/**
 * 内存后端。测试专用 —— 保证测试**绝不**碰开发者的真实 Keychain（§9.3）。
 */

import {
  accountName,
  assertValidProfile,
  SECRET_KEYS,
  type SecretBackendInfo,
  type SecretKey,
  type SecretStore,
} from "./secret-store.js";

export class MemorySecretStore implements SecretStore {
  readonly #entries = new Map<string, string>();

  get info(): SecretBackendInfo {
    return {
      backend: "memory",
      securityLevel: "memory-only",
      location: "(进程内存)",
      warning: "凭据仅存在于内存中，进程退出即丢失。仅供测试使用。",
    };
  }

  async isAvailable(): Promise<boolean> {
    return true;
  }

  async get(profile: string, key: SecretKey): Promise<string | null> {
    assertValidProfile(profile);
    return this.#entries.get(accountName(profile, key)) ?? null;
  }

  async set(profile: string, key: SecretKey, value: string): Promise<void> {
    assertValidProfile(profile);
    this.#entries.set(accountName(profile, key), value);
  }

  async delete(profile: string, key: SecretKey): Promise<void> {
    assertValidProfile(profile);
    this.#entries.delete(accountName(profile, key));
  }

  async list(profile: string): Promise<SecretKey[]> {
    assertValidProfile(profile);
    return SECRET_KEYS.filter((k) => this.#entries.has(accountName(profile, k)));
  }
}
