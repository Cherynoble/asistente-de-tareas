/** Message-data routes: iMessage chat picker, attachment serving + gallery,
 *  the Mensajes tab, backfill, and the SSE processing stream. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import express from 'express';
import { db } from '../../db/index.js';
import { config } from '../../config.js';
import { AI_NOT_CONFIGURED, hasAiKey } from '../../ai/index.js';
import { splitAtt } from '../../attachments.js';
import { createThread } from '../../chat/store.js';
import {
  processNewMessages,
  analyzeSelection,
  selectionTranscript,
  SELECTION_MAX_MESSAGES,
} from '../../extract/pipeline.js';
import { backfillByCount } from '../../ingest/imessage/ingest.js';
import { listChats } from '../../ingest/imessage/reader.js';
import { resolveContactName } from '../../ingest/contacts.js';
import { downloadWaMedia } from '../../ingest/whatsapp/client.js';
import {
  listChatSummaries,
  pageMessages,
  searchAllMessages,
  chatOfMessage,
  chatStats,
  tasksForMessages,
} from '../../messages/browse.js';
import { nameMap } from '../../names.js';
import { getSelectedChats } from '../../settings.js';
import {
  attachmentEntries,
  browseMessage,
  clampNum,
  hasFda,
  includedChats,
  ingestSafely,
  MIME_BY_EXT,
  NATIVE_IMAGE,
  sseSender,
  type AttachmentRowLike,
} from '../helpers.js';

export const messagesRouter = express.Router();
const r = messagesRouter;

/** Available iMessage chats (with counts) for the selection UI. */
r.get('/api/chats', (_req, res) => {
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
    // SQLite reports both "file missing" and "permission denied" as the same
    // "unable to open database file" — so a granted-but-not-effective FDA and a
    // Mac without Messages set up look identical here. Surface the path so the
    // user (or we) can tell which, and 403 so the UI shows the recovery steps.
    const permissionish = /authorization|unable to open|not authorized|operation not permitted|permission denied/i.test(msg);
    res.status(permissionish ? 403 : 500).json({ error: msg, path: config.chatDbPath });
  }
});

/** Serve an attachment by message id + index, converting HEIC/etc. to JPEG. */
r.get('/api/attachment', async (req, res) => {
  const id = Number(req.query.id);
  const i = Number(req.query.i ?? 0);
  const row = db()
    .prepare(
      'SELECT attachment_paths, attachment_mimes, attachment_names, source, wa_account, source_msg_id FROM messages WHERE id = ?',
    )
    .get(id) as
    | {
        attachment_paths: string;
        attachment_mimes: string;
        attachment_names: string;
        source: string;
        wa_account: string | null;
        source_msg_id: string;
      }
    | undefined;
  if (!row) {
    res.status(404).end();
    return;
  }
  let filePath = splitAtt(row.attachment_paths)[i];
  let mime = splitAtt(row.attachment_mimes)[i];
  // WhatsApp media captured before download existed (or whose download failed)
  // has no file — fetch it on demand from the connected account, then serve.
  if ((!filePath || !filePath.trim()) && row.source === 'whatsapp' && i === 0 && row.source_msg_id) {
    const dl = await downloadWaMedia(row.wa_account || 'acc1', row.source_msg_id);
    if (dl) {
      filePath = dl.path;
      mime = dl.mime;
    }
  }
  if (!filePath || !filePath.trim()) {
    res.status(404).end();
    return;
  }
  const abs = filePath.startsWith('~') ? path.join(os.homedir(), filePath.slice(1)) : filePath;
  if (!fs.existsSync(abs)) {
    res.status(404).end();
    return;
  }
  // chat.db can store an attachment with a NULL mime_type; fall back to the
  // file extension so a real on-disk file is still previewable/downloadable.
  if (!mime) mime = MIME_BY_EXT[path.extname(abs).toLowerCase()] ?? '';
  // Download-a-copy: any file type, forced as an attachment with a tidy name.
  if (req.query.download === '1') {
    const rawName = splitAtt(row.attachment_names)[i] || '';
    const name = (rawName || `${row.source}-${id}-${i}${path.extname(abs)}`)
      .replace(/[^\w.\- ]/g, '_')
      .slice(0, 120);
    res.download(abs, name);
    return;
  }
  if (NATIVE_IMAGE.has(mime) || mime === 'application/pdf') {
    res.type(mime);
    fs.createReadStream(abs).pipe(res);
    return;
  }
  // Video/audio: sendFile handles Content-Type + Range (seeking / playback).
  if (mime.startsWith('video/') || mime.startsWith('audio/')) {
    res.sendFile(abs, (err) => {
      if (err && !res.headersSent) res.status(404).end();
    });
    return;
  }
  // Other images (HEIC, TIFF, …): convert to JPEG for the browser.
  if (mime.startsWith('image/')) {
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
    return;
  }
  // Non-previewable file (doc, vcf, …): the gallery offers it via ?download=1.
  res.status(415).end();
});

const ATT_ROW_COLS = `id, source, wa_account AS waAccount, sender, sender_name AS senderName,
                      chat_name AS chatName, ts, attachment_mimes, attachment_names, attachment_paths`;

/** Persistent attachment gallery: one entry per attachment on messages that have
 *  them, newest first, respecting the included-chats selection, paginated. */
r.get('/api/attachments', (req, res) => {
  const limit = clampNum(req.query.limit, 120, 1, 500);
  const offset = clampNum(req.query.offset, 0, 0, Number.MAX_SAFE_INTEGER);
  const { filtering, allowed } = includedChats();
  if (filtering && allowed.length === 0) {
    res.json({ attachments: [], done: true });
    return;
  }
  const where = filtering ? `AND chat_id IN (${allowed.map(() => '?').join(',')})` : '';
  const rows = db()
    .prepare(
      `SELECT ${ATT_ROW_COLS}
       FROM messages WHERE has_attachment = 1 ${where}
       ORDER BY ts DESC LIMIT ? OFFSET ?`,
    )
    .all(...(filtering ? allowed : []), limit, offset) as AttachmentRowLike[];

  const names = nameMap();
  const fda = hasFda();
  const out = rows.flatMap((row) => attachmentEntries(row, fda, names));
  res.json({ attachments: out, done: rows.length < limit });
});

/** Locate one message's attachments for the task→file deep link (no chat filter:
 *  a task's own source file is always viewable, even from a chat not in the
 *  gallery's included set). Same entry shape as /api/attachments. */
r.get('/api/attachments/locate', (req, res) => {
  const messageId = Number(req.query.messageId);
  if (!Number.isFinite(messageId)) {
    res.json({ attachments: [] });
    return;
  }
  const row = db()
    .prepare(`SELECT ${ATT_ROW_COLS} FROM messages WHERE id = ? AND has_attachment = 1`)
    .get(messageId) as AttachmentRowLike | undefined;
  if (!row) {
    res.json({ attachments: [] });
    return;
  }
  res.json({ attachments: attachmentEntries(row, hasFda(), nameMap()) });
});

// ---------------------------------------------------------------------------
// Mensajes tab — a chat-style view of what is actually stored, per conversation.
// ---------------------------------------------------------------------------

/** Every conversation in the DB, newest first. Intentionally NOT filtered by the
 *  Ajustes chat selection — see the note in messages/browse.ts — but each chat
 *  reports whether it is currently included in ingestion. */
r.get('/api/messages/chats', (_req, res) => {
  const { filtering, allowed } = includedChats();
  const allowSet = new Set(allowed);
  const names = nameMap();
  const chats = listChatSummaries().map((c) => ({
    ...c,
    // Group chats keep their own name; a 1:1 has none, so fall back to the
    // resolved counterpart (manual name > Contacts > pushname > handle).
    displayName:
      c.chatName || names[c.counterpart ?? ''] || c.counterpartName || c.counterpart || 'Sin nombre',
    included: !filtering || allowSet.has(c.chatId),
  }));
  res.json({ chats, filtering });
});

/** One page of a conversation. See pageMessages() for the cursor semantics. */
r.get('/api/messages', (req, res) => {
  const chatId = String(req.query.chatId ?? '');
  if (!chatId) {
    res.status(400).json({ error: 'chatId required' });
    return;
  }
  const dirRaw = String(req.query.dir ?? 'older');
  const dir = dirRaw === 'newer' || dirRaw === 'around' ? dirRaw : 'older';
  const page = pageMessages({
    chatId,
    dir,
    cursorTs: req.query.cursorTs !== undefined ? Number(req.query.cursorTs) : undefined,
    cursorId: req.query.cursorId !== undefined ? Number(req.query.cursorId) : undefined,
    limit: clampNum(req.query.limit, 100, 1, 300),
    q: String(req.query.q ?? ''),
    onlyUnprocessed: req.query.unprocessed === '1',
    onlyAttachments: req.query.withFiles === '1',
  });

  const names = nameMap();
  const fda = hasFda();
  const tasks = tasksForMessages(page.messages.map((m) => m.id));
  res.json({
    messages: page.messages.map((m) => browseMessage(m, names, fda, tasks)),
    hasOlder: page.hasOlder,
    hasNewer: page.hasNewer,
    stats: chatStats(chatId),
  });
});

/** Global body search across every conversation (sidebar search). */
r.get('/api/messages/search', (req, res) => {
  const q = String(req.query.q ?? '').trim();
  if (!q) {
    res.json({ hits: [] });
    return;
  }
  const names = nameMap();
  const fda = hasFda();
  const hits = searchAllMessages(q, clampNum(req.query.limit, 40, 1, 100)).map((row) =>
    browseMessage(row, names, fda, new Map()),
  );
  res.json({ hits });
});

/** Where a message lives, so a search hit can open its chat anchored on it. */
r.get('/api/messages/locate', (req, res) => {
  res.json(chatOfMessage(Number(req.query.id)) ?? { chatId: null, ts: 0 });
});

/**
 * Re-check a hand-picked selection and propose tasks from it. A PREVIEW run:
 * it ignores and never sets `processed`, so this can't quietly drain messages
 * out of the normal pipeline queue, and the same selection can be re-run.
 */
r.post('/api/messages/reanalyze', async (req, res) => {
  if (!hasAiKey()) {
    res.status(400).json({ error: AI_NOT_CONFIGURED });
    return;
  }
  const b = (req.body as { ids?: unknown; vision?: boolean }) ?? {};
  const ids = Array.isArray(b.ids) ? b.ids.map(Number).filter((n) => Number.isFinite(n)) : [];
  if (ids.length === 0) {
    res.status(400).json({ error: 'No hay mensajes seleccionados.' });
    return;
  }
  try {
    const result = await analyzeSelection(ids, { vision: b.vision !== false });
    res.json({
      messages: result.messages,
      filesAnalyzed: result.filesAnalyzed,
      proposed: result.proposed.map((t) => ({ title: t.title, detail: t.detail, client: t.clientHint })),
      // Proposals the deterministic dedup refused — shown so a repeat run reads
      // as "already exists: X", never as a silent nothing.
      duplicates: result.duplicates.map((s) => ({ title: s.existingTitle, state: s.existingState })),
      related: result.related,
      truncated: ids.length > SELECTION_MAX_MESSAGES,
    });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

/** Build the transcript for a selection and open it in a NEW chat thread. The
 *  thread is created empty; the transcript rides along with the owner's first
 *  message (see contextIds on POST /api/chat) so the agent sees both at once. */
r.post('/api/messages/to-chat', (req, res) => {
  const b = (req.body as { ids?: unknown }) ?? {};
  const ids = Array.isArray(b.ids) ? b.ids.map(Number).filter((n) => Number.isFinite(n)) : [];
  if (ids.length === 0) {
    res.status(400).json({ error: 'No hay mensajes seleccionados.' });
    return;
  }
  const names = nameMap();
  const t = selectionTranscript(ids, (h) => names[h] ?? '');
  const label = t.chatName ? `${t.count} mensajes de ${t.chatName}` : `${t.count} mensajes`;
  res.json({ threadId: createThread(label), count: t.count, label, preview: t.text.slice(0, 4000) });
});

/** One-time backfill: import the most recent N iMessages. */
r.post('/api/backfill', (req, res) => {
  const count = clampNum((req.body as { count?: number })?.count, 1000, 1, 50000);
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
r.get('/api/process/stream', async (req, res) => {
  if (!hasAiKey()) {
    res.status(400).json({ error: AI_NOT_CONFIGURED });
    return;
  }
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();

  const vision = req.query.vision === '1';
  // Default high so "Procesar" analyzes every new image/PDF (bounded per click by
  // the unprocessed-message count); still clamped to keep one run's cost sane.
  const visionCap = clampNum(req.query.cap, 1000, 0, 2000);
  const maxBatches = clampNum(req.query.maxBatches, 10, 1, 100);
  const sse = sseSender(req, res);

  try {
    // Pull anything new first (cheap; deduped), so "process new" sees today's messages.
    ingestSafely();
    await processNewMessages({ vision, visionCap, maxBatches, onEvent: sse.send });
  } catch (err) {
    sse.fail(err instanceof Error ? err.message : String(err));
  } finally {
    if (!res.writableEnded) res.end();
  }
});
