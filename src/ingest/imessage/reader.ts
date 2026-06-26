import { openChatDb } from '../../db/index.js';
import { decodeAttributedBody } from './attributedBody.js';

/** Apple's Core Data epoch (2001-01-01) in unix milliseconds. */
const APPLE_EPOCH_MS = 978_307_200_000;

/** The "Object Replacement Character" iMessage uses as an attachment placeholder. */
const OBJ_REPLACEMENT = /￼/g;

export interface IMessageRow {
  sourceMsgId: string; // message.guid
  chatId: string | null;
  chatName: string | null;
  sender: string | null; // handle (phone/email), or 'me' for outgoing
  direction: 'incoming' | 'outgoing';
  body: string;
  ts: number; // unix ms
  fromAttributedBody: boolean;
  hasAttachment: boolean;
  attachmentMimes: string[];
  attachmentNames: string[];
  attachmentPaths: string[];
}

interface RawRow {
  guid: string;
  text: string | null;
  attributedBody: Buffer | null;
  is_from_me: bigint;
  date: bigint; // nanoseconds since APPLE_EPOCH
  handle: string | null;
  chat_identifier: string | null;
  display_name: string | null;
  chat_guid: string | null;
  attachment_count: bigint;
  attachment_mimes: string | null;
  attachment_names: string | null;
  attachment_paths: string | null;
}

const SELECT_CORE = /* sql */ `
  SELECT
    m.guid                              AS guid,
    m.text                              AS text,
    m.attributedBody                    AS attributedBody,
    m.is_from_me                        AS is_from_me,
    m.date                              AS date,
    h.id                                AS handle,
    c.chat_identifier                   AS chat_identifier,
    c.display_name                      AS display_name,
    c.guid                              AS chat_guid,
    COUNT(a.ROWID)                      AS attachment_count,
    GROUP_CONCAT(a.mime_type, '||')     AS attachment_mimes,
    GROUP_CONCAT(a.transfer_name, '||') AS attachment_names,
    GROUP_CONCAT(a.filename, '||')      AS attachment_paths
  FROM message m
  LEFT JOIN handle h                  ON m.handle_id = h.ROWID
  LEFT JOIN chat_message_join j       ON j.message_id = m.ROWID
  LEFT JOIN chat c                    ON c.ROWID = j.chat_id
  LEFT JOIN message_attachment_join k ON k.message_id = m.ROWID
  LEFT JOIN attachment a              ON a.ROWID = k.attachment_id
`;

function splitList(s: string | null): string[] {
  if (!s) return [];
  return s.split('||').filter((x) => x && x.length > 0);
}

function mapRow(r: RawRow): IMessageRow | null {
  const fromAttr = r.text == null && r.attributedBody != null;
  const raw = r.text ?? (r.attributedBody ? decodeAttributedBody(r.attributedBody) : null);
  let body = (raw ?? '').replace(OBJ_REPLACEMENT, '').trim();

  const hasAttachment = Number(r.attachment_count) > 0;
  const mimes = splitList(r.attachment_mimes);
  const names = splitList(r.attachment_names);
  const paths = splitList(r.attachment_paths);

  if (!body && hasAttachment) {
    const label = names.length ? names.join(', ') : mimes.join(', ');
    body = `[attachment: ${label || 'file'}]`;
  }
  if (!body) return null;

  return {
    sourceMsgId: r.guid,
    chatId: r.chat_guid ?? r.chat_identifier,
    chatName: r.display_name || r.chat_identifier || r.handle,
    sender: r.is_from_me === 1n ? 'me' : r.handle,
    direction: r.is_from_me === 1n ? 'outgoing' : 'incoming',
    body,
    ts: Number(r.date / 1_000_000n) + APPLE_EPOCH_MS,
    fromAttributedBody: fromAttr,
    hasAttachment,
    attachmentMimes: mimes,
    attachmentNames: names,
    attachmentPaths: paths,
  };
}

function chatClause(chats: string[]): string {
  return chats.length ? ` c.chat_identifier IN (${chats.map(() => '?').join(',')})` : '';
}

/**
 * Read iMessages at or after `sinceMs`, chronological. If `chats` is non-empty,
 * only messages from those chat_identifiers are returned.
 */
export function readMessagesSince(sinceMs: number, chats: string[] = []): IMessageRow[] {
  const db = openChatDb();
  try {
    const cutoffNs = BigInt(sinceMs - APPLE_EPOCH_MS) * 1_000_000n;
    const where = `WHERE m.date >= ?${chats.length ? ' AND' + chatClause(chats) : ''}`;
    const stmt = db
      .prepare(`${SELECT_CORE} ${where} GROUP BY m.ROWID ORDER BY m.date ASC`)
      .safeIntegers(true);
    const rows = stmt.all(cutoffNs, ...chats) as unknown as RawRow[];
    return rows.map(mapRow).filter((r): r is IMessageRow => r !== null);
  } finally {
    db.close();
  }
}

/** Read the most recent `limit` iMessages (optionally only from `chats`), chronological. */
export function readRecentMessagesByCount(limit: number, chats: string[] = []): IMessageRow[] {
  const db = openChatDb();
  try {
    const where = chats.length ? `WHERE${chatClause(chats)}` : '';
    const stmt = db
      .prepare(`${SELECT_CORE} ${where} GROUP BY m.ROWID ORDER BY m.date DESC LIMIT ?`)
      .safeIntegers(true);
    const rows = stmt.all(...chats, BigInt(limit)) as unknown as RawRow[];
    return rows
      .map(mapRow)
      .filter((r): r is IMessageRow => r !== null)
      .reverse();
  } finally {
    db.close();
  }
}

export interface ChatInfo {
  id: string; // chat_identifier
  name: string;
  isGroup: boolean;
  count: number;
}

/** List available iMessage chats (with message counts) for the selection UI. */
export function listChats(): ChatInfo[] {
  const db = openChatDb();
  try {
    const rows = db
      .prepare(
        `SELECT c.chat_identifier AS id,
                COALESCE(NULLIF(c.display_name, ''), c.chat_identifier) AS name,
                MAX(c.style) AS style,
                COUNT(j.message_id) AS count
         FROM chat c
         LEFT JOIN chat_message_join j ON j.chat_id = c.ROWID
         GROUP BY c.chat_identifier
         HAVING count > 0
         ORDER BY count DESC`,
      )
      .all() as { id: string; name: string; style: number; count: number }[];
    return rows
      .filter((r) => r.id)
      .map((r) => ({ id: r.id, name: r.name || r.id, isGroup: r.style === 43, count: r.count }));
  } finally {
    db.close();
  }
}
