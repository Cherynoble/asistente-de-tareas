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
//
// These are a WIRE FORMAT, not UI text — never translate them, and never change
// the legacy pair. The Spanish literals are already stored inside chat_messages
// rows in every existing database; renaming them would silently break the
// rendering of every thread that has a selection in it. So: WRITE the neutral
// pair from now on, READ both forever. No migration, no risk.
const SEL_OPEN = '⟦SELECTION⟧';
const SEL_CLOSE = '⟦/SELECTION⟧';
const SEL_OPEN_LEGACY = '⟦SELECCIÓN⟧';
const SEL_CLOSE_LEGACY = '⟦/SELECCIÓN⟧';

/** Locate the selection block, accepting either the neutral or legacy pair. */
function findSelectionBlock(raw) {
  for (const [o, c] of [
    [SEL_OPEN, SEL_CLOSE],
    [SEL_OPEN_LEGACY, SEL_CLOSE_LEGACY],
  ]) {
    const open = raw.indexOf(o);
    const close = raw.indexOf(c);
    if (open !== -1 && close > open) return { open, close, openLen: o.length, closeLen: c.length };
  }
  return null;
}

function bubble(role, text, attachments) {
  const atts = (attachments || []).map((a) => `<span class="att">${ico('clip')}${esc(a.name)}</span>`).join('');
  const raw = text ?? '';
  let quoted = '';
  let rest = raw;
  const found = findSelectionBlock(raw);
  if (found) {
    const { open, close, openLen, closeLen } = found;
    const inner = raw.slice(open + openLen, close).trim();
    const nl = inner.indexOf('\n');
    const header = nl === -1 ? inner : inner.slice(0, nl);
    const body = nl === -1 ? '' : inner.slice(nl + 1);
    quoted =
      `<details class="sel-quote"><summary>${ico('message')}${esc(header)}</summary>` +
      `<pre>${esc(body)}</pre></details>`;
    rest = (raw.slice(0, open) + raw.slice(close + closeLen)).trim();
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
      <button class="del-thread" title="${esc(tr('chat.deleteThread'))}" aria-label="${esc(tr('chat.deleteThread'))}">${ico('trash')}</button>
    </div>`);
    item.querySelector('.tt').onclick = () => openThread(t.id);
    item.querySelector('.del-thread').onclick = async (e) => {
      e.stopPropagation();
      if (!confirm(tr('chat.confirmDeleteThread'))) return;
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
  log.append(el(`<div class="empty">${ico('chat', 'ico-xl')}${esc(tr('chat.emptyThread'))}</div>`));
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
  chip.innerHTML = `${ico('clip')}${esc(f.name)} <button title="${esc(tr('att.remove'))}" aria-label="${esc(tr('chat.removeFile'))}">${ico('close')}</button>`;
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
    ` <span class="sel-hint">${esc(tr('chat.selectionHint'))}</span></summary>` +
    `<pre>${esc(pendingSelection.preview)}</pre></details>` +
    `<button class="sel-drop" title="${esc(tr('chat.dropSelection'))}" aria-label="${esc(tr('chat.dropSelection'))}">${ico('close')}</button>`;
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
  const thinking = el(`<div class="bubble bot thinking">${esc(file ? tr('chat.analyzingFile') : tr('chat.thinking'))}</div>`);
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
    log.append(bubble('bot', r.reply || `(${tr('common.errorPrefix', { message: r.error || tr('chat.noReply') })})`));
    handleChatTools(r, log);
    if (r.createdThread) await loadThreads();
  } catch (err) {
    thinking.remove();
    log.append(bubble('bot', `(${tr('common.errorPrefix', { message: String(err) })})`));
  }
  log.scrollTop = log.scrollHeight;
});

function handleChatTools(r, log) {
  const note = (t) => log.append(el(`<div class="empty" style="padding:6px">${t}</div>`));
  const used = r.usedTools || [];
  if (used.includes('save_memory')) { note(ico('memory') + ' ' + esc(tr('chat.savedMemory'))); loadMemory(); }
  if (used.includes('create_task')) {
    note(ico('check') + ' ' + esc(tr('chat.createdTask')));
    loadInbox();
    loadTasks();
    loadStats();
  }
  if (used.includes('schedule_reminder')) { note(ico('clock') + ' ' + esc(tr('chat.scheduledReminder'))); loadReminders(); }
}

// ---- Scheduled reminders (chat subtab) ----
async function loadReminders() {
  const rs = await (await fetch('/api/agenda')).json();
  $('#reminders-count').textContent = rs.length;
  const list = $('#reminders-list');
  list.innerHTML = '';
  if (!rs.length) {
    list.append(el(`<div class="empty">${ico('clock', 'ico-xl')}${esc(tr('chat.noReminders'))}</div>`));
    return;
  }
  for (const r of rs) {
    const overdue = r.dueAt < Date.now();
    const when = fmtDateTime(r.dueAt);
    const card = el(`<div class="card mem-item">
      <span class="mc"><b>${esc(r.text)}</b><br><span class="${overdue ? 'overdue-when' : 'muted'}" style="font-size:12px">${overdue ? ico('warn') + ' ' : ''}${esc(when)}</span></span>
      <button class="dismiss iconbtn" title="${esc(tr('common.cancel'))}" aria-label="${esc(tr('chat.cancelReminder'))}">${ico('trash')}</button>
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
      const sec = el(`<div class="dsec"><h4>${ico('clock')}${esc(tr('chat.recordatorios'))}</h4></div>`);
      for (const r of reminders)
        sec.append(el(`<div class="ditem"><div class="dt">${esc(r.text)}</div><div class="dd">${esc(fmtDateTime(r.dueAt))}</div></div>`));
      body.append(sec);
    }
    if (newTasks.length) {
      const sec = el(`<div class="dsec"><h4>${ico('new')}${esc(tr('digest.newTasks'))} <span class="dg-count">(${newTasks.length})</span></h4></div>`);
      for (const t of newTasks) {
        const item = el(`<div class="ditem ditem-task">
          <div class="dt">${esc(t.title)}</div>
          ${t.clientHint ? `<div class="dd">${esc(tr('tasks.clientLabel', { who: displayName(t.clientHint) }))}</div>` : ''}
          <div class="dactions">
            <button class="approve j-dg-approve">${ico('check')}${esc(tr('inbox.approve'))}</button>
            <button class="dismiss j-dg-dismiss">${ico('trash')}${esc(tr('digest.dismiss'))}</button>
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
          settle(ico('check') + ' ' + esc(tr('digest.approved')));
        };
        item.querySelector('.j-dg-dismiss').onclick = async (e) => {
          e.target.disabled = true;
          await deleteTask(t.id); // → Papelera (existing bulk-delete)
          settle(ico('trash') + ' ' + esc(tr('digest.dismissed')));
        };
        sec.append(item);
      }
      body.append(sec);
    }
    if (!hasContent) {
      body.append(
        el(`<div class="dsec"><div class="ditem ditem-clear"><div class="dt">${ico('check')}${esc(tr('digest.allClear'))}</div><div class="dd">${esc(tr('digest.allClearBody'))}</div></div></div>`),
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
    list.append(el(`<div class="empty">${ico('memory', 'ico-xl')}${esc(tr('chat.noMemories'))}</div>`));
    return;
  }
  for (const m of mems) {
    const card = el(`<div class="card mem-item">
      <span class="mc">${esc(m.content)}</span>
      <button class="dismiss iconbtn" title="${esc(tr('chat.forget'))}" aria-label="${esc(tr('chat.forgetThis'))}">${ico('trash')}</button>
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
