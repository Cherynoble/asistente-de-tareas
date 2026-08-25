/**
 * Generic OpenAI-compatible Chat Completions adapter, used for every
 * non-Anthropic provider (Kimi/Moonshot, DeepSeek, Qwen, GLM, Ollama, custom).
 *
 * Deliberately fetch-based with no SDK dependency: the packaged app's
 * node_modules are frozen in the shell (online updates ship only dist/+public/),
 * so a plain-fetch adapter can ship as a normal online update.
 */
import { extractPdfText } from './pdf.js';
import {
  AiHttpError,
  withRetry,
  type AiChatProvider,
  type AiMsg,
  type AiPart,
  type AiRequest,
  type AiResponse,
  type AiToolCall,
} from './types.js';

/**
 * No AI call may hang forever. fetch() has no default timeout, so a wedged
 * provider connection — routine on a throttled link — would otherwise stall the
 * nightly cron indefinitely and silently stop producing tasks. A timeout throws
 * without an HTTP status, which withRetry() treats as transient and retries.
 */
const DEFAULT_TIMEOUT_MS = Number(process.env.AI_TIMEOUT_MS ?? 120_000);

interface OaiContentPart {
  type: 'text' | 'image_url';
  text?: string;
  image_url?: { url: string };
}

interface OaiMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | OaiContentPart[] | null;
  tool_calls?: { id: string; type: 'function'; function: { name: string; arguments: string } }[];
  tool_call_id?: string;
}

interface OaiChoice {
  finish_reason?: string;
  message?: {
    content?: string | null;
    tool_calls?: { id?: string; function?: { name?: string; arguments?: string } }[];
  };
}

async function toOaiParts(parts: AiPart[], vision: boolean): Promise<OaiContentPart[]> {
  const out: OaiContentPart[] = [];
  for (const p of parts) {
    if (p.type === 'text') {
      out.push({ type: 'text', text: p.text });
    } else if (p.type === 'image') {
      if (vision) {
        out.push({ type: 'image_url', image_url: { url: `data:${p.mediaType};base64,${p.dataBase64}` } });
      } else {
        out.push({ type: 'text', text: '[imagen adjunta — el modelo configurado no acepta imágenes]' });
      }
    } else {
      // PDF: no OpenAI-compatible provider takes inline PDFs — extract the text
      // locally and inline it, which covers the real case (text-based quotes/
      // invoices). Scanned PDFs come back with an explanatory note instead.
      const r = await extractPdfText(Buffer.from(p.dataBase64, 'base64'));
      out.push({
        type: 'text',
        text: r.ok
          ? `[Contenido extraído de un PDF de ${r.pages} página(s):]\n${r.text}`
          : `[PDF adjunto: ${r.note}]`,
      });
    }
  }
  return out;
}

async function toOaiMessages(req: AiRequest, vision: boolean): Promise<OaiMessage[]> {
  const out: OaiMessage[] = [];
  let system = req.system ?? '';
  if (req.jsonSchema) {
    // The literal word "json" MUST appear in the prompt: DeepSeek (and OpenAI
    // itself) reject response_format:json_object otherwise. It happens to be
    // present in this sentence — keep it that way deliberately, and see the
    // matching assertion in tests/ai-layer.test.ts.
    system +=
      `\n\nRespond ONLY with a single json object (no prose, no markdown fence) matching exactly this JSON schema:\n` +
      JSON.stringify(req.jsonSchema);
  }
  if (system) out.push({ role: 'system', content: system });

  for (const m of req.messages) {
    if (m.role === 'user') {
      out.push({
        role: 'user',
        content: typeof m.content === 'string' ? m.content : await toOaiParts(m.content, vision),
      });
    } else if (m.role === 'assistant') {
      // Empty string, not null: the OpenAI spec allows null content alongside
      // tool_calls, but several OpenAI-*compatible* backends (Moonshot and some
      // vLLM/Ollama builds among them) reject a null and 400 the whole request.
      // '' is accepted everywhere, so it is the portable choice.
      const msg: OaiMessage = { role: 'assistant', content: m.content || '' };
      if (m.toolCalls?.length) {
        msg.tool_calls = m.toolCalls.map((t) => ({
          id: t.id,
          type: 'function',
          function: { name: t.name, arguments: JSON.stringify(t.input ?? {}) },
        }));
      }
      out.push(msg);
    } else {
      out.push({ role: 'tool', tool_call_id: m.toolCallId, content: m.content });
    }
  }
  return out;
}

export interface OpenAiCompatOptions {
  providerId: string;
  baseUrl: string;
  model: string;
  apiKey: string;
  vision: boolean;
}

export class OpenAiCompatProvider implements AiChatProvider {
  readonly name: string;
  readonly supportsVision: boolean;
  readonly supportsPdfNative = false;

  constructor(private readonly opts: OpenAiCompatOptions) {
    this.name = `${opts.providerId}:${opts.model}`;
    this.supportsVision = opts.vision;
  }

  async chat(req: AiRequest): Promise<AiResponse> {
    const messages = await toOaiMessages(req, this.opts.vision);
    const body: Record<string, unknown> = {
      model: this.opts.model,
      max_tokens: req.maxTokens,
      messages,
    };
    if (req.tools?.length) {
      body.tools = req.tools.map((t) => ({
        type: 'function',
        function: { name: t.name, description: t.description, parameters: t.schema },
      }));
    }
    // JSON mode where supported; the schema itself rides in the system prompt
    // (json_schema-style enforcement isn't uniform across these providers), and
    // extractJson() on the caller side tolerates decorated output anyway.
    if (req.jsonSchema) body.response_format = { type: 'json_object' };

    const url = `${this.opts.baseUrl.replace(/\/+$/, '')}/chat/completions`;
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.opts.apiKey) headers.Authorization = `Bearer ${this.opts.apiKey}`;

    const data = await withRetry(async () => {
      let res: Response;
      try {
        res = await fetch(url, {
          method: 'POST',
          headers,
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
        });
      } catch (err) {
        if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
          throw new Error(
            `${this.name} → sin respuesta tras ${Math.round(DEFAULT_TIMEOUT_MS / 1000)}s (tiempo de espera agotado).`,
          );
        }
        throw err;
      }
      if (!res.ok) {
        const errText = (await res.text().catch(() => '')).slice(0, 300);
        throw new AiHttpError(res.status, `${this.name} → HTTP ${res.status}: ${errText}`);
      }
      return (await res.json()) as { choices?: OaiChoice[] };
    });

    const choice = data.choices?.[0];
    const toolCalls: AiToolCall[] = (choice?.message?.tool_calls ?? []).map((t, i) => {
      let input: unknown = {};
      try {
        input = t.function?.arguments ? JSON.parse(t.function.arguments) : {};
      } catch {
        input = {};
      }
      return { id: t.id || `call_${i}`, name: t.function?.name ?? '', input };
    });

    const finish = choice?.finish_reason ?? '';
    return {
      text: (choice?.message?.content ?? '') || '',
      toolCalls,
      stopReason:
        toolCalls.length || finish === 'tool_calls'
          ? 'tool_use'
          : finish === 'length'
            ? 'length'
            : finish === 'stop'
              ? 'end'
              : 'other',
    };
  }
}
