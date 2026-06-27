import { db } from '../db/index.js';
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
      hasAttachment: boolean;
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
  | { type: 'done'; proposed: number };

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
  return db()
    .prepare(
      `SELECT title, client_hint AS clientHint FROM tasks
       WHERE status IN ('proposed','todo','waiting') AND archived_at IS NULL`,
    )
    .all() as ExistingTask[];
}

function loadClients(): ClientContext[] {
  return db()
    .prepare(`SELECT name, product_need AS productNeed FROM clients`)
    .all() as ClientContext[];
}

function saveTasks(tasks: ProposedTask[]): void {
  const d = db();
  const now = Date.now();
  const insert = d.prepare(
    `INSERT INTO tasks (title, detail, status, client_hint, source_message_id, source_quote, created_at, updated_at)
     VALUES (?, ?, 'proposed', ?, ?, ?, ?, ?)`,
  );
  d.transaction(() => {
    for (const t of tasks) {
      insert.run(t.title, t.detail, t.clientHint ?? '', t.sourceMessageId, t.sourceQuote ?? '', now, now);
    }
  })();
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

/**
 * Vision-enrich a batch of rows in place, up to `budget` describe-calls. Skips
 * stickers/Memoji. Returns how many calls it used. Mutates row.body to fold in
 * the description so the text extractor sees it.
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
    const idx = mimes.findIndex(
      (m, k) =>
        (m.startsWith('image/') || m === 'application/pdf') &&
        !(paths[k] ?? '').includes('/StickerCache/'),
    );
    if (idx === -1) continue;
    const description = await describeAttachment(paths[idx]!, mimes[idx]!);
    emit({ type: 'vision', messageId: r.id, attachmentIndex: idx, mime: mimes[idx]!, name: names[idx] ?? '', description });
    r.body = `${r.body}\n(attachment contents: ${description})`;
    used++;
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
  for (const r of rows) {
    emit({
      type: 'message',
      id: r.id,
      sender: r.sender,
      senderName: r.senderName,
      source: r.source,
      waAccount: r.waAccount,
      direction: r.direction,
      body: r.body,
      hasAttachment: !!r.attachment_mimes,
    });
  }

  if (vision) await enrichVision(rows, cap, emit);

  const extractor = new ClaudeExtractor();
  const tasks = await extractor.proposeTasks(toMessages(rows), loadClients(), loadOpenTasks());
  saveTasks(tasks);

  for (const t of tasks) {
    emit({
      type: 'task',
      title: t.title,
      detail: t.detail,
      client: t.clientHint,
      sourceQuote: t.sourceQuote,
      sourceMessageId: t.sourceMessageId,
    });
  }
  emit({ type: 'done', proposed: tasks.length });
  return { proposed: tasks.length };
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
 * Continuous engine: process UNPROCESSED messages in batches, deduping against
 * open tasks, marking each batch processed. Bounded by maxBatches per call so a
 * huge backfill is chewed through incrementally rather than in one giant request.
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
    emit({ type: 'done', proposed: 0 });
    return { processed: 0, proposed: 0, remaining: countUnprocessed() };
  }
  processingNow = true;
  try {
    const total = countUnprocessed();
    emit({ type: 'start', total, vision });

    const extractor = new ClaudeExtractor();
    const selectBatch = d.prepare(
      `SELECT ${ROW_COLS} FROM messages WHERE processed = 0 ORDER BY ts ASC LIMIT ?`,
    );
    const markProcessed = d.prepare('UPDATE messages SET processed = 1 WHERE id = ?');

    let processed = 0;
    let proposed = 0;

    for (let b = 0; b < maxBatches; b++) {
      const rows = selectBatch.all(batchSize) as Row[];
      if (rows.length === 0) break;

      // Stream each message so the Pipeline tab's "Messages sifted" fills live.
      for (const r of rows) {
        emit({
          type: 'message',
          id: r.id,
          sender: r.sender,
          senderName: r.senderName,
          source: r.source,
          waAccount: r.waAccount,
          direction: r.direction,
          body: r.body,
          hasAttachment: !!r.attachment_mimes,
        });
      }

      if (vision && visionBudget > 0) {
        visionBudget -= await enrichVision(rows, visionBudget, emit);
      }

      const tasks = await extractor.proposeTasks(toMessages(rows), loadClients(), loadOpenTasks());
      saveTasks(tasks);
      for (const t of tasks) {
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
      proposed += tasks.length;
      emit({ type: 'batch', processed, total, proposed });
    }

    emit({ type: 'done', proposed });
    return { processed, proposed, remaining: countUnprocessed() };
  } finally {
    processingNow = false;
  }
}
