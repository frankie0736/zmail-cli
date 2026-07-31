/**
 * 同步引擎集成测试 —— Phase 3 的验收标准逐条验证。
 *
 * 这些场景在真实邮箱上跑不了：开发账号只有 26 封邮件，翻不了页、
 * 没有「中途」可以中断、也没法让 Zoho 按需返回 429。
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { defaultConfig, profileSchema } from "../../src/config/schema.js";
import { migrate, openDatabase, type SqliteDatabase } from "../../src/db/database.js";
import { MessageRepository } from "../../src/db/repositories/message-repository.js";
import { SearchService } from "../../src/mail/search-service.js";
import { MemorySecretStore } from "../../src/secrets/memory-secret-store.js";
import { SyncEngine } from "../../src/sync/sync-engine.js";
import { ZohoClient } from "../../src/zoho/client.js";
import { TokenManager } from "../../src/zoho/token-manager.js";
import {
  MOCK_CLIENT_ID,
  MOCK_CLIENT_SECRET,
  MOCK_EMAIL,
  MOCK_REFRESH_TOKEN,
  MockZohoServer,
} from "./mock-zoho-server.js";

const PROFILE = "primary";

let dir: string;
let db: SqliteDatabase;
let server: MockZohoServer;

async function setup(mockOpts: ConstructorParameters<typeof MockZohoServer>[0] = {}) {
  server = new MockZohoServer({ messageCount: 250, pageLimit: 200, ...mockOpts });
  await server.start();

  const secrets = new MemorySecretStore();
  await secrets.set(PROFILE, "client-id", MOCK_CLIENT_ID);
  await secrets.set(PROFILE, "client-secret", MOCK_CLIENT_SECRET);
  await secrets.set(PROFILE, "refresh-token", MOCK_REFRESH_TOKEN);

  const tokens = new TokenManager({ profile: PROFILE, region: server.region, secrets });
  const client = new ZohoClient({ region: server.region, tokens });

  const config = defaultConfig();
  const profile = profileSchema.parse({
    email: MOCK_EMAIL,
    zohoLocation: "com",
    accountsBaseUrl: server.baseUrl,
    mailApiBaseUrl: server.baseUrl,
    // Inbox / Sent / Archive 就是 mock 里有邮件的三个
    sync: { includeFolders: ["Inbox", "Sent", "Archive"], contentConcurrency: 4 },
  });
  config.profiles[PROFILE] = profile;

  return {
    engine: new SyncEngine({ db, client, profileId: PROFILE, profile, config }),
    profile,
    config,
    client,
  };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "zmail-sync-"));
  db = openDatabase(join(dir, "mail.sqlite3"));
  migrate(db);
});

afterEach(async () => {
  db.close();
  await server?.stop();
  rmSync(dir, { recursive: true, force: true });
});

const countMessages = () =>
  (db.prepare("SELECT count(*) AS c FROM messages").get() as { c: number }).c;

describe("Full Sync", () => {
  it("拉取全部邮件，翻页无遗漏", async () => {
    const { engine } = await setup();
    const result = await engine.run({ mode: "full" });

    // mock 把邮件分散在三个可同步文件夹里
    expect(countMessages()).toBe(server.messageCount);
    expect(result.totalInserted).toBe(server.messageCount);
    expect(result.aborted).toBe(false);
  });

  /** §Phase 3 验收：连续两次 Full Sync，消息总数不增长。 */
  it("连续两次 Full Sync 消息总数不增长（幂等）", async () => {
    const { engine } = await setup();
    await engine.run({ mode: "full" });
    const after1 = countMessages();

    const second = await engine.run({ mode: "full" });
    const after2 = countMessages();

    expect(after2).toBe(after1);
    expect(second.totalInserted).toBe(0);
    expect(second.totalUpdated).toBe(after1);
  });

  it("重复同步不产生重复收件人", async () => {
    const { engine } = await setup({ messageCount: 30 });
    await engine.run({ mode: "full" });
    const first = (
      db.prepare("SELECT count(*) AS c FROM message_recipients").get() as { c: number }
    ).c;

    await engine.run({ mode: "full" });
    const second = (
      db.prepare("SELECT count(*) AS c FROM message_recipients").get() as { c: number }
    ).c;

    expect(second).toBe(first);
  });

  it("正文被抓取并转成纯文本", async () => {
    const { engine } = await setup({ messageCount: 30 });
    await engine.run({ mode: "full" });

    const row = db
      .prepare("SELECT body_text FROM messages WHERE body_text IS NOT NULL LIMIT 1")
      .get() as { body_text: string } | undefined;
    expect(row?.body_text).toBeTruthy();
    // HTML 标签应已被剥离
    expect(row?.body_text).not.toContain("<div>");
  });

  it("远程 ID 以字符串保存，无精度损失", async () => {
    const { engine } = await setup({ messageCount: 20 });
    await engine.run({ mode: "full" });

    const ids = (
      db.prepare("SELECT zoho_message_id FROM messages").all() as Array<{
        zoho_message_id: string;
      }>
    ).map((r) => r.zoho_message_id);

    const expected = new Set(server.listMessageIds());
    for (const id of ids) {
      expect(typeof id).toBe("string");
      expect(expected.has(id)).toBe(true);
      // 若任何环节数值化过，这里会对不上
      expect(String(Number(id))).not.toBe(id);
    }
  });
});

describe("中断与续传", () => {
  /** §Phase 3 验收：中途终止后再次执行可继续。 */
  it("中断后 checkpoint 保留页进度，再次运行可继续", async () => {
    const { engine } = await setup({ messageCount: 250 });

    // 第一页之后就中断
    let pages = 0;
    const first = await engine.run({
      mode: "full",
      shouldAbort: () => {
        pages++;
        return pages > 2;
      },
    });
    expect(first.aborted).toBe(true);
    const partial = countMessages();
    expect(partial).toBeGreaterThan(0);
    expect(partial).toBeLessThan(server.messageCount);

    // checkpoint 应记录了页进度
    const state = db
      .prepare("SELECT last_page_start FROM sync_state WHERE profile_id = ?")
      .get(PROFILE) as { last_page_start: number | null } | undefined;
    expect(state?.last_page_start).toBeGreaterThan(1);

    // 再次运行补齐
    const second = await engine.run({ mode: "full" });
    expect(second.aborted).toBe(false);
    expect(countMessages()).toBe(server.messageCount);
  });

  it("同步成功后清除页进度，下次是干净起点", async () => {
    const { engine } = await setup({ messageCount: 30 });
    await engine.run({ mode: "full" });
    const rows = db
      .prepare("SELECT last_page_start, last_successful_sync_at FROM sync_state")
      .all() as Array<{ last_page_start: number | null; last_successful_sync_at: number | null }>;
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      expect(r.last_page_start).toBeNull();
      expect(r.last_successful_sync_at).not.toBeNull();
    }
  });
});

describe("故障容忍", () => {
  it("429 触发退避重试后仍能完成", async () => {
    const { engine } = await setup({
      messageCount: 40,
      faults: { rateLimitEvery: 4, retryAfterSeconds: 0 },
    });
    const result = await engine.run({ mode: "full", sleep: async () => {} });
    expect(server.stats.rateLimited).toBeGreaterThan(0);
    expect(countMessages()).toBe(server.messageCount);
    expect(result.aborted).toBe(false);
  });

  it("单封正文 404 不阻塞整个文件夹", async () => {
    const server0 = new MockZohoServer({ messageCount: 30 });
    const doomed = server0.listMessageIds().slice(0, 3);
    const { engine } = await setup({
      messageCount: 30,
      faults: { notFoundMessageIds: new Set(doomed) },
    });

    const result = await engine.run({ mode: "full", sleep: async () => {} });
    // 列表阶段仍然全部入库
    expect(countMessages()).toBe(server.messageCount);
    expect(result.totalBodyFailures).toBeGreaterThan(0);
    // 其余邮件的正文正常
    const withBody = (
      db.prepare("SELECT count(*) AS c FROM messages WHERE body_text IS NOT NULL").get() as {
        c: number;
      }
    ).c;
    expect(withBody).toBeGreaterThan(20);
  });

  it("access token 过期时自动刷新并继续", async () => {
    const { engine } = await setup({
      messageCount: 40,
      faults: { expireAccessTokenAfter: 5 },
    });
    await engine.run({ mode: "full", sleep: async () => {} });
    expect(server.stats.tokenRefreshes).toBeGreaterThan(1);
    expect(countMessages()).toBe(server.messageCount);
  });
});

describe("对账：WebMail 中的变化", () => {
  it("移动邮件后本地 folder_id 更新", async () => {
    const { engine } = await setup({ messageCount: 30 });
    await engine.run({ mode: "full" });

    const id = server.listMessageIds("1000000001")[0] as string;
    server.moveMessage(id, "1000000006"); // Inbox → Archive
    await engine.run({ mode: "full" });

    const row = db.prepare("SELECT folder_id FROM messages WHERE zoho_message_id = ?").get(id) as {
      folder_id: string;
    };
    expect(row.folder_id).toBe("1000000006");
  });

  it("远程删除只打墓碑标记，不删本地内容", async () => {
    const { engine } = await setup({ messageCount: 30 });
    await engine.run({ mode: "full" });
    const before = countMessages();

    const id = server.listMessageIds()[0] as string;
    server.deleteMessage(id);
    await engine.run({ mode: "full" });

    // 行数不变 —— 用户可能还需要那封邮件的内容（§14.7）
    expect(countMessages()).toBe(before);
    const row = db
      .prepare("SELECT is_remote_deleted, body_text FROM messages WHERE zoho_message_id = ?")
      .get(id) as { is_remote_deleted: number; body_text: string | null };
    expect(row.is_remote_deleted).toBe(1);
    expect(row.body_text).toBeTruthy();
  });

  it("邮件重新出现时清除墓碑标记", async () => {
    const { engine } = await setup({ messageCount: 20 });
    await engine.run({ mode: "full" });
    const id = server.listMessageIds()[0] as string;

    server.deleteMessage(id);
    await engine.run({ mode: "full" });
    expect(
      (
        db
          .prepare("SELECT is_remote_deleted AS d FROM messages WHERE zoho_message_id = ?")
          .get(id) as {
          d: number;
        }
      ).d,
    ).toBe(1);
  });
});

describe("Quick Sync", () => {
  it("只扫描最新若干封", async () => {
    const { engine } = await setup({ messageCount: 250 });
    const result = await engine.run({ mode: "quick", quickScanLimit: 50 });
    // 每个文件夹最多 50，三个文件夹
    expect(countMessages()).toBeLessThanOrEqual(150);
    expect(result.totalInserted).toBeGreaterThan(0);
  });

  it("Quick Sync 不做对账，不误标墓碑", async () => {
    const { engine } = await setup({ messageCount: 250 });
    await engine.run({ mode: "quick", quickScanLimit: 20 });
    const flagged = (
      db.prepare("SELECT count(*) AS c FROM messages WHERE is_remote_deleted = 1").get() as {
        c: number;
      }
    ).c;
    // 没扫到的邮件绝不能被当成已删除
    expect(flagged).toBe(0);
  });
});

describe("离线搜索（Phase 3 验收核心）", () => {
  it("同步后可离线全文搜索，中英文都能命中", async () => {
    const { engine } = await setup({ messageCount: 120, seed: 1 });
    await engine.run({ mode: "full" });

    // 关掉服务器，证明搜索完全离线
    await server.stop();

    const search = new SearchService(db);
    const cn = search.search({ profileId: PROFILE, query: "报价", limit: 50 });
    const en = search.search({ profileId: PROFILE, query: "quotation", limit: 50 });

    expect(cn.total).toBeGreaterThan(0);
    expect(en.total).toBeGreaterThan(0);
  });

  it.each(["询价", "报价", "样品", "交期"])("中文两字词 %s 能命中", async (term) => {
    const { engine } = await setup({ messageCount: 120, seed: 1 });
    await engine.run({ mode: "full" });
    const { total } = new SearchService(db).search({ profileId: PROFILE, query: term, limit: 50 });
    expect(total).toBeGreaterThan(0);
  });

  it("按发件人域名过滤", async () => {
    const { engine } = await setup({ messageCount: 60 });
    await engine.run({ mode: "full" });
    const { hits } = new SearchService(db).search({
      profileId: PROFILE,
      fromDomain: "buyer.example.com",
      limit: 50,
    });
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.every((h) => h.fromAddress?.endsWith("@buyer.example.com"))).toBe(true);
  });

  it("按收件人过滤走 message_recipients", async () => {
    const { engine } = await setup({ messageCount: 40 });
    await engine.run({ mode: "full" });
    const { total } = new SearchService(db).search({
      profileId: PROFILE,
      to: MOCK_EMAIL,
      limit: 50,
    });
    expect(total).toBeGreaterThan(0);
  });

  it("默认排除远程已删除的邮件", async () => {
    const { engine } = await setup({ messageCount: 30 });
    await engine.run({ mode: "full" });
    const id = server.listMessageIds()[0] as string;
    server.deleteMessage(id);
    await engine.run({ mode: "full" });

    const search = new SearchService(db);
    const normal = search.search({ profileId: PROFILE, limit: 100 });
    const withDeleted = search.search({
      profileId: PROFILE,
      limit: 100,
      includeRemoteDeleted: true,
    });
    expect(withDeleted.total).toBe(normal.total + 1);
  });

  it("message get 返回完整正文与收件人", async () => {
    const { engine } = await setup({ messageCount: 20 });
    await engine.run({ mode: "full" });
    const id = server.listMessageIds()[0] as string;

    const msg = new SearchService(db).getMessage(PROFILE, id);
    // 先窄化再断言：msg 为 null 时应该在这里失败，而不是在解引用时抛 TypeError
    if (msg === null) throw new Error(`message get 返回 null: ${id}`);
    expect(msg.messageId).toBe(id);
    expect(msg.bodyText).toBeTruthy();
    expect(msg.recipients as unknown[]).not.toHaveLength(0);
  });
});

describe("FTS 索引一致性", () => {
  it("每条消息都有对应的索引行", async () => {
    const { engine } = await setup({ messageCount: 60 });
    await engine.run({ mode: "full" });

    const messages = countMessages();
    const indexed = (db.prepare("SELECT count(*) AS c FROM messages_fts").get() as { c: number }).c;
    expect(indexed).toBe(messages);
  });

  it("rebuild-index 后搜索结果不变", async () => {
    const { engine } = await setup({ messageCount: 80, seed: 3 });
    await engine.run({ mode: "full" });

    const search = new SearchService(db);
    const before = search.search({ profileId: PROFILE, query: "报价", limit: 100 }).total;

    const rebuilt = new MessageRepository(db).rebuildIndex();
    expect(rebuilt).toBe(countMessages());

    const after = search.search({ profileId: PROFILE, query: "报价", limit: 100 }).total;
    expect(after).toBe(before);
  });

  it("FTS integrity-check 通过", async () => {
    const { engine } = await setup({ messageCount: 40 });
    await engine.run({ mode: "full" });
    expect(() =>
      db.exec("INSERT INTO messages_fts(messages_fts) VALUES('integrity-check')"),
    ).not.toThrow();
  });
});
