// app-settings.js — Ajustes: settings, diagnostics, updates, AI provider.
// Split from the old single app.js (1.8.0-dev). These files are CLASSIC scripts
// sharing one global scope; index.html loads them in a fixed order that mirrors
// the original file, so cross-file references keep working. Keep new top-level
// names unique across app-*.js.

// ---- Settings ----
async function loadSettings() {
  const s = await (await fetch('/api/settings')).json();
  loadAiSettings();
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
          .map((s) => `${s.source}: ${s.count} (${tr('diag.last')} ${s.lastAt ? fmtMsgTime(s.lastAt) : '—'})`)
          .join(' · ')
      : tr('diag.noMessages');
    const unproc = d.unprocessed.count
      ? tr('diag.nUnprocessed', { n: d.unprocessed.count, oldest: fmtMsgTime(d.unprocessed.oldestAt) })
      : tr('diag.allProcessed');
    box.innerHTML =
      `<div><b>${esc(tr('diag.database'))}</b> ${esc(d.dbPath)}</div>` +
      `<div><b>${esc(tr('diag.messages'))}</b> ${esc(src)}</div>` +
      `<div><b>${esc(tr('diag.queue'))}</b> ${esc(unproc)}</div>`;
    // Deliberately untranslated: this is a diagnostic blob meant to be pasted
    // back to whoever is debugging, so it stays stable across languages.
    lastDiagText = `dataDir: ${d.dataDir}\ndbPath: ${d.dbPath}\nmessages: ${src}\nqueue: ${unproc}`;
  } catch {
    box.textContent = tr('diag.loadFailed');
    lastDiagText = '';
  }
}

$('#diag-copy').addEventListener('click', async () => {
  if (!lastDiagText) return;
  try {
    await navigator.clipboard.writeText(lastDiagText);
    $('#diag-copied').textContent = tr('diag.copied') + ' ✓';
    setTimeout(() => ($('#diag-copied').textContent = ''), 2000);
  } catch {
    $('#diag-copied').textContent = tr('diag.copyFailed');
  }
});

// ---- Updates (only available inside the Electron app via the preload bridge) ----
let updatesWired = false;
let pendingUpdateZip = null;
async function initUpdates() {
  if (!window.updater) return; // running in a plain browser (dev) — hide the block
  $('#update-block').style.display = '';
  const v = await window.updater.version();
  $('#upd-status').textContent = tr('update.currentVersion', { v });
  if (!updatesWired) {
    updatesWired = true;
    $('#upd-check').addEventListener('click', runUpdateCheck);
    $('#upd-install').addEventListener('click', runUpdateInstall);
  }
}

async function runUpdateCheck() {
  const msg = $('#upd-msg');
  msg.textContent = tr('update.checking');
  $('#upd-install').style.display = 'none';
  $('#upd-badge').style.display = 'none';
  pendingUpdateZip = null;
  const r = await window.updater.check();
  if (r.status === 'up-to-date') {
    msg.textContent = tr('update.upToDate');
  } else if (r.status === 'available') {
    pendingUpdateZip = r.zipUrl;
    $('#upd-badge').style.display = '';
    $('#upd-install').style.display = '';
    msg.textContent = tr('update.available', { v: r.latestVersion }) + (r.notes ? ` ${r.notes}` : '');
  } else if (r.status === 'needs-new-app') {
    msg.innerHTML =
      `${esc(tr('update.needsNewApp', { v: r.latestVersion }))} ` +
      `<a href="${esc(r.page)}" target="_blank">${esc(tr('update.openPage'))}</a>.`;
  } else {
    msg.textContent = tr('update.checkFailed', { message: r.message || tr('common.error') });
  }
}

async function runUpdateInstall() {
  if (!pendingUpdateZip) return;
  $('#upd-install').disabled = true;
  $('#upd-msg').textContent = tr('update.installing');
  const r = await window.updater.apply(pendingUpdateZip);
  if (!r.ok) {
    $('#upd-install').disabled = false;
    $('#upd-msg').textContent = tr('update.installFailed', { message: r.message || tr('common.error') });
  }
  // on success the main process relaunches the app automatically
}

async function loadReminderPreview() {
  try {
    const r = await (await fetch('/api/reminders')).json();
    const c = r.digest.counts;
    $('#rem-preview').textContent = c.total
      ? tr('reminders.preview', { total: c.total, overdue: c.overdue, todo: c.todo, waiting: c.waiting })
      : tr('reminders.previewEmpty');
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
  $('#rem-saved').textContent = '✓ ' + tr('common.saved');
});

$('#rem-test').addEventListener('click', async () => {
  await fetch('/api/reminders/test', { method: 'POST' });
  $('#rem-saved').textContent = tr('reminders.testSent');
});

$('#rem-digest').addEventListener('click', async () => {
  await fetch('/api/reminders/digest', { method: 'POST' });
  $('#rem-saved').textContent = tr('reminders.digestSent');
  loadReminderPreview();
});

$('#rem-nudge').addEventListener('click', async () => {
  const r = await (await fetch('/api/reminders/nudge', { method: 'POST' })).json();
  $('#rem-saved').textContent = r.result?.nudged
    ? tr('reminders.nudged', { n: r.result.nudged })
    : tr('reminders.nothingToNudge');
  loadReminderPreview();
});

// ---- AI provider (Anthropic / Kimi / DeepSeek / Qwen / GLM / Ollama / custom) ----
let aiStatusCache = null;

function fillAiFields(providerId) {
  if (!aiStatusCache) return;
  const p = aiStatusCache.providers.find((x) => x.id === providerId) || aiStatusCache.providers[0];
  $('#ai-model').value = p.model || '';
  $('#ai-baseurl').value = p.baseUrl || '';
  $('#ai-baseurl-row').style.display = p.id === 'anthropic' ? 'none' : '';
  $('#ai-vision').checked = !!p.vision;
  $('#api-key').value = '';
  $('#api-key').placeholder = p.hasKey
    ? tr('ai.keySaved')
    : p.needsKey
      ? `${tr('ai.apiKey')}${p.keyHint ? ` (${p.keyHint})` : ''}`
      : tr('ai.noKeyOptional');
  const active = aiStatusCache.active;
  $('#key-status').textContent =
    active.provider === p.id
      ? active.configured
        ? tr('ai.activeProvider', { name: active.name })
        : tr('ai.missingKeyOrModel')
      : tr('ai.willSwitch', { name: active.name });
}

async function loadAiSettings() {
  try {
    aiStatusCache = await (await fetch('/api/ai')).json();
  } catch {
    return;
  }
  const sel = $('#ai-provider');
  sel.innerHTML = aiStatusCache.providers
    .map((p) => `<option value="${esc(p.id)}">${esc(p.label)}</option>`)
    .join('');
  sel.value = aiStatusCache.active.provider;
  fillAiFields(sel.value);
}

$('#ai-provider').addEventListener('change', () => fillAiFields($('#ai-provider').value));

$('#save-key').addEventListener('click', async () => {
  const body = {
    provider: $('#ai-provider').value,
    model: $('#ai-model').value.trim(),
    baseUrl: $('#ai-baseurl').value.trim(),
    vision: $('#ai-vision').checked,
  };
  const apiKey = $('#api-key').value.trim();
  if (apiKey) body.apiKey = apiKey; // empty = keep the stored key
  await fetch('/api/ai', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  $('#key-saved').textContent = '✓ ' + tr('common.saved');
  $('#ai-test-result').textContent = '';
  await Promise.all([loadAiSettings(), loadStats()]);
});

$('#ai-test').addEventListener('click', async () => {
  const out = $('#ai-test-result');
  out.textContent = tr('ai.testing');
  try {
    const r = await fetch('/api/ai/test', { method: 'POST' });
    const j = await r.json();
    out.textContent = j.ok
      ? `✓ ${tr('ai.replied', { name: j.name, reply: j.reply || 'ok' })}`
      : `✗ ${j.name ? j.name + ' — ' : ''}${j.error || tr('ai.connectionFailed')}`;
  } catch {
    out.textContent = '✗ ' + tr('ai.testFailed');
  }
});

$('#save-sched').addEventListener('click', async () => {
  await fetch('/api/settings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ schedulerEnabled: $('#sched-on').checked, dailyTime: $('#sched-time').value }),
  });
  $('#sched-saved').textContent = '✓ ' + tr('common.saved');
});

async function loadChats() {
  const list = $('#chats-list');
  list.innerHTML = `<div class="empty">${esc(tr('settings.loadingChats'))}</div>`;
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
          `<b>${esc(tr('fda.title'))}</b>` +
          `<p>${esc(tr('fda.intro'))}</p>` +
          '<ol>' +
          `<li>${esc(tr('fda.step1'))}</li>` +
          `<li>${esc(tr('fda.step2'))}</li>` +
          `<li>${esc(tr('fda.step3'))}</li>` +
          '</ol>' +
          `<p class="muted">${esc(tr('fda.fileItReads'))} <code>${path}</code></p>` +
          `<button id="chats-retry">${ico('refresh')}${esc(tr('common.retry'))}</button>` +
          '</div>';
        const retry = document.getElementById('chats-retry');
        if (retry) retry.onclick = () => loadChats();
      } else {
        list.innerHTML = `<div class="empty">${esc(e.error || tr('settings.chatsReadFailed'))}</div>`;
      }
      return;
    }
    data = await r.json();
  } catch {
    list.innerHTML = `<div class="empty">${esc(tr('settings.chatsReadFailed'))}</div>`;
    return;
  }
  $('#chats-note').textContent = data.filtering
    ? tr('settings.onlyCheckedChats')
    : tr('settings.noSelectionAllChats');
  list.innerHTML = '';
  for (const c of data.chats) {
    const name = c.displayName || c.name;
    const showId = name && name !== c.id;
    list.append(
      el(`<label class="chatrow" data-name="${esc((name + ' ' + c.id).toLowerCase())}">
      <input type="checkbox" value="${esc(c.id)}" ${c.selected ? 'checked' : ''} />
      <span class="cn">${esc(name)}${showId ? ` <span class="cid">${esc(c.id)}</span>` : ''}</span>
      <span class="ct">${esc(c.isGroup ? tr('settings.group') : tr('settings.direct'))} · ${c.count}</span>
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
  $('#chats-saved').textContent = '✓ ' + tr('common.saved');
  await loadChats();
}

$('#save-chats').addEventListener('click', () => {
  const ids = [...document.querySelectorAll('#chats-list input:checked')].map((i) => i.value);
  saveChatSelection(ids);
});
$('#clear-chats').addEventListener('click', () => saveChatSelection([]));

// ---- Language ----
// The three buttons show ENDONYMS (Español / English / 中文), which are never
// translated — a picker that renders every option in the language you can't
// read is useless. Switching reloads the page: the catalog is server-rendered
// (see routes/i18n.ts) and every AI prompt is rebuilt from the new setting, so
// a reload is both the simplest and the most complete way to apply it.
function paintLangSeg(active) {
  document.querySelectorAll('#lang-seg .seg-btn').forEach((b) => {
    const on = b.dataset.lang === active;
    b.classList.toggle('active', on);
    b.setAttribute('aria-pressed', String(on));
  });
}

document.querySelectorAll('#lang-seg .seg-btn').forEach((b) => {
  b.onclick = async () => {
    const lang = b.dataset.lang;
    if (lang === I18N_LOCALE) return;
    paintLangSeg(lang);
    $('#lang-saved').textContent = '…';
    try {
      const res = await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ uiLanguage: lang }),
      });
      if (!res.ok) throw new Error(String(res.status));
      location.reload();
    } catch {
      paintLangSeg(I18N_LOCALE);
      $('#lang-saved').textContent = tr('settings.languageFailed');
    }
  };
});
paintLangSeg(I18N_LOCALE);
