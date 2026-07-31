/**
 * Zoho OAuth 2.0 —— Authorization Code Flow + 本地 Loopback 回调。
 *
 * 实施计划 §10.2 的安全要求全部在此实现：
 *   - 只监听 127.0.0.1，不监听 0.0.0.0
 *   - 每次登录生成随机 state，回调强制校验
 *   - 授权码只用一次
 *   - HTTP Server 在成功或超时后立即关闭
 *   - 浏览器打开失败时输出可复制的 URL
 *   - Access Token 不落盘
 */

import { createServer } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { spawn } from "node:child_process";
import { parsePreservingBigInts } from "./json-safe.mjs";

export const CALLBACK_PORT = 53682;
export const CALLBACK_PATH = "/oauth/callback";
export const REDIRECT_URI = `http://127.0.0.1:${CALLBACK_PORT}${CALLBACK_PATH}`;

/** 只读 scope（实施计划 §10.1 第一阶段） */
export const READ_SCOPES = [
  "ZohoMail.accounts.READ",
  "ZohoMail.folders.READ",
  "ZohoMail.messages.READ",
];

/**
 * Zoho 数据中心 → 域名。实施计划 §10.4 要求集中解析，禁止散落硬编码。
 * spike 阶段先覆盖已知区域，正式版进 ZohoRegionResolver。
 */
export const REGIONS = {
  com: { accounts: "https://accounts.zoho.com", mail: "https://mail.zoho.com", imap: "imap.zoho.com" },
  eu: { accounts: "https://accounts.zoho.eu", mail: "https://mail.zoho.eu", imap: "imap.zoho.eu" },
  in: { accounts: "https://accounts.zoho.in", mail: "https://mail.zoho.in", imap: "imap.zoho.in" },
  "com.cn": { accounts: "https://accounts.zoho.com.cn", mail: "https://mail.zoho.com.cn", imap: "imap.zoho.com.cn" },
  "com.au": { accounts: "https://accounts.zoho.com.au", mail: "https://mail.zoho.com.au", imap: "imap.zoho.com.au" },
  jp: { accounts: "https://accounts.zoho.jp", mail: "https://mail.zoho.jp", imap: "imap.zoho.jp" },
};

export function resolveRegion(location = "com") {
  const r = REGIONS[location];
  if (!r) {
    throw new Error(`未知的 Zoho 数据中心 "${location}"。已知：${Object.keys(REGIONS).join(", ")}`);
  }
  return r;
}

function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

function openBrowser(url) {
  const cmd = process.platform === "darwin" ? "open"
    : process.platform === "win32" ? "cmd"
    : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  try {
    spawn(cmd, args, { stdio: "ignore", detached: true }).unref();
    return true;
  } catch {
    return false;
  }
}

const PAGE = (title, body) =>
  `<!doctype html><meta charset="utf-8"><title>${title}</title>` +
  `<body style="font:16px/1.6 system-ui;padding:3rem;max-width:34rem;margin:auto">` +
  `<h2>${title}</h2><p>${body}</p></body>`;

/**
 * 走完整的 loopback 授权流程，返回 token 响应。
 *
 * @param {{clientId: string, clientSecret: string, location?: string, scopes?: string[], timeoutMs?: number}} opts
 */
export async function loginWithLoopback(opts) {
  const { clientId, clientSecret, location = "com", scopes = READ_SCOPES, timeoutMs = 180_000 } = opts;
  const region = resolveRegion(location);
  const state = randomBytes(24).toString("base64url");

  const authUrl = new URL(`${region.accounts}/oauth/v2/auth`);
  authUrl.searchParams.set("client_id", clientId);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("redirect_uri", REDIRECT_URI);
  authUrl.searchParams.set("scope", scopes.join(","));
  authUrl.searchParams.set("access_type", "offline");
  authUrl.searchParams.set("prompt", "consent"); // 强制每次返回 refresh_token
  authUrl.searchParams.set("state", state);

  const code = await new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn, arg) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      server.close(() => fn(arg));
    };

    const server = createServer((req, res) => {
      const url = new URL(req.url, `http://127.0.0.1:${CALLBACK_PORT}`);
      if (url.pathname !== CALLBACK_PATH) {
        res.writeHead(404).end();
        return;
      }
      const err = url.searchParams.get("error");
      const gotState = url.searchParams.get("state");
      const gotCode = url.searchParams.get("code");

      if (err) {
        res.writeHead(400, { "content-type": "text/html; charset=utf-8" })
          .end(PAGE("授权被拒绝", `Zoho 返回：<code>${err}</code>。可以关闭此页。`));
        return finish(reject, new Error(`授权被拒绝: ${err}`));
      }
      // state 校验必须在使用 code 之前
      if (!gotState || !safeEqual(gotState, state)) {
        res.writeHead(400, { "content-type": "text/html; charset=utf-8" })
          .end(PAGE("state 校验失败", "请求可能被篡改，已中止。"));
        return finish(reject, new Error("state 校验失败，可能存在 CSRF"));
      }
      if (!gotCode) {
        res.writeHead(400, { "content-type": "text/html; charset=utf-8" })
          .end(PAGE("缺少 code", "回调中没有授权码。"));
        return finish(reject, new Error("回调缺少 code"));
      }

      res.writeHead(200, { "content-type": "text/html; charset=utf-8" })
        .end(PAGE("授权成功", "可以关闭此页，回到终端继续。"));
      finish(resolve, gotCode);
    });

    const timer = setTimeout(
      () => finish(reject, new Error(`等待授权超时（${timeoutMs / 1000}s）`)),
      timeoutMs,
    );

    server.on("error", (e) => finish(reject, e));
    // 只绑 127.0.0.1
    server.listen(CALLBACK_PORT, "127.0.0.1", () => {
      console.log(`\n本地回调服务已启动: ${REDIRECT_URI}`);
      const opened = openBrowser(authUrl.href);
      console.log(opened ? "\n已尝试打开浏览器。若没弹出，请手动访问：" : "\n无法自动打开浏览器，请手动访问：");
      console.log(`\n  ${authUrl.href}\n`);
      console.log("等待授权中…（Ctrl+C 取消）\n");
    });
  });

  return exchangeCode({ clientId, clientSecret, code, location });
}

/** 用授权码换 token。授权码只能用一次。 */
export async function exchangeCode({ clientId, clientSecret, code, location = "com" }) {
  const region = resolveRegion(location);
  return tokenRequest(`${region.accounts}/oauth/v2/token`, {
    grant_type: "authorization_code",
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: REDIRECT_URI,
    code,
  });
}

/** 用 refresh token 换新的 access token。 */
export async function refreshAccessToken({ clientId, clientSecret, refreshToken, location = "com" }) {
  const region = resolveRegion(location);
  return tokenRequest(`${region.accounts}/oauth/v2/token`, {
    grant_type: "refresh_token",
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: refreshToken,
  });
}

async function tokenRequest(url, params) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params),
  });
  const text = await res.text();

  let parsed;
  try {
    parsed = parsePreservingBigInts(text).value;
  } catch {
    throw new Error(`Token 端点返回了非 JSON 响应 (HTTP ${res.status}): ${text.slice(0, 200)}`);
  }

  // Zoho 在 HTTP 200 下也可能返回 { error: "invalid_code" }
  if (!res.ok || parsed?.error) {
    throw new Error(
      `Token 请求失败 (HTTP ${res.status}): ${parsed?.error ?? "unknown"}` +
      (parsed?.error_description ? ` — ${parsed.error_description}` : ""),
    );
  }
  return parsed;
}
