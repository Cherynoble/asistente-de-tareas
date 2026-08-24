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
    ? 'clave guardada — pega otra para reemplazarla'
    : p.needsKey
      ? `clave de API${p.keyHint ? ` (${p.keyHint})` : ''}`
      : 'sin clave (opcional)';
  const active = aiStatusCache.active;
  $('#key-status').textContent =
    active.provider === p.id
      ? active.configured
        ? `Proveedor activo: ${active.name}.`
        : 'Este proveedor está seleccionado pero le falta clave o modelo.'
      : `Al guardar, la IA cambiará a este proveedor. Activo ahora: ${active.name}.`;
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
  $('#key-saved').textContent = '✓ guardado';
  $('#ai-test-result').textContent = '';
  await Promise.all([loadAiSettings(), loadStats()]);
});

$('#ai-test').addEventListener('click', async () => {
  const out = $('#ai-test-result');
  out.textContent = 'Probando conexión…';
  try {
    const r = await fetch('/api/ai/test', { method: 'POST' });
    const j = await r.json();
    out.textContent = j.ok
      ? `✓ ${j.name} respondió: “${j.reply || 'ok'}”`
      : `✗ ${j.name ? j.name + ' — ' : ''}${j.error || 'falló la conexión'}`;
  } catch {
    out.textContent = '✗ No se pudo probar la conexión.';
  }
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
