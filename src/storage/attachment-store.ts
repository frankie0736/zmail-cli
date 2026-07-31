/**
 * 附件存储。实施计划 §15.2 / §15.5。
 *
 * ## 内容寻址
 *
 * 文件按 SHA-256 存放在 `attachments/<前2位>/<完整哈希>`，**不使用原始文件名
 * 作为磁盘路径**。这一条同时解决三个问题：
 *
 *   1. 路径穿越 —— 磁盘路径完全由哈希决定，与不可信的文件名无关
 *   2. 去重 —— 同一份附件在多封邮件中出现只存一份
 *   3. 完整性 —— 路径本身就是校验和
 *
 * ## 下载流程
 *
 *   下载到 tmp → 计算 SHA-256 → 校验字节数 → 原子移动到最终路径 → 更新数据库
 *
 * 顺序不能变：先入库后落盘会留下「数据库说有、磁盘上没有」的幽灵记录；
 * 中断也不会留下被标记为成功的损坏文件。
 */

import { createHash } from "node:crypto";
import {
  chmodSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  renameSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { DIR_MODE, FILE_MODE } from "../config/paths.js";
import { ErrorCode, ZmailError } from "../core/errors.js";

export interface StoredBlob {
  sha256: string;
  sizeBytes: number;
  path: string;
  /** 内容此前已存在，本次未实际写入。 */
  deduplicated: boolean;
}

export class AttachmentStore {
  readonly #root: string;
  readonly #tmpDir: string;

  constructor(attachmentsDir: string, tmpDir: string) {
    this.#root = attachmentsDir;
    this.#tmpDir = tmpDir;
  }

  /** 内容寻址路径：两级目录避免单目录塞进几十万文件。 */
  pathFor(sha256: string): string {
    return join(this.#root, sha256.slice(0, 2), sha256);
  }

  has(sha256: string): boolean {
    return existsSync(this.pathFor(sha256));
  }

  /**
   * 把一个响应流落盘。
   *
   * @param expectedSize 服务端声明的字节数。不匹配即认为下载不完整。
   */
  async storeStream(
    body: ReadableStream<Uint8Array>,
    expectedSize?: number | null,
  ): Promise<StoredBlob> {
    mkdirSync(this.#tmpDir, { recursive: true, mode: DIR_MODE });
    const tmpPath = join(this.#tmpDir, `dl-${process.pid}-${performance.now().toString(36)}`);

    const hash = createHash("sha256");
    let bytes = 0;

    try {
      const out = createWriteStream(tmpPath, { mode: FILE_MODE });
      // 边写边算哈希，避免为了校验再读一遍整个文件
      const source = (async function* () {
        for await (const chunk of body) {
          const buf = Buffer.from(chunk as Uint8Array);
          hash.update(buf);
          bytes += buf.length;
          yield buf;
        }
      })();
      await pipeline(source, out);

      if (bytes === 0) {
        throw new ZmailError(ErrorCode.INCOMPLETE_DATA, "附件内容为空");
      }
      // 服务端声明的大小对不上，说明传输被截断 —— 绝不能标记为下载成功
      if (expectedSize != null && expectedSize > 0 && bytes !== expectedSize) {
        throw new ZmailError(
          ErrorCode.INCOMPLETE_DATA,
          `附件字节数不符：期望 ${expectedSize}，实际 ${bytes}`,
          { details: { expectedSize, actualSize: bytes }, retryable: true },
        );
      }

      const sha256 = hash.digest("hex");
      const finalPath = this.pathFor(sha256);

      if (existsSync(finalPath)) {
        unlinkSync(tmpPath);
        return { sha256, sizeBytes: bytes, path: finalPath, deduplicated: true };
      }

      mkdirSync(join(this.#root, sha256.slice(0, 2)), { recursive: true, mode: DIR_MODE });
      // rename 是原子的：要么完整可见，要么完全不存在
      renameSync(tmpPath, finalPath);
      chmodSync(finalPath, FILE_MODE);

      return { sha256, sizeBytes: bytes, path: finalPath, deduplicated: false };
    } catch (err) {
      // 失败时清理临时文件，不留垃圾
      try {
        if (existsSync(tmpPath)) unlinkSync(tmpPath);
      } catch {
        /* 已在错误路径上，清理失败不覆盖原因 */
      }
      throw err;
    }
  }

  /** 删除内容文件。仅供 LRU 回收与 purge 使用。 */
  evict(sha256: string): boolean {
    const path = this.pathFor(sha256);
    if (!existsSync(path)) return false;
    unlinkSync(path);
    return true;
  }

  sizeOf(sha256: string): number | null {
    const path = this.pathFor(sha256);
    return existsSync(path) ? statSync(path).size : null;
  }
}

/**
 * 计算 LRU 淘汰名单。实施计划 §15.5。
 *
 * v1.0 完全没有回收机制，附件目录只增不减。
 *
 * 淘汰只删磁盘文件、**保留数据库元数据**并把状态改回 `metadata_only`，
 * 用户再次请求时按需重新下载。被本地草稿引用或标记 pinned 的永不淘汰。
 */
export interface EvictionCandidate {
  sha256: string;
  sizeBytes: number;
  lastAccessedAt: number | null;
}

export function planEviction(
  candidates: EvictionCandidate[],
  currentBytes: number,
  quotaBytes: number,
): { evict: EvictionCandidate[]; freedBytes: number } {
  if (currentBytes <= quotaBytes) return { evict: [], freedBytes: 0 };

  // 最久未访问的先走；从未访问过的视为最旧
  const sorted = [...candidates].sort((a, b) => (a.lastAccessedAt ?? 0) - (b.lastAccessedAt ?? 0));

  const evict: EvictionCandidate[] = [];
  let freed = 0;
  for (const c of sorted) {
    if (currentBytes - freed <= quotaBytes) break;
    evict.push(c);
    freed += c.sizeBytes;
  }
  return { evict, freedBytes: freed };
}
