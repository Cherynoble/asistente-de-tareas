/**
 * The multi-turn tool loop — the highest-risk part of moving off Anthropic.
 *
 * Two layers are covered:
 *  1. runTurn()'s loop, with a scripted provider: does it carry tool results
 *     back correctly across three rounds without losing the thread, and do the
 *     tools' side effects actually land in the database?
 *  2. The real OpenAiCompatProvider against a mock HTTP server, asserting the
 *     OpenAI wire format at EVERY round — Anthropic and the OpenAI dialect
 *     disagree about how consecutive tool results are batched, and a bug there
 *     only shows up from round two onward.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'dadsapp-chat-test-'));

const { db } = await import('../src/db/index.js');
const { runTurn } = await import('../src/chat/index.js');
const { createThread, threadMessages, listMemories } = await import('../src/chat/store.js');
const { OpenAiCompatProvider } = await import('../src/ai/openai.js');
const { setLocale, getLocale } = await import('../src/i18n.js');
const { ModelExtractor } = await import('../src/extract/extractor.js');
const { saveAiSettings } = await import('../src/ai/index.js');
type AiReq = import('../src/ai/types.js').AiRequest;
type AiResp = import('../src/ai/types.js').AiResponse;

// ---- 1. runTurn's loop with a scripted provider ----

/** A provider that replays a fixed script and records what it was sent. */
function scriptedProvider(script: AiResp[]) {
  const seen: AiReq[] = [];
  let i = 0;
  return {
    seen,
    provider: {
      name: 'scripted:test',
      supportsVision: true,
      supportsPdfNative: false,
      async chat(req: AiReq): Promise<AiResp> {
        seen.push(structuredClone(req));
        const r = script[i++];
        if (!r) throw new Error(`script exhausted after ${i - 1} rounds`);
        return r;
      },
    },
  };
}

const say = (text: string): AiResp => ({ text, toolCalls: [], stopReason: 'end' });
const call = (id: string, name: string, input: unknown): AiResp => ({
  text: '',
  toolCalls: [{ id, name, input }],
  stopReason: 'tool_use',
});

test('runTurn carries tool results across three rounds and applies their effects', async () => {
  const threadId = createThread('t1');
  const { provider, seen } = scriptedProvider([
    call('c1', 'save_memory', { fact: 'El cliente Wong compra toallas de papel.' }),
    call('c2', 'create_task', { title: 'Cotizar toallas de papel', client: 'Wong' }),
    say('Listo: guardé el dato y creé la tarea.'),
  ]);

  const { reply, usedTools } = await runTurn(threadId, '¿me ayudas?', [], provider);

  assert.equal(seen.length, 3, 'should have run exactly three rounds');
  assert.deepEqual(usedTools, ['save_memory', 'create_task']);
  assert.match(reply, /guardé el dato/);

  // Round 2 must show round 1's assistant turn AND its tool result, in order.
  const r2 = seen[1]!.messages;
  const asst = r2.find((m) => m.role === 'assistant' && 'toolCalls' in m && m.toolCalls?.length);
  assert.ok(asst, 'round 2 must replay the assistant turn that made the tool call');
  const toolMsg = r2.find((m) => m.role === 'tool');
  assert.ok(toolMsg, 'round 2 must carry the tool result');
  assert.equal((toolMsg as { toolCallId: string }).toolCallId, 'c1', 'tool result must answer by id');

  // Round 3 must still contain round 1's result — the thread is cumulative.
  const r3 = seen[2]!.messages;
  const ids = r3.filter((m) => m.role === 'tool').map((m) => (m as { toolCallId: string }).toolCallId);
  assert.deepEqual(ids, ['c1', 'c2'], 'both tool results must survive to the final round');

  // The tools' effects really happened.
  assert.equal(listMemories().length, 1);
  const tasks = db().prepare(`SELECT title FROM tasks`).all() as { title: string }[];
  assert.deepEqual(tasks.map((t) => t.title), ['Cotizar toallas de papel']);

  // The reply is persisted, and no empty rows poison the thread.
  const stored = threadMessages(threadId);
  assert.equal(stored.at(-1)!.role, 'assistant');
  assert.ok(stored.every((m) => m.content.trim() !== ''), 'no empty message may be stored');
});

test('runTurn answers EVERY tool call in a parallel round', async () => {
  const threadId = createThread('t2');
  const { provider, seen } = scriptedProvider([
    {
      text: '',
      toolCalls: [
        { id: 'p1', name: 'save_memory', input: { fact: 'Dato A' } },
        { id: 'p2', name: 'save_memory', input: { fact: 'Dato B' } },
      ],
      stopReason: 'tool_use',
    },
    say('Guardé ambos.'),
  ]);
  await runTurn(threadId, 'guarda dos cosas', [], provider);
  const ids = seen[1]!.messages.filter((m) => m.role === 'tool').map((m) => (m as { toolCallId: string }).toolCallId);
  assert.deepEqual(ids, ['p1', 'p2'], 'an unanswered tool_call id makes providers 400 the next request');
});

test('runTurn stops at the loop cap instead of calling tools forever', async () => {
  const threadId = createThread('t3');
  const script: AiResp[] = Array.from({ length: 12 }, (_, i) => call(`loop${i}`, 'save_memory', { fact: `f${i}` }));
  const { provider, seen } = scriptedProvider(script);
  await runTurn(threadId, 'bucle', [], provider);
  assert.equal(seen.length, 5, 'the loop is bounded at 5 rounds');
});

test('runTurn never persists an empty assistant reply', async () => {
  const threadId = createThread('t4');
  const { provider } = scriptedProvider([say('')]);
  const { reply } = await runTurn(threadId, 'hola', [], provider);
  assert.ok(reply.trim().length > 0, 'an empty reply would break every later turn in the thread');
  assert.ok(threadMessages(threadId).every((m) => m.content.trim() !== ''));
});

// ---- 2. The OpenAI dialect across three real rounds ----

interface Captured {
  messages: {
    role: string;
    content: unknown;
    tool_calls?: { id: string; type: string; function: { name: string; arguments: string } }[];
    tool_call_id?: string;
  }[];
  tools?: unknown[];
}

/** Mock provider that replies from a queue and records each request body. */
function mockOai(replies: object[]): Promise<{ url: string; captured: Captured[]; close: () => void }> {
  const captured: Captured[] = [];
  let i = 0;
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () => {
        captured.push(JSON.parse(raw));
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify(replies[i++] ?? replies.at(-1)));
      });
    });
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address() as AddressInfo;
      resolve({ url: `http://127.0.0.1:${port}/v1`, captured, close: () => srv.close() });
    });
  });
}

const oaiToolCall = (id: string, name: string, args: object) => ({
  choices: [
    {
      finish_reason: 'tool_calls',
      message: { content: '', tool_calls: [{ id, function: { name, arguments: JSON.stringify(args) } }] },
    },
  ],
});

test('OpenAI dialect stays valid across three tool rounds via runTurn', async () => {
  const m = await mockOai([
    oaiToolCall('c1', 'search_messages', { query: 'toallas' }),
    oaiToolCall('c2', 'create_task', { title: 'Cotizar toallas' }),
    { choices: [{ finish_reason: 'stop', message: { content: 'Hecho.' } }] },
  ]);
  try {
    const provider = new OpenAiCompatProvider({
      providerId: 'mock',
      baseUrl: m.url,
      model: 'mock-model',
      apiKey: 'k',
      vision: false,
    });
    const threadId = createThread('oai');
    const { reply } = await runTurn(threadId, '¿alguien pidió toallas?', [], provider);
    assert.equal(reply, 'Hecho.');
    assert.equal(m.captured.length, 3, 'three HTTP round trips');

    for (const [round, body] of m.captured.entries()) {
      // Every assistant tool-call message must carry non-null content: the spec
      // permits null, but several OpenAI-compatible backends 400 on it.
      for (const msg of body.messages) {
        if (msg.role === 'assistant' && msg.tool_calls) {
          assert.notEqual(msg.content, null, `round ${round}: null assistant content is not portable`);
          for (const tc of msg.tool_calls) {
            assert.equal(tc.type, 'function');
            assert.doesNotThrow(() => JSON.parse(tc.function.arguments), 'arguments must be a JSON string');
          }
        }
      }
      // Every tool message must answer a tool_call announced earlier in THIS
      // request, and every announced call must be answered — the two ways a
      // provider rejects a multi-round conversation.
      const announced = new Set(
        body.messages.flatMap((x) => (x.tool_calls ?? []).map((t) => t.id)),
      );
      const answered = body.messages.filter((x) => x.role === 'tool').map((x) => x.tool_call_id!);
      for (const a of answered) {
        assert.ok(announced.has(a), `round ${round}: tool result ${a} answers no announced call`);
      }
      assert.equal(
        answered.length,
        announced.size,
        `round ${round}: every announced tool_call must have exactly one result`,
      );
      // Tool results must follow their assistant message, never precede it.
      for (const id of answered) {
        const asstAt = body.messages.findIndex((x) => (x.tool_calls ?? []).some((t) => t.id === id));
        const toolAt = body.messages.findIndex((x) => x.role === 'tool' && x.tool_call_id === id);
        assert.ok(asstAt < toolAt, `round ${round}: result for ${id} must come after its call`);
      }
    }

    // Tools are declared on every round, not just the first.
    assert.ok(m.captured.every((b) => Array.isArray(b.tools) && b.tools.length > 0));
  } finally {
    m.close();
  }
});

// ---- 3. The chosen UI language actually reaches the model ----

test('the system prompt instructs the model in the owner\'s selected language', async () => {
  const expected: Record<string, RegExp> = {
    es: /Spanish \(neutral Latin-American Spanish\)/,
    en: /\bEnglish\b/,
    zh: /Simplified Chinese/,
  };
  for (const [locale, re] of Object.entries(expected)) {
    setLocale(locale as 'es' | 'en' | 'zh');
    assert.equal(getLocale(), locale);
    const threadId = createThread(`lang-${locale}`);
    const { provider, seen } = scriptedProvider([say('ok')]);
    await runTurn(threadId, 'hola', [], provider);
    const system = seen[0]!.system!;
    assert.match(system, re, `locale ${locale}: prompt must name the output language`);
    // And it must not still be hardcoding Spanish for the other two.
    if (locale !== 'es') {
      assert.doesNotMatch(system, /ALWAYS reply in Spanish/i, `locale ${locale}: stale hardcoded Spanish`);
    }
  }
  setLocale('es'); // restore for any later test
});

test('the system prompt tells the model to search rather than claim it cannot see', async () => {
  const threadId = createThread('search-nudge');
  const { provider, seen } = scriptedProvider([say('ok')]);
  await runTurn(threadId, 'x', [], provider);
  const system = seen[0]!.system!;
  // This is the behaviour most at risk on a smaller model: answering from the
  // 150-message window instead of calling the retrieval tool.
  assert.match(system, /CALL search_messages/);
  assert.match(system, /Do NOT conclude that something never happened/);
});

// ---- 4. NEW tasks are generated in the selected language ----
// The owner's question: "if the language is Chinese, will tasks be generated in
// Chinese?" They will — but only because the extractor prompt is rebuilt from
// the setting on every run. This test is what stops that regressing silently,
// since a wrong answer here is invisible until tasks show up in the wrong
// language days later.

test('the extractor is told to write task titles in the selected language', async () => {
  const m = await mockOai([{ choices: [{ finish_reason: 'stop', message: { content: '{"tasks":[]}' } }] }]);
  try {
    saveAiSettings({ provider: 'custom', baseUrl: m.url, model: 'mock', apiKey: 'k' });
    const msgs = [
      { id: 1, body: '需要报价单', direction: 'incoming', sender: 'x', chatName: 'Wong', ts: 0 },
    ] as never;

    const expected: Record<string, RegExp> = {
      es: /Write your output in Spanish \(neutral Latin-American Spanish\)/,
      en: /Write your output in English/,
      zh: /Write your output in Simplified Chinese/,
    };

    let i = 0;
    for (const [locale, re] of Object.entries(expected)) {
      setLocale(locale as 'es' | 'en' | 'zh');
      await new ModelExtractor().proposeTasks(msgs);
      const system = String(m.captured[i]!.messages[0]!.content);
      assert.match(system, re, `locale ${locale}: extractor must name the output language`);
      // source_quote must NEVER follow the UI language — it is a literal search
      // string pasted into WhatsApp, so it stays in the message's own language.
      assert.match(system, /ORIGINAL LANGUAGE/, `locale ${locale}: source_quote rule lost`);
      i++;
    }
    assert.equal(m.captured.length, 3);
  } finally {
    m.close();
    setLocale('es');
  }
});

test('switching language does NOT rewrite tasks already stored', async () => {
  // Deliberate product decision: re-translating the same column is lossy and a
  // UI preference must not silently rewrite his data. `translate:tasks` is the
  // explicit opt-in. This test pins that behaviour.
  const now = Date.now();
  db()
    .prepare(
      `INSERT INTO tasks (title, detail, status, client_hint, source_quote, created_at, updated_at)
       VALUES ('Cotizar toallas de papel', 'Pedido de Wong', 'todo', 'Wong', 'necesito cotización', ?, ?)`,
    )
    .run(now, now);
  const before = (db().prepare(`SELECT title FROM tasks ORDER BY id DESC LIMIT 1`).get() as { title: string }).title;

  setLocale('zh');
  const afterZh = (db().prepare(`SELECT title FROM tasks ORDER BY id DESC LIMIT 1`).get() as { title: string }).title;
  setLocale('en');
  const afterEn = (db().prepare(`SELECT title FROM tasks ORDER BY id DESC LIMIT 1`).get() as { title: string }).title;
  setLocale('es');

  assert.equal(afterZh, before, 'existing task titles must survive a language switch untouched');
  assert.equal(afterEn, before);
});
