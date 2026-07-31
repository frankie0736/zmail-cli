/**
 * Agent JSON 契约。实施计划 §17。
 *
 * 铁律：
 *   - stdout 只放业务结果，且 --json 下必须是**恰好一个**合法 JSON 文档
 *   - 所有进度、日志、警告走 stderr
 *   - 时间统一 ISO 8601 带时区
 *   - 远程 ID 始终是 string
 */

import type { ErrorCodeValue, ExitCodeValue, ZmailError } from "../core/errors.js";
import { redactString, redactValue } from "./redact.js";

export interface EnvelopeMeta {
  profile?: string;
  /** 数据来源：本地镜像还是刚从 Zoho 取的。Agent 据此判断新鲜度。 */
  source?: "local" | "remote" | "none";
  syncedAt?: string | null;
  nextCursor?: string | null;
  [key: string]: unknown;
}

export interface SuccessEnvelope<T> {
  ok: true;
  data: T;
  meta: EnvelopeMeta;
}

export interface ErrorEnvelope {
  ok: false;
  error: {
    code: ErrorCodeValue;
    message: string;
    retryable: boolean;
    details: Record<string, unknown>;
  };
}

export type Envelope<T> = SuccessEnvelope<T> | ErrorEnvelope;

export const successEnvelope = <T>(data: T, meta: EnvelopeMeta = {}): SuccessEnvelope<T> => ({
  ok: true,
  data,
  meta,
});

export const errorEnvelope = (err: ZmailError): ErrorEnvelope => ({
  ok: false,
  error: {
    code: err.code,
    message: redactString(err.message),
    retryable: err.retryable,
    details: redactValue(err.details) as Record<string, unknown>,
  },
});

/** ISO 8601，带本地时区偏移。 */
export function isoTimestamp(date: Date = new Date()): string {
  const pad = (n: number, w = 2) => String(Math.abs(n)).padStart(w, "0");
  const offsetMin = -date.getTimezoneOffset();
  const sign = offsetMin >= 0 ? "+" : "-";
  const offset =
    offsetMin === 0
      ? "Z"
      : `${sign}${pad(Math.floor(Math.abs(offsetMin) / 60))}:${pad(Math.abs(offsetMin) % 60)}`;
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}` +
    `.${pad(date.getMilliseconds(), 3)}${offset}`
  );
}

/**
 * 输出通道。
 *
 * 存在的意义是让「stdout 只有一个 JSON 文档」成为**结构上**的保证，
 * 而不是靠每个命令自觉。命令只调用 emit()/note()，不直接碰 console。
 */
export class OutputChannel {
  #json: boolean;
  #quiet: boolean;
  #emitted = false;
  #stdout: NodeJS.WritableStream;
  #stderr: NodeJS.WritableStream;

  constructor(opts: {
    json: boolean;
    quiet?: boolean;
    stdout?: NodeJS.WritableStream;
    stderr?: NodeJS.WritableStream;
  }) {
    this.#json = opts.json;
    this.#quiet = opts.quiet ?? false;
    this.#stdout = opts.stdout ?? process.stdout;
    this.#stderr = opts.stderr ?? process.stderr;
  }

  get isJson(): boolean {
    return this.#json;
  }

  /** 进度、警告、调试 —— 一律 stderr，永远不污染 stdout。 */
  note(message: string): void {
    if (!this.#quiet) this.#stderr.write(`${redactString(message)}\n`);
  }

  /** 结构化日志事件，走 stderr。 */
  event(evt: string, fields: Record<string, unknown> = {}): void {
    if (this.#quiet) return;
    this.#stderr.write(`${JSON.stringify({ evt, ...(redactValue(fields) as object) })}\n`);
  }

  /**
   * 输出最终业务结果。一个进程生命周期内只允许调用一次 —— 重复调用是
   * 编程错误，会破坏 §17.3 的「stdout 恰好一个 JSON 文档」契约。
   */
  emit<T>(data: T, meta: EnvelopeMeta = {}, humanRenderer?: (data: T) => string): void {
    if (this.#emitted) {
      throw new Error("OutputChannel.emit 被调用了多次，会破坏 stdout 的单文档契约");
    }
    this.#emitted = true;

    if (this.#json) {
      this.#stdout.write(`${JSON.stringify(successEnvelope(data, meta))}\n`);
      return;
    }
    this.#stdout.write(`${humanRenderer ? humanRenderer(data) : String(data)}\n`);
  }

  /** 输出错误。与 emit 互斥，同样只允许一次。 */
  emitError(err: ZmailError): void {
    if (this.#emitted) return; // 已经输出过结果，不再追加，保持单文档
    this.#emitted = true;

    if (this.#json) {
      this.#stdout.write(`${JSON.stringify(errorEnvelope(err))}\n`);
      return;
    }
    this.#stderr.write(`错误 [${err.code}] ${redactString(err.message)}\n`);
    if (err.hint) this.#stderr.write(`  → ${redactString(err.hint)}\n`);
  }

  get hasEmitted(): boolean {
    return this.#emitted;
  }
}

export type { ExitCodeValue };
