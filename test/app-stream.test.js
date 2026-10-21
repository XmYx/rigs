// App streaming host (src/app-stream.js, docs/app-streaming.md): the pure parts (settings, size policy, compositor and
// encoder choice incl. the x264 fallback, pipelines, wire header, gate, flow control, input mapping, lifecycle) and the
// host manager end to end with a fake runner over its Unix socket, a WebSocket viewer, a peer relay (forwardWs), the
// screen-control kill and the app-streaming switch.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { test, after } from 'node:test';

// Unix socket paths are limited to ~104 bytes on macOS: keep the scratch homes short.
const root = fs.mkdtempSync(path.join(process.platform === 'win32' ? os.tmpdir() : '/tmp', 'ras-'));
process.env.RIGS_HOME = path.join(root, 'default');
const S = await import('../src/app-stream.js');
const { refusal: screenRefusal } = await import('../src/screen-stream.js');
const { forwardWs } = await import('../src/proxy.js');
const { PATCH_BLOCKED, defaults } = await import('../src/config.js');
const { WebSocket, WebSocketServer } = await import('ws');
const cleanups = [];
after(async () => { for (const c of cleanups.reverse()) await c(); fs.rmSync(root, { recursive: true, force: true }); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 3000) => { const end = Date.now() + ms; while (!fn()) { if (Date.now() > end) throw new Error('timed out'); await sleep(5); } };

// ---------------------------------------------------------------- pure parts

test('settings: defaults, clamping, and appStream is blocked from settings patches', () => {
  const d = S.streamSettings();
  assert.equal(d.enabled, true);
  assert.equal(d.maxSessions, 4);
  assert.equal(d.bitrate.balanced, 8000);
  const c = S.streamSettings({ enabled: false, fps: 500, maxSessions: 0, encoder: 'magic', allowFrom: ['a', 3], bitrate: { high: 1e9 } });
  assert.equal(c.enabled, false);
  assert.equal(c.fps, 120);
  assert.equal(c.maxSessions, 1);
  assert.equal(c.encoder, 'auto');
  assert.deepEqual(c.allowFrom, ['a']);
  assert.equal(c.bitrate.high, 100000);
  assert.ok(PATCH_BLOCKED.includes('appStream'));
  assert.deepEqual(S.streamSettings(defaults().appStream), d);
  assert.equal(S.bitrateFor({ quality: 'high' }), 16000);
  assert.equal(S.bitrateFor({ quality: 'nope' }), 8000);
  assert.equal(S.bitrateFor({ bitrateKbps: 99999999 }), 40000);
});

test('size policy: window × dpr, fixed, phone default, clamps and even sizes', () => {
  assert.deepEqual(S.sizeFor({ want: { fit: 'window', width: 800, height: 600, dpr: 2 } }), { width: 1600, height: 1200 });
  assert.deepEqual(S.sizeFor({ want: { fit: 'window', width: 801, height: 601, dpr: 3 } }), { width: 1602, height: 1202 }); // dpr capped at 2
  assert.deepEqual(S.sizeFor({ want: { fit: 'fixed', width: 1920, height: 1080 } }), { width: 1920, height: 1080 });
  assert.deepEqual(S.sizeFor({ phone: true }), { width: 1280, height: 720 });
  assert.deepEqual(S.sizeFor({}), { width: 1920, height: 1080 });
  assert.deepEqual(S.sizeFor({ want: { fit: 'fixed', width: 8000, height: 4000 } }), { width: 3840, height: 1920 }); // aspect kept
  assert.deepEqual(S.sizeFor({ want: { fit: 'fixed', width: 1920, height: 1080 }, caps: { maxWidth: 1280, maxHeight: 720 } }), { width: 1280, height: 720 });
  assert.deepEqual(S.sizeFor({ want: { fit: 'fixed', width: 100, height: 50 } }), { width: 640, height: 360 });
  assert.deepEqual(S.sizeFor({ want: { fit: 'fixed', width: 1281, height: 721 } }), { width: 1280, height: 720 });
});

test('compositor choice: mutter, the gnome-shell fallback, unsupported hosts', () => {
  assert.deepEqual(S.compositorFor({ platform: 'linux', mutter: true, gnomeShell: 50 }), { name: 'mutter', fallback: false });
  const fb = S.compositorFor({ platform: 'linux', mutter: false, gnomeShell: 50 });
  assert.equal(fb.name, 'gnome-shell');
  assert.equal(fb.fallback, true);
  assert.match(fb.hint, /Install mutter/);
  assert.equal(S.compositorFor({ platform: 'linux', mutter: true, gnomeShell: 50 }, 'gnome-shell').name, 'gnome-shell');
  assert.equal(S.compositorFor({ platform: 'linux', gnomeShell: 42 }).name, null);
  assert.match(S.compositorFor({ platform: 'linux' }).why, /GNOME\/mutter/);
  assert.match(S.compositorFor({ platform: 'darwin' }).why, /macOS/);
  assert.match(S.compositorFor({ platform: 'win32' }).why, /Windows/);
});

test('encoder choice: NVENC first on NVIDIA, VA-API next, x264 when there is no hardware encoder', () => {
  const all = { nvh264enc: true, glupload: true, cudaupload: true, vah264lpenc: true, x264enc: true, openh264enc: true };
  assert.deepEqual(S.pickEncoder({ gst: all, nvidia: true }).map((e) => `${e.name}/${e.path}`),
    ['nvh264enc/dmabuf-gl', 'nvh264enc/shm-cuda', 'vah264lpenc/va', 'x264enc/sw', 'openh264enc/sw']);
  // nvh264enc installed but no NVIDIA GPU: not tried.
  assert.equal(S.pickEncoder({ gst: all, nvidia: false })[0].name, 'vah264lpenc');
  assert.equal(S.pickEncoder({ gst: { vah264enc: true, x264enc: true } })[0].name, 'vah264enc');
  // No hardware encoder at all → the software fallback is selected.
  const sw = S.pickEncoder({ gst: { x264enc: true, nvh264enc: false }, nvidia: false });
  assert.deepEqual(sw[0], { name: 'x264enc', hw: false, path: 'sw' });
  assert.equal(S.pickEncoder({ gst: { openh264enc: true } })[0].name, 'openh264enc');
  assert.deepEqual(S.pickEncoder({ gst: {} }), []);
  // A forced preference goes first; a missing one falls through to the automatic order.
  assert.equal(S.pickEncoder({ gst: all, nvidia: true }, 'x264')[0].name, 'x264enc');
  assert.equal(S.pickEncoder({ gst: { nvh264enc: true, glupload: true, x264enc: true }, nvidia: true }, 'vaapi')[0].name, 'nvh264enc');
  const host = S.hostSummary({ platform: 'linux', gnomeShell: 50, gst: { x264enc: true }, missing: [] });
  assert.equal(host.supported, true);
  assert.equal(host.encoders[0].name, 'x264enc');
  assert.match(S.hostSummary({ platform: 'linux', gnomeShell: 50, gst: {}, missing: [] }).why, /no H\.264 encoder/);
  assert.match(S.hostSummary({ platform: 'linux', gnomeShell: 50, gst: { x264enc: true }, missing: ['gstreamer1.0-pipewire'] }).why, /missing packages/);
});

test('pipelines: one per encoder path, with the element names the runner needs', () => {
  const o = { width: 1920, height: 1080, fps: 60, kbps: 8000 };
  const dmabuf = S.pipelineFor({ name: 'nvh264enc', path: 'dmabuf-gl' }, o);
  assert.match(dmabuf, /^pipewiresrc name=src path=%NODE% do-timestamp=true keepalive-time=500/);
  assert.match(dmabuf, /memory:DMABuf\),width=1920,height=1080 ! glupload ! glcolorconvert/);
  assert.match(dmabuf, /nvh264enc name=enc preset=p1 tune=ultra-low-latency zerolatency=true bframes=0 gop-size=-1 rc-mode=cbr bitrate=8000 vbv-buffer-size=133/);
  assert.match(dmabuf, /profile=high,stream-format=byte-stream,alignment=au ! h264parse config-interval=-1 ! appsink name=out/);
  assert.match(S.pipelineFor({ name: 'nvh264enc', path: 'shm-cuda' }, o), /cudaupload ! cudaconvertscale/);
  assert.match(S.pipelineFor({ name: 'vah264lpenc', path: 'va' }, o), /vapostproc ! .* ! vah264lpenc name=enc rate-control=cbr bitrate=8000 key-int-max=0 b-frames=0/);
  const x264 = S.pipelineFor({ name: 'x264enc', path: 'sw' }, { ...o, fps: 30 });
  assert.match(x264, /videorate drop-only=true max-rate=30/);
  assert.match(x264, /x264enc name=enc speed-preset=ultrafast tune=zerolatency bitrate=8000 key-int-max=0 bframes=0/);
  assert.match(x264, /profile=constrained-baseline/);
  assert.doesNotMatch(dmabuf, /videorate/);
  assert.match(S.pipelineFor({ name: 'jpegenc' }, { ...o, transport: 'jpeg' }), /max-rate=15 ! videoconvert ! jpegenc name=enc quality=70 ! appsink name=out/);
});

test('wire header round trip and the runner socket framing', () => {
  const payload = Buffer.from([0, 0, 0, 1, 0x67, 1, 2, 3]);
  const b = S.encodeHeader({ kind: 1, flags: S.FLAGS.key | S.FLAGS.config, seq: 4294967295, captureUs: 123456789012345n, encodeUs: 4321, inputSeq: 7, width: 1920, height: 1080 }, payload);
  assert.equal(b.length, 32 + payload.length);
  const h = S.decodeHeader(b);
  assert.equal(h.kind, 1);
  assert.equal(h.key, true);
  assert.equal(h.flags, 3);
  assert.equal(h.seq, 4294967295);
  assert.equal(h.captureUs, 123456789012345n);
  assert.equal(h.encodeUs, 4321);
  assert.equal(h.inputSeq, 7);
  assert.equal(h.width, 1920);
  assert.equal(h.height, 1080);
  assert.deepEqual([...h.payload], [...payload]);
  assert.equal(S.decodeHeader(Buffer.alloc(10)), null);
  // A longer header (a future version) is skipped by its declared length.
  const longer = Buffer.concat([b.subarray(0, 32), Buffer.alloc(8), payload]);
  longer.writeUInt16LE(40, 2);
  assert.deepEqual([...S.decodeHeader(longer).payload], [...payload]);

  const read = S.messageReader();
  const all = Buffer.concat([S.packMessage(1, { ev: 'ready' }), S.packMessage(2, b)]);
  const got = [...read(all.subarray(0, 3)), ...read(all.subarray(3, 20)), ...read(all.subarray(20))];
  assert.equal(got.length, 2);
  assert.deepEqual(JSON.parse(got[0].body), { ev: 'ready' });
  assert.equal(got[1].type, 2);
  assert.equal(S.decodeHeader(got[1].body).seq, 4294967295);
});

test('gate: app streaming switch, kill, allowFrom, input, agents and roles; refusals in the screen-stream shape', () => {
  const on = S.streamSettings();
  const human = { from: 'macbookpro', human: true, via: 'tailnet' };
  assert.equal(S.gateDecision({ settings: on, caller: human }), null);
  assert.equal(S.gateDecision({ settings: on, caller: human, act: true }), null);
  const off = S.gateDecision({ settings: S.streamSettings({ enabled: false }), caller: human });
  assert.equal(off.status, 'appstream-off');
  assert.equal(S.gateDecision({ settings: on, killed: { at: 'x' }, caller: human }).status, 'appstream-off');
  assert.equal(S.gateDecision({ settings: S.streamSettings({ allowFrom: ['phone'] }), caller: human }).status, 'not-allowed');
  assert.equal(S.gateDecision({ settings: S.streamSettings({ allowFrom: ['macbookpro'] }), caller: human }), null);
  assert.equal(S.gateDecision({ settings: S.streamSettings({ input: false }), caller: human }), null); // viewing is fine
  assert.equal(S.gateDecision({ settings: S.streamSettings({ input: false }), caller: human, act: true }).status, 'input-off');
  assert.equal(S.gateDecision({ settings: on, caller: { from: 'x', agent: 'claude', via: 'mcp', human: false }, act: true }).code, 'agent');
  assert.equal(S.gateDecision({ settings: on, caller: { from: 'x', agent: 'claude', via: 'mcp', human: false } }), null); // agents may watch
  assert.equal(S.gateDecision({ settings: on, caller: human, act: true, role: 'viewer' }).code, 'viewer');

  // The ending a viewer gets has screen-stream's keys (status, code, message, close) and the same 4403 for a refusal.
  const e = S.ending(off);
  const screen = screenRefusal({ code: 'off', message: 'm' });
  assert.deepEqual(Object.keys(e).sort(), Object.keys(screen).sort());
  assert.equal(e.close, screen.close);
  assert.equal(S.ending({ status: 'no-session', message: 'x' }).close, 4404);
  assert.equal(S.ending({ status: 'unsupported', message: 'x' }).close, 4501);

  assert.equal(S.mayEnable({ enabled: false }, { agent: 'claude', via: 'mcp' }), null); // switching off: anyone
  assert.equal(S.mayEnable({ enabled: true }, { human: true }, 'node', 'node'), null);
  assert.equal(S.mayEnable({ enabled: true }, { human: true }, 'other', 'node').status, 'not-allowed');
  assert.equal(S.mayEnable({ input: true }, { human: false, agent: 'codex' }, 'node', 'node').status, 'not-allowed');
  assert.equal(S.controlEventEnds('kill', {}), true);
  assert.equal(S.controlEventEnds('change', { enabled: false }), true);
  assert.equal(S.controlEventEnds('change', { enabled: true }), false);
});

test('flow control: budget, keyframe-only catch-up, skip gate and AIMD', () => {
  assert.equal(S.budgetFor(60), 6);
  assert.equal(S.budgetFor(10), 2);
  let v = { lastSent: null, lastAck: null, needsIdr: true };
  // A new viewer waits for an IDR and asks for one.
  let r = S.flowStep(v, { seq: 1, key: false });
  assert.equal(r.send, false);
  assert.equal(r.requestIdr, true);
  r = S.flowStep(r.v, { seq: 2, key: true });
  assert.equal(r.send, true);
  v = r.v;
  for (let seq = 3; seq <= 7; seq++) { r = S.flowStep(v, { seq, key: false }, { fps: 60 }); assert.equal(r.send, true); v = r.v; }
  // 6 frames in flight and no ack: over budget → skip, congested, and from now on only an IDR resumes it.
  r = S.flowStep(v, { seq: 8, key: false }, { fps: 60 });
  assert.deepEqual([r.send, r.congested, r.v.needsIdr], [false, true, true]);
  assert.equal(S.overBudget(r.v, { fps: 60 }), true);
  assert.equal(S.shouldSkip([{ st: r.v, buffered: 0 }], { fps: 60 }), true);
  assert.equal(S.shouldSkip([{ st: r.v, buffered: 0 }, { st: { lastSent: 1, lastAck: 1 }, buffered: 0 }], { fps: 60 }), false);
  assert.equal(S.shouldSkip([], { fps: 60 }), false);
  // A viewer only waiting for an IDR is not over budget: the encoder must keep running (else nothing ever arrives).
  assert.equal(S.shouldSkip([{ st: { lastSent: null, lastAck: null, needsIdr: true }, buffered: 0 }], { fps: 60 }), false);
  v = { ...r.v, lastAck: 7 };
  r = S.flowStep(v, { seq: 9, key: false });
  assert.equal(r.send, false); // caught up, but a P-frame: still waiting
  assert.equal(r.requestIdr, true);
  r = S.flowStep(v, { seq: 10, key: true });
  assert.equal(r.send, true);
  assert.equal(r.v.lastAck, 9); // frames 8–9 were skipped, not in flight
  assert.equal(S.flowStep(r.v, { seq: 11, key: false }).send, true);
  assert.equal(S.flowStep({ lastSent: 7, lastAck: 5, needsIdr: true }, { seq: 12, key: true }).send, false); // still 2 in flight
  assert.equal(S.flowStep({ lastSent: 1, lastAck: 1 }, { seq: 2, key: false }, { buffered: S.MAX_BUFFERED + 1 }).congested, true);
  assert.equal(S.aimd(8000, { congested: true }), 5600);
  assert.equal(S.aimd(1200, { congested: true }), 1000);
  assert.equal(S.aimd(5600, { calmMs: 6000, target: 8000 }), 6160);
  assert.equal(S.aimd(7900, { calmMs: 6000, target: 8000 }), 8000);
  assert.equal(S.aimd(5600, { calmMs: 1000, target: 8000 }), 5600);
});

test('input: validation, clamping, coalescing and the evdev key table', () => {
  const b = S.validateInput({ seq: 5, e: [
    { k: 'pm', x: 10, y: 10 }, { k: 'pm', x: 5000, y: -3 }, { k: 'pb', b: 0, d: 1 }, { k: 'pb', b: 9, d: 1 },
    { k: 'pw', dx: 0, dy: 120 }, { k: 'pw', dx: 0, dy: 1, mode: 'line' }, { k: 'kc', c: 'KeyA', d: 1 }, { k: 'kc', c: 'NoSuchKey', d: 1 },
    { k: 'kc', c: 'Enter', d: 0 }, { k: 'tx', s: 'őű' }, { k: 'tx', s: 'a\0' }, { k: 'tc', id: 0, ph: 'down', x: 1, y: 1 }, { k: 'ra' }, { k: 'evil' }, null,
  ] }, { width: 1280, height: 720 });
  assert.equal(b.seq, 5);
  assert.deepEqual(b.e[0], { k: 'pm', x: 1279, y: 0 }); // two moves coalesced to the latest, clamped to the stream
  assert.deepEqual(b.e[1], { k: 'pb', b: 0, d: 1 });
  assert.deepEqual(b.e[2], { k: 'pw', dx: 0, dy: 120, mode: 'px' });
  assert.deepEqual(b.e[3], { k: 'pw', dx: 0, dy: 1, mode: 'line' });
  assert.deepEqual(b.e[4], { k: 'kc', c: 'KeyA', code: 30, d: 1 });
  assert.deepEqual(b.e[5], { k: 'kc', c: 'Enter', code: 28, d: 0 });
  assert.deepEqual(b.e[6], { k: 'tx', s: 'őű' });
  assert.equal(b.e[7].k, 'tc');
  assert.equal(b.e[8].k, 'ra');
  assert.equal(b.dropped, 5);
  assert.equal(S.validateInput({ seq: 1, e: Array.from({ length: 100 }, () => ({ k: 'pb', b: 0, d: 0 })) }).e.length, 64);
  assert.equal(S.validateInput({ seq: 1, e: [{ k: 'tx', s: 'x'.repeat(4001) }] }).e.length, 0);
  assert.equal(S.validateInput({ seq: -1 }).seq, 0);
  for (const [code, ev] of [['KeyZ', 44], ['Space', 57], ['ShiftLeft', 42], ['ControlLeft', 29], ['MetaLeft', 125], ['F12', 88], ['ArrowLeft', 105], ['IntlBackslash', 86], ['Backquote', 41]]) assert.equal(S.CODE_TO_EVDEV[code], ev, code);
});

test('lifecycle transitions', () => {
  assert.equal(S.nextState('starting', 'ready'), 'running');
  assert.equal(S.nextState('starting', 'error'), 'failed');
  assert.equal(S.nextState('running', 'last-viewer-left'), 'parked');
  assert.equal(S.nextState('parked', 'viewer-joined'), 'running');
  assert.equal(S.nextState('parked', 'park-expired'), 'stopping');
  assert.equal(S.nextState('running', 'kill'), 'parked');
  assert.equal(S.nextState('stopping', 'stopped'), 'ended');
  assert.equal(S.nextState('ended', 'ready'), 'ended');
  assert.equal(S.nextState('running', 'nonsense'), 'running');
  assert.match(S.newSessionId(), /^as-[0-9a-f]{8}$/);
});

// ---------------------------------------------------------------- host manager with a fake runner

/**
 * A fake runner: listens on the session socket like scripts/appstream/rigs-appstream-linux.py (or a RIGS Control app
 * session on macOS: `opts` gives its encoder, its own size and its ready event) and records the ops.
 */
function fakeRunner(socketPath, opts = {}) {
  const r = { ops: [], conns: [], width: 0, height: 0, seq: 0, timer: null, stopped: false, skip: false };
  // opts.honorSkip: like the real runner, a set skip gate drops raw frames before the encoder, so nothing comes out.
  const gated = () => opts.honorSkip && r.skip;
  const sendTo = (c, type, body) => c.write(S.packMessage(type, body));
  r.event = (obj) => { for (const c of r.conns) sendTo(c, 1, obj); };
  r.frame = (key) => {
    r.seq++;
    const f = S.encodeHeader({ kind: 1, flags: key ? 3 : 0, seq: r.seq, captureUs: 1n, width: r.width, height: r.height }, Buffer.from([0, 0, 0, 1, key ? 0x65 : 0x41, r.seq & 0xff]));
    for (const c of r.conns) sendTo(c, 2, f);
  };
  r.server = net.createServer((c) => {
    r.conns.push(c);
    const read = S.messageReader();
    c.on('data', (chunk) => {
      for (const m of read(chunk)) {
        const op = JSON.parse(m.body);
        r.ops.push(op);
        if (op.op === 'start-stream') {
          r.width = opts.size?.width ?? op.width; r.height = opts.size?.height ?? op.height;
          r.event({ ev: 'stream', encoder: opts.encoder || op.candidates[0].encoder, width: r.width, height: r.height, fps: op.fps, fallback: false });
          r.frame(true);
          clearInterval(r.timer);
          r.timer = setInterval(() => { if (!gated()) r.frame(false); }, 10);
        } else if (op.op === 'skip') r.skip = op.on;
        else if (op.op === 'keyframe') { if (!gated()) r.frame(true); }
        else if (op.op === 'stop-stream') clearInterval(r.timer);
        else if (op.op === 'stop') { r.stop(); }
      }
    });
    c.on('error', () => {});
    sendTo(c, 1, opts.ready || { ev: 'ready', compositor: 'gnome-shell', display: 'wayland-50' });
  });
  r.stop = () => { r.stopped = true; clearInterval(r.timer); for (const c of r.conns) c.destroy(); r.server.close(); };
  r.server.listen(socketPath);
  return r;
}

function host(over = {}) {
  const home = fs.mkdtempSync(path.join(root, 'h'));
  let cfg = { name: 'magix', appStream: {}, ...over.cfg };
  const control = { events: new EventEmitter() };
  const runners = [];
  const as = S.createAppStream({
    getConfig: () => cfg, persistConfig: (c) => { cfg = c; }, home, appDir: path.resolve('.'), nodeName: () => 'magix', control,
    findApp: async (id) => (id === 'ai.storyteller.filmcraft' ? { id, name: 'FilmCraft', streamable: true, launch: { kind: 'desktop', file: '/x/filmcraft.desktop', argv: ['/x/filmcraft'], dbus: false } } : null),
    run: async () => ({ code: 0, stdout: '', stderr: '' }), which: () => null, systemd: false, platform: 'linux',
    probe: async () => ({ platform: 'linux', gnomeShell: 50, mutter: false, nvidia: true, gst: { nvh264enc: true, glupload: true, cudaupload: true, x264enc: true }, missing: [] }),
    spawn: (cmd, args) => {
      runners.push(fakeRunner(args[args.indexOf('--socket') + 1], over.runner));
      return { pid: 0, unref() {} };
    },
  });
  cleanups.push(async () => { as.close(); for (const r of runners) if (!r.stopped) r.stop(); });
  return { as, control, runners, home, cfg: () => cfg };
}

async function wsHost(as) {
  const wss = new WebSocketServer({ noServer: true });
  const server = http.createServer();
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, 'http://x');
    const m = /\/appstream\/sessions\/([\w-]+)\/stream$/.exec(url.pathname);
    let agent = null;
    try { agent = req.headers['x-rigs-caller'] ? JSON.parse(req.headers['x-rigs-caller']) : null; } catch {}
    wss.handleUpgrade(req, socket, head, (ws) => as.attachWs(ws, m[1], url.searchParams, { from: req.headers['x-rigs-via'] || 'local', human: !agent, ...(agent ? { agent: agent.agent, via: 'mcp' } : {}) }));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  cleanups.push(() => new Promise((r) => server.close(r)));
  return server;
}

function viewer(url, { hello = { want: { fit: 'fixed', width: 1280, height: 720 } }, ack = true, headers = {} } = {}) {
  const v = { text: [], frames: [], close: null, ws: new WebSocket(url, { headers }) };
  v.ws.on('open', () => hello && v.ws.send(JSON.stringify({ type: 'hello', v: 1, caps: { decoders: ['webcodecs'] }, ...hello })));
  v.ws.on('message', (d, bin) => {
    if (!bin) return v.text.push(JSON.parse(String(d)));
    const h = S.decodeHeader(d);
    v.frames.push(h);
    if (ack) v.ws.send(JSON.stringify({ type: 'ack', seq: h.seq }));
  });
  v.ws.on('close', (code, reason) => { v.close = { code, reason: String(reason) }; });
  v.send = (o) => v.ws.send(JSON.stringify(o));
  return v;
}

test('host: start a session, stream to a viewer through the peer relay, input reaches the runner, stop cleans up', async () => {
  const h = host();
  const caller = { from: 'macbookpro', human: true, via: 'tailnet' };
  const r = await h.as.api('sessions', 'POST', null, async () => ({ app: 'ai.storyteller.filmcraft' }), caller);
  assert.equal(r.status, 201);
  const sess = r.body.session;
  assert.match(sess.id, /^as-[0-9a-f]{8}$/);
  assert.equal(sess.state, 'parked'); // ready, no viewer yet
  assert.equal(sess.compositor, 'gnome-shell');
  assert.ok(fs.existsSync(path.join(h.home, 'appstream', 'sessions', sess.id + '.json')));
  // reuse: the same app again returns the live session.
  const again = await h.as.api('sessions', 'POST', null, async () => ({ app: 'ai.storyteller.filmcraft' }), caller);
  assert.equal(again.status, 200);
  assert.equal(again.body.session.id, sess.id);
  await assert.rejects(h.as.api('sessions', 'POST', null, async () => ({ app: 'nope' }), caller), { name: 'AppStreamError', status: 404 });
  await assert.rejects(h.as.api('sessions', 'POST', null, async () => ({}), caller), { status: 400 });

  // Viewer on another machine: browser → front daemon → forwardWs → host daemon.
  const hostSrv = await wsHost(h.as);
  const seen = [];
  const front = http.createServer();
  front.on('upgrade', (req, socket, head) => {
    const m = /^\/api\/nodes\/([^/]+)\/(appstream\/sessions\/[\w-]+\/stream)$/.exec(new URL(req.url, 'http://x').pathname);
    seen.push(m[2]);
    forwardWs({ url: `http://127.0.0.1:${hostSrv.address().port}` }, req, socket, head, m[2]);
  });
  await new Promise((res) => front.listen(0, '127.0.0.1', res));
  cleanups.push(() => new Promise((res) => front.close(res)));
  const v = viewer(`ws://127.0.0.1:${front.address().port}/api/nodes/magix/appstream/sessions/${sess.id}/stream`);
  await until(() => v.frames.length >= 5);
  const hello = v.text.find((m) => m.type === 'hello');
  assert.deepEqual(hello.encoder, { name: 'nvh264enc', hw: true, path: 'dmabuf-gl' });
  assert.equal(hello.role, 'controller');
  assert.equal(hello.input, true);
  assert.equal(hello.width, 1280);
  assert.equal(v.frames[0].key, true); // the first frame a viewer gets is an IDR
  const run = h.runners[0];
  const start = run.ops.find((o) => o.op === 'start-stream');
  assert.equal(start.candidates[0].encoder.name, 'nvh264enc');
  assert.match(start.candidates.at(-1).desc, /x264enc/);
  assert.equal((await h.as.api('sessions/' + sess.id, 'GET', null, null, caller)).session.state, 'running');
  assert.deepEqual(h.as.attentionItems(), []); // a person streaming their own app is not an "agent needs you" item

  v.send({ type: 'in', seq: 3, e: [{ k: 'pm', x: 10, y: 20 }, { k: 'pb', b: 0, d: 1 }, { k: 'pb', b: 0, d: 0 }, { k: 'kc', c: 'KeyA', d: 1 }, { k: 'bogus' }] });
  await until(() => run.ops.some((o) => o.op === 'input'));
  assert.deepEqual(run.ops.find((o) => o.op === 'input'), { op: 'input', seq: 3, e: [{ k: 'pm', x: 10, y: 20 }, { k: 'pb', b: 0, d: 1 }, { k: 'pb', b: 0, d: 0 }, { k: 'kc', c: 'KeyA', code: 30, d: 1 }] });
  v.send({ type: 'ping', t0: 1 });
  await until(() => v.text.some((m) => m.type === 'pong'));
  v.send({ type: 'resize', width: 1600, height: 900 });
  await until(() => run.ops.some((o) => o.op === 'resize'));
  assert.deepEqual(run.ops.find((o) => o.op === 'resize'), { op: 'resize', width: 1600, height: 900 });

  // An agent watching through the relay is a viewer without input.
  const agent = viewer(`ws://127.0.0.1:${front.address().port}/api/nodes/magix/appstream/sessions/${sess.id}/stream`, { headers: { 'x-rigs-caller': JSON.stringify({ agent: 'claude' }) } });
  await until(() => agent.text.some((m) => m.type === 'hello'));
  assert.equal(agent.text.find((m) => m.type === 'hello').role, 'viewer');
  const items = h.as.attentionItems();
  assert.equal(items.length, 1);
  assert.match(items[0].title, /FilmCraft on magix is being watched by an agent/);
  assert.equal(typeof items[0].since, 'number');
  assert.equal(items[0].agent, 'claude');
  const before = run.ops.filter((o) => o.op === 'input').length;
  agent.send({ type: 'in', seq: 9, e: [{ k: 'pm', x: 1, y: 1 }] });
  await until(() => agent.text.some((m) => m.type === 'status' && m.code === 'agent'));
  assert.equal(run.ops.filter((o) => o.op === 'input').length, before);
  agent.ws.close();

  // Leaving parks the session; DELETE stops it and removes its files.
  v.ws.close();
  await until(() => h.as.sessions.get(sess.id).state === 'parked');
  assert.ok(run.ops.some((o) => o.op === 'stop-stream'));
  const del = await h.as.api('sessions/' + sess.id, 'DELETE', new URLSearchParams('force=1'), null, caller);
  assert.equal(del.ok, true);
  assert.equal(del.state, 'ended');
  assert.ok(run.ops.some((o) => o.op === 'stop' && o.force === true));
  assert.ok(!fs.existsSync(path.join(h.home, 'appstream', 'sessions', sess.id + '.json')));
  const audit = fs.readFileSync(path.join(h.home, 'logs', 'appstream.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l).op);
  for (const op of ['start', 'ready', 'join', 'leave', 'stop']) assert.ok(audit.includes(op), op);
});

test('host: a screen-control kill ends live viewers (4403 killed) and parks the session; app streaming off refuses start and input', async () => {
  const h = host();
  const caller = { from: 'macbookpro', human: true };
  const { body } = await h.as.api('sessions', 'POST', null, async () => ({ command: ['xterm'] }), caller);
  const srv = await wsHost(h.as);
  const url = `ws://127.0.0.1:${srv.address().port}/api/local/appstream/sessions/${body.session.id}/stream`;
  const v = viewer(url);
  await until(() => v.frames.length >= 2);
  const t = Date.now();
  h.control.events.emit('kill', { reason: 'test' });
  await until(() => v.close);
  assert.ok(Date.now() - t < 1000);
  assert.deepEqual(v.close, { code: 4403, reason: 'killed' });
  assert.equal(v.text.at(-1).status, 'killed');
  await until(() => h.as.sessions.get(body.session.id).state === 'parked');
  assert.ok(h.runners[0].ops.some((o) => o.op === 'release-all'));
  // A control switch-on is not a reason to end anything.
  const v2 = viewer(url);
  await until(() => v2.frames.length >= 1);
  h.control.events.emit('change', { enabled: true });
  await sleep(50);
  assert.equal(v2.close, null);
  h.control.events.emit('change', { enabled: false });
  await until(() => v2.close);
  assert.equal(v2.close.code, 4403);

  // App streaming killed: start and view refused in the error shape; the persisted kill survives a new instance.
  const v3 = viewer(url);
  await until(() => v3.frames.length >= 1);
  const k = await h.as.api('kill', 'POST', null, async () => ({ reason: 'test' }), caller);
  assert.equal(k.ended, 1);
  await until(() => v3.close);
  assert.deepEqual(v3.close, { code: 4403, reason: 'appstream-off' });
  await assert.rejects(h.as.api('sessions', 'POST', null, async () => ({ command: ['xterm'] }), caller), (e) => e.name === 'AppStreamError' && e.status === 403 && e.code === 'appstream-off');
  const v4 = viewer(url);
  await until(() => v4.close);
  assert.deepEqual(v4.close, { code: 4403, reason: 'appstream-off' });
  assert.deepEqual(Object.keys(v4.text[0]).sort(), ['code', 'message', 'status', 'type']);
  assert.ok(fs.readFileSync(path.join(h.home, 'appstream-state.json'), 'utf8').includes('killed'));
  // Only a confirmed human switches it back on.
  await assert.rejects(h.as.api('enable', 'POST', null, async () => ({ enabled: true, confirm: 'magix' }), { agent: 'claude', via: 'mcp', human: false }), { status: 403 });
  await assert.rejects(h.as.api('enable', 'POST', null, async () => ({ enabled: true, confirm: 'wrong' }), caller), { status: 403 });
  const st = await h.as.api('enable', 'POST', null, async () => ({ enabled: true, input: false, confirm: 'magix' }), caller);
  assert.equal(st.enabled, true);
  assert.equal(st.killed, null);
  // Input off: viewing works, input is refused and never reaches the runner.
  const v5 = viewer(url);
  await until(() => v5.frames.length >= 1);
  v5.send({ type: 'in', seq: 1, e: [{ k: 'pm', x: 1, y: 1 }] });
  await until(() => v5.text.some((m) => m.type === 'status' && m.status === 'input-off'));
  assert.ok(!h.runners[0].ops.some((o) => o.op === 'input'));
  v5.ws.close();
  await h.as.api('sessions/' + body.session.id, 'DELETE', new URLSearchParams('force=1'), null, caller);
});

test('host: slow viewer gets only keyframes until it catches up; unknown sessions and busy hosts are refused', async () => {
  const h = host({ cfg: { appStream: { maxSessions: 1 } } });
  const caller = { from: 'local', human: true };
  const { body } = await h.as.api('sessions', 'POST', null, async () => ({ command: ['glxgears'] }), caller);
  await assert.rejects(h.as.api('sessions', 'POST', null, async () => ({ command: ['xterm'] }), caller), { status: 409 });
  const srv = await wsHost(h.as);
  const base = `ws://127.0.0.1:${srv.address().port}/api/local/appstream/sessions/`;
  const slow = viewer(base + body.session.id + '/stream', { ack: false });
  await until(() => slow.frames.length >= 6);
  await sleep(100);
  // fps 60 → budget 6 frames in flight; without acks it stops at the budget and the encoder is told to skip.
  assert.equal(slow.frames.length, 6);
  await until(() => h.runners[0].ops.some((o) => o.op === 'skip' && o.on === true));
  await until(() => h.runners[0].ops.some((o) => o.op === 'bitrate')); // AIMD: congestion lowers the bitrate
  assert.ok(h.runners[0].ops.find((o) => o.op === 'bitrate').kbps < 8000);
  // Acking everything lets it resume — on a fresh keyframe, never a P-frame.
  slow.send({ type: 'ack', seq: slow.frames.at(-1).seq });
  await until(() => slow.frames.length >= 8);
  assert.equal(slow.frames[6].key, true);
  assert.ok(slow.frames[7].seq > slow.frames[6].seq);
  slow.ws.close();
  const none = viewer(base + 'as-00000000/stream');
  await until(() => none.close);
  assert.deepEqual(none.close, { code: 4404, reason: 'no-session' });
  await h.as.api('sessions/' + body.session.id, 'DELETE', new URLSearchParams('force=1'), null, caller);
});

// ---------------------------------------------------------------- macOS host (§3.6): shared desktop through RIGS Control

test('host: a viewer whose acks arrive later than the budget keeps getting frames (the skip gate lifts on acks)', async () => {
  // Regression (found in t4 with a real browser): WebCodecs acks ~130 ms late at 60 fps. The viewer goes over budget, the
  // skip gate stops the encoder, so no frame reaches the host again; only an ack can lift the gate and ask for an IDR.
  const h = host({ runner: { honorSkip: true } });
  const caller = { from: 'local', human: true };
  const { body } = await h.as.api('sessions', 'POST', null, async () => ({ command: ['glxgears'] }), caller);
  const srv = await wsHost(h.as);
  const v = viewer(`ws://127.0.0.1:${srv.address().port}/api/local/appstream/sessions/${body.session.id}/stream`, { ack: false });
  v.ws.on('message', (d, bin) => { if (bin) { const seq = S.decodeHeader(d).seq; setTimeout(() => v.ws.readyState === 1 && v.send({ type: 'ack', seq }), 150); } });
  await until(() => h.runners[0].ops.some((o) => o.op === 'skip' && o.on === true));
  const mark = v.frames.length;
  await sleep(1500);
  // Without the ack path it stalls for ever (no frame after the gate closes); with it the stream keeps going.
  assert.ok(v.frames.length - mark >= 10, `only ${v.frames.length - mark} frames after the gate closed`);
  assert.ok(h.runners[0].ops.some((o) => o.op === 'skip' && o.on === false));
  // The gate holds the encoder at the viewer's pace: raw frames are dropped, encoded ones never, so every frame the viewer
  // gets either follows the previous one or is an IDR (never a P-frame whose reference it did not get).
  assert.ok(v.frames.every((f, i) => i === 0 || f.key || f.seq === v.frames[i - 1].seq + 1));
  v.ws.close();
  await h.as.api('sessions/' + body.session.id, 'DELETE', new URLSearchParams('force=1'), null, caller);
});

test('macOS: compositor/encoder facts, the Mac key table, and control refusals in the app-stream shape', () => {
  assert.deepEqual(S.compositorFor({ platform: 'darwin', darwin: '25.3.0' }), { name: 'screencapturekit', fallback: false, shared: true });
  assert.equal(S.compositorFor({ platform: 'darwin', darwin: '21.4.0' }).name, 'screencapturekit'); // macOS 12.3
  assert.match(S.compositorFor({ platform: 'darwin', darwin: '21.3.0' }).why, /12\.3/);
  assert.deepEqual(S.pickEncoder({ platform: 'darwin' }), [{ name: 'h264_videotoolbox', hw: true, path: 'sck' }]);
  const host = S.hostSummary({ platform: 'darwin', darwin: '25.3.0', missing: [] });
  assert.equal(host.supported, true);
  assert.equal(host.shared, true);
  assert.match(host.note, /screen control/);
  // ANSI positions (kVK_*): the Mac's layout picks the characters, as at its own keyboard.
  for (const [code, vk] of Object.entries({ KeyA: 0, KeyS: 1, KeyZ: 6, KeyQ: 12, Digit1: 18, Digit0: 29, Enter: 36, Tab: 48, Space: 49, Backspace: 51, Escape: 53, MetaLeft: 55, ShiftLeft: 56, AltLeft: 58, ControlLeft: 59, ArrowLeft: 123, ArrowUp: 126, F1: 122, F12: 111, Delete: 117, IntlBackslash: 10 })) assert.equal(S.CODE_TO_MAC[code], vk, code);
  assert.equal(new Set(Object.values(S.CODE_TO_MAC)).size, Object.keys(S.CODE_TO_MAC).length);
  const missing = Object.keys(S.CODE_TO_EVDEV).filter((c) => !(c in S.CODE_TO_MAC));
  assert.deepEqual(missing.sort(), ['Insert', 'NumLock', 'Pause', 'PrintScreen', 'ScrollLock']);
  const b = S.validateInput({ seq: 1, e: [{ k: 'kc', c: 'KeyA', d: 1 }, { k: 'kc', c: 'Insert', d: 1 }, { k: 'kc', c: 'toString', d: 1 }] }, { keymap: S.CODE_TO_MAC });
  assert.deepEqual(b.e, [{ k: 'kc', c: 'KeyA', code: 0, d: 1 }]);
  assert.equal(b.dropped, 2);
  assert.equal(S.validateInput({ e: [{ k: 'kc', c: 'KeyA', d: 1 }] }).e[0].code, 30); // Linux keeps evdev
  assert.equal(S.controlRefusal(null), null);
  assert.deepEqual(S.controlRefusal({ code: 'off', message: 'x' }), { status: 'control-off', code: 'control-off', message: 'Screen control is off on this Mac, so its apps cannot be streamed. A person can switch it on in JARVIS → Access & control.' });
  const fix = { kind: 'grant', permission: 'screenCapture' };
  assert.deepEqual(S.controlRefusal({ code: 'needs-permission', message: 'm', fix }), { status: 'needs-permission', code: 'needs-permission', message: 'm', fix });
  assert.equal(S.controlRefusal({ code: 'busy', message: 'lease' }).status, 'busy-lease');
  assert.equal(S.controlRefusal({ code: 'locked', message: 'locked' }).status, 'locked');
  assert.equal(S.ending(S.controlRefusal({ code: 'needs-permission', message: 'm', fix })).close, 4412);
  assert.equal(S.ending(S.controlRefusal({ code: 'off', message: 'm' })).close, 4403);
});

/** A Mac host: control is a fake RIGS Control (gate state, appStream op that opens a fake session, inputStream). */
function macHost({ helperVersion = '2' } = {}) {
  const home = fs.mkdtempSync(path.join(root, 'm'));
  let cfg = { name: 'macbookpro', appStream: {} };
  const runners = [], starts = [], inputs = [], ended = [];
  const control = {
    events: new EventEmitter(), access: null, input: null, startError: null,
    accessFor(caller, act) { return control.access || (act && control.input === 'input-off' ? { code: 'input-off', message: 'Input control is off on this machine.' } : null); },
    async appStream(op, args, caller) {
      starts.push({ op, args, caller });
      if (control.startError) throw control.startError;
      runners.push(fakeRunner(args.socket, { encoder: { name: 'h264_videotoolbox', hw: true, path: 'sck-lowlatency' }, size: { width: 1600, height: 1000 }, ready: { ev: 'ready', compositor: 'screencapturekit', display: '1' } }));
      return { sid: args.sid, pid: 4242, launched: true, name: 'TextEdit' };
    },
    async inputStream(caller) { inputs.push(caller); return control.input ? { code: control.input, message: `refused: ${control.input}` } : null; },
    inputStreamEnd(caller) { ended.push(caller); },
    async status() { return { backend: { helper: { running: true, version: helperVersion } } }; },
  };
  const as = S.createAppStream({
    getConfig: () => cfg, persistConfig: (c) => { cfg = c; }, home, appDir: path.resolve('.'), nodeName: () => 'macbookpro', control, platform: 'darwin',
    findApp: async (id) => (id === 'com.apple.TextEdit' ? { id, name: 'TextEdit', streamable: true, launch: { kind: 'bundle', path: '/System/Applications/TextEdit.app' } } : null),
    run: async () => ({ code: 0, stdout: '', stderr: '' }), which: () => null, systemd: false, spawn: () => { throw new Error('no runner process on macOS'); },
    probe: async ({ platform }) => ({ platform, darwin: '25.3.0', missing: [] }),
  });
  cleanups.push(async () => { as.close(); for (const r of runners) if (!r.stopped) r.stop(); });
  return { as, control, runners, starts, inputs, ended, home };
}

test('macOS host: control off or a missing grant refuse the start precisely; an out-of-date RIGS Control says how to update', async () => {
  const caller = { from: 'magix-system', human: true, via: 'tailnet' };
  const m = macHost();
  m.control.access = { code: 'off', message: 'Screen access is off on this machine (switched off or stopped).' };
  await assert.rejects(m.as.api('sessions', 'POST', null, async () => ({ app: 'com.apple.TextEdit' }), caller),
    (e) => e.name === 'AppStreamError' && e.status === 403 && e.code === 'control-off' && /Screen control is off on this Mac/.test(e.message));
  assert.equal(m.starts.length, 0);
  const status = await m.as.api('', 'GET', null, null, caller);
  assert.equal(status.host.supported, true);
  assert.equal(status.host.compositor, 'screencapturekit');
  // Control on, but RIGS Control lacks Screen Recording: 412 with the grant fix, nothing left behind.
  m.control.access = null;
  const fix = { kind: 'grant', permission: 'screenCapture', text: 'switch on RIGS Control in Screen Recording' };
  m.control.startError = Object.assign(new Error('screenshot needs Screen Recording for RIGS Control.app, which is not granted on macbookpro'), { code: 'needs-permission', fix });
  await assert.rejects(m.as.api('sessions', 'POST', null, async () => ({ app: 'com.apple.TextEdit' }), caller), (e) => e.status === 412 && e.code === 'needs-permission' && e.fix === fix);
  assert.equal(m.as.sessions.size, 1);
  assert.equal([...m.as.sessions.values()][0].state, 'failed');
  assert.deepEqual(fs.readdirSync(path.join(m.home, 'appstream', 'sessions')), []);
  const old = macHost({ helperVersion: '1' });
  await assert.rejects(old.as.api('sessions', 'POST', null, async () => ({ app: 'com.apple.TextEdit' }), caller), (e) => e.status === 501 && /version 1/.test(e.message) && /helper install/.test(e.fix.text));
  // A command on macOS is an .app bundle (plus files), never an arbitrary argv.
  await assert.rejects(m.as.api('sessions', 'POST', null, async () => ({ command: ['/usr/bin/xterm'] }), caller), { status: 501 });
});

test('macOS host: RIGS Control session streams VideoToolbox frames; input needs control\'s lease per batch and uses Mac key codes; control off ends viewers', async () => {
  const caller = { from: 'magix-system', human: true, via: 'tailnet' };
  const m = macHost();
  const r = await m.as.api('sessions', 'POST', null, async () => ({ app: 'com.apple.TextEdit', files: ['/tmp/note.txt'] }), caller);
  assert.equal(r.status, 201);
  const sess = r.body.session;
  assert.deepEqual(m.starts[0].args, { sid: sess.id, socket: path.join(m.home, 'run', 'appstream', sess.id + '.sock'), path: '/System/Applications/TextEdit.app', files: ['/tmp/note.txt'] });
  assert.equal(m.starts[0].caller, caller);
  assert.equal(sess.host, 'shared-desktop');
  assert.equal(sess.appPid, 4242);
  assert.equal(sess.compositor, 'screencapturekit');
  assert.equal(sess.state, 'parked');

  const srv = await wsHost(m.as);
  const url = `ws://127.0.0.1:${srv.address().port}/api/local/appstream/sessions/${sess.id}/stream`;
  const v = viewer(url);
  await until(() => v.frames.length >= 3);
  const hello = v.text.find((x) => x.type === 'hello');
  assert.deepEqual(hello.encoder, { name: 'h264_videotoolbox', hw: true, path: 'sck-lowlatency' });
  assert.equal(hello.width, 1600); // the window's size, not the viewer's
  assert.equal(hello.input, true);
  const run = m.runners[0];
  const start = run.ops.find((o) => o.op === 'start-stream');
  assert.equal(start.candidates[0].desc, null);
  assert.equal(start.maxWidth, 3840);

  v.send({ type: 'in', seq: 4, e: [{ k: 'pm', x: 10, y: 20 }, { k: 'kc', c: 'KeyA', d: 1 }, { k: 'kc', c: 'KeyA', d: 0 }, { k: 'kc', c: 'PrintScreen', d: 1 }] });
  await until(() => run.ops.some((o) => o.op === 'input'));
  assert.deepEqual(run.ops.find((o) => o.op === 'input'), { op: 'input', seq: 4, e: [{ k: 'pm', x: 10, y: 20 }, { k: 'kc', c: 'KeyA', code: 0, d: 1 }, { k: 'kc', c: 'KeyA', code: 0, d: 0 }] });
  assert.equal(m.inputs.length, 1);
  // Resize moves a real window: only through the input gate.
  v.send({ type: 'resize', width: 1200, height: 800 });
  await until(() => run.ops.some((o) => o.op === 'resize'));
  assert.equal(m.inputs.length, 2);
  // An agent holds control's lease (or the screen is locked): the batch is refused with a status, never forwarded.
  m.control.input = 'busy';
  v.send({ type: 'in', seq: 5, e: [{ k: 'pm', x: 1, y: 1 }] });
  v.send({ type: 'clipboard', text: 'secret' });
  await until(() => v.text.some((x) => x.type === 'status' && x.status === 'busy-lease'));
  await sleep(30);
  assert.equal(run.ops.filter((o) => o.op === 'input').length, 1);
  assert.ok(!run.ops.some((o) => o.op === 'clipboard-set'));
  assert.equal(v.text.filter((x) => x.type === 'status' && x.status === 'busy-lease').length, 1);
  m.control.input = null;
  v.send({ type: 'in', seq: 6, e: [{ k: 'tx', s: 'őű' }] });
  await until(() => run.ops.filter((o) => o.op === 'input').length === 2);

  // RIGS Control lost Screen Recording mid-stream: the viewer ends with the grant fix.
  run.event({ ev: 'error', code: 'needs-permission', message: 'RIGS Control needs Screen Recording to stream TextEdit' });
  await until(() => v.close);
  assert.deepEqual(v.close, { code: 4412, reason: 'needs-permission' });
  assert.equal(v.text.at(-1).fix.permission, 'screenCapture');
  await until(() => m.ended.length === 1); // the controller left: control audits the end of its input run

  // Screen control switched off (no event, e.g. config): the 500 ms re-check ends the viewer as control-off.
  const v2 = viewer(url);
  await until(() => v2.frames.length >= 1);
  const t = Date.now();
  m.control.access = { code: 'off', message: 'off' };
  await until(() => v2.close, 2000);
  assert.ok(Date.now() - t < 1200);
  assert.deepEqual(v2.close, { code: 4403, reason: 'control-off' });
  // ... and new viewers are refused at once.
  const v3 = viewer(url);
  await until(() => v3.close);
  assert.deepEqual(v3.close, { code: 4403, reason: 'control-off' });

  // DELETE asks RIGS Control to stop the session; the daemon never signals the app's pid itself.
  const kill = process.kill;
  const killed = [];
  process.kill = (pid, sig) => { killed.push([pid, sig]); return true; };
  try {
    const del = await m.as.api('sessions/' + sess.id, 'DELETE', null, null, caller);
    assert.equal(del.state, 'ended');
  } finally { process.kill = kill; }
  assert.ok(run.ops.some((o) => o.op === 'stop' && o.force === false));
  assert.deepEqual(killed, []);
});
