/**
 * 同步锁。实施计划 §14.6。
 *
 * 同时只允许一个写同步进程。锁按 profile 隔离，不同 profile 可并行同步。
 *
 * 关键设计：**陈旧锁只能按 PID 判断，不能按时间强杀**。
 * 一个同步 10 万封邮件的进程跑 7 小时是正常的，按「超过 N 分钟就是死锁」
 * 清理，会在用户最需要它工作的时候把它干掉，而且是静默的数据竞争。
 */

import { closeSync, existsSync, openSync, readFileSync, unlinkSync, writeSync } from "node:fs";
import { join } from "node:path";
import { ErrorCode, ZmailError } from "../core/errors.js";

export interface LockInfo {
  pid: number;
  startedAt: string;
  command: string;
  hostname: string;
}

export interface AcquireOptions {
  locksDir: string;
  profile: string;
  command: string;
  /** 注入以便测试。 */
  isProcessAlive?: (pid: number) => boolean;
  now?: () => Date;
}

/** 进程是否还活着。signal 0 不发送信号，只做存在性与权限检查。 */
export function defaultIsProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM 表示进程存在但属于其他用户 —— 仍然算活着
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

export class SyncLock {
  readonly #path: string;
  #held = false;

  private constructor(path: string) {
    this.#path = path;
  }

  static lockPath(locksDir: string, profile: string): string {
    return join(locksDir, `sync-${profile}.lock`);
  }

  /**
   * 获取锁。已被其他活进程持有时抛 SYNC_LOCKED。
   */
  static acquire(opts: AcquireOptions): SyncLock {
    const isAlive = opts.isProcessAlive ?? defaultIsProcessAlive;
    const now = opts.now ?? (() => new Date());
    const path = SyncLock.lockPath(opts.locksDir, opts.profile);

    const info: LockInfo = {
      pid: process.pid,
      startedAt: now().toISOString(),
      command: opts.command,
      hostname: process.env.HOSTNAME ?? "localhost",
    };

    const tryCreate = (): boolean => {
      let fd: number | undefined;
      try {
        // 'wx' 在文件已存在时失败 —— 这就是原子性的来源
        fd = openSync(path, "wx", 0o600);
        writeSync(fd, JSON.stringify(info, null, 2));
        return true;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "EEXIST") return false;
        throw new ZmailError(ErrorCode.DATABASE_ERROR, `无法创建同步锁: ${path}`, { cause: err });
      } finally {
        if (fd !== undefined) closeSync(fd);
      }
    };

    if (tryCreate()) {
      const lock = new SyncLock(path);
      lock.#held = true;
      return lock;
    }

    // 已存在：判断持有者是否还活着
    const existing = SyncLock.read(path);

    if (existing === null) {
      // 锁文件损坏或为空 —— 无法判断持有者，清理后重试一次
      SyncLock.#forceRemove(path);
      if (tryCreate()) {
        const lock = new SyncLock(path);
        lock.#held = true;
        return lock;
      }
      throw new ZmailError(ErrorCode.SYNC_LOCKED, "同步锁竞争失败", { details: { path } });
    }

    if (isAlive(existing.pid)) {
      throw new ZmailError(
        ErrorCode.SYNC_LOCKED,
        `另一个同步进程正在运行（PID ${existing.pid}，自 ${existing.startedAt} 起）`,
        {
          details: { pid: existing.pid, startedAt: existing.startedAt, command: existing.command },
          retryable: true,
          hint: "等待其完成，或确认该进程已死后删除锁文件",
        },
      );
    }

    // 持有者已死：清理陈旧锁。**只在 PID 确认不存在时才做这件事**
    SyncLock.#forceRemove(path);
    if (!tryCreate()) {
      throw new ZmailError(ErrorCode.SYNC_LOCKED, "清理陈旧锁后仍无法获取", { details: { path } });
    }
    const lock = new SyncLock(path);
    lock.#held = true;
    return lock;
  }

  static read(path: string): LockInfo | null {
    if (!existsSync(path)) return null;
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8")) as LockInfo;
      return typeof parsed.pid === "number" ? parsed : null;
    } catch {
      return null;
    }
  }

  static #forceRemove(path: string): void {
    try {
      unlinkSync(path);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
  }

  release(): void {
    if (!this.#held) return;
    this.#held = false;
    SyncLock.#forceRemove(this.#path);
  }

  get isHeld(): boolean {
    return this.#held;
  }

  get path(): string {
    return this.#path;
  }
}

/**
 * 在锁保护下执行。
 *
 * 用 finally 释放：同步过程中抛任何异常都不能留下一个永远清不掉的锁 ——
 * 那会让用户下次运行时看到「另一个同步正在运行」，而实际上什么都没在跑。
 */
export async function withSyncLock<T>(
  opts: AcquireOptions,
  fn: (lock: SyncLock) => Promise<T>,
): Promise<T> {
  const lock = SyncLock.acquire(opts);
  try {
    return await fn(lock);
  } finally {
    lock.release();
  }
}
