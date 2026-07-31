/**
 * §13.1.2 的不变量测试。
 *
 * 中文搜索的失效方式是**静默返回空** —— 不报错，只是查不到。
 * 这是最难在生产中发现的一类 bug，所以必须由测试守住。
 */

import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildIdentityText,
  containsCjk,
  escapeFtsLiteral,
  NORMALIZER_VERSION,
  normalizeForIndex,
  toAndQuery,
  toPhraseQuery,
} from "../../src/mail/normalize-for-index.js";

describe("normalizeForIndex", () => {
  it("把连续汉字逐字用空格分开", () => {
    expect(normalizeForIndex("硅胶管")).toBe("硅 胶 管");
  });

  it("不改动纯 ASCII 文本的词形", () => {
    expect(normalizeForIndex("silicone tubing quotation")).toBe("silicone tubing quotation");
  });

  it("中英混排时两者都保持可索引", () => {
    expect(normalizeForIndex("客户询价 silicone tubing")).toBe("客 户 询 价 silicone tubing");
  });

  it("折叠多余空白", () => {
    expect(normalizeForIndex("  a\n\n b\t\tc  ")).toBe("a b c");
  });

  it("覆盖日文与韩文", () => {
    expect(normalizeForIndex("見積もり")).toContain("見 積");
    expect(normalizeForIndex("견적서")).toBe("견 적 서");
  });

  it("空输入返回空串而不是抛错", () => {
    expect(normalizeForIndex("")).toBe("");
  });

  it("是幂等的 —— 重复规范化不会继续变形", () => {
    const once = normalizeForIndex("硅胶管报价");
    expect(normalizeForIndex(once)).toBe(once);
  });
});

describe("containsCjk", () => {
  it("正确识别，且带全局 flag 的正则不会因 lastIndex 残留而漏判", () => {
    expect(containsCjk("硅胶")).toBe(true);
    // 连续调用两次：如果内部正则没重置 lastIndex，第二次会错误返回 false
    expect(containsCjk("硅胶")).toBe(true);
    expect(containsCjk("silicone")).toBe(false);
  });
});

describe("escapeFtsLiteral", () => {
  it("双引号通过重复来转义", () => {
    expect(escapeFtsLiteral('say "hi"')).toBe('"say ""hi"""');
  });

  it("FTS5 运算符被当作字面量而非语法", () => {
    // 不转义的话 AND / OR / NEAR / * 会改变查询语义
    expect(toPhraseQuery("foo AND bar")).toBe('"foo AND bar"');
    expect(toPhraseQuery("a* OR b")).toBe('"a* OR b"');
  });
});

describe("toAndQuery", () => {
  it("每个词各自规范化后用 AND 连接", () => {
    expect(toAndQuery(["硅胶", "quotation"])).toBe('"硅 胶" AND "quotation"');
  });

  it("忽略空词", () => {
    expect(toAndQuery(["硅胶", "", "   "])).toBe('"硅 胶"');
  });
});

describe("buildIdentityText", () => {
  it("拼接姓名与地址", () => {
    expect(buildIdentityText([{ name: "John Doe", address: "john@acme.com" }])).toBe(
      "John Doe john@acme.com",
    );
  });

  it("没有姓名时只用地址", () => {
    expect(buildIdentityText([{ address: "a@b.com" }, { name: null, address: "c@d.com" }])).toBe(
      "a@b.com c@d.com",
    );
  });
});

// ---------------------------------------------------------------- 端到端

describe("FTS5 端到端：索引与查询必须用同一个规范化函数", () => {
  let db: Database.Database;

  const SUBJECT = "报价单 Q3 quotation";
  const BODY = "客户询价硅胶管，需要样品和交期 silicone tubing sample lead time";
  const SENDER = "John Doe john@acme.com";
  const RECIPIENTS = "Owner sales@example.com";

  beforeEach(() => {
    db = new Database(":memory:");
    db.exec(`
      CREATE VIRTUAL TABLE messages_fts USING fts5(
        subject, sender, recipients, body,
        content='', contentless_delete=1,
        tokenize='unicode61 remove_diacritics 2');
    `);
    db.prepare(
      "INSERT INTO messages_fts(rowid, subject, sender, recipients, body) VALUES (?, ?, ?, ?, ?)",
    ).run(
      1,
      normalizeForIndex(SUBJECT),
      normalizeForIndex(SENDER),
      normalizeForIndex(RECIPIENTS),
      normalizeForIndex(BODY),
    );
  });

  afterEach(() => db.close());

  const search = (fts: string): number =>
    db.prepare("SELECT rowid FROM messages_fts WHERE messages_fts MATCH ?").all(fts).length;

  // 这些两字词是中文商务邮件的核心词汇。trigram 分词器会让它们全部失效。
  it.each(["询价", "报价", "样品", "交期", "客户", "硅胶"])("两字中文词 %s 能命中", (term) => {
    expect(search(toPhraseQuery(term))).toBe(1);
  });

  it.each(["硅胶管", "报价单"])("三字中文词 %s 能命中", (term) => {
    expect(search(toPhraseQuery(term))).toBe(1);
  });

  it.each(["silicone", "quotation", "sample"])("英文词 %s 能命中", (term) => {
    expect(search(toPhraseQuery(term))).toBe(1);
  });

  it("中英混合查询能命中", () => {
    expect(search(toAndQuery(["硅胶", "silicone"]))).toBe(1);
  });

  it("不存在的词不命中", () => {
    expect(search(toPhraseQuery("不存在的关键词"))).toBe(0);
  });

  it("列限定查询可用", () => {
    expect(search(`sender:${toPhraseQuery("acme")}`)).toBe(1);
  });

  it("bm25 排序可用（contentless 表仍支持）", () => {
    const row = db
      .prepare("SELECT bm25(messages_fts) AS r FROM messages_fts WHERE messages_fts MATCH ?")
      .get(toPhraseQuery("silicone")) as { r: number };
    expect(typeof row.r).toBe("number");
  });

  it("contentless_delete 使删除生效", () => {
    db.prepare("DELETE FROM messages_fts WHERE rowid = 1").run();
    expect(search(toPhraseQuery("硅胶"))).toBe(0);
  });

  /**
   * 不变量 1 的守护测试。
   *
   * 如果写入端忘了调用 normalizeForIndex，中文搜索会静默失效。
   * 这个测试**故意**制造那种不一致，并断言它确实查不到 ——
   * 一旦有人「修好」了这个测试（比如让未规范化的写入也能查到），
   * 说明规范化逻辑被绕过了。
   */
  it("写入端不规范化时，中文查询确实查不到（证明不变量真实存在）", () => {
    const raw = new Database(":memory:");
    raw.exec(`
      CREATE VIRTUAL TABLE t USING fts5(body, content='', contentless_delete=1,
        tokenize='unicode61 remove_diacritics 2');
    `);
    // 未经规范化直接写入
    raw.prepare("INSERT INTO t(rowid, body) VALUES (1, ?)").run(BODY);

    const hits = raw
      .prepare("SELECT rowid FROM t WHERE t MATCH ?")
      .all(toPhraseQuery("询价")).length;

    expect(hits).toBe(0); // 静默失效 —— 这正是必须守住不变量的原因
    raw.close();
  });

  it("查询端不规范化时同样查不到", () => {
    // 索引是规范化过的，但查询直接用原词
    expect(search(escapeFtsLiteral("询价"))).toBe(0);
    // 走正确路径就能查到
    expect(search(toPhraseQuery("询价"))).toBe(1);
  });
});

describe("规范化版本", () => {
  it("与 migration 中写入的初始值一致", () => {
    // 003_fts.sql 里 INSERT 的是 '1'。两者不一致会导致 doctor 永久告警。
    expect(NORMALIZER_VERSION).toBe(1);
  });
});
