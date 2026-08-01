/**
 * 地址解析与正文标准化测试。
 *
 * 其中 HTML 实体解码那一组来自真实数据上踩到的 bug：Zoho 的正文响应
 * 会把地址字段转义，不解码会产出 `addr&gt` 这种垃圾，导致身份匹配
 * 全部落空、按收件人搜索失效 —— 而且不报错。
 */

import { describe, expect, it } from "vitest";
import {
  decodeHtmlEntities,
  htmlToText,
  matchIdentity,
  parseAddressList,
} from "../../src/mail/normalize-message.js";

describe("decodeHtmlEntities", () => {
  it.each([
    ["&lt;", "<"],
    ["&gt;", ">"],
    ["&quot;", '"'],
    ["&amp;", "&"],
    ["&#39;", "'"],
    ["&#x3C;", "<"],
  ])("%s → %s", (input, expected) => {
    expect(decodeHtmlEntities(input)).toBe(expected);
  });

  it("未知实体原样保留，不吞字符", () => {
    expect(decodeHtmlEntities("a &unknown; b")).toBe("a &unknown; b");
  });
});

describe("parseAddressList", () => {
  it("解析 Zoho 正文响应中的转义地址（真实 bug 场景）", () => {
    const r = parseAddressList("&quot;Owner&quot; &lt;owner@example.com&gt;");
    expect(r).toEqual([{ name: "Owner", address: "owner@example.com" }]);
  });

  it("绝不把实体残片带进地址", () => {
    for (const input of [
      "&quot;X&quot; &lt;a@b.example&gt;",
      "&lt;a@b.example&gt;",
      "a@b.example&gt;",
    ]) {
      const [first] = parseAddressList(input);
      expect(first?.address).toBe("a@b.example");
      expect(first?.address).not.toMatch(/&|;|<|>/);
    }
  });

  it("引号内的逗号不被当作分隔符", () => {
    expect(
      parseAddressList('"Doe, John" <john@x.example>, jane@y.example').map((r) => r.address),
    ).toEqual(["john@x.example", "jane@y.example"]);
  });

  it("地址统一小写，便于与身份表比对", () => {
    expect(parseAddressList("Owner@Example.COM")[0]?.address).toBe("owner@example.com");
  });

  it.each([["null"], [""], ["   "], ["not-an-address"]])("无效输入 %s 返回空数组", (input) => {
    expect(parseAddressList(input)).toEqual([]);
  });
});

describe("htmlToText", () => {
  it("剥离标签", () => {
    expect(htmlToText("<div>hello <b>world</b></div>")).toBe("hello world");
  });

  it("丢弃 script 与 style", () => {
    const text = htmlToText("<div>keep</div><script>evil()</script><style>.x{}</style>");
    expect(text).toBe("keep");
    expect(text).not.toContain("evil");
  });

  it("保留中文", () => {
    expect(htmlToText("<p>硅胶管报价</p>")).toContain("硅胶管报价");
  });

  it("折叠多余空行", () => {
    expect(htmlToText("<p>a</p><br><br><br><p>b</p>")).not.toMatch(/\n{3,}/);
  });
});

describe("matchIdentity", () => {
  const identities = [
    { id: 1, address: "sales@example.com", isPrimary: false },
    { id: 2, address: "owner@example.com", isPrimary: true },
  ];

  it("primary 优先于 alias", () => {
    const matched = matchIdentity(
      [
        { type: "to", name: null, address: "sales@example.com" },
        { type: "to", name: null, address: "owner@example.com" },
      ],
      identities,
    );
    expect(matched).toBe(2);
  });

  it("同等条件下 to 优先于 cc", () => {
    const matched = matchIdentity(
      [
        { type: "cc", name: null, address: "sales@example.com" },
        { type: "to", name: null, address: "sales@example.com" },
      ],
      identities,
    );
    expect(matched).toBe(1);
  });

  it("大小写不敏感", () => {
    expect(
      matchIdentity([{ type: "to", name: null, address: "OWNER@EXAMPLE.COM" }], identities),
    ).toBe(2);
  });

  it("没有命中时返回 null", () => {
    expect(
      matchIdentity([{ type: "to", name: null, address: "other@nowhere.invalid" }], identities),
    ).toBeNull();
  });
});
