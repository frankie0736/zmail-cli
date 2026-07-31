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
const REPO_ROOT = dirname(SPIKE_DIR);
const SECRETS_PATH = join(SPIKE_DIR, ".secrets.json");
export const OUT_DIR = join(SPIKE_DIR, "out");

/**
 * 自动加载 .env。
 *
 * 优先级：shell 环境变量 > spikes/.env > <repo>/.env > .secrets.json
 *
 * `process.loadEnvFile` 不会覆盖 process.env 中已存在的键，所以先加载的文件
 * 优先级更高 —— spikes/.env 更靠近脚本，视为更具体的配置。
 */
function autoLoadEnvFiles() {
  const loaded = [];
  for (const candidate of [join(SPIKE_DIR, ".env"), join(REPO_ROOT, ".env")]) {
    if (!existsSync(candidate)) continue;
    try {
      process.loadEnvFile(candidate);
      loaded.push(candidate);
    } catch (err) {
      console.error(`⚠️  无法解析 ${candidate}: ${err.message}`);
    }
  }

  // 两份凭据文件是真实隐患：轮换了一个忘了另一个，排查起来毫无头绪
  if (loaded.length > 1) {
    console.error("⚠️  检测到多个 .env 文件，凭据存在两处容易不同步：");
    for (const p of loaded) console.error(`     ${p}`);
    console.error(`   当前生效的是 ${loaded[0]}，建议删掉其余的。\n`);
  }
  return loaded;
}

const loadedEnvFiles = autoLoadEnvFiles();

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

/**
 * 读回一份先前 spike 的产物。
 * 让后续脚本能复用前面的结论（例如 0-2 用 0-6 报告的邮箱体积做推算）。
 * @param {string} name 文件名
 * @returns {any | null} 不存在或无法解析时返回 null
 */
export function readOut(name) {
  const p = join(OUT_DIR, name);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}

/** 从环境变量、.env 或 .secrets.json 读取必需配置，缺失则给出可操作的报错。 */
export function requireConfig(keys) {
  const secrets = loadSecrets();
  const out = {};
  const missing = [];
  for (const k of keys) {
    const envKey = `ZMAIL_${k.replace(/([a-z])([A-Z])/g, "$1_$2").toUpperCase()}`;
    const v = process.env[envKey] ?? secrets[k];
    if (!v) missing.push({ key: k, envKey });
    else out[k] = v;
  }

  if (missing.length) {
    console.error("\n缺少必需配置：");
    for (const m of missing) console.error(`  ${m.envKey}`);

    console.error("\n可以放在以下任一位置（优先级从高到低）：");
    console.error("  1. shell 环境变量");
    console.error(`  2. ${join(SPIKE_DIR, ".env")}`);
    console.error(`  3. ${join(REPO_ROOT, ".env")}`);
    console.error(`  4. ${SECRETS_PATH}（JSON，键名为 ${missing.map((m) => m.key).join(" / ")}）`);

    if (loadedEnvFiles.length > 0) {
      console.error(`\n已加载的 .env：${loadedEnvFiles.join(", ")}`);
      console.error("  文件读到了，但里面没有上面这些键 —— 检查拼写。");
    } else {
      console.error("\n未找到任何 .env 文件。");
    }

    console.error("\n.env 格式示例（无引号、无 export）：");
    console.error("  ZMAIL_CLIENT_ID=1000.XXXXXXXX");
    console.error("  ZMAIL_CLIENT_SECRET=xxxxxxxx");
    console.error("  ZMAIL_LOCATION=com");
    console.error("\n详见 spikes/README.md。\n");
    process.exit(2);
  }
  return out;
}
