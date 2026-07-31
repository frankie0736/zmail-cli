/**
 * MockZohoServer 自身的测试。
 *
 * 这层测试容易被认为多余，其实不然：**一个错误的 mock 会让所有依赖它的测试
 * 变成假绿**。同步引擎的全部集成测试都建立在它忠实复现真实 API 之上，
 * 所以那些「反直觉但真实」的行为必须被钉死。
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MemorySecretStore } from "../../src/secrets/memory-secret-store.js";
import { discoverAccount, ZohoClient } from "../../src/zoho/client.js";
import { parsePreservingBigInts } from "../../src/zoho/json.js";
import { refreshAccessToken } from "../../src/zoho/oauth.js";
import { TokenManager } from "../../src/zoho/token-manager.js";
import {
  MOCK_ACCOUNT_ID,
  MOCK_CLIENT_ID,
  MOCK_CLIENT_SECRET,
  MOCK_REFRESH_TOKEN,
  MockZohoServer,
} from "./mock-zoho-server.js";

async function makeClient(server: MockZohoServer) {
  const secrets = new MemorySecretStore();
  await secrets.set("primary", "client-id", MOCK_CLIENT_ID);
  await secrets.set("primary", "client-secret", MOCK_CLIENT_SECRET);
  await secrets.set("primary", "refresh-token", MOCK_REFRESH_TOKEN);
  const tokens = new TokenManager({ profile: "primary", region: server.region, secrets });
  return { client: new ZohoClient({ region: server.region, tokens }), secrets, tokens };
}

describe("MockZohoServer 忠实度", () => {
  let server: MockZohoServer;

  beforeAll(async () => {
    server = new MockZohoServer({ messageCount: 250, pageLimit: 200 });
    await server.start();
  });
  afterAll(() => server.stop());

  it("OAuth 刷新**不返回** refresh_token —— 与 Zoho 实测一致", async () => {
    // 这是最关键的忠实度断言。如果 mock 返回了 refresh_token，
    // TokenManager 那个「不得覆盖」的 bug 在测试里永远暴露不出来。
    const resp = await refreshAccessToken({
      clientId: MOCK_CLIENT_ID,
      clientSecret: MOCK_CLIENT_SECRET,
      region: server.region,
      refreshToken: MOCK_REFRESH_TOKEN,
    });
    expect(resp.refreshToken).toBeNull();
    expect(resp.accessToken).toBeTruthy();
  });

  it("scope 用空格分隔，不是逗号", async () => {
    const resp = await refreshAccessToken({
      clientId: MOCK_CLIENT_ID,
      clientSecret: MOCK_CLIENT_SECRET,
      region: server.region,
      refreshToken: MOCK_REFRESH_TOKEN,
    });
    expect(resp.grantedScopes).toHaveLength(3);
    expect(resp.grantedScopes).toContain("ZohoMail.messages.READ");
  });

  it("无效 client 在 HTTP 200 下返回业务错误", async () => {
    const res = await fetch(`${server.baseUrl}/oauth/v2/token`, {
      method: "POST",
      body: new URLSearchParams({ client_id: "wrong", grant_type: "refresh_token" }),
    });
    expect(res.status).toBe(200); // 关键：不是 401
    expect(await res.json()).toMatchObject({ error: "invalid_client" });
  });

  it("accountId 超出 2^53 但加了引号，解析无精度损失", async () => {
    const { client } = await makeClient(server);
    const account = await discoverAccount(client);
    expect(account.accountId).toBe(MOCK_ACCOUNT_ID);
    expect(Number(MOCK_ACCOUNT_ID)).toBeGreaterThan(Number.MAX_SAFE_INTEGER);
  });

  it("messageId 超出 2^53，任何数值化都会暴露", async () => {
    const { client } = await makeClient(server);
    const res = await client.request<Array<{ messageId: string }>>(
      `/api/accounts/${MOCK_ACCOUNT_ID}/messages/view`,
      { query: { folderId: "1000000001", limit: 1, start: 1 } },
    );
    const id = res.data[0]?.messageId as string;
    expect(typeof id).toBe("string");
    expect(Number(id)).toBeGreaterThan(Number.MAX_SAFE_INTEGER);
    // 反向确认：若走了普通 JSON.parse 会损坏
    expect(String(Number(id))).not.toBe(id);
  });

  it("folders 端点不返回 messageCount", async () => {
    const { client } = await makeClient(server);
    const res = await client.request<Array<Record<string, unknown>>>(
      `/api/accounts/${MOCK_ACCOUNT_ID}/folders`,
    );
    // 同步进度不能依赖它 —— 真实 API 就是没有
    expect(res.data[0]).not.toHaveProperty("messageCount");
    expect(res.data[0]).toHaveProperty("folderName");
  });

  it("存储字段是 KB：allowedStorage / 1024 / 1024 == planStorage", async () => {
    const { client } = await makeClient(server);
    const account = await discoverAccount(client);
    expect(Number(account.allowedStorageKb) / 1024 / 1024).toBe(account.planStorageGb);
  });

  it("身份含 alias，且 status 与 validated 不一致", async () => {
    const { client } = await makeClient(server);
    const account = await discoverAccount(client);
    const alias = account.identities.find((i) => i.isAlias);
    expect(alias).toBeDefined();
    expect(account.identities.map((i) => i.sendMode)).toContain("alias");
    const sendable = account.identities.find((i) => i.isSend);
    expect(sendable?.sendStatus).toBe(true);
    expect(sendable?.sendValidated).toBe(false);
  });

  it('正文响应含字符串字面量 "null"', async () => {
    const { client } = await makeClient(server);
    const ids = server.listMessageIds("1000000001");
    const res = await client.request<Record<string, unknown>>(
      `/api/accounts/${MOCK_ACCOUNT_ID}/folders/1000000001/messages/${ids[0]}/content`,
    );
    expect(res.data.replyTo).toBe("null"); // 不是 JSON null
  });
});

describe("分页", () => {
  let server: MockZohoServer;
  beforeAll(async () => {
    server = new MockZohoServer({ messageCount: 250, pageLimit: 200 });
    await server.start();
  });
  afterAll(() => server.stop());

  it("服务端把超限的 limit 截断到分页上限", async () => {
    const { client } = await makeClient(server);
    const res = await client.request<unknown[]>(`/api/accounts/${MOCK_ACCOUNT_ID}/messages/view`, {
      query: { limit: 500, start: 1 },
    });
    expect(res.data).toHaveLength(200); // 不是 500
  });

  it("翻页能取完全部邮件且无重复无遗漏", async () => {
    const { client } = await makeClient(server);
    const seen = new Set<string>();
    let start = 1;
    for (;;) {
      const res = await client.request<Array<{ messageId: string }>>(
        `/api/accounts/${MOCK_ACCOUNT_ID}/messages/view`,
        { query: { limit: 100, start } },
      );
      if (res.data.length === 0) break;
      for (const m of res.data) seen.add(m.messageId);
      start += res.data.length;
    }
    expect(seen.size).toBe(server.messageCount);
  });

  it("按文件夹过滤", async () => {
    const { client } = await makeClient(server);
    const res = await client.request<Array<{ folderId: string }>>(
      `/api/accounts/${MOCK_ACCOUNT_ID}/messages/view`,
      { query: { folderId: "1000000001", limit: 200, start: 1 } },
    );
    expect(res.data.length).toBeGreaterThan(0);
    expect(res.data.every((m) => m.folderId === "1000000001")).toBe(true);
  });

  it("超出末尾返回空数组而不是报错", async () => {
    const { client } = await makeClient(server);
    const res = await client.request<unknown[]>(`/api/accounts/${MOCK_ACCOUNT_ID}/messages/view`, {
      query: { limit: 50, start: 99999 },
    });
    expect(res.data).toEqual([]);
  });
});

describe("故障注入", () => {
  it("401 后自动刷新 token 并重试成功", async () => {
    const server = new MockZohoServer({
      messageCount: 10,
      faults: { expireAccessTokenAfter: 2 },
    });
    await server.start();
    try {
      const { client } = await makeClient(server);
      await client.request(`/api/accounts/${MOCK_ACCOUNT_ID}/folders`);
      await client.request(`/api/accounts/${MOCK_ACCOUNT_ID}/folders`);
      // 第三次触发 401，客户端应刷新后重试
      const third = await client.request(`/api/accounts/${MOCK_ACCOUNT_ID}/folders`);
      expect(third.ok).toBe(true);
      expect(server.stats.tokenRefreshes).toBeGreaterThan(1);
    } finally {
      await server.stop();
    }
  });

  it("429 映射为 RATE_LIMITED 且 retryable", async () => {
    const server = new MockZohoServer({
      messageCount: 10,
      faults: { rateLimitEvery: 2, retryAfterSeconds: 3 },
    });
    await server.start();
    try {
      const { client } = await makeClient(server);
      await client.request(`/api/accounts/${MOCK_ACCOUNT_ID}/folders`); // 第 1 次通过
      await expect(
        client.request(`/api/accounts/${MOCK_ACCOUNT_ID}/folders`),
      ).rejects.toMatchObject({ code: "RATE_LIMITED", retryable: true });
    } finally {
      await server.stop();
    }
  });

  it("429 不带 Retry-After 时也能正确归类", async () => {
    const server = new MockZohoServer({
      messageCount: 10,
      faults: { rateLimitEvery: 1, retryAfterSeconds: null },
    });
    await server.start();
    try {
      const { client } = await makeClient(server);
      await expect(
        client.request(`/api/accounts/${MOCK_ACCOUNT_ID}/folders`),
      ).rejects.toMatchObject({ code: "RATE_LIMITED" });
    } finally {
      await server.stop();
    }
  });

  it("正文 404 单独报错，不影响其他邮件", async () => {
    const server = new MockZohoServer({ messageCount: 30 });
    await server.start();
    try {
      const { client } = await makeClient(server);
      const ids = server.listMessageIds("1000000001");
      const missing = "40012340000999999999";
      await expect(
        client.request(
          `/api/accounts/${MOCK_ACCOUNT_ID}/folders/1000000001/messages/${missing}/content`,
        ),
      ).rejects.toMatchObject({ code: "ZOHO_API_ERROR" });

      const ok = await client.request(
        `/api/accounts/${MOCK_ACCOUNT_ID}/folders/1000000001/messages/${ids[0]}/content`,
      );
      expect(ok.ok).toBe(true);
    } finally {
      await server.stop();
    }
  });

  it("非法 JSON 映射为 ZOHO_API_ERROR 而不是裸 SyntaxError", async () => {
    const server = new MockZohoServer({ messageCount: 10, faults: { malformedJsonEvery: 1 } });
    await server.start();
    try {
      const { client } = await makeClient(server);
      await expect(
        client.request(`/api/accounts/${MOCK_ACCOUNT_ID}/folders`),
      ).rejects.toMatchObject({ code: "ZOHO_API_ERROR" });
    } finally {
      await server.stop();
    }
  });

  it("500 映射为 ZOHO_API_ERROR", async () => {
    const server = new MockZohoServer({
      messageCount: 10,
      faults: { serverErrorOn: new Set([1]) },
    });
    await server.start();
    try {
      const { client } = await makeClient(server);
      await expect(
        client.request(`/api/accounts/${MOCK_ACCOUNT_ID}/folders`),
      ).rejects.toMatchObject({ code: "ZOHO_API_ERROR" });
    } finally {
      await server.stop();
    }
  });
});

describe("可变状态：模拟 WebMail 操作", () => {
  it("移动邮件后出现在新文件夹", async () => {
    const server = new MockZohoServer({ messageCount: 30 });
    await server.start();
    try {
      const { client } = await makeClient(server);
      const id = server.listMessageIds("1000000001")[0] as string;
      expect(server.moveMessage(id, "1000000006")).toBe(true);

      const res = await client.request<Array<{ messageId: string }>>(
        `/api/accounts/${MOCK_ACCOUNT_ID}/messages/view`,
        { query: { folderId: "1000000006", limit: 200, start: 1 } },
      );
      expect(res.data.map((m) => m.messageId)).toContain(id);
    } finally {
      await server.stop();
    }
  });

  it("删除邮件后从列表消失", async () => {
    const server = new MockZohoServer({ messageCount: 30 });
    await server.start();
    try {
      const before = server.messageCount;
      const id = server.listMessageIds()[0] as string;
      expect(server.deleteMessage(id)).toBe(true);
      expect(server.messageCount).toBe(before - 1);
      expect(server.listMessageIds()).not.toContain(id);
    } finally {
      await server.stop();
    }
  });
});

describe("ID 生成的有效性（mock 自身的正确性）", () => {
  it("生成的 messageId 必须真的会被 Number() 损坏", () => {
    // 若断言失败，说明 ID 尾数太圆整、能被 double 精确表示，
    // 那么所有「ID 不能当数字处理」的测试都会变成假绿。
    const server = new MockZohoServer({ messageCount: 20 });
    for (const id of server.listMessageIds()) {
      expect(Number(id)).toBeGreaterThan(Number.MAX_SAFE_INTEGER);
      expect(String(Number(id))).not.toBe(id);
    }
  });
});

describe("确定性", () => {
  it("同一种子生成同样的数据", async () => {
    const a = new MockZohoServer({ messageCount: 20, seed: 7 });
    const b = new MockZohoServer({ messageCount: 20, seed: 7 });
    expect(a.listMessageIds()).toEqual(b.listMessageIds());
  });

  it("生成的语料含中英文，能驱动 CJK 搜索路径", async () => {
    const server = new MockZohoServer({ messageCount: 60, seed: 1 });
    await server.start();
    try {
      const { client } = await makeClient(server);
      const res = await client.request<Array<{ subject: string; summary: string }>>(
        `/api/accounts/${MOCK_ACCOUNT_ID}/messages/view`,
        { query: { limit: 60, start: 1 } },
      );
      const all = res.data.map((m) => `${m.subject} ${m.summary}`).join(" ");
      expect(/[一-鿿]/.test(all)).toBe(true);
      expect(/[a-zA-Z]{4,}/.test(all)).toBe(true);
    } finally {
      await server.stop();
    }
  });
});

describe("统计", () => {
  it("记录调用次数，供「全量同步消耗多少次调用」的断言使用", async () => {
    const server = new MockZohoServer({ messageCount: 20 });
    await server.start();
    try {
      const { client } = await makeClient(server);
      server.resetStats();
      await client.request(`/api/accounts/${MOCK_ACCOUNT_ID}/folders`);
      await client.request(`/api/accounts/${MOCK_ACCOUNT_ID}/messages/view`, {
        query: { limit: 10, start: 1 },
      });
      expect(server.stats.totalRequests).toBe(2);
      expect(server.stats.byPath[`/api/accounts/${MOCK_ACCOUNT_ID}/folders`]).toBe(1);
    } finally {
      await server.stop();
    }
  });
});

describe("保精度解析在真实响应体上生效", () => {
  it("原始文本中的 19 位 messageId 未被损坏", async () => {
    const server = new MockZohoServer({ messageCount: 5 });
    await server.start();
    try {
      const { client } = await makeClient(server);
      const res = await client.request(`/api/accounts/${MOCK_ACCOUNT_ID}/messages/view`, {
        query: { limit: 5, start: 1 },
      });
      // 客户端保留了原始文本，可用它反查
      const { lossy } = parsePreservingBigInts(res.rawText);
      // ID 都是带引号的字符串，因此不应有任何丢精度字段
      expect(lossy).toEqual([]);
      expect(res.rawText).toContain('"messageId":"40012340000');
    } finally {
      await server.stop();
    }
  });
});
