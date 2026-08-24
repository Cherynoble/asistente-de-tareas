/** Task routes: Bandeja (inbox), Tareas, Archivo, Papelera, bulk actions. */
import express from 'express';
import { db } from '../../db/index.js';

export const tasksRouter = express.Router();
const r = tasksRouter;

/** Proposed tasks awaiting review, with the message that triggered each. */
r.get('/api/inbox', (_req, res) => {
  const rows = db()
    .prepare(
      `SELECT t.id, t.title, t.detail, t.client_hint AS clientHint, t.source_quote AS sourceQuote,
              t.created_at AS createdAt, t.source_message_id AS sourceMessageId,
              m.body AS sourceBody, m.sender AS sourceSender, m.chat_name AS chatName,
              m.has_attachment AS hasAttachment, m.source AS source, m.wa_account AS waAccount
       FROM tasks t
       LEFT JOIN messages m ON m.id = t.source_message_id
       WHERE t.status = 'proposed' AND t.archived_at IS NULL AND t.deleted_at IS NULL
       ORDER BY t.created_at DESC, t.id DESC`,
    )
    .all();
  res.json(rows);
});

/** Active tasks (approved through to done), excluding archived. */
r.get('/api/tasks', (_req, res) => {
  const rows = db()
    .prepare(
      `SELECT t.id, t.title, t.detail, t.client_hint AS clientHint, t.source_quote AS sourceQuote,
              t.status, t.due_at AS dueAt, t.updated_at AS updatedAt, t.source_message_id AS sourceMessageId,
              m.source AS source, m.wa_account AS waAccount, m.has_attachment AS hasAttachment
       FROM tasks t
       LEFT JOIN messages m ON m.id = t.source_message_id
       WHERE t.status IN ('todo','waiting','done') AND t.archived_at IS NULL AND t.deleted_at IS NULL
       ORDER BY CASE t.status WHEN 'todo' THEN 0 WHEN 'waiting' THEN 1 ELSE 2 END, t.updated_at DESC`,
    )
    .all();
  res.json(rows);
});

/** Archived tasks. */
r.get('/api/archive', (_req, res) => {
  const rows = db()
    .prepare(
      `SELECT id, title, detail, client_hint AS clientHint, status, archived_at AS archivedAt
       FROM tasks WHERE archived_at IS NOT NULL AND deleted_at IS NULL ORDER BY archived_at DESC`,
    )
    .all();
  res.json(rows);
});

/** Manually create a task (saved as todo). */
r.post('/api/tasks', (req, res) => {
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
r.post('/api/tasks/:id/archive', (req, res) => {
  const undo = (req.body as { undo?: boolean })?.undo === true;
  db()
    .prepare('UPDATE tasks SET archived_at = ?, updated_at = ? WHERE id = ?')
    .run(undo ? null : Date.now(), Date.now(), Number(req.params.id));
  res.json({ ok: true });
});

const TASK_STATUSES = ['proposed', 'todo', 'waiting', 'done', 'dismissed'];

/**
 * Bulk action over a set of task ids. action ∈
 * status | archive | unarchive | delete | restore | purge | client | due.
 * Used by the multi-select toolbars and per-card delete/restore buttons.
 */
r.post('/api/tasks/bulk', (req, res) => {
  const { ids, action, value } = req.body as { ids?: number[]; action?: string; value?: unknown };
  const idList = Array.isArray(ids) ? ids.map(Number).filter((n) => Number.isFinite(n)) : [];
  if (!idList.length || !action) {
    res.status(400).json({ error: 'ids and action required' });
    return;
  }
  const now = Date.now();
  const ph = idList.map(() => '?').join(',');
  let sql: string;
  let head: unknown[];
  switch (action) {
    case 'status': {
      const status = String(value);
      if (!TASK_STATUSES.includes(status)) {
        res.status(400).json({ error: 'bad status' });
        return;
      }
      sql = `UPDATE tasks SET status=?, updated_at=? WHERE id IN (${ph})`;
      head = [status, now];
      break;
    }
    case 'archive':
      sql = `UPDATE tasks SET archived_at=?, updated_at=? WHERE id IN (${ph})`;
      head = [now, now];
      break;
    case 'unarchive':
      sql = `UPDATE tasks SET archived_at=NULL, updated_at=? WHERE id IN (${ph})`;
      head = [now];
      break;
    case 'delete':
      sql = `UPDATE tasks SET deleted_at=?, updated_at=? WHERE id IN (${ph})`;
      head = [now, now];
      break;
    case 'restore':
      sql = `UPDATE tasks SET deleted_at=NULL, updated_at=? WHERE id IN (${ph})`;
      head = [now];
      break;
    case 'purge':
      // Only ever hard-delete what is already in the Papelera. This is the one
      // irreversible action in the API, and the UI only offers it from Trash —
      // but a malformed/replayed call must not be able to destroy live tasks.
      sql = `DELETE FROM tasks WHERE id IN (${ph}) AND deleted_at IS NOT NULL`;
      head = [];
      break;
    case 'client':
      sql = `UPDATE tasks SET client_hint=?, updated_at=? WHERE id IN (${ph})`;
      head = [String(value ?? '').trim(), now];
      break;
    case 'due': {
      const dueAt = value == null || value === '' ? null : Number(value);
      sql = `UPDATE tasks SET due_at=?, updated_at=? WHERE id IN (${ph})`;
      head = [dueAt, now];
      break;
    }
    default:
      res.status(400).json({ error: 'unknown action' });
      return;
  }
  const info = db().prepare(sql).run(...head, ...idList);
  res.json({ ok: true, changed: info.changes });
});

/** Soft-deleted tasks and clients, for the Trash tab. */
r.get('/api/trash', (_req, res) => {
  const d = db();
  const tasks = d
    .prepare(
      `SELECT id, title, detail, client_hint AS clientHint, status, deleted_at AS deletedAt
       FROM tasks WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC`,
    )
    .all();
  const clients = d
    .prepare(
      `SELECT handle, name, product_need AS productNeed, deleted_at AS deletedAt
       FROM clients WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC`,
    )
    .all();
  res.json({ tasks, clients });
});

/** Permanently empty the trash (tasks, clients, or both). */
r.post('/api/trash/empty', (req, res) => {
  const type = (req.body as { type?: string })?.type ?? 'all';
  const d = db();
  if (type === 'tasks' || type === 'all') d.prepare(`DELETE FROM tasks WHERE deleted_at IS NOT NULL`).run();
  if (type === 'clients' || type === 'all') d.prepare(`DELETE FROM clients WHERE deleted_at IS NOT NULL`).run();
  res.json({ ok: true });
});

r.post('/api/tasks/:id/status', (req, res) => {
  const status = (req.body as { status?: string }).status ?? '';
  if (!TASK_STATUSES.includes(status)) {
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
r.post('/api/tasks/:id/due', (req, res) => {
  const raw = (req.body as { dueAt?: number | null }).dueAt;
  const dueAt = raw == null || Number.isNaN(Number(raw)) ? null : Number(raw);
  db()
    .prepare('UPDATE tasks SET due_at = ?, updated_at = ? WHERE id = ?')
    .run(dueAt, Date.now(), Number(req.params.id));
  res.json({ ok: true });
});
