/**
 * i18n runtime for the classic (non-module) app-*.js scripts.
 *
 * These files all share one global scope and are loaded in a fixed order, so
 * this file must come FIRST — everything after it may call t() at parse time
 * (label maps, for instance, are module-level constants).
 *
 * The catalog is NOT fetched here. The server renders it as a plain script at
 * /i18n/catalog.js, which is loaded synchronously before this file. That keeps
 * three properties that a fetch() would break:
 *   - synchronous availability, so classic scripts can use t() while parsing;
 *   - a single source of truth (public/i18n/<locale>.json, read by both the
 *     server and, through this route, the browser) that cannot drift;
 *   - the browser's language always matches the server's, because both come
 *     from the same setting on the same request.
 * Switching language therefore just reloads the page.
 */

/* global window, document, navigator, Intl */

const I18N_LOCALE = window.I18N_LOCALE || 'es';
const I18N_CATALOG = window.I18N_CATALOG || {};
const I18N_FALLBACK = window.I18N_FALLBACK || {};

/**
 * Translate a key. `vars` fills {placeholders}.
 *
 * Named `tr` and NOT `t` on purpose: these classic scripts share one global
 * scope, and `t` is already the conventional loop variable for a task
 * (`.map((t) => t.title)`) in ~50 places across app-tasks.js, app-chat.js and
 * app-messages.js. A global `t()` would be shadowed inside every one of those
 * callbacks and fail at runtime, not at load.
 * Falls back: active locale → Spanish (what the app shipped in) → the key
 * itself. A visible key is a far better failure than a blank button.
 */
function tr(key, vars) {
  let s = I18N_CATALOG[key];
  if (s === undefined) s = I18N_FALLBACK[key];
  if (s === undefined) {
    if (window.I18N_DEBUG) console.warn('[i18n] missing key:', key);
    return key;
  }
  if (!vars) return s;
  return s.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m));
}

/** Plural helper: `key` and `key_one` (used where languages differ on plurals). */
function trn(key, n, vars) {
  const one = I18N_CATALOG[key + '_one'] !== undefined || I18N_FALLBACK[key + '_one'] !== undefined;
  return tr(one && Number(n) === 1 ? key + '_one' : key, Object.assign({ n }, vars || {}));
}

// ---- Locale-aware formatting -------------------------------------------
// Every one of these replaced a hardcoded 'es' somewhere in the app.

/** BCP-47 tag for Intl. 'zh' → 'zh-CN' so dates read the way CJK users expect. */
const I18N_BCP47 = { es: 'es', en: 'en', zh: 'zh-CN' }[I18N_LOCALE] || I18N_LOCALE;

const fmtDate = (ms) =>
  ms ? new Date(ms).toLocaleDateString(I18N_BCP47, { day: '2-digit', month: '2-digit', year: 'numeric' }) : '';

const fmtDateTime = (ms) => (ms ? new Date(ms).toLocaleString(I18N_BCP47) : '');

const fmtDayLong = (ms) =>
  new Date(ms).toLocaleDateString(I18N_BCP47, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });

const fmtDayKey = (ms) => new Date(ms).toLocaleDateString(I18N_BCP47);

const fmtShortDate = (ms) =>
  new Date(ms).toLocaleDateString(I18N_BCP47, { day: '2-digit', month: '2-digit', year: '2-digit' });

/**
 * Collator for sorting names. Chinese sorts by pinyin here rather than by code
 * point, which is what a Chinese reader expects from an alphabetical list.
 */
const i18nCollator = new Intl.Collator(I18N_BCP47, { sensitivity: 'base', numeric: true });
const i18nCompare = (a, b) => i18nCollator.compare(a ?? '', b ?? '');

/**
 * Translate a DOM subtree in place. Markup carries the keys declaratively:
 *   <button data-i18n="tasks.approve"></button>
 *   <input data-i18n-placeholder="search.placeholder">
 *   <span data-i18n-title="tasks.dueHint">
 * so index.html stays readable and reviewable instead of turning into
 * hundreds of createElement calls.
 */
/**
 * Set an element's visible text WITHOUT destroying its element children.
 *
 * Most labelled controls here look like `<button><svg class="ico"/>Archivar</button>`.
 * Assigning textContent would delete the icon, so we replace only the first
 * non-empty text node and leave the markup alone.
 */
function setI18nText(el, str) {
  const texts = Array.prototype.filter.call(el.childNodes, (n) => n.nodeType === 3 && n.textContent.trim() !== '');
  if (texts.length > 0) {
    texts[0].textContent = str;
    for (let i = 1; i < texts.length; i++) texts[i].textContent = '';
    return;
  }
  if (el.children.length === 0) el.textContent = str;
  else el.insertBefore(document.createTextNode(str), null);
}

function applyI18n(root) {
  const scope = root || document;
  scope.querySelectorAll('[data-i18n]').forEach((el) => {
    setI18nText(el, tr(el.getAttribute('data-i18n')));
  });
  // Prose whose sentence wraps inline <b>/<i> cannot be translated fragment by
  // fragment — word order differs between languages, so the pieces would come
  // out shuffled. Those carry the whole sentence, markup included, in one key.
  // innerHTML is safe here: catalog values are our own shipped translations,
  // never user or message content.
  scope.querySelectorAll('[data-i18n-html]').forEach((el) => {
    el.innerHTML = tr(el.getAttribute('data-i18n-html'));
  });
  scope.querySelectorAll('[data-i18n-placeholder]').forEach((el) => {
    el.setAttribute('placeholder', tr(el.getAttribute('data-i18n-placeholder')));
  });
  scope.querySelectorAll('[data-i18n-title]').forEach((el) => {
    el.setAttribute('title', tr(el.getAttribute('data-i18n-title')));
  });
  scope.querySelectorAll('[data-i18n-aria-label]').forEach((el) => {
    el.setAttribute('aria-label', tr(el.getAttribute('data-i18n-aria-label')));
  });
}

// Reflect the language on <html> so CSS can adapt (CJK line-breaking, fonts).
document.documentElement.setAttribute('lang', I18N_BCP47);
document.documentElement.setAttribute('data-locale', I18N_LOCALE);
