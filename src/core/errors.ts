/**
 * 错误码、退出码与错误类型。
 *
 * 实施计划 §17.4。退出码是 Agent 的一等契约：Agent 靠它分类失败，
 * 因此每个可预见的失败都必须映射到具体码，绝不能落到兜底的 1。
 */

/** 退出码。删除或改变含义属于 breaking change。 */
export const ExitCode = {
  OK: 0,
  /** 未预期的内部错误。兜底，不应出现在正常路径。 */
  INTERNAL: 1,
  /** 参数错误，含 Commander 解析失败。 */
  USAGE: 2,
  NOT_FOUND: 3,
  NOT_INITIALIZED: 4,
  UNAUTHORIZED: 5,
  NETWORK: 6,
  ZOHO_API: 7,
  RATE_LIMITED: 8,
  DATABASE: 9,
  SYNC_LOCKED: 10,
  APPROVAL_REQUIRED: 11,
  INSUFFICIENT_SCOPE: 12,
  INCOMPLETE_DATA: 13,
  /** 凭据后端不可用或解密失败。 */
  SECRET_BACKEND: 14,
} as const;

export type ExitCodeValue = (typeof ExitCode)[keyof typeof ExitCode];

/**
 * 稳定的错误码。Agent 按 `code` 分支，不解析 `message`。
 * 新增码是兼容变更；删除或改变语义是 breaking change。
 */
export const ErrorCode = {
  INTERNAL: "INTERNAL",
  INVALID_ARGUMENT: "INVALID_ARGUMENT",
  NOT_FOUND: "NOT_FOUND",
  NOT_INITIALIZED: "NOT_INITIALIZED",
  ALREADY_INITIALIZED: "ALREADY_INITIALIZED",

  AUTH_REQUIRED: "AUTH_REQUIRED",
  AUTH_PASSPHRASE_REQUIRED: "AUTH_PASSPHRASE_REQUIRED",
  SECRET_BACKEND_UNAVAILABLE: "SECRET_BACKEND_UNAVAILABLE",
  SECRET_DECRYPT_FAILED: "SECRET_DECRYPT_FAILED",
  SECRET_NOT_FOUND: "SECRET_NOT_FOUND",

  NETWORK_ERROR: "NETWORK_ERROR",
  ZOHO_API_ERROR: "ZOHO_API_ERROR",
  RATE_LIMITED: "RATE_LIMITED",
  INSUFFICIENT_SCOPE: "INSUFFICIENT_SCOPE",

  DATABASE_ERROR: "DATABASE_ERROR",
  MIGRATION_FAILED: "MIGRATION_FAILED",
  SCHEMA_TOO_NEW: "SCHEMA_TOO_NEW",

  SYNC_LOCKED: "SYNC_LOCKED",
  APPROVAL_REQUIRED: "APPROVAL_REQUIRED",
  INCOMPLETE_DATA: "INCOMPLETE_DATA",

  CONFIG_INVALID: "CONFIG_INVALID",
  PROFILE_NOT_FOUND: "PROFILE_NOT_FOUND",
} as const;

export type ErrorCodeValue = (typeof ErrorCode)[keyof typeof ErrorCode];

const EXIT_BY_CODE: Record<ErrorCodeValue, ExitCodeValue> = {
  INTERNAL: ExitCode.INTERNAL,
  INVALID_ARGUMENT: ExitCode.USAGE,
  NOT_FOUND: ExitCode.NOT_FOUND,
  NOT_INITIALIZED: ExitCode.NOT_INITIALIZED,
  ALREADY_INITIALIZED: ExitCode.USAGE,

  AUTH_REQUIRED: ExitCode.UNAUTHORIZED,
  AUTH_PASSPHRASE_REQUIRED: ExitCode.UNAUTHORIZED,
  SECRET_BACKEND_UNAVAILABLE: ExitCode.SECRET_BACKEND,
  SECRET_DECRYPT_FAILED: ExitCode.SECRET_BACKEND,
  SECRET_NOT_FOUND: ExitCode.SECRET_BACKEND,

  NETWORK_ERROR: ExitCode.NETWORK,
  ZOHO_API_ERROR: ExitCode.ZOHO_API,
  RATE_LIMITED: ExitCode.RATE_LIMITED,
  INSUFFICIENT_SCOPE: ExitCode.INSUFFICIENT_SCOPE,

  DATABASE_ERROR: ExitCode.DATABASE,
  MIGRATION_FAILED: ExitCode.DATABASE,
  SCHEMA_TOO_NEW: ExitCode.DATABASE,

  SYNC_LOCKED: ExitCode.SYNC_LOCKED,
  APPROVAL_REQUIRED: ExitCode.APPROVAL_REQUIRED,
  INCOMPLETE_DATA: ExitCode.INCOMPLETE_DATA,

  CONFIG_INVALID: ExitCode.USAGE,
  PROFILE_NOT_FOUND: ExitCode.NOT_FOUND,
};

/** 默认可重试的错误码：Agent 据此决定是否自动重试。 */
const RETRYABLE = new Set<ErrorCodeValue>([
  ErrorCode.NETWORK_ERROR,
  ErrorCode.RATE_LIMITED,
  ErrorCode.SYNC_LOCKED,
]);

export interface ZmailErrorOptions {
  /** 结构化补充信息。必须已脱敏 —— 它会进入 stdout 的 JSON。 */
  details?: Record<string, unknown>;
  /** 覆盖默认的可重试判定。 */
  retryable?: boolean;
  /** 保留原始错误用于日志，**不**输出到 stdout。 */
  cause?: unknown;
  /** 面向人的下一步建议，会在人类可读输出中显示。 */
  hint?: string;
}

/** 所有可预见的失败都抛这个类型。 */
export class ZmailError extends Error {
  readonly code: ErrorCodeValue;
  readonly exitCode: ExitCodeValue;
  readonly retryable: boolean;
  readonly details: Record<string, unknown>;
  readonly hint: string | undefined;

  constructor(code: ErrorCodeValue, message: string, options: ZmailErrorOptions = {}) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = "ZmailError";
    this.code = code;
    this.exitCode = EXIT_BY_CODE[code];
    this.retryable = options.retryable ?? RETRYABLE.has(code);
    this.details = options.details ?? {};
    this.hint = options.hint;
  }
}

/** 把任意抛出物归一化为 ZmailError。未知错误一律 INTERNAL。 */
export function toZmailError(err: unknown): ZmailError {
  if (err instanceof ZmailError) return err;

  if (err instanceof Error) {
    // fetch 的网络失败没有独立类型，只能靠 cause 的 errno 判断
    const cause = (err as { cause?: { code?: string } }).cause;
    const errno = cause?.code;
    if (
      errno &&
      ["ENOTFOUND", "ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "EAI_AGAIN", "EPIPE"].includes(errno)
    ) {
      return new ZmailError(ErrorCode.NETWORK_ERROR, `网络请求失败: ${errno}`, { cause: err });
    }
    return new ZmailError(ErrorCode.INTERNAL, err.message, { cause: err });
  }

  return new ZmailError(ErrorCode.INTERNAL, String(err), { cause: err });
}

export const exitCodeFor = (code: ErrorCodeValue): ExitCodeValue => EXIT_BY_CODE[code];
