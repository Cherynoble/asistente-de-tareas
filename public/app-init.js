// app-init.js — Startup sequence (must load LAST).
// Split from the old single app.js (1.8.0-dev). These files are CLASSIC scripts
// sharing one global scope; index.html loads them in a fixed order that mirrors
// the original file, so cross-file references keep working. Keep new top-level
// names unique across app-*.js.

// Translate the static markup before anything renders on top of it, so there
// is never a flash of the previous language.
applyI18n();
document.title = tr('app.asistenteDeTareas');

/**
 * First run: ask which language to use, once, before anything else.
 *
 * Until the owner picks one the app runs in Spanish (what it always shipped
 * in), so an existing install is never interrupted — `languageChosen` is only
 * false on a genuinely fresh database.
 */
async function askLanguageOnFirstRun() {
  let s;
  try {
    s = await (await fetch('/api/settings')).json();
  } catch {
    return; // offline/boot race — the picker in Ajustes still works
  }
  if (s.languageChosen) return;
  const ov = $('#lang-overlay');
  if (!ov) return;
  ov.hidden = false;
  ov.style.display = 'flex';
  ov.querySelectorAll('[data-firstrun-lang]').forEach((b) => {
    b.onclick = async () => {
      ov.querySelectorAll('button').forEach((x) => (x.disabled = true));
      try {
        await fetch('/api/settings', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ uiLanguage: b.dataset.firstrunLang }),
        });
        location.reload();
      } catch {
        ov.querySelectorAll('button').forEach((x) => (x.disabled = false));
      }
    };
  });
  // Block the rest of the startup sequence while the picker is up. Without
  // this, boot continues and the "Buenos días" digest opens its own overlay on
  // top of the picker. Choosing a language reloads the page, so this promise
  // intentionally never resolves.
  return new Promise(() => {});
}

(async () => {
  await askLanguageOnFirstRun();
  await loadNames();
  await loadWaAccountLabels(); // so per-account badges render before opening Ajustes
  loadStats();
  loadInbox();
  loadTasks();
  checkDigest();
})();
