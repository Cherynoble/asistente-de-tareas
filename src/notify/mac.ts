import { execFile } from 'node:child_process';

/**
 * Fire a native macOS notification (best-effort). Uses /usr/bin/osascript so it
 * works with no extra deps. Non-fatal: off-mac or on error it just logs.
 */
export function macNotify(opts: {
  title: string;
  subtitle?: string;
  message: string;
  sound?: boolean;
}): void {
  if (process.platform !== 'darwin') return;
  // Escape backslashes/quotes and flatten newlines for the AppleScript string.
  const esc = (s: string) => s.replace(/[\\"]/g, '\\$&').replace(/[\r\n]+/g, ' ').trim();
  let script = `display notification "${esc(opts.message)}" with title "${esc(opts.title)}"`;
  if (opts.subtitle) script += ` subtitle "${esc(opts.subtitle)}"`;
  if (opts.sound !== false) script += ` sound name "Glass"`;
  execFile('/usr/bin/osascript', ['-e', script], (err) => {
    if (err) console.error('[notify] failed:', err.message);
  });
}
