/**
 * zmail auth setup / login / status / refresh / revoke / remove
 *
 * 职责区分（实施计划 §16.3）：
 *   setup   保存 Client ID/Secret
 *   login   完成用户授权并保存 Refresh Token
 *   revoke  远程撤销 Token（同时清本机）
 *   remove  只删本机凭据，不碰远程
 */

import { createInterface } from "node:readline/promises";
import { profileSchema, type ZohoLocation, zohoLocationSchema } from "../config/schema.js";
import { saveConfig } from "../config/store.js";
import type { Context } from "../core/context.js";
import { ErrorCode, ZmailError } from "../core/errors.js";
import { redactEmail, registerSecret } from "../output/redact.js";
import { createSecretStore } from "../secrets/index.js";
import type { SecretStore } from "../secrets/secret-store.js";
import { discoverAccount, ZohoClient } from "../zoho/client.js";
import { loginWithLoopback, REDIRECT_URI, revokeRefreshToken } from "../zoho/oauth.js";
import {
  hasRequiredScopes,
  KNOWN_LOCATIONS,
  READ_SCOPES,
  resolveRegion,
} from "../zoho/region-resolver.js";
import { persistRefreshToken, TokenManager } from "../zoho/token-manager.js";

async function secretStoreFor(ctx: Context): Promise<SecretStore> {
  return createSecretStore({
    dataDir: ctx.paths.root,
    configured: ctx.isInitialized ? ctx.config().secretBackend : null,
    json: ctx.out.isJson,
  });
}

// ---------------------------------------------------------------- setup

export interface AuthSetupOptions {
  clientId?: string | undefined;
  clientSecret?: string | undefined;
  email?: string | undefined;
  location?: string | undefined;
}

export async function runAuthSetup(ctx: Context, opts: AuthSetupOptions): Promise<void> {
  const { out } = ctx;
  const profile = ctx.options.profile ?? "primary";

  // --json 下不能交互 —— Agent 无法回答提示（§9.5.3 同理）
  const needsPrompt = !opts.clientId || !opts.clientSecret || !opts.email;
  if (needsPrompt && (out.isJson || !process.stdin.isTTY)) {
    throw new ZmailError(ErrorCode.INVALID_ARGUMENT, "缺少必需参数，且当前不是交互式终端", {
      details: {
        required: ["--client-id", "--client-secret", "--email"],
        missing: [
          !opts.clientId && "--client-id",
          !opts.clientSecret && "--client-secret",
          !opts.email && "--email",
        ].filter(Boolean),
      },
      hint: "在交互式终端运行，或用 --client-id / --client-secret / --email 传入",
    });
  }

  const answers = needsPrompt ? await promptForSetup(opts) : opts;
  const clientId = String(answers.clientId);
  const clientSecret = String(answers.clientSecret);
  const email = String(answers.email);
  registerSecret(clientSecret);

  const location = zohoLocationSchema.parse(answers.location ?? "com") as ZohoLocation;
  const region = resolveRegion(location);

  const secrets = await secretStoreFor(ctx);
  await secrets.set(profile, "client-id", clientId);
  await secrets.set(profile, "client-secret", clientSecret);

  // 凭据进 SecretStore，config.json 只留非敏感引用（§8.4）
  const config = ctx.config();
  config.profiles[profile] = profileSchema.parse({
    email,
    zohoLocation: location,
    accountId: null,
    accountsBaseUrl: region.accountsBaseUrl,
    mailApiBaseUrl: region.mailApiBaseUrl,
    grantedScopes: [],
  });
  if (!config.profiles[config.defaultProfile]) config.defaultProfile = profile;
  saveConfig(ctx.paths.configFile, config);

  out.emit(
    {
      profile,
      email: redactEmail(email),
      zohoLocation: location,
      secretBackend: secrets.info.backend,
      redirectUri: REDIRECT_URI,
      credentialsStored: ["client-id", "client-secret"],
    },
    {},
    (d) =>
      [
        `已保存 profile "${d.profile}" 的 OAuth 客户端凭据`,
        `  邮箱     ${d.email}`,
        `  数据中心 ${d.zohoLocation}`,
        `  凭据后端 ${d.secretBackend}`,
        "",
        "确认 Zoho API Console 中的 Authorized Redirect URI 为：",
        `  ${d.redirectUri}`,
        "",
        "下一步: zmail auth login",
      ].join("\n"),
  );
}

async function promptForSetup(opts: AuthSetupOptions): Promise<AuthSetupOptions> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    process.stderr.write(
      [
        "",
        "需要一个 Zoho OAuth 应用（约 3 分钟，一次性）：",
        "  1. 打开 https://api-console.zoho.com/ → ADD CLIENT → Server-based Applications",
        `  2. Authorized Redirect URIs 填写（必须一字不差）：`,
        `     ${REDIRECT_URI}`,
        "  3. 创建后复制 Client ID 与 Client Secret",
        "",
      ].join("\n"),
    );

    const clientId = opts.clientId ?? (await rl.question("Client ID: ")).trim();
    const clientSecret = opts.clientSecret ?? (await rl.question("Client Secret: ")).trim();
    const email = opts.email ?? (await rl.question("Zoho 邮箱地址: ")).trim();
    const location =
      opts.location ??
      (await rl.question(`数据中心 [${KNOWN_LOCATIONS.join("/")}] (com): `)).trim();

    return { clientId, clientSecret, email, location: location || "com" };
  } finally {
    rl.close();
  }
}

// ---------------------------------------------------------------- login

export async function runAuthLogin(ctx: Context): Promise<void> {
  const { out } = ctx;
  const profileName = ctx.profileName();
  const profile = ctx.profile();
  const region = resolveRegion(profile.zohoLocation);
  const secrets = await secretStoreFor(ctx);

  const [clientId, clientSecret] = await Promise.all([
    secrets.get(profileName, "client-id"),
    secrets.get(profileName, "client-secret"),
  ]);
  if (!clientId || !clientSecret) {
    throw new ZmailError(
      ErrorCode.AUTH_REQUIRED,
      `profile "${profileName}" 尚未配置 OAuth 客户端`,
      {
        hint: "先运行 zmail auth setup",
      },
    );
  }
  registerSecret(clientSecret);

  if (out.isJson) {
    // 授权需要人在浏览器里点击，Agent 无法完成
    throw new ZmailError(ErrorCode.INVALID_ARGUMENT, "auth login 需要人工在浏览器中授权", {
      hint: "请由用户在交互式终端运行 zmail auth login",
    });
  }

  out.event("auth_login_start", { profile: profileName, location: profile.zohoLocation });

  const tokens = await loginWithLoopback({
    clientId,
    clientSecret,
    region,
    scopes: READ_SCOPES,
    onNotice: (m) => out.note(m),
  });

  // 首次授权必须拿到 refresh token，否则下次启动就要重新授权
  if (!tokens.refreshToken) {
    throw new ZmailError(ErrorCode.AUTH_REQUIRED, "Zoho 未返回 refresh token", {
      hint:
        "多为同一 client 重复授权所致。到 accounts.zoho.com 的「已连接应用」中" + "撤销后重试。",
    });
  }
  await persistRefreshToken(secrets, profileName, tokens);

  if (!hasRequiredScopes(tokens.grantedScopes, READ_SCOPES)) {
    out.note(`⚠️ 授予的 scope 少于申请：${tokens.grantedScopes.join(", ")}。部分功能可能不可用。`);
  }

  // 立刻验证 base URL 与凭据可用 —— 验证失败时不得进入同步（§10.6）
  out.note("正在发现账户…");
  const manager = new TokenManager({ profile: profileName, region, secrets });
  const client = new ZohoClient({
    region,
    tokens: manager,
    onEvent: (evt, fields) => out.event(evt, fields),
  });
  const account = await discoverAccount(client);

  const config = ctx.config();
  const stored = config.profiles[profileName];
  if (stored) {
    stored.accountId = account.accountId;
    stored.grantedScopes = tokens.grantedScopes;
    saveConfig(ctx.paths.configFile, config);
  }

  out.emit(
    {
      profile: profileName,
      accountId: account.accountId,
      email: redactEmail(account.primaryEmail),
      grantedScopes: tokens.grantedScopes,
      identities: account.identities.length,
      aliases: account.identities.filter((i) => i.isAlias).length,
      storage:
        account.usedStorageKb !== null && account.allowedStorageKb !== null
          ? {
              unit: "KB",
              usedKb: account.usedStorageKb,
              allowedKb: account.allowedStorageKb,
            }
          : null,
    },
    { profile: profileName, source: "remote" },
    (d) =>
      [
        "授权成功",
        `  profile    ${d.profile}`,
        `  账户       ${d.email}`,
        `  accountId  ${d.accountId}`,
        `  身份       ${d.identities} 个（含 ${d.aliases} 个 alias）`,
        d.storage
          ? `  容量       ${(d.storage.usedKb / 1024).toFixed(1)} MB / ${(d.storage.allowedKb / 1024 / 1024).toFixed(1)} GB`
          : "",
        "",
        "下一步: zmail sync --full",
      ]
        .filter(Boolean)
        .join("\n"),
  );
}

// ---------------------------------------------------------------- status

export async function runAuthStatus(ctx: Context): Promise<void> {
  const { out } = ctx;
  const profileName = ctx.profileName();
  const config = ctx.config();
  const profile = config.profiles[profileName];
  const secrets = await secretStoreFor(ctx);

  const stored = profile ? await secrets.list(profileName) : [];
  const hasClient = stored.includes("client-id") && stored.includes("client-secret");
  const hasRefresh = stored.includes("refresh-token");

  out.emit(
    {
      profile: profileName,
      configured: Boolean(profile),
      clientConfigured: hasClient,
      authorized: hasRefresh,
      accountId: profile?.accountId ?? null,
      email: profile ? redactEmail(profile.email) : null,
      zohoLocation: profile?.zohoLocation ?? null,
      grantedScopes: profile?.grantedScopes ?? [],
      hasRequiredScopes: profile ? hasRequiredScopes(profile.grantedScopes, READ_SCOPES) : false,
      secretBackend: secrets.info.backend,
      securityLevel: secrets.info.securityLevel,
    },
    { profile: profileName },
    (d) => {
      if (!d.configured) return `profile "${d.profile}" 不存在。运行 zmail auth setup。`;
      const mark = (ok: boolean) => (ok ? "✅" : "❌");
      return [
        `profile      ${d.profile}`,
        `邮箱         ${d.email}`,
        `数据中心     ${d.zohoLocation}`,
        `凭据后端     ${d.secretBackend} (${d.securityLevel})`,
        `客户端凭据   ${mark(d.clientConfigured)}`,
        `已授权       ${mark(d.authorized)}`,
        `accountId    ${d.accountId ?? "（尚未发现）"}`,
        `scope        ${d.grantedScopes.length ? d.grantedScopes.join(", ") : "（无）"}`,
        d.authorized ? "" : "\n运行 zmail auth login 完成授权。",
      ]
        .filter(Boolean)
        .join("\n");
    },
  );
}

// ---------------------------------------------------------------- refresh

export async function runAuthRefresh(ctx: Context): Promise<void> {
  const { out } = ctx;
  const profileName = ctx.profileName();
  const profile = ctx.profile();
  const region = resolveRegion(profile.zohoLocation);
  const secrets = await secretStoreFor(ctx);

  const manager = new TokenManager({ profile: profileName, region, secrets });
  const startedAt = Date.now();
  await manager.getAccessToken();

  out.emit(
    {
      profile: profileName,
      refreshed: true,
      elapsedMs: Date.now() - startedAt,
      grantedScopes: manager.grantedScopes ?? [],
    },
    { profile: profileName, source: "remote" },
    (d) => `刷新成功（${d.elapsedMs} ms）。access token 仅在内存中，未落盘。`,
  );
}

// ---------------------------------------------------------------- revoke / remove

export async function runAuthRevoke(ctx: Context): Promise<void> {
  const { out } = ctx;
  const profileName = ctx.profileName();
  const profile = ctx.profile();
  const region = resolveRegion(profile.zohoLocation);
  const secrets = await secretStoreFor(ctx);

  const refreshToken = await secrets.get(profileName, "refresh-token");
  if (!refreshToken) {
    throw new ZmailError(ErrorCode.AUTH_REQUIRED, `profile "${profileName}" 尚未授权`, {
      hint: "无需撤销",
    });
  }

  await revokeRefreshToken({ region, refreshToken });
  await secrets.delete(profileName, "refresh-token");

  const config = ctx.config();
  const stored = config.profiles[profileName];
  if (stored) {
    stored.grantedScopes = [];
    saveConfig(ctx.paths.configFile, config);
  }

  out.emit(
    { profile: profileName, revoked: true, localCredentialsRemoved: ["refresh-token"] },
    {},
    () =>
      `已在 Zoho 远程撤销并删除本机 refresh token。client-id / client-secret 保留，可直接重新 login。`,
  );
}

export async function runAuthRemove(ctx: Context): Promise<void> {
  const { out } = ctx;
  const profileName = ctx.profileName();
  const secrets = await secretStoreFor(ctx);

  const existing = await secrets.list(profileName);
  for (const key of existing) await secrets.delete(profileName, key);

  out.emit({ profile: profileName, removed: existing, remoteRevoked: false }, {}, (d) =>
    [
      `已删除本机凭据: ${d.removed.join(", ") || "（无）"}`,
      "",
      "⚠️ 远程授权仍然有效。要一并撤销请先运行 zmail auth revoke，",
      "   或到 accounts.zoho.com 的「已连接应用」中手工移除。",
    ].join("\n"),
  );
}
