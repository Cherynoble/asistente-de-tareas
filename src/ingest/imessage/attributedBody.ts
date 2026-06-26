/**
 * Modern macOS often stores message text in the binary `attributedBody` column
 * (an NSAttributedString archived as a typedstream) instead of the plain `text`
 * column. There's no clean public format, so this is a best-effort heuristic:
 * find the `NSString` class marker, skip to the typedstream length prefix, and
 * read that many UTF-8 bytes. Returns null if it can't confidently decode — we
 * tune this against real data in the Phase 1 checkpoint.
 */
export function decodeAttributedBody(buf: Buffer): string | null {
  try {
    const marker = buf.indexOf(Buffer.from('NSString', 'ascii'));
    if (marker === -1) return null;

    // After the class name comes a class-version marker `+` (0x2B), then the
    // typedstream length prefix, then the UTF-8 bytes.
    let p = buf.indexOf(0x2b, marker);
    if (p === -1) return null;
    p += 1;

    let len = buf[p];
    if (len === undefined) return null;
    p += 1;
    if (len === 0x81) {
      len = buf.readUInt16LE(p);
      p += 2;
    } else if (len === 0x82) {
      len = buf.readUInt32LE(p);
      p += 4;
    }

    if (len <= 0 || p + len > buf.length) return null;
    const text = buf.subarray(p, p + len).toString('utf8');

    // Sanity check: reject blobs that decoded to mostly control characters.
    if (!text || /�/.test(text)) return null;
    return text;
  } catch {
    return null;
  }
}
