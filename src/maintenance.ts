import fs from 'node:fs';
import { db } from './db/index.js';
import { splitAtt } from './attachments.js';

/**
 * One-time (idempotent) cleanup of WhatsApp stickers. Stickers carry no task
 * signal (memes/emoji) and only waste storage + on-demand downloads, so as of
 * this version we stop ingesting them (see whatsapp/client.ts). This scrubs any
 * that were already captured/downloaded: delete their files from disk and drop
 * the message rows. Runs on every boot — after the first pass it finds nothing,
 * so it's cheap and safe to leave in place.
 *
 * A sticker row is identified by its body marker ("[attachment: sticker]") — set
 * at capture time and never overwritten — or the bare "sticker" mime tag left on
 * rows captured before any download. Both are covered.
 */
export function purgeStickers(): number {
  const d = db();
  const rows = d
    .prepare(
      `SELECT id, attachment_paths AS paths FROM messages
       WHERE body = '[attachment: sticker]' OR attachment_mimes = 'sticker'`,
    )
    .all() as { id: number; paths: string | null }[];
  if (!rows.length) return 0;

  for (const r of rows) {
    for (const p of splitAtt(r.paths)) {
      const f = p.trim();
      if (!f) continue;
      try {
        fs.rmSync(f, { force: true });
      } catch {
        /* best effort — a missing file is fine */
      }
    }
  }
  const ids = rows.map((r) => r.id);
  const del = d.prepare(`DELETE FROM messages WHERE id IN (${ids.map(() => '?').join(',')})`);
  del.run(...ids);
  console.log(`[maintenance] purged ${rows.length} sticker message(s)`);
  return rows.length;
}
