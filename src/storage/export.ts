/**
 * 数据导出。实施计划 §16.8。
 *
 * 「你的数据不被锁定」是这个工具的三条承诺之一，而承诺只有在能被执行时
 * 才算数。eml 与 mbox 是标准格式，任何邮件客户端都能读；jsonl 供脚本消费。
 */

import { createWriteStream, mkdirSync } from "node:fs";
import { ErrorCode, ZmailError } from "../core/errors.js";
import type { SqliteDatabase } from "../db/database.js";
import { assertUsableOutDir, uniqueExportPath } from "./safe-filename.js";

export type ExportFormat = "eml" | "mbox" | "jsonl";

export interface ExportFilter {
  profileId: string;
  folder?: string | undefined;
  after?: string | undefined;
  before?: string | undefined;
  includeRemoteDeleted?: boolean;
  limit?: number | undefined;
}

export interface ExportResult {
  format: ExportFormat;
  out: string;
  exported: number;
  skipped: number;
}

interface ExportRow {
  zoho_message_id: string;
  zoho_thread_id: string | null;
  subject: string | null;
  from_name: string | null;
  from_address: string | null;
  received_at: number | null;
  body_text: string | null;
  body_html: string | null;
  folder_name: string | null;
  is_read: number;
  has_attachments: number;
}

function selectRows(db: SqliteDatabase, filter: ExportFilter): ExportRow[] {
  const where = ["m.profile_id = @profileId"];
  const params: Record<string, unknown> = { profileId: filter.profileId };
  if (!filter.includeRemoteDeleted) where.push("m.is_remote_deleted = 0");
  if (filter.folder) {
    where.push(
      "m.folder_id IN (SELECT zoho_folder_id FROM folders WHERE profile_id = @profileId AND lower(name) = lower(@folder))",
    );
    params.folder = filter.folder;
  }
  if (filter.after) {
    where.push("m.received_at >= @after");
    params.after = Date.parse(filter.after);
  }
  if (filter.before) {
    where.push("m.received_at <= @before");
    params.before = Date.parse(filter.before);
  }

  return db
    .prepare(`
      SELECT m.zoho_message_id, m.zoho_thread_id, m.subject, m.from_name, m.from_address,
             m.received_at, m.body_text, m.body_html, m.is_read, m.has_attachments,
             (SELECT name FROM folders WHERE profile_id = m.profile_id AND zoho_folder_id = m.folder_id) AS folder_name
      FROM messages m
      WHERE ${where.join(" AND ")}
      ORDER BY m.received_at ASC
      ${filter.limit ? "LIMIT @limit" : ""}
    `)
    .all({ ...params, ...(filter.limit ? { limit: filter.limit } : {}) }) as ExportRow[];
}

function recipientsOf(db: SqliteDatabase, profileId: string, messageId: string) {
  return db
    .prepare(`
      SELECT r.recipient_type, r.name, r.address
      FROM message_recipients r
      JOIN messages m ON m.id = r.message_pk
      WHERE m.profile_id = ? AND m.zoho_message_id = ?
    `)
    .all(profileId, messageId) as Array<{
    recipient_type: string;
    name: string | null;
    address: string;
  }>;
}

/** RFC 5322 头部折行与非 ASCII 编码。 */
function headerValue(raw: string | null): string {
  if (!raw) return "";
  const text = raw.replace(/[\r\n]+/g, " ").trim();
  // 非 ASCII 必须走 encoded-word，否则某些客户端会显示乱码
  // biome-ignore lint/suspicious/noControlCharactersInRegex: 检测需要编码的字符
  if (/[^ -~]/.test(text)) {
    return `=?UTF-8?B?${Buffer.from(text, "utf8").toString("base64")}?=`;
  }
  return text;
}

function toEml(
  row: ExportRow,
  recipients: Array<{ recipient_type: string; name: string | null; address: string }>,
): string {
  const to = recipients.filter((r) => r.recipient_type === "to").map((r) => r.address);
  const cc = recipients.filter((r) => r.recipient_type === "cc").map((r) => r.address);
  const date = row.received_at ? new Date(row.received_at).toUTCString() : "";

  const headers = [
    `Message-ID: <${row.zoho_message_id}@zmail.local>`,
    row.zoho_thread_id ? `X-Zmail-Thread-ID: ${row.zoho_thread_id}` : "",
    date ? `Date: ${date}` : "",
    row.from_address
      ? `From: ${row.from_name ? `${headerValue(row.from_name)} ` : ""}<${row.from_address}>`
      : "",
    to.length ? `To: ${to.join(", ")}` : "",
    cc.length ? `Cc: ${cc.join(", ")}` : "",
    `Subject: ${headerValue(row.subject)}`,
    row.folder_name ? `X-Zmail-Folder: ${row.folder_name}` : "",
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: 8bit",
  ].filter(Boolean);

  return `${headers.join("\r\n")}\r\n\r\n${(row.body_text ?? "").replace(/\r?\n/g, "\r\n")}\r\n`;
}

/**
 * mbox 的 From_ 行分隔。
 *
 * 正文中以 "From " 开头的行必须转义成 ">From "，否则解析器会把它当成
 * 下一封邮件的开始 —— 这会静默地把一封邮件劈成两封。
 */
function toMbox(eml: string, fromAddress: string | null, receivedAt: number | null): string {
  const stamp = receivedAt ? new Date(receivedAt).toUTCString() : new Date(0).toUTCString();
  const escaped = eml.replace(/^From /gm, ">From ");
  return `From ${fromAddress ?? "unknown@localhost"} ${stamp}\n${escaped}\n`;
}

export async function exportMessages(
  db: SqliteDatabase,
  format: ExportFormat,
  out: string,
  filter: ExportFilter,
  onProgress?: (done: number) => void,
): Promise<ExportResult> {
  const rows = selectRows(db, filter);
  if (rows.length === 0) {
    throw new ZmailError(ErrorCode.NOT_FOUND, "没有符合条件的邮件可导出", {
      hint: "先运行 zmail sync，或放宽过滤条件",
    });
  }

  let exported = 0;
  const skipped = 0;

  if (format === "eml") {
    const dir = assertUsableOutDir(out);
    mkdirSync(dir, { recursive: true });
    const { writeFileSync } = await import("node:fs");
    for (const row of rows) {
      const eml = toEml(row, recipientsOf(db, filter.profileId, row.zoho_message_id));
      // 文件名来自主题（不可信），必须消毒；同名不覆盖
      const base = `${row.received_at ? new Date(row.received_at).toISOString().slice(0, 10) : "undated"}-${row.subject ?? "no-subject"}.eml`;
      writeFileSync(uniqueExportPath(dir, base), eml, "utf8");
      exported++;
      if (exported % 100 === 0) onProgress?.(exported);
    }
    return { format, out: dir, exported, skipped };
  }

  // mbox / jsonl 都是单文件流式写出，避免把整个邮箱读进内存
  const stream = createWriteStream(out, { mode: 0o600 });
  try {
    for (const row of rows) {
      const recipients = recipientsOf(db, filter.profileId, row.zoho_message_id);
      const line =
        format === "mbox"
          ? toMbox(toEml(row, recipients), row.from_address, row.received_at)
          : `${JSON.stringify({
              messageId: row.zoho_message_id,
              threadId: row.zoho_thread_id,
              folder: row.folder_name,
              subject: row.subject,
              from: { name: row.from_name, address: row.from_address },
              recipients: recipients.map((r) => ({
                type: r.recipient_type,
                name: r.name,
                address: r.address,
              })),
              receivedAt: row.received_at ? new Date(row.received_at).toISOString() : null,
              isRead: row.is_read === 1,
              hasAttachments: row.has_attachments === 1,
              bodyText: row.body_text,
            })}\n`;

      if (!stream.write(line)) {
        // 背压：不等的话导出一个大邮箱会把内存吃光
        await new Promise<void>((resolve) => stream.once("drain", resolve));
      }
      exported++;
      if (exported % 200 === 0) onProgress?.(exported);
    }
  } finally {
    await new Promise<void>((resolve, reject) => {
      stream.end((err?: Error) => (err ? reject(err) : resolve()));
    });
  }

  return { format, out, exported, skipped };
}
