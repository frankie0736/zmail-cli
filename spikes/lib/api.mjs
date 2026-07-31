/**
 * 极简 Zoho Mail API 客户端（spike 用）。
 *
 * 与正式版的关键差异：spike **必须保留原始响应文本**，因为 §11.3 的
 * ID 类型分析依赖字面量，`JSON.parse` 后再 stringify 会抹掉证据。
 */

import { parsePreservingBigInts } from "./json-safe.mjs";
import { resolveRegion } from "./oauth.mjs";

/** Zoho 用自有的 Authorization 方案，不是 Bearer。 */
const authHeader = (accessToken) => `Zoho-oauthtoken ${accessToken}`;

/** 可能与限流有关的响应头，全部记录下来供 0-2 分析。 */
const RATE_LIMIT_HEADERS = [
  "retry-after",
  "x-rate-limit-limit",
  "x-rate-limit-remaining",
  "x-rate-limit-reset",
  "x-ratelimit-limit",
  "x-ratelimit-remaining",
  "x-ratelimit-reset",
];

/**
 * @param {string} path  以 / 开头的 API 路径，如 "/api/accounts"
 * @param {{accessToken: string, location?: string, method?: string, query?: Record<string,string|number>}} opts
 */
export async function apiRequest(path, opts) {
  const { accessToken, location = "com", method = "GET", query } = opts;
  const region = resolveRegion(location);

  const url = new URL(path, region.mail);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    }
  }

  const startedAt = process.hrtime.bigint();
  const res = await fetch(url.href, {
    method,
    headers: { authorization: authHeader(accessToken), accept: "application/json" },
  });
  const rawText = await res.text();
  const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1e6;

  const rateLimit = {};
  for (const h of RATE_LIMIT_HEADERS) {
    const v = res.headers.get(h);
    if (v !== null) rateLimit[h] = v;
  }

  let parsed = null;
  let lossy = [];
  let parseError = null;
  try {
    const r = parsePreservingBigInts(rawText);
    parsed = r.value;
    lossy = r.lossy;
  } catch (e) {
    parseError = e.message;
  }

  // 边界 I/O 结构化日志（不含 token、不含正文）
  console.error(
    JSON.stringify({
      evt: "api_request",
      method,
      path: url.pathname,
      status: res.status,
      elapsedMs: Math.round(elapsedMs),
      bytes: rawText.length,
      ...(Object.keys(rateLimit).length ? { rateLimit } : {}),
      ...(lossy.length ? { lossyIdFields: lossy.map((l) => l.key) } : {}),
      ...(parseError ? { parseError } : {}),
    }),
  );

  return { status: res.status, ok: res.ok, headers: Object.fromEntries(res.headers), rawText, parsed, lossy, parseError, elapsedMs, url: url.href };
}

/** Zoho 把业务错误包在 200 里，需要单独判断。 */
export function assertApiOk(result, what) {
  if (!result.ok) {
    const code = result.parsed?.data?.errorCode ?? result.parsed?.status?.code ?? result.status;
    const desc = result.parsed?.data?.moreInfo ?? result.parsed?.status?.description ?? result.rawText.slice(0, 300);
    throw new Error(`${what} 失败 (HTTP ${result.status}, code=${code}): ${desc}`);
  }
  return result;
}
