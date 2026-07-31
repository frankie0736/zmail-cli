/**
 * MockZohoServer —— 本项目对外的核心测试基础设施。实施计划 §22.3 / §23.6。
 *
 * ## 为什么它是必需的而不是可选的
 *
 * 1. **外部贡献者没有 Zoho 账号。** 没有它，`pnpm test` 在干净机器上就跑不全，
 *    CONTRIBUTING.md 的核心承诺不成立，项目也就不会有社区。
 * 2. **真实邮箱验不了关键路径。** 开发用的邮箱只有 26 封邮件，分页边界、
 *    断点续传、限流退避、大批量 upsert 这些最容易出错的地方，在真实账号上
 *    根本触发不了。
 * 3. **故障注入无法在真实 API 上做。** 你没法让 Zoho 按需返回 429 或超时。
 *
 * ## 响应结构来自实测
 *
 * 字段名和取值取自 Phase 0 采集的真实响应（见 docs/phase-0-findings.md），
 * 而不是文档 —— 两者有出入的地方以实测为准。特别是：
 *
 *   - folders 端点**不返回** messageCount
 *   - usedStorage / allowedStorage 单位是 KB
 *   - signatureId 是字符串 "null"，另有多个空字符串字段
 *   - sendMailDetails.mode 取值含 'alias'
 *   - accountId 超出 2^53 但被加了引号
 *
 * ## 确定性
 *
 * 所有生成都由种子驱动，不用 Math.random。测试失败必须可复现 ——
 * 随机数据导致的偶发失败比没有测试更糟。
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { ZohoRegion } from "../../src/zoho/region-resolver.js";

// ---------------------------------------------------------------- 确定性随机

/** mulberry32：小而快的可播种 PRNG。 */
function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------- 语料

const SUBJECTS_CN = [
  "硅胶管报价单",
  "客户询价 —— 交期确认",
  "样品寄送与规格确认",
  "关于付款条件的讨论",
  "质量问题反馈",
  "新产品目录",
];
const SUBJECTS_EN = [
  "Quotation for silicone tubing",
  "Sample request and lead time",
  "Re: payment terms",
  "Quality issue report",
  "Updated product catalogue",
];
const BODY_FRAGMENTS_CN = [
  "您好，我们需要硅胶管的报价，规格如下。",
  "请确认交期与最小起订量。",
  "样品已寄出，请查收并反馈测试结果。",
  "关于上次提到的质量问题，我们已安排复检。",
];
const BODY_FRAGMENTS_EN = [
  "Please find our quotation attached.",
  "Could you confirm the lead time and MOQ?",
  "Samples have been dispatched, tracking number follows.",
  "We have arranged a re-inspection regarding the quality issue.",
];

const SENDERS = [
  { name: "John Doe", address: "john@buyer.example.com" },
  { name: "王经理", address: "wang@customer.example.org" },
  { name: "Maria Silva", address: "maria@distributor.example.net" },
  { name: "", address: "noreply@notifications.example.com" },
];

// ---------------------------------------------------------------- 配置

export interface FaultConfig {
  /** 每第 N 个 API 请求返回 429。0 表示不注入。 */
  rateLimitEvery?: number;
  /** 429 是否带 Retry-After 头。null 表示不带（Zoho 实际行为待确认）。 */
  retryAfterSeconds?: number | null;
  /** access token 被使用 N 次后开始返回 401，模拟过期。 */
  expireAccessTokenAfter?: number;
  /** 这些 messageId 的正文请求返回 404，模拟邮件已被移动或删除。 */
  notFoundMessageIds?: Set<string>;
  /** 每第 N 个请求返回非法 JSON。 */
  malformedJsonEvery?: number;
  /** 每个请求的人工延迟，用于测超时。 */
  delayMs?: number;
  /** 返回 500 的请求序号集合。 */
  serverErrorOn?: Set<number>;
}

export interface MockOptions {
  messageCount?: number;
  /** 服务端分页上限。超过此值的 limit 会被截断 —— 真实 API 就是这么做的。 */
  pageLimit?: number;
  seed?: number;
  faults?: FaultConfig;
  /** refresh 时是否返回新的 refresh_token。默认 false，与 Zoho 实测一致。 */
  rotateRefreshToken?: boolean;
}

export interface MockStats {
  totalRequests: number;
  byPath: Record<string, number>;
  tokenRefreshes: number;
  rateLimited: number;
}

interface MockMessage {
  messageId: string;
  threadId: string;
  folderId: string;
  subject: string;
  sender: string;
  fromAddress: string;
  toAddress: string;
  ccAddress: string;
  summary: string;
  body: string;
  receivedTime: string;
  hasAttachment: string;
  size: number;
  status: string;
}

export const MOCK_ACCOUNT_ID = "4001234000000009007";
export const MOCK_EMAIL = "owner@example.com";
export const MOCK_CLIENT_ID = "1000.MOCKCLIENTID";
export const MOCK_CLIENT_SECRET = "mock-client-secret";
export const MOCK_REFRESH_TOKEN = "1000.mockrefreshtoken.aaaa";

/** 与真实响应一致的文件夹集合（Phase 0-6 实测 11 个）。 */
const FOLDERS = [
  { folderId: "1000000001", folderName: "Inbox", folderType: "Inbox" },
  { folderId: "1000000002", folderName: "Drafts", folderType: "Drafts" },
  { folderId: "1000000003", folderName: "Sent", folderType: "Sent" },
  { folderId: "1000000004", folderName: "Spam", folderType: "Spam" },
  { folderId: "1000000005", folderName: "Trash", folderType: "Trash" },
  { folderId: "1000000006", folderName: "Archive", folderType: "Archive" },
];

const SYNCABLE_FOLDERS = ["1000000001", "1000000003", "1000000006"];

/**
 * ID 基准值。取自 Phase 0 采集的真实 accountId 量级，且**尾数不圆整** ——
 * 这样 `Number(id)` 一定会丢精度，任何误把 ID 当数字处理的代码都会被测出来。
 */
const MESSAGE_ID_BASE = 4001234000000009007n;
const THREAD_ID_BASE = 4101234000000009003n;

export class MockZohoServer {
  #server: Server | undefined;
  #port = 0;
  readonly #opts: Required<Omit<MockOptions, "faults">> & { faults: FaultConfig };
  readonly #messages: MockMessage[] = [];
  #requestCounter = 0;
  #accessTokenUses = 0;
  #currentAccessToken = "mock-access-token-1";
  readonly stats: MockStats = {
    totalRequests: 0,
    byPath: {},
    tokenRefreshes: 0,
    rateLimited: 0,
  };

  constructor(opts: MockOptions = {}) {
    this.#opts = {
      messageCount: opts.messageCount ?? 250,
      pageLimit: opts.pageLimit ?? 200,
      seed: opts.seed ?? 42,
      rotateRefreshToken: opts.rotateRefreshToken ?? false,
      faults: opts.faults ?? {},
    };
    this.#generateMessages();
  }

  #generateMessages(): void {
    const rand = seededRandom(this.#opts.seed);
    const pick = <T>(arr: readonly T[]): T => arr[Math.floor(rand() * arr.length)] as T;
    // 固定基准时间，不用 Date.now —— 否则测试结果随运行时刻变化
    const baseTime = 1_760_000_000_000;

    for (let i = 0; i < this.#opts.messageCount; i++) {
      const useCn = rand() < 0.5;
      const sender = pick(SENDERS);
      const subject = `${useCn ? pick(SUBJECTS_CN) : pick(SUBJECTS_EN)} #${i + 1}`;
      const body = useCn
        ? `${pick(BODY_FRAGMENTS_CN)}\n\n${pick(BODY_FRAGMENTS_EN)}`
        : `${pick(BODY_FRAGMENTS_EN)}\n\n${pick(BODY_FRAGMENTS_CN)}`;

      // messageId 必须真的会被 Number() 损坏，否则这个 mock 就起不到
      // 暴露数值化 bug 的作用。
      //
      // 尾数圆整的大整数（如 ...00100000）恰好能被 double 精确表示，
      // String(Number(id)) === id，看着超了 2^53 其实无害 —— 第一版就踩了这个坑。
      // 以真实 ID 4001234000000009007 为基准、步长 7 递增，保证尾数不圆整。
      const messageId = String(MESSAGE_ID_BASE + BigInt(i) * 7n);

      this.#messages.push({
        messageId,
        threadId: String(THREAD_ID_BASE + BigInt(Math.floor(i / 3)) * 13n),
        folderId: SYNCABLE_FOLDERS[i % SYNCABLE_FOLDERS.length] as string,
        subject,
        sender: sender.name,
        fromAddress: sender.address,
        toAddress: MOCK_EMAIL,
        ccAddress: i % 5 === 0 ? "cc@example.org" : "",
        summary: body.slice(0, 60),
        body,
        // 时间递减：索引越小越新，与真实列表顺序一致
        receivedTime: String(baseTime - i * 3_600_000),
        hasAttachment: i % 7 === 0 ? "1" : "0",
        size: 2048 + Math.floor(rand() * 40000),
        status: i % 3 === 0 ? "0" : "1",
      });
    }
  }

  async start(): Promise<string> {
    const server = createServer((req, res) => void this.#handle(req, res));
    this.#server = server;
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const addr = server.address();
    if (addr === null || typeof addr === "string") {
      throw new Error("MockZohoServer 未能绑定到 TCP 端口");
    }
    this.#port = addr.port;
    return this.baseUrl;
  }

  async stop(): Promise<void> {
    if (!this.#server) return;
    await new Promise<void>((resolve) => this.#server?.close(() => resolve()));
    this.#server = undefined;
  }

  get baseUrl(): string {
    return `http://127.0.0.1:${this.#port}`;
  }

  /** 同时充当 accounts 与 mail API 端点 —— 路径不冲突。 */
  get region(): ZohoRegion {
    return {
      location: "com",
      accountsBaseUrl: this.baseUrl,
      mailApiBaseUrl: this.baseUrl,
    };
  }

  get messageCount(): number {
    return this.#messages.length;
  }

  /** 模拟远程删除：邮件从列表中消失，供对账逻辑测试使用。 */
  deleteMessage(messageId: string): boolean {
    const idx = this.#messages.findIndex((m) => m.messageId === messageId);
    if (idx < 0) return false;
    this.#messages.splice(idx, 1);
    return true;
  }

  /** 模拟在 WebMail 中移动邮件。 */
  moveMessage(messageId: string, toFolderId: string): boolean {
    const msg = this.#messages.find((m) => m.messageId === messageId);
    if (!msg) return false;
    msg.folderId = toFolderId;
    return true;
  }

  listMessageIds(folderId?: string): string[] {
    return this.#messages
      .filter((m) => !folderId || m.folderId === folderId)
      .map((m) => m.messageId);
  }

  resetStats(): void {
    this.stats.totalRequests = 0;
    this.stats.byPath = {};
    this.stats.tokenRefreshes = 0;
    this.stats.rateLimited = 0;
    this.#requestCounter = 0;
    this.#accessTokenUses = 0;
  }

  // ---- 请求处理 ----

  async #handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", this.baseUrl);
    const path = url.pathname;

    const faults = this.#opts.faults;
    if (faults.delayMs) await new Promise((r) => setTimeout(r, faults.delayMs));

    // token 端点不计入 API 统计，也不受故障注入影响
    if (path === "/oauth/v2/token") {
      await this.#handleToken(req, res);
      return;
    }
    if (path === "/oauth/v2/token/revoke") {
      this.#json(res, 200, { status: "success" });
      return;
    }

    this.#requestCounter++;
    this.stats.totalRequests++;
    this.stats.byPath[path] = (this.stats.byPath[path] ?? 0) + 1;
    const n = this.#requestCounter;

    // ---- 故障注入 ----
    if (faults.serverErrorOn?.has(n)) {
      this.#json(res, 500, { status: { code: 500, description: "Internal Server Error" } });
      return;
    }
    if (faults.malformedJsonEvery && n % faults.malformedJsonEvery === 0) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end('{"data": [ this is not valid json');
      return;
    }
    if (faults.rateLimitEvery && n % faults.rateLimitEvery === 0) {
      this.stats.rateLimited++;
      const headers: Record<string, string> = { "content-type": "application/json" };
      if (faults.retryAfterSeconds != null) {
        headers["retry-after"] = String(faults.retryAfterSeconds);
      }
      res.writeHead(429, headers);
      res.end(JSON.stringify({ status: { code: 429, description: "Rate limit exceeded" } }));
      return;
    }

    // ---- 鉴权 ----
    const auth = req.headers.authorization ?? "";
    if (!auth.startsWith("Zoho-oauthtoken ")) {
      this.#json(res, 401, { status: { code: 401, description: "Unauthorized" } });
      return;
    }
    const presented = auth.slice("Zoho-oauthtoken ".length);
    this.#accessTokenUses++;
    const expireAfter = faults.expireAccessTokenAfter;
    if (
      presented !== this.#currentAccessToken ||
      (expireAfter && this.#accessTokenUses > expireAfter)
    ) {
      this.#json(res, 401, { status: { code: 401, description: "Invalid OAuth token" } });
      return;
    }

    // ---- 路由 ----
    if (path === "/api/accounts") {
      this.#json(res, 200, { status: { code: 200 }, data: [this.#accountPayload()] });
      return;
    }
    if (path === `/api/accounts/${MOCK_ACCOUNT_ID}`) {
      this.#json(res, 200, { status: { code: 200 }, data: this.#accountPayload() });
      return;
    }
    if (path === `/api/accounts/${MOCK_ACCOUNT_ID}/folders`) {
      // 刻意不返回 messageCount —— 与真实 API 一致（Phase 0-6 实测）
      this.#json(res, 200, {
        status: { code: 200 },
        data: FOLDERS.map((f) => ({
          ...f,
          path: `/${f.folderName}`,
          isArchived: "0",
          folderIcon: "null",
          imapAccess: true,
          VW: "0",
          HIDE: "0",
          URI: `/api/accounts/${MOCK_ACCOUNT_ID}/folders/${f.folderId}`,
        })),
      });
      return;
    }
    if (path === `/api/accounts/${MOCK_ACCOUNT_ID}/messages/view`) {
      this.#handleList(url, res);
      return;
    }

    const contentMatch = new RegExp(
      `^/api/accounts/${MOCK_ACCOUNT_ID}/folders/(\\d+)/messages/(\\d+)/content$`,
    ).exec(path);
    if (contentMatch) {
      this.#handleContent(contentMatch[2] as string, res);
      return;
    }

    this.#json(res, 404, { status: { code: 404, description: "Not Found" } });
  }

  async #handleToken(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await new Promise<string>((resolve) => {
      let b = "";
      req.on("data", (c) => {
        b += c;
      });
      req.on("end", () => resolve(b));
    });
    const params = new URLSearchParams(body);

    if (params.get("client_id") !== MOCK_CLIENT_ID) {
      // Zoho 在 HTTP 200 下返回业务错误
      this.#json(res, 200, { error: "invalid_client" });
      return;
    }

    const grantType = params.get("grant_type");
    if (grantType === "refresh_token") {
      if (params.get("refresh_token") !== MOCK_REFRESH_TOKEN) {
        this.#json(res, 200, { error: "invalid_code" });
        return;
      }
      this.stats.tokenRefreshes++;
      this.#accessTokenUses = 0;
      this.#currentAccessToken = `mock-access-token-${this.stats.tokenRefreshes + 1}`;

      // ⚠️ 默认**不返回** refresh_token —— 与 Zoho 实测行为一致（§10.5）。
      // 这正是 TokenManager 最容易写错的地方，mock 必须忠实复现。
      this.#json(res, 200, {
        access_token: this.#currentAccessToken,
        ...(this.#opts.rotateRefreshToken
          ? { refresh_token: `${MOCK_REFRESH_TOKEN}.rotated` }
          : {}),
        expires_in: 3600,
        // Zoho 用**空格**分隔，尽管申请时用的是逗号
        scope: "ZohoMail.accounts.READ ZohoMail.folders.READ ZohoMail.messages.READ",
        api_domain: "https://www.zohoapis.com",
        token_type: "Bearer",
      });
      return;
    }

    if (grantType === "authorization_code") {
      if (params.get("code") !== "MOCK_AUTH_CODE") {
        this.#json(res, 200, { error: "invalid_code" });
        return;
      }
      this.#json(res, 200, {
        access_token: this.#currentAccessToken,
        refresh_token: MOCK_REFRESH_TOKEN,
        expires_in: 3600,
        scope: "ZohoMail.accounts.READ ZohoMail.folders.READ ZohoMail.messages.READ",
        api_domain: "https://www.zohoapis.com",
        token_type: "Bearer",
      });
      return;
    }

    this.#json(res, 400, { error: "unsupported_grant_type" });
  }

  #handleList(url: URL, res: ServerResponse): void {
    const folderId = url.searchParams.get("folderId");
    const requested = Number(url.searchParams.get("limit") ?? 50);
    // 服务端截断到分页上限 —— 这正是 03-quota 想测出来的行为
    const limit = Math.min(requested, this.#opts.pageLimit);
    const start = Number(url.searchParams.get("start") ?? 1);

    const pool = folderId
      ? this.#messages.filter((m) => m.folderId === folderId)
      : [...this.#messages];

    const page = pool.slice(start - 1, start - 1 + limit);

    this.#json(res, 200, {
      status: { code: 200 },
      data: page.map((m) => ({
        messageId: m.messageId,
        threadId: m.threadId,
        folderId: m.folderId,
        subject: m.subject,
        sender: m.sender,
        fromAddress: m.fromAddress,
        toAddress: m.toAddress,
        ccAddress: m.ccAddress,
        summary: m.summary,
        receivedTime: m.receivedTime,
        sentDateInGMT: m.receivedTime,
        hasAttachment: m.hasAttachment,
        size: m.size,
        status: m.status,
        status2: m.status,
        threadCount: "1",
        priority: "3",
        hasInline: "false",
        flagid: "flag_not_set",
        calendarType: 0,
      })),
    });
  }

  #handleContent(messageId: string, res: ServerResponse): void {
    if (this.#opts.faults.notFoundMessageIds?.has(messageId)) {
      this.#json(res, 404, { status: { code: 404, description: "Message not found" } });
      return;
    }
    const msg = this.#messages.find((m) => m.messageId === messageId);
    if (!msg) {
      this.#json(res, 404, { status: { code: 404, description: "Message not found" } });
      return;
    }
    this.#json(res, 200, {
      status: { code: 200 },
      data: {
        messageId: msg.messageId,
        content: `<div>${msg.body.replace(/\n/g, "<br>")}</div>`,
        subject: msg.subject,
        fromAddress: msg.fromAddress,
        toAddress: msg.toAddress,
        ccAddress: msg.ccAddress,
        receivedTime: msg.receivedTime,
        // 脏数据：字符串 "null" 与空字符串，与真实响应一致
        bccAddress: "",
        replyTo: "null",
      },
    });
  }

  #accountPayload(): Record<string, unknown> {
    return {
      // 19 位，超出 2^53，但加了引号 —— 与真实响应一致
      accountId: MOCK_ACCOUNT_ID,
      primaryEmailAddress: MOCK_EMAIL,
      mailboxAddress: MOCK_EMAIL,
      accountName: "mockaccount",
      displayName: "Mock User",
      // 单位是 KB，不是字节
      usedStorage: 1877,
      allowedStorage: 10485760,
      planStorage: 10,
      planType: 93,
      imapAccessEnabled: true,
      imapBlocked: false,
      popAccessEnabled: true,
      // 裸数字，安全范围内
      zuid: 809451734,
      emailAddress: [
        { mailId: MOCK_EMAIL, isPrimary: true, isAlias: false, isConfirmed: true },
        { mailId: "sales@example.org", isPrimary: false, isAlias: true, isConfirmed: true },
        { mailId: "external@example.net", isPrimary: false, isAlias: false, isConfirmed: true },
      ],
      sendMailDetails: [
        {
          fromAddress: MOCK_EMAIL,
          displayName: "Mock User",
          mode: "mailbox",
          sendMailId: "4001234000000009004",
          // 实测中二者不一致
          status: true,
          validated: false,
          signatureId: "null",
        },
        {
          fromAddress: "sales@example.org",
          displayName: "Sales",
          mode: "alias",
          sendMailId: "4001234000000009005",
          status: true,
          validated: false,
          signatureId: "null",
        },
      ],
      // 一批脏空值，复现真实响应
      mobileNumber: "",
      phoneNumber: "",
      phoneNumer: "",
      lastName: "",
      timeZone: "",
    };
  }

  #json(res: ServerResponse, status: number, body: unknown): void {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  }
}
