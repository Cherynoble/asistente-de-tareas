/**
 * The selection sentinels are a WIRE FORMAT already stored inside chat_messages
 * rows in every existing database. Making the UI trilingual must not translate
 * or rename them, or every thread that contains a pasted selection would stop
 * rendering its transcript. New messages use a locale-neutral pair; readers must
 * accept the legacy Spanish pair forever.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  SEL_OPEN,
  SEL_CLOSE,
  SEL_OPEN_LEGACY,
  SEL_CLOSE_LEGACY,
  SEL_MARKERS,
} from '../src/chat/store.js';

test('the legacy Spanish sentinels are frozen exactly as they were stored', () => {
  // These two literals must never change. Existing rows contain them verbatim.
  assert.equal(SEL_OPEN_LEGACY, '⟦SELECCIÓN⟧');
  assert.equal(SEL_CLOSE_LEGACY, '⟦/SELECCIÓN⟧');
});

test('new messages are written with a locale-neutral pair', () => {
  assert.equal(SEL_OPEN, '⟦SELECTION⟧');
  assert.equal(SEL_CLOSE, '⟦/SELECTION⟧');
  assert.notEqual(SEL_OPEN, SEL_OPEN_LEGACY);
});

test('SEL_MARKERS covers both pairs, so strippers cannot miss one', () => {
  assert.deepEqual(new Set(SEL_MARKERS), new Set([SEL_OPEN, SEL_CLOSE, SEL_OPEN_LEGACY, SEL_CLOSE_LEGACY]));
});

test('the browser parser accepts BOTH pairs and agrees with the server constants', () => {
  // app-chat.js is a classic script (no exports), so lift the parser out of the
  // source and run it — that keeps this test honest about the shipped code
  // rather than a copy of it.
  const src = fs.readFileSync(new URL('../public/app-chat.js', import.meta.url), 'utf8');
  const start = src.indexOf("const SEL_OPEN =");
  const end = src.indexOf('function bubble(');
  assert.ok(start >= 0 && end > start, 'sentinel block not found in app-chat.js');
  const block = src.slice(start, end);

  // The frontend copies must match the server's, or threads render wrong.
  assert.ok(block.includes(`'${SEL_OPEN}'`), 'frontend SEL_OPEN drifted from the server');
  assert.ok(block.includes(`'${SEL_CLOSE}'`), 'frontend SEL_CLOSE drifted from the server');
  assert.ok(block.includes(`'${SEL_OPEN_LEGACY}'`), 'frontend dropped the legacy open sentinel');
  assert.ok(block.includes(`'${SEL_CLOSE_LEGACY}'`), 'frontend dropped the legacy close sentinel');

  const findSelectionBlock = new Function(`${block}; return findSelectionBlock;`)() as (
    raw: string,
  ) => { open: number; close: number; openLen: number; closeLen: number } | null;

  // A thread written BEFORE this change (Spanish sentinels) must still parse.
  const legacy = `${SEL_OPEN_LEGACY}\n12 mensajes de Wong\nhola\n${SEL_CLOSE_LEGACY}\n\n¿qué pidió?`;
  const a = findSelectionBlock(legacy);
  assert.ok(a, 'legacy thread must still render its transcript');
  assert.equal(legacy.slice(a!.open + a!.openLen, a!.close).trim().split('\n')[0], '12 mensajes de Wong');

  // A thread written AFTER this change parses too.
  const modern = `${SEL_OPEN}\n3 messages from Wong\nhi\n${SEL_CLOSE}\n\nwhat did they ask?`;
  const b = findSelectionBlock(modern);
  assert.ok(b, 'new-format thread must render');
  assert.equal(modern.slice(b!.open + b!.openLen, b!.close).trim().split('\n')[0], '3 messages from Wong');

  // Ordinary text has no selection block.
  assert.equal(findSelectionBlock('just a normal question'), null);
  // An unterminated marker must not be treated as a block.
  assert.equal(findSelectionBlock(`${SEL_OPEN}\nno closing marker`), null);
});
