import { db } from '../db/index.js';
import { config } from '../config.js';
import { anthropicClient } from '../settings.js';
import { nameMap } from '../names.js';

export interface ChatMsg {
  role: 'user' | 'assistant';
  content: string;
}

const SYSTEM = `You are the assistant inside "Dad's App", a task tracker for a trading-company owner. You can see his recent messages, his clients, and his current tasks (provided below as context). Help him: answer what a client asked for, what's pending or overdue, what he might be forgetting, draft a reply, etc. Be concise and practical. Only use the provided context — if the answer isn't there, say so rather than guessing.

IMPORTANT: The user is a native Spanish speaker. ALWAYS reply in Spanish (neutral Latin-American Spanish), regardless of the language of the messages or tasks in the context. Keep proper names, product names, and quoted message snippets in their original language.`;

/** Build a context block from the DB: open tasks, named clients, recent messages. */
function buildContext(): string {
  const d = db();
  const tasks = d
    .prepare(
      `SELECT title, status, client_hint FROM tasks
       WHERE status IN ('proposed','todo','waiting') AND archived_at IS NULL
       ORDER BY updated_at DESC LIMIT 100`,
    )
    .all() as { title: string; status: string; client_hint: string }[];

  const clients = d
    .prepare(`SELECT name, handle, product_need FROM clients`)
    .all() as { name: string; handle: string | null; product_need: string }[];

  const names = nameMap();

  const recent = (
    d
      .prepare(`SELECT sender, direction, body FROM messages ORDER BY ts DESC LIMIT 250`)
      .all() as { sender: string | null; direction: string; body: string }[]
  ).reverse();

  const tasksTxt = tasks.length
    ? tasks
        .map((t) => `- [${t.status}] ${t.title}${t.client_hint ? ` (client: ${t.client_hint})` : ''}`)
        .join('\n')
    : '(none)';
  const clientsTxt = clients.length
    ? clients
        .map((c) => `- ${c.name}${c.handle ? ` (${c.handle})` : ''}${c.product_need ? `: ${c.product_need}` : ''}`)
        .join('\n')
    : '(none named yet)';
  const msgsTxt = recent
    .map((m) => {
      const who = m.direction === 'outgoing' ? 'Me' : names[m.sender ?? ''] || m.sender || '?';
      return `${who}: ${m.body}`;
    })
    .join('\n');

  return `CURRENT OPEN TASKS:\n${tasksTxt}\n\nKNOWN CLIENTS:\n${clientsTxt}\n\nRECENT MESSAGES (most recent 250, oldest first):\n${msgsTxt}`;
}

/** Answer a chat turn using the DB as context. */
export async function chat(history: ChatMsg[]): Promise<string> {
  const resp = await anthropicClient().messages.create({
    model: config.model,
    max_tokens: 1024,
    system: `${SYSTEM}\n\n--- CONTEXT (from the database) ---\n${buildContext()}`,
    messages: history.map((m) => ({ role: m.role, content: m.content })),
  });
  const block = resp.content.find((b) => b.type === 'text');
  return block && block.type === 'text' ? block.text : '';
}
