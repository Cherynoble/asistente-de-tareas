import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { config } from '../config.js';
import { SCHEMA } from './schema.js';

let _db: Database.Database | null = null;

/** The app's own database (data/app.db), created on first use. */
export function db(): Database.Database {
  if (_db) return _db;
  fs.mkdirSync(config.dataDir, { recursive: true });
  const dbPath = path.join(config.dataDir, 'app.db');
  _db = new Database(dbPath);
  _db.pragma('journal_mode = WAL');
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
