/**
 * 凭据存储的统一接口。实施计划 §9.3。
 *
 * 存在三个实现：
 *   MacosKeychainSecretStore  macOS 默认，走系统钥匙串
 *   FileSecretStore           跨平台兜底，scrypt + AES-256-GCM
 *   MemorySecretStore         测试专用，绝不碰真实钥匙串
 */

/** 允许存储的凭据种类。Access Token **不在**其中 —— 它只存在于进程内存。 */
export const SECRET_KEYS = ["client-id", "client-secret", "refresh-token"] as const;
export type SecretKey = (typeof SECRET_KEYS)[number];

export type SecretBackendKind = "keychain" | "file" | "memory";

/** 后端的安全等级，doctor 必须如实报告（§9.5.4）。 */
export type SecurityLevel = "os-keystore" | "encrypted-file" | "memory-only";

export interface SecretBackendInfo {
  backend: SecretBackendKind;
  securityLevel: SecurityLevel;
  /** 面向人的位置描述。不含任何凭据。 */
  location: string;
  /** 与 OS 钥匙串的差距说明。非钥匙串后端必须有。 */
  warning?: string;
}

export interface SecretStore {
  readonly info: SecretBackendInfo;
  get(profile: string, key: SecretKey): Promise<string | null>;
  set(profile: string, key: SecretKey, value: string): Promise<void>;
  delete(profile: string, key: SecretKey): Promise<void>;
  list(profile: string): Promise<SecretKey[]>;
  /** 后端当前是否真的可用（钥匙串被锁、口令缺失等）。 */
  isAvailable(): Promise<boolean>;
}

/** Keychain 中的 account 字段：`<profile>:<key>`（§9.1）。 */
export const accountName = (profile: string, key: SecretKey): string => `${profile}:${key}`;

const PROFILE_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/i;

/**
 * 校验 profile 名。
 *
 * profile 名会进入 Keychain account 字段和文件路径，必须拒绝
 * 冒号（破坏 `<profile>:<key>` 解析）、路径分隔符和控制字符。
 */
export function assertValidProfile(profile: string): void {
  if (!PROFILE_PATTERN.test(profile)) {
    throw new Error(
      `非法的 profile 名 "${profile}"：只允许字母、数字、点、下划线和连字符，最长 64 字符`,
    );
  }
}
