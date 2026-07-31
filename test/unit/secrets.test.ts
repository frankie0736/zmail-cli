/**
 * FileSecretStore 测试。实施计划 §22.1。
 *
 * 这个后端承担 Linux / Windows 用户的全部凭据安全，必须验证：
 * 正确口令可解、错误口令报错而非静默返回空、密文被篡改时 GCM 拒绝。
 */

import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ErrorCode, ZmailError } from "../../src/core/errors.js";
import { createPassphraseProvider, FileSecretStore } from "../../src/secrets/file-secret-store.js";
import { MemorySecretStore } from "../../src/secrets/memory-secret-store.js";
import { assertValidProfile } from "../../src/secrets/secret-store.js";

let dir: string;
let file: string;

const store = (passphrase: string) => new FileSecretStore(file, async () => passphrase);

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "zmail-secret-"));
  file = join(dir, "secrets.enc");
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("FileSecretStore", () => {
  it("往返读写", async () => {
    const s = store("correct horse battery staple");
    await s.set("primary", "refresh-token", "1000.abc.def");
    expect(await s.get("primary", "refresh-token")).toBe("1000.abc.def");
  });

  it("跨实例持久化（新进程只凭口令即可读回）", async () => {
    await store("pw").set("primary", "client-id", "1000.CID");
    // 全新实例 = 模拟新进程，缓存的 key 不复用
    expect(await store("pw").get("primary", "client-id")).toBe("1000.CID");
  });

  it("密文中不出现明文", async () => {
    await store("pw").set("primary", "refresh-token", "SUPER_SECRET_VALUE");
    expect(readFileSync(file, "utf8")).not.toContain("SUPER_SECRET_VALUE");
  });

  it("文件权限为 0600", async () => {
    await store("pw").set("primary", "client-id", "x");
    if (process.platform !== "win32") {
      expect(statSync(file).mode & 0o777).toBe(0o600);
    }
  });

  it("错误口令抛 SECRET_DECRYPT_FAILED，而不是静默返回 null", async () => {
    await store("right").set("primary", "refresh-token", "value");
    // 这是关键：如果只是返回 null，用户会以为「凭据丢了」而重新授权，
    // 真正的原因（口令错）永远不会浮现
    await expect(store("wrong").get("primary", "refresh-token")).rejects.toMatchObject({
      code: ErrorCode.SECRET_DECRYPT_FAILED,
    });
  });

  it("密文被篡改时 GCM 校验拒绝解密", async () => {
    const s = store("pw");
    await s.set("primary", "refresh-token", "value");

    const parsed = JSON.parse(readFileSync(file, "utf8"));
    const entry = parsed.entries["primary:refresh-token"];
    const bytes = Buffer.from(entry.ciphertext, "base64");
    expect(bytes.length).toBeGreaterThan(0);
    bytes.writeUInt8(bytes.readUInt8(0) ^ 0xff, 0); // 翻转一个 bit
    entry.ciphertext = bytes.toString("base64");
    writeFileSync(file, JSON.stringify(parsed));

    await expect(store("pw").get("primary", "refresh-token")).rejects.toMatchObject({
      code: ErrorCode.SECRET_DECRYPT_FAILED,
    });
  });

  it("不存在的条目返回 null（区别于口令错）", async () => {
    const s = store("pw");
    await s.set("primary", "client-id", "x");
    expect(await s.get("primary", "refresh-token")).toBeNull();
  });

  it("未创建文件时 get 返回 null", async () => {
    expect(await store("pw").get("primary", "client-id")).toBeNull();
  });

  it("list 只返回已存在的 key", async () => {
    const s = store("pw");
    await s.set("primary", "client-id", "a");
    await s.set("primary", "refresh-token", "b");
    expect((await s.list("primary")).sort()).toEqual(["client-id", "refresh-token"]);
  });

  it("delete 是幂等的", async () => {
    const s = store("pw");
    await s.set("primary", "client-id", "a");
    await s.delete("primary", "client-id");
    await s.delete("primary", "client-id");
    expect(await s.get("primary", "client-id")).toBeNull();
  });

  it("多个 profile 互不干扰", async () => {
    const s = store("pw");
    await s.set("primary", "client-id", "PRIMARY");
    await s.set("work", "client-id", "WORK");
    expect(await s.get("primary", "client-id")).toBe("PRIMARY");
    expect(await s.get("work", "client-id")).toBe("WORK");
  });

  it("文件损坏时给出可操作的错误", async () => {
    writeFileSync(file, "{ not json");
    await expect(store("pw").get("primary", "client-id")).rejects.toMatchObject({
      code: ErrorCode.SECRET_BACKEND_UNAVAILABLE,
    });
  });

  it("文件版本高于支持范围时拒绝读取", async () => {
    writeFileSync(file, JSON.stringify({ version: 99, kdf: {}, verifier: {}, entries: {} }));
    await expect(store("pw").get("primary", "client-id")).rejects.toMatchObject({
      code: ErrorCode.SECRET_BACKEND_UNAVAILABLE,
    });
  });

  it("info 如实报告安全等级，且带警告", () => {
    const info = store("pw").info;
    expect(info.backend).toBe("file");
    expect(info.securityLevel).toBe("encrypted-file");
    // §9.5.4：不得暗示与系统钥匙串等价
    expect(info.warning).toBeTruthy();
  });
});

describe("createPassphraseProvider", () => {
  it("优先使用 ZMAIL_PASSPHRASE", async () => {
    const provider = createPassphraseProvider({
      json: true,
      env: { ZMAIL_PASSPHRASE: "from-env" },
    });
    expect(await provider()).toBe("from-env");
  });

  it("--json 模式下缺口令时抛 AUTH_PASSPHRASE_REQUIRED 而不是阻塞", async () => {
    // Agent 无法回答交互式提示，阻塞等于挂死
    const provider = createPassphraseProvider({ json: true, env: {} });
    await expect(provider()).rejects.toMatchObject({
      code: ErrorCode.AUTH_PASSPHRASE_REQUIRED,
    });
  });

  it("非 TTY 时同样不阻塞", async () => {
    const provider = createPassphraseProvider({ json: false, env: {} });
    if (!process.stdin.isTTY) {
      await expect(provider()).rejects.toBeInstanceOf(ZmailError);
    }
  });
});

describe("assertValidProfile", () => {
  it.each(["primary", "work", "a-b_c.d", "p1"])("接受合法名 %s", (name) => {
    expect(() => assertValidProfile(name)).not.toThrow();
  });

  it.each([
    ["含冒号会破坏 <profile>:<key> 解析", "pri:mary"],
    ["路径分隔符", "../etc"],
    ["反斜杠", "a\\b"],
    ["空字符串", ""],
    ["以点开头", ".hidden"],
    ["超长", "x".repeat(65)],
  ])("拒绝 %s", (_desc, name) => {
    expect(() => assertValidProfile(name)).toThrow();
  });
});

describe("MemorySecretStore", () => {
  it("绝不触碰真实钥匙串，仅存在于内存", async () => {
    const s = new MemorySecretStore();
    await s.set("primary", "client-id", "x");
    expect(await s.get("primary", "client-id")).toBe("x");
    expect(s.info.securityLevel).toBe("memory-only");
    // 新实例没有任何残留
    expect(await new MemorySecretStore().get("primary", "client-id")).toBeNull();
  });
});
