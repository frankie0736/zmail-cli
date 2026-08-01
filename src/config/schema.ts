/**
 * config.json 的 schema。实施计划 §8.4。
 *
 * 铁律：配置里**只**保存非敏感信息和凭据引用。
 * Client ID / Secret / Refresh Token 一律进 SecretStore，绝不落这里。
 */

import { z } from "zod";

/** config.json 的 schema 版本。结构不兼容变更时递增。 */
export const CONFIG_SCHEMA_VERSION = 1;

/** Zoho 数据中心。域名解析集中在 ZohoRegionResolver，禁止散落硬编码（§10.4）。 */
export const zohoLocationSchema = z.enum(["com", "eu", "in", "com.cn", "com.au", "jp"]);
export type ZohoLocation = z.infer<typeof zohoLocationSchema>;

export const syncConfigSchema = z.object({
  includeFolders: z.array(z.string()).default(["Inbox", "Sent", "Archive"]),
  excludeFolders: z.array(z.string()).default(["Spam", "Trash"]),
  bodyMode: z.enum(["full", "summary", "none"]).default("full"),
  attachmentMode: z.enum(["metadata", "auto", "none"]).default("metadata"),
  maxAutoDownloadMb: z.number().int().positive().max(500).default(10),
  /** Quick Sync 的重叠扫描深度（§14.3）。 */
  quickScanLimit: z.number().int().positive().max(5000).default(400),
  /** 正文请求并发。设上限，防止 Agent 把并发调爆触发限流（§14.5）。 */
  contentConcurrency: z.number().int().positive().max(16).default(4),
  attachmentConcurrency: z.number().int().positive().max(8).default(2),
  /** 只同步该日期之后的邮件。配额受限时的降级手段（§25 Phase 0-2）。 */
  since: z.string().datetime({ offset: true }).nullable().default(null),
});

/** 存储策略（§12.1 / §15.5）。 */
export const storageConfigSchema = z.object({
  keepRawJson: z.enum(["always", "recent", "never"]).default("recent"),
  keepRawJsonDays: z.number().int().positive().default(30),
  keepBodyHtml: z.boolean().default(true),
  attachmentQuotaGb: z.number().positive().default(20),
  attachmentEvictionPolicy: z.enum(["lru", "none"]).default("lru"),
});

export const profileSchema = z.object({
  email: z.email(),
  zohoLocation: zohoLocationSchema.default("com"),
  /** Zoho 的 ID 一律当作不透明字符串，不做数学运算（§11.3）。 */
  accountId: z.string().nullable().default(null),
  accountsBaseUrl: z.url(),
  mailApiBaseUrl: z.url(),
  /**
   * SecretStore 中该 profile 凭据的 service 名，不含凭据本身。
   *
   * 用项目名而不是维护者的个人标识：用户在「钥匙串访问」里看到的
   * 应该是他们装的这个工具，而不是某个陌生人的名字。
   */
  keychainService: z.string().default("zmail-cli"),
  /** 授权时实际获得的 scope，用于在调用前预判权限不足。 */
  grantedScopes: z.array(z.string()).default([]),
  sync: syncConfigSchema.prefault({}),
  storage: storageConfigSchema.prefault({}),
});

export type Profile = z.infer<typeof profileSchema>;

export const configSchema = z.object({
  schemaVersion: z.number().int().positive().default(CONFIG_SCHEMA_VERSION),
  defaultProfile: z.string().default("primary"),
  profiles: z.record(z.string(), profileSchema).default({}),
  /** 凭据后端覆盖。留空则按平台自动选择（§9.5.1）。 */
  secretBackend: z.enum(["keychain", "file"]).nullable().default(null),
});

export type Config = z.infer<typeof configSchema>;

/** 全新安装的默认配置。不含任何 profile —— profile 由 auth login 创建。 */
export function defaultConfig(): Config {
  return configSchema.parse({});
}

/**
 * 校验并归一化配置。
 *
 * 拒绝比当前代码更新的 schema：老版本 CLI 不该猜新格式的语义，
 * 静默降级可能损坏数据。
 */
export function parseConfig(raw: unknown): Config {
  const parsed = configSchema.parse(raw);
  if (parsed.schemaVersion > CONFIG_SCHEMA_VERSION) {
    throw new Error(
      `config.json 的 schemaVersion 是 ${parsed.schemaVersion}，` +
        `而当前 zmail 只支持到 ${CONFIG_SCHEMA_VERSION}。请升级 zmail-cli。`,
    );
  }
  return parsed;
}
