/**
 * Catalog integrity. The requirement was "everything translated — no leftover
 * Spanish strings anywhere", and the only way that stays true as the app changes
 * is to make a missing translation a test failure rather than something you
 * notice in the UI three languages later.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public', 'i18n');
const LOCALES = ['es', 'en', 'zh'] as const;

const load = (l: string): Record<string, string> =>
  JSON.parse(fs.readFileSync(path.join(DIR, `${l}.json`), 'utf8')) as Record<string, string>;

const cats = Object.fromEntries(LOCALES.map((l) => [l, load(l)])) as Record<string, Record<string, string>>;

test('every locale defines exactly the same keys', () => {
  const base = Object.keys(cats.es!).sort();
  for (const l of LOCALES) {
    const keys = Object.keys(cats[l]!).sort();
    const missing = base.filter((k) => !keys.includes(k));
    const extra = keys.filter((k) => !base.includes(k));
    assert.deepEqual(missing, [], `${l}.json is missing keys`);
    assert.deepEqual(extra, [], `${l}.json has keys no other locale has`);
  }
});

test('no value is empty', () => {
  for (const l of LOCALES) {
    for (const [k, v] of Object.entries(cats[l]!)) {
      assert.ok(v.trim().length > 0, `${l}.json: ${k} is empty`);
    }
  }
});

test('placeholders match across locales — a dropped {n} shows a wrong number', () => {
  const ph = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]!).sort();
  for (const [k, esVal] of Object.entries(cats.es!)) {
    for (const l of LOCALES) {
      if (l === 'es') continue;
      assert.deepEqual(ph(cats[l]![k]!), ph(esVal), `${l}.json: ${k} placeholders differ from Spanish`);
    }
  }
});

test('non-Spanish catalogs contain no leftover Spanish text', () => {
  // Accents alone are not proof (English has none), so look for words that only
  // appear in Spanish copy and would signal an untranslated string.
  const tells = /\b(mensajes?|tareas?|cliente|archivo|guardar|buscar|eliminar|conversación|ninguna?|configura)\b/i;
  const allowed = new Set(['settings.httpsV1']); // literal URLs etc.
  for (const l of ['en', 'zh'] as const) {
    for (const [k, v] of Object.entries(cats[l]!)) {
      if (allowed.has(k)) continue;
      assert.ok(!tells.test(v), `${l}.json: ${k} looks untranslated → ${v}`);
    }
  }
});

test('HTML-mode values keep the same tags in every language', () => {
  const tags = (s: string) => [...s.matchAll(/<(\/?)(\w+)/g)].map((m) => `${m[1]}${m[2]}`).sort();
  for (const [k, esVal] of Object.entries(cats.es!)) {
    if (!/</.test(esVal)) continue;
    for (const l of ['en', 'zh'] as const) {
      assert.deepEqual(tags(cats[l]![k]!), tags(esVal), `${l}.json: ${k} has different markup from Spanish`);
    }
  }
});

test('every key referenced by the frontend exists in the catalog', () => {
  const pub = path.join(DIR, '..');
  // app-i18n.js is the runtime, not a consumer — the keys in its doc comment
  // are illustrative examples, not real references.
  const files = fs
    .readdirSync(pub)
    .filter((f) => f.startsWith('app-') && f.endsWith('.js') && f !== 'app-i18n.js');
  files.push('index.html');
  const known = new Set(Object.keys(cats.es!));
  const missing = new Set<string>();
  for (const f of files) {
    const src = fs.readFileSync(path.join(pub, f), 'utf8');
    // tr('key') / trn('key', …) and data-i18n[-*]="key"
    for (const m of src.matchAll(/\btrn?\(\s*'([a-zA-Z0-9_.]+)'/g)) {
      if (!known.has(m[1]!) && !known.has(`${m[1]}_one`)) missing.add(`${f}: ${m[1]}`);
    }
    for (const m of src.matchAll(/data-i18n(?:-[a-z-]+)?="([a-zA-Z0-9_.]+)"/g)) {
      if (!known.has(m[1]!)) missing.add(`${f}: ${m[1]}`);
    }
  }
  assert.deepEqual([...missing], [], 'frontend references keys that no catalog defines');
});

test('a help fragment exists for every locale', () => {
  for (const l of LOCALES) {
    const p = path.join(DIR, `help.${l}.html`);
    assert.ok(fs.existsSync(p), `missing help.${l}.html`);
    assert.ok(fs.readFileSync(p, 'utf8').trim().length > 200, `help.${l}.html looks empty`);
  }
});
