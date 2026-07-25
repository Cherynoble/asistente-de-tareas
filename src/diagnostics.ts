import fs from 'node:fs';
import path from 'node:path';
import { db } from './db/index.js';
import { config } from './config.js';

export interface DiagnosticsInfo {
  dataDir: string;
  dbPath: string;
  sources: { source: string; count: number; lastAt: number | null }[];
  unprocessed: { count: number; oldestAt: number | null };
}

/** Which DB this process is actually talking to, and how stale/backed-up it is —
 * the facts needed to catch config.ts's dev/prod dataDir split silently pointing
 * two processes at two different files. */
export function computeDiagnostics(): DiagnosticsInfo {
  const d = db();
  const sources = d
    .prepare(`SELECT source, COUNT(*) AS count, MAX(ts) AS lastAt FROM messages GROUP BY source`)
    .all() as { source: string; count: number; lastAt: number | null }[];
  const unprocessed = d
    .prepare(`SELECT COUNT(*) AS count, MIN(ts) AS oldestAt FROM messages WHERE processed = 0`)
    .get() as { count: number; oldestAt: number | null };
  return {
    dataDir: config.dataDir,
    dbPath: path.join(config.dataDir, 'app.db'),
    sources,
    unprocessed,
  };
}

const MAX_LOG_BYTES = 200_000;

/**
 * Append a startup diagnostics snapshot to a persistent log file. A bare
 * console.log isn't retrievable from a double-clicked .app (no attached
 * terminal), so this writes to disk instead — readable later via Terminal
 * (`cat`) or by AirDropping the file, without needing the app to be running.
 */
export function logStartupDiagnostics(): void {
  try {
    const info = computeDiagnostics();
    const logDir = path.join(config.dataDir, 'logs');
    fs.mkdirSync(logDir, { recursive: true });
    const logPath = path.join(logDir, 'startup.log');
    const iso = (ms: number | null) => (ms ? new Date(ms).toISOString() : 'n/a');
    const lines = [
      `--- ${new Date().toISOString()} ---`,
      `dataDir: ${info.dataDir}`,
      `dbPath: ${info.dbPath}`,
      ...info.sources.map((s) => `  ${s.source}: ${s.count} messages, last at ${iso(s.lastAt)}`),
      `  unprocessed: ${info.unprocessed.count} (oldest ${iso(info.unprocessed.oldestAt)})`,
      '',
    ];
    fs.appendFileSync(logPath, lines.join('\n'));
    // Bound growth across months of restarts — keep only the most recent tail.
    if (fs.statSync(logPath).size > MAX_LOG_BYTES) {
      const tail = fs.readFileSync(logPath, 'utf8').slice(-MAX_LOG_BYTES);
      fs.writeFileSync(logPath, tail);
    }
    console.log(`  Data dir: ${info.dataDir}`);
  } catch (err) {
    console.warn('[diagnostics] failed to log startup info:', err instanceof Error ? err.message : err);
  }
}
