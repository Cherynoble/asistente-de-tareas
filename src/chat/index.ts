import { db } from '../db/index.js';
import { splitAtt } from '../attachments.js';
import { aiProvider, type AiChatProvider, type AiMsg, type AiTool } from '../ai/index.js';
import { clampItem, clampBlockKeepingEnd } from '../ai/budget.js';
import { nameMap, resolveClientHint } from '../names.js';
import { replyLanguageInstruction } from '../i18n.js';
import { addMessage, threadMessages, listMemories, saveMemory } from './store.js';
import { scheduleReminder } from '../notify/scheduled.js';
import { describeAttachment } from '../extract/vision.js';
import { normTitle } from '../extract/pipeline.js';
import { bodyFilterSql } from '../messages/browse.js';
import { downloadWaMedia } from '../ingest/whatsapp/client.js';

export interface ChatMsg {
  role: 'user' | 'assistant';
  content: string;
}

// resolveClientHint moved to ../names.ts in 1.7.2 so the extraction pipeline
// shares one definition of "which contact is this task for" — see the note there.

/**
 * The chat agent's system prompt.
 *
 * Portability notes (was tuned against claude-haiku-4-5):
 *  - The instruction language is English. Every model here follows English
 *    instructions and English tool schemas best — that is what function-calling
 *    training data looks like — while the ANSWER language is set separately by
 *    replyLanguageInstruction(), so the owner still reads his own language.
 *  - The "don't assume it didn't happen, go and search" guidance matters more,
 *    not less, on a smaller model: the failure mode we are guarding against is
 *    answering "no lo veo" instead of calling search_messages. It is stated
 *    early, concretely, and again per-tool.
 */
function systemPrompt(): string {
  return `You are the assistant inside "Dad's App", a task tracker for a trading-company owner. You can see his recent messages, his clients, his current tasks, and durable memory (provided below as context). Help him: answer what a client asked for, what's pending or overdue, what he might be forgetting, draft a reply, etc. Be concise and practical. Only use the provided context or what your tools return — if the answer isn't there, say so rather than guessing.

The RECENT MESSAGES below are only a small window (the most recent 150). The full history holds many thousands of messages and every attachment (photos, PDFs) the owner has received or sent. Do NOT conclude that something never happened just because it is missing from that window. Before answering "I don't see it", CALL search_messages. When the owner refers to a photo, quote, invoice or document, call find_attachments and then read_attachment before answering.

Tools you can use:
- save_memory: when the owner tells you something durable worth remembering across conversations (a lasting preference, a standing instruction, a key fact about a client or his business), save a concise one-sentence fact. Do NOT save ephemeral chatter or things already in the tasks/clients data.
- create_task: when the owner asks you to create or add a task, create it directly. Use a short title, an optional detail, and the client if he names one. Confirm briefly in your reply.
- schedule_reminder: when the owner asks to be reminded at a later time, schedule it. Give due_iso as a local ISO 8601 datetime (e.g. 2026-06-27T09:00:00). If he gives no time of day, default to 09:00. Use CURRENT DATE/TIME below to compute it. Confirm the date and time in your reply.
- search_messages: search the FULL message history by keyword (and optionally by client) when the answer might be older than the recent window — "what did X ask for", "did anyone mention toallas", "when did we last talk to Y". Prefer this over saying you cannot see it.
- find_attachments: find files (images, PDFs, documents) the owner received or sent, by filename, contact, chat, or surrounding text. Returns each file's message_id and index so you can read it.
- read_attachment: open and read a specific file (image or PDF) by message_id (from find_attachments) and analyse its contents — quote figures from a quotation or invoice, describe a product photo, and so on. Use it whenever the owner asks about the content of a file.

${replyLanguageInstruction()}`;
}

const TOOLS: AiTool[] = [
  {
    name: 'save_memory',
    description:
      'Save a durable fact about the owner, his clients, his business or his preferences, to remember in future conversations. Use only when he shares something worth remembering long term — not for ephemeral details or one-off questions.',
    schema: {
      type: 'object',
      properties: {
        fact: { type: 'string', description: 'The fact to remember, as one concise sentence.' },
      },
      required: ['fact'],
    },
  },
  {
    name: 'create_task',
    description:
      'Create a new task directly in the list (it lands in the "todo" state). Use when the owner explicitly asks to create or add a task.',
    schema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: "Short task title, in the owner's language." },
        detail: { type: 'string', description: 'Optional detail or context.' },
        client: { type: 'string', description: 'Name of the related client, if the owner mentions one.' },
      },
      required: ['title'],
    },
  },
  {
    name: 'schedule_reminder',
    description:
      'Schedule a one-off reminder for a future date and time. Use when the owner asks to be reminded of something later.',
    schema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: "What to remind him of, in the owner's language." },
        due_iso: {
          type: 'string',
          description: 'Local date and time in ISO 8601, e.g. 2026-06-27T09:00:00.',
        },
      },
      required: ['text', 'due_iso'],
    },
  },
  {
    name: 'search_messages',
    description:
      'Search the ENTIRE message history (thousands of messages), not just the recent window. Use whenever the answer might be further back in time. Returns matching messages with date, sender and text.',
    schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Word or phrase to search for in message text.' },
        client: { type: 'string', description: 'Optional: restrict to one client/contact by name.' },
        limit: { type: 'number', description: 'Maximum results (default 20, maximum 40).' },
      },
      required: ['query'],
    },
  },
  {
    name: 'find_attachments',
    description:
      'Find files (images, PDFs, documents) received or sent, by filename, contact, chat or nearby text. Returns each file\'s message_id and index so it can be opened with read_attachment.',
    schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Filename, contact, chat or related word. Empty = the most recent files.' },
        limit: { type: 'number', description: 'Maximum results (default 15, maximum 30).' },
      },
      required: [],
    },
  },
  {
    name: 'read_attachment',
    description:
      'Open and read the contents of a specific file (image or PDF) by message_id (from find_attachments) and analyse it: transcribe figures from a quotation or invoice, describe a product photo, and so on.',
    schema: {
      type: 'object',
      properties: {
        message_id: { type: 'number', description: 'The id of the message containing the file (from find_attachments).' },
        index: { type: 'number', description: 'Which attachment of the message, if there are several (default 0).' },
      },
      required: ['message_id'],
    },
  },
];

function readPrompt(): string {
  return (
    `Read this file carefully on behalf of the owner of a trading company. Say what it is and describe its contents. ` +
    `If it is a quotation, invoice, order or list, transcribe the key data (products, quantities, prices, dates, supplier/client). ` +
    `Be concise but do not omit figures. ${replyLanguageInstruction()}`
  );
}

/** Normalize a possibly-bare stored mime + file path into something vision accepts. */
function visionMime(mime: string, filePath: string): string {
  if (mime === 'application/pdf' || mime.startsWith('image/')) return mime;
  if (/\.pdf$/i.test(filePath)) return 'application/pdf';
  return 'image/jpeg'; // sips converts whatever it actually is
}

/** Build a context block from the DB: open tasks, named clients, recent messages, memory. */
export function buildContext(): string {
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

  // A small ambient window of "what's happening right now". Anything older is
  // reachable via the search_messages tool, so this stays lean instead of
  // stuffing hundreds of messages into every turn.
  const recent = (
    d
      .prepare(`SELECT sender, direction, body FROM messages ORDER BY ts DESC LIMIT 150`)
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
  // clampItem is load-bearing, not defensive garnish: one WhatsApp system
  // message in the real database carries a 39,748-character base64 JPEG in its
  // body, which alone is several times the size of this entire block.
  const msgsTxt = clampBlockKeepingEnd(
    recent
      .map((m) => {
        const who = m.direction === 'outgoing' ? 'Me' : names[m.sender ?? ''] || m.sender || '?';
        return `${who}: ${clampItem(m.body)}`;
      })
      .join('\n'),
  );
  const memTxt = memories.length ? memories.map((m) => `- ${m.content}`).join('\n') : '(none yet)';

  const nowLocal = new Date().toString();
  return `CURRENT DATE/TIME: ${nowLocal}\n\nLONG-TERM MEMORY (things you saved before):\n${memTxt}\n\nCURRENT OPEN TASKS:\n${tasksTxt}\n\nKNOWN CLIENTS:\n${clientsTxt}\n\nRECENT MESSAGES (only the most recent 150, oldest first — use search_messages to look further back):\n${msgsTxt}`;
}

/** Execute a tool the model called; returns a short result string. */
async function execTool(name: string, input: unknown, threadId: number): Promise<string> {
  if (name === 'search_messages') {
    const i = (input as { query?: string; client?: string; limit?: number }) ?? {};
    const q = (i.query ?? '').trim();
    if (!q) return 'Falta el texto a buscar.';
    const lim = Math.min(Math.max(Number(i.limit) || 20, 1), 40);
    const names = nameMap();
    // Same indexed substring filter as the Mensajes search (FTS when available).
    const f = bodyFilterSql(q);
    const params: unknown[] = [f.param];
    let where = f.sql;
    const client = (i.client ?? '').trim();
    if (client) {
      const handle = resolveClientHint(client);
      where += ` AND (sender = ? OR sender_name LIKE ? OR chat_name LIKE ?)`;
      params.push(handle, `%${client}%`, `%${client}%`);
    }
    const rows = db()
      .prepare(
        `SELECT ts, sender, sender_name, chat_name, direction, body FROM messages
         WHERE ${where} ORDER BY ts DESC LIMIT ?`,
      )
      .all(...params, lim) as {
      ts: number;
      sender: string | null;
      sender_name: string | null;
      chat_name: string | null;
      direction: string;
      body: string;
    }[];
    if (!rows.length) return 'No se encontraron mensajes que coincidan.';
    return rows
      .map((r) => {
        const who = r.direction === 'outgoing' ? 'Yo' : names[r.sender ?? ''] || r.sender_name || r.sender || '?';
        const when = new Date(r.ts).toLocaleString('es');
        return `[${when}] ${who}${r.chat_name ? ` (${r.chat_name})` : ''}: ${clampItem(r.body)}`;
      })
      .join('\n');
  }
  if (name === 'find_attachments') {
    const i = (input as { query?: string; limit?: number }) ?? {};
    const q = (i.query ?? '').trim();
    const lim = Math.min(Math.max(Number(i.limit) || 15, 1), 30);
    const names = nameMap();
    const like = `%${q}%`;
    const filter = q
      ? `AND (attachment_names LIKE ? OR chat_name LIKE ? OR sender_name LIKE ? OR body LIKE ?)`
      : '';
    const rows = db()
      .prepare(
        `SELECT id, ts, sender, sender_name, chat_name, direction, attachment_mimes, attachment_names, attachment_paths
         FROM messages WHERE has_attachment = 1 ${filter} ORDER BY ts DESC LIMIT ?`,
      )
      .all(...(q ? [like, like, like, like] : []), lim) as {
      id: number;
      ts: number;
      sender: string | null;
      sender_name: string | null;
      chat_name: string | null;
      direction: string;
      attachment_mimes: string;
      attachment_names: string;
      attachment_paths: string;
    }[];
    if (!rows.length) return 'No se encontraron archivos.';
    const lines: string[] = [];
    for (const r of rows) {
      const mimes = splitAtt(r.attachment_mimes);
      const fnames = splitAtt(r.attachment_names);
      const who = r.direction === 'outgoing' ? 'Yo' : names[r.sender ?? ''] || r.sender_name || r.sender || '?';
      const when = new Date(r.ts).toLocaleString('es');
      for (let idx = 0; idx < Math.max(mimes.length, 1); idx++) {
        const mime = mimes[idx] || '';
        lines.push(
          `message_id=${r.id} index=${idx} · ${fnames[idx] || '(sin nombre)'} [${mime || '?'}] · ${who}${
            r.chat_name ? ` en ${r.chat_name}` : ''
          } · ${when}`,
        );
      }
    }
    return lines.join('\n');
  }
  if (name === 'read_attachment') {
    const i = (input as { message_id?: number; index?: number }) ?? {};
    const id = Number(i.message_id);
    if (!Number.isFinite(id)) return 'Falta message_id.';
    const idx = Math.max(Number(i.index) || 0, 0);
    const row = db()
      .prepare(
        `SELECT source, wa_account, source_msg_id, attachment_mimes, attachment_paths
         FROM messages WHERE id = ?`,
      )
      .get(id) as
      | { source: string; wa_account: string | null; source_msg_id: string; attachment_mimes: string; attachment_paths: string }
      | undefined;
    if (!row) return 'No se encontró ese mensaje.';
    const mimes = splitAtt(row.attachment_mimes);
    const paths = splitAtt(row.attachment_paths);
    let mime = mimes[idx] || mimes[0] || '';
    let filePath = (paths[idx] || '').trim();
    if (!filePath && row.source === 'whatsapp') {
      const dl = await downloadWaMedia(row.wa_account || 'acc1', row.source_msg_id);
      if (dl) {
        filePath = dl.path;
        mime = dl.mime;
      }
    }
    if (!filePath) return 'El archivo no está disponible (si es de WhatsApp, la cuenta debe estar conectada).';
    return describeAttachment(filePath, visionMime(mime, filePath), {
      prompt: readPrompt(),
      maxTokens: 700,
    });
  }
  if (name === 'save_memory') {
    const fact = (input as { fact?: string })?.fact ?? '';
    saveMemory(fact, threadId);
    return 'Guardado en memoria.';
  }
  if (name === 'create_task') {
    const i = (input as { title?: string; detail?: string; client?: string }) ?? {};
    const title = (i.title ?? '').trim();
    if (!title) return 'Falta el título de la tarea.';
    // Same deterministic guard as the extraction pipeline: an open task with
    // the same normalized title FOR THE SAME CLIENT already exists → report it
    // instead of creating a twin (the model retrying a tool call, or the owner
    // asking twice, must not stack duplicates). A different client's identical
    // title is a different task; a missing hint on either side still matches
    // conservatively — mirroring saveTasks() rule 1 in extract/pipeline.ts.
    const hint = resolveClientHint(i.client ?? '');
    const twin = (
      db()
        .prepare(
          `SELECT title, status, client_hint AS clientHint FROM tasks
           WHERE status IN ('proposed','todo','waiting') AND archived_at IS NULL AND deleted_at IS NULL`,
        )
        .all() as { title: string; status: string; clientHint: string }[]
    ).find((t) => {
      if (normTitle(t.title) !== normTitle(title)) return false;
      const ha = hint.trim().toLowerCase();
      const hb = (t.clientHint || '').trim().toLowerCase();
      return !ha || !hb || ha === hb;
    });
    if (twin) return `Ya existe una tarea abierta con ese título: "${twin.title}" (${twin.status}). No se creó un duplicado.`;
    const now = Date.now();
    db()
      .prepare(
        `INSERT INTO tasks (title, detail, status, client_hint, source_quote, created_at, updated_at)
         VALUES (?, ?, 'todo', ?, '', ?, ?)`,
      )
      .run(title, (i.detail ?? '').trim(), hint, now, now);
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
  /**
   * Test seam. Production always passes nothing and gets the configured
   * provider; tests script a provider so the multi-round tool loop — the part
   * most likely to break on a non-Anthropic model — can be exercised without a
   * network or an API key.
   */
  providerOverride?: AiChatProvider,
): Promise<{ reply: string; usedTools: string[] }> {
  addMessage(threadId, 'user', userText, attachments);

  // Drop any empty-content message (the APIs reject empty text blocks, and one
  // bad stored row would otherwise make every future turn in the thread fail).
  const messages: AiMsg[] = threadMessages(threadId)
    .filter((m) => m.content.trim() !== '')
    .map((m) => ({
      role: m.role,
      content: m.content,
    }));
  const provider = providerOverride ?? aiProvider();
  const system = `${systemPrompt()}\n\n--- CONTEXT (from the database) ---\n${buildContext()}`;
  const usedTools: string[] = [];
  let reply = '';

  for (let i = 0; i < 5; i++) {
    const resp = await provider.chat({
      system,
      maxTokens: 1024,
      tools: TOOLS,
      messages,
    });
    if (resp.text) reply = resp.text;

    if (resp.stopReason === 'tool_use' && resp.toolCalls.length) {
      messages.push({ role: 'assistant', content: resp.text, toolCalls: resp.toolCalls });
      for (const call of resp.toolCalls) {
        usedTools.push(call.name);
        messages.push({
          role: 'tool',
          toolCallId: call.id,
          content: await execTool(call.name, call.input, threadId),
        });
      }
      continue;
    }
    break;
  }

  // Never persist an empty reply — it would poison the thread's history for
  // every later API call (empty text blocks are rejected).
  if (!reply.trim()) reply = 'Listo.';
  addMessage(threadId, 'assistant', reply);
  return { reply, usedTools };
}
