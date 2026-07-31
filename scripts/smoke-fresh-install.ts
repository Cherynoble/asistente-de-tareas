/**
 * Fresh-install smoke test — the safety net this project did not have.
 *
 * WHY THIS EXISTS: `chat_messages.attachments` was added to `migrate()` in 0.3.0
 * and never to `schema.ts`. Because `migrate()` skips tables that don't exist
 * yet, every database created FRESH after 0.3.0 lacked the column and the whole
 * Chat tab returned 500 on its first message. It went unnoticed for four minor
 * versions because the only database anyone ever tested against was the original
 * install, which predates 0.3.0 and therefore got the migration.
 *
 * In silo mode every employee's Mac is a fresh install, so "works on the DB I
 * already have" is worth nothing. Run this before every release.
 *
 *   npx tsx scripts/smoke-fresh-install.ts
 *
 * It builds a throwaway DB in a temp dir, asserts that the fresh schema carries
 * every column the code actually reads, and exercises the write paths. It never
 * touches the real database and never calls the Anthropic API.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Point config.ts at a scratch dir BEFORE anything imports it.
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'dadsapp-smoke-'));
process.env.DATA_DIR = scratch;

const { db } = await import('../src/db/index.js');
const { createThread, addMessage, threadMessages, saveMemory, listMemories } = await import(
  '../src/chat/store.js'
);
const { saveTasks } = await import('../src/extract/pipeline.js');
const { openTasks, buildDigest, runNudgeSweep } = await import('../src/notify/reminders.js');
const { scheduleReminder, listReminders } = await import('../src/notify/scheduled.js');
const { nameMap, resolveClientHint } = await import('../src/names.js');
const { computeDiagnostics } = await import('../src/diagnostics.js');
const { getSetting, setSetting, listWaAccounts } = await import('../src/settings.js');

let failures = 0;
function check(name: string, fn: () => void): void {
  try {
    fn();
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failures++;
    console.log(`  ✗ ${name}\n      ${err instanceof Error ? err.message : String(err)}`);
  }
}
function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

console.log(`\nFresh-install smoke test — ${scratch}\n`);

// ── 1. Schema parity: every column the code reads must exist on a FRESH DB ──
// This is the check that would have caught the 0.3.0 regression.
const EXPECTED: Record<string, string[]> = {
  messages: [
    'id', 'source', 'wa_account', 'source_msg_id', 'chat_id', 'chat_name', 'sender',
    'sender_name', 'direction', 'body', 'ts', 'ingested_at', 'processed', 'has_attachment',
    'attachment_mimes', 'attachment_names', 'attachment_paths',
  ],
  tasks: [
    'id', 'client_id', 'title', 'detail', 'status', 'client_hint', 'source_message_id',
    'source_quote', 'due_at', 'last_nudge_at', 'archived_at', 'deleted_at', 'created_at',
    'updated_at',
  ],
  clients: ['id', 'name', 'handle', 'product_need', 'category', 'deleted_at', 'created_at', 'updated_at'],
  settings: ['key', 'value'],
  chat_threads: ['id', 'title', 'created_at', 'updated_at'],
  chat_messages: ['id', 'thread_id', 'role', 'content', 'attachments', 'created_at'],
  chat_memory: ['id', 'content', 'source_thread_id', 'created_at'],
  ai_reminders: ['id', 'text', 'due_at', 'created_at', 'notified_at', 'dismissed_at', 'source_thread_id'],
};

console.log('Schema parity (fresh DB vs. what the code reads):');
for (const [table, expected] of Object.entries(EXPECTED)) {
  check(`${table} has every expected column`, () => {
    const actual = (db().prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(
      (c) => c.name,
    );
    assert(actual.length > 0, `table ${table} does not exist on a fresh install`);
    const missing = expected.filter((c) => !actual.includes(c));
    assert(
      missing.length === 0,
      `missing on fresh install: ${missing.join(', ')} — add them to schema.ts, not just to migrate()`,
    );
  });
}

// ── 2. The write paths that a first-run user hits ──
console.log('\nFirst-run write paths:');

check('chat thread + message round-trips (the 1.7.2 regression)', () => {
  const id = createThread('prueba');
  addMessage(id, 'user', 'hola', [{ name: 'foto.jpg' }]);
  addMessage(id, 'assistant', 'listo');
  const msgs = threadMessages(id);
  assert(msgs.length === 2, `expected 2 messages, got ${msgs.length}`);
  assert(msgs[0]?.attachments?.[0]?.name === 'foto.jpg', 'attachment did not round-trip');
});

check('memory saves and dedups', () => {
  saveMemory('el cliente X compra toallas');
  saveMemory('el cliente X compra toallas');
  assert(listMemories().length === 1, 'exact-duplicate memory was not deduped');
});

check('settings read/write + WA account registry seeds', () => {
  setSetting('smoke', 'ok');
  assert(getSetting('smoke') === 'ok', 'setting did not round-trip');
  const accts = listWaAccounts();
  assert(accts.length === 1 && accts[0]?.id === 'acc1', 'expected a seeded acc1');
});

// Seed a stub message: tasks.source_message_id has an enforced FK.
const msgId = Number(
  db()
    .prepare(
      `INSERT INTO messages (source, source_msg_id, chat_id, chat_name, sender, direction, body, ts, ingested_at)
       VALUES ('imessage', 'smoke-1', 'chat-1', 'Cliente Uno', '+575550000001@c.us', 'incoming', 'necesito toallas', ?, ?)`,
    )
    .run(Date.now(), Date.now()).lastInsertRowid,
);

check('saveTasks inserts, then refuses a deterministic duplicate', () => {
  const proposal = {
    title: 'Cotizar toallas',
    detail: 'El cliente pidió precio',
    sourceMessageId: msgId,
    sourceQuote: 'necesito toallas',
    clientHint: 'Cliente Uno',
  };
  const first = saveTasks([proposal]);
  assert(first.saved.length === 1, 'first save should insert');
  assert(first.duplicates.length === 0, 'first save should not report a duplicate');

  const second = saveTasks([proposal]);
  assert(second.saved.length === 0, 'second save should insert nothing');
  assert(second.duplicates.length === 1, 'second save should report the collision');
});

check('client_hint is normalized to a handle when one resolves', () => {
  const now = Date.now();
  db()
    .prepare(
      `INSERT INTO clients (handle, name, product_need, created_at, updated_at)
       VALUES ('+575550000001@c.us', 'Cliente Uno', 'toallas', ?, ?)`,
    )
    .run(now, now);
  assert(
    resolveClientHint('Cliente Uno') === '+575550000001@c.us',
    'an exact client name should resolve to its handle',
  );
  // The live-DB failure case: a space-formatted number never matched a handle.
  assert(
    resolveClientHint('+57 555 000 0001') === '+575550000001@c.us',
    'a space-formatted phone number should resolve on digits',
  );
  assert(resolveClientHint('Grupo Ejemplo 2024') === 'Grupo Ejemplo 2024', 'an unresolvable hint should pass through');
  assert(typeof nameMap()['+575550000001@c.us'] === 'string', 'nameMap should resolve the handle');
});

// ── 3. Reminders must ignore the Papelera ──
console.log('\nReminders:');

check('a trashed task is not "open" (digest + nudge leak)', () => {
  const now = Date.now();
  db()
    .prepare(
      `INSERT INTO tasks (title, detail, status, client_hint, source_quote, due_at, deleted_at, created_at, updated_at)
       VALUES ('Tarea en la papelera', '', 'todo', '', '', ?, ?, ?, ?)`,
    )
    .run(now - 86_400_000, now, now, now); // overdue AND trashed

  const titles = openTasks().map((t) => t.title);
  assert(
    !titles.includes('Tarea en la papelera'),
    'a trashed task is still counted as open — it will nudge forever',
  );
  assert(buildDigest().counts.overdue === 0, 'a trashed overdue task inflated the digest');
  const swept = runNudgeSweep(Date.now(), { force: true });
  assert(
    !swept.tasks.some((t) => t.title === 'Tarea en la papelera'),
    'the nudge sweep picked up a trashed task',
  );
});

check('scheduled reminders round-trip', () => {
  scheduleReminder('llamar a la fábrica', Date.now() + 3_600_000);
  assert(listReminders().length === 1, 'reminder was not stored');
});

// ── 4. Diagnostics bound to the scratch DB, not the real one ──
console.log('\nIsolation:');
check('diagnostics point at the scratch dir (real DB untouched)', () => {
  const info = computeDiagnostics();
  assert(info.dataDir === scratch, `expected ${scratch}, got ${info.dataDir}`);
});

// ── done ──
fs.rmSync(scratch, { recursive: true, force: true });
if (failures) {
  console.log(`\n✗ ${failures} check(s) failed.\n`);
  process.exit(1);
}
console.log('\n✓ Fresh install is healthy.\n');
