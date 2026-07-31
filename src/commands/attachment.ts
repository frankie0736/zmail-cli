/**
 * 附件命令：list / download / path / prune。实施计划 §16.6 / §15.5。
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { loadConfig } from "../config/store.js";
import type { Context } from "../core/context.js";
import { ErrorCode, ZmailError } from "../core/errors.js";
import { openDatabase } from "../db/database.js";
import { AttachmentRepository } from "../db/repositories/attachment-repository.js";
import { createSecretStore } from "../secrets/index.js";
import { AttachmentStore, planEviction } from "../storage/attachment-store.js";
import { assertUsableOutDir, uniqueExportPath } from "../storage/safe-filename.js";
import { ZohoClient } from "../zoho/client.js";
import { resolveRegion } from "../zoho/region-resolver.js";
import { TokenManager } from "../zoho/token-manager.js";

async function makeClient(ctx: Context) {
  const profileName = ctx.profileName();
  const profile = ctx.profile();
  const region = resolveRegion(profile.zohoLocation);
  const config = loadConfig(ctx.paths.configFile);
  const secrets = await createSecretStore({
    dataDir: ctx.paths.root,
    configured: config.secretBackend,
    json: ctx.out.isJson,
  });
  const tokens = new TokenManager({ profile: profileName, region, secrets });
  return {
    client: new ZohoClient({ region, tokens, onEvent: (e, f) => ctx.out.event(e, f) }),
    profile,
    profileName,
  };
}

export async function runAttachmentList(ctx: Context, messageId: string): Promise<void> {
  const db = openDatabase(ctx.paths.databaseFile);
  try {
    const rows = new AttachmentRepository(db).listForMessage(ctx.profileName(), messageId);
    ctx.out.emit(
      { messageId, attachments: rows },
      { profile: ctx.profileName(), source: "local" },
      (d) =>
        d.attachments.length === 0
          ? "该邮件没有附件（或尚未同步）。"
          : d.attachments
              .map(
                (a) =>
                  `${a.downloadStatus.padEnd(14)} ${String(a.sizeBytes ?? "?").padStart(9)} B  ${a.filename ?? "(无名)"}\n  id=${a.zohoAttachmentId}`,
              )
              .join("\n"),
    );
  } finally {
    db.close();
  }
}

export async function runAttachmentDownload(
  ctx: Context,
  attachmentId: string,
  opts: { out?: string | undefined },
): Promise<void> {
  const db = openDatabase(ctx.paths.databaseFile);
  try {
    const repo = new AttachmentRepository(db);
    const row = repo.find(ctx.profileName(), attachmentId);
    if (!row) {
      throw new ZmailError(ErrorCode.NOT_FOUND, `本地没有 ID 为 ${attachmentId} 的附件`, {
        hint: "先运行 zmail sync",
      });
    }

    const store = new AttachmentStore(ctx.paths.attachmentsDir, ctx.paths.tmpDir);

    // 已在本地且内容还在，直接复用 —— 不重复消耗配额
    if (row.sha256 && store.has(row.sha256)) {
      repo.touch(row.id);
      await exportIfRequested(ctx, store, row.sha256, row.filename, opts.out);
      ctx.out.emit(
        { attachmentId, sha256: row.sha256, path: store.pathFor(row.sha256), downloaded: false },
        { profile: ctx.profileName(), source: "local" },
        (d) => `已在本地: ${d.path}`,
      );
      return;
    }

    const { client, profile } = await makeClient(ctx);
    if (!profile.accountId) {
      throw new ZmailError(ErrorCode.AUTH_REQUIRED, "尚未完成账户发现", {
        hint: "运行 zmail auth login",
      });
    }

    const url = `/api/accounts/${profile.accountId}/folders/${row.folderId}/messages/${row.zohoMessageId}/attachments/${row.zohoAttachmentId}`;
    const res = await client.requestRaw(url);
    if (!res.body) {
      repo.markFailed(row.id);
      throw new ZmailError(ErrorCode.ZOHO_API_ERROR, "附件响应没有内容");
    }

    const blob = await store.storeStream(res.body, row.sizeBytes);
    repo.markDownloaded(row.id, blob.sha256, blob.path, blob.sizeBytes);
    await exportIfRequested(ctx, store, blob.sha256, row.filename, opts.out);

    ctx.out.emit(
      {
        attachmentId,
        sha256: blob.sha256,
        sizeBytes: blob.sizeBytes,
        path: blob.path,
        deduplicated: blob.deduplicated,
        downloaded: true,
      },
      { profile: ctx.profileName(), source: "remote" },
      (d) =>
        `已下载 ${d.sizeBytes} 字节 → ${d.path}${d.deduplicated ? "（内容已存在，复用）" : ""}`,
    );
  } finally {
    db.close();
  }
}

/**
 * 按需导出到用户目录。
 *
 * 文件名来自不可信的邮件，必须经过 §15.4 的消毒；
 * 同名不覆盖，否则一次导出里两个同名附件会静默丢一个。
 */
async function exportIfRequested(
  ctx: Context,
  store: AttachmentStore,
  sha256: string,
  filename: string | null,
  outDir: string | undefined,
): Promise<void> {
  if (!outDir) return;
  const dir = assertUsableOutDir(outDir);
  mkdirSync(dir, { recursive: true });
  const target = uniqueExportPath(dir, filename ?? `${sha256.slice(0, 12)}.bin`);
  writeFileSync(target, readFileSync(store.pathFor(sha256)));
  ctx.out.note(`已导出到 ${target}`);
}

export async function runAttachmentPath(ctx: Context, attachmentId: string): Promise<void> {
  const db = openDatabase(ctx.paths.databaseFile);
  try {
    const row = new AttachmentRepository(db).find(ctx.profileName(), attachmentId);
    if (!row?.sha256) {
      throw new ZmailError(ErrorCode.NOT_FOUND, "该附件尚未下载", {
        hint: `运行 zmail attachment download ${attachmentId}`,
      });
    }
    const store = new AttachmentStore(ctx.paths.attachmentsDir, ctx.paths.tmpDir);
    const path = store.pathFor(row.sha256);
    if (!store.has(row.sha256)) {
      throw new ZmailError(ErrorCode.NOT_FOUND, "附件内容已被回收", {
        hint: `运行 zmail attachment download ${attachmentId} 重新获取`,
      });
    }
    ctx.out.emit({ attachmentId, path }, { profile: ctx.profileName() }, (d) => d.path);
  } finally {
    db.close();
  }
}

/** 按配额做 LRU 回收（§15.5）。 */
export async function runAttachmentPrune(
  ctx: Context,
  opts: { toQuota?: boolean; dryRun?: boolean },
): Promise<void> {
  const db = openDatabase(ctx.paths.databaseFile);
  try {
    const profile = ctx.profile();
    const repo = new AttachmentRepository(db);
    const store = new AttachmentStore(ctx.paths.attachmentsDir, ctx.paths.tmpDir);

    const quotaBytes = profile.storage.attachmentQuotaGb * 1024 ** 3;
    const currentBytes = repo.downloadedBytes();
    const plan = planEviction(repo.evictionCandidates(), currentBytes, quotaBytes);

    if (!opts.dryRun) {
      for (const c of plan.evict) {
        store.evict(c.sha256);
        repo.markEvicted(c.sha256);
      }
    }

    ctx.out.emit(
      {
        currentBytes,
        quotaBytes,
        evicted: plan.evict.length,
        freedBytes: plan.freedBytes,
        dryRun: opts.dryRun === true,
      },
      { profile: ctx.profileName() },
      (d) =>
        d.evicted === 0
          ? `未超出配额（${(d.currentBytes / 1024 ** 2).toFixed(1)} MB / ${(d.quotaBytes / 1024 ** 3).toFixed(1)} GB），无需回收。`
          : `${d.dryRun ? "将回收" : "已回收"} ${d.evicted} 个附件，释放 ${(d.freedBytes / 1024 ** 2).toFixed(1)} MB。元数据保留，再次请求会重新下载。`,
    );
  } finally {
    db.close();
  }
}
