/**
 * zmail init —— 创建数据目录、config.json 和数据库。
 *
 * 实施计划 §7.4：安装包只安装程序，首次运行才创建 ~/.zmail/。
 * 升级不覆盖用户数据，卸载不删除用户数据。
 */

import { existsSync } from "node:fs";
import {
  checkPermissions,
  ensureDataDir,
  fixPermissions,
  supportsPosixPermissions,
} from "../config/paths.js";
import { defaultConfig } from "../config/schema.js";
import { configExists, saveConfig } from "../config/store.js";
import type { Context } from "../core/context.js";
import { latestSchemaVersion, migrate, openDatabase } from "../db/database.js";

export interface InitResult {
  dataDir: string;
  configFile: string;
  databaseFile: string;
  created: boolean;
  schemaVersion: number;
  appliedMigrations: number[];
  permissionsFixed: string[];
}

export async function runInit(ctx: Context): Promise<void> {
  const { paths, out } = ctx;
  const alreadyInitialized = configExists(paths.configFile);

  out.event("init_start", { dataDir: paths.root, alreadyInitialized });

  // 目录创建是幂等的：已存在时只确保权限正确
  ensureDataDir(paths);

  // 已有配置时绝不覆盖 —— 那会丢掉用户的 profile 和同步设置
  if (!alreadyInitialized) {
    saveConfig(paths.configFile, defaultConfig());
  }

  const db = openDatabase(paths.databaseFile);
  let applied: number[];
  try {
    applied = migrate(db);
  } finally {
    db.close();
  }

  // 从备份恢复或 rsync 同步过来的目录权限常常是 0755；
  // umask 管不了已存在的文件，必须主动修
  let permissionsFixed: string[] = [];
  if (supportsPosixPermissions) {
    const issues = checkPermissions(paths);
    if (issues.length > 0) {
      fixPermissions(issues);
      permissionsFixed = issues.map((i) => i.path);
    }
  }

  const result: InitResult = {
    dataDir: paths.root,
    configFile: paths.configFile,
    databaseFile: paths.databaseFile,
    created: !alreadyInitialized,
    schemaVersion: latestSchemaVersion(),
    appliedMigrations: applied,
    permissionsFixed,
  };

  out.event("init_done", {
    created: result.created,
    appliedMigrations: applied.length,
    permissionsFixed: permissionsFixed.length,
  });

  out.emit(result, {}, (r) => {
    const lines = [
      r.created ? `已初始化 ${r.dataDir}` : `${r.dataDir} 已存在，未覆盖任何数据`,
      `  配置    ${r.configFile}`,
      `  数据库  ${r.databaseFile}  (schema v${r.schemaVersion})`,
    ];
    if (r.appliedMigrations.length > 0) {
      lines.push(`  已应用 migration: ${r.appliedMigrations.join(", ")}`);
    }
    if (r.permissionsFixed.length > 0) {
      lines.push(`  已修复 ${r.permissionsFixed.length} 处过松的权限`);
    }
    lines.push("", "下一步: zmail auth setup");
    return lines.join("\n");
  });
}

/** 供 doctor 复用：数据库文件是否存在。 */
export const databaseExists = (path: string): boolean => existsSync(path);
