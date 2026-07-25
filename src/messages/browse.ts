/**
 * Read-only queries behind the Mensajes tab — a chat-style view of what is
 * ACTUALLY in the local DB, per conversation.
 *
 * Deliberately unfiltered by the Ajustes chat selection: that selection controls
 * *ingestion*, and chats excluded from it can still hold thousands of rows
 * imported earlier. Hiding them would defeat the point of the tab, which is to
 * show what really got stored. The route marks each chat as included or not
 * instead.
 */
import { db } from '../db/index.js';

export interface ChatSummary {
  chatId: string;
  chatName: string | null;
  source: string;
  waAccount: string | null;
  lastTs: number;
  lastBody: string;
  lastDirection: 'incoming' | 'outgoing';
  total: number;
  unprocessed: number;
  withAttachments: number;
  /** Most recent non-'me' handle in the chat — the fallback display name for a
   *  1:1 conversation, which has no chat_name of its own. */
  counterpart: string | null;
  counterpartName: string | null;
}

/** One message row, attachment columns left RAW so the route can decorate them
 *  with the same availability model the Adjuntos gallery uses. */
export interface BrowseRow {
  id: number;
  source: string;
  waAccount: string | null;
  sourceMsgId: string;
  chatId: string | null;
  chatName: string | null;
  sender: string | null;
  senderName: string | null;
  direction: 'incoming' | 'outgoing';
  body: string;
  ts: number;
  processed: number;
  attachment_mimes: string;
  attachment_names: string;
  attachment_paths: string;
}

const ROW_COLS = `id, source, wa_account AS waAccount, source_msg_id AS sourceMsgId,
                  chat_id AS chatId, chat_name AS chatName, sender, sender_name AS senderName,
                  direction, body, ts, processed,
                  attachment_mimes, attachment_names, attachment_paths`;

/**
 * Every conversation in the DB, most recent first.
 *
 * `chat_name`, `body`, `source` and `direction` are bare columns alongside
 * MAX(ts): SQLite defines those to come from the row that produced the maximum,
 * which is exactly the "last message preview" we want. (This is a documented
 * SQLite guarantee for min/max aggregates, not an accident of the query plan.)
 */
export function listChatSummaries(): ChatSummary[] {
  const rows = db()
    .prepare(
      `SELECT chat_id AS chatId, chat_name AS chatName, source, wa_account AS waAccount,
              MAX(ts) AS lastTs, body AS lastBody, direction AS lastDirection,
              COUNT(*) AS total,
              SUM(CASE WHEN processed = 0 THEN 1 ELSE 0 END) AS unprocessed,
              SUM(CASE WHEN has_attachment = 1 THEN 1 ELSE 0 END) AS withAttachments
       FROM messages
       WHERE chat_id IS NOT NULL AND chat_id <> ''
       GROUP BY chat_id
       ORDER BY lastTs DESC`,
    )
    .all() as Omit<ChatSummary, 'counterpart' | 'counterpartName'>[];

  // Latest counterpart per chat, for naming 1:1 conversations that carry no
  // chat_name. One extra grouped scan rather than a correlated subquery per row.
  const others = db()
    .prepare(
      `SELECT chat_id AS chatId, sender, sender_name AS senderName, MAX(ts) AS ts
       FROM messages
       WHERE chat_id IS NOT NULL AND chat_id <> '' AND sender IS NOT NULL AND sender <> 'me'
       GROUP BY chat_id`,
    )
    .all() as { chatId: string; sender: string; senderName: string | null; ts: number }[];
  const byChat = new Map(others.map((o) => [o.chatId, o]));

  return rows.map((r) => {
    const o = byChat.get(r.chatId);
    return { ...r, counterpart: o?.sender ?? null, counterpartName: o?.senderName ?? null };
  });
}

/** Which chat a message belongs to — lets a global search result open its
 *  conversation anchored on that message. */
export function chatOfMessage(id: number): { chatId: string; ts: number } | null {
  const r = db().prepare(`SELECT chat_id AS chatId, ts FROM messages WHERE id = ?`).get(id) as
    | { chatId: string | null; ts: number }
    | undefined;
  return r?.chatId ? { chatId: r.chatId, ts: r.ts } : null;
}

export type PageDir = 'older' | 'newer' | 'around';

export interface PageOpts {
  chatId: string;
  dir?: PageDir;
  cursorTs?: number;
  cursorId?: number;
  limit?: number;
  q?: string;
  onlyUnprocessed?: boolean;
  onlyAttachments?: boolean;
}

export interface Page {
  messages: BrowseRow[];
  /** Whether MORE exists past the edge this page was fetched towards. The
   *  opposite edge always reports false: the caller is paging in one direction
   *  and already holds what lies behind it. */
  hasOlder: boolean;
  hasNewer: boolean;
}

/** Escape LIKE wildcards so a literal % or _ in the query doesn't match everything. */
function likeTerm(q: string): string {
  return `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

/** Extra WHERE clauses + params shared by every direction of the pager. */
function filterSql(o: PageOpts): { sql: string; params: unknown[] } {
  let sql = '';
  const params: unknown[] = [];
  if (o.q && o.q.trim()) {
    sql += ` AND body LIKE ? ESCAPE '\\'`;
    params.push(likeTerm(o.q.trim()));
  }
  if (o.onlyUnprocessed) sql += ` AND processed = 0`;
  if (o.onlyAttachments) sql += ` AND has_attachment = 1`;
  return { sql, params };
}

/**
 * One page of a conversation, chronological.
 *
 * Cursors are the composite (ts, id), not ts alone: messages imported in bulk
 * routinely share a timestamp, and a ts-only cursor would either skip or repeat
 * them at every page boundary.
 *
 * - `older`  — strictly before the cursor (scrolling up).
 * - `newer`  — strictly after it (scrolling down, or after a jump-to-date).
 * - `around` — half before, half at-or-after: the landing page for jump-to-date,
 *              which needs context on both sides of the target instant.
 * - no cursor — the newest page, which is where opening a chat starts.
 */
export function pageMessages(o: PageOpts): Page {
  const limit = Math.min(Math.max(o.limit ?? 100, 1), 300);
  const { sql: filt, params: fp } = filterSql(o);
  const base = `SELECT ${ROW_COLS} FROM messages WHERE chat_id = ?${filt}`;
  const d = db();

  // limit + 1 probes for a further page without a second COUNT query.
  const runOlder = (ts: number, id: number, n: number): BrowseRow[] =>
    d
      .prepare(`${base} AND (ts < ? OR (ts = ? AND id < ?)) ORDER BY ts DESC, id DESC LIMIT ?`)
      .all(o.chatId, ...fp, ts, ts, id, n + 1) as BrowseRow[];
  const runNewer = (ts: number, id: number, n: number): BrowseRow[] =>
    d
      .prepare(`${base} AND (ts > ? OR (ts = ? AND id > ?)) ORDER BY ts ASC, id ASC LIMIT ?`)
      .all(o.chatId, ...fp, ts, ts, id, n + 1) as BrowseRow[];
  /** At-or-after the cursor instant — the "after" half of a jump-to-date, where
   *  the target instant itself must be included so the jump lands ON that day. */
  const runFrom = (ts: number, n: number): BrowseRow[] =>
    d
      .prepare(`${base} AND ts >= ? ORDER BY ts ASC, id ASC LIMIT ?`)
      .all(o.chatId, ...fp, ts, n + 1) as BrowseRow[];

  const dir = o.dir ?? 'older';
  const hasCursor = Number.isFinite(o.cursorTs);
  const cts = Number(o.cursorTs ?? 0);
  const cid = Number(o.cursorId ?? 0);

  if (!hasCursor) {
    // Newest page: take from the end, then flip to chronological.
    const rows = d
      .prepare(`${base} ORDER BY ts DESC, id DESC LIMIT ?`)
      .all(o.chatId, ...fp, limit + 1) as BrowseRow[];
    const hasOlder = rows.length > limit;
    return { messages: rows.slice(0, limit).reverse(), hasOlder, hasNewer: false };
  }

  if (dir === 'newer') {
    const rows = runNewer(cts, cid, limit);
    return { messages: rows.slice(0, limit), hasOlder: false, hasNewer: rows.length > limit };
  }

  if (dir === 'around') {
    const half = Math.floor(limit / 2);
    // Strictly-before and at-or-after partition the timeline at the anchor: no
    // gap, no duplicate row across the two halves.
    const before = runOlder(cts, cid, half);
    const after = runFrom(cts, limit - half);
    return {
      messages: [...before.slice(0, half).reverse(), ...after.slice(0, limit - half)],
      hasOlder: before.length > half,
      hasNewer: after.length > limit - half,
    };
  }

  const rows = runOlder(cts, cid, limit);
  return { messages: rows.slice(0, limit).reverse(), hasOlder: rows.length > limit, hasNewer: false };
}

export interface SearchHit extends BrowseRow {
  chatId: string;
}

/** Global body search across every conversation, newest first. */
export function searchAllMessages(q: string, limit = 40): SearchHit[] {
  const term = q.trim();
  if (!term) return [];
  return db()
    .prepare(
      `SELECT ${ROW_COLS} FROM messages
       WHERE chat_id IS NOT NULL AND chat_id <> '' AND body LIKE ? ESCAPE '\\'
       ORDER BY ts DESC LIMIT ?`,
    )
    .all(likeTerm(term), Math.min(Math.max(limit, 1), 100)) as SearchHit[];
}

/** Totals for the header strip of an open conversation. */
export function chatStats(chatId: string): { total: number; unprocessed: number; withAttachments: number } {
  return db()
    .prepare(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN processed = 0 THEN 1 ELSE 0 END) AS unprocessed,
              SUM(CASE WHEN has_attachment = 1 THEN 1 ELSE 0 END) AS withAttachments
       FROM messages WHERE chat_id = ?`,
    )
    .get(chatId) as { total: number; unprocessed: number; withAttachments: number };
}

/** Task ids that cite each of these messages as their source, for the per-message
 *  detail popover ("esta mensaje generó la tarea N"). */
export function tasksForMessages(ids: number[]): Map<number, { id: number; title: string }[]> {
  const out = new Map<number, { id: number; title: string }[]>();
  if (ids.length === 0) return out;
  const rows = db()
    .prepare(
      `SELECT id, title, source_message_id AS messageId FROM tasks
       WHERE source_message_id IN (${ids.map(() => '?').join(',')}) AND deleted_at IS NULL`,
    )
    .all(...ids) as { id: number; title: string; messageId: number }[];
  for (const r of rows) {
    const list = out.get(r.messageId) ?? [];
    list.push({ id: r.id, title: r.title });
    out.set(r.messageId, list);
  }
  return out;
}
