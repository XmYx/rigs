// Navigation applet in the app store: manifest validation, the pure install plan per platform (no venv,
// no model steps, no hardcoded home), and a scratch install that starts the applet from the generated
// command and checks /healthz. Everything lives in temp dirs; the real ~/.config/systemd and ~/.rigs
// are never touched.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rigs-nav-store-'));
process.env.RIGS_HOME = path.join(tmp, 'rigs');
process.env.RIGS_NO_OPENRIG = '1';
process.env.RIGS_NO_MIGRATIONS = '1';
process.env.RIGS_NO_AUTOUPDATE = '1';
const { validateManifest, installPlan, needsVenvOrModels, fill } = await import('../src/store.js');
const { validateApp } = await import('../src/apps.js');

const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'applets/navigation/store.json'), 'utf8'));
const unitTemplate = fs.readFileSync(path.join(ROOT, manifest.launch.linux.systemd.template), 'utf8');
const planFor = (platform, extra = {}) => installPlan(manifest, {
  platform, installDir: platform === 'win32' ? 'C:\\Users\\sam\\.rigs\\app' : '/opt/rigs/app',
  rigsHome: platform === 'win32' ? 'C:\\Users\\sam\\.rigs' : '/srv/sam/.rigs', nodePath: platform === 'win32' ? 'C:\\node\\node.exe' : '/usr/local/bin/node',
  home: '/srv/sam', unitTemplate, ...extra,
});

test('store manifest: valid, explicit about no venv and no models, optional secret TomTom key', () => {
  assert.deepEqual(validateManifest(manifest), []);
  assert.equal(manifest.id, 'navigation');
  assert.equal(manifest.port, 8731);
  assert.equal(manifest.healthPath, 'healthz');
  assert.equal(manifest.python, null);
  assert.equal(manifest.venv, false);
  assert.deepEqual(manifest.models, []);
  assert.equal(manifest.requirements.gpu, false);
  assert.equal(manifest.runtime.node, '>=22');
  assert.deepEqual(manifest.settings.map((s) => [s.key, s.secret, s.optional]), [['NAV_TOMTOM_KEY', true, true]]);
  assert.equal(needsVenvOrModels(manifest), false);
  assert.ok(fs.existsSync(path.join(ROOT, manifest.iconFile)));
});

test('store manifest: validation rejects what an installer could not act on', () => {
  assert.ok(validateManifest({ ...manifest, id: 'Bad Id' }).some((e) => /id/.test(e)));
  assert.ok(validateManifest({ ...manifest, port: 0 }).some((e) => /port/.test(e)));
  const { python, ...noPython } = manifest;
  assert.ok(validateManifest(noPython).some((e) => /python, venv and models/.test(e)));
  assert.ok(validateManifest({ ...manifest, launch: { linux: manifest.launch.linux } }).some((e) => /launch\.darwin/.test(e)));
  assert.throws(() => fill('{{NOPE}}', {}), /unknown placeholder/);
});

test('install plan linux: systemd --user unit with the real install path, no venv or model steps', () => {
  const p = planFor('linux');
  assert.equal(p.launch.kind, 'systemd');
  assert.equal(p.launch.unit, 'rigs-navigation.service');
  assert.deepEqual(p.launch.start, ['systemctl', '--user', 'enable', '--now', 'rigs-navigation.service']);
  assert.equal(p.files.length, 1);
  assert.equal(p.files[0].path, '/srv/sam/.config/systemd/user/rigs-navigation.service');
  const unit = p.files[0].content;
  assert.match(unit, /^WorkingDirectory=\/opt\/rigs\/app$/m);
  assert.match(unit, /^ExecStart=\/usr\/local\/bin\/node \/opt\/rigs\/app\/applets\/navigation\/server\.js$/m);
  assert.match(unit, /NAV_PORT=8731 NAV_HOST=127\.0\.0\.1 NAV_DATA_DIR=\/srv\/sam\/\.rigs\/navigation\/trips/);
  assert.match(unit, /^EnvironmentFile=-\/srv\/sam\/\.rigs\/navigation\/env$/m);
  assert.doesNotMatch(unit, /\{\{|\/home\/magix|%h/);
  assert.doesNotMatch(unit, /^Environment=.*NAV_TOMTOM_KEY/m);
  assert.deepEqual(p.dirs, ['/srv/sam/.rigs/navigation/trips']);
  assert.deepEqual(p.steps.filter((s) => /venv|pip|python|model|download/.test(s)), []);
  assert.deepEqual(p.uninstall, { steps: ['stop-launch', 'remove-launch', 'unregister', 'remove-data'], keepData: true, dataDir: '/srv/sam/.rigs/navigation/trips' });
});

test('install plan darwin and win32: a launch command with the real paths, no venv or model steps', () => {
  const mac = planFor('darwin');
  assert.equal(mac.launch.kind, 'command');
  assert.equal(mac.launch.command, '/usr/local/bin/node /opt/rigs/app/applets/navigation/server.js');
  assert.equal(mac.launch.cwd, '/opt/rigs/app');
  assert.deepEqual(mac.files, []);
  assert.deepEqual(mac.registration.launch, { command: mac.launch.command });
  const win = planFor('win32');
  assert.equal(win.launch.command, '"C:\\node\\node.exe" "C:\\Users\\sam\\.rigs\\app\\applets\\navigation\\server.js"');
  assert.equal(win.dirs[0], 'C:\\Users\\sam\\.rigs\\navigation\\trips');
  for (const p of [mac, win]) assert.deepEqual(p.steps.filter((s) => /venv|pip|python|model|download/.test(s)), []);
  assert.throws(() => installPlan({ ...manifest, platforms: ['linux'] }, { platform: 'darwin', installDir: '/x', rigsHome: '/y', nodePath: '/n' }), /does not support/);
});

test('registration payload passes the apps.js validation on every platform', () => {
  for (const platform of ['linux', 'darwin', 'win32']) {
    const { registration } = planFor(platform);
    const { app, errors } = validateApp(registration, 'test-node');
    assert.deepEqual(errors, [], platform);
    assert.equal(app.id, 'navigation');
    assert.equal(app.target, 'http://127.0.0.1:8731');
    assert.equal(app.healthPath, '/healthz');
  }
});

/** A command line → argv: "double-quoted" words keep their spaces, other words split on whitespace. */
const splitCommand = (line) => [...line.matchAll(/"([^"]*)"|(\S+)/g)].map((m) => m[1] ?? m[2]);

test('splitCommand: the darwin and win32 launch lines of the plan split into node + server.js', () => {
  assert.deepEqual(splitCommand(planFor('darwin').launch.command), ['/usr/local/bin/node', '/opt/rigs/app/applets/navigation/server.js']);
  assert.deepEqual(splitCommand(planFor('win32').launch.command), ['C:\\node\\node.exe', 'C:\\Users\\sam\\.rigs\\app\\applets\\navigation\\server.js']);
});

const freePort = () => new Promise((res, rej) => {
  const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => res(port)); });
  s.on('error', rej);
});

test('scratch install: generated command starts the applet, /healthz answers {ok:true}', async () => {
  const port = await freePort();
  const rigsHome = process.env.RIGS_HOME;
  // The plan for the OS this runs on (win32 quotes its paths; macOS stands in for Linux, whose plan is a systemd unit).
  const platform = process.platform === 'win32' ? 'win32' : 'darwin';
  const plan = installPlan(manifest, { platform, installDir: ROOT, rigsHome, nodePath: process.execPath, port });
  fs.mkdirSync(plan.dirs[0], { recursive: true });
  const [cmd, ...args] = splitCommand(plan.launch.command);
  assert.equal(cmd, process.execPath);
  const child = spawn(cmd, args, { cwd: plan.launch.cwd, env: { ...process.env, ...plan.env }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; });
  try {
    let body = null;
    for (let i = 0; i < 60 && !body; i++) {
      try { body = await (await fetch(`http://127.0.0.1:${port}/${manifest.healthPath}`)).json(); } catch { await new Promise((r) => setTimeout(r, 250)); }
    }
    assert.deepEqual(body, { ok: true }, out);
    assert.equal(plan.registration.port, port);
    assert.deepEqual(validateApp(plan.registration, 'test-node').errors, []);
    assert.ok(fs.existsSync(plan.dirs[0]), 'trip data dir exists under the scratch RIGS_HOME');
    assert.ok(plan.dirs[0].startsWith(tmp));
  } finally {
    child.kill();
  }
});

test('the Linux unit generated for this checkout is runnable (paths exist)', () => {
  const p = installPlan(manifest, { platform: 'linux', installDir: ROOT, rigsHome: '/tmp/x/.rigs', nodePath: process.execPath, home: '/tmp/x', unitTemplate });
  const exec = p.files[0].content.match(/^ExecStart=(\S+) (\S+)$/m);
  assert.ok(fs.existsSync(exec[1]) && fs.existsSync(exec[2]));
});
