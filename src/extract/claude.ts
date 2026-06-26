import { config } from '../config.js';
import { anthropicClient } from '../settings.js';
import type {
  ClientContext,
  ExistingTask,
  IngestedMessage,
  ProposedTask,
  TaskExtractor,
} from './types.js';

const SYSTEM = `You help a trading-company owner who hand-messages many clients a day and forgets follow-ups. From his chat messages, extract ACTIONABLE tasks he needs to do or follow up on.

A task is something he committed to, a client requested, or that clearly needs follow-up — e.g. "consult factories about toilet paper", "send the quote", "follow up on the sample", "check pricing for X". A photo or PDF of a product is usually a request to source/quote it.

Be LENIENT: when in doubt, propose the task — he reviews and one-taps approve or dismiss, so a false positive is cheap but a missed task is costly.

Do NOT create tasks for: greetings, small talk, emoji-only messages, confirmations/acknowledgements ("ok", "thanks"), or things already clearly completed.

If a list of ALREADY-OPEN tasks is provided, do NOT re-propose anything that is essentially the same as an existing one — only surface genuinely new tasks.

For each task return:
- title: a short imperative title, WRITTEN IN SPANISH (neutral Latin-American Spanish)
- detail: a one-line description, WRITTEN IN SPANISH
- source_msg_id: the #id of the single message that best triggered it
- source_quote: a SHORT, VERBATIM phrase copied exactly from that message (5–12 words) that the owner can paste into WhatsApp/iMessage search to find the conversation. Copy it character-for-character from the message IN ITS ORIGINAL LANGUAGE; do NOT translate or paraphrase it.
- client: the client/chat it relates to

The owner is a native Spanish speaker, so title and detail MUST be in Spanish even when the source messages are in English or Chinese. Keep product names, brand names, and proper names as-is. Only source_quote stays in the original language (it is used for text search).

If there are no real new tasks, return an empty list.`;

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
} as const;

interface RawTask {
  title: string;
  detail: string;
  source_msg_id: number;
  source_quote: string;
  client: string;
}

export class ClaudeExtractor implements TaskExtractor {
  readonly name = `claude:${config.model}`;

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

    const transcript = messages
      .map((m) => `#${m.id} [${m.direction}] ${m.chatName ?? m.sender ?? '?'}: ${m.body}`)
      .join('\n');

    const resp = await anthropicClient().messages.create({
      model: config.model,
      max_tokens: 4000,
      system: SYSTEM,
      messages: [
        {
          role: 'user',
          content: `${clientCtx}${openCtx}Chat transcript (oldest first). Each line is prefixed with #<id>:\n\n${transcript}`,
        },
      ],
      output_config: { format: { type: 'json_schema', schema: SCHEMA } },
    });

    const text = resp.content.find((b) => b.type === 'text');
    if (!text || text.type !== 'text') return [];
    const parsed = JSON.parse(text.text) as { tasks?: RawTask[] };

    return (parsed.tasks ?? []).map((t) => ({
      title: t.title,
      detail: t.detail,
      sourceMessageId: Number.isFinite(t.source_msg_id) ? t.source_msg_id : null,
      sourceQuote: t.source_quote ?? '',
      clientHint: t.client || null,
    }));
  }
}
