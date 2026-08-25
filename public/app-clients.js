// app-clients.js — Clientes tab.
// Split from the old single app.js (1.8.0-dev). These files are CLASSIC scripts
// sharing one global scope; index.html loads them in a fixed order that mirrors
// the original file, so cross-file references keep working. Keep new top-level
// names unique across app-*.js.

// ---- Clients / senders ----
let sendersItems = [];
/**
 * Display label for a stored category value. The two built-ins are translated;
 * anything the owner typed himself is shown exactly as he typed it.
 */
const categoryLabel = (c) => (c === 'Oficina' || c === 'Personal' ? tr(`category.${c}`) : c);

let clientsFilter = 'all'; // 'all' | '__unclassified__' | a category name
const clientsSel = makeSelection('clients', () => filteredSenders().map((s) => s.handle));
function filteredSenders() {
  const q = $('#clients-search').value;
  return sendersItems.filter((s) => {
    if (!matches(q, s.handle, s.displayName, s.name, s.productNeed)) return false;
    if (clientsFilter === 'all') return true;
    if (clientsFilter === '__unclassified__') return !s.category;
    return s.category === clientsFilter;
  });
}
// Known categories = the two defaults plus any custom ones already in use.
function knownCats() {
  const set = new Set(['Oficina', 'Personal']);
  // Note: these two are stored VALUES, not display text — see categoryLabel().
  for (const s of sendersItems) if (s.category) set.add(s.category);
  return [...set].sort(i18nCompare);
}
function catCounts() {
  const c = { __all__: sendersItems.length, __unclassified__: 0 };
  for (const s of sendersItems) {
    if (!s.category) c.__unclassified__++;
    else c[s.category] = (c[s.category] || 0) + 1;
  }
  return c;
}
function renderClientChips() {
  const box = $('#clients-cats');
  if (!box) return;
  box.innerHTML = '';
  const counts = catCounts();
  const chip = (key, label, n) => {
    const b = el(
      `<button class="chip ${clientsFilter === key ? 'active' : ''}">${esc(label)}${
        n != null ? ` <span class="chip-n">${n}</span>` : ''
      }</button>`,
    );
    b.onclick = () => {
      clientsFilter = key;
      renderClientChips();
      renderSenders();
    };
    return b;
  };
  box.append(chip('all', tr('clients.allFilter'), counts.__all__));
  for (const cat of knownCats()) box.append(chip(cat, categoryLabel(cat), counts[cat] || 0));
  box.append(chip('__unclassified__', tr('clients.unclassified'), counts.__unclassified__));
}
async function loadSenders() {
  sendersItems = await (await fetch('/api/senders')).json();
  clientsSel.clear();
  renderClientChips();
  renderSenders();
}
function renderSenders() {
  const list = $('#senders-list');
  list.innerHTML = '';
  const items = filteredSenders();
  if (!items.length) {
    list.append(el(`<div class="empty">${sendersItems.length ? ico('search', 'ico-xl') + esc(tr('common.noSearchMatch')) : ico('clients', 'ico-xl') + esc(tr('clients.empty'))}</div>`));
    clientsSel.refresh();
    return;
  }
  for (const s of items) {
    // Is the handle a phone/email/JID identifier, or a free-text client name
    // (typed into a task)? Free-text names are shown directly, not as "sin nombre".
    const isId = /@/.test(s.handle) || /^\+?[\d][\d\s().-]*$/.test(s.handle);
    const resolved = s.displayName && s.displayName !== s.handle ? s.displayName : isId ? '' : s.handle;
    const cats = knownCats();
    // The category VALUE stays as stored ('Oficina'/'Personal' or a custom
    // one the owner typed); only the displayed label is translated, so
    // switching language never rewrites the database.
    const catOpts = [`<option value="">${esc(tr('clients.unclassified'))}</option>`]
      .concat(cats.map((c) => `<option value="${esc(c)}" ${s.category === c ? 'selected' : ''}>${esc(categoryLabel(c))}</option>`))
      .concat(`<option value="__new__">${esc(tr('clients.newCategory'))}</option>`)
      .join('');
    const card = el(`<div class="card sender">
      <input type="checkbox" class="sel" data-id="${esc(s.handle)}" />
      ${isId ? `<span class="handle">${esc(s.handle)}</span>` : ''}
      ${resolved ? `<span class="rn">${esc(resolved)}</span>` : `<span class="rn unnamed">${esc(tr('clients.unnamed'))}</span>`}
      <span class="count">${s.count ? tr('clients.msgCount', { n: s.count }) : tr('clients.fromTask')}</span>
      <input class="nm" placeholder="${esc(resolved ? tr('clients.rename') : tr('clients.name'))}" value="${esc(s.name || '')}" />
      <input class="pn" placeholder="${esc(tr('clients.productNeed'))}" value="${esc(s.productNeed || '')}" />
      <select class="cat" title="${esc(tr('clients.category'))}">${catOpts}</select>
      <button class="approve save">${esc(tr('common.save'))}</button>
      <span class="saved"></span>
    </div>`);
    clientsSel.bind(card.querySelector('.sel'), s.handle);
    card.querySelector('.cat').onchange = async (e) => {
      let val = e.target.value;
      if (val === '__new__') {
        val = ((await askText(tr('clients.newCategoryPrompt'))) || '').trim();
        if (!val) { e.target.value = s.category || ''; return; }
      }
      await fetch('/api/clients/category', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ handle: s.handle, category: val }),
      });
      s.category = val;
      renderClientChips();
      renderSenders(); // reflect the new category / custom option / active filter
    };
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
$('#clients-autoclass').onclick = async () => {
  const btn = $('#clients-autoclass');
  const st = $('#clients-autoclass-status');
  btn.disabled = true;
  st.textContent = tr('clients.classifying');
  try {
    const r = await (await fetch('/api/clients/autoclassify', { method: 'POST' })).json();
    if (r.error) st.textContent = r.error;
    else {
      st.textContent = `✓ ${tr('clients.classified', { n: r.classified })}`;
      await loadSenders();
    }
  } catch {
    st.textContent = tr('clients.classifyFailed');
  }
  btn.disabled = false;
};
