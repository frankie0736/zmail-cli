/**
 * zmail sync / search / message get / thread get / folder list
 */

import { loadConfig } from "../config/store.js";
import type { Context } from "../core/context.js";
import { ErrorCode, ZmailError } from "../core/errors.js";
import { openDatabase } from "../db/database.js";
import { FolderRepository } from "../db/repositories/index.js";
import { MessageRepository } from "../db/repositories/message-repository.js";
import { type SearchInput, SearchService } from "../mail/search-service.js";
import { isoTimestamp } from "../output/envelope.js";
import { createSecretStore } from "../secrets/index.js";
import { SyncEngine, type SyncMode } from "../sync/sync-engine.js";
import { withSyncLock } from "../sync/sync-lock.js";
import { ZohoClient } from "../zoho/client.js";
import { resolveRegion } from "../zoho/region-resolver.js";
import { TokenManager } from "../zoho/token-manager.js";

async function openContext(ctx: Context) {
  if (!ctx.isInitialized) {
    throw new ZmailError(ErrorCode.NOT_INITIALIZED, "尚未初始化", { hint: "运行 zmail init" });
  }
  return { db: openDatabase(ctx.paths.databaseFile), profileName: ctx.profileName() };
}

// ---------------------------------------------------------------- sync

export interface SyncCommandOptions {
  full?: boolean;
  quick?: boolean;
  folder?: string | undefined;
}

export async function runSync(ctx: Context, opts: SyncCommandOptions): Promise<void> {
  const { out } = ctx;
  const profileName = ctx.profileName();
  const profile = ctx.profile();
  const config = loadConfig(ctx.paths.configFile);
  const region = resolveRegion(profile.zohoLocation);
  const mode: SyncMode = opts.full ? "full" : "quick";

  const secrets = await createSecretStore({
    dataDir: ctx.paths.root,
    configured: config.secretBackend,
    json: out.isJson,
  });
  const tokens = new TokenManager({ profile: profileName, region, secrets });
  const client = new ZohoClient({
    region,
    tokens,
    onEvent: (evt, fields) => out.event(evt, fields),
  });

  const db = openDatabase(ctx.paths.databaseFile);

  try {
    const result = await withSyncLock(
      { locksDir: ctx.paths.locksDir, profile: profileName, command: `zmail sync --${mode}` },
      async () => {
        const engine = new SyncEngine({ db, client, profileId: profileName, profile, config });
        return engine.run({
          mode,
          folder: opts.folder,
          onEvent: (evt, fields) => out.event(evt, fields),
          onProgress: (p) =>
            // 进度里**没有总数** —— folders 端点不返回 messageCount（§14.2）
            out.note(
              `[${p.folder}] ${p.phase === "list" ? "列表" : p.phase === "content" ? "正文" : "对账"} ` +
                `已处理 ${p.messagesSeen} 封，正文 ${p.bodiesFetched} 封`,
            ),
        });
      },
    );

    out.emit(
      { ...result, syncedAt: isoTimestamp() },
      { profile: profileName, source: "remote", syncedAt: isoTimestamp() },
      (r) => {
        const lines = [
          `同步完成（${r.mode === "full" ? "全量" : "快速"}，${(r.elapsedMs / 1000).toFixed(1)} 秒）`,
        ];
        for (const f of r.folders) {
          lines.push(
            `  ${f.folder.padEnd(12)} 新增 ${f.inserted}  更新 ${f.updated}  正文 ${f.bodiesFetched}` +
              (f.bodyFailures ? `  失败 ${f.bodyFailures}` : "") +
              (f.markedDeleted ? `  远程已删 ${f.markedDeleted}` : "") +
              (f.error ? `  ⚠️ ${f.error}` : ""),
          );
        }
        if (r.aborted) lines.push("", "⚠️ 同步被中断，下次运行将从断点继续。");
        return lines.join("\n");
      },
    );
  } finally {
    db.close();
  }
}

// ---------------------------------------------------------------- search

export interface SearchCommandOptions {
  query?: string | undefined;
  phrase?: string | undefined;
  any?: string[] | undefined;
  exclude?: string[] | undefined;
  rawFts?: string | undefined;
  from?: string | undefined;
  fromDomain?: string | undefined;
  to?: string | undefined;
  folder?: string | undefined;
  after?: string | undefined;
  before?: string | undefined;
  unread?: boolean;
  hasAttachment?: boolean;
  limit?: string;
  sort?: "relevance" | "newest" | "oldest";
}

export async function runSearch(
  ctx: Context,
  positional: string | undefined,
  opts: SearchCommandOptions,
): Promise<void> {
  const { db, profileName } = await openContext(ctx);
  try {
    const input: SearchInput = {
      profileId: profileName,
      // 位置参数等价于 --query，便于 `zmail search "报价"` 这种最常见用法
      query: opts.query ?? positional,
      phrase: opts.phrase,
      any: opts.any,
      exclude: opts.exclude,
      rawFts: opts.rawFts,
      from: opts.from,
      fromDomain: opts.fromDomain,
      to: opts.to,
      folder: opts.folder,
      after: opts.after,
      before: opts.before,
      unreadOnly: opts.unread === true,
      hasAttachment: opts.hasAttachment === true,
      limit: opts.limit ? Number(opts.limit) : 20,
      sort: opts.sort ?? "relevance",
    };

    const { hits, total } = new SearchService(db).search(input);

    ctx.out.emit(
      { hits, total, returned: hits.length },
      { profile: profileName, source: "local" },
      (d) => {
        if (d.hits.length === 0) return "没有匹配的邮件。";
        const lines = [`共 ${d.total} 封匹配，显示 ${d.returned} 封：`, ""];
        for (const h of d.hits) {
          lines.push(
            `${h.receivedAt?.slice(0, 10) ?? "?"}  ${(h.fromAddress ?? "?").padEnd(30).slice(0, 30)}  ${h.subject ?? "(无主题)"}`,
          );
          if (h.snippet) lines.push(`            ${h.snippet}`);
          lines.push(`            id=${h.messageId}${h.hasAttachments ? "  📎" : ""}`);
          lines.push("");
        }
        return lines.join("\n");
      },
    );
  } finally {
    db.close();
  }
}

// ---------------------------------------------------------------- message / thread

export async function runMessageGet(ctx: Context, messageId: string): Promise<void> {
  const { db, profileName } = await openContext(ctx);
  try {
    const msg = new SearchService(db).getMessage(profileName, messageId);
    if (!msg) {
      throw new ZmailError(ErrorCode.NOT_FOUND, `本地没有 ID 为 ${messageId} 的邮件`, {
        details: { messageId },
        hint: "先运行 zmail sync，或检查 ID 是否正确",
      });
    }
    ctx.out.emit(msg, { profile: profileName, source: "local" }, (m) =>
      [
        `主题: ${m.subject ?? "(无)"}`,
        `发件: ${(m.from as { name?: string; address?: string }).address ?? "?"}`,
        `时间: ${m.receivedAt ?? "?"}`,
        `文件夹: ${m.folder ?? "?"}`,
        "",
        String(m.bodyText ?? "(无正文，可能尚未同步)"),
      ].join("\n"),
    );
  } finally {
    db.close();
  }
}

export async function runThreadGet(ctx: Context, threadId: string): Promise<void> {
  const { db, profileName } = await openContext(ctx);
  try {
    const messages = new SearchService(db).getThread(profileName, threadId);
    if (messages.length === 0) {
      throw new ZmailError(ErrorCode.NOT_FOUND, `本地没有 ID 为 ${threadId} 的线程`, {
        details: { threadId },
      });
    }
    ctx.out.emit(
      { threadId, messageCount: messages.length, messages },
      { profile: profileName, source: "local" },
      (d) =>
        d.messages
          .map(
            (m, i) =>
              `── [${i + 1}/${d.messageCount}] ${m.receivedAt ?? "?"} ${(m.from as { address?: string }).address ?? "?"}\n${m.bodyText ?? "(无正文)"}`,
          )
          .join("\n\n"),
    );
  } finally {
    db.close();
  }
}

// ---------------------------------------------------------------- folder

export async function runFolderList(ctx: Context): Promise<void> {
  const { db, profileName } = await openContext(ctx);
  try {
    const profile = ctx.profile();
    if (!profile.accountId) {
      throw new ZmailError(ErrorCode.AUTH_REQUIRED, "尚未完成账户发现", {
        hint: "运行 zmail auth login",
      });
    }
    const folders = new FolderRepository(db).listAll({
      profileId: profileName,
      accountId: profile.accountId,
    });
    ctx.out.emit({ folders }, { profile: profileName, source: "local" }, (d) =>
      d.folders.length === 0
        ? "尚无文件夹记录，先运行 zmail sync。"
        : d.folders
            .map((f) => `${f.isSynced ? "✓" : " "} ${f.name.padEnd(16)} ${f.folderId}`)
            .join("\n"),
    );
  } finally {
    db.close();
  }
}

// ---------------------------------------------------------------- rebuild-index

export async function runRebuildIndex(ctx: Context): Promise<void> {
  const { db, profileName } = await openContext(ctx);
  try {
    const started = Date.now();
    const count = new MessageRepository(db).rebuildIndex((done) =>
      ctx.out.note(`已重建 ${done} 条…`),
    );
    ctx.out.emit(
      { rebuilt: count, elapsedMs: Date.now() - started },
      { profile: profileName },
      (d) => `已重建 ${d.rebuilt} 条索引（${(d.elapsedMs / 1000).toFixed(1)} 秒）`,
    );
  } finally {
    db.close();
  }
}
