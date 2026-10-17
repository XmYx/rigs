import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import net from 'node:net';
import { test, after } from 'node:test';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rigs-control-test-'));
process.env.RIGS_HOME = path.join(root, 'default');
const { createControl, selectBackend, parseCombo, imageSize } = await import('../src/control.js');
const { createLinuxAdapter } = await import('../src/control-linux.js');
const { ControlRPC } = await import('../src/control-rpc.js');
const { createMacAdapter } = await import('../src/control-mac.js');
const { createWindowsAdapter } = await import('../src/control-win.js');
const { run } = await import('../src/util.js');
const cleanups = [];
after(async () => { for (const cleanup of cleanups) await cleanup(); fs.rmSync(root, { recursive: true, force: true }); });

const alice = { from: 'macbookpro', agent: 'codex', session: 'scratch' };
const bob = { from: 'other', agent: 'claude', session: 'work' };
const facts = { session: 'wayland', desktop: 'gnome', available: { gi: true, mutterScreenCast: 4, mutterRemoteDesktop: 1, 'gst-launch-1.0': true, rigsExtension: true }, displays: [{ id: 'DP-1', width: 3840, height: 2160, scale: 1.5, primary: true }], locked: false };
const png = Buffer.from('89504e470d0a1a0a0000000d494844520000064000000384', 'hex'); // header fixture: 1600×900
function fixture(overrides = {}, behavior = {}) {
  const home = fs.mkdtempSync(path.join(root, 'instance-'));
  let cfg = { name: 'test-node', control: { enabled: true, input: true, leaseIdleSec: 60, maxActionsPerMin: 120, maxShotsPerMin: 30, auditPreview: 64, ...overrides } };
  let time = 10000;
  const calls = [], events = new EventEmitter();
  const adapter = {
    events,
    inspect: async () => { calls.push(['inspect']); return structuredClone(facts); },
    configure: async (s) => { calls.push(['configure', s]); },
    stop: async () => { calls.push(['stop']); },
    request: async (op, a) => {
      calls.push([op, a]);
      if (behavior[op]) return behavior[op](a);
      if (op === 'locked') return { locked: false };
      if (op === 'shot') { fs.writeFileSync(a.file, png); return { display: 'DP-1', sourceWidth: 3840, sourceHeight: 2160 }; }
      if (op === 'windows') return [{ id: 'opaque:2', title: 'Scratch', focused: true }];
      if (op === 'type') return { typed: a.text.length, via: 'keysym' };
      return {};
    },
  };
  const c = createControl({ platform: 'linux', home, getConfig: () => cfg, persistConfig: (v) => { cfg = v; }, adapter, now: () => time, permissions: async () => ({}), timeoutMs: 100 });
  cleanups.push(() => c.kill());
  return { c, home, calls, events, adapter, config: () => cfg, advance: (n) => { time += n; } };
}

test('backend selection covers platform families and explicit choices without side effects', () => {
  assert.equal(selectBackend({ platform: 'darwin', session: 'quartz', available: { macHelper: true } }).capture, 'mac-helper');
  assert.equal(selectBackend({ platform: 'windows', session: 'windows', available: { windowsHelper: true } }).input, 'windows');
  assert.deepEqual(selectBackend({ platform: 'linux', ...facts }), { capture: 'mutter', input: 'mutter', windows: 'rigs-extension', missing: [] });
  const wlr = selectBackend({ platform: 'linux', session: 'wayland', desktop: 'sway', available: { grim: true, wtype: true, wlrctl: true, swaymsg: true } });
  assert.deepEqual(wlr, { capture: 'grim', input: 'wlroots', windows: 'sway', missing: [] });
  assert.equal(selectBackend({ platform: 'linux', session: 'wayland', desktop: 'hyprland', available: { grim: true, uinputWritable: true, hyprctl: true } }).windows, 'hyprland');
  assert.deepEqual(selectBackend({ platform: 'linux', session: 'x11', available: { xdotool: true, wmctrl: true, import: true } }), { capture: 'x11', input: 'x11', windows: 'x11', missing: [] });
  const portal = { gi: true, portalScreenCast: 5, portalRemoteDesktop: 2, 'gst-launch-1.0': true };
  assert.equal(selectBackend({ platform: 'linux', session: 'wayland', desktop: 'kde', available: portal }).capture, 'portal');
  assert.equal(selectBackend({ platform: 'linux', ...facts, force: 'portal' }).capture, null);
  assert.equal(selectBackend({ platform: 'linux', ...facts, force: 'uinput', available: { ...facts.available, uinputWritable: true } }).input, 'uinput');
  assert.deepEqual(selectBackend({ platform: 'linux', session: 'none' }).missing, ['capture', 'input', 'windows']);
  assert.equal(selectBackend({ platform: 'mac', session: 'quartz', available: {}, force: 'mac-jxa' }).input, null);
});

test('combo aliases, portable mod and bad arguments', () => {
  assert.deepEqual(parseCombo('MOD+Shift+t', 'mac'), ['super', 'shift', 't']);
  assert.deepEqual(parseCombo('option+F24', 'linux'), ['alt', 'f24']);
  assert.deepEqual(parseCombo('mod+return', 'linux'), ['ctrl', 'enter']);
  assert.deepEqual(parseCombo('ctrl++', 'linux'), ['ctrl', '+']);
  assert.deepEqual(parseCombo('+', 'linux'), ['+']);
  for (const text of ['', 'ctrl++a', 'shift+shift+a', 'f25', 'nope', 'a+b']) assert.throws(() => parseCombo(text), { code: 'bad-args' });
});

test('off/input-off refuse every public desktop operation before a helper is contacted, audit refusals', async () => {
  const { c, calls } = fixture({ enabled: false });
  for (const op of [() => c.screenshot({}, alice), () => c.listWindows(alice), () => c.focusWindow('2', alice), () => c.pointer({ x: 1, y: 2 }, alice), () => c.typeText('hello', {}, alice), () => c.key('enter', {}, alice)]) await assert.rejects(op(), { code: 'off', status: 403 });
  assert.equal(calls.length, 0);
  assert.equal(c.auditTail().length, 6);
  const f = fixture({ input: false });
  await assert.rejects(f.c.key('a', {}, alice), { code: 'input-off' });
  assert.equal(f.calls.length, 0);
});

test('allowFrom, exclusive lease, idle handoff and machine-wide rates', async () => {
  const f = fixture({ allowFrom: ['macbookpro', 'other'], maxActionsPerMin: 2 });
  await assert.rejects(f.c.listWindows({ from: 'unknown' }), { code: 'not-allowed' });
  await f.c.listWindows(alice);
  await assert.rejects(f.c.listWindows(bob), { code: 'busy' });
  assert.equal((await f.c.status()).lease.holder.session, alice.session);
  await f.c.key('enter', {}, alice);
  await assert.rejects(f.c.key('enter', {}, alice), { code: 'rate', status: 429 });
  f.advance(61000);
  await f.c.listWindows(bob);
  assert.equal((await f.c.status()).lease.holder.agent, 'claude');
});

test('lock is checked fresh despite cached status; unknown lock also refuses screenshots', async () => {
  let locked = false;
  const f = fixture({}, { locked: async () => ({ locked }) });
  await f.c.listWindows(alice);
  locked = true;
  await assert.rejects(f.c.typeText('unsafe', {}, alice), { code: 'locked' });
  locked = null;
  await assert.rejects(f.c.screenshot({}, alice), { code: 'locked' });
  assert.ok(!f.calls.some(([op]) => op === 'type' || op === 'shot'));
});

test('screenshot data, cleanup, shot transforms including crop origin, and stale coordinates', async () => {
  const f = fixture();
  const shot = await f.c.screenshot({ region: { x: 100, y: 200, width: 3200, height: 1800 }, maxWidth: 1600 }, alice);
  assert.deepEqual(imageSize(shot.data), { width: 1600, height: 900 });
  assert.equal(shot.scale, 2);
  assert.deepEqual(fs.readdirSync(path.join(f.home, 'run/shots')), []);
  await f.c.pointer({ action: 'drag', x: 20, y: 30, to: { x: 40, y: 50 }, shot: shot.shot }, alice);
  const moves = f.calls.filter(([op]) => op === 'move').map(([, args]) => args);
  assert.deepEqual(moves, [{ x: 140, y: 260, display: 'DP-1' }, { x: 180, y: 300, display: 'DP-1' }]);
  await assert.rejects(f.c.pointer({ x: 1600, y: 2, shot: shot.shot }, alice), { code: 'bad-args' });
  f.advance(300001);
  await assert.rejects(f.c.pointer({ x: 1, y: 1, shot: shot.shot }, alice), { code: 'bad-args' });
});

test('separate screenshot rate and key release order; focus uses windowId (not request id)', async () => {
  const f = fixture({ maxShotsPerMin: 1 });
  await f.c.screenshot({}, alice);
  await assert.rejects(f.c.screenshot({}, alice), { code: 'rate' });
  await f.c.key('ctrl+shift+t', {}, alice);
  assert.deepEqual(f.calls.filter(([op]) => op === 'key').map(([, a]) => [a.key, a.down]), [['ctrl', true], ['shift', true], ['t', true], ['t', false], ['shift', false], ['ctrl', false]]);
  await f.c.focusWindow('opaque:2', alice);
  assert.deepEqual(f.calls.find(([op]) => op === 'focus')[1], { windowId: 'opaque:2' });
});

test('secret typing never appears in audit/feed, including backend error messages', async () => {
  const f = fixture({}, { type: async () => { throw new Error('secret-token'); } });
  const feed = []; f.c.events.on('action', (v) => feed.push(v));
  await assert.rejects(f.c.typeText('secret-token', { secret: true }, alice));
  assert.doesNotMatch(fs.readFileSync(path.join(f.home, 'logs/control.jsonl'), 'utf8'), /secret-token/);
  assert.doesNotMatch(JSON.stringify(feed), /secret-token/);
  assert.equal(f.c.auditTail()[0].args.length, 12);
  if (process.platform !== 'win32') assert.equal(fs.statSync(path.join(f.home, 'logs/control.jsonl')).mode & 0o777, 0o600);
});

test('only confirmed human enable clears persistent kill; agents may disable', async () => {
  const f = fixture();
  await f.c.kill({ reason: 'hands off' }, alice);
  assert.equal(f.config().control.enabled, false);
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.home, 'control-state.json'))).killed.reason, 'hands off');
  // Even an externally toggled config cannot undo the persistent kill.
  f.config().control.enabled = true;
  await assert.rejects(f.c.listWindows(alice), { code: 'off' });
  for (const caller of [alice, { ...alice, human: true }, { human: true }]) {
    await assert.rejects(f.c.enable({ enabled: true, input: true, confirm: 'wrong' }, caller), { code: 'not-allowed' });
  }
  await assert.rejects(f.c.enable({ enabled: true, confirm: 'test-node' }, { ...alice, human: true }), { code: 'not-allowed' });
  await f.c.enable({ enabled: true, input: true, confirm: 'test-node' }, { human: true, who: 'Sir' });
  assert.equal((await f.c.status()).killed, null);
  await f.c.enable({ enabled: false }, alice);
  assert.equal(f.config().control.input, false);
});

test('timeout aborts helper and late completion cannot send subsequent input', async () => {
  let finish;
  const f = fixture({}, { move: () => new Promise((r) => { finish = r; }) });
  await assert.rejects(f.c.pointer({ action: 'click', x: 1, y: 2 }, alice), { code: 'timeout' });
  finish({});
  await new Promise((r) => setImmediate(r));
  assert.equal(f.calls.filter(([op]) => op === 'button').length, 0);
  assert.ok(f.calls.some(([op]) => op === 'stop'));
});

test('kill cancels in-flight operation and actions queued before kill', async () => {
  let finish;
  const f = fixture({}, { move: () => new Promise((r) => { finish = r; }) });
  const first = f.c.pointer({ action: 'click', x: 1, y: 2 }, alice);
  const queued = f.c.typeText('must not run', {}, alice);
  while (!finish) await new Promise((r) => setImmediate(r));
  await f.c.kill({}, bob);
  finish({});
  await assert.rejects(first, { code: 'off' });
  await assert.rejects(queued, { code: 'off' });
  assert.ok(!f.calls.some(([op]) => ['button', 'type'].includes(op)));
});

test('kill rejects immediately even when a runner ignores cancellation', async () => {
  const f = fixture({}, { type: () => new Promise(() => {}) });
  const pending = f.c.typeText('scratch', {}, alice);
  while (!f.calls.some(([op]) => op === 'type')) await new Promise((r) => setImmediate(r));
  const rejected = assert.rejects(pending, { code: 'off' });
  await f.c.kill({}, bob);
  await rejected;
});

test('helper closed event persistently kills control', async () => {
  const f = fixture();
  f.events.emit('event', { event: 'closed' });
  await new Promise((r) => setImmediate(r));
  assert.equal(f.config().control.enabled, false);
  assert.equal((await f.c.status()).killed.reason, 'helper closed');
});

test('Linux runner receives literal Unicode/text args and X11 window focus validates ids', async () => {
  const calls = [];
  const adapter = createLinuxAdapter({ runner: async (...args) => { calls.push(args); return { code: 0, stdout: '', stderr: '' }; }, find: () => true, environment: () => ({ DISPLAY: ':test' }), refresh: async () => {} });
  await adapter.configure({ capture: 'x11', input: 'x11', windows: 'x11' });
  const text = 'á $(touch /tmp/never) `literal`';
  await adapter.request('type', { text, delayMs: 2 });
  assert.deepEqual(calls[0][1], ['type', '--clearmodifiers', '--delay', '2', '--file', '-']);
  assert.equal(calls[0][2].input, text);
  await adapter.request('focus', { windowId: '0xabc' });
  assert.deepEqual(calls[1][1], ['windowactivate', '--sync', '0xabc']);
  await assert.rejects(adapter.request('focus', { windowId: '0;exec' }), { code: 'bad-args' });
});

test('JSONL transport handles fragmented replies, errors, timeout, and never replays an op', async () => {
  let sent = '', read, write, destroyed = 0;
  const rpc = new ControlRPC({ timeout: 20, connect: async () => {
    read = new PassThrough(); write = new PassThrough(); write.on('data', (d) => { sent += d; });
    return { read, write, destroy: () => { destroyed++; read.destroy(); write.destroy(); }, onClose: () => {} };
  } });
  const p = rpc.request('focus', { windowId: 'opaque' });
  await new Promise((r) => setImmediate(r));
  const request = JSON.parse(sent);
  assert.equal(request.windowId, 'opaque');
  read.write(`{"id":${request.id},"ok":true,`); read.write('"result":{"ok":true}}\n');
  assert.deepEqual(await p, { ok: true });
  await assert.rejects(rpc.request('type', { text: 'test' }), { code: 'timeout' });
  assert.equal(destroyed, 1);
  assert.equal(sent.split('\n').filter(Boolean).length, 2);
});

test('Linux CLI cancellation releases only keys/buttons held by this adapter', async () => {
  const calls = [];
  const a = createLinuxAdapter({ runner: async (cmd, args) => { calls.push([cmd, args]); return { code: 0, stdout: '', stderr: '' }; }, environment: () => ({}), refresh: async () => {} });
  await a.configure({ input: 'x11' });
  await a.request('key', { key: 'ctrl', down: true });
  await a.request('button', { button: 'left', down: true });
  await a.stop();
  assert.deepEqual(calls.map(([, args]) => args), [['keydown', 'Control_L'], ['mousedown', '1'], ['keyup', 'Control_L'], ['mouseup', '1']]);
});

test('wlroots shortcuts stay in one virtual keyboard lifetime; text uses stdin', async () => {
  const calls = [];
  const a = createLinuxAdapter({ runner: async (...args) => { calls.push(args); return { code: 0, stdout: '', stderr: '' }; }, environment: () => ({}), refresh: async () => {} });
  await a.configure({ input: 'wlroots' });
  await a.request('combo', { keys: ['ctrl', 'shift', 't'], repeat: 1 });
  assert.deepEqual(calls[0][1], ['-M', 'ctrl', '-M', 'shift', '-P', 't', '-p', 't', '-m', 'shift', '-m', 'ctrl']);
  await a.request('type', { text: 'árvíztűrő', delayMs: 0 });
  assert.equal(calls[1][2].input, 'árvíztűrő');
});

test('macOS adapter exchanges authenticated JSONL with independent helper; missing helper gives fix', { skip: process.platform === 'win32' }, async () => {
  const home = fs.mkdtempSync(path.join(root, 'mac-'));
  const missing = createMacAdapter({ home });
  assert.deepEqual((await missing.inspect()).available, {});
  await assert.rejects(missing.request('locked'), { code: 'needs-permission' });
  fs.mkdirSync(path.join(home, 'run'));
  fs.writeFileSync(path.join(home, 'run/control.token'), 'test-token', { mode: 0o600 });
  const received = [];
  const server = net.createServer((socket) => {
    let buffer = '';
    socket.on('data', (chunk) => {
      buffer += chunk;
      while (buffer.includes('\n')) {
        const i = buffer.indexOf('\n'), req = JSON.parse(buffer.slice(0, i)); buffer = buffer.slice(i + 1);
        received.push(req);
        socket.write(JSON.stringify({ id: req.id, ok: true, result: req.op === 'probe' ? { locked: false, displays: [] } : { ok: true } }) + '\n');
      }
    });
  });
  await new Promise((resolve) => server.listen(path.join(home, 'run/control.sock'), resolve));
  const a = createMacAdapter({ home });
  try {
    assert.equal((await a.inspect()).available.macHelper, true);
    await a.request('focus', { windowId: '234' });
    assert.equal(received[1].windowId, '234');
    assert.equal(received[1].token, 'test-token');
  } finally { await a.stop(); await new Promise((resolve) => server.close(resolve)); }
});

test('run AbortSignal terminates in-flight commands and rejects no process for pre-abort', async () => {
  const controller = new AbortController();
  const pending = run(process.execPath, ['-e', 'setTimeout(()=>{},60000)'], { signal: controller.signal });
  controller.abort();
  assert.equal((await pending).code, -3);
  assert.equal((await run('does-not-exist', [], { signal: controller.signal })).code, -3);
});

test('Windows adapter starts the fixed helper script and transports literal Unicode JSON', async () => {
  const seen = []; let invocation;
  const child = new EventEmitter();
  child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.pid = 123;
  child.kill = () => child.emit('exit', 0);
  child.stdin.on('data', (data) => {
    for (const line of data.toString().trim().split('\n').filter(Boolean)) {
      const req = JSON.parse(line); seen.push(req);
      child.stdout.write(JSON.stringify({ id: req.id, ok: true, result: req.op === 'probe' ? { locked: false, displays: [] } : {} }) + '\n');
      if (req.op === 'stop') setImmediate(() => child.emit('exit', 0));
    }
  });
  const a = createWindowsAdapter({ spawn: (cmd, args) => { invocation = { cmd, args }; return child; } });
  try {
    assert.equal((await a.inspect()).available.windowsHelper, true);
    await a.request('type', { text: '日本語 $(literal)', delayMs: 0 });
    assert.equal(invocation.cmd, 'powershell.exe');
    assert.equal(invocation.args.at(-2), '-File');
    assert.match(invocation.args.at(-1), /rigs-control\.ps1$/);
    assert.equal(seen[1].text, '日本語 $(literal)');
  } finally { await a.stop(); }
});

test('Linux helper fixes both scaled dimensions and rejects non-ASCII before any input', { skip: process.platform !== 'linux' }, async (t) => {
  const result = await run('python3', ['-c', `
import importlib.util, tempfile, os
from unittest.mock import patch
spec=importlib.util.spec_from_file_location('control','scripts/control/rigs-control-linux.py')
m=importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
h=m.Helper(); h.op_configure({'input':'mutter'})
try:
    h.op_type({'text':'ASCII then 日本語'})
    raise AssertionError('non-ASCII accepted')
except m.Fail as e:
    assert e.code == 'unsupported'
calls=[]
class Result:
    returncode=0
with tempfile.NamedTemporaryFile() as f:
    f.write(b'png'); f.flush()
    with patch.object(m.subprocess,'run',side_effect=lambda args,**kw: (calls.append(args) or Result())):
        m.gst_frame(1,f.name,max_width=1568,src_size=(3840,2160))
assert 'video/x-raw,width=1568,height=882,pixel-aspect-ratio=1/1' in calls[0]
class Portal:
    fd=None
    streams=[{'node':5,'props':{'size':(2560,1440)}}]
    def ensure(self): pass
    def stream(self,i): return self.streams[i]
    def move(self,i,x,y): self.last_move=(i,x,y)
h.portal=Portal(); h.op_configure({'capture':'portal','input':'portal'})
with tempfile.TemporaryDirectory() as d:
    out=os.path.join(d,'shot.png')
    def frame(node,file,**kw):
        with open(file,'wb') as f: f.write(b'png')
    with patch.object(m,'gst_frame',side_effect=frame), patch.object(m,'image_size',side_effect=lambda f: (3840,2160) if f.endswith('.source.png') else (1568,882)):
        result=h.op_shot({'file':out,'maxWidth':1568})
    assert result['sourceWidth']==3840
    assert not os.path.exists(out+'.source.png')
    h.op_move({'x':1920,'y':1080,'display':'0'})
    assert h.portal.last_move==(0,1280,720)
print('scaled frame, portal coordinates and pre-input Unicode refusal verified')
`], { env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } });
  if (result.code === -1) { t.skip('python3 not installed on this test host'); return; }
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /verified/);
});
