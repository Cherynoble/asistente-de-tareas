// Electron entry point. Boots the existing Express server IN-PROCESS (so Full
// Disk Access granted to this .app applies to its chat.db reads) and opens a
// window pointing at the local dashboard. Written as .cjs so it loads as
// CommonJS even though the project is "type": "module".
//
// OPTION B — hot-updatable code: in a packaged build we run the app's JS
// (dist/ + public/) from a WRITABLE external folder
// (~/Library/Application Support/DadsApp/app/) instead of from inside the
// read-only bundle. On launch we seed that folder from the bundle if it's
// missing or older, and symlink its node_modules to the bundle's, so an online
// update only has to drop new dist/+public/ files there — no repackaging, no
// re-signing, and the database (one level up, in DadsApp/) is never touched.
const { app, BrowserWindow, shell, dialog, Menu, ipcMain, powerMonitor } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const http = require('node:http');
const { pathToFileURL } = require('node:url');
const updater = require('./updater.cjs');

const PORT = process.env.PORT || '4319';
const BUNDLE_ROOT = path.join(__dirname, '..'); // .../Resources/app (or project root in dev)
// The external code dir lives INSIDE DadsApp/app; the DB/session stay at DadsApp/ (one level up).
const EXTERNAL_ROOT = path.join(app.getPath('appData'), 'DadsApp', 'app');

let win = null;
let waClient = null; // whatsapp client module, kept for graceful shutdown
let quitting = false;

function readJson(p) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

/** Compare dotted versions: returns true if a < b. */
function versionLt(a, b) {
  const pa = String(a || '0').split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b || '0').split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] || 0;
    const y = pb[i] || 0;
    if (x !== y) return x < y;
  }
  return false;
}

/** Point EXTERNAL_ROOT/node_modules at the CURRENT bundle's node_modules. */
function ensureNodeModulesLink() {
  const target = path.join(BUNDLE_ROOT, 'node_modules');
  const link = path.join(EXTERNAL_ROOT, 'node_modules');
  try {
    const st = fs.lstatSync(link);
    if (st.isSymbolicLink() && fs.readlinkSync(link) === target) return; // already correct
    fs.rmSync(link, { recursive: true, force: true });
  } catch {
    /* link doesn't exist yet */
  }
  fs.symlinkSync(target, link, 'dir');
}

/**
 * Make sure EXTERNAL_ROOT holds runnable code at least as new as the bundle,
 * then return the directory to load the app from. In dev (unpackaged) we just
 * run straight from the project so live edits aren't shadowed by a stale copy.
 */
function resolveCodeRoot() {
  if (!app.isPackaged) return BUNDLE_ROOT;

  const bundledVersion = (readJson(path.join(BUNDLE_ROOT, 'package.json')) || {}).version || '0';
  const ext = readJson(path.join(EXTERNAL_ROOT, 'code-version.json'));
  const externalVersion = ext && ext.version;
  const hasCode = fs.existsSync(path.join(EXTERNAL_ROOT, 'dist', 'server', 'index.js'));

  // Seed/refresh from the bundle when the external copy is missing or older than
  // the shell we just launched (a freshly installed .app carries newer code).
  if (!hasCode || !externalVersion || versionLt(externalVersion, bundledVersion)) {
    fs.mkdirSync(EXTERNAL_ROOT, { recursive: true });
    for (const dir of ['dist', 'public']) {
      const dest = path.join(EXTERNAL_ROOT, dir);
      fs.rmSync(dest, { recursive: true, force: true });
      fs.cpSync(path.join(BUNDLE_ROOT, dir), dest, { recursive: true });
    }
    fs.copyFileSync(path.join(BUNDLE_ROOT, 'package.json'), path.join(EXTERNAL_ROOT, 'package.json'));
    fs.writeFileSync(
      path.join(EXTERNAL_ROOT, 'code-version.json'),
      JSON.stringify({ version: bundledVersion, seededFrom: 'bundle', at: Date.now() }, null, 2),
    );
  }

  ensureNodeModulesLink();
  return EXTERNAL_ROOT;
}

/** Poll the server until it answers, so we don't load a blank page. */
function waitForServer(timeoutMs = 30000) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tryOnce = () => {
      const req = http.get(`http://localhost:${PORT}/api/stats`, (res) => {
        res.resume();
        resolve();
      });
      req.on('error', () => {
        if (Date.now() - start > timeoutMs) reject(new Error('El servidor no respondió'));
        else setTimeout(tryOnce, 300);
      });
    };
    tryOnce();
  });
}

async function boot() {
  const codeRoot = resolveCodeRoot();
  // dist/ is the compiled (ESM) server — import() loads it and it auto-listens.
  await import(pathToFileURL(path.join(codeRoot, 'dist', 'server', 'index.js')).href);
  waClient = await import(
    pathToFileURL(path.join(codeRoot, 'dist', 'ingest', 'whatsapp', 'client.js')).href
  );
}

/** Relaunch the app, but stop WhatsApp first so its Chrome isn't orphaned. */
async function relaunchCleanly() {
  quitting = true; // suppress the before-quit handler's second shutdown
  try {
    if (waClient && waClient.stopWhatsApp) await waClient.stopWhatsApp();
  } catch {
    /* best effort */
  }
  app.relaunch();
  app.exit(0);
}

/** Menu-driven update flow (works without the web UI). */
async function checkUpdatesInteractive() {
  const r = await updater.checkForUpdate();
  if (r.status === 'error') {
    dialog.showErrorBox('Buscar actualizaciones', r.message || 'No se pudo comprobar.');
    return;
  }
  if (r.status === 'up-to-date') {
    dialog.showMessageBox(win, {
      type: 'info',
      message: 'La app está actualizada.',
      detail: `Versión actual: ${r.currentVersion}`,
      buttons: ['OK'],
    });
    return;
  }
  if (r.status === 'needs-new-app') {
    const { response } = await dialog.showMessageBox(win, {
      type: 'info',
      message: 'Hay una versión nueva que requiere descargar la app de nuevo.',
      detail: `Versión ${r.latestVersion}. Ábrela desde la página de descargas.`,
      buttons: ['Abrir página', 'Ahora no'],
      defaultId: 0,
      cancelId: 1,
    });
    if (response === 0) shell.openExternal(r.page);
    return;
  }
  // available
  const { response } = await dialog.showMessageBox(win, {
    type: 'question',
    message: `Actualización disponible (${r.latestVersion}).`,
    detail: (r.notes ? `${r.notes}\n\n` : '') + 'Se instalará y la app se reiniciará.',
    buttons: ['Instalar y reiniciar', 'Ahora no'],
    defaultId: 0,
    cancelId: 1,
  });
  if (response !== 0) return;
  const applied = await updater.applyUpdate(r.zipUrl);
  if (!applied.ok) {
    dialog.showErrorBox('Actualización', applied.message || 'No se pudo instalar.');
    return;
  }
  await relaunchCleanly();
}

function createWindow() {
  win = new BrowserWindow({
    width: 1240,
    height: 880,
    minWidth: 900,
    minHeight: 600,
    title: 'Asistente de Tareas',
    webPreferences: { contextIsolation: true, preload: path.join(__dirname, 'preload.cjs') },
  });
  win.loadURL(`http://localhost:${PORT}`);
  // Links that try to open a new window go to the real browser instead.
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
}

// Only ONE copy may run: a second WhatsApp session on the same number competes
// with the first and leaves it stuck "authenticated — syncing". If the user
// double-launches, focus the existing window instead of starting a rival server.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  // Updater bridge for the web UI (preload.cjs → window.updater).
  ipcMain.handle('updater:check', () => updater.checkForUpdate());
  ipcMain.handle('updater:version', () => updater.currentCodeVersion());
  ipcMain.handle('updater:apply', async (_e, zipUrl) => {
    const r = await updater.applyUpdate(zipUrl);
    if (r.ok) setTimeout(() => relaunchCleanly(), 600);
    return r;
  });

  app.whenReady().then(async () => {
    // Spanish-friendly menu; the app menu carries "Buscar actualizaciones…".
    Menu.setApplicationMenu(Menu.buildFromTemplate([
      {
        label: app.name,
        submenu: [
          { role: 'about' },
          { type: 'separator' },
          { label: 'Buscar actualizaciones…', click: () => checkUpdatesInteractive() },
          { type: 'separator' },
          { role: 'services' },
          { type: 'separator' },
          { role: 'hide' },
          { role: 'hideOthers' },
          { role: 'unhide' },
          { type: 'separator' },
          { role: 'quit' },
        ],
      },
      { role: 'editMenu' },
      { role: 'viewMenu' },
      { role: 'windowMenu' },
    ]));

    try {
      await boot();
      await waitForServer();
    } catch (err) {
      dialog.showErrorBox('Error al iniciar', String(err && err.message ? err.message : err));
    }
    createWindow();
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });

    // Sleep/wake handling. macOS can kill the puppeteer Chrome when the Mac
    // sleeps (lid closed), which corrupts the WhatsApp session and leaves it
    // "signed out" / stuck on the next wake. So: BEFORE sleep, close the WhatsApp
    // browsers cleanly (stopWhatsApp now stops every account); AFTER wake,
    // reconnect them all. This is the proper fix for "laptop closed → WhatsApp
    // signed out and auto sign-in doesn't work". (The server also has a
    // wall-clock wake detector as a fallback when this shell isn't present.)
    powerMonitor.on('suspend', () => {
      try {
        if (waClient && waClient.stopWhatsApp) waClient.stopWhatsApp();
      } catch {
        /* best effort */
      }
    });
    powerMonitor.on('resume', () => {
      // Give the network a moment to come back before relaunching the browsers.
      setTimeout(() => {
        try {
          if (waClient && waClient.startWhatsApp) waClient.startWhatsApp();
        } catch {
          /* best effort */
        }
      }, 4000);
    });
  });

  app.on('window-all-closed', () => app.quit());

  // Close WhatsApp's Chrome cleanly on quit — an orphaned/hard-killed Chrome is
  // what corrupts the session and causes the "stuck at 99%" hang.
  app.on('before-quit', (e) => {
    if (quitting || !waClient || !waClient.stopWhatsApp) return;
    quitting = true;
    e.preventDefault();
    Promise.resolve(waClient.stopWhatsApp())
      .catch(() => {})
      .finally(() => app.quit());
  });
}
