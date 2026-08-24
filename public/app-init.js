// app-init.js — Startup sequence (must load LAST).
// Split from the old single app.js (1.8.0-dev). These files are CLASSIC scripts
// sharing one global scope; index.html loads them in a fixed order that mirrors
// the original file, so cross-file references keep working. Keep new top-level
// names unique across app-*.js.

(async () => {
  await loadNames();
  await loadWaAccountLabels(); // so per-account badges render before opening Ajustes
  loadStats();
  loadInbox();
  loadTasks();
  checkDigest();
})();
