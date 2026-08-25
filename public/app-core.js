// app-core.js — Utilities, date picker, theme, tabs, stats.
// Split from the old single app.js (1.8.0-dev). These files are CLASSIC scripts
// sharing one global scope; index.html loads them in a fixed order that mirrors
// the original file, so cross-file references keep working. Keep new top-level
// names unique across app-*.js.

const $ = (sel) => document.querySelector(sel);
const el = (html) => {
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  return t.content.firstElementChild;
};
const esc = (s) =>
  (s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// Presentational only: renders one icon from the <svg class="sprite"> symbol set
// defined at the top of index.html. Keeps a single stroke weight everywhere and
// inherits colour from its context via `currentColor`.
const ico = (name, cls = '') => `<svg class="ico${cls ? ' ' + cls : ''}" aria-hidden="true"><use href="#i-${name}"/></svg>`;

// In-app text prompt. Electron doesn't implement window.prompt() (it silently
// returns null), so we roll our own. Resolves to the string, or null on cancel.
function askText(message, defaultValue = '') {
  return new Promise((resolve) => {
    const ov = el(`<div class="overlay askmodal" style="display:flex;">
      <div class="modal ask-box">
        <div class="ask-msg">${esc(message)}</div>
        <input class="ask-input" value="${esc(defaultValue)}" />
        <div class="modal-actions">
          <button class="ask-cancel">${esc(tr('common.cancel'))}</button>
          <button class="primary ask-ok">${esc(tr('common.accept'))}</button>
        </div>
      </div>
    </div>`);
    document.body.append(ov);
    const input = ov.querySelector('.ask-input');
    const done = (val) => {
      ov.remove();
      resolve(val);
    };
    ov.querySelector('.ask-ok').onclick = () => done(input.value);
    ov.querySelector('.ask-cancel').onclick = () => done(null);
    ov.addEventListener('click', (e) => {
      if (e.target === ov) done(null);
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); done(input.value); }
      else if (e.key === 'Escape') { e.preventDefault(); done(null); }
    });
    setTimeout(() => { input.focus(); input.select(); }, 0);
  });
}
// Short date for "task generated on" labels (locale-aware — see app-i18n.js).
const fmtGen = (ms) => (ms ? fmtDate(ms) : '');
// Compact date + time a message was sent (feed rows can span many days).
const fmtMsgTime = (ms) =>
  ms
    ? new Date(ms).toLocaleString(I18N_BCP47, {
        day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit',
      })
    : '';

// Task statuses and WhatsApp connection states.
// The KEYS are the canonical values the API speaks and the database stores —
// only the displayed text is translated, so switching language never touches
// data or breaks a request.
const statusLabel = (s) => (s ? tr(`status.${s}`) : s);
const waLabel = (s) => (s ? tr(`wa.${s}`) : s);

// handle → display name (phone numbers become real names once assigned).
let names = {};
const displayName = (h) => (h && names[h]) || h || '';
async function loadNames() {
  try {
    names = await (await fetch('/api/namemap')).json();
  } catch {
    names = {};
  }
}

// Small badge showing which app a message came from.
function sourceBadge(source) {
  if (source === 'whatsapp') return '<span class="srcbadge wa">WA</span>';
  if (source === 'imessage') return '<span class="srcbadge imsg">iMsg</span>';
  return '';
}

// id → short label for connected WhatsApp accounts (loaded from the accounts
// endpoint). Used to badge which account a combined-inbox item came from.
let waAccountLabels = {};
async function loadWaAccountLabels() {
  try {
    const { accounts } = await (await fetch('/api/whatsapp/accounts')).json();
    waAccountLabels = {};
    for (const a of accounts || []) waAccountLabels[a.id] = a.label;
  } catch {
    /* keep whatever we had */
  }
}
// Badge for a WhatsApp account on a task/message — only shown when more than one
// account exists (single-account users get no clutter).
function accountBadge(source, waAccount) {
  if (source !== 'whatsapp' || !waAccount) return '';
  const ids = Object.keys(waAccountLabels);
  if (ids.length < 2) return '';
  const label = waAccountLabels[waAccount] || waAccount;
  return ` <span class="acctbadge" title="${esc(tr('common.whatsappAccount'))}">${esc(label)}</span>`;
}

// Turn a raw handle/JID into something readable: assigned name → pushname →
// clean phone (WhatsApp @c.us) → friendly label for hidden (@lid) / groups.
function prettySender(sender, senderName) {
  const named = displayName(sender);
  if (named && named !== sender) return named;
  if (senderName) return senderName;
  const s = sender || '';
  if (s.endsWith('@c.us')) return '+' + s.replace('@c.us', '');
  if (s.endsWith('@lid')) return tr('sender.whatsappContact');
  if (s.endsWith('@g.us')) return tr('sender.group');
  return s || '?';
}

// ---- Date picker ----------------------------------------------------------
// Chromium's native calendar panel can't be themed, so it's suppressed in CSS
// and this popover takes its place. It is purely presentational: it writes the
// same "YYYY-MM-DD" string into the same <input type="date"> and fires the same
// `change` event, so every existing handler keeps working untouched. Typing
// directly into the field also still works.
// Month and weekday names come from Intl rather than a translated list: they
// are calendar data, not UI copy, and Intl already has them correct for every
// locale (including which day the week starts on, which differs — Monday in
// Spanish, Sunday in English and Chinese).
const DP_MONTHS = Array.from({ length: 12 }, (_, m) =>
  new Intl.DateTimeFormat(I18N_BCP47, { month: 'long' }).format(new Date(2021, m, 1)),
);
/** 1 = Monday … 7 = Sunday, per Intl; falls back to Monday where unsupported. */
const DP_FIRST_DAY = (() => {
  try {
    const info = new Intl.Locale(I18N_BCP47).getWeekInfo?.();
    return info && info.firstDay ? info.firstDay : 1;
  } catch {
    return 1;
  }
})();
const DP_DOW = Array.from({ length: 7 }, (_, i) => {
  // 2021-11-01 was a Monday, so offset from there by the locale's first day.
  const d = new Date(2021, 10, 1 + ((DP_FIRST_DAY - 1 + i) % 7));
  return new Intl.DateTimeFormat(I18N_BCP47, { weekday: 'narrow' }).format(d);
});
let dpNode = null;
let dpInput = null;
let dpView = null; // { y, m } — the month currently on screen

const dpISO = (y, m, d) => `${y}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
function dpParse(v) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v || '');
  return m ? { y: +m[1], m: +m[2] - 1, d: +m[3] } : null;
}

function closeDatePicker() {
  if (!dpNode) return;
  dpNode.remove();
  dpNode = null;
  dpInput = null;
  dpView = null;
}

function dpPosition() {
  if (!dpNode || !dpInput) return;
  const r = dpInput.getBoundingClientRect();
  const w = dpNode.offsetWidth;
  const h = dpNode.offsetHeight;
  const left = Math.min(Math.max(8, r.left), Math.max(8, window.innerWidth - w - 8));
  // Flip above the field when there isn't room below it.
  const top = r.bottom + 8 + h > window.innerHeight - 8 ? Math.max(8, r.top - h - 8) : r.bottom + 8;
  dpNode.style.left = `${left}px`;
  dpNode.style.top = `${top}px`;
}

function dpRender() {
  const sel = dpParse(dpInput.value);
  const selISO = sel ? dpISO(sel.y, sel.m, sel.d) : null;
  const todayISO = (() => { const n = new Date(); return dpISO(n.getFullYear(), n.getMonth(), n.getDate()); })();
  const { y, m } = dpView;
  // Offset the grid by the locale's first weekday, so the day columns line up
  // with the DP_DOW headers (Monday-first in Spanish, Sunday-first in English
  // and Chinese). getDay() is 0=Sunday; DP_FIRST_DAY is 1=Monday…7=Sunday.
  const lead = (new Date(y, m, 1).getDay() - (DP_FIRST_DAY % 7) + 7) % 7;
  let cells = '';
  for (let i = 0; i < 42; i++) {
    const d = new Date(y, m, i - lead + 1); // JS normalizes over month edges
    const iso = dpISO(d.getFullYear(), d.getMonth(), d.getDate());
    const cls = [
      'dp-day',
      d.getMonth() === m ? '' : 'out',
      iso === todayISO ? 'today' : '',
      iso === selISO ? 'sel' : '',
    ].filter(Boolean).join(' ');
    cells += `<button type="button" class="${cls}" data-iso="${iso}">${d.getDate()}</button>`;
  }
  // Chinese writes "2026年3月", Spanish "marzo 2026" — let Intl decide.
  dpNode.querySelector('.dp-title').textContent = new Intl.DateTimeFormat(I18N_BCP47, {
    month: 'long', year: 'numeric',
  }).format(new Date(y, m, 1));
  dpNode.querySelector('.dp-grid').innerHTML = cells;
}

function dpCommit(iso) {
  const input = dpInput;
  closeDatePicker();
  // A background refresh can re-render the card out from under an open picker,
  // leaving `input` detached — writing to it then would silently do nothing.
  if (!input || !input.isConnected) return;
  input.value = iso;
  input.dispatchEvent(new Event('change', { bubbles: true }));
}

function dpShift(delta) {
  dpView.m += delta;
  if (dpView.m < 0) { dpView.m = 11; dpView.y--; }
  else if (dpView.m > 11) { dpView.m = 0; dpView.y++; }
  dpRender();
}

function openDatePicker(input) {
  closeDatePicker();
  dpInput = input;
  const sel = dpParse(input.value);
  const now = new Date();
  dpView = sel ? { y: sel.y, m: sel.m } : { y: now.getFullYear(), m: now.getMonth() };
  dpNode = el(`<div class="dp" role="dialog" aria-label="${esc(tr('datepicker.choose'))}">
    <div class="dp-head">
      <button type="button" class="dp-prev iconbtn" aria-label="${esc(tr('datepicker.prevMonth'))}">${ico('left')}</button>
      <span class="dp-title"></span>
      <button type="button" class="dp-next iconbtn" aria-label="${esc(tr('datepicker.nextMonth'))}">${ico('right')}</button>
    </div>
    <div class="dp-dow">${DP_DOW.map((d) => `<span>${d}</span>`).join('')}</div>
    <div class="dp-grid"></div>
    <div class="dp-foot">
      <button type="button" class="dp-clear">${esc(tr('datepicker.clear'))}</button>
      <button type="button" class="dp-today primary">${esc(tr('datepicker.today'))}</button>
    </div>
  </div>`);
  document.body.append(dpNode);
  dpRender();
  dpPosition();
  dpNode.querySelector('.dp-prev').onclick = () => dpShift(-1);
  dpNode.querySelector('.dp-next').onclick = () => dpShift(1);
  dpNode.querySelector('.dp-clear').onclick = () => dpCommit('');
  dpNode.querySelector('.dp-today').onclick = () => {
    const n = new Date();
    dpCommit(dpISO(n.getFullYear(), n.getMonth(), n.getDate()));
  };
  dpNode.addEventListener('click', (e) => {
    const day = e.target.closest('.dp-day');
    if (day) dpCommit(day.dataset.iso);
  });
}

const dpFieldAt = (target) => (target && target.closest ? target.closest("input[type='date']") : null);

document.addEventListener('click', (e) => {
  const field = dpFieldAt(e.target);
  if (field) {
    if (dpInput !== field) openDatePicker(field);
    return;
  }
  if (dpNode && !e.target.closest('.dp')) closeDatePicker();
});
document.addEventListener('keydown', (e) => {
  const field = dpFieldAt(e.target);
  // The keys Chromium uses to summon its own calendar — take them over.
  if (field && (e.key === 'F4' || e.key === ' ' || (e.altKey && e.key === 'ArrowDown'))) {
    e.preventDefault();
    openDatePicker(field);
    return;
  }
  if (dpNode && e.key === 'Escape') {
    e.preventDefault();
    closeDatePicker();
  }
});
window.addEventListener('resize', () => dpPosition());
window.addEventListener('scroll', () => dpPosition(), true);

// ---- Apariencia (claro / oscuro) ------------------------------------------
// Display-only preference kept in localStorage; the resolver that stamps
// <html data-theme> lives inline in index.html so it runs before first paint.
const THEME_KEY = 'theme';
function themePref() {
  try {
    return localStorage.getItem(THEME_KEY) || 'auto';
  } catch {
    return 'auto';
  }
}
function paintThemeSeg() {
  const pref = themePref();
  document.querySelectorAll('#theme-seg .seg-btn').forEach((b) => {
    const on = b.dataset.themeChoice === pref;
    b.classList.toggle('active', on);
    b.setAttribute('aria-pressed', String(on));
  });
}
function setThemePref(pref) {
  try {
    localStorage.setItem(THEME_KEY, pref);
  } catch {
    /* preference just won't persist */
  }
  const paint = () => {
    if (window.applyTheme) window.applyTheme();
    paintThemeSeg();
  };
  // Crossfade the whole document instead of snapping, where supported.
  if (document.startViewTransition) document.startViewTransition(paint);
  else paint();
  const saved = $('#theme-saved');
  if (saved) {
    saved.innerHTML = `${ico('check')}${esc(tr('common.saved'))}`;
    setTimeout(() => (saved.innerHTML = ''), 1800);
  }
}
document.querySelectorAll('#theme-seg .seg-btn').forEach((b) => {
  b.onclick = () => setThemePref(b.dataset.themeChoice);
});
paintThemeSeg();

// ---- Tabs ----
document.querySelectorAll('.tab').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((b) => b.classList.toggle('active', b === btn));
    const id = btn.dataset.tab;
    document.querySelectorAll('.panel').forEach((p) => p.classList.toggle('active', p.id === id));
    if (id === 'archive') loadArchive();
    if (id === 'tasks') loadTasks();
    if (id === 'trash') loadTrash();
    if (id === 'chat') initChat();
    if (id === 'messages') initMessages();
    if (id === 'clients') loadSenders();
    if (id === 'attachments') {
      attFocusId = null;
      const fb = $('#att-focus');
      if (fb) { fb.hidden = true; fb.innerHTML = ''; }
      loadAttachments(true);
    }
    if (id === 'settings') {
      loadSettings();
      loadChats();
      loadWaAccounts();
    }
    if (id === 'help') loadHelpDoc();
  });
});

/**
 * The Help tab is long-form prose with inline markup, so it is NOT translated
 * key-by-key — splitting sentences around <b> tags produces word salad in any
 * language whose word order differs. Each language gets its own hand-written
 * fragment instead, loaded on first open.
 *
 * innerHTML is safe here: the source is our own static file shipped in public/,
 * never user or message content.
 */
let helpDocLoaded = false;
async function loadHelpDoc() {
  if (helpDocLoaded) return;
  const box = $('#help-doc');
  if (!box) return;
  const tryLoad = async (loc) => {
    const res = await fetch(`/i18n/help.${loc}.html`);
    return res.ok ? res.text() : null;
  };
  try {
    const html = (await tryLoad(I18N_LOCALE)) ?? (await tryLoad('es'));
    if (html) {
      box.innerHTML = html;
      helpDocLoaded = true;
    }
  } catch {
    /* leave the panel empty rather than breaking the tab */
  }
}

// ---- Stats ----
async function loadStats() {
  const s = await (await fetch('/api/stats')).json();
  $('#stats').innerHTML =
    `<span><b>${s.messages}</b> ${esc(tr('stats.messages'))}</span>` +
    `<span><b>${s.proposed}</b> ${esc(tr('stats.proposed'))}</span>` +
    `<span><b>${s.todo + s.waiting}</b> ${esc(tr('stats.open'))}</span>` +
    `<span><b>${s.done}</b> ${esc(tr('stats.done'))}</span>`;
  $('#inbox-count').textContent = s.proposed;
  if (typeof s.trash === 'number') $('#trash-pill').textContent = s.trash;
  if (!s.hasApiKey) $('#proc-status').textContent = tr('common.configureAiProvider');
}
