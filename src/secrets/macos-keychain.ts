/**
 * macOS Keychain 后端。实施计划 §9.3。
 *
 * 用 execFile 而非 exec —— 绝不做 shell 字符串拼接，凭据里的引号和分号
 * 会变成命令注入。
 *
 * 已知边界（§9.4）：`security add-generic-password -w <secret>` 会让 secret
 * 短暂出现在进程参数中，同机其他用户可通过 ps 看到。个人机可接受，
 * 因此 SecretStore 被设计成可替换。
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  accountName,
  assertValidProfile,
  SECRET_KEYS,
  type SecretBackendInfo,
  type SecretKey,
  type SecretStore,
} from "./secret-store.js";

const exec = promisify(execFile);
const SECURITY_BIN = "/usr/bin/security";

/** security(1) 找不到条目时的退出码。 */
const ERR_ITEM_NOT_FOUND = 44;

export class MacosKeychainSecretStore implements SecretStore {
  readonly #service: string;

  constructor(service = "zmail-cli") {
    this.#service = service;
  }

  get info(): SecretBackendInfo {
    return {
      backend: "keychain",
      securityLevel: "os-keystore",
      location: `macOS Keychain (service: ${this.#service})`,
    };
  }

  async isAvailable(): Promise<boolean> {
    if (process.platform !== "darwin") return false;
    try {
      // list-keychains 不需要解锁，够用来判断 security(1) 可调用
      await exec(SECURITY_BIN, ["list-keychains"]);
      return true;
    } catch {
      return false;
    }
  }

  async get(profile: string, key: SecretKey): Promise<string | null> {
    assertValidProfile(profile);
    try {
      // -w 只输出密码本身
      const { stdout } = await exec(SECURITY_BIN, [
        "find-generic-password",
        "-s",
        this.#service,
        "-a",
        accountName(profile, key),
        "-w",
      ]);
      return stdout.replace(/\n$/, "");
    } catch (err) {
      if ((err as { code?: number }).code === ERR_ITEM_NOT_FOUND) return null;
      // 错误消息可能包含命令参数，绝不原样上抛
      throw new Error(`读取 Keychain 失败 (${profile}:${key})`);
    }
  }

  async set(profile: string, key: SecretKey, value: string): Promise<void> {
    assertValidProfile(profile);
    try {
      // -U 表示已存在时更新，避免先 delete 再 add 的竞态窗口
      await exec(SECURITY_BIN, [
        "add-generic-password",
        "-s",
        this.#service,
        "-a",
        accountName(profile, key),
        "-w",
        value,
        "-U",
      ]);
    } catch {
      throw new Error(`写入 Keychain 失败 (${profile}:${key})`);
    }
  }

  async delete(profile: string, key: SecretKey): Promise<void> {
    assertValidProfile(profile);
    try {
      await exec(SECURITY_BIN, [
        "delete-generic-password",
        "-s",
        this.#service,
        "-a",
        accountName(profile, key),
      ]);
    } catch (err) {
      // 删除不存在的条目视为成功（幂等）
      if ((err as { code?: number }).code === ERR_ITEM_NOT_FOUND) return;
      throw new Error(`删除 Keychain 条目失败 (${profile}:${key})`);
    }
  }

  async list(profile: string): Promise<SecretKey[]> {
    assertValidProfile(profile);
    const found: SecretKey[] = [];
    for (const key of SECRET_KEYS) {
      if ((await this.get(profile, key)) !== null) found.push(key);
    }
    return found;
  }
}
