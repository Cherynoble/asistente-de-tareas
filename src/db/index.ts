import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { config } from '../config.js';
import { SCHEMA } from './schema.js';

let _db: Database.Database | null = null;

function tableExists(d: Database.Database, name: string): boolean {
  return (
    (d.prepare(`SELECT count(*) AS n FROM sqlite_master WHERE type='table' AND name=?`).get(name) as { n: number })
      .n > 0
  );
}

/** Add a column if it isn't already present (idempotent forward-migration). */
function ensureColumn(d: Database.Database, table: string, col: string, type: string): void {
  if (!tableExists(d, table)) return; // a fresh install creates it from SCHEMA instead
  const cols = d.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (!cols.some((c) => c.name === col)) {
    d.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${type}`);
  }
}

/**
 * Bring an existing DB up to the current schema. Every column current code reads
 * is ensured here (idempotent), so a much older DB — e.g. a 0.1 install with
 * thousands of messages already — upgrades in place with no data loss. New tables
 * are created by exec(SCHEMA) before this runs.
 */
function migrate(d: Database.Database): void {
  // messages: gained processed/sender_name (and, on very old DBs, attachment cols).
  ensureColumn(d, 'messages', 'processed', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn(d, 'messages', 'sender_name', 'TEXT');
  ensureColumn(d, 'messages', 'has_attachment', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn(d, 'messages', 'attachment_mimes', `TEXT NOT NULL DEFAULT ''`);
  ensureColumn(d, 'messages', 'attachment_names', `TEXT NOT NULL DEFAULT ''`);
  ensureColumn(d, 'messages', 'attachment_paths', `TEXT NOT NULL DEFAULT ''`);
  ensureColumn(d, 'messages', 'wa_account', 'TEXT'); // multi-account WhatsApp tag (0.4.0)
  // tasks: columns added across passes (extraction, reminders, archive, trash).
  // client_id is indexed by SCHEMA (idx_tasks_client), so it MUST exist before
  // exec(SCHEMA) or the CREATE INDEX crashes on a sufficiently old DB — same
  // failure mode as the messages.processed index fixed in 0.3.2.
  ensureColumn(d, 'tasks', 'client_id', 'INTEGER');
  ensureColumn(d, 'tasks', 'source_quote', `TEXT NOT NULL DEFAULT ''`);
  ensureColumn(d, 'tasks', 'due_at', 'INTEGER');
  ensureColumn(d, 'tasks', 'last_nudge_at', 'INTEGER');
  ensureColumn(d, 'tasks', 'archived_at', 'INTEGER');
  ensureColumn(d, 'tasks', 'deleted_at', 'INTEGER');
  // clients: trash support + Personal/Oficina (or custom) categorization.
  ensureColumn(d, 'clients', 'deleted_at', 'INTEGER');
  ensureColumn(d, 'clients', 'category', `TEXT NOT NULL DEFAULT ''`);
  // chat_messages: attachments added in 0.3.0 (only if the table predates it).
  ensureColumn(d, 'chat_messages', 'attachments', `TEXT NOT NULL DEFAULT ''`);
}

let _ftsAvailable = false;

/** Whether the messages_fts full-text index exists and can be queried. Search
 *  code falls back to LIKE scans when this is false. */
export function ftsAvailable(): boolean {
  return _ftsAvailable;
}

/**
 * Full-text index over messages.body, for the Mensajes search and the chat
 * agent's search_messages tool — a LIKE over every body is a full-table scan
 * that gets slow as a silo's history grows into six figures.
 *
 * fts5 with the TRIGRAM tokenizer, specifically: it matches substrings (same
 * semantics the LIKE search always had) and works on Chinese text, which has no
 * word boundaries for the default tokenizer to find. External-content table +
 * triggers keep it in sync with inserts/deletes (sticker purges included); the
 * first boot on an existing DB does a one-time 'rebuild' (see the marker note
 * below). Best-effort: if this SQLite build lacks fts5/trigram, search silently
 * stays on LIKE.
 */
function ensureFts(d: Database.Database): void {
  try {
    d.exec(/* sql */ `
      CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts
        USING fts5(body, content='messages', content_rowid='id', tokenize='trigram');
      CREATE TRIGGER IF NOT EXISTS messages_fts_ai AFTER INSERT ON messages BEGIN
        INSERT INTO messages_fts(rowid, body) VALUES (new.id, new.body);
      END;
      CREATE TRIGGER IF NOT EXISTS messages_fts_ad AFTER DELETE ON messages BEGIN
        INSERT INTO messages_fts(messages_fts, rowid, body) VALUES ('delete', old.id, old.body);
      END;
      CREATE TRIGGER IF NOT EXISTS messages_fts_au AFTER UPDATE OF body ON messages BEGIN
        INSERT INTO messages_fts(messages_fts, rowid, body) VALUES ('delete', old.id, old.body);
        INSERT INTO messages_fts(rowid, body) VALUES (new.id, new.body);
      END;
    `);
    // A row-count comparison can NOT detect an unbuilt index here: on an
    // external-content fts5 table, SELECTs (including COUNT) are answered from
    // the content table, so they "match" even when the index is empty. Use an
    // explicit one-time marker instead; the triggers keep it in sync after.
    const marker = d
      .prepare(`SELECT value FROM settings WHERE key = 'fts_built'`)
      .get() as { value: string } | undefined;
    if (marker?.value !== '1') {
      const msgs = (d.prepare('SELECT COUNT(*) AS n FROM messages').get() as { n: number }).n;
      d.exec(`INSERT INTO messages_fts(messages_fts) VALUES ('rebuild')`);
      d.prepare(
        `INSERT INTO settings (key, value) VALUES ('fts_built', '1')
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      ).run();
      console.log(`[db] built messages_fts (${msgs} rows)`);
    }
    _ftsAvailable = true;
  } catch (err) {
    _ftsAvailable = false;
    console.warn('[db] fts unavailable, search falls back to LIKE:', err instanceof Error ? err.message : err);
  }
}

/** The app's own database (data/app.db), created on first use. */
export function db(): Database.Database {
  if (_db) return _db;
  fs.mkdirSync(config.dataDir, { recursive: true });
  const dbPath = path.join(config.dataDir, 'app.db');
  _db = new Database(dbPath);
  _db.pragma('journal_mode = WAL');
  // Order matters: add any missing columns to EXISTING tables first, so that
  // SCHEMA's CREATE INDEX statements (e.g. on messages.processed) don't fail on
  // an old DB. On a fresh install migrate() is a no-op (tables don't exist yet)
  // and SCHEMA creates everything.
  migrate(_db);
  _db.exec(SCHEMA);
  ensureFts(_db);
  return _db;
}

/**
 * Open the macOS iMessage database read-only. Requires Full Disk Access for the
 * host process, or this throws with an authorization error.
 */
export function openChatDb(): Database.Database {
  return new Database(config.chatDbPath, { readonly: true, fileMustExist: true });
}
