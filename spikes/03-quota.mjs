#!/usr/bin/env node

/**
 * Phase 0-2：API 配额与速率限制实测
 *
 * ⚠️ 这个脚本会**真实消耗你的 Zoho API 配额**。
 *
 * 当前同步设计是每封邮件一次正文请求（§14.2 第 7 步）。5 万封邮件 = 5 万次调用。
 * 如果 Zoho 的每日上限只有几千次，全量同步根本跑不完 —— 这不是优化问题，
 * 是可行性问题，会推翻 §3.1 / §8.4 / §14 的设计。
 *
 * 产出（§25 Phase 0-2）：
 *   - 列表 API 单页最大条数
 *   - 顺序请求的延迟分布
 *   - 提高并发是否触发 429，以及 429 是否带 Retry-After
 *   - 是否存在批量取正文的接口
 *   - 「同步 N 封邮件需要多久、消耗多少次调用」的推算
 *
 * 用法：
 *   node spikes/03-quota.mjs                    # 默认预算 120 次调用
 *   node spikes/03-quota.mjs --budget 300       # 放宽预算
 *   node spikes/03-quota.mjs --probe-429        # 额外探测限流阈值（会被短暂限流）
 */

import { apiRequest } from "./lib/api.mjs";
import { humanDuration, runWithConcurrency, sleep, summarize } from "./lib/concurrency.mjs";
import { refreshAccessToken } from "./lib/oauth.mjs";
import { loadSecrets, readOut, requireConfig, writeOut } from "./lib/store.mjs";

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : fallback;
};
const BUDGET = Number(flag("budget", "120"));
const PROBE_429 = argv.includes("--probe-429");

const cfg = requireConfig(["clientId", "clientSecret", "refreshToken"]);
const location = process.env.ZMAIL_LOCATION ?? loadSecrets().location ?? "com";

/** 调用计数器。硬性上限，超出即停 —— 绝不能因为脚本 bug 把配额烧光。 */
let callsUsed = 0;
const findings = {
  step: "0-2",
  location,
  budget: BUDGET,
  probed429: PROBE_429,
  callsUsed: 0,
  ok: false,
};

/** 每次调用前检查预算；结论随时可落盘，Ctrl+C 不丢数据。 */
async function call(path, opts = {}) {
  if (callsUsed >= BUDGET) {
    const err = new Error(`已达调用预算上限 ${BUDGET}，停止探测`);
    err.budgetExhausted = true;
    throw err;
  }
  callsUsed++;
  findings.callsUsed = callsUsed;
  return apiRequest(path, { ...opts, accessToken: opts.accessToken, location });
}

const save = () => writeOut("findings-0-2.json", JSON.stringify(findings, null, 2));

process.on("SIGINT", () => {
  console.error("\n\n已中断。保存已获得的部分结论…");
  findings.interrupted = true;
  save();
  process.exit(130);
});

try {
  console.log("\n=== Phase 0-2: API 配额与速率限制 ===");
  console.log(`调用预算: ${BUDGET} 次${PROBE_429 ? "（含 429 阈值探测）" : ""}`);
  console.log("⚠️  本脚本消耗真实 API 配额\n");

  const tok = await refreshAccessToken({ ...cfg, location });
  const accessToken = tok.access_token;

  // ---- 账户与文件夹 ----
  const accountsRes = await call("/api/accounts", { accessToken });
  const accountId = String(accountsRes.parsed?.data?.[0]?.accountId ?? "");
  if (!accountId) throw new Error("拿不到 accountId，先跑 02-account.mjs");

  const foldersRes = await call(`/api/accounts/${accountId}/folders`, { accessToken });
  const folders = foldersRes.parsed?.data ?? [];
  const inbox = folders.find((f) => /^inbox$/i.test(f.folderName)) ?? folders[0];
  if (!inbox) throw new Error("没有可用的文件夹");
  const folderId = String(inbox.folderId);
  findings.probeFolder = { name: inbox.folderName, messageCount: inbox.messageCount ?? null };
  console.log(`探测文件夹: ${inbox.folderName}（${inbox.messageCount ?? "?"} 封）\n`);

  // ---- A. 列表 API 单页上限 ----
  // Zoho 文档给的上限未必等于实际行为，逐档试出来。
  console.log("A. 探测列表分页上限…");
  findings.pageLimits = [];
  for (const limit of [50, 100, 200, 250, 500]) {
    if (callsUsed >= BUDGET) break;
    const res = await call(`/api/accounts/${accountId}/messages/view`, {
      accessToken,
      query: { folderId, limit, start: 1 },
    });
    const returned = Array.isArray(res.parsed?.data) ? res.parsed.data.length : null;
    findings.pageLimits.push({ requested: limit, returned, status: res.status });
    console.log(
      `   limit=${String(limit).padStart(3)} → 返回 ${returned ?? "错误"} 条 (HTTP ${res.status})`,
    );
    if (returned !== null && returned < limit) {
      console.log(`   ↑ 实际上限约为 ${returned}`);
      break;
    }
  }
  const best = findings.pageLimits.filter((p) => p.returned).pop();
  findings.maxPageSize = best?.returned ?? null;

  // ---- B. 取一批 messageId 供后续正文测试 ----
  const listRes = await call(`/api/accounts/${accountId}/messages/view`, {
    accessToken,
    query: { folderId, limit: 25, start: 1 },
  });
  const messages = (listRes.parsed?.data ?? []).map((m) => String(m.messageId)).filter(Boolean);
  if (messages.length === 0) throw new Error("文件夹为空，换一个有邮件的文件夹");

  // ---- C. 顺序取正文的延迟 ----
  console.log("\nB. 顺序取正文的延迟…");
  const contentPath = (id) =>
    `/api/accounts/${accountId}/folders/${folderId}/messages/${id}/content`;

  const seqLatencies = [];
  const sampleSize = Math.min(8, messages.length, Math.max(0, BUDGET - callsUsed - 20));
  for (let i = 0; i < sampleSize; i++) {
    const res = await call(contentPath(messages[i]), { accessToken });
    if (res.ok) seqLatencies.push(res.elapsedMs);
    if (i === 0) {
      findings.contentEndpoint = { path: contentPath("<id>"), status: res.status, ok: res.ok };
      if (!res.ok) {
        console.log(`   ⚠️ 正文接口返回 HTTP ${res.status} —— 路径或 scope 可能不对`);
        break;
      }
    }
  }
  findings.sequentialLatency = summarize(seqLatencies);
  if (findings.sequentialLatency) {
    const s = findings.sequentialLatency;
    console.log(`   n=${s.count}  p50=${s.p50}ms  p95=${s.p95}ms  max=${s.max}ms`);
  }

  // ---- D. 并发 4（计划中的默认值）是否安全 ----
  console.log("\nC. 并发 4 的表现（§14.5 的默认值）…");
  const concurrentCount = Math.min(8, messages.length, Math.max(0, BUDGET - callsUsed - 10));
  if (concurrentCount >= 4) {
    const startedAt = Date.now();
    const tasks = messages
      .slice(0, concurrentCount)
      .map(
        (id) => () => call(contentPath(id), { accessToken }).catch((e) => ({ error: e.message })),
      );
    const results = await runWithConcurrency(tasks, 4);
    const elapsed = Date.now() - startedAt;
    const throttled = results.filter((r) => r?.status === 429).length;
    findings.concurrency4 = {
      requests: concurrentCount,
      elapsedMs: elapsed,
      throttledCount: throttled,
      perRequestMs: Math.round(elapsed / concurrentCount),
      safe: throttled === 0,
    };
    console.log(
      `   ${concurrentCount} 个请求耗时 ${elapsed}ms，429 次数=${throttled}` +
        `${throttled === 0 ? "  → 并发 4 安全" : "  → 需要下调默认并发"}`,
    );
  } else {
    console.log("   预算不足，跳过");
  }

  // ---- E. 429 阈值（可选，会被短暂限流）----
  if (PROBE_429 && callsUsed < BUDGET - 12) {
    console.log("\nD. 探测 429 阈值（会导致短时间限流）…");
    findings.rateLimitProbe = [];
    for (const concurrency of [8, 16]) {
      if (callsUsed >= BUDGET - 4) break;
      const n = Math.min(concurrency, Math.max(0, BUDGET - callsUsed - 2));
      const tasks = Array.from(
        { length: n },
        (_, i) => () =>
          call(contentPath(messages[i % messages.length]), { accessToken }).catch((e) => ({
            error: e.message,
          })),
      );
      const results = await runWithConcurrency(tasks, concurrency);
      const throttled = results.filter((r) => r?.status === 429);
      const retryAfter = throttled
        .map((r) => r.headers?.["retry-after"])
        .find((v) => v !== undefined);
      findings.rateLimitProbe.push({
        concurrency,
        requests: n,
        throttledCount: throttled.length,
        retryAfterHeader: retryAfter ?? null,
      });
      console.log(
        `   并发 ${concurrency}: ${throttled.length}/${n} 被限流` +
          (retryAfter
            ? `，Retry-After=${retryAfter}`
            : throttled.length
              ? "，无 Retry-After 头"
              : ""),
      );
      if (throttled.length > 0) {
        findings.retryAfterPresent = retryAfter !== undefined;
        // 触发限流后停手并等待，不要继续加压
        await sleep(Number(retryAfter ?? 5) * 1000);
        break;
      }
    }
  } else if (!PROBE_429) {
    console.log("\nD. 跳过 429 阈值探测（加 --probe-429 启用）");
  }

  // ---- F. 是否存在批量取正文的接口 ----
  // 如果存在，能同时缓解配额和耗时两个问题，会显著改变 §14 的设计。
  console.log("\nE. 探测批量取正文的可能性…");
  findings.batchFetch = { supported: false, attempts: [] };
  if (callsUsed < BUDGET - 2) {
    // 列表接口是否能直接带回正文？能的话就不必逐封请求
    const res = await call(`/api/accounts/${accountId}/messages/view`, {
      accessToken,
      query: { folderId, limit: 2, start: 1, includeto: "true", attachedMails: "true" },
    });
    const first = res.parsed?.data?.[0] ?? {};
    const bodyish = Object.keys(first).filter((k) => /content|body|html|summary/i.test(k));
    findings.batchFetch.attempts.push({
      approach: "list-with-content-params",
      status: res.status,
      bodyLikeFields: bodyish,
      hasFullBody: bodyish.some((k) => typeof first[k] === "string" && first[k].length > 300),
    });
    findings.batchFetch.supported = findings.batchFetch.attempts.some((a) => a.hasFullBody);
    console.log(
      `   列表接口中的正文类字段: ${bodyish.join(", ") || "无"}` +
        `${findings.batchFetch.supported ? "  → 可能支持批量！" : "  → 仍需逐封请求"}`,
    );
  }

  // ---- G. 推算全量同步成本 ----
  const prior = readOut("findings-0-6.json");
  const usedBytes = prior?.storage?.usedBytes ?? null;
  const totalMessages = folders.reduce((sum, f) => sum + (Number(f.messageCount) || 0), 0) || null;

  const perMessageMs =
    findings.concurrency4?.perRequestMs ?? findings.sequentialLatency?.p50 ?? null;
  if (totalMessages && perMessageMs) {
    // 每封邮件：1 次正文请求；列表请求按每页 maxPageSize 摊
    const listCalls = Math.ceil(totalMessages / (findings.maxPageSize || 200));
    const totalCalls = totalMessages + listCalls;
    findings.fullSyncEstimate = {
      totalMessages,
      listCalls,
      totalApiCalls: totalCalls,
      estimatedMs: totalMessages * perMessageMs,
      estimatedHuman: humanDuration(totalMessages * perMessageMs),
      mailboxUsedBytes: usedBytes,
    };
    console.log("\n──────── 全量同步推算 ────────");
    console.log(`邮件总数        ${totalMessages}`);
    console.log(`预计 API 调用   ${totalCalls} 次`);
    console.log(`预计耗时        ${humanDuration(totalMessages * perMessageMs)}（并发 4）`);
    console.log("──────────────────────────────");
    console.log("\n把这个数字和 Zoho 对你套餐的每日调用上限对比。");
    console.log("如果调用数超过每日上限，必须修订 §3.1 / §8.4 / §14：");
    console.log("  · 默认只同步最近 N 个月");
    console.log("  · 支持跨天续传");
    console.log("  · 或改走 IMAP 批量取正文（见 04-imap.mjs）");
  }

  findings.ok = true;
} catch (err) {
  findings.ok = false;
  findings.error = err.message;
  if (err.budgetExhausted) {
    console.log(`\n⚠️ ${err.message}`);
    console.log("   已获得的结论仍然有效。需要更多数据可加 --budget。");
    findings.ok = true;
  } else {
    console.error(`\n❌ ${err.message}`);
  }
} finally {
  console.log(`\n本次共消耗 ${callsUsed} 次 API 调用`);
  console.log(`结论已写入: ${save()}\n`);
  console.log(
    "⚠️  请到 Zoho 控制台查看你的套餐每日 API 上限，手工填进 findings-0-2.json 的 dailyQuota 字段。",
  );
  process.exit(findings.ok ? 0 : 1);
}
