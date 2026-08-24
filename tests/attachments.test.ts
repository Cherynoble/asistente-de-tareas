import { test } from 'node:test';
import assert from 'node:assert/strict';
import { joinAtt, splitAtt, sanitizeAttComponent, attachmentCategory } from '../src/attachments.js';

test('splitAtt preserves positions and empty slots', () => {
  assert.deepEqual(splitAtt('a||b||c'), ['a', 'b', 'c']);
  assert.deepEqual(splitAtt('a||||c'), ['a', '', 'c']); // middle slot stays empty
  assert.deepEqual(splitAtt(''), []);
  assert.deepEqual(splitAtt(null), []);
  assert.deepEqual(splitAtt('||'), []); // all-empty list is "no attachments"
});

test('joinAtt/splitAtt round-trip keeps alignment', () => {
  const mimes = ['image/jpeg', '', 'application/pdf'];
  assert.deepEqual(splitAtt(joinAtt(mimes)), mimes);
});

test('a filename containing the separator cannot corrupt alignment', () => {
  const names = ['foto||rara.jpg', 'ok.pdf'];
  const split = splitAtt(joinAtt(names));
  assert.equal(split.length, 2); // NOT 3 — the separator inside was neutralized
  assert.equal(split[1], 'ok.pdf'); // index alignment survives
  assert.equal(sanitizeAttComponent('a||b'), 'a¦¦b');
});

test('attachmentCategory groups real mimes and bare WhatsApp markers', () => {
  assert.equal(attachmentCategory('image/heic'), 'image');
  assert.equal(attachmentCategory('image'), 'image');
  assert.equal(attachmentCategory('sticker'), 'image');
  assert.equal(attachmentCategory('application/pdf'), 'pdf');
  assert.equal(attachmentCategory('ptt'), 'audio');
  assert.equal(attachmentCategory('video/mp4'), 'video');
  assert.equal(attachmentCategory(''), 'other');
  assert.equal(attachmentCategory('text/vcard'), 'other');
});
