import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import pkg from 'whatsapp-web.js';
import type { Message } from 'whatsapp-web.js';
import QRCode from 'qrcode';
import { config } from '../../config.js';
import { db } from '../../db/index.js';
import { getSelectedWaChats } from '../../settings.js';

// whatsapp-web.js is CommonJS — default-import then destructure (Node's ESM
// loader can't bind its named exports directly).
const { Client, LocalAuth } = pkg;

export type WaStatus = 'idle' | 'starting' | 'qr' | 'authenticated' | 'ready' | 'disconnected';

let client: InstanceType<typeof Client> | null = null;
let status: WaStatus = 'idle';
let qrDataUrl: string | null = null;
let everReady = false;
// Diagnostics surfaced to the UI so a stall isn't an opaque "connecting…".
let detail = '';
let lastError = '';
// Readiness watchdog: if we authenticate but never reach 'ready', recycle.
let readyTimer: ReturnType<typeof setTimeout> | null = null;
let startAttempts = 0;
const READY_TIMEOUT_MS = Number(process.env.WA_READY_TIMEOUT_MS ?? 90_000);
// Recycle at most once (a transient lock clears on relaunch). Beyond that the
// session cache is usually corrupted — recycling just re-links and thrashes, so
// we stop and tell the user to Re-pair instead.
const MAX_ATTEMPTS = Number(process.env.WA_MAX_ATTEMPTS ?? 2);

const authPath = () => path.join(config.dataDir, 'wwebjs_auth');
const sessionPath = () => path.join(authPath(), 'session');

/**
 * Kill any leftover Chrome bound to OUR WhatsApp profile. A non-graceful kill
 * of the server (e.g. `kill -9`, which can't run stopWhatsApp) orphans the
 * puppeteer Chrome; it keeps holding the userDataDir lock and the linked-device
 * session, so the next launch authenticates but never reaches 'ready'. We match
 * only processes whose command line references our session dir — never the
 * user's normal Chrome (which uses a different profile). Returns count killed.
 */
function killOrphanChrome(): number {
  const needle = authPath();
  let out = '';
  try {
    out = execFileSync('/bin/ps', ['-axo', 'pid=,command='], { encoding: 'utf8' });
  } catch {
    return 0;
  }
  let killed = 0;
  for (const line of out.split('\n')) {
    if (!line.includes(needle)) continue; // only our session
    if (!/[Cc]hrom(e|ium)/.test(line)) continue; // only browser processes
    const pid = Number(line.trim().split(/\s+/)[0]);
    if (!pid || pid === process.pid) continue;
    try {
      process.kill(pid, 'SIGKILL');
      killed++;
    } catch {
      /* already gone */
    }
  }
  return killed;
}

/** Remove stale Chrome singleton lock files left by an ungraceful exit. */
function removeStaleLocks(): void {
  for (const f of ['SingletonLock', 'SingletonCookie', 'SingletonSocket']) {
    try {
      fs.rmSync(path.join(sessionPath(), f), { force: true });
    } catch {
      /* best effort */
    }
  }
}

/**
 * Guarantee a clean slate before launching the browser. Safe to call only when
 * no client is live in THIS process (startWhatsApp's `if (client) return` guard
 * ensures that), so anything we find is genuinely an orphan.
 */
function cleanupSession(): void {
  const killed = killOrphanChrome();
  if (killed) console.log(`[whatsapp] cleaned up ${killed} orphaned Chrome process(es)`);
  removeStaleLocks();
}

/** Find a Chrome/Chromium to drive: env override → system Chrome → bundled. */
function chromePath(): string | undefined {
  if (process.env.WA_CHROME_PATH) return process.env.WA_CHROME_PATH;
  const sys = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  if (fs.existsSync(sys)) return sys;
  return undefined; // let puppeteer use its bundled browser
}

/** True if a paired session already exists (so we can auto-reconnect). */
export function hasWaSession(): boolean {
  try {
    return fs.existsSync(authPath()) && fs.readdirSync(authPath()).length > 0;
  } catch {
    return false;
  }
}

export interface WaState {
  status: WaStatus;
  qrDataUrl: string | null;
  detail: string;
  lastError: string;
  attempts: number;
}

export function getWaState(): WaState {
  return { status, qrDataUrl, detail, lastError, attempts: startAttempts };
}

const INSERT = `INSERT OR IGNORE INTO messages
  (source, source_msg_id, chat_id, chat_name, sender, sender_name, direction,
   body, ts, ingested_at, has_attachment, attachment_mimes, attachment_names, attachment_paths)
  VALUES (@source, @sid, @chatId, @chatName, @sender, @senderName, @dir,
   @body, @ts, @now, @hasAtt, @mimes, '', '')`;

/** Normalize and persist one WhatsApp message. Returns 1 if newly inserted. */
async function persist(msg: Message): Promise<number> {
  try {
    // Chat selection: skip messages from chats the user didn't pick (empty = all).
    const selected = getSelectedWaChats();
    if (selected.length && msg.id.remote && !selected.includes(msg.id.remote)) return 0;

    const hasMedia = msg.hasMedia;
    let body = msg.body || '';
    if (!body && hasMedia) body = `[attachment: ${msg.type}]`;
    if (!body) return 0;

    const fromMe = msg.fromMe;
    const sender = fromMe ? 'me' : msg.author || msg.from || null;
    let senderName: string | null = null;
    let chatName: string | null = null;
    try {
      const chat = await msg.getChat();
      chatName = chat.name || null;
    } catch {
      /* keep null */
    }
    if (!fromMe) {
      try {
        const c = await msg.getContact();
        senderName = c.pushname || c.name || c.number || null;
      } catch {
        /* keep null */
      }
    }

    const info = db()
      .prepare(INSERT)
      .run({
        source: 'whatsapp',
        sid: msg.id._serialized,
        chatId: msg.id.remote ?? null,
        chatName: chatName ?? senderName ?? sender,
        sender,
        senderName,
        dir: fromMe ? 'outgoing' : 'incoming',
        body,
        ts: (msg.timestamp || 0) * 1000,
        now: Date.now(),
        hasAtt: hasMedia ? 1 : 0,
        mimes: hasMedia ? msg.type : '',
      });
    return info.changes;
  } catch {
    return 0;
  }
}

/**
 * If we authenticate but never reach 'ready' within the timeout, recycle the
 * client (up to MAX_ATTEMPTS) instead of hanging on "connecting…" forever. This
 * is the self-recovery for a stuck launch; cleanupSession() in startWhatsApp
 * removes whatever was blocking it on the retry.
 */
function armReadyWatchdog(): void {
  if (readyTimer) clearTimeout(readyTimer);
  readyTimer = setTimeout(() => {
    if (status === 'ready') return;

    // Authenticated but not ready = WhatsApp is doing its initial history sync
    // (the phone shows a spinning "linked device" indicator). The FIRST sync of
    // a busy account can take several minutes. Recycling here would re-link and
    // restart that sync from scratch — so it might NEVER finish. Be patient:
    // keep the client alive and just update the status. 'ready' fires when the
    // sync completes; if it's genuinely wedged, the user can hit "Volver a
    // vincular" (Re-pair), which is offered in the UI during this state.
    if (status === 'authenticated') {
      detail = 'sincronizando — la primera vez puede tardar varios minutos; deja la app abierta y el teléfono conectado';
      return; // do NOT recycle a sync in progress
    }
    // Still waiting for the user to scan the QR — leave it; it auto-refreshes.
    if (status === 'qr') return;

    // Stuck on 'starting': the browser launched but never even loaded WhatsApp
    // Web (no QR, no auth). A fresh Chrome usually fixes that — recycle, bounded.
    if (startAttempts >= MAX_ATTEMPTS) {
      lastError =
        `No se pudo cargar WhatsApp tras ${MAX_ATTEMPTS} intentos. Pulsa "Reconectar"; ` +
        `si el problema persiste, "Volver a vincular".`;
      detail = '';
      status = 'disconnected';
      console.warn('[whatsapp] ' + lastError);
      void stopWhatsApp();
      return;
    }
    console.warn(
      `[whatsapp] stuck at "starting" after ${Math.round(READY_TIMEOUT_MS / 1000)}s — recycling (attempt ${startAttempts}/${MAX_ATTEMPTS})`,
    );
    void (async () => {
      await stopWhatsApp();
      startWhatsApp(); // re-cleans the session and re-inits
    })();
  }, READY_TIMEOUT_MS);
}

/** Start (or no-op if already started) the read-only WhatsApp Web mirror. */
export function startWhatsApp(): void {
  if (client) return;
  // Self-heal: clear any orphaned Chrome / stale locks from a previous (maybe
  // hard-killed) run before we launch, so we never inherit a locked profile.
  cleanupSession();
  startAttempts += 1;
  status = 'starting';
  qrDataUrl = null;
  detail = startAttempts > 1 ? `retrying (attempt ${startAttempts})…` : 'starting browser…';
  lastError = '';

  // Optional web-version pin. A NEWER build is sometimes needed so a fresh
  // device link doesn't fail ("Couldn't link device"), but the library only
  // fully hooks (fires 'ready', captures messages) on the version it was built
  // for. So: pin a newer version only to LINK; reconnect on the library default
  // (WA_WEB_VERSION=default) to actually run.
  const pin = process.env.WA_WEB_VERSION ?? 'default';
  const usePin = pin.toLowerCase() !== 'default' && pin !== '';

  client = new Client({
    authStrategy: new LocalAuth({ dataPath: authPath() }),
    // The web-version cache MUST live in a writable directory. whatsapp-web.js
    // defaults it to ./.wwebjs_cache (relative to CWD), and a bundled .app runs
    // with CWD "/" (read-only). Its persist() does fs.mkdirSync/writeFileSync with
    // NO error handling, so it throws EROFS right AFTER 'authenticated' and BEFORE
    // 'ready' — leaving the app stuck on "authenticated — syncing" forever (worked
    // in dev only because CWD was the writable project dir). Point it at our own
    // writable dataDir so persist() succeeds and 'ready' fires.
    webVersionCache: usePin
      ? {
          type: 'remote' as const,
          remotePath:
            'https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/{version}.html',
        }
      : { type: 'local' as const, path: path.join(config.dataDir, 'wwebjs_cache') },
    ...(usePin ? { webVersion: pin } : {}),
    puppeteer: {
      headless: process.env.WA_HEADLESS !== '0',
      executablePath: chromePath(),
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    },
  });

  client.on('qr', async (qr: string) => {
    if (!everReady) status = 'qr';
    try {
      qrDataUrl = await QRCode.toDataURL(qr, { width: 320, margin: 1 });
    } catch {
      qrDataUrl = null;
    }
  });
  client.on('authenticated', () => {
    // Don't downgrade once we've reached ready — WhatsApp re-emits this on
    // reconnects and it shouldn't flap the status back.
    if (!everReady) status = 'authenticated';
    detail = 'authenticated — syncing…';
    qrDataUrl = null;
  });
  client.on('ready', () => {
    everReady = true;
    status = 'ready';
    qrDataUrl = null;
    detail = '';
    lastError = '';
    startAttempts = 0; // healthy — reset the recycle counter
    if (readyTimer) clearTimeout(readyTimer), (readyTimer = null);
    console.log('[whatsapp] ready');
  });
  client.on('disconnected', (reason: string) => {
    everReady = false;
    status = 'disconnected';
    detail = '';
    if (readyTimer) clearTimeout(readyTimer), (readyTimer = null);
    console.log('[whatsapp] disconnected:', reason);
  });
  client.on('change_state', (s: string) => {
    detail = String(s).toLowerCase();
    console.log('[whatsapp] state:', s);
  });
  client.on('loading_screen', (pct: number, msg: string) => {
    if (!everReady) detail = `loading ${pct}%${msg ? ` ${msg}` : ''}`;
    console.log(`[whatsapp] loading ${pct}% ${msg}`);
  });
  client.on('auth_failure', (m: string) => {
    lastError = `Authentication failed: ${m}`;
    console.log('[whatsapp] auth_failure:', m);
  });
  // Fires for both received and sent messages — the read-only mirror.
  client.on('message_create', (msg: Message) => {
    void persist(msg);
  });

  armReadyWatchdog();
  client.initialize().catch((err: unknown) => {
    const m = err instanceof Error ? err.message : String(err);
    console.error('[whatsapp] init failed:', m);
    lastError = `Launch failed: ${m}`;
    status = 'disconnected';
    if (readyTimer) clearTimeout(readyTimer), (readyTimer = null);
  });
}

/** Cleanly close the WhatsApp browser (prevents orphaned Chrome on restart). */
export async function stopWhatsApp(): Promise<void> {
  if (readyTimer) clearTimeout(readyTimer), (readyTimer = null);
  if (!client) return;
  const c = client;
  client = null;
  everReady = false;
  status = 'idle';
  detail = '';
  try {
    // destroy() can hang if the page is wedged — bound it, then force-kill any
    // Chrome it leaves behind so the next start has a clean profile.
    await Promise.race([
      c.destroy(),
      new Promise((resolve) => setTimeout(resolve, 10_000)),
    ]);
  } catch {
    /* best effort */
  }
  killOrphanChrome();
}

/**
 * Hard reset: stop, scrub orphan Chrome + stale locks, reset the attempt
 * counter, and start fresh. Used by the UI "Reconnect" button so the user can
 * recover from a stuck state without touching the terminal.
 */
export async function resetWhatsApp(): Promise<void> {
  await stopWhatsApp();
  cleanupSession();
  startAttempts = 0;
  lastError = '';
  startWhatsApp();
}

/**
 * Re-pair from scratch: stop, scrub orphans/locks, then DELETE the stored
 * session so the next start shows a fresh QR. The reliable escape hatch when the
 * session cache is corrupted (the "stuck at 99%" hang a plain restart can't
 * clear). Loses the current pairing — the user must scan the QR again.
 */
export async function repairWhatsApp(): Promise<void> {
  await stopWhatsApp();
  cleanupSession();
  try {
    fs.rmSync(authPath(), { recursive: true, force: true });
  } catch {
    /* best effort */
  }
  startAttempts = 0;
  lastError = '';
  everReady = false;
  startWhatsApp();
}

export interface WaChatInfo {
  id: string;
  name: string;
  isGroup: boolean;
}

/** List the connected account's chats for the selection UI (requires ready). */
export async function listWaChats(): Promise<WaChatInfo[]> {
  if (!client || status !== 'ready') return [];
  const chats = await client.getChats();
  return chats.map((c) => ({
    id: c.id._serialized,
    name: c.name || c.id.user || c.id._serialized,
    isGroup: c.isGroup,
  }));
}

/** Backfill recent history from selected chats (empty selection = all). */
export async function backfillWhatsApp(perChat = 50): Promise<{ inserted: number; chats: number }> {
  if (!client || status !== 'ready') return { inserted: 0, chats: 0 };
  const selected = getSelectedWaChats();
  const chats = (await client.getChats()).filter(
    (c) => !selected.length || selected.includes(c.id._serialized),
  );
  let inserted = 0;
  for (const chat of chats) {
    try {
      const msgs = await chat.fetchMessages({ limit: perChat });
      for (const m of msgs) inserted += await persist(m);
    } catch {
      /* skip a problematic chat */
    }
  }
  return { inserted, chats: chats.length };
}
