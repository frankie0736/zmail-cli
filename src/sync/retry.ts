/**
 * 限流与重试策略。实施计划 §14.5。
 *
 * 规则按错误类型区分，不是无差别重试：
 *
 *   429      尊重 Retry-After；没有该头则指数退避
 *   5xx      有限次数指数退避
 *   网络中断  重试
 *   401      刷新一次 token 后重试（由 ZohoClient 处理，不在这里）
 *   403      **不重试** —— scope 不足，再试一万次也是一样
 *   404      **不重试** —— 交由对账处理
 *   其他 4xx  **不重试**
 *
 * 无差别重试比不重试更糟：403 重试三次只是把「权限不足」变成「三倍延迟后的
 * 权限不足」，还浪费配额。
 */

import { ZmailError } from "../core/errors.js";

export interface RetryOptions {
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  /** 注入以便测试时不真的睡眠。 */
  sleep?: (ms: number) => Promise<void>;
  /** 每次重试前回调，用于结构化日志。 */
  onRetry?: (info: { attempt: number; delayMs: number; code: string; reason: string }) => void;
  /** 注入随机抖动，测试时固定为 0。 */
  jitter?: () => number;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * 哪些错误值得重试。
 *
 * 以 ZmailError 自带的 `retryable` 为准，而不是在这里维护第二份错误码清单 ——
 * 两份清单迟早会不一致，而不一致的那一刻没人会发现。
 * 抛错方最清楚自己那次失败是不是暂时的（例如 5xx 可重试、4xx 不可）。
 */
export function isRetryable(err: unknown): boolean {
  return err instanceof ZmailError && err.retryable;
}

/**
 * 从 429 错误中提取 Retry-After（秒）。
 *
 * Phase 0-2 未能确认 Zoho 是否发送该头（邮箱太小，触发不了限流），
 * 因此两种情况都必须处理。
 */
export function retryAfterMs(err: unknown): number | null {
  if (!(err instanceof ZmailError)) return null;
  const raw = err.details.retryAfter;
  if (raw === null || raw === undefined) return null;
  const seconds = Number(raw);
  if (!Number.isFinite(seconds) || seconds < 0) return null;
  // 上限保护：服务端给出离谱的值时不能真的睡那么久
  return Math.min(seconds * 1000, 300_000);
}

/**
 * 带退避的重试执行器。
 */
export async function withRetry<T>(fn: () => Promise<T>, opts: RetryOptions = {}): Promise<T> {
  const {
    maxAttempts = 5,
    baseDelayMs = 1000,
    maxDelayMs = 60_000,
    sleep = defaultSleep,
    onRetry = () => {},
    jitter = Math.random,
  } = opts;

  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;

      if (!isRetryable(err) || attempt === maxAttempts) throw err;

      const code = err instanceof ZmailError ? err.code : "UNKNOWN";
      const serverDelay = retryAfterMs(err);

      // 服务端明确说了等多久就等多久，别自作聪明
      const delayMs =
        serverDelay ?? Math.min(baseDelayMs * 2 ** (attempt - 1) * (0.5 + jitter()), maxDelayMs);

      onRetry({
        attempt,
        delayMs: Math.round(delayMs),
        code,
        reason: serverDelay !== null ? "retry-after" : "exponential-backoff",
      });

      await sleep(delayMs);
    }
  }

  throw lastError;
}
