/**
 * Commander 装配与顶层错误处理。
 *
 * 关键点（实施计划 §17.3）：Commander 默认在参数错误时用自己的格式打到 stderr
 * 并 process.exit(1)。这会直接破坏 Agent 契约 —— Agent 拿到「退出码 1 + 空 stdout」，
 * 无法解析也无法归类。因此这里用 exitOverride() 接管，把所有 Commander 错误
 * 映射成标准 error envelope，退出码 2。
 */

import { Command, CommanderError } from "commander";
import { runDoctor } from "./commands/doctor.js";
import { runInit } from "./commands/init.js";
import { runConfigPath, runConfigShow, runStatus, runVersion } from "./commands/status.js";
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
    .version(packageVersion(), "-V, --version", "输出版本号")
    .option("--profile <name>", "使用指定的 profile")
    .option("--data-dir <path>", "覆盖数据目录（优先于 ZMAIL_HOME）")
    .option("--json", "输出 JSON，供 Agent 消费", false)
    .option("-q, --quiet", "抑制 stderr 上的进度信息", false)
    .option("--verbose", "输出更详细的诊断信息", false)
    .option("--no-color", "禁用彩色输出")
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
      throw new ZmailError(ErrorCode.INVALID_ARGUMENT, "缺少子命令", {
        details: { available: program.commands.map((c) => c.name()) },
        hint: "运行 zmail --help 查看用法",
      });
    }
    program.outputHelp();
  });

  program
    .command("init")
    .description("初始化 ~/.zmail/ 并创建数据库")
    .action(async () => {
      await runInit(makeContext(program, streams));
    });

  program
    .command("status")
    .description("显示当前状态")
    .action(async () => {
      await runStatus(makeContext(program, streams));
    });

  program
    .command("doctor")
    .description("诊断 Node、目录、权限、凭据后端和数据库")
    .action(async () => {
      await runDoctor(makeContext(program, streams));
    });

  program
    .command("version")
    .description("输出版本、schema 版本与索引规范化版本")
    .action(async () => {
      await runVersion(makeContext(program, streams));
    });

  const config = requireSubcommand(program.command("config").description("查看配置"));
  config
    .command("path")
    .description("输出 config.json 的路径")
    .action(async () => {
      await runConfigPath(makeContext(program, streams));
    });
  config
    .command("show")
    .description("输出当前配置内容")
    .action(async () => {
      await runConfigShow(makeContext(program, streams));
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
    throw new ZmailError(ErrorCode.INVALID_ARGUMENT, `"${cmd.name()}" 需要一个子命令`, {
      details: { command: cmd.name(), available },
      hint: `可用子命令: ${available.join(", ")}`,
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
        hint: "运行 zmail --help 查看用法",
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
