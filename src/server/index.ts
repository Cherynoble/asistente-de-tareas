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
  startWhatsApp,
  stopWhatsApp,
  resetWhatsApp,
  repairWhatsApp,
  getWaState,
  backfillWhatsApp,
  hasWaSession,
  listWaChats,
} from '../ingest/whatsapp/client.js';
import { chat, type ChatMsg } from '../chat/index.js';
import { nameMap } from '../names.js';
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
  getSchedulerConfig,
  timeToCron,
  cronToTime,
} from '../settings.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, '..', '..', 'public');
const NATIVE_IMAGE = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);

const app = express();
app.use(express.json());
app.use(express.static(PUBLIC_DIR));

/** Proposed tasks awaiting review, with the message that triggered each. */
app.get('/api/inbox', (_req, res) => {
  const rows = db()
    .prepare(
      `SELECT t.id, t.title, t.detail, t.client_hint AS clientHint, t.source_quote AS sourceQuote,
              t.created_at AS createdAt, t.source_message_id AS sourceMessageId,
              m.body AS sourceBody, m.sender AS sourceSender, m.chat_name AS chatName,
              m.has_attachment AS hasAttachment
       FROM tasks t
       LEFT JOIN messages m ON m.id = t.source_message_id
       WHERE t.status = 'proposed' AND t.archived_at IS NULL
       ORDER BY t.created_at DESC, t.id DESC`,
    )
    .all();
  res.json(rows);
});

/** Active tasks (approved through to done), excluding archived. */
app.get('/api/tasks', (_req, res) => {
  const rows = db()
    .prepare(
      `SELECT id, title, detail, client_hint AS clientHint, source_quote AS sourceQuote,
              status, due_at AS dueAt, updated_at AS updatedAt
       FROM tasks WHERE status IN ('todo','waiting','done') AND archived_at IS NULL
       ORDER BY CASE status WHEN 'todo' THEN 0 WHEN 'waiting' THEN 1 ELSE 2 END, updated_at DESC`,
    )
    .all();
  res.json(rows);
});

/** Archived tasks. */
app.get('/api/archive', (_req, res) => {
  const rows = db()
    .prepare(
      `SELECT id, title, detail, client_hint AS clientHint, status, archived_at AS archivedAt
       FROM tasks WHERE archived_at IS NOT NULL ORDER BY archived_at DESC`,
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

/**
 * Distinct senders with message counts, the resolved display name, and any
 * manual client name/product-need. Limited to senders that appear in the chats
 * selected in Settings (empty selection = all chats), so the Clientes tab only
 * lists people the owner actually chose to track.
 */
app.get('/api/senders', (_req, res) => {
  const selImsg = getSelectedChats();
  const selWa = getSelectedWaChats();
  const filtering = selImsg.length > 0 || selWa.length > 0;

  // Which raw chat_ids are "included" given the per-source selections.
  let allowed: string[] = [];
  if (filtering) {
    const chatRows = db()
      .prepare(`SELECT DISTINCT source, chat_id FROM messages WHERE chat_id IS NOT NULL`)
      .all() as { source: string; chat_id: string }[];
    for (const r of chatRows) {
      if (r.source === 'whatsapp') {
        if (!selWa.length || selWa.includes(r.chat_id)) allowed.push(r.chat_id);
      } else {
        const ident = String(r.chat_id).split(';').pop() ?? r.chat_id;
        if (!selImsg.length || selImsg.includes(ident)) allowed.push(r.chat_id);
      }
    }
    if (!allowed.length) {
      res.json([]);
      return;
    }
  }

  const where =
    `WHERE m.sender IS NOT NULL AND m.sender != 'me'` +
    (filtering ? ` AND m.chat_id IN (${allowed.map(() => '?').join(',')})` : '');
  const rows = db()
    .prepare(
      `SELECT m.sender AS handle, COUNT(*) AS count, c.name AS name, c.product_need AS productNeed
       FROM messages m
       LEFT JOIN clients c ON c.handle = m.sender
       ${where}
       GROUP BY m.sender ORDER BY count DESC LIMIT 200`,
    )
    .all(...(filtering ? allowed : [])) as {
    handle: string;
    count: number;
    name: string | null;
    productNeed: string | null;
  }[];

  const names = nameMap();
  res.json(rows.map((r) => ({ ...r, displayName: names[r.handle] ?? null })));
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
         name = excluded.name, product_need = excluded.product_need, updated_at = excluded.updated_at`,
    )
    .run({ handle, name: name.trim(), productNeed: (productNeed ?? '').trim(), now });
  res.json({ ok: true });
});

/** handle → display name (manual > macOS Contacts > WhatsApp pushname). */
app.get('/api/namemap', (_req, res) => {
  res.json(nameMap());
});

/** Chat with Haiku using the message/task/client database as context. */
app.post('/api/chat', async (req, res) => {
  if (!getApiKey()) {
    res.status(400).json({ error: 'No ANTHROPIC_API_KEY set in .env' });
    return;
  }
  const history = ((req.body as { messages?: ChatMsg[] })?.messages ?? []).slice(-20);
  try {
    const reply = await chat(history);
    res.json({ reply });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

/** Start the read-only WhatsApp mirror (begins QR pairing). */
app.post('/api/whatsapp/start', (_req, res) => {
  startWhatsApp();
  res.json(getWaState());
});

/** WhatsApp connection status + current QR (data URL) if pairing. */
app.get('/api/whatsapp/status', (_req, res) => {
  res.json(getWaState());
});

/** Hard reset: scrub orphan Chrome + stale locks and reconnect from scratch. */
app.post('/api/whatsapp/reset', async (_req, res) => {
  await resetWhatsApp();
  res.json(getWaState());
});

/** Re-pair: wipe the (possibly corrupted) session so a fresh QR is shown. */
app.post('/api/whatsapp/repair', async (_req, res) => {
  await repairWhatsApp();
  res.json(getWaState());
});

/** Backfill recent WhatsApp history once connected. */
app.post('/api/whatsapp/backfill', async (req, res) => {
  const perChat = Math.min(Math.max(Number((req.body as { perChat?: number })?.perChat ?? 50), 1), 500);
  try {
    res.json(await backfillWhatsApp(perChat));
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

/** WhatsApp chats for the selection UI (requires the mirror to be connected). */
app.get('/api/whatsapp/chats', async (_req, res) => {
  if (getWaState().status !== 'ready') {
    res.json({ chats: [], filtering: false, ready: false });
    return;
  }
  try {
    const selected = new Set(getSelectedWaChats());
    const chats = (await listWaChats()).map((c) => ({ ...c, selected: selected.has(c.id) }));
    res.json({ chats, filtering: selected.size > 0, ready: true });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

/** Available iMessage chats (with counts) for the selection UI. */
app.get('/api/chats', (_req, res) => {
  try {
    const selected = new Set(getSelectedChats());
    const chats = listChats().map((c) => ({ ...c, selected: selected.has(c.id) }));
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
    waSelectedChats?: string[];
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
  if (Array.isArray(b.waSelectedChats))
    setSetting('wa_selected_chats', JSON.stringify(b.waSelectedChats.filter((x) => typeof x === 'string')));
  applySchedule();
  res.json({ ok: true });
});

app.get('/api/stats', (_req, res) => {
  const d = db();
  const count = (s: string) =>
    (d.prepare('SELECT COUNT(*) AS n FROM tasks WHERE status = ?').get(s) as { n: number }).n;
  const messages = (d.prepare('SELECT COUNT(*) AS n FROM messages').get() as { n: number }).n;
  res.json({
    messages,
    proposed: count('proposed'),
    todo: count('todo'),
    waiting: count('waiting'),
    done: count('done'),
    dismissed: count('dismissed'),
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
    void stopWhatsApp().finally(() => process.exit(0));
  });
}

const PORT = Number(process.env.PORT ?? 4319);
app.listen(PORT, () => {
  console.log(`\n  Dad's App dashboard → http://localhost:${PORT}\n`);
  applySchedule();
  startNudgeLoop();
  // Reconnect WhatsApp automatically if a session was already paired.
  if (hasWaSession()) {
    console.log('  WhatsApp session found — reconnecting…');
    startWhatsApp();
  }
});
