// Vertex Cow applet: the server (healthz, page, module, 404s and no path escape), the cow geometry (enough
// finite points, the same cow from the same seed) and that the page uses relative URLs and fetches nothing.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'applets', 'vertex-cow');
const { createServer } = await import('../applets/vertex-cow/server.js');
const { buildCow, seeded } = await import('../applets/vertex-cow/public/cow.js');

let server, base;
before(async () => {
  server = createServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

test('healthz answers ok', async () => {
  const r = await fetch(`${base}/healthz`);
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { ok: true });
});

test('serves the page and the cow module', async () => {
  const page = await fetch(`${base}/`);
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-type'), /text\/html/);
  assert.match(await page.text(), /from '\.\/cow\.js'/);
  const mod = await fetch(`${base}/cow.js`);
  assert.equal(mod.status, 200);
  assert.match(mod.headers.get('content-type'), /javascript/);
});

test('unknown paths and escapes are 404', async () => {
  for (const p of ['/nope.html', '/server.js', '/%2e%2e/server.js', '/..%2fserver.js', '/%E0%A4%A']) {
    assert.equal((await fetch(`${base}${p}`)).status, 404, p);
  }
});

test('the cow is more than 1000 finite xyz points, the same for the same seed', () => {
  const pts = buildCow(seeded(7));
  assert.ok(pts.length > 1000, `${pts.length} points`);
  for (const p of pts) assert.ok(p.length === 3 && p.every(Number.isFinite));
  assert.deepEqual(buildCow(seeded(7)).slice(0, 50), pts.slice(0, 50));
  const ys = pts.map((p) => p[1]);
  assert.ok(Math.min(...ys) < -1 && Math.max(...ys) > 1, 'stands on legs below the centre, horns above');
});

test('page and module use relative URLs and fetch nothing external', () => {
  for (const f of ['public/index.html', 'public/cow.js']) {
    const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
    assert.doesNotMatch(src, /(?:src|href|from|import\()\s*=?\s*["'`]\//, `${f}: absolute /-rooted URL`);
    assert.doesNotMatch(src, /https?:\/\//, `${f}: external URL`);
    assert.doesNotMatch(src, /\bfetch\(|XMLHttpRequest|WebSocket/, `${f}: network call`);
  }
});
