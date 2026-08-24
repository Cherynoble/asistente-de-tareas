// app-chat.js — Chat tab: threads, uploads, agenda, digest, memory.
// Split from the old single app.js (1.8.0-dev). These files are CLASSIC scripts
// sharing one global scope; index.html loads them in a fixed order that mirrors
// the original file, so cross-file references keep working. Keep new top-level
// names unique across app-*.js.

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
