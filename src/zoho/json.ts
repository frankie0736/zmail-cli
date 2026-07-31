/**
 * 保留大整数精度的 JSON 解析。实施计划 §11.3。
 *
 * Zoho 混用带引号的字符串 ID 和裸数字 ID，且部分裸数字超出 2^53。
 * 默认 `JSON.parse` 会静默损坏它们：
 *
 *   原文     200193088841352729
 *   解析后   200193088841352740
 *
 * Node 22 的 `JSON.parse` reviver 支持 `context.source`（原始字面量文本），
 * 因此无需正则预处理即可判断是否丢精度。
 *
 * Phase 0-6 实测：本次响应中所有关键 ID（accountId、sendMailId）都被 Zoho
 * 加了引号，未出现超 2^53 的裸数字。但只验证了一个端点，messages 与
 * attachments 端点未测 —— 保精度解析必须保留。
 */

import { ErrorCode, ZmailError } from "../core/errors.js";

export interface LossyField {
  key: string;
  source: string;
  parsed: string;
}

export interface ParseResult<T> {
  value: T;
  /** 发生过精度丢失、已被保留为字符串的字段。 */
  lossy: LossyField[];
}

/**
 * `JSON.parse` reviver 的第三参数（原始字面量文本）来自
 * json-parse-with-source 提案，Node 22 已实现但 @types/node 尚未声明。
 * 在此显式建模，而不是到处 `as any`。
 */
interface ReviverContext {
  source?: string;
}
type SourceAwareReviver = (
  this: unknown,
  key: string,
  value: unknown,
  context?: ReviverContext,
) => unknown;
type SourceAwareParse = (text: string, reviver: SourceAwareReviver) => unknown;

/**
 * 解析 JSON，把所有会丢精度的整数保留为字符串。
 *
 * 安全范围内的数字保持为 number —— 不做无差别字符串化，
 * 否则 `size`、`expires_in` 这类真正的数值也会变成字符串。
 */
export function parsePreservingBigInts<T = unknown>(text: string): ParseResult<T> {
  const lossy: LossyField[] = [];

  const value = (JSON.parse as SourceAwareParse)(text, (key, val, context) => {
    if (typeof val !== "number") return val;

    const source = context?.source;
    if (typeof source !== "string") return val;

    // 只关心整数字面量；浮点数不会是 ID
    if (!/^-?\d+$/.test(source)) return val;

    if (String(val) !== source) {
      lossy.push({ key, source, parsed: String(val) });
      return source;
    }
    return val;
  }) as T;

  return { value, lossy };
}

/** 解析 Zoho 响应，失败时抛出结构化错误而非裸 SyntaxError。 */
export function parseZohoJson<T = unknown>(text: string, context: string): ParseResult<T> {
  try {
    return parsePreservingBigInts<T>(text);
  } catch (err) {
    throw new ZmailError(ErrorCode.ZOHO_API_ERROR, `${context}: 响应不是合法 JSON`, {
      cause: err,
      // 截断且不含正文，避免把邮件内容写进错误详情
      details: { preview: text.slice(0, 120) },
    });
  }
}

/**
 * 把 Zoho 的 ID 字段归一化为不透明字符串。
 *
 * Zoho 对同一类 ID 有时给字符串有时给数字，因此不能依赖类型。
 * 数字形态若已超出安全范围，说明上游解析没走保精度路径 —— 直接报错，
 * 而不是接受一个可能已损坏的值。
 */
export function toOpaqueId(value: unknown, fieldName: string): string {
  if (typeof value === "string") return value;
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) {
      throw new ZmailError(
        ErrorCode.ZOHO_API_ERROR,
        `字段 ${fieldName} 是超出安全整数范围的数字，精度可能已损坏`,
        { details: { fieldName, value: String(value) } },
      );
    }
    return String(value);
  }
  throw new ZmailError(ErrorCode.ZOHO_API_ERROR, `字段 ${fieldName} 不是合法的 ID`, {
    details: { fieldName, actualType: typeof value },
  });
}

/**
 * 归一化 Zoho 的脏空值。
 *
 * Phase 0-6 实测：`signatureId` 的值是**字符串字面量 `"null"`**，不是 JSON null。
 * 同一响应中还有 12 个空字符串字段。直接 `if (x == null)` 会把 `"null"`
 * 当成合法值使用。
 */
export function normalizeNullish(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") return String(value);
  const trimmed = value.trim();
  if (trimmed === "" || trimmed === "null" || trimmed === "undefined") return null;
  return trimmed;
}
