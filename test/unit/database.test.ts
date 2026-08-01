/**
 * migration runner 与 schema 行为。实施计划 §22.2。
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ErrorCode } from "../../src/core/errors.js";
import {
  currentSchemaVersion,
  latestSchemaVersion,
  loadMigrations,
  migrate,
  openDatabase,
  readNormalizerVersion,
  type SqliteDatabase,
  verifyIntegrity,
} from "../../src/db/database.js";

let dir: string;
let dbPath: string;
let db: SqliteDatabase;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "zmail-db-"));
  dbPath = join(dir, "mail.sqlite3");
  db = openDatabase(dbPath);
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("migrations 文件", () => {
  it("编号从 1 开始且连续", () => {
    const migrations = loadMigrations();
    expect(migrations.length).toBeGreaterThan(0);
    for (const [i, m] of migrations.entries()) {
      expect(m.version).toBe(i + 1);
    }
  });
});

describe("migrate", () => {
  it("从空库应用到最新版本", () => {
    expect(currentSchemaVersion(db)).toBe(0);
    const applied = migrate(db);
    expect(applied).toEqual([1, 2, 3, 4]);
    expect(currentSchemaVersion(db)).toBe(latestSchemaVersion());
  });

  it("重复执行是幂等的", () => {
    migrate(db);
    expect(migrate(db)).toEqual([]);
    expect(currentSchemaVersion(db)).toBe(latestSchemaVersion());
  });

  it("PRAGMA 已正确设置", () => {
    expect(db.pragma("journal_mode", { simple: true })).toBe("wal");
    expect(db.pragma("foreign_keys", { simple: true })).toBe(1);
  });

  it("数据库比代码新时拒绝运行而不是猜语义", () => {
    migrate(db);
    db.prepare("INSERT INTO schema_migrations VALUES (?, ?, ?)").run(
      999,
      "from_future",
      Date.now(),
    );
    expect(() => migrate(db)).toThrowError(
      expect.objectContaining({ code: ErrorCode.SCHEMA_TOO_NEW }),
    );
  });

  it("失败的 migration 整体回滚，不留半应用状态", () => {
    const broken = [
      { version: 1, name: "ok", sql: "CREATE TABLE a(x INTEGER);" },
      { version: 2, name: "broken", sql: "CREATE TABLE b(y INTEGER); THIS IS NOT SQL;" },
    ];
    expect(() => migrate(db, broken)).toThrowError(
      expect.objectContaining({ code: ErrorCode.MIGRATION_FAILED }),
    );
    // 1 已提交
    expect(currentSchemaVersion(db)).toBe(1);
    // 2 的 CREATE TABLE b 必须被回滚
    const hasB = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='b'").get();
    expect(hasB).toBeUndefined();
  });
});

describe("schema 行为", () => {
  beforeEach(() => migrate(db));

  const seed = () => {
    const now = Date.now();
    db.prepare("INSERT INTO profiles VALUES ('primary','owner@example.com','com',?,?)").run(now, now);
    db.prepare(
      `INSERT INTO account_identities(profile_id,account_id,address,is_receive,is_alias,first_synced_at,last_synced_at)
       VALUES ('primary','ACC','sales@example.com',1,1,?,?)`,
    ).run(now, now);
    const identityId = (db.prepare("SELECT id FROM account_identities").get() as { id: number }).id;
    db.prepare(
      `INSERT INTO messages(profile_id,account_id,zoho_message_id,folder_id,subject,from_address,
        received_at,matched_identity_id,first_synced_at,last_synced_at)
       VALUES ('primary','ACC','999999999999999999','inbox','报价','John@ACME.example',?,?,?,?)`,
    ).run(now, identityId, now, now);
    const messageId = (db.prepare("SELECT id FROM messages").get() as { id: number }).id;
    return { identityId, messageId, now };
  };

  it("远程 ID 以 TEXT 保存，超 2^53 无精度损失", () => {
    seed();
    const row = db.prepare("SELECT zoho_message_id AS id FROM messages").get() as { id: string };
    expect(typeof row.id).toBe("string");
    expect(row.id).toBe("999999999999999999");
  });

  it("from_domain 生成列做了小写归一", () => {
    seed();
    const row = db.prepare("SELECT from_domain AS d FROM messages").get() as { d: string };
    expect(row.d).toBe("acme.example");
  });

  it("from_address 为 NULL 时 from_domain 也是 NULL", () => {
    const now = Date.now();
    db.prepare("INSERT INTO profiles VALUES ('p','a@b.example','com',?,?)").run(now, now);
    db.prepare(
      `INSERT INTO messages(profile_id,account_id,zoho_message_id,folder_id,first_synced_at,last_synced_at)
       VALUES ('p','A','1','inbox',?,?)`,
    ).run(now, now);
    const row = db.prepare("SELECT from_domain AS d FROM messages").get() as { d: string | null };
    expect(row.d).toBeNull();
  });

  it("同一 message 重复 upsert 不产生重复行", () => {
    const { now } = seed();
    const insert = db.prepare(
      `INSERT INTO messages(profile_id,account_id,zoho_message_id,folder_id,first_synced_at,last_synced_at)
       VALUES ('primary','ACC','999999999999999999','inbox',?,?)
       ON CONFLICT(profile_id,account_id,zoho_message_id) DO UPDATE SET last_synced_at=excluded.last_synced_at`,
    );
    insert.run(now, now);
    insert.run(now, now);
    expect((db.prepare("SELECT count(*) AS c FROM messages").get() as { c: number }).c).toBe(1);
  });

  it("删除 message 级联删除 recipients 与 attachments", () => {
    const { messageId, now } = seed();
    db.prepare(
      "INSERT INTO message_recipients(message_pk,recipient_type,address) VALUES (?,'to','a@b.example')",
    ).run(messageId);
    db.prepare(
      `INSERT INTO attachments(message_pk,zoho_attachment_id,filename,first_synced_at,last_synced_at)
       VALUES (?,'att1','f.pdf',?,?)`,
    ).run(messageId, now, now);

    db.prepare("DELETE FROM messages WHERE id = ?").run(messageId);
    expect(
      (db.prepare("SELECT count(*) AS c FROM message_recipients").get() as { c: number }).c,
    ).toBe(0);
    expect((db.prepare("SELECT count(*) AS c FROM attachments").get() as { c: number }).c).toBe(0);
  });

  it("删除身份不删邮件，只把 matched_identity_id 置 NULL", () => {
    const { identityId } = seed();
    db.prepare("DELETE FROM account_identities WHERE id = ?").run(identityId);
    const row = db.prepare("SELECT matched_identity_id AS m FROM messages").get() as {
      m: number | null;
    };
    // 邮件是从 Zoho 同步来的事实，不该因为本地身份记录变化而消失
    expect(row).toBeDefined();
    expect(row.m).toBeNull();
  });

  it("STRICT 表拒绝错误的列类型", () => {
    expect(() =>
      db.prepare("INSERT INTO audit_log(action,created_at) VALUES ('x','not-a-number')").run(),
    ).toThrow();
  });

  it("recipient_type 的 CHECK 约束生效", () => {
    const { messageId } = seed();
    expect(() =>
      db
        .prepare(
          "INSERT INTO message_recipients(message_pk,recipient_type,address) VALUES (?,'xx','a@b.example')",
        )
        .run(messageId),
    ).toThrow();
  });

  it("关键查询走索引而非全表扫描", () => {
    seed();
    // EXPLAIN QUERY PLAN 仍需绑定占位符的值，否则 better-sqlite3 直接拒绝
    const plan = (sql: string, ...params: unknown[]) =>
      (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params) as Array<{ detail: string }>)
        .map((r) => r.detail)
        .join(" | ");

    expect(
      plan(
        "SELECT * FROM messages WHERE profile_id=? AND folder_id=? ORDER BY received_at DESC",
        "primary",
        "inbox",
      ),
    ).toContain("idx_messages_folder_time");

    expect(plan("SELECT * FROM messages WHERE from_domain=?", "acme.example")).toContain(
      "idx_messages_from_domain",
    );

    expect(plan("SELECT * FROM messages WHERE profile_id=? AND is_read=0", "primary")).toContain(
      "idx_messages_unread",
    );

    expect(plan("SELECT * FROM message_recipients WHERE address=?", "a@b.example")).toContain(
      "idx_recipients_address",
    );

    // 没有索引时应该是 SCAN —— 反向确认上面的断言真的在检测索引使用
    expect(plan("SELECT * FROM messages WHERE summary=?", "x")).toContain("SCAN");
  });

  it("normalizer_version 与代码一致", () => {
    expect(readNormalizerVersion(db)).toBe(1);
  });

  it("完整性检查通过", () => {
    seed();
    const result = verifyIntegrity(db);
    expect(result.problems).toEqual([]);
    expect(result.ok).toBe(true);
  });
});
