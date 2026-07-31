/**
 * 搜索服务。实施计划 §13.2 / §13.3。
 *
 * 默认模式下 Agent **不能**直接拼任意 FTS 表达式 —— 所有输入都经过
 * normalizeForIndex 与转义。`--raw-fts` 是唯一绕过入口，且明确标注
 * 中文查询在该模式下多半失效。
 */

import type { SqliteDatabase } from "../db/database.js";
import { normalizeForIndex, toAndQuery, toPhraseQuery } from "./normalize-for-index.js";

export interface SearchInput {
  profileId: string;
  /** 普通关键词，安全转义后按 AND 组合。 */
  query?: string | undefined;
  /** 精确短语。 */
  phrase?: string | undefined;
  /** 任一关键词命中即可。 */
  any?: string[] | undefined;
  /** 排除这些关键词。 */
  exclude?: string[] | undefined;
  /** 高级调试：直接传 FTS5 表达式，不做规范化。中文多半查不到。 */
  rawFts?: string | undefined;

  from?: string | undefined;
  fromDomain?: string | undefined;
  to?: string | undefined;
  folder?: string | undefined;
  after?: string | undefined;
  before?: string | undefined;
  unreadOnly?: boolean;
  hasAttachment?: boolean;
  includeRemoteDeleted?: boolean;
  limit?: number;
  offset?: number;
  sort?: "relevance" | "newest" | "oldest";
}

export interface SearchHit {
  messageId: string;
  threadId: string | null;
  folder: string | null;
  subject: string | null;
  fromName: string | null;
  fromAddress: string | null;
  receivedAt: string | null;
  hasAttachments: boolean;
  isRead: boolean;
  isRemoteDeleted: boolean;
  /** 从 body_text 生成的摘要。contentless FTS 不支持 snippet()，由应用层做。 */
  snippet: string | null;
  score: number | null;
}

const MAX_LIMIT = 500;

/** 构造 FTS5 MATCH 表达式。 */
export function buildFtsExpression(input: SearchInput): string | null {
  if (input.rawFts) return input.rawFts;

  const clauses: string[] = [];
  if (input.query) {
    const q = toAndQuery(input.query.split(/\s+/).filter(Boolean));
    if (q) clauses.push(q);
  }
  if (input.phrase) {
    const p = toPhraseQuery(input.phrase);
    if (p) clauses.push(p);
  }
  if (input.any?.length) {
    const anyClause = input.any.map(toPhraseQuery).filter(Boolean).join(" OR ");
    if (anyClause) clauses.push(`(${anyClause})`);
  }

  let expr = clauses.join(" AND ");

  if (input.exclude?.length) {
    const notClause = input.exclude
      .map(toPhraseQuery)
      .filter(Boolean)
      .map((t) => `NOT ${t}`)
      .join(" ");
    // FTS5 的 NOT 必须有左操作数
    expr = expr ? `${expr} ${notClause}` : "";
  }

  return expr || null;
}

/**
 * 生成摘要。
 *
 * 从 `body_text` 而非 FTS 索引取 —— 索引文本经过 CJK 空格化，
 * 直接展示会是「硅 胶 管」这种断裂形式（§13.1）。
 */
export function buildSnippet(
  bodyText: string | null,
  terms: string[],
  maxLen = 160,
): string | null {
  if (!bodyText) return null;
  const text = bodyText.replace(/\s+/g, " ").trim();
  if (!text) return null;

  for (const term of terms) {
    if (!term) continue;
    const idx = text.toLowerCase().indexOf(term.toLowerCase());
    if (idx >= 0) {
      const from = Math.max(0, idx - Math.floor(maxLen / 3));
      const slice = text.slice(from, from + maxLen);
      return (from > 0 ? "…" : "") + slice + (from + maxLen < text.length ? "…" : "");
    }
  }
  return text.slice(0, maxLen) + (text.length > maxLen ? "…" : "");
}

export class SearchService {
  readonly #db: SqliteDatabase;

  constructor(db: SqliteDatabase) {
    this.#db = db;
  }

  search(input: SearchInput): { hits: SearchHit[]; total: number } {
    const limit = Math.min(input.limit ?? 20, MAX_LIMIT);
    const offset = input.offset ?? 0;
    const fts = buildFtsExpression(input);

    const where: string[] = ["m.profile_id = @profileId"];
    const params: Record<string, unknown> = { profileId: input.profileId, limit, offset };

    if (!input.includeRemoteDeleted) where.push("m.is_remote_deleted = 0");
    if (input.from) {
      where.push("m.from_address = @from");
      params.from = input.from.toLowerCase();
    }
    if (input.fromDomain) {
      // 走 idx_messages_from_domain 生成列索引，而不是 LIKE '%@domain'
      where.push("m.from_domain = @fromDomain");
      params.fromDomain = input.fromDomain.toLowerCase();
    }
    if (input.to) {
      where.push(
        "EXISTS (SELECT 1 FROM message_recipients r WHERE r.message_pk = m.id AND r.address = @to)",
      );
      params.to = input.to.toLowerCase();
    }
    if (input.folder) {
      where.push(`m.folder_id IN (
        SELECT zoho_folder_id FROM folders
        WHERE profile_id = @profileId AND lower(name) = lower(@folder)
      )`);
      params.folder = input.folder;
    }
    if (input.after) {
      where.push("m.received_at >= @after");
      params.after = Date.parse(input.after);
    }
    if (input.before) {
      where.push("m.received_at <= @before");
      params.before = Date.parse(input.before);
    }
    if (input.unreadOnly) where.push("m.is_read = 0");
    if (input.hasAttachment) where.push("m.has_attachments = 1");

    const ftsJoin = fts ? "JOIN messages_fts f ON f.rowid = m.id AND messages_fts MATCH @fts" : "";
    if (fts) params.fts = fts;

    const order =
      input.sort === "oldest"
        ? "m.received_at ASC"
        : input.sort === "newest" || !fts
          ? "m.received_at DESC"
          : "bm25(messages_fts) ASC, m.received_at DESC";

    const sql = `
      SELECT
        m.id, m.zoho_message_id, m.zoho_thread_id, m.subject,
        m.from_name, m.from_address, m.received_at, m.body_text, m.summary,
        m.has_attachments, m.is_read, m.is_remote_deleted, m.folder_id,
        (SELECT name FROM folders WHERE profile_id = m.profile_id AND zoho_folder_id = m.folder_id) AS folder_name
        ${fts ? ", bm25(messages_fts) AS score" : ", NULL AS score"}
      FROM messages m
      ${ftsJoin}
      WHERE ${where.join(" AND ")}
      ORDER BY ${order}
      LIMIT @limit OFFSET @offset
    `;

    const rows = this.#db.prepare(sql).all(params) as Array<Record<string, unknown>>;

    const countSql = `
      SELECT count(*) AS c FROM messages m
      ${ftsJoin}
      WHERE ${where.join(" AND ")}
    `;
    const { c: total } = this.#db.prepare(countSql).get(params) as { c: number };

    const terms = [
      ...(input.query ? input.query.split(/\s+/) : []),
      ...(input.phrase ? [input.phrase] : []),
      ...(input.any ?? []),
    ].filter(Boolean);

    return {
      total,
      hits: rows.map((r) => ({
        messageId: String(r.zoho_message_id),
        threadId: r.zoho_thread_id === null ? null : String(r.zoho_thread_id),
        folder: (r.folder_name as string | null) ?? null,
        subject: (r.subject as string | null) ?? null,
        fromName: (r.from_name as string | null) ?? null,
        fromAddress: (r.from_address as string | null) ?? null,
        receivedAt: r.received_at === null ? null : new Date(Number(r.received_at)).toISOString(),
        hasAttachments: r.has_attachments === 1,
        isRead: r.is_read === 1,
        isRemoteDeleted: r.is_remote_deleted === 1,
        snippet: buildSnippet(
          (r.body_text as string | null) ?? (r.summary as string | null),
          terms,
        ),
        score: r.score === null ? null : Number(r.score),
      })),
    };
  }

  /** 按 Zoho ID 取单封邮件的完整内容。 */
  getMessage(profileId: string, messageId: string): Record<string, unknown> | null {
    const row = this.#db
      .prepare(`
        SELECT m.*,
          (SELECT name FROM folders WHERE profile_id = m.profile_id AND zoho_folder_id = m.folder_id) AS folder_name
        FROM messages m
        WHERE m.profile_id = ? AND m.zoho_message_id = ?
      `)
      .get(profileId, messageId) as Record<string, unknown> | undefined;
    if (!row) return null;

    const recipients = this.#db
      .prepare(
        "SELECT recipient_type, name, address FROM message_recipients WHERE message_pk = ? ORDER BY recipient_type, address",
      )
      .all(row.id as number) as Array<{
      recipient_type: string;
      name: string | null;
      address: string;
    }>;

    return {
      messageId: String(row.zoho_message_id),
      threadId: row.zoho_thread_id === null ? null : String(row.zoho_thread_id),
      folder: row.folder_name ?? null,
      subject: row.subject ?? null,
      from: { name: row.from_name ?? null, address: row.from_address ?? null },
      recipients: recipients.map((r) => ({
        type: r.recipient_type,
        name: r.name,
        address: r.address,
      })),
      receivedAt: row.received_at === null ? null : new Date(Number(row.received_at)).toISOString(),
      isRead: row.is_read === 1,
      hasAttachments: row.has_attachments === 1,
      isRemoteDeleted: row.is_remote_deleted === 1,
      bodyText: row.body_text ?? null,
      /** HTML 视为不可信数据，默认不输出（§12）。 */
      bodyHtmlAvailable: row.body_html !== null,
    };
  }

  /** 取整个线程，按时间正序。回复前必须读完整线程（§18）。 */
  getThread(profileId: string, threadId: string): Record<string, unknown>[] {
    const rows = this.#db
      .prepare(`
        SELECT zoho_message_id FROM messages
        WHERE profile_id = ? AND zoho_thread_id = ?
        ORDER BY received_at ASC
      `)
      .all(profileId, threadId) as Array<{ zoho_message_id: string }>;
    return rows
      .map((r) => this.getMessage(profileId, r.zoho_message_id))
      .filter((m): m is Record<string, unknown> => m !== null);
  }
}

export { normalizeForIndex };
