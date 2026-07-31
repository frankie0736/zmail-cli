-- 002_indexes.sql
-- 实施计划 §11.10。
--
-- v1.0 全库只有 UNIQUE 约束，§13.2 承诺的每个过滤条件都会退化成全表扫描。

-- 列表 / 时间范围 / 文件夹：最高频访问路径
CREATE INDEX idx_messages_folder_time
  ON messages(profile_id, folder_id, received_at DESC);

-- 线程聚合
CREATE INDEX idx_messages_thread
  ON messages(profile_id, zoho_thread_id);

-- 发件人精确匹配
CREATE INDEX idx_messages_from
  ON messages(from_address);

-- 按收件身份分流（sales@ / info@ / 个人地址）
CREATE INDEX idx_messages_identity
  ON messages(profile_id, matched_identity_id, received_at DESC);

-- 未读 / 有附件：部分索引，不为占多数的 0 值建索引
CREATE INDEX idx_messages_unread
  ON messages(profile_id, received_at DESC) WHERE is_read = 0;

CREATE INDEX idx_messages_has_att
  ON messages(profile_id, received_at DESC) WHERE has_attachments = 1;

-- 远程已删除对账
CREATE INDEX idx_messages_remote_deleted
  ON messages(profile_id, is_remote_deleted) WHERE is_remote_deleted = 1;

-- 收件人反查
CREATE INDEX idx_recipients_address
  ON message_recipients(address);

CREATE INDEX idx_recipients_message
  ON message_recipients(message_pk);

-- 身份地址反查（同步时匹配收件人用）
CREATE INDEX idx_identities_address
  ON account_identities(address);

-- 附件按内容哈希去重
CREATE INDEX idx_attachments_sha256
  ON attachments(sha256) WHERE sha256 IS NOT NULL;

-- 附件 LRU 回收扫描
CREATE INDEX idx_attachments_lru
  ON attachments(last_accessed_at) WHERE download_status = 'downloaded' AND is_pinned = 0;

CREATE INDEX idx_attachments_message
  ON attachments(message_pk);

-- 审计日志按时间倒查
CREATE INDEX idx_audit_created
  ON audit_log(created_at DESC);

-- --from-domain 过滤。
-- LIKE '%@example.com' 是前导通配，用不上 idx_messages_from，必须靠生成列。
ALTER TABLE messages ADD COLUMN from_domain TEXT
  GENERATED ALWAYS AS (
    CASE
      WHEN from_address IS NULL OR instr(from_address, '@') = 0 THEN NULL
      ELSE lower(substr(from_address, instr(from_address, '@') + 1))
    END
  ) VIRTUAL;

CREATE INDEX idx_messages_from_domain
  ON messages(from_domain) WHERE from_domain IS NOT NULL;

ALTER TABLE message_recipients ADD COLUMN address_domain TEXT
  GENERATED ALWAYS AS (
    CASE
      WHEN instr(address, '@') = 0 THEN NULL
      ELSE lower(substr(address, instr(address, '@') + 1))
    END
  ) VIRTUAL;

CREATE INDEX idx_recipients_domain
  ON message_recipients(address_domain) WHERE address_domain IS NOT NULL;
