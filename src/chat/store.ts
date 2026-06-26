import { db } from '../db/index.js';

export interface Thread {
  id: number;
  title: string;
  createdAt: number;
  updatedAt: number;
}
export interface StoredMsg {
  role: 'user' | 'assistant';
  content: string;
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
  return db()
    .prepare(`SELECT role, content FROM chat_messages WHERE thread_id = ? ORDER BY id ASC`)
    .all(threadId) as StoredMsg[];
}

export function addMessage(threadId: number, role: 'user' | 'assistant', content: string): void {
  const now = Date.now();
  db()
    .prepare(`INSERT INTO chat_messages (thread_id, role, content, created_at) VALUES (?, ?, ?, ?)`)
    .run(threadId, role, content, now);
  db().prepare(`UPDATE chat_threads SET updated_at = ? WHERE id = ?`).run(now, threadId);
}

/** First user line, trimmed to a short thread title. */
export function titleFrom(text: string): string {
  const t = text.replace(/\s+/g, ' ').trim();
  return t.length > 48 ? t.slice(0, 47) + '…' : t || 'Nueva conversación';
}

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
