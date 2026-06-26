// Electron entry point. Boots the existing Express server IN-PROCESS (so Full
// Disk Access granted to this .app applies to its chat.db reads) and opens a
// window pointing at the local dashboard. Written as .cjs so it loads as
// CommonJS even though the project is "type": "module".
const { app, BrowserWindow, shell, dialog, Menu } = require('electron');
const path = require('node:path');
const http = require('node:http');

const PORT = process.env.PORT || '4319';
let win = null;
let waClient = null; // whatsapp client module, kept for graceful shutdown
let quitting = false;

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
  // dist/ is the compiled (ESM) server — import() loads it and it auto-listens.
  await import(path.join(__dirname, '..', 'dist', 'server', 'index.js'));
  waClient = await import(path.join(__dirname, '..', 'dist', 'ingest', 'whatsapp', 'client.js'));
}

function createWindow() {
  win = new BrowserWindow({
    width: 1240,
    height: 880,
    minWidth: 900,
    minHeight: 600,
    title: 'Asistente de Tareas',
    webPreferences: { contextIsolation: true },
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

  app.whenReady().then(async () => {
    // A simple Spanish-friendly default menu (Edit menu enables copy/paste).
    Menu.setApplicationMenu(Menu.buildFromTemplate([
      { role: 'appMenu' },
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
