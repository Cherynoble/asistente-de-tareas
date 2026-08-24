// app-whatsapp.js — Ajustes: WhatsApp multi-account.
// Split from the old single app.js (1.8.0-dev). These files are CLASSIC scripts
// sharing one global scope; index.html loads them in a fixed order that mirrors
// the original file, so cross-file references keep working. Keep new top-level
// names unique across app-*.js.

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
