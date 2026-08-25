/** Chat tab routes: threads, turns, uploads, memory, agenda, launch digest. */
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import { db } from '../../db/index.js';
import { config } from '../../config.js';
import { aiNotConfigured, hasAiKey } from '../../ai/index.js';
import { runTurn } from '../../chat/index.js';
import {
  listThreads,
  createThread,
  deleteThread,
  threadMessages,
  titleFrom,
  renameThread,
  listMemories,
  deleteMemory,
  SEL_OPEN,
  SEL_CLOSE,
} from '../../chat/store.js';
import { selectionTranscript } from '../../extract/pipeline.js';
import { describeAttachment } from '../../extract/vision.js';
import { nameMap } from '../../names.js';
import {
  listReminders,
  dueReminders,
  dismissReminder,
  deleteReminder,
} from '../../notify/scheduled.js';
import { getSetting, setSetting } from '../../settings.js';

export const chatRouter = express.Router();
const r = chatRouter;

/** List saved chat threads. */
r.get('/api/threads', (_req, res) => {
  res.json(listThreads());
});

/** Create a new chat thread. */
r.post('/api/threads', (_req, res) => {
  res.json({ id: createThread() });
});

/** Messages of one thread. */
r.get('/api/threads/:id', (req, res) => {
  res.json(threadMessages(Number(req.params.id)));
});

/** Delete a thread and its messages. */
r.delete('/api/threads/:id', (req, res) => {
  deleteThread(Number(req.params.id));
  res.json({ ok: true });
});

/**
 * Send a message in a thread and get the assistant's reply. Creates the thread
 * if none is given, and titles it from the first message. Uses the configured
 * AI provider with the DB + long-term memory as context, and may call tools.
 */
r.post('/api/chat', async (req, res) => {
  if (!hasAiKey()) {
    res.status(400).json({ error: aiNotConfigured });
    return;
  }
  const body = (req.body as { threadId?: number; message?: string; contextIds?: unknown }) ?? {};
  const message = (body.message ?? '').trim();
  if (!message) {
    res.status(400).json({ error: 'message required' });
    return;
  }
  // Hoisted so the catch can roll back a thread this request created — a turn
  // that fails (bad API key, network, a DB error) must not leave an untitled
  // empty conversation in the sidebar. Reproduced on a fresh install, where the
  // first message failed and every retry stacked another orphan.
  let threadId = Number(body.threadId);
  let createdThread = false;
  try {
    if (!threadId || !Number.isFinite(threadId)) {
      threadId = createThread(titleFrom(message));
      createdThread = true;
    } else if (threadMessages(threadId).length === 0) {
      renameThread(threadId, titleFrom(message));
    }

    // A selection sent over from the Mensajes tab rides along with the owner's
    // first message, so the agent sees the transcript and the question together.
    const ctxIds = Array.isArray(body.contextIds)
      ? body.contextIds.map(Number).filter((n) => Number.isFinite(n))
      : [];
    let composed = message;
    if (ctxIds.length) {
      const names = nameMap();
      const t = selectionTranscript(ctxIds, (h) => names[h] ?? '');
      if (t.count) {
        const header = t.chatName ? `${t.count} mensajes de ${t.chatName}` : `${t.count} mensajes`;
        composed = `${SEL_OPEN}\n${header}\n${t.text}\n${SEL_CLOSE}\n\n${message}`;
      }
    }

    const { reply, usedTools } = await runTurn(threadId, composed);
    res.json({ reply, threadId, createdThread, usedTools });
  } catch (err) {
    if (createdThread) deleteThread(threadId); // roll back the empty thread
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

/** The assistant's long-term memory (read / delete). */
r.get('/api/memory', (_req, res) => {
  res.json(listMemories());
});
r.delete('/api/memory/:id', (req, res) => {
  deleteMemory(Number(req.params.id));
  res.json({ ok: true });
});

/**
 * Send an image/PDF in a chat thread: save it, describe it with vision, and feed
 * that description into the chat turn so the assistant can discuss it (and create
 * a task from it if asked). Files come as base64 JSON (no multipart dependency).
 */
r.post('/api/chat/upload', async (req, res) => {
  if (!hasAiKey()) {
    res.status(400).json({ error: aiNotConfigured });
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
  // Hoisted for the same rollback reason as POST /api/chat above.
  let threadId = Number(b.threadId);
  let createdThread = false;
  try {
    const userText = (b.message ?? '').trim();
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
    if (createdThread) deleteThread(threadId); // roll back the empty thread
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

/** Scheduled (AI) reminders: list / dismiss / delete. */
r.get('/api/agenda', (_req, res) => {
  res.json(listReminders());
});
r.post('/api/agenda/:id/dismiss', (req, res) => {
  dismissReminder(Number(req.params.id));
  res.json({ ok: true });
});
r.delete('/api/agenda/:id', (req, res) => {
  deleteReminder(Number(req.params.id));
  res.json({ ok: true });
});

/** Launch digest: tasks auto-proposed since last seen + reminders now due. */
r.get('/api/digest', (_req, res) => {
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
r.post('/api/digest/seen', (_req, res) => {
  setSetting('last_digest_seen', String(Date.now()));
  res.json({ ok: true });
});
