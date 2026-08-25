import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { extractJson, withRetry, AiHttpError } from '../src/ai/types.js';
import { clampItem, clampBlockKeepingEnd, MAX_ITEM_CHARS } from '../src/ai/budget.js';

// Short timeout so the "provider never answers" test finishes fast. Must be set
// BEFORE the adapter module evaluates, hence the dynamic import.
process.env.AI_TIMEOUT_MS = '400';
const { OpenAiCompatProvider } = await import('../src/ai/openai.js');

// ---- extractJson: tolerate the ways JSON-mode providers decorate output ----

test('extractJson parses clean JSON', () => {
  assert.deepEqual(extractJson('{"a":1}'), { a: 1 });
  assert.deepEqual(extractJson('[1,2]'), [1, 2]);
});

test('extractJson unwraps markdown fences and surrounding prose', () => {
  assert.deepEqual(extractJson('Here you go:\n```json\n{"a":1}\n```\nEnjoy!'), { a: 1 });
  assert.deepEqual(extractJson('The answer is {"tasks":[]} as requested.'), { tasks: [] });
});

test('extractJson returns null on garbage', () => {
  assert.equal(extractJson('no json here'), null);
  assert.equal(extractJson(''), null);
});

// ---- withRetry: transient failures retry, permanent ones do not ----

test('withRetry retries 5xx then succeeds', async () => {
  let calls = 0;
  const result = await withRetry(async () => {
    calls++;
    if (calls < 3) throw new AiHttpError(529, 'overloaded');
    return 'ok';
  });
  assert.equal(result, 'ok');
  assert.equal(calls, 3);
});

test('withRetry does NOT retry a 400', async () => {
  let calls = 0;
  await assert.rejects(
    withRetry(async () => {
      calls++;
      throw new AiHttpError(400, 'bad request');
    }),
    /bad request/,
  );
  assert.equal(calls, 1);
});

// ---- OpenAI-compatible adapter: wire format against a local mock ----

interface Captured {
  auth: string | undefined;
  body: {
    model: string;
    messages: { role: string; content: unknown; tool_calls?: unknown[]; tool_call_id?: string }[];
    tools?: unknown[];
    response_format?: { type: string };
  };
}

function mockServer(
  reply: object,
): Promise<{ url: string; captured: Captured[]; close: () => void }> {
  const captured: Captured[] = [];
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () => {
        captured.push({ auth: req.headers.authorization, body: JSON.parse(raw) });
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify(reply));
      });
    });
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address() as AddressInfo;
      resolve({ url: `http://127.0.0.1:${port}/v1`, captured, close: () => srv.close() });
    });
  });
}

const provider = (baseUrl: string, vision = false) =>
  new OpenAiCompatProvider({ providerId: 'test', baseUrl, model: 'test-model', apiKey: 'k123', vision });

test('adapter sends bearer auth, model, and maps a plain reply', async () => {
  const m = await mockServer({ choices: [{ finish_reason: 'stop', message: { content: 'hola' } }] });
  try {
    const resp = await provider(m.url).chat({ maxTokens: 50, messages: [{ role: 'user', content: 'hi' }] });
    assert.equal(resp.text, 'hola');
    assert.equal(resp.stopReason, 'end');
    assert.deepEqual(resp.toolCalls, []);
    assert.equal(m.captured[0]!.auth, 'Bearer k123');
    assert.equal(m.captured[0]!.body.model, 'test-model');
  } finally {
    m.close();
  }
});

test('adapter maps tools, tool_calls, and the tool-result round trip', async () => {
  const m = await mockServer({
    choices: [
      {
        finish_reason: 'tool_calls',
        message: {
          content: '',
          tool_calls: [{ id: 'c1', function: { name: 'create_task', arguments: '{"title":"x"}' } }],
        },
      },
    ],
  });
  try {
    const resp = await provider(m.url).chat({
      maxTokens: 50,
      tools: [{ name: 'create_task', description: 'd', schema: { type: 'object' } }],
      messages: [
        { role: 'user', content: 'crea una tarea' },
        { role: 'assistant', content: '', toolCalls: [{ id: 'c0', name: 'save_memory', input: { fact: 'f' } }] },
        { role: 'tool', toolCallId: 'c0', content: 'Guardado.' },
      ],
    });
    assert.equal(resp.stopReason, 'tool_use');
    assert.deepEqual(resp.toolCalls, [{ id: 'c1', name: 'create_task', input: { title: 'x' } }]);
    const sent = m.captured[0]!.body;
    assert.equal(sent.tools?.length, 1);
    const assistant = sent.messages.find((x) => x.role === 'assistant')!;
    assert.equal((assistant.tool_calls as { id: string }[])[0]!.id, 'c0');
    const toolMsg = sent.messages.find((x) => x.role === 'tool')!;
    assert.equal(toolMsg.tool_call_id, 'c0');
    assert.equal(toolMsg.content, 'Guardado.');
  } finally {
    m.close();
  }
});

test('adapter requests JSON mode and injects the schema into the system prompt', async () => {
  const m = await mockServer({ choices: [{ finish_reason: 'stop', message: { content: '{"ok":true}' } }] });
  try {
    await provider(m.url).chat({
      maxTokens: 50,
      jsonSchema: { type: 'object', properties: { ok: { type: 'boolean' } } },
      messages: [{ role: 'user', content: 'go' }],
    });
    const sent = m.captured[0]!.body;
    assert.equal(sent.response_format?.type, 'json_object');
    const sys = sent.messages[0]!;
    assert.equal(sys.role, 'system');
    assert.match(String(sys.content), /"type":"object"/);
  } finally {
    m.close();
  }
});

test('adapter degrades an image part to a note when the model lacks vision', async () => {
  const m = await mockServer({ choices: [{ finish_reason: 'stop', message: { content: 'ok' } }] });
  try {
    await provider(m.url, false).chat({
      maxTokens: 50,
      messages: [
        { role: 'user', content: [{ type: 'image', mediaType: 'image/jpeg', dataBase64: 'aGk=' }, { type: 'text', text: 'mira' }] },
      ],
    });
    const parts = m.captured[0]!.body.messages[0]!.content as { type: string; text?: string }[];
    assert.equal(parts[0]!.type, 'text'); // image replaced by a note, not sent blind
    assert.match(parts[0]!.text!, /no acepta imágenes/);
  } finally {
    m.close();
  }
});

test('adapter sends images as data URIs when the model has vision', async () => {
  const m = await mockServer({ choices: [{ finish_reason: 'stop', message: { content: 'ok' } }] });
  try {
    await provider(m.url, true).chat({
      maxTokens: 50,
      messages: [{ role: 'user', content: [{ type: 'image', mediaType: 'image/png', dataBase64: 'aGk=' }] }],
    });
    const parts = m.captured[0]!.body.messages[0]!.content as { type: string; image_url?: { url: string } }[];
    assert.equal(parts[0]!.type, 'image_url');
    assert.equal(parts[0]!.image_url!.url, 'data:image/png;base64,aGk=');
  } finally {
    m.close();
  }
});

// ---- JSON mode: the keyword requirement is deliberate, not incidental ----

test('adapter includes the literal word "json" in the system prompt', async () => {
  const m = await mockServer({ choices: [{ finish_reason: 'stop', message: { content: '{}' } }] });
  try {
    await provider(m.url).chat({
      maxTokens: 50,
      jsonSchema: { type: 'object' },
      messages: [{ role: 'user', content: 'go' }],
    });
    const sys = String(m.captured[0]!.body.messages[0]!.content);
    // DeepSeek (and OpenAI) reject response_format:json_object unless the word
    // appears in the prompt. Losing it would 400 every extraction run.
    assert.match(sys, /\bjson\b/i);
  } finally {
    m.close();
  }
});

// ---- assistant tool-call messages must not use null content ----

test('adapter sends "" not null for an assistant message carrying tool_calls', async () => {
  const m = await mockServer({ choices: [{ finish_reason: 'stop', message: { content: 'ok' } }] });
  try {
    await provider(m.url).chat({
      maxTokens: 50,
      messages: [
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: '', toolCalls: [{ id: 'a1', name: 't', input: {} }] },
        { role: 'tool', toolCallId: 'a1', content: 'done' },
      ],
    });
    const asst = m.captured[0]!.body.messages.find((x) => x.role === 'assistant')!;
    assert.notEqual(asst.content, null, 'several OpenAI-compatible backends 400 on null content');
    assert.equal(asst.content, '');
  } finally {
    m.close();
  }
});

// ---- timeouts: a provider that accepts and never answers ----

test('adapter gives up on a provider that never responds', async () => {
  const sockets: import('node:net').Socket[] = [];
  const srv = http.createServer(() => {
    /* accept, never reply — the wedged-connection failure mode */
  });
  srv.on('connection', (s) => sockets.push(s));
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  const { port } = srv.address() as AddressInfo;
  try {
    const started = Date.now();
    await assert.rejects(
      provider(`http://127.0.0.1:${port}/v1`).chat({ maxTokens: 10, messages: [{ role: 'user', content: 'hi' }] }),
      /tiempo de espera agotado/,
    );
    // 400ms timeout × 3 withRetry attempts + 1s and 3s backoff ≈ 5.2s ceiling.
    const elapsed = Date.now() - started;
    assert.ok(elapsed < 12_000, `should not hang; took ${elapsed}ms`);
  } finally {
    for (const s of sockets) s.destroy();
    srv.close();
  }
});

// ---- context budgeting ----

test('clampItem truncates an oversized body and says that it did', () => {
  const blob = 'A'.repeat(40_000); // the real DB has a 39,748-char base64 body
  const out = clampItem(blob);
  assert.ok(out.length < 2_100, `expected a bounded result, got ${out.length}`);
  assert.match(out, /recortado: 40000 caracteres/);
});

test('clampItem leaves normal messages completely untouched', () => {
  for (const s of ['', 'hola', 'Necesito cotización de toallas', '需要报价', 'x'.repeat(MAX_ITEM_CHARS)]) {
    assert.equal(clampItem(s), s);
  }
});

test('clampBlockKeepingEnd keeps the most recent lines, not the oldest', () => {
  const lines = Array.from({ length: 5_000 }, (_, i) => `line ${i}`);
  const out = clampBlockKeepingEnd(lines.join('\n'), 1_000);
  assert.ok(out.includes('line 4999'), 'the newest line must survive');
  assert.ok(!out.includes('line 0\n'), 'the oldest lines are the ones dropped');
  assert.match(out, /se omitieron \d+ caracteres más antiguos/);
  assert.ok(out.length < 1_200);
});

test('clampBlockKeepingEnd leaves a block under budget alone', () => {
  const small = 'a\nb\nc';
  assert.equal(clampBlockKeepingEnd(small, 1_000), small);
});

// ---- model roles: chat / bulk / vision resolve independently ----
// The bug this guards: on Qwen the strongest text models (qwen-max, qwen-plus)
// cannot see images at all, so if vision inherited the chat or bulk model every
// product photo would silently fail — and product-photo-to-task is a core
// feature of the app.

test('the vision role resolves to a vision-capable model, not the chat one', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dadsapp-role-'));
  process.env.DATA_DIR = dir;
  const { aiConfig, saveAiSettings } = await import('../src/ai/index.js');

  saveAiSettings({ provider: 'qwen', apiKey: 'k' });
  const chat = aiConfig('chat');
  const bulk = aiConfig('bulk');
  const vision = aiConfig('vision');

  assert.equal(chat.model, 'qwen-max');
  assert.equal(bulk.model, 'qwen-plus', 'bulk must use the cheap tier');
  assert.equal(vision.model, 'qwen-vl-max', 'vision must NOT inherit a text-only model');
  assert.notEqual(vision.model, chat.model);
  assert.notEqual(vision.model, bulk.model);
});

test('an explicit per-role model override wins over the preset', async () => {
  const { aiConfig, saveAiSettings } = await import('../src/ai/index.js');
  saveAiSettings({ provider: 'qwen', visionModel: 'qwen-vl-plus', bulkModel: 'qwen-turbo' });
  assert.equal(aiConfig('vision').model, 'qwen-vl-plus');
  assert.equal(aiConfig('bulk').model, 'qwen-turbo');
  assert.equal(aiConfig('chat').model, 'qwen-max', 'the chat model is unaffected');
});

test('a provider with no per-role defaults uses one model for all three', async () => {
  const { aiConfig, saveAiSettings } = await import('../src/ai/index.js');
  saveAiSettings({ provider: 'deepseek', apiKey: 'k' });
  const m = aiConfig('chat').model;
  assert.equal(aiConfig('bulk').model, m);
  assert.equal(aiConfig('vision').model, m, 'no vision model configured → falls back, and vision:false gates it');
  assert.equal(aiConfig('vision').vision, false, 'DeepSeek has no vision — images must degrade, not be sent blind');
});
