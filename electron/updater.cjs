// In-app updater for Option B. A "code update" is just new dist/ + public/
// files published as a GitHub Release (a zip + a manifest.json). We download it,
// atomically swap it into the external code dir, and relaunch — no repackaging,
// no re-signing, and the database (one level up) is never touched.
//
// The native .app shell only needs re-delivering when a native/npm dependency
// changes; the manifest's `minShellVersion` gates that case and tells the user
// to download a fresh app instead of self-updating.
const { app } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { execFile } = require('node:child_process');

const {
  REPO,
  DOWNLOAD_TIMEOUT_MS,
  fetchWithTimeout,
  cmpVersion,
  isAllowedZipUrl,
  verifyBundle,
} = require('./update-core.cjs');
const RELEASES_PAGE = `https://github.com/${REPO}/releases/latest`;

const BUNDLE_ROOT = path.join(__dirname, '..');
const EXTERNAL_ROOT = path.join(app.getPath('appData'), 'DadsApp', 'app');
const UA = { 'User-Agent': 'asistente-de-tareas-updater' };

function readJson(p) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

function currentCodeVersion() {
  const ext = readJson(path.join(EXTERNAL_ROOT, 'code-version.json'));
  if (ext && ext.version) return ext.version;
  return (readJson(path.join(BUNDLE_ROOT, 'package.json')) || {}).version || '0';
}

function shellVersion() {
  return (readJson(path.join(BUNDLE_ROOT, 'package.json')) || {}).version || '0';
}

/**
 * Ask GitHub for the latest release and decide what (if anything) to do.
 * Returns one of:
 *   { status: 'up-to-date', currentVersion }
 *   { status: 'available', currentVersion, latestVersion, notes, zipUrl }
 *   { status: 'needs-new-app', currentVersion, latestVersion, page } // dep/native change
 *   { status: 'error', message }
 */
async function checkForUpdate() {
  try {
    const res = await fetchWithTimeout(`https://api.github.com/repos/${REPO}/releases/latest`, {
      headers: { ...UA, Accept: 'application/vnd.github+json' },
    });
    if (!res.ok) {
      if (res.status === 404) return { status: 'up-to-date', currentVersion: currentCodeVersion() };
      return { status: 'error', message: `GitHub respondió ${res.status}` };
    }
    const rel = await res.json();
    const assets = rel.assets || [];
    const manifestAsset = assets.find((a) => a.name === 'manifest.json');
    const zipAsset = assets.find((a) => a.name === 'app-bundle.zip');
    if (!manifestAsset || !zipAsset) {
      return { status: 'error', message: 'La versión publicada no trae los archivos esperados.' };
    }
    const manifestRes = await fetchWithTimeout(manifestAsset.browser_download_url, { headers: UA });
    if (!manifestRes.ok) return { status: 'error', message: `No se pudo leer el manifiesto (HTTP ${manifestRes.status}).` };
    const manifest = await manifestRes.json();
    const latest = manifest.version;
    const current = currentCodeVersion();

    if (cmpVersion(latest, current) <= 0) return { status: 'up-to-date', currentVersion: current };

    if (manifest.minShellVersion && cmpVersion(shellVersion(), manifest.minShellVersion) < 0) {
      return { status: 'needs-new-app', currentVersion: current, latestVersion: latest, page: RELEASES_PAGE };
    }
    return {
      status: 'available',
      currentVersion: current,
      latestVersion: latest,
      notes: manifest.notes || rel.body || '',
      zipUrl: zipAsset.browser_download_url,
      sha256: manifest.sha256 || '',
    };
  } catch (err) {
    return { status: 'error', message: String((err && err.message) || err) };
  }
}

function ditto(zipPath, destDir) {
  return new Promise((resolve, reject) => {
    execFile('/usr/bin/ditto', ['-x', '-k', zipPath, destDir], (err) =>
      err ? reject(err) : resolve(),
    );
  });
}

/** Move src→dest within EXTERNAL_ROOT (same volume), backing up any existing dest. */
function swapIn(stagedDir, name) {
  const cur = path.join(EXTERNAL_ROOT, name);
  const next = path.join(EXTERNAL_ROOT, `${name}.next`);
  const bak = path.join(EXTERNAL_ROOT, `${name}.bak`);
  fs.rmSync(next, { recursive: true, force: true });
  fs.cpSync(path.join(stagedDir, name), next, { recursive: true });
  fs.rmSync(bak, { recursive: true, force: true });
  if (fs.existsSync(cur)) fs.renameSync(cur, bak);
  fs.renameSync(next, cur);
  fs.rmSync(bak, { recursive: true, force: true });
}

/**
 * Download the update zip, validate it, and swap dist/+public/+package.json into
 * the external code dir. Returns { ok, version } or { ok:false, message }.
 * The caller relaunches afterwards.
 */
async function applyUpdate(requestedZipUrl) {
  if (!app.isPackaged) return { ok: false, message: 'Las actualizaciones solo se aplican en la app instalada.' };

  // Re-derive the URL and its hash from the release manifest instead of trusting
  // what came back over IPC. applyUpdate is reachable from the renderer, so a
  // compromised page could otherwise nominate any asset under our releases path
  // (isAllowedZipUrl only pins host + path prefix) and get its code executed on
  // the next launch. The renderer's value is now only a sanity check.
  const latest = await checkForUpdate();
  if (latest.status === 'error') return { ok: false, message: latest.message };
  if (latest.status !== 'available') return { ok: false, message: 'No hay ninguna actualización que instalar.' };
  const zipUrl = latest.zipUrl;
  if (!isAllowedZipUrl(zipUrl)) return { ok: false, message: 'URL de actualización no permitida.' };
  if (requestedZipUrl && requestedZipUrl !== zipUrl) {
    return { ok: false, message: 'La actualización cambió mientras se descargaba. Vuelve a intentarlo.' };
  }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dadsapp-update-'));
  try {
    const zipPath = path.join(tmp, 'app-bundle.zip');
    const res = await fetchWithTimeout(zipUrl, { headers: UA }, DOWNLOAD_TIMEOUT_MS);
    if (!res.ok) return { ok: false, message: `No se pudo descargar la actualización (HTTP ${res.status}).` };
    const buf = Buffer.from(await res.arrayBuffer());

    // An integrity check an attacker can skip by omitting the field is not an
    // integrity check: verifyBundle() rejects a missing hash as well as a wrong
    // one. release.mjs always publishes sha256, so absence is a fault.
    const verdict = verifyBundle(buf, latest.sha256);
    if (!verdict.ok) return { ok: false, message: verdict.message };
    fs.writeFileSync(zipPath, buf);

    const extracted = path.join(tmp, 'x');
    fs.mkdirSync(extracted, { recursive: true });
    await ditto(zipPath, extracted);

    // The zip may wrap contents in a top-level folder; find the dir holding dist/.
    let staged = extracted;
    if (!fs.existsSync(path.join(staged, 'dist', 'server', 'index.js'))) {
      const sub = fs.readdirSync(extracted).map((d) => path.join(extracted, d));
      staged =
        sub.find((d) => fs.existsSync(path.join(d, 'dist', 'server', 'index.js'))) || extracted;
    }
    if (
      !fs.existsSync(path.join(staged, 'dist', 'server', 'index.js')) ||
      !fs.existsSync(path.join(staged, 'public', 'index.html'))
    ) {
      return { ok: false, message: 'La actualización descargada no es válida.' };
    }
    const manifest = readJson(path.join(staged, 'manifest.json')) || {};

    swapIn(staged, 'dist');
    swapIn(staged, 'public');
    if (fs.existsSync(path.join(staged, 'package.json'))) {
      fs.copyFileSync(path.join(staged, 'package.json'), path.join(EXTERNAL_ROOT, 'package.json'));
    }
    fs.writeFileSync(
      path.join(EXTERNAL_ROOT, 'code-version.json'),
      JSON.stringify(
        { version: manifest.version || currentCodeVersion(), updatedFrom: 'online', at: Date.now() },
        null,
        2,
      ),
    );
    return { ok: true, version: manifest.version || currentCodeVersion() };
  } catch (err) {
    return { ok: false, message: String((err && err.message) || err) };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

module.exports = { checkForUpdate, applyUpdate, currentCodeVersion, RELEASES_PAGE };
