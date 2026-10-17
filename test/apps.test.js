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
  assert.match(bad({ id: 'x', port: 80, launch: {} }), /launch needs systemd \(unit name\), command, or a per-OS recipe/);
  assert.match(bad({ id: 'x', port: 80, launch: { systemd: 'bad unit' } }), /launch.systemd is not a valid unit name/);
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


test('startApp: already up is a no-op; systemd unit is started and awaited; no recipe is a clear error', async () => {
  const cfg = loadConfig();
  cfg.apps = [
    { id: 'svc', port: 9, launch: { systemd: 'svc.service' } },
    { id: 'bare', port: 9 },
  ];
  saveConfig(cfg);
  A.resetAppsState();
  const calls = [];
  let up = false;
  const deps = {
    probe: async () => (up ? { ok: true, latencyMs: 1 } : { ok: false, error: 'ECONNREFUSED' }),
    run: async (cmd, args) => { calls.push([cmd, ...args].join(' ')); setTimeout(() => { up = true; }, 5); return { code: 0, stdout: '', stderr: '' }; },
    sleep: (ms) => new Promise((ok) => setTimeout(ok, 10)),
    platform: 'linux', // systemd units are Linux-only
  };
  const r = await A.startApp('svc', { deps, pollMs: 10, waitMs: 2000 });
  assert.equal(r.started, true);
  assert.equal(r.health.status, 'up');
  assert.deepEqual(calls, ['systemctl --user start svc.service']);
  const again = await A.startApp('svc', { deps });
  assert.equal(again.started, false);
  assert.equal(calls.length, 1);
  up = false;
  await assert.rejects(A.startApp('bare', { deps }), /no launch recipe/);
  await assert.rejects(A.startApp('nope', { deps }), /unknown app/);
});

test('startApp: command recipe spawns detached and times out if the app never answers', async () => {
  const cfg = loadConfig();
  cfg.apps = [{ id: 'cmd', port: 9, launch: { command: 'python3 -m http.server 9' } }];
  saveConfig(cfg);
  A.resetAppsState();
  const spawned = [];
  const deps = {
    probe: async () => ({ ok: false, error: 'ECONNREFUSED' }),
    spawn: (command, opts) => { spawned.push([command, opts.detached]); return { unref() {}, on() {} }; },
    sleep: () => new Promise((ok) => setTimeout(ok, 5)),
    platform: 'linux',
  };
  await assert.rejects(A.startApp('cmd', { deps, pollMs: 5, waitMs: 40 }), /did not answer \/ within/);
  assert.deepEqual(spawned, [['python3 -m http.server 9', true]]);
});

// ---------------------------------------------------------------- per-OS launch recipes

test('launch recipe: old shapes validate and normalize exactly as before', () => {
  assert.deepEqual(A.validateApp({ id: 'a', port: 1, launch: { systemd: 'a.service' } }).app.launch, { systemd: 'a.service' });
  assert.deepEqual(A.validateApp({ id: 'b', port: 1, launch: { command: 'node server.js' } }).app.launch, { command: 'node server.js' });
  assert.equal(A.validateApp({ id: 'c', port: 1 }).app.launch, null);
});

test('launch recipe: per-OS entries beside the systemd unit, with cwd/env, aliases and string shorthand', () => {
  const { app, errors } = A.validateApp({ id: 'x', port: 1, launch: {
    systemd: 'x.service', command: 'x-serve', cwd: '~/x', env: { PORT: 8080 },
    win32: { command: 'x.cmd --port 1', cwd: '~\\x', env: { DEBUG: true } },
    mac: 'x-mac',
  } });
  assert.deepEqual(errors, []);
  assert.deepEqual(app.launch, {
    systemd: 'x.service', command: 'x-serve', cwd: '~/x', env: { PORT: '8080' },
    darwin: { command: 'x-mac' },
    windows: { command: 'x.cmd --port 1', cwd: '~\\x', env: { DEBUG: 'true' } },
  });
  const perOsOnly = A.validateApp({ id: 'y', port: 1, launch: { windows: { command: 'y.exe' } } });
  assert.deepEqual(perOsOnly.app.launch, { windows: { command: 'y.exe' } });
  assert.deepEqual(A.validateApp({ id: 'z', port: 1, launch: { linux: { systemd: 'z.service' } } }).app.launch, { linux: { systemd: 'z.service' } });
});

test('launch recipe: invalid per-OS entries are rejected with readable errors', () => {
  const bad = (launch) => A.validateApp({ id: 'x', port: 1, launch }).errors.join(' | ');
  assert.match(bad({ windows: { systemd: 'x.service' } }), /launch.windows.systemd is Linux only/);
  assert.match(bad({ darwin: {} }), /launch.darwin needs a command/);
  assert.match(bad({ linux: { systemd: 'a', command: 'b' } }), /launch.linux needs exactly one of systemd/);
  assert.match(bad({ windows: { command: 'x', env: { 'BAD-NAME': '1' } } }), /launch.windows.env.BAD-NAME is not a valid variable name/);
  assert.match(bad({ windows: { command: 'x' }, win32: { command: 'y' } }), /repeats launch.windows/);
  assert.match(bad({ command: 'x', cwd: 5 }), /launch.cwd must be a path/);
  assert.match(bad('node x'), /launch must be an object/);
});

test('launchFor: picks the recipe per platform (linux, darwin, win32)', () => {
  const both = { systemd: 'x.service', command: 'x-serve', windows: { command: 'x.cmd', cwd: 'C:\\x' } };
  assert.deepEqual(A.launchFor(both, 'linux'), { systemd: 'x.service' });
  assert.deepEqual(A.launchFor(both, 'darwin'), { command: 'x-serve', cwd: '', env: {} });
  assert.deepEqual(A.launchFor(both, 'win32'), { command: 'x.cmd', cwd: 'C:\\x', env: {} });
  // A systemd-only app has nothing to run off Linux; a command-only app runs everywhere.
  assert.equal(A.launchFor({ systemd: 'x.service' }, 'win32'), null);
  assert.equal(A.launchFor({ systemd: 'x.service' }, 'darwin'), null);
  for (const p of ['linux', 'darwin', 'win32']) assert.deepEqual(A.launchFor({ command: 'go' }, p), { command: 'go', cwd: '', env: {} });
  // A per-OS linux entry replaces the top-level unit there.
  assert.deepEqual(A.launchFor({ systemd: 'x.service', linux: { command: 'x-linux' } }, 'linux'), { command: 'x-linux', cwd: '', env: {} });
  assert.equal(A.launchFor(null, 'linux'), null);
  // localApps exposes the recipe this node runs.
  assert.deepEqual(A.validateApp({ id: 'h', port: 1, launch: { command: 'go' } }).app.launchHere, { command: 'go', cwd: '', env: {} });
});

test('splitWinCommand: Windows command-line quoting', () => {
  assert.deepEqual(A.splitWinCommand('"C:\\Program Files\\nodejs\\node.exe" "C:\\Users\\me\\.rigs\\apps\\x\\launch.mjs"'), ['C:\\Program Files\\nodejs\\node.exe', 'C:\\Users\\me\\.rigs\\apps\\x\\launch.mjs']);
  assert.deepEqual(A.splitWinCommand('python  -m http.server 9'), ['python', '-m', 'http.server', '9']);
  assert.deepEqual(A.splitWinCommand('x "" "a ""b"" c" d\\e'), ['x', '', 'a "b" c', 'd\\e']);
});

test('commandPlan: shell on POSIX; on win32 argv + PATH lookup for spawnCmd, cmd.exe only for cmd syntax', () => {
  const posix = A.commandPlan({ command: 'python3 -m http.server 9', cwd: '~/app', env: { A: '1' } }, { platform: 'linux', home: '/home/me', shellEnv: '/bin/zsh' });
  assert.deepEqual(posix, { cmd: 'python3 -m http.server 9', args: [], shell: '/bin/zsh', cwd: '/home/me/app', env: { A: '1' } });
  assert.equal(A.commandPlan({ command: 'x' }, { platform: 'darwin', home: '/Users/me', shellEnv: '' }).shell, '/bin/sh');

  const looked = [];
  const which = (n) => { looked.push(n); return n === 'serve' ? 'C:\\Users\\me\\AppData\\Roaming\\npm\\serve.cmd' : null; };
  const win = A.commandPlan({ command: 'serve -l 8080 ~\\site', cwd: '~\\apps' }, { platform: 'win32', home: 'C:\\Users\\me', which });
  assert.deepEqual(win, { cmd: 'C:\\Users\\me\\AppData\\Roaming\\npm\\serve.cmd', args: ['-l', '8080', 'C:\\Users\\me\\site'], shell: false, cwd: 'C:\\Users\\me\\apps', env: {} });
  assert.deepEqual(looked, ['serve']);
  const rel = A.commandPlan({ command: '.\\run.ps1 --fast', cwd: 'D:\\app' }, { platform: 'win32', home: 'C:\\Users\\me', which });
  assert.deepEqual([rel.cmd, rel.args, rel.shell], ['D:\\app\\run.ps1', ['--fast'], false]);
  const cmdSyntax = A.commandPlan({ command: 'set X=1 && node server.js' }, { platform: 'win32', home: 'C:\\Users\\me', which });
  assert.deepEqual([cmdSyntax.cmd, cmdSyntax.shell, cmdSyntax.cwd], ['set X=1 && node server.js', true, 'C:\\Users\\me']);
});

test('startApp on win32: the windows command goes through spawnCmd — no systemctl, no POSIX shell', async () => {
  const cfg = loadConfig();
  cfg.apps = [{ id: 'dual', port: 9, launch: { systemd: 'dual.service', windows: { command: 'dual-serve --port 9', env: { DUAL: '1' } } } }];
  saveConfig(cfg);
  A.resetAppsState();
  const calls = [];
  let up = false;
  const deps = {
    platform: 'win32',
    probe: async () => (up ? { ok: true, latencyMs: 1 } : { ok: false, error: 'ECONNREFUSED' }),
    run: async (cmd, args) => { calls.push(['run', cmd, ...args]); return { code: 0, stdout: '', stderr: '' }; },
    spawn: (cmd) => { calls.push(['spawn', cmd]); return { unref() {}, on() {} }; },
    which: (n) => (n === 'dual-serve' ? 'C:\\tools\\dual-serve.cmd' : null),
    spawnCmd: (cmd, args, opts) => {
      calls.push(['spawnCmd', cmd, ...args]);
      assert.equal(opts.detached, true);
      assert.equal(opts.windowsHide, true);
      assert.equal(opts.shell, undefined);
      assert.equal(opts.env.DUAL, '1');
      assert.ok(opts.env.PATH);
      setTimeout(() => { up = true; }, 5);
      return { unref() {}, on() {} };
    },
    sleep: () => new Promise((ok) => setTimeout(ok, 5)),
  };
  const r = await A.startApp('dual', { deps, pollMs: 5, waitMs: 2000 });
  assert.equal(r.started, true);
  assert.deepEqual(calls, [['spawnCmd', 'C:\\tools\\dual-serve.cmd', '--port', '9']]);

  // The same app on Linux uses its systemd unit.
  up = false;
  calls.length = 0;
  deps.platform = 'linux';
  deps.run = async (cmd, args) => { calls.push(['run', cmd, ...args]); setTimeout(() => { up = true; }, 5); return { code: 0, stdout: '', stderr: '' }; };
  await A.startApp('dual', { deps, pollMs: 5, waitMs: 2000 });
  assert.deepEqual(calls, [['run', 'systemctl', '--user', 'start', 'dual.service']]);

  // On macOS it has no recipe: a clear error that says which OS key to add.
  up = false;
  deps.platform = 'darwin';
  await assert.rejects(A.startApp('dual', { deps }), /no launch recipe for darwin \(add "launch": \{ "darwin"/);
});
