import { db } from '../db/index.js';

export interface Thread {
  id: number;
  title: string;
  createdAt: number;
  updatedAt: number;
}
export interface Attachment {
  name: string;
}
export interface StoredMsg {
  role: 'user' | 'assistant';
  content: string;
  attachments?: Attachment[];
}
export interface Memory {
  id: number;
  content: string;
  createdAt: number;
}

export function listThreads(): Thread[] {
  return db()
    .prepare(
      `SELECT id, title, created_at AS createdAt, updated_at AS updatedAt
       FROM chat_threads ORDER BY updated_at DESC`,
    )
    .all() as Thread[];
}

export function createThread(title = 'Nueva conversación'): number {
  const now = Date.now();
  const info = db()
    .prepare(`INSERT INTO chat_threads (title, created_at, updated_at) VALUES (?, ?, ?)`)
    .run(title, now, now);
  return Number(info.lastInsertRowid);
}

export function deleteThread(id: number): void {
  const d = db();
  d.prepare(`DELETE FROM chat_messages WHERE thread_id = ?`).run(id);
  d.prepare(`DELETE FROM chat_threads WHERE id = ?`).run(id);
}

export function renameThread(id: number, title: string): void {
  db().prepare(`UPDATE chat_threads SET title = ?, updated_at = ? WHERE id = ?`).run(title, Date.now(), id);
}

export function threadMessages(threadId: number): StoredMsg[] {
  const rows = db()
    .prepare(`SELECT role, content, attachments FROM chat_messages WHERE thread_id = ? ORDER BY id ASC`)
    .all(threadId) as { role: 'user' | 'assistant'; content: string; attachments: string }[];
  return rows.map((r) => ({
    role: r.role,
    content: r.content,
    attachments: r.attachments ? (JSON.parse(r.attachments) as Attachment[]) : [],
  }));
}

export function addMessage(
  threadId: number,
  role: 'user' | 'assistant',
  content: string,
  attachments: Attachment[] = [],
): void {
  const now = Date.now();
  db()
    .prepare(
      `INSERT INTO chat_messages (thread_id, role, content, attachments, created_at) VALUES (?, ?, ?, ?, ?)`,
    )
    .run(threadId, role, content, attachments.length ? JSON.stringify(attachments) : '', now);
  db().prepare(`UPDATE chat_threads SET updated_at = ? WHERE id = ?`).run(now, threadId);
}

/** First user line, trimmed to a short thread title. */
export function titleFrom(text: string): string {
  const t = text.replace(/\s+/g, ' ').trim();
  return t.length > 48 ? t.slice(0, 47) + '…' : t || 'Nueva conversación';
}

/**
 * Sentinels wrapping a pasted message selection inside a chat message's content.
 *
 * The transcript has to live in `content` because that is what gets replayed to
 * the model on every later turn. The frontend splits on these markers to render
 * it collapsed instead of dumping 200 lines into a bubble — visible if you open
 * it, out of the way if you don't. `public/app-chat.js` hardcodes the same
 * strings; change one and you must change the other.
 *
 * They are a WIRE FORMAT, never UI text: they must NOT be translated.
 */
export const SEL_OPEN = '⟦SELECTION⟧';
export const SEL_CLOSE = '⟦/SELECTION⟧';

/**
 * The original Spanish sentinels. These are already stored inside chat_messages
 * rows in every existing database, so they can never be retired — only stopped
 * being written. Readers must accept both pairs forever; writers use the neutral
 * pair above. This buys locale-neutrality with no migration and no risk to
 * existing threads (rewriting stored message content to change a marker would
 * be all downside).
 */
export const SEL_OPEN_LEGACY = '⟦SELECCIÓN⟧';
export const SEL_CLOSE_LEGACY = '⟦/SELECCIÓN⟧';

/** Every sentinel a reader must strip or recognise. */
export const SEL_MARKERS = [SEL_OPEN, SEL_CLOSE, SEL_OPEN_LEGACY, SEL_CLOSE_LEGACY];

// ---- Memory ----
export function listMemories(): Memory[] {
  return db()
    .prepare(`SELECT id, content, created_at AS createdAt FROM chat_memory ORDER BY created_at DESC`)
    .all() as Memory[];
}

export function saveMemory(content: string, sourceThreadId: number | null = null): number {
  const c = content.trim();
  if (!c) return 0;
  // De-dup exact repeats so the store doesn't bloat.
  const existing = db().prepare(`SELECT id FROM chat_memory WHERE content = ?`).get(c) as { id: number } | undefined;
  if (existing) return existing.id;
  const info = db()
    .prepare(`INSERT INTO chat_memory (content, source_thread_id, created_at) VALUES (?, ?, ?)`)
    .run(c, sourceThreadId, Date.now());
  return Number(info.lastInsertRowid);
}

export function deleteMemory(id: number): void {
  db().prepare(`DELETE FROM chat_memory WHERE id = ?`).run(id);
}
