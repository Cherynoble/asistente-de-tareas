// app-tasks.js — Search/multi-select infra, Bandeja, Tareas, Archivo.
// Split from the old single app.js (1.8.0-dev). These files are CLASSIC scripts
// sharing one global scope; index.html loads them in a fixed order that mirrors
// the original file, so cross-file references keep working. Keep new top-level
// names unique across app-*.js.

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
    if (countEl) countEl.textContent = selected.size ? tr('common.selectedCount', { n: selected.size }) : '';
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
  if (action === 'purge' && !confirm(tr('tasks.confirmPurgeMany', { n: ids.length }))) return;
  await bulkPost('/api/tasks/bulk', { ids, action, value });
  selection.clear();
  await refreshTaskViews();
}

async function bulkClients(selection, action) {
  const handles = selection.ids();
  if (!handles.length) return;
  if (action === 'purge' && !confirm(tr('clients.confirmPurgeMany', { n: handles.length }))) return;
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
    list.append(el(`<div class="empty">${inboxItems.length ? ico('search', 'ico-xl') + esc(tr('common.noSearchMatch')) : ico('inbox', 'ico-xl') + esc(tr('inbox.empty'))}</div>`));
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
        ${t.sourceQuote ? `<div class="quote">${ico('search')}<span class="qtext">${esc(who ? tr('tasks.searchFor', { who }) : tr('tasks.search'))}: <span>"${esc(t.sourceQuote)}"</span></span></div>` : ''}
        ${t.sourceBody && !t.sourceQuote ? `<div class="src">${t.hasAttachment ? ico('clip') + ' ' : ''}${esc(t.sourceBody.slice(0, 160))}</div>` : ''}
        ${t.hasAttachment && t.sourceMessageId ? `<div class="filelink"><a href="#" class="j-file">${ico('clip')}${esc(tr('tasks.viewFile'))}</a></div>` : ''}
        <div class="meta">${who ? `<span>${esc(tr('tasks.clientLabel', { who }))}</span>` : ''}${t.createdAt ? `<span>${esc(tr('tasks.generatedLabel', { date: fmtGen(t.createdAt) }))}</span>` : ''}${accountBadge(t.source, t.waAccount)}</div>
        <div class="actions">
          <button class="approve j-approve">${ico('check')}${esc(tr('inbox.approve'))}</button>
          <button class="dismiss j-del iconbtn" title="${esc(tr('common.delete'))}" aria-label="${esc(tr('common.delete'))}">${ico('trash')}</button>
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
        ${t.hasAttachment && t.sourceMessageId ? `<div class="filelink"><a href="#" class="j-file">${ico('clip')}${esc(tr('tasks.viewFile'))}</a></div>` : ''}
        <div class="meta">
          ${t.clientHint ? `<span>${esc(tr('tasks.clientLabel', { who: displayName(t.clientHint) }))}</span>` : ''}${accountBadge(t.source, t.waAccount)}
          <label class="due ${overdue ? 'overdue' : ''}">${esc(tr('tasks.dueLabel'))} <input type="date" class="duedate" value="${dateInput(t.dueAt)}" /></label>
        </div>
        <div class="actions">
          <select class="status">${options}</select>
          <button class="archivebtn">${ico('archive')}${esc(tr('tasks.archive'))}</button>
          <button class="dismiss j-del iconbtn" title="${esc(tr('common.delete'))}" aria-label="${esc(tr('common.delete'))}">${ico('trash')}</button>
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
    list.append(el(`<div class="empty">${archiveItems.length ? ico('search', 'ico-xl') + esc(tr('common.noSearchMatch')) : ico('archive', 'ico-xl') + esc(tr('archive.empty'))}</div>`));
    archiveSel.refresh();
    return;
  }
  for (const t of items) {
    const card = el(`<div class="card selectable">
      <input type="checkbox" class="sel" data-id="${t.id}" />
      <div class="cardbody">
        <div class="title">${esc(t.title)}</div>
        <div class="detail">${esc(t.detail)}</div>
        <div class="meta"><span class="badge b-done">${esc(statusLabel(t.status))}</span>${t.clientHint ? `<span>${esc(tr('tasks.clientLabel', { who: displayName(t.clientHint) }))}</span>` : ''}</div>
        <div class="actions">
          <button class="approve j-unarchive">${ico('undo')}${esc(tr('archive.unarchive'))}</button>
          <button class="dismiss j-del iconbtn" title="${esc(tr('common.delete'))}" aria-label="${esc(tr('common.delete'))}">${ico('trash')}</button>
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
