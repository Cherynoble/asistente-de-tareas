/**
 * Reminders engine: a daily morning digest and escalating nudges that re-ping
 * open tasks until they're done. Notifications are native macOS banners.
 *
 * Nudges are throttled per-task via tasks.last_nudge_at so a given task is
 * re-surfaced at most once per interval (default 2 days). They escalate: the
 * longer a task is overdue/stale, the louder the wording.
 */
import { db } from '../db/index.js';
import { getSetting } from '../settings.js';
import { macNotify } from './mac.js';
import { t, tn } from '../i18n.js';

const DAY = 24 * 60 * 60 * 1000;

export interface OpenTask {
  id: number;
  title: string;
  status: string; // 'todo' | 'waiting'
  clientHint: string;
  dueAt: number | null;
  lastNudgeAt: number | null;
  createdAt: number;
}

export interface Digest {
  title: string;
  subtitle: string;
  message: string;
  counts: { total: number; todo: number; waiting: number; overdue: number };
  tasks: OpenTask[];
}

/** Master on/off for all notifications (digest + nudges). Default on. */
export function remindersEnabled(): boolean {
  return (getSetting('reminders_enabled') ?? '1') === '1';
}

/** Days between re-nudges for an unfinished task. Default 2, min 1. */
export function nudgeIntervalDays(): number {
  const n = Number(getSetting('nudge_interval_days') ?? '2');
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 2;
}

/**
 * Active, unfinished tasks (todo/waiting), most urgent first.
 *
 * `deleted_at IS NULL` is load-bearing: a task the owner moved to the Papelera is
 * not open. Without it a trashed task keeps firing "⚠️ N vencidas" banners forever
 * and inflates the morning digest, with no way to make it stop short of emptying
 * the trash. Same class of bug as the `loadOpenTasks` fix in 1.7.1 — that one
 * closed the extractor's copy of this query and missed the reminders engine.
 */
export function openTasks(): OpenTask[] {
  return db()
    .prepare(
      `SELECT id, title, status, client_hint AS clientHint, due_at AS dueAt,
              last_nudge_at AS lastNudgeAt, created_at AS createdAt
       FROM tasks
       WHERE status IN ('todo','waiting') AND archived_at IS NULL AND deleted_at IS NULL
       ORDER BY (due_at IS NULL), due_at ASC, created_at ASC`,
    )
    .all() as OpenTask[];
}

const isOverdue = (t: OpenTask, now: number) => t.dueAt != null && t.dueAt < now;

/** Build (but don't send) a summary of the open-task situation. */
export function buildDigest(now = Date.now()): Digest {
  const tasks = openTasks();
  const todo = tasks.filter((t) => t.status === 'todo');
  const waiting = tasks.filter((t) => t.status === 'waiting');
  const overdue = tasks.filter((t) => isOverdue(t, now));

  const counts = { total: tasks.length, todo: todo.length, waiting: waiting.length, overdue: overdue.length };
  if (tasks.length === 0) {
    return {
      title: t('notify.allClearTitle'),
      subtitle: t('notify.allClearSubtitle'),
      message: t('notify.allClearMessage'),
      counts,
      tasks,
    };
  }
  const title = tn('notify.openTasks', tasks.length);
  const parts: string[] = [];
  if (overdue.length) parts.push(tn('notify.overdue', overdue.length));
  parts.push(t('notify.todo', { n: todo.length }), t('notify.waiting', { n: waiting.length }));
  const subtitle = parts.join(' · ');
  // Lead with the most pressing items (overdue first, else most urgent).
  const lead = (overdue.length ? overdue : tasks).slice(0, 3);
  const more = tasks.length - lead.length;
  const message =
    lead.map((task) => task.title).join('; ') + (more > 0 ? t('notify.andMore', { n: more }) : '');
  return { title, subtitle, message, counts, tasks };
}

/** Build + send the daily morning digest as a native notification. */
export function sendDailyDigest(now = Date.now()): Digest {
  const d = buildDigest(now);
  if (remindersEnabled()) {
    macNotify({ title: t('notify.goodMorning', { summary: d.title }), subtitle: d.subtitle, message: d.message });
  }
  return d;
}

export interface SweepResult {
  nudged: number;
  overdue: number;
  tasks: { id: number; title: string }[];
}

/**
 * Find open tasks that are due for a nudge (never nudged, or last nudged ≥
 * interval ago) and send ONE grouped, escalating notification, then stamp
 * last_nudge_at. Grouping avoids 20 separate banners.
 *
 * `force` ignores the per-task throttle and the master enable (for a manual
 * "remind me now" / test from the UI).
 */
export function runNudgeSweep(now = Date.now(), opts: { force?: boolean } = {}): SweepResult {
  if (!remindersEnabled() && !opts.force) return { nudged: 0, overdue: 0, tasks: [] };

  const intervalMs = nudgeIntervalDays() * DAY;
  const tasks = openTasks();
  const due = tasks.filter(
    (t) => opts.force || t.lastNudgeAt == null || now - t.lastNudgeAt >= intervalMs,
  );
  if (due.length === 0) return { nudged: 0, overdue: 0, tasks: [] };

  const overdue = due.filter((t) => isOverdue(t, now));
  const lead = (overdue.length ? overdue : due).slice(0, 3).map((task) => task.title);
  const n = due.length;
  const more = n - lead.length;

  // Escalating wording: bare reminder → "still open" → "⚠️ overdue".
  const title = overdue.length
    ? tn('notify.overdueTitle', overdue.length)
    : tn('notify.stillOpenTitle', n);
  const message = lead.join('; ') + (more > 0 ? t('notify.andMore', { n: more }) : '');
  macNotify({ title, subtitle: t('notify.openAppToUpdate'), message });

  const stmt = db().prepare('UPDATE tasks SET last_nudge_at = ? WHERE id = ?');
  const tx = db().transaction((ids: number[]) => {
    for (const id of ids) stmt.run(now, id);
  });
  tx(due.map((task) => task.id));

  return { nudged: n, overdue: overdue.length, tasks: due.map((task) => ({ id: task.id, title: task.title })) };
}
