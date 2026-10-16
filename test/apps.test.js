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
