/**
 * 附件 repository。实施计划 §15。
 *
 * 文件本体在文件系统（内容寻址），这里只管元数据与状态机：
 *
 *   metadata_only → downloading → downloaded
 *                              ↘ failed
 *   downloaded → evicted → (再次请求时回到 metadata_only 重新下载)
 */

import type { EvictionCandidate } from "../../storage/attachment-store.js";
import type { SqliteDatabase } from "../database.js";

export interface AttachmentMeta {
  zohoAttachmentId: string;
  filename: string | null;
  mimeType: string | null;
  sizeBytes: number | null;
}

export interface AttachmentRow {
  id: number;
  messagePk: number;
  zohoMessageId: string;
  folderId: string;
  zohoAttachmentId: string;
  filename: string | null;
  mimeType: string | null;
  sizeBytes: number | null;
  sha256: string | null;
  localPath: string | null;
  downloadStatus: string;
  isPinned: boolean;
}

export class AttachmentRepository {
  readonly #db: SqliteDatabase;

  constructor(db: SqliteDatabase) {
    this.#db = db;
  }

  /** 写入元数据。已下载的记录不会被元数据同步降级。 */
  upsertMany(messagePk: number, metas: AttachmentMeta[]): number {
    const run = this.#db.transaction(() => {
      const now = Date.now();
      const stmt = this.#db.prepare(`
        INSERT INTO attachments (
          message_pk, zoho_attachment_id, filename, mime_type, size_bytes,
          download_status, first_synced_at, last_synced_at
        ) VALUES (?, ?, ?, ?, ?, 'metadata_only', ?, ?)
        ON CONFLICT(message_pk, zoho_attachment_id) DO UPDATE SET
          filename       = excluded.filename,
          mime_type      = excluded.mime_type,
          size_bytes     = excluded.size_bytes,
          -- 不要把已下载的记录改回 metadata_only
          last_synced_at = ?
      `);
      let n = 0;
      for (const m of metas) {
        n += stmt.run(
          messagePk,
          m.zohoAttachmentId,
          m.filename,
          m.mimeType,
          m.sizeBytes,
          now,
          now,
          now,
        ).changes;
      }
      return n;
    });
    return run();
  }

  find(profileId: string, attachmentId: string): AttachmentRow | null {
    const row = this.#db
      .prepare(`
        SELECT a.*, m.zoho_message_id, m.folder_id
        FROM attachments a
        JOIN messages m ON m.id = a.message_pk
        WHERE m.profile_id = ? AND a.zoho_attachment_id = ?
        LIMIT 1
      `)
      .get(profileId, attachmentId) as Record<string, unknown> | undefined;
    return row ? this.#toRow(row) : null;
  }

  listForMessage(profileId: string, zohoMessageId: string): AttachmentRow[] {
    return (
      this.#db
        .prepare(`
          SELECT a.*, m.zoho_message_id, m.folder_id
          FROM attachments a
          JOIN messages m ON m.id = a.message_pk
          WHERE m.profile_id = ? AND m.zoho_message_id = ?
          ORDER BY a.filename
        `)
        .all(profileId, zohoMessageId) as Array<Record<string, unknown>>
    ).map((r) => this.#toRow(r));
  }

  #toRow(r: Record<string, unknown>): AttachmentRow {
    return {
      id: r.id as number,
      messagePk: r.message_pk as number,
      zohoMessageId: String(r.zoho_message_id),
      folderId: String(r.folder_id),
      zohoAttachmentId: String(r.zoho_attachment_id),
      filename: (r.filename as string | null) ?? null,
      mimeType: (r.mime_type as string | null) ?? null,
      sizeBytes: (r.size_bytes as number | null) ?? null,
      sha256: (r.sha256 as string | null) ?? null,
      localPath: (r.local_path as string | null) ?? null,
      downloadStatus: String(r.download_status),
      isPinned: r.is_pinned === 1,
    };
  }

  markDownloaded(id: number, sha256: string, localPath: string, sizeBytes: number): void {
    this.#db
      .prepare(`
        UPDATE attachments
        SET sha256 = ?, local_path = ?, size_bytes = ?, download_status = 'downloaded',
            last_accessed_at = ?, last_synced_at = ?
        WHERE id = ?
      `)
      .run(sha256, localPath, sizeBytes, Date.now(), Date.now(), id);
  }

  markFailed(id: number): void {
    this.#db
      .prepare("UPDATE attachments SET download_status = 'failed', last_synced_at = ? WHERE id = ?")
      .run(Date.now(), id);
  }

  touch(id: number): void {
    this.#db
      .prepare("UPDATE attachments SET last_accessed_at = ? WHERE id = ?")
      .run(Date.now(), id);
  }

  /**
   * 标记为已淘汰。**只清路径，保留 sha256 与元数据** ——
   * 用户再次请求时可以按需重新下载，而不是发现附件凭空消失。
   */
  markEvicted(sha256: string): number {
    return this.#db
      .prepare(`
        UPDATE attachments SET local_path = NULL, download_status = 'evicted'
        WHERE sha256 = ? AND download_status = 'downloaded'
      `)
      .run(sha256).changes;
  }

  /**
   * LRU 淘汰候选。
   *
   * 按 sha256 聚合 —— 同一份内容被多封邮件引用时只占一份磁盘，
   * 淘汰决策也必须按内容而非按引用来算，否则会重复计入体积。
   */
  evictionCandidates(): EvictionCandidate[] {
    return (
      this.#db
        .prepare(`
          SELECT sha256, MAX(size_bytes) AS size_bytes, MAX(last_accessed_at) AS last_accessed_at
          FROM attachments
          WHERE download_status = 'downloaded' AND sha256 IS NOT NULL AND is_pinned = 0
          GROUP BY sha256
        `)
        .all() as Array<{
        sha256: string;
        size_bytes: number | null;
        last_accessed_at: number | null;
      }>
    ).map((r) => ({
      sha256: r.sha256,
      sizeBytes: r.size_bytes ?? 0,
      lastAccessedAt: r.last_accessed_at,
    }));
  }

  /** 已下载附件占用的磁盘总量，按内容去重。 */
  downloadedBytes(): number {
    const row = this.#db
      .prepare(`
        SELECT COALESCE(SUM(size_bytes), 0) AS total FROM (
          SELECT DISTINCT sha256, MAX(size_bytes) AS size_bytes
          FROM attachments
          WHERE download_status = 'downloaded' AND sha256 IS NOT NULL
          GROUP BY sha256
        )
      `)
      .get() as { total: number };
    return row.total;
  }

  stats(): {
    total: number;
    downloaded: number;
    uniqueBlobs: number;
    downloadedBytes: number;
    dedupSavedBytes: number;
  } {
    const g = <T>(sql: string) => this.#db.prepare(sql).get() as T;
    const total = g<{ c: number }>("SELECT count(*) AS c FROM attachments").c;
    const downloaded = g<{ c: number }>(
      "SELECT count(*) AS c FROM attachments WHERE download_status = 'downloaded'",
    ).c;
    const uniqueBlobs = g<{ c: number }>(
      "SELECT count(DISTINCT sha256) AS c FROM attachments WHERE sha256 IS NOT NULL",
    ).c;
    const naive = g<{ t: number }>(
      "SELECT COALESCE(SUM(size_bytes), 0) AS t FROM attachments WHERE download_status = 'downloaded'",
    ).t;
    const actual = this.downloadedBytes();
    return {
      total,
      downloaded,
      uniqueBlobs,
      downloadedBytes: actual,
      // 去重省下的量是个让用户满意的数字，值得显式报告
      dedupSavedBytes: Math.max(naive - actual, 0),
    };
  }
}
