// Pure, dependency-free half of the updater: version comparison, URL allow-
// listing, and payload integrity. Split out of updater.cjs (which requires
// `electron` at load time and therefore can't be unit-tested) so the parts that
// decide "is it safe to run this code" are covered by tests/updater.test.ts.
const crypto = require('node:crypto');

const REPO = 'Cherynoble/asistente-de-tareas';

// Every network call in the updater is bounded. Without this a throttled or
// blackholed connection — the normal failure mode on a China link — leaves
// "Buscar actualizaciones" spinning forever with no error and no way to cancel,
// because fetch() has no default timeout of its own.
const METADATA_TIMEOUT_MS = 20_000; // small JSON calls
const DOWNLOAD_TIMEOUT_MS = 10 * 60 * 1000; // the bundle zip, over a slow link

async function fetchWithTimeout(url, opts = {}, ms = METADATA_TIMEOUT_MS, fetchImpl = fetch) {
  try {
    return await fetchImpl(url, { ...opts, signal: AbortSignal.timeout(ms) });
  } catch (err) {
    // AbortSignal.timeout rejects with a TimeoutError DOMException; say what
    // actually happened instead of surfacing a bare "The operation was aborted".
    if (err && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      throw new Error(`Se agotó el tiempo de espera (${Math.round(ms / 1000)}s). Revisa la conexión a internet.`);
    }
    throw err;
  }
}

/** Compare dotted versions: -1 if a<b, 0 if equal, 1 if a>b. */
function cmpVersion(a, b) {
  const pa = String(a || '0').split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b || '0').split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] || 0;
    const y = pb[i] || 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

/**
 * Only install zips that are release assets of OUR repo. applyUpdate is
 * reachable from the renderer over IPC, so without this check a compromised
 * page could point the updater at an arbitrary zip and get its code run on next
 * launch. (GitHub redirects asset downloads to objects.githubusercontent.com;
 * fetch follows that redirect internally, so validating the initial URL is
 * enough.) This is defence in depth only — applyUpdate re-derives the URL from
 * the release manifest rather than trusting the renderer's copy.
 */
function isAllowedZipUrl(u) {
  try {
    const url = new URL(String(u));
    return (
      url.protocol === 'https:' &&
      url.hostname === 'github.com' &&
      url.pathname.startsWith(`/${REPO}/releases/download/`)
    );
  } catch {
    return false;
  }
}

/** SHA-256 of a buffer, lowercase hex. */
function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

/** A published hash is only usable if it is a real 64-hex-digit SHA-256. */
function isValidSha256(s) {
  return /^[0-9a-f]{64}$/i.test(String(s || ''));
}

/**
 * Decide whether a downloaded bundle may be installed. Returns
 * { ok: true } or { ok: false, message } — one place, so the rule can't drift
 * between the menu flow and the in-app flow.
 */
function verifyBundle(buf, expectedSha256) {
  if (!isValidSha256(expectedSha256)) {
    return { ok: false, message: 'La versión publicada no trae huella de verificación (sha256). No se instaló.' };
  }
  if (sha256(buf) !== String(expectedSha256).toLowerCase()) {
    return { ok: false, message: 'La actualización descargada está corrupta o alterada (sha256 no coincide). No se instaló.' };
  }
  return { ok: true };
}

module.exports = {
  REPO,
  METADATA_TIMEOUT_MS,
  DOWNLOAD_TIMEOUT_MS,
  fetchWithTimeout,
  cmpVersion,
  isAllowedZipUrl,
  sha256,
  isValidSha256,
  verifyBundle,
};
