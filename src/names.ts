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
