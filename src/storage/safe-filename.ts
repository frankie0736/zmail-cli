/**
 * 导出文件名消毒。实施计划 §15.4。
 *
 * §15.2 的 SHA-256 内容寻址只保证了**内部**存储安全 —— 磁盘上的路径由哈希
 * 决定，与文件名无关。但 `zmail attachment download --out <dir>` 和
 * `zmail export` 会把文件写到用户指定目录并使用原始文件名，而文件名来自
 * 不可信的外部邮件。
 *
 * 攻击面是真实的：一封精心构造的邮件，附件名叫 `../../.ssh/authorized_keys`，
 * 用户一次导出就可能被写入任意路径。
 */

import { existsSync } from "node:fs";
import { basename, extname, isAbsolute, resolve, sep } from "node:path";
import { ErrorCode, ZmailError } from "../core/errors.js";

/** Windows 保留设备名。即使加了扩展名依然保留（`CON.txt` 也不行）。 */
const WINDOWS_RESERVED = /^(CON|PRN|AUX|NUL|COM[0-9¹²³]|LPT[0-9¹²³])(\..*)?$/i;

/**
 * 文件系统与 shell 都可能出问题的字符，加上全部 C0 控制字符与 DEL。
 *
 * 控制字符才是真正危险的部分：文件名里的 NUL 会截断某些系统调用的路径，
 * 换行会破坏日志与脚本输出。空格是合法的，**不**在此列 ——
 * 把 "my file.pdf" 改成 "my_file.pdf" 是没必要的破坏。
 *
 * 用转义序列而非字面量控制字节：后者会让 grep 把整个源文件视为二进制，
 * 在代码库里搜不到这一行。
 */
// biome-ignore lint/suspicious/noControlCharactersInRegex: 消毒控制字符正是本函数的职责
const ILLEGAL_CHARS = /[<>:"/\\|?*\u0000-\u001f\u007f]/g;

/** 大多数文件系统的单段上限是 255 字节，留出去重后缀的余量。 */
const MAX_BASENAME_LENGTH = 200;

export interface SafeFilenameOptions {
  /** 无法从原名得到任何有效字符时使用。 */
  fallback?: string;
}

/**
 * 把不可信文件名转成安全的单段文件名。
 *
 * 只做「名字」这一层，不涉及目录 —— 目录安全由 resolveExportPath 保证。
 */
export function safeFilename(
  raw: string | null | undefined,
  opts: SafeFilenameOptions = {},
): string {
  const fallback = opts.fallback ?? "attachment";

  // 1. 丢弃所有目录成分。basename 对 POSIX 有效，但 Windows 风格的
  //    `..\..\evil` 在 POSIX 上不会被 basename 处理，所以先统一分隔符。
  let name = basename(String(raw ?? "").replace(/\\/g, "/"));

  // 2. 过滤非法与控制字符
  name = name.replace(ILLEGAL_CHARS, "_");

  // 3. 去掉首尾的点与空格。`..` 会变成空；Windows 也不允许尾部点/空格。
  name = name.replace(/^[.\s]+/, "").replace(/[.\s]+$/, "");

  // 4. 拒绝 Windows 保留设备名
  if (WINDOWS_RESERVED.test(name)) name = `_${name}`;

  // 5. 截断但保留扩展名 —— 扩展名决定用户能否打开这个文件
  if (Buffer.byteLength(name, "utf8") > MAX_BASENAME_LENGTH) {
    const ext = extname(name).slice(0, 20);
    const stem = name.slice(0, name.length - ext.length);
    let truncated = stem;
    while (Buffer.byteLength(truncated + ext, "utf8") > MAX_BASENAME_LENGTH) {
      truncated = truncated.slice(0, -1);
    }
    name = truncated + ext;
  }

  return name || fallback;
}

/**
 * 解析导出目标路径，并断言它确实落在允许的目录内。
 *
 * 这是最后一道防线。即使 safeFilename 因为某种未预料的输入而漏掉了什么，
 * 这里的 resolve + startsWith 检查也会拦下越界写入。
 */
export function resolveExportPath(outDir: string, unsafeName: string): string {
  const dir = resolve(outDir);
  const name = safeFilename(unsafeName);
  const target = resolve(dir, name);

  // resolve 之后再比对，才能识破 `a/../../b` 这类构造
  if (target !== dir && !target.startsWith(dir + sep)) {
    throw new ZmailError(ErrorCode.INVALID_ARGUMENT, "导出路径越界，已拒绝写入", {
      details: { outDir: dir, attempted: target },
    });
  }
  return target;
}

/**
 * 同名冲突时追加序号。
 *
 * **绝不静默覆盖** —— 一次导出里两个同名附件，覆盖会让用户以为只有一个。
 */
export function uniqueExportPath(
  outDir: string,
  unsafeName: string,
  exists: (p: string) => boolean = existsSync,
): string {
  const base = resolveExportPath(outDir, unsafeName);
  if (!exists(base)) return base;

  const ext = extname(base);
  const stem = base.slice(0, base.length - ext.length);
  for (let i = 1; i < 10_000; i++) {
    const candidate = `${stem} (${i})${ext}`;
    if (!exists(candidate)) return candidate;
  }
  throw new ZmailError(ErrorCode.INVALID_ARGUMENT, "同名文件过多，无法生成唯一导出路径", {
    details: { base },
  });
}

/** 校验用户提供的输出目录本身是否合理。 */
export function assertUsableOutDir(outDir: string): string {
  const dir = resolve(outDir);
  if (!isAbsolute(dir)) {
    throw new ZmailError(ErrorCode.INVALID_ARGUMENT, `输出目录必须能解析为绝对路径: ${outDir}`);
  }
  return dir;
}
