import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { extractJson, withRetry, AiHttpError } from '../src/ai/types.js';
import { OpenAiCompatProvider } from '../src/ai/openai.js';

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
