-- 004_local_annotations.sql
-- 本地 Agent 元数据、草稿与待办操作。实施计划 §11.7。
--
-- 这些数据**不写回 Zoho**，也无法从 Zoho 重建 —— 因此备份是必需的（§21.1）。

CREATE TABLE local_annotations (
  id INTEGER PRIMARY KEY,
  message_pk INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  annotation_type TEXT NOT NULL,
  value_json TEXT NOT NULL,
  model TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(message_pk, annotation_type)
) STRICT;

CREATE INDEX idx_annotations_type ON local_annotations(annotation_type);

-- 本地草稿。v0.2 起使用；表结构先建好，避免后续迁移。
CREATE TABLE local_drafts (
  id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  account_id TEXT NOT NULL,

  -- 回复目标。draft 独立存在时为 NULL。
  in_reply_to_message_pk INTEGER REFERENCES messages(id) ON DELETE SET NULL,
  -- 用哪个发信身份发出（§11.8）。发错身份在商务场景是真实事故。
  from_identity_id INTEGER REFERENCES account_identities(id) ON DELETE SET NULL,

  subject TEXT,
  body_markdown TEXT,
  recipients_json TEXT NOT NULL DEFAULT '[]',
  attachments_json TEXT NOT NULL DEFAULT '[]',

  -- 内容哈希，approval token 绑定它（§19.2）
  content_hash TEXT,
  status TEXT NOT NULL DEFAULT 'local'
    CHECK(status IN ('local', 'pushed', 'sent', 'failed')),
  zoho_draft_id TEXT,

  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;

CREATE INDEX idx_drafts_profile ON local_drafts(profile_id, updated_at DESC);

-- 待执行的远程操作队列。断网时排队，恢复后重放。
CREATE TABLE pending_operations (
  id INTEGER PRIMARY KEY,
  profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  operation TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  -- 幂等键：同一操作重放多次只生效一次（§ Phase 7）
  idempotency_key TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK(status IN ('pending', 'in_flight', 'done', 'failed')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(idempotency_key)
) STRICT;

CREATE INDEX idx_pending_status ON pending_operations(status, created_at);
