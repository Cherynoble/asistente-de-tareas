import { config } from '../../config.js';
import { db } from '../../db/index.js';
import { getSelectedChats } from '../../settings.js';
import { readMessagesSince, readRecentMessagesByCount, type IMessageRow } from './reader.js';

/** Persist a batch of iMessages into app.db, deduped on (source, source_msg_id). */
export function persistMessages(rows: IMessageRow[]): { read: number; inserted: number } {
  const d = db();
  const now = Date.now();
  const insert = d.prepare(/* sql */ `
    INSERT OR IGNORE INTO messages
      (source, source_msg_id, chat_id, chat_name, sender, sender_name, direction,
       body, ts, ingested_at, has_attachment, attachment_mimes, attachment_names,
       attachment_paths)
    VALUES
      (@source, @source_msg_id, @chat_id, @chat_name, @sender, @sender_name, @direction,
       @body, @ts, @ingested_at, @has_attachment, @attachment_mimes, @attachment_names,
       @attachment_paths)
  `);

  const run = d.transaction((items: IMessageRow[]) => {
    let inserted = 0;
    for (const r of items) {
      const info = insert.run({
        source: 'imessage',
        source_msg_id: r.sourceMsgId,
        chat_id: r.chatId,
        chat_name: r.chatName,
        sender: r.sender,
        sender_name: null,
        direction: r.direction,
        body: r.body,
        ts: r.ts,
        ingested_at: now,
        has_attachment: r.hasAttachment ? 1 : 0,
        attachment_mimes: r.attachmentMimes.join('||'),
        attachment_names: r.attachmentNames.join('||'),
        attachment_paths: r.attachmentPaths.join('||'),
      });
      inserted += info.changes;
    }
    return inserted;
  });

  return { read: rows.length, inserted: run(rows) };
}

/** Incremental: pull the last `days` days of iMessages from selected chats (deduped). */
export function ingestRecentDays(days: number) {
  const since = Date.now() - days * 24 * 60 * 60 * 1000;
  return persistMessages(readMessagesSince(since, getSelectedChats()));
}

/** Backfill: pull the most recent `limit` iMessages from selected chats (deduped). */
export function backfillByCount(limit: number) {
  return persistMessages(readRecentMessagesByCount(limit, getSelectedChats()));
}

// CLI entry: `BACKFILL=5000 npm run imessage:ingest` does a count-based backfill;
// otherwise it pulls the last HISTORY_DAYS days.
const isMain = process.argv[1]?.endsWith('ingest.ts');
if (isMain) {
  const backfill = Number(process.env.BACKFILL ?? 0);
  const { read, inserted } = backfill > 0
    ? backfillByCount(backfill)
    : ingestRecentDays(config.historyDays);

  const d = db();
  const total = (d.prepare('SELECT COUNT(*) AS n FROM messages').get() as { n: number }).n;
  const withAttach = (
    d.prepare('SELECT COUNT(*) AS n FROM messages WHERE has_attachment = 1').get() as { n: number }
  ).n;
  console.log(
    `\n${backfill > 0 ? `Backfill (${backfill})` : `Last ${config.historyDays}d`}: ` +
      `read ${read}, inserted ${inserted} new.`,
  );
  console.log(`app.db now holds ${total} messages (${withAttach} with attachments).`);
}
