/**
 * Context budgeting for everything we send a model.
 *
 * The risk here is NOT the number of messages — measured against the real dev
 * DB, the whole chat context block is ~8k characters (~2–4k tokens) and an
 * extractor batch is about the same. The risk is a SINGLE pathological body:
 * that database holds a WhatsApp system message (id 21073) whose `body` is a
 * 39,748-character raw base64 JPEG. One row like that is ~10–18k tokens on its
 * own, and it would land in the recent-messages window, a pasted selection, and
 * an extractor batch alike — blowing the request on a model with a smaller
 * window, and costing real money on any of them.
 *
 * So the defence is per-item first, whole-block second. Both caps are in
 * CHARACTERS, not tokens: we have no tokenizer for the Chinese models, and a
 * character budget is the conservative choice because CJK packs more tokens per
 * character than Latin text does (roughly 1–1.5 chars/token vs 3.5–4).
 */

/** No single message body may occupy more than this share of a request. */
export const MAX_ITEM_CHARS = 2_000;

/** Ceiling for an assembled context block (recent messages, transcripts…). */
export const MAX_BLOCK_CHARS = 24_000;

/**
 * Trim one item (a message body, a task title…) and say so visibly, so the
 * model knows it is looking at a fragment rather than silently reasoning over
 * truncated evidence.
 */
export function clampItem(text: string, max = MAX_ITEM_CHARS): string {
  const t = text ?? '';
  if (t.length <= max) return t;
  return `${t.slice(0, max)}… [recortado: ${t.length} caracteres]`;
}

/**
 * Trim an assembled block, keeping the END. Recent messages and chat
 * transcripts are ordered oldest-first, so the tail is the part closest to what
 * the owner is asking about — dropping the head loses less than dropping the
 * tail would.
 */
export function clampBlockKeepingEnd(text: string, max = MAX_BLOCK_CHARS): string {
  const t = text ?? '';
  if (t.length <= max) return t;
  const kept = t.slice(t.length - max);
  // Resume at a line boundary so the first surviving line isn't a fragment.
  const nl = kept.indexOf('\n');
  const body = nl >= 0 && nl < 400 ? kept.slice(nl + 1) : kept;
  return `[…se omitieron ${t.length - body.length} caracteres más antiguos…]\n${body}`;
}
