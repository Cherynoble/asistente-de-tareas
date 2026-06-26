import Anthropic from '@anthropic-ai/sdk';
import { db } from './db/index.js';
import { config } from './config.js';

/** Read a stored setting, or null. */
export function getSetting(key: string): string | null {
  const row = db().prepare('SELECT value FROM settings WHERE key = ?').get(key) as
    | { value: string }
    | undefined;
  return row ? row.value : null;
}

/** Write a setting (upsert). */
export function setSetting(key: string, value: string): void {
  db()
    .prepare(
      `INSERT INTO settings (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    )
    .run(key, value);
}

/** Effective Anthropic key: in-app setting wins, else the .env value. */
export function getApiKey(): string {
  return (getSetting('anthropic_api_key') || config.anthropicApiKey || '').trim();
}

/** A fresh Anthropic client using the current key (so in-app key changes apply). */
export function anthropicClient(): Anthropic {
  return new Anthropic({ apiKey: getApiKey() });
}

function parseChatList(key: string): string[] {
  const raw = getSetting(key);
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw) as unknown;
    return Array.isArray(arr) ? (arr as string[]) : [];
  } catch {
    return [];
  }
}

/** Selected iMessage chat_identifiers to ingest from; empty = all chats. */
export function getSelectedChats(): string[] {
  return parseChatList('selected_chats');
}

/** Selected WhatsApp chat IDs (JIDs) to ingest from; empty = all chats. */
export function getSelectedWaChats(): string[] {
  return parseChatList('wa_selected_chats');
}

export interface SchedulerConfig {
  enabled: boolean;
  cron: string; // node-cron expression
}

/** Scheduler config: in-app setting wins, else DAILY_CRON env / 7am default. */
export function getSchedulerConfig(): SchedulerConfig {
  const enabled = (getSetting('scheduler_enabled') ?? '1') === '1';
  const cron = getSetting('daily_cron') || process.env.DAILY_CRON || '0 7 * * *';
  return { enabled, cron };
}

/** Convert "HH:MM" to a daily cron expression. */
export function timeToCron(time: string): string | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(time.trim());
  if (!m) return null;
  const hour = Number(m[1]);
  const min = Number(m[2]);
  if (hour > 23 || min > 59) return null;
  return `${min} ${hour} * * *`;
}

/** Convert a daily cron expression back to "HH:MM" for display, if possible. */
export function cronToTime(cron: string): string {
  const parts = cron.split(/\s+/);
  if (parts.length === 5 && /^\d+$/.test(parts[0]!) && /^\d+$/.test(parts[1]!)) {
    return `${parts[1]!.padStart(2, '0')}:${parts[0]!.padStart(2, '0')}`;
  }
  return '07:00';
}
