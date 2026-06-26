import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { config } from '../config.js';
import { SCHEMA } from './schema.js';

let _db: Database.Database | null = null;

/** Add a column if it isn't already present (idempotent forward-migration). */
function ensureColumn(d: Database.Database, table: string, col: string, type: string): void {
  const cols = d.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (!cols.some((c) => c.name === col)) {
    d.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${type}`);
  }
}

/** Bring an existing DB up to the current schema (new columns added over time). */
function migrate(d: Database.Database): void {
  ensureColumn(d, 'tasks', 'source_quote', `TEXT NOT NULL DEFAULT ''`);
  ensureColumn(d, 'tasks', 'archived_at', 'INTEGER');
  ensureColumn(d, 'tasks', 'deleted_at', 'INTEGER');
  ensureColumn(d, 'clients', 'deleted_at', 'INTEGER');
}

/** The app's own database (data/app.db), created on first use. */
export function db(): Database.Database {
  if (_db) return _db;
  fs.mkdirSync(config.dataDir, { recursive: true });
  const dbPath = path.join(config.dataDir, 'app.db');
  _db = new Database(dbPath);
  _db.pragma('journal_mode = WAL');
  _db.exec(SCHEMA);
  migrate(_db);
  return _db;
}

/**
 * Open the macOS iMessage database read-only. Requires Full Disk Access for the
 * host process, or this throws with an authorization error.
 */
export function openChatDb(): Database.Database {
  return new Database(config.chatDbPath, { readonly: true, fileMustExist: true });
}
