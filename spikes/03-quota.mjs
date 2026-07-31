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
  // 注意：folders 接口**不返回** messageCount。实测可用字段为
  // path / VW / HIDE / isArchived / folderIcon / folderName / imapAccess / folderType / URI / folderId
  findings.probeFolder = { name: inbox.folderName, availableFields: Object.keys(inbox) };
  console.log(`探测文件夹: ${inbox.folderName}\n`);

  // ---- A. 列表 API 单页上限 ----
  // Zoho 文档给的上限未必等于实际行为，逐档试出来。
  console.log("A. 探测列表分页上限…");
  findings.pageLimits = [];
  let previousReturned = null;
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
    if (returned === null) break;

    // 「返回条数 < 请求条数」有两种截然不同的原因：
    //   a) 服务端分页上限就是这么多  → 这才是我们要测的
    //   b) 文件夹里根本没那么多邮件  → 与分页上限无关
    // 区分方法：提高 limit 后返回条数是否随之增长。不增长说明是 (b)。
    if (returned < limit) {
      if (previousReturned !== null && returned === previousReturned) {
        findings.pageSizeReliable = true;
        findings.maxPageSize = returned;
        console.log(`   ↑ 提高 limit 后返回数不变，分页上限确认为 ${returned}`);
      } else if (previousReturned === null) {
        // 第一档就没填满，继续抬高 limit 才能区分 (a) 和 (b)
        previousReturned = returned;
        continue;
      } else {
        findings.pageSizeReliable = true;
        findings.maxPageSize = returned;
      }
      break;
    }
    previousReturned = returned;
  }

  if (findings.maxPageSize === undefined) {
    const filled = findings.pageLimits.filter((p) => p.returned === p.requested).pop();
    if (filled) {
      // 所有档位都被填满 → 上限至少是最后一档，但没测到天花板
      findings.maxPageSize = filled.requested;
      findings.pageSizeReliable = false;
      console.log(`   所有档位都填满，分页上限 >= ${filled.requested}（未触及天花板）`);
    } else {
      const returned = findings.pageLimits.at(-1)?.returned ?? null;
      findings.maxPageSize = null;
      findings.pageSizeReliable = false;
      findings.pageSizeNote = `文件夹只有约 ${returned} 封邮件，不足以测出分页上限`;
      console.log(`   ⚠️ 文件夹只有约 ${returned} 封，测不出分页上限 —— 需要更大的邮箱重测`);
    }
  }

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
  // 不去数当前邮箱有多少封 —— 数一遍本身就要遍历全部分页，代价和同步差不多，
  // 而且当前体量未必代表将来。改为按若干假设规模给出推算表。
  const prior = readOut("findings-0-6.json");
  const perMessageMs =
    findings.concurrency4?.perRequestMs ?? findings.sequentialLatency?.p50 ?? null;

  if (perMessageMs) {
    const pageSize = findings.maxPageSize || 200;
    findings.fullSyncEstimate = {
      perMessageMs,
      assumedPageSize: pageSize,
      pageSizeIsReliable: findings.pageSizeReliable === true,
      mailboxUsedKb: prior?.storage?.usedKb ?? null,
      scenarios: [1_000, 10_000, 50_000, 100_000].map((n) => ({
        messages: n,
        apiCalls: n + Math.ceil(n / pageSize),
        estimatedMs: n * perMessageMs,
        estimatedHuman: humanDuration(n * perMessageMs),
      })),
    };

    console.log("\n──────── 全量同步推算（并发 4）────────");
    console.log("   邮件数     API 调用          耗时");
    for (const s of findings.fullSyncEstimate.scenarios) {
      console.log(
        `  ${String(s.messages).padStart(7)}  ${String(s.apiCalls).padStart(9)}  ${s.estimatedHuman.padStart(12)}`,
      );
    }
    console.log("────────────────────────────────────────");
    if (!findings.pageSizeReliable) {
      console.log(`⚠️ 分页上限未测出（邮件太少），上表按假设的 ${pageSize} 计算。`);
    }
    console.log("\n把 API 调用数与你套餐的每日上限对比。超出则必须修订 §3.1 / §8.4 / §14：");
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
