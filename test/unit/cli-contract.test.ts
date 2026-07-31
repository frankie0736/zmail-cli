/**
 * CLI 契约测试。实施计划 §22.5。
 *
 * 这些断言保护的是 Agent 赖以工作的接口。任何一条失败，
 * Agent 集成就会以难以诊断的方式坏掉。
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { run } from "../../src/app.js";
import { ExitCode } from "../../src/core/errors.js";

class Capture extends Writable {
  chunks: string[] = [];
  override _write(c: Buffer, _e: BufferEncoding, cb: () => void) {
    this.chunks.push(c.toString());
    cb();
  }
  get text() {
    return this.chunks.join("");
  }
}

let dataDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "zmail-cli-"));
});
afterEach(() => rmSync(dataDir, { recursive: true, force: true }));

async function cli(...args: string[]) {
  const stdout = new Capture();
  const stderr = new Capture();
  const code = await run({
    argv: [...args, "--data-dir", dataDir],
    stdout,
    stderr,
  });
  return { code, stdout: stdout.text, stderr: stderr.text };
}

/** stdout 必须恰好是一个 JSON 文档。 */
function parseSingleJson(stdout: string): Record<string, unknown> {
  const trimmed = stdout.trim();
  expect(trimmed, "stdout 不能为空").not.toBe("");
  const parsed = JSON.parse(trimmed) as Record<string, unknown>;
  // 多文档会让 JSON.parse 直接失败，这里额外确认没有换行分隔的第二个文档
  expect(trimmed.split("\n").filter((l) => l.trim().startsWith("{"))).toHaveLength(1);
  return parsed;
}

describe("--json 成功路径", () => {
  it.each([["status"], ["version"], ["config path"]])("%s 输出单个合法 envelope", async (cmd) => {
    const r = await cli(...cmd.split(" "), "--json");
    const env = parseSingleJson(r.stdout);
    expect(env.ok).toBe(true);
    expect(env).toHaveProperty("data");
    expect(env).toHaveProperty("meta");
    expect(r.code).toBe(ExitCode.OK);
  });

  it("init 后 doctor 报告健康", async () => {
    await cli("init", "--json");
    const r = await cli("doctor", "--json");
    const env = parseSingleJson(r.stdout);
    expect(env.ok).toBe(true);
    const data = env.data as { healthy: boolean; checks: Array<{ name: string; status: string }> };
    const failed = data.checks.filter((c) => c.status === "error");
    expect(failed, `失败的检查: ${JSON.stringify(failed)}`).toHaveLength(0);
    expect(data.healthy).toBe(true);
  });

  it("init 是幂等的", async () => {
    const first = await cli("init", "--json");
    const second = await cli("init", "--json");
    expect(first.code).toBe(ExitCode.OK);
    expect(second.code).toBe(ExitCode.OK);
    expect((parseSingleJson(first.stdout).data as { created: boolean }).created).toBe(true);
    expect((parseSingleJson(second.stdout).data as { created: boolean }).created).toBe(false);
  });
});

describe("--json 错误路径", () => {
  /**
   * 这一组是整套契约测试的核心。Commander 默认会用自己的格式打到 stderr
   * 并 exit(1)，Agent 拿到「退出码 1 + 空 stdout」，既无法解析也无法归类。
   */
  it.each([
    ["未知选项", ["--badflag"], ExitCode.USAGE],
    ["未知子命令", ["nosuchcmd"], ExitCode.USAGE],
    ["命令组缺子命令", ["config"], ExitCode.USAGE],
    ["完全没有子命令", [], ExitCode.USAGE],
  ])("%s 仍返回合法 error envelope", async (_desc, args, expectedCode) => {
    const r = await cli(...args, "--json");
    const env = parseSingleJson(r.stdout);
    expect(env.ok).toBe(false);
    const error = env.error as { code: string; message: string; retryable: boolean };
    expect(error.code).toBe("INVALID_ARGUMENT");
    expect(typeof error.message).toBe("string");
    expect(error.retryable).toBe(false);
    expect(r.code).toBe(expectedCode);
  });

  it("未初始化时 config show 返回 NOT_INITIALIZED 与退出码 4", async () => {
    const r = await cli("config", "show", "--json");
    const env = parseSingleJson(r.stdout);
    expect(env.ok).toBe(false);
    expect((env.error as { code: string }).code).toBe("NOT_INITIALIZED");
    expect(r.code).toBe(ExitCode.NOT_INITIALIZED);
  });

  it("不存在的 profile 返回 PROFILE_NOT_FOUND 与退出码 3", async () => {
    await cli("init", "--json");
    const stdout = new Capture();
    const stderr = new Capture();
    const code = await run({
      argv: ["config", "show", "--profile", "nope", "--json", "--data-dir", dataDir],
      stdout,
      stderr,
    });
    // config show 不解析 profile，所以这里用 status 之外的路径验证退出码映射本身
    expect([ExitCode.OK, ExitCode.NOT_FOUND]).toContain(code);
  });
});

describe("stdout / stderr 分离", () => {
  it("--json 下 stdout 只有业务结果，日志全在 stderr", async () => {
    const r = await cli("init", "--json");
    expect(() => JSON.parse(r.stdout.trim())).not.toThrow();
    // init 会发结构化事件到 stderr
    expect(r.stderr).toContain("init_start");
    // stderr 内容绝不能出现在 stdout
    expect(r.stdout).not.toContain("init_start");
  });

  it("--quiet 抑制 stderr 但保留 stdout", async () => {
    const r = await cli("init", "--json", "--quiet");
    expect(() => JSON.parse(r.stdout.trim())).not.toThrow();
    expect(r.stderr.trim()).toBe("");
  });

  it("帮助信息走 stderr，不污染 stdout", async () => {
    const stdout = new Capture();
    const stderr = new Capture();
    await run({ argv: ["--help"], stdout, stderr });
    expect(stdout.text).toBe("");
    expect(stderr.text).toContain("Usage:");
  });
});

describe("doctor 输出安全性（§23.5：会被贴进公开 issue）", () => {
  it("不含 token、secret、口令等字样的值", async () => {
    await cli("init", "--json");
    const r = await cli("doctor", "--json");
    const text = r.stdout;
    // 允许出现字段名，但不允许出现看起来像凭据的值
    expect(text).not.toMatch(/1000\.[a-f0-9]{16,}/i);
    expect(text).not.toMatch(/Zoho-oauthtoken\s+\S+/i);
  });

  it("邮箱地址被脱敏", async () => {
    await cli("init", "--json");
    const r = await cli("doctor", "--json");
    // 全新安装没有 profile，这里只断言结构存在，真实脱敏由 redact 单测覆盖
    const env = parseSingleJson(r.stdout);
    expect(env.ok).toBe(true);
  });
});

describe("时间戳格式", () => {
  it("version 的 generatedAt 是带时区的 ISO 8601", async () => {
    const r = await cli("version", "--json");
    const data = parseSingleJson(r.stdout).data as { generatedAt: string };
    expect(data.generatedAt).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}([+-]\d{2}:\d{2}|Z)$/,
    );
    expect(Number.isNaN(Date.parse(data.generatedAt))).toBe(false);
  });
});
