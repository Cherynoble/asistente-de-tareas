/**
 * Tests for the update path's security-critical decisions. These matter more
 * than usual: applyUpdate installs code that runs on the next launch, and it is
 * reachable from the renderer over IPC.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require_ = createRequire(import.meta.url);
const core = require_('../electron/update-core.cjs') as {
  cmpVersion(a: string, b: string): number;
  isAllowedZipUrl(u: unknown): boolean;
  sha256(buf: Buffer): string;
  isValidSha256(s: unknown): boolean;
  verifyBundle(buf: Buffer, expected: unknown): { ok: boolean; message?: string };
  fetchWithTimeout(url: string, opts?: object, ms?: number): Promise<Response>;
};

// ---- version comparison ----

test('cmpVersion orders releases, including uneven segment counts', () => {
  assert.equal(core.cmpVersion('1.8.0', '1.9.0'), -1);
  assert.equal(core.cmpVersion('1.10.0', '1.9.0'), 1); // not string order
  assert.equal(core.cmpVersion('1.8.0', '1.8.0'), 0);
  assert.equal(core.cmpVersion('1.8', '1.8.0'), 0);
  assert.equal(core.cmpVersion('1.8.1', '1.8'), 1);
  assert.equal(core.cmpVersion('', '0.0.1'), -1);
});

// ---- URL allow-listing ----

test('isAllowedZipUrl accepts only our repo release assets over https', () => {
  const ok = 'https://github.com/Cherynoble/asistente-de-tareas/releases/download/code-v1.9.0/app-bundle.zip';
  assert.equal(core.isAllowedZipUrl(ok), true);
});

test('isAllowedZipUrl rejects other hosts, other repos, http, and junk', () => {
  const bad = [
    'http://github.com/Cherynoble/asistente-de-tareas/releases/download/v1/app-bundle.zip', // not https
    'https://evil.com/Cherynoble/asistente-de-tareas/releases/download/v1/app-bundle.zip', // wrong host
    'https://github.com/attacker/evil-repo/releases/download/v1/app-bundle.zip', // wrong repo
    'https://github.com/Cherynoble/asistente-de-tareas/raw/main/x.zip', // wrong path
    'https://github.com.evil.com/Cherynoble/asistente-de-tareas/releases/download/v1/a.zip', // suffix trick
    'file:///tmp/app-bundle.zip',
    'not a url',
    '',
    null,
    undefined,
  ];
  for (const u of bad) {
    assert.equal(core.isAllowedZipUrl(u), false, `should reject: ${String(u)}`);
  }
});

// ---- payload integrity ----

test('verifyBundle accepts a payload whose hash matches', () => {
  const buf = Buffer.from('pretend this is app-bundle.zip');
  const v = core.verifyBundle(buf, core.sha256(buf));
  assert.equal(v.ok, true);
});

test('verifyBundle accepts an uppercase published hash', () => {
  const buf = Buffer.from('payload');
  const v = core.verifyBundle(buf, core.sha256(buf).toUpperCase());
  assert.equal(v.ok, true);
});

test('verifyBundle rejects a tampered payload', () => {
  const buf = Buffer.from('original payload');
  const published = core.sha256(buf);
  const tampered = Buffer.from('original payload + backdoor');
  const v = core.verifyBundle(tampered, published);
  assert.equal(v.ok, false);
  assert.match(v.message!, /no coincide/);
});

test('verifyBundle rejects a release with no hash at all — omission is not a bypass', () => {
  const buf = Buffer.from('payload');
  for (const missing of ['', null, undefined, 'not-a-hash', 'abc123']) {
    const v = core.verifyBundle(buf, missing);
    assert.equal(v.ok, false, `should reject published hash: ${String(missing)}`);
    assert.match(v.message!, /sha256/);
  }
});

test('isValidSha256 requires exactly 64 hex digits', () => {
  assert.equal(core.isValidSha256('a'.repeat(64)), true);
  assert.equal(core.isValidSha256('A'.repeat(64)), true);
  assert.equal(core.isValidSha256('a'.repeat(63)), false);
  assert.equal(core.isValidSha256('a'.repeat(65)), false);
  assert.equal(core.isValidSha256('g'.repeat(64)), false); // not hex
});

// ---- network timeouts ----
// The China link's real failure mode is a connection that accepts and then
// never answers. Before this, "Buscar actualizaciones" hung forever with no
// error and no cancel, because fetch() has no default timeout.

test('fetchWithTimeout aborts a request the server never answers', async () => {
  const http = await import('node:http');
  const sockets: import('node:net').Socket[] = [];
  const srv = http.createServer((_req, _res) => {
    /* deliberately never respond */
  });
  srv.on('connection', (s) => sockets.push(s));
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  const { port } = srv.address() as import('node:net').AddressInfo;
  try {
    const started = Date.now();
    await assert.rejects(
      core.fetchWithTimeout(`http://127.0.0.1:${port}/hang`, {}, 300),
      /tiempo de espera/,
      'should reject with a legible Spanish timeout message, not hang',
    );
    const elapsed = Date.now() - started;
    assert.ok(elapsed < 3000, `should give up promptly, took ${elapsed}ms`);
  } finally {
    for (const s of sockets) s.destroy();
    srv.close();
  }
});

test('fetchWithTimeout passes a normal response straight through', async () => {
  const http = await import('node:http');
  const srv = http.createServer((_req, res) => res.end('pong'));
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  const { port } = srv.address() as import('node:net').AddressInfo;
  try {
    const res = await core.fetchWithTimeout(`http://127.0.0.1:${port}/`, {}, 5000);
    assert.equal(await res.text(), 'pong');
  } finally {
    srv.close();
  }
});
