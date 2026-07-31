/**
 * Zoho 数据中心解析。实施计划 §10.6。
 *
 * 域名解析集中在这里，禁止在代码各处写死 `accounts.zoho.com` / `mail.zoho.com`。
 */

import type { ZohoLocation } from "../config/schema.js";
import { ErrorCode, ZmailError } from "../core/errors.js";

export interface ZohoRegion {
  location: ZohoLocation;
  accountsBaseUrl: string;
  mailApiBaseUrl: string;
}

/**
 * 已知数据中心。
 *
 * 注意 IMAP 主机**不在此处** —— Phase 0-4 已实测确认 Zoho 不支持第三方
 * IMAP 的 XOAUTH2 认证（§4），本项目不走 IMAP。
 */
const REGIONS: Record<ZohoLocation, Omit<ZohoRegion, "location">> = {
  com: { accountsBaseUrl: "https://accounts.zoho.com", mailApiBaseUrl: "https://mail.zoho.com" },
  eu: { accountsBaseUrl: "https://accounts.zoho.eu", mailApiBaseUrl: "https://mail.zoho.eu" },
  in: { accountsBaseUrl: "https://accounts.zoho.in", mailApiBaseUrl: "https://mail.zoho.in" },
  "com.cn": {
    accountsBaseUrl: "https://accounts.zoho.com.cn",
    mailApiBaseUrl: "https://mail.zoho.com.cn",
  },
  "com.au": {
    accountsBaseUrl: "https://accounts.zoho.com.au",
    mailApiBaseUrl: "https://mail.zoho.com.au",
  },
  jp: { accountsBaseUrl: "https://accounts.zoho.jp", mailApiBaseUrl: "https://mail.zoho.jp" },
};

export const KNOWN_LOCATIONS = Object.keys(REGIONS) as ZohoLocation[];

export function resolveRegion(location: ZohoLocation): ZohoRegion {
  const region = REGIONS[location];
  if (!region) {
    throw new ZmailError(ErrorCode.CONFIG_INVALID, `未知的 Zoho 数据中心 "${location}"`, {
      details: { location, known: KNOWN_LOCATIONS },
      hint: `可用值: ${KNOWN_LOCATIONS.join(", ")}`,
    });
  }
  return { location, ...region };
}

/**
 * 判断某个 base URL 是否属于已知数据中心。
 *
 * config.json 中的 URL 可能被手工编辑过。授权前校验一次，
 * 避免把凭据发到任意主机。
 */
export function isKnownZohoHost(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== "https:") return false;
  return Object.values(REGIONS).some(
    (r) =>
      new URL(r.accountsBaseUrl).host === parsed.host ||
      new URL(r.mailApiBaseUrl).host === parsed.host,
  );
}

/**
 * OAuth 端点。集中构造，避免拼接散落。
 */
export const oauthEndpoints = (region: ZohoRegion) => ({
  authorize: `${region.accountsBaseUrl}/oauth/v2/auth`,
  token: `${region.accountsBaseUrl}/oauth/v2/token`,
  revoke: `${region.accountsBaseUrl}/oauth/v2/token/revoke`,
});

/**
 * 第一阶段只读 scope（§10.1）。
 *
 * Phase 0-1 实测：这三个足以列出账户、文件夹、邮件列表和正文。
 */
export const READ_SCOPES = [
  "ZohoMail.accounts.READ",
  "ZohoMail.folders.READ",
  "ZohoMail.messages.READ",
] as const;

/**
 * 解析 Zoho 返回的 scope 字符串。
 *
 * ⚠️ 申请时用**逗号**分隔，但响应里用**空格**分隔（Phase 0-1 实测）。
 * 按逗号切分会得到一个包含全部 scope 的单元素数组。
 */
export function parseGrantedScopes(scope: string | null | undefined): string[] {
  if (!scope) return [];
  return scope.split(/[\s,]+/).filter(Boolean);
}

/** 检查已授予的 scope 是否覆盖所需，用于调用前预判权限不足。 */
export function hasRequiredScopes(granted: string[], required: readonly string[]): boolean {
  const set = new Set(granted);
  return required.every((r) => {
    if (set.has(r)) return true;
    // ZohoMail.messages.ALL 蕴含 ZohoMail.messages.READ
    const all = r.replace(/\.(READ|CREATE|UPDATE|DELETE)$/, ".ALL");
    return set.has(all);
  });
}
