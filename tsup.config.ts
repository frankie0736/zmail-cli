import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/cli.ts"],
  format: ["esm"],
  target: "node22",
  platform: "node",
  outDir: "dist",
  clean: true,
  sourcemap: true,
  // better-sqlite3 是原生模块，绝不能被打进 bundle
  external: ["better-sqlite3"],
  // 不加 banner：src/cli.ts 里已经有 shebang，tsup 会原样保留。
  // 两处都写会产生两行 shebang，第二行是语法错误 —— 而且只有构建产物会坏，
  // tsx 跑源码时看不出来。由 scripts/smoke-install.mjs 守住。

  // migrations/ 以文件形式随包分发（package.json files），在运行时按路径读取，
  // 不进 bundle —— 这样 SQL 可以被用户和贡献者直接阅读、diff。
});
