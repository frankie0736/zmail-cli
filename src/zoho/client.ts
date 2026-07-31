/**
 * Zoho Mail API 客户端与账户/身份发现。
 *
 * Phase 0-6 已确认真实响应结构，这里的 schema 按实测编写，
 * 而不是按文档 —— 两者有出入的地方以实测为准。
 */

import { ErrorCode, ZmailError } from "../core/errors.js";
import { normalizeNullish, parseZohoJson, toOpaqueId } from "./json.js";
import type { ZohoRegion } from "./region-resolver.js";
import type { TokenManager } from "./token-manager.js";

/** Zoho 用自有的 Authorization 方案，不是 Bearer。 */
const authHeader = (token: string) => `Zoho-oauthtoken ${token}`;

export interface ApiResult<T> {
  status: number;
  ok: boolean;
  data: T;
  rawText: string;
  elapsedMs: number;
}

export interface ZohoClientOptions {
  region: ZohoRegion;
  tokens: TokenManager;
  onEvent?: (evt: string, fields: Record<string, unknown>) => void;
}

export class ZohoClient {
  readonly #region: ZohoRegion;
  readonly #tokens: TokenManager;
  readonly #onEvent: (evt: string, fields: Record<string, unknown>) => void;

  constructor(opts: ZohoClientOptions) {
    this.#region = opts.region;
    this.#tokens = opts.tokens;
    this.#onEvent = opts.onEvent ?? (() => {});
  }

  /**
   * 发起 API 请求。
   *
   * 401 时刷新一次 token 后重试；其余错误按 §14.5 的规则交给调用方处理。
   */
  async request<T = unknown>(
    path: string,
    opts: { query?: Record<string, string | number | undefined>; retryOn401?: boolean } = {},
  ): Promise<ApiResult<T>> {
    const { retryOn401 = true } = opts;

    const url = new URL(path, this.#region.mailApiBaseUrl);
    for (const [k, v] of Object.entries(opts.query ?? {})) {
      if (v !== undefined) url.searchParams.set(k, String(v));
    }

    const send = async (token: string) => {
      const startedAt = process.hrtime.bigint();
      let res: Response;
      try {
        res = await fetch(url.href, {
          headers: { authorization: authHeader(token), accept: "application/json" },
        });
      } catch (err) {
        throw new ZmailError(ErrorCode.NETWORK_ERROR, `请求 ${url.pathname} 失败`, { cause: err });
      }
      const rawText = await res.text();
      const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
      return { res, rawText, elapsedMs };
    };

    let token = await this.#tokens.getAccessToken();
    let { res, rawText, elapsedMs } = await send(token);

    if (res.status === 401 && retryOn401) {
      this.#onEvent("token_refresh", { reason: "http_401", path: url.pathname });
      token = await this.#tokens.forceRefresh();
      ({ res, rawText, elapsedMs } = await send(token));
    }

    // 边界 I/O 日志：不含 token、不含正文
    this.#onEvent("api_request", {
      path: url.pathname,
      status: res.status,
      elapsedMs: Math.round(elapsedMs),
      bytes: rawText.length,
    });

    if (res.status === 403) {
      throw new ZmailError(ErrorCode.INSUFFICIENT_SCOPE, `权限不足: ${url.pathname}`, {
        details: { path: url.pathname, status: 403 },
        hint: "重新运行 zmail auth login 以授予所需 scope",
      });
    }
    if (res.status === 429) {
      throw new ZmailError(ErrorCode.RATE_LIMITED, "触发 Zoho 限流", {
        details: { retryAfter: res.headers.get("retry-after") },
        retryable: true,
      });
    }
    if (!res.ok) {
      throw new ZmailError(ErrorCode.ZOHO_API_ERROR, `Zoho API 返回 HTTP ${res.status}`, {
        details: { path: url.pathname, status: res.status },
      });
    }

    const { value } = parseZohoJson<{ data?: T }>(rawText, url.pathname);
    return {
      status: res.status,
      ok: true,
      data: (value.data ?? value) as T,
      rawText,
      elapsedMs,
    };
  }
}

// ---------------------------------------------------------------- 账户与身份

export interface ZohoIdentity {
  address: string;
  displayName: string | null;
  isReceive: boolean;
  isPrimary: boolean;
  isAlias: boolean;
  isConfirmed: boolean;
  isSend: boolean;
  /** 'mailbox' | 'alias' | 'extfrom'（Phase 0-6 实测存在 'alias'）。 */
  sendMode: string | null;
  sendMailId: string | null;
  sendValidated: boolean;
  sendStatus: boolean;
}

export interface ZohoAccount {
  accountId: string;
  primaryEmail: string;
  displayName: string | null;
  accountName: string | null;
  /** ⚠️ 单位是 KB，不是字节（Phase 0-6 实测）。 */
  usedStorageKb: number | null;
  allowedStorageKb: number | null;
  planStorageGb: number | null;
  imapAccessEnabled: boolean | null;
  imapBlocked: boolean | null;
  identities: ZohoIdentity[];
}

interface RawEmailAddress {
  mailId?: string;
  isPrimary?: boolean;
  isAlias?: boolean;
  isConfirmed?: boolean;
}

interface RawSendMailDetail {
  fromAddress?: string;
  displayName?: string;
  mode?: string;
  sendMailId?: string | number;
  validated?: boolean;
  status?: boolean;
}

interface RawAccount {
  accountId?: string | number;
  primaryEmailAddress?: string;
  mailboxAddress?: string;
  displayName?: string;
  accountName?: string;
  usedStorage?: number;
  allowedStorage?: number;
  planStorage?: number;
  imapAccessEnabled?: boolean;
  imapBlocked?: boolean;
  emailAddress?: RawEmailAddress[];
  sendMailDetails?: RawSendMailDetail[];
}

/**
 * 把原始账户响应归一化。
 *
 * 收件身份与发信身份合并到一张身份表：同一地址可能两者皆是（§11.8）。
 */
export function normalizeAccount(raw: RawAccount): ZohoAccount {
  const accountId = toOpaqueId(raw.accountId, "accountId");
  const primaryEmail = normalizeNullish(raw.primaryEmailAddress ?? raw.mailboxAddress);
  if (!primaryEmail) {
    throw new ZmailError(ErrorCode.ZOHO_API_ERROR, "账户响应中缺少主邮箱地址", {
      details: { accountId },
    });
  }

  const byAddress = new Map<string, ZohoIdentity>();

  const upsert = (address: string): ZohoIdentity => {
    const key = address.toLowerCase();
    let entry = byAddress.get(key);
    if (!entry) {
      entry = {
        address,
        displayName: null,
        isReceive: false,
        isPrimary: false,
        isAlias: false,
        isConfirmed: false,
        isSend: false,
        sendMode: null,
        sendMailId: null,
        sendValidated: false,
        sendStatus: false,
      };
      byAddress.set(key, entry);
    }
    return entry;
  };

  for (const e of raw.emailAddress ?? []) {
    const address = normalizeNullish(e.mailId);
    if (!address) continue;
    const entry = upsert(address);
    entry.isReceive = true;
    entry.isPrimary = e.isPrimary === true;
    entry.isAlias = e.isAlias === true;
    entry.isConfirmed = e.isConfirmed === true;
  }

  for (const s of raw.sendMailDetails ?? []) {
    const address = normalizeNullish(s.fromAddress);
    if (!address) continue;
    const entry = upsert(address);
    entry.isSend = true;
    entry.sendMode = normalizeNullish(s.mode);
    entry.sendMailId = s.sendMailId === undefined ? null : toOpaqueId(s.sendMailId, "sendMailId");
    // 实测存在 status=true 而 validated=false，两者语义不同，都保留
    entry.sendValidated = s.validated === true;
    entry.sendStatus = s.status === true;
    entry.displayName ??= normalizeNullish(s.displayName);
  }

  return {
    accountId,
    primaryEmail,
    displayName: normalizeNullish(raw.displayName),
    accountName: normalizeNullish(raw.accountName),
    usedStorageKb: raw.usedStorage ?? null,
    allowedStorageKb: raw.allowedStorage ?? null,
    planStorageGb: raw.planStorage ?? null,
    imapAccessEnabled: raw.imapAccessEnabled ?? null,
    imapBlocked: raw.imapBlocked ?? null,
    identities: [...byAddress.values()],
  };
}

/** 列出账户并取第一个的详情。MVP 只支持单账户（§11.9）。 */
export async function discoverAccount(client: ZohoClient): Promise<ZohoAccount> {
  const list = await client.request<RawAccount[]>("/api/accounts");
  const accounts = Array.isArray(list.data) ? list.data : [];
  if (accounts.length === 0) {
    throw new ZmailError(ErrorCode.ZOHO_API_ERROR, "Zoho 未返回任何账户", {
      hint: "确认授权时包含了 ZohoMail.accounts.READ scope",
    });
  }

  const accountId = toOpaqueId(accounts[0]?.accountId, "accountId");
  const detail = await client.request<RawAccount>(`/api/accounts/${accountId}`);
  return normalizeAccount(detail.data);
}

export interface ZohoFolder {
  folderId: string;
  name: string;
  path: string | null;
  folderType: string | null;
  imapAccess: boolean | null;
}

/**
 * 列出文件夹。
 *
 * 注意：**响应不含 messageCount**（Phase 0-6 实测），
 * 因此无法据此显示「N / 总数」形式的同步进度。
 */
export async function listFolders(client: ZohoClient, accountId: string): Promise<ZohoFolder[]> {
  const res = await client.request<Array<Record<string, unknown>>>(
    `/api/accounts/${accountId}/folders`,
  );
  return (Array.isArray(res.data) ? res.data : []).map((f) => ({
    folderId: toOpaqueId(f.folderId, "folderId"),
    name: String(f.folderName ?? ""),
    path: normalizeNullish(f.path),
    folderType: normalizeNullish(f.folderType),
    imapAccess: typeof f.imapAccess === "boolean" ? f.imapAccess : null,
  }));
}
