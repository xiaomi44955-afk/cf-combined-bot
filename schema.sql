-- Combined Messenger + Uploader Bot Schema
-- Version: 5

-- ═══════════════════════════════════════════════════════
-- META
-- ═══════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT
);

-- ═══════════════════════════════════════════════════════
-- USERS
-- ═══════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS users (
  user_id     INTEGER PRIMARY KEY,
  username    TEXT,
  first_name  TEXT,
  last_name   TEXT,
  is_registered INTEGER DEFAULT 0,
  blocked     INTEGER DEFAULT 0,
  chat_mode   TEXT DEFAULT 'normal',
  updated_at  TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_users_blocked ON users(blocked);
CREATE INDEX IF NOT EXISTS idx_users_chat_mode ON users(chat_mode);

-- ═══════════════════════════════════════════════════════
-- ADMINS
-- ═══════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS admins (
  user_id INTEGER PRIMARY KEY,
  role    TEXT DEFAULT 'admin'
);

-- ═══════════════════════════════════════════════════════
-- BUTTONS (nested content tree)
-- ═══════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS buttons (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  parent_id           INTEGER DEFAULT 0,
  name                TEXT,
  is_active           INTEGER DEFAULT 1,
  protect_content     INTEGER DEFAULT 0,
  upload_completed    INTEGER DEFAULT 0,
  order_index         INTEGER,
  content_kind        TEXT,
  content_text        TEXT,
  content_file_id     TEXT,
  archive_chat_id     TEXT,
  archive_message_id  TEXT
);

CREATE INDEX IF NOT EXISTS idx_buttons_parent_id ON buttons(parent_id);

-- ═══════════════════════════════════════════════════════
-- BUTTON CONTENTS (multi-content per button)
-- ═══════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS button_contents (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  button_id           INTEGER,
  order_index         INTEGER,
  content_kind        TEXT,
  content_text        TEXT,
  content_file_id     TEXT,
  archive_chat_id     TEXT,
  archive_message_id  TEXT,
  created_at          TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_button_contents_button_id ON button_contents(button_id);

-- ═══════════════════════════════════════════════════════
-- FORCED CHANNELS (force-join before using bot)
-- ═══════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS forced_channels (
  channel_ref TEXT PRIMARY KEY
);

-- ═══════════════════════════════════════════════════════
-- SETTINGS
-- ═══════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT
);

-- ═══════════════════════════════════════════════════════
-- USER STATES (conversation state machine)
-- ═══════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS user_states (
  user_id     INTEGER PRIMARY KEY,
  state       TEXT,
  data        TEXT DEFAULT '{}',
  updated_at  TEXT DEFAULT (datetime('now'))
);

-- ═══════════════════════════════════════════════════════
-- SUPPORT MESSAGES
-- ═══════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS support_messages (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id       INTEGER,
  message_text  TEXT,
  status        TEXT DEFAULT 'pending',
  created_at    TEXT DEFAULT (datetime('now'))
);

-- ═══════════════════════════════════════════════════════
-- SEED DATA
-- ═══════════════════════════════════════════════════════
INSERT OR IGNORE INTO meta (key, value) VALUES ('schema_version', '5');

INSERT OR IGNORE INTO buttons (id, parent_id, name, is_active, order_index)
VALUES (0, NULL, 'ROOT', 1, 0);
