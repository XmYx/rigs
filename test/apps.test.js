// App registry tests: config validation, health transitions, aggregation, resolveApp (no daemon needed).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

process.env.RIGS_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'rigs-apps-'));
process.env.RIGS_NAME = 'mac';
const A = await import('../src/apps.js');
const { saveConfig, loadConfig } = await import('../src/config.js');

test('validateApp: port app gets defaults and the local node name', () => {
  const { app, errors } = A.validateApp({ id: 'SZUF', name: 'SZÜF', icon: '🚗', port: 8787, host: '100.82.152.1' });
  assert.deepEqual(errors, []);
  assert.equal(app.id, 'szuf');
  assert.equal(app.node, 'mac');
  assert.equal(app.target, 'http://100.82.152.1:8787');
  assert.equal(app.healthPath, '/');
});

test('validateApp: url form, launch and rewrite hints', () => {
  const { app, errors } = A.validateApp({ id: 'wiki', url: 'http://127.0.0.1:3000/base/', healthPath: '/up', launch: { systemd: 'wiki.service' }, rewrite: { rootRelative: true, basePath: '/ui' } });
  assert.deepEqual(errors, []);
  assert.equal(app.target, 'http://127.0.0.1:3000/base');
  assert.deepEqual(app.launch, { systemd: 'wiki.service' });
  assert.deepEqual(app.rewrite, { rootRelative: true, basePath: '/ui' });
});

test('validateApp: rejects bad input with readable errors', () => {
  const bad = (raw) => A.validateApp(raw).errors.join(' | ');
  assert.match(bad({ id: 'a b', port: 80 }), /id must be/);
  assert.match(bad({ id: 'x' }), /exactly one of port or url/);
  assert.match(bad({ id: 'x', port: 80, url: 'http://a' }), /exactly one of port or url/);
  assert.match(bad({ id: 'x', port: 70000 }), /port must be/);
  assert.match(bad({ id: 'x', url: 'ftp://a' }), /http/);
  assert.match(bad({ id: 'x', port: 80, healthPath: 'health' }), /healthPath must start/);
  assert.match(bad({ id: 'x', port: 80, launch: { systemd: 'a', command: 'b' } }), /launch needs exactly one/);
  assert.match(bad({ id: 'x', port: 80, rewrite: { nope: true } }), /not a known hint/);
  assert.match(bad({ id: 'x', port: 80, rewrite: { basePath: 'ui' } }), /basePath must start/);
  assert.match(bad(null), /must be an object/);
});

test('loadApps: drops invalid and duplicate entries but keeps the good ones', () => {
  const { apps, errors } = A.loadApps([{ id: 'a', port: 1 }, { id: 'a', port: 2 }, { id: 'b' }, { id: 'c', port: 3 }], 'mac');
  assert.deepEqual(apps.map((a) => a.id), ['a', 'c']);
  assert.equal(errors.length, 2);
  assert.ok(errors.some((e) => /duplicate/.test(e)));
});

test('nextHealth: unknown → up → down → up transitions', () => {
  let h = A.nextHealth(undefined, { ok: true, latencyMs: 12 }, 100);
  assert.deepEqual([h.status, h.latencyMs, h.lastChecked, h.since], ['up', 12, 100, 100]);
  h = A.nextHealth(h, { ok: true, latencyMs: 8 }, 200);
  assert.deepEqual([h.status, h.since], ['up', 100], 'staying up keeps the original since');
  h = A.nextHealth(h, { ok: false, error: 'timeout' }, 300);
  assert.deepEqual([h.status, h.latencyMs, h.since, h.failures, h.error], ['down', null, 300, 1, 'timeout']);
  h = A.nextHealth(h, { ok: false, error: 'ECONNREFUSED' }, 400);
  assert.deepEqual([h.status, h.since, h.failures], ['down', 300, 2]);
  h = A.nextHealth(h, { ok: true, latencyMs: 5 }, 500);
  assert.deepEqual([h.status, h.since, h.failures, h.error], ['up', 500, 0, '']);
});

test('probeApp: status < 500 is up, 5xx and network errors are down, slow is a timeout', async () => {
  const app = { target: 'http://x', healthPath: '/h' };
  const reply = (status) => async (url) => { assert.equal(url, 'http://x/h'); return { status }; };
  assert.equal((await A.probeApp(app, { fetchImpl: reply(200) })).ok, true);
  assert.equal((await A.probeApp(app, { fetchImpl: reply(401) })).ok, true);
  assert.deepEqual(await A.probeApp(app, { fetchImpl: reply(503) }), { ok: false, error: 'HTTP 503' });
  const refused = async () => { throw Object.assign(new Error('fetch failed'), { cause: { code: 'ECONNREFUSED' } }); };
  assert.deepEqual(await A.probeApp(app, { fetchImpl: refused }), { ok: false, error: 'ECONNREFUSED' });
  // AbortSignal.timeout timers are unref'd (a real socket keeps the loop alive); hold it open here.
  const hang = (_u, { signal }) => new Promise((_, rej) => { const keep = setTimeout(() => {}, 1000); signal.addEventListener('abort', () => { clearTimeout(keep); rej(signal.reason); }); });
  assert.deepEqual(await A.probeApp(app, { fetchImpl: hang, timeoutMs: 30 }), { ok: false, error: 'timeout' });
});

test('checkAll + localApps: unknown before the first probe, then follows the real app up and down', async () => {
  let status = 200;
  const srv = http.createServer((req, res) => { res.statusCode = req.url === '/health' ? status : 404; res.end('ok'); });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;
  const cfg = loadConfig();
  cfg.apps = [{ id: 'demo', name: 'Demo', port, healthPath: '/health' }, { id: 'broken' }];
  saveConfig(cfg);
  A.resetAppsState();
  try {
    let local = A.localApps();
    assert.equal(local.apps.length, 1);
    assert.equal(local.errors.length, 1);
    assert.equal(local.apps[0].health.status, 'unknown');
    await A.checkAll();
    assert.equal(A.localApps().apps[0].health.status, 'up');
    assert.ok(A.localApps().apps[0].health.latencyMs >= 0);
    status = 500;
    await A.checkAll();
    assert.equal(A.localApps().apps[0].health.status, 'down');
    await new Promise((r) => srv.close(r));
    await A.checkAll();
    assert.equal(A.localApps().apps[0].health.status, 'down');
    assert.equal(A.localApps().apps[0].health.failures, 2);
  } finally {
    srv.close();
  }
});

test('aggregateApps: tags node, sorts, and reports failing peers', () => {
  const res = A.aggregateApps([
    { node: { id: 'n2', name: 'magix' }, apps: [{ id: 'szuf', health: { status: 'up' } }] },
    { node: { id: 'n1', name: 'mac' }, apps: [{ id: 'b' }, { id: 'a' }] },
    { node: { id: 'n3', name: 'win' }, error: 'HTTP 503' },
  ]);
  assert.deepEqual(res.apps.map((a) => `${a.node}/${a.id}`), ['mac/a', 'mac/b', 'magix/szuf']);
  assert.equal(res.apps[2].nodeId, 'n2');
  assert.deepEqual(res.errors, [{ node: 'win', error: 'HTTP 503' }]);
});

test('resolveApp: local by name/self, peers from the mesh catalog, null when unknown', () => {
  const cfg = loadConfig();
  cfg.apps = [{ id: 'demo', port: 9 }];
  saveConfig(cfg);
  A.resetAppsState();
  assert.equal(A.resolveApp('self', 'demo').local, true);
  assert.equal(A.resolveApp('MAC', 'DEMO').app.target, 'http://127.0.0.1:9');
  assert.equal(A.resolveApp('magix', 'szuf'), null, 'peer unknown before aggregation');
  A.setMeshCatalog([{ id: 'szuf', node: 'magix', nodeId: 'n2', target: 'http://100.82.152.1:8787', health: { status: 'up' } }]);
  const r = A.resolveApp('magix', 'szuf');
  assert.equal(r.local, false);
  assert.equal(r.nodeId, 'n2');
  assert.equal(A.resolveApp('n2', 'szuf').node, 'magix');
  assert.equal(A.resolveApp('magix', 'nope'), null);
});

test('declaredApps: a hand edit of config.json is picked up without restarting', async () => {
  const { CONFIG_FILE, config } = await import('../src/config.js');
  const cfg = loadConfig();
  cfg.apps = [{ id: 'one', port: 1 }];
  saveConfig(cfg);
  A.resetAppsState();
  assert.deepEqual(A.loadApps().apps.map((a) => a.id), ['one']);
  const disk = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  disk.apps.push({ id: 'two', port: 2 });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(disk));
  const later = new Date(Date.now() + 5000);
  fs.utimesSync(CONFIG_FILE, later, later);
  assert.deepEqual(A.loadApps().apps.map((a) => a.id), ['one', 'two']);
  assert.equal(config().apps.length, 2, 'in-memory config follows so saveConfig does not revert the edit');
});

test('onAppsChange: fires when an app is added or flips up/down, not on unchanged probes', async () => {
  const srv = http.createServer((q, r) => r.end('ok'));
  await new Promise((ok) => srv.listen(0, '127.0.0.1', ok));
  const cfg = loadConfig();
  cfg.apps = [{ id: 'live', port: srv.address().port }];
  saveConfig(cfg);
  A.resetAppsState();
  const seen = [];
  const off = A.onAppsChange((r) => seen.push(r.apps.map((a) => `${a.id}:${a.health.status}`).join(',')));
  await A.checkAll();
  await A.checkAll();
  await new Promise((ok) => srv.close(ok));
  await A.checkAll({ timeoutMs: 500 });
  off();
  assert.deepEqual(seen, ['live:up', 'live:down']);
});

test('appResponseHeaders: drops frame blockers, keeps redirects and cookies under the proxy base', async () => {
  const { appResponseHeaders } = await import('../src/proxy.js');
  const base = '/api/nodes/magix/apps/krea';
  const out = appResponseHeaders({
    'x-frame-options': 'DENY', 'content-security-policy': "default-src 'self'; frame-ancestors 'none'", connection: 'close',
    location: '/login', 'set-cookie': ['sid=1; Path=/; HttpOnly'], 'content-type': 'text/html',
  }, base);
  assert.equal(out['x-frame-options'], undefined);
  assert.equal(out.connection, undefined);
  assert.equal(out['content-security-policy'], "default-src 'self'");
  assert.equal(out.location, base + '/login');
  assert.deepEqual(out['set-cookie'], [`sid=1; Path=${base}/; HttpOnly`]);
  assert.equal(appResponseHeaders({ location: 'https://x.y/z' }, base).location, 'https://x.y/z');
  assert.equal(appResponseHeaders({ location: base + '/a' }, base).location, base + '/a');
});

test('forwardApp: streams method, path, query and body to the app; 502 when it is down', async () => {
  const { forwardApp } = await import('../src/proxy.js');
  const app = http.createServer((q, r) => {
    let b = '';
    q.on('data', (d) => { b += d; });
    q.on('end', () => r.end(JSON.stringify({ m: q.method, u: q.url, b, prefix: q.headers['x-forwarded-prefix'], tok: q.headers['x-rigs-token'] || null })));
  });
  await new Promise((ok) => app.listen(0, '127.0.0.1', ok));
  const target = { id: 'k', name: 'K', node: 'mac', target: `http://127.0.0.1:${app.address().port}` };
  const gw = http.createServer((q, r) => forwardApp(target, q, r, q.url.slice(1), '/api/local/apps/k'));
  await new Promise((ok) => gw.listen(0, '127.0.0.1', ok));
  const url = `http://127.0.0.1:${gw.address().port}`;
  const r = await fetch(url + '/api/generate?x=1', { method: 'POST', body: 'hi', headers: { 'x-rigs-token': 'secret' } });
  assert.deepEqual(await r.json(), { m: 'POST', u: '/api/generate?x=1', b: 'hi', prefix: '/api/local/apps/k', tok: null });
  await new Promise((ok) => app.close(ok));
  const down = await fetch(url + '/');
  assert.equal(down.status, 502);
  assert.match(await down.text(), /K on mac is not answering/);
  await new Promise((ok) => gw.close(ok));
});
