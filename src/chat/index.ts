import type Anthropic from '@anthropic-ai/sdk';
import { db } from '../db/index.js';
import { config } from '../config.js';
import { anthropicClient } from '../settings.js';
import { nameMap } from '../names.js';
import { addMessage, threadMessages, listMemories, saveMemory } from './store.js';
import { scheduleReminder } from '../notify/scheduled.js';
import { describeAttachment } from '../extract/vision.js';
import { downloadWaMedia } from '../ingest/whatsapp/client.js';

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

The RECENT MESSAGES below are only a small window (the last 150). The full history has many thousands of messages and every attachment (photos, PDFs) the owner has received or sent. Do NOT assume something didn't happen just because it isn't in that window — use search_messages / find_attachments to look. When the owner refers to a photo, quote, invoice or document, find it and read_attachment it before answering.

Tools you can use:
- save_memory: when the owner tells you something durable worth remembering across conversations (a lasting preference, a standing instruction, a key fact about a client or his business), save a concise one-sentence fact. Do NOT save ephemeral chatter or things already in the tasks/clients data.
- create_task: when the owner asks you to create/add a task ("crea una tarea…", "agrégame…"), create it directly. Use a short Spanish title, an optional detail, and the client if he names one. Confirm briefly in your reply.
- schedule_reminder: when the owner asks to be reminded at a later time ("recuérdame mañana…", "el lunes avísame…"), schedule it. Give due_iso as a local ISO 8601 datetime (e.g. 2026-06-27T09:00:00). If he gives no time of day, default to 09:00. Use CURRENT DATE/TIME below to compute it. Confirm the date/time in your reply.
- search_messages: search the FULL message history by keyword (and optionally by client) when the answer might be older than the recent window — "what did X ask for", "did anyone mention toallas", "when did we last talk to Y". Prefer this over saying "I don't see it".
- find_attachments: find files (images, PDFs, documents) the owner received or sent, by filename, contact, chat, or surrounding text. Returns each file's message_id + index so you can read it.
- read_attachment: actually open and read a specific file (image or PDF) by message_id (from find_attachments) and analyze its contents — quote figures from a cotización/invoice, describe a product photo, etc. Use it whenever the owner asks about the content of a file.

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
  {
    name: 'search_messages',
    description:
      'Busca en TODO el historial de mensajes (miles), no solo en los recientes. Úsalo cuando la respuesta pueda estar más atrás en el tiempo. Devuelve los mensajes que coinciden con fecha, remitente y texto.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Palabra(s) o frase a buscar en el texto de los mensajes.' },
        client: { type: 'string', description: 'Opcional: limita a un cliente/contacto por nombre.' },
        limit: { type: 'number', description: 'Máximo de resultados (por defecto 20, máximo 40).' },
      },
      required: ['query'],
    },
  },
  {
    name: 'find_attachments',
    description:
      'Busca archivos (imágenes, PDF, documentos) recibidos o enviados, por nombre de archivo, contacto, chat o texto cercano. Devuelve message_id e index de cada archivo para poder leerlo con read_attachment.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Nombre de archivo, contacto, chat o palabra relacionada. Vacío = los más recientes.' },
        limit: { type: 'number', description: 'Máximo de resultados (por defecto 15, máximo 30).' },
      },
      required: [],
    },
  },
  {
    name: 'read_attachment',
    description:
      'Abre y lee el contenido de un archivo concreto (imagen o PDF) por message_id (obtenido de find_attachments) y lo analiza: transcribe cifras de una cotización/factura, describe una foto de producto, etc.',
    input_schema: {
      type: 'object',
      properties: {
        message_id: { type: 'number', description: 'El id del mensaje que contiene el archivo (de find_attachments).' },
        index: { type: 'number', description: 'Cuál adjunto del mensaje, si hay varios (por defecto 0).' },
      },
      required: ['message_id'],
    },
  },
];

const READ_PROMPT = `Lee este archivo con detalle para el dueño de una empresa comercial. Di qué es y describe su contenido; si es una cotización, factura, orden o lista, transcribe los datos clave (productos, cantidades, precios, fechas, proveedor/cliente). Sé conciso pero no omitas cifras. Responde en español; conserva nombres de productos y marcas tal cual.`;

/** Normalize a possibly-bare stored mime + file path into something vision accepts. */
function visionMime(mime: string, filePath: string): string {
  if (mime === 'application/pdf' || mime.startsWith('image/')) return mime;
  if (/\.pdf$/i.test(filePath)) return 'application/pdf';
  return 'image/jpeg'; // sips converts whatever it actually is
}

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
  const msgsTxt = recent
    .map((m) => {
      const who = m.direction === 'outgoing' ? 'Me' : names[m.sender ?? ''] || m.sender || '?';
      return `${who}: ${m.body}`;
    })
    .join('\n');
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
    const params: unknown[] = [`%${q}%`];
    let where = `body LIKE ?`;
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
        return `[${when}] ${who}${r.chat_name ? ` (${r.chat_name})` : ''}: ${r.body}`;
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
      const mimes = (r.attachment_mimes || '').split('||');
      const fnames = (r.attachment_names || '').split('||');
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
    const mimes = (row.attachment_mimes || '').split('||');
    const paths = (row.attachment_paths || '').split('||');
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
    return describeAttachment(filePath, visionMime(mime, filePath), { prompt: READ_PROMPT, maxTokens: 700 });
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

  // Drop any empty-content message (the API rejects empty text blocks, and one
  // bad stored row would otherwise make every future turn in the thread fail).
  const messages: Anthropic.MessageParam[] = threadMessages(threadId)
    .filter((m) => m.content.trim() !== '')
    .map((m) => ({
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
            content: await execTool(block.name, block.input, threadId),
          });
        }
      }
      messages.push({ role: 'assistant', content: resp.content });
      messages.push({ role: 'user', content: results });
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
