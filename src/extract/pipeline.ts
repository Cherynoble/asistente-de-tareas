import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { db } from '../db/index.js';
import { SEL_CLOSE, SEL_OPEN } from '../chat/store.js';
import { ClaudeExtractor } from './claude.js';
import { describeAttachment } from './vision.js';
import type { ClientContext, ExistingTask, IngestedMessage, ProposedTask } from './types.js';

/** Live events emitted as the pipeline runs — drives the dashboard's Pipeline tab. */
export type ActivityEvent =
  | { type: 'start'; total: number; vision: boolean }
  | {
      type: 'message';
      id: number;
      sender: string | null;
      senderName: string | null;
      source: string;
      waAccount: string | null;
      direction: 'incoming' | 'outgoing';
      body: string;
      ts: number; // when the message was sent (unix ms)
      hasAttachment: boolean;
      // Image/PDF attachments the UI can render via /api/attachment (empty for
      // text-only messages). Includes pathless WhatsApp images, which the
      // endpoint fetches on demand.
      attachments: { index: number; mime: string }[];
    }
  | {
      type: 'vision';
      messageId: number;
      attachmentIndex: number;
      mime: string;
      name: string;
      description: string;
    }
  | { type: 'batch'; processed: number; total: number; proposed: number }
  | {
      type: 'task';
      title: string;
      detail: string;
      client: string | null;
      sourceQuote: string;
      sourceMessageId: number | null;
    }
  | { type: 'done'; proposed: number; remaining?: number };

interface Row {
  id: number;
  chatName: string | null;
  sender: string | null;
  senderName: string | null;
  source: string;
  waAccount: string | null;
  direction: 'incoming' | 'outgoing';
  body: string;
  ts: number;
  attachment_mimes: string;
  attachment_names: string;
  attachment_paths: string;
}

const ROW_COLS = `id, chat_name AS chatName, sender, sender_name AS senderName, source,
                  wa_account AS waAccount,
                  direction, body, ts,
                  attachment_mimes, attachment_names, attachment_paths`;

function loadOpenTasks(): ExistingTask[] {
  // deleted_at IS NULL: a task in the Papelera is not "already open" — telling
  // the model it is would silently suppress legitimate new proposals.
  return db()
    .prepare(
      `SELECT title, client_hint AS clientHint FROM tasks
       WHERE status IN ('proposed','todo','waiting') AND archived_at IS NULL AND deleted_at IS NULL`,
    )
    .all() as ExistingTask[];
}

function loadClients(): ClientContext[] {
  return db()
    .prepare(`SELECT name, product_need AS productNeed FROM clients`)
    .all() as ClientContext[];
}

/** A proposal the deterministic dedup refused to insert, with the task it
 *  collided with — surfaced to the UI so "nothing new" reads as "already
 *  exists: X", not as a silent no-op. */
export interface SkippedDuplicate {
  title: string;
  existingId: number;
  existingTitle: string;
  /** Canonical status, or 'archived' / 'trash' when the twin is no longer active. */
  existingState: string;
}

/** Accent-, case- and punctuation-insensitive form of a title, for duplicate
 *  detection ("Enviar diagnóstico." ≡ "enviar diagnostico"). Also used by the
 *  chat agent's create_task tool, so every task-creating path shares one
 *  definition of "the same task". */
export function normTitle(t: string): string {
  return t
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/**
 * Insert proposals, MINUS deterministic duplicates. The extractor is told not to
 * re-propose open tasks, but that guard is probabilistic — over repeated runs it
 * eventually slips (observed: the third "Analizar" of the same selection
 * re-created a task the first two runs had correctly declined). This layer is
 * the guaranteed backstop, and because it lives here it covers every save path:
 * Analizar, the Proceso tab, and the nightly cron.
 *
 * Two rules, checked at insert time (better-sqlite3 is synchronous, so
 * overlapping runs can't interleave between check and insert):
 *  1. An OPEN task (proposed/todo/waiting, not archived/trashed) with the same
 *     normalized title already exists → skip. Done tasks don't block: a client
 *     re-requesting something finished is a genuinely new task.
 *  2. A task in ANY state citing the same source message with the same
 *     normalized title → skip. Re-analyzing a message must not resurrect a task
 *     the owner already completed, archived or trashed.
 */
export function saveTasks(tasks: ProposedTask[]): { saved: ProposedTask[]; duplicates: SkippedDuplicate[] } {
  const saved: ProposedTask[] = [];
  const duplicates: SkippedDuplicate[] = [];
  if (tasks.length === 0) return { saved, duplicates };

  const d = db();
  const now = Date.now();
  const insert = d.prepare(
    `INSERT INTO tasks (title, detail, status, client_hint, source_message_id, source_quote, created_at, updated_at)
     VALUES (?, ?, 'proposed', ?, ?, ?, ?, ?)`,
  );
  const selectOpen = d.prepare(
    `SELECT id, title, status FROM tasks
     WHERE status IN ('proposed','todo','waiting') AND archived_at IS NULL AND deleted_at IS NULL`,
  );
  const selectBySource = d.prepare(
    `SELECT id, title, status, archived_at, deleted_at FROM tasks WHERE source_message_id = ?`,
  );
  type Twin = { id: number; title: string; status: string; archived_at?: number | null; deleted_at?: number | null };
  const stateOf = (e: Twin) => (e.deleted_at ? 'trash' : e.archived_at ? 'archived' : e.status);

  d.transaction(() => {
    // Loaded inside the transaction, and updated per insert so rule 1 also
    // dedups within a single model response.
    const openByTitle = new Map<string, Twin>();
    for (const e of selectOpen.all() as Twin[]) {
      const k = normTitle(e.title);
      if (k && !openByTitle.has(k)) openByTitle.set(k, e);
    }
    for (const t of tasks) {
      const key = normTitle(t.title);
      const twin =
        (key && openByTitle.get(key)) ||
        (t.sourceMessageId != null
          ? (selectBySource.all(t.sourceMessageId) as Twin[]).find((e) => normTitle(e.title) === key)
          : undefined);
      if (twin) {
        duplicates.push({ title: t.title, existingId: twin.id, existingTitle: twin.title, existingState: stateOf(twin) });
        continue;
      }
      const info = insert.run(t.title, t.detail, t.clientHint ?? '', t.sourceMessageId, t.sourceQuote ?? '', now, now);
      saved.push(t);
      if (key) openByTitle.set(key, { id: Number(info.lastInsertRowid), title: t.title, status: 'proposed' });
    }
  })();
  return { saved, duplicates };
}

/** Attachments the UI can preview via /api/attachment. */
function renderableAttachments(r: Row): { index: number; mime: string }[] {
  const mimes = r.attachment_mimes ? r.attachment_mimes.split('||') : [];
  const paths = r.attachment_paths ? r.attachment_paths.split('||') : [];
  const out: { index: number; mime: string }[] = [];
  mimes.forEach((mime, index) => {
    const hasFile = !!(paths[index] && paths[index].trim());
    if (hasFile && (mime.startsWith('image/') || mime === 'application/pdf')) {
      out.push({ index, mime });
    } else if (!hasFile && r.source === 'whatsapp' && mime === 'image') {
      // Pathless WhatsApp image (older message / pre-download capture): the
      // endpoint fetches it on demand when the browser requests it.
      out.push({ index, mime: 'image/*' });
    }
  });
  return out;
}

/** The 'message' activity event for one row (shared by preview + process). */
function messageEvent(r: Row): ActivityEvent {
  return {
    type: 'message',
    id: r.id,
    sender: r.sender,
    senderName: r.senderName,
    source: r.source,
    waAccount: r.waAccount,
    direction: r.direction,
    body: r.body,
    ts: r.ts,
    hasAttachment: !!r.attachment_mimes,
    attachments: renderableAttachments(r),
  };
}

function toMessages(rows: Row[]): IngestedMessage[] {
  return rows.map((r) => ({
    id: r.id,
    chatName: r.chatName,
    sender: r.sender,
    direction: r.direction,
    body: r.body,
    ts: r.ts,
  }));
}

/** Is the stored attachment path a real file on this Mac right now? Dead temp
 *  paths (/var/folders/… purged by macOS) and empty slots fail this, so they
 *  don't consume a vision slot on a doomed describe call. */
function fileOnDisk(p: string | undefined): boolean {
  const t = (p ?? '').trim();
  if (!t) return false;
  const abs = t.startsWith('~') ? path.join(os.homedir(), t.slice(1)) : t;
  try {
    return fs.existsSync(abs);
  } catch {
    return false;
  }
}

/**
 * Vision-enrich a batch of rows in place, up to `budget` describe-calls. Skips
 * stickers/Memoji. Returns how many calls it used. Mutates row.body to fold in
 * the descriptions so the text extractor sees them.
 *
 * Every qualifying attachment on a row is described, not just the first. A
 * client sending five product photos in one message used to contribute exactly
 * one description at any budget — the other four were never seen, and the row
 * was then marked processed, so that signal was lost for good.
 */
async function enrichVision(
  rows: Row[],
  budget: number,
  emit: (e: ActivityEvent) => void,
): Promise<number> {
  let used = 0;
  for (const r of rows) {
    if (used >= budget) break;
    const mimes = r.attachment_mimes ? r.attachment_mimes.split('||') : [];
    const names = r.attachment_names ? r.attachment_names.split('||') : [];
    const paths = r.attachment_paths ? r.attachment_paths.split('||') : [];
    const described: string[] = [];

    for (let k = 0; k < mimes.length; k++) {
      if (used >= budget) break;
      const mime = mimes[k] ?? '';
      const p = paths[k];
      if (!(mime.startsWith('image/') || mime === 'application/pdf')) continue;
      if ((p ?? '').includes('/StickerCache/')) continue;
      if (!fileOnDisk(p)) continue;

      const description = await describeAttachment(p!, mime);
      emit({ type: 'vision', messageId: r.id, attachmentIndex: k, mime, name: names[k] ?? '', description });
      // Label each file only when there are several, so the single-attachment
      // case (the common one) keeps its original wording.
      described.push(described.length || mimes.length > 1 ? `[${names[k] || `archivo ${k + 1}`}] ${description}` : description);
      used++;
    }

    if (described.length) r.body = `${r.body}\n(attachment contents: ${described.join('\n')})`;
  }
  return used;
}

export interface ExtractionOptions {
  limit?: number;
  vision?: boolean;
  visionCap?: number;
  onEvent?: (e: ActivityEvent) => void;
}

/**
 * Preview run over the most recent `limit` messages — streams every message and
 * any analyzed attachment, then proposes (deduped) tasks. Does NOT mark messages
 * processed; it's a manual exploration tool.
 */
export async function runExtraction(opts: ExtractionOptions = {}): Promise<{ proposed: number }> {
  const limit = opts.limit ?? 80;
  const vision = opts.vision ?? false;
  const cap = opts.visionCap ?? 10;
  const emit = opts.onEvent ?? (() => {});

  const rows = (
    db().prepare(`SELECT ${ROW_COLS} FROM messages ORDER BY ts DESC LIMIT ?`).all(limit) as Row[]
  ).reverse();

  emit({ type: 'start', total: rows.length, vision });
  for (const r of rows) emit(messageEvent(r));

  if (vision) await enrichVision(rows, cap, emit);

  const extractor = new ClaudeExtractor();
  const tasks = await extractor.proposeTasks(toMessages(rows), loadClients(), loadOpenTasks());
  const { saved } = saveTasks(tasks);

  for (const t of saved) {
    emit({
      type: 'task',
      title: t.title,
      detail: t.detail,
      client: t.clientHint,
      sourceQuote: t.sourceQuote,
      sourceMessageId: t.sourceMessageId,
    });
  }
  emit({ type: 'done', proposed: saved.length });
  return { proposed: saved.length };
}

export interface ProcessOptions {
  batchSize?: number;
  maxBatches?: number;
  vision?: boolean;
  visionCap?: number;
  onEvent?: (e: ActivityEvent) => void;
}

// Guard against concurrent runs (e.g. a manual "Process" click overlapping the
// daily cron). Rows are only marked processed AFTER the async extract call, so
// two overlapping runs would select the same unprocessed rows and double-propose.
let processingNow = false;

/**
 * Continuous engine: process UNPROCESSED messages in batches — NEWEST FIRST, so
 * today's messages are analyzed on the very next run even when a history import
 * just queued thousands of old ones (oldest-first buried recent messages behind
 * the backlog, and tasks from them never appeared). Each batch is fed to the
 * extractor in chronological order. Dedupes against open tasks, marks each batch
 * processed. Bounded by maxBatches per call so a huge backfill is chewed through
 * incrementally rather than in one giant request.
 */
export async function processNewMessages(opts: ProcessOptions = {}): Promise<{
  processed: number;
  proposed: number;
  remaining: number;
}> {
  const batchSize = opts.batchSize ?? 120;
  const maxBatches = opts.maxBatches ?? 10;
  const vision = opts.vision ?? false;
  let visionBudget = opts.visionCap ?? 15;
  const emit = opts.onEvent ?? (() => {});

  const d = db();
  const countUnprocessed = () =>
    (d.prepare('SELECT COUNT(*) AS n FROM messages WHERE processed = 0').get() as { n: number }).n;

  // Bail out (rather than double-process) if another run is already in flight.
  if (processingNow) {
    const remaining = countUnprocessed();
    emit({ type: 'done', proposed: 0, remaining });
    return { processed: 0, proposed: 0, remaining };
  }
  processingNow = true;
  try {
    const total = countUnprocessed();
    emit({ type: 'start', total, vision });

    const extractor = new ClaudeExtractor();
    const selectBatch = d.prepare(
      `SELECT ${ROW_COLS} FROM messages WHERE processed = 0 ORDER BY ts DESC LIMIT ?`,
    );
    const markProcessed = d.prepare('UPDATE messages SET processed = 1 WHERE id = ?');

    let processed = 0;
    let proposed = 0;

    for (let b = 0; b < maxBatches; b++) {
      const rows = selectBatch.all(batchSize) as Row[];
      if (rows.length === 0) break;
      // The batch is selected newest-first; present it to the extractor (and
      // the live feed) oldest-first so the transcript reads chronologically.
      rows.reverse();

      // Stream each message so the Pipeline tab's "Messages sifted" fills live.
      for (const r of rows) emit(messageEvent(r));

      if (vision && visionBudget > 0) {
        visionBudget -= await enrichVision(rows, visionBudget, emit);
      }

      const tasks = await extractor.proposeTasks(toMessages(rows), loadClients(), loadOpenTasks());
      const { saved } = saveTasks(tasks);
      for (const t of saved) {
        emit({
          type: 'task',
          title: t.title,
          detail: t.detail,
          client: t.clientHint,
          sourceQuote: t.sourceQuote,
          sourceMessageId: t.sourceMessageId,
        });
      }

      d.transaction(() => {
        for (const r of rows) markProcessed.run(r.id);
      })();

      processed += rows.length;
      proposed += saved.length;
      emit({ type: 'batch', processed, total, proposed });
    }

    const remaining = countUnprocessed();
    emit({ type: 'done', proposed, remaining });
    return { processed, proposed, remaining };
  } finally {
    processingNow = false;
  }
}

/** Hard ceilings for a hand-picked selection (Mensajes tab → "Analizar"). The
 *  message cap keeps one request inside the model's context; the file cap keeps
 *  one click's vision cost predictable. */
export const SELECTION_MAX_MESSAGES = 200;
export const SELECTION_MAX_FILES = 40;

export interface SelectionAnalysis {
  messages: number;
  filesAnalyzed: number;
  proposed: ProposedTask[];
  /** Proposals the deterministic dedup refused because their twin already
   *  exists — the exact answer to "why did nothing new appear?". */
  duplicates: SkippedDuplicate[];
  /** Open tasks already tied to this conversation — shown when nothing new was
   *  proposed, so a zero result reads as "already covered" rather than "broken".
   *  A relatedness heuristic (same source message or client), NOT the extractor's
   *  actual dedup decision, which it doesn't report. */
  related: { id: number; title: string; status: string }[];
}

/**
 * Analyze an explicit, hand-picked set of messages and propose tasks from them.
 *
 * Unlike processNewMessages this is a PREVIEW run: it deliberately ignores the
 * `processed` flag and never sets it, so re-checking a message doesn't quietly
 * drain it from the normal pipeline queue and the same selection can be run
 * again. Proposed tasks land in Bandeja like any other.
 */
export async function analyzeSelection(
  ids: number[],
  opts: { vision?: boolean; visionCap?: number } = {},
): Promise<SelectionAnalysis> {
  const picked = [...new Set(ids.filter((n) => Number.isFinite(n)))].slice(0, SELECTION_MAX_MESSAGES);
  if (picked.length === 0) return { messages: 0, filesAnalyzed: 0, proposed: [], duplicates: [], related: [] };

  const d = db();
  const placeholders = picked.map(() => '?').join(',');
  const rows = d
    .prepare(`SELECT ${ROW_COLS} FROM messages WHERE id IN (${placeholders}) ORDER BY ts ASC`)
    .all(...picked) as Row[];
  if (rows.length === 0) return { messages: 0, filesAnalyzed: 0, proposed: [], duplicates: [], related: [] };

  const cap = Math.min(Math.max(opts.visionCap ?? SELECTION_MAX_FILES, 0), SELECTION_MAX_FILES);
  const filesAnalyzed = opts.vision === false ? 0 : await enrichVision(rows, cap, () => {});

  const extractor = new ClaudeExtractor();
  const { saved, duplicates } = saveTasks(
    await extractor.proposeTasks(toMessages(rows), loadClients(), loadOpenTasks()),
  );

  // Relatedness by the same source messages or the same handles/chats the
  // selection came from. The source-message leg applies even when no hint
  // resolved (e.g. a chat of only outgoing messages).
  const hints = [
    ...new Set(
      rows.flatMap((r) => [r.sender, r.chatName].filter((s): s is string => !!s && s !== 'me')),
    ),
  ];
  const conds = [`source_message_id IN (${placeholders})`];
  const params: unknown[] = [...picked];
  if (hints.length > 0) {
    conds.push(`client_hint IN (${hints.map(() => '?').join(',')})`);
    params.push(...hints);
  }
  const related = d
    .prepare(
      `SELECT id, title, status FROM tasks
       WHERE status IN ('proposed','todo','waiting')
         AND archived_at IS NULL AND deleted_at IS NULL
         AND (${conds.join(' OR ')})
       ORDER BY updated_at DESC LIMIT 10`,
    )
    .all(...params) as { id: number; title: string; status: string }[];

  return { messages: rows.length, filesAnalyzed, proposed: saved, duplicates, related };
}

/** Render a selection as a plain-text transcript for the chat agent. Kept here
 *  so the ordering and naming match what the extractor sees. */
export function selectionTranscript(ids: number[], resolveName: (handle: string) => string): {
  text: string;
  count: number;
  chatName: string;
} {
  const picked = [...new Set(ids.filter((n) => Number.isFinite(n)))].slice(0, SELECTION_MAX_MESSAGES);
  if (picked.length === 0) return { text: '', count: 0, chatName: '' };
  const rows = db()
    .prepare(
      `SELECT ${ROW_COLS} FROM messages WHERE id IN (${picked.map(() => '?').join(',')}) ORDER BY ts ASC`,
    )
    .all(...picked) as Row[];

  const lines = rows.map((r) => {
    const when = new Date(r.ts).toLocaleString('es', {
      day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit',
    });
    const who = r.direction === 'outgoing' ? 'Yo' : resolveName(r.sender ?? '') || r.senderName || r.sender || '?';
    const files = r.attachment_names ? ` [archivos: ${r.attachment_names.split('||').filter(Boolean).join(', ')}]` : '';
    // A body containing the literal selection sentinels would terminate the
    // collapsed block early in the chat UI, spilling the rest of the transcript
    // into the visible bubble. Message bodies are untrusted text; strip them.
    const body = (r.body || '(sin texto)').replaceAll(SEL_OPEN, '').replaceAll(SEL_CLOSE, '');
    return `[${when}] ${who}: ${body}${files}`;
  });

  return {
    text: lines.join('\n'),
    count: rows.length,
    chatName: rows.find((r) => r.chatName)?.chatName ?? '',
  };
}
