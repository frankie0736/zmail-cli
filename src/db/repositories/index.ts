/**
 * 账户、身份、文件夹与同步状态的 repository。
 */

import type { ZohoAccount, ZohoFolder } from "../../zoho/client.js";
import type { SqliteDatabase } from "../database.js";

export interface ProfileContext {
  profileId: string;
  accountId: string;
}

// ---------------------------------------------------------------- profile

export class ProfileRepository {
  readonly #db: SqliteDatabase;
  constructor(db: SqliteDatabase) {
    this.#db = db;
  }

  ensure(profileId: string, email: string, zohoLocation: string): void {
    const now = Date.now();
    this.#db
      .prepare(`
        INSERT INTO profiles (id, email, zoho_location, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          email = excluded.email, zoho_location = excluded.zoho_location, updated_at = ?
      `)
      .run(profileId, email, zohoLocation, now, now, now);
  }
}

// ---------------------------------------------------------------- account

export class AccountRepository {
  readonly #db: SqliteDatabase;
  constructor(db: SqliteDatabase) {
    this.#db = db;
  }

  /** 写入账户与全部身份。整体在一个事务内，避免半更新的身份表。 */
  upsert(profileId: string, account: ZohoAccount): void {
    const run = this.#db.transaction(() => {
      const now = Date.now();
      this.#db
        .prepare(`
          INSERT INTO accounts (
            profile_id, zoho_account_id, primary_email, display_name,
            used_storage_kb, allowed_storage_kb, plan_storage_gb,
            imap_access_enabled, imap_blocked, first_synced_at, last_synced_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(profile_id, zoho_account_id) DO UPDATE SET
            primary_email      = excluded.primary_email,
            display_name       = excluded.display_name,
            used_storage_kb    = excluded.used_storage_kb,
            allowed_storage_kb = excluded.allowed_storage_kb,
            plan_storage_gb    = excluded.plan_storage_gb,
            imap_access_enabled= excluded.imap_access_enabled,
            imap_blocked       = excluded.imap_blocked,
            last_synced_at     = ?
        `)
        .run(
          profileId,
          account.accountId,
          account.primaryEmail,
          account.displayName,
          account.usedStorageKb,
          account.allowedStorageKb,
          account.planStorageGb,
          account.imapAccessEnabled === null ? null : account.imapAccessEnabled ? 1 : 0,
          account.imapBlocked === null ? null : account.imapBlocked ? 1 : 0,
          now,
          now,
          now,
        );

      const stmt = this.#db.prepare(`
        INSERT INTO account_identities (
          profile_id, account_id, address, display_name,
          is_receive, is_primary, is_alias, is_confirmed,
          is_send, send_mode, send_mail_id, send_validated, send_status,
          first_synced_at, last_synced_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(profile_id, account_id, address) DO UPDATE SET
          display_name  = excluded.display_name,
          is_receive    = excluded.is_receive,
          is_primary    = excluded.is_primary,
          is_alias      = excluded.is_alias,
          is_confirmed  = excluded.is_confirmed,
          is_send       = excluded.is_send,
          send_mode     = excluded.send_mode,
          send_mail_id  = excluded.send_mail_id,
          send_validated= excluded.send_validated,
          send_status   = excluded.send_status,
          last_synced_at= ?
      `);

      for (const i of account.identities) {
        stmt.run(
          profileId,
          account.accountId,
          i.address.toLowerCase(),
          i.displayName,
          i.isReceive ? 1 : 0,
          i.isPrimary ? 1 : 0,
          i.isAlias ? 1 : 0,
          i.isConfirmed ? 1 : 0,
          i.isSend ? 1 : 0,
          i.sendMode,
          i.sendMailId,
          i.sendValidated ? 1 : 0,
          i.sendStatus ? 1 : 0,
          now,
          now,
          now,
        );
      }
    });
    run();
  }

  listIdentities(ctx: ProfileContext): Array<{ id: number; address: string; isPrimary: boolean }> {
    return (
      this.#db
        .prepare(
          "SELECT id, address, is_primary FROM account_identities WHERE profile_id = ? AND account_id = ?",
        )
        .all(ctx.profileId, ctx.accountId) as Array<{
        id: number;
        address: string;
        is_primary: number;
      }>
    ).map((r) => ({ id: r.id, address: r.address, isPrimary: r.is_primary === 1 }));
  }
}

// ---------------------------------------------------------------- folder

export class FolderRepository {
  readonly #db: SqliteDatabase;
  constructor(db: SqliteDatabase) {
    this.#db = db;
  }

  upsertMany(ctx: ProfileContext, folders: ZohoFolder[], syncedNames: Set<string>): void {
    const run = this.#db.transaction(() => {
      const now = Date.now();
      const stmt = this.#db.prepare(`
        INSERT INTO folders (
          profile_id, account_id, zoho_folder_id, name, path, folder_type,
          is_synced, first_synced_at, last_synced_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(profile_id, account_id, zoho_folder_id) DO UPDATE SET
          name = excluded.name, path = excluded.path, folder_type = excluded.folder_type,
          is_synced = excluded.is_synced, last_synced_at = ?
      `);
      for (const f of folders) {
        stmt.run(
          ctx.profileId,
          ctx.accountId,
          f.folderId,
          f.name,
          f.path,
          f.folderType,
          syncedNames.has(f.name) ? 1 : 0,
          now,
          now,
          now,
        );
      }
    });
    run();
  }

  listSynced(ctx: ProfileContext): Array<{ folderId: string; name: string }> {
    return (
      this.#db
        .prepare(`
          SELECT zoho_folder_id, name FROM folders
          WHERE profile_id = ? AND account_id = ? AND is_synced = 1
          ORDER BY name
        `)
        .all(ctx.profileId, ctx.accountId) as Array<{ zoho_folder_id: string; name: string }>
    ).map((r) => ({ folderId: r.zoho_folder_id, name: r.name }));
  }

  listAll(ctx: ProfileContext): Array<{ folderId: string; name: string; isSynced: boolean }> {
    return (
      this.#db
        .prepare(`
          SELECT zoho_folder_id, name, is_synced FROM folders
          WHERE profile_id = ? AND account_id = ? ORDER BY name
        `)
        .all(ctx.profileId, ctx.accountId) as Array<{
        zoho_folder_id: string;
        name: string;
        is_synced: number;
      }>
    ).map((r) => ({ folderId: r.zoho_folder_id, name: r.name, isSynced: r.is_synced === 1 }));
  }
}

// ---------------------------------------------------------------- sync_state

export interface SyncState {
  folderId: string;
  lastSuccessfulSyncAt: number | null;
  lastFullSyncAt: number | null;
  latestSeenMessageId: string | null;
  latestSeenReceivedAt: number | null;
  lastPageStart: number | null;
  lastErrorCode: string | null;
  lastErrorAt: number | null;
}

/**
 * 同步检查点。实施计划 §14.4。
 *
 * 不依赖单一时间戳 —— 时间戳无法区分「同步到这里成功结束」和
 * 「同步到这里被杀掉」，而这两者的恢复策略完全不同。
 */
export class SyncStateRepository {
  readonly #db: SqliteDatabase;
  constructor(db: SqliteDatabase) {
    this.#db = db;
  }

  get(profileId: string, folderId: string): SyncState | null {
    const row = this.#db
      .prepare("SELECT * FROM sync_state WHERE profile_id = ? AND folder_id = ?")
      .get(profileId, folderId) as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      folderId,
      lastSuccessfulSyncAt: (row.last_successful_sync_at as number | null) ?? null,
      lastFullSyncAt: (row.last_full_sync_at as number | null) ?? null,
      latestSeenMessageId: (row.latest_seen_message_id as string | null) ?? null,
      latestSeenReceivedAt: (row.latest_seen_received_at as number | null) ?? null,
      lastPageStart: (row.last_page_start as number | null) ?? null,
      lastErrorCode: (row.last_error_code as string | null) ?? null,
      lastErrorAt: (row.last_error_at as number | null) ?? null,
    };
  }

  /** 记录页进度。中断后从这里恢复，不必从头重扫。 */
  savePageProgress(profileId: string, folderId: string, pageStart: number): void {
    this.#db
      .prepare(`
        INSERT INTO sync_state (profile_id, folder_id, last_page_start)
        VALUES (?, ?, ?)
        ON CONFLICT(profile_id, folder_id) DO UPDATE SET last_page_start = excluded.last_page_start
      `)
      .run(profileId, folderId, pageStart);
  }

  markSuccess(
    profileId: string,
    folderId: string,
    opts: { full: boolean; latestMessageId: string | null; latestReceivedAt: number | null },
  ): void {
    const now = Date.now();
    this.#db
      .prepare(`
        INSERT INTO sync_state (
          profile_id, folder_id, last_successful_sync_at, last_full_sync_at,
          latest_seen_message_id, latest_seen_received_at, last_page_start,
          last_error_code, last_error_at
        ) VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, NULL)
        ON CONFLICT(profile_id, folder_id) DO UPDATE SET
          last_successful_sync_at = ?,
          last_full_sync_at = CASE WHEN ? THEN ? ELSE sync_state.last_full_sync_at END,
          latest_seen_message_id  = excluded.latest_seen_message_id,
          latest_seen_received_at = excluded.latest_seen_received_at,
          -- 成功后清掉页进度与错误：下次是干净的起点
          last_page_start = NULL,
          last_error_code = NULL,
          last_error_at   = NULL
      `)
      .run(
        profileId,
        folderId,
        now,
        opts.full ? now : null,
        opts.latestMessageId,
        opts.latestReceivedAt,
        now,
        opts.full ? 1 : 0,
        now,
      );
  }

  markError(profileId: string, folderId: string, code: string): void {
    this.#db
      .prepare(`
        INSERT INTO sync_state (profile_id, folder_id, last_error_code, last_error_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(profile_id, folder_id) DO UPDATE SET
          last_error_code = excluded.last_error_code,
          last_error_at   = excluded.last_error_at
      `)
      .run(profileId, folderId, code, Date.now());
  }
}
