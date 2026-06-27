import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import pkg from 'whatsapp-web.js';
import type { Message } from 'whatsapp-web.js';
import QRCode from 'qrcode';
import { config } from '../../config.js';
import { db } from '../../db/index.js';
import {
  getSelectedWaChats,
  listWaAccounts,
  addWaAccount,
  removeWaAccount,
  setWaLabel,
  getWaLabel,
  setWaIdentity,
  getWaIdentity,
  waCacheDir,
  type WaAccountMeta,
  type WaIdentity,
} from '../../settings.js';

// whatsapp-web.js is CommonJS — default-import then destructure (Node's ESM
// loader can't bind its named exports directly).
const { Client, LocalAuth } = pkg;

export type WaStatus = 'idle' | 'starting' | 'qr' | 'authenticated' | 'ready' | 'disconnected';

const READY_TIMEOUT_MS = Number(process.env.WA_READY_TIMEOUT_MS ?? 90_000);
// Recycle at most once (a transient lock clears on relaunch). Beyond that the
// session cache is usually corrupted — recycling just re-links and thrashes, so
// we stop and tell the user to Re-pair instead.
const MAX_ATTEMPTS = Number(process.env.WA_MAX_ATTEMPTS ?? 2);

export interface WaState {
  id: string;
  label: string; // resolved display label (custom > identity > id)
  identity: WaIdentity | null; // connected phone number + profile name, if known
  status: WaStatus;
  qrDataUrl: string | null;
  detail: string;
  lastError: string;
  attempts: number;
  hasSession: boolean;
}

/** Find a Chrome/Chromium to drive: env override → system Chrome → bundled. */
function chromePath(): string | undefined {
  if (process.env.WA_CHROME_PATH) return process.env.WA_CHROME_PATH;
  const sys = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  if (fs.existsSync(sys)) return sys;
  return undefined; // let puppeteer use its bundled browser
}

/**
 * One WhatsApp Web mirror (read-only) for a single account. The app can run
 * several of these at once; each owns its own session directory, browser
 * profile, status, and recovery state. All the hard-won single-account fixes
 * (orphan-Chrome cleanup, stale-lock removal, the readiness watchdog, the
 * writable web-version cache) live here, now scoped per account.
 */
class WaAccount {
  readonly id: string;
  authDir: string;
  private client: InstanceType<typeof Client> | null = null;
  private status: WaStatus = 'idle';
  private qrDataUrl: string | null = null;
  private everReady = false;
  private detail = '';
  private lastError = '';
  private readyTimer: ReturnType<typeof setTimeout> | null = null;
  private startAttempts = 0;

  constructor(meta: WaAccountMeta) {
    this.id = meta.id;
    this.authDir = meta.authDir;
  }

  // ── paths (all per-account so two accounts never collide) ──
  private authPath(): string {
    return this.authDir;
  }
  private sessionPath(): string {
    return path.join(this.authDir, 'session');
  }

  hasSession(): boolean {
    try {
      return fs.existsSync(this.authPath()) && fs.readdirSync(this.authPath()).length > 0;
    } catch {
      return false;
    }
  }

  /** Resolved label: custom rename > connected identity > generic. */
  label(): string {
    const custom = getWaLabel(this.id);
    if (custom) return custom;
    const ident = getWaIdentity(this.id);
    if (ident) return ident.name || ident.number || this.id;
    const n = Number(this.id.replace(/^acc/, '')) || 0;
    return `Cuenta ${n || this.id}`;
  }

  state(): WaState {
    return {
      id: this.id,
      label: this.label(),
      identity: getWaIdentity(this.id),
      status: this.status,
      qrDataUrl: this.qrDataUrl,
      detail: this.detail,
      lastError: this.lastError,
      attempts: this.startAttempts,
      hasSession: this.hasSession(),
    };
  }

  /**
   * Kill any leftover Chrome bound to THIS account's profile. A non-graceful
   * kill of the server (e.g. kill -9, or the OS killing Chrome on sleep) orphans
   * the puppeteer Chrome; it keeps holding the userDataDir lock and the linked
   * session, so the next launch authenticates but never reaches 'ready'. We match
   * only processes whose command line references this account's session dir —
   * never the user's normal Chrome and never a sibling account.
   */
  private killOrphanChrome(): number {
    const needle = this.authPath();
    let out = '';
    try {
      out = execFileSync('/bin/ps', ['-axo', 'pid=,command='], { encoding: 'utf8' });
    } catch {
      return 0;
    }
    let killed = 0;
    for (const line of out.split('\n')) {
      if (!line.includes(needle)) continue; // only this account's session
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
  private removeStaleLocks(): void {
    for (const f of ['SingletonLock', 'SingletonCookie', 'SingletonSocket']) {
      try {
        fs.rmSync(path.join(this.sessionPath(), f), { force: true });
      } catch {
        /* best effort */
      }
    }
  }

  /** Clean slate before launching: only safe when no client is live here. */
  private cleanupSession(): void {
    const killed = this.killOrphanChrome();
    if (killed) console.log(`[whatsapp:${this.id}] cleaned up ${killed} orphaned Chrome process(es)`);
    this.removeStaleLocks();
  }

  /** Capture the connected account's phone number + profile name (post-ready). */
  private async captureIdentity(): Promise<void> {
    try {
      const info = (this.client as unknown as { info?: { wid?: { user?: string }; pushname?: string } })
        ?.info;
      const number = info?.wid?.user || '';
      const name = info?.pushname || '';
      if (number || name) setWaIdentity(this.id, { number, name });
    } catch {
      /* identity is best-effort */
    }
  }

  /**
   * If we authenticate but never reach 'ready' within the timeout, recycle the
   * client (up to MAX_ATTEMPTS) instead of hanging on "connecting…" forever.
   */
  private armReadyWatchdog(): void {
    if (this.readyTimer) clearTimeout(this.readyTimer);
    this.readyTimer = setTimeout(() => {
      if (this.status === 'ready') return;

      // Authenticated but not ready = WhatsApp's initial history sync (the phone
      // shows a spinning linked-device indicator). The first sync of a busy
      // account can take minutes. Recycling here would re-link and restart that
      // sync from scratch — so it might NEVER finish. Be patient.
      if (this.status === 'authenticated') {
        this.detail =
          'sincronizando — la primera vez puede tardar varios minutos; deja la app abierta y el teléfono conectado';
        return;
      }
      if (this.status === 'qr') return; // still awaiting the scan; auto-refreshes

      // Stuck on 'starting': the browser launched but never loaded WhatsApp Web.
      if (this.startAttempts >= MAX_ATTEMPTS) {
        this.lastError =
          `No se pudo cargar WhatsApp tras ${MAX_ATTEMPTS} intentos. Pulsa "Reconectar"; ` +
          `si el problema persiste, "Volver a vincular".`;
        this.detail = '';
        this.status = 'disconnected';
        console.warn(`[whatsapp:${this.id}] ${this.lastError}`);
        void this.stop();
        return;
      }
      console.warn(
        `[whatsapp:${this.id}] stuck at "starting" after ${Math.round(
          READY_TIMEOUT_MS / 1000,
        )}s — recycling (attempt ${this.startAttempts}/${MAX_ATTEMPTS})`,
      );
      void (async () => {
        await this.stop();
        this.start(); // re-cleans the session and re-inits
      })();
    }, READY_TIMEOUT_MS);
  }

  private readonly INSERT = `INSERT OR IGNORE INTO messages
    (source, wa_account, source_msg_id, chat_id, chat_name, sender, sender_name, direction,
     body, ts, ingested_at, has_attachment, attachment_mimes, attachment_names, attachment_paths)
    VALUES (@source, @account, @sid, @chatId, @chatName, @sender, @senderName, @dir,
     @body, @ts, @now, @hasAtt, @mimes, '', '')`;

  /** Normalize and persist one WhatsApp message. Returns 1 if newly inserted. */
  private async persist(msg: Message): Promise<number> {
    try {
      const selected = getSelectedWaChats(this.id);
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
        .prepare(this.INSERT)
        .run({
          source: 'whatsapp',
          account: this.id,
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

  /** Start (or no-op if already started) this account's mirror. */
  start(): void {
    if (this.client) return;
    fs.mkdirSync(this.authPath(), { recursive: true });
    fs.mkdirSync(waCacheDir(this.id), { recursive: true });
    // Self-heal: clear any orphaned Chrome / stale locks from a previous run
    // before launching, so we never inherit a locked profile.
    this.cleanupSession();
    this.startAttempts += 1;
    this.status = 'starting';
    this.qrDataUrl = null;
    this.detail = this.startAttempts > 1 ? `retrying (attempt ${this.startAttempts})…` : 'starting browser…';
    this.lastError = '';

    // Optional web-version pin. A NEWER build is sometimes needed so a fresh
    // device link doesn't fail ("Couldn't link device"), but the library only
    // fully hooks on the version it was built for. Pin a newer version only to
    // LINK; reconnect on the library default to actually run.
    const pin = process.env.WA_WEB_VERSION ?? 'default';
    const usePin = pin.toLowerCase() !== 'default' && pin !== '';

    this.client = new Client({
      // Each account gets its own dataPath → its own session + browser profile.
      authStrategy: new LocalAuth({ dataPath: this.authPath() }),
      // The web-version cache MUST be writable (a bundled .app runs with CWD "/",
      // read-only). whatsapp-web.js's persist() throws right after 'authenticated'
      // and before 'ready' otherwise — the classic "authenticated — syncing" hang.
      // Per-account cache dir so two clients never race on the same files.
      webVersionCache: usePin
        ? {
            type: 'remote' as const,
            remotePath:
              'https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/{version}.html',
          }
        : { type: 'local' as const, path: waCacheDir(this.id) },
      ...(usePin ? { webVersion: pin } : {}),
      puppeteer: {
        headless: process.env.WA_HEADLESS !== '0',
        executablePath: chromePath(),
        args: ['--no-sandbox', '--disable-setuid-sandbox'],
      },
    });

    this.client.on('qr', async (qr: string) => {
      if (!this.everReady) this.status = 'qr';
      try {
        this.qrDataUrl = await QRCode.toDataURL(qr, { width: 320, margin: 1 });
      } catch {
        this.qrDataUrl = null;
      }
    });
    this.client.on('authenticated', () => {
      if (!this.everReady) this.status = 'authenticated';
      this.detail = 'authenticated — syncing…';
      this.qrDataUrl = null;
    });
    this.client.on('ready', () => {
      this.everReady = true;
      this.status = 'ready';
      this.qrDataUrl = null;
      this.detail = '';
      this.lastError = '';
      this.startAttempts = 0; // healthy — reset the recycle counter
      if (this.readyTimer) clearTimeout(this.readyTimer), (this.readyTimer = null);
      void this.captureIdentity();
      console.log(`[whatsapp:${this.id}] ready`);
    });
    this.client.on('disconnected', (reason: string) => {
      this.everReady = false;
      this.status = 'disconnected';
      this.detail = '';
      if (this.readyTimer) clearTimeout(this.readyTimer), (this.readyTimer = null);
      console.log(`[whatsapp:${this.id}] disconnected:`, reason);
    });
    this.client.on('change_state', (s: string) => {
      this.detail = String(s).toLowerCase();
      console.log(`[whatsapp:${this.id}] state:`, s);
    });
    this.client.on('loading_screen', (pct: number, msg: string) => {
      if (!this.everReady) this.detail = `loading ${pct}%${msg ? ` ${msg}` : ''}`;
      console.log(`[whatsapp:${this.id}] loading ${pct}% ${msg}`);
    });
    this.client.on('auth_failure', (m: string) => {
      this.lastError = `Authentication failed: ${m}`;
      console.log(`[whatsapp:${this.id}] auth_failure:`, m);
    });
    // Fires for both received and sent messages — the read-only mirror.
    this.client.on('message_create', (msg: Message) => {
      void this.persist(msg);
    });

    this.armReadyWatchdog();
    this.client.initialize().catch((err: unknown) => {
      const m = err instanceof Error ? err.message : String(err);
      console.error(`[whatsapp:${this.id}] init failed:`, m);
      this.lastError = `Launch failed: ${m}`;
      this.status = 'disconnected';
      if (this.readyTimer) clearTimeout(this.readyTimer), (this.readyTimer = null);
    });
  }

  /** Cleanly close this account's browser (prevents orphaned Chrome). */
  async stop(): Promise<void> {
    if (this.readyTimer) clearTimeout(this.readyTimer), (this.readyTimer = null);
    if (!this.client) return;
    const c = this.client;
    this.client = null;
    this.everReady = false;
    this.status = 'idle';
    this.detail = '';
    try {
      await Promise.race([c.destroy(), new Promise((resolve) => setTimeout(resolve, 10_000))]);
    } catch {
      /* best effort */
    }
    this.killOrphanChrome();
  }

  /** Hard reset: stop, scrub orphans/locks, reset the attempt counter, restart. */
  async reset(): Promise<void> {
    await this.stop();
    this.cleanupSession();
    this.startAttempts = 0;
    this.lastError = '';
    this.start();
  }

  /** Re-pair: stop, scrub, DELETE the stored session so a fresh QR is shown. */
  async repair(): Promise<void> {
    await this.stop();
    this.cleanupSession();
    try {
      fs.rmSync(this.authPath(), { recursive: true, force: true });
    } catch {
      /* best effort */
    }
    this.startAttempts = 0;
    this.lastError = '';
    this.everReady = false;
    this.start();
  }

  /** Wipe this account's on-disk session + cache (used when removing it). */
  wipeSession(): void {
    try {
      fs.rmSync(this.authPath(), { recursive: true, force: true });
    } catch {
      /* best effort */
    }
    try {
      fs.rmSync(waCacheDir(this.id), { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }

  isReady(): boolean {
    return this.status === 'ready';
  }

  /** List this account's chats for the selection UI (requires ready). */
  async listChats(): Promise<WaChatInfo[]> {
    if (!this.client || this.status !== 'ready') return [];
    const chats = await this.client.getChats();
    return chats.map((c) => ({
      id: c.id._serialized,
      name: c.name || c.id.user || c.id._serialized,
      isGroup: c.isGroup,
    }));
  }

  /** Backfill recent history from selected chats (empty selection = all). */
  async backfill(perChat = 50): Promise<{ inserted: number; chats: number }> {
    if (!this.client || this.status !== 'ready') return { inserted: 0, chats: 0 };
    const selected = getSelectedWaChats(this.id);
    const chats = (await this.client.getChats()).filter(
      (c) => !selected.length || selected.includes(c.id._serialized),
    );
    let inserted = 0;
    for (const chat of chats) {
      try {
        const msgs = await chat.fetchMessages({ limit: perChat });
        for (const m of msgs) inserted += await this.persist(m);
      } catch {
        /* skip a problematic chat */
      }
    }
    return { inserted, chats: chats.length };
  }
}

export interface WaChatInfo {
  id: string;
  name: string;
  isGroup: boolean;
}

// ─────────────────────────────── manager ───────────────────────────────
// A registry of live WaAccount instances, hydrated from the settings registry.

const accounts = new Map<string, WaAccount>();

function hydrate(): void {
  for (const meta of listWaAccounts()) {
    const existing = accounts.get(meta.id);
    if (existing) {
      existing.authDir = meta.authDir; // keep path in sync with the registry
    } else {
      accounts.set(meta.id, new WaAccount(meta));
    }
  }
}

function get(id: string): WaAccount | null {
  hydrate();
  return accounts.get(id) ?? null;
}

/** All accounts' states for the UI. */
export function listAccountStates(): WaState[] {
  hydrate();
  return [...accounts.values()].map((a) => a.state());
}

export function getAccountState(id: string): WaState | null {
  return get(id)?.state() ?? null;
}

/** Add a new account slot, start pairing, and return its state. */
export function addAccount(): WaState {
  const meta = addWaAccount();
  const a = new WaAccount(meta);
  accounts.set(meta.id, a);
  a.start();
  return a.state();
}

/** Remove an account: stop it, wipe its session, drop it from the registry. */
export async function removeAccount(id: string): Promise<void> {
  const a = get(id);
  if (a) {
    await a.stop();
    a.wipeSession();
    accounts.delete(id);
  }
  removeWaAccount(id);
}

/** Rename (custom label) an account; pass '' to clear back to auto. */
export function renameAccount(id: string, label: string): WaState | null {
  setWaLabel(id, label);
  return get(id)?.state() ?? null;
}

export function startAccount(id: string): WaState | null {
  const a = get(id);
  a?.start();
  return a?.state() ?? null;
}

export async function resetAccount(id: string): Promise<WaState | null> {
  const a = get(id);
  if (a) await a.reset();
  return a?.state() ?? null;
}

export async function repairAccount(id: string): Promise<WaState | null> {
  const a = get(id);
  if (a) await a.repair();
  return a?.state() ?? null;
}

export async function backfillAccount(
  id: string,
  perChat = 50,
): Promise<{ inserted: number; chats: number }> {
  const a = get(id);
  if (!a) return { inserted: 0, chats: 0 };
  return a.backfill(perChat);
}

export async function listAccountChats(id: string): Promise<WaChatInfo[]> {
  const a = get(id);
  if (!a) return [];
  return a.listChats();
}

export function accountIsReady(id: string): boolean {
  return get(id)?.isReady() ?? false;
}

/** Start every registered account that already has a paired session (boot). */
export function startAllSessions(): void {
  hydrate();
  for (const a of accounts.values()) if (a.hasSession()) a.start();
}

/** Stop every account cleanly (shutdown / sleep). */
export async function stopAllAccounts(): Promise<void> {
  hydrate();
  await Promise.all([...accounts.values()].map((a) => a.stop()));
}

/** True if any account has a paired session (used to decide boot reconnect). */
export function anyWaSession(): boolean {
  hydrate();
  return [...accounts.values()].some((a) => a.hasSession());
}

// ── Back-compat aliases: the installed Electron shell imports these names from
// the compiled client.js for graceful shutdown / relaunch. stopWhatsApp now
// stops ALL accounts, so the existing shell still closes both browsers cleanly
// on quit without needing a new .app.
export const stopWhatsApp = stopAllAccounts;
export const startWhatsApp = startAllSessions;
