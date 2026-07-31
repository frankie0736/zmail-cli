/**
 * Zoho 响应 → 本地 schema 的字段映射。实施计划 §12。
 *
 * 设计要点：
 *   - 收件人在**列表阶段**就解析（Phase 0-2 实测 toAddress/ccAddress 随列表返回），
 *     正文抓取失败时收件人的可检索性仍然保住
 *   - 所有 ID 走 toOpaqueId，绝不数值化
 *   - 所有可空字段走 normalizeNullish，处理 "null" / "" 这类脏值
 */

import { convert } from "html-to-text";
import { normalizeNullish, toOpaqueId } from "../zoho/json.js";

export interface NormalizedRecipient {
  type: "to" | "cc" | "bcc";
  name: string | null;
  address: string;
}

export interface NormalizedMessage {
  zohoMessageId: string;
  zohoThreadId: string | null;
  folderId: string;
  subject: string | null;
  fromName: string | null;
  fromAddress: string | null;
  replyToAddress: string | null;
  summary: string | null;
  bodyText: string | null;
  bodyHtml: string | null;
  receivedAt: number | null;
  sentAt: number | null;
  sizeBytes: number | null;
  isRead: boolean;
  isFlagged: boolean;
  hasAttachments: boolean;
  recipients: NormalizedRecipient[];
  rawJson: string | null;
}

/**
 * 解码 HTML 实体。
 *
 * Zoho 的**正文响应会把地址字段做 HTML 转义**：
 *
 *   &quot;John Doe&quot; &lt;john@example.com&gt;
 *
 * 不解码的话尖括号规则匹配不上，解析器会把实体残片当成地址的一部分，
 * 产出 `john@example.com&gt` 这种垃圾。后果是身份匹配全部落空、
 * 按收件人搜索失效 —— 而且不报错。真实数据上实际踩到过。
 */
export function decodeHtmlEntities(text: string): string {
  const named: Record<string, string> = {
    amp: "&",
    lt: "<",
    gt: ">",
    quot: '"',
    apos: "'",
    nbsp: " ",
  };
  return text.replace(/&(#x?[0-9a-f]+|[a-z]+);?/gi, (match, entity: string) => {
    if (entity.startsWith("#")) {
      const code =
        entity.startsWith("#x") || entity.startsWith("#X")
          ? Number.parseInt(entity.slice(2), 16)
          : Number.parseInt(entity.slice(1), 10);
      return Number.isFinite(code) && code > 0 ? String.fromCodePoint(code) : match;
    }
    return named[entity.toLowerCase()] ?? match;
  });
}

/**
 * 解析 Zoho 的地址字段。
 *
 * 实际格式多样：
 *   "a@b.com"
 *   "Name <a@b.com>"
 *   "a@b.com,c@d.com"
 *   "\"Doe, John\" <john@x.com>, jane@y.com"
 *   "&quot;Doe&quot; &lt;john@x.com&gt;"   ← 正文响应中的转义形式
 *
 * 逗号既是分隔符又可能出现在引号内的显示名里，因此不能简单 split(",")。
 */
export function parseAddressList(raw: unknown): Array<{ name: string | null; address: string }> {
  const decoded = normalizeNullish(raw);
  if (!decoded) return [];
  // 先解码再解析 —— 顺序反了就白做
  const text = decodeHtmlEntities(decoded);

  const parts: string[] = [];
  let current = "";
  let inQuotes = false;
  let inAngle = false;

  for (const ch of text) {
    if (ch === '"') inQuotes = !inQuotes;
    else if (ch === "<") inAngle = true;
    else if (ch === ">") inAngle = false;

    if ((ch === "," || ch === ";") && !inQuotes && !inAngle) {
      parts.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  if (current.trim()) parts.push(current);

  const out: Array<{ name: string | null; address: string }> = [];
  for (const part of parts) {
    const trimmed = part.trim();
    if (!trimmed) continue;

    const angled = /^(.*?)<([^>]+)>$/.exec(trimmed);
    if (angled) {
      const name = angled[1]?.trim().replace(/^"|"$/g, "") ?? "";
      const inner = angled[2]?.trim() ?? "";
      const address = /[\w.!#$%&'*+/=?^`{|}~-]+@[\w-]+(?:\.[\w-]+)+/.exec(inner)?.[0];
      if (address) out.push({ name: name || null, address: address.toLowerCase() });
      continue;
    }
    // 兜底：从任意文本中抽出邮件地址本身，丢掉周围的残渣。
    // 即使上游出现未预料的转义形式，也不会把垃圾写进 message_recipients。
    const bare = /[\w.!#$%&'*+/=?^`{|}~-]+@[\w-]+(?:\.[\w-]+)+/.exec(trimmed);
    if (bare) out.push({ name: null, address: bare[0].toLowerCase() });
  }
  return out;
}

/**
 * HTML → 纯文本。实施计划 §12。
 *
 * 保留引用层级边界与链接目标；去掉 script/style。
 * 不尝试完美识别签名和历史引用 —— 那需要启发式规则，误判的代价
 * （丢失正文）大于收益。
 */
export function htmlToText(html: string): string {
  return convert(html, {
    wordwrap: false,
    selectors: [
      { selector: "script", format: "skip" },
      { selector: "style", format: "skip" },
      // 图片对全文检索没有价值，且 alt 常是噪声
      { selector: "img", format: "skip" },
      // 保留链接目标：邮件里的 URL 是可检索的重要信息
      { selector: "a", options: { hideLinkHrefIfSameAsText: true } },
      // 引用块保留缩进标记，让 Agent 能看出层级
      { selector: "blockquote", format: "blockquote" },
    ],
  })
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Zoho 的时间戳是毫秒 epoch 的字符串。 */
function parseTimestamp(raw: unknown): number | null {
  const text = normalizeNullish(raw);
  if (!text) return null;
  const n = Number(text);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n;
}

/** Zoho 用字符串 "0"/"1" 表达布尔。 */
const truthy = (raw: unknown): boolean => {
  const t = normalizeNullish(raw);
  return t === "1" || t === "true";
};

export interface ListItem {
  messageId?: string | number;
  threadId?: string | number;
  folderId?: string | number;
  subject?: string;
  sender?: string;
  fromAddress?: string;
  toAddress?: string;
  ccAddress?: string;
  summary?: string;
  receivedTime?: string;
  sentDateInGMT?: string;
  hasAttachment?: string;
  size?: number | string;
  /** Zoho 的已读标志：实测 "0" 表示未读。 */
  status?: string;
  flagid?: string;
}

/**
 * 由列表项构造消息。
 *
 * 此时还没有正文 —— bodyText/bodyHtml 为 null，等正文请求补齐。
 * 但收件人已经可用，因此即使正文抓取失败，「发给谁」仍然可搜。
 */
export function normalizeListItem(item: ListItem): NormalizedMessage {
  const recipients: NormalizedRecipient[] = [
    ...parseAddressList(item.toAddress).map((r) => ({ ...r, type: "to" as const })),
    ...parseAddressList(item.ccAddress).map((r) => ({ ...r, type: "cc" as const })),
  ];

  const from = parseAddressList(item.fromAddress)[0];

  return {
    zohoMessageId: toOpaqueId(item.messageId, "messageId"),
    zohoThreadId: item.threadId === undefined ? null : toOpaqueId(item.threadId, "threadId"),
    folderId: toOpaqueId(item.folderId, "folderId"),
    subject: normalizeNullish(item.subject),
    // sender 是显示名，fromAddress 才是地址
    fromName: normalizeNullish(item.sender) ?? from?.name ?? null,
    fromAddress: from?.address ?? null,
    replyToAddress: null,
    summary: normalizeNullish(item.summary),
    bodyText: null,
    bodyHtml: null,
    receivedAt: parseTimestamp(item.receivedTime),
    sentAt: parseTimestamp(item.sentDateInGMT),
    sizeBytes: item.size === undefined ? null : Number(item.size) || null,
    // 实测 status="0" 表示未读
    isRead: normalizeNullish(item.status) !== "0",
    isFlagged: (normalizeNullish(item.flagid) ?? "flag_not_set") !== "flag_not_set",
    hasAttachments: truthy(item.hasAttachment),
    recipients,
    rawJson: null,
  };
}

export interface ContentPayload {
  content?: string;
  subject?: string;
  fromAddress?: string;
  toAddress?: string;
  ccAddress?: string;
  bccAddress?: string;
  replyTo?: string;
  receivedTime?: string;
}

export interface MergeContentOptions {
  keepBodyHtml: boolean;
  keepRawJson: boolean;
  rawText?: string | undefined;
}

/**
 * 把正文响应合并进已有的消息。
 *
 * 正文里的收件人比列表更完整（含 bcc），因此覆盖而不是追加 ——
 * 追加会产生重复行。
 */
export function mergeContent(
  base: NormalizedMessage,
  payload: ContentPayload,
  opts: MergeContentOptions,
): NormalizedMessage {
  const html = normalizeNullish(payload.content);
  const bodyText = html ? htmlToText(html) : base.bodyText;

  const fromContent: NormalizedRecipient[] = [
    ...parseAddressList(payload.toAddress).map((r) => ({ ...r, type: "to" as const })),
    ...parseAddressList(payload.ccAddress).map((r) => ({ ...r, type: "cc" as const })),
    ...parseAddressList(payload.bccAddress).map((r) => ({ ...r, type: "bcc" as const })),
  ];

  return {
    ...base,
    subject: normalizeNullish(payload.subject) ?? base.subject,
    bodyText,
    bodyHtml: opts.keepBodyHtml ? html : null,
    replyToAddress: parseAddressList(payload.replyTo)[0]?.address ?? null,
    recipients: fromContent.length > 0 ? fromContent : base.recipients,
    rawJson: opts.keepRawJson ? (opts.rawText ?? null) : null,
  };
}

/**
 * 匹配这封邮件命中了本账号的哪个收件身份（§11.8）。
 *
 * 多个身份同时命中时：primary 优先，其次 to 早于 cc。
 * 规则必须确定，否则同一封邮件在两次同步中可能被归到不同身份。
 */
export function matchIdentity(
  recipients: NormalizedRecipient[],
  identities: Array<{ id: number; address: string; isPrimary: boolean }>,
): number | null {
  if (identities.length === 0) return null;
  const byAddress = new Map(identities.map((i) => [i.address.toLowerCase(), i]));

  const order: Array<"to" | "cc" | "bcc"> = ["to", "cc", "bcc"];
  let best: { id: number; isPrimary: boolean; rank: number } | null = null;

  for (const r of recipients) {
    const identity = byAddress.get(r.address.toLowerCase());
    if (!identity) continue;
    const rank = order.indexOf(r.type);
    if (
      best === null ||
      (identity.isPrimary && !best.isPrimary) ||
      (identity.isPrimary === best.isPrimary && rank < best.rank)
    ) {
      best = { id: identity.id, isPrimary: identity.isPrimary, rank };
    }
  }
  return best?.id ?? null;
}
