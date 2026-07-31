-- 001_initial.sql
-- 核心表。实施计划 §11。
--
-- ID 规则（§11.3）：所有 Zoho 远程 ID 一律 TEXT。Zoho 混用字符串与裸数字，
-- 且部分字段超出 2^53，任何数值化处理都会静默损坏数据。

-- ---------------------------------------------------------------- profiles

CREATE TABLE profiles (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  zoho_location TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;

-- ---------------------------------------------------------------- accounts

CREATE TABLE accounts (
  id INTEGER PRIMARY KEY,
  profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  zoho_account_id TEXT NOT NULL,

  primary_email TEXT,
  display_name TEXT,
  -- 邮箱容量，用于校准存储预算与配额推算（§25 Phase 0-6）
  used_storage_bytes INTEGER,
  allowed_storage_bytes INTEGER,
  -- IMAP 可用性，决定是否值得走 IMAP 批量同步（§25 Phase 0-4）
  imap_access_enabled INTEGER,
  imap_blocked INTEGER,

  first_synced_at INTEGER NOT NULL,
  last_synced_at INTEGER NOT NULL,

  UNIQUE(profile_id, zoho_account_id)
) STRICT;

-- ------------------------------------------------------- account_identities
-- 收件身份（alias）与发信身份。语义不同，但一个地址可能两者皆是，
-- 因此用 is_receive / is_send 两个标志而不是拆表。（§11.8）

CREATE TABLE account_identities (
  id INTEGER PRIMARY KEY,
  profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  account_id TEXT NOT NULL,

  address TEXT NOT NULL,
  display_name TEXT,

  -- 来自 emailAddress[]
  is_receive INTEGER NOT NULL DEFAULT 0,
  is_primary INTEGER NOT NULL DEFAULT 0,
  is_alias INTEGER NOT NULL DEFAULT 0,
  is_confirmed INTEGER NOT NULL DEFAULT 0,

  -- 来自 sendMailDetails[]
  is_send INTEGER NOT NULL DEFAULT 0,
  send_mode TEXT,                      -- 'mailbox' | 'extfrom'
  send_mail_id TEXT,                   -- 不透明字符串
  send_validated INTEGER NOT NULL DEFAULT 0,
  send_status INTEGER NOT NULL DEFAULT 0,

  first_synced_at INTEGER NOT NULL,
  last_synced_at INTEGER NOT NULL,

  UNIQUE(profile_id, account_id, address)
) STRICT;

-- ---------------------------------------------------------------- folders

CREATE TABLE folders (
  id INTEGER PRIMARY KEY,
  profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  account_id TEXT NOT NULL,
  zoho_folder_id TEXT NOT NULL,

  name TEXT NOT NULL,
  path TEXT,
  parent_folder_id TEXT,
  folder_type TEXT,
  -- 是否纳入同步范围，由 config 的 include/exclude 计算得出
  is_synced INTEGER NOT NULL DEFAULT 0,

  first_synced_at INTEGER NOT NULL,
  last_synced_at INTEGER NOT NULL,

  UNIQUE(profile_id, account_id, zoho_folder_id)
) STRICT;

-- ---------------------------------------------------------------- threads

CREATE TABLE threads (
  id INTEGER PRIMARY KEY,
  profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  account_id TEXT NOT NULL,
  zoho_thread_id TEXT NOT NULL,

  subject TEXT,
  message_count INTEGER NOT NULL DEFAULT 0,
  first_message_at INTEGER,
  last_message_at INTEGER,

  first_synced_at INTEGER NOT NULL,
  last_synced_at INTEGER NOT NULL,

  UNIQUE(profile_id, account_id, zoho_thread_id)
) STRICT;

-- ---------------------------------------------------------------- messages

CREATE TABLE messages (
  id INTEGER PRIMARY KEY,
  profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  account_id TEXT NOT NULL,
  zoho_message_id TEXT NOT NULL,
  zoho_thread_id TEXT,
  folder_id TEXT NOT NULL,

  internet_message_id TEXT,
  subject TEXT,
  from_name TEXT,
  from_address TEXT,
  reply_to_address TEXT,

  summary TEXT,
  body_text TEXT,
  body_html TEXT,

  received_at INTEGER,
  sent_at INTEGER,
  size_bytes INTEGER,

  is_read INTEGER NOT NULL DEFAULT 0,
  is_flagged INTEGER NOT NULL DEFAULT 0,
  has_attachments INTEGER NOT NULL DEFAULT 0,
  is_remote_deleted INTEGER NOT NULL DEFAULT 0,

  -- 这封邮件命中了本账号的哪个收件身份（§11.8）。
  -- 多个身份同时命中时取 is_primary 优先，其次 to 早于 cc。
  matched_identity_id INTEGER REFERENCES account_identities(id) ON DELETE SET NULL,

  raw_json TEXT,
  remote_updated_at INTEGER,
  first_synced_at INTEGER NOT NULL,
  last_synced_at INTEGER NOT NULL,

  UNIQUE(profile_id, account_id, zoho_message_id)
) STRICT;

-- ------------------------------------------------------- message_recipients
-- 独立成表而不是 to_json，否则「发给某人的邮件」无法走索引（§11.5）

CREATE TABLE message_recipients (
  id INTEGER PRIMARY KEY,
  message_pk INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  recipient_type TEXT NOT NULL CHECK(recipient_type IN ('to', 'cc', 'bcc')),
  name TEXT,
  address TEXT NOT NULL
) STRICT;

-- ---------------------------------------------------------------- attachments
-- 文件本体按 SHA-256 内容寻址存在文件系统，数据库只存元数据与路径（§15.2）

CREATE TABLE attachments (
  id INTEGER PRIMARY KEY,
  message_pk INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  zoho_attachment_id TEXT NOT NULL,
  filename TEXT,
  mime_type TEXT,
  size_bytes INTEGER,
  sha256 TEXT,
  local_path TEXT,
  download_status TEXT NOT NULL DEFAULT 'metadata_only'
    CHECK(download_status IN ('metadata_only', 'downloading', 'downloaded', 'failed', 'evicted')),
  extracted_text_path TEXT,
  -- LRU 回收依据（§15.5）
  last_accessed_at INTEGER,
  is_pinned INTEGER NOT NULL DEFAULT 0,

  first_synced_at INTEGER NOT NULL,
  last_synced_at INTEGER NOT NULL,

  UNIQUE(message_pk, zoho_attachment_id)
) STRICT;

-- ---------------------------------------------------------------- labels

CREATE TABLE labels (
  id INTEGER PRIMARY KEY,
  profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  account_id TEXT NOT NULL,
  zoho_label_id TEXT NOT NULL,
  name TEXT NOT NULL,
  color TEXT,
  UNIQUE(profile_id, account_id, zoho_label_id)
) STRICT;

CREATE TABLE message_labels (
  message_pk INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  label_pk INTEGER NOT NULL REFERENCES labels(id) ON DELETE CASCADE,
  PRIMARY KEY(message_pk, label_pk)
) STRICT;

-- ---------------------------------------------------------------- sync_state
-- 不依赖单一时间戳（§14.4）

CREATE TABLE sync_state (
  id INTEGER PRIMARY KEY,
  profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  folder_id TEXT NOT NULL,

  last_successful_sync_at INTEGER,
  last_full_sync_at INTEGER,
  latest_seen_message_id TEXT,
  latest_seen_received_at INTEGER,
  last_page_start INTEGER,
  last_error_code TEXT,
  last_error_at INTEGER,

  UNIQUE(profile_id, folder_id)
) STRICT;

-- ---------------------------------------------------------------- audit_log
-- 只记高风险动作，普通读取不逐条审计以免日志膨胀（§20.2）

CREATE TABLE audit_log (
  id INTEGER PRIMARY KEY,
  profile_id TEXT,
  action TEXT NOT NULL,
  detail_json TEXT,
  created_at INTEGER NOT NULL
) STRICT;
