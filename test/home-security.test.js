// Home Security app (docs/home-security.md): the server answers healthz, keeps api/ routes for t2/t3 (501 until
// implemented), serves nothing outside public/, and the default data dir follows RIGS_HOME.
import assert from 'node:assert/strict';
import path from 'node:path';
import { after, before, test } from 'node:test';

const { createServer, dataDir, DEFAULT_PORT } = await import('../apps/home-security/server.js');

let server, base;
before(async () => {
  server = createServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

test('healthz answers 200 with ok', async () => {
  const r = await fetch(`${base}/healthz`);
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.ok, true);
  assert.equal(j.app, 'home-security');
});

test('api routes are JSON (stubbed until implemented)', async () => {
  const r = await fetch(`${base}/api/cameras`);
  assert.notEqual(r.status, 404);
  assert.match(r.headers.get('content-type'), /application\/json/);
});

test('unknown paths and escapes are 404', async () => {
  for (const p of ['/nope.html', '/server.js', '/%2e%2e/server.js', '/..%2fserver.js', '/%E0%A4%A']) {
    assert.equal((await fetch(`${base}${p}`)).status, 404, p);
  }
});

test('data dir: HOME_SECURITY_DATA wins, else <RIGS_HOME>/home-security; port 8749', () => {
  assert.equal(dataDir({ HOME_SECURITY_DATA: '/x/y' }), '/x/y');
  assert.equal(dataDir({ RIGS_HOME: '/r' }), path.join('/r', 'home-security'));
  assert.equal(DEFAULT_PORT, 8749);
});
