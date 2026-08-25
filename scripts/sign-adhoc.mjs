/**
 * Ad-hoc signing for LOCAL DEV builds — the fallback when there is no Apple
 * Developer account (or you just don't want to spend a notarization round trip).
 *
 * This does the same INSIDE-OUT pass the real pipeline does, with the same
 * hardened runtime and the same entitlements, so a dev build exercises the
 * production signing shape. Getting an entitlement wrong then fails here,
 * on this Mac, instead of on an office Mac in China.
 *
 * What it does NOT give you: a Developer ID identity or a notarization ticket.
 * An ad-hoc signed app is still "unidentified developer" on another Mac and
 * needs `xattr -cr` or "Open Anyway". For distribution use `npm run dist:signed`.
 *
 * Replaces the old one-liner `codesign --force --deep --sign -`. `--deep` is
 * deprecated by Apple and signs outside-in, which silently produces bundles
 * that fail verification in ways that only show up after AirDrop.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const APP = process.env.APP_PATH || '/Users/cherynoble/dadsapp-release/mac-arm64/Asistente de Tareas.app';
const ENT = path.join(ROOT, 'build', 'entitlements.mac.plist');
const ENT_INHERIT = path.join(ROOT, 'build', 'entitlements.mac.inherit.plist');

if (!fs.existsSync(APP)) {
  console.error(`✗ No app at ${APP} — run \`npm run dist\` first.`);
  process.exit(1);
}

const sign = (target, entitlements) =>
  execFileSync(
    '/usr/bin/codesign',
    [
      '--force',
      '--sign',
      '-',
      '--options',
      'runtime',
      '--timestamp=none', // ad-hoc signatures can't be timestamped
      ...(entitlements ? ['--entitlements', entitlements] : []),
      target,
    ],
    { stdio: ['ignore', 'ignore', 'pipe'] },
  );

/** Every Mach-O that isn't a bundle, deepest first. */
function machOFiles(dir) {
  const out = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) walk(p);
      else if (/\.(node|dylib|so)$/.test(e.name)) out.push(p);
    }
  };
  walk(dir);
  return out;
}

// 1. Native modules and libraries (deepest first).
const libs = machOFiles(APP);
for (const f of libs) sign(f);
console.log(`• signed ${libs.length} native binaries`);

// 2. Helper apps — these get the INHERIT entitlements, not the app's.
const fw = path.join(APP, 'Contents', 'Frameworks');
if (fs.existsSync(fw)) {
  for (const e of fs.readdirSync(fw)) {
    if (e.endsWith('.app')) {
      sign(path.join(fw, e), ENT_INHERIT);
      console.log(`• signed helper: ${e}`);
    }
  }
  // 3. Frameworks.
  for (const e of fs.readdirSync(fw)) {
    if (e.endsWith('.framework')) {
      sign(path.join(fw, e));
      console.log(`• signed framework: ${e}`);
    }
  }
}

// 4. The app bundle last, with the real entitlements.
sign(APP, ENT);
console.log('• signed app bundle');

// 5. Verify — a signature that doesn't verify is the AirDrop "damaged" bug.
execFileSync('/usr/bin/codesign', ['--verify', '--strict', '--verbose=2', APP], { stdio: 'inherit' });
// `codesign -d` writes its report to STDERR, not stdout — read both.
const probe = spawnSync('/usr/bin/codesign', ['-d', '--verbose=2', APP], { encoding: 'utf8' });
const info = `${probe.stdout ?? ''}${probe.stderr ?? ''}`;
const flags = /flags=([^\s]+)/.exec(info)?.[1] ?? '';
if (!/runtime/.test(flags)) {
  console.error(`✗ hardened runtime missing (flags=${flags})`);
  process.exit(1);
}
console.log(`\n✓ Ad-hoc signed with hardened runtime (flags=${flags}).`);
console.log('  Local/dev use only — for distribution run: npm run dist:signed');
