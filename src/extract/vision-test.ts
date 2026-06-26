import { db } from '../db/index.js';
import { describeAttachment } from './vision.js';

// Validates vision on a few real image/PDF attachments from app.db.
// Sends those files to Claude — run on a small N (default 3).
const limit = Number(process.env.VISION_LIMIT ?? 3);

interface Row {
  id: number;
  chat_name: string | null;
  attachment_mimes: string;
  attachment_paths: string;
}

const rows = db()
  .prepare(
    `SELECT id, chat_name, attachment_mimes, attachment_paths
     FROM messages
     WHERE has_attachment = 1
       AND (attachment_mimes LIKE '%image/%' OR attachment_mimes LIKE '%pdf%')
       AND attachment_paths != ''
     ORDER BY ts DESC LIMIT ?`,
  )
  .all(limit) as Row[];

if (rows.length === 0) {
  console.log('No image/PDF attachments found. Run `npm run imessage:ingest` first.');
  process.exit(0);
}

console.log(`Describing ${rows.length} recent image/PDF attachment(s) with Claude vision…\n`);

for (const r of rows) {
  const mimes = r.attachment_mimes.split('||');
  const paths = r.attachment_paths.split('||');
  // Pick the first image/PDF in the message.
  const idx = mimes.findIndex((m) => m.startsWith('image/') || m === 'application/pdf');
  if (idx === -1) continue;
  const mime = mimes[idx]!;
  const filePath = paths[idx]!;

  console.log(`msg #${r.id} · ${r.chat_name ?? '?'} · ${mime}`);
  try {
    const desc = await describeAttachment(filePath, mime);
    console.log(`  → ${desc}\n`);
  } catch (err) {
    console.log(`  ✗ ${err instanceof Error ? err.message : String(err)}\n`);
  }
}
