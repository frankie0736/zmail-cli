/**
 * 后端选择。实施计划 §9.5.1。
 *
 * 优先级：
 *   1. 显式指定  ZMAIL_SECRET_BACKEND=keychain|file / config.secretBackend
 *   2. macOS 且 security(1) 可用  → Keychain
 *   3. 其他                       → 加密文件
 *   4. 测试环境                   → 内存
 */

import { join } from "node:path";
import { createPassphraseProvider, FileSecretStore } from "./file-secret-store.js";
import { MacosKeychainSecretStore } from "./macos-keychain.js";
import { MemorySecretStore } from "./memory-secret-store.js";
import type { SecretStore } from "./secret-store.js";

export { createPassphraseProvider, FileSecretStore } from "./file-secret-store.js";
export { MacosKeychainSecretStore } from "./macos-keychain.js";
export { MemorySecretStore } from "./memory-secret-store.js";
export * from "./secret-store.js";

export const SECRETS_FILENAME = "secrets.enc";

export interface CreateSecretStoreOptions {
  dataDir: string;
  /** config.json 中的 secretBackend，null 表示自动。 */
  configured?: "keychain" | "file" | null;
  keychainService?: string;
  json: boolean;
  env?: NodeJS.ProcessEnv;
}

export async function createSecretStore(opts: CreateSecretStoreOptions): Promise<SecretStore> {
  const env = opts.env ?? process.env;
  const requested = env.ZMAIL_SECRET_BACKEND ?? opts.configured ?? null;

  if (requested === "memory") return new MemorySecretStore();

  if (requested === "file") {
    return new FileSecretStore(
      join(opts.dataDir, SECRETS_FILENAME),
      createPassphraseProvider({ json: opts.json, env }),
    );
  }

  const keychain = new MacosKeychainSecretStore(opts.keychainService);

  if (requested === "keychain") {
    // 显式要求 keychain 却不可用时必须报错，不能静默降级 ——
    // 用户以为凭据在钥匙串里，实际落到了文件，这是安全预期的错位
    if (!(await keychain.isAvailable())) {
      const { ErrorCode, ZmailError } = await import("../core/errors.js");
      throw new ZmailError(
        ErrorCode.SECRET_BACKEND_UNAVAILABLE,
        "显式指定了 keychain 后端，但当前平台不可用",
        {
          hint:
            process.platform === "darwin"
              ? "检查 /usr/bin/security 是否可执行"
              : `keychain 后端只支持 macOS，当前平台是 ${process.platform}。改用 file 后端。`,
        },
      );
    }
    return keychain;
  }

  // 自动选择
  if (await keychain.isAvailable()) return keychain;

  return new FileSecretStore(
    join(opts.dataDir, SECRETS_FILENAME),
    createPassphraseProvider({ json: opts.json, env }),
  );
}
