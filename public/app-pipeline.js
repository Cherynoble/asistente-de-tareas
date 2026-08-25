// app-pipeline.js — Proceso tab: live extraction feed rendering.
// Split from the old single app.js (1.8.0-dev). These files are CLASSIC scripts
// sharing one global scope; index.html loads them in a fixed order that mirrors
// the original file, so cross-file references keep working. Keep new top-level
// names unique across app-*.js.

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
    const who = e.direction === 'outgoing' ? esc(tr('common.me')) + ' →' : esc(prettySender(e.sender, e.senderName));
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
      <div class="who"><span>${sourceBadge(e.source)}${accountBadge(e.source, e.waAccount)} ${who}</span><span class="mmeta">${when}${e.hasAttachment ? `<span class="paperclip" title="${esc(tr('pipeline.hasAttachment'))}">${ico('clip')}</span>` : ''}</span></div>
      ${clip}${atts ? `<div class="matts">${atts}</div>` : ''}</div>`));
  } else if (e.type === 'vision') {
    counters.vis++;
    $('#vis-count').textContent = counters.vis;
    const media =
      e.mime === 'application/pdf'
        ? `<div class="pdfbadge">PDF</div>`
        : `<img loading="lazy" src="/api/attachment?id=${e.messageId}&i=${e.attachmentIndex}" alt="" />`;
    $('#vis-feed').append(el(`<div class="vcard">${media}
      <div class="vname">${esc(e.name || e.mime)} · ${esc(tr('pipeline.msgRef', { id: e.messageId }))}</div>
      <div class="vdesc">${esc(e.description)}</div></div>`));
  } else if (e.type === 'task') {
    counters.tasks++;
    $('#task-count').textContent = counters.tasks;
    $('#task-feed').append(el(`<div class="tcard">
      <div class="title">${esc(e.title)}</div>
      <div class="detail">${esc(e.detail)}</div>
      ${e.sourceQuote ? `<div class="quote">${ico('search')}<span>"${esc(e.sourceQuote)}"</span></div>` : ''}
      <div class="who">${e.client ? esc(tr('tasks.clientLabel', { who: displayName(e.client) })) : ''}</div></div>`));
  }
}

function startStream(url, statusEl, onDone) {
  resetFeeds();
  counters.msgs = counters.vis = counters.tasks = 0;
  statusEl.textContent = tr('pipeline.starting');
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
    if (e.type === 'start') statusEl.textContent = tr(e.vision ? 'pipeline.readingVision' : 'pipeline.reading', { n: e.total });
    else if (e.type === 'batch') statusEl.textContent = tr('pipeline.batch', { done: e.processed, total: e.total, proposed: e.proposed });
    else if (e.type === 'done') {
      if (!counters.tasks) $('#task-feed').append(el(`<div class="empty">${esc(tr('pipeline.noTasksFound'))}</div>`));
      // The engine processes the NEWEST messages first and is bounded per run —
      // tell the user when older imported history is still queued.
      const left = e.remaining > 0
        ? ` · ${tr('pipeline.remaining', { n: e.remaining })}`
        : '';
      finish(tr('pipeline.finished', { n: e.proposed }) + left);
    } else handleEvent(e);
  };
  es.addEventListener('failed', (ev) => finish('error: ' + JSON.parse(ev.data).message));
  es.onerror = () => finish(tr('pipeline.connectionLost'));
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
  $('#proc-status').textContent = tr('pipeline.importing', { n: count });
  const r = await (
    await fetch('/api/backfill', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ count }),
    })
  ).json();
  $('#proc-status').textContent = r.ok
    ? tr('pipeline.imported', { n: r.inserted, total: r.total })
    : tr('common.errorPrefix', { message: r.error });
  loadStats();
});
