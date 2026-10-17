// OS control on by default: fresh defaults, the one-time migration for machines on the old off defaults (a kill or a
// person's switch-off stays off), gating with the defaults on, and the first-run setup at boot. Throwaway RIGS_HOME
// and fake runners only; no real desktop, gsettings or root step is touched.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { test, after } from 'node:test';

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'rigs-control-setup-'));
process.env.RIGS_HOME = HOME;
const { config, loadConfig, saveConfig, patchConfig, CONFIG_FILE } = await import('../src/config.js');
const migrations = await import('../src/migrations.js');
const { createControl } = await import('../src/control.js');
const { controlHistory, defaultOnDecision, parseStrv, formatStrv, installGnomeExtension, ensureControlSetup, EXTENSION_UUID } = await import('../src/control-setup.js');
after(() => fs.rmSync(HOME, { recursive: true, force: true }));

const ID = '2026-10-17-control-default-on';
const OLD_OFF = { enabled: false, input: false, backend: 'auto', allowFrom: [], leaseIdleSec: 60, maxActionsPerMin: 120, maxShotsPerMin: 30, announce: 'lease', killHotkey: 'default', auditPreview: 64 };

/** A machine with this saved config and control history; then only the control migration runs. */
async function machine({ control, killed, audit } = {}) {
  for (const f of ['control-state.json', 'logs', 'migrations.json']) fs.rmSync(path.join(HOME, f), { recursive: true, force: true });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify({ name: 'test-node', ...(control ? { control } : {}) }));
  if (killed) fs.writeFileSync(path.join(HOME, 'control-state.json'), JSON.stringify({ killed }));
  if (audit) { fs.mkdirSync(path.join(HOME, 'logs')); for (const [f, lines] of Object.entries(audit)) fs.writeFileSync(path.join(HOME, 'logs', f), lines.map((l) => JSON.stringify(l)).join('\n') + '\n'); }
  loadConfig();
}
async function migrate() {
  const others = migrations.status().map((m) => m.id).filter((id) => id !== ID);
  fs.writeFileSync(path.join(HOME, 'migrations.json'), JSON.stringify(Object.fromEntries(others.map((id) => [id, { ok: true, at: 1 }]))));
  await migrations.runPending();
  const done = JSON.parse(fs.readFileSync(path.join(HOME, 'migrations.json'), 'utf8'))[ID];
  assert.equal(done.ok, true, done.error);
  return { result: done.result, saved: JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')).control };
}

const facts = { session: 'wayland', desktop: 'gnome', available: { gi: true, mutterScreenCast: 4, mutterRemoteDesktop: 1, 'gst-launch-1.0': true, rigsExtension: true }, displays: [{ id: 'DP-1', width: 1920, height: 1080, scale: 1, primary: true }], locked: false };
function stubAdapter() {
  return { events: new EventEmitter(), inspect: async () => structuredClone(facts), configure: async () => {}, stop: async () => {},
    request: async (op) => op === 'locked' ? { locked: false } : op === 'windows' ? [{ id: 'w1', title: 'Scratch' }] : {} };
}

test('a fresh config has control and input on, and a settings save cannot change control', async () => {
  await machine();
  assert.equal(config().control.enabled, true);
  assert.equal(config().control.input, true);
  patchConfig({ control: { enabled: false, input: false } });
  assert.deepEqual([config().control.enabled, config().control.input], [true, true]);
  const { result, saved } = await migrate();
  assert.equal(result.change, false, 'already on: nothing to migrate');
  assert.deepEqual([saved.enabled, saved.input], [true, true]);
});

test('the migration switches on a machine still on the old off defaults', async () => {
  await machine({ control: OLD_OFF });
  assert.equal(config().control.enabled, false);
  const { result, saved } = await migrate();
  assert.deepEqual([result.change, result.reason], [true, 'old off defaults']);
  assert.deepEqual([saved.enabled, saved.input, saved.maxActionsPerMin], [true, true, 120]);
  assert.equal(config().control.enabled, true);
});

test('the migration leaves a killed machine off, and the kill still holds in control', async () => {
  const killed = { at: '2026-10-17T10:00:00.000Z', by: { who: 'Sir' }, reason: 'hands off' };
  await machine({ control: OLD_OFF, killed });
  const { result, saved } = await migrate();
  assert.deepEqual([result.change, result.reason], [false, 'killed']);
  assert.deepEqual([saved.enabled, saved.input], [false, false]);
  const c = createControl({ platform: 'linux', home: HOME, getConfig: config, persistConfig: saveConfig, adapter: stubAdapter(), permissions: async () => ({}) });
  const st = await c.status();
  assert.deepEqual([st.enabled, st.killed?.reason], [false, 'hands off']);
});

test('the migration leaves a machine a person switched off (audit, even rotated) as it is', async () => {
  await machine({ control: OLD_OFF, audit: { 'control.jsonl.1': [{ ts: '2026-10-17T09:00:00.000Z', node: 'test-node', op: 'enable', ok: true, caller: { human: true }, args: { enabled: false, input: false } }] } });
  const { result, saved } = await migrate();
  assert.deepEqual([result.change, result.reason], [false, 'set by a person']);
  assert.equal(saved.enabled, false);
  // A refused enable, or ordinary actions, are no evidence of a person's choice.
  await machine({ control: OLD_OFF, audit: { 'control.jsonl': [{ op: 'enable', ok: false }, { op: 'screenshot', ok: true }] } });
  assert.equal((await migrate()).result.change, true);
});

test('the decision only flips the exact old defaults', () => {
  assert.equal(defaultOnDecision({ control: { enabled: true, input: false } }).change, false, 'access-only was a person\'s choice');
  assert.equal(defaultOnDecision({ control: { enabled: false, input: false }, killed: { at: 'x' } }).change, false);
  assert.equal(defaultOnDecision({ control: { enabled: false, input: false }, touched: true }).change, false);
  assert.equal(defaultOnDecision({ control: { enabled: false, input: false } }).change, true);
  assert.deepEqual(controlHistory(path.join(HOME, 'missing')), { killed: null, touched: false });
});

test('gating with the defaults on: agents act and may kill but never re-enable; the kill survives a restart', async () => {
  await machine();
  const alice = { from: 'macbookpro', agent: 'codex', session: 's1' };
  const make = () => createControl({ platform: 'linux', home: HOME, getConfig: config, persistConfig: saveConfig, adapter: stubAdapter(), permissions: async () => ({}) });
  const c = make();
  assert.deepEqual(await c.listWindows(alice), [{ id: 'w1', title: 'Scratch' }]);
  await c.kill({ reason: 'stop' }, alice);
  await assert.rejects(c.listWindows(alice), { code: 'off' });
  await assert.rejects(c.enable({ enabled: true, input: true, confirm: 'test-node' }, alice), { code: 'not-allowed' });
  await assert.rejects(c.enable({ enabled: true, input: true, confirm: 'test-node' }, { human: true, via: 'mcp' }), { code: 'not-allowed' });
  // Restart and update: reload config from disk, then even a hand edit back to on cannot undo the kill marker.
  loadConfig();
  assert.equal(config().control.enabled, false);
  config().control.enabled = true; config().control.input = true;
  const restarted = make();
  assert.equal((await restarted.status()).killed.reason, 'stop');
  await assert.rejects(restarted.listWindows(alice), { code: 'off' });
  await c.kill({}, alice); await restarted.kill({}, alice);
});

test('GNOME extension: installed for the user and added to enabled-extensions without dropping others', async () => {
  const home = fs.mkdtempSync(path.join(HOME, 'home-'));
  const calls = [];
  let list = "['ding@rastersoft.com', 'ubuntu-dock@ubuntu.com']\n";
  const runner = async (cmd, args) => {
    calls.push([cmd, ...args]);
    if (cmd === 'gsettings' && args[0] === 'get') return { code: 0, stdout: list, stderr: '' };
    if (cmd === 'gnome-extensions') return { code: 2, stdout: '', stderr: `Extension “${EXTENSION_UUID}” does not exist` };
    return { code: 0, stdout: '', stderr: '' };
  };
  const r = await installGnomeExtension({ home, runner, env: {} });
  const dst = path.join(home, '.local/share/gnome-shell/extensions', EXTENSION_UUID);
  assert.ok(fs.existsSync(path.join(dst, 'extension.js')) && fs.existsSync(path.join(dst, 'metadata.json')));
  assert.deepEqual([r.copied, r.enabled, r.relogin], [true, true, true]);
  assert.deepEqual(calls.at(-1), ['gsettings', 'set', 'org.gnome.shell', 'enabled-extensions', `['ding@rastersoft.com', 'ubuntu-dock@ubuntu.com', '${EXTENSION_UUID}']`]);

  calls.length = 0; list = formatStrv(['ding@rastersoft.com', EXTENSION_UUID]);
  const again = await installGnomeExtension({ home, runner, env: {} });
  assert.deepEqual([again.copied, again.enabled, again.relogin], [false, true, false]);
  assert.deepEqual(calls.map((c) => c.slice(0, 2)), [['gsettings', 'get']], 'idempotent: no enable or set');

  calls.length = 0;
  const failed = await installGnomeExtension({ home, runner: async (cmd, args) => { calls.push([cmd, ...args]); return { code: 1, stdout: '', stderr: 'no bus' }; }, env: {} });
  assert.equal(failed.enabled, false);
  assert.ok(!calls.some((c) => c[1] === 'set'), 'a failed read never writes the list back');
  assert.deepEqual(parseStrv('@as []'), []);
  assert.deepEqual(parseStrv(formatStrv(["it's", 'b\\c'])), ["it's", 'b\\c']);
});

test('first-run setup at boot: helper started, Linux root step and GNOME extension, macOS grants; nothing when off', async () => {
  const home = fs.mkdtempSync(path.join(HOME, 'home-'));
  const runner = async (cmd, args) => (cmd === 'gsettings' && args[0] === 'get' ? { code: 0, stdout: '@as []' } : { code: 0, stdout: '' });
  const control = (st) => ({ forced: [], async status(o) { this.forced.push(o?.force); return st; } });
  let uinputCalls = 0;
  const uinput = async () => { uinputCalls++; return { uinput: false, pendingRoot: true }; };

  const on = control({ enabled: true, session: 'wayland', desktop: 'gnome', killed: null, backend: { helper: { kind: 'python', running: true, pid: 42 } } });
  const r = await ensureControlSetup({ control: on, platform: 'linux', home, runner, env: {}, uinput });
  assert.deepEqual(on.forced, [true], 'a forced status probe is what starts the helper');
  assert.equal(r.helper.running, true);
  assert.deepEqual(r.uinput, { uinput: false, pendingRoot: true });
  assert.equal(r.extension.enabled, true);

  const killed = await ensureControlSetup({ control: control({ enabled: false, killed: { at: 'x' } }), platform: 'linux', home, runner, env: {}, uinput });
  assert.deepEqual(killed, { skipped: 'killed' });
  const headless = await ensureControlSetup({ control: control({ enabled: true, session: 'none', desktop: '', backend: {} }), platform: 'linux', home, runner, env: {}, uinput });
  assert.equal(headless.uinput, undefined);
  assert.equal(uinputCalls, 1, 'no root step when off, killed or headless');

  // macOS: RIGS Control.app is built and started (its own LaunchAgent) before the probe; never when control is off.
  let installs = 0;
  const macHelper = async () => { installs++; return { label: 'dev.rigs.control', built: false }; };
  const macOn = control({ enabled: true, session: 'quartz', backend: {}, permissions: { screenCapture: { ok: true }, accessibility: { ok: false } } });
  const mac = await ensureControlSetup({ control: macOn, platform: 'mac', home, runner, uinput, macHelper });
  assert.deepEqual(mac.grants, ['accessibility']);
  assert.deepEqual(mac.install, { label: 'dev.rigs.control', built: false });
  assert.deepEqual(macOn.forced, [undefined, true]);
  const macOff = await ensureControlSetup({ control: control({ enabled: false, killed: { at: 'x' } }), platform: 'mac', home, runner, uinput, macHelper });
  assert.deepEqual(macOff, { skipped: 'killed' });
  assert.equal(installs, 1);
  const broken = await ensureControlSetup({ control: control({ enabled: true, session: 'quartz', backend: {}, permissions: {} }), platform: 'mac', home, runner, uinput, macHelper: async () => { throw Object.assign(new Error('no swiftc'), { fix: { text: 'xcode-select --install' } }); } });
  assert.deepEqual(broken.install, { error: 'no swiftc', fix: { text: 'xcode-select --install' } });
});
