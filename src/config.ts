import 'dotenv/config';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Where the app stores its own DB. In development we keep using ./data (so the
 * existing dev database is found). For a bundled .app the working directory is
 * unpredictable (can be "/"), so default to a stable, user-writable location.
 */
function resolveDataDir(): string {
  if (process.env.DATA_DIR) return process.env.DATA_DIR;
  const devDir = path.join(process.cwd(), 'data');
  if (fs.existsSync(path.join(devDir, 'app.db'))) return devDir;
  return path.join(os.homedir(), 'Library', 'Application Support', 'DadsApp');
}

export const config = {
  /** Claude API key (Phase 2+). */
  anthropicApiKey: process.env.ANTHROPIC_API_KEY ?? '',
  /** Extraction model. */
  model: process.env.CLAUDE_MODEL ?? 'claude-haiku-4-5',
  /** Local iMessage SQLite DB. */
  chatDbPath:
    process.env.CHAT_DB_PATH ||
    path.join(os.homedir(), 'Library', 'Messages', 'chat.db'),
  /** Where this app stores its own data (messages, clients, tasks). */
  dataDir: resolveDataDir(),
  /** First-run history import window. */
  historyDays: Number(process.env.HISTORY_DAYS ?? 30),
  /** iMessage poll interval in seconds. */
  imessagePollSeconds: Number(process.env.IMESSAGE_POLL_SECONDS ?? 60),
} as const;
