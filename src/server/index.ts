/**
 * Server entry point: builds the Express app, mounts the route modules, and
 * starts the background machinery. This file stays the Electron shell's import
 * target (dist/server/index.js) — importing it boots the whole server.
 *
 * Layout (split from a single 1,700-line file in 1.8.0-dev):
 *   helpers.ts        — clampNum, SSE writer, included-chats scope, attachments
 *   lifecycle.ts      — daily cron, nudge loop, reminder sweep, wake detector
 *   routes/tasks.ts   — Bandeja / Tareas / Archivo / Papelera / bulk
 *   routes/clients.ts — Clientes roster + client upserts + auto-classify
 *   routes/chat.ts    — chat threads/turns/uploads, memory, agenda, digest
 *   routes/whatsapp.ts— WhatsApp multi-account management
 *   routes/messages.ts— Mensajes tab, attachments, backfill, process stream
 *   routes/settings.ts— Ajustes, AI provider, stats, diagnostics, reminders
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { purgeStickers } from '../maintenance.js';
import { logStartupDiagnostics } from '../diagnostics.js';
import { startAllSessions, stopAllAccounts, anyWaSession } from '../ingest/whatsapp/client.js';
import { applySchedule, startBackgroundLoops } from './lifecycle.js';
import { tasksRouter } from './routes/tasks.js';
import { clientsRouter } from './routes/clients.js';
import { chatRouter } from './routes/chat.js';
import { whatsappRouter } from './routes/whatsapp.js';
import { messagesRouter } from './routes/messages.js';
import { settingsRouter } from './routes/settings.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, '..', '..', 'public');

const app = express();

/**
 * The dashboard has no authentication — it holds the owner's entire message
 * history and can spend API credits — so requests must only ever come from the
 * app's own window (or a browser on this Mac). Three layers, all cheap:
 *  1. The server binds to loopback (see app.listen), so nothing on the LAN can
 *     reach it directly.
 *  2. Host-header allowlist: a malicious website can't use DNS rebinding to
 *     read responses through a hostname it controls that resolves to 127.0.0.1.
 *  3. Cross-site request rejection: browsers label requests from other origins
 *     (Sec-Fetch-Site / Origin), so a web page can't trigger state changes or
 *     paid processing via <img>/form/fetch aimed at localhost.
 */
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);
function hostAllowed(host: string | undefined): boolean {
  if (!host) return false;
  const bare = host.replace(/:\d+$/, '');
  return LOCAL_HOSTS.has(bare);
}
app.use('/api', (req, res, next) => {
  if (!hostAllowed(req.headers.host)) {
    res.status(403).json({ error: 'forbidden host' });
    return;
  }
  const site = req.headers['sec-fetch-site'];
  if (site === 'cross-site') {
    res.status(403).json({ error: 'cross-site request rejected' });
    return;
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    const origin = req.headers.origin;
    if (origin && origin !== 'null') {
      try {
        if (!hostAllowed(new URL(origin).host)) {
          res.status(403).json({ error: 'cross-origin request rejected' });
          return;
        }
      } catch {
        res.status(403).json({ error: 'bad origin' });
        return;
      }
    }
  }
  next();
});

app.use(express.json({ limit: '30mb' })); // base64 image/PDF uploads in chat
app.use(express.static(PUBLIC_DIR));

app.use(tasksRouter);
app.use(clientsRouter);
app.use(chatRouter);
app.use(whatsappRouter);
app.use(messagesRouter);
app.use(settingsRouter);

/**
 * Last-resort error handler for /api. Must be registered AFTER every route, and
 * must take four arguments or Express treats it as ordinary middleware.
 *
 * Many routes carry their own try/catch, but not all. Without this, a throw in
 * the others fell through to Express's default handler, which answers with an
 * HTML stack trace — leaking absolute filesystem paths, and breaking the
 * frontend, which calls .json() on every response and dies with "Unexpected
 * token '<'" instead of showing the real error. A fresh install hit this on its
 * very first chat message (see the 1.7.2 schema fix).
 */
app.use('/api', (err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error('[api]', message);
  if (res.headersSent) return; // a stream (SSE/file) already started — nothing to say
  res.status(500).json({ error: message });
});

// Resilience net for an always-on app: a stray promise rejection from a library
// internal (e.g. puppeteer/whatsapp-web.js) shouldn't take the whole app down.
// Log it and keep serving — our own async paths are already guarded.
process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection]', reason instanceof Error ? reason.message : reason);
});

// Same philosophy for a synchronous throw that escaped a callback (e.g. an EPIPE
// from writing to a socket the user just closed, or a library internal): log and
// keep serving rather than letting the always-on app die and drop the WhatsApp
// sessions. Our own request/DB paths are guarded; this is the last-resort net.
process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', err instanceof Error ? err.message : err);
});

// Close the WhatsApp browser cleanly on shutdown so it doesn't leave an
// orphaned Chrome holding the session lock (which blocks the next start).
for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    void stopAllAccounts().finally(() => process.exit(0));
  });
}

const PORT = Number(process.env.PORT ?? 4319);
// Loopback only: the dashboard has no auth, so it must not be reachable from
// the LAN. Set HOST explicitly (e.g. 0.0.0.0) only if remote access is ever
// wanted on purpose — and add auth first.
const HOST = process.env.HOST ?? '127.0.0.1';
app.listen(PORT, HOST, () => {
  console.log(`\n  Dad's App dashboard → http://localhost:${PORT}\n`);
  logStartupDiagnostics(); // which DB this process bound to — see Ajustes → Diagnóstico
  try {
    purgeStickers(); // scrub any previously-captured stickers (idempotent)
  } catch (err) {
    console.error('[maintenance] sticker purge failed:', err instanceof Error ? err.message : err);
  }
  applySchedule();
  startBackgroundLoops();

  // Reconnect every account that already has a paired session.
  if (anyWaSession()) {
    console.log('  WhatsApp session(s) found — reconnecting…');
    startAllSessions();
  }
});
