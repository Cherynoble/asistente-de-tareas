import { aiJson, aiName } from '../ai/index.js';
import { clampItem, clampBlockKeepingEnd } from '../ai/budget.js';
import { replyLanguageInstruction } from '../i18n.js';
import type {
  ClientContext,
  ExistingTask,
  IngestedMessage,
  ProposedTask,
  TaskExtractor,
} from './types.js';

/**
 * The extraction prompt.
 *
 * Portability notes — this was originally written and tuned against
 * claude-haiku-4-5, and three things in it leaned on Claude-specific behavior:
 *
 *  1. It assumed the model would honour a JSON schema it was never shown. Only
 *     Anthropic gets real schema enforcement here; OpenAI-compatible providers
 *     get `response_format: json_object` plus the schema as text. So the shape
 *     is now spelled out in the prompt WITH a worked example, and the parser
 *     (extractJson) already tolerates fences and surrounding prose.
 *  2. It relied on deep instruction-following for "copy source_quote verbatim,
 *     in the original language". Smaller models translate quotes anyway — which
 *     silently breaks the feature, because that string exists to be pasted into
 *     WhatsApp search. The instruction is now stated twice and, more
 *     importantly, verified in code by validateProposals() below. Prompts ask;
 *     code enforces.
 *  3. Output language was hardcoded to Spanish. It now follows the owner's
 *     chosen UI language.
 */
function systemPrompt(): string {
  return `You help a trading-company owner who hand-messages many clients a day and forgets follow-ups. From his chat messages, extract ACTIONABLE tasks he needs to do or follow up on.

A task is something he committed to, a client requested, or that clearly needs follow-up — e.g. "consult factories about toilet paper", "send the quote", "follow up on the sample", "check pricing for X". A photo or PDF of a product is usually a request to source/quote it.

Be LENIENT: when in doubt, propose the task — he reviews and one-taps approve or dismiss, so a false positive is cheap but a missed task is costly.

Do NOT create tasks for: greetings, small talk, emoji-only messages, confirmations/acknowledgements ("ok", "thanks"), or things already clearly completed.

If a list of ALREADY-OPEN tasks is provided, do NOT re-propose anything that is essentially the same as an existing one — only surface genuinely new tasks.

OUTPUT FORMAT — return a single json object, nothing else. No explanation before or after it, and no markdown code fence. It must look exactly like this:

{"tasks":[{"title":"...","detail":"...","source_msg_id":123,"source_quote":"...","client":"..."}]}

Field by field:
- title: a short imperative title.
- detail: a one-line description.
- source_msg_id: the integer #id of the single message that best triggered the task. It MUST be one of the #id values shown in the transcript. Never invent one.
- source_quote: 5-12 words COPIED CHARACTER-FOR-CHARACTER from that message, in the message's ORIGINAL LANGUAGE. This is not a summary and not a translation — the owner pastes this string into WhatsApp/iMessage search to find the conversation, so if you rewrite it in any way it will not be found. Copy, do not paraphrase.
- client: the client or chat it relates to.

${replyLanguageInstruction()}
The one exception is source_quote, which always stays in the original language of the message.

If there are no real new tasks, return {"tasks":[]}.`;
}

const SCHEMA = {
  type: 'object',
  properties: {
    tasks: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          detail: { type: 'string' },
          source_msg_id: { type: 'integer' },
          source_quote: { type: 'string' },
          client: { type: 'string' },
        },
        required: ['title', 'detail', 'source_msg_id', 'source_quote', 'client'],
        additionalProperties: false,
      },
    },
  },
  required: ['tasks'],
  additionalProperties: false,
};

interface RawTask {
  title: string;
  detail: string;
  source_msg_id: number;
  source_quote: string;
  client: string;
}

/** Loose match: ignore case, accents and whitespace runs when locating a quote. */
function norm(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/** First N words of a message, as a usable fallback search string. */
function leadingWords(body: string, count = 8): string {
  return body.replace(/\s+/g, ' ').trim().split(' ').slice(0, count).join(' ');
}

/**
 * Turn whatever the model returned into proposals we can trust.
 *
 * This is the deterministic half of the portability work. A weaker model gets
 * `source_msg_id` and `source_quote` wrong in ways that are invisible until the
 * owner taps a task and the quoted text isn't findable, so both are checked
 * against the actual transcript instead of taken on faith:
 *
 *  - an id that wasn't in this batch is dropped (it points at nothing);
 *  - a quote that does not literally occur in its message is replaced with real
 *    text from that message, so the search string always works;
 *  - a task with no usable title is dropped entirely.
 *
 * Exported for tests: this is the guard that has to hold when the model doesn't.
 */
export function validateProposals(raw: RawTask[], messages: IngestedMessage[]): ProposedTask[] {
  const byId = new Map(messages.map((m) => [m.id, m]));
  const out: ProposedTask[] = [];

  for (const t of raw) {
    const title = (t?.title ?? '').trim();
    if (!title) continue; // nothing actionable to show

    const id = Number(t?.source_msg_id);
    const msg = Number.isFinite(id) ? byId.get(id) : undefined;

    let quote = (t?.source_quote ?? '').trim();
    if (msg) {
      const body = msg.body ?? '';
      if (!quote || !norm(body).includes(norm(quote))) {
        // The model paraphrased or translated it. Substitute text that is
        // actually present, so the "paste into WhatsApp search" path works.
        quote = leadingWords(body);
      }
    } else if (quote) {
      // No resolvable source message: keep the text but drop the dangling id.
      quote = quote.slice(0, 200);
    }

    out.push({
      title,
      detail: (t?.detail ?? '').trim(),
      sourceMessageId: msg ? id : null,
      sourceQuote: quote,
      clientHint: (t?.client ?? '').trim() || null,
    });
  }
  return out;
}

/**
 * Task extraction over the CONFIGURED provider (Ajustes → Proveedor de IA),
 * using the cheap 'bulk' model — this runs over thousands of messages.
 * Formerly `ClaudeExtractor`.
 */
export class ModelExtractor implements TaskExtractor {
  readonly name = aiName('bulk');

  async proposeTasks(
    messages: IngestedMessage[],
    clients: ClientContext[] = [],
    existingTasks: ExistingTask[] = [],
  ): Promise<ProposedTask[]> {
    if (messages.length === 0) return [];

    const clientCtx = clients.length
      ? `Known clients and what they buy:\n${clients
          .map((c) => `- ${c.name}: ${c.productNeed}`)
          .join('\n')}\n\n`
      : '';

    const openCtx = existingTasks.length
      ? `ALREADY-OPEN tasks (do not duplicate these):\n${existingTasks
          .map((t) => `- ${t.title}${t.clientHint ? ` [${t.clientHint}]` : ''}`)
          .join('\n')}\n\n`
      : '';

    // A single oversized body (base64 blobs do turn up in real WhatsApp data)
    // would otherwise dominate the batch and can overflow a smaller model's
    // window outright — see ai/budget.ts.
    const transcript = clampBlockKeepingEnd(
      messages
        .map((m) => `#${m.id} [${m.direction}] ${m.chatName ?? m.sender ?? '?'}: ${clampItem(m.body)}`)
        .join('\n'),
    );

    const parsed = await aiJson<{ tasks?: RawTask[] }>(
      {
        system: systemPrompt(),
        maxTokens: 4000,
        messages: [
          {
            role: 'user',
            content: `${clientCtx}${openCtx}Chat transcript (oldest first). Each line is prefixed with #<id>:\n\n${transcript}`,
          },
        ],
      },
      SCHEMA,
    );

    return validateProposals(parsed?.tasks ?? [], messages);
  }
}
