/**
 * zmail doctor —— 诊断 Node、目录、权限、凭据后端、数据库和授权状态。
 *
 * 两重身份：
 *   1. 用户自助排错的入口
 *   2. Issue 模板指定的诊断信息来源（实施计划 §23.5）
 *
 * 因此输出**必须**保证不含任何 token、secret、邮箱地址和邮件内容。
 * 这一点有专门的测试守护。
 */

import { existsSync, statSync } from "node:fs";
import { checkPermissions, supportsPosixPermissions } from "../config/paths.js";
import { configExists, loadConfig } from "../config/store.js";
import type { Context } from "../core/context.js";
import {
  currentSchemaVersion,
  latestSchemaVersion,
  openDatabase,
  readNormalizerVersion,
  verifyIntegrity,
} from "../db/database.js";
import { NORMALIZER_VERSION } from "../mail/normalize-for-index.js";
import { redactEmail } from "../output/redact.js";
import { createSecretStore } from "../secrets/index.js";

type Status = "ok" | "warn" | "error";

interface Check {
  name: string;
  status: Status;
  message: string;
  hint?: string;
  data?: Record<string, unknown>;
}

export interface DoctorResult {
  healthy: boolean;
  checks: Check[];
}

const MIN_NODE_MAJOR = 22;

export async function runDoctor(ctx: Context): Promise<void> {
  const { paths, out } = ctx;
  const checks: Check[] = [];

  // ---- Node 版本 ----
  const nodeMajor = Number(process.versions.node.split(".")[0]);
  checks.push({
    name: "node",
    status: nodeMajor >= MIN_NODE_MAJOR ? "ok" : "error",
    message: `Node ${process.version} (${process.platform}-${process.arch})`,
    ...(nodeMajor < MIN_NODE_MAJOR ? { hint: `zmail-cli 需要 Node >= ${MIN_NODE_MAJOR}` } : {}),
  });

  // ---- 原生模块（开源项目首要失败源，§6.2）----
  checks.push(await checkNativeModule());

  // ---- 数据目录 ----
  if (!existsSync(paths.root)) {
    checks.push({
      name: "data-dir",
      status: "error",
      message: `数据目录不存在: ${paths.root}`,
      hint: "运行 zmail init",
    });
  } else {
    checks.push({
      name: "data-dir",
      status: "ok",
      message: paths.root,
      data: { path: paths.root },
    });

    if (supportsPosixPermissions) {
      const issues = checkPermissions(paths);
      checks.push({
        name: "permissions",
        status: issues.length === 0 ? "ok" : "warn",
        message: issues.length === 0 ? "目录 0700 / 文件 0600" : `${issues.length} 处权限过松`,
        ...(issues.length > 0
          ? {
              hint: "运行 zmail init 自动修复",
              data: { issues },
            }
          : {}),
      });
    } else {
      checks.push({
        name: "permissions",
        status: "warn",
        message: "当前平台不支持 POSIX 权限位，跳过检查",
      });
    }
  }

  // ---- 配置 ----
  const hasConfig = configExists(paths.configFile);
  if (!hasConfig) {
    checks.push({
      name: "config",
      status: "error",
      message: "未初始化",
      hint: "运行 zmail init",
    });
  } else {
    try {
      const config = loadConfig(paths.configFile);
      const profiles = Object.keys(config.profiles);
      checks.push({
        name: "config",
        status: "ok",
        message: `${profiles.length} 个 profile，默认 "${config.defaultProfile}"`,
        data: {
          profiles,
          // 邮箱地址脱敏：doctor 输出会被贴进公开 issue
          emails: Object.fromEntries(
            Object.entries(config.profiles).map(([k, p]) => [k, redactEmail(p.email)]),
          ),
        },
      });
    } catch (err) {
      checks.push({
        name: "config",
        status: "error",
        message: `配置无法读取: ${(err as Error).message}`,
      });
    }
  }

  // ---- 凭据后端（§9.5.1 要求报告安全等级）----
  checks.push(await checkSecretBackend(ctx));

  // ---- 数据库 ----
  checks.push(...checkDatabase(paths.databaseFile));

  const healthy = checks.every((c) => c.status !== "error");
  const result: DoctorResult = { healthy, checks };

  out.emit(result, { source: "local" }, renderHuman);
}

async function checkNativeModule(): Promise<Check> {
  try {
    const { default: Database } = await import("better-sqlite3");
    const db = new Database(":memory:");
    const version = (db.prepare("SELECT sqlite_version() AS v").get() as { v: string }).v;

    let fts5 = false;
    try {
      db.exec("CREATE VIRTUAL TABLE t USING fts5(a, content='', contentless_delete=1)");
      fts5 = true;
    } catch {
      fts5 = false;
    }
    db.close();

    if (!fts5) {
      return {
        name: "native-module",
        status: "error",
        message: `better-sqlite3 已加载 (SQLite ${version})，但缺少 FTS5 或 contentless_delete`,
        hint: "SQLite 构建缺少必需特性，请重装 better-sqlite3",
      };
    }
    return {
      name: "native-module",
      status: "ok",
      message: `better-sqlite3 / SQLite ${version} / FTS5 可用`,
      data: { sqliteVersion: version },
    };
  } catch (err) {
    return {
      name: "native-module",
      status: "error",
      message: `better-sqlite3 加载失败: ${(err as Error).message}`,
      hint:
        "原生模块未能安装。macOS 需要 Xcode Command Line Tools (xcode-select --install)，" +
        "Linux 需要 build-essential 和 python3。然后重新安装 zmail-cli。",
    };
  }
}

async function checkSecretBackend(ctx: Context): Promise<Check> {
  try {
    const configured = ctx.isInitialized ? ctx.config().secretBackend : null;
    const store = await createSecretStore({
      dataDir: ctx.paths.root,
      configured,
      json: ctx.out.isJson,
    });
    const info = store.info;
    const available = await store.isAvailable();

    return {
      name: "secret-backend",
      status: available ? "ok" : "warn",
      message: `${info.backend} (${info.securityLevel}) — ${info.location}`,
      ...(info.warning ? { hint: info.warning } : {}),
      data: {
        backend: info.backend,
        securityLevel: info.securityLevel,
        available,
        ...(info.warning ? { warning: info.warning } : {}),
      },
    };
  } catch (err) {
    return {
      name: "secret-backend",
      status: "error",
      message: `凭据后端不可用: ${(err as Error).message}`,
    };
  }
}

function checkDatabase(dbPath: string): Check[] {
  if (!existsSync(dbPath)) {
    return [
      { name: "database", status: "error", message: "数据库不存在", hint: "运行 zmail init" },
    ];
  }

  const checks: Check[] = [];
  let db: ReturnType<typeof openDatabase> | undefined;
  try {
    db = openDatabase(dbPath);
    const current = currentSchemaVersion(db);
    const latest = latestSchemaVersion();
    const sizeBytes = statSync(dbPath).size;

    checks.push({
      name: "database",
      status: current === latest ? "ok" : current < latest ? "warn" : "error",
      message:
        current === latest
          ? `schema v${current}，${(sizeBytes / 1024 / 1024).toFixed(1)} MB`
          : current < latest
            ? `schema v${current}，有未应用的 migration（最新 v${latest}）`
            : `schema v${current} 高于当前 zmail 支持的 v${latest}`,
      ...(current < latest
        ? { hint: "运行 zmail init 应用 migration" }
        : current > latest
          ? { hint: "升级 zmail-cli" }
          : {}),
      data: { schemaVersion: current, latestSchemaVersion: latest, sizeBytes },
    });

    // 索引规范化版本不一致 → 中文搜索会出现「存在但搜不到」（§13.1.2 不变量 3）
    const dbNormalizer = readNormalizerVersion(db);
    if (dbNormalizer !== null) {
      checks.push({
        name: "index-normalizer",
        status: dbNormalizer === NORMALIZER_VERSION ? "ok" : "warn",
        message:
          dbNormalizer === NORMALIZER_VERSION
            ? `规范化版本 v${dbNormalizer}`
            : `索引规范化版本不一致：数据库 v${dbNormalizer}，当前代码 v${NORMALIZER_VERSION}`,
        ...(dbNormalizer !== NORMALIZER_VERSION
          ? {
              hint: "运行 zmail data rebuild-index，否则部分邮件会存在但搜不到",
            }
          : {}),
        data: { database: dbNormalizer, code: NORMALIZER_VERSION },
      });
    }

    const integrity = verifyIntegrity(db);
    checks.push({
      name: "integrity",
      status: integrity.ok ? "ok" : "error",
      message: integrity.ok ? "完整性检查通过" : `${integrity.problems.length} 处问题`,
      ...(integrity.ok ? {} : { data: { problems: integrity.problems } }),
    });
  } catch (err) {
    checks.push({
      name: "database",
      status: "error",
      message: `数据库检查失败: ${(err as Error).message}`,
    });
  } finally {
    db?.close();
  }

  return checks;
}

const ICON: Record<Status, string> = { ok: "✅", warn: "⚠️ ", error: "❌" };

function renderHuman(result: DoctorResult): string {
  const lines = result.checks.map((c) => {
    const head = `${ICON[c.status]} ${c.name.padEnd(18)} ${c.message}`;
    return c.hint ? `${head}\n${" ".repeat(4)}→ ${c.hint}` : head;
  });
  lines.push("", result.healthy ? "整体状态: 正常" : "整体状态: 存在需要处理的问题");
  return lines.join("\n");
}
