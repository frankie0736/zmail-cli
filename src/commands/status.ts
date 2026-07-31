/**
 * zmail status —— 一眼看清当前状态。
 * zmail config path / show —— 配置查看。
 */

import { existsSync, statSync } from "node:fs";
import { configExists, loadConfig } from "../config/store.js";
import type { Context } from "../core/context.js";
import { packageVersion } from "../core/version.js";
import { currentSchemaVersion, latestSchemaVersion, openDatabase } from "../db/database.js";
import { isoTimestamp } from "../output/envelope.js";
import { redactEmail } from "../output/redact.js";

export interface StatusResult {
  version: string;
  initialized: boolean;
  dataDir: string;
  schemaVersion: number | null;
  latestSchemaVersion: number;
  databaseSizeBytes: number | null;
  defaultProfile: string | null;
  profiles: Array<{
    name: string;
    email: string;
    zohoLocation: string;
    authorized: boolean;
    accountId: string | null;
  }>;
  counts: { messages: number; folders: number; attachments: number } | null;
}

export async function runStatus(ctx: Context): Promise<void> {
  const { paths, out } = ctx;
  const initialized = configExists(paths.configFile);

  const result: StatusResult = {
    version: packageVersion(),
    initialized,
    dataDir: paths.root,
    schemaVersion: null,
    latestSchemaVersion: latestSchemaVersion(),
    databaseSizeBytes: null,
    defaultProfile: null,
    profiles: [],
    counts: null,
  };

  if (initialized) {
    const config = loadConfig(paths.configFile);
    result.defaultProfile = config.defaultProfile;
    result.profiles = Object.entries(config.profiles).map(([name, p]) => ({
      name,
      // status 是给人看的常用命令，邮箱脱敏保留域名即可识别
      email: redactEmail(p.email),
      zohoLocation: p.zohoLocation,
      // accountId 存在说明账户发现已完成，即授权成功过
      authorized: p.accountId !== null,
      accountId: p.accountId,
    }));
  }

  if (existsSync(paths.databaseFile)) {
    result.databaseSizeBytes = statSync(paths.databaseFile).size;
    const db = openDatabase(paths.databaseFile);
    try {
      result.schemaVersion = currentSchemaVersion(db);
      if (result.schemaVersion >= 1) {
        const count = (table: string) =>
          (db.prepare(`SELECT count(*) AS c FROM ${table}`).get() as { c: number }).c;
        result.counts = {
          messages: count("messages"),
          folders: count("folders"),
          attachments: count("attachments"),
        };
      }
    } finally {
      db.close();
    }
  }

  out.emit(result, { source: "local", syncedAt: null }, renderStatus);
}

function renderStatus(r: StatusResult): string {
  if (!r.initialized) {
    return [
      `zmail-cli ${r.version}`,
      "",
      `未初始化。数据目录将创建在: ${r.dataDir}`,
      "",
      "运行 zmail init 开始。",
    ].join("\n");
  }

  const lines = [
    `zmail-cli ${r.version}`,
    `数据目录   ${r.dataDir}`,
    `数据库     schema v${r.schemaVersion ?? "?"}/${r.latestSchemaVersion}` +
      (r.databaseSizeBytes !== null
        ? `  ${(r.databaseSizeBytes / 1024 / 1024).toFixed(1)} MB`
        : ""),
  ];

  if (r.counts) {
    lines.push(
      `内容       ${r.counts.messages} 封邮件 / ${r.counts.folders} 个文件夹 / ${r.counts.attachments} 个附件`,
    );
  }

  lines.push("");
  if (r.profiles.length === 0) {
    lines.push("尚无 profile。运行 zmail auth setup 然后 zmail auth login。");
  } else {
    lines.push("Profile:");
    for (const p of r.profiles) {
      const marker = p.name === r.defaultProfile ? "*" : " ";
      lines.push(
        `  ${marker} ${p.name.padEnd(12)} ${p.email.padEnd(28)} ${p.zohoLocation.padEnd(8)} ${
          p.authorized ? "已授权" : "未授权"
        }`,
      );
    }
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------- config

export async function runConfigPath(ctx: Context): Promise<void> {
  ctx.out.emit(
    { configFile: ctx.paths.configFile, dataDir: ctx.paths.root },
    {},
    (d) => d.configFile,
  );
}

export async function runConfigShow(ctx: Context): Promise<void> {
  const config = ctx.config();
  // config.json 里本就不含凭据（§8.4），可以整体输出
  ctx.out.emit(config, { source: "local" }, (c) => JSON.stringify(c, null, 2));
}

export async function runVersion(ctx: Context): Promise<void> {
  const { paths } = ctx;
  let schemaVersion: number | null = null;
  if (existsSync(paths.databaseFile)) {
    const db = openDatabase(paths.databaseFile);
    try {
      schemaVersion = currentSchemaVersion(db);
    } finally {
      db.close();
    }
  }

  const { versionInfo } = await import("../core/version.js");
  const info = {
    ...versionInfo(schemaVersion ?? latestSchemaVersion()),
    generatedAt: isoTimestamp(),
  };
  ctx.out.emit(info, {}, (i) =>
    [
      `zmail-cli ${i.version}`,
      `  schema           v${i.schemaVersion}`,
      `  index normalizer v${i.indexNormalizerVersion}`,
      `  node             ${i.node} (${i.platform})`,
    ].join("\n"),
  );
}
