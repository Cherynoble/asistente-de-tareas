/**
 * Real code signing + notarization for "Asistente de Tareas".
 *
 * Replaces the ad-hoc signature (`npm run sign:adhoc`, still available as the
 * local-dev fallback) with the full Apple pipeline:
 *
 *   Developer ID Application cert  →  hardened runtime + entitlements
 *   →  codesign (inside-out, done by electron-builder)
 *   →  notarytool submit --wait
 *   →  stapler staple
 *   →  verification (codesign --verify, spctl --assess)
 *
 * Usage:
 *   npm run dist:signed
 *
 * Credentials — NEVER committed; this repo is public. Either:
 *   A. (recommended) a stored notarytool keychain profile:
 *        xcrun notarytool store-credentials "dadsapp" \
 *          --apple-id you@example.com --team-id TEAMID --password <app-specific>
 *        NOTARY_PROFILE=dadsapp npm run dist:signed
 *   B. env vars:
 *        APPLE_ID, APPLE_TEAM_ID, APPLE_APP_PASSWORD
 *
 * The signing identity is picked up from the login keychain. Override with
 * CSC_NAME="Developer ID Application: Your Name (TEAMID)".
 */
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const APP = '/Users/cherynoble/dadsapp-release/mac-arm64/Asistente de Tareas.app';

const run = (cmd, args, opts = {}) =>
  execFileSync(cmd, args, { stdio: 'inherit', cwd: ROOT, ...opts });
// Several codesign subcommands report on STDERR, so capture both streams.
const capture = (cmd, args) => {
  const r = spawnSync(cmd, args, { cwd: ROOT, encoding: 'utf8' });
  return `${r.stdout ?? ''}${r.stderr ?? ''}`;
};

function die(msg, hint) {
  console.error(`\n✗ ${msg}`);
  if (hint) console.error(`\n  ${hint}\n`);
  process.exit(1);
}

// ---- 1. Preflight: identity + credentials, BEFORE a 5-minute build ----

function findIdentity() {
  if (process.env.CSC_NAME) return process.env.CSC_NAME;
  let out = '';
  try {
    out = capture('/usr/bin/security', ['find-identity', '-v', '-p', 'codesigning']);
  } catch {
    die('Could not read the keychain.');
  }
  const m = out.match(/"(Developer ID Application: [^"]+)"/);
  if (!m) {
    die(
      'No "Developer ID Application" certificate found in the keychain.',
      'Enroll at developer.apple.com ($99/yr, INDIVIDUAL account — no D-U-N-S needed),\n' +
        '  then Xcode → Settings → Accounts → Manage Certificates → + → Developer ID Application.\n' +
        '  For a local unsigned build meanwhile, use: npm run dist',
    );
  }
  return m[1];
}

function notaryArgs() {
  if (process.env.NOTARY_PROFILE) return ['--keychain-profile', process.env.NOTARY_PROFILE];
  const { APPLE_ID, APPLE_TEAM_ID, APPLE_APP_PASSWORD } = process.env;
  if (APPLE_ID && APPLE_TEAM_ID && APPLE_APP_PASSWORD) {
    return ['--apple-id', APPLE_ID, '--team-id', APPLE_TEAM_ID, '--password', APPLE_APP_PASSWORD];
  }
  die(
    'No notarization credentials.',
    'Set NOTARY_PROFILE (see the header of this script), or APPLE_ID + APPLE_TEAM_ID + APPLE_APP_PASSWORD.\n' +
      '  Never put these in .env or any committed file — this repo is public.',
  );
}

const identity = findIdentity();
const notary = notaryArgs();
const teamId = (identity.match(/\(([A-Z0-9]+)\)\s*$/) || [])[1] || process.env.APPLE_TEAM_ID || '';
console.log(`• Signing identity: ${identity}`);
console.log(`• Team ID: ${teamId || '(unknown)'}`);

// ---- 2. Build + package, signed with hardened runtime ----

console.log('\n• Building dist/…');
run('npm', ['run', 'build']);
console.log('• Rebuilding better-sqlite3 for the Electron ABI…');
run('npm', ['run', 'rebuild:electron']);

console.log('• Packaging + signing…');
try {
  run('npx', [
    'electron-builder',
    '--mac',
    '--dir',
    `-c.mac.identity=${identity}`,
    '-c.mac.hardenedRuntime=true',
    '-c.mac.gatekeeperAssess=false',
    '-c.mac.entitlements=build/entitlements.mac.plist',
    '-c.mac.entitlementsInherit=build/entitlements.mac.inherit.plist',
    // Notarization is done explicitly below so each step is visible and
    // debuggable; electron-builder's own pass would duplicate it.
    '-c.mac.notarize=false',
  ]);
} finally {
  // Always restore the Node ABI so the tsx dev workflow keeps working, even if
  // packaging failed halfway.
  console.log('• Restoring better-sqlite3 for the Node ABI…');
  try {
    run('npm', ['run', 'rebuild:node']);
  } catch {
    console.error('  (restore failed — run `npm run rebuild:node` by hand)');
  }
}

if (!fs.existsSync(APP)) die(`Packaged app not found at ${APP}`);

// ---- 3. Verify the signature before wasting a notarization round trip ----

console.log('\n• Verifying signature…');
run('/usr/bin/codesign', ['--verify', '--strict', '--verbose=2', APP]);
const flags = capture('/usr/bin/codesign', ['-d', '--verbose=2', APP]);
if (!/runtime/.test(flags)) {
  die('The app is signed but NOT with the hardened runtime — notarization would reject it.');
}
console.log('  hardened runtime: present');

// ---- 4. Notarize ----

const zip = path.join(os.tmpdir(), `dadsapp-notarize-${Date.now()}.zip`);
console.log('\n• Zipping for submission…');
run('/usr/bin/ditto', ['-c', '-k', '--keepParent', APP, zip]);

console.log('• Submitting to Apple (this can take a few minutes)…');
try {
  run('xcrun', ['notarytool', 'submit', zip, ...notary, '--wait']);
} catch {
  console.error('\n  Notarization failed. To see why:');
  console.error(`    xcrun notarytool history ${notary.join(' ')}`);
  console.error(`    xcrun notarytool log <submission-id> ${notary.join(' ')}`);
  process.exit(1);
} finally {
  fs.rmSync(zip, { force: true });
}

// ---- 5. Staple, so Gatekeeper can validate OFFLINE ----
// This is the step that matters most for the China deployment: a stapled ticket
// lives inside the bundle, so first launch does not depend on reaching Apple.

console.log('\n• Stapling the notarization ticket…');
run('xcrun', ['stapler', 'staple', APP]);
run('xcrun', ['stapler', 'validate', APP]);

// ---- 6. Final assessment, the way the user's Mac will see it ----

console.log('\n• Gatekeeper assessment…');
run('/usr/sbin/spctl', ['--assess', '--type', 'execute', '--verbose=4', APP]);

console.log(`\n✓ Signed, notarized and stapled:\n  ${APP}`);
console.log('  It can be copied or AirDropped to any Mac and opened by double-clicking —');
console.log('  no `xattr -cr`, no "Open Anyway".');
console.log('\n  NOTE: re-signing with a NEW identity invalidates the existing Full Disk');
console.log('  Access grant. On each Mac: System Settings → Privacy & Security → Full Disk');
console.log('  Access → select "Asistente de Tareas" → "−" to remove it → then re-add.');
