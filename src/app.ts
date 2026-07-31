/**
 * Commander 装配与顶层错误处理。
 *
 * 关键点（实施计划 §17.3）：Commander 默认在参数错误时用自己的格式打到 stderr
 * 并 process.exit(1)。这会直接破坏 Agent 契约 —— Agent 拿到「退出码 1 + 空 stdout」，
 * 无法解析也无法归类。因此这里用 exitOverride() 接管，把所有 Commander 错误
 * 映射成标准 error envelope，退出码 2。
 */

import { Command, CommanderError } from "commander";
import {
  runAttachmentDownload,
  runAttachmentList,
  runAttachmentPath,
  runAttachmentPrune,
} from "./commands/attachment.js";
import {
  runAuthLogin,
  runAuthRefresh,
  runAuthRemove,
  runAuthRevoke,
  runAuthSetup,
  runAuthStatus,
} from "./commands/auth.js";
import {
  runDataBackup,
  runDataPrune,
  runDataPurge,
  runDataReset,
  runDataStats,
  runDataVerify,
  runExport,
} from "./commands/data.js";
import { runDoctor } from "./commands/doctor.js";
import { runInit } from "./commands/init.js";
import { runCompletion, runSkillPath, runSkillPrint } from "./commands/skill.js";
import { runConfigPath, runConfigShow, runStatus, runVersion } from "./commands/status.js";
import {
  runFolderList,
  runMessageGet,
  runRebuildIndex,
  runSearch,
  runSync,
  runThreadGet,
} from "./commands/sync.js";
import { Context, type GlobalOptions, type Streams } from "./core/context.js";
import {
  ErrorCode,
  ExitCode,
  type ExitCodeValue,
  toZmailError,
  ZmailError,
} from "./core/errors.js";
import { packageVersion } from "./core/version.js";
import { OutputChannel } from "./output/envelope.js";

/** stdout/stderr 可注入，便于契约测试捕获输出。 */
export interface RunOptions {
  argv: string[];
  stdout?: NodeJS.WritableStream;
  stderr?: NodeJS.WritableStream;
  env?: NodeJS.ProcessEnv;
}

/**
 * `--json` 必须在 Commander 解析**之前**就知道 ——
 * 因为解析本身就可能失败，而失败输出的格式取决于它。
 */
function detectJsonFlag(argv: string[]): boolean {
  return argv.includes("--json");
}

function detectQuietFlag(argv: string[]): boolean {
  return argv.includes("--quiet") || argv.includes("-q");
}

export function buildProgram(streams: Streams = {}): Command {
  const program = new Command();

  program
    .name("zmail")
    .description("Local-first Zoho Mail mirror, search and safe-write CLI for AI agents")
    .version(packageVersion(), "-V, --version", "print the version")
    .option("--profile <name>", "use a specific profile")
    .option("--data-dir <path>", "override the data directory (takes precedence over ZMAIL_HOME)")
    .option("--json", "emit the stable JSON envelope for agents", false)
    .option("-q, --quiet", "suppress progress output on stderr", false)
    .option("--verbose", "emit more diagnostic detail", false)
    .option("--no-color", "disable coloured output")
    // 抛异常而不是直接退出，交给顶层统一处理
    .exitOverride()
    .configureOutput({
      // 帮助信息也走 stderr —— --json 下 stdout 只能有业务结果
      writeOut: (text) => void (streams.stderr ?? process.stderr).write(text),
      writeErr: (text) => void (streams.stderr ?? process.stderr).write(text),
    })
    .showHelpAfterError();

  // 裸 `zmail` 不带子命令：人类看帮助是合理的，但 --json 下必须给出可解析的错误，
  // 否则 Agent 拿到「退出码 0 + 空 stdout」。
  program.action(() => {
    // 选项在 action 触发前已解析完成，直接读 opts()，不碰 process.argv ——
    // 那样会让注入 argv 的契约测试失效。
    if (program.opts().json) {
      throw new ZmailError(ErrorCode.INVALID_ARGUMENT, "missing subcommand", {
        details: { available: program.commands.map((c) => c.name()) },
        hint: "Run `zmail --help` for usage",
      });
    }
    program.outputHelp();
  });

  program
    .command("init")
    .description("create ~/.zmail/ and initialise the database")
    .action(async () => {
      await runInit(makeContext(program, streams));
    });

  program
    .command("status")
    .description("show current status")
    .action(async () => {
      await runStatus(makeContext(program, streams));
    });

  program
    .command("doctor")
    .description("diagnose Node, directories, permissions, credential backend and database")
    .action(async () => {
      await runDoctor(makeContext(program, streams));
    });

  program
    .command("version")
    .description("print package, schema and index-normalizer versions")
    .action(async () => {
      await runVersion(makeContext(program, streams));
    });

  const config = requireSubcommand(program.command("config").description("inspect configuration"));
  config
    .command("path")
    .description("print the path to config.json")
    .action(async () => {
      await runConfigPath(makeContext(program, streams));
    });
  config
    .command("show")
    .description("print the current configuration")
    .action(async () => {
      await runConfigShow(makeContext(program, streams));
    });

  program
    .command("sync")
    .description("sync mail from Zoho into the local mirror")
    .option("--full", "full sync with reconciliation (default is quick)", false)
    .option("--quick", "scan only the most recent messages (default)", false)
    .option("--folder <name>", "sync only the named folder")
    .action(async (opts) => {
      await runSync(makeContext(program, streams), opts);
    });

  program
    .command("search [terms...]")
    .description("full-text search the local mirror (English and Chinese)")
    .option("--query <text>", "terms, escaped and combined with AND")
    .option("--phrase <text>", "exact phrase")
    .option("--any <text...>", "match any of these terms")
    .option("--exclude <text...>", "exclude these terms")
    .option("--raw-fts <expr>", "raw FTS5 expression; Chinese will usually match nothing")
    .option("--from <address>", "sender address")
    .option("--from-domain <domain>", "sender domain")
    .option("--to <address>", "recipient address")
    .option("--folder <name>", "restrict to a folder")
    .option("--after <date>", "on or after this ISO 8601 date")
    .option("--before <date>", "on or before this ISO 8601 date")
    .option("--unread", "unread only", false)
    .option("--has-attachment", "with attachments only", false)
    .option("--limit <n>", "number of results", "20")
    .option("--sort <mode>", "relevance | newest | oldest", "relevance")
    .action(async (terms: string[], opts) => {
      await runSearch(makeContext(program, streams), terms?.join(" ") || undefined, opts);
    });

  const message = requireSubcommand(
    program.command("message").description("read a single message"),
  );
  message
    .command("get <messageId>")
    .description("read a message by ID")
    .action(async (messageId: string) => {
      await runMessageGet(makeContext(program, streams), messageId);
    });

  const thread = requireSubcommand(program.command("thread").description("read a thread"));
  thread
    .command("get <threadId>")
    .description("read an entire thread by ID")
    .action(async (threadId: string) => {
      await runThreadGet(makeContext(program, streams), threadId);
    });

  const folder = requireSubcommand(program.command("folder").description("folders"));
  folder
    .command("list")
    .description("list folders and whether they are synced")
    .action(async () => {
      await runFolderList(makeContext(program, streams));
    });

  const attachment = requireSubcommand(
    program
      .command("attachment")
      .description("attachments (metadata syncs; content downloads on demand)"),
  );
  attachment
    .command("list <messageId>")
    .description("list a message's attachments")
    .action(async (messageId: string) => {
      await runAttachmentList(makeContext(program, streams), messageId);
    });
  attachment
    .command("download <attachmentId>")
    .description("download attachment content into content-addressed storage")
    .option("--out <dir>", "also export to this directory (filename is sanitized)")
    .action(async (attachmentId: string, opts) => {
      await runAttachmentDownload(makeContext(program, streams), attachmentId, opts);
    });
  attachment
    .command("path <attachmentId>")
    .description("print the local absolute path of an attachment")
    .action(async (attachmentId: string) => {
      await runAttachmentPath(makeContext(program, streams), attachmentId);
    });
  attachment
    .command("prune")
    .description("evict attachment content by LRU to stay within quota (metadata kept)")
    .option("--dry-run", "show what would be evicted without doing it", false)
    .action(async (opts) => {
      await runAttachmentPrune(makeContext(program, streams), opts);
    });

  const data = requireSubcommand(program.command("data").description("local data maintenance"));
  data
    .command("rebuild-index")
    .description("rebuild the full-text index from messages")
    .action(async () => {
      await runRebuildIndex(makeContext(program, streams));
    });
  data
    .command("stats")
    .description("report disk usage broken down by component")
    .action(async () => {
      await runDataStats(makeContext(program, streams));
    });
  data
    .command("verify")
    .description("integrity check: database, FTS index consistency, attachment files")
    .action(async () => {
      await runDataVerify(makeContext(program, streams));
    });
  data
    .command("backup")
    .description("back up database and config (excludes attachments and credentials)")
    .option("--out <dir>", "backup directory; defaults to ~/.zmail/backups/")
    .action(async (opts) => {
      await runDataBackup(makeContext(program, streams), opts);
    });
  data
    .command("prune")
    .description("prune regenerable data to reclaim space")
    .option("--raw-json", "drop stored raw JSON", false)
    .option("--body-html", "drop HTML bodies (plain text is kept)", false)
    .option("--remote-deleted", "delete messages confirmed gone from the server", false)
    .option("--older-than <days>", "only prune items older than this (e.g. 30d)", "30d")
    .action(async (opts) => {
      await runDataPrune(makeContext(program, streams), opts);
    });
  data
    .command("reset")
    .description("clear the local database and attachments; the Zoho mailbox is untouched")
    .option("--local-only", "required, to make 'local only' explicit on the command line", false)
    .option("--yes", "skip the interactive confirmation", false)
    .action(async (opts) => {
      await runDataReset(makeContext(program, streams), opts);
    });
  data
    .command("purge")
    .description("delete the entire data directory")
    .option("--yes", "skip the interactive confirmation", false)
    .action(async (opts) => {
      await runDataPurge(makeContext(program, streams), opts);
    });

  program
    .command("export")
    .description("export mail to standard formats — your data is not locked in")
    .requiredOption("--format <fmt>", "eml | mbox | jsonl", "jsonl")
    .requiredOption("--out <path>", "directory for eml; file path for mbox and jsonl")
    .option("--folder <name>", "restrict to a folder")
    .option("--after <date>", "该时间之后")
    .option("--before <date>", "该时间之前")
    .option("--limit <n>", "maximum number of messages to export")
    .action(async (opts) => {
      await runExport(makeContext(program, streams), opts);
    });

  const skill = requireSubcommand(
    program.command("skill").description("agent skill files bundled with this package"),
  );
  skill
    .command("path")
    .description("print where SKILL.md and its references live")
    .action(async () => {
      await runSkillPath(makeContext(program, streams));
    });
  skill
    .command("print")
    .description("print SKILL.md to stdout")
    .action(async () => {
      await runSkillPrint(makeContext(program, streams));
    });

  program
    .command("completion <shell>")
    .description("emit shell completion for bash, zsh or fish")
    .action(async (shell: string) => {
      await runCompletion(makeContext(program, streams), shell);
    });

  const auth = requireSubcommand(program.command("auth").description("manage Zoho authorization"));
  auth
    .command("setup")
    .description("store Zoho OAuth client credentials")
    .option("--client-id <id>", "Zoho OAuth client ID")
    .option("--client-secret <secret>", "Zoho OAuth client secret")
    .option("--email <address>", "Zoho email address")
    .option("--location <dc>", "data centre (com/eu/in/com.cn/com.au/jp)", "com")
    .action(async (opts) => {
      await runAuthSetup(makeContext(program, streams), opts);
    });
  auth
    .command("login")
    .description("authorize in a browser and store the refresh token")
    .action(async () => {
      await runAuthLogin(makeContext(program, streams));
    });
  auth
    .command("status")
    .description("show authorization status")
    .action(async () => {
      await runAuthStatus(makeContext(program, streams));
    });
  auth
    .command("refresh")
    .description("refresh the access token to verify credentials work")
    .action(async () => {
      await runAuthRefresh(makeContext(program, streams));
    });
  auth
    .command("revoke")
    .description("revoke remotely at Zoho and delete the local refresh token")
    .action(async () => {
      await runAuthRevoke(makeContext(program, streams));
    });
  auth
    .command("remove")
    .description("delete local credentials only; the remote grant stays active")
    .action(async () => {
      await runAuthRemove(makeContext(program, streams));
    });

  return program;
}

/**
 * 命令组必须带子命令。
 *
 * Commander 对「有子命令但没有 action 的命令」的默认行为是打印帮助后正常返回，
 * 于是 `zmail config --json` 会得到「退出码 0 + 空 stdout」—— Agent 无法解析，
 * 也无法判断出错了。每个命令组都必须显式拒绝。
 */
function requireSubcommand(cmd: Command): Command {
  cmd.action(() => {
    const available = cmd.commands.map((c) => c.name());
    throw new ZmailError(ErrorCode.INVALID_ARGUMENT, `"${cmd.name()}" requires a subcommand`, {
      details: { command: cmd.name(), available },
      hint: `Available subcommands: ${available.join(", ")}`,
    });
  });
  return cmd;
}

function makeContext(program: Command, streams: Streams = {}): Context {
  const opts = program.opts();
  const globalOptions: GlobalOptions = {
    profile: opts.profile as string | undefined,
    dataDir: opts.dataDir as string | undefined,
    json: Boolean(opts.json),
    quiet: Boolean(opts.quiet),
    verbose: Boolean(opts.verbose),
    color: opts.color !== false,
  };
  return new Context(globalOptions, streams);
}

/**
 * 执行 CLI，返回退出码。
 *
 * 不调用 process.exit —— 由调用方决定，这样契约测试可以在同一进程内断言。
 */
export async function run(options: RunOptions): Promise<ExitCodeValue> {
  const argv = options.argv;
  const json = detectJsonFlag(argv);
  const quiet = detectQuietFlag(argv);

  // 这个 channel 只用于「Commander 解析失败」的场景 —— 此时还没有 Context
  const fallbackOut = new OutputChannel({
    json,
    quiet,
    ...(options.stdout ? { stdout: options.stdout } : {}),
    ...(options.stderr ? { stderr: options.stderr } : {}),
  });

  const program = buildProgram({ stdout: options.stdout, stderr: options.stderr });

  try {
    await program.parseAsync(argv, { from: "user" });
    return ExitCode.OK;
  } catch (err) {
    // --help 和 --version 走的也是 CommanderError，它们不是失败
    if (err instanceof CommanderError) {
      if (err.code === "commander.helpDisplayed" || err.code === "commander.help") {
        return ExitCode.OK;
      }
      if (err.code === "commander.version") {
        // Commander 自己把版本写到了 stderr（见 configureOutput）。
        // --json 下需要一个合法文档，补一个到 stdout。
        if (json) fallbackOut.emit({ version: packageVersion() });
        else fallbackOut.emit({ version: packageVersion() }, {}, (d) => d.version);
        return ExitCode.OK;
      }

      const zErr = new ZmailError(ErrorCode.INVALID_ARGUMENT, cleanCommanderMessage(err), {
        details: { commanderCode: err.code },
        hint: "Run `zmail --help` for usage",
      });
      fallbackOut.emitError(zErr);
      return zErr.exitCode;
    }

    const zErr = toZmailError(err);

    // 命令内部已经拿到自己的 OutputChannel，但错误发生在 emit 之前，
    // 所以这里用 fallback 输出。emitError 的幂等保护确保不会重复输出。
    fallbackOut.emitError(zErr);

    if (zErr.code === ErrorCode.INTERNAL && process.env.ZMAIL_DEBUG) {
      options.stderr?.write?.(`${(zErr.cause as Error)?.stack ?? ""}\n`);
    }
    return zErr.exitCode;
  }
}

/** Commander 的消息带换行和多余修饰，压成一行。 */
function cleanCommanderMessage(err: CommanderError): string {
  return err.message
    .replace(/^error:\s*/i, "")
    .replace(/\s+/g, " ")
    .trim();
}
