/**
 * 保留大整数精度的 JSON 解析，以及 ID 类型分析。
 *
 * 背景（见实施计划 §11.3）：Zoho 混用字符串与裸数字 ID。
 *   "accountId": "2560636000000008002"   ← 字符串
 *   "verifyCode": 200193088841352729     ← 裸数字，且 > 2^53
 * 默认 JSON.parse 会把后者静默变成 200193088841352740。
 *
 * Node 22 支持 JSON.parse reviver 的 context.source（原始字面量文本），
 * 无需正则预处理即可判断是否丢精度。
 */

/** JavaScript 能精确表示的最大整数 */
const MAX_SAFE = Number.MAX_SAFE_INTEGER;

/**
 * 解析 JSON，把所有会丢精度的数字保留为字符串。
 *
 * @param {string} text 原始响应文本
 * @returns {{ value: unknown, lossy: Array<{key: string, source: string, parsed: string}> }}
 *   value  解析结果，丢精度的数字已被替换为其原始字面量字符串
 *   lossy  发生过精度丢失的字段（仅字段名，不含完整路径 —— reviver 自底向上访问，
 *          构造完整路径需要额外跟踪 holder，对诊断用途没有必要）
 */
export function parsePreservingBigInts(text) {
  const lossy = [];

  const value = JSON.parse(text, function reviver(key, val, context) {
    if (typeof val !== "number" || !context || typeof context.source !== "string") {
      return val;
    }
    const source = context.source;
    // 只关心整数字面量；浮点数不是 ID
    if (!/^-?\d+$/.test(source)) return val;

    if (String(val) !== source) {
      lossy.push({ key, source, parsed: String(val) });
      return source; // 保留原始字面量，避免精度丢失
    }
    return val;
  });

  return { value, lossy };
}

/**
 * 扫描原始 JSON 文本，报告所有 ID 类字段的实际类型。
 *
 * 不依赖任何 schema —— 目的正是发现文档与现实的偏差。
 *
 * @param {string} text 原始响应文本
 * @returns {{
 *   bareNumbers: Array<{key: string, source: string, unsafe: boolean}>,
 *   numericStrings: Array<{key: string, value: string}>,
 *   nullLiterals: Array<{key: string, value: string}>
 * }}
 */
export function analyzeIdTypes(text) {
  const bareNumbers = [];
  const numericStrings = [];
  const nullLiterals = [];
  const seen = new Set();

  // 裸数字字段： "key": 12345
  for (const m of text.matchAll(/"([A-Za-z_][\w.]*)"\s*:\s*(-?\d+)(?=\s*[,}\]])/g)) {
    const [, key, source] = m;
    const dedupKey = `n:${key}:${source}`;
    if (seen.has(dedupKey)) continue;
    seen.add(dedupKey);
    bareNumbers.push({
      key,
      source,
      unsafe: source.replace("-", "").length > 15 && Math.abs(Number(source)) > MAX_SAFE,
    });
  }

  // 纯数字字符串： "key": "12345"  —— 通常就是被正确引起来的 ID
  for (const m of text.matchAll(/"([A-Za-z_][\w.]*)"\s*:\s*"(\d{10,})"/g)) {
    const [, key, value] = m;
    const dedupKey = `s:${key}`;
    if (seen.has(dedupKey)) continue;
    seen.add(dedupKey);
    numericStrings.push({ key, value });
  }

  // 脏数据： "key": "null" / "" / "undefined"
  for (const m of text.matchAll(/"([A-Za-z_][\w.]*)"\s*:\s*"(null|undefined|)"/g)) {
    const [, key, value] = m;
    const dedupKey = `x:${key}`;
    if (seen.has(dedupKey)) continue;
    seen.add(dedupKey);
    nullLiterals.push({ key, value });
  }

  return { bareNumbers, numericStrings, nullLiterals };
}
