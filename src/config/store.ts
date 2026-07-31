/**
 * config.json 的读写。实施计划 §8.3。
 *
 * 所有配置写入必须原子：写临时文件 → fsync → rename 替换。
 * 直接覆写原文件的话，进程在写一半时被杀会留下损坏的 config。
 */

import {
  closeSync,
  existsSync,
  fsyncSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { ZodError } from "zod";
import { ErrorCode, ZmailError } from "../core/errors.js";
import { FILE_MODE } from "./paths.js";
import { type Config, defaultConfig, parseConfig } from "./schema.js";

/**
 * 原子写文件。
 *
 * 临时文件与目标同目录 —— 跨文件系统 rename 不是原子操作，
 * 放 /tmp 会退化成 copy+unlink。
 */
export function writeFileAtomic(targetPath: string, content: string, mode = FILE_MODE): void {
  const dir = dirname(targetPath);
  const tmpPath = join(dir, `.${Date.now()}-${process.pid}.tmp`);

  let fd: number | undefined;
  try {
    fd = openSync(tmpPath, "wx", mode);
    writeSync(fd, content);
    fsyncSync(fd); // 数据落盘后才能 rename，否则崩溃时可能得到空文件
    closeSync(fd);
    fd = undefined;
    renameSync(tmpPath, targetPath);
  } catch (err) {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        /* 已经在错误路径上，关闭失败不覆盖原因 */
      }
    }
    try {
      if (existsSync(tmpPath)) unlinkSync(tmpPath);
    } catch {
      /* 清理失败不掩盖原始错误 */
    }
    throw err;
  }
}

export function configExists(configFile: string): boolean {
  return existsSync(configFile);
}

export function loadConfig(configFile: string): Config {
  if (!existsSync(configFile)) {
    throw new ZmailError(ErrorCode.NOT_INITIALIZED, `未找到配置文件: ${configFile}`, {
      hint: "先运行 zmail init",
      details: { configFile },
    });
  }

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(configFile, "utf8"));
  } catch (err) {
    throw new ZmailError(ErrorCode.CONFIG_INVALID, `配置文件不是合法 JSON: ${configFile}`, {
      cause: err,
      details: { configFile },
      hint: "手工修复该文件，或删除后重新运行 zmail init",
    });
  }

  try {
    return parseConfig(raw);
  } catch (err) {
    if (err instanceof ZodError) {
      throw new ZmailError(ErrorCode.CONFIG_INVALID, "配置文件校验失败", {
        cause: err,
        details: {
          issues: err.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
        },
      });
    }
    throw new ZmailError(ErrorCode.CONFIG_INVALID, (err as Error).message, { cause: err });
  }
}

export function saveConfig(configFile: string, config: Config): void {
  writeFileAtomic(configFile, `${JSON.stringify(config, null, 2)}\n`);
}

export function loadOrCreateConfig(configFile: string): Config {
  if (!existsSync(configFile)) {
    const config = defaultConfig();
    saveConfig(configFile, config);
    return config;
  }
  return loadConfig(configFile);
}
