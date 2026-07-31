/**
 * SQLite 连接与 migration runner。实施计划 §11.1 / §6.2。
 *
 * 数据库实现藏在 MailDatabase 接口之后，未来切到 node:sqlite 时
 * 不需要改 CLI、Zoho Client 和同步逻辑。
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { ErrorCode, ZmailError } from "../core/errors.js";

export type SqliteDatabase = Database.Database;

/** 当前代码期望的 schema 版本 = migrations 目录中最大的编号。 */
export interface Migration {
  version: number;
  name: string;
  sql: string;
}

/**
 * 定位 migrations 目录。
 *
 * 开发时是 <repo>/migrations，安装后 dist/cli.js 与 migrations/ 同级于包根，
 * 两种布局都要能找到。
 */
export function findMigrationsDir(fromUrl = import.meta.url): string {
  const here = dirname(fileURLToPath(fromUrl));
  const candidates = [
    join(here, "..", "..", "migrations"), // src/db/database.ts → repo/migrations
    join(here, "..", "migrations"), // dist/cli.js → package/migrations
    join(here, "migrations"),
  ];
  for (const dir of candidates) {
    if (existsSync(dir)) return dir;
  }
  throw new ZmailError(ErrorCode.MIGRATION_FAILED, "找不到 migrations 目录", {
    details: { searched: candidates },
    hint: "安装可能不完整，尝试重新安装 zmail-cli",
  });
}

const MIGRATION_FILE = /^(\d{3})_([a-z0-9_]+)\.sql$/;

export function loadMigrations(dir = findMigrationsDir()): Migration[] {
  const migrations: Migration[] = [];
  for (const file of readdirSync(dir).sort()) {
    const m = MIGRATION_FILE.exec(file);
    if (!m) continue;
    const [, versionStr, name] = m;
    migrations.push({
      version: Number(versionStr),
      name: name as string,
      sql: readFileSync(join(dir, file), "utf8"),
    });
  }
  migrations.sort((a, b) => a.version - b.version);

  // 编号必须从 1 开始且连续 —— 断号说明有 migration 文件丢失，
  // 继续执行会得到一个结构不完整的库
  migrations.forEach((mig, i) => {
    if (mig.version !== i + 1) {
      throw new ZmailError(
        ErrorCode.MIGRATION_FAILED,
        `migration 编号不连续：期望 ${i + 1}，实际 ${mig.version} (${mig.name})`,
      );
    }
  });

  return migrations;
}

export const latestSchemaVersion = (migrations = loadMigrations()): number =>
  migrations.length === 0 ? 0 : (migrations.at(-1)?.version ?? 0);

/** 打开数据库并应用连接级 PRAGMA（§11.1）。 */
export function openDatabase(dbPath: string): SqliteDatabase {
  let db: SqliteDatabase;
  try {
    db = new Database(dbPath);
  } catch (err) {
    throw new ZmailError(ErrorCode.DATABASE_ERROR, `无法打开数据库: ${dbPath}`, {
      cause: err,
      details: { path: dbPath },
    });
  }

  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  db.pragma("synchronous = NORMAL");
  return db;
}

export function currentSchemaVersion(db: SqliteDatabase): number {
  const hasTable = db
    .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='schema_migrations'")
    .get();
  if (!hasTable) return 0;
  const row = db.prepare("SELECT MAX(version) AS v FROM schema_migrations").get() as
    | { v: number | null }
    | undefined;
  return row?.v ?? 0;
}

/**
 * 执行所有未应用的 migration。
 *
 * 每个 migration 在**独立事务**中运行：失败时只回滚它自己，
 * 已成功的保持已应用状态，重跑可以从断点继续。
 */
export function migrate(db: SqliteDatabase, migrations = loadMigrations()): number[] {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at INTEGER NOT NULL
    ) STRICT;
  `);

  const current = currentSchemaVersion(db);
  const target = latestSchemaVersion(migrations);

  // 库比代码新：老版本 CLI 不该猜新 schema 的语义，写入可能损坏数据
  if (current > target) {
    throw new ZmailError(
      ErrorCode.SCHEMA_TOO_NEW,
      `数据库 schema 版本 ${current} 高于当前 zmail 支持的 ${target}`,
      { hint: "升级 zmail-cli：npm install -g zmail-cli@latest" },
    );
  }

  const applied: number[] = [];
  const record = db.prepare(
    "INSERT INTO schema_migrations(version, name, applied_at) VALUES (?, ?, ?)",
  );

  for (const mig of migrations) {
    if (mig.version <= current) continue;

    // better-sqlite3 的 transaction() 不能包含 DDL 之外的隐式提交语句，
    // 这里全是 DDL，安全。
    const run = db.transaction(() => {
      db.exec(mig.sql);
      record.run(mig.version, mig.name, Date.now());
    });

    try {
      run();
      applied.push(mig.version);
    } catch (err) {
      throw new ZmailError(
        ErrorCode.MIGRATION_FAILED,
        `migration ${String(mig.version).padStart(3, "0")}_${mig.name} 执行失败`,
        {
          cause: err,
          details: {
            version: mig.version,
            name: mig.name,
            sqliteMessage: (err as Error).message,
          },
        },
      );
    }
  }

  return applied;
}

/** PRAGMA integrity_check + FTS5 integrity-check。 */
export function verifyIntegrity(db: SqliteDatabase): { ok: boolean; problems: string[] } {
  const problems: string[] = [];

  const rows = db.pragma("integrity_check") as Array<{ integrity_check: string }>;
  for (const row of rows) {
    if (row.integrity_check !== "ok") problems.push(`integrity_check: ${row.integrity_check}`);
  }

  const fkRows = db.pragma("foreign_key_check") as unknown[];
  if (fkRows.length > 0) problems.push(`foreign_key_check: ${fkRows.length} 处外键冲突`);

  const hasFts = db
    .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='messages_fts'")
    .get();
  if (hasFts) {
    try {
      db.exec("INSERT INTO messages_fts(messages_fts) VALUES('integrity-check')");
    } catch (err) {
      problems.push(`FTS5 integrity-check: ${(err as Error).message}`);
    }
  }

  return { ok: problems.length === 0, problems };
}

/** 读取索引规范化版本。与代码不一致时必须 rebuild-index（§13.1.2）。 */
export function readNormalizerVersion(db: SqliteDatabase): number | null {
  const hasTable = db
    .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='index_meta'")
    .get();
  if (!hasTable) return null;
  const row = db.prepare("SELECT value FROM index_meta WHERE key = 'normalizer_version'").get() as
    | { value: string }
    | undefined;
  return row ? Number(row.value) : null;
}
