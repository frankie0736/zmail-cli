#!/usr/bin/env node
/**
 * Phase 0-1：OAuth Loopback 授权 + Refresh Token 验证
 *
 * 产出结论（实施计划 §25 Phase 0-1）：
 *   - Loopback Redirect URI 能否在所选 Client 类型下注册并工作
 *   - 是否稳定返回 refresh_token
 *   - access_type=offline / prompt=consent 的实际行为
 *   - refresh token 能否在重启进程后独立换取新 access token
 *
 * 用法：
 *   node spikes/01-oauth.mjs            # 完整授权
 *   node spikes/01-oauth.mjs --refresh  # 只用已存的 refresh token 换 access token
 */

import { loginWithLoopback, refreshAccessToken, READ_SCOPES, REDIRECT_URI } from "./lib/oauth.mjs";
import { loadSecrets, saveSecrets, writeOut, requireConfig } from "./lib/store.mjs";

const refreshOnly = process.argv.includes("--refresh");
const cfg = requireConfig(["clientId", "clientSecret"]);
const location = process.env.ZMAIL_LOCATION ?? loadSecrets().location ?? "com";

const findings = { step: "0-1", location, redirectUri: REDIRECT_URI, scopes: READ_SCOPES };

try {
  if (refreshOnly) {
    // ---- 验证：重启进程后仅凭 refresh token 能否换到 access token ----
    const { refreshToken } = requireConfig(["refreshToken"]);
    console.log("\n用已保存的 refresh token 换取新的 access token…\n");

    const t0 = Date.now();
    const tok = await refreshAccessToken({ ...cfg, refreshToken, location });
    findings.refreshWorks = Boolean(tok.access_token);
    findings.refreshElapsedMs = Date.now() - t0;
    findings.expiresInSeconds = tok.expires_in;
    findings.refreshResponseKeys = Object.keys(tok).sort();
    findings.returnsNewRefreshTokenOnRefresh = "refresh_token" in tok;
    findings.grantedScope = tok.scope ?? null;

    console.log("✅ refresh 成功");
    console.log(`   access token 有效期: ${tok.expires_in} 秒`);
    console.log(`   响应字段: ${findings.refreshResponseKeys.join(", ")}`);
    console.log(`   刷新时是否附带新 refresh_token: ${findings.returnsNewRefreshTokenOnRefresh ? "是" : "否"}`);
  } else {
    // ---- 完整 loopback 授权 ----
    console.log("\n=== Phase 0-1: Zoho OAuth Loopback Spike ===");
    console.log(`数据中心: ${location}`);
    console.log(`回调地址: ${REDIRECT_URI}`);
    console.log(`申请 scope: ${READ_SCOPES.join(", ")}`);
    console.log("\n⚠️  确认你已在 Zoho API Console 中把上面的回调地址注册为 Authorized Redirect URI，");
    console.log("    否则 Zoho 会直接报 redirect_uri_mismatch。");

    const t0 = Date.now();
    const tok = await loginWithLoopback({ ...cfg, location });
    findings.loopbackWorks = true;
    findings.authElapsedMs = Date.now() - t0;
    findings.tokenResponseKeys = Object.keys(tok).sort();
    findings.returnsRefreshToken = Boolean(tok.refresh_token);
    findings.expiresInSeconds = tok.expires_in;
    findings.grantedScope = tok.scope ?? null;
    findings.tokenType = tok.token_type ?? null;

    if (!tok.refresh_token) {
      console.warn("\n⚠️  没有拿到 refresh_token。");
      console.warn("    多数情况是 Zoho 对同一个 client 的重复授权不再返回 refresh_token。");
      console.warn("    可在 accounts.zoho.com 的「已连接应用」中撤销后重试，");
      console.warn("    或确认 access_type=offline & prompt=consent 是否生效。");
    } else {
      saveSecrets({ refreshToken: tok.refresh_token, location });
      console.log("\n✅ 已获取 refresh token 并存入 spikes/.secrets.json (0600, 已 gitignore)");
    }

    console.log(`   access token 有效期: ${tok.expires_in} 秒`);
    console.log(`   实际授予的 scope: ${tok.scope ?? "(未返回)"}`);
    console.log("\n下一步验证「重启后仅凭 refresh token 可用」：");
    console.log("   node spikes/01-oauth.mjs --refresh");
  }

  findings.ok = true;
} catch (err) {
  findings.ok = false;
  findings.error = err.message;
  console.error(`\n❌ ${err.message}`);
  if (/redirect_uri/i.test(err.message)) {
    console.error(`\n   请在 Zoho API Console 中把 Authorized Redirect URI 设为：\n   ${REDIRECT_URI}`);
  }
  if (/invalid_client/i.test(err.message)) {
    console.error("\n   Client ID / Secret 不匹配，或所选数据中心不对（试试 ZMAIL_LOCATION=eu 等）。");
  }
} finally {
  const p = writeOut(`findings-0-1${refreshOnly ? "-refresh" : ""}.json`, JSON.stringify(findings, null, 2));
  console.log(`\n结论已写入: ${p}\n`);
  process.exit(findings.ok ? 0 : 1);
}
