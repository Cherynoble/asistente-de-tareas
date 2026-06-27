import fs from 'node:fs';
import path from 'node:path';
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

// ─────────────────────────── WhatsApp accounts ───────────────────────────
// The app supports several WhatsApp accounts at once (the owner's father runs
// two numbers). Each account has a stable id, its own session dir, and an
// optional custom label; we also cache the connected identity (phone + profile
// name) so the UI can show which account is which even before it reconnects.

export interface WaAccountMeta {
  id: string;
  authDir: string; // LocalAuth dataPath for this account's session
  label?: string; // user-chosen label, overrides the auto-detected name
}

const legacyAuthDir = () => path.join(config.dataDir, 'wwebjs_auth');
const accountAuthDir = (id: string) => path.join(config.dataDir, 'wa', id);

/** Cache dir for the WA-Web build (must be writable; per-account to avoid races). */
export function waCacheDir(id: string): string {
  return path.join(config.dataDir, 'wa-cache', id);
}

function dirHasContent(p: string): boolean {
  try {
    return fs.existsSync(p) && fs.readdirSync(p).length > 0;
  } catch {
    return false;
  }
}

/**
 * The registered WhatsApp accounts. Self-migrating: the first time this runs on
 * an install that predates multi-account, it seeds a single account `acc1`. If a
 * legacy single-account session exists at dataDir/wwebjs_auth, acc1 KEEPS that
 * directory in place — so the father's already-paired account survives the
 * upgrade with no re-pairing and no data loss.
 */
export function listWaAccounts(): WaAccountMeta[] {
  const raw = getSetting('wa_accounts');
  if (raw) {
    try {
      const arr = JSON.parse(raw) as WaAccountMeta[];
      if (Array.isArray(arr) && arr.length) return arr;
    } catch {
      /* fall through to (re)seed */
    }
  }
  const acc1: WaAccountMeta = {
    id: 'acc1',
    authDir: dirHasContent(legacyAuthDir()) ? legacyAuthDir() : accountAuthDir('acc1'),
  };
  const seeded = [acc1];
  setSetting('wa_accounts', JSON.stringify(seeded));
  return seeded;
}

function saveWaAccounts(accts: WaAccountMeta[]): void {
  setSetting('wa_accounts', JSON.stringify(accts));
}

/** Add a fresh WhatsApp account slot and return its metadata. */
export function addWaAccount(): WaAccountMeta {
  const accts = listWaAccounts();
  // Stable, collision-free id: acc + first unused integer.
  let n = accts.length + 1;
  const used = new Set(accts.map((a) => a.id));
  while (used.has(`acc${n}`)) n += 1;
  const meta: WaAccountMeta = { id: `acc${n}`, authDir: accountAuthDir(`acc${n}`) };
  saveWaAccounts([...accts, meta]);
  return meta;
}

/** Remove an account from the registry (caller wipes its session dir). */
export function removeWaAccount(id: string): void {
  saveWaAccounts(listWaAccounts().filter((a) => a.id !== id));
  // Drop its per-account settings too.
  db().prepare('DELETE FROM settings WHERE key = ?').run(`wa_selected_chats:${id}`);
  db().prepare('DELETE FROM settings WHERE key = ?').run(`wa_identity:${id}`);
  db().prepare('DELETE FROM settings WHERE key = ?').run(`wa_label:${id}`);
}

/** Set (or clear, with '') a user-chosen label for an account. */
export function setWaLabel(id: string, label: string): void {
  setSetting(`wa_label:${id}`, label.trim());
}

export function getWaLabel(id: string): string {
  return (getSetting(`wa_label:${id}`) || '').trim();
}

export interface WaIdentity {
  number: string; // phone number (wid.user)
  name: string; // WhatsApp profile / push name
}

/** Cache the connected identity so the UI can label the account when offline. */
export function setWaIdentity(id: string, ident: WaIdentity): void {
  setSetting(`wa_identity:${id}`, JSON.stringify(ident));
}

export function getWaIdentity(id: string): WaIdentity | null {
  const raw = getSetting(`wa_identity:${id}`);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as WaIdentity;
  } catch {
    return null;
  }
}

/**
 * Selected WhatsApp chat IDs (JIDs) to ingest for a given account; empty = all.
 * acc1 falls back to the pre-multi-account `wa_selected_chats` key so the
 * father's existing chat selection carries over after the upgrade.
 */
export function getSelectedWaChats(accountId = 'acc1'): string[] {
  const perAccount = parseChatList(`wa_selected_chats:${accountId}`);
  if (perAccount.length) return perAccount;
  if (accountId === 'acc1' && getSetting(`wa_selected_chats:acc1`) === null) {
    return parseChatList('wa_selected_chats'); // legacy fallback
  }
  return perAccount;
}

/** Persist a chat selection for an account. */
export function setSelectedWaChats(accountId: string, ids: string[]): void {
  setSetting(`wa_selected_chats:${accountId}`, JSON.stringify(ids));
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
