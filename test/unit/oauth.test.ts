/**
 * OAuth 与 TokenManager 测试。实施计划 §10.5 / §22.1。
 *
 * 重点是那条最容易写错的规则：刷新响应不含 refresh_token 时不得覆盖已存凭据。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ErrorCode } from "../../src/core/errors.js";
import { MemorySecretStore } from "../../src/secrets/memory-secret-store.js";
import { normalizeAccount } from "../../src/zoho/client.js";
import { normalizeNullish, parsePreservingBigInts, toOpaqueId } from "../../src/zoho/json.js";
import { buildAuthorizeUrl, REDIRECT_URI, refreshAccessToken } from "../../src/zoho/oauth.js";
import {
  hasRequiredScopes,
  isKnownZohoHost,
  parseGrantedScopes,
  READ_SCOPES,
  resolveRegion,
} from "../../src/zoho/region-resolver.js";
import { persistRefreshToken, TokenManager } from "../../src/zoho/token-manager.js";

const region = resolveRegion("com");

describe("保精度 JSON 解析", () => {
  it("超出 2^53 的裸数字被保留为原始字面量", () => {
    const { value, lossy } = parsePreservingBigInts<{ verifyCode: string }>(
      '{"verifyCode":200193088841352729}',
    );
    expect(value.verifyCode).toBe("200193088841352729");
    expect(lossy).toHaveLength(1);
  });

  it("安全范围内的数字保持为 number", () => {
    // 无差别字符串化会把 expires_in / size 这类真正的数值也毁掉
    const { value, lossy } = parsePreservingBigInts<{ zuid: number; expiresIn: number }>(
      '{"zuid":809451734,"expiresIn":3600}',
    );
    expect(value.zuid).toBe(809451734);
    expect(typeof value.expiresIn).toBe("number");
    expect(lossy).toHaveLength(0);
  });

  it("已加引号的 ID 原样保留", () => {
    const { value } = parsePreservingBigInts<{ accountId: string }>(
      '{"accountId":"4001234000000009007"}',
    );
    expect(value.accountId).toBe("4001234000000009007");
  });

  it("浮点数不受影响", () => {
    const { value } = parsePreservingBigInts<{ x: number }>('{"x":1.5}');
    expect(value.x).toBe(1.5);
  });
});

describe("toOpaqueId", () => {
  it("字符串与安全数字都能转", () => {
    expect(toOpaqueId("4001234000000009007", "accountId")).toBe("4001234000000009007");
    expect(toOpaqueId(12345, "folderId")).toBe("12345");
  });

  it("拒绝超出安全范围的数字 —— 那说明上游没走保精度解析", () => {
    // 用 Number() 构造而非写字面量：字面量本身在源码里就已经丢了精度，
    // 那会让「测试精度丢失」这件事本身变得可疑。
    const alreadyLossy = Number("200193088841352729");
    expect(Number.isSafeInteger(alreadyLossy)).toBe(false);
    expect(() => toOpaqueId(alreadyLossy, "verifyCode")).toThrowError(
      expect.objectContaining({ code: ErrorCode.ZOHO_API_ERROR }),
    );
  });
});

describe("normalizeNullish", () => {
  it.each([
    ['字符串字面量 "null"', "null", null],
    ["空字符串", "", null],
    ['"undefined"', "undefined", null],
    ["仅空白", "   ", null],
    ["正常值", "abc", "abc"],
    ["带空白的正常值", "  abc  ", "abc"],
  ])("%s → %s", (_desc, input, expected) => {
    expect(normalizeNullish(input)).toBe(expected);
  });

  it("Phase 0-6 实测的 signatureId 陷阱", () => {
    // 直接 `x == null` 会把字符串 "null" 当成合法 ID 使用
    const signatureId = "null";
    expect(signatureId == null).toBe(false);
    expect(normalizeNullish(signatureId)).toBeNull();
  });
});

describe("scope 解析", () => {
  it("按空格切分 —— Zoho 响应用空格，申请时用逗号", () => {
    expect(parseGrantedScopes("ZohoMail.accounts.READ ZohoMail.folders.READ")).toEqual([
      "ZohoMail.accounts.READ",
      "ZohoMail.folders.READ",
    ]);
  });

  it("逗号分隔也能处理", () => {
    expect(parseGrantedScopes("a,b")).toEqual(["a", "b"]);
  });

  it("空值返回空数组", () => {
    expect(parseGrantedScopes(null)).toEqual([]);
    expect(parseGrantedScopes("")).toEqual([]);
  });

  it("ALL 蕴含 READ", () => {
    expect(hasRequiredScopes(["ZohoMail.messages.ALL"], ["ZohoMail.messages.READ"])).toBe(true);
  });

  it("缺失的 scope 被识别", () => {
    expect(hasRequiredScopes(["ZohoMail.accounts.READ"], READ_SCOPES)).toBe(false);
  });
});

describe("Region Resolver", () => {
  it("已知数据中心", () => {
    expect(resolveRegion("eu").mailApiBaseUrl).toBe("https://mail.zoho.eu");
  });

  it("未知数据中心抛 CONFIG_INVALID", () => {
    expect(() => resolveRegion("nope" as never)).toThrowError(
      expect.objectContaining({ code: ErrorCode.CONFIG_INVALID }),
    );
  });

  it("只接受已知 Zoho 主机的 https URL", () => {
    expect(isKnownZohoHost("https://mail.zoho.com")).toBe(true);
    expect(isKnownZohoHost("http://mail.zoho.com")).toBe(false); // 非 https
    expect(isKnownZohoHost("https://evil.example.com")).toBe(false);
    expect(isKnownZohoHost("not-a-url")).toBe(false);
  });
});

describe("授权 URL", () => {
  const url = () =>
    new URL(buildAuthorizeUrl({ clientId: "cid", region, scopes: READ_SCOPES, state: "STATE123" }));

  it("只指向 127.0.0.1 的回调", () => {
    expect(url().searchParams.get("redirect_uri")).toBe(REDIRECT_URI);
    expect(REDIRECT_URI).toContain("127.0.0.1");
    expect(REDIRECT_URI).not.toContain("0.0.0.0");
  });

  it("scope 用逗号分隔", () => {
    expect(url().searchParams.get("scope")).toBe(READ_SCOPES.join(","));
  });

  it("带 access_type=offline 与 prompt=consent —— 否则可能拿不到 refresh token", () => {
    expect(url().searchParams.get("access_type")).toBe("offline");
    expect(url().searchParams.get("prompt")).toBe("consent");
  });

  it("携带 state", () => {
    expect(url().searchParams.get("state")).toBe("STATE123");
  });
});

// ---------------------------------------------------------------- 核心陷阱

describe("persistRefreshToken：刷新响应无 refresh_token 时不得覆盖", () => {
  let secrets: MemorySecretStore;

  beforeEach(async () => {
    secrets = new MemorySecretStore();
    await secrets.set("primary", "refresh-token", "ORIGINAL_REFRESH_TOKEN");
  });

  it("响应带新值时写回", async () => {
    const wrote = await persistRefreshToken(secrets, "primary", { refreshToken: "NEW_TOKEN" });
    expect(wrote).toBe(true);
    expect(await secrets.get("primary", "refresh-token")).toBe("NEW_TOKEN");
  });

  /**
   * 这是整个鉴权链路里最容易写错的一行。Zoho 的刷新响应**不含** refresh_token，
   * 无条件写回会把凭据抹成空，症状是「昨天还好好的，今天要重新授权」，
   * 且只在刷新过至少一次之后才出现。
   */
  it("响应为 null 时保持原值不动（Phase 0-1 实测的真实场景）", async () => {
    const wrote = await persistRefreshToken(secrets, "primary", { refreshToken: null });
    expect(wrote).toBe(false);
    expect(await secrets.get("primary", "refresh-token")).toBe("ORIGINAL_REFRESH_TOKEN");
  });
});

describe("TokenManager", () => {
  let secrets: MemorySecretStore;
  let fetchMock: ReturnType<typeof vi.fn>;

  const tokenBody = (over: Record<string, unknown> = {}) =>
    JSON.stringify({
      access_token: "AT_1",
      expires_in: 3600,
      scope: READ_SCOPES.join(" "),
      token_type: "Bearer",
      ...over,
    });

  beforeEach(async () => {
    secrets = new MemorySecretStore();
    await secrets.set("primary", "client-id", "cid");
    await secrets.set("primary", "client-secret", "csecret");
    await secrets.set("primary", "refresh-token", "RT_ORIGINAL");

    fetchMock = vi.fn(async () => new Response(tokenBody(), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => vi.unstubAllGlobals());

  it("首次调用触发刷新并返回 access token", async () => {
    const m = new TokenManager({ profile: "primary", region, secrets });
    expect(await m.getAccessToken()).toBe("AT_1");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("token 未过期时复用缓存，不重复请求", async () => {
    const m = new TokenManager({ profile: "primary", region, secrets });
    await m.getAccessToken();
    await m.getAccessToken();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("过期后自动刷新", async () => {
    let now = 1_000_000;
    const m = new TokenManager({ profile: "primary", region, secrets, now: () => now });
    await m.getAccessToken();
    now += 3600 * 1000; // 越过有效期
    await m.getAccessToken();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("提前 120 秒视为过期，留出请求发出的余量", async () => {
    let now = 1_000_000;
    const m = new TokenManager({ profile: "primary", region, secrets, now: () => now });
    await m.getAccessToken();
    now += (3600 - 130) * 1000; // 还剩 130 秒，未进入余量区
    await m.getAccessToken();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    now += 20 * 1000; // 还剩 110 秒，进入余量区
    await m.getAccessToken();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("并发调用共享同一次刷新", async () => {
    const m = new TokenManager({ profile: "primary", region, secrets });
    await Promise.all([m.getAccessToken(), m.getAccessToken(), m.getAccessToken()]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("刷新后 refresh token 未被抹掉", async () => {
    const m = new TokenManager({ profile: "primary", region, secrets });
    await m.getAccessToken();
    expect(await secrets.get("primary", "refresh-token")).toBe("RT_ORIGINAL");
  });

  it("响应确实带了新 refresh token 时会更新", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(tokenBody({ refresh_token: "RT_ROTATED" }), { status: 200 }),
    );
    const m = new TokenManager({ profile: "primary", region, secrets });
    await m.getAccessToken();
    expect(await secrets.get("primary", "refresh-token")).toBe("RT_ROTATED");
  });

  it("未配置客户端凭据时抛 AUTH_REQUIRED", async () => {
    const empty = new MemorySecretStore();
    const m = new TokenManager({ profile: "primary", region, secrets: empty });
    await expect(m.getAccessToken()).rejects.toMatchObject({ code: ErrorCode.AUTH_REQUIRED });
  });

  it("未授权（无 refresh token）时抛 AUTH_REQUIRED", async () => {
    await secrets.delete("primary", "refresh-token");
    const m = new TokenManager({ profile: "primary", region, secrets });
    await expect(m.getAccessToken()).rejects.toMatchObject({ code: ErrorCode.AUTH_REQUIRED });
  });

  it("refresh token 失效时抛 AUTH_REQUIRED 而非泛化的 API 错误", async () => {
    // Zoho 在 HTTP 200 下返回 { error: ... }
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: "invalid_code" }), { status: 200 }),
    );
    const m = new TokenManager({ profile: "primary", region, secrets });
    await expect(m.getAccessToken()).rejects.toMatchObject({ code: ErrorCode.AUTH_REQUIRED });
  });
});

describe("refreshAccessToken", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("缺少 refresh_token 的响应被映射为 null（而非 undefined）", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ access_token: "AT", expires_in: 3600 }), { status: 200 }),
      ),
    );
    const resp = await refreshAccessToken({
      clientId: "c",
      clientSecret: "s",
      region,
      refreshToken: "RT",
    });
    // null 是显式的「本次没有新值」，调用方据此判断是否写回
    expect(resp.refreshToken).toBeNull();
  });

  it("网络失败映射为 NETWORK_ERROR", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("fetch failed");
      }),
    );
    await expect(
      refreshAccessToken({ clientId: "c", clientSecret: "s", region, refreshToken: "RT" }),
    ).rejects.toMatchObject({ code: ErrorCode.NETWORK_ERROR });
  });
});

// ---------------------------------------------------------------- 账户归一化

describe("normalizeAccount（按 Phase 0-6 实测结构）", () => {
  const raw = {
    accountId: "4001234000000009007",
    primaryEmailAddress: "owner@example.com",
    displayName: "Mailbox Owner",
    accountName: "mockaccount",
    usedStorage: 1877,
    allowedStorage: 10485760,
    planStorage: 10,
    imapAccessEnabled: true,
    imapBlocked: false,
    emailAddress: [
      { mailId: "hi@example.org", isPrimary: false, isAlias: true, isConfirmed: true },
      { mailId: "owner@example.com", isPrimary: true, isAlias: false, isConfirmed: true },
    ],
    sendMailDetails: [
      {
        fromAddress: "hi@example.org",
        mode: "alias",
        sendMailId: "111",
        status: true,
        validated: false,
      },
      {
        fromAddress: "owner@example.com",
        mode: "mailbox",
        sendMailId: "222",
        status: true,
        validated: false,
      },
    ],
  };

  it("收件身份与发信身份合并到同一条记录", () => {
    const acct = normalizeAccount(raw);
    expect(acct.identities).toHaveLength(2);
    const alias = acct.identities.find((i) => i.address === "hi@example.org");
    expect(alias).toMatchObject({
      isReceive: true,
      isSend: true,
      isAlias: true,
      sendMode: "alias",
    });
  });

  it("保留实测存在的 mode='alias'", () => {
    const modes = normalizeAccount(raw).identities.map((i) => i.sendMode);
    expect(modes).toContain("alias");
    expect(modes).toContain("mailbox");
  });

  it("status 与 validated 分别保留 —— 实测二者不一致", () => {
    const acct = normalizeAccount(raw);
    const identity = acct.identities[0];
    expect(identity?.sendStatus).toBe(true);
    expect(identity?.sendValidated).toBe(false);
  });

  it("存储字段按 KB 语义命名，不做单位转换", () => {
    const acct = normalizeAccount(raw);
    expect(acct.usedStorageKb).toBe(1877);
    expect(acct.allowedStorageKb).toBe(10485760);
    // 10485760 KB = 10 GB，与 planStorage 一致
    expect(acct.allowedStorageKb).not.toBeNull();
    expect(Number(acct.allowedStorageKb) / 1024 / 1024).toBe(acct.planStorageGb);
  });

  it("地址大小写不同不会产生重复身份", () => {
    const acct = normalizeAccount({
      ...raw,
      sendMailDetails: [{ fromAddress: "OWNER@example.com", mode: "mailbox", status: true }],
    });
    expect(acct.identities).toHaveLength(2);
  });

  it("缺少主邮箱时抛错而不是产出半个账户", () => {
    expect(() => normalizeAccount({ accountId: "1" })).toThrowError(
      expect.objectContaining({ code: ErrorCode.ZOHO_API_ERROR }),
    );
  });
});
