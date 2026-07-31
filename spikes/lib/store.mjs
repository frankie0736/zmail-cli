/**
 * Spike 专用的本地状态存储。
 *
 * ⚠️ 这不是最终实现。正式版凭据进 Keychain / FileSecretStore（实施计划 §9）。
 * spike 阶段为了让流程可复现、可反复调试，把 refresh token 明文存在
 * spikes/.secrets.json（已 gitignore，权限 0600）。
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SPIKE_DIR = dirname(dirname(fileURLToPath(import.meta.url)));
const SECRETS_PATH = join(SPIKE_DIR, ".secrets.json");
export const OUT_DIR = join(SPIKE_DIR, "out");

/** @returns {Record<string, any>} */
export function loadSecrets() {
  if (!existsSync(SECRETS_PATH)) return {};
  return JSON.parse(readFileSync(SECRETS_PATH, "utf8"));
}

/** @param {Record<string, any>} patch */
export function saveSecrets(patch) {
  const merged = { ...loadSecrets(), ...patch };
  writeFileSync(SECRETS_PATH, JSON.stringify(merged, null, 2), { mode: 0o600 });
  chmodSync(SECRETS_PATH, 0o600);
  return merged;
}

/**
 * 写一份 spike 产物到 spikes/out/。
 * @param {string} name 文件名
 * @param {string} content 内容
 */
export function writeOut(name, content) {
  mkdirSync(OUT_DIR, { recursive: true, mode: 0o700 });
  const p = join(OUT_DIR, name);
  writeFileSync(p, content, { mode: 0o600 });
  return p;
}

/** 从环境变量或 .secrets.json 读取必需配置，缺失则给出可操作的报错。 */
export function requireConfig(keys) {
  const secrets = loadSecrets();
  const out = {};
  const missing = [];
  for (const k of keys) {
    const envKey = `ZMAIL_${k.replace(/([a-z])([A-Z])/g, "$1_$2").toUpperCase()}`;
    const v = process.env[envKey] ?? secrets[k];
    if (!v) missing.push(`${k}  (环境变量 ${envKey}，或 spikes/.secrets.json 中的 "${k}")`);
    else out[k] = v;
  }
  if (missing.length) {
    console.error(`\n缺少必需配置：\n  ${missing.join("\n  ")}`);
    console.error("\n请先阅读 spikes/README.md 完成 Zoho API Console 注册。\n");
    process.exit(2);
  }
  return out;
}
