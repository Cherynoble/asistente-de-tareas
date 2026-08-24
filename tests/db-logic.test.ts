/**
 * Logic that needs a real (scratch) database: the deterministic task dedup,
 * client-hint resolution + the name cache, the Mensajes pager cursors, and the
 * FTS-backed search. DATA_DIR points at a temp dir BEFORE any src import, so
 * the real DB is never touched (same pattern as scripts/smoke-fresh-install.ts).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'dadsapp-test-'));

const { db, ftsAvailable } = await import('../src/db/index.js');
const { saveTasks, normTitle } = await import('../src/extract/pipeline.js');
const { resolveClientHint, invalidateNameCache } = await import('../src/names.js');
const { pageMessages, searchAllMessages } = await import('../src/messages/browse.js');
const { timeToCron, cronToTime } = await import('../src/settings.js');

const now = Date.now();

function seedMessage(id: number, chatId: string, body: string, ts: number): void {
  db()
    .prepare(
      `INSERT INTO messages (id, source, source_msg_id, chat_id, chat_name, sender, direction, body, ts, ingested_at)
       VALUES (?, 'whatsapp', ?, ?, ?, ?, 'incoming', ?, ?, ?)`,
    )
    .run(id, `sid-${id}`, chatId, 'Chat', `+575550000009@c.us`, body, ts, now);
}

// ---- normTitle ----

test('normTitle ignores case, accents, and punctuation', () => {
  assert.equal(normTitle('Enviar diagnóstico.'), normTitle('enviar diagnostico'));
  assert.equal(normTitle('  Cotizar   papel!!  '), 'cotizar papel');
});

// ---- saveTasks dedup rules ----

test('rule 1: same title + same client is a duplicate', () => {
  const first = saveTasks([
    { title: 'Cotizar papel higiénico', detail: '', sourceMessageId: null, sourceQuote: '', clientHint: 'Cliente A' },
  ]);
  assert.equal(first.saved.length, 1);
  const again = saveTasks([
    { title: 'cotizar papel higienico', detail: '', sourceMessageId: null, sourceQuote: '', clientHint: 'Cliente A' },
  ]);
  assert.equal(again.saved.length, 0);
  assert.equal(again.duplicates.length, 1);
});

test('rule 1 fix: the SAME title for a DIFFERENT client is a real second task', () => {
  const other = saveTasks([
    { title: 'Cotizar papel higiénico', detail: '', sourceMessageId: null, sourceQuote: '', clientHint: 'Cliente B' },
  ]);
  assert.equal(other.saved.length, 1, 'a different client must not be swallowed as a duplicate');
});

test('rule 1: a hint-less proposal still matches conservatively', () => {
  const r = saveTasks([
    { title: 'Cotizar papel higiénico', detail: '', sourceMessageId: null, sourceQuote: '', clientHint: null },
  ]);
  assert.equal(r.saved.length, 0, 'no hint = conservative match against any open twin');
});

test('within one batch, twin proposals dedup against each other per client', () => {
  const r = saveTasks([
    { title: 'Enviar muestra', detail: '', sourceMessageId: null, sourceQuote: '', clientHint: 'Cliente A' },
    { title: 'enviar muestra', detail: '', sourceMessageId: null, sourceQuote: '', clientHint: 'Cliente A' },
    { title: 'Enviar muestra', detail: '', sourceMessageId: null, sourceQuote: '', clientHint: 'Cliente B' },
  ]);
  assert.equal(r.saved.length, 2);
  assert.equal(r.duplicates.length, 1);
});

test('rule 2: a done task blocks re-proposal only from the same source message', () => {
  seedMessage(9001, 'chat-dedup', 'manda la factura', now);
  const first = saveTasks([
    { title: 'Enviar factura', detail: '', sourceMessageId: 9001, sourceQuote: '', clientHint: 'Cliente A' },
  ]);
  assert.equal(first.saved.length, 1);
  db().prepare(`UPDATE tasks SET status='done' WHERE title='Enviar factura'`).run();

  // Re-analyzing the SAME message must not resurrect it…
  const resurrect = saveTasks([
    { title: 'Enviar factura', detail: '', sourceMessageId: 9001, sourceQuote: '', clientHint: 'Cliente A' },
  ]);
  assert.equal(resurrect.saved.length, 0);
  assert.equal(resurrect.duplicates[0]?.existingState, 'done');

  // …but the same request from a NEW message is a genuinely new task.
  seedMessage(9002, 'chat-dedup', 'la factura otra vez porfa', now + 1);
  const fresh = saveTasks([
    { title: 'Enviar factura', detail: '', sourceMessageId: 9002, sourceQuote: '', clientHint: 'Cliente A' },
  ]);
  assert.equal(fresh.saved.length, 1);
});

// ---- resolveClientHint + name cache ----

test('resolveClientHint resolves names and digit-formatted numbers to handles', () => {
  db()
    .prepare(
      `INSERT INTO clients (handle, name, product_need, created_at, updated_at)
       VALUES ('+575550000001@c.us', 'Cliente Uno', 'toallas', ?, ?)`,
    )
    .run(now, now);
  invalidateNameCache(); // direct DB write bypasses the API's invalidation

  assert.equal(resolveClientHint('Cliente Uno'), '+575550000001@c.us'); // exact name
  assert.equal(resolveClientHint('cliente'), '+575550000001@c.us'); // partial
  assert.equal(resolveClientHint('+57 555 0000001'), '+575550000001@c.us'); // digits
  assert.equal(resolveClientHint('Nadie Conocido'), 'Nadie Conocido'); // pass-through
});

test('nameMap caches until invalidated', async () => {
  const { nameMap } = await import('../src/names.js');
  const before = nameMap();
  db()
    .prepare(
      `INSERT INTO clients (handle, name, product_need, created_at, updated_at)
       VALUES ('+575550000002@c.us', 'Cliente Dos', '', ?, ?)`,
    )
    .run(now, now);
  assert.equal(nameMap()['+575550000002@c.us'], undefined, 'cached map should not see the write yet');
  assert.equal(before['+575550000001@c.us'], 'Cliente Uno');
  invalidateNameCache();
  assert.equal(nameMap()['+575550000002@c.us'], 'Cliente Dos');
});

// ---- Mensajes pager: composite (ts, id) cursors ----

test('pager pages duplicate-timestamp messages without skips or repeats', () => {
  const T = 1_700_000_000_000;
  // 10 messages, ALL sharing one timestamp — the case a ts-only cursor breaks on.
  for (let i = 1; i <= 10; i++) seedMessage(8000 + i, 'chat-pager', `msg ${i}`, T);

  const page1 = pageMessages({ chatId: 'chat-pager', limit: 4 });
  assert.equal(page1.messages.length, 4);
  assert.equal(page1.hasOlder, true);
  assert.equal(page1.hasNewer, false);
  assert.deepEqual(page1.messages.map((m) => m.id), [8007, 8008, 8009, 8010]);

  const first = page1.messages[0]!;
  const page2 = pageMessages({ chatId: 'chat-pager', dir: 'older', cursorTs: first.ts, cursorId: first.id, limit: 4 });
  assert.deepEqual(page2.messages.map((m) => m.id), [8003, 8004, 8005, 8006]);
  assert.equal(page2.hasOlder, true);

  const oldest = page2.messages[0]!;
  const page3 = pageMessages({ chatId: 'chat-pager', dir: 'older', cursorTs: oldest.ts, cursorId: oldest.id, limit: 4 });
  assert.deepEqual(page3.messages.map((m) => m.id), [8001, 8002]);
  assert.equal(page3.hasOlder, false);

  // 'newer' from the middle picks up exactly what follows.
  const mid = page2.messages[3]!; // id 8006
  const newer = pageMessages({ chatId: 'chat-pager', dir: 'newer', cursorTs: mid.ts, cursorId: mid.id, limit: 4 });
  assert.deepEqual(newer.messages.map((m) => m.id), [8007, 8008, 8009, 8010]);
  assert.equal(newer.hasNewer, false);

  // 'around' lands with context on both sides, no gap and no duplicate.
  const around = pageMessages({ chatId: 'chat-pager', dir: 'around', cursorTs: T, cursorId: 8005, limit: 4 });
  assert.deepEqual(around.messages.map((m) => m.id), [8003, 8004, 8005, 8006]);
});

// ---- search: FTS with LIKE semantics ----

test('search finds substrings, Chinese text, and treats % literally', () => {
  seedMessage(7001, 'chat-search', 'Necesito cotización de papel higiénico urgente', now);
  seedMessage(7002, 'chat-search', '请发卫生纸的报价', now + 1);
  seedMessage(7003, 'chat-search', 'descuento del 20% confirmado', now + 2);

  assert.equal(ftsAvailable(), true, 'this SQLite build should have fts5+trigram');
  assert.equal(searchAllMessages('papel higi').length, 1);
  assert.equal(searchAllMessages('卫生纸').length, 1);
  assert.equal(searchAllMessages('20%').length, 1); // literal %, not a wildcard
  assert.equal(searchAllMessages('zz-no-match').length, 0);
  // Short terms fall back to LIKE and still work.
  assert.ok(searchAllMessages('报价').length >= 1);
});

// ---- cron helpers ----

test('timeToCron/cronToTime round-trip and reject junk', () => {
  assert.equal(timeToCron('07:30'), '30 7 * * *');
  assert.equal(cronToTime('30 7 * * *'), '07:30');
  assert.equal(timeToCron('25:00'), null);
  assert.equal(timeToCron('nonsense'), null);
  assert.equal(cronToTime('*/5 * * * *'), '07:00'); // non-daily → display fallback
});
