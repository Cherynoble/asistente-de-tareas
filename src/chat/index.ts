import type Anthropic from '@anthropic-ai/sdk';
import { db } from '../db/index.js';
import { config } from '../config.js';
import { anthropicClient } from '../settings.js';
import { nameMap } from '../names.js';
import { addMessage, threadMessages, listMemories, saveMemory } from './store.js';
import { scheduleReminder } from '../notify/scheduled.js';

export interface ChatMsg {
  role: 'user' | 'assistant';
  content: string;
}

/** Map a client name the user typed to a known handle, if one matches; else keep the text. */
function resolveClientHint(client: string): string {
  const c = client.trim();
  if (!c) return '';
  const names = nameMap();
  const lc = c.toLowerCase();
  let partial = '';
  for (const [handle, name] of Object.entries(names)) {
    if (name.toLowerCase() === lc) return handle; // exact name → handle
    if (!partial && name.toLowerCase().includes(lc)) partial = handle;
  }
  return partial || c;
}

const SYSTEM = `You are the assistant inside "Dad's App", a task tracker for a trading-company owner. You can see his recent messages, his clients, his current tasks, and durable memory (provided below as context). Help him: answer what a client asked for, what's pending or overdue, what he might be forgetting, draft a reply, etc. Be concise and practical. Only use the provided context — if the answer isn't there, say so rather than guessing.

Tools you can use:
- save_memory: when the owner tells you something durable worth remembering across conversations (a lasting preference, a standing instruction, a key fact about a client or his business), save a concise one-sentence fact. Do NOT save ephemeral chatter or things already in the tasks/clients data.
- create_task: when the owner asks you to create/add a task ("crea una tarea…", "agrégame…"), create it directly. Use a short Spanish title, an optional detail, and the client if he names one. Confirm briefly in your reply.
- schedule_reminder: when the owner asks to be reminded at a later time ("recuérdame mañana…", "el lunes avísame…"), schedule it. Give due_iso as a local ISO 8601 datetime (e.g. 2026-06-27T09:00:00). If he gives no time of day, default to 09:00. Use CURRENT DATE/TIME below to compute it. Confirm the date/time in your reply.

IMPORTANT: The user is a native Spanish speaker. ALWAYS reply in Spanish (neutral Latin-American Spanish), regardless of the language of the messages or tasks in the context. Keep proper names, product names, and quoted message snippets in their original language.`;

const TOOLS: Anthropic.Tool[] = [
  {
    name: 'save_memory',
    description:
      'Guarda un dato duradero sobre el usuario, sus clientes, su negocio o sus preferencias para recordarlo en futuras conversaciones. Úsalo solo cuando el usuario comparta algo que valga la pena recordar a largo plazo — no para detalles efímeros ni preguntas puntuales.',
    input_schema: {
      type: 'object',
      properties: {
        fact: { type: 'string', description: 'El dato a recordar, en una sola frase concisa.' },
      },
      required: ['fact'],
    },
  },
  {
    name: 'create_task',
    description:
      'Crea una tarea nueva directamente en la lista (queda en estado "por hacer"). Úsalo cuando el usuario pida explícitamente crear o agregar una tarea.',
    input_schema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Título corto de la tarea, en español.' },
        detail: { type: 'string', description: 'Detalle o contexto opcional.' },
        client: { type: 'string', description: 'Nombre del cliente relacionado, si el usuario lo menciona.' },
      },
      required: ['title'],
    },
  },
  {
    name: 'schedule_reminder',
    description:
      'Programa un recordatorio único para una fecha/hora futura. Úsalo cuando el usuario pida que le recuerdes algo más tarde.',
    input_schema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Qué recordarle, en español.' },
        due_iso: {
          type: 'string',
          description: 'Fecha y hora local en ISO 8601, p. ej. 2026-06-27T09:00:00.',
        },
      },
      required: ['text', 'due_iso'],
    },
  },
];

/** Build a context block from the DB: open tasks, named clients, recent messages, memory. */
function buildContext(): string {
  const d = db();
  const tasks = d
    .prepare(
      `SELECT title, status, client_hint FROM tasks
       WHERE status IN ('proposed','todo','waiting') AND archived_at IS NULL AND deleted_at IS NULL
       ORDER BY updated_at DESC LIMIT 100`,
    )
    .all() as { title: string; status: string; client_hint: string }[];

  const clients = d
    .prepare(`SELECT name, handle, product_need FROM clients WHERE deleted_at IS NULL`)
    .all() as { name: string; handle: string | null; product_need: string }[];

  const names = nameMap();

  const recent = (
    d
      .prepare(`SELECT sender, direction, body FROM messages ORDER BY ts DESC LIMIT 250`)
      .all() as { sender: string | null; direction: string; body: string }[]
  ).reverse();

  // Cap injected memories so the store can grow without saturating the window.
  const memories = listMemories().slice(0, 40);

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
  const memTxt = memories.length ? memories.map((m) => `- ${m.content}`).join('\n') : '(none yet)';

  const nowLocal = new Date().toString();
  return `CURRENT DATE/TIME: ${nowLocal}\n\nLONG-TERM MEMORY (things you saved before):\n${memTxt}\n\nCURRENT OPEN TASKS:\n${tasksTxt}\n\nKNOWN CLIENTS:\n${clientsTxt}\n\nRECENT MESSAGES (most recent 250, oldest first):\n${msgsTxt}`;
}

/** Execute a tool the model called; returns a short result string. */
function execTool(name: string, input: unknown, threadId: number): string {
  if (name === 'save_memory') {
    const fact = (input as { fact?: string })?.fact ?? '';
    saveMemory(fact, threadId);
    return 'Guardado en memoria.';
  }
  if (name === 'create_task') {
    const i = (input as { title?: string; detail?: string; client?: string }) ?? {};
    const title = (i.title ?? '').trim();
    if (!title) return 'Falta el título de la tarea.';
    const now = Date.now();
    db()
      .prepare(
        `INSERT INTO tasks (title, detail, status, client_hint, source_quote, created_at, updated_at)
         VALUES (?, ?, 'todo', ?, '', ?, ?)`,
      )
      .run(title, (i.detail ?? '').trim(), resolveClientHint(i.client ?? ''), now, now);
    return `Tarea creada: "${title}".`;
  }
  if (name === 'schedule_reminder') {
    const i = (input as { text?: string; due_iso?: string }) ?? {};
    const text = (i.text ?? '').trim();
    const dueAt = i.due_iso ? new Date(i.due_iso).getTime() : NaN;
    if (!text || !Number.isFinite(dueAt)) return 'No se pudo programar (faltan datos o fecha inválida).';
    scheduleReminder(text, dueAt, threadId);
    return `Recordatorio programado para ${new Date(dueAt).toLocaleString('es')}.`;
  }
  return 'Herramienta desconocida.';
}

/**
 * Run one chat turn inside a thread: persist the user message, run the
 * tool-using loop (currently just save_memory), persist + return the reply.
 */
export async function runTurn(
  threadId: number,
  userText: string,
  attachments: { name: string }[] = [],
): Promise<{ reply: string; usedTools: string[] }> {
  addMessage(threadId, 'user', userText, attachments);

  const messages: Anthropic.MessageParam[] = threadMessages(threadId).map((m) => ({
    role: m.role,
    content: m.content,
  }));
  const client = anthropicClient();
  const usedTools: string[] = [];
  let reply = '';

  for (let i = 0; i < 5; i++) {
    const resp = await client.messages.create({
      model: config.model,
      max_tokens: 1024,
      system: `${SYSTEM}\n\n--- CONTEXT (from the database) ---\n${buildContext()}`,
      tools: TOOLS,
      messages,
    });
    const text = resp.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('');
    if (text) reply = text;

    if (resp.stop_reason === 'tool_use') {
      const results: Anthropic.ToolResultBlockParam[] = [];
      for (const block of resp.content) {
        if (block.type === 'tool_use') {
          usedTools.push(block.name);
          results.push({
            type: 'tool_result',
            tool_use_id: block.id,
            content: execTool(block.name, block.input, threadId),
          });
        }
      }
      messages.push({ role: 'assistant', content: resp.content });
      messages.push({ role: 'user', content: results });
      continue;
    }
    break;
  }

  addMessage(threadId, 'assistant', reply);
  return { reply, usedTools };
}
