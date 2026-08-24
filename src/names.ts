import { db } from './db/index.js';
import { resolveContactName } from './ingest/contacts.js';

// nameMap() scans and GROUPs the whole messages table, yet is called on nearly
// every request (message pages, senders, attachments, chat context) and inside
// resolveClientHint() per task insert — O(all messages) each time. Cache it
// briefly; writers that change names (Clientes edits, ingest) call
// invalidateNameCache() so edits still show up immediately.
const NAME_CACHE_MS = 30_000;
let nameCache: { map: Record<string, string>; at: number } | null = null;

/** Drop the cached name map (call after any write that can change a name). */
export function invalidateNameCache(): void {
  nameCache = null;
}

/**
 * Build a handle -> display-name map used everywhere the UI shows a sender.
 * Precedence, highest first:
 *   1. Manual name the owner set in the Clientes tab (clients.name)
 *   2. macOS Contacts (phone/email lookup) — real saved names
 *   3. Captured WhatsApp pushname (messages.sender_name)
 * Handles with none of these are omitted, so the UI falls back to the raw
 * phone/email (prettified) and can prompt the owner to name them.
 */
export function nameMap(): Record<string, string> {
  if (nameCache && Date.now() - nameCache.at < NAME_CACHE_MS) return nameCache.map;
  const d = db();
  const handles = d
    .prepare(`SELECT DISTINCT sender FROM messages WHERE sender IS NOT NULL AND sender != 'me'`)
    .all() as { sender: string }[];

  // Best captured WhatsApp name per sender (most frequent non-empty).
  const capturedRows = d
    .prepare(
      `SELECT sender, sender_name AS nm, COUNT(*) AS c
       FROM messages
       WHERE sender_name IS NOT NULL AND sender_name != '' AND sender IS NOT NULL
       GROUP BY sender, sender_name`,
    )
    .all() as { sender: string; nm: string; c: number }[];
  const captured: Record<string, { nm: string; c: number }> = {};
  for (const r of capturedRows) {
    const cur = captured[r.sender];
    if (!cur || r.c > cur.c) captured[r.sender] = { nm: r.nm, c: r.c };
  }

  const manual: Record<string, string> = {};
  for (const r of d
    .prepare(`SELECT handle, name FROM clients WHERE handle IS NOT NULL AND name != '' AND deleted_at IS NULL`)
    .all() as { handle: string; name: string }[]) {
    manual[r.handle] = r.name;
  }

  const out: Record<string, string> = {};
  for (const { sender } of handles) {
    const name = manual[sender] || resolveContactName(sender) || captured[sender]?.nm;
    if (name) out[sender] = name;
  }
  // Manual entries whose handle no longer appears in messages still count.
  for (const [h, n] of Object.entries(manual)) if (!out[h]) out[h] = n;
  nameCache = { map: out, at: Date.now() };
  return out;
}

/**
 * Resolve whatever a task-creating path calls "the client" down to a HANDLE when
 * one matches, else keep the text as-is.
 *
 * `tasks.client_hint` is the only real link between a task and a contact
 * (`tasks.client_id` has never been written by any code path). It has to be
 * written consistently or that link silently rots: before 1.7.2 the chat agent
 * stored handles here while the extractor stored whatever *display name* the
 * model produced, so the same client accumulated several spellings and the
 * Clientes tab listed each unresolvable one as a phantom contact with 0
 * messages. Observed in the live DB: 9 of 13 distinct hints were not handles —
 * they were chat titles, group names, and space-formatted phone numbers, none of
 * which can ever match the stored handle format.
 *
 * Digits-only comparison is what catches that last case: a hint of
 * "+00 000 0000000" and a handle of "000000000000@c.us" are the same person.
 *
 * The examples here are synthetic on purpose. Never paste real contact data out
 * of the database into source or docs — this repo is public and the bundle ships
 * these comments in `dist/`.
 */
export function resolveClientHint(client: string): string {
  const c = client.trim();
  if (!c) return '';
  const names = nameMap();
  const lc = c.toLowerCase();
  const hintDigits = c.replace(/\D/g, '');

  let partial = '';
  let byDigits = '';
  for (const [handle, name] of Object.entries(names)) {
    if (name.toLowerCase() === lc) return handle; // exact name → handle
    if (!partial && name.toLowerCase().includes(lc)) partial = handle;
    if (!byDigits && hintDigits.length >= 7) {
      const hd = handle.replace(/\D/g, '');
      // Compare on the last 9 digits so a country-code difference doesn't miss.
      if (hd.length >= 7 && hd.slice(-9) === hintDigits.slice(-9)) byDigits = handle;
    }
  }
  return partial || byDigits || c;
}
