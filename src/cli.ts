#!/usr/bin/env node
/**
 * CLI 入口。
 *
 * 职责只有三件：设置 umask、调用 run()、按返回值退出。
 * 所有逻辑在 app.ts 和 Core 中，以便未来的 MCP Adapter 直接复用。
 */

import { run } from "./app.js";
import { ExitCode } from "./core/errors.js";

// 必须在任何文件创建之前设置：本地邮件镜像是隐私数据，
// 新建的文件和目录默认只对当前用户可见（实施计划 §8.3）。
// 注意 umask 只影响新建对象，已存在文件由 doctor / init 主动 chmod。
process.umask(0o077);

const exitCode = await run({ argv: process.argv.slice(2) }).catch((err: unknown) => {
  // run() 内部已捕获所有可预见错误。走到这里说明是错误处理链本身出了问题。
  process.stderr.write(`zmail: 内部错误 ${err instanceof Error ? err.message : String(err)}\n`);
  return ExitCode.INTERNAL;
});

process.exitCode = exitCode;
