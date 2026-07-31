/**
 * data 维护命令：stats / verify / backup / restore / prune / reset / purge。
 * 实施计划 §12.1 / §16.7 / §21。
 */

import { copyFileSync, existsSync, mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import type { Context } from "../core/context.js";
import { ErrorCode, ZmailError } from "../core/errors.js";
import { currentSchemaVersion, openDatabase, verifyIntegrity } from "../db/database.js";
import { AttachmentRepository } from "../db/repositories/attachment-repository.js";
import { isoTimestamp } from "../output/envelope.js";
import { type ExportFormat, exportMessages } from "../storage/export.js";
import { assertUsableOutDir } from "../storage/safe-filename.js";

const MB = 1024 ** 2;
const human = (bytes: number) =>
  bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(2)} GB` : `${(bytes / MB).toFixed(1)} MB`;

// ---------------------------------------------------------------- stats

export async function runDataStats(ctx: Context): Promise<void> {
  const db = openDatabase(ctx.paths.databaseFile);
  try {
    const g = <T>(sql: string) => db.prepare(sql).get() as T;
    const bytesOf = (col: string) =>
      g<{ t: number }>(`SELECT COALESCE(SUM(length(${col})), 0) AS t FROM messages`).t;

    // 分项体积是 MVP 必需项：用户必须能自己诊断磁盘占用（§12.1）
    const breakdown = {
      bodyText: bytesOf("body_text"),
      bodyHtml: bytesOf("body_html"),
      rawJson: bytesOf("raw_json"),
      subjectAndMeta: bytesOf("subject") + bytesOf("summary"),
    };
    const ftsBytes = g<{ t: number }>(
      "SELECT COALESCE(SUM(length(block)), 0) AS t FROM messages_fts_data",
    ).t;

    const attachments = new AttachmentRepository(db).stats();

    ctx.out.emit(
      {
        database: {
          path: ctx.paths.databaseFile,
          fileBytes: existsSync(ctx.paths.databaseFile) ? statSync(ctx.paths.databaseFile).size : 0,
          schemaVersion: currentSchemaVersion(db),
          messages: g<{ c: number }>("SELECT count(*) AS c FROM messages").c,
          folders: g<{ c: number }>("SELECT count(*) AS c FROM folders").c,
          recipients: g<{ c: number }>("SELECT count(*) AS c FROM message_recipients").c,
          breakdown: { ...breakdown, ftsIndex: ftsBytes },
        },
        attachments: {
          ...attachments,
          quotaBytes: ctx.isInitialized
            ? (Object.values(ctx.config().profiles)[0]?.storage.attachmentQuotaGb ?? 20) * 1024 ** 3
            : null,
        },
      },
      { profile: ctx.profileName(), source: "local" },
      (d) =>
        [
          `数据库  ${human(d.database.fileBytes)}  schema v${d.database.schemaVersion}`,
          `  邮件      ${d.database.messages}`,
          `  文件夹    ${d.database.folders}`,
          `  收件人    ${d.database.recipients}`,
          "",
          "体积分项:",
          `  正文纯文本  ${human(d.database.breakdown.bodyText)}`,
          `  正文 HTML   ${human(d.database.breakdown.bodyHtml)}`,
          `  原始 JSON   ${human(d.database.breakdown.rawJson)}`,
          `  全文索引    ${human(d.database.breakdown.ftsIndex)}`,
          "",
          `附件  ${d.attachments.downloaded}/${d.attachments.total} 已下载，占用 ${human(d.attachments.downloadedBytes)}`,
          d.attachments.dedupSavedBytes > 0
            ? `  内容去重节省 ${human(d.attachments.dedupSavedBytes)}`
            : "",
        ]
          .filter(Boolean)
          .join("\n"),
    );
  } finally {
    db.close();
  }
}

// ---------------------------------------------------------------- verify

export async function runDataVerify(ctx: Context): Promise<void> {
  const db = openDatabase(ctx.paths.databaseFile);
  try {
    const integrity = verifyIntegrity(db);

    // 索引与消息数量对不上，说明 FTS 维护漏了某一处 —— 那意味着有邮件搜不到
    const messages = (db.prepare("SELECT count(*) AS c FROM messages").get() as { c: number }).c;
    const indexed = (db.prepare("SELECT count(*) AS c FROM messages_fts").get() as { c: number }).c;

    // 数据库说已下载但磁盘上没有的附件
    const orphans = (
      db
        .prepare(
          "SELECT local_path FROM attachments WHERE download_status = 'downloaded' AND local_path IS NOT NULL",
        )
        .all() as Array<{ local_path: string }>
    ).filter((r) => !existsSync(r.local_path)).length;

    const problems = [
      ...integrity.problems,
      ...(indexed !== messages
        ? [`FTS 索引数量不符：消息 ${messages} 条，索引 ${indexed} 条 —— 部分邮件搜不到`]
        : []),
      ...(orphans > 0 ? [`${orphans} 个附件在数据库中标记为已下载但磁盘上不存在`] : []),
    ];

    ctx.out.emit(
      { ok: problems.length === 0, messages, indexed, orphanAttachments: orphans, problems },
      { profile: ctx.profileName(), source: "local" },
      (d) =>
        d.ok
          ? `完整性检查通过（${d.messages} 条消息，索引一致）`
          : `发现 ${d.problems.length} 处问题：\n${d.problems.map((p) => `  - ${p}`).join("\n")}\n\n索引不一致可用 zmail data rebuild-index 修复。`,
    );
    if (problems.length > 0) throw new ZmailError(ErrorCode.INCOMPLETE_DATA, "完整性检查未通过");
  } finally {
    db.close();
  }
}

// ---------------------------------------------------------------- backup

export async function runDataBackup(ctx: Context, opts: { out?: string }): Promise<void> {
  const stamp = new Date().toISOString().replace(/[:.]/g, "").slice(0, 15);
  const dest = opts.out
    ? assertUsableOutDir(opts.out)
    : join(ctx.paths.backupsDir, `zmail-${stamp}`);
  mkdirSync(dest, { recursive: true, mode: 0o700 });

  // SQLite 的在线备份 API：不用停止写入也能拿到一致快照
  const db = openDatabase(ctx.paths.databaseFile);
  try {
    await db.backup(join(dest, "mail.sqlite3"));
  } finally {
    db.close();
  }

  if (existsSync(ctx.paths.configFile)) {
    copyFileSync(ctx.paths.configFile, join(dest, "config.json"));
  }

  const manifest = {
    createdAt: isoTimestamp(),
    schemaVersion: (() => {
      const d = openDatabase(join(dest, "mail.sqlite3"));
      try {
        return currentSchemaVersion(d);
      } finally {
        d.close();
      }
    })(),
    // 附件默认不复制：大文件可从 Zoho 重新下载，备份体积不该被它们主导（§21.2）
    attachmentsIncluded: false,
    note: "Keychain 凭据不进入备份。恢复后需要重新 auth login 或 auth setup。",
  };
  writeFileSync(join(dest, "manifest.json"), JSON.stringify(manifest, null, 2), { mode: 0o600 });

  ctx.out.emit(
    { path: dest, ...manifest },
    { profile: ctx.profileName() },
    (d) => `已备份到 ${d.path}\n（不含附件与凭据）`,
  );
}

// ---------------------------------------------------------------- export

export async function runExport(
  ctx: Context,
  opts: {
    format?: string;
    out?: string;
    folder?: string | undefined;
    after?: string | undefined;
    before?: string | undefined;
    limit?: string | undefined;
  },
): Promise<void> {
  const format = (opts.format ?? "jsonl") as ExportFormat;
  if (!["eml", "mbox", "jsonl"].includes(format)) {
    throw new ZmailError(ErrorCode.INVALID_ARGUMENT, `不支持的导出格式: ${format}`, {
      details: { supported: ["eml", "mbox", "jsonl"] },
    });
  }
  if (!opts.out) {
    throw new ZmailError(ErrorCode.INVALID_ARGUMENT, "必须指定 --out", {
      hint: format === "eml" ? "eml 需要一个目录路径" : "mbox / jsonl 需要一个文件路径",
    });
  }

  const db = openDatabase(ctx.paths.databaseFile);
  try {
    const result = await exportMessages(
      db,
      format,
      opts.out,
      {
        profileId: ctx.profileName(),
        folder: opts.folder,
        after: opts.after,
        before: opts.before,
        limit: opts.limit ? Number(opts.limit) : undefined,
      },
      (done) => ctx.out.note(`已导出 ${done} 封…`),
    );
    ctx.out.emit(
      result,
      { profile: ctx.profileName(), source: "local" },
      (d) => `已导出 ${d.exported} 封为 ${d.format} → ${d.out}`,
    );
  } finally {
    db.close();
  }
}

// ---------------------------------------------------------------- prune

export async function runDataPrune(
  ctx: Context,
  opts: { rawJson?: boolean; bodyHtml?: boolean; remoteDeleted?: boolean; olderThan?: string },
): Promise<void> {
  const db = openDatabase(ctx.paths.databaseFile);
  try {
    const days = opts.olderThan ? Number(opts.olderThan.replace(/d$/, "")) : 30;
    const cutoff = Date.now() - days * 86_400_000;
    const changes: Record<string, number> = {};

    if (opts.rawJson) {
      changes.rawJson = db
        .prepare(
          "UPDATE messages SET raw_json = NULL WHERE raw_json IS NOT NULL AND received_at < ?",
        )
        .run(cutoff).changes;
    }
    if (opts.bodyHtml) {
      changes.bodyHtml = db
        .prepare(
          "UPDATE messages SET body_html = NULL WHERE body_html IS NOT NULL AND received_at < ?",
        )
        .run(cutoff).changes;
    }
    if (opts.remoteDeleted) {
      // 只清理确认远程已删除且超过保留期的 —— 本地正文在此之前一直保留（§14.7）
      changes.remoteDeleted = db
        .prepare("DELETE FROM messages WHERE is_remote_deleted = 1 AND last_synced_at < ?")
        .run(cutoff).changes;
    }

    if (Object.keys(changes).length === 0) {
      throw new ZmailError(ErrorCode.INVALID_ARGUMENT, "未指定要清理的内容", {
        hint: "使用 --raw-json / --body-html / --remote-deleted",
      });
    }

    db.exec("VACUUM");
    ctx.out.emit({ cutoffDays: days, changes }, { profile: ctx.profileName() }, (d) =>
      Object.entries(d.changes)
        .map(([k, v]) => `${k}: 清理 ${v} 条`)
        .join("\n"),
    );
  } finally {
    db.close();
  }
}

// ---------------------------------------------------------------- reset / purge

export async function runDataReset(
  ctx: Context,
  opts: { localOnly?: boolean; yes?: boolean },
): Promise<void> {
  if (!opts.localOnly) {
    throw new ZmailError(ErrorCode.INVALID_ARGUMENT, "必须显式指定 --local-only", {
      hint: "这是为了让「只影响本地」这件事在命令行上可见",
    });
  }
  await confirmDestructive(ctx, "这会删除本地数据库与附件（Zoho 远程邮箱不受影响）", opts.yes);

  rmSync(ctx.paths.databaseFile, { force: true });
  rmSync(`${ctx.paths.databaseFile}-wal`, { force: true });
  rmSync(`${ctx.paths.databaseFile}-shm`, { force: true });
  rmSync(ctx.paths.attachmentsDir, { recursive: true, force: true });
  mkdirSync(ctx.paths.attachmentsDir, { recursive: true, mode: 0o700 });

  ctx.out.emit(
    { reset: true, remoteUnaffected: true },
    { profile: ctx.profileName() },
    () => "本地数据已清除。config.json 与凭据保留。运行 zmail init 重建，然后 zmail sync --full。",
  );
}

export async function runDataPurge(ctx: Context, opts: { yes?: boolean }): Promise<void> {
  await confirmDestructive(
    ctx,
    `这会删除整个 ${ctx.paths.root} 目录，包括配置、数据库、附件与日志`,
    opts.yes,
  );
  rmSync(ctx.paths.root, { recursive: true, force: true });
  ctx.out.emit(
    { purged: ctx.paths.root, credentialsRemoved: false },
    {},
    (d) =>
      `已删除 ${d.purged}\n\n⚠️ 系统钥匙串中的凭据未被删除，如需清理请运行 zmail auth remove（在删除前）。`,
  );
}

/**
 * 破坏性操作的二次确认（§7.4）。
 *
 * `--json` 下不交互 —— Agent 无法回答，而静默执行一个删库操作是不可接受的。
 * 必须显式传 --yes。
 */
async function confirmDestructive(
  ctx: Context,
  what: string,
  yes: boolean | undefined,
): Promise<void> {
  if (yes) return;
  if (ctx.out.isJson || !process.stdin.isTTY) {
    throw new ZmailError(ErrorCode.APPROVAL_REQUIRED, `${what}。需要确认。`, {
      hint: "确认无误后追加 --yes",
    });
  }
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    const answer = await rl.question(`${what}\n确认执行？输入 yes 继续: `);
    if (answer.trim().toLowerCase() !== "yes") {
      throw new ZmailError(ErrorCode.APPROVAL_REQUIRED, "已取消");
    }
  } finally {
    rl.close();
  }
}
