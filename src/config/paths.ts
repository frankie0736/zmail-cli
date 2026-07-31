/**
 * 数据目录解析与权限。实施计划 §8.2 / §8.3。
 *
 * 解析优先级：--data-dir > ZMAIL_HOME > ~/.zmail
 * 权限目标：目录 0700，文件 0600。
 */

import { chmodSync, existsSync, mkdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

export const DIR_MODE = 0o700;
export const FILE_MODE = 0o600;

export interface ZmailPaths {
  root: string;
  configFile: string;
  databaseFile: string;
  attachmentsDir: string;
  extractedDir: string;
  draftsDir: string;
  backupsDir: string;
  logsDir: string;
  locksDir: string;
  tmpDir: string;
}

/**
 * 解析数据目录。
 *
 * @param explicit --data-dir 的值（最高优先级）
 * @param env 环境变量来源，测试时可注入
 */
export function resolveDataDir(
  explicit?: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const candidate = explicit ?? env.ZMAIL_HOME ?? join(homedir(), ".zmail");
  // 相对路径按当前工作目录展开，避免不同 cwd 下指向不同位置
  return isAbsolute(candidate) ? resolve(candidate) : resolve(process.cwd(), candidate);
}

export function buildPaths(root: string): ZmailPaths {
  return {
    root,
    configFile: join(root, "config.json"),
    databaseFile: join(root, "mail.sqlite3"),
    attachmentsDir: join(root, "attachments"),
    extractedDir: join(root, "extracted"),
    draftsDir: join(root, "drafts"),
    backupsDir: join(root, "backups"),
    logsDir: join(root, "logs"),
    locksDir: join(root, "locks"),
    tmpDir: join(root, "tmp"),
  };
}

/** 所有需要预先创建的子目录。 */
const SUBDIRS: Array<keyof ZmailPaths> = [
  "attachmentsDir",
  "extractedDir",
  "draftsDir",
  "backupsDir",
  "logsDir",
  "locksDir",
  "tmpDir",
];

/**
 * 创建数据目录树并强制权限。
 *
 * mkdir 的 mode 会被 umask 削弱，因此创建后再显式 chmod —— 不能只依赖 mode 参数。
 */
export function ensureDataDir(paths: ZmailPaths): void {
  mkdirSync(paths.root, { recursive: true, mode: DIR_MODE });
  chmodSync(paths.root, DIR_MODE);

  for (const key of SUBDIRS) {
    const dir = paths[key];
    mkdirSync(dir, { recursive: true, mode: DIR_MODE });
    chmodSync(dir, DIR_MODE);
  }
}

export interface PermissionIssue {
  path: string;
  expected: string;
  actual: string;
}

/**
 * 检查目录树权限是否过松。
 *
 * 用户从备份恢复、或用 rsync 同步过来，权限很容易变成 0755 —— umask 对
 * 已存在的文件无能为力，所以 doctor 必须能主动发现并修复。
 */
export function checkPermissions(paths: ZmailPaths): PermissionIssue[] {
  const issues: PermissionIssue[] = [];
  const check = (p: string, expected: number) => {
    if (!existsSync(p)) return;
    const mode = statSync(p).mode & 0o777;
    // 只关心「比预期更松」，更严格不报错
    if ((mode & ~expected) !== 0) {
      issues.push({
        path: p,
        expected: `0${expected.toString(8)}`,
        actual: `0${mode.toString(8)}`,
      });
    }
  };

  check(paths.root, DIR_MODE);
  for (const key of SUBDIRS) check(paths[key], DIR_MODE);
  check(paths.configFile, FILE_MODE);
  check(paths.databaseFile, FILE_MODE);
  return issues;
}

/** 修复 checkPermissions 报告的问题。 */
export function fixPermissions(issues: PermissionIssue[]): void {
  for (const issue of issues) {
    const isDir = statSync(issue.path).isDirectory();
    chmodSync(issue.path, isDir ? DIR_MODE : FILE_MODE);
  }
}

/** Windows 没有 POSIX 权限位，检查无意义。 */
export const supportsPosixPermissions = process.platform !== "win32";
