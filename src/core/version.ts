/**
 * 版本信息。
 *
 * `zmail --version` 同时输出包版本、数据库 schema 版本和索引规范化版本 ——
 * 三者解耦，排查问题时缺一不可（实施计划 §23.4）。
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { NORMALIZER_VERSION } from "../mail/normalize-for-index.js";

export interface VersionInfo {
  version: string;
  schemaVersion: number;
  indexNormalizerVersion: number;
  node: string;
  platform: string;
}

let cachedPackageVersion: string | undefined;

/** 从 package.json 读版本。开发布局与安装布局都要能找到。 */
export function packageVersion(fromUrl = import.meta.url): string {
  if (cachedPackageVersion) return cachedPackageVersion;
  const here = dirname(fileURLToPath(fromUrl));
  for (const candidate of [
    join(here, "..", "..", "package.json"), // src/core/version.ts
    join(here, "..", "package.json"), // dist/cli.js
  ]) {
    try {
      const pkg = JSON.parse(readFileSync(candidate, "utf8")) as { version?: string };
      if (pkg.version) {
        cachedPackageVersion = pkg.version;
        return pkg.version;
      }
    } catch {
      // 换下一个候选路径
    }
  }
  cachedPackageVersion = "0.0.0-unknown";
  return cachedPackageVersion;
}

export function versionInfo(schemaVersion: number): VersionInfo {
  return {
    version: packageVersion(),
    schemaVersion,
    indexNormalizerVersion: NORMALIZER_VERSION,
    node: process.version,
    platform: `${process.platform}-${process.arch}`,
  };
}
