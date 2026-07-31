/**
 * Fixture 脱敏。
 *
 * Phase 0 采集的真实 Payload 会成为 MockZohoServer 的数据源（实施计划 §23.6），
 * 因此必须提交到公开仓库 —— 也因此必须彻底脱敏。
 *
 * 原则：**一致性替换**。同一个真实地址永远映射到同一个假地址，
 * 这样线程、收发关系、alias 命中等结构在 fixture 中依然成立。
 */

import { createHash } from "node:crypto";

const FAKE_DOMAINS = ["example.com", "example.org", "example.net", "test.invalid"];
const FIRST = ["alex", "blake", "casey", "dana", "eden", "finley", "gray", "harper", "indigo", "jordan"];
const LAST = ["adams", "brooks", "chen", "diaz", "evans", "fisher", "grant", "hayes", "ito", "jones"];

/** 稳定哈希 → 索引，保证同一输入永远得到同一假值。 */
const pick = (list, seed) =>
  list[parseInt(createHash("sha256").update(seed).digest("hex").slice(0, 8), 16) % list.length];

export function createRedactor({ keepDomains = [] } = {}) {
  const emailMap = new Map();
  const tokenPatterns = [];

  return {
    /** 登记需要整体抹掉的敏感字符串（token、secret 等）。 */
    addSecret(value) {
      if (value && String(value).length >= 8) tokenPatterns.push(String(value));
      return this;
    },

    email(addr) {
      if (!addr) return addr;
      const lower = String(addr).toLowerCase();
      if (emailMap.has(lower)) return emailMap.get(lower);
      const [local, domain = ""] = lower.split("@");
      const fake = keepDomains.includes(domain)
        ? `${pick(FIRST, lower)}@${domain}`
        : `${pick(FIRST, lower)}.${pick(LAST, lower + "x")}@${pick(FAKE_DOMAINS, domain)}`;
      emailMap.set(lower, fake);
      return fake;
    },

    /** 对任意文本做全量脱敏：secret → [REDACTED]，邮箱 → 一致假地址。 */
    text(input) {
      if (typeof input !== "string") return input;
      let out = input;
      for (const t of tokenPatterns) out = out.split(t).join("[REDACTED]");
      out = out.replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, (m) => this.email(m));
      return out;
    },

    /** 递归脱敏整个对象。字段名匹配敏感关键字时直接替换为占位符。 */
    object(value) {
      const SENSITIVE_KEY = /token|secret|password|passwd|cookie|authorization|signature/i;
      const walk = (v, key = "") => {
        if (typeof v === "string") {
          if (SENSITIVE_KEY.test(key)) return "[REDACTED]";
          return this.text(v);
        }
        if (Array.isArray(v)) return v.map((x) => walk(x, key));
        if (v && typeof v === "object") {
          return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x, k)]));
        }
        return v;
      };
      return walk(value);
    },

    /** 脱敏映射表，便于人工复核「有没有漏掉的」。 */
    mapping() {
      return Object.fromEntries(emailMap);
    },
  };
}
