/**
 * Locale layer, shared by the server, the AI prompts and the browser UI.
 *
 * ONE catalog, ONE copy: the message files live in `public/i18n/*.json`, which
 * is already part of the online-update payload (release.mjs ships dist/ +
 * public/), so translations can be corrected in a normal code update without a
 * new .app. The browser fetches them directly; the server reads the same files
 * off disk. Nothing is duplicated between the two sides, so they cannot drift.
 *
 * Catalogs are flat `"section.key": "text"` maps. Interpolation is `{name}`.
 * A missing key falls back to Spanish (the language the app shipped in), then
 * to the key itself — a wrong-looking label is a much better failure than a
 * blank button or a crash.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getSetting, setSetting } from './settings.js';

export const LOCALES = ['es', 'en', 'zh'] as const;
export type Locale = (typeof LOCALES)[number];

/** Spanish is the default: it is what every existing install already shows. */
export const DEFAULT_LOCALE: Locale = 'es';

export function isLocale(v: unknown): v is Locale {
  return typeof v === 'string' && (LOCALES as readonly string[]).includes(v);
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const I18N_DIR = path.join(__dirname, '..', 'public', 'i18n');

type Catalog = Record<string, string>;
/** Cached catalog plus the mtime it was read from. */
const cache = new Map<Locale, { mtimeMs: number; cat: Catalog }>();

/**
 * Read a catalog, re-reading it whenever the file on disk has changed.
 *
 * The mtime check is not just a dev convenience: an online update replaces the
 * whole public/ directory underneath a running server, so a plain cache would
 * keep serving the previous release's strings until the app was restarted.
 */
function load(locale: Locale): Catalog {
  const file = path.join(I18N_DIR, `${locale}.json`);
  let mtimeMs = 0;
  try {
    mtimeMs = fs.statSync(file).mtimeMs;
  } catch {
    /* missing file → mtime 0, handled below */
  }
  const hit = cache.get(locale);
  if (hit && hit.mtimeMs === mtimeMs) return hit.cat;

  let cat: Catalog = {};
  try {
    cat = JSON.parse(fs.readFileSync(file, 'utf8')) as Catalog;
  } catch {
    // A missing or malformed catalog must not take the app down; t() will fall
    // back through Spanish to the key.
    cat = {};
  }
  cache.set(locale, { mtimeMs, cat });
  return cat;
}

/** The whole catalog for a locale — used to render it into the browser. */
export function catalog(locale: Locale): Record<string, string> {
  return load(locale);
}

/** Drop cached catalogs (used by tests, and after an online update swaps public/). */
export function invalidateCatalogs(): void {
  cache.clear();
}

/** The language the owner picked in Ajustes. */
export function getLocale(): Locale {
  const v = getSetting('ui_language');
  return isLocale(v) ? v : DEFAULT_LOCALE;
}

export function setLocale(locale: Locale): void {
  if (!isLocale(locale)) throw new Error(`Unknown locale: ${locale}`);
  setSetting('ui_language', locale);
}

/** Has the owner ever chosen a language? Drives the first-run picker. */
export function localeChosen(): boolean {
  return isLocale(getSetting('ui_language'));
}

function interpolate(s: string, vars?: Record<string, string | number>): string {
  if (!vars) return s;
  return s.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m));
}

/**
 * Plural helper: looks for `key_one` when n === 1, else `key`. Kept simple on
 * purpose — the three shipped languages need only a one/other split (Chinese
 * needs neither, and simply defines both forms identically).
 */
export function tn(key: string, n: number, vars?: Record<string, string | number>, locale = getLocale()): string {
  const oneKey = `${key}_one`;
  const useOne = n === 1 && (load(locale)[oneKey] !== undefined || load(DEFAULT_LOCALE)[oneKey] !== undefined);
  return t(useOne ? oneKey : key, { n, ...(vars ?? {}) }, locale);
}

/** Translate a key in the active locale (or an explicit one). */
export function t(key: string, vars?: Record<string, string | number>, locale = getLocale()): string {
  const direct = load(locale)[key];
  if (direct !== undefined) return interpolate(direct, vars);
  const fallback = load(DEFAULT_LOCALE)[key];
  if (fallback !== undefined) return interpolate(fallback, vars);
  return key;
}

// ---- Model-facing language control ----------------------------------------
//
// Prompts are English (every model's strongest instruction-following language,
// and the one these tool schemas were trained on), but the CONTENT the model
// produces has to come back in the owner's language. Keeping that as one
// instruction, in one place, means adding a language later touches one map.

const LANGUAGE_NAMES: Record<Locale, string> = {
  es: 'Spanish (neutral Latin-American Spanish)',
  en: 'English',
  zh: 'Simplified Chinese (简体中文)',
};

/** Human-readable name of a locale, for use inside a prompt. */
export function languageName(locale = getLocale()): string {
  return LANGUAGE_NAMES[locale];
}

/**
 * The instruction that makes the model answer in the owner's language.
 *
 * Deliberately explicit about what must NOT be translated: product names, brand
 * names and quoted snippets. `source_quote` in particular is a literal search
 * string pasted into WhatsApp/iMessage — translating it silently breaks the
 * feature, and smaller models translate quotes unless told twice.
 */
export function replyLanguageInstruction(locale = getLocale()): string {
  return (
    `Write your output in ${languageName(locale)}, regardless of the language of the ` +
    `input messages. Keep proper names, product names, brand names, and any quoted ` +
    `message snippet exactly as they appear in the original — do not translate those.`
  );
}
