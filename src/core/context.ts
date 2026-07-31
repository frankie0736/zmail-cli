/**
 * 命令执行上下文。
 *
 * 所有业务逻辑放在 Core，CLI 只是 Adapter（实施计划 §5）。
 * 以后加 MCP 时，MCP 直接构造 Context 调用同样的函数，不经过 Shell。
 */

import { buildPaths, resolveDataDir, type ZmailPaths } from "../config/paths.js";
import type { Config } from "../config/schema.js";
import { configExists, loadConfig } from "../config/store.js";
import { OutputChannel } from "../output/envelope.js";
import { ErrorCode, ZmailError } from "./errors.js";

export interface GlobalOptions {
  profile?: string | undefined;
  dataDir?: string | undefined;
  json: boolean;
  quiet: boolean;
  verbose: boolean;
  color: boolean;
}

/** 可注入的输出流。契约测试靠它在同一进程内捕获 stdout/stderr。 */
export interface Streams {
  stdout?: NodeJS.WritableStream | undefined;
  stderr?: NodeJS.WritableStream | undefined;
}

export class Context {
  readonly options: GlobalOptions;
  readonly paths: ZmailPaths;
  readonly out: OutputChannel;
  #config: Config | undefined;

  constructor(options: GlobalOptions, streams: Streams = {}) {
    this.options = options;
    this.paths = buildPaths(resolveDataDir(options.dataDir));
    this.out = new OutputChannel({
      json: options.json,
      quiet: options.quiet,
      ...(streams.stdout ? { stdout: streams.stdout } : {}),
      ...(streams.stderr ? { stderr: streams.stderr } : {}),
    });
  }

  get isInitialized(): boolean {
    return configExists(this.paths.configFile);
  }

  /** 读配置。未初始化时抛 NOT_INITIALIZED，退出码 4。 */
  config(): Config {
    if (!this.#config) this.#config = loadConfig(this.paths.configFile);
    return this.#config;
  }

  /** 解析当前 profile 名：--profile > config.defaultProfile。 */
  profileName(): string {
    const explicit = this.options.profile;
    if (explicit) return explicit;
    return this.config().defaultProfile;
  }

  /** 解析当前 profile。不存在时抛 PROFILE_NOT_FOUND。 */
  profile() {
    const config = this.config();
    const name = this.profileName();
    const profile = config.profiles[name];
    if (!profile) {
      const available = Object.keys(config.profiles);
      throw new ZmailError(ErrorCode.PROFILE_NOT_FOUND, `未找到 profile "${name}"`, {
        details: { requested: name, available },
        hint:
          available.length === 0
            ? "还没有任何 profile，先运行 zmail auth login"
            : `可用的 profile: ${available.join(", ")}`,
      });
    }
    return profile;
  }
}
