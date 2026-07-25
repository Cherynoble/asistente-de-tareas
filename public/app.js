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
          <button class="ask-cancel">Cancelar</button>
          <button class="primary ask-ok">Aceptar</button>
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
// Short Spanish date for "task generated on" labels.
const fmtGen = (ms) =>
  ms ? new Date(ms).toLocaleDateString('es', { day: '2-digit', month: '2-digit', year: 'numeric' }) : '';
// Compact date + time a message was sent (feed rows can span many days).
const fmtMsgTime = (ms) =>
  ms
    ? new Date(ms).toLocaleString('es', {
        day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit',
      })
    : '';

// Spanish labels for task statuses and WhatsApp connection states.
const STATUS_LABELS = { proposed: 'propuesta', todo: 'por hacer', waiting: 'en espera', done: 'hecho', dismissed: 'descartada' };
const statusLabel = (s) => STATUS_LABELS[s] || s;
const WA_LABELS = {
  idle: 'inactivo', starting: 'iniciando', qr: 'código QR', authenticated: 'autenticado',
  ready: 'conectado', disconnected: 'desconectado',
};
const waLabel = (s) => WA_LABELS[s] || s;

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
  return ` <span class="acctbadge" title="Cuenta de WhatsApp">${esc(label)}</span>`;
}

// Turn a raw handle/JID into something readable: assigned name → pushname →
// clean phone (WhatsApp @c.us) → friendly label for hidden (@lid) / groups.
function prettySender(sender, senderName) {
  const named = displayName(sender);
  if (named && named !== sender) return named;
  if (senderName) return senderName;
  const s = sender || '';
  if (s.endsWith('@c.us')) return '+' + s.replace('@c.us', '');
  if (s.endsWith('@lid')) return 'contacto de WhatsApp';
  if (s.endsWith('@g.us')) return 'grupo';
  return s || '?';
}

// ---- Date picker ----------------------------------------------------------
// Chromium's native calendar panel can't be themed, so it's suppressed in CSS
// and this popover takes its place. It is purely presentational: it writes the
// same "YYYY-MM-DD" string into the same <input type="date"> and fires the same
// `change` event, so every existing handler keeps working untouched. Typing
// directly into the field also still works.
const DP_MONTHS = [
  'enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio',
  'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre',
];
const DP_DOW = ['L', 'M', 'X', 'J', 'V', 'S', 'D']; // Spanish week starts Monday
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
  const lead = (new Date(y, m, 1).getDay() + 6) % 7; // Monday-first offset
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
  dpNode.querySelector('.dp-title').textContent = `${DP_MONTHS[m]} ${y}`;
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
  dpNode = el(`<div class="dp" role="dialog" aria-label="Elegir fecha">
    <div class="dp-head">
      <button type="button" class="dp-prev iconbtn" aria-label="Mes anterior">${ico('left')}</button>
      <span class="dp-title"></span>
      <button type="button" class="dp-next iconbtn" aria-label="Mes siguiente">${ico('right')}</button>
    </div>
    <div class="dp-dow">${DP_DOW.map((d) => `<span>${d}</span>`).join('')}</div>
    <div class="dp-grid"></div>
    <div class="dp-foot">
      <button type="button" class="dp-clear">Borrar</button>
      <button type="button" class="dp-today primary">Hoy</button>
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
    saved.innerHTML = `${ico('check')}guardado`;
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
  });
});

// ---- Stats ----
async function loadStats() {
  const s = await (await fetch('/api/stats')).json();
  $('#stats').innerHTML =
    `<span><b>${s.messages}</b> mensajes</span>` +
    `<span><b>${s.proposed}</b> propuestas</span>` +
    `<span><b>${s.todo + s.waiting}</b> abiertas</span>` +
    `<span><b>${s.done}</b> hechas</span>`;
  $('#inbox-count').textContent = s.proposed;
  if (typeof s.trash === 'number') $('#trash-pill').textContent = s.trash;
  if (!s.hasApiKey) $('#proc-status').textContent = 'No hay clave de API configurada';
}

// ---- Search + multi-select infrastructure ----
// Spanish↔English month names normalize to the same token so "junio" finds "June".
const MONTH_SETS = [
  ['enero', 'january'], ['febrero', 'february'], ['marzo', 'march'], ['abril', 'april'],
  ['mayo', 'may'], ['junio', 'june'], ['julio', 'july'], ['agosto', 'august'],
  ['septiembre', 'setiembre', 'september'], ['octubre', 'october'],
  ['noviembre', 'november'], ['diciembre', 'december'],
];
function normMonths(s) {
  let out = s;
  MONTH_SETS.forEach((names, i) => {
    const tok = 'mes' + String(i + 1).padStart(2, '0');
    for (const n of names) out = out.replace(new RegExp('\\b' + n + '\\b', 'g'), tok);
  });
  return out;
}
// Every word in the query must appear somewhere in the joined fields.
function matches(q, ...fields) {
  if (!q || !q.trim()) return true;
  const hay = normMonths(fields.filter(Boolean).join(' ').toLowerCase());
  return normMonths(q.toLowerCase()).split(/\s+/).every((w) => hay.includes(w));
}

// Selection state + toolbar wiring for one panel. `key` is the panel id, and the
// toolbar elements follow the `${key}-bulk/-selcount/-all` id convention.
function makeSelection(key, getVisibleIds) {
  const selected = new Set();
  const bar = $(`#${key}-bulk`);
  const countEl = $(`#${key}-selcount`);
  const allBox = $(`#${key}-all`);
  function refresh() {
    if (bar) bar.hidden = selected.size === 0;
    if (countEl) countEl.textContent = selected.size ? `${selected.size} seleccionada(s)` : '';
    if (allBox) {
      const ids = getVisibleIds();
      allBox.checked = ids.length > 0 && ids.every((i) => selected.has(i));
    }
  }
  if (allBox)
    allBox.onchange = () => {
      const ids = getVisibleIds();
      if (allBox.checked) ids.forEach((i) => selected.add(i));
      else ids.forEach((i) => selected.delete(i));
      document.querySelectorAll(`#${key} .sel`).forEach((cb) => {
        cb.checked = selected.has(cb.dataset.id);
      });
      refresh();
    };
  return {
    selected,
    bind(cb, id) {
      cb.checked = selected.has(id);
      cb.onchange = () => {
        if (cb.checked) selected.add(id);
        else selected.delete(id);
        refresh();
      };
    },
    ids: () => [...selected],
    clear() {
      selected.clear();
      refresh();
    },
    refresh,
  };
}

function bulkPost(url, body) {
  return fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

// Reload everything that a task change can affect.
async function refreshTaskViews() {
  await Promise.all([loadInbox(), loadTasks(), loadArchive(), loadTrash(), loadStats()]);
}

async function bulkTasks(selection, action, value) {
  const ids = selection.ids().map(Number).filter((n) => Number.isFinite(n));
  if (!ids.length) return;
  if (action === 'purge' && !confirm(`¿Borrar definitivamente ${ids.length} tarea(s)? No se puede deshacer.`)) return;
  await bulkPost('/api/tasks/bulk', { ids, action, value });
  selection.clear();
  await refreshTaskViews();
}

async function bulkClients(selection, action) {
  const handles = selection.ids();
  if (!handles.length) return;
  if (action === 'purge' && !confirm(`¿Borrar definitivamente ${handles.length} cliente(s)? No se puede deshacer.`)) return;
  await bulkPost('/api/clients/bulk', { handles, action });
  selection.clear();
  await Promise.all([loadSenders(), loadNames(), loadTrash(), loadStats()]);
}

// ---- Inbox ----
let inboxItems = [];
const inboxSel = makeSelection('inbox', () => filteredInbox().map((t) => String(t.id)));
function filteredInbox() {
  const q = $('#inbox-search').value;
  return inboxItems.filter((t) =>
    matches(q, t.title, t.detail, displayName(t.clientHint || t.chatName || t.sourceSender || ''), t.sourceQuote),
  );
}
async function loadInbox() {
  inboxItems = await (await fetch('/api/inbox')).json();
  inboxSel.clear();
  renderInbox();
}
function renderInbox() {
  const list = $('#inbox-list');
  list.innerHTML = '';
  const items = filteredInbox();
  if (!items.length) {
    list.append(el(`<div class="empty">${inboxItems.length ? ico('search', 'ico-xl') + 'Nada coincide con la búsqueda.' : ico('inbox', 'ico-xl') + 'Aún no hay tareas propuestas. Usa la pestaña Proceso para encontrar algunas.'}</div>`));
    inboxSel.refresh();
    return;
  }
  for (const t of items) {
    const who = displayName(t.clientHint || t.chatName || t.sourceSender || '');
    const card = el(`<div class="card selectable">
      <input type="checkbox" class="sel" data-id="${t.id}" />
      <div class="cardbody">
        <div class="title">${esc(t.title)}</div>
        <div class="detail">${esc(t.detail)}</div>
        ${t.sourceQuote ? `<div class="quote">${ico('search')}<span class="qtext">buscar ${who ? 'a ' + esc(who) : ''}: <span>"${esc(t.sourceQuote)}"</span></span></div>` : ''}
        ${t.sourceBody && !t.sourceQuote ? `<div class="src">${t.hasAttachment ? ico('clip') + ' ' : ''}${esc(t.sourceBody.slice(0, 160))}</div>` : ''}
        ${t.hasAttachment && t.sourceMessageId ? `<div class="filelink"><a href="#" class="j-file">${ico('clip')}ver archivo</a></div>` : ''}
        <div class="meta">${who ? `<span>cliente: ${esc(who)}</span>` : ''}${t.createdAt ? `<span>generada: ${esc(fmtGen(t.createdAt))}</span>` : ''}${accountBadge(t.source, t.waAccount)}</div>
        <div class="actions">
          <button class="approve j-approve">${ico('check')}Aprobar</button>
          <button class="dismiss j-del iconbtn" title="Eliminar" aria-label="Eliminar">${ico('trash')}</button>
        </div>
      </div>
    </div>`);
    inboxSel.bind(card.querySelector('.sel'), String(t.id));
    card.querySelector('.j-approve').onclick = () => setStatus(t.id, 'todo');
    card.querySelector('.j-del').onclick = () => deleteTask(t.id);
    const fileLink = card.querySelector('.j-file');
    if (fileLink) fileLink.onclick = (e) => { e.preventDefault(); focusAttachment(t.sourceMessageId); };
    list.append(card);
  }
  inboxSel.refresh();
}
async function deleteTask(id) {
  await bulkPost('/api/tasks/bulk', { ids: [Number(id)], action: 'delete' });
  await refreshTaskViews();
}
$('#inbox-search').addEventListener('input', renderInbox);
$('#inbox-bulk-approve').onclick = () => bulkTasks(inboxSel, 'status', 'todo');
$('#inbox-bulk-delete').onclick = () => bulkTasks(inboxSel, 'delete');

async function setStatus(id, status) {
  await fetch(`/api/tasks/${id}/status`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status }),
  });
  await Promise.all([loadInbox(), loadTasks(), loadStats()]);
}

async function archiveTask(id, undo = false) {
  await fetch(`/api/tasks/${id}/archive`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ undo }),
  });
  await Promise.all([loadTasks(), loadArchive(), loadStats()]);
}

// ---- Tasks ----
const STATUSES = ['todo', 'waiting', 'done'];
// unix ms → "YYYY-MM-DD" (local) for a date input; '' if unset.
function dateInput(ms) {
  if (!ms) return '';
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

async function setDue(id, value) {
  // Treat the date as end-of-day local so a task isn't "overdue" the morning it's due.
  const dueAt = value ? new Date(value + 'T23:59:59').getTime() : null;
  await fetch(`/api/tasks/${id}/due`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ dueAt }),
  });
  await loadTasks();
}

let tasksItems = [];
const tasksSel = makeSelection('tasks', () => filteredTasks().map((t) => String(t.id)));
function filteredTasks() {
  const q = $('#tasks-search').value;
  return tasksItems.filter((t) => matches(q, t.title, t.detail, displayName(t.clientHint || ''), t.sourceQuote));
}
async function loadTasks() {
  tasksItems = await (await fetch('/api/tasks')).json();
  tasksSel.clear();
  renderTasks();
}
function renderTasks() {
  for (const id of STATUSES) $(`#col-${id}`).innerHTML = '';
  const counts = { todo: 0, waiting: 0, done: 0 };
  for (const t of filteredTasks()) {
    counts[t.status]++;
    const options = STATUSES.map(
      (s) => `<option value="${s}" ${s === t.status ? 'selected' : ''}>${statusLabel(s)}</option>`,
    ).join('');
    const overdue = t.dueAt && t.dueAt < Date.now() && t.status !== 'done';
    const card = el(`<div class="card selectable">
      <input type="checkbox" class="sel" data-id="${t.id}" />
      <div class="cardbody">
        <div class="title">${esc(t.title)}</div>
        <div class="detail">${esc(t.detail)}</div>
        ${t.sourceQuote ? `<div class="quote">${ico('search')}<span>"${esc(t.sourceQuote)}"</span></div>` : ''}
        ${t.hasAttachment && t.sourceMessageId ? `<div class="filelink"><a href="#" class="j-file">${ico('clip')}ver archivo</a></div>` : ''}
        <div class="meta">
          ${t.clientHint ? `<span>cliente: ${esc(displayName(t.clientHint))}</span>` : ''}${accountBadge(t.source, t.waAccount)}
          <label class="due ${overdue ? 'overdue' : ''}">vence <input type="date" class="duedate" value="${dateInput(t.dueAt)}" /></label>
        </div>
        <div class="actions">
          <select class="status">${options}</select>
          <button class="archivebtn">${ico('archive')}Archivar</button>
          <button class="dismiss j-del iconbtn" title="Eliminar" aria-label="Eliminar">${ico('trash')}</button>
        </div>
      </div>
    </div>`);
    tasksSel.bind(card.querySelector('.sel'), String(t.id));
    const fileLink = card.querySelector('.j-file');
    if (fileLink) fileLink.onclick = (e) => { e.preventDefault(); focusAttachment(t.sourceMessageId); };
    card.querySelector('.status').onchange = (e) => setStatus(t.id, e.target.value);
    card.querySelector('.duedate').onchange = (e) => setDue(t.id, e.target.value);
    card.querySelector('.archivebtn').onclick = () => archiveTask(t.id);
    card.querySelector('.j-del').onclick = () => deleteTask(t.id);
    $(`#col-${t.status}`).append(card);
  }
  for (const id of STATUSES) if (!counts[id]) $(`#col-${id}`).append(el('<div class="empty">—</div>'));
  tasksSel.refresh();
}
$('#tasks-search').addEventListener('input', renderTasks);
$('#tasks-bulk-status').onchange = (e) => {
  const v = e.target.value;
  if (v) { e.target.value = ''; bulkTasks(tasksSel, 'status', v); }
};
$('#tasks-bulk-due').onchange = (e) => {
  const v = e.target.value;
  e.target.value = '';
  bulkTasks(tasksSel, 'due', v ? new Date(v + 'T23:59:59').getTime() : null);
};
$('#tasks-bulk-setclient').onclick = () => {
  const v = $('#tasks-bulk-client').value.trim();
  $('#tasks-bulk-client').value = '';
  bulkTasks(tasksSel, 'client', v);
};
$('#tasks-bulk-archive').onclick = () => bulkTasks(tasksSel, 'archive');
$('#tasks-bulk-delete').onclick = () => bulkTasks(tasksSel, 'delete');

// ---- New task ----
$('#new-task').addEventListener('submit', async (e) => {
  e.preventDefault();
  const title = $('#nt-title').value.trim();
  if (!title) return;
  await fetch('/api/tasks', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title, detail: $('#nt-detail').value, client: $('#nt-client').value }),
  });
  $('#nt-title').value = '';
  $('#nt-detail').value = '';
  $('#nt-client').value = '';
  await Promise.all([loadTasks(), loadStats()]);
});

// ---- Archive ----
let archiveItems = [];
const archiveSel = makeSelection('archive', () => filteredArchive().map((t) => String(t.id)));
function filteredArchive() {
  const q = $('#archive-search').value;
  return archiveItems.filter((t) => matches(q, t.title, t.detail, displayName(t.clientHint || '')));
}
async function loadArchive() {
  archiveItems = await (await fetch('/api/archive')).json();
  archiveSel.clear();
  renderArchive();
}
function renderArchive() {
  const list = $('#archive-list');
  list.innerHTML = '';
  const items = filteredArchive();
  if (!items.length) {
    list.append(el(`<div class="empty">${archiveItems.length ? ico('search', 'ico-xl') + 'Nada coincide con la búsqueda.' : ico('archive', 'ico-xl') + 'No hay nada archivado todavía.'}</div>`));
    archiveSel.refresh();
    return;
  }
  for (const t of items) {
    const card = el(`<div class="card selectable">
      <input type="checkbox" class="sel" data-id="${t.id}" />
      <div class="cardbody">
        <div class="title">${esc(t.title)}</div>
        <div class="detail">${esc(t.detail)}</div>
        <div class="meta"><span class="badge b-done">${esc(statusLabel(t.status))}</span>${t.clientHint ? `<span>cliente: ${esc(displayName(t.clientHint))}</span>` : ''}</div>
        <div class="actions">
          <button class="approve j-unarchive">${ico('undo')}Desarchivar</button>
          <button class="dismiss j-del iconbtn" title="Eliminar" aria-label="Eliminar">${ico('trash')}</button>
        </div>
      </div>
    </div>`);
    archiveSel.bind(card.querySelector('.sel'), String(t.id));
    card.querySelector('.j-unarchive').onclick = () => archiveTask(t.id, true);
    card.querySelector('.j-del').onclick = () => deleteTask(t.id);
    list.append(card);
  }
  archiveSel.refresh();
}
$('#archive-search').addEventListener('input', renderArchive);
$('#archive-bulk-unarchive').onclick = () => bulkTasks(archiveSel, 'unarchive');
$('#archive-bulk-delete').onclick = () => bulkTasks(archiveSel, 'delete');

// ---- Pipeline: shared rendering ----
function resetFeeds() {
  for (const id of ['msg', 'vis', 'task']) {
    $(`#${id}-feed`).innerHTML = '';
    $(`#${id}-count`).textContent = '0';
  }
}
const counters = { msgs: 0, vis: 0, tasks: 0 };
function handleEvent(e) {
  if (e.type === 'message') {
    counters.msgs++;
    $('#msg-count').textContent = counters.msgs;
    const who = e.direction === 'outgoing' ? 'yo →' : esc(prettySender(e.sender, e.senderName));
    // Inline thumbnails / PDF chips for any image or PDF attachment we have a file for.
    // Inline thumbnails / PDF chips. Broken images (e.g. WhatsApp media that
    // can't be fetched on demand) remove themselves via onerror.
    const atts = (e.attachments || [])
      .map((a) =>
        a.mime === 'application/pdf'
          ? `<a class="matt pdf" href="/api/attachment?id=${e.id}&i=${a.index}" target="_blank" rel="noopener">${ico('pdf')}PDF</a>`
          : `<img class="matt" loading="lazy" onerror="this.remove()" src="/api/attachment?id=${e.id}&i=${a.index}" alt="" />`,
      )
      .join('');
    // If the body is only the "[attachment: …]" placeholder and we're showing the
    // real attachment, drop the redundant placeholder text.
    const isMarker = /^\[attachment: .*\]$/.test(e.body || '');
    const clip = atts && isMarker ? '' : `<div class="clip">${esc(e.body)}</div>`;
    const when = e.ts ? `<span class="mwhen">${esc(fmtMsgTime(e.ts))}</span>` : '';
    $('#msg-feed').append(el(`<div class="mrow ${e.direction === 'outgoing' ? 'out' : ''}">
      <div class="who"><span>${sourceBadge(e.source)}${accountBadge(e.source, e.waAccount)} ${who}</span><span class="mmeta">${when}${e.hasAttachment ? `<span class="paperclip" title="tiene adjunto">${ico('clip')}</span>` : ''}</span></div>
      ${clip}${atts ? `<div class="matts">${atts}</div>` : ''}</div>`));
  } else if (e.type === 'vision') {
    counters.vis++;
    $('#vis-count').textContent = counters.vis;
    const media =
      e.mime === 'application/pdf'
        ? `<div class="pdfbadge">PDF</div>`
        : `<img loading="lazy" src="/api/attachment?id=${e.messageId}&i=${e.attachmentIndex}" alt="" />`;
    $('#vis-feed').append(el(`<div class="vcard">${media}
      <div class="vname">${esc(e.name || e.mime)} · msj #${e.messageId}</div>
      <div class="vdesc">${esc(e.description)}</div></div>`));
  } else if (e.type === 'task') {
    counters.tasks++;
    $('#task-count').textContent = counters.tasks;
    $('#task-feed').append(el(`<div class="tcard">
      <div class="title">${esc(e.title)}</div>
      <div class="detail">${esc(e.detail)}</div>
      ${e.sourceQuote ? `<div class="quote">${ico('search')}<span>"${esc(e.sourceQuote)}"</span></div>` : ''}
      <div class="who">${e.client ? 'cliente: ' + esc(displayName(e.client)) : ''}</div></div>`));
  }
}

function startStream(url, statusEl, onDone) {
  resetFeeds();
  counters.msgs = counters.vis = counters.tasks = 0;
  statusEl.textContent = 'iniciando…';
  // Run completion is funneled through finish() so a normal end, a server error,
  // and a dropped connection all close the stream and refresh the views exactly
  // once — a mid-run drop no longer freezes the status text forever.
  let finished = false;
  const es = new EventSource(url);
  const finish = (msg) => {
    if (finished) return;
    finished = true;
    if (msg) statusEl.textContent = msg;
    es.close();
    onDone();
  };
  es.onmessage = (ev) => {
    const e = JSON.parse(ev.data);
    if (e.type === 'start') statusEl.textContent = `leyendo ${e.total} mensajes${e.vision ? ', visión activada' : ''}…`;
    else if (e.type === 'batch') statusEl.textContent = `procesados ${e.processed}/${e.total} · ${e.proposed} propuestas…`;
    else if (e.type === 'done') {
      if (!counters.tasks) $('#task-feed').append(el('<div class="empty">No se encontraron tareas.</div>'));
      // The engine processes the NEWEST messages first and is bounded per run —
      // tell the user when older imported history is still queued.
      const left = e.remaining > 0
        ? ` · quedan ${e.remaining} mensajes antiguos en cola — pulsa de nuevo para continuar`
        : '';
      finish(`listo — ${e.proposed} tarea(s) propuesta(s)${left}`);
    } else handleEvent(e);
  };
  es.addEventListener('failed', (ev) => finish('error: ' + JSON.parse(ev.data).message));
  es.onerror = () => finish('se interrumpió la conexión — vuelve a intentarlo');
  return es;
}

$('#process').addEventListener('click', () => {
  // cap=1000 ≈ "analyze every new image/PDF" — the run is already bounded by the
  // number of unprocessed messages per click. The "Imágenes y PDF analizados"
  // counter shows how many were actually analyzed.
  startStream(`/api/process/stream?vision=1&cap=1000`, $('#proc-status'), () => {
    loadInbox();
    loadStats();
  });
});

$('#backfill').addEventListener('click', async () => {
  const count = Number($('#backfill-count').value) || 2000;
  $('#proc-status').textContent = `importando ${count} mensajes…`;
  const r = await (
    await fetch('/api/backfill', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ count }),
    })
  ).json();
  $('#proc-status').textContent = r.ok
    ? `importados ${r.inserted} nuevos (BD ahora ${r.total}). Pulsa "Procesar mensajes nuevos".`
    : `error: ${r.error}`;
  loadStats();
});

// ---- Clients / senders ----
let sendersItems = [];
let clientsFilter = 'all'; // 'all' | '__unclassified__' | a category name
const clientsSel = makeSelection('clients', () => filteredSenders().map((s) => s.handle));
function filteredSenders() {
  const q = $('#clients-search').value;
  return sendersItems.filter((s) => {
    if (!matches(q, s.handle, s.displayName, s.name, s.productNeed)) return false;
    if (clientsFilter === 'all') return true;
    if (clientsFilter === '__unclassified__') return !s.category;
    return s.category === clientsFilter;
  });
}
// Known categories = the two defaults plus any custom ones already in use.
function knownCats() {
  const set = new Set(['Oficina', 'Personal']);
  for (const s of sendersItems) if (s.category) set.add(s.category);
  return [...set].sort((a, b) => a.localeCompare(b, 'es'));
}
function catCounts() {
  const c = { __all__: sendersItems.length, __unclassified__: 0 };
  for (const s of sendersItems) {
    if (!s.category) c.__unclassified__++;
    else c[s.category] = (c[s.category] || 0) + 1;
  }
  return c;
}
function renderClientChips() {
  const box = $('#clients-cats');
  if (!box) return;
  box.innerHTML = '';
  const counts = catCounts();
  const chip = (key, label, n) => {
    const b = el(
      `<button class="chip ${clientsFilter === key ? 'active' : ''}">${esc(label)}${
        n != null ? ` <span class="chip-n">${n}</span>` : ''
      }</button>`,
    );
    b.onclick = () => {
      clientsFilter = key;
      renderClientChips();
      renderSenders();
    };
    return b;
  };
  box.append(chip('all', 'Todos', counts.__all__));
  for (const cat of knownCats()) box.append(chip(cat, cat, counts[cat] || 0));
  box.append(chip('__unclassified__', 'Sin clasificar', counts.__unclassified__));
}
async function loadSenders() {
  sendersItems = await (await fetch('/api/senders')).json();
  clientsSel.clear();
  renderClientChips();
  renderSenders();
}
function renderSenders() {
  const list = $('#senders-list');
  list.innerHTML = '';
  const items = filteredSenders();
  if (!items.length) {
    list.append(el(`<div class="empty">${sendersItems.length ? ico('search', 'ico-xl') + 'Nada coincide con la búsqueda.' : ico('clients', 'ico-xl') + 'Aún no hay remitentes: primero importa algunos mensajes.'}</div>`));
    clientsSel.refresh();
    return;
  }
  for (const s of items) {
    // Is the handle a phone/email/JID identifier, or a free-text client name
    // (typed into a task)? Free-text names are shown directly, not as "sin nombre".
    const isId = /@/.test(s.handle) || /^\+?[\d][\d\s().-]*$/.test(s.handle);
    const resolved = s.displayName && s.displayName !== s.handle ? s.displayName : isId ? '' : s.handle;
    const cats = knownCats();
    const catOpts = ['<option value="">Sin clasificar</option>']
      .concat(cats.map((c) => `<option value="${esc(c)}" ${s.category === c ? 'selected' : ''}>${esc(c)}</option>`))
      .concat('<option value="__new__">+ Nueva…</option>')
      .join('');
    const card = el(`<div class="card sender">
      <input type="checkbox" class="sel" data-id="${esc(s.handle)}" />
      ${isId ? `<span class="handle">${esc(s.handle)}</span>` : ''}
      ${resolved ? `<span class="rn">${esc(resolved)}</span>` : '<span class="rn unnamed">sin nombre</span>'}
      <span class="count">${s.count ? s.count + ' msjs' : 'tarea'}</span>
      <input class="nm" placeholder="${resolved ? 'cambiar nombre' : 'nombre'}" value="${esc(s.name || '')}" />
      <input class="pn" placeholder="qué compran / necesitan" value="${esc(s.productNeed || '')}" />
      <select class="cat" title="Categoría">${catOpts}</select>
      <button class="approve save">Guardar</button>
      <span class="saved"></span>
    </div>`);
    clientsSel.bind(card.querySelector('.sel'), s.handle);
    card.querySelector('.cat').onchange = async (e) => {
      let val = e.target.value;
      if (val === '__new__') {
        val = ((await askText('Nueva categoría (p. ej. Proveedor):')) || '').trim();
        if (!val) { e.target.value = s.category || ''; return; }
      }
      await fetch('/api/clients/category', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ handle: s.handle, category: val }),
      });
      s.category = val;
      renderClientChips();
      renderSenders(); // reflect the new category / custom option / active filter
    };
    card.querySelector('.save').onclick = async () => {
      const name = card.querySelector('.nm').value.trim();
      if (!name) return;
      await fetch('/api/clients', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ handle: s.handle, name, productNeed: card.querySelector('.pn').value.trim() }),
      });
      card.querySelector('.saved').textContent = '✓ guardado';
      await loadNames();
      // Re-render the views that show names so the change shows immediately.
      await Promise.all([loadInbox(), loadTasks()]);
    };
    list.append(card);
  }
  clientsSel.refresh();
}
$('#clients-search').addEventListener('input', renderSenders);
$('#clients-bulk-delete').onclick = () => bulkClients(clientsSel, 'delete');
$('#clients-autoclass').onclick = async () => {
  const btn = $('#clients-autoclass');
  const st = $('#clients-autoclass-status');
  btn.disabled = true;
  st.textContent = 'clasificando… (puede tardar)';
  try {
    const r = await (await fetch('/api/clients/autoclassify', { method: 'POST' })).json();
    if (r.error) st.textContent = r.error;
    else {
      st.textContent = `✓ ${r.classified} clasificados`;
      await loadSenders();
    }
  } catch {
    st.textContent = 'no se pudo clasificar';
  }
  btn.disabled = false;
};

// ---- Adjuntos (persistent attachment gallery) ----
let attItems = [];
let attOffset = 0;
let attLoading = false;
let attDone = false;
let attFocusId = null; // message whose file a task deep-link is highlighting
const ATT_PAGE = 120;

// Jump from a task card straight to its source file in the gallery.
async function focusAttachment(messageId) {
  document.querySelectorAll('.tab').forEach((b) => b.classList.toggle('active', b.dataset.tab === 'attachments'));
  document.querySelectorAll('.panel').forEach((p) => p.classList.toggle('active', p.id === 'attachments'));
  attFocusId = Number(messageId);
  await loadAttachments(true);
  await renderFocus();
}

async function renderFocus() {
  const box = $('#att-focus');
  if (!box) return;
  box.innerHTML = '';
  box.hidden = true;
  if (!attFocusId) return;
  try {
    const r = await (await fetch(`/api/attachments/locate?messageId=${attFocusId}`)).json();
    const items = r.attachments || [];
    if (!items.length) return;
    box.hidden = false;
    const head = el(
      `<div class="att-focus-head"><span>${ico('clip')}Archivo de la tarea</span><button class="att-focus-clear">quitar</button></div>`,
    );
    head.querySelector('.att-focus-clear').onclick = () => {
      attFocusId = null;
      renderFocus();
    };
    box.append(head);
    const grid = el('<div class="att-grid"></div>');
    items.forEach((a, i) => grid.append(attCard(a, items, i)));
    box.append(grid);
    box.scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch {
    /* focus is best-effort */
  }
}

async function loadAttachments(reset) {
  if (reset) {
    attItems = [];
    attOffset = 0;
    attDone = false;
    $('#att-grid').innerHTML = '';
  }
  if (attLoading || attDone) return;
  attLoading = true;
  $('#att-status').textContent = 'cargando…';
  try {
    const r = await (await fetch(`/api/attachments?limit=${ATT_PAGE}&offset=${attOffset}`)).json();
    attItems.push(...(r.attachments || []));
    attOffset += ATT_PAGE; // server paginates by message row; advance by the page size
    attDone = !!r.done;
  } catch {
    attLoading = false;
    $('#att-status').textContent = 'no se pudieron cargar';
    return;
  }
  attLoading = false;
  $('#att-status').textContent = '';
  renderAttachments();
}

// Save a file WITHOUT navigating the window. A plain <a href> to the attachment
// URL makes the Electron top-level frame navigate to the file and white-screen
// (the shell has no will-navigate guard). Fetch the bytes as a blob and save via
// a temporary object-URL download instead — same-origin, never navigates.
async function downloadFile(url, filename) {
  try {
    const resp = await fetch(url);
    if (!resp.ok) throw new Error('HTTP ' + resp.status);
    const blob = await resp.blob();
    const objUrl = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = objUrl;
    a.download = filename || 'archivo';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(objUrl), 5000);
  } catch {
    alert('No se pudo descargar el archivo.');
  }
}

function attWho(a) {
  return a.sender === 'me'
    ? 'yo →'
    : esc(displayName(a.sender) || a.senderName || prettySender(a.sender, a.senderName));
}

// The actual media element for a downloaded/available attachment.
// "lista-de-precios.xlsx" → "XLSX". A generic tile that just says "archivo"
// repeats the filename underneath it and tells you nothing.
function attExt(a) {
  const m = /\.([a-z0-9]{2,5})$/i.exec(a.filename || '');
  return m ? m[1].toUpperCase() : 'Archivo';
}

function attMediaHtml(a, src) {
  const label = esc(a.filename || a.category || 'archivo');
  if (a.category === 'image') return `<img class="att-thumb" loading="lazy" src="${src}" alt="${label}" />`;
  if (a.category === 'video') return `<video class="att-thumb" controls preload="metadata" src="${src}"></video>`;
  if (a.category === 'pdf')
    return `<a class="att-thumb att-icon att-file att-pdf" href="${src}" target="_blank" rel="noopener">${ico('pdf', 'ico-xl')}<span>PDF</span></a>`;
  // Chromium drops the <audio> timeline below ~200px, so a tile-width player has
  // no scrubber and no duration — unusable. The tile is the affordance; clicking
  // it opens the preview overlay, which plays the file full size on its own.
  if (a.category === 'audio')
    return `<div class="att-thumb att-icon att-file att-audio">${ico('audio', 'ico-xl')}<span>Audio</span></div>`;
  return `<div class="att-thumb att-icon att-file">${ico('file', 'ico-xl')}<span>${esc(attExt(a))}</span></div>`;
}

// When an <img>/<video> in a card fails to load, replace it with a placeholder.
function attWireError(card, label) {
  const m = card.querySelector('img.att-thumb, video.att-thumb');
  if (m)
    m.addEventListener('error', () => {
      const box = card.querySelector('.att-media');
      if (box) box.innerHTML = `<div class="att-thumb att-icon att-unavail">${ico('ban', 'ico-xl')}<span>${label}</span></div>`;
    });
}

function attCard(a, list, idx) {
  const src = `/api/attachment?id=${a.id}&i=${a.i}`;
  // state: ok = on disk; fetch = WhatsApp not downloaded (load on demand);
  // fda = iMessage file behind Full Disk Access; missing = not on this Mac.
  const st = a.state || (a.hasFile ? 'ok' : a.source === 'whatsapp' ? 'fetch' : 'missing');
  let media;
  if (st === 'ok') media = attMediaHtml(a, src);
  else if (st === 'fetch')
    media = `<div class="att-thumb att-icon att-unavail att-fetch"><button class="att-load">${ico('download')}Ver archivo</button><span>guardado en WhatsApp</span></div>`;
  else if (st === 'fda')
    media = `<div class="att-thumb att-icon att-unavail">${ico('lock', 'ico-xl')}<span>Activa Acceso total al disco</span></div>`;
  else media = `<div class="att-thumb att-icon att-unavail">${ico('ban', 'ico-xl')}<span>No está en este Mac</span></div>`;
  const name = a.filename || a.category;
  // Download only makes sense when the file is (or can be) fetched.
  const canDownload = st === 'ok' || st === 'fetch';
  const card = el(`<div class="att-card">
    <div class="att-media">${media}<button class="att-expand" title="Vista previa" aria-label="Vista previa">${ico('expand')}</button></div>
    <div class="att-meta">
      <div class="att-name" title="${esc(name)}">${esc(name)}</div>
      <div class="att-sub">${sourceBadge(a.source)}${accountBadge(a.source, a.waAccount)} ${attWho(a)}</div>
      ${a.chatName ? `<div class="att-sub att-where" title="${esc(a.chatName)}">${esc(a.chatName)}</div>` : ''}
      <div class="att-sub att-when">${esc(fmtMsgTime(a.ts))}</div>
    </div>
    ${canDownload ? `<a class="att-dl" href="${src}&download=1" title="Descargar una copia" aria-label="Descargar una copia">${ico('download')}</a>` : ''}
  </div>`);

  // Open the Quick-Look-style preview from the ⤢ button, or by clicking the tile
  // (but not on a control/link inside it — let video/audio/PDF behave normally).
  const openHere = () => openLightbox(list || [a], list ? idx : 0);
  card.querySelector('.att-expand').onclick = (e) => { e.preventDefault(); e.stopPropagation(); openHere(); };
  const mediaBox = card.querySelector('.att-media');
  mediaBox.addEventListener('click', (e) => {
    if (e.target.closest('button, a, video, audio')) return;
    openHere();
  });

  if (st === 'ok') attWireError(card, 'no disponible');

  // WhatsApp media not downloaded yet: fetch on demand only when the user asks
  // (auto-fetching a whole gallery of old messages is slow and often fails).
  const loadBtn = card.querySelector('.att-load');
  if (loadBtn)
    loadBtn.onclick = () => {
      const box = card.querySelector('.att-media');
      box.innerHTML = `<div class="att-thumb att-icon">${ico('download', 'ico-xl')}<span>descargando…</span></div>`;
      // A cache-busting param forces a fresh request that triggers the download.
      const freshSrc = `${src}&t=${Date.now()}`;
      box.innerHTML = attMediaHtml(a, freshSrc);
      attWireError(card, 'no disponible — conecta WhatsApp');
    };

  // Download without navigating the window (would white-screen in Electron).
  const dl = card.querySelector('.att-dl');
  if (dl)
    dl.onclick = (e) => {
      e.preventDefault();
      downloadFile(`${src}&download=1`, name);
    };
  return card;
}

function renderAttachments() {
  const q = $('#att-search').value;
  const typ = $('#att-type').value;
  const grid = $('#att-grid');
  grid.innerHTML = '';
  const items = attItems.filter(
    (a) =>
      (!typ || a.category === typ) &&
      matches(q, a.filename, displayName(a.sender), a.senderName, a.chatName, a.mime),
  );
  $('#att-count').textContent = items.length ? `${items.length} archivo(s)` : '';
  if (!items.length) {
    grid.append(
      el(
        `<div class="empty">${attItems.length ? ico('search', 'ico-xl') + 'Nada coincide con la búsqueda.' : ico('clip', 'ico-xl') + 'No hay adjuntos en los chats incluidos todavía.'}</div>`,
      ),
    );
  } else {
    items.forEach((a, i) => grid.append(attCard(a, items, i)));
  }
  $('#att-more').hidden = attDone;
}

$('#att-search').addEventListener('input', renderAttachments);
$('#att-type').addEventListener('change', renderAttachments);
$('#att-more').addEventListener('click', () => loadAttachments(false));

// ---- Quick-Look-style preview (lightbox) ----
let qlList = [];
let qlIdx = 0;

// The large preview element for an available file.
function qlOkMedia(a, src) {
  if (a.category === 'image') return `<img class="ql-media" src="${src}" alt="" />`;
  if (a.category === 'video') return `<video class="ql-media" controls autoplay src="${src}"></video>`;
  if (a.category === 'audio')
    return `<div class="ql-audiobox">${ico('audio', 'ico-xl')}<audio class="ql-audio" controls autoplay src="${src}"></audio></div>`;
  if (a.category === 'pdf') return `<iframe class="ql-frame" src="${src}"></iframe>`;
  return `<div class="ql-note">${ico('file', 'ico-xl')}<div>Este tipo de archivo no se puede previsualizar. Usa “Descargar copia”.</div></div>`;
}

function qlStageHtml(a, src, st) {
  if (st === 'ok') return qlOkMedia(a, src);
  if (st === 'fetch') return `<div class="ql-note">${ico('download', 'ico-xl')}<button class="ql-load">Descargar de WhatsApp para ver</button></div>`;
  if (st === 'fda')
    return `<div class="ql-note">${ico('lock', 'ico-xl')}<div>Activa <b>Acceso total al disco</b> para ver los archivos de iMessage.</div></div>`;
  return `<div class="ql-note">${ico('ban', 'ico-xl')}<div>Este archivo no está en este Mac (se borró o está en iCloud).</div></div>`;
}

function qlRender() {
  const a = qlList[qlIdx];
  const stage = $('#ql-overlay .ql-stage');
  const cap = $('#ql-overlay .ql-caption');
  if (!a || !stage) return;
  const src = `/api/attachment?id=${a.id}&i=${a.i}`;
  const st = a.state || (a.hasFile ? 'ok' : a.source === 'whatsapp' ? 'fetch' : 'missing');
  stage.innerHTML = qlStageHtml(a, src, st);

  // Load-on-demand WhatsApp file inside the preview.
  const loadBtn = stage.querySelector('.ql-load');
  if (loadBtn)
    loadBtn.onclick = () => {
      stage.innerHTML = `<div class="ql-note">${ico('download', 'ico-xl')}<div>Descargando…</div></div>`;
      stage.innerHTML = qlOkMedia(a, `${src}&t=${Date.now()}`);
      const m = stage.querySelector('img.ql-media, video.ql-media');
      if (m) m.addEventListener('error', () => {
        stage.innerHTML = `<div class="ql-note">${ico('ban', 'ico-xl')}<div>No disponible. Conecta WhatsApp e inténtalo de nuevo.</div></div>`;
      });
    };
  const okMedia = stage.querySelector('img.ql-media, video.ql-media');
  if (st === 'ok' && okMedia)
    okMedia.addEventListener('error', () => {
      stage.innerHTML = `<div class="ql-note">${ico('ban', 'ico-xl')}<div>No se pudo cargar el archivo.</div></div>`;
    });

  const name = a.filename || a.category;
  const canDownload = st === 'ok' || st === 'fetch';
  cap.innerHTML =
    `<div class="ql-name" title="${esc(name)}">${esc(name)}</div>` +
    `<div class="ql-sub">${sourceBadge(a.source)}${accountBadge(a.source, a.waAccount)} ${attWho(a)}` +
    `${a.chatName ? ` · ${esc(a.chatName)}` : ''} · ${esc(fmtMsgTime(a.ts))}</div>` +
    `<div class="ql-tools">` +
    `${canDownload ? `<button class="ql-dl">${ico('download')}Descargar copia</button>` : ''}` +
    `${a.category === 'pdf' && st === 'ok' ? `<a class="ql-open" href="${src}" target="_blank" rel="noopener">Abrir en pestaña</a>` : ''}` +
    `<span class="ql-pos">${qlIdx + 1} / ${qlList.length}</span></div>`;
  const dlb = cap.querySelector('.ql-dl');
  if (dlb) dlb.onclick = () => downloadFile(`${src}&download=1`, name);

  $('#ql-overlay .ql-prev').disabled = qlIdx <= 0;
  $('#ql-overlay .ql-next').disabled = qlIdx >= qlList.length - 1;
}

function openLightbox(list, idx) {
  qlList = Array.isArray(list) && list.length ? list : [];
  qlIdx = Math.max(0, Math.min(idx || 0, qlList.length - 1));
  if (!qlList.length) return;
  const ov = $('#ql-overlay');
  ov.hidden = false;
  ov.style.display = 'flex';
  qlRender();
}

function closeLightbox() {
  const ov = $('#ql-overlay');
  if (!ov) return;
  ov.hidden = true;
  ov.style.display = 'none';
  const stage = ov.querySelector('.ql-stage');
  if (stage) stage.innerHTML = ''; // stop any playing video/audio
}

function qlNav(delta) {
  const n = qlIdx + delta;
  if (n < 0 || n >= qlList.length) return;
  qlIdx = n;
  qlRender();
}

$('#ql-overlay .ql-close').onclick = closeLightbox;
$('#ql-overlay .ql-prev').onclick = () => qlNav(-1);
$('#ql-overlay .ql-next').onclick = () => qlNav(1);
$('#ql-overlay').addEventListener('click', (e) => {
  if (e.target.id === 'ql-overlay') closeLightbox(); // click the backdrop
});
document.addEventListener('keydown', (e) => {
  const ov = $('#ql-overlay');
  if (!ov || ov.hidden) return;
  if (e.key === 'Escape') { e.preventDefault(); closeLightbox(); }
  else if (e.key === 'ArrowLeft') { e.preventDefault(); qlNav(-1); }
  else if (e.key === 'ArrowRight') { e.preventDefault(); qlNav(1); }
  else if (e.key === ' ' && !e.target.closest('video, audio, button, a, input, textarea')) {
    e.preventDefault();
    closeLightbox(); // spacebar closes, like Quick Look
  }
});

// ---- Mensajes: a chat-style view of what is actually in the DB ----
//
// Deliberately shows every conversation, including ones excluded from ingestion
// in Ajustes: the point of the tab is to reveal what really got stored, and
// excluded chats can still hold thousands of rows imported earlier. They carry a
// "no se importa" badge instead of being hidden.

const MSG_PAGE = 100;
const MSG_MAX_SEL = 200; // must match SELECTION_MAX_MESSAGES in extract/pipeline.ts

let msgChats = [];
let msgChatId = null;
let msgRows = []; // the loaded window of the open chat, chronological
let msgSel = new Set();
let msgHasOlder = false;
let msgHasNewer = false;
let msgLoading = false;
let msgAnchorId = null; // scroll target after a search hit (exact message)
let msgAnchorTs = null; // scroll target after a date jump (first message of that day)
let msgLastPicked = null; // index in msgRows, for shift-click ranges
let msgFilters = { find: '', unproc: false, files: false };
let msgHits = []; // global search results, shown above the chat list

const msgDayKey = (ms) => new Date(ms).toLocaleDateString('es-CL');
const msgDayLabel = (ms) =>
  new Date(ms).toLocaleDateString('es', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
const msgTime = (ms) => new Date(ms).toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit' });

/** Short relative-ish stamp for the chat list: time today, date otherwise. */
function msgWhen(ms) {
  if (!ms) return '';
  const d = new Date(ms);
  return msgDayKey(ms) === msgDayKey(Date.now())
    ? msgTime(ms)
    : d.toLocaleDateString('es', { day: '2-digit', month: '2-digit', year: '2-digit' });
}

function msgChatLabel(c) {
  return c.displayName || 'Sin nombre';
}

// ---- sidebar ----

async function loadMsgChats() {
  const r = await (await fetch('/api/messages/chats')).json();
  msgChats = r.chats || [];
  renderMsgSide();
}

async function runMsgSearch(q) {
  if (!q || q.trim().length < 2) {
    msgHits = [];
    renderMsgSide();
    return;
  }
  const r = await (await fetch(`/api/messages/search?q=${encodeURIComponent(q.trim())}&limit=40`)).json();
  msgHits = r.hits || [];
  renderMsgSide();
}

function renderMsgSide() {
  const q = $('#msg-search').value.trim();
  const box = $('#msg-chats');
  const shown = msgChats.filter((c) => matches(q, msgChatLabel(c), c.chatId));

  let html = '';
  if (msgHits.length) {
    html += `<div class="msg-sec">Mensajes que coinciden (${msgHits.length})</div>`;
    html += msgHits
      .map(
        (h) => `<button class="msg-hit" data-hit="${h.id}">
          <span class="msg-hit-top">${sourceBadge(h.source)}${esc(h.senderName || prettySender(h.sender, h.senderName))}
            <span class="msg-chat-when">${esc(msgWhen(h.ts))}</span></span>
          <span class="msg-hit-body">${esc((h.body || '').slice(0, 140))}</span>
        </button>`,
      )
      .join('');
    html += `<div class="msg-sec">Conversaciones (${shown.length})</div>`;
  }

  html += shown.length
    ? shown
        .map((c) => {
          const preview = (c.lastDirection === 'outgoing' ? 'Yo: ' : '') + (c.lastBody || '(archivo)');
          return `<button class="msg-chat${c.chatId === msgChatId ? ' active' : ''}" data-chat="${esc(c.chatId)}">
            <span class="msg-chat-top">
              <span class="msg-chat-name">${esc(msgChatLabel(c))}</span>
              <span class="msg-chat-when">${esc(msgWhen(c.lastTs))}</span>
            </span>
            <span class="msg-chat-prev">${sourceBadge(c.source)}${accountBadge(c.source, c.waAccount)}${esc(preview.slice(0, 90))}</span>
            <span class="msg-chat-counts">
              <span>${c.total} msj</span>
              ${c.unprocessed ? `<span class="msg-warn">${c.unprocessed} sin procesar</span>` : ''}
              ${c.withAttachments ? `<span>${c.withAttachments} adj.</span>` : ''}
              ${c.included ? '' : '<span class="msg-excl">no se importa</span>'}
            </span>
          </button>`;
        })
        .join('')
    : `<div class="msg-empty">Ninguna conversación coincide.</div>`;

  box.innerHTML = html;
  box.querySelectorAll('.msg-chat').forEach((b) => {
    b.onclick = () => openMsgChat(b.dataset.chat);
  });
  box.querySelectorAll('.msg-hit').forEach((b) => {
    b.onclick = () => jumpToMessage(Number(b.dataset.hit));
  });
}

/** Open the conversation a search hit belongs to, anchored on that message. */
async function jumpToMessage(id) {
  const loc = await (await fetch(`/api/messages/locate?id=${id}`)).json();
  if (!loc.chatId) return;
  msgAnchorId = id;
  await openMsgChat(loc.chatId, loc.ts);
}

// ---- thread ----

function msgQuery(extra) {
  const p = new URLSearchParams({ chatId: msgChatId, limit: String(MSG_PAGE), ...extra });
  if (msgFilters.find) p.set('q', msgFilters.find);
  if (msgFilters.unproc) p.set('unprocessed', '1');
  if (msgFilters.files) p.set('withFiles', '1');
  return `/api/messages?${p.toString()}`;
}

async function openMsgChat(chatId, anchorTs) {
  // Re-entered for three reasons: a different chat, a filter change, or a date
  // jump. Only the first invalidates the selection — the other two stay within
  // the same conversation, where keeping what you picked is the useful behaviour.
  if (chatId !== msgChatId) msgSel.clear();
  if (!anchorTs) msgAnchorTs = null; // don't let a previous jump's anchor linger
  msgChatId = chatId;
  msgRows = [];
  msgLastPicked = null;
  const chat = msgChats.find((c) => c.chatId === chatId);
  $('#msg-title').textContent = chat ? msgChatLabel(chat) : 'Conversación';
  $('#msg-tools').hidden = false;
  renderMsgSide();

  const url = anchorTs
    ? msgQuery({ dir: 'around', cursorTs: String(anchorTs), cursorId: '0' })
    : msgQuery({});
  msgLoading = true;
  $('#msg-thread').innerHTML = `<div class="msg-empty">Cargando…</div>`;
  try {
    const r = await (await fetch(url)).json();
    msgRows = r.messages || [];
    msgHasOlder = !!r.hasOlder;
    msgHasNewer = !!r.hasNewer;
    renderMsgStats(r.stats);
    renderMsgThread(msgAnchorId || msgAnchorTs ? 'anchor' : 'bottom');
    renderMsgSelection();
  } finally {
    msgLoading = false;
  }
}

function renderMsgStats(s) {
  if (!s) return;
  $('#msg-stats').innerHTML =
    `<span>${s.total} mensajes</span>` +
    `<span class="${s.unprocessed ? 'msg-warn' : ''}">${s.unprocessed || 0} sin procesar</span>` +
    `<span>${s.withAttachments || 0} con adjuntos</span>`;
}

/** Load the next page in one direction and splice it onto the loaded window. */
async function loadMsgPage(dir) {
  if (msgLoading || !msgChatId) return;
  if (dir === 'older' ? !msgHasOlder : !msgHasNewer) return;
  const edge = dir === 'older' ? msgRows[0] : msgRows[msgRows.length - 1];
  if (!edge) return;

  msgLoading = true;
  const box = $('#msg-thread');
  // Distance from the bottom is stable across a prepend; scrollTop is not.
  const fromBottom = box.scrollHeight - box.scrollTop;
  try {
    const r = await (
      await fetch(msgQuery({ dir, cursorTs: String(edge.ts), cursorId: String(edge.id) }))
    ).json();
    const rows = r.messages || [];
    if (dir === 'older') {
      msgRows = [...rows, ...msgRows];
      msgHasOlder = !!r.hasOlder;
      renderMsgThread({ fromBottom });
    } else {
      msgRows = [...msgRows, ...rows];
      msgHasNewer = !!r.hasNewer;
      renderMsgThread({ top: box.scrollTop });
    }
  } finally {
    msgLoading = false;
  }
}

function msgAttHtml(m) {
  if (!m.attachments.length) return '';
  return (
    `<div class="msg-atts">` +
    m.attachments
      .map((a, i) => {
        const src = `/api/attachment?id=${a.id}&i=${a.i}`;
        const st = a.state || (a.hasFile ? 'ok' : a.source === 'whatsapp' ? 'fetch' : 'missing');
        const label = esc(a.filename || a.category || 'archivo');
        let inner;
        if (st === 'ok' && a.category === 'image')
          inner = `<img loading="lazy" src="${src}" alt="${label}" />`;
        else if (st === 'ok' && a.category === 'video')
          inner = `<video preload="metadata" src="${src}"></video>`;
        else if (st === 'fda') inner = `${ico('lock')}<span>Acceso total al disco</span>`;
        else if (st === 'missing') inner = `${ico('ban')}<span>No está en este Mac</span>`;
        else if (st === 'fetch') inner = `${ico('download')}<span>${label}</span>`;
        else if (a.category === 'pdf') inner = `${ico('pdf')}<span>${label}</span>`;
        else if (a.category === 'audio') inner = `${ico('audio')}<span>${label}</span>`;
        else inner = `${ico('file')}<span>${label}</span>`;
        const kind = st === 'ok' && (a.category === 'image' || a.category === 'video') ? 'media' : 'chip';
        return `<button class="msg-att msg-att-${kind}" data-att="${i}" title="${label}">${inner}</button>`;
      })
      .join('') +
    `</div>`
  );
}

function msgRowHtml(m, showWho) {
  const out = m.direction === 'outgoing';
  const picked = msgSel.has(m.id);
  const who = out ? '' : displayName(m.sender) || m.senderName || prettySender(m.sender, m.senderName);
  return `<div class="msg-row ${out ? 'out' : 'in'}${picked ? ' picked' : ''}" data-id="${m.id}">
    <input class="msg-pick" type="checkbox" ${picked ? 'checked' : ''} aria-label="Seleccionar mensaje" />
    <div class="msg-bubble">
      ${showWho && who ? `<div class="msg-who">${esc(who)}</div>` : ''}
      ${msgAttHtml(m)}
      ${m.body ? `<div class="msg-text">${esc(m.body)}</div>` : ''}
      <div class="msg-meta">
        <span>${esc(msgTime(m.ts))}</span>
        ${m.processed ? '' : '<span class="msg-flag warn">sin procesar</span>'}
        ${m.tasks.length ? `<span class="msg-flag ok">${m.tasks.length} tarea${m.tasks.length > 1 ? 's' : ''}</span>` : ''}
        <button class="msg-info" title="Detalles técnicos" aria-label="Detalles técnicos">${ico('diag')}</button>
      </div>
    </div>
  </div>`;
}

function renderMsgThread(scroll) {
  const box = $('#msg-thread');
  if (!msgRows.length) {
    box.innerHTML = `<div class="msg-empty">${
      msgFilters.find || msgFilters.unproc || msgFilters.files
        ? 'Ningún mensaje coincide con los filtros.'
        : 'Esta conversación no tiene mensajes guardados.'
    }</div>`;
    return;
  }

  let html = msgHasOlder ? `<div class="msg-more">Desplázate para cargar mensajes anteriores…</div>` : '';
  let day = '';
  let prevSender = null;
  for (const m of msgRows) {
    const k = msgDayKey(m.ts);
    if (k !== day) {
      day = k;
      prevSender = null;
      html += `<button class="msg-day" data-day="${esc(k)}" title="Seleccionar todo este día">${esc(msgDayLabel(m.ts))}</button>`;
    }
    // Only label the first message of a run from the same person.
    html += msgRowHtml(m, m.sender !== prevSender);
    prevSender = m.sender;
  }
  if (msgHasNewer) html += `<div class="msg-more">Desplázate para cargar mensajes posteriores…</div>`;
  box.innerHTML = html;
  wireMsgThread();

  if (scroll === 'bottom') box.scrollTop = box.scrollHeight;
  else if (scroll === 'anchor') {
    // A search hit anchors on its exact message; a date jump anchors on the
    // first message at or after local midnight of that day. Without the second
    // case the jump loads the right window but lands at the bottom of it, i.e.
    // on a later day than the one that was asked for.
    let id = msgAnchorId;
    if (!id && msgAnchorTs !== null) {
      const hit = msgRows.find((m) => m.ts >= msgAnchorTs);
      id = hit ? hit.id : null;
    }
    const target = id && box.querySelector(`.msg-row[data-id="${id}"]`);
    if (target) {
      target.scrollIntoView({ block: 'center' });
      target.classList.add('flash');
    } else box.scrollTop = box.scrollHeight;
    msgAnchorId = null;
    msgAnchorTs = null;
  } else if (scroll && typeof scroll.fromBottom === 'number') {
    box.scrollTop = box.scrollHeight - scroll.fromBottom;
  } else if (scroll && typeof scroll.top === 'number') {
    box.scrollTop = scroll.top;
  }
}

function wireMsgThread() {
  const box = $('#msg-thread');
  box.querySelectorAll('.msg-row').forEach((row) => {
    const id = Number(row.dataset.id);
    const cb = row.querySelector('.msg-pick');
    cb.addEventListener('click', (e) => {
      const idx = msgRows.findIndex((m) => m.id === id);
      if (e.shiftKey && msgLastPicked !== null && idx !== -1) {
        const [a, b] = msgLastPicked < idx ? [msgLastPicked, idx] : [idx, msgLastPicked];
        msgSelAdd(msgRows.slice(a, b + 1).map((m) => m.id), cb.checked);
      } else {
        msgSelAdd([id], cb.checked);
      }
      msgLastPicked = idx;
      renderMsgSelection();
    });

    row.querySelectorAll('.msg-att').forEach((btn) => {
      btn.onclick = () => {
        const m = msgRows.find((x) => x.id === id);
        if (m) openLightbox(m.attachments, Number(btn.dataset.att));
      };
    });

    const info = row.querySelector('.msg-info');
    if (info) info.onclick = () => showMsgDetails(id);
  });

  box.querySelectorAll('.msg-day').forEach((btn) => {
    btn.onclick = () => {
      const ids = msgRows.filter((m) => msgDayKey(m.ts) === btn.dataset.day).map((m) => m.id);
      // Toggle: if the whole day is already selected, clear it.
      const allIn = ids.every((i) => msgSel.has(i));
      msgSelAdd(ids, !allIn);
      // renderMsgSelection repaints every row's class and checkbox in place, so
      // no thread re-render (and no scroll jump) is needed here.
      renderMsgSelection();
    };
  });
}

/** Add or remove ids, stopping at the hard cap. Hitting the cap is reported by
 *  the "(máx. N)" suffix the action bar renders, not by a separate alert. */
function msgSelAdd(ids, on) {
  for (const id of ids) {
    if (!on) {
      msgSel.delete(id);
      continue;
    }
    if (msgSel.size >= MSG_MAX_SEL && !msgSel.has(id)) break;
    msgSel.add(id);
  }
}

/** Reflect the selection in the rows and the floating action bar. */
function renderMsgSelection() {
  const box = $('#msg-thread');
  box.querySelectorAll('.msg-row').forEach((row) => {
    const on = msgSel.has(Number(row.dataset.id));
    row.classList.toggle('picked', on);
    const cb = row.querySelector('.msg-pick');
    if (cb.checked !== on) cb.checked = on;
  });

  const bar = $('#msg-bar');
  const n = msgSel.size;
  bar.hidden = n === 0;
  if (!n) return;
  const files = msgRows
    .filter((m) => msgSel.has(m.id))
    .reduce((sum, m) => sum + m.attachments.filter((a) => a.category === 'image' || a.category === 'pdf').length, 0);
  $('#msg-selcount').textContent =
    `${n} seleccionado${n > 1 ? 's' : ''}${n >= MSG_MAX_SEL ? ` (máx. ${MSG_MAX_SEL})` : ''}`;
  const opt = $('#msg-visopt');
  opt.hidden = files === 0;
  $('#msg-vislabel').textContent = `analizar ${files} archivo${files > 1 ? 's' : ''}`;
}

function clearMsgSelection() {
  msgSel.clear();
  msgLastPicked = null;
  renderMsgSelection();
}

/** Raw stored values for one message, for checking what actually landed. */
function showMsgDetails(id) {
  const m = msgRows.find((x) => x.id === id);
  if (!m) return;
  const rows = [
    ['id interno', m.id],
    ['id de origen', m.sourceMsgId],
    ['fuente', m.source + (m.waAccount ? ` (${m.waAccount})` : '')],
    ['conversación', m.chatId || '—'],
    ['remitente', m.sender || '—'],
    ['fecha', new Date(m.ts).toLocaleString('es')],
    ['analizado por la IA', m.processed ? 'sí' : 'no'],
    ['adjuntos', m.attachments.length ? m.attachments.map((a) => `${a.filename || a.category} (${a.state})`).join(', ') : 'ninguno'],
    ['tareas generadas', m.tasks.length ? m.tasks.map((t) => `#${t.id} ${t.title}`).join(' · ') : 'ninguna'],
  ];
  msgModal(
    'Detalles del mensaje',
    `<table class="msg-detail">${rows
      .map(([k, v]) => `<tr><th>${esc(String(k))}</th><td>${esc(String(v))}</td></tr>`)
      .join('')}</table>`,
  );
}

/** Small dismissible modal, same shell as askText(). */
function msgModal(title, bodyHtml) {
  const ov = el(`<div class="overlay askmodal" style="display:flex;">
    <div class="modal msg-modal">
      <div class="mem-head"><strong>${esc(title)}</strong>
        <button class="msg-modal-x" aria-label="Cerrar">${ico('close')}</button></div>
      <div class="msg-modal-body">${bodyHtml}</div>
      <div class="modal-actions"><button class="primary msg-modal-ok">Cerrar</button></div>
    </div>
  </div>`);
  document.body.append(ov);
  const close = () => ov.remove();
  ov.querySelector('.msg-modal-x').onclick = close;
  ov.querySelector('.msg-modal-ok').onclick = close;
  ov.addEventListener('click', (e) => {
    if (e.target === ov) close();
  });
  return ov;
}

// ---- selection actions ----

async function msgAnalyze() {
  const ids = [...msgSel];
  if (!ids.length) return;
  const btn = $('#msg-analyze');
  btn.disabled = true;
  const was = btn.innerHTML;
  btn.innerHTML = 'Analizando…';
  try {
    const r = await (
      await fetch('/api/messages/reanalyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids, vision: $('#msg-vision').checked }),
      })
    ).json();

    if (r.error) {
      msgModal('No se pudo analizar', `<p class="hint">${esc(r.error)}</p>`);
      return;
    }

    const head = `<p class="hint">${r.messages} mensaje${r.messages > 1 ? 's' : ''} analizado${
      r.messages > 1 ? 's' : ''
    }${r.filesAnalyzed ? `, ${r.filesAnalyzed} archivo${r.filesAnalyzed > 1 ? 's' : ''} leído${r.filesAnalyzed > 1 ? 's' : ''}` : ''}.</p>`;

    let body;
    if (r.proposed.length) {
      body =
        head +
        `<p><b>${r.proposed.length} tarea${r.proposed.length > 1 ? 's' : ''} nueva${
          r.proposed.length > 1 ? 's' : ''
        }</b>, ya en la Bandeja:</p><ul class="msg-proposed">` +
        r.proposed
          .map(
            (t) =>
              `<li><b>${esc(t.title)}</b>${t.client ? ` <span class="msg-flag">${esc(displayName(t.client) || t.client)}</span>` : ''}${
                t.detail ? `<div class="hint">${esc(t.detail)}</div>` : ''
              }</li>`,
          )
          .join('') +
        `</ul>`;
    } else {
      // A zero here almost always means "already covered", not "nothing found":
      // the extractor is given the open tasks and told not to duplicate them.
      body =
        head +
        `<p>No se propuso ninguna tarea nueva. Normalmente es porque lo que piden estos mensajes ya está cubierto por una tarea abierta.</p>` +
        (r.related.length
          ? `<p class="hint">Tareas abiertas relacionadas con esta conversación:</p><ul class="msg-proposed">` +
            r.related.map((t) => `<li><b>${esc(t.title)}</b> <span class="msg-flag">${esc(statusLabel(t.status))}</span></li>`).join('') +
            `</ul>`
          : '');
    }
    msgModal('Resultado del análisis', body);
    if (r.proposed.length) {
      loadInbox();
      loadStats();
    }
  } catch (err) {
    msgModal('No se pudo analizar', `<p class="hint">${esc(String(err))}</p>`);
  } finally {
    btn.disabled = false;
    btn.innerHTML = was;
  }
}

async function msgToChat() {
  const ids = [...msgSel];
  if (!ids.length) return;
  const r = await (
    await fetch('/api/messages/to-chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids }),
    })
  ).json();
  if (r.error) {
    msgModal('No se pudo enviar al chat', `<p class="hint">${esc(r.error)}</p>`);
    return;
  }

  pendingSelection = { ids, label: r.label, preview: r.preview, threadId: r.threadId };
  clearMsgSelection();

  document.querySelectorAll('.tab').forEach((b) => b.classList.toggle('active', b.dataset.tab === 'chat'));
  document.querySelectorAll('.panel').forEach((p) => p.classList.toggle('active', p.id === 'chat'));
  await initChat();
  await openThread(r.threadId);
  renderPendingSelection();
  $('#chat-input').focus();
}

// ---- wiring ----

let msgInited = false;
async function initMessages() {
  if (!msgInited) {
    msgInited = true;
    await loadMsgChats();
  } else {
    loadMsgChats(); // counts move as messages arrive and get processed
  }
}

let msgSearchTimer = null;
$('#msg-search').addEventListener('input', (e) => {
  renderMsgSide();
  clearTimeout(msgSearchTimer);
  const q = e.target.value;
  msgSearchTimer = setTimeout(() => runMsgSearch(q), 250);
});

let msgFindTimer = null;
$('#msg-find').addEventListener('input', (e) => {
  clearTimeout(msgFindTimer);
  const q = e.target.value;
  msgFindTimer = setTimeout(() => {
    msgFilters.find = q.trim();
    if (msgChatId) openMsgChat(msgChatId);
  }, 250);
});

function msgToggleFilter(btn, key) {
  msgFilters[key] = !msgFilters[key];
  btn.setAttribute('aria-pressed', String(msgFilters[key]));
  btn.classList.toggle('on', msgFilters[key]);
  if (msgChatId) openMsgChat(msgChatId);
}
$('#msg-f-unproc').onclick = (e) => msgToggleFilter(e.currentTarget, 'unproc');
$('#msg-f-files').onclick = (e) => msgToggleFilter(e.currentTarget, 'files');

// Jump to a date: the anchor is local midnight, and pageMessages('around')
// returns half a page either side of it, so the day lands with context above it.
// The custom picker attaches itself through the delegated input[type='date']
// handler further up, so there is nothing to wire here beyond the change event.
$('#msg-date').addEventListener('change', (e) => {
  const v = e.target.value;
  if (!v || !msgChatId) return;
  const [y, m, d] = v.split('-').map(Number);
  const ts = new Date(y, m - 1, d, 0, 0, 0, 0).getTime();
  msgAnchorId = null;
  msgAnchorTs = ts;
  openMsgChat(msgChatId, ts);
});

$('#msg-thread').addEventListener('scroll', (e) => {
  const box = e.currentTarget;
  if (msgLoading) return;
  if (box.scrollTop < 150) loadMsgPage('older');
  else if (box.scrollHeight - box.scrollTop - box.clientHeight < 150) loadMsgPage('newer');
});

$('#msg-analyze').onclick = msgAnalyze;
$('#msg-tochat').onclick = msgToChat;
$('#msg-clear').onclick = clearMsgSelection;

// ---- Trash ----
let trashData = { tasks: [], clients: [] };
async function loadTrash() {
  trashData = await (await fetch('/api/trash')).json();
  $('#trash-pill').textContent = trashData.tasks.length + trashData.clients.length;
  renderTrash();
}
function renderTrash() {
  const q = $('#trash-search').value;
  const tk = trashData.tasks.filter((t) => matches(q, t.title, t.detail, displayName(t.clientHint || '')));
  const cl = trashData.clients.filter((c) => matches(q, c.handle, c.name, displayName(c.handle)));
  $('#trash-task-count').textContent = tk.length;
  $('#trash-client-count').textContent = cl.length;

  const tl = $('#trash-tasks');
  tl.innerHTML = '';
  if (!tk.length) tl.append(el('<div class="empty">—</div>'));
  for (const t of tk) {
    const card = el(`<div class="card">
      <div class="title">${esc(t.title)}</div>
      <div class="detail">${esc(t.detail)}</div>
      <div class="meta">${t.clientHint ? `<span>cliente: ${esc(displayName(t.clientHint))}</span>` : ''}<span class="badge">${esc(statusLabel(t.status))}</span></div>
      <div class="actions">
        <button class="approve j-restore">${ico('undo')}Restaurar</button>
        <button class="dismiss j-purge">${ico('trash')}Borrar definitivamente</button>
      </div>
    </div>`);
    card.querySelector('.j-restore').onclick = async () => {
      await bulkPost('/api/tasks/bulk', { ids: [Number(t.id)], action: 'restore' });
      await refreshTaskViews();
    };
    card.querySelector('.j-purge').onclick = async () => {
      if (!confirm('¿Borrar definitivamente esta tarea? No se puede deshacer.')) return;
      await bulkPost('/api/tasks/bulk', { ids: [Number(t.id)], action: 'purge' });
      await refreshTaskViews();
    };
    tl.append(card);
  }

  const cle = $('#trash-clients');
  cle.innerHTML = '';
  if (!cl.length) cle.append(el('<div class="empty">—</div>'));
  for (const c of cl) {
    const nm = c.name || displayName(c.handle) || c.handle;
    const card = el(`<div class="card sender">
      <span class="handle">${esc(c.handle)}</span>
      <span class="rn">${esc(nm)}</span>
      <span class="actions" style="margin-left:auto">
        <button class="approve j-restore">${ico('undo')}Restaurar</button>
        <button class="dismiss j-purge">${ico('trash')}Borrar definitivamente</button>
      </span>
    </div>`);
    card.querySelector('.j-restore').onclick = async () => {
      await bulkPost('/api/clients/bulk', { handles: [c.handle], action: 'restore' });
      await Promise.all([loadSenders(), loadNames(), loadTrash(), loadStats()]);
    };
    card.querySelector('.j-purge').onclick = async () => {
      if (!confirm('¿Borrar definitivamente este cliente? No se puede deshacer.')) return;
      await bulkPost('/api/clients/bulk', { handles: [c.handle], action: 'purge' });
      await Promise.all([loadSenders(), loadNames(), loadTrash(), loadStats()]);
    };
    cle.append(card);
  }
}
$('#trash-search').addEventListener('input', renderTrash);
$('#trash-empty').onclick = async () => {
  if (!confirm('¿Vaciar la papelera? Se borrarán definitivamente todos los elementos eliminados.')) return;
  await bulkPost('/api/trash/empty', { type: 'all' });
  await Promise.all([loadTrash(), loadSenders(), loadNames(), loadStats()]);
};

// ---- Chat (threads + memory) ----
let currentThreadId = null;
let chatInited = false;

// Sentinels wrapping a message selection pasted in from the Mensajes tab. They
// must match SEL_OPEN / SEL_CLOSE in src/chat/store.ts. The transcript lives in
// the message content because that is what gets replayed to the model, so here
// it is folded into a <details> instead of flooding the bubble: visible when you
// want to check what the assistant was given, out of the way otherwise.
const SEL_OPEN = '⟦SELECCIÓN⟧';
const SEL_CLOSE = '⟦/SELECCIÓN⟧';

function bubble(role, text, attachments) {
  const atts = (attachments || []).map((a) => `<span class="att">${ico('clip')}${esc(a.name)}</span>`).join('');
  const raw = text ?? '';
  let quoted = '';
  let rest = raw;
  const open = raw.indexOf(SEL_OPEN);
  const close = raw.indexOf(SEL_CLOSE);
  if (open !== -1 && close > open) {
    const inner = raw.slice(open + SEL_OPEN.length, close).trim();
    const nl = inner.indexOf('\n');
    const header = nl === -1 ? inner : inner.slice(0, nl);
    const body = nl === -1 ? '' : inner.slice(nl + 1);
    quoted =
      `<details class="sel-quote"><summary>${ico('message')}${esc(header)}</summary>` +
      `<pre>${esc(body)}</pre></details>`;
    rest = (raw.slice(0, open) + raw.slice(close + SEL_CLOSE.length)).trim();
  }
  return el(
    `<div class="bubble ${role === 'user' ? 'user' : 'bot'}">${atts}${quoted}${esc(rest)}</div>`,
  );
}

async function loadThreads() {
  const threads = await (await fetch('/api/threads')).json();
  const list = $('#thread-list');
  list.innerHTML = '';
  for (const t of threads) {
    const item = el(`<div class="thread-item ${t.id === currentThreadId ? 'active' : ''}">
      <span class="tt">${esc(t.title)}</span>
      <button class="del-thread" title="Eliminar conversación" aria-label="Eliminar conversación">${ico('trash')}</button>
    </div>`);
    item.querySelector('.tt').onclick = () => openThread(t.id);
    item.querySelector('.del-thread').onclick = async (e) => {
      e.stopPropagation();
      if (!confirm('¿Eliminar esta conversación?')) return;
      await fetch(`/api/threads/${t.id}`, { method: 'DELETE' });
      if (currentThreadId === t.id) newThread();
      await loadThreads();
    };
    list.append(item);
  }
}

async function openThread(id) {
  currentThreadId = id;
  // A pending selection belongs to the thread it was handed to; navigating away
  // drops it rather than silently attaching it to an unrelated conversation.
  if (pendingSelection && pendingSelection.threadId !== id) clearPendingSelection();
  showChatView();
  const msgs = await (await fetch(`/api/threads/${id}`)).json();
  const log = $('#chat-log');
  log.innerHTML = '';
  for (const m of msgs) log.append(bubble(m.role, m.content, m.attachments));
  log.scrollTop = log.scrollHeight;
  await loadThreads();
}

function newThread() {
  currentThreadId = null;
  clearPendingSelection();
  showChatView();
  const log = $('#chat-log');
  log.innerHTML = '';
  log.append(el(`<div class="empty">${ico('chat', 'ico-xl')}Nueva conversación. Pregúntame sobre tus mensajes, clientes o tareas.</div>`));
  document.querySelectorAll('.thread-item').forEach((i) => i.classList.remove('active'));
  $('#chat-input').focus();
}

function showChatView() {
  $('#memory-panel').hidden = true;
  $('#reminders-panel').hidden = true;
  $('#chat-log').style.display = '';
  $('#chat-form').style.display = '';
}

async function initChat() {
  if (chatInited) return;
  chatInited = true;
  await Promise.all([loadThreads(), loadMemory(), loadReminders()]);
  const threads = await (await fetch('/api/threads')).json();
  if (threads.length) openThread(threads[0].id);
  else newThread();
}

$('#new-thread').onclick = newThread;

// ---- Chat file attachment ----
let selectedFile = null;
function clearFile() {
  selectedFile = null;
  $('#chat-file').value = '';
  const chip = $('#chat-file-chip');
  chip.hidden = true;
  chip.innerHTML = '';
}
$('#chat-file').addEventListener('change', (e) => {
  const f = e.target.files[0];
  if (!f) return clearFile();
  selectedFile = f;
  const chip = $('#chat-file-chip');
  chip.hidden = false;
  chip.innerHTML = `${ico('clip')}${esc(f.name)} <button title="quitar" aria-label="Quitar archivo">${ico('close')}</button>`;
  chip.querySelector('button').onclick = clearFile;
});
function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1]);
    r.onerror = reject;
    r.readAsDataURL(file);
  });
}

// A selection handed over from the Mensajes tab, waiting to ride along with the
// next message the owner sends. { ids, label, preview } or null.
let pendingSelection = null;

function clearPendingSelection() {
  pendingSelection = null;
  const chip = $('#chat-sel-chip');
  chip.hidden = true;
  chip.innerHTML = '';
}

function renderPendingSelection() {
  const chip = $('#chat-sel-chip');
  if (!pendingSelection) return clearPendingSelection();
  chip.hidden = false;
  chip.innerHTML =
    `<details class="sel-quote"><summary>${ico('message')}${esc(pendingSelection.label)}` +
    ` <span class="sel-hint">se enviará con tu pregunta</span></summary>` +
    `<pre>${esc(pendingSelection.preview)}</pre></details>` +
    `<button class="sel-drop" title="Quitar la selección" aria-label="Quitar la selección">${ico('close')}</button>`;
  chip.querySelector('.sel-drop').onclick = clearPendingSelection;
}

$('#chat-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const input = $('#chat-input');
  const text = input.value.trim();
  const file = selectedFile;
  if (!text && !file) return;
  input.value = '';
  showChatView();
  // The selection only travels with a typed message, never with a file upload
  // (that path composes its own content around the vision description).
  const sel = file ? null : pendingSelection;
  if (sel) clearPendingSelection();
  const log = $('#chat-log');
  if (log.querySelector('.empty')) log.innerHTML = '';
  log.append(
    bubble(
      'user',
      sel ? `${SEL_OPEN}\n${sel.label}\n${sel.preview}\n${SEL_CLOSE}\n\n${text}` : text,
      file ? [{ name: file.name }] : [],
    ),
  );
  const thinking = el(`<div class="bubble bot thinking">${file ? 'analizando archivo…' : 'pensando…'}</div>`);
  log.append(thinking);
  log.scrollTop = log.scrollHeight;
  try {
    let r;
    if (file) {
      const dataBase64 = await fileToBase64(file);
      clearFile();
      r = await (
        await fetch('/api/chat/upload', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            threadId: currentThreadId,
            message: text,
            fileName: file.name,
            mimeType: file.type,
            dataBase64,
          }),
        })
      ).json();
    } else {
      r = await (
        await fetch('/api/chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            threadId: currentThreadId,
            message: text,
            ...(sel ? { contextIds: sel.ids } : {}),
          }),
        })
      ).json();
    }
    thinking.remove();
    if (r.threadId) currentThreadId = r.threadId;
    log.append(bubble('bot', r.reply || `(error: ${r.error || 'sin respuesta'})`));
    handleChatTools(r, log);
    if (r.createdThread) await loadThreads();
  } catch (err) {
    thinking.remove();
    log.append(bubble('bot', `(error: ${String(err)})`));
  }
  log.scrollTop = log.scrollHeight;
});

function handleChatTools(r, log) {
  const note = (t) => log.append(el(`<div class="empty" style="padding:6px">${t}</div>`));
  const used = r.usedTools || [];
  if (used.includes('save_memory')) { note(ico('memory') + ' guardé algo en la memoria'); loadMemory(); }
  if (used.includes('create_task')) {
    note(ico('check') + ' creé una tarea en «Por hacer»');
    loadInbox();
    loadTasks();
    loadStats();
  }
  if (used.includes('schedule_reminder')) { note(ico('clock') + ' programé un recordatorio'); loadReminders(); }
}

// ---- Scheduled reminders (chat subtab) ----
async function loadReminders() {
  const rs = await (await fetch('/api/agenda')).json();
  $('#reminders-count').textContent = rs.length;
  const list = $('#reminders-list');
  list.innerHTML = '';
  if (!rs.length) {
    list.append(el(`<div class="empty">${ico('clock', 'ico-xl')}No hay recordatorios. Pídele al asistente «recuérdame mañana…».</div>`));
    return;
  }
  for (const r of rs) {
    const overdue = r.dueAt < Date.now();
    const when = new Date(r.dueAt).toLocaleString('es');
    const card = el(`<div class="card mem-item">
      <span class="mc"><b>${esc(r.text)}</b><br><span class="${overdue ? 'overdue-when' : 'muted'}" style="font-size:12px">${overdue ? ico('warn') + ' ' : ''}${esc(when)}</span></span>
      <button class="dismiss iconbtn" title="Cancelar" aria-label="Cancelar recordatorio">${ico('trash')}</button>
    </div>`);
    card.querySelector('.dismiss').onclick = async () => {
      await fetch(`/api/agenda/${r.id}`, { method: 'DELETE' });
      await loadReminders();
    };
    list.append(card);
  }
}
$('#show-reminders').onclick = () => {
  $('#chat-log').style.display = 'none';
  $('#chat-form').style.display = 'none';
  $('#memory-panel').hidden = true;
  $('#reminders-panel').hidden = false;
  loadReminders();
};
$('#close-reminders').onclick = showChatView;

// ---- Launch digest ("Buenos días") ----
function sameDay(a, b) {
  const x = new Date(a);
  const y = new Date(b);
  return x.getFullYear() === y.getFullYear() && x.getMonth() === y.getMonth() && x.getDate() === y.getDate();
}
async function checkDigest() {
  try {
    const d = await (await fetch('/api/digest')).json();
    const newTasks = d.newTasks || [];
    const reminders = d.reminders || [];
    const hasContent = newTasks.length || reminders.length;
    const greetedToday = d.lastSeen && sameDay(d.lastSeen, Date.now());
    // Nothing new and we already said hello today → don't pop up again.
    if (!hasContent && greetedToday) return;

    const body = $('#digest-body');
    body.innerHTML = '';
    if (reminders.length) {
      const sec = el(`<div class="dsec"><h4>${ico('clock')}Recordatorios</h4></div>`);
      for (const r of reminders)
        sec.append(el(`<div class="ditem"><div class="dt">${esc(r.text)}</div><div class="dd">${esc(new Date(r.dueAt).toLocaleString('es'))}</div></div>`));
      body.append(sec);
    }
    if (newTasks.length) {
      const sec = el(`<div class="dsec"><h4>${ico('new')}Tareas propuestas nuevas <span class="dg-count">(${newTasks.length})</span></h4></div>`);
      for (const t of newTasks) {
        const item = el(`<div class="ditem ditem-task">
          <div class="dt">${esc(t.title)}</div>
          ${t.clientHint ? `<div class="dd">cliente: ${esc(displayName(t.clientHint))}</div>` : ''}
          <div class="dactions">
            <button class="approve j-dg-approve">${ico('check')}Aprobar</button>
            <button class="dismiss j-dg-dismiss">${ico('trash')}Descartar</button>
          </div>
        </div>`);
        const settle = (label) => {
          item.classList.add('actioned');
          const act = item.querySelector('.dactions');
          if (act) act.innerHTML = `<span class="dg-done">${label}</span>`;
          const left = sec.querySelectorAll('.ditem-task:not(.actioned)').length;
          const cnt = sec.querySelector('.dg-count');
          if (cnt) cnt.textContent = `(${left})`;
        };
        item.querySelector('.j-dg-approve').onclick = async (e) => {
          e.target.disabled = true;
          await setStatus(t.id, 'todo'); // → Tareas (existing endpoint)
          settle(ico('check') + ' Aprobada');
        };
        item.querySelector('.j-dg-dismiss').onclick = async (e) => {
          e.target.disabled = true;
          await deleteTask(t.id); // → Papelera (existing bulk-delete)
          settle(ico('trash') + ' Descartada');
        };
        sec.append(item);
      }
      body.append(sec);
    }
    if (!hasContent) {
      body.append(
        el(`<div class="dsec"><div class="ditem ditem-clear"><div class="dt">${ico('check')}Todo al día</div><div class="dd">No hay tareas nuevas ni recordatorios pendientes. Que tengas un buen día.</div></div></div>`),
      );
    }
    const ov = $('#digest-overlay');
    ov.hidden = false;
    ov.style.display = 'flex';
    $('#digest-ok').onclick = async () => {
      ov.hidden = true;
      ov.style.display = 'none';
      await fetch('/api/digest/seen', { method: 'POST' });
      for (const r of reminders) fetch(`/api/agenda/${r.id}/dismiss`, { method: 'POST' });
      loadReminders();
    };
  } catch {
    /* digest is best-effort */
  }
}

// ---- Memory ----
async function loadMemory() {
  const mems = await (await fetch('/api/memory')).json();
  $('#memory-count').textContent = mems.length;
  const list = $('#memory-list');
  list.innerHTML = '';
  if (!mems.length) {
    list.append(el(`<div class="empty">${ico('memory', 'ico-xl')}El asistente aún no ha guardado nada. Cuéntale algo que deba recordar.</div>`));
    return;
  }
  for (const m of mems) {
    const card = el(`<div class="card mem-item">
      <span class="mc">${esc(m.content)}</span>
      <button class="dismiss iconbtn" title="Olvidar" aria-label="Olvidar este dato">${ico('trash')}</button>
    </div>`);
    card.querySelector('.dismiss').onclick = async () => {
      await fetch(`/api/memory/${m.id}`, { method: 'DELETE' });
      await loadMemory();
    };
    list.append(card);
  }
}
$('#show-memory').onclick = () => {
  $('#chat-log').style.display = 'none';
  $('#chat-form').style.display = 'none';
  $('#reminders-panel').hidden = true;
  $('#memory-panel').hidden = false;
  loadMemory();
};
$('#close-memory').onclick = showChatView;

// ---- Settings ----
async function loadSettings() {
  const s = await (await fetch('/api/settings')).json();
  $('#key-status').textContent = s.hasApiKey
    ? s.apiKeyFromEnv
      ? 'La clave está configurada (desde .env). Puedes reemplazarla aquí.'
      : 'La clave está configurada.'
    : 'Sin clave — pega tu clave de API de Anthropic para activar la IA.';
  $('#sched-on').checked = s.schedulerEnabled;
  $('#sched-time').value = s.dailyTime || '07:00';
  $('#rem-on').checked = s.remindersEnabled;
  $('#rem-interval').value = s.nudgeIntervalDays || 2;
  loadReminderPreview();
  loadDiagnostics();
  initUpdates();
}

// ---- Diagnostics: which DB this running instance is actually bound to ----
let lastDiagText = '';
async function loadDiagnostics() {
  const box = $('#diag-body');
  try {
    const d = await (await fetch('/api/diagnostics')).json();
    const src = d.sources.length
      ? d.sources
          .map((s) => `${s.source}: ${s.count} (último ${s.lastAt ? fmtMsgTime(s.lastAt) : '—'})`)
          .join(' · ')
      : 'sin mensajes';
    const unproc = d.unprocessed.count
      ? `${d.unprocessed.count} sin procesar (el más antiguo: ${fmtMsgTime(d.unprocessed.oldestAt)})`
      : 'todo procesado';
    box.innerHTML =
      `<div><b>Base de datos:</b> ${esc(d.dbPath)}</div>` +
      `<div><b>Mensajes:</b> ${esc(src)}</div>` +
      `<div><b>Cola de proceso:</b> ${esc(unproc)}</div>`;
    lastDiagText = `dataDir: ${d.dataDir}\ndbPath: ${d.dbPath}\nmensajes: ${src}\ncola: ${unproc}`;
  } catch {
    box.textContent = 'No se pudo cargar el diagnóstico.';
    lastDiagText = '';
  }
}

$('#diag-copy').addEventListener('click', async () => {
  if (!lastDiagText) return;
  try {
    await navigator.clipboard.writeText(lastDiagText);
    $('#diag-copied').textContent = 'Copiado ✓';
    setTimeout(() => ($('#diag-copied').textContent = ''), 2000);
  } catch {
    $('#diag-copied').textContent = 'No se pudo copiar.';
  }
});

// ---- Updates (only available inside the Electron app via the preload bridge) ----
let updatesWired = false;
let pendingUpdateZip = null;
async function initUpdates() {
  if (!window.updater) return; // running in a plain browser (dev) — hide the block
  $('#update-block').style.display = '';
  const v = await window.updater.version();
  $('#upd-status').textContent = `Versión actual: ${v}`;
  if (!updatesWired) {
    updatesWired = true;
    $('#upd-check').addEventListener('click', runUpdateCheck);
    $('#upd-install').addEventListener('click', runUpdateInstall);
  }
}

async function runUpdateCheck() {
  const msg = $('#upd-msg');
  msg.textContent = 'Comprobando…';
  $('#upd-install').style.display = 'none';
  $('#upd-badge').style.display = 'none';
  pendingUpdateZip = null;
  const r = await window.updater.check();
  if (r.status === 'up-to-date') {
    msg.textContent = 'La app está actualizada.';
  } else if (r.status === 'available') {
    pendingUpdateZip = r.zipUrl;
    $('#upd-badge').style.display = '';
    $('#upd-install').style.display = '';
    msg.textContent = `Disponible la versión ${r.latestVersion}.` + (r.notes ? ` ${r.notes}` : '');
  } else if (r.status === 'needs-new-app') {
    msg.innerHTML =
      `La versión ${esc(r.latestVersion)} requiere descargar la app de nuevo: ` +
      `<a href="${esc(r.page)}" target="_blank">abrir página</a>.`;
  } else {
    msg.textContent = `No se pudo comprobar: ${r.message || 'error'}`;
  }
}

async function runUpdateInstall() {
  if (!pendingUpdateZip) return;
  $('#upd-install').disabled = true;
  $('#upd-msg').textContent = 'Descargando e instalando… la app se reiniciará.';
  const r = await window.updater.apply(pendingUpdateZip);
  if (!r.ok) {
    $('#upd-install').disabled = false;
    $('#upd-msg').textContent = `No se pudo instalar: ${r.message || 'error'}`;
  }
  // on success the main process relaunches the app automatically
}

async function loadReminderPreview() {
  try {
    const r = await (await fetch('/api/reminders')).json();
    const c = r.digest.counts;
    $('#rem-preview').textContent = c.total
      ? `Ahora mismo: ${c.total} abiertas — ${c.overdue} vencidas, ${c.todo} por hacer, ${c.waiting} en espera.`
      : 'Ahora mismo: no hay tareas abiertas.';
  } catch {
    $('#rem-preview').textContent = '';
  }
}

$('#save-rem').addEventListener('click', async () => {
  await fetch('/api/settings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      remindersEnabled: $('#rem-on').checked,
      nudgeIntervalDays: Number($('#rem-interval').value) || 2,
    }),
  });
  $('#rem-saved').textContent = '✓ guardado';
});

$('#rem-test').addEventListener('click', async () => {
  await fetch('/api/reminders/test', { method: 'POST' });
  $('#rem-saved').textContent = 'enviada — revisa tus notificaciones';
});

$('#rem-digest').addEventListener('click', async () => {
  await fetch('/api/reminders/digest', { method: 'POST' });
  $('#rem-saved').textContent = 'resumen enviado';
  loadReminderPreview();
});

$('#rem-nudge').addEventListener('click', async () => {
  const r = await (await fetch('/api/reminders/nudge', { method: 'POST' })).json();
  $('#rem-saved').textContent = r.result?.nudged
    ? `${r.result.nudged} tarea(s) avisada(s)`
    : 'no hay tareas pendientes que avisar';
  loadReminderPreview();
});

$('#save-key').addEventListener('click', async () => {
  const apiKey = $('#api-key').value.trim();
  if (!apiKey) return;
  await fetch('/api/settings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ apiKey }),
  });
  $('#api-key').value = '';
  $('#key-saved').textContent = '✓ guardado';
  await Promise.all([loadSettings(), loadStats()]);
});

$('#save-sched').addEventListener('click', async () => {
  await fetch('/api/settings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ schedulerEnabled: $('#sched-on').checked, dailyTime: $('#sched-time').value }),
  });
  $('#sched-saved').textContent = '✓ guardado';
});

async function loadChats() {
  const list = $('#chats-list');
  list.innerHTML = '<div class="empty">cargando chats…</div>';
  let data;
  try {
    const r = await fetch('/api/chats');
    if (!r.ok) {
      const e = await r.json();
      const msg = (e.error || '').toLowerCase();
      // FDA / permission problem reading ~/Library/Messages/chat.db.
      if (r.status === 403 || msg.includes('unable to open') || msg.includes('authorization')) {
        const path = e.path ? esc(e.path) : '~/Library/Messages/chat.db';
        list.innerHTML =
          '<div class="empty fda-help">' +
          '<b>No se puede leer iMessage todavía.</b>' +
          '<p>Si ya diste <b>Acceso total al disco</b>, el permiso casi siempre no se aplica hasta reiniciar la app. Prueba en orden:</p>' +
          '<ol>' +
          '<li><b>Cierra la app por completo</b> (menú Asistente de Tareas → Salir, o ⌘Q — no solo la ventana) y vuelve a abrirla.</li>' +
          '<li>Si sigue igual: Ajustes del Sistema → Privacidad y seguridad → <b>Acceso total al disco</b>. <b>Quita</b> “Asistente de Tareas” de la lista con el botón <b>–</b>, vuelve a <b>añadirla</b> con <b>+</b> (o el interruptor apágalo y enciéndelo), y reinicia la app.</li>' +
          '<li>Asegúrate de que solo haya <b>una copia</b> de la app (p. ej. en Aplicaciones) y de que el permiso esté dado a esa copia.</li>' +
          '</ol>' +
          `<p class="muted">Archivo que intenta leer: <code>${path}</code></p>` +
          `<button id="chats-retry">${ico('refresh')}Reintentar</button>` +
          '</div>';
        const retry = document.getElementById('chats-retry');
        if (retry) retry.onclick = () => loadChats();
      } else {
        list.innerHTML = `<div class="empty">${esc(e.error || 'no se pudieron leer los chats')}</div>`;
      }
      return;
    }
    data = await r.json();
  } catch {
    list.innerHTML = '<div class="empty">no se pudieron leer los chats</div>';
    return;
  }
  $('#chats-note').textContent = data.filtering
    ? 'Solo se incluyen los chats marcados.'
    : 'Sin selección — se incluyen todos los chats. Marca algunos para limitar.';
  list.innerHTML = '';
  for (const c of data.chats) {
    const name = c.displayName || c.name;
    const showId = name && name !== c.id;
    list.append(
      el(`<label class="chatrow" data-name="${esc((name + ' ' + c.id).toLowerCase())}">
      <input type="checkbox" value="${esc(c.id)}" ${c.selected ? 'checked' : ''} />
      <span class="cn">${esc(name)}${showId ? ` <span class="cid">${esc(c.id)}</span>` : ''}</span>
      <span class="ct">${c.isGroup ? 'grupo' : 'directo'} · ${c.count}</span>
    </label>`),
    );
  }
  filterChatRows('#chats-list', $('#chats-search').value);
}

// Filter chat rows by hiding (not removing) so checkbox selections survive search.
function filterChatRows(listSel, q) {
  q = (q || '').toLowerCase().trim();
  document.querySelectorAll(`${listSel} .chatrow`).forEach((row) => {
    row.style.display = !q || (row.dataset.name || '').includes(q) ? '' : 'none';
  });
}
$('#chats-search').addEventListener('input', (e) => filterChatRows('#chats-list', e.target.value));

async function saveChatSelection(ids) {
  await fetch('/api/settings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ selectedChats: ids }),
  });
  $('#chats-saved').textContent = '✓ guardado';
  await loadChats();
}

$('#save-chats').addEventListener('click', () => {
  const ids = [...document.querySelectorAll('#chats-list input:checked')].map((i) => i.value);
  saveChatSelection(ids);
});
$('#clear-chats').addEventListener('click', () => saveChatSelection([]));

// ---- WhatsApp accounts (multi-account) ----
let waPollTimer = null;
const waExpanded = new Set(); // account ids whose chat picker is open
const waPickerNodes = new Map(); // id -> the picker DOM node (reused across re-renders so it doesn't flicker)
const waChatsLoaded = new Set(); // ids whose picker has already been populated (don't reload on every poll)

function waBadgeHtml(status) {
  const cls =
    status === 'ready'
      ? 'b-done'
      : ['qr', 'starting', 'authenticated'].includes(status)
        ? 'b-waiting'
        : 'b-todo';
  return `<span class="badge ${cls}">${waLabel(status)}</span>`;
}

function waIdentityLine(st) {
  if (st.identity && (st.identity.number || st.identity.name)) {
    const num = st.identity.number ? '+' + esc(st.identity.number) : '';
    const nm = st.identity.name ? esc(st.identity.name) : '';
    return `${nm}${nm && num ? ' · ' : ''}${num}`;
  }
  return st.hasSession ? 'vinculada (reconectando)' : 'sin vincular';
}

async function loadWaAccounts() {
  const wrap = $('#wa-accounts');
  let data;
  try {
    data = await (await fetch('/api/whatsapp/accounts')).json();
  } catch {
    wrap.innerHTML = '<div class="empty">no se pudieron cargar las cuentas</div>';
    return;
  }
  const accounts = data.accounts || [];
  waAccountLabels = {};
  for (const a of accounts) waAccountLabels[a.id] = a.label;

  wrap.innerHTML = '';
  if (!accounts.length) wrap.innerHTML = '<div class="empty">No hay cuentas todavía.</div>';
  for (const st of accounts) wrap.append(renderWaCard(st));

  // Keep polling while any account is mid-pairing/connecting.
  if (waPollTimer) {
    clearTimeout(waPollTimer);
    waPollTimer = null;
  }
  const transitional = accounts.some((a) => ['starting', 'qr', 'authenticated'].includes(a.status));
  if (transitional) {
    waPollTimer = setTimeout(() => {
      if (document.querySelector('#settings').classList.contains('active')) loadWaAccounts();
    }, 2500);
  }
  // Re-open any chat pickers the user had expanded. Only (re)fetch chats for a
  // picker that hasn't been populated yet — re-rendering reuses the cached node
  // (renderWaCard), so an already-loaded picker survives a poll-driven rebuild
  // without flickering back to its "Cargando…" placeholder.
  for (const id of waExpanded) if (!waChatsLoaded.has(id)) loadAccountChats(id);
}

function renderWaCard(st) {
  const id = st.id;
  const card = el(`<div class="wa-card" data-acc="${esc(id)}"></div>`);

  const head = el(`<div class="wa-head">
    <div class="wa-name"><b>${esc(st.label)}</b> ${waBadgeHtml(st.status)}</div>
    <div class="wa-id hint">${waIdentityLine(st)}</div>
  </div>`);
  card.append(head);

  const body = el('<div class="wa-cardbody"></div>');
  card.append(body);

  if (st.status === 'ready') {
    body.append(el(`<div class="setrow"><span class="saved">${ico('check')}Conectado</span></div>`));
    const row = el('<div class="setrow"></div>');
    const bf = el(`<button class="primary">${ico('import')}Importar historial</button>`);
    const perChatInput = el(
      '<label>últimos <input class="wa-perchat" type="number" value="200" min="10" max="2000" style="width:5em" /> por chat</label>',
    );
    const bfStatus = el('<span class="run-status"></span>');
    bf.onclick = async () => {
      const perChat = Number(perChatInput.querySelector('input').value) || 200;
      bf.disabled = true;
      bfStatus.textContent = `obteniendo ${perChat} por chat… (puede tardar varios minutos)`;
      try {
        const r = await (
          await fetch(`/api/whatsapp/accounts/${id}/backfill`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ perChat }),
          })
        ).json();
        bfStatus.textContent = r.error ? 'error: ' + r.error : `importados ${r.inserted} de ${r.chats} chats`;
      } catch (err) {
        bfStatus.textContent = 'error: ' + String(err);
      }
      bf.disabled = false;
      loadStats();
    };
    const pick = el(`<button>${ico('message')}Elegir chats a incluir</button>`);
    pick.onclick = () => {
      if (waExpanded.has(id)) {
        waExpanded.delete(id);
        waPickerNodes.delete(id); // drop cache so a later re-open reloads fresh
        waChatsLoaded.delete(id);
      } else {
        waExpanded.add(id);
      }
      loadWaAccounts();
    };
    row.append(bf, perChatInput, pick, bfStatus);
    body.append(row);
    // Per-account chat picker (filled by loadAccountChats when expanded). Reuse
    // the cached node so a poll-driven card rebuild moves the already-populated
    // picker instead of recreating an empty one (the flicker fix).
    if (waExpanded.has(id)) {
      let picker = waPickerNodes.get(id);
      if (!picker) {
        picker = renderWaChatPicker(id);
        waPickerNodes.set(id, picker);
      }
      body.append(picker);
    }
  } else if (st.status === 'qr' && st.qrDataUrl) {
    body.append(
      el(`<div><img class="wa-qr" src="${st.qrDataUrl}" alt="QR de WhatsApp" />
        <p class="hint">Escanea en ~60 s desde el WhatsApp de esta cuenta; el código se actualiza solo.</p></div>`),
    );
  } else if (st.status === 'starting' || st.status === 'authenticated') {
    const d = st.detail ? esc(st.detail) : 'abriendo un navegador en segundo plano, ~10–20 s';
    const attempt = st.attempts > 1 ? ` <span class="muted">(intento ${st.attempts})</span>` : '';
    body.append(el(`<div class="hint">conectando… ${d}${attempt}</div>`));
    // A wedged sync that exhausted auto-recovery sets lastError with guidance.
    if (st.lastError) body.append(el(`<div class="hint err">${ico('warn')} ${esc(st.lastError)}</div>`));
    body.append(waRecoveryRow(id));
  } else {
    if (st.lastError) body.append(el(`<div class="hint err">${ico('warn')} ${esc(st.lastError)}</div>`));
    const row = el('<div class="setrow"></div>');
    const connect = el(`<button class="primary">${st.hasSession ? 'Reconectar' : 'Conectar / escanear QR'}</button>`);
    connect.onclick = () => waStart(id);
    row.append(connect);
    body.append(row);
    body.append(waRecoveryRow(id));
  }

  // Footer: rename + remove (always available).
  const foot = el('<div class="setrow wa-foot"></div>');
  const rename = el('<button class="small">Renombrar</button>');
  rename.onclick = () => waRename(id, st.label);
  const remove = el(`<button class="small danger">${ico('trash')}Quitar cuenta</button>`);
  remove.onclick = () => waRemove(id, st.label);
  foot.append(rename, remove);
  card.append(foot);

  return card;
}

function waRecoveryRow(id) {
  const row = el('<div class="setrow"></div>');
  const reset = el(`<button>${ico('refresh')}Reconectar</button>`);
  reset.onclick = () => waReset(id);
  const repair = el(`<button>${ico('phone')}Volver a vincular</button>`);
  repair.onclick = () => waRepair(id);
  row.append(reset, repair);
  return row;
}

async function waStart(id) {
  await fetch(`/api/whatsapp/accounts/${id}/start`, { method: 'POST' }).catch(() => {});
  setTimeout(loadWaAccounts, 1200);
}
async function waReset(id) {
  waPickerNodes.delete(id);
  waChatsLoaded.delete(id);
  await fetch(`/api/whatsapp/accounts/${id}/reset`, { method: 'POST' }).catch(() => {});
  setTimeout(loadWaAccounts, 1500);
}
async function waRepair(id) {
  if (!confirm('¿Reiniciar esta cuenta y escanear un nuevo código QR? Esto borra la vinculación actual de esta cuenta.')) return;
  waPickerNodes.delete(id);
  waChatsLoaded.delete(id);
  await fetch(`/api/whatsapp/accounts/${id}/repair`, { method: 'POST' }).catch(() => {});
  setTimeout(loadWaAccounts, 1500);
}
async function waRename(id, current) {
  const label = await askText('Nombre para esta cuenta (deja vacío para usar el nombre de WhatsApp):', current || '');
  if (label === null) return;
  await fetch(`/api/whatsapp/accounts/${id}/label`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ label }),
  }).catch(() => {});
  loadWaAccounts();
}
async function waRemove(id, label) {
  if (!confirm(`¿Quitar la cuenta "${label}"? Se cierra y se borra su vinculación (los mensajes ya guardados se conservan).`)) return;
  waExpanded.delete(id);
  waPickerNodes.delete(id);
  waChatsLoaded.delete(id);
  await fetch(`/api/whatsapp/accounts/${id}`, { method: 'DELETE' }).catch(() => {});
  loadWaAccounts();
}

$('#wa-add').addEventListener('click', async () => {
  await fetch('/api/whatsapp/accounts', { method: 'POST' }).catch(() => {});
  setTimeout(loadWaAccounts, 1200);
});

// Per-account chat-inclusion picker.
function renderWaChatPicker(id) {
  const box = el(`<div class="wa-chatpick" id="wa-chatpick-${esc(id)}">
    <p class="hint" id="wa-chnote-${esc(id)}">Cargando chats…</p>
    <input class="search" id="wa-chsearch-${esc(id)}" placeholder="Buscar chat por nombre o número…" />
    <div class="chatsel" id="wa-chlist-${esc(id)}"><div class="empty">cargando…</div></div>
    <div class="setrow">
      <button class="primary" id="wa-chsave-${esc(id)}">Guardar selección</button>
      <button id="wa-chall-${esc(id)}">Incluir todos</button>
      <span class="saved" id="wa-chsaved-${esc(id)}"></span>
    </div>
  </div>`);
  return box;
}

async function loadAccountChats(id) {
  const list = document.getElementById(`wa-chlist-${id}`);
  if (!list) return; // picker not currently rendered
  let data;
  try {
    data = await (await fetch(`/api/whatsapp/accounts/${id}/chats`)).json();
  } catch {
    list.innerHTML = '<div class="empty">no se pudieron cargar los chats</div>';
    return;
  }
  const note = document.getElementById(`wa-chnote-${id}`);
  if (!data.ready) {
    list.innerHTML = '<div class="empty">Conecta esta cuenta para elegir sus chats.</div>';
    if (note) note.textContent = '';
    waChatsLoaded.delete(id); // not loaded yet — let a later poll retry once ready
    return;
  }
  waChatsLoaded.add(id); // populated — poll-driven rebuilds will now reuse this node
  if (note)
    note.textContent = data.filtering
      ? 'Solo se incluyen los chats marcados de esta cuenta.'
      : 'Sin selección — se incluyen todos los chats de esta cuenta. Marca algunos para limitar.';
  list.innerHTML = '';
  for (const c of data.chats) {
    const name = c.displayName || c.name;
    const showId = name && name !== c.id;
    list.append(
      el(`<label class="chatrow" data-name="${esc((name + ' ' + c.id).toLowerCase())}">
        <input type="checkbox" value="${esc(c.id)}" ${c.selected ? 'checked' : ''} />
        <span class="cn">${esc(name)}${showId ? ` <span class="cid">${esc(c.id)}</span>` : ''}</span>
        <span class="ct">${c.isGroup ? 'grupo' : 'directo'}</span>
      </label>`),
    );
  }
  const search = document.getElementById(`wa-chsearch-${id}`);
  if (search) {
    filterChatRows(`#wa-chlist-${id}`, search.value);
    search.oninput = () => filterChatRows(`#wa-chlist-${id}`, search.value);
  }
  const save = document.getElementById(`wa-chsave-${id}`);
  if (save)
    save.onclick = () => saveAccountChats(id, [...list.querySelectorAll('input:checked')].map((i) => i.value));
  const all = document.getElementById(`wa-chall-${id}`);
  if (all) all.onclick = () => saveAccountChats(id, []);
}

async function saveAccountChats(id, ids) {
  await fetch(`/api/whatsapp/accounts/${id}/chats`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chats: ids }),
  }).catch(() => {});
  const saved = document.getElementById(`wa-chsaved-${id}`);
  if (saved) saved.textContent = '✓ guardado';
  loadAccountChats(id);
}

(async () => {
  await loadNames();
  await loadWaAccountLabels(); // so per-account badges render before opening Ajustes
  loadStats();
  loadInbox();
  loadTasks();
  checkDigest();
})();
