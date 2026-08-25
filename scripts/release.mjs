// Publish a CODE-ONLY update (Option B): build dist/, stage it with public/ +
// package.json + a manifest, zip it, and create a GitHub Release. The installed
// app's in-app updater picks it up and swaps it in — no repackage, no re-sign.
//
// Usage:
//   npm run release -- "Notas de esta versión"
// The release version is package.json's "version" — bump it before releasing.
// Set MIN_SHELL_VERSION only when the update needs a freshly delivered .app
// (e.g. a new/native npm dependency); then also hand over a rebuilt app.
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const version = pkg.version;
const notes = process.argv.slice(2).join(' ') || `Versión ${version}`;
const minShellVersion = process.env.MIN_SHELL_VERSION || version.split('.').slice(0, 2).join('.') + '.0';
const tag = `code-v${version}`;

const run = (cmd, args, opts = {}) =>
  execFileSync(cmd, args, { stdio: 'inherit', cwd: ROOT, ...opts });

// 1. Build fresh dist/.
console.log('• Building dist/…');
run('npm', ['run', 'build']);

// 2. Stage dist/ + public/ + package.json + manifest.json inside bundle/, with
//    the zip written OUTSIDE bundle/ so it isn't zipped into itself.
const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'dadsapp-release-'));
const bundleDir = path.join(stage, 'bundle');
fs.mkdirSync(bundleDir);
console.log(`• Staging in ${bundleDir}`);
fs.cpSync(path.join(ROOT, 'dist'), path.join(bundleDir, 'dist'), { recursive: true });
fs.cpSync(path.join(ROOT, 'public'), path.join(bundleDir, 'public'), { recursive: true });
fs.copyFileSync(path.join(ROOT, 'package.json'), path.join(bundleDir, 'package.json'));
// The manifest INSIDE the zip can't carry the zip's own hash, so it stays
// hash-free; applyUpdate only reads `version` from it. The manifest published as
// a RELEASE ASSET (written below, after zipping) is the one the updater trusts,
// and that one carries sha256.
const manifest = { version, minShellVersion, notes, at: Date.now() };
fs.writeFileSync(path.join(bundleDir, 'manifest.json'), JSON.stringify(manifest, null, 2));

// 3. Zip bundle/ contents at the archive root (no --keepParent).
const zipPath = path.join(stage, 'app-bundle.zip');
run('/usr/bin/ditto', ['-c', '-k', '--sequesterRsrc', bundleDir, zipPath]);

// 3b. Publish the zip's SHA-256 in the asset manifest. The installed updater
//     refuses any release without it, so this is required, not optional — it is
//     what lets a download over a hostile/slow link be trusted (or rejected).
const sha256 = crypto.createHash('sha256').update(fs.readFileSync(zipPath)).digest('hex');
const manifestPath = path.join(stage, 'manifest.json');
fs.writeFileSync(manifestPath, JSON.stringify({ ...manifest, sha256 }, null, 2));
console.log(`• sha256 ${sha256}`);

// 4. Create the GitHub Release with the zip + manifest as assets.
console.log(`• Creating release ${tag}…`);
run('gh', [
  'release', 'create', tag,
  zipPath,
  manifestPath,
  '--repo', 'Cherynoble/asistente-de-tareas',
  '--title', `Asistente de Tareas ${version}`,
  '--notes', notes,
]);

fs.rmSync(stage, { recursive: true, force: true });
console.log(`✓ Released ${tag} (minShellVersion ${minShellVersion}).`);
