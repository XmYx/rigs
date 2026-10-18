import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import { test, after } from 'node:test';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rigs-stream-test-'));
process.env.RIGS_HOME = path.join(root, 'default');
const { createControl, accessCheck } = await import('../src/control.js');
const { streamOptions, streamKey, targetWidth, frameDelay, retryDelay, decideOnError, refusal, createStreamHub, DEFAULTS } = await import('../src/screen-stream.js');
const { forwardWs, relayCloseCode } = await import('../src/proxy.js');
const { config } = await import('../src/config.js');
const { WebSocket, WebSocketServer } = await import('ws');
const cleanups = [];
after(async () => { for (const c of cleanups) await c(); fs.rmSync(root, { recursive: true, force: true }); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 2000) => { const end = Date.now() + ms; while (!fn()) { if (Date.now() > end) throw new Error('timed out'); await sleep(10); } };

// A JPEG header the control module can size: SOI, then SOF0 with 450×800 (height, width).
const jpeg = Buffer.from('ffd8ffc0001108' + '01c2' + '0320' + '03012200021101031101', 'hex');

/** A real control instance (src/control.js) over a fake helper, so the stream goes through the real gate. */
function fixture(overrides = {}) {
  const home = fs.mkdtempSync(path.join(root, 'node-'));
  let cfg = { name: 'test-node', control: { enabled: true, input: true, leaseIdleSec: 60, maxShotsPerMin: 30, maxStreamFramesPerMin: 600, ...overrides } };
  const calls = [];
  const adapter = {
    events: new EventEmitter(),
    inspect: async () => ({ session: 'wayland', desktop: 'gnome', available: { gi: true, mutterScreenCast: 4, mutterRemoteDesktop: 1, 'gst-launch-1.0': true }, displays: [{ id: 'DP-1', width: 1600, height: 900, primary: true }], locked: false }),
    configure: async () => {},
    stop: async () => {},
    request: async (op, a) => {
      calls.push([op, a]);
      if (op === 'locked') return { locked: false };
      if (op === 'shot') { fs.writeFileSync(a.file, jpeg); return { display: 'DP-1', sourceWidth: 1600 }; }
      return {};
    },
  };
  const control = createControl({ platform: 'linux', home, getConfig: () => cfg, persistConfig: (v) => { cfg = v; }, adapter, permissions: async () => ({}), timeoutMs: 1000 });
  cleanups.push(() => control.kill().catch(() => {}));
  const shots = () => calls.filter(([op]) => op === 'shot');
  return { control, calls, shots, config: () => cfg, setConfig: (c) => { cfg = c; } };
}

function viewer() {
  const v = { frames: [], messages: [], closed: null };
  v.send = (d) => v.frames.push(d);
  v.message = (m) => v.messages.push(m);
  v.close = (code, reason) => { v.closed = { code, reason }; };
  return v;
}

test('stream options are clamped, defaulted and never throw', () => {
  assert.deepEqual(streamOptions({}), { ...DEFAULTS });
  assert.deepEqual(streamOptions(new URLSearchParams('fps=99&quality=1&scale=4&maxWidth=20&display=2')), { fps: 10, quality: 10, scale: 1, maxWidth: 160, display: 2 });
  assert.deepEqual(streamOptions({ fps: 0, quality: 'x', scale: -1 }), { fps: 0.2, quality: DEFAULTS.quality, scale: 0.1 });
  assert.equal(streamOptions({ fps: '4.44' }).fps, 4.4);
  assert.equal(streamOptions({ display: 'DP-1' }).display, 'DP-1');
  assert.equal(streamOptions({ maxWidth: 99999 }).maxWidth, 3840);
  assert.notEqual(streamKey(streamOptions({}), 'a'), streamKey(streamOptions({}), 'b'));
  assert.equal(streamKey(streamOptions({ fps: 3 })), streamKey(streamOptions({})));
});

test('frame pacing: width from scale, delay holds fps, back-off is bounded', () => {
  assert.equal(targetWidth({ sourceWidth: 3840, scale: 0.5 }), 1920);
  assert.equal(targetWidth({ sourceWidth: 3840, scale: 0.5, maxWidth: 800 }), 800);
  assert.equal(targetWidth({ sourceWidth: 200, scale: 0.1 }), 160);
  assert.equal(targetWidth({ scale: 0.5 }), 960); // first frame: guessed 1920-wide source
  assert.equal(frameDelay(4, 0), 250);
  assert.equal(frameDelay(4, 100), 150);
  assert.equal(frameDelay(4, 400), 0);
  assert.equal(frameDelay(0.2, 0), 5000);
  assert.equal(retryDelay(10, 1), 500);
  assert.equal(retryDelay(10, 3), 2000);
  assert.equal(retryDelay(10, 20), 5000);
  assert.equal(retryDelay(0.5, 1), 2000);
});

test('access gate: the shared check, and what a failed frame means for the stream', () => {
  assert.equal(accessCheck({ enabled: true }, null, {}), null);
  assert.equal(accessCheck({ enabled: false }, null, {}).code, 'off');
  assert.equal(accessCheck({ enabled: true }, { at: 'x' }, {}).code, 'off'); // killed wins over the setting
  assert.equal(accessCheck({ enabled: true, input: false }, null, {}, true).code, 'input-off');
  assert.equal(accessCheck({ enabled: true, input: false }, null, {}, false), null);
  assert.equal(accessCheck({ enabled: true, allowFrom: ['a'] }, null, { from: 'b' }).code, 'not-allowed');
  assert.equal(accessCheck({ enabled: true, allowFrom: ['a'] }, null, { from: 'a' }), null);

  const off = { code: 'off', message: 'off' };
  assert.deepEqual(refusal(off), { end: true, status: 'control-off', close: 4403, code: 'off', message: 'off' });
  // Access off right now: control-off, whatever the frame said.
  assert.equal(decideOnError({ code: 'timeout' }, off).status, 'control-off');
  // 'off' from a helper restart or lease end while access is still on: keep trying.
  assert.deepEqual(decideOnError({ code: 'off', message: 'Control helper stopped' }, null), { end: false, status: 'restarting', code: 'off', message: 'Control helper stopped' });
  for (const code of ['locked', 'rate', 'timeout', 'busy', 'error']) assert.equal(decideOnError({ code }, null).end, false, code);
  for (const [code, close] of [['needs-permission', 4412], ['unsupported', 4501], ['no-session', 4503], ['not-allowed', 4403]]) {
    const d = decideOnError({ code, fix: { text: 'grant' } }, null);
    assert.equal(d.end, true); assert.equal(d.close, close); assert.equal(d.status, code);
  }
  assert.deepEqual(decideOnError({ code: 'needs-permission', fix: { text: 'grant' } }).fix, { text: 'grant' });
});

test('viewers share one capture loop, which stops when the last viewer leaves', async () => {
  const f = fixture();
  const hub = createStreamHub({ control: f.control, nodeName: () => 'test-node' });
  const a = viewer(), b = viewer();
  const ha = hub.join(a, { fps: 10 }, { from: 'test-node', human: true });
  const hb = hub.join(b, { fps: 10 }, { from: 'test-node', human: true });
  assert.equal(ha.key, hb.key);
  assert.deepEqual(a.messages[0], { type: 'hello', node: 'test-node', fps: 10, quality: 60, scale: 0.5, viewers: 1 });
  assert.equal(b.messages[0].viewers, 2);
  await until(() => a.frames.length >= 3 && b.frames.length >= 3);
  assert.ok(a.frames[0].equals(jpeg));
  assert.deepEqual(a.messages.find((m) => m.type === 'meta'), { type: 'meta', width: 800, height: 450, scale: 2, display: 'DP-1' });
  assert.equal(a.messages.filter((m) => m.type === 'meta').length, 1); // only when the size changes
  // Second frame on: width from the measured source (1600 × 0.5), JPEG, the requested quality.
  const [, args] = f.shots().at(-1);
  assert.deepEqual([args.format, args.quality, args.maxWidth], ['jpeg', 60, 800]);
  let st = hub.status();
  assert.equal(st.capturing, true); assert.equal(st.viewers, 2); assert.equal(st.streams.length, 1);

  ha.leave();
  const n = b.frames.length;
  await until(() => b.frames.length > n + 1);
  assert.equal(hub.status().viewers, 1);
  hb.leave(); hb.leave(); // leaving twice is harmless
  const shots = f.shots().length;
  await sleep(350);
  assert.ok(f.shots().length <= shots + 1, 'at most the frame in flight finishes after the last viewer left');
  st = hub.status();
  assert.equal(st.capturing, false); assert.equal(st.viewers, 0);

  // Frames neither take the screen lease nor fill the audit log; the stream's start and end are audited.
  assert.equal((await f.control.status()).lease, null);
  const audit = f.control.auditTail({ limit: 500 });
  assert.equal(audit.filter((l) => l.op === 'frame').length, 0);
  assert.deepEqual(audit.filter((l) => l.op === 'stream').map((l) => l.args.phase), ['start', 'end']);
  assert.ok(audit.find((l) => l.op === 'stream' && l.args.phase === 'end').args.frames >= 3);
});

test('different settings get their own loop; a viewer can change its settings', async () => {
  const f = fixture();
  const hub = createStreamHub({ control: f.control });
  const a = viewer(), b = viewer();
  const ha = hub.join(a, { fps: 10, scale: 0.25 }, {}), hb = hub.join(b, { fps: 2 }, {});
  assert.notEqual(ha.key, hb.key);
  assert.equal(hub.status().streams.length, 2);
  ha.leave(); hb.leave();
  assert.equal(hub.status().streams.length, 0);
});

test('with screen access off the stream refuses at once and never captures', async () => {
  for (const overrides of [{ enabled: false }, { enabled: true, allowFrom: ['other'] }]) {
    const f = fixture(overrides);
    const hub = createStreamHub({ control: f.control });
    const v = viewer();
    assert.equal(hub.join(v, {}, { from: 'test-node' }), null);
    assert.equal(v.messages[0].type, 'error');
    assert.equal(v.messages[0].status, overrides.enabled ? 'not-allowed' : 'control-off');
    assert.equal(v.closed.code, 4403);
    await sleep(50);
    assert.equal(f.calls.length, 0);
    assert.equal(hub.status().capturing, false);
  }
});

test('the kill switch ends a running stream at once; a settings switch-off within the watch interval', async () => {
  const f = fixture();
  const hub = createStreamHub({ control: f.control, watchMs: 200 });
  const v = viewer();
  hub.join(v, { fps: 10 }, {});
  await until(() => v.frames.length >= 2);
  const t = Date.now();
  await f.control.kill({ reason: 'test' }, { who: 'person' });
  await until(() => v.closed);
  assert.ok(Date.now() - t < 1000);
  assert.deepEqual(v.closed, { code: 4403, reason: 'control-off' });
  assert.equal(v.messages.at(-1).status, 'control-off');
  const shots = f.shots().length;
  await sleep(300);
  assert.equal(f.shots().length, shots);

  // Switched off without an event (config changed underneath): the watch catches it.
  const g = fixture();
  const hub2 = createStreamHub({ control: g.control, watchMs: 200 });
  const w = viewer();
  hub2.join(w, { fps: 0.2 }, {}); // slow stream: the next frame is 5 s away
  await until(() => w.frames.length >= 1);
  const t2 = Date.now();
  g.setConfig({ ...g.config(), control: { ...g.config().control, enabled: false } });
  await until(() => w.closed);
  assert.ok(Date.now() - t2 < 1000);
  assert.equal(w.closed.reason, 'control-off');
  // Nothing on this path switches access back on.
  assert.equal(g.config().control.enabled, false);
});

test('a transient failure is reported and retried; a missing permission ends the stream', async () => {
  const f = fixture();
  let fail = 'locked';
  const orig = f.control.frame;
  f.control.frame = async (...args) => { if (fail) { const e = new Error(fail); e.code = fail; throw e; } return orig(...args); };
  const hub = createStreamHub({ control: f.control });
  const v = viewer();
  hub.join(v, { fps: 10 }, {});
  await until(() => v.messages.some((m) => m.type === 'status'));
  assert.equal(v.messages.find((m) => m.type === 'status').status, 'locked');
  fail = null;
  await until(() => v.frames.length >= 1, 3000);
  assert.ok(v.messages.some((m) => m.type === 'status' && m.status === 'ok'));
  fail = 'needs-permission';
  await until(() => v.closed, 3000);
  assert.deepEqual(v.closed, { code: 4412, reason: 'needs-permission' });
});

test('/screen/stream over a WebSocket, relayed through the peer proxy, with control-off passed through', async () => {
  const f = fixture();
  const hub = createStreamHub({ control: f.control, nodeName: () => 'peer', watchMs: 200 });
  const wss = new WebSocketServer({ noServer: true });
  const seen = [];
  const peer = http.createServer();
  peer.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, 'http://x');
    seen.push({ path: url.pathname, via: req.headers['x-rigs-via'] });
    wss.handleUpgrade(req, socket, head, (ws) => hub.attachWs(ws, url.searchParams, { from: req.headers['x-rigs-via'] || 'local' }));
  });
  const front = http.createServer();
  front.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, 'http://x');
    forwardWs({ url: `http://127.0.0.1:${peer.address().port}` }, req, socket, head, 'screen/stream' + url.search);
  });
  await new Promise((r) => peer.listen(0, '127.0.0.1', r));
  await new Promise((r) => front.listen(0, '127.0.0.1', r));
  cleanups.push(() => { peer.close(); front.close(); });

  const ws = new WebSocket(`ws://127.0.0.1:${front.address().port}/api/nodes/peer/screen/stream?fps=10&quality=50`);
  const got = { text: [], binary: 0, close: null };
  ws.on('message', (d, isBinary) => { if (isBinary) got.binary++; else got.text.push(JSON.parse(String(d))); });
  ws.on('close', (code, reason) => { got.close = { code, reason: String(reason) }; });
  await until(() => got.binary >= 3);
  assert.deepEqual(seen[0], { path: '/api/local/screen/stream', via: config().name }); // the node the viewer entered on
  assert.equal(got.text[0].type, 'hello');
  assert.equal(got.text[0].quality, 50);
  assert.equal(hub.status().viewers, 1);
  // Adjusting the frame rate from the client moves it to another loop.
  ws.send(JSON.stringify({ fps: 5 }));
  await until(() => got.text.filter((m) => m.type === 'hello').length === 2);
  assert.equal(got.text.filter((m) => m.type === 'hello')[1].fps, 5);
  assert.equal(hub.status().streams[0].fps, 5);

  await f.control.kill({ reason: 'test' }, { who: 'person' });
  await until(() => got.close);
  assert.deepEqual(got.close, { code: 4403, reason: 'control-off' });
  assert.equal(got.text.at(-1).status, 'control-off');
  await until(() => !hub.status().capturing);

  // A fresh viewer while access is off: refused through the relay with the same status.
  const ws2 = new WebSocket(`ws://127.0.0.1:${front.address().port}/api/nodes/peer/screen/stream`);
  const got2 = { text: [], close: null };
  ws2.on('message', (d) => got2.text.push(JSON.parse(String(d))));
  ws2.on('close', (code, reason) => { got2.close = { code, reason: String(reason) }; });
  await until(() => got2.close);
  assert.equal(got2.text[0].status, 'control-off');
  assert.equal(got2.close.code, 4403);

  // The viewer leaving closes the upstream stream too.
  const g = fixture();
  const hub3 = createStreamHub({ control: g.control });
  const wss3 = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await new Promise((r) => wss3.on('listening', r));
  wss3.on('connection', (sock, req) => hub3.attachWs(sock, new URL(req.url, 'http://x').searchParams, {}));
  cleanups.push(() => wss3.close());
  const ws3 = new WebSocket(`ws://127.0.0.1:${wss3.address().port}/?fps=10`);
  let frames = 0;
  ws3.on('message', (d, bin) => { if (bin) frames++; });
  await until(() => frames >= 2);
  ws3.close();
  await until(() => !hub3.status().capturing);
});

test('relay close codes', () => {
  assert.equal(relayCloseCode(4403), 4403);
  assert.equal(relayCloseCode(1000), 1000);
  assert.equal(relayCloseCode(1005), 1000);
  assert.equal(relayCloseCode(1006), 1000);
});

test('a live stream is announced: broadcast on start/end and an attention item while it runs', async () => {
  const { wireControlEvents } = await import('../src/control-api.js');
  const events = new EventEmitter(), sent = [];
  const wired = wireControlEvents({ events, nodeName: () => 'peer', settings: () => ({}), broadcast: (m) => sent.push(m), notifyAll: async () => {}, osNotify: async () => {} });
  const caller = { from: 'macbookpro', who: 'person' };
  events.emit('stream', { phase: 'start', fps: 3, quality: 60, scale: 0.5, caller });
  const [item] = wired.items();
  assert.equal(item.key, 'control-stream:peer');
  assert.equal(item.title, 'This screen is being streamed');
  assert.deepEqual(item.stop, { method: 'POST', path: 'control/kill' });
  events.emit('stream', { phase: 'end', fps: 3, quality: 60, scale: 0.5, frames: 12, reason: 'control-off', caller });
  assert.deepEqual(wired.items(), []);
  assert.deepEqual(sent.map((m) => m.summary), ['screen stream start 3 fps', 'screen stream end after 12 frames — control-off']);
});
