#!/usr/bin/env node
/**
 * Phase 0-6：账户身份、Alias、邮箱规模、IMAP 可用性、ID 类型
 *
 * 一次 Accounts API 调用同时产出四项结论（实施计划 §25 Phase 0-6）：
 *   - emailAddress[] / sendMailDetails[]  → 校验 §11.8 account_identities 表结构
 *   - usedStorage / allowedStorage        → 邮箱真实体积，校准 §12.1 存储预算与 0-2 配额推算
 *   - imapAccessEnabled / imapBlocked     → 0-4 IMAP 探测的前置判断
 *   - 原始文本的 ID 字面量分析            → 校验 §11.3 大整数精度问题
 *
 * 用法：node spikes/02-account.mjs
 */

import { refreshAccessToken } from "./lib/oauth.mjs";
import { apiRequest, assertApiOk } from "./lib/api.mjs";
import { analyzeIdTypes } from "./lib/json-safe.mjs";
import { createRedactor } from "./lib/redact.mjs";
import { loadSecrets, writeOut, requireConfig } from "./lib/store.mjs";

const cfg = requireConfig(["clientId", "clientSecret", "refreshToken"]);
const location = process.env.ZMAIL_LOCATION ?? loadSecrets().location ?? "com";

const findings = { step: "0-6", location };
const redactor = createRedactor();
redactor.addSecret(cfg.clientSecret).addSecret(cfg.refreshToken);

const gb = (bytes) => (Number(bytes) / 1024 ** 3).toFixed(2) + " GB";

try {
  console.log("\n=== Phase 0-6: 账户身份 / Alias / 规模 / IMAP / ID 类型 ===\n");

  const tok = await refreshAccessToken({ ...cfg, location });
  const accessToken = tok.access_token;
  redactor.addSecret(accessToken);

  // ---- 账户列表 ----
  const listRes = assertApiOk(await apiRequest("/api/accounts", { accessToken, location }), "获取账户列表");
  const accounts = listRes.parsed?.data ?? [];
  findings.accountCount = accounts.length;
  if (!accounts.length) throw new Error("账户列表为空，检查 scope 是否包含 ZohoMail.accounts.READ");

  const primary = accounts[0];
  const accountId = String(primary.accountId);
  findings.accountIdType = typeof primary.accountId;

  // ---- 账户详情（字段最全的一个响应）----
  const detailRes = assertApiOk(
    await apiRequest(`/api/accounts/${accountId}`, { accessToken, location }),
    "获取账户详情",
  );
  const acct = detailRes.parsed?.data ?? {};

  // ---- 1. 收件身份 / alias ----
  const addresses = Array.isArray(acct.emailAddress) ? acct.emailAddress : [];
  findings.identities = {
    receiveAddressCount: addresses.length,
    aliasCount: addresses.filter((a) => a.isAlias).length,
    primaryCount: addresses.filter((a) => a.isPrimary).length,
    unconfirmedCount: addresses.filter((a) => a.isConfirmed === false).length,
    observedKeys: [...new Set(addresses.flatMap((a) => Object.keys(a)))].sort(),
  };

  // ---- 2. 发信身份 ----
  const sendDetails = Array.isArray(acct.sendMailDetails) ? acct.sendMailDetails : [];
  findings.sendIdentities = {
    count: sendDetails.length,
    modes: [...new Set(sendDetails.map((s) => s.mode))],
    validatedCount: sendDetails.filter((s) => s.validated === true).length,
    observedKeys: [...new Set(sendDetails.flatMap((s) => Object.keys(s)))].sort(),
  };

  // ---- 3. 邮箱规模 ----
  findings.storage = {
    usedBytes: acct.usedStorage ?? null,
    allowedBytes: acct.allowedStorage ?? null,
    usedHuman: acct.usedStorage != null ? gb(acct.usedStorage) : null,
    allowedHuman: acct.allowedStorage != null ? gb(acct.allowedStorage) : null,
    planType: acct.planType ?? null,
  };

  // ---- 4. IMAP 可用性（决定 0-4 是否值得做）----
  findings.imap = {
    imapAccessEnabled: acct.imapAccessEnabled ?? null,
    imapBlocked: acct.imapBlocked ?? null,
    popAccessEnabled: acct.popAccessEnabled ?? null,
    activeSyncEnabled: acct.activeSyncEnabled ?? null,
    verdict:
      acct.imapAccessEnabled === true && acct.imapBlocked !== true
        ? "可行 —— 建议执行 0-4 IMAP 探测"
        : "不可行 —— 跳过 0-4，节省 2 小时",
  };

  // ---- 5. ID 类型分析（用原始文本，不能用解析后的对象）----
  const idAnalysis = analyzeIdTypes(detailRes.rawText);
  const unsafe = idAnalysis.bareNumbers.filter((b) => b.unsafe);
  findings.idTypes = {
    bareNumberFields: idAnalysis.bareNumbers.map((b) => b.key),
    unsafeBareNumberFields: unsafe.map((b) => ({ key: b.key, source: b.source })),
    numericStringFields: idAnalysis.numericStrings.map((n) => n.key),
    dirtyNullLiterals: idAnalysis.nullLiterals.map((n) => `${n.key}="${n.value}"`),
    precisionLossDetectedByParser: detailRes.lossy.map((l) => l.key),
    verdict: unsafe.length
      ? "确认存在超 2^53 的裸数字字段 —— §11.3 的保精度解析是必需的"
      : "本次响应未见超 2^53 的裸数字，但仍应保留保精度解析（其他端点可能有）",
  };

  // ---- 6. 文件夹（顺带确认只读 scope 是否够用）----
  const folderRes = await apiRequest(`/api/accounts/${accountId}/folders`, { accessToken, location });
  findings.folders = folderRes.ok
    ? {
        ok: true,
        count: (folderRes.parsed?.data ?? []).length,
        names: (folderRes.parsed?.data ?? []).map((f) => f.folderName),
      }
    : { ok: false, status: folderRes.status, hint: "只读 scope 可能不足以列出文件夹" };

  // ---- 落盘：脱敏 fixture + 结论 ----
  const fixture = redactor.object(detailRes.parsed);
  writeOut("fixture-account-detail.json", JSON.stringify(fixture, null, 2));
  writeOut("fixture-account-detail.raw.json", detailRes.rawText); // 未脱敏，仅本地，已 gitignore
  writeOut("redaction-mapping.json", JSON.stringify(redactor.mapping(), null, 2));

  findings.ok = true;

  // ---- 人类可读摘要 ----
  console.log("\n──────── 结论摘要 ────────");
  console.log(`账户数            : ${findings.accountCount}`);
  console.log(`收件地址 / alias  : ${findings.identities.receiveAddressCount} 个，其中 alias ${findings.identities.aliasCount} 个`);
  console.log(`发信身份          : ${findings.sendIdentities.count} 个，mode = ${findings.sendIdentities.modes.join(", ") || "-"}`);
  console.log(`邮箱占用          : ${findings.storage.usedHuman ?? "?"} / ${findings.storage.allowedHuman ?? "?"}`);
  console.log(`文件夹            : ${findings.folders.ok ? findings.folders.count + " 个" : "❌ 获取失败"}`);
  console.log(`IMAP              : ${findings.imap.verdict}`);
  console.log(`ID 类型           : ${findings.idTypes.verdict}`);
  if (unsafe.length) console.log(`  超 2^53 字段    : ${unsafe.map((u) => u.key).join(", ")}`);
  if (idAnalysis.nullLiterals.length) {
    console.log(`  脏 null 字面量  : ${findings.idTypes.dirtyNullLiterals.join(", ")}`);
  }
  console.log("──────────────────────────");
  console.log("\n⚠️  fixture-account-detail.raw.json 是未脱敏原文，仅供本地比对，切勿提交。");
} catch (err) {
  findings.ok = false;
  findings.error = err.message;
  console.error(`\n❌ ${err.message}`);
  if (/403|scope/i.test(err.message)) {
    console.error("   scope 不足。确认授权时申请了 ZohoMail.accounts.READ / folders.READ / messages.READ。");
  }
} finally {
  const p = writeOut("findings-0-6.json", JSON.stringify(findings, null, 2));
  console.log(`\n结论已写入: ${p}\n`);
  process.exit(findings.ok ? 0 : 1);
}
