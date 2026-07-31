import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // live 测试需要真实 Zoho 凭据，默认排除（实施计划 §23.6）。
    // 显式运行：ZMAIL_LIVE_TEST=1 vitest run test/live
    exclude: process.env.ZMAIL_LIVE_TEST ? [] : ["test/live/**"],
    environment: "node",
    // 每个测试文件用独立进程，避免 better-sqlite3 句柄与 umask 互相污染
    pool: "forks",
  },
});
