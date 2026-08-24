/** WhatsApp account routes (multi-account: the father runs two numbers). */
import express from 'express';
import {
  listAccountStates,
  getAccountState,
  addAccount,
  removeAccount,
  renameAccount,
  startAccount,
  resetAccount,
  repairAccount,
  backfillAccount,
  listAccountChats,
  accountIsReady,
} from '../../ingest/whatsapp/client.js';
import { resolveContactName } from '../../ingest/contacts.js';
import { nameMap } from '../../names.js';
import { getSelectedWaChats, setSelectedWaChats } from '../../settings.js';
import { clampNum } from '../helpers.js';

export const whatsappRouter = express.Router();
const r = whatsappRouter;

/** All registered accounts with their status, identity, and QR. */
r.get('/api/whatsapp/accounts', (_req, res) => {
  res.json({ accounts: listAccountStates() });
});

/** Add a fresh account slot and begin pairing it. */
r.post('/api/whatsapp/accounts', (_req, res) => {
  res.json(addAccount());
});

/** Remove an account: stop it, wipe its session, drop it from the registry. */
r.delete('/api/whatsapp/accounts/:id', async (req, res) => {
  await removeAccount(req.params.id);
  res.json({ ok: true, accounts: listAccountStates() });
});

/** Rename (custom label) an account; empty label reverts to auto-detected. */
r.post('/api/whatsapp/accounts/:id/label', (req, res) => {
  const label = String((req.body as { label?: string })?.label ?? '');
  res.json(renameAccount(req.params.id, label) ?? { error: 'cuenta no encontrada' });
});

/** Start (begin pairing / reconnect) a single account. */
r.post('/api/whatsapp/accounts/:id/start', (req, res) => {
  res.json(startAccount(req.params.id) ?? { error: 'cuenta no encontrada' });
});

/** One account's status + current QR. */
r.get('/api/whatsapp/accounts/:id/status', (req, res) => {
  res.json(getAccountState(req.params.id) ?? { error: 'cuenta no encontrada' });
});

/** Hard reset one account: scrub orphan Chrome + stale locks, reconnect. */
r.post('/api/whatsapp/accounts/:id/reset', async (req, res) => {
  res.json((await resetAccount(req.params.id)) ?? { error: 'cuenta no encontrada' });
});

/** Re-pair one account: wipe its (corrupted) session so a fresh QR is shown. */
r.post('/api/whatsapp/accounts/:id/repair', async (req, res) => {
  res.json((await repairAccount(req.params.id)) ?? { error: 'cuenta no encontrada' });
});

/** Backfill recent history for one connected account. */
r.post('/api/whatsapp/accounts/:id/backfill', async (req, res) => {
  const perChat = clampNum((req.body as { perChat?: number })?.perChat, 200, 1, 2000);
  try {
    res.json(await backfillAccount(req.params.id, perChat));
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

/** One account's chats for the selection UI (requires that account to be ready). */
r.get('/api/whatsapp/accounts/:id/chats', async (req, res) => {
  const id = req.params.id;
  if (!accountIsReady(id)) {
    res.json({ chats: [], filtering: false, ready: false });
    return;
  }
  try {
    const selected = new Set(getSelectedWaChats(id));
    const names = nameMap();
    const chats = (await listAccountChats(id)).map((c) => ({
      ...c,
      selected: selected.has(c.id),
      displayName: names[c.id] || c.name || resolveContactName(c.id) || c.id,
    }));
    res.json({ chats, filtering: selected.size > 0, ready: true });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

/** Save a chat selection for one account (empty = all chats). */
r.post('/api/whatsapp/accounts/:id/chats', (req, res) => {
  const ids = (req.body as { chats?: unknown })?.chats;
  setSelectedWaChats(req.params.id, Array.isArray(ids) ? ids.filter((x) => typeof x === 'string') : []);
  res.json({ ok: true });
});
