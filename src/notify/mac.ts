import { execFile } from 'node:child_process';

export interface NotifyOpts {
  title: string;
  subtitle?: string;
  message: string;
  sound?: boolean;
}

/**
 * Electron's own Notification, when we're running inside the packaged app.
 *
 * Two reasons this is preferred over shelling out to osascript:
 *  1. Attribution — an osascript banner is attributed to the script host, so the
 *     owner sees notifications from something that isn't "Asistente de Tareas"
 *     and can't meaningfully allow/deny them per app.
 *  2. Hardened runtime — a signed, notarized app that drives osascript is
 *     sending Apple Events, which needs the apple-events entitlement and can
 *     raise a TCC automation prompt. Going through Electron avoids both.
 *
 * Loaded lazily and defensively: src/ also runs under plain node (`npm run
 * dashboard`), where there is no electron module to import.
 */
async function electronNotify(opts: NotifyOpts): Promise<boolean> {
  if (!process.versions.electron) return false;
  try {
    const mod = (await import('electron')) as unknown as {
      Notification?: {
        isSupported(): boolean;
        new (o: { title: string; subtitle?: string; body: string; silent?: boolean }): { show(): void };
      };
      default?: { Notification?: unknown };
    };
    const Ctor = mod.Notification ?? (mod.default as { Notification?: typeof mod.Notification })?.Notification;
    if (!Ctor || !Ctor.isSupported()) return false;
    new Ctor({
      title: opts.title,
      subtitle: opts.subtitle,
      body: opts.message,
      silent: opts.sound === false,
    }).show();
    return true;
  } catch {
    return false; // fall back to osascript
  }
}

/** osascript fallback for the dev server (plain node, no electron module). */
function osascriptNotify(opts: NotifyOpts): void {
  // Escape backslashes/quotes and flatten newlines for the AppleScript string.
  const esc = (s: string) => s.replace(/[\\"]/g, '\\$&').replace(/[\r\n]+/g, ' ').trim();
  let script = `display notification "${esc(opts.message)}" with title "${esc(opts.title)}"`;
  if (opts.subtitle) script += ` subtitle "${esc(opts.subtitle)}"`;
  if (opts.sound !== false) script += ` sound name "Glass"`;
  execFile('/usr/bin/osascript', ['-e', script], (err) => {
    if (err) console.error('[notify] failed:', err.message);
  });
}

/**
 * Fire a native macOS notification (best-effort). Non-fatal: off-mac, or on any
 * error, it just logs — a failed banner must never take down the always-on app.
 */
export function macNotify(opts: NotifyOpts): void {
  if (process.platform !== 'darwin') return;
  void electronNotify(opts).then((sent) => {
    if (!sent) osascriptNotify(opts);
  });
}
