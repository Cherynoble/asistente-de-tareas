/**
 * Provider-neutral AI types. Every AI call in the app (extraction, vision, the
 * chat agent, classification, translation) goes through this shape, so the
 * active provider — Anthropic or any OpenAI-compatible endpoint (Kimi/Moonshot,
 * DeepSeek, Qwen, GLM, Ollama…) — can be swapped in Ajustes without touching
 * feature code.
 */

export type AiPart =
  | { type: 'text'; text: string }
  | { type: 'image'; mediaType: string; dataBase64: string }
  /** Inline PDF. Anthropic reads it natively; OpenAI-compatible providers get
   *  its extracted text instead (see ai/pdf.ts). */
  | { type: 'pdf'; dataBase64: string };

export interface AiToolCall {
  id: string;
  name: string;
  input: unknown;
}

export type AiMsg =
  | { role: 'user'; content: string | AiPart[] }
  | { role: 'assistant'; content: string; toolCalls?: AiToolCall[] }
  /** Result of one tool call, answering the assistant's toolCalls by id. */
  | { role: 'tool'; toolCallId: string; content: string };

export interface AiTool {
  name: string;
  description: string;
  /** JSON schema of the tool input. */
  schema: Record<string, unknown>;
}

export interface AiRequest {
  system?: string;
  messages: AiMsg[];
  tools?: AiTool[];
  maxTokens: number;
  /** Ask for structured output matching this JSON schema. Providers without
   *  real schema enforcement get JSON mode + the schema in the prompt. */
  jsonSchema?: Record<string, unknown>;
}

export interface AiResponse {
  text: string;
  toolCalls: AiToolCall[];
  stopReason: 'end' | 'tool_use' | 'length' | 'other';
}

export interface AiChatProvider {
  /** e.g. "anthropic:claude-haiku-4-5" or "kimi:kimi-k3" — used in logs/UI. */
  readonly name: string;
  /** Whether the configured model accepts image input. */
  readonly supportsVision: boolean;
  /** Whether the provider reads PDFs natively (vs. local text extraction). */
  readonly supportsPdfNative: boolean;
  chat(req: AiRequest): Promise<AiResponse>;
}

/** True for HTTP statuses worth retrying (rate limit, overload, server error). */
export function retryableStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

export class AiHttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/**
 * Run an AI call with bounded retries on transient failures (429/5xx/network).
 * One definition so every provider and every feature gets the same behavior —
 * before this layer existed, a single 429 during the nightly cron silently
 * failed the whole batch.
 */
export async function withRetry<T>(fn: () => Promise<T>, attempts = 3): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const status =
        err instanceof AiHttpError
          ? err.status
          : typeof (err as { status?: unknown })?.status === 'number'
            ? ((err as { status: number }).status)
            : 0; // 0 = network/unknown → retry
      if (status && !retryableStatus(status)) throw err;
      if (i < attempts - 1) {
        const delay = 1000 * Math.pow(3, i); // 1s, 3s
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }
  throw lastErr;
}

/**
 * Pull a JSON object out of a model reply that may wrap it in prose or a
 * ```json fence. Providers with enforced schemas return clean JSON and the
 * fast path applies; JSON-mode providers occasionally decorate.
 */
export function extractJson<T>(text: string): T | null {
  const t = text.trim();
  try {
    return JSON.parse(t) as T;
  } catch {
    /* fall through */
  }
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(t);
  if (fenced?.[1]) {
    try {
      return JSON.parse(fenced[1].trim()) as T;
    } catch {
      /* fall through */
    }
  }
  const first = t.search(/[[{]/);
  if (first >= 0) {
    const open = t[first]!;
    const close = open === '{' ? '}' : ']';
    const last = t.lastIndexOf(close);
    if (last > first) {
      try {
        return JSON.parse(t.slice(first, last + 1)) as T;
      } catch {
        /* give up */
      }
    }
  }
  return null;
}
