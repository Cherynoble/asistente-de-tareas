/**
 * The ONE definition of how attachment lists are stored on a message row.
 *
 * messages.attachment_{mimes,names,paths} are '||'-joined, positionally aligned
 * lists (mimes[i]/names[i]/paths[i] describe the same file). That alignment is
 * load-bearing everywhere, and the historical splitting was copy-pasted across
 * eight files with no escaping — a filename that itself contained '||' would
 * silently shift every list after it and pair index i with the wrong file.
 * joinAtt() now neutralizes the separator inside components at write time;
 * existing rows are unaffected (real-world mimes/paths can't contain '||', and
 * filenames virtually never do — this closes the door going forward).
 */

export const ATT_SEP = '||';

/** Make a component safe to embed in a '||'-joined list. */
export function sanitizeAttComponent(s: string): string {
  return (s || '').replace(/\|\|/g, '¦¦');
}

/** Join components, PRESERVING positions (empty slots stay empty). */
export function joinAtt(parts: (string | null | undefined)[]): string {
  return parts.map((p) => sanitizeAttComponent(p ?? '')).join(ATT_SEP);
}

/** Split a stored list, PRESERVING positions so index alignment holds.
 *  ('' → [] so "no attachments" doesn't read as one empty attachment.) */
export function splitAtt(s: string | null | undefined): string[] {
  if (!s) return [];
  const parts = s.split(ATT_SEP);
  return parts.every((x) => x === '') ? [] : parts;
}

/** UI grouping for an attachment's stored mime (which may be a bare WhatsApp
 *  type marker like 'image'/'video'/'ptt' rather than a real mime type). */
export function attachmentCategory(mime: string): 'image' | 'pdf' | 'video' | 'audio' | 'other' {
  if (!mime) return 'other';
  if (mime.startsWith('image/') || mime === 'image' || mime === 'sticker') return 'image';
  if (mime === 'application/pdf') return 'pdf';
  if (mime.startsWith('video/') || mime === 'video') return 'video';
  if (mime.startsWith('audio/') || mime === 'audio' || mime === 'ptt') return 'audio';
  return 'other';
}
