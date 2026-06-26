import { db } from './index.js';

// Creates data/app.db and applies the schema. Safe to run repeatedly.
const d = db();
const tables = d
  .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
  .all()
  .map((r) => (r as { name: string }).name)
  .filter((n) => !n.startsWith('sqlite_'));

console.log('app.db ready. Tables:', tables.join(', '));
