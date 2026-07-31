/**
 * 同步引擎。实施计划 §14。
 *
 * ## 两种模式
 *
 * Quick Sync：每个文件夹扫描最新 N 封（默认 400），upsert 新邮件与状态变化。
 *   不假设「上次时间点之后绝对无遗漏」—— REST API 没有可靠的增量游标
 *   （Phase 0-4 已确认 IMAP 不可用，所以这个补偿是必需的）。
 *
 * Full Sync：翻完全部分页，并做对账（发现远程已消失的邮件）。
 *
 * ## 不变量
 *
 *   - 幂等：同一封邮件重复同步不产生重复行
 *   - 可中断：任何时刻被杀掉，下次从 checkpoint 继续
 *   - 单封失败不阻塞整个文件夹
 *   - 进度**不能**显示「N / 总数」—— folders 端点不返回 messageCount
 */

import pLimit from "p-limit";
import type { Config, Profile } from "../config/schema.js";
import { ErrorCode, ZmailError } from "../core/errors.js";
import type { SqliteDatabase } from "../db/database.js";
import { AttachmentRepository } from "../db/repositories/attachment-repository.js";
import {
  AccountRepository,
  FolderRepository,
  ProfileRepository,
  SyncStateRepository,
} from "../db/repositories/index.js";
import { MessageRepository } from "../db/repositories/message-repository.js";
import {
  type ContentPayload,
  type ListItem,
  matchIdentity,
  mergeContent,
  type NormalizedMessage,
  normalizeListItem,
} from "../mail/normalize-message.js";
import { discoverAccount, listAttachments, listFolders, type ZohoClient } from "../zoho/client.js";
import { withRetry } from "./retry.js";

/** 列表单页条数。上限由 Adapter 常量控制，不在业务层散落（§14.2）。 */
const LIST_PAGE_SIZE = 200;

export type SyncMode = "quick" | "full";

export interface SyncOptions {
  mode: SyncMode;
  /** 只同步指定文件夹（按名称）。 */
  folder?: string | undefined;
  /** Quick Sync 的重叠扫描深度。 */
  quickScanLimit?: number;
  onEvent?: (evt: string, fields: Record<string, unknown>) => void;
  onProgress?: (p: SyncProgress) => void;
  /** 注入以便测试中断。返回 true 表示应当停止。 */
  shouldAbort?: () => boolean;
  sleep?: (ms: number) => Promise<void>;
}

export interface SyncProgress {
  folder: string;
  /** 已同步的封数。**没有总数** —— folders 端点不提供（§14.2）。 */
  messagesSeen: number;
  bodiesFetched: number;
  phase: "list" | "content" | "reconcile";
}

export interface FolderSyncResult {
  folder: string;
  folderId: string;
  listed: number;
  inserted: number;
  updated: number;
  bodiesFetched: number;
  bodyFailures: number;
  attachmentsIndexed: number;
  markedDeleted: number;
  aborted: boolean;
  error: string | null;
}

export interface SyncResult {
  mode: SyncMode;
  accountId: string;
  folders: FolderSyncResult[];
  totalInserted: number;
  totalUpdated: number;
  totalBodyFailures: number;
  totalAttachmentsIndexed: number;
  aborted: boolean;
  elapsedMs: number;
}

export interface SyncEngineOptions {
  db: SqliteDatabase;
  client: ZohoClient;
  profileId: string;
  profile: Profile;
  config: Config;
}

export class SyncEngine {
  readonly #db: SqliteDatabase;
  readonly #client: ZohoClient;
  readonly #profileId: string;
  readonly #profile: Profile;
  readonly #messages: MessageRepository;
  readonly #accounts: AccountRepository;
  readonly #folders: FolderRepository;
  readonly #syncState: SyncStateRepository;
  readonly #profiles: ProfileRepository;
  readonly #attachments: AttachmentRepository;

  constructor(opts: SyncEngineOptions) {
    this.#db = opts.db;
    this.#client = opts.client;
    this.#profileId = opts.profileId;
    this.#profile = opts.profile;
    this.#messages = new MessageRepository(opts.db);
    this.#accounts = new AccountRepository(opts.db);
    this.#folders = new FolderRepository(opts.db);
    this.#syncState = new SyncStateRepository(opts.db);
    this.#profiles = new ProfileRepository(opts.db);
    this.#attachments = new AttachmentRepository(opts.db);
  }

  async run(opts: SyncOptions): Promise<SyncResult> {
    const startedAt = Date.now();
    const onEvent = opts.onEvent ?? (() => {});
    const shouldAbort = opts.shouldAbort ?? (() => false);

    onEvent("sync_start", { mode: opts.mode, profile: this.#profileId });

    // ---- 账户与文件夹发现 ----
    this.#profiles.ensure(this.#profileId, this.#profile.email, this.#profile.zohoLocation);
    const account = await withRetry(() => discoverAccount(this.#client), {
      ...(opts.sleep ? { sleep: opts.sleep } : {}),
    });
    this.#accounts.upsert(this.#profileId, account);

    const ctx = { profileId: this.#profileId, accountId: account.accountId };

    const remoteFolders = await withRetry(() => listFolders(this.#client, account.accountId), {
      ...(opts.sleep ? { sleep: opts.sleep } : {}),
    });

    const include = new Set(this.#profile.sync.includeFolders);
    const exclude = new Set(this.#profile.sync.excludeFolders);
    const syncedNames = new Set(
      remoteFolders.map((f) => f.name).filter((n) => include.has(n) && !exclude.has(n)),
    );
    this.#folders.upsertMany(ctx, remoteFolders, syncedNames);

    let targets = this.#folders.listSynced(ctx);
    if (opts.folder) {
      targets = targets.filter((f) => f.name.toLowerCase() === opts.folder?.toLowerCase());
      if (targets.length === 0) {
        throw new ZmailError(ErrorCode.NOT_FOUND, `未找到已启用同步的文件夹 "${opts.folder}"`, {
          details: { available: this.#folders.listSynced(ctx).map((f) => f.name) },
        });
      }
    }

    onEvent("sync_folders", { count: targets.length, names: targets.map((f) => f.name) });

    const results: FolderSyncResult[] = [];
    let aborted = false;

    for (const target of targets) {
      if (shouldAbort()) {
        aborted = true;
        break;
      }
      const result = await this.#syncFolder(ctx, target, account.accountId, opts);
      results.push(result);
      if (result.aborted) {
        aborted = true;
        break;
      }
    }

    const summary: SyncResult = {
      mode: opts.mode,
      accountId: account.accountId,
      folders: results,
      totalInserted: results.reduce((s, r) => s + r.inserted, 0),
      totalUpdated: results.reduce((s, r) => s + r.updated, 0),
      totalBodyFailures: results.reduce((s, r) => s + r.bodyFailures, 0),
      totalAttachmentsIndexed: results.reduce((s, r) => s + r.attachmentsIndexed, 0),
      aborted,
      elapsedMs: Date.now() - startedAt,
    };

    onEvent("sync_done", {
      mode: opts.mode,
      inserted: summary.totalInserted,
      updated: summary.totalUpdated,
      bodyFailures: summary.totalBodyFailures,
      aborted,
      elapsedMs: summary.elapsedMs,
    });

    return summary;
  }

  async #syncFolder(
    ctx: { profileId: string; accountId: string },
    target: { folderId: string; name: string },
    accountId: string,
    opts: SyncOptions,
  ): Promise<FolderSyncResult> {
    const onEvent = opts.onEvent ?? (() => {});
    const onProgress = opts.onProgress ?? (() => {});
    const shouldAbort = opts.shouldAbort ?? (() => false);

    const result: FolderSyncResult = {
      folder: target.name,
      folderId: target.folderId,
      listed: 0,
      inserted: 0,
      updated: 0,
      bodiesFetched: 0,
      bodyFailures: 0,
      attachmentsIndexed: 0,
      markedDeleted: 0,
      aborted: false,
      error: null,
    };

    const identities = this.#accounts.listIdentities(ctx);
    const quickLimit = opts.quickScanLimit ?? this.#profile.sync.quickScanLimit;
    const sinceMs = this.#profile.sync.since ? Date.parse(this.#profile.sync.since) : null;

    try {
      // ---- 阶段一：翻页取列表 ----
      // 从 checkpoint 恢复：中断后不必从头重扫（§14.4）
      const saved = this.#syncState.get(this.#profileId, target.folderId);
      let start = opts.mode === "full" ? (saved?.lastPageStart ?? 1) : 1;
      const seenIds: string[] = [];
      let latestMessageId: string | null = null;
      let latestReceivedAt: number | null = null;

      for (;;) {
        if (shouldAbort()) {
          result.aborted = true;
          break;
        }

        // Quick Sync 必须**按需请求**，而不是拉满一页再丢弃多余的部分 ——
        // 后者消耗的配额与 Full Sync 相同，那 Quick Sync 就失去了意义。
        const pageSize =
          opts.mode === "quick"
            ? Math.min(Math.max(quickLimit - result.listed, 0), LIST_PAGE_SIZE)
            : LIST_PAGE_SIZE;
        if (pageSize === 0) break;

        const page = await withRetry(
          () =>
            this.#client.request<ListItem[]>(`/api/accounts/${accountId}/messages/view`, {
              query: { folderId: target.folderId, limit: pageSize, start },
            }),
          {
            ...(opts.sleep ? { sleep: opts.sleep } : {}),
            onRetry: (info) => onEvent("sync_retry", { folder: target.name, ...info }),
          },
        );

        const items = Array.isArray(page.data) ? page.data : [];
        if (items.length === 0) break;

        const normalized: NormalizedMessage[] = [];
        for (const item of items) {
          try {
            const msg = normalizeListItem(item);
            // since 过滤：配额受限时的降级手段（§8.4）
            if (sinceMs !== null && msg.receivedAt !== null && msg.receivedAt < sinceMs) continue;
            normalized.push(msg);
            seenIds.push(msg.zohoMessageId);
            if (latestReceivedAt === null || (msg.receivedAt ?? 0) > latestReceivedAt) {
              latestReceivedAt = msg.receivedAt;
              latestMessageId = msg.zohoMessageId;
            }
          } catch (err) {
            // 单封畸形数据不应阻塞整个文件夹（§14.1）
            result.bodyFailures++;
            onEvent("sync_item_skipped", {
              folder: target.name,
              reason: err instanceof Error ? err.message : String(err),
            });
          }
        }

        if (normalized.length > 0) {
          const upserted = this.#messages.upsertMany(normalized, ctx);
          result.inserted += upserted.inserted;
          result.updated += upserted.updated;
        }
        result.listed += items.length;

        start += items.length;
        // 每页落一次 checkpoint —— 崩溃时最多重做一页
        this.#syncState.savePageProgress(this.#profileId, target.folderId, start);
        onProgress({
          folder: target.name,
          messagesSeen: result.listed,
          bodiesFetched: result.bodiesFetched,
          phase: "list",
        });

        // Quick Sync 只扫最新若干封
        if (opts.mode === "quick" && result.listed >= quickLimit) break;
        // 不满一页说明已经到底。比较对象必须是**本次请求的** pageSize，
        // 不是 LIST_PAGE_SIZE —— Quick Sync 下两者不同。
        if (items.length < pageSize) break;
      }

      // ---- 阶段二：补正文 ----
      if (!result.aborted && this.#profile.sync.bodyMode !== "none") {
        const missing = this.#messages.idsMissingBody(
          ctx,
          target.folderId,
          opts.mode === "quick" ? quickLimit : Number.MAX_SAFE_INTEGER,
        );
        const limit = pLimit(this.#profile.sync.contentConcurrency);

        await Promise.all(
          missing.map((messageId) =>
            limit(async () => {
              if (shouldAbort()) {
                result.aborted = true;
                return;
              }
              try {
                const res = await withRetry(
                  () =>
                    this.#client.request<ContentPayload>(
                      `/api/accounts/${accountId}/folders/${target.folderId}/messages/${messageId}/content`,
                    ),
                  {
                    ...(opts.sleep ? { sleep: opts.sleep } : {}),
                    onRetry: (info) => onEvent("sync_retry", { folder: target.name, ...info }),
                  },
                );

                const existing = this.#messages.findByZohoId(ctx, messageId);
                if (!existing) return;

                const base = normalizeListItem({
                  messageId,
                  folderId: target.folderId,
                  ...(existing.zoho_thread_id ? { threadId: existing.zoho_thread_id } : {}),
                  ...(existing.subject ? { subject: existing.subject } : {}),
                  ...(existing.from_address ? { fromAddress: existing.from_address } : {}),
                  ...(existing.received_at ? { receivedTime: String(existing.received_at) } : {}),
                  status: existing.is_read ? "1" : "0",
                  hasAttachment: existing.has_attachments ? "1" : "0",
                });

                const merged = mergeContent(base, res.data, {
                  keepBodyHtml: this.#profile.storage.keepBodyHtml,
                  keepRawJson: this.#profile.storage.keepRawJson === "always",
                  rawText: res.rawText,
                });
                merged.recipients = merged.recipients.length > 0 ? merged.recipients : [];

                this.#messages.attachContent(messageId, ctx, merged);
                result.bodiesFetched++;

                // 身份匹配必须用**数据库里实际存下来的**收件人，而不是内存中的
                // merged.recipients —— 后者在正文响应缺少收件人字段时是空的，
                // 于是匹配静默落空，matched_identity_id 永远为 NULL。
                const stored = this.#db
                  .prepare(`
                    SELECT r.recipient_type, r.address
                    FROM message_recipients r
                    JOIN messages m ON m.id = r.message_pk
                    WHERE m.profile_id = ? AND m.account_id = ? AND m.zoho_message_id = ?
                  `)
                  .all(ctx.profileId, ctx.accountId, messageId) as Array<{
                  recipient_type: string;
                  address: string;
                }>;

                const identityId = matchIdentity(
                  stored.map((r) => ({
                    type: r.recipient_type as "to" | "cc" | "bcc",
                    name: null,
                    address: r.address,
                  })),
                  identities,
                );
                if (identityId !== null) {
                  this.#db
                    .prepare(
                      "UPDATE messages SET matched_identity_id = ? WHERE profile_id = ? AND account_id = ? AND zoho_message_id = ?",
                    )
                    .run(identityId, ctx.profileId, ctx.accountId, messageId);
                }

                // 附件只同步**元数据**，内容按需下载（§15.1 默认 attachmentMode=metadata）。
                // 全量下载附件会让首次同步的体积与耗时失控。
                if (
                  existing.has_attachments === 1 &&
                  this.#profile.sync.attachmentMode !== "none"
                ) {
                  try {
                    const metas = await listAttachments(
                      this.#client,
                      accountId,
                      target.folderId,
                      messageId,
                    );
                    if (metas.length > 0) {
                      this.#attachments.upsertMany(existing.id, metas);
                      result.attachmentsIndexed += metas.length;
                    }
                  } catch (err) {
                    // 附件元数据失败不影响正文 —— 邮件本身仍然可读可搜
                    onEvent("sync_attachment_meta_failed", {
                      folder: target.name,
                      code: err instanceof ZmailError ? err.code : "UNKNOWN",
                    });
                  }
                }

                if (result.bodiesFetched % 25 === 0) {
                  onProgress({
                    folder: target.name,
                    messagesSeen: result.listed,
                    bodiesFetched: result.bodiesFetched,
                    phase: "content",
                  });
                }
              } catch (err) {
                // 404 说明邮件已被移动或删除，交给对账；其他错误也不阻塞整个文件夹
                result.bodyFailures++;
                onEvent("sync_body_failed", {
                  folder: target.name,
                  code: err instanceof ZmailError ? err.code : "UNKNOWN",
                });
              }
            }),
          ),
        );
      }

      // ---- 阶段三：对账（只在 Full Sync）----
      if (opts.mode === "full" && !result.aborted) {
        onProgress({
          folder: target.name,
          messagesSeen: result.listed,
          bodiesFetched: result.bodiesFetched,
          phase: "reconcile",
        });
        const localIds = this.#messages.localIdsInFolder(ctx, target.folderId);
        const seen = new Set(seenIds);
        const vanished = localIds.filter((id) => !seen.has(id));
        // 只标记，不删除（§14.7）—— 用户可能还需要那些内容
        result.markedDeleted = this.#messages.markRemoteDeleted(ctx, vanished);
      }

      if (!result.aborted) {
        this.#syncState.markSuccess(this.#profileId, target.folderId, {
          full: opts.mode === "full",
          latestMessageId,
          latestReceivedAt,
        });
      }
    } catch (err) {
      const code = err instanceof ZmailError ? err.code : "UNKNOWN";
      result.error = code;
      this.#syncState.markError(this.#profileId, target.folderId, code);
      onEvent("sync_folder_failed", { folder: target.name, code });
      // 单个文件夹失败不中止其余文件夹
    }

    return result;
  }
}
