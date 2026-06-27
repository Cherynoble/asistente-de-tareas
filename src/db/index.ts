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
  // tasks: columns added across passes (extraction, reminders, archive, trash).
  ensureColumn(d, 'tasks', 'source_quote', `TEXT NOT NULL DEFAULT ''`);
  ensureColumn(d, 'tasks', 'due_at', 'INTEGER');
  ensureColumn(d, 'tasks', 'last_nudge_at', 'INTEGER');
  ensureColumn(d, 'tasks', 'archived_at', 'INTEGER');
  ensureColumn(d, 'tasks', 'deleted_at', 'INTEGER');
  // clients: trash support.
  ensureColumn(d, 'clients', 'deleted_at', 'INTEGER');
  // chat_messages: attachments added in 0.3.0 (only if the table predates it).
  ensureColumn(d, 'chat_messages', 'attachments', `TEXT NOT NULL DEFAULT ''`);
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
  return _db;
}

/**
 * Open the macOS iMessage database read-only. Requires Full Disk Access for the
 * host process, or this throws with an authorization error.
 */
export function openChatDb(): Database.Database {
  return new Database(config.chatDbPath, { readonly: true, fileMustExist: true });
}
