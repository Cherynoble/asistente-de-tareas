import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodeAttributedBody } from '../src/ingest/imessage/attributedBody.js';

/** Build a minimal typedstream-shaped buffer the decoder understands:
 *  …NSString…+ <length prefix> <utf8 bytes>… */
function synthetic(text: string): Buffer {
  const utf8 = Buffer.from(text, 'utf8');
  let lenPrefix: Buffer;
  if (utf8.length < 0x81) {
    lenPrefix = Buffer.from([utf8.length]);
  } else if (utf8.length <= 0xffff) {
    lenPrefix = Buffer.alloc(3);
    lenPrefix[0] = 0x81;
    lenPrefix.writeUInt16LE(utf8.length, 1);
  } else {
    lenPrefix = Buffer.alloc(5);
    lenPrefix[0] = 0x82;
    lenPrefix.writeUInt32LE(utf8.length, 1);
  }
  return Buffer.concat([
    Buffer.from([0x04, 0x0b]), // arbitrary preamble
    Buffer.from('NSString', 'ascii'),
    Buffer.from([0x01, 0x94, 0x84, 0x01]), // filler before the class-version marker
    Buffer.from('+', 'ascii'),
    lenPrefix,
    utf8,
    Buffer.from([0x86, 0x84]), // trailing stream bytes
  ]);
}

test('decodes a short single-byte-length message', () => {
  assert.equal(decodeAttributedBody(synthetic('Hola, ¿cómo vas?')), 'Hola, ¿cómo vas?');
});

test('decodes a >128-byte message via the 0x81 two-byte length', () => {
  const long = 'pedido de papel higiénico '.repeat(10).trim();
  assert.ok(Buffer.byteLength(long, 'utf8') > 0x81);
  assert.equal(decodeAttributedBody(synthetic(long)), long);
});

test('decodes Chinese text', () => {
  assert.equal(decodeAttributedBody(synthetic('请问卫生纸的报价')), '请问卫生纸的报价');
});

test('returns null on buffers without the NSString marker', () => {
  assert.equal(decodeAttributedBody(Buffer.from('random bytes with no marker')), null);
});

test('returns null instead of throwing on truncated buffers', () => {
  const b = synthetic('hello world');
  assert.equal(decodeAttributedBody(b.subarray(0, b.length - 8)), null);
});
