// app-attachments.js — Adjuntos gallery + Quick-Look preview.
// Split from the old single app.js (1.8.0-dev). These files are CLASSIC scripts
// sharing one global scope; index.html loads them in a fixed order that mirrors
// the original file, so cross-file references keep working. Keep new top-level
// names unique across app-*.js.

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
      `<div class="att-focus-head"><span>${ico('clip')}${esc(tr('att.taskFile'))}</span><button class="att-focus-clear">${esc(tr('att.remove'))}</button></div>`,
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
  $('#att-status').textContent = tr('common.loading');
  try {
    const r = await (await fetch(`/api/attachments?limit=${ATT_PAGE}&offset=${attOffset}`)).json();
    attItems.push(...(r.attachments || []));
    attOffset += ATT_PAGE; // server paginates by message row; advance by the page size
    attDone = !!r.done;
  } catch {
    attLoading = false;
    $('#att-status').textContent = tr('att.loadFailed');
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
    a.download = filename || tr('att.file');
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(objUrl), 5000);
  } catch {
    alert(tr('att.downloadFailed'));
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
  return m ? m[1].toUpperCase() : tr('att.fileCap');
}

function attMediaHtml(a, src) {
  const label = esc(a.filename || a.category || tr('att.file'));
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
    media = `<div class="att-thumb att-icon att-unavail att-fetch"><button class="att-load">${ico('download')}${esc(tr('att.viewFile'))}</button><span>${esc(tr('att.storedInWhatsapp'))}</span></div>`;
  else if (st === 'fda')
    media = `<div class="att-thumb att-icon att-unavail">${ico('lock', 'ico-xl')}<span>${esc(tr('att.needsFda'))}</span></div>`;
  else media = `<div class="att-thumb att-icon att-unavail">${ico('ban', 'ico-xl')}<span>${esc(tr('att.notOnThisMac'))}</span></div>`;
  const name = a.filename || a.category;
  // Download only makes sense when the file is (or can be) fetched.
  const canDownload = st === 'ok' || st === 'fetch';
  const card = el(`<div class="att-card">
    <div class="att-media">${media}<button class="att-expand" title="${esc(tr('att.preview'))}" aria-label="${esc(tr('att.preview'))}">${ico('expand')}</button></div>
    <div class="att-meta">
      <div class="att-name" title="${esc(name)}">${esc(name)}</div>
      <div class="att-sub">${sourceBadge(a.source)}${accountBadge(a.source, a.waAccount)} ${attWho(a)}</div>
      ${a.chatName ? `<div class="att-sub att-where" title="${esc(a.chatName)}">${esc(a.chatName)}</div>` : ''}
      <div class="att-sub att-when">${esc(fmtMsgTime(a.ts))}</div>
    </div>
    ${canDownload ? `<a class="att-dl" href="${src}&download=1" title="${esc(tr('att.downloadCopy'))}" aria-label="${esc(tr('att.downloadCopy'))}">${ico('download')}</a>` : ''}
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

  if (st === 'ok') attWireError(card, tr('att.unavailable'));

  // WhatsApp media not downloaded yet: fetch on demand only when the user asks
  // (auto-fetching a whole gallery of old messages is slow and often fails).
  const loadBtn = card.querySelector('.att-load');
  if (loadBtn)
    loadBtn.onclick = () => {
      const box = card.querySelector('.att-media');
      box.innerHTML = `<div class="att-thumb att-icon">${ico('download', 'ico-xl')}<span>${esc(tr('att.downloading'))}</span></div>`;
      // A cache-busting param forces a fresh request that triggers the download.
      const freshSrc = `${src}&t=${Date.now()}`;
      box.innerHTML = attMediaHtml(a, freshSrc);
      attWireError(card, tr('att.unavailableConnectWa'));
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
  $('#att-count').textContent = items.length ? tr('att.fileCount', { n: items.length }) : '';
  if (!items.length) {
    grid.append(
      el(
        `<div class="empty">${attItems.length ? ico('search', 'ico-xl') + esc(tr('common.noSearchMatch')) : ico('clip', 'ico-xl') + esc(tr('att.empty'))}</div>`,
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
      stage.innerHTML = `<div class="ql-note">${ico('ban', 'ico-xl')}<div>${esc(tr('att.loadFileFailed'))}</div></div>`;
    });

  const name = a.filename || a.category;
  const canDownload = st === 'ok' || st === 'fetch';
  cap.innerHTML =
    `<div class="ql-name" title="${esc(name)}">${esc(name)}</div>` +
    `<div class="ql-sub">${sourceBadge(a.source)}${accountBadge(a.source, a.waAccount)} ${attWho(a)}` +
    `${a.chatName ? ` · ${esc(a.chatName)}` : ''} · ${esc(fmtMsgTime(a.ts))}</div>` +
    `<div class="ql-tools">` +
    `${canDownload ? `<button class="ql-dl">${ico('download')}${esc(tr('att.downloadCopyBtn'))}</button>` : ''}` +
    `${a.category === 'pdf' && st === 'ok' ? `<a class="ql-open" href="${src}" target="_blank" rel="noopener">${esc(tr('att.openInTab'))}</a>` : ''}` +
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
