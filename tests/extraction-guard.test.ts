/**
 * The deterministic guard on model output.
 *
 * Moving off Claude means a weaker model may paraphrase, translate or invent
 * the two fields the app depends on mechanically:
 *   source_msg_id  — links a task back to a real message
 *   source_quote   — the literal string the owner pastes into WhatsApp search
 * Neither failure is visible in the UI until he taps a task and finds nothing.
 * validateProposals() is what makes those fields trustworthy regardless of
 * which model produced them, so it gets tested against the ways models fail.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateProposals } from '../src/extract/extractor.js';
import type { IngestedMessage } from '../src/extract/types.js';

const msg = (id: number, body: string): IngestedMessage =>
  ({ id, body, direction: 'incoming', sender: '+1@c.us', chatName: 'Wong', ts: 0 }) as IngestedMessage;

const messages = [
  msg(101, 'Hola, necesito cotización de toallas de papel para el lunes'),
  msg(102, 'Can you check with the factory about the paper towels pricing?'),
  msg(103, '请给我报价单，谢谢'),
];

const raw = (over: Partial<Record<string, unknown>> = {}) => ({
  title: 'Cotizar toallas',
  detail: 'Pedido de Wong',
  source_msg_id: 101,
  source_quote: 'necesito cotización de toallas',
  client: 'Wong',
  ...over,
}) as never;

test('a well-formed proposal passes through unchanged', () => {
  const [t] = validateProposals([raw()], messages);
  assert.equal(t!.sourceMessageId, 101);
  assert.equal(t!.sourceQuote, 'necesito cotización de toallas');
  assert.equal(t!.clientHint, 'Wong');
});

test('a quote the model TRANSLATED is replaced with text really in the message', () => {
  // The classic small-model failure: it renders the Spanish message's quote in
  // English. Pasting that into WhatsApp search finds nothing.
  const [t] = validateProposals([raw({ source_quote: 'I need a quote for paper towels' })], messages);
  assert.notEqual(t!.sourceQuote, 'I need a quote for paper towels');
  assert.ok(
    messages[0]!.body.includes(t!.sourceQuote),
    `repaired quote must literally occur in the message, got: ${t!.sourceQuote}`,
  );
});

test('a PARAPHRASED quote is likewise repaired', () => {
  const [t] = validateProposals([raw({ source_quote: 'pide cotizacion de toallas para el lunes' })], messages);
  assert.ok(messages[0]!.body.includes(t!.sourceQuote));
});

test('quote matching ignores case, accents and whitespace runs', () => {
  // Real quotes differ cosmetically all the time; those must NOT be "repaired".
  const [t] = validateProposals([raw({ source_quote: 'NECESITO   COTIZACION de toallas' })], messages);
  assert.equal(t!.sourceQuote, 'NECESITO   COTIZACION de toallas', 'a cosmetic difference is still a real quote');
});

test('an invented source_msg_id is dropped rather than stored as a dead link', () => {
  const [t] = validateProposals([raw({ source_msg_id: 999 })], messages);
  assert.equal(t!.sourceMessageId, null);
  assert.equal(t!.title, 'Cotizar toallas', 'the task itself is still worth proposing');
});

test('a non-numeric source_msg_id does not crash the batch', () => {
  const out = validateProposals([raw({ source_msg_id: 'abc' }), raw({ source_msg_id: null })], messages);
  assert.equal(out.length, 2);
  assert.ok(out.every((t) => t.sourceMessageId === null));
});

test('Chinese messages round-trip without mangling the quote', () => {
  const [t] = validateProposals(
    [raw({ source_msg_id: 103, source_quote: '请给我报价单' })],
    messages,
  );
  assert.equal(t!.sourceMessageId, 103);
  assert.equal(t!.sourceQuote, '请给我报价单');
});

test('a translated Chinese quote is repaired with real Chinese text', () => {
  const [t] = validateProposals(
    [raw({ source_msg_id: 103, source_quote: 'please send me the quotation' })],
    messages,
  );
  assert.ok(messages[2]!.body.includes(t!.sourceQuote), `got: ${t!.sourceQuote}`);
});

test('a missing quote is filled in from the message', () => {
  const [t] = validateProposals([raw({ source_quote: '' })], messages);
  assert.ok(t!.sourceQuote.length > 0);
  assert.ok(messages[0]!.body.includes(t!.sourceQuote));
});

test('a task with no title is dropped entirely', () => {
  const out = validateProposals([raw({ title: '   ' }), raw({ title: 'Real' })], messages);
  assert.deepEqual(out.map((t) => t.title), ['Real']);
});

test('missing fields degrade to empty rather than "undefined" text', () => {
  const out = validateProposals(
    [{ title: 'Solo título' } as never],
    messages,
  );
  assert.equal(out.length, 1);
  assert.equal(out[0]!.detail, '');
  assert.equal(out[0]!.clientHint, null);
  assert.equal(out[0]!.sourceMessageId, null);
});

test('an empty model response yields no proposals', () => {
  assert.deepEqual(validateProposals([], messages), []);
});
