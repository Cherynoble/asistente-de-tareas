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
// Wedged-sync recovery: a busy account's first history sync can take minutes and
// is left strictly alone WHILE it makes progress (loading % advances, state
// changes, messages arrive). But if it sits in 'authenticated' with NO progress
// at all for this long, the sync is genuinely stuck (the classic "loading 99%"
// wedge) — we auto-recover it (reset keeps the session, no QR), bounded so a
// pathological account can't loop forever; after that we ask the user to re-pair.
const SYNC_STALL_MS = Number(process.env.WA_SYNC_STALL_MS ?? 5 * 60_000);
const MAX_SYNC_RECYCLES = Number(process.env.WA_MAX_SYNC_RECYCLES ?? 2);
// Cap how big an attachment we download+store (skip huge files). 16 MB covers
// any photo or product PDF; videos/audio are skipped by type anyway.
const MAX_MEDIA_BYTES = Number(process.env.WA_MAX_MEDIA_BYTES ?? 16 * 1024 * 1024);
const MEDIA_DL_TIMEOUT_MS = Number(process.env.WA_MEDIA_TIMEOUT_MS ?? 20_000);
// On-demand fetch (user opened the attachment gallery) is more permissive than
// ingest: any media type, bigger cap, longer wait — because it's explicit.
const ONDEMAND_MAX_BYTES = Number(process.env.WA_ONDEMAND_MAX_BYTES ?? 64 * 1024 * 1024);
const ONDEMAND_TIMEOUT_MS = Number(process.env.WA_ONDEMAND_TIMEOUT_MS ?? 60_000);

/** Reasonable file extension for a mime type (for a tidy stored filename). */
function extForMime(mime: string): string {
  const map: Record<string, string> = {
    'application/pdf': 'pdf',
    'image/jpeg': 'jpg',
    'image/png': 'png',
    'image/webp': 'webp',
    'image/gif': 'gif',
    'video/mp4': 'mp4',
    'video/quicktime': 'mov',
    'video/3gpp': '3gp',
    'audio/ogg': 'ogg',
    'audio/mpeg': 'mp3',
    'audio/mp4': 'm4a',
    'audio/aac': 'aac',
  };
  return map[mime] || (mime.split('/')[1] || 'bin').replace(/[^a-z0-9]/gi, '').slice(0, 8) || 'bin';
}

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
  // Wedged-sync detection (see SYNC_STALL_MS): a recurring watchdog armed on
  // 'authenticated' that only fires when the sync stops making progress.
  private syncTimer: ReturnType<typeof setInterval> | null = null;
  private lastProgressAt = 0;
  private lastLoadingPct = -1;
  private syncRecycles = 0;

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

  /** Note that the sync made progress (loading %, state change, or a message). */
  private markSyncProgress(): void {
    this.lastProgressAt = Date.now();
  }

  private clearSyncWatchdog(): void {
    if (this.syncTimer) {
      clearInterval(this.syncTimer);
      this.syncTimer = null;
    }
  }

  /**
   * Police a stalled history sync. Armed when we reach 'authenticated'; checks
   * once a minute. A sync that is still advancing (markSyncProgress keeps
   * lastProgressAt fresh) is left completely alone — only one that has frozen for
   * SYNC_STALL_MS is recovered, and only MAX_SYNC_RECYCLES times before we hand
   * off to the user. reset() keeps the stored session, so recovery needs no QR.
   */
  private armSyncWatchdog(): void {
    if (this.syncTimer) return;
    this.markSyncProgress();
    this.syncTimer = setInterval(() => {
      if (this.status === 'ready') return this.clearSyncWatchdog();
      if (this.status !== 'authenticated') return; // only police a live sync
      const stalledFor = Date.now() - this.lastProgressAt;
      if (stalledFor < SYNC_STALL_MS) return; // still making progress — be patient

      if (this.syncRecycles >= MAX_SYNC_RECYCLES) {
        this.lastError =
          'La sincronización se quedó atascada. Pulsa "Volver a vincular" para reconectar esta cuenta.';
        this.detail = '';
        this.clearSyncWatchdog();
        console.warn(`[whatsapp:${this.id}] sync wedged after ${MAX_SYNC_RECYCLES} recoveries — needs re-pair`);
        return;
      }
      this.syncRecycles += 1; // bound persists across reset() so this can't loop
      console.warn(
        `[whatsapp:${this.id}] sync stalled ${Math.round(stalledFor / 1000)}s with no progress — ` +
          `auto-recovering (${this.syncRecycles}/${MAX_SYNC_RECYCLES})`,
      );
      this.clearSyncWatchdog();
      void this.reset(); // scrub orphan Chrome + relaunch; keeps the session (no QR)
    }, 60_000);
  }

  private readonly INSERT = `INSERT OR IGNORE INTO messages
    (source, wa_account, source_msg_id, chat_id, chat_name, sender, sender_name, direction,
     body, ts, ingested_at, has_attachment, attachment_mimes, attachment_names, attachment_paths)
    VALUES (@source, @account, @sid, @chatId, @chatName, @sender, @senderName, @dir,
     @body, @ts, @now, @hasAtt, @mimes, @names, @paths)`;

  // Downloading media is still read-only — downloadMedia only fetches to the
  // linked device, it never sends. Best-effort: a failure just leaves the
  // "[attachment: …]" marker. Ingest keeps only images/PDFs (for vision); the
  // on-demand gallery path keeps any type.

  /** Download + store a message's media to disk. `accept` gates which mimes we
   *  keep; `maxBytes`/`timeoutMs` bound cost. Returns the stored file or null. */
  private async storeMedia(
    msg: Message,
    accept: (mime: string) => boolean,
    maxBytes: number,
    timeoutMs: number,
  ): Promise<{ mime: string; name: string; path: string } | null> {
    try {
      const media = await Promise.race([
        msg.downloadMedia(),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), timeoutMs)),
      ]);
      if (!media || !media.data) return null;
      const mime = media.mimetype || '';
      if (!accept(mime)) return null;
      const buf = Buffer.from(media.data, 'base64');
      if (!buf.length || buf.length > maxBytes) return null;
      const dir = path.join(config.dataDir, 'wa_media', this.id);
      fs.mkdirSync(dir, { recursive: true });
      const ext = extForMime(mime);
      const base = msg.id._serialized.replace(/[^a-zA-Z0-9]/g, '_').slice(0, 80);
      const filePath = path.join(dir, `${base}.${ext}`);
      fs.writeFileSync(filePath, buf);
      return { mime, name: media.filename || `${msg.type}.${ext}`, path: filePath };
    } catch {
      return null;
    }
  }

  /** Ingest-time: conservative — only images/PDFs, modest cap (bulk backfill). */
  private async saveMedia(msg: Message): Promise<{ mime: string; name: string; path: string } | null> {
    if (msg.type !== 'image' && msg.type !== 'document') return null;
    return this.storeMedia(
      msg,
      (m) => m.startsWith('image/') || m === 'application/pdf',
      MAX_MEDIA_BYTES,
      MEDIA_DL_TIMEOUT_MS,
    );
  }

  /** Normalize and persist one WhatsApp message. Returns 1 if newly inserted. */
  private async persist(msg: Message): Promise<number> {
    try {
      const selected = getSelectedWaChats(this.id);
      if (selected.length && msg.id.remote && !selected.includes(msg.id.remote)) return 0;

      // Stickers are pure noise for a task tracker (memes/emoji, no product
      // signal) and just eat storage + on-demand downloads. Drop them entirely.
      if (msg.type === 'sticker') return 0;

      const hasMedia = msg.hasMedia;
      let body = msg.body || '';
      if (!body && hasMedia) body = `[attachment: ${msg.type}]`;
      if (!body) return 0;

      // Already stored? (UNIQUE(source, source_msg_id)) Then don't re-download —
      // but if it was captured before media download existed and still has no
      // file, backfill the attachment now, so re-importing history fills media
      // onto old rows. Either way it's not a new insert.
      const sid = msg.id._serialized;
      const existing = db()
        .prepare(
          `SELECT id, attachment_paths AS paths FROM messages WHERE source='whatsapp' AND source_msg_id = ?`,
        )
        .get(sid) as { id: number; paths: string | null } | undefined;
      if (existing) {
        if (hasMedia && !(existing.paths && existing.paths.trim())) {
          const saved = await this.saveMedia(msg);
          if (saved) {
            db()
              .prepare(
                `UPDATE messages SET attachment_mimes=?, attachment_names=?, attachment_paths=? WHERE id=?`,
              )
              .run(saved.mime, saved.name, saved.path, existing.id);
          }
        }
        return 0;
      }

      // New message → download image/PDF media so it can be shown + vision-
      // analyzed. Falls back to a bare type marker (mime = msg.type, no path)
      // when download isn't possible, so capture never depends on it.
      let mimes = hasMedia ? msg.type : '';
      let names = '';
      let paths = '';
      if (hasMedia) {
        const saved = await this.saveMedia(msg);
        if (saved) {
          mimes = saved.mime;
          names = saved.name;
          paths = saved.path;
        }
      }

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
          mimes,
          names,
          paths,
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
    this.lastLoadingPct = -1; // fresh sync — first loading % counts as progress

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
      this.armSyncWatchdog(); // start policing a possibly-wedged history sync
    });
    this.client.on('ready', () => {
      this.everReady = true;
      this.status = 'ready';
      this.qrDataUrl = null;
      this.detail = '';
      this.lastError = '';
      this.startAttempts = 0; // healthy — reset the recycle counter
      this.syncRecycles = 0; // a completed sync proves health
      this.clearSyncWatchdog();
      if (this.readyTimer) clearTimeout(this.readyTimer), (this.readyTimer = null);
      void this.captureIdentity();
      console.log(`[whatsapp:${this.id}] ready`);
    });
    this.client.on('disconnected', (reason: string) => {
      this.everReady = false;
      this.status = 'disconnected';
      this.detail = '';
      this.clearSyncWatchdog();
      if (this.readyTimer) clearTimeout(this.readyTimer), (this.readyTimer = null);
      console.log(`[whatsapp:${this.id}] disconnected:`, reason);
    });
    this.client.on('change_state', (s: string) => {
      this.detail = String(s).toLowerCase();
      this.markSyncProgress(); // a state transition means the sync is alive
      console.log(`[whatsapp:${this.id}] state:`, s);
    });
    this.client.on('loading_screen', (pct: number, msg: string) => {
      if (!this.everReady) this.detail = `loading ${pct}%${msg ? ` ${msg}` : ''}`;
      // A changing percentage is real progress; a frozen one is not (don't keep
      // the watchdog alive on a stuck "loading 99%").
      if (pct !== this.lastLoadingPct) {
        this.lastLoadingPct = pct;
        this.markSyncProgress();
      }
      console.log(`[whatsapp:${this.id}] loading ${pct}% ${msg}`);
    });
    this.client.on('auth_failure', (m: string) => {
      this.lastError = `Authentication failed: ${m}`;
      console.log(`[whatsapp:${this.id}] auth_failure:`, m);
    });
    // Fires for both received and sent messages — the read-only mirror.
    this.client.on('message_create', (msg: Message) => {
      this.markSyncProgress(); // messages flowing = the connection is working
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
    this.clearSyncWatchdog();
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
    this.syncRecycles = 0; // explicit user re-pair — fresh slate for sync recovery
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

  /**
   * On-demand media fetch for a stored message that has no downloaded file yet
   * (captured before media download existed, or an earlier download failed).
   * Requires the account connected; fetches the message live, saves the media,
   * updates the row so future requests hit the file directly. Returns the file
   * or null (media gone / not an image·PDF / account offline).
   */
  async downloadMediaById(sid: string): Promise<{ mime: string; path: string } | null> {
    if (!this.client || this.status !== 'ready') return null;
    try {
      const msg = await this.client.getMessageById(sid);
      if (!msg || !msg.hasMedia) return null;
      if (msg.type === 'sticker') return null; // never spend time/storage on stickers
      // Permissive: the user explicitly opened this attachment, so fetch any
      // type (video, audio, doc), with a larger cap and longer wait.
      const saved = await this.storeMedia(msg, () => true, ONDEMAND_MAX_BYTES, ONDEMAND_TIMEOUT_MS);
      if (!saved) return null;
      db()
        .prepare(
          `UPDATE messages SET attachment_mimes=?, attachment_names=?, attachment_paths=?
           WHERE source='whatsapp' AND source_msg_id=?`,
        )
        .run(saved.mime, saved.name, saved.path, sid);
      return { mime: saved.mime, path: saved.path };
    } catch {
      return null;
    }
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

/** On-demand media fetch for a WhatsApp message that has no stored file yet. */
export async function downloadWaMedia(
  accountId: string,
  sid: string,
): Promise<{ mime: string; path: string } | null> {
  const a = get(accountId);
  return a ? a.downloadMediaById(sid) : null;
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
