// app-trash.js — Papelera tab.
// Split from the old single app.js (1.8.0-dev). These files are CLASSIC scripts
// sharing one global scope; index.html loads them in a fixed order that mirrors
// the original file, so cross-file references keep working. Keep new top-level
// names unique across app-*.js.

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
      <div class="meta">${t.clientHint ? `<span>${esc(tr('tasks.clientLabel', { who: displayName(t.clientHint) }))}</span>` : ''}<span class="badge">${esc(statusLabel(t.status))}</span></div>
      <div class="actions">
        <button class="approve j-restore">${ico('undo')}${esc(tr('trash.restore'))}</button>
        <button class="dismiss j-purge">${ico('trash')}${esc(tr('trash.purge'))}</button>
      </div>
    </div>`);
    card.querySelector('.j-restore').onclick = async () => {
      await bulkPost('/api/tasks/bulk', { ids: [Number(t.id)], action: 'restore' });
      await refreshTaskViews();
    };
    card.querySelector('.j-purge').onclick = async () => {
      if (!confirm(tr('trash.confirmPurgeTask'))) return;
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
        <button class="approve j-restore">${ico('undo')}${esc(tr('trash.restore'))}</button>
        <button class="dismiss j-purge">${ico('trash')}${esc(tr('trash.purge'))}</button>
      </span>
    </div>`);
    card.querySelector('.j-restore').onclick = async () => {
      await bulkPost('/api/clients/bulk', { handles: [c.handle], action: 'restore' });
      await Promise.all([loadSenders(), loadNames(), loadTrash(), loadStats()]);
    };
    card.querySelector('.j-purge').onclick = async () => {
      if (!confirm(tr('trash.confirmPurgeClient'))) return;
      await bulkPost('/api/clients/bulk', { handles: [c.handle], action: 'purge' });
      await Promise.all([loadSenders(), loadNames(), loadTrash(), loadStats()]);
    };
    cle.append(card);
  }
}
$('#trash-search').addEventListener('input', renderTrash);
$('#trash-empty').onclick = async () => {
  if (!confirm(tr('trash.confirmEmpty'))) return;
  await bulkPost('/api/trash/empty', { type: 'all' });
  await Promise.all([loadTrash(), loadSenders(), loadNames(), loadStats()]);
};
