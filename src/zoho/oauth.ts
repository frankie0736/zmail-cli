/**
 * OAuth 2.0 Authorization Code Flow + 本地 Loopback 回调。实施计划 §10.2。
 *
 * Phase 0-1 实测：Loopback 可用，不需要降级到 Device Flow。
 *
 * 安全要求（全部在此实现）：
 *   - 只监听 127.0.0.1，不监听 0.0.0.0
 *   - 每次登录生成随机 state，回调强制校验（常量时间比较）
 *   - 授权码只使用一次
 *   - HTTP Server 在成功或超时后立即关闭
 *   - 浏览器打开失败时输出可复制的 URL
 *   - Access Token 不写入磁盘
 */

import { spawn } from "node:child_process";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { ErrorCode, ZmailError } from "../core/errors.js";
import { registerSecret } from "../output/redact.js";
import { parseZohoJson } from "./json.js";
import {
  oauthEndpoints,
  parseGrantedScopes,
  READ_SCOPES,
  type ZohoRegion,
} from "./region-resolver.js";

export const CALLBACK_PORT = 53682;
export const CALLBACK_PATH = "/oauth/callback";
export const REDIRECT_URI = `http://127.0.0.1:${CALLBACK_PORT}${CALLBACK_PATH}`;

export interface TokenResponse {
  accessToken: string;
  /** 刷新响应中**不包含**此字段（Phase 0-1 实测，见 §10.5）。 */
  refreshToken: string | null;
  expiresInSeconds: number;
  grantedScopes: string[];
  tokenType: string;
}

interface RawTokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  token_type?: string;
  error?: string;
  error_description?: string;
}

function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

function openBrowser(url: string): boolean {
  const [cmd, args] =
    process.platform === "darwin"
      ? ["open", [url]]
      : process.platform === "win32"
        ? ["cmd", ["/c", "start", "", url]]
        : ["xdg-open", [url]];
  try {
    spawn(cmd, args as string[], { stdio: "ignore", detached: true }).unref();
    return true;
  } catch {
    return false;
  }
}

const page = (title: string, body: string) =>
  `<!doctype html><meta charset="utf-8"><title>${title}</title>` +
  `<body style="font:16px/1.6 system-ui;padding:3rem;max-width:34rem;margin:auto">` +
  `<h2>${title}</h2><p>${body}</p></body>`;

export interface LoginOptions {
  clientId: string;
  clientSecret: string;
  region: ZohoRegion;
  scopes?: readonly string[];
  timeoutMs?: number;
  /** 进度输出，注入以便测试。 */
  onNotice?: (message: string) => void;
  /** 测试时禁止真的打开浏览器。 */
  openBrowserFn?: (url: string) => boolean;
}

export function buildAuthorizeUrl(opts: {
  clientId: string;
  region: ZohoRegion;
  scopes: readonly string[];
  state: string;
}): string {
  const url = new URL(oauthEndpoints(opts.region).authorize);
  url.searchParams.set("client_id", opts.clientId);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("redirect_uri", REDIRECT_URI);
  // 申请时用逗号分隔；注意响应里 Zoho 会用空格返回（§10.5）
  url.searchParams.set("scope", opts.scopes.join(","));
  url.searchParams.set("access_type", "offline");
  // 不加 prompt=consent 时，重复授权可能不再返回 refresh_token
  url.searchParams.set("prompt", "consent");
  url.searchParams.set("state", opts.state);
  return url.href;
}

/** 完整的 loopback 授权流程。 */
export async function loginWithLoopback(opts: LoginOptions): Promise<TokenResponse> {
  const {
    clientId,
    clientSecret,
    region,
    scopes = READ_SCOPES,
    timeoutMs = 180_000,
    onNotice = () => {},
    openBrowserFn = openBrowser,
  } = opts;

  const state = randomBytes(24).toString("base64url");
  const authUrl = buildAuthorizeUrl({ clientId, region, scopes, state });

  const code = await new Promise<string>((resolve, reject) => {
    let settled = false;
    const finish = (fn: (v: never) => void, arg: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // server.close() 只是停止接受新连接，它会**等待已有连接自然关闭**。
      // 浏览器默认 keep-alive，不会主动断开，于是授权成功后终端要干等几秒，
      // 而失败后立刻重试则会撞上 EADDRINUSE 永远登不上。
      // 必须显式掐断存量连接 —— 回调页已经发完，没有什么可等的。
      server.closeAllConnections();
      server.close(() => fn(arg as never));
    };

    const server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", `http://127.0.0.1:${CALLBACK_PORT}`);
      if (url.pathname !== CALLBACK_PATH) {
        res.writeHead(404).end();
        return;
      }

      const err = url.searchParams.get("error");
      const gotState = url.searchParams.get("state");
      const gotCode = url.searchParams.get("code");

      if (err) {
        res
          .writeHead(400, { "content-type": "text/html; charset=utf-8", connection: "close" })
          .end(page("授权被拒绝", `Zoho 返回：<code>${err}</code>。可以关闭此页。`));
        finish(reject, new ZmailError(ErrorCode.AUTH_REQUIRED, `授权被拒绝: ${err}`));
        return;
      }

      // state 校验必须发生在使用 code 之前
      if (!gotState || !safeEqual(gotState, state)) {
        res
          .writeHead(400, { "content-type": "text/html; charset=utf-8", connection: "close" })
          .end(page("state 校验失败", "请求可能被篡改，已中止。"));
        finish(
          reject,
          new ZmailError(ErrorCode.AUTH_REQUIRED, "OAuth state 校验失败，可能存在 CSRF"),
        );
        return;
      }

      if (!gotCode) {
        res
          .writeHead(400, { "content-type": "text/html; charset=utf-8", connection: "close" })
          .end(page("缺少 code", "回调中没有授权码。"));
        finish(reject, new ZmailError(ErrorCode.AUTH_REQUIRED, "OAuth 回调缺少 code"));
        return;
      }

      res
        .writeHead(200, { "content-type": "text/html; charset=utf-8", connection: "close" })
        .end(page("授权成功", "可以关闭此页，回到终端继续。"));
      finish(resolve as (v: never) => void, gotCode);
    });

    const timer = setTimeout(
      () =>
        finish(
          reject,
          new ZmailError(ErrorCode.AUTH_REQUIRED, `等待授权超时（${timeoutMs / 1000} 秒）`, {
            hint: "重新运行 zmail auth login",
          }),
        ),
      timeoutMs,
    );

    server.on("error", (e: NodeJS.ErrnoException) => {
      finish(
        reject,
        e.code === "EADDRINUSE"
          ? new ZmailError(ErrorCode.AUTH_REQUIRED, `端口 ${CALLBACK_PORT} 已被占用`, {
              hint: `检查是否有另一个 zmail auth login 在运行：lsof -i :${CALLBACK_PORT}`,
              cause: e,
            })
          : e,
      );
    });

    server.listen(CALLBACK_PORT, "127.0.0.1", () => {
      const opened = openBrowserFn(authUrl);
      onNotice(
        opened ? "已打开浏览器完成授权。若没弹出，请手动访问：" : "请在浏览器中打开以下地址：",
      );
      onNotice(`  ${authUrl}`);
      onNotice("等待授权中…（Ctrl+C 取消）");
    });
  });

  return exchangeCode({ clientId, clientSecret, region, code });
}

/** 用授权码换 token。授权码只能使用一次。 */
export async function exchangeCode(opts: {
  clientId: string;
  clientSecret: string;
  region: ZohoRegion;
  code: string;
}): Promise<TokenResponse> {
  return tokenRequest(oauthEndpoints(opts.region).token, {
    grant_type: "authorization_code",
    client_id: opts.clientId,
    client_secret: opts.clientSecret,
    redirect_uri: REDIRECT_URI,
    code: opts.code,
  });
}

/** 用 refresh token 换新的 access token。 */
export async function refreshAccessToken(opts: {
  clientId: string;
  clientSecret: string;
  region: ZohoRegion;
  refreshToken: string;
}): Promise<TokenResponse> {
  return tokenRequest(oauthEndpoints(opts.region).token, {
    grant_type: "refresh_token",
    client_id: opts.clientId,
    client_secret: opts.clientSecret,
    refresh_token: opts.refreshToken,
  });
}

/** 远程撤销 refresh token。 */
export async function revokeRefreshToken(opts: {
  region: ZohoRegion;
  refreshToken: string;
}): Promise<void> {
  const res = await fetch(oauthEndpoints(opts.region).revoke, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ token: opts.refreshToken }),
  });
  if (!res.ok) {
    throw new ZmailError(ErrorCode.ZOHO_API_ERROR, `撤销 token 失败 (HTTP ${res.status})`, {
      details: { status: res.status },
    });
  }
}

async function tokenRequest(url: string, params: Record<string, string>): Promise<TokenResponse> {
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(params),
    });
  } catch (err) {
    throw new ZmailError(ErrorCode.NETWORK_ERROR, "无法连接 Zoho 授权服务器", { cause: err });
  }

  const text = await res.text();
  const { value } = parseZohoJson<RawTokenResponse>(text, "Token 端点");

  // Zoho 会在 HTTP 200 下返回 { error: "..." }，不能只看状态码
  if (!res.ok || value.error) {
    const code = value.error ?? `http_${res.status}`;
    const isAuthFailure = /invalid_code|invalid_client|invalid_grant|unauthorized/i.test(code);
    throw new ZmailError(
      isAuthFailure ? ErrorCode.AUTH_REQUIRED : ErrorCode.ZOHO_API_ERROR,
      `Token 请求失败: ${code}${value.error_description ? ` — ${value.error_description}` : ""}`,
      {
        details: { zohoError: code, httpStatus: res.status },
        ...(isAuthFailure ? { hint: "重新运行 zmail auth login" } : {}),
      },
    );
  }

  if (!value.access_token) {
    throw new ZmailError(ErrorCode.ZOHO_API_ERROR, "Token 响应中缺少 access_token", {
      details: { keys: Object.keys(value) },
    });
  }

  // 登记到脱敏器：即使某处不慎把 token 拼进日志，也不会真的输出
  registerSecret(value.access_token);
  if (value.refresh_token) registerSecret(value.refresh_token);

  return {
    accessToken: value.access_token,
    // ⚠️ 刷新响应里没有这个字段，必须是 null 而不是 undefined —— 调用方据此判断是否写回
    refreshToken: value.refresh_token ?? null,
    expiresInSeconds: value.expires_in ?? 3600,
    grantedScopes: parseGrantedScopes(value.scope),
    tokenType: value.token_type ?? "Bearer",
  };
}
