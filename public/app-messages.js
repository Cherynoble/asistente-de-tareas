// app-messages.js — Mensajes tab: sidebar, thread, selection.
// Split from the old single app.js (1.8.0-dev). These files are CLASSIC scripts
// sharing one global scope; index.html loads them in a fixed order that mirrors
// the original file, so cross-file references keep working. Keep new top-level
// names unique across app-*.js.

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

const msgDayKey = (ms) => fmtDayKey(ms);
const msgDayLabel = (ms) =>
  fmtDayLong(ms);
const msgTime = (ms) => new Date(ms).toLocaleTimeString(I18N_BCP47, { hour: '2-digit', minute: '2-digit' });

/** Short relative-ish stamp for the chat list: time today, date otherwise. */
function msgWhen(ms) {
  if (!ms) return '';
  const d = new Date(ms);
  return msgDayKey(ms) === msgDayKey(Date.now())
    ? msgTime(ms)
    : fmtShortDate(ms);
}

function msgChatLabel(c) {
  return c.displayName || tr('messages.noName');
}

// ---- sidebar ----

async function loadMsgChats() {
  const r = await (await fetch('/api/messages/chats')).json();
  msgChats = r.chats || [];
  renderMsgSide();
}

let msgSearchSeq = 0;
async function runMsgSearch(q) {
  const seq = ++msgSearchSeq;
  if (!q || q.trim().length < 2) {
    msgHits = [];
    renderMsgSide();
    return;
  }
  const r = await (await fetch(`/api/messages/search?q=${encodeURIComponent(q.trim())}&limit=40`)).json();
  // A slower response for an earlier query must not overwrite the results of
  // the query the user actually typed last.
  if (seq !== msgSearchSeq) return;
  msgHits = r.hits || [];
  renderMsgSide();
}

function renderMsgSide() {
  const q = $('#msg-search').value.trim();
  const box = $('#msg-chats');
  const shown = msgChats.filter((c) => matches(q, msgChatLabel(c), c.chatId));

  let html = '';
  if (msgHits.length) {
    html += `<div class="msg-sec">${esc(tr('messages.matching', { n: msgHits.length }))}</div>`;
    html += msgHits
      .map(
        (h) => `<button class="msg-hit" data-hit="${h.id}">
          <span class="msg-hit-top">${sourceBadge(h.source)}${esc(h.senderName || prettySender(h.sender, h.senderName))}
            <span class="msg-chat-when">${esc(msgWhen(h.ts))}</span></span>
          <span class="msg-hit-body">${esc((h.body || '').slice(0, 140))}</span>
        </button>`,
      )
      .join('');
    html += `<div class="msg-sec">${esc(tr('messages.conversations', { n: shown.length }))}</div>`;
  }

  html += shown.length
    ? shown
        .map((c) => {
          const preview = (c.lastDirection === 'outgoing' ? tr('messages.mePrefix') : '') + (c.lastBody || tr('messages.fileFallback'));
          return `<button class="msg-chat${c.chatId === msgChatId ? ' active' : ''}" data-chat="${esc(c.chatId)}">
            <span class="msg-chat-top">
              <span class="msg-chat-name">${esc(msgChatLabel(c))}</span>
              <span class="msg-chat-when">${esc(msgWhen(c.lastTs))}</span>
            </span>
            <span class="msg-chat-prev">${sourceBadge(c.source)}${accountBadge(c.source, c.waAccount)}${esc(preview.slice(0, 90))}</span>
            <span class="msg-chat-counts">
              <span>${c.total} msj</span>
              ${c.unprocessed ? `<span class="msg-warn">${esc(tr('messages.nUnprocessed', { n: c.unprocessed }))}</span>` : ''}
              ${c.withAttachments ? `<span>${esc(tr('messages.nAttachments', { n: c.withAttachments }))}</span>` : ''}
              ${c.included ? '' : `<span class="msg-excl">${esc(tr('messages.notImported'))}</span>`}
            </span>
          </button>`;
        })
        .join('')
    : `<div class="msg-empty">${esc(tr('messages.noChatMatch'))}</div>`;

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
  $('#msg-title').textContent = chat ? msgChatLabel(chat) : tr('messages.conversation');
  $('#msg-tools').hidden = false;
  renderMsgSide();

  const url = anchorTs
    ? msgQuery({ dir: 'around', cursorTs: String(anchorTs), cursorId: '0' })
    : msgQuery({});
  msgLoading = true;
  $('#msg-thread').innerHTML = `<div class="msg-empty">${esc(tr('common.loading'))}</div>`;
  try {
    const r = await (await fetch(url)).json();
    msgRows = r.messages || [];
    msgHasOlder = !!r.hasOlder;
    msgHasNewer = !!r.hasNewer;
    renderMsgStats(r.stats);
    renderMsgThread(msgAnchorId || msgAnchorTs ? 'anchor' : 'bottom');
    renderMsgSelection();
  } catch (err) {
    // Without this a failed fetch leaves "Cargando…" on screen forever.
    $('#msg-thread').innerHTML = `<div class="msg-empty">${esc(tr('messages.loadFailed'))} ${esc(String(err))}</div>`;
  } finally {
    msgLoading = false;
  }
}

function renderMsgStats(s) {
  if (!s) return;
  $('#msg-stats').innerHTML =
    `<span>${esc(tr('messages.nMessages', { n: s.total }))}</span>` +
    `<span class="${s.unprocessed ? 'msg-warn' : ''}">${esc(tr('messages.nUnprocessed', { n: s.unprocessed || 0 }))}</span>` +
    `<span>${esc(tr('messages.nWithAttachments', { n: s.withAttachments || 0 }))}</span>`;
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
        const label = esc(a.filename || a.category || tr('att.file'));
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
    <input class="msg-pick" type="checkbox" ${picked ? 'checked' : ''} aria-label="${esc(tr('messages.selectMessage'))}" />
    <div class="msg-bubble">
      ${showWho && who ? `<div class="msg-who">${esc(who)}</div>` : ''}
      ${msgAttHtml(m)}
      ${m.body ? `<div class="msg-text">${esc(m.body)}</div>` : ''}
      <div class="msg-meta">
        <span>${esc(msgTime(m.ts))}</span>
        ${m.processed ? '' : `<span class="msg-flag warn">${esc(tr('messages.unprocessed'))}</span>`}
        ${m.tasks.length ? `<span class="msg-flag ok">${esc(trn('messages.nTasks', m.tasks.length))}</span>` : ''}
        <button class="msg-info" title="${esc(tr('messages.technicalDetails'))}" aria-label="${esc(tr('messages.technicalDetails'))}">${ico('diag')}</button>
      </div>
    </div>
  </div>`;
}

function renderMsgThread(scroll) {
  const box = $('#msg-thread');
  if (!msgRows.length) {
    box.innerHTML = `<div class="msg-empty">${
      msgFilters.find || msgFilters.unproc || msgFilters.files
        ? tr('messages.noMessageMatch')
        : tr('messages.emptyConversation')
    }</div>`;
    return;
  }

  let html = msgHasOlder ? `<div class="msg-more">${esc(tr('messages.scrollOlder'))}</div>` : '';
  let day = '';
  let prevSender = null;
  for (const m of msgRows) {
    const k = msgDayKey(m.ts);
    if (k !== day) {
      day = k;
      prevSender = null;
      html += `<button class="msg-day" data-day="${esc(k)}" title="${esc(tr('messages.selectWholeDay'))}">${esc(msgDayLabel(m.ts))}</button>`;
    }
    // Only label the first message of a run from the same person.
    html += msgRowHtml(m, m.sender !== prevSender);
    prevSender = m.sender;
  }
  if (msgHasNewer) html += `<div class="msg-more">${esc(tr('messages.scrollNewer'))}</div>`;
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
    trn('messages.nSelected', n) + (n >= MSG_MAX_SEL ? ` ${tr('messages.maxSel', { max: MSG_MAX_SEL })}` : '');
  const opt = $('#msg-visopt');
  opt.hidden = files === 0;
  $('#msg-vislabel').textContent = trn('messages.analyzeNFiles', files);
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
    [tr('detail.internalId'), m.id],
    [tr('detail.sourceId'), m.sourceMsgId],
    [tr('detail.source'), m.source + (m.waAccount ? ` (${m.waAccount})` : '')],
    [tr('detail.conversation'), m.chatId || '—'],
    [tr('detail.sender'), m.sender || '—'],
    [tr('detail.date'), fmtDateTime(m.ts)],
    [tr('detail.analyzedByAi'), m.processed ? tr('common.yes') : tr('common.no')],
    [tr('detail.attachments'), m.attachments.length ? m.attachments.map((a) => `${a.filename || a.category} (${a.state})`).join(', ') : tr('common.none')],
    [tr('detail.generatedTasks'), m.tasks.length ? m.tasks.map((t) => `#${t.id} ${t.title}`).join(' · ') : tr('common.noneF')],
  ];
  msgModal(
    tr('messages.messageDetails'),
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
        <button class="msg-modal-x" aria-label="${esc(tr('common.close'))}">${ico('close')}</button></div>
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
  btn.innerHTML = esc(tr('messages.analyzing'));
  try {
    const r = await (
      await fetch('/api/messages/reanalyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids, vision: $('#msg-vision').checked }),
      })
    ).json();

    if (r.error) {
      msgModal(tr('messages.analyzeFailed'), `<p class="hint">${esc(r.error)}</p>`);
      return;
    }

    const head =
      `<p class="hint">${esc(trn('messages.nAnalyzed', r.messages))}` +
      `${r.filesAnalyzed ? esc(', ' + trn('messages.nFilesRead', r.filesAnalyzed)) : ''}.</p>`;

    // Proposals the server refused because their twin already exists — the
    // deterministic dedup that keeps a repeated "Analizar" from re-creating
    // the same task on the run where the model's own judgment slips.
    const dups = r.duplicates || [];
    const dupList = dups.length
      ? `<ul class="msg-proposed">` +
        dups.map((t) => `<li><b>${esc(t.title)}</b> <span class="msg-flag">${esc(statusLabel(t.state))}</span></li>`).join('') +
        `</ul>`
      : '';

    let body;
    if (r.proposed.length) {
      body =
        head +
        `<p><b>${esc(trn('messages.nNewTasks', r.proposed.length))}</b>${esc(tr('messages.alreadyInInbox'))}</p><ul class="msg-proposed">` +
        r.proposed
          .map(
            (t) =>
              `<li><b>${esc(t.title)}</b>${t.client ? ` <span class="msg-flag">${esc(displayName(t.client) || t.client)}</span>` : ''}${
                t.detail ? `<div class="hint">${esc(t.detail)}</div>` : ''
              }</li>`,
          )
          .join('') +
        `</ul>` +
        (dups.length
          ? `<p class="hint">${esc(trn('messages.skippedDuplicates', dups.length))}</p>` + dupList
          : '');
    } else if (dups.length) {
      // The model proposed something, but each proposal already exists — say
      // exactly which, so a repeat analysis reads as confirmation, not failure.
      body =
        head +
        `<p>${esc(tr('messages.noNewTasksExisting'))}</p>` +
        dupList;
    } else {
      // A zero here almost always means "already covered", not "nothing found":
      // the extractor is given the open tasks and told not to duplicate them.
      body =
        head +
        `<p>${esc(tr('messages.noNewTasksCovered'))}</p>` +
        (r.related.length
          ? `<p class="hint">${esc(tr('messages.relatedOpenTasks'))}</p><ul class="msg-proposed">` +
            r.related.map((t) => `<li><b>${esc(t.title)}</b> <span class="msg-flag">${esc(statusLabel(t.status))}</span></li>`).join('') +
            `</ul>`
          : '');
    }
    msgModal(tr('messages.analysisResult'), body);
    if (r.proposed.length) {
      loadInbox();
      loadStats();
    }
  } catch (err) {
    msgModal(tr('messages.analyzeFailed'), `<p class="hint">${esc(String(err))}</p>`);
  } finally {
    btn.disabled = false;
    btn.innerHTML = was;
  }
}

async function msgToChat() {
  const ids = [...msgSel];
  if (!ids.length) return;
  // Disabled while in flight: each call creates a thread server-side, so a
  // double click would leave an orphan empty conversation in the Chat tab.
  const btn = $('#msg-tochat');
  if (btn.disabled) return;
  btn.disabled = true;
  let r;
  try {
    r = await (
      await fetch('/api/messages/to-chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids }),
      })
    ).json();
  } catch (err) {
    msgModal(tr('messages.sendToChatFailed'), `<p class="hint">${esc(String(err))}</p>`);
    return;
  } finally {
    btn.disabled = false;
  }
  if (r.error) {
    msgModal(tr('messages.sendToChatFailed'), `<p class="hint">${esc(r.error)}</p>`);
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
