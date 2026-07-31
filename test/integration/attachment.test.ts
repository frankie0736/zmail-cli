/**
 * 附件同步与下载集成测试。
 *
 * mock 刻意在附件名里放了路径穿越与 Windows 保留名。这一层要证明的是：
 * 那些名字**穿过整条链路**（同步 → 入库 → 下载 → 导出）之后仍然无害，
 * 而不只是 safeFilename 单元测试里孤立地无害。
 */

import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { defaultConfig, profileSchema } from "../../src/config/schema.js";
import { migrate, openDatabase, type SqliteDatabase } from "../../src/db/database.js";
import { AttachmentRepository } from "../../src/db/repositories/attachment-repository.js";
import { MemorySecretStore } from "../../src/secrets/memory-secret-store.js";
import { AttachmentStore } from "../../src/storage/attachment-store.js";
import { uniqueExportPath } from "../../src/storage/safe-filename.js";
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

async function syncAll(messageCount = 40) {
  server = new MockZohoServer({ messageCount });
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
    accountId: "4001234000000009007",
  });
  config.profiles[PROFILE] = profile;

  const engine = new SyncEngine({ db, client, profileId: PROFILE, profile, config });
  const result = await engine.run({ mode: "full" });
  return { result, client, profile };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "zmail-att-int-"));
  db = openDatabase(join(dir, "mail.sqlite3"));
  migrate(db);
});
afterEach(async () => {
  db.close();
  await server?.stop();
  rmSync(dir, { recursive: true, force: true });
});

describe("附件元数据同步", () => {
  it("有附件的邮件被索引，元数据入库", async () => {
    const { result } = await syncAll(40);
    expect(result.totalAttachmentsIndexed).toBeGreaterThan(0);

    const stats = new AttachmentRepository(db).stats();
    expect(stats.total).toBe(result.totalAttachmentsIndexed);
    // 默认 attachmentMode=metadata：只索引不下载，首次同步体积才可控
    expect(stats.downloaded).toBe(0);
  });

  it("重复同步不产生重复附件行", async () => {
    await syncAll(40);
    const first = new AttachmentRepository(db).stats().total;
    // 第二次同步
    const secrets = new MemorySecretStore();
    await secrets.set(PROFILE, "client-id", MOCK_CLIENT_ID);
    await secrets.set(PROFILE, "client-secret", MOCK_CLIENT_SECRET);
    await secrets.set(PROFILE, "refresh-token", MOCK_REFRESH_TOKEN);
    const config = defaultConfig();
    const profile = profileSchema.parse({
      email: MOCK_EMAIL,
      accountsBaseUrl: server.baseUrl,
      mailApiBaseUrl: server.baseUrl,
    });
    config.profiles[PROFILE] = profile;
    await new SyncEngine({
      db,
      client: new ZohoClient({
        region: server.region,
        tokens: new TokenManager({ profile: PROFILE, region: server.region, secrets }),
      }),
      profileId: PROFILE,
      profile,
      config,
    }).run({ mode: "full" });

    expect(new AttachmentRepository(db).stats().total).toBe(first);
  });

  it("附件元数据失败不影响邮件本身", async () => {
    // attachmentinfo 端点在 mock 里对无附件邮件返回空列表；
    // 这里断言即使没有附件，邮件与正文依然完整
    const { result } = await syncAll(40);
    const withBody = (
      db.prepare("SELECT count(*) AS c FROM messages WHERE body_text IS NOT NULL").get() as {
        c: number;
      }
    ).c;
    expect(withBody).toBe(result.totalInserted);
  });
});

describe("按需下载与内容寻址", () => {
  it("下载后按 SHA-256 落盘，路径与文件名无关", async () => {
    await syncAll(40);
    const repo = new AttachmentRepository(db);
    const row = repo.find(PROFILE, repo.stats().total > 0 ? getFirstAttachmentId(db) : "");
    expect(row).not.toBeNull();
    if (!row) return;

    const store = new AttachmentStore(join(dir, "attachments"), join(dir, "tmp"));
    const res = await new ZohoClient({
      region: server.region,
      tokens: new TokenManager({
        profile: PROFILE,
        region: server.region,
        secrets: await seededSecrets(),
      }),
    }).requestRaw(
      `/api/accounts/4001234000000009007/folders/${row.folderId}/messages/${row.zohoMessageId}/attachments/${row.zohoAttachmentId}`,
    );
    const blob = await store.storeStream(res.body as ReadableStream<Uint8Array>, row.sizeBytes);

    // 路径完全由哈希决定 —— 恶意文件名进不了磁盘路径
    expect(blob.path).toContain(`${sep}${blob.sha256.slice(0, 2)}${sep}${blob.sha256}`);
    expect(blob.path).not.toContain("passwd");
    expect(blob.path).not.toContain("..");

    repo.markDownloaded(row.id, blob.sha256, blob.path, blob.sizeBytes);
    expect(repo.stats().downloaded).toBe(1);
  });

  it("相同内容的附件被去重", async () => {
    await syncAll(40);
    const store = new AttachmentStore(join(dir, "attachments"), join(dir, "tmp"));
    const repo = new AttachmentRepository(db);
    const secrets = await seededSecrets();
    const client = new ZohoClient({
      region: server.region,
      tokens: new TokenManager({ profile: PROFILE, region: server.region, secrets }),
    });

    const rows = (
      db.prepare("SELECT zoho_attachment_id FROM attachments LIMIT 6").all() as Array<{
        zoho_attachment_id: string;
      }>
    ).map((r) => r.zoho_attachment_id);

    const hashes = new Set<string>();
    let dedupCount = 0;
    for (const attId of rows) {
      const row = repo.find(PROFILE, attId);
      if (!row) continue;
      const res = await client.requestRaw(
        `/api/accounts/4001234000000009007/folders/${row.folderId}/messages/${row.zohoMessageId}/attachments/${row.zohoAttachmentId}`,
      );
      const blob = await store.storeStream(res.body as ReadableStream<Uint8Array>, row.sizeBytes);
      if (blob.deduplicated) dedupCount++;
      hashes.add(blob.sha256);
      repo.markDownloaded(row.id, blob.sha256, blob.path, blob.sizeBytes);
    }

    // mock 让每 3 封共享同一份内容，因此唯一 blob 数必然少于附件数
    expect(hashes.size).toBeLessThan(rows.length);
    expect(dedupCount).toBeGreaterThan(0);
    expect(repo.stats().dedupSavedBytes).toBeGreaterThan(0);
  });
});

describe("导出安全：恶意文件名穿过整条链路", () => {
  it("附件名里的路径穿越无法逃出导出目录", async () => {
    await syncAll(40);
    const names = (
      db.prepare("SELECT filename FROM attachments").all() as Array<{ filename: string }>
    ).map((r) => r.filename);

    // 确认 mock 确实投喂了恶意名字，否则这个测试是空转
    expect(names.some((n) => n.includes(".."))).toBe(true);
    expect(names.some((n) => /^CON/i.test(n))).toBe(true);

    const outDir = join(dir, "export");
    for (const name of names) {
      const target = uniqueExportPath(outDir, name, () => false);
      expect(target.startsWith(outDir + sep)).toBe(true);
      expect(target).not.toContain("..");
    }
  });

  it("中文附件名被完整保留", async () => {
    await syncAll(40);
    const names = (
      db.prepare("SELECT filename FROM attachments").all() as Array<{ filename: string }>
    ).map((r) => r.filename);
    const cn = names.find((n) => /[一-鿿]/.test(n));
    expect(cn).toBeTruthy();
    if (cn) {
      const target = uniqueExportPath(join(dir, "export"), cn, () => false);
      // 过度消毒也是 bug：用户得能认出自己的文件
      expect(target).toContain("报价单");
    }
  });
});

describe("LRU 回收", () => {
  it("回收只删内容，保留元数据以便重新下载", async () => {
    await syncAll(40);
    const repo = new AttachmentRepository(db);
    const store = new AttachmentStore(join(dir, "attachments"), join(dir, "tmp"));

    const row = repo.find(PROFILE, getFirstAttachmentId(db));
    if (!row) throw new Error("没有附件可测");

    const client = new ZohoClient({
      region: server.region,
      tokens: new TokenManager({
        profile: PROFILE,
        region: server.region,
        secrets: await seededSecrets(),
      }),
    });
    const res = await client.requestRaw(
      `/api/accounts/4001234000000009007/folders/${row.folderId}/messages/${row.zohoMessageId}/attachments/${row.zohoAttachmentId}`,
    );
    const blob = await store.storeStream(res.body as ReadableStream<Uint8Array>, row.sizeBytes);
    repo.markDownloaded(row.id, blob.sha256, blob.path, blob.sizeBytes);

    expect(store.has(blob.sha256)).toBe(true);
    store.evict(blob.sha256);
    const changed = repo.markEvicted(blob.sha256);

    expect(changed).toBeGreaterThan(0);
    expect(existsSync(blob.path)).toBe(false);
    // 元数据必须还在 —— 否则用户会以为附件凭空消失了
    const after = repo.find(PROFILE, row.zohoAttachmentId);
    expect(after?.downloadStatus).toBe("evicted");
    expect(after?.filename).toBe(row.filename);
    expect(after?.sha256).toBe(blob.sha256);
  });
});

// ---- helpers ----

function getFirstAttachmentId(database: SqliteDatabase): string {
  const row = database.prepare("SELECT zoho_attachment_id FROM attachments LIMIT 1").get() as
    | { zoho_attachment_id: string }
    | undefined;
  return row?.zoho_attachment_id ?? "";
}

async function seededSecrets() {
  const s = new MemorySecretStore();
  await s.set(PROFILE, "client-id", MOCK_CLIENT_ID);
  await s.set(PROFILE, "client-secret", MOCK_CLIENT_SECRET);
  await s.set(PROFILE, "refresh-token", MOCK_REFRESH_TOKEN);
  return s;
}
