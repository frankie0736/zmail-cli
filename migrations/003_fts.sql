-- 003_fts.sql
-- 实施计划 §13.1。
--
-- ⚠️ v1.0 的定义无法工作：
--   CREATE VIRTUAL TABLE messages_fts USING fts5(
--     subject, sender, recipients, body_text,
--     content='messages', content_rowid='id');
--
-- FTS5 外部内容表按列名回查内容表，但 messages 里没有 sender / recipients 列。
-- 建表时不报错，rebuild 时报 "no such column: T.sender"，查询静默返回空。
--
-- 采用 contentless 表：FTS5 只存倒排索引，不存列值。四个字段的文本由应用层
-- 在 upsert 时拼接、经 normalizeForIndex 规范化后显式写入，rowid 绑定 messages.id。
--
-- 取舍：
--   放弃 snippet()  —— 索引文本经 CJK 空格化，snippet 输出会是「硅 胶 管」，
--                      本来就不能直接展示。摘要一律由应用层从 body_text 生成。
--   放弃原生 rebuild —— 由 zmail data rebuild-index 在应用层实现。这反而更正确：
--                      重建必须重新执行规范化函数，SQLite 原生 rebuild 做不到。
--   保留 bm25() / integrity-check / contentless_delete 删除。

CREATE VIRTUAL TABLE messages_fts USING fts5(
  subject,
  sender,
  recipients,
  body,
  content='',
  contentless_delete=1,
  tokenize='unicode61 remove_diacritics 2'
);

-- 索引规范化函数的版本。
-- normalizeForIndex 的任何行为变更都必须递增此值并强制 rebuild-index，
-- 否则新旧索引混用会产生「存在但搜不到」的邮件（§13.1.2 不变量 3）。
CREATE TABLE index_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
) STRICT;

INSERT INTO index_meta(key, value) VALUES ('normalizer_version', '1');
