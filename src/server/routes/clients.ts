/** Clientes routes: senders roster, client upsert/category, auto-classify. */
import express from 'express';
import { db } from '../../db/index.js';
import { autoClassifyClients } from '../../clients/classify.js';
import { nameMap, invalidateNameCache } from '../../names.js';
import { aiNotConfigured, hasAiKey } from '../../ai/index.js';
import { includedChats } from '../helpers.js';

export const clientsRouter = express.Router();
const r = clientsRouter;

/** Bulk action over a set of client handles. action ∈ delete | restore | purge. */
r.post('/api/clients/bulk', (req, res) => {
  const { handles, action } = req.body as { handles?: string[]; action?: string };
  const list = Array.isArray(handles) ? handles.filter((h) => typeof h === 'string' && h) : [];
  if (!list.length || !action) {
    res.status(400).json({ error: 'handles and action required' });
    return;
  }
  const now = Date.now();
  const ph = list.map(() => '?').join(',');
  const d = db();
  if (action === 'delete') {
    // Tombstone the handle (create an empty record if it isn't a client yet) so
    // it's hidden from Clientes and its name dropped — tasks are untouched.
    const ins = d.prepare(
      `INSERT INTO clients (handle, name, product_need, deleted_at, created_at, updated_at)
       VALUES (?, '', '', ?, ?, ?)
       ON CONFLICT(handle) DO UPDATE SET deleted_at = excluded.deleted_at, updated_at = excluded.updated_at`,
    );
    const tx = d.transaction((hs: string[]) => {
      for (const h of hs) ins.run(h, now, now, now);
    });
    tx(list);
  } else if (action === 'restore') {
    d.prepare(`UPDATE clients SET deleted_at=NULL, updated_at=? WHERE handle IN (${ph})`).run(now, ...list);
  } else if (action === 'purge') {
    // Same rule as tasks: purge is Trash-only and irreversible.
    d.prepare(`DELETE FROM clients WHERE handle IN (${ph}) AND deleted_at IS NOT NULL`).run(...list);
  } else {
    res.status(400).json({ error: 'unknown action' });
    return;
  }
  invalidateNameCache(); // deleting/restoring a client changes resolved names
  res.json({ ok: true });
});

/**
 * Distinct senders with message counts, the resolved display name, and any
 * manual client name/product-need. Limited to senders that appear in the chats
 * selected in Settings (empty selection = all chats), so the Clientes tab only
 * lists people the owner actually chose to track.
 */
r.get('/api/senders', (_req, res) => {
  const d = db();
  const { filtering, allowed } = includedChats();
  const noneAllowed = filtering && allowed.length === 0;

  type Row = {
    handle: string;
    count: number;
    name: string | null;
    productNeed: string | null;
    category: string | null;
  };
  const byHandle = new Map<string, Row>();

  // 1) Message senders (subject to the selected-chats filter).
  if (!noneAllowed) {
    const where =
      `WHERE m.sender IS NOT NULL AND m.sender != 'me'` +
      ` AND m.sender NOT IN (SELECT handle FROM clients WHERE deleted_at IS NOT NULL AND handle IS NOT NULL)` +
      (filtering ? ` AND m.chat_id IN (${allowed.map(() => '?').join(',')})` : '');
    const rows = d
      .prepare(
        `SELECT m.sender AS handle, COUNT(*) AS count, c.name AS name, c.product_need AS productNeed,
                c.category AS category
         FROM messages m
         LEFT JOIN clients c ON c.handle = m.sender AND c.deleted_at IS NULL
         ${where}
         GROUP BY m.sender ORDER BY count DESC LIMIT 200`,
      )
      .all(...(filtering ? allowed : [])) as Row[];
    for (const row of rows) byHandle.set(row.handle, row);
  }

  // 2) Clients referenced by a task (client_hint) but not in the message senders
  //    — e.g. a brand-new client typed into a manually/AI-created task. These are
  //    explicit, so they show regardless of the chat filter.
  const deleted = new Set(
    (d.prepare(`SELECT handle FROM clients WHERE deleted_at IS NOT NULL AND handle IS NOT NULL`).all() as {
      handle: string;
    }[]).map((x) => x.handle),
  );
  const taskClients = d
    .prepare(`SELECT DISTINCT client_hint AS h FROM tasks WHERE client_hint != '' AND deleted_at IS NULL`)
    .all() as { h: string }[];
  for (const { h } of taskClients) {
    if (byHandle.has(h) || deleted.has(h)) continue;
    const c = d
      .prepare(
        `SELECT name, product_need AS productNeed, category FROM clients WHERE handle = ? AND deleted_at IS NULL`,
      )
      .get(h) as { name: string; productNeed: string; category: string } | undefined;
    byHandle.set(h, {
      handle: h,
      count: 0,
      name: c?.name ?? null,
      productNeed: c?.productNeed ?? null,
      category: c?.category ?? null,
    });
  }

  const names = nameMap();
  const out = [...byHandle.values()]
    .map((row) => ({ ...row, displayName: names[row.handle] ?? null }))
    .sort((a, b) => b.count - a.count);
  res.json(out);
});

/** Create/update a client: name + product-need for a handle. */
r.post('/api/clients', (req, res) => {
  const { handle, name, productNeed } = req.body as {
    handle?: string;
    name?: string;
    productNeed?: string;
  };
  if (!handle || !name || !name.trim()) {
    res.status(400).json({ error: 'handle and name required' });
    return;
  }
  const now = Date.now();
  db()
    .prepare(
      `INSERT INTO clients (handle, name, product_need, created_at, updated_at)
       VALUES (@handle, @name, @productNeed, @now, @now)
       ON CONFLICT(handle) DO UPDATE SET
         name = excluded.name, product_need = excluded.product_need,
         deleted_at = NULL, updated_at = excluded.updated_at`,
    )
    .run({ handle, name: name.trim(), productNeed: (productNeed ?? '').trim(), now });
  invalidateNameCache(); // renames must show up immediately, not after the TTL
  res.json({ ok: true });
});

/** Set (or clear) a client's category — Personal / Oficina / custom / '' — for a
 *  handle, creating the client row if it doesn't exist yet. */
r.post('/api/clients/category', (req, res) => {
  const { handle, category } = req.body as { handle?: string; category?: string };
  if (!handle) {
    res.status(400).json({ error: 'handle required' });
    return;
  }
  const cat = (category ?? '').trim().slice(0, 40);
  const now = Date.now();
  const name = nameMap()[handle] || ''; // don't bake a phone number into the name
  db()
    .prepare(
      `INSERT INTO clients (handle, name, category, created_at, updated_at)
       VALUES (@handle, @name, @cat, @now, @now)
       ON CONFLICT(handle) DO UPDATE SET category = excluded.category, deleted_at = NULL, updated_at = excluded.updated_at`,
    )
    .run({ handle, name, cat, now });
  invalidateNameCache(); // may create a client row (affects manual-name layer)
  res.json({ ok: true });
});

/** Auto-tag still-unclassified clients as Personal/Oficina with a quick AI pass. */
r.post('/api/clients/autoclassify', async (_req, res) => {
  if (!hasAiKey()) {
    res.status(400).json({ error: aiNotConfigured });
    return;
  }
  try {
    const result = await autoClassifyClients();
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

/** handle → display name (manual > macOS Contacts > WhatsApp pushname). */
r.get('/api/namemap', (_req, res) => {
  res.json(nameMap());
});
