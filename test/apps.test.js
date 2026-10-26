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

test('startApp: a resident systemd app (keepAlive, or JARVIS\'s voice) is enabled with --now so it starts at boot; a failed enable falls back to start', async () => {
  const cfg = loadConfig();
  cfg.persona = { ...cfg.persona, neural: true, voiceApp: undefined, hearingApp: undefined };
  cfg.apps = [
    { id: 'resident', port: 9, keepAlive: true, launch: { systemd: 'resident.service' } },
    { id: 'jarvis-voice', port: 9, launch: { systemd: 'jarvis-voice.service' } }, // no flag: persona.voiceApp makes it resident anyway
    { id: 'plain', port: 9, launch: { systemd: 'plain.service' } },
  ];
  saveConfig(cfg);
  A.resetAppsState();
  assert.equal(A.isKeepAlive('resident'), true);
  assert.equal(A.isKeepAlive('Jarvis-Voice'), true);
  assert.equal(A.isKeepAlive('plain'), false);
  assert.equal(A.isKeepAlive('jarvis-voice', { persona: { neural: false, hearingApp: 'other/ears' } }), false, 'no neural voice and a different hearing app: nothing makes it resident');
  assert.equal(A.isKeepAlive('ears', { apps: [], persona: { hearingApp: 'other/ears' } }), true);
  const calls = [];
  let enableFails = false;
  const deps = {
    probe: async () => (calls.length ? { ok: true, latencyMs: 1 } : { ok: false, error: 'ECONNREFUSED' }),
    run: async (cmd, args) => { calls.push([cmd, ...args].join(' ')); return { code: enableFails && args[1] === 'enable' ? 1 : 0, stdout: '', stderr: '' }; },
    sleep: () => new Promise((ok) => setTimeout(ok, 5)),
    track: () => {},
    platform: 'linux',
  };
  await A.startApp('resident', { deps, pollMs: 5, waitMs: 2000 });
  assert.deepEqual(calls, ['systemctl --user enable --now resident.service']);
  calls.length = 0;
  await A.startApp('jarvis-voice', { deps, pollMs: 5, waitMs: 2000 });
  assert.deepEqual(calls, ['systemctl --user enable --now jarvis-voice.service']);
  calls.length = 0;
  await A.startApp('plain', { deps, pollMs: 5, waitMs: 2000 });
  assert.deepEqual(calls, ['systemctl --user start plain.service']);
  calls.length = 0;
  enableFails = true;
  await A.startApp('resident', { deps, pollMs: 5, waitMs: 2000 });
  assert.deepEqual(calls, ['systemctl --user enable --now resident.service', 'systemctl --user start resident.service']);
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
  await assert.rejects(A.startApp('cmd', { deps, pollMs: 5, waitMs: 40 }), /did not answer \/ within 0s \(last try: ECONNREFUSED\)/, 'the error says how the last probe failed');
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

// ---------------------------------------------------------------- reliability: slow starts, backoff, opensFor

test('validateApp: startupGraceMs (5 s – 15 min) and opensFor { workspace, keywords, path? } are validated and kept', () => {
  const ok = A.validateApp({ id: 'bm', port: 8600, startupGraceMs: 300000, opensFor: { workspace: ' body_matching_implementation ', keywords: [' Train', 'epoch', 'train', ''], path: '/training' } });
  assert.deepEqual(ok.errors, []);
  assert.equal(ok.app.startupGraceMs, 300000);
  assert.deepEqual(ok.app.opensFor, { workspace: 'body_matching_implementation', keywords: ['train', 'epoch'], path: '/training' });
  const noPath = A.validateApp({ id: 'bm', port: 8600, opensFor: { workspace: 'w', keywords: ['x'] } });
  assert.deepEqual(noPath.app.opensFor, { workspace: 'w', keywords: ['x'] });
  assert.equal('startupGraceMs' in A.validateApp({ id: 'bm', port: 8600 }).app, false, 'absent when not declared (the default applies)');
  const bad = (patch) => A.validateApp({ id: 'bm', port: 8600, ...patch }).errors.join('; ');
  assert.match(bad({ startupGraceMs: 1000 }), /startupGraceMs must be a number of milliseconds between 5000 and 900000/);
  assert.match(bad({ startupGraceMs: 'soon' }), /startupGraceMs must be/);
  assert.match(bad({ startupGraceMs: 900001 }), /startupGraceMs must be/);
  assert.match(bad({ opensFor: 'training' }), /opensFor must be an object/);
  assert.match(bad({ opensFor: { keywords: ['x'] } }), /opensFor\.workspace must be text/);
  assert.match(bad({ opensFor: { workspace: 'w', keywords: 'train' } }), /opensFor\.keywords must be an array/);
  assert.match(bad({ opensFor: { workspace: 'w', keywords: [' '] } }), /at least one word/);
  assert.match(bad({ opensFor: { workspace: 'w', keywords: Array.from({ length: 13 }, (_, i) => `k${i}`) } }), /at most 12 words/);
  assert.match(bad({ opensFor: { workspace: 'w', keywords: ['x'.repeat(41)] } }), /at most 40 characters/);
  assert.match(bad({ opensFor: { workspace: 'w', keywords: ['x'], path: 'training' } }), /opensFor\.path must start with \//);
  // The field survives registration and shows in the catalog (the planner reads it from there).
  const cfg = loadConfig();
  cfg.apps = [{ id: 'bm', port: 8600, startupGraceMs: 300000, opensFor: { workspace: 'body_matching_implementation', keywords: ['train'], path: '/training' } }];
  saveConfig(cfg);
  A.resetAppsState();
  const listed = A.localApps().apps.find((a) => a.id === 'bm');
  assert.deepEqual(listed.opensFor, { workspace: 'body_matching_implementation', keywords: ['train'], path: '/training' });
  assert.equal(listed.startupGraceMs, 300000);
});

test('startApp: a slow app answers pending after pendingAfterMs; the probe loop goes on until its startupGraceMs and the apps event says when it is up', async () => {
  const cfg = loadConfig();
  cfg.apps = [{ id: 'slow', name: 'Body Matching', port: 9, healthPath: '/healthz', launch: { command: 'python api.py' }, startupGraceMs: 300000 }];
  saveConfig(cfg);
  A.resetAppsState();
  let probes = 0;
  let upAfter = 8; // the app answers on the 8th probe after the launch
  let t = 0; // injected clock: every poll is "a second" later
  const spawned = [];
  const deps = {
    probe: async () => (++probes > upAfter ? { ok: true, latencyMs: 2 } : { ok: false, error: 'ECONNREFUSED' }),
    spawn: (command) => { spawned.push(command); return { unref() {}, on() {} }; },
    sleep: () => { t += 1000; return new Promise((ok) => setTimeout(ok, 4)); },
    now: () => t,
    platform: 'linux',
  };
  const seen = [];
  const off = A.onAppsChange((r) => seen.push(r.apps.find((a) => a.id === 'slow').health.status));
  const r = await A.startApp('slow', { deps, pollMs: 1, pendingAfterMs: 10 });
  assert.deepEqual([r.started, r.pending, r.health.status], [true, true, 'down'], JSON.stringify(r));
  assert.deepEqual(spawned, ['python api.py']);
  assert.ok(A.isStarting('slow'), 'the background loop is still probing');
  // A second start while one is in flight joins it instead of launching again.
  const again = await A.startApp('slow', { deps, pollMs: 1, pendingAfterMs: 10 });
  assert.equal(again.pending, true);
  assert.equal(spawned.length, 1);
  for (let i = 0; i < 200 && A.isStarting('slow'); i++) await new Promise((ok) => setTimeout(ok, 5));
  assert.equal(A.isStarting('slow'), false);
  assert.equal(A.localApps().apps[0].health.status, 'up');
  assert.deepEqual(seen, ['down', 'up'], 'the apps event fired when it came up (the UI reloads the window on it)');
  assert.ok(t <= 10000, `came up after ${t / 1000} s of polling, within its grace`);
  off();
  // Never answering: the loop ends at the app's startupGraceMs (300 s here, not the old fixed 60 s) and records why.
  A.resetAppsState();
  probes = 0; upAfter = Infinity; t = 0; spawned.length = 0;
  const r2 = await A.startApp('slow', { deps, pollMs: 1, pendingAfterMs: 10 });
  assert.equal(r2.pending, true);
  for (let i = 0; i < 2000 && A.isStarting('slow'); i++) await new Promise((ok) => setTimeout(ok, 5));
  assert.equal(A.isStarting('slow'), false);
  const h = A.localApps().apps[0].health;
  assert.equal(h.status, 'down');
  assert.match(h.error, /Body Matching was started but did not answer \/healthz within 300s/);
  assert.ok(t >= 300000, `polled for the whole grace (${t / 1000} s)`);
  // Awaited without a pending cut-off (the old behaviour): the 504 is the rejection.
  A.resetAppsState();
  probes = 0; t = 0;
  await assert.rejects(A.startApp('slow', { deps, pollMs: 1, pendingAfterMs: Infinity, waitMs: 5000 }), /did not answer \/healthz within 5s/);
});

test('startAppAsync: answers as soon as the launch was issued; already up is a no-op; launch errors still throw', async () => {
  const cfg = loadConfig();
  cfg.apps = [{ id: 'svc2', port: 9, launch: { systemd: 'svc2.service' } }, { id: 'bare2', port: 9 }];
  saveConfig(cfg);
  A.resetAppsState();
  let up = false;
  const calls = [];
  const deps = {
    probe: async () => (up ? { ok: true, latencyMs: 1 } : { ok: false, error: 'ECONNREFUSED' }),
    run: async (cmd, args) => { calls.push([cmd, ...args].join(' ')); setTimeout(() => { up = true; }, 20); return { code: 0, stdout: '', stderr: '' }; },
    sleep: () => new Promise((ok) => setTimeout(ok, 5)),
    platform: 'linux',
  };
  const seen = [];
  const off = A.onAppsChange((r) => seen.push(r.apps.find((a) => a.id === 'svc2').health.status));
  const r = await A.startAppAsync('svc2', { deps, pollMs: 1 });
  assert.deepEqual([r.started, r.pending], [true, true]);
  assert.deepEqual(calls, ['systemctl --user start svc2.service']);
  assert.equal(up, false, 'answered before the app was up');
  for (let i = 0; i < 200 && A.isStarting('svc2'); i++) await new Promise((ok) => setTimeout(ok, 5));
  assert.equal(A.localApps().apps.find((a) => a.id === 'svc2').health.status, 'up');
  assert.ok(seen.includes('up'));
  off();
  const noop = await A.startAppAsync('svc2', { deps });
  assert.equal(noop.started, false);
  assert.equal(calls.length, 1);
  // startApp({ mode: 'async' }) is the same entry point (server.js switches the route with it).
  up = false;
  const viaMode = await A.startApp('svc2', { mode: 'async', deps, pollMs: 1 });
  assert.equal(viaMode.pending, true);
  for (let i = 0; i < 200 && A.isStarting('svc2'); i++) await new Promise((ok) => setTimeout(ok, 5));
  up = false;
  await assert.rejects(A.startAppAsync('bare2', { deps }), /no launch recipe/);
  await assert.rejects(A.startAppAsync('nope', { deps }), /unknown app/);
});

test('health checks back off per app: a dead app is probed at 5, 10, 20, 40, 60 s (cap); answering or startApp resets it', async () => {
  const cfg = loadConfig();
  cfg.apps = [{ id: 'dead', port: 9 }, { id: 'fine', port: 9 }];
  saveConfig(cfg);
  A.resetAppsState();
  let t = 0;
  const now = () => t;
  const opts = { now, baseMs: 5000, maxMs: 60000, fetchImpl: async () => { throw Object.assign(new Error('fetch failed'), { cause: { code: 'ECONNREFUSED' } }); } };
  assert.deepEqual((await A.checkDue(opts)).sort(), ['dead', 'fine'], 'never probed: both due');
  assert.deepEqual([A.backoffFor('dead'), A.backoffFor('fine')], [5000, 5000]);
  t = 4999;
  assert.deepEqual(await A.checkDue(opts), [], 'nothing due yet');
  const gaps = [];
  for (const at of [5000, 15000, 35000, 75000, 135000, 195000]) { t = at; await A.checkDue(opts); gaps.push(A.backoffFor('dead')); }
  assert.deepEqual(gaps, [10000, 20000, 40000, 60000, 60000, 60000], 'doubles to the 60 s cap and stays there');
  // Between those, a tick finds nothing due: a dead app no longer costs a request every 5 s.
  t = 140000;
  assert.deepEqual(await A.checkDue(opts), []);
  // It answers → back to the base interval.
  t = 255000;
  assert.deepEqual(await A.checkDue({ ...opts, fetchImpl: async () => ({ status: 200 }) }), ['dead', 'fine']);
  assert.equal(A.backoffFor('dead'), 5000);
  assert.equal(A.localApps().apps.find((a) => a.id === 'dead').health.status, 'up');
  // Down again twice → 10 s gap; a start request resets it so the next tick looks at once.
  t = 260000; await A.checkDue(opts);
  t = 265000; await A.checkDue(opts);
  assert.equal(A.backoffFor('dead'), 10000);
  A.resetBackoff('dead');
  assert.equal(A.backoffFor('dead'), 0);
  t = 265001;
  assert.deepEqual(await A.checkDue(opts), ['dead'], 'probed at once after the reset, the other app waits its turn');
  // checkAll (a manual sweep) probes everything and re-plans from the results.
  t = 270000;
  await A.checkAll({ ...opts, fetchImpl: async () => ({ status: 200 }) });
  assert.deepEqual([A.backoffFor('dead'), A.backoffFor('fine')], [5000, 5000]);
});
