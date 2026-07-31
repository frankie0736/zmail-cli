/**
 * 跨平台加密文件后端。实施计划 §9.5。
 *
 * 存在的意义：v1.0 只有 macOS Keychain，Linux / Windows 用户能装上但
 * 一到 auth setup 就 ENOENT 崩溃。这是开源项目不可接受的首次体验。
 *
 * 方案：
 *   KDF   scrypt(passphrase, salt, N=2^17, r=8, p=1) → 32 字节 key
 *   加密  AES-256-GCM，每条 secret 独立 12 字节 nonce
 *   认证  GCM tag，篡改直接拒绝解密
 *
 * 全部使用 node:crypto，不引入新依赖。
 *
 * 这**不**等价于系统钥匙串。强度取决于口令，doctor 必须如实报告（§9.5.4）。
 */

import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  type ScryptOptions,
  scrypt,
  timingSafeEqual,
} from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { writeFileAtomic } from "../config/store.js";
import { ErrorCode, ZmailError } from "../core/errors.js";
import {
  accountName,
  assertValidProfile,
  SECRET_KEYS,
  type SecretBackendInfo,
  type SecretKey,
  type SecretStore,
} from "./secret-store.js";

/**
 * promisify(scrypt) 会绑定到 3 参数的重载，拿不到 options。
 * 手写包装以便传 N / r / p / maxmem。
 */
function scryptAsync(
  password: string,
  salt: Buffer,
  keylen: number,
  options: ScryptOptions,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, keylen, options, (err, derivedKey) => {
      if (err) reject(err);
      else resolve(derivedKey);
    });
  });
}

const FILE_VERSION = 1;
const KDF = { algorithm: "scrypt", N: 1 << 17, r: 8, p: 1 } as const;
const KEY_BYTES = 32;
const SALT_BYTES = 16;
const NONCE_BYTES = 12;
/** scrypt N=2^17 需要约 128 MB，默认 maxmem 不够。 */
const SCRYPT_MAXMEM = 256 * 1024 * 1024;

interface Entry {
  nonce: string;
  ciphertext: string;
  tag: string;
}

interface SecretFile {
  version: number;
  kdf: { algorithm: string; N: number; r: number; p: number; salt: string };
  /** 口令校验器：用同一个 key 加密的固定串，用来区分「口令错」与「条目不存在」。 */
  verifier: Entry;
  entries: Record<string, Entry>;
}

const VERIFIER_PLAINTEXT = "zmail-passphrase-verifier-v1";

export type PassphraseProvider = () => Promise<string>;

export class FileSecretStore implements SecretStore {
  readonly #path: string;
  readonly #getPassphrase: PassphraseProvider;
  /** 单进程内只派生一次 key —— scrypt N=2^17 每次约 100ms，不能每读一条跑一遍。 */
  #cachedKey: Buffer | undefined;
  /** 新建文件时由 #deriveKey 生成，供 #createFile 固化进文件头。 */
  #saltForNewFile: Buffer | undefined;

  constructor(filePath: string, getPassphrase: PassphraseProvider) {
    this.#path = filePath;
    this.#getPassphrase = getPassphrase;
  }

  get info(): SecretBackendInfo {
    return {
      backend: "file",
      securityLevel: "encrypted-file",
      location: this.#path,
      warning: "凭据由口令派生的密钥保护，而非操作系统钥匙串。安全强度取决于口令强度。",
    };
  }

  async isAvailable(): Promise<boolean> {
    if (!existsSync(this.#path)) return true; // 尚未创建，视为可用
    try {
      await this.#deriveKey();
      return true;
    } catch {
      return false;
    }
  }

  async get(profile: string, key: SecretKey): Promise<string | null> {
    assertValidProfile(profile);
    const file = this.#readFile();
    if (!file) return null;
    const entry = file.entries[accountName(profile, key)];
    if (!entry) return null;
    return this.#decrypt(await this.#deriveKey(), entry);
  }

  async set(profile: string, key: SecretKey, value: string): Promise<void> {
    assertValidProfile(profile);
    const derived = await this.#deriveKey();
    const file = this.#readFile() ?? this.#createFile(derived);
    file.entries[accountName(profile, key)] = this.#encrypt(derived, value);
    this.#writeFile(file);
  }

  async delete(profile: string, key: SecretKey): Promise<void> {
    assertValidProfile(profile);
    const file = this.#readFile();
    if (!file) return;
    delete file.entries[accountName(profile, key)];
    this.#writeFile(file);
  }

  async list(profile: string): Promise<SecretKey[]> {
    assertValidProfile(profile);
    const file = this.#readFile();
    if (!file) return [];
    return SECRET_KEYS.filter((k) => accountName(profile, k) in file.entries);
  }

  // ---- 内部 ----

  #readFile(): SecretFile | null {
    if (!existsSync(this.#path)) return null;
    try {
      const parsed = JSON.parse(readFileSync(this.#path, "utf8")) as SecretFile;
      if (parsed.version > FILE_VERSION) {
        throw new ZmailError(
          ErrorCode.SECRET_BACKEND_UNAVAILABLE,
          `凭据文件版本 ${parsed.version} 高于当前支持的 ${FILE_VERSION}`,
          { hint: "请升级 zmail-cli" },
        );
      }
      return parsed;
    } catch (err) {
      if (err instanceof ZmailError) throw err;
      throw new ZmailError(ErrorCode.SECRET_BACKEND_UNAVAILABLE, "凭据文件已损坏，无法解析", {
        cause: err,
        details: { path: this.#path },
        hint: "备份该文件后删除，然后重新执行 zmail auth setup",
      });
    }
  }

  #createFile(key: Buffer): SecretFile {
    // 新建时用刚派生的 key 生成校验器；salt 已在 deriveKey 中固化
    const salt = this.#saltForNewFile;
    if (!salt) throw new Error("内部错误：创建凭据文件前未派生 salt");
    return {
      version: FILE_VERSION,
      kdf: { ...KDF, salt: salt.toString("base64") },
      verifier: this.#encrypt(key, VERIFIER_PLAINTEXT),
      entries: {},
    };
  }

  #writeFile(file: SecretFile): void {
    writeFileAtomic(this.#path, `${JSON.stringify(file, null, 2)}\n`);
  }

  async #deriveKey(): Promise<Buffer> {
    if (this.#cachedKey) return this.#cachedKey;

    const file = this.#readFile();
    const salt = file ? Buffer.from(file.kdf.salt, "base64") : randomBytes(SALT_BYTES);
    if (!file) this.#saltForNewFile = salt;

    const passphrase = await this.#getPassphrase();
    if (!passphrase) {
      throw new ZmailError(ErrorCode.AUTH_PASSPHRASE_REQUIRED, "需要口令才能访问凭据文件", {
        hint: "设置环境变量 ZMAIL_PASSPHRASE，或在交互式终端中运行",
      });
    }

    const params = file ? file.kdf : KDF;
    const key = await scryptAsync(passphrase, salt, KEY_BYTES, {
      N: params.N,
      r: params.r,
      p: params.p,
      maxmem: SCRYPT_MAXMEM,
    });

    // 已有文件时校验口令是否正确 —— 否则错误口令会表现为「所有条目都不存在」，
    // 那是最难排查的一类故障
    if (file) {
      let ok = false;
      try {
        ok = this.#decrypt(key, file.verifier) === VERIFIER_PLAINTEXT;
      } catch {
        ok = false;
      }
      if (!ok) {
        throw new ZmailError(ErrorCode.SECRET_DECRYPT_FAILED, "口令错误，无法解密凭据文件", {
          hint: "检查 ZMAIL_PASSPHRASE 是否正确",
        });
      }
    }

    this.#cachedKey = key;
    return key;
  }

  #encrypt(key: Buffer, plaintext: string): Entry {
    const nonce = randomBytes(NONCE_BYTES);
    const cipher = createCipheriv("aes-256-gcm", key, nonce);
    const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    return {
      nonce: nonce.toString("base64"),
      ciphertext: ciphertext.toString("base64"),
      tag: cipher.getAuthTag().toString("base64"),
    };
  }

  #decrypt(key: Buffer, entry: Entry): string {
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(entry.nonce, "base64"));
    decipher.setAuthTag(Buffer.from(entry.tag, "base64"));
    try {
      return Buffer.concat([
        decipher.update(Buffer.from(entry.ciphertext, "base64")),
        decipher.final(),
      ]).toString("utf8");
    } catch (err) {
      // GCM 校验失败：口令错误或密文被篡改，两者不可区分，也不该区分
      throw new ZmailError(ErrorCode.SECRET_DECRYPT_FAILED, "凭据解密失败：口令错误或文件被篡改", {
        cause: err,
      });
    }
  }
}

/**
 * 口令来源（§9.5.3）：
 *   1. 环境变量 ZMAIL_PASSPHRASE（无人值守）
 *   2. 交互式 TTY 输入，不回显
 *   3. 都不可用 → AUTH_PASSPHRASE_REQUIRED
 *
 * `--json` 模式下**绝不**阻塞等待输入 —— Agent 无法回答口令提示。
 */
export function createPassphraseProvider(opts: {
  json: boolean;
  env?: NodeJS.ProcessEnv;
}): PassphraseProvider {
  const env = opts.env ?? process.env;
  return async () => {
    const fromEnv = env.ZMAIL_PASSPHRASE;
    if (fromEnv) return fromEnv;

    if (opts.json || !process.stdin.isTTY) {
      throw new ZmailError(ErrorCode.AUTH_PASSPHRASE_REQUIRED, "需要口令，但当前不是交互式终端", {
        hint: "设置环境变量 ZMAIL_PASSPHRASE 后重试",
        details: { reason: opts.json ? "json-mode" : "non-tty" },
      });
    }
    return promptHidden("凭据文件口令: ");
  };
}

/** 无回显读取一行。 */
function promptHidden(prompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    process.stderr.write(prompt);
    const stdin = process.stdin;
    const wasRaw = stdin.isRaw;
    stdin.setRawMode?.(true);
    stdin.resume();
    stdin.setEncoding("utf8");

    let buffer = "";
    const cleanup = () => {
      stdin.removeListener("data", onData);
      stdin.setRawMode?.(wasRaw ?? false);
      stdin.pause();
      process.stderr.write("\n");
    };

    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === "\n" || ch === "\r") {
          cleanup();
          resolve(buffer);
          return;
        }
        if (ch === "\u0003") {
          // Ctrl+C
          cleanup();
          reject(new ZmailError(ErrorCode.AUTH_PASSPHRASE_REQUIRED, "用户取消了口令输入"));
          return;
        }
        if (ch === "\u007f" || ch === "\b") {
          // Backspace / Delete
          buffer = buffer.slice(0, -1);
          continue;
        }
        buffer += ch;
      }
    };
    stdin.on("data", onData);
  });
}

/** 常量时间比较，供测试与校验使用。 */
export function constantTimeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}
