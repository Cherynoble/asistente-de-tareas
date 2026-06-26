/**
 * Schema for the app's own database (data/app.db). This is separate from the
 * read-only iMessage chat.db. Tasks: ingested messages, the client roster, and
 * the tasks the AI proposes from those messages.
 */
export const SCHEMA = /* sql */ `
CREATE TABLE IF NOT EXISTS messages (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  source        TEXT    NOT NULL,            -- 'imessage' | 'whatsapp'
  source_msg_id TEXT    NOT NULL,            -- stable id from the source, for dedup
  chat_id       TEXT,                        -- conversation/group id
  chat_name     TEXT,                        -- human-readable chat/group name
  sender        TEXT,                        -- handle / phone number
  sender_name   TEXT,                        -- display name if known
  direction     TEXT    NOT NULL,            -- 'incoming' | 'outgoing'
  body          TEXT    NOT NULL DEFAULT '',
  ts            INTEGER NOT NULL,            -- message time, unix ms
  ingested_at   INTEGER NOT NULL,            -- when we stored it, unix ms
  processed     INTEGER NOT NULL DEFAULT 0,  -- 1 once extraction has seen it
  has_attachment   INTEGER NOT NULL DEFAULT 0,  -- 1 if photo/pdf/video/etc.
  attachment_mimes TEXT    NOT NULL DEFAULT '', -- '||'-joined mime types
  attachment_names TEXT    NOT NULL DEFAULT '', -- '||'-joined filenames
  attachment_paths TEXT    NOT NULL DEFAULT '', -- '||'-joined on-disk paths
  UNIQUE (source, source_msg_id)
);

CREATE INDEX IF NOT EXISTS idx_messages_ts ON messages (ts);
CREATE INDEX IF NOT EXISTS idx_messages_processed ON messages (processed);

CREATE TABLE IF NOT EXISTS clients (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  name          TEXT    NOT NULL,            -- WhatsApp/chat display name
  handle        TEXT    UNIQUE,              -- phone/handle, if known
  product_need  TEXT    NOT NULL DEFAULT '', -- free text: what they buy / need
  deleted_at    INTEGER,                     -- soft-delete to Trash; NULL = active
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS tasks (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id     INTEGER REFERENCES clients (id),
  title         TEXT    NOT NULL,
  detail        TEXT    NOT NULL DEFAULT '',
  status        TEXT    NOT NULL DEFAULT 'proposed', -- proposed|todo|waiting|done|dismissed
  client_hint   TEXT    NOT NULL DEFAULT '',         -- chat/sender the task relates to
  source_message_id INTEGER REFERENCES messages (id), -- message that triggered it
  source_quote  TEXT    NOT NULL DEFAULT '',         -- verbatim snippet to search in WhatsApp/iMessage
  due_at        INTEGER,                     -- optional deadline, unix ms
  last_nudge_at INTEGER,                      -- last reminder fired, unix ms
  archived_at   INTEGER,                     -- set when archived; hidden from active views
  deleted_at    INTEGER,                     -- soft-delete to Trash; NULL = active
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks (status);
CREATE INDEX IF NOT EXISTS idx_tasks_client ON tasks (client_id);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;
