/**
 * spike 用的极简并发限制器（零依赖，不引入 p-limit）。
 */

/**
 * 以固定并发度跑完所有任务，保持结果顺序。
 *
 * @template T
 * @param {Array<() => Promise<T>>} tasks
 * @param {number} concurrency
 * @returns {Promise<T[]>}
 */
export async function runWithConcurrency(tasks, concurrency) {
  const results = new Array(tasks.length);
  let next = 0;

  const worker = async () => {
    while (true) {
      const index = next++;
      if (index >= tasks.length) return;
      const task = tasks[index];
      if (!task) return;
      results[index] = await task();
    }
  };

  await Promise.all(Array.from({ length: Math.min(concurrency, tasks.length) }, worker));
  return results;
}

/** @param {number} ms */
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 统计摘要。用于把一组延迟压成可写进结论的数字。
 * @param {number[]} values
 */
export function summarize(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const at = (q) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))];
  return {
    count: sorted.length,
    min: Math.round(sorted[0] ?? 0),
    p50: Math.round(at(0.5) ?? 0),
    p95: Math.round(at(0.95) ?? 0),
    max: Math.round(sorted[sorted.length - 1] ?? 0),
    meanMs: Math.round(sorted.reduce((a, b) => a + b, 0) / sorted.length),
  };
}

/** 人类可读的时长。 */
export function humanDuration(ms) {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)} 秒`;
  const m = s / 60;
  if (m < 60) return `${m.toFixed(1)} 分钟`;
  const h = m / 60;
  if (h < 48) return `${h.toFixed(1)} 小时`;
  return `${(h / 24).toFixed(1)} 天`;
}
