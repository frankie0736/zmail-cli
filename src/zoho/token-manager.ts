/**
 * Access Token 生命周期管理。实施计划 §10.5。
 *
 * 铁律：
 *   - Access Token **只存在于进程内存**，绝不落盘
 *   - Refresh Token 只从 SecretStore 读写
 *   - 刷新响应不含 refresh_token 时，**不得**覆盖已存凭据
 */

import { ErrorCode, ZmailError } from "../core/errors.js";
import type { SecretStore } from "../secrets/secret-store.js";
import { refreshAccessToken, type TokenResponse } from "./oauth.js";
import type { ZohoRegion } from "./region-resolver.js";

/** 提前多少秒视为即将过期。留出余量，避免请求发出时刚好失效。 */
const EXPIRY_SKEW_SECONDS = 120;

interface CachedToken {
  accessToken: string;
  /** epoch 毫秒。仅内存，不落盘。 */
  expiresAt: number;
  grantedScopes: string[];
}

export interface TokenManagerOptions {
  profile: string;
  region: ZohoRegion;
  secrets: SecretStore;
  /** 注入以便测试，默认 Date.now。 */
  now?: () => number;
}

export class TokenManager {
  readonly #profile: string;
  readonly #region: ZohoRegion;
  readonly #secrets: SecretStore;
  readonly #now: () => number;
  #cached: CachedToken | undefined;
  /** 并发调用时共享同一次刷新，避免同时发起多个刷新请求。 */
  #inflight: Promise<CachedToken> | undefined;

  constructor(opts: TokenManagerOptions) {
    this.#profile = opts.profile;
    this.#region = opts.region;
    this.#secrets = opts.secrets;
    this.#now = opts.now ?? Date.now;
  }

  /** 取一个当前有效的 access token，必要时自动刷新。 */
  async getAccessToken(): Promise<string> {
    if (this.#cached && this.#now() < this.#cached.expiresAt) {
      return this.#cached.accessToken;
    }
    const fresh = await this.#refresh();
    return fresh.accessToken;
  }

  /** 强制刷新，忽略缓存。用于 401 之后的重试（§14.5）。 */
  async forceRefresh(): Promise<string> {
    this.#cached = undefined;
    const fresh = await this.#refresh();
    return fresh.accessToken;
  }

  /** 本次进程内已知的授予 scope。尚未刷新过时为 null。 */
  get grantedScopes(): string[] | null {
    return this.#cached?.grantedScopes ?? null;
  }

  async #refresh(): Promise<CachedToken> {
    // 多个并发请求同时发现 token 过期时，只发一次刷新
    if (this.#inflight) return this.#inflight;

    this.#inflight = this.#doRefresh().finally(() => {
      this.#inflight = undefined;
    });
    return this.#inflight;
  }

  async #doRefresh(): Promise<CachedToken> {
    const [clientId, clientSecret, refreshToken] = await Promise.all([
      this.#secrets.get(this.#profile, "client-id"),
      this.#secrets.get(this.#profile, "client-secret"),
      this.#secrets.get(this.#profile, "refresh-token"),
    ]);

    if (!clientId || !clientSecret) {
      throw new ZmailError(
        ErrorCode.AUTH_REQUIRED,
        `profile "${this.#profile}" 尚未配置 OAuth 客户端`,
        {
          hint: "运行 zmail auth setup",
        },
      );
    }
    if (!refreshToken) {
      throw new ZmailError(ErrorCode.AUTH_REQUIRED, `profile "${this.#profile}" 尚未授权`, {
        hint: "运行 zmail auth login",
      });
    }

    const resp = await refreshAccessToken({
      clientId,
      clientSecret,
      region: this.#region,
      refreshToken,
    });

    await persistRefreshToken(this.#secrets, this.#profile, resp);

    const cached: CachedToken = {
      accessToken: resp.accessToken,
      expiresAt: this.#now() + (resp.expiresInSeconds - EXPIRY_SKEW_SECONDS) * 1000,
      grantedScopes: resp.grantedScopes,
    };
    this.#cached = cached;
    return cached;
  }
}

/**
 * 写回 refresh token —— **只在响应确实带了新值时**。
 *
 * Phase 0-1 实测：Zoho 的刷新响应**不包含** refresh_token。
 * 无条件写回会把已存凭据覆盖成空，症状是「昨天还好好的，今天要求重新授权」，
 * 而且只在刷新过至少一次之后才出现，极难排查。
 *
 * 独立成函数是为了能被单独测试 —— 这是整个鉴权链路里最容易写错的一行。
 */
export async function persistRefreshToken(
  secrets: SecretStore,
  profile: string,
  resp: Pick<TokenResponse, "refreshToken">,
): Promise<boolean> {
  if (!resp.refreshToken) return false;
  await secrets.set(profile, "refresh-token", resp.refreshToken);
  return true;
}
