import { db } from '../db/index.js';
import { macNotify } from './mac.js';

/**
 * One-off reminders the chat assistant schedules on request ("recuérdame mañana
 * que…"). These are distinct from the task-nudge sweep: they fire once at a set
 * time, surface in the launch digest, and are listed/cancellable in the chat tab.
 */

export interface Reminder {
  id: number;
  text: string;
  dueAt: number;
  createdAt: number;
  notifiedAt: number | null;
  dismissedAt: number | null;
}

export function scheduleReminder(text: string, dueAt: number, sourceThreadId: number | null = null): number {
  const t = text.trim();
  if (!t || !Number.isFinite(dueAt)) return 0;
  const info = db()
    .prepare(`INSERT INTO ai_reminders (text, due_at, created_at, source_thread_id) VALUES (?, ?, ?, ?)`)
    .run(t, dueAt, Date.now(), sourceThreadId);
  return Number(info.lastInsertRowid);
}

/** Pending (not dismissed) reminders, soonest first. */
export function listReminders(): Reminder[] {
  return db()
    .prepare(
      `SELECT id, text, due_at AS dueAt, created_at AS createdAt,
              notified_at AS notifiedAt, dismissed_at AS dismissedAt
       FROM ai_reminders WHERE dismissed_at IS NULL ORDER BY due_at ASC`,
    )
    .all() as Reminder[];
}

/** Reminders that are due now and not yet dismissed (for the launch digest). */
export function dueReminders(now = Date.now()): Reminder[] {
  return db()
    .prepare(
      `SELECT id, text, due_at AS dueAt, created_at AS createdAt,
              notified_at AS notifiedAt, dismissed_at AS dismissedAt
       FROM ai_reminders WHERE dismissed_at IS NULL AND due_at <= ? ORDER BY due_at ASC`,
    )
    .all(now) as Reminder[];
}

export function dismissReminder(id: number): void {
  db().prepare(`UPDATE ai_reminders SET dismissed_at = ? WHERE id = ?`).run(Date.now(), id);
}

export function deleteReminder(id: number): void {
  db().prepare(`DELETE FROM ai_reminders WHERE id = ?`).run(id);
}

/**
 * Fire a native notification for any reminder that has come due and hasn't been
 * notified yet. Called periodically; the launch digest is the reliable backstop.
 */
export function sweepReminderNotifications(now = Date.now()): number {
  const due = db()
    .prepare(`SELECT id, text FROM ai_reminders WHERE dismissed_at IS NULL AND notified_at IS NULL AND due_at <= ?`)
    .all(now) as { id: number; text: string }[];
  for (const r of due) {
    macNotify({ title: 'Recordatorio', message: r.text });
    db().prepare(`UPDATE ai_reminders SET notified_at = ? WHERE id = ?`).run(now, r.id);
  }
  return due.length;
}
