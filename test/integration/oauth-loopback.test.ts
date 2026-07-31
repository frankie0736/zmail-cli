/**
 * OAuth loopback 端到端测试。
 *
 * 覆盖 `zmail auth login` 的完整链路，唯一被替换掉的是「人在浏览器里点同意」
 * 这一步 —— 那部分已在 Phase 0-1 用真实 Zoho 账号验证过（见
 * docs/phase-0-findings.md），且回调地址与 state 校验逻辑与此处一致。
 *
 * 用假浏览器而不是真人操作，好处是这条路径能进 CI 永久守着：
 * 回调服务器绑定、state 校验、授权码交换、refresh token 落库、账户发现，
 * 任何一环回归都会立刻失败。
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ErrorCode } from "../../src/core/errors.js";
import { MemorySecretStore } from "../../src/secrets/memory-secret-store.js";
import { discoverAccount, ZohoClient } from "../../src/zoho/client.js";
import {
  CALLBACK_PORT,
  loginWithLoopback,
  REDIRECT_URI,
  revokeRefreshToken,
} from "../../src/zoho/oauth.js";
import { persistRefreshToken, TokenManager } from "../../src/zoho/token-manager.js";
import {
  MOCK_ACCOUNT_ID,
  MOCK_CLIENT_ID,
  MOCK_CLIENT_SECRET,
  MOCK_EMAIL,
  MOCK_REFRESH_TOKEN,
  MockZohoServer,
} from "./mock-zoho-server.js";

let server: MockZohoServer;

beforeEach(async () => {
  server = new MockZohoServer({ messageCount: 5 });
  await server.start();
});
afterEach(() => server.stop());

/**
 * 假浏览器：拿到授权 URL 后立刻回调本地服务器。
 * 这就是真人点「同意」之后 Zoho 会做的事。
 */
function fakeBrowser(opts: { code?: string; tamperState?: boolean; error?: string } = {}) {
  return (authUrl: string): boolean => {
    const state = new URL(authUrl).searchParams.get("state") ?? "";
    const params = new URLSearchParams();
    if (opts.error) {
      params.set("error", opts.error);
    } else {
      params.set("code", opts.code ?? "MOCK_AUTH_CODE");
    }
    params.set("state", opts.tamperState ? "TAMPERED" : state);

    // 稍等一拍，确保 listen 回调已经跑完
    setTimeout(() => {
      void fetch(`${REDIRECT_URI}?${params.toString()}`).catch(() => {});
    }, 10);
    return true;
  };
}

const loginOpts = (browser: (url: string) => boolean) => ({
  clientId: MOCK_CLIENT_ID,
  clientSecret: MOCK_CLIENT_SECRET,
  region: server.region,
  timeoutMs: 5000,
  openBrowserFn: browser,
  onNotice: () => {},
});

describe("loopback 授权成功路径", () => {
  it("完成授权并拿到 refresh token", async () => {
    const tokens = await loginWithLoopback(loginOpts(fakeBrowser()));
    expect(tokens.accessToken).toBeTruthy();
    expect(tokens.refreshToken).toBe(MOCK_REFRESH_TOKEN);
    expect(tokens.grantedScopes).toContain("ZohoMail.messages.READ");
  });

  it("授权后完整链路：存凭据 → 发现账户 → 可用", async () => {
    const secrets = new MemorySecretStore();
    await secrets.set("primary", "client-id", MOCK_CLIENT_ID);
    await secrets.set("primary", "client-secret", MOCK_CLIENT_SECRET);

    const tokens = await loginWithLoopback(loginOpts(fakeBrowser()));
    const wrote = await persistRefreshToken(secrets, "primary", tokens);
    expect(wrote).toBe(true);

    // 这一步是 auth login 真正验证「凭据可用」的地方
    const manager = new TokenManager({ profile: "primary", region: server.region, secrets });
    const account = await discoverAccount(
      new ZohoClient({ region: server.region, tokens: manager }),
    );

    expect(account.accountId).toBe(MOCK_ACCOUNT_ID);
    expect(account.primaryEmail).toBe(MOCK_EMAIL);
    expect(account.identities.length).toBeGreaterThan(0);
  });

  it("回调端口在流程结束后被释放", async () => {
    await loginWithLoopback(loginOpts(fakeBrowser()));
    // 端口没释放的话，第二次登录会 EADDRINUSE
    const second = await loginWithLoopback(loginOpts(fakeBrowser()));
    expect(second.accessToken).toBeTruthy();
  });

  it("授权 URL 只指向 127.0.0.1", async () => {
    let captured = "";
    await loginWithLoopback(
      loginOpts((url) => {
        captured = url;
        return fakeBrowser()(url);
      }),
    );
    const redirect = new URL(captured).searchParams.get("redirect_uri") ?? "";
    expect(redirect).toContain("127.0.0.1");
    expect(redirect).not.toContain("0.0.0.0");
    expect(redirect).not.toContain("localhost");
    expect(new URL(redirect).port).toBe(String(CALLBACK_PORT));
  });
});

describe("loopback 失败路径", () => {
  it("state 被篡改时拒绝并抛 AUTH_REQUIRED", async () => {
    // 这是 CSRF 防护的核心断言：即使带着合法的 code，state 对不上也必须拒绝
    await expect(
      loginWithLoopback(loginOpts(fakeBrowser({ tamperState: true }))),
    ).rejects.toMatchObject({ code: ErrorCode.AUTH_REQUIRED });
  });

  it("用户拒绝授权时给出明确错误", async () => {
    await expect(
      loginWithLoopback(loginOpts(fakeBrowser({ error: "access_denied" }))),
    ).rejects.toMatchObject({ code: ErrorCode.AUTH_REQUIRED });
  });

  it("无效授权码被识别为鉴权失败而非 API 错误", async () => {
    await expect(
      loginWithLoopback(loginOpts(fakeBrowser({ code: "WRONG_CODE" }))),
    ).rejects.toMatchObject({ code: ErrorCode.AUTH_REQUIRED });
  });

  it("等待超时后不挂起", async () => {
    await expect(
      loginWithLoopback({
        ...loginOpts(() => true), // 浏览器「打开」了但从不回调
        timeoutMs: 300,
      }),
    ).rejects.toMatchObject({ code: ErrorCode.AUTH_REQUIRED });
  });

  it("失败之后端口仍然被释放，可以立刻重试", async () => {
    await expect(
      loginWithLoopback(loginOpts(fakeBrowser({ tamperState: true }))),
    ).rejects.toThrow();
    // 失败路径若不关服务器，用户重试时会撞上 EADDRINUSE 而永远登不上
    const retry = await loginWithLoopback(loginOpts(fakeBrowser()));
    expect(retry.refreshToken).toBe(MOCK_REFRESH_TOKEN);
  });

  it("端口被占用时给出可操作的提示", async () => {
    const blocker = await loginWithLoopback(loginOpts(fakeBrowser()));
    expect(blocker.accessToken).toBeTruthy();

    // 手工占住端口，模拟另一个 zmail auth login 正在运行
    const { createServer } = await import("node:http");
    const squatter = createServer(() => {});
    await new Promise<void>((r) => squatter.listen(CALLBACK_PORT, "127.0.0.1", r));
    try {
      await expect(loginWithLoopback(loginOpts(fakeBrowser()))).rejects.toMatchObject({
        code: ErrorCode.AUTH_REQUIRED,
      });
    } finally {
      await new Promise<void>((r) => squatter.close(() => r()));
    }
  });
});

describe("revoke", () => {
  it("远程撤销成功返回", async () => {
    await expect(
      revokeRefreshToken({ region: server.region, refreshToken: MOCK_REFRESH_TOKEN }),
    ).resolves.toBeUndefined();
  });
});
