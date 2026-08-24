/**
 * Request-level helpers shared by the route modules. Everything here used to
 * live inline in the old 1,700-line server/index.ts; the split moved routes to
 * src/server/routes/* and the cross-cutting pieces to this file.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type express from 'express';
import { db } from '../db/index.js';
import { config } from '../config.js';
import { splitAtt, attachmentCategory } from '../attachments.js';
import { getSelectedChats, getSelectedWaChats, listWaAccounts } from '../settings.js';
import { ingestRecentDays } from '../ingest/imessage/ingest.js';
import type { ActivityEvent } from '../extract/pipeline.js';
import type { BrowseRow } from '../messages/browse.js';

export const NATIVE_IMAGE = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);

/** Fallback mime by extension for attachments chat.db stored without one. */
export const MIME_BY_EXT: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.heic': 'image/heic',
  '.tiff': 'image/tiff',
  '.pdf': 'application/pdf',
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.m4a': 'audio/mp4',
  '.mp3': 'audio/mpeg',
  '.caf': 'audio/x-caf',
};

/**
 * Clamp a query/body param into [lo, hi], falling back to `dflt` when it isn't a
 * number at all.
 *
 * The bare `Math.min(Math.max(Number(x), lo), hi)` idiom this replaces looks
 * safe but propagates NaN — every comparison with NaN is false, so `Number('abc')`
 * came straight out the other end and reached SQLite as a LIMIT, which failed
 * with "datatype mismatch". Any hand-typed or stale URL could 500 a route.
 */
export function clampNum(raw: unknown, dflt: number, lo: number, hi: number): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(Math.max(n, lo), hi);
}

/**
 * SSE writer that survives the client disconnecting mid-stream. If the user
 * closes the window or switches tabs while a long extraction is running, the
 * socket dies; writing to it then can throw EPIPE and (without this guard) crash
 * the always-on server. We stop writing once the request closes or the response
 * ends, and swallow late socket errors.
 */
export function sseSender(req: express.Request, res: express.Response) {
  let gone = false;
  const stop = () => {
    gone = true;
  };
  req.on('close', stop);
  res.on('error', stop);
  const write = (raw: string) => {
    if (gone || res.writableEnded) return;
    try {
      res.write(raw);
    } catch {
      gone = true;
    }
  };
  return {
    send: (e: ActivityEvent) => write(`data: ${JSON.stringify(e)}\n\n`),
    fail: (message: string) => write(`event: failed\ndata: ${JSON.stringify({ message })}\n\n`),
    get closed() {
      return gone;
    },
  };
}

/** Which chat_ids are "included" given the per-source selections (empty = all).
 *  Shared by Clientes, the Adjuntos gallery and the Mensajes tab so they all
 *  honor the same scope. */
export function includedChats(): { filtering: boolean; allowed: string[] } {
  const selImsg = getSelectedChats();
  const waSel = new Map(listWaAccounts().map((a) => [a.id, getSelectedWaChats(a.id)]));
  const anyWaFilter = [...waSel.values()].some((s) => s.length > 0);
  const filtering = selImsg.length > 0 || anyWaFilter;
  if (!filtering) return { filtering: false, allowed: [] };
  const rows = db()
    .prepare(`SELECT DISTINCT source, wa_account, chat_id FROM messages WHERE chat_id IS NOT NULL`)
    .all() as { source: string; wa_account: string | null; chat_id: string }[];
  const allowed: string[] = [];
  for (const r of rows) {
    if (r.source === 'whatsapp') {
      const sel = waSel.get(r.wa_account || 'acc1') ?? getSelectedWaChats(r.wa_account || 'acc1');
      if (!sel.length || sel.includes(r.chat_id)) allowed.push(r.chat_id);
    } else {
      const ident = String(r.chat_id).split(';').pop() ?? r.chat_id;
      if (!selImsg.length || selImsg.includes(ident)) allowed.push(r.chat_id);
    }
  }
  return { filtering: true, allowed };
}

/** Does this process actually have Full Disk Access (can it read chat.db)? */
export function hasFda(): boolean {
  try {
    fs.accessSync(config.chatDbPath, fs.constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

export function absOfPath(p: string): string {
  return p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p;
}

/**
 * Why an attachment can (or can't) be shown, computed cheaply for the gallery so
 * a broken tile explains itself instead of just failing to load:
 *  - 'ok'      : file is on disk, serve it.
 *  - 'fda'     : an iMessage file whose folder we can't read (Full Disk Access).
 *  - 'fetch'   : a WhatsApp file not downloaded yet — fetchable on demand (needs
 *                the account connected); loaded only when the user asks.
 *  - 'missing' : file isn't on this Mac (deleted, or offloaded to iCloud).
 */
export function attachmentState(
  source: string,
  storedPath: string | undefined,
  fda: boolean,
): 'ok' | 'fda' | 'fetch' | 'missing' {
  const p = (storedPath || '').trim();
  if (p) {
    if (source === 'imessage' && !fda) return 'fda';
    try {
      return fs.existsSync(absOfPath(p)) ? 'ok' : 'missing';
    } catch {
      return 'missing';
    }
  }
  return source === 'whatsapp' ? 'fetch' : 'missing';
}

/** The row fields attachmentEntries() needs (both raw-SQL and BrowseRow shapes
 *  map onto this). */
export interface AttachmentRowLike {
  id: number;
  source: string;
  waAccount: string | null;
  sender: string | null;
  senderName: string | null;
  chatName: string | null;
  ts: number;
  attachment_mimes: string;
  attachment_names: string;
  attachment_paths: string;
}

/**
 * One entry per attachment on a message row, decorated with category, resolved
 * sender name, and the availability state above. This shape is the contract of
 * /api/attachments, /api/attachments/locate AND the Mensajes tab — it used to
 * be three hand-maintained copies that had to agree field-for-field.
 */
export function attachmentEntries(
  r: AttachmentRowLike,
  fda: boolean,
  names: Record<string, string>,
) {
  if (!r.attachment_mimes && !r.attachment_names) return [];
  const mimes = splitAtt(r.attachment_mimes);
  const fnames = splitAtt(r.attachment_names);
  const paths = splitAtt(r.attachment_paths);
  const out = [];
  for (let i = 0; i < Math.max(mimes.length, 1); i++) {
    const mime = mimes[i] || '';
    const p = paths[i];
    out.push({
      id: r.id,
      i,
      mime,
      category: attachmentCategory(mime),
      filename: fnames[i] || '',
      ts: r.ts,
      source: r.source,
      waAccount: r.waAccount,
      sender: r.sender,
      senderName: r.sender === 'me' ? null : names[r.sender ?? ''] || r.senderName || null,
      chatName: r.chatName,
      hasFile: !!(p && p.trim()),
      state: attachmentState(r.source, p, fda),
    });
  }
  return out;
}

/** Shape one message for the Mensajes browser, resolving names + attachments. */
export function browseMessage(
  r: BrowseRow,
  names: Record<string, string>,
  fda: boolean,
  tasks: Map<number, { id: number; title: string }[]>,
) {
  return {
    id: r.id,
    ts: r.ts,
    body: r.body,
    direction: r.direction,
    source: r.source,
    waAccount: r.waAccount,
    sourceMsgId: r.sourceMsgId,
    chatId: r.chatId,
    chatName: r.chatName,
    sender: r.sender,
    senderName: r.sender === 'me' ? null : names[r.sender ?? ''] || r.senderName || null,
    processed: !!r.processed,
    attachments: attachmentEntries(r, fda, names),
    tasks: tasks.get(r.id) ?? [],
  };
}

// Pull recent iMessages, but never let a chat.db failure (e.g. Full Disk Access
// not granted yet, or a WhatsApp-only setup) abort processing — we still want to
// process messages already stored (incl. WhatsApp).
export function ingestSafely(): void {
  try {
    ingestRecentDays(config.historyDays);
  } catch (err) {
    console.warn('[ingest] iMessage pull skipped:', err instanceof Error ? err.message : err);
  }
}
