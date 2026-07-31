#!/usr/bin/env node

/**
 * Phase 0-4：IMAP + XOAUTH2 可行性探测（限时 2 小时）
 *
 * ## 动机
 *
 * §14 为了同步正确性造了一整套机器 —— 400 封重叠扫描、reconcile 对账、
 * 多字段 checkpoint、「不假设上次时间点之后绝对无遗漏」。这些**全都是在
 * 补偿 REST API 缺少可靠的增量游标**。
 *
 * IMAP 的 UIDVALIDITY + UID 恰好就是为这个问题设计的：
 *
 *   增量同步    UID FETCH <last+1>:*  精确无遗漏，不需要重叠扫描
 *   批量正文    一次 FETCH 取多封，直接缓解 0-2 的配额问题
 *   近实时      IDLE，不需要公网 webhook
 *
 * ## 这一项的结论可能推翻 §4 的「不做通用 IMAP 客户端」
 *
 * 注意不是推翻 REST 方案 —— REST 在 thread ID、label、草稿推送、发送上更好。
 * 可能的结论是**混合方案**：IMAP 负责正文批量同步与增量游标，
 * REST 负责元数据与写操作。
 *
 * ## 安全约束
 *
 * 本脚本操作你的真实邮箱，因此：
 *   - 只用 EXAMINE（只读打开），绝不用 SELECT
 *   - 只用 BODY.PEEK[]，绝不用 BODY[] —— 后者会把邮件标记为已读
 *   - 不发送任何 STORE / EXPUNGE / APPEND
 *
 * 用法：
 *   node spikes/04-imap.mjs
 *   node spikes/04-imap.mjs --fetch 20    # 批量取正文的样本数（默认 10）
 */

import { humanDuration } from "./lib/concurrency.mjs";
import { ImapProbe, parseExamine, xoauth2Token } from "./lib/imap.mjs";
import { refreshAccessToken, resolveRegion } from "./lib/oauth.mjs";
import { loadSecrets, readOut, requireConfig, writeOut } from "./lib/store.mjs";

const argv = process.argv.slice(2);
const flagIdx = argv.indexOf("--fetch");
const FETCH_COUNT = flagIdx >= 0 ? Number(argv[flagIdx + 1] ?? 10) : 10;

const cfg = requireConfig(["clientId", "clientSecret", "refreshToken"]);
const location = process.env.ZMAIL_LOCATION ?? loadSecrets().location ?? "com";
const region = resolveRegion(location);

const findings = { step: "0-4", location, imapHost: region.imap, ok: false };
const save = () => writeOut("findings-0-4.json", JSON.stringify(findings, null, 2));

// ---- 前置检查：02-account 已经告诉我们 IMAP 是否开启 ----
const prior = readOut("findings-0-6.json");
if (prior?.imap?.imapAccessEnabled === false || prior?.imap?.imapBlocked === true) {
  console.log("\n=== Phase 0-4: IMAP 探测 ===\n");
  console.log("❌ 02-account.mjs 已报告该账户的 IMAP 未启用：");
  console.log(
    `   imapAccessEnabled=${prior.imap.imapAccessEnabled} imapBlocked=${prior.imap.imapBlocked}`,
  );
  console.log("\n结论：IMAP 方案不可行，§4「不做通用 IMAP 客户端」维持不变。");
  console.log("省下 2 小时。REST 方案继续，但 0-2 的配额结论就更关键了。\n");
  findings.ok = true;
  findings.verdict = "imap-disabled-on-account";
  findings.skippedReason = "02-account.mjs 报告 IMAP 未启用";
  console.log(`结论已写入: ${save()}\n`);
  process.exit(0);
}

let imap;

try {
  console.log("\n=== Phase 0-4: IMAP + XOAUTH2 可行性探测 ===");
  console.log(`目标: ${region.imap}:993`);
  console.log("只读模式：EXAMINE + BODY.PEEK[]，不会把任何邮件标记为已读\n");

  // ---- 拿 access token 和主邮箱地址 ----
  const tok = await refreshAccessToken({ ...cfg, location });
  const accessToken = tok.access_token;

  const accountsRes = await fetch(`${region.mail}/api/accounts`, {
    headers: { authorization: `Zoho-oauthtoken ${accessToken}` },
  });
  const accountsJson = await accountsRes.json();
  const account = accountsJson?.data?.[0];
  const loginEmail = account?.primaryEmailAddress ?? account?.mailboxAddress;
  if (!loginEmail) throw new Error("拿不到主邮箱地址，先跑 02-account.mjs");
  findings.scopesUsed = tok.scope ?? null;

  // ---- 1. 连接 ----
  imap = new ImapProbe({ host: region.imap });
  const t0 = Date.now();
  await imap.connect();
  findings.connect = { ok: true, elapsedMs: Date.now() - t0 };
  console.log(`1. TLS 连接成功 (${findings.connect.elapsedMs}ms)`);

  // ---- 2. CAPABILITY ----
  const cap = await imap.send("CAPABILITY");
  const capLine = cap.lines.find((l) => l.startsWith("* CAPABILITY")) ?? "";
  const capabilities = capLine.replace("* CAPABILITY", "").trim().split(/\s+/);
  findings.capabilities = capabilities;
  findings.supportsXoauth2 = capabilities.includes("AUTH=XOAUTH2");
  findings.supportsIdle = capabilities.includes("IDLE");
  findings.supportsCondstore = capabilities.includes("CONDSTORE");
  console.log(`2. CAPABILITY: ${capabilities.length} 项`);
  console.log(`   AUTH=XOAUTH2  ${findings.supportsXoauth2 ? "✅" : "❌"}`);
  console.log(`   IDLE          ${findings.supportsIdle ? "✅ 可做近实时推送" : "❌"}`);
  console.log(`   CONDSTORE     ${findings.supportsCondstore ? "✅ 可做增量标志同步" : "❌"}`);

  if (!findings.supportsXoauth2) {
    throw new Error(
      "服务器不支持 AUTH=XOAUTH2，无法复用 OAuth token（需要应用专用密码，不可接受）",
    );
  }

  // ---- 3. XOAUTH2 认证 ----
  const authT0 = Date.now();
  try {
    await imap.send(`AUTHENTICATE XOAUTH2 ${xoauth2Token(loginEmail, accessToken)}`, {
      // 失败时服务器会先发 continuation，需要回一个空行才能拿到 NO
      onContinuation: () => imap.writeRaw(""),
    });
    findings.authenticate = { ok: true, elapsedMs: Date.now() - authT0 };
    console.log(
      `3. XOAUTH2 认证成功 (${findings.authenticate.elapsedMs}ms) —— OAuth token 可直接复用`,
    );
  } catch (err) {
    findings.authenticate = { ok: false, error: err.message };
    console.log(`3. ❌ XOAUTH2 认证失败: ${err.message}`);
    console.log("   常见原因：当前 scope 不含 IMAP 权限，或账户未开启 IMAP 访问");
    throw err;
  }

  // ---- 4. LIST：能看到哪些邮箱 ----
  const list = await imap.send('LIST "" "*"');
  const mailboxes = list.lines
    .filter((l) => l.startsWith("* LIST"))
    .map((l) => l.match(/"([^"]*)"\s*$/)?.[1] ?? l)
    .filter(Boolean);
  findings.mailboxes = mailboxes;
  console.log(
    `4. LIST: ${mailboxes.length} 个邮箱 —— ${mailboxes.slice(0, 6).join(", ")}${mailboxes.length > 6 ? " …" : ""}`,
  );

  // ---- 5. EXAMINE INBOX（只读）----
  const examine = await imap.send("EXAMINE INBOX");
  // [READ-ONLY] 出现在 tagged 响应行（"A005 OK [READ-ONLY] ..."），
  // 只传 untagged 行会漏掉它，导致下面的只读断言恒为假。
  const state = parseExamine([...examine.lines, `* OK ${examine.text}`]);
  findings.inbox = state;
  console.log(`5. EXAMINE INBOX（只读=${state.readOnly ? "是" : "否"}）`);
  console.log(`   EXISTS       ${state.exists}`);
  console.log(`   UIDVALIDITY  ${state.uidValidity}   ← 增量同步的锚点`);
  console.log(`   UIDNEXT      ${state.uidNext}       ← 下次从这里开始拉`);

  if (!state.readOnly) {
    // EXAMINE 理应只读；不是的话说明服务器行为异常，后续实现必须格外小心
    console.log("   ⚠️ 服务器未把会话标为 READ-ONLY，实现时需要额外防护");
  }

  // ---- 6. 批量取正文的吞吐（BODY.PEEK，不标记已读）----
  if (state.exists > 0) {
    const count = Math.min(FETCH_COUNT, state.exists);
    const startSeq = Math.max(1, state.exists - count + 1);
    console.log(`\n6. 批量取正文：一次 FETCH 取 ${count} 封（BODY.PEEK，不改已读状态）…`);

    const fetchT0 = Date.now();
    const fetched = await imap.send(
      `${startSeq}:${state.exists} FETCH (UID RFC822.SIZE BODY.PEEK[])`,
    );
    const elapsed = Date.now() - fetchT0;

    const uids = fetched.lines.flatMap((l) => {
      const m = /UID (\d+)/.exec(l);
      return m ? [m[1]] : [];
    });
    const bytes = fetched.lines.reduce((sum, l) => sum + l.length, 0);

    findings.batchFetch = {
      requested: count,
      uidsSeen: uids.length,
      elapsedMs: elapsed,
      perMessageMs: Math.round(elapsed / count),
      approxBytes: bytes,
      singleRoundTrip: true,
    };
    console.log(`   ${count} 封 / ${elapsed}ms = 每封 ${Math.round(elapsed / count)}ms`);
    console.log(`   ✅ 一次往返取回 ${uids.length} 封的正文 —— REST 需要 ${count} 次请求`);

    // ---- 7. UID 增量同步验证 ----
    if (uids.length >= 2) {
      const sorted = [...uids].map(Number).sort((a, b) => a - b);
      const from = sorted[Math.floor(sorted.length / 2)];
      const incr = await imap.send(`UID FETCH ${from}:* (UID)`);
      const incrUids = incr.lines.flatMap((l) => {
        const m = /UID (\d+)/.exec(l);
        return m ? [Number(m[1])] : [];
      });
      findings.incrementalSync = {
        anchorUid: String(from),
        returned: incrUids.length,
        allAtOrAboveAnchor: incrUids.every((u) => u >= from),
        works: incrUids.length > 0 && incrUids.every((u) => u >= from),
      };
      console.log(
        `\n7. 增量同步 UID FETCH ${from}:* → 返回 ${incrUids.length} 封，` +
          `全部 >= 锚点: ${findings.incrementalSync.allAtOrAboveAnchor ? "✅" : "❌"}`,
      );
      console.log("   这就是 §14.3 那 400 封重叠扫描想要解决的问题，IMAP 免费提供");
    }
  }

  // ---- 8. 与 REST 方案的对比推算 ----
  const quota = readOut("findings-0-2.json");
  const totalMessages = quota?.fullSyncEstimate?.totalMessages ?? null;
  if (totalMessages && findings.batchFetch) {
    const imapMs = totalMessages * findings.batchFetch.perMessageMs;
    const restMs = quota.fullSyncEstimate.estimatedMs;
    const restCalls = quota.fullSyncEstimate.totalApiCalls;
    // IMAP 按每批 count 封算往返次数
    const imapRoundTrips = Math.ceil(totalMessages / findings.batchFetch.requested);

    findings.comparison = {
      totalMessages,
      rest: { apiCalls: restCalls, estimatedMs: restMs, human: humanDuration(restMs) },
      imap: { roundTrips: imapRoundTrips, estimatedMs: imapMs, human: humanDuration(imapMs) },
      speedup: Number((restMs / imapMs).toFixed(1)),
    };

    console.log("\n──────── REST vs IMAP ────────");
    console.log(`邮件总数      ${totalMessages}`);
    console.log(`REST          ${restCalls} 次调用，${humanDuration(restMs)}`);
    console.log(`IMAP          ${imapRoundTrips} 次往返，${humanDuration(imapMs)}`);
    console.log(`加速比        ${findings.comparison.speedup}×`);
    console.log("──────────────────────────────");
  } else {
    console.log("\n（先跑 03-quota.mjs 才能做 REST vs IMAP 的对比推算）");
  }

  // ---- 结论 ----
  findings.verdict =
    findings.supportsXoauth2 && findings.authenticate?.ok && findings.incrementalSync?.works
      ? "viable-hybrid-recommended"
      : "partial";
  findings.ok = true;

  console.log("\n──────── 结论 ────────");
  if (findings.verdict === "viable-hybrid-recommended") {
    console.log("✅ IMAP + XOAUTH2 可行，且 UID 增量同步成立。");
    console.log("");
    console.log("建议修订实施计划：");
    console.log("  · §4  移除或限定「不做通用 IMAP 客户端」这条非目标");
    console.log("  · §14 改为混合方案：IMAP 负责正文批量同步与增量游标");
    console.log("  · §14.3 的 400 封重叠扫描可由 UID FETCH 取代");
    console.log("  · §14.7 的对账逻辑大幅简化（UID 天然反映删除与移动）");
    console.log("  · REST 保留用于：账户/身份发现、thread、label、草稿、发送");
    if (findings.supportsIdle) {
      console.log("  · IDLE 可选：近实时推送，且不需要公网 webhook（§4 仍然成立）");
    }
  } else {
    console.log("⚠️ 部分可行，细节见 findings-0-4.json。");
  }
} catch (err) {
  findings.ok = false;
  findings.error = err.message;
  findings.verdict = "not-viable";
  console.error(`\n❌ ${err.message}`);
  console.log("\n结论：IMAP 方案不可行，§4 与 §14 维持 REST 方案不变。");
  console.log("此时 0-2 的配额结论就成为决定 MVP 形态的关键。");
} finally {
  await imap?.logout();
  console.log(`\n结论已写入: ${save()}\n`);
  process.exit(findings.ok ? 0 : 1);
}
