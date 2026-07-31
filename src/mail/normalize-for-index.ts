/**
 * 索引文本规范化。实施计划 §13.1.2。
 *
 * ## 为什么必须有这个函数
 *
 * FTS5 的 unicode61 分词器把**连续汉字视为一个 token**。对文本
 * 「客户询价硅胶管报价单」，整段是单个 token，因此：
 *
 *   查询 "硅胶管"  → 0 命中（它只是那个大 token 的子串）
 *   查询 "询价"    → 0 命中
 *
 * trigram 分词器要求查询串至少 3 字符，两字词（询价、报价、样品、交期）
 * 全部失效 —— 而这正是中文商务邮件的核心词汇。
 *
 * 解法：索引前把 CJK 字符逐字用空格分隔，配合 unicode61。
 *
 * ## 硬性不变量
 *
 * 1. 写入索引与构造查询**必须调用同一个函数**。任何一侧遗漏都会导致
 *    中文搜索静默返回空 —— 不报错，只是查不到，最难排查的一类 bug。
 * 2. CJK 查询词规范化后必须包装成 FTS5 **短语查询**，否则会被拆成
 *    独立单字的 OR 查询，产生大量误命中。
 * 3. 本函数属于索引格式的一部分。修改它必须递增 NORMALIZER_VERSION
 *    并强制 rebuild-index，否则新旧索引混用会产生查不到的邮件。
 */

/**
 * 索引规范化版本。**修改 normalizeForIndex 的行为时必须递增。**
 * 与数据库 index_meta.normalizer_version 比对，不一致时 doctor 告警。
 */
export const NORMALIZER_VERSION = 1;

/**
 * 需要逐字切分的 Unicode 区段：
 *   㐀-䶿  CJK 扩展 A
 *   一-鿿  CJK 统一表意文字
 *   ぀-ヿ  日文平假名 / 片假名
 *   가-힯  韩文音节
 *   豈-﫿  CJK 兼容表意文字
 */
const CJK_PATTERN = /[㐀-䶿一-鿿぀-ヿ가-힯豈-﫿]/g;

/**
 * 把文本规范化为可索引 / 可查询的形式。
 *
 * 索引时与查询时必须调用同一个函数 —— 这是不变量 1。
 */
export function normalizeForIndex(text: string): string {
  if (!text) return "";
  return text
    .replace(CJK_PATTERN, (c) => ` ${c} `)
    .replace(/\s+/g, " ")
    .trim();
}

/** 文本中是否含 CJK 字符。决定是否需要包成短语查询。 */
export function containsCjk(text: string): boolean {
  CJK_PATTERN.lastIndex = 0;
  return CJK_PATTERN.test(text);
}

/**
 * 转义 FTS5 查询中的字面量。
 *
 * FTS5 的字符串字面量用双引号包裹，内部双引号通过重复转义。
 * 不转义的话，用户搜索包含引号的内容会构造出语法错误或非预期查询。
 */
export function escapeFtsLiteral(term: string): string {
  return `"${term.replace(/"/g, '""')}"`;
}

/**
 * 把用户输入的关键词转成安全的 FTS5 短语查询。
 *
 * 默认模式下 Agent **不能**直接拼任意 FTS 表达式（§13.3），
 * 所有输入都经过这里。
 */
export function toPhraseQuery(term: string): string {
  const normalized = normalizeForIndex(term);
  if (!normalized) return "";
  return escapeFtsLiteral(normalized);
}

/**
 * 多个关键词的 AND 查询。
 * 每个词各自规范化并包成短语，再用 AND 连接。
 */
export function toAndQuery(terms: string[]): string {
  return terms.map(toPhraseQuery).filter(Boolean).join(" AND ");
}

/** 拼接用于 sender / recipients 字段的可索引文本。 */
export function buildIdentityText(parts: Array<{ name?: string | null; address: string }>): string {
  return normalizeForIndex(
    parts.map((p) => (p.name ? `${p.name} ${p.address}` : p.address)).join(" "),
  );
}
