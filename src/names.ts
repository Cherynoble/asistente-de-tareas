import { db } from './db/index.js';
import { resolveContactName } from './ingest/contacts.js';

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
 * chat titles ("Seniors 2024"), group names, and space-formatted phone numbers
 * ("+57 321 4274369") that can never match the stored handle format.
 *
 * Digits-only comparison is what catches that last case: a hint of
 * "+57 321 4274369" and a handle of "573214274369@c.us" are the same person.
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
