/**
 * 日志与错误信息脱敏。
 *
 * 实施计划 §20.1：日志禁止出现 access token、refresh token、client secret、
 * 完整 Authorization Header、完整邮件正文、未脱敏收件人列表。
 *
 * 这里是**最后一道防线**。调用方仍应从一开始就不要把 secret 传进来。
 */

/** 运行期登记的敏感值。进程内全局，因为 secret 可能在任意深度被拼进字符串。 */
const registered = new Set<string>();

/** 登记一个需要在所有输出中抹掉的值。短值忽略，避免误伤正常文本。 */
export function registerSecret(value: string | undefined | null): void {
  if (typeof value === "string" && value.length >= 8) registered.add(value);
}

/** 仅供测试使用。 */
export function clearRegisteredSecrets(): void {
  registered.clear();
}

/** 字段名匹配即整体替换，不看值。 */
const SENSITIVE_KEY =
  /(^|_|\.|-)(token|secret|password|passwd|passphrase|credential|cookie|authorization|auth|signature|apikey|api_key)($|_|\.|-)/i;

/** 值本身像凭据的模式。 */
const SECRET_VALUE_PATTERNS: Array<[RegExp, string]> = [
  // Zoho OAuth token：1000.<32hex>.<32hex>
  [/\b1000\.[a-f0-9]{16,}\.[a-f0-9]{16,}\b/gi, "[REDACTED_ZOHO_TOKEN]"],
  // Authorization header
  [/\b(Zoho-oauthtoken|Bearer|Basic)\s+\S+/gi, "$1 [REDACTED]"],
];

export const REDACTED = "[REDACTED]";

/** 对任意字符串做脱敏。 */
export function redactString(input: string): string {
  let out = input;
  for (const secret of registered) {
    if (secret && out.includes(secret)) out = out.split(secret).join(REDACTED);
  }
  for (const [pattern, replacement] of SECRET_VALUE_PATTERNS) {
    out = out.replace(pattern, replacement);
  }
  return out;
}

/**
 * 邮箱地址脱敏：保留域名，遮蔽 local part。
 * 日志里需要能看出「发给哪个域」，但不该留下完整地址。
 */
export function redactEmail(address: string): string {
  const at = address.lastIndexOf("@");
  if (at <= 0) return REDACTED;
  const local = address.slice(0, at);
  const domain = address.slice(at + 1);
  const head = local.slice(0, 1);
  return `${head}${"*".repeat(Math.max(local.length - 1, 1))}@${domain}`;
}

/** 长文本截断，避免整封正文进日志。 */
export function truncate(text: string, max = 200): string {
  return text.length <= max ? text : `${text.slice(0, max)}…(+${text.length - max})`;
}

/** 递归脱敏任意值，用于日志。深度受限，避免循环引用打爆栈。 */
export function redactValue(value: unknown, depth = 0): unknown {
  if (depth > 8) return "[TRUNCATED_DEPTH]";
  if (typeof value === "string") return redactString(value);
  if (Array.isArray(value)) return value.map((v) => redactValue(v, depth + 1));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [
        k,
        SENSITIVE_KEY.test(k) ? REDACTED : redactValue(v, depth + 1),
      ]),
    );
  }
  return value;
}
