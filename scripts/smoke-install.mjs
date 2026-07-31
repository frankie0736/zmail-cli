#!/usr/bin/env node
/**
 * 全局安装冒烟测试。实施计划 §22.6。
 *
 * 必须在 CI 中跑，不能只在本机跑 —— 本机永远装着 Xcode CLT，
 * 测不出真实用户在缺少构建工具时的失败。
 *
 * 验证：
 *   - npm pack 的文件清单不含 §7.3 的禁止内容
 *   - 全局安装后 zmail 在 PATH 中可用
 *   - 数据写入用户目录，不是包目录
 *   - 卸载后数据仍然存在
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const repoRoot = process.cwd();
let failures = 0;

const check = (name, ok, extra = "") => {
  console.log(`${ok ? "✅" : "❌"} ${name}${extra ? ` — ${extra}` : ""}`);
  if (!ok) failures++;
};

const sh = (cmd, args, opts = {}) =>
  execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...opts });

const workDir = mkdtempSync(join(tmpdir(), "zmail-smoke-"));
const prefix = join(workDir, "npm-prefix");
const fakeHome = join(workDir, "home");
const dataDir = join(fakeHome, ".zmail");

console.log(`工作目录: ${workDir}\n`);

try {
  // ---- 1. 构建并打包 ----
  console.log("构建…");
  sh("npm", ["run", "build"], { cwd: repoRoot });

  const packOut = sh("npm", ["pack", "--json"], { cwd: repoRoot });
  const packInfo = JSON.parse(packOut)[0];
  const tarball = join(repoRoot, packInfo.filename);
  check("npm pack 成功", existsSync(tarball), packInfo.filename);

  // ---- 2. 包内容审计（§7.3 禁止清单）----
  const files = packInfo.files.map((f) => f.path);
  const forbidden = files.filter((f) =>
    /(^|\/)(\.env|\.secrets\.json|spikes\/|test\/|docs\/|.*\.log|.*\.sqlite3?)$/i.test(f),
  );
  check("包内无禁止文件", forbidden.length === 0, forbidden.join(", ") || "clean");

  const required = ["package.json", "dist/cli.js", "README.md", "LICENSE"];
  const missingRequired = required.filter((r) => !files.includes(r));
  check("包含必需文件", missingRequired.length === 0, missingRequired.join(", ") || "ok");

  const hasMigrations = files.some((f) => f.startsWith("migrations/"));
  check(
    "migrations 随包分发",
    hasMigrations,
    `${files.filter((f) => f.startsWith("migrations/")).length} 个`,
  );

  // 包里绝不能出现真实邮箱地址
  const tarText = readFileSync(tarball).toString("latin1");
  const emailHits = [...tarText.matchAll(/[\w.+-]+@[\w-]+\.[a-z]{2,}/gi)]
    .map((m) => m[0])
    .filter((e) => !/example\.(com|org|net)|test\.invalid|\.local$/i.test(e));
  check(
    "包内无非示例邮箱地址",
    emailHits.length === 0,
    [...new Set(emailHits)].slice(0, 5).join(", "),
  );

  const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
  check("无 postinstall 脚本", !pkg.scripts?.postinstall && !pkg.scripts?.preinstall);

  // ---- 3. 全局安装到隔离 prefix ----
  console.log("\n全局安装…");
  const env = { ...process.env, npm_config_prefix: prefix, HOME: fakeHome, USERPROFILE: fakeHome };
  sh("npm", ["install", "-g", tarball], { env, cwd: workDir });

  const binName = process.platform === "win32" ? "zmail.cmd" : "zmail";
  const binPath = join(prefix, process.platform === "win32" ? "" : "bin", binName);
  check("zmail 已安装到 prefix", existsSync(binPath), binPath);

  const zmail = (...args) => sh(binPath, args, { env, cwd: workDir });

  // ---- 4. 基本命令 ----
  const versionOut = zmail("version", "--json");
  const versionEnv = JSON.parse(versionOut);
  check("zmail version --json 输出合法 envelope", versionEnv.ok === true, versionEnv.data?.version);

  zmail("init", "--json");
  check("数据写入用户 HOME 而非包目录", existsSync(join(dataDir, "mail.sqlite3")), dataDir);
  check(
    "包目录未被写入数据",
    !existsSync(join(prefix, "lib", "node_modules", "zmail-cli", "mail.sqlite3")),
  );

  const doctorEnv = JSON.parse(zmail("doctor", "--json"));
  const errors = (doctorEnv.data?.checks ?? []).filter((c) => c.status === "error");
  check("doctor 无 error 级问题", errors.length === 0, errors.map((e) => e.name).join(", "));

  // 参数错误必须仍返回合法 JSON（§17.3）
  let usageOut = "";
  let usageCode = 0;
  try {
    usageOut = zmail("--badflag", "--json");
  } catch (err) {
    usageOut = err.stdout ?? "";
    usageCode = err.status;
  }
  const usageEnv = JSON.parse(usageOut);
  check(
    "参数错误返回合法 error envelope",
    usageEnv.ok === false && usageEnv.error?.code === "INVALID_ARGUMENT",
  );
  check("参数错误退出码为 2", usageCode === 2, String(usageCode));

  // ---- 5. 卸载后数据仍在（§7.4）----
  console.log("\n卸载…");
  sh("npm", ["uninstall", "-g", "zmail-cli"], { env, cwd: workDir });
  check("卸载后 zmail 已移除", !existsSync(binPath));
  check("卸载后用户数据仍然存在", existsSync(join(dataDir, "mail.sqlite3")));

  rmSync(tarball, { force: true });
} catch (err) {
  console.error(`\n冒烟测试异常中止: ${err.message}`);
  if (err.stdout) console.error(`stdout: ${err.stdout}`);
  if (err.stderr) console.error(`stderr: ${err.stderr}`);
  failures++;
} finally {
  rmSync(workDir, { recursive: true, force: true });
}

console.log(`\n${failures === 0 ? "全部通过" : `${failures} 项失败`}`);
process.exit(failures === 0 ? 0 : 1);
