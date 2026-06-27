import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { db } from '../db/index.js';
import { config } from '../config.js';
import cron from 'node-cron';
import { runExtraction, processNewMessages, type ActivityEvent } from '../extract/pipeline.js';
import { ingestRecentDays, backfillByCount } from '../ingest/imessage/ingest.js';
import { listChats } from '../ingest/imessage/reader.js';
import {
  startAllSessions,
  stopAllAccounts,
  anyWaSession,
  listAccountStates,
  getAccountState,
  addAccount,
  removeAccount,
  renameAccount,
  startAccount,
  resetAccount,
  repairAccount,
  backfillAccount,
  listAccountChats,
  accountIsReady,
} from '../ingest/whatsapp/client.js';
import { runTurn } from '../chat/index.js';
import {
  listThreads,
  createThread,
  deleteThread,
  threadMessages,
  titleFrom,
  renameThread,
  listMemories,
  deleteMemory,
} from '../chat/store.js';
import { nameMap } from '../names.js';
import { resolveContactName } from '../ingest/contacts.js';
import { describeAttachment } from '../extract/vision.js';
import {
  listReminders,
  dueReminders,
  dismissReminder,
  deleteReminder,
  sweepReminderNotifications,
} from '../notify/scheduled.js';
import { macNotify } from '../notify/mac.js';
import {
  buildDigest,
  sendDailyDigest,
  runNudgeSweep,
  remindersEnabled,
  nudgeIntervalDays,
} from '../notify/reminders.js';
import {
  getApiKey,
  getSetting,
  setSetting,
  getSelectedChats,
  getSelectedWaChats,
  setSelectedWaChats,
  listWaAccounts,
  getSchedulerConfig,
  timeToCron,
  cronToTime,
} from '../settings.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, '..', '..', 'public');
const NATIVE_IMAGE = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);

const app = express();
app.use(express.json({ limit: '30mb' })); // base64 image/PDF uploads in chat
app.use(express.static(PUBLIC_DIR));

/** Proposed tasks awaiting review, with the message that triggered each. */
app.get('/api/inbox', (_req, res) => {
  const rows = db()
    .prepare(
      `SELECT t.id, t.title, t.detail, t.client_hint AS clientHint, t.source_quote AS sourceQuote,
              t.created_at AS createdAt, t.source_message_id AS sourceMessageId,
              m.body AS sourceBody, m.sender AS sourceSender, m.chat_name AS chatName,
              m.has_attachment AS hasAttachment, m.source AS source, m.wa_account AS waAccount
       FROM tasks t
       LEFT JOIN messages m ON m.id = t.source_message_id
       WHERE t.status = 'proposed' AND t.archived_at IS NULL AND t.deleted_at IS NULL
       ORDER BY t.created_at DESC, t.id DESC`,
    )
    .all();
  res.json(rows);
});

/** Active tasks (approved through to done), excluding archived. */
app.get('/api/tasks', (_req, res) => {
  const rows = db()
    .prepare(
      `SELECT t.id, t.title, t.detail, t.client_hint AS clientHint, t.source_quote AS sourceQuote,
              t.status, t.due_at AS dueAt, t.updated_at AS updatedAt,
              m.source AS source, m.wa_account AS waAccount
       FROM tasks t
       LEFT JOIN messages m ON m.id = t.source_message_id
       WHERE t.status IN ('todo','waiting','done') AND t.archived_at IS NULL AND t.deleted_at IS NULL
       ORDER BY CASE t.status WHEN 'todo' THEN 0 WHEN 'waiting' THEN 1 ELSE 2 END, t.updated_at DESC`,
    )
    .all();
  res.json(rows);
});

/** Archived tasks. */
app.get('/api/archive', (_req, res) => {
  const rows = db()
    .prepare(
      `SELECT id, title, detail, client_hint AS clientHint, status, archived_at AS archivedAt
       FROM tasks WHERE archived_at IS NOT NULL AND deleted_at IS NULL ORDER BY archived_at DESC`,
    )
    .all();
  res.json(rows);
});

/** Manually create a task (saved as todo). */
app.post('/api/tasks', (req, res) => {
  const { title, detail, client } = req.body as { title?: string; detail?: string; client?: string };
  if (!title || !title.trim()) {
    res.status(400).json({ error: 'title required' });
    return;
  }
  const now = Date.now();
  const info = db()
    .prepare(
      `INSERT INTO tasks (title, detail, status, client_hint, created_at, updated_at)
       VALUES (?, ?, 'todo', ?, ?, ?)`,
    )
    .run(title.trim(), (detail ?? '').trim(), (client ?? '').trim(), now, now);
  res.json({ ok: true, id: info.lastInsertRowid });
});

/** Archive / unarchive a task. */
app.post('/api/tasks/:id/archive', (req, res) => {
  const undo = (req.body as { undo?: boolean })?.undo === true;
  db()
    .prepare('UPDATE tasks SET archived_at = ?, updated_at = ? WHERE id = ?')
    .run(undo ? null : Date.now(), Date.now(), Number(req.params.id));
  res.json({ ok: true });
});

const TASK_STATUSES = ['proposed', 'todo', 'waiting', 'done', 'dismissed'];

/**
 * Bulk action over a set of task ids. action ∈
 * status | archive | unarchive | delete | restore | purge | client | due.
 * Used by the multi-select toolbars and per-card delete/restore buttons.
 */
app.post('/api/tasks/bulk', (req, res) => {
  const { ids, action, value } = req.body as { ids?: number[]; action?: string; value?: unknown };
  const idList = Array.isArray(ids) ? ids.map(Number).filter((n) => Number.isFinite(n)) : [];
  if (!idList.length || !action) {
    res.status(400).json({ error: 'ids and action required' });
    return;
  }
  const now = Date.now();
  const ph = idList.map(() => '?').join(',');
  let sql: string;
  let head: unknown[];
  switch (action) {
    case 'status': {
      const status = String(value);
      if (!TASK_STATUSES.includes(status)) {
        res.status(400).json({ error: 'bad status' });
        return;
      }
      sql = `UPDATE tasks SET status=?, updated_at=? WHERE id IN (${ph})`;
      head = [status, now];
      break;
    }
    case 'archive':
      sql = `UPDATE tasks SET archived_at=?, updated_at=? WHERE id IN (${ph})`;
      head = [now, now];
      break;
    case 'unarchive':
      sql = `UPDATE tasks SET archived_at=NULL, updated_at=? WHERE id IN (${ph})`;
      head = [now];
      break;
    case 'delete':
      sql = `UPDATE tasks SET deleted_at=?, updated_at=? WHERE id IN (${ph})`;
      head = [now, now];
      break;
    case 'restore':
      sql = `UPDATE tasks SET deleted_at=NULL, updated_at=? WHERE id IN (${ph})`;
      head = [now];
      break;
    case 'purge':
      sql = `DELETE FROM tasks WHERE id IN (${ph})`;
      head = [];
      break;
    case 'client':
      sql = `UPDATE tasks SET client_hint=?, updated_at=? WHERE id IN (${ph})`;
      head = [String(value ?? '').trim(), now];
      break;
    case 'due': {
      const dueAt = value == null || value === '' ? null : Number(value);
      sql = `UPDATE tasks SET due_at=?, updated_at=? WHERE id IN (${ph})`;
      head = [dueAt, now];
      break;
    }
    default:
      res.status(400).json({ error: 'unknown action' });
      return;
  }
  const info = db().prepare(sql).run(...head, ...idList);
  res.json({ ok: true, changed: info.changes });
});

/** Bulk action over a set of client handles. action ∈ delete | restore | purge. */
app.post('/api/clients/bulk', (req, res) => {
  const { handles, action } = req.body as { handles?: string[]; action?: string };
  const list = Array.isArray(handles) ? handles.filter((h) => typeof h === 'string' && h) : [];
  if (!list.length || !action) {
    res.status(400).json({ error: 'handles and action required' });
    return;
  }
  const now = Date.now();
  const ph = list.map(() => '?').join(',');
  const d = db();
  if (action === 'delete') {
    // Tombstone the handle (create an empty record if it isn't a client yet) so
    // it's hidden from Clientes and its name dropped — tasks are untouched.
    const ins = d.prepare(
      `INSERT INTO clients (handle, name, product_need, deleted_at, created_at, updated_at)
       VALUES (?, '', '', ?, ?, ?)
       ON CONFLICT(handle) DO UPDATE SET deleted_at = excluded.deleted_at, updated_at = excluded.updated_at`,
    );
    const tx = d.transaction((hs: string[]) => {
      for (const h of hs) ins.run(h, now, now, now);
    });
    tx(list);
  } else if (action === 'restore') {
    d.prepare(`UPDATE clients SET deleted_at=NULL, updated_at=? WHERE handle IN (${ph})`).run(now, ...list);
  } else if (action === 'purge') {
    d.prepare(`DELETE FROM clients WHERE handle IN (${ph})`).run(...list);
  } else {
    res.status(400).json({ error: 'unknown action' });
    return;
  }
  res.json({ ok: true });
});

/** Soft-deleted tasks and clients, for the Trash tab. */
app.get('/api/trash', (_req, res) => {
  const d = db();
  const tasks = d
    .prepare(
      `SELECT id, title, detail, client_hint AS clientHint, status, deleted_at AS deletedAt
       FROM tasks WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC`,
    )
    .all();
  const clients = d
    .prepare(
      `SELECT handle, name, product_need AS productNeed, deleted_at AS deletedAt
       FROM clients WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC`,
    )
    .all();
  res.json({ tasks, clients });
});

/** Permanently empty the trash (tasks, clients, or both). */
app.post('/api/trash/empty', (req, res) => {
  const type = (req.body as { type?: string })?.type ?? 'all';
  const d = db();
  if (type === 'tasks' || type === 'all') d.prepare(`DELETE FROM tasks WHERE deleted_at IS NOT NULL`).run();
  if (type === 'clients' || type === 'all') d.prepare(`DELETE FROM clients WHERE deleted_at IS NOT NULL`).run();
  res.json({ ok: true });
});

/**
 * Distinct senders with message counts, the resolved display name, and any
 * manual client name/product-need. Limited to senders that appear in the chats
 * selected in Settings (empty selection = all chats), so the Clientes tab only
 * lists people the owner actually chose to track.
 */
app.get('/api/senders', (_req, res) => {
  const d = db();
  const selImsg = getSelectedChats();
  // WhatsApp chat selection is per-account (empty = all for that account).
  const waSel = new Map(listWaAccounts().map((a) => [a.id, getSelectedWaChats(a.id)]));
  const anyWaFilter = [...waSel.values()].some((s) => s.length > 0);
  const filtering = selImsg.length > 0 || anyWaFilter;

  // Which raw chat_ids are "included" given the per-source selections.
  let allowed: string[] = [];
  let noneAllowed = false;
  if (filtering) {
    const chatRows = d
      .prepare(`SELECT DISTINCT source, wa_account, chat_id FROM messages WHERE chat_id IS NOT NULL`)
      .all() as { source: string; wa_account: string | null; chat_id: string }[];
    for (const r of chatRows) {
      if (r.source === 'whatsapp') {
        const sel = waSel.get(r.wa_account || 'acc1') ?? getSelectedWaChats(r.wa_account || 'acc1');
        if (!sel.length || sel.includes(r.chat_id)) allowed.push(r.chat_id);
      } else {
        const ident = String(r.chat_id).split(';').pop() ?? r.chat_id;
        if (!selImsg.length || selImsg.includes(ident)) allowed.push(r.chat_id);
      }
    }
    if (!allowed.length) noneAllowed = true;
  }

  type Row = { handle: string; count: number; name: string | null; productNeed: string | null };
  const byHandle = new Map<string, Row>();

  // 1) Message senders (subject to the selected-chats filter).
  if (!noneAllowed) {
    const where =
      `WHERE m.sender IS NOT NULL AND m.sender != 'me'` +
      ` AND m.sender NOT IN (SELECT handle FROM clients WHERE deleted_at IS NOT NULL AND handle IS NOT NULL)` +
      (filtering ? ` AND m.chat_id IN (${allowed.map(() => '?').join(',')})` : '');
    const rows = d
      .prepare(
        `SELECT m.sender AS handle, COUNT(*) AS count, c.name AS name, c.product_need AS productNeed
         FROM messages m
         LEFT JOIN clients c ON c.handle = m.sender AND c.deleted_at IS NULL
         ${where}
         GROUP BY m.sender ORDER BY count DESC LIMIT 200`,
      )
      .all(...(filtering ? allowed : [])) as Row[];
    for (const r of rows) byHandle.set(r.handle, r);
  }

  // 2) Clients referenced by a task (client_hint) but not in the message senders
  //    — e.g. a brand-new client typed into a manually/AI-created task. These are
  //    explicit, so they show regardless of the chat filter.
  const deleted = new Set(
    (d.prepare(`SELECT handle FROM clients WHERE deleted_at IS NOT NULL AND handle IS NOT NULL`).all() as {
      handle: string;
    }[]).map((x) => x.handle),
  );
  const taskClients = d
    .prepare(`SELECT DISTINCT client_hint AS h FROM tasks WHERE client_hint != '' AND deleted_at IS NULL`)
    .all() as { h: string }[];
  for (const { h } of taskClients) {
    if (byHandle.has(h) || deleted.has(h)) continue;
    const c = d
      .prepare(`SELECT name, product_need AS productNeed FROM clients WHERE handle = ? AND deleted_at IS NULL`)
      .get(h) as { name: string; productNeed: string } | undefined;
    byHandle.set(h, { handle: h, count: 0, name: c?.name ?? null, productNeed: c?.productNeed ?? null });
  }

  const names = nameMap();
  const out = [...byHandle.values()]
    .map((r) => ({ ...r, displayName: names[r.handle] ?? null }))
    .sort((a, b) => b.count - a.count);
  res.json(out);
});

/** Create/update a client: name + product-need for a handle. */
app.post('/api/clients', (req, res) => {
  const { handle, name, productNeed } = req.body as {
    handle?: string;
    name?: string;
    productNeed?: string;
  };
  if (!handle || !name || !name.trim()) {
    res.status(400).json({ error: 'handle and name required' });
    return;
  }
  const now = Date.now();
  db()
    .prepare(
      `INSERT INTO clients (handle, name, product_need, created_at, updated_at)
       VALUES (@handle, @name, @productNeed, @now, @now)
       ON CONFLICT(handle) DO UPDATE SET
         name = excluded.name, product_need = excluded.product_need,
         deleted_at = NULL, updated_at = excluded.updated_at`,
    )
    .run({ handle, name: name.trim(), productNeed: (productNeed ?? '').trim(), now });
  res.json({ ok: true });
});

/** handle → display name (manual > macOS Contacts > WhatsApp pushname). */
app.get('/api/namemap', (_req, res) => {
  res.json(nameMap());
});

/** List saved chat threads. */
app.get('/api/threads', (_req, res) => {
  res.json(listThreads());
});

/** Create a new chat thread. */
app.post('/api/threads', (_req, res) => {
  res.json({ id: createThread() });
});

/** Messages of one thread. */
app.get('/api/threads/:id', (req, res) => {
  res.json(threadMessages(Number(req.params.id)));
});

/** Delete a thread and its messages. */
app.delete('/api/threads/:id', (req, res) => {
  deleteThread(Number(req.params.id));
  res.json({ ok: true });
});

/**
 * Send a message in a thread and get the assistant's reply. Creates the thread
 * if none is given, and titles it from the first message. Uses Haiku with the
 * DB + long-term memory as context, and may call the save_memory tool.
 */
app.post('/api/chat', async (req, res) => {
  if (!getApiKey()) {
    res.status(400).json({ error: 'No ANTHROPIC_API_KEY set in .env' });
    return;
  }
  const body = (req.body as { threadId?: number; message?: string }) ?? {};
  const message = (body.message ?? '').trim();
  if (!message) {
    res.status(400).json({ error: 'message required' });
    return;
  }
  try {
    let threadId = Number(body.threadId);
    let createdThread = false;
    if (!threadId || !Number.isFinite(threadId)) {
      threadId = createThread(titleFrom(message));
      createdThread = true;
    } else if (threadMessages(threadId).length === 0) {
      renameThread(threadId, titleFrom(message));
    }
    const { reply, usedTools } = await runTurn(threadId, message);
    res.json({ reply, threadId, createdThread, usedTools });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

/** The assistant's long-term memory (read / delete). */
app.get('/api/memory', (_req, res) => {
  res.json(listMemories());
});
app.delete('/api/memory/:id', (req, res) => {
  deleteMemory(Number(req.params.id));
  res.json({ ok: true });
});

/**
 * Send an image/PDF in a chat thread: save it, describe it with vision, and feed
 * that description into the chat turn so the assistant can discuss it (and create
 * a task from it if asked). Files come as base64 JSON (no multipart dependency).
 */
app.post('/api/chat/upload', async (req, res) => {
  if (!getApiKey()) {
    res.status(400).json({ error: 'No ANTHROPIC_API_KEY set in .env' });
    return;
  }
  const b =
    (req.body as { threadId?: number; message?: string; fileName?: string; mimeType?: string; dataBase64?: string }) ??
    {};
  const mime = b.mimeType ?? '';
  const data = b.dataBase64 ?? '';
  const name = (b.fileName ?? 'archivo').replace(/[^\w.\- ]/g, '_').slice(0, 80);
  if (!data || !(/^image\//.test(mime) || mime === 'application/pdf')) {
    res.status(400).json({ error: 'Solo se permiten imágenes o PDF.' });
    return;
  }
  try {
    const userText = (b.message ?? '').trim();
    let threadId = Number(b.threadId);
    let createdThread = false;
    if (!threadId || !Number.isFinite(threadId)) {
      threadId = createThread(titleFrom(userText || name));
      createdThread = true;
    } else if (threadMessages(threadId).length === 0) {
      renameThread(threadId, titleFrom(userText || name));
    }
    const dir = path.join(config.dataDir, 'chat_uploads', String(threadId));
    fs.mkdirSync(dir, { recursive: true });
    const filePath = path.join(dir, `${Date.now()}-${name}`);
    fs.writeFileSync(filePath, Buffer.from(data, 'base64'));

    const desc = await describeAttachment(filePath, mime);
    const composed = `${userText ? userText + '\n\n' : ''}🔎 Archivo adjunto: ${name}\nAnálisis del archivo:\n${desc}`;
    const { reply, usedTools } = await runTurn(threadId, composed, [{ name }]);
    res.json({ reply, threadId, createdThread, usedTools, attachment: { name }, analysis: desc });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

/** Scheduled (AI) reminders: list / dismiss / delete. */
app.get('/api/agenda', (_req, res) => {
  res.json(listReminders());
});
app.post('/api/agenda/:id/dismiss', (req, res) => {
  dismissReminder(Number(req.params.id));
  res.json({ ok: true });
});
app.delete('/api/agenda/:id', (req, res) => {
  deleteReminder(Number(req.params.id));
  res.json({ ok: true });
});

/** Launch digest: tasks auto-proposed since last seen + reminders now due. */
app.get('/api/digest', (_req, res) => {
  const lastSeen = Number(getSetting('last_digest_seen') ?? '0');
  const newTasks = db()
    .prepare(
      `SELECT id, title, detail, client_hint AS clientHint FROM tasks
       WHERE created_at > ? AND status = 'proposed' AND archived_at IS NULL AND deleted_at IS NULL
       ORDER BY created_at DESC LIMIT 50`,
    )
    .all(lastSeen);
  res.json({ newTasks, reminders: dueReminders(), lastSeen });
});
app.post('/api/digest/seen', (_req, res) => {
  setSetting('last_digest_seen', String(Date.now()));
  res.json({ ok: true });
});

// ── WhatsApp accounts (multi-account: the father runs two numbers) ──

/** All registered accounts with their status, identity, and QR. */
app.get('/api/whatsapp/accounts', (_req, res) => {
  res.json({ accounts: listAccountStates() });
});

/** Add a fresh account slot and begin pairing it. */
app.post('/api/whatsapp/accounts', (_req, res) => {
  res.json(addAccount());
});

/** Remove an account: stop it, wipe its session, drop it from the registry. */
app.delete('/api/whatsapp/accounts/:id', async (req, res) => {
  await removeAccount(req.params.id);
  res.json({ ok: true, accounts: listAccountStates() });
});

/** Rename (custom label) an account; empty label reverts to auto-detected. */
app.post('/api/whatsapp/accounts/:id/label', (req, res) => {
  const label = String((req.body as { label?: string })?.label ?? '');
  res.json(renameAccount(req.params.id, label) ?? { error: 'cuenta no encontrada' });
});

/** Start (begin pairing / reconnect) a single account. */
app.post('/api/whatsapp/accounts/:id/start', (req, res) => {
  res.json(startAccount(req.params.id) ?? { error: 'cuenta no encontrada' });
});

/** One account's status + current QR. */
app.get('/api/whatsapp/accounts/:id/status', (req, res) => {
  res.json(getAccountState(req.params.id) ?? { error: 'cuenta no encontrada' });
});

/** Hard reset one account: scrub orphan Chrome + stale locks, reconnect. */
app.post('/api/whatsapp/accounts/:id/reset', async (req, res) => {
  res.json((await resetAccount(req.params.id)) ?? { error: 'cuenta no encontrada' });
});

/** Re-pair one account: wipe its (corrupted) session so a fresh QR is shown. */
app.post('/api/whatsapp/accounts/:id/repair', async (req, res) => {
  res.json((await repairAccount(req.params.id)) ?? { error: 'cuenta no encontrada' });
});

/** Backfill recent history for one connected account. */
app.post('/api/whatsapp/accounts/:id/backfill', async (req, res) => {
  const perChat = Math.min(Math.max(Number((req.body as { perChat?: number })?.perChat ?? 50), 1), 500);
  try {
    res.json(await backfillAccount(req.params.id, perChat));
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

/** One account's chats for the selection UI (requires that account to be ready). */
app.get('/api/whatsapp/accounts/:id/chats', async (req, res) => {
  const id = req.params.id;
  if (!accountIsReady(id)) {
    res.json({ chats: [], filtering: false, ready: false });
    return;
  }
  try {
    const selected = new Set(getSelectedWaChats(id));
    const names = nameMap();
    const chats = (await listAccountChats(id)).map((c) => ({
      ...c,
      selected: selected.has(c.id),
      displayName: names[c.id] || c.name || resolveContactName(c.id) || c.id,
    }));
    res.json({ chats, filtering: selected.size > 0, ready: true });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

/** Save a chat selection for one account (empty = all chats). */
app.post('/api/whatsapp/accounts/:id/chats', (req, res) => {
  const ids = (req.body as { chats?: unknown })?.chats;
  setSelectedWaChats(req.params.id, Array.isArray(ids) ? ids.filter((x) => typeof x === 'string') : []);
  res.json({ ok: true });
});

/** Available iMessage chats (with counts) for the selection UI. */
app.get('/api/chats', (_req, res) => {
  try {
    const selected = new Set(getSelectedChats());
    const names = nameMap();
    const chats = listChats().map((c) => ({
      ...c,
      selected: selected.has(c.id),
      displayName: c.isGroup ? c.name : names[c.id] || resolveContactName(c.id) || c.name,
    }));
    res.json({ chats, filtering: selected.size > 0 });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(/authorization|unable to open/i.test(msg) ? 403 : 500).json({ error: msg });
  }
});

/** Read current settings (never returns the key itself). */
app.get('/api/settings', (_req, res) => {
  const { enabled, cron: expr } = getSchedulerConfig();
  res.json({
    hasApiKey: Boolean(getApiKey()),
    apiKeyFromEnv: Boolean(config.anthropicApiKey) && !getSetting('anthropic_api_key'),
    schedulerEnabled: enabled,
    dailyTime: cronToTime(expr),
    remindersEnabled: remindersEnabled(),
    nudgeIntervalDays: nudgeIntervalDays(),
  });
});

/** Update settings: API key, scheduler on/off + time, selected chats. */
app.post('/api/settings', (req, res) => {
  const b = req.body as {
    apiKey?: string;
    schedulerEnabled?: boolean;
    dailyTime?: string;
    selectedChats?: string[];
    remindersEnabled?: boolean;
    nudgeIntervalDays?: number;
  };
  if (typeof b.apiKey === 'string') setSetting('anthropic_api_key', b.apiKey.trim());
  if (typeof b.remindersEnabled === 'boolean')
    setSetting('reminders_enabled', b.remindersEnabled ? '1' : '0');
  if (typeof b.nudgeIntervalDays === 'number' && b.nudgeIntervalDays >= 1)
    setSetting('nudge_interval_days', String(Math.floor(b.nudgeIntervalDays)));
  if (typeof b.schedulerEnabled === 'boolean')
    setSetting('scheduler_enabled', b.schedulerEnabled ? '1' : '0');
  if (typeof b.dailyTime === 'string') {
    const expr = timeToCron(b.dailyTime);
    if (expr) setSetting('daily_cron', expr);
  }
  if (Array.isArray(b.selectedChats))
    setSetting('selected_chats', JSON.stringify(b.selectedChats.filter((x) => typeof x === 'string')));
  applySchedule();
  res.json({ ok: true });
});

app.get('/api/stats', (_req, res) => {
  const d = db();
  const count = (s: string) =>
    (
      d
        .prepare('SELECT COUNT(*) AS n FROM tasks WHERE status = ? AND deleted_at IS NULL')
        .get(s) as { n: number }
    ).n;
  const messages = (d.prepare('SELECT COUNT(*) AS n FROM messages').get() as { n: number }).n;
  const trash =
    (d.prepare('SELECT COUNT(*) AS n FROM tasks WHERE deleted_at IS NOT NULL').get() as { n: number }).n +
    (d.prepare('SELECT COUNT(*) AS n FROM clients WHERE deleted_at IS NOT NULL').get() as { n: number }).n;
  res.json({
    messages,
    proposed: count('proposed'),
    todo: count('todo'),
    waiting: count('waiting'),
    done: count('done'),
    dismissed: count('dismissed'),
    trash,
    hasApiKey: Boolean(getApiKey()),
  });
});

app.post('/api/tasks/:id/status', (req, res) => {
  const status = (req.body as { status?: string }).status ?? '';
  const allowed = ['proposed', 'todo', 'waiting', 'done', 'dismissed'];
  if (!allowed.includes(status)) {
    res.status(400).json({ error: 'invalid status' });
    return;
  }
  db().prepare('UPDATE tasks SET status = ?, updated_at = ? WHERE id = ?').run(
    status,
    Date.now(),
    Number(req.params.id),
  );
  res.json({ ok: true });
});

/** Set or clear a task's due date (unix ms, or null to clear). */
app.post('/api/tasks/:id/due', (req, res) => {
  const raw = (req.body as { dueAt?: number | null }).dueAt;
  const dueAt = raw == null || Number.isNaN(Number(raw)) ? null : Number(raw);
  db()
    .prepare('UPDATE tasks SET due_at = ?, updated_at = ? WHERE id = ?')
    .run(dueAt, Date.now(), Number(req.params.id));
  res.json({ ok: true });
});

/** Reminder settings + a live preview of today's digest and what's pending. */
app.get('/api/reminders', (_req, res) => {
  res.json({
    enabled: remindersEnabled(),
    nudgeIntervalDays: nudgeIntervalDays(),
    digest: buildDigest(),
  });
});

/** Fire a test notification so the user can confirm banners are allowed. */
app.post('/api/reminders/test', (_req, res) => {
  macNotify({
    title: 'Asistente de Tareas',
    subtitle: 'Notificación de prueba',
    message: 'Las notificaciones funcionan — los recordatorios aparecerán así.',
  });
  res.json({ ok: true });
});

/** Send the morning digest right now (manual trigger / preview). */
app.post('/api/reminders/digest', (_req, res) => {
  res.json({ ok: true, digest: sendDailyDigest() });
});

/** Force a nudge sweep now (ignores the per-task throttle). */
app.post('/api/reminders/nudge', (_req, res) => {
  res.json({ ok: true, result: runNudgeSweep(Date.now(), { force: true }) });
});

/** Serve an attachment by message id + index, converting HEIC/etc. to JPEG. */
app.get('/api/attachment', (req, res) => {
  const id = Number(req.query.id);
  const i = Number(req.query.i ?? 0);
  const row = db()
    .prepare('SELECT attachment_paths, attachment_mimes FROM messages WHERE id = ?')
    .get(id) as { attachment_paths: string; attachment_mimes: string } | undefined;
  if (!row) {
    res.status(404).end();
    return;
  }
  const filePath = (row.attachment_paths || '').split('||')[i];
  const mime = (row.attachment_mimes || '').split('||')[i];
  if (!filePath || !mime) {
    res.status(404).end();
    return;
  }
  const abs = filePath.startsWith('~') ? path.join(os.homedir(), filePath.slice(1)) : filePath;
  if (!fs.existsSync(abs)) {
    res.status(404).end();
    return;
  }
  if (NATIVE_IMAGE.has(mime) || mime === 'application/pdf') {
    res.type(mime);
    fs.createReadStream(abs).pipe(res);
    return;
  }
  // Convert (HEIC, TIFF, …) to JPEG for the browser.
  try {
    const tmp = path.join(os.tmpdir(), `dash-${id}-${i}-${Date.now()}.jpg`);
    execFileSync('/usr/bin/sips', ['-s', 'format', 'jpeg', abs, '--out', tmp], { stdio: 'ignore' });
    res.type('image/jpeg');
    const stream = fs.createReadStream(tmp);
    stream.pipe(res);
    stream.on('close', () => fs.unlink(tmp, () => {}));
  } catch {
    res.status(415).end();
  }
});

/** Live extraction over SSE — streams every message sifted and image analyzed. */
app.get('/api/extract/stream', async (req, res) => {
  if (!getApiKey()) {
    res.status(400).json({ error: 'No ANTHROPIC_API_KEY set in .env' });
    return;
  }
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();

  const limit = Number(req.query.limit ?? 60);
  const vision = req.query.vision === '1';
  // Clamp the per-run vision cap to a sane range to bound cost.
  const visionCap = Math.min(Math.max(Number(req.query.cap ?? 10), 1), 50);
  const send = (e: ActivityEvent) => res.write(`data: ${JSON.stringify(e)}\n\n`);

  try {
    await runExtraction({ limit, vision, visionCap, onEvent: send });
  } catch (err) {
    res.write(
      `event: failed\ndata: ${JSON.stringify({ message: err instanceof Error ? err.message : String(err) })}\n\n`,
    );
  } finally {
    res.end();
  }
});

/** One-time backfill: import the most recent N iMessages. */
app.post('/api/backfill', (req, res) => {
  const count = Math.min(Math.max(Number((req.body as { count?: number })?.count ?? 1000), 1), 50000);
  try {
    const { read, inserted } = backfillByCount(count);
    const total = (db().prepare('SELECT COUNT(*) AS n FROM messages').get() as { n: number }).n;
    res.json({ ok: true, read, inserted, total });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

/**
 * Continuous engine over SSE: pull any new iMessages, then process all
 * UNPROCESSED messages in batches (deduped), proposing tasks live.
 */
app.get('/api/process/stream', async (req, res) => {
  if (!getApiKey()) {
    res.status(400).json({ error: 'No ANTHROPIC_API_KEY set in .env' });
    return;
  }
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();

  const vision = req.query.vision === '1';
  const visionCap = Math.min(Math.max(Number(req.query.cap ?? 15), 0), 100);
  const maxBatches = Math.min(Math.max(Number(req.query.maxBatches ?? 10), 1), 100);
  const send = (e: ActivityEvent) => res.write(`data: ${JSON.stringify(e)}\n\n`);

  try {
    // Pull anything new first (cheap; deduped), so "process new" sees today's messages.
    ingestSafely();
    await processNewMessages({ vision, visionCap, maxBatches, onEvent: send });
  } catch (err) {
    res.write(
      `event: failed\ndata: ${JSON.stringify({ message: err instanceof Error ? err.message : String(err) })}\n\n`,
    );
  } finally {
    res.end();
  }
});

// Pull recent iMessages, but never let a chat.db failure (e.g. Full Disk Access
// not granted yet, or a WhatsApp-only setup) abort processing — we still want to
// process messages already stored (incl. WhatsApp).
function ingestSafely(): void {
  try {
    ingestRecentDays(config.historyDays);
  } catch (err) {
    console.warn('[ingest] iMessage pull skipped:', err instanceof Error ? err.message : err);
  }
}

// Daily auto ingest + process, configurable in-app (Settings tab) and live-
// reschedulable. Reads scheduler config from settings (falls back to DAILY_CRON
// env / 7am default).
let scheduledTask: ReturnType<typeof cron.schedule> | null = null;
function applySchedule(): void {
  scheduledTask?.stop();
  scheduledTask = null;
  const { enabled, cron: expr } = getSchedulerConfig();
  if (!enabled || !getApiKey() || !cron.validate(expr)) {
    console.log('  Daily auto-process: off');
    return;
  }
  scheduledTask = cron.schedule(expr, async () => {
    console.log(`[cron] ${new Date().toISOString()} daily ingest + process`);
    try {
      ingestSafely();
      const r = await processNewMessages({ vision: true, visionCap: 20, maxBatches: 50 });
      console.log(`[cron] processed ${r.processed}, proposed ${r.proposed}, remaining ${r.remaining}`);
      // Morning digest right after the day's messages are processed.
      const d = sendDailyDigest();
      console.log(`[cron] digest: ${d.counts.total} open (${d.counts.overdue} overdue)`);
    } catch (err) {
      console.error('[cron] failed:', err instanceof Error ? err.message : err);
    }
  });
  console.log(`  Daily auto-process scheduled: "${expr}"`);
}

// Escalating nudges: re-surface unfinished tasks every ~2 days (per-task
// throttle lives in runNudgeSweep). We check hourly but only notify during
// waking hours so nobody gets a 3am ping.
let nudgeTimer: ReturnType<typeof setInterval> | null = null;
function startNudgeLoop(): void {
  if (nudgeTimer) return;
  const tick = () => {
    const hour = new Date().getHours();
    if (hour < 8 || hour >= 21) return;
    try {
      const r = runNudgeSweep();
      if (r.nudged) console.log(`[nudge] ${r.nudged} task(s) nudged (${r.overdue} overdue)`);
    } catch (err) {
      console.error('[nudge] failed:', err instanceof Error ? err.message : err);
    }
  };
  nudgeTimer = setInterval(tick, 60 * 60 * 1000); // hourly
}

// Resilience net for an always-on app: a stray promise rejection from a library
// internal (e.g. puppeteer/whatsapp-web.js) shouldn't take the whole app down.
// Log it and keep serving — our own async paths are already guarded.
process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection]', reason instanceof Error ? reason.message : reason);
});

// Close the WhatsApp browser cleanly on shutdown so it doesn't leave an
// orphaned Chrome holding the session lock (which blocks the next start).
for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    void stopAllAccounts().finally(() => process.exit(0));
  });
}

const PORT = Number(process.env.PORT ?? 4319);
app.listen(PORT, () => {
  console.log(`\n  Dad's App dashboard → http://localhost:${PORT}\n`);
  applySchedule();
  startNudgeLoop();
  // Fire native notifications for scheduled reminders that come due (every 5 min;
  // the launch digest is the reliable backstop).
  setInterval(() => {
    try {
      sweepReminderNotifications();
    } catch (err) {
      console.error('[reminders] sweep failed:', err instanceof Error ? err.message : err);
    }
  }, 5 * 60 * 1000);

  // Sleep/wake detector (works without the Electron shell): if the wall clock
  // jumps far past our tick interval, the Mac most likely slept — and macOS may
  // have killed the puppeteer Chrome, leaving a wedged/disconnected session that
  // never silently recovers. On a detected wake, reconnect any paired account
  // that isn't currently 'ready' (reset scrubs orphans + relaunches cleanly).
  // This directly addresses "laptop closed → WhatsApp signed out, auto sign-in
  // doesn't kick in". A still-healthy 'ready' account is left alone.
  const WAKE_TICK_MS = 30_000;
  let lastWakeTick = Date.now();
  setInterval(() => {
    const now = Date.now();
    const gap = now - lastWakeTick;
    lastWakeTick = now;
    if (gap > WAKE_TICK_MS * 4) {
      console.log(`[whatsapp] wake detected (gap ${Math.round(gap / 1000)}s) — health-checking accounts`);
      for (const s of listAccountStates()) {
        // Only revive accounts that are genuinely stuck (paired but idle/dropped).
        // Leave alone ones already pairing/syncing/connected — and ones the
        // Electron shell's powerMonitor may have just restarted on resume.
        if (s.hasSession && (s.status === 'disconnected' || s.status === 'idle')) {
          console.log(`[whatsapp:${s.id}] reconnecting after wake`);
          void resetAccount(s.id);
        }
      }
    }
  }, WAKE_TICK_MS);

  // Reconnect every account that already has a paired session.
  if (anyWaSession()) {
    console.log('  WhatsApp session(s) found — reconnecting…');
    startAllSessions();
  }
});
