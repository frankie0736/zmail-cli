/**
 * 消息 repository。实施计划 §11 / §13.1 / §14.2。
 *
 * ## 这一层存在的唯一理由
 *
 * FTS5 索引是 contentless 的，**不会自动跟随 messages 变化**。索引维护和
 * 消息写入必须在同一个事务里完成，否则会出现「邮件在库里但搜不到」——
 * 而且不报错。
 *
 * 因此业务代码**不得直接写 messages 表**，一律经过这里。这不是分层洁癖，
 * 是把一个静默失效的不变量变成结构上无法违反的东西。
 */

import { buildIdentityText, normalizeForIndex } from "../../mail/normalize-for-index.js";
import type { NormalizedMessage } from "../../mail/normalize-message.js";
import type { SqliteDatabase } from "../database.js";

export interface UpsertContext {
  profileId: string;
  accountId: string;
}

export interface UpsertResult {
  inserted: number;
  updated: number;
}

interface MessageRow {
  id: number;
  profile_id: string;
  account_id: string;
  zoho_message_id: string;
  zoho_thread_id: string | null;
  folder_id: string;
  subject: string | null;
  from_name: string | null;
  from_address: string | null;
  body_text: string | null;
  body_html: string | null;
  received_at: number | null;
  is_read: number;
  has_attachments: number;
  is_remote_deleted: number;
}

export class MessageRepository {
  readonly #db: SqliteDatabase;

  constructor(db: SqliteDatabase) {
    this.#db = db;
  }

  /**
   * 批量 upsert。整批在一个事务内完成 —— 逐条提交会让 10 万封邮件产生
   * 10 万次 fsync，慢上两个数量级。
   */
  upsertMany(messages: NormalizedMessage[], ctx: UpsertContext): UpsertResult {
    const run = this.#db.transaction((batch: NormalizedMessage[]) => {
      let inserted = 0;
      let updated = 0;
      for (const msg of batch) {
        const before = this.#findId(ctx, msg.zohoMessageId);
        this.#upsertOne(msg, ctx);
        if (before === null) inserted++;
        else updated++;
      }
      return { inserted, updated };
    });
    return run(messages);
  }

  #findId(ctx: UpsertContext, zohoMessageId: string): number | null {
    const row = this.#db
      .prepare(
        "SELECT id FROM messages WHERE profile_id = ? AND account_id = ? AND zoho_message_id = ?",
      )
      .get(ctx.profileId, ctx.accountId, zohoMessageId) as { id: number } | undefined;
    return row?.id ?? null;
  }

  /**
   * 单条 upsert。**必须在事务内调用** —— 它写三张表（messages、
   * message_recipients、messages_fts），任何一步失败都不能留下部分状态。
   */
  #upsertOne(msg: NormalizedMessage, ctx: UpsertContext): number {
    const now = Date.now();

    this.#db
      .prepare(`
        INSERT INTO messages (
          profile_id, account_id, zoho_message_id, zoho_thread_id, folder_id,
          subject, from_name, from_address, reply_to_address,
          summary, body_text, body_html,
          received_at, sent_at, size_bytes,
          is_read, is_flagged, has_attachments,
          raw_json, first_synced_at, last_synced_at
        ) VALUES (
          @profileId, @accountId, @zohoMessageId, @zohoThreadId, @folderId,
          @subject, @fromName, @fromAddress, @replyToAddress,
          @summary, @bodyText, @bodyHtml,
          @receivedAt, @sentAt, @sizeBytes,
          @isRead, @isFlagged, @hasAttachments,
          @rawJson, @now, @now
        )
        ON CONFLICT(profile_id, account_id, zoho_message_id) DO UPDATE SET
          zoho_thread_id  = excluded.zoho_thread_id,
          folder_id       = excluded.folder_id,
          subject         = excluded.subject,
          from_name       = excluded.from_name,
          from_address    = excluded.from_address,
          reply_to_address= excluded.reply_to_address,
          summary         = excluded.summary,
          -- 正文可能本次没抓（列表阶段 upsert），不要用 NULL 覆盖已有正文
          body_text       = COALESCE(excluded.body_text, messages.body_text),
          body_html       = COALESCE(excluded.body_html, messages.body_html),
          received_at     = excluded.received_at,
          sent_at         = excluded.sent_at,
          size_bytes      = excluded.size_bytes,
          is_read         = excluded.is_read,
          is_flagged      = excluded.is_flagged,
          has_attachments = excluded.has_attachments,
          raw_json        = COALESCE(excluded.raw_json, messages.raw_json),
          -- 重新出现说明没被删除，清掉墓碑标记
          is_remote_deleted = 0,
          last_synced_at  = @now
      `)
      .run({
        profileId: ctx.profileId,
        accountId: ctx.accountId,
        zohoMessageId: msg.zohoMessageId,
        zohoThreadId: msg.zohoThreadId,
        folderId: msg.folderId,
        subject: msg.subject,
        fromName: msg.fromName,
        fromAddress: msg.fromAddress,
        replyToAddress: msg.replyToAddress,
        summary: msg.summary,
        bodyText: msg.bodyText,
        bodyHtml: msg.bodyHtml,
        receivedAt: msg.receivedAt,
        sentAt: msg.sentAt,
        sizeBytes: msg.sizeBytes,
        isRead: msg.isRead ? 1 : 0,
        isFlagged: msg.isFlagged ? 1 : 0,
        hasAttachments: msg.hasAttachments ? 1 : 0,
        rawJson: msg.rawJson,
        now,
      });

    const id = this.#findId(ctx, msg.zohoMessageId);
    if (id === null) throw new Error("upsert 后找不到消息行，schema 可能已损坏");

    // 收件人：先删后插。追加会在重复同步时产生重复行。
    if (msg.recipients.length > 0) {
      this.#db.prepare("DELETE FROM message_recipients WHERE message_pk = ?").run(id);
      const insertRecipient = this.#db.prepare(
        "INSERT INTO message_recipients (message_pk, recipient_type, name, address) VALUES (?, ?, ?, ?)",
      );
      for (const r of msg.recipients) {
        insertRecipient.run(id, r.type, r.name, r.address.toLowerCase());
      }
    }

    this.#reindex(id, msg);
    return id;
  }

  /**
   * 维护 FTS 索引。
   *
   * contentless 表不支持 UPDATE，只能先 delete 再 insert。
   * 所有写入文本都必须经过 normalizeForIndex —— 漏掉任何一处，
   * 中文搜索就会对那部分邮件静默失效（§13.1.2 不变量 1）。
   */
  #reindex(messagePk: number, msg: NormalizedMessage): void {
    this.#db.prepare("DELETE FROM messages_fts WHERE rowid = ?").run(messagePk);

    const recipientText = buildIdentityText(
      this.#db
        .prepare("SELECT name, address FROM message_recipients WHERE message_pk = ?")
        .all(messagePk) as Array<{ name: string | null; address: string }>,
    );

    this.#db
      .prepare(
        "INSERT INTO messages_fts (rowid, subject, sender, recipients, body) VALUES (?, ?, ?, ?, ?)",
      )
      .run(
        messagePk,
        normalizeForIndex(msg.subject ?? ""),
        buildIdentityText(
          msg.fromAddress ? [{ name: msg.fromName, address: msg.fromAddress }] : [],
        ),
        recipientText,
        normalizeForIndex(msg.bodyText ?? msg.summary ?? ""),
      );
  }

  /** 给已有消息补正文。用于列表先行、正文后补的两阶段同步。 */
  attachContent(zohoMessageId: string, ctx: UpsertContext, updated: NormalizedMessage): boolean {
    const run = this.#db.transaction(() => {
      const id = this.#findId(ctx, zohoMessageId);
      if (id === null) return false;
      this.#upsertOne(updated, ctx);
      return true;
    });
    return run();
  }

  /** 按 Zoho ID 查消息。 */
  findByZohoId(ctx: UpsertContext, zohoMessageId: string): MessageRow | null {
    return (
      (this.#db
        .prepare(
          "SELECT * FROM messages WHERE profile_id = ? AND account_id = ? AND zoho_message_id = ?",
        )
        .get(ctx.profileId, ctx.accountId, zohoMessageId) as MessageRow | undefined) ?? null
    );
  }

  /** 哪些消息还没有正文，需要后续抓取。 */
  idsMissingBody(ctx: UpsertContext, folderId: string, limit: number): string[] {
    return (
      this.#db
        .prepare(`
          SELECT zoho_message_id FROM messages
          WHERE profile_id = ? AND account_id = ? AND folder_id = ?
            AND body_text IS NULL AND is_remote_deleted = 0
          ORDER BY received_at DESC
          LIMIT ?
        `)
        .all(ctx.profileId, ctx.accountId, folderId, limit) as Array<{ zoho_message_id: string }>
    ).map((r) => r.zoho_message_id);
  }

  count(ctx: UpsertContext): number {
    return (
      this.#db
        .prepare("SELECT count(*) AS c FROM messages WHERE profile_id = ? AND account_id = ?")
        .get(ctx.profileId, ctx.accountId) as { c: number }
    ).c;
  }

  /**
   * 标记为远程已删除。**不删除本地行**（§14.7）——
   * 用户可能还需要那封邮件的内容，清理必须是显式操作。
   */
  markRemoteDeleted(ctx: UpsertContext, zohoMessageIds: string[]): number {
    if (zohoMessageIds.length === 0) return 0;
    const run = this.#db.transaction((ids: string[]) => {
      const stmt = this.#db.prepare(`
        UPDATE messages SET is_remote_deleted = 1, last_synced_at = ?
        WHERE profile_id = ? AND account_id = ? AND zoho_message_id = ?
      `);
      let n = 0;
      const now = Date.now();
      for (const id of ids) n += stmt.run(now, ctx.profileId, ctx.accountId, id).changes;
      return n;
    });
    return run(zohoMessageIds);
  }

  /** 本地已有但本次列表未出现的消息 —— 对账用。 */
  localIdsInFolder(ctx: UpsertContext, folderId: string): string[] {
    return (
      this.#db
        .prepare(`
          SELECT zoho_message_id FROM messages
          WHERE profile_id = ? AND account_id = ? AND folder_id = ? AND is_remote_deleted = 0
        `)
        .all(ctx.profileId, ctx.accountId, folderId) as Array<{ zoho_message_id: string }>
    ).map((r) => r.zoho_message_id);
  }

  /**
   * 从 messages 重建整个 FTS 索引。
   *
   * contentless 表不支持 SQLite 原生的 rebuild，只能在应用层做 ——
   * 这反而更正确：重建必须重新执行 normalizeForIndex，原生 rebuild 做不到。
   */
  rebuildIndex(onProgress?: (done: number) => void): number {
    const rows = this.#db
      .prepare(`
        SELECT m.id, m.subject, m.from_name, m.from_address, m.body_text, m.summary
        FROM messages m ORDER BY m.id
      `)
      .all() as Array<{
      id: number;
      subject: string | null;
      from_name: string | null;
      from_address: string | null;
      body_text: string | null;
      summary: string | null;
    }>;

    const run = this.#db.transaction(() => {
      this.#db.exec("DELETE FROM messages_fts");
      const insert = this.#db.prepare(
        "INSERT INTO messages_fts (rowid, subject, sender, recipients, body) VALUES (?, ?, ?, ?, ?)",
      );
      const recipientsFor = this.#db.prepare(
        "SELECT name, address FROM message_recipients WHERE message_pk = ?",
      );

      let done = 0;
      for (const row of rows) {
        insert.run(
          row.id,
          normalizeForIndex(row.subject ?? ""),
          buildIdentityText(
            row.from_address ? [{ name: row.from_name, address: row.from_address }] : [],
          ),
          buildIdentityText(
            recipientsFor.all(row.id) as Array<{ name: string | null; address: string }>,
          ),
          normalizeForIndex(row.body_text ?? row.summary ?? ""),
        );
        done++;
        if (done % 500 === 0) onProgress?.(done);
      }
      return done;
    });

    return run();
  }
}
