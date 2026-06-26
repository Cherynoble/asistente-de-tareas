const $ = (sel) => document.querySelector(sel);
const el = (html) => {
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  return t.content.firstElementChild;
};
const esc = (s) =>
  (s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

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
    if (id === 'clients') loadSenders();
    if (id === 'settings') {
      loadSettings();
      loadChats();
      loadWaChats();
      refreshWa();
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
// Every word in the query must appear somewhere in the joined fields.
function matches(q, ...fields) {
  if (!q || !q.trim()) return true;
  const hay = fields.filter(Boolean).join(' ').toLowerCase();
  return q.toLowerCase().split(/\s+/).every((w) => hay.includes(w));
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
    list.append(el(`<div class="empty">${inboxItems.length ? 'Nada coincide con la búsqueda.' : 'Aún no hay tareas propuestas. Usa la pestaña Proceso para encontrar algunas.'}</div>`));
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
        ${t.sourceQuote ? `<div class="quote">🔎 buscar ${who ? 'a ' + esc(who) : ''}: <span>"${esc(t.sourceQuote)}"</span></div>` : ''}
        ${t.sourceBody && !t.sourceQuote ? `<div class="src">${t.hasAttachment ? '📎 ' : ''}${esc(t.sourceBody.slice(0, 160))}</div>` : ''}
        <div class="meta">${who ? `<span>cliente: ${esc(who)}</span>` : ''}</div>
        <div class="actions">
          <button class="approve j-approve">✓ Aprobar</button>
          <button class="dismiss j-dismiss">✕ Descartar</button>
          <button class="dismiss j-del" title="Eliminar">🗑</button>
        </div>
      </div>
    </div>`);
    inboxSel.bind(card.querySelector('.sel'), String(t.id));
    card.querySelector('.j-approve').onclick = () => setStatus(t.id, 'todo');
    card.querySelector('.j-dismiss').onclick = () => setStatus(t.id, 'dismissed');
    card.querySelector('.j-del').onclick = () => deleteTask(t.id);
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
$('#inbox-bulk-dismiss').onclick = () => bulkTasks(inboxSel, 'status', 'dismissed');
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
        ${t.sourceQuote ? `<div class="quote">🔎 "${esc(t.sourceQuote)}"</div>` : ''}
        <div class="meta">
          ${t.clientHint ? `<span>cliente: ${esc(displayName(t.clientHint))}</span>` : ''}
          <label class="due ${overdue ? 'overdue' : ''}">vence <input type="date" class="duedate" value="${dateInput(t.dueAt)}" /></label>
        </div>
        <div class="actions">
          <select class="status">${options}</select>
          <button class="dismiss archivebtn">Archivar</button>
          <button class="dismiss j-del" title="Eliminar">🗑</button>
        </div>
      </div>
    </div>`);
    tasksSel.bind(card.querySelector('.sel'), String(t.id));
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
    list.append(el(`<div class="empty">${archiveItems.length ? 'Nada coincide con la búsqueda.' : 'No hay nada archivado todavía.'}</div>`));
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
          <button class="approve j-unarchive">↩ Desarchivar</button>
          <button class="dismiss j-del" title="Eliminar">🗑</button>
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
    $('#msg-feed').append(el(`<div class="mrow ${e.direction === 'outgoing' ? 'out' : ''}">
      <div class="who"><span>${sourceBadge(e.source)} ${who}</span>${e.hasAttachment ? '<span class="paperclip">📎</span>' : ''}</div>
      <div class="clip">${esc(e.body)}</div></div>`));
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
      ${e.sourceQuote ? `<div class="quote">🔎 "${esc(e.sourceQuote)}"</div>` : ''}
      <div class="who">${e.client ? 'cliente: ' + esc(displayName(e.client)) : ''}</div></div>`));
  }
}

function startStream(url, statusEl, onDone) {
  resetFeeds();
  counters.msgs = counters.vis = counters.tasks = 0;
  statusEl.textContent = 'iniciando…';
  const es = new EventSource(url);
  es.onmessage = (ev) => {
    const e = JSON.parse(ev.data);
    if (e.type === 'start') statusEl.textContent = `leyendo ${e.total} mensajes${e.vision ? ', visión activada' : ''}…`;
    else if (e.type === 'batch') statusEl.textContent = `procesados ${e.processed}/${e.total} · ${e.proposed} propuestas…`;
    else if (e.type === 'done') {
      statusEl.textContent = `listo — ${e.proposed} tarea(s) propuesta(s)`;
      if (!counters.tasks) $('#task-feed').append(el('<div class="empty">No se encontraron tareas.</div>'));
      es.close();
      onDone();
    } else handleEvent(e);
  };
  es.addEventListener('failed', (ev) => {
    statusEl.textContent = 'error: ' + JSON.parse(ev.data).message;
    es.close();
    onDone();
  });
  es.onerror = () => es.close();
  return es;
}

$('#run').addEventListener('click', () => {
  const limit = Number($('#limit').value) || 40;
  const vision = $('#vision').checked ? 1 : 0;
  const cap = Number($('#visionCap').value) || 10;
  startStream(`/api/extract/stream?limit=${limit}&vision=${vision}&cap=${cap}`, $('#run-status'), () => {
    loadInbox();
    loadStats();
  });
});

$('#process').addEventListener('click', () => {
  startStream(`/api/process/stream?vision=1&cap=15`, $('#proc-status'), () => {
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
const clientsSel = makeSelection('clients', () => filteredSenders().map((s) => s.handle));
function filteredSenders() {
  const q = $('#clients-search').value;
  return sendersItems.filter((s) => matches(q, s.handle, s.displayName, s.name, s.productNeed));
}
async function loadSenders() {
  sendersItems = await (await fetch('/api/senders')).json();
  clientsSel.clear();
  renderSenders();
}
function renderSenders() {
  const list = $('#senders-list');
  list.innerHTML = '';
  const items = filteredSenders();
  if (!items.length) {
    list.append(el(`<div class="empty">${sendersItems.length ? 'Nada coincide con la búsqueda.' : 'Aún no hay remitentes — primero importa algunos mensajes.'}</div>`));
    clientsSel.refresh();
    return;
  }
  for (const s of items) {
    const resolved = s.displayName && s.displayName !== s.handle ? s.displayName : '';
    const card = el(`<div class="card sender">
      <input type="checkbox" class="sel" data-id="${esc(s.handle)}" />
      <span class="handle">${esc(s.handle)}</span>
      ${resolved ? `<span class="rn">${esc(resolved)}</span>` : '<span class="rn unnamed">sin nombre</span>'}
      <span class="count">${s.count} msjs</span>
      <input class="nm" placeholder="${resolved ? 'cambiar nombre' : 'nombre'}" value="${esc(s.name || '')}" />
      <input class="pn" placeholder="qué compran / necesitan" value="${esc(s.productNeed || '')}" />
      <button class="approve save">Guardar</button>
      <span class="saved"></span>
    </div>`);
    clientsSel.bind(card.querySelector('.sel'), s.handle);
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
        <button class="approve j-restore">↩ Restaurar</button>
        <button class="dismiss j-purge">Borrar definitivamente</button>
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
        <button class="approve j-restore">↩ Restaurar</button>
        <button class="dismiss j-purge">Borrar definitivamente</button>
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

function bubble(role, text) {
  return el(`<div class="bubble ${role === 'user' ? 'user' : 'bot'}">${esc(text)}</div>`);
}

async function loadThreads() {
  const threads = await (await fetch('/api/threads')).json();
  const list = $('#thread-list');
  list.innerHTML = '';
  for (const t of threads) {
    const item = el(`<div class="thread-item ${t.id === currentThreadId ? 'active' : ''}">
      <span class="tt">${esc(t.title)}</span>
      <button class="del-thread" title="Eliminar conversación">🗑</button>
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
  showChatView();
  const msgs = await (await fetch(`/api/threads/${id}`)).json();
  const log = $('#chat-log');
  log.innerHTML = '';
  for (const m of msgs) log.append(bubble(m.role, m.content));
  log.scrollTop = log.scrollHeight;
  await loadThreads();
}

function newThread() {
  currentThreadId = null;
  showChatView();
  const log = $('#chat-log');
  log.innerHTML = '';
  log.append(el('<div class="empty">Nueva conversación. Pregúntame sobre tus mensajes, clientes o tareas.</div>'));
  document.querySelectorAll('.thread-item').forEach((i) => i.classList.remove('active'));
  $('#chat-input').focus();
}

function showChatView() {
  $('#memory-panel').hidden = true;
  $('#chat-log').style.display = '';
  $('#chat-form').style.display = '';
}

async function initChat() {
  if (chatInited) return;
  chatInited = true;
  await Promise.all([loadThreads(), loadMemory()]);
  const threads = await (await fetch('/api/threads')).json();
  if (threads.length) openThread(threads[0].id);
  else newThread();
}

$('#new-thread').onclick = newThread;

$('#chat-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const input = $('#chat-input');
  const text = input.value.trim();
  if (!text) return;
  input.value = '';
  showChatView();
  const log = $('#chat-log');
  if (log.querySelector('.empty')) log.innerHTML = '';
  log.append(bubble('user', text));
  const thinking = el('<div class="bubble bot thinking">pensando…</div>');
  log.append(thinking);
  log.scrollTop = log.scrollHeight;
  try {
    const r = await (
      await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ threadId: currentThreadId, message: text }),
      })
    ).json();
    thinking.remove();
    if (r.threadId) currentThreadId = r.threadId;
    log.append(bubble('bot', r.reply || `(error: ${r.error || 'sin respuesta'})`));
    if (r.usedTools && r.usedTools.includes('save_memory')) {
      log.append(el('<div class="empty" style="padding:6px">🧠 guardé algo en la memoria</div>'));
      loadMemory();
    }
    if (r.createdThread) await loadThreads();
  } catch (err) {
    thinking.remove();
    log.append(bubble('bot', `(error: ${String(err)})`));
  }
  log.scrollTop = log.scrollHeight;
});

// ---- Memory ----
async function loadMemory() {
  const mems = await (await fetch('/api/memory')).json();
  $('#memory-count').textContent = mems.length;
  const list = $('#memory-list');
  list.innerHTML = '';
  if (!mems.length) {
    list.append(el('<div class="empty">El asistente aún no ha guardado nada. Cuéntale algo que deba recordar.</div>'));
    return;
  }
  for (const m of mems) {
    const card = el(`<div class="card mem-item">
      <span class="mc">${esc(m.content)}</span>
      <button class="dismiss">🗑</button>
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
  initUpdates();
}

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
        list.innerHTML =
          '<div class="empty">No se puede acceder a iMessage. Concede <b>Acceso total al disco</b> a esta app en ' +
          'Ajustes del Sistema → Privacidad y seguridad → Acceso total al disco, y vuelve a abrirla.</div>';
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
$('#wachats-search').addEventListener('input', (e) => filterChatRows('#wachats-list', e.target.value));

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

// ---- WhatsApp chat selection ----
async function loadWaChats() {
  const list = $('#wachats-list');
  list.innerHTML = '<div class="empty">cargando…</div>';
  let data;
  try {
    data = await (await fetch('/api/whatsapp/chats')).json();
  } catch {
    list.innerHTML = '<div class="empty">no se pudieron cargar los chats</div>';
    return;
  }
  if (!data.ready) {
    list.innerHTML = '<div class="empty">Primero conecta WhatsApp (sección de arriba) y vuelve a abrir Ajustes.</div>';
    $('#wachats-note').textContent = 'Conecta WhatsApp para elegir qué chats incluir.';
    return;
  }
  $('#wachats-note').textContent = data.filtering
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
        <span class="ct">${c.isGroup ? 'grupo' : 'directo'}</span>
      </label>`),
    );
  }
  filterChatRows('#wachats-list', $('#wachats-search').value);
}

async function saveWaChatSelection(ids) {
  await fetch('/api/settings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ waSelectedChats: ids }),
  });
  $('#wachats-saved').textContent = '✓ guardado';
  await loadWaChats();
}

$('#save-wachats').addEventListener('click', () => {
  const ids = [...document.querySelectorAll('#wachats-list input:checked')].map((i) => i.value);
  saveWaChatSelection(ids);
});
$('#clear-wachats').addEventListener('click', () => saveWaChatSelection([]));

// ---- WhatsApp ----
function renderWa(st) {
  const badge = $('#wa-status');
  const body = $('#wa-body');
  badge.textContent = waLabel(st.status);
  badge.className =
    'badge ' +
    (st.status === 'ready'
      ? 'b-done'
      : ['qr', 'starting', 'authenticated'].includes(st.status)
        ? 'b-waiting'
        : 'b-todo');

  if (st.status === 'ready') {
    body.innerHTML = '';
    const row = el(`<div class="setrow">
      <span class="saved">✓ Conectado</span>
      <button id="wa-backfill" class="primary">Importar historial</button>
      <span id="wa-bf" class="run-status"></span>
    </div>`);
    body.append(row);
    $('#wa-backfill').onclick = async () => {
      $('#wa-bf').textContent = 'obteniendo… (puede tardar un minuto)';
      const r = await (
        await fetch('/api/whatsapp/backfill', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ perChat: 50 }),
        })
      ).json();
      $('#wa-bf').textContent = r.error ? 'error: ' + r.error : `importados ${r.inserted} de ${r.chats} chats`;
      loadStats();
    };
  } else if (st.status === 'qr' && st.qrDataUrl) {
    body.innerHTML = `<img class="wa-qr" src="${st.qrDataUrl}" alt="QR de WhatsApp" /><p class="hint">Escanea en ~60 s; el código se actualiza solo.</p>`;
  } else if (st.status === 'starting' || st.status === 'authenticated') {
    const d = st.detail ? esc(st.detail) : 'abriendo un navegador en segundo plano, ~10–20 s';
    const attempt = st.attempts > 1 ? ` <span class="muted">(intento ${st.attempts})</span>` : '';
    body.innerHTML = `<div class="hint">conectando… ${d}${attempt}</div>`;
    const row = el('<div class="setrow"></div>');
    const reset = el('<button id="wa-reset">Reconectar</button>');
    reset.onclick = () => waReconnect(body);
    row.append(reset);
    // Escape hatch if a sync is genuinely wedged (not just slow): full re-pair.
    const repair = el('<button id="wa-repair">Volver a vincular</button>');
    repair.onclick = () => waRepair(body);
    row.append(repair);
    body.append(row);
  } else {
    body.innerHTML = '';
    if (st.lastError) body.append(el(`<div class="hint err">⚠️ ${esc(st.lastError)}</div>`));
    const row = el('<div class="setrow"></div>');
    const btn = el('<button id="wa-connect" class="primary">Conectar WhatsApp</button>');
    btn.onclick = () => waReconnect(body);
    row.append(btn);
    // Re-pair is the escape hatch for a corrupted session (loses the pairing).
    const repair = el('<button id="wa-repair">Volver a vincular (reiniciar y escanear)</button>');
    repair.onclick = () => waRepair(body);
    row.append(repair);
    body.append(row);
  }
}

// Re-pair = wipe the stored session and start fresh (shows a new QR). Use when
// the session is corrupted and a plain Reconnect won't clear it.
async function waRepair(body) {
  if (!confirm('¿Reiniciar WhatsApp y escanear un nuevo código QR? Esto borra la vinculación actual.')) return;
  body.innerHTML = '<div class="hint">reiniciando sesión… aparecerá un QR en breve</div>';
  try {
    await fetch('/api/whatsapp/repair', { method: 'POST' });
  } catch {
    /* fall through to polling */
  }
  setTimeout(refreshWa, 1500);
}

// Reset = stop, scrub orphan Chrome + stale locks, reconnect. Recovers a stuck
// state (the recurring "connecting…" hang) without touching the terminal.
async function waReconnect(body) {
  body.innerHTML = '<div class="hint">reiniciando… (cerrando el navegador atascado)</div>';
  try {
    await fetch('/api/whatsapp/reset', { method: 'POST' });
  } catch {
    /* fall through to polling */
  }
  setTimeout(refreshWa, 1500);
}

async function refreshWa() {
  let st;
  try {
    st = await (await fetch('/api/whatsapp/status')).json();
  } catch {
    return;
  }
  renderWa(st);
  // Keep polling while pairing/connecting.
  if (['starting', 'qr', 'authenticated'].includes(st.status)) {
    setTimeout(() => {
      if (document.querySelector('#settings').classList.contains('active')) refreshWa();
    }, 2500);
  }
}

(async () => {
  await loadNames();
  loadStats();
  loadInbox();
  loadTasks();
})();
