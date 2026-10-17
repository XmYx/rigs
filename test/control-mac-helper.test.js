// macOS RIGS Control helper: label, LaunchAgent, source hash, install/rebuild decisions, helper-owned permissions.
// No test builds the app, loads a LaunchAgent or touches TCC: launchctl, bash and tccutil are injected.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rigs-machelper-'));
process.env.RIGS_HOME = path.join(root, 'home');
process.env.RIGS_NO_MIGRATIONS = '1';
process.env.RIGS_NO_AUTOUPDATE = '1';
process.env.RIGS_NO_OPENRIG = '1';

const H = await import('../src/control-mac-helper.js');
const A = await import('../src/access.js');
const { createControl } = await import('../src/control.js');
const { createMacAdapter } = await import('../src/control-mac.js');

test('helperLabel: the real home owns dev.rigs.control; any other home gets its own stable label', () => {
  assert.equal(H.helperLabel('/Users/x/.rigs', '/Users/x/.rigs'), 'dev.rigs.control');
  assert.equal(H.helperLabel('/Users/x/.rigs/', '/Users/x/.rigs'), 'dev.rigs.control');
  const dev = H.helperLabel('/Users/x/proj/.rigs-dev/mac', '/Users/x/.rigs');
  assert.match(dev, /^dev\.rigs\.control\.[0-9a-f]{8}$/);
  assert.equal(H.helperLabel('/Users/x/proj/.rigs-dev/mac', '/Users/x/.rigs'), dev);
  assert.notEqual(H.helperLabel('/Users/x/other', '/Users/x/.rigs'), dev);
});

test('launchAgentPlist: own Aqua job, interactive, restarted only after a crash, paths escaped', () => {
  const xml = H.launchAgentPlist({ label: 'dev.rigs.control', exe: '/U/a&b/RIGS Control.app/Contents/MacOS/rigs-control', home: '/U/<h>', log: '/U/h/logs/control-helper.log' });
  assert.match(xml, /<key>Label<\/key><string>dev\.rigs\.control<\/string>/);
  assert.match(xml, /<string>\/U\/a&amp;b\/RIGS Control\.app\/Contents\/MacOS\/rigs-control<\/string><string>--home<\/string><string>\/U\/&lt;h&gt;<\/string>/);
  assert.match(xml, /<key>ProcessType<\/key><string>Interactive<\/string>/);
  assert.match(xml, /<key>LimitLoadToSessionType<\/key><string>Aqua<\/string>/);
  assert.match(xml, /<key>KeepAlive<\/key>\s*<dict><key>SuccessfulExit<\/key><false\/><\/dict>/);
  if (process.platform === 'darwin') {
    const f = path.join(root, 'agent.plist');
    fs.writeFileSync(f, xml);
    assert.equal(spawnSync('plutil', ['-lint', f]).status, 0);
  }
});

test('sourceHash matches what build.sh stores in the bundle', { skip: spawnSync('shasum', ['-v']).status !== 0 }, () => {
  const files = ['RigsControl.swift', 'Info.plist', 'build.sh'].map((f) => path.join(H.SOURCE_DIR, f));
  const r = spawnSync('bash', ['-c', 'cat "$@" | shasum -a 256 | cut -d" " -f1', 'hash', ...files], { encoding: 'utf8' });
  assert.equal(r.stdout.trim(), H.sourceHash());
});

/** launchctl/bash fake: records calls; bash "builds" by writing the bundle's hash file. */
function fakeRunner({ loaded = false } = {}) {
  const calls = [];
  const runner = async (cmd, args) => {
    calls.push([cmd, ...args]);
    if (cmd === 'bash') {
      const app = args[1];
      fs.mkdirSync(path.join(app, 'Contents/Resources'), { recursive: true });
      fs.writeFileSync(path.join(app, 'Contents/Resources/source.sha256'), H.sourceHash() + '\n');
      return { code: 0, stdout: '', stderr: '' };
    }
    if (cmd === 'launchctl' && args[0] === 'print') return { code: loaded ? 0 : 113, stdout: '', stderr: '' };
    if (cmd === 'launchctl' && args[0] === 'bootstrap') { loaded = true; return { code: 0, stdout: '', stderr: '' }; }
    if (cmd === 'launchctl' && args[0] === 'bootout') { loaded = false; return { code: 0, stdout: '', stderr: '' }; }
    return { code: 0, stdout: '', stderr: '' };
  };
  return { runner, calls };
}

test('installMacHelper: builds once, bootstraps its own job, then only makes sure it runs; a rebuild asks for a re-grant', async () => {
  const home = fs.mkdtempSync(path.join(root, 'h-')), agents = path.join(root, 'agents-' + path.basename(home));
  const ready = async () => ({});
  const f = fakeRunner();
  const first = await H.installMacHelper({ home, runner: f.runner, launchAgents: agents, uid: 501, ready });
  assert.equal(first.built, true);
  assert.equal(first.regrant, false, 'a first build has no old grant to reset');
  assert.deepEqual(f.calls.map((c) => c.slice(0, 2).join(' ')), ['bash ' + path.join(H.SOURCE_DIR, 'build.sh'), 'launchctl print', 'launchctl bootstrap']);
  assert.equal(f.calls[2][2], 'gui/501');
  const plist = fs.readFileSync(first.plist, 'utf8');
  assert.match(plist, new RegExp(`<string>${first.label.replace(/\./g, '\\.')}</string>`));
  assert.ok(first.plist.startsWith(agents + path.sep));

  // Nothing changed: no build, no reload; kickstart without -k only starts a stopped job.
  f.calls.length = 0;
  const again = await H.installMacHelper({ home, runner: f.runner, launchAgents: agents, uid: 501, ready });
  assert.equal(again.built, false);
  assert.deepEqual(f.calls.map((c) => c.slice(0, 2).join(' ')), ['launchctl print', 'launchctl kickstart']);
  assert.ok(!f.calls[1].includes('-k'));

  // Sources changed (old hash in the bundle): rebuild, reload, and remember that the old TCC entries are stale.
  fs.writeFileSync(path.join(home, 'bin', H.APP_NAME, 'Contents/Resources/source.sha256'), 'old\n');
  f.calls.length = 0;
  const rebuilt = await H.installMacHelper({ home, runner: f.runner, launchAgents: agents, uid: 501, ready });
  assert.equal(rebuilt.built, true);
  assert.equal(rebuilt.regrant, true);
  assert.deepEqual(f.calls.map((c) => c.slice(0, 2).join(' ')), ['bash ' + path.join(H.SOURCE_DIR, 'build.sh'), 'launchctl print', 'launchctl bootout', 'launchctl bootstrap']);

  // The grant flow resets only RIGS Control's own entries, once.
  const t = fakeRunner();
  assert.deepEqual(await H.resetStaleGrants({ home, runner: t.runner }), { reset: true });
  assert.deepEqual(t.calls, [['tccutil', 'reset', 'ScreenCapture', 'dev.rigs.control'], ['tccutil', 'reset', 'Accessibility', 'dev.rigs.control']]);
  assert.deepEqual(await H.resetStaleGrants({ home, runner: t.runner }), { reset: false });
  assert.equal(t.calls.length, 2);
});

test('installMacHelper: no swiftc gives the xcode-select fix', async () => {
  const home = fs.mkdtempSync(path.join(root, 'h-'));
  const runner = async (cmd) => (cmd === 'bash' ? { code: 2, stdout: '', stderr: 'swiftc not found: run xcode-select --install' } : { code: 0, stdout: '', stderr: '' });
  await assert.rejects(H.installMacHelper({ home, runner, launchAgents: path.join(home, 'agents'), uid: 501, ready: async () => {} }),
    (e) => e.code === 'unsupported' && /xcode-select --install/.test(e.fix.text));
});

test('decideMacHelper: the helper\'s own grants, each missing one with its System Settings pane', () => {
  const none = A.decideMacHelper({ running: true, grants: { screen: false, ax: false, post: false }, app: '/h/bin/RIGS Control.app' });
  assert.equal(none.screenCapture.fix.url, A.MAC_PANES.screenCapture);
  assert.equal(none.accessibility.fix.url, A.MAC_PANES.accessibility);
  assert.equal(none.input.fix.url, A.MAC_PANES.accessibility);
  assert.match(none.screenCapture.fix.text, /Screen Recording and switch on RIGS Control/);
  assert.match(none.screenCapture.fix.text, /not to node/);
  const all = A.decideMacHelper({ running: true, grants: { screen: true, ax: true, post: true } });
  for (const k of ['screenCapture', 'input', 'accessibility']) { assert.equal(all[k].ok, true); assert.equal(all[k].fix, undefined); }
  // Accessibility on but post-event off: input is still missing.
  assert.equal(A.decideMacHelper({ running: true, grants: { screen: true, ax: true, post: false } }).input.ok, false);
  // An older helper that reports nothing: unknown, never assumed granted.
  assert.equal(A.decideMacHelper({ running: true, grants: {} }).screenCapture.ok, null);
  const regrant = A.decideMacHelper({ running: true, grants: { screen: false }, regrant: true });
  assert.match(regrant.screenCapture.fix.text, /it was updated/);
  const down = A.decideMacHelper({ running: false, error: 'not installed' });
  assert.equal(down.screenCapture.ok, false);
  assert.equal(down.input.fix.kind, 'helper');
  assert.match(down.input.fix.text, /not running \(not installed\).*rigs control helper install/);
});

test('nodeGrantWarning: node holding screen or input rights is a gate bypass', () => {
  assert.equal(A.nodeGrantWarning({ screen: false, ax: false }), null);
  assert.equal(A.nodeGrantWarning(null), null);
  const w = A.nodeGrantWarning({ screen: true, ax: false });
  assert.deepEqual(w.held, ['Screen Recording']);
  assert.match(w.text, /bypass the control gate/);
});

test('macOS control with the helper not running: actions fail with how to start it, kill unloads it', async () => {
  const home = fs.mkdtempSync(path.join(root, 'ctl-'));
  let stopped = 0;
  const cfg = { name: 'mac-test', control: { enabled: true, input: true } };
  const control = createControl({ home, platform: 'mac', getConfig: () => cfg, persistConfig: (c) => Object.assign(cfg, c), adapter: createMacAdapter({ home, stopHelper: async () => { stopped++; } }) });
  const st = await control.status({ force: true });
  assert.equal(st.ready.see, false);
  assert.equal(st.permissions.screenCapture.fix.kind, 'helper');
  assert.equal(st.ready.act, false);
  await assert.rejects(control.screenshot({}, { from: 'test', agent: 'a' }), (e) => e.code === 'needs-permission' && e.status === 412 && e.fix.kind === 'helper');
  await control.kill({ reason: 'test' }, { who: 'test' });
  assert.equal(stopped, 1);
});

test('ready follows the helper\'s grants: no Screen Recording means not ready to see, input still ready', async () => {
  const home = fs.mkdtempSync(path.join(root, 'ready-'));
  const cfg = { name: 'mac-test', control: { enabled: true, input: true } };
  const permissions = A.decideMacHelper({ running: true, grants: { screen: false, ax: true, post: true } });
  const adapter = { events: null, async inspect() { return { session: 'quartz', desktop: '', available: { macHelper: true }, locked: false, displays: [], permissions }; }, async request() { return { locked: false }; }, async configure() {}, async stop() {} };
  const control = createControl({ home, platform: 'mac', getConfig: () => cfg, persistConfig: () => {}, adapter });
  const st = await control.status({ force: true });
  assert.deepEqual(st.ready, { see: false, act: true });
  await assert.rejects(control.screenshot({}, { from: 'test', agent: 'a' }), (e) => e.code === 'needs-permission' && /Privacy_ScreenCapture$/.test(e.fix.url));
});
