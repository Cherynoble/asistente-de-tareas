/**
 * Anthropic adapter over the official SDK — the default provider, and the only
 * one with native PDF reading. Behavior matches the pre-provider-layer code
 * (JSON-schema structured output via output_config, tool use, vision).
 */
import Anthropic from '@anthropic-ai/sdk';
import {
  withRetry,
  type AiChatProvider,
  type AiPart,
  type AiRequest,
  type AiResponse,
  type AiToolCall,
} from './types.js';

function toBlocks(parts: AiPart[]): Anthropic.ContentBlockParam[] {
  return parts.map((p): Anthropic.ContentBlockParam => {
    if (p.type === 'text') return { type: 'text', text: p.text };
    if (p.type === 'image') {
      return {
        type: 'image',
        source: {
          type: 'base64',
          media_type: p.mediaType as 'image/jpeg',
          data: p.dataBase64,
        },
      };
    }
    return {
      type: 'document',
      source: { type: 'base64', media_type: 'application/pdf', data: p.dataBase64 },
    };
  });
}

function toAnthropicMessages(req: AiRequest): Anthropic.MessageParam[] {
  const out: Anthropic.MessageParam[] = [];
  for (const m of req.messages) {
    if (m.role === 'user') {
      out.push({
        role: 'user',
        content: typeof m.content === 'string' ? m.content : toBlocks(m.content),
      });
    } else if (m.role === 'assistant') {
      if (!m.toolCalls?.length) {
        out.push({ role: 'assistant', content: m.content });
        continue;
      }
      const blocks: Anthropic.ContentBlockParam[] = [];
      if (m.content) blocks.push({ type: 'text', text: m.content });
      for (const t of m.toolCalls) {
        blocks.push({ type: 'tool_use', id: t.id, name: t.name, input: t.input ?? {} });
      }
      out.push({ role: 'assistant', content: blocks });
    } else {
      // tool result → a user message with a tool_result block. Consecutive tool
      // messages merge into one user turn (all results of a parallel call must
      // arrive in a single message).
      const block: Anthropic.ToolResultBlockParam = {
        type: 'tool_result',
        tool_use_id: m.toolCallId,
        content: m.content,
      };
      const prev = out[out.length - 1];
      if (prev && prev.role === 'user' && Array.isArray(prev.content) && prev.content.some((b) => b.type === 'tool_result')) {
        (prev.content as Anthropic.ContentBlockParam[]).push(block);
      } else {
        out.push({ role: 'user', content: [block] });
      }
    }
  }
  return out;
}

export class AnthropicProvider implements AiChatProvider {
  readonly name: string;
  readonly supportsVision = true;
  readonly supportsPdfNative = true;

  constructor(
    private readonly apiKey: string,
    private readonly model: string,
  ) {
    this.name = `anthropic:${model}`;
  }

  async chat(req: AiRequest): Promise<AiResponse> {
    const client = new Anthropic({ apiKey: this.apiKey });
    const params: Anthropic.MessageCreateParamsNonStreaming = {
      model: this.model,
      max_tokens: req.maxTokens,
      messages: toAnthropicMessages(req),
    };
    if (req.system) params.system = req.system;
    if (req.tools?.length) {
      params.tools = req.tools.map(
        (t): Anthropic.Tool => ({
          name: t.name,
          description: t.description,
          input_schema: t.schema as Anthropic.Tool.InputSchema,
        }),
      );
    }
    if (req.jsonSchema) {
      (params as unknown as Record<string, unknown>).output_config = {
        format: { type: 'json_schema', schema: req.jsonSchema },
      };
    }

    const resp = await withRetry(() => client.messages.create(params));

    const text = resp.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('');
    const toolCalls: AiToolCall[] = resp.content
      .filter((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use')
      .map((b) => ({ id: b.id, name: b.name, input: b.input }));

    return {
      text,
      toolCalls,
      stopReason:
        resp.stop_reason === 'tool_use'
          ? 'tool_use'
          : resp.stop_reason === 'max_tokens'
            ? 'length'
            : resp.stop_reason === 'end_turn'
              ? 'end'
              : 'other',
    };
  }
}
