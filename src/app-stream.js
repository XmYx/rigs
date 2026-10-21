/**
 * RIGS app streaming, host side (binding design: docs/app-streaming.md). One app = one isolated headless compositor on a
 * private D-Bus bus, run by a per-session Python runner (scripts/appstream/rigs-appstream-linux.py) in a transient
 * `systemd --user` unit so a daemon restart never kills an app with unsaved work. The runner captures the session's
 * virtual monitor, encodes H.264 (NVENC → VA-API → x264) and talks to the daemon over a Unix socket; this module keeps
 * the session registry, supervises runners, serves viewers over WebSocket (/api/local/appstream/sessions/<sid>/stream,
 * relayed by forwardWs as /api/nodes/<n>/appstream/...), applies the gate (§6) and flow control (§5.6), and audits.
 *
 * Gate (§6): isolated sessions have their own switch config.appStream (enabled/input/allowFrom, in PATCH_BLOCKED) and a
 * persistent kill in RIGS_HOME/appstream-state.json. A screen-control kill or switch-off ends every live viewer at once
 * (status 'killed', close 4403) and parks the sessions. Refusals use screen-stream's error shape: a text
 * {type:'error', status, code, message, fix?} and a 44xx/45xx close; over HTTP {error, code, status}.
 *
 * The pure parts (settings, size policy, compositor/encoder choice, pipelines, wire header, gate, flow control, input
 * validation, lifecycle) are exported for test/app-stream.test.js.
 */
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

// ---------------------------------------------------------------- pure: settings

export const DEFAULTS = Object.freeze({
  enabled: true, input: true, allowFrom: [], maxSessions: 4, parkMinutes: 120, encoder: 'auto', compositor: 'auto',
  fps: 60, maxWidth: 3840, maxHeight: 2160, bitrate: { low: 3000, balanced: 8000, high: 16000, max: 40000 }, clipboard: true, audio: false,
});
const QUALITIES = ['low', 'balanced', 'high', 'max'];
const clampNum = (v, lo, hi, fallback) => {
  const n = v == null || v === '' ? NaN : Number(v);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : fallback;
};

/** config.appStream with defaults filled in and every number clamped. Never throws. */
export function streamSettings(cfg = {}) {
  const c = cfg && typeof cfg === 'object' ? cfg : {};
  const br = { ...DEFAULTS.bitrate };
  for (const q of QUALITIES) br[q] = Math.round(clampNum(c.bitrate?.[q], 500, 100000, DEFAULTS.bitrate[q]));
  return {
    enabled: c.enabled !== false, input: c.input !== false,
    allowFrom: Array.isArray(c.allowFrom) ? c.allowFrom.filter((x) => typeof x === 'string') : [],
    maxSessions: Math.round(clampNum(c.maxSessions, 1, 32, DEFAULTS.maxSessions)),
    parkMinutes: clampNum(c.parkMinutes, 1, 7 * 24 * 60, DEFAULTS.parkMinutes),
    encoder: ['auto', 'nvenc', 'vaapi', 'x264'].includes(c.encoder) ? c.encoder : 'auto',
    compositor: ['auto', 'mutter', 'gnome-shell'].includes(c.compositor) ? c.compositor : 'auto',
    fps: Math.round(clampNum(c.fps, 5, 120, DEFAULTS.fps)),
    maxWidth: Math.round(clampNum(c.maxWidth, 640, 7680, DEFAULTS.maxWidth)),
    maxHeight: Math.round(clampNum(c.maxHeight, 360, 4320, DEFAULTS.maxHeight)),
    bitrate: br, clipboard: c.clipboard !== false, audio: false,
  };
}

/** The target bitrate (kbit/s) for a quality preset or an explicit value, within [500, preset max]. */
export function bitrateFor({ quality, bitrateKbps } = {}, prefs = streamSettings()) {
  if (bitrateKbps != null && Number.isFinite(Number(bitrateKbps))) return Math.round(clampNum(bitrateKbps, 500, prefs.bitrate.max, prefs.bitrate.balanced));
  return prefs.bitrate[QUALITIES.includes(quality) ? quality : 'balanced'];
}

/**
 * The stream size (§5.2) from the viewer's `want` ({fit, width, height, dpr}) and decoder caps ({maxWidth, maxHeight}).
 * window: CSS px × min(dpr, 2); fixed: the given size (phones default to 1280x720). Clamped to [640×360, max], even.
 */
export function sizeFor({ want = {}, caps = {}, prefs = streamSettings(), phone = false } = {}) {
  const dpr = clampNum(want.dpr, 0.5, 2, 1);
  let w, h;
  if ((want.fit || (phone ? 'fixed' : 'window')) === 'window' && Number(want.width) > 0 && Number(want.height) > 0) {
    w = Number(want.width) * dpr; h = Number(want.height) * dpr;
  } else if (Number(want.width) > 0 && Number(want.height) > 0) { w = Number(want.width); h = Number(want.height); } else { w = phone ? 1280 : 1920; h = phone ? 720 : 1080; }
  const maxW = Math.min(prefs.maxWidth, clampNum(caps.maxWidth, 640, 16384, prefs.maxWidth));
  const maxH = Math.min(prefs.maxHeight, clampNum(caps.maxHeight, 360, 16384, prefs.maxHeight));
  // Shrink both sides together when one is over its limit (keeps the aspect ratio), then the per-side minimums.
  const s = Math.min(1, maxW / w, maxH / h);
  w = Math.max(640, Math.min(maxW, Math.round(w * s)));
  h = Math.max(360, Math.min(maxH, Math.round(h * s)));
  // Portrait viewers (phones) may have a side under 640/360 after the minimum swap: accept ≥ 16 px.
  return { width: Math.max(16, w - (w % 2)), height: Math.max(16, h - (h % 2)) };
}

// ---------------------------------------------------------------- pure: host choices

/**
 * Which headless compositor runs sessions (§3.2). facts = { platform, mutter: bool, gnomeShell: major version | null }.
 * → { name: 'mutter' | 'gnome-shell', fallback: bool } or { name: null, why }.
 */
export function compositorFor(facts = {}, pref = 'auto') {
  if (facts.platform && facts.platform !== 'linux') return { name: null, why: facts.platform === 'darwin' ? 'macOS hosting is not available yet' : 'Windows hosting is designed but not built yet' };
  const shell = Number(facts.gnomeShell) >= 45;
  if (facts.mutter && pref !== 'gnome-shell') return { name: 'mutter', fallback: false };
  if (shell && pref !== 'mutter') return { name: 'gnome-shell', fallback: true, hint: 'Install mutter for lighter, fully isolated sessions' };
  if (facts.mutter) return { name: 'mutter', fallback: false };
  return { name: null, why: 'isolated app sessions need GNOME/mutter on Linux (KDE/wlroots hosts are not supported yet)' };
}

/**
 * The encoders to try, best first (§4.1). facts = { gst: {element: bool}, nvidia: bool }; pref = auto|nvenc|vaapi|x264.
 * Each entry is { name, hw, path }. A forced choice that is missing falls through to the automatic order.
 */
export function pickEncoder(facts = {}, pref = 'auto') {
  const g = facts.gst || {};
  const nv = g.nvh264enc && facts.nvidia ? [
    ...(g.glupload ? [{ name: 'nvh264enc', hw: true, path: 'dmabuf-gl' }] : []),
    ...(g.cudaupload ? [{ name: 'nvh264enc', hw: true, path: 'shm-cuda' }] : []),
  ] : [];
  const va = g.vah264lpenc ? [{ name: 'vah264lpenc', hw: true, path: 'va' }] : g.vah264enc ? [{ name: 'vah264enc', hw: true, path: 'va' }] : [];
  const sw = [...(g.x264enc ? [{ name: 'x264enc', hw: false, path: 'sw' }] : []), ...(g.openh264enc ? [{ name: 'openh264enc', hw: false, path: 'sw' }] : [])];
  const order = pref === 'vaapi' ? [...va, ...nv, ...sw] : pref === 'x264' ? [...sw, ...nv, ...va] : [...nv, ...va, ...sw];
  return order;
}

/**
 * The GStreamer pipeline for one encoder (§4.2). `%NODE%` is the PipeWire node the runner fills in. Element names the
 * runner relies on: src (pipewiresrc), enc (encoder), out (appsink).
 */
export function pipelineFor(enc, { width, height, fps = 60, kbps = 8000, transport = 'h264' } = {}) {
  const W = Math.round(width), H = Math.round(height), F = Math.round(fps), K = Math.round(kbps);
  const head = 'pipewiresrc name=src path=%NODE% do-timestamp=true keepalive-time=500 always-copy=false';
  const rate = F < 60 ? ` ! videorate drop-only=true max-rate=${F}` : '';
  const sink = 'appsink name=out emit-signals=true sync=false max-buffers=4 drop=false';
  if (transport === 'jpeg') {
    return `${head} ! video/x-raw,width=${W},height=${H} ! videorate drop-only=true max-rate=${Math.min(F, 15)} ! videoconvert ! jpegenc name=enc quality=70 ! ${sink}`;
  }
  const tail = (profile) => ` ! video/x-h264,profile=${profile},stream-format=byte-stream,alignment=au ! h264parse config-interval=-1 ! ${sink}`;
  const nv = `nvh264enc name=enc preset=p1 tune=ultra-low-latency zerolatency=true bframes=0 gop-size=-1 rc-mode=cbr bitrate=${K} vbv-buffer-size=${Math.max(1, Math.round(K / F))} aud=false`;
  if (enc?.name === 'nvh264enc' && enc.path === 'dmabuf-gl') return `${head} ! video/x-raw(memory:DMABuf),width=${W},height=${H}${rate} ! glupload ! glcolorconvert ! video/x-raw(memory:GLMemory),format=NV12 ! ${nv}${tail('high')}`;
  if (enc?.name === 'nvh264enc') return `${head} ! video/x-raw,width=${W},height=${H}${rate} ! queue max-size-buffers=2 leaky=downstream ! cudaupload ! cudaconvertscale ! video/x-raw(memory:CUDAMemory),format=NV12 ! ${nv}${tail('high')}`;
  if (enc?.name === 'vah264lpenc' || enc?.name === 'vah264enc') return `${head} ! video/x-raw(memory:DMABuf),width=${W},height=${H}${rate} ! vapostproc ! video/x-raw(memory:VAMemory),format=NV12 ! ${enc.name} name=enc rate-control=cbr bitrate=${K} key-int-max=0 b-frames=0 target-usage=7${tail('high')}`;
  if (enc?.name === 'openh264enc') return `${head} ! video/x-raw,width=${W},height=${H}${rate} ! videoconvert ! video/x-raw,format=I420 ! openh264enc name=enc bitrate=${K * 1000} gop-size=2147483647 rate-control=bitrate${tail('constrained-baseline')}`;
  return `${head} ! video/x-raw,width=${W},height=${H}${rate} ! videoconvert n-threads=4 ! video/x-raw,format=I420 ! x264enc name=enc speed-preset=ultrafast tune=zerolatency bitrate=${K} key-int-max=0 bframes=0 sliced-threads=true byte-stream=true${tail('constrained-baseline')}`;
}

// ---------------------------------------------------------------- pure: wire format (§5.3)

export const HEADER_LEN = 32;
export const KIND = Object.freeze({ h264: 1, audio: 2, jpeg: 3 });
export const FLAGS = Object.freeze({ key: 1, config: 2, discontinuity: 4, repeat: 8 });

/** A media frame header (32 bytes, little-endian) + payload. */
export function encodeHeader({ kind = 1, flags = 0, seq = 0, captureUs = 0n, encodeUs = 0, inputSeq = 0, width = 0, height = 0 } = {}, payload = Buffer.alloc(0)) {
  const b = Buffer.alloc(HEADER_LEN + payload.length);
  b.writeUInt8(kind, 0); b.writeUInt8(flags, 1); b.writeUInt16LE(HEADER_LEN, 2); b.writeUInt32LE(seq >>> 0, 4);
  b.writeBigUInt64LE(BigInt(captureUs), 8); b.writeUInt32LE(encodeUs >>> 0, 16); b.writeUInt32LE(inputSeq >>> 0, 20);
  b.writeUInt16LE(width, 24); b.writeUInt16LE(height, 26); b.writeUInt32LE(0, 28);
  payload.copy(b, HEADER_LEN);
  return b;
}

/** Parse a media frame; null when it is too short. Readers skip header bytes beyond the 32 they know. */
export function decodeHeader(buf) {
  if (!buf || buf.length < HEADER_LEN) return null;
  const len = buf.readUInt16LE(2);
  if (len < HEADER_LEN || len > buf.length) return null;
  const flags = buf.readUInt8(1);
  return {
    kind: buf.readUInt8(0), flags, key: !!(flags & FLAGS.key), headerLength: len, seq: buf.readUInt32LE(4),
    captureUs: buf.readBigUInt64LE(8), encodeUs: buf.readUInt32LE(16), inputSeq: buf.readUInt32LE(20),
    width: buf.readUInt16LE(24), height: buf.readUInt16LE(26), payload: buf.subarray(len),
  };
}

/** Daemon ↔ runner socket messages: u32 LE body length + u8 type (1 JSON, 2 media frame) + body. */
export function packMessage(type, body) {
  const b = Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body));
  const h = Buffer.alloc(5);
  h.writeUInt32LE(b.length, 0); h.writeUInt8(type, 4);
  return Buffer.concat([h, b]);
}

/** Incremental reader for packMessage frames: push(chunk) → [{ type, body }]. */
export function messageReader(max = 64 * 1024 * 1024) {
  let buf = Buffer.alloc(0);
  return (chunk) => {
    buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
    const out = [];
    while (buf.length >= 5) {
      const n = buf.readUInt32LE(0);
      if (n > max) throw new Error('runner message too large');
      if (buf.length < 5 + n) break;
      out.push({ type: buf.readUInt8(4), body: buf.subarray(5, 5 + n) });
      buf = buf.subarray(5 + n);
    }
    return out;
  };
}

// ---------------------------------------------------------------- pure: gate (§6) and endings (§5.5)

export const ENDINGS = Object.freeze({
  'bad-args': { close: 4400, http: 400 },
  'appstream-off': { close: 4403, http: 403 },
  'input-off': { close: 4403, http: 403 },
  'not-allowed': { close: 4403, http: 403 },
  killed: { close: 4403, http: 403 },
  'control-off': { close: 4403, http: 403 },
  'no-session': { close: 4404, http: 404 },
  busy: { close: 4409, http: 409 },
  ended: { close: 4410, http: 410 },
  'needs-permission': { close: 4412, http: 412 },
  unsupported: { close: 4501, http: 501 },
  'host-restart': { close: 4503, http: 503 },
});

/** A refusal { status, code, message } as the ending a viewer gets: the screen-stream shape plus the close code. */
export const ending = (r) => ({ end: true, status: r.status, code: r.code || r.status, message: r.message, ...(r.fix ? { fix: r.fix } : {}), close: ENDINGS[r.status]?.close || 4403 });

/**
 * May `caller` start/view (act=false) or send input (act=true)? Pure: null when allowed, else { status, code, message }.
 * settings = streamSettings(config.appStream); killed = the persisted kill marker or null. Input is only for a human
 * viewer (no agent x-rigs-caller, not via MCP) in the controller role.
 */
export function gateDecision({ settings = streamSettings(), killed = null, caller = {}, act = false, role = 'controller' } = {}) {
  if (!settings.enabled || killed) return { status: 'appstream-off', code: 'off', message: 'App streaming is off on this machine. A person can switch it on in JARVIS → Access & control.' };
  if (settings.allowFrom.length && !settings.allowFrom.includes(caller.from)) return { status: 'not-allowed', code: 'not-allowed', message: 'Caller node is not in appStream.allowFrom' };
  if (!act) return null;
  if (!settings.input) return { status: 'input-off', code: 'input-off', message: 'Input to streamed apps is off on this machine.' };
  if (caller.agent || caller.via === 'mcp' || caller.human === false) return { status: 'not-allowed', code: 'agent', message: 'Agents may not send input to a streamed app' };
  if (role !== 'controller') return { status: 'not-allowed', code: 'viewer', message: 'Another viewer has control; send take-control first' };
  return null;
}

/** May this caller switch app streaming on (same rule as control.enable)? Switching off is open to every caller. */
export function mayEnable({ enabled, input } = {}, caller = {}, confirm, nodeName) {
  const grants = enabled === true || input === true;
  if (!grants) return null;
  if (caller.human !== true || caller.agent || caller.via === 'mcp' || confirm !== nodeName) return { status: 'not-allowed', code: 'not-allowed', message: 'Only a confirmed human surface may switch app streaming on; confirm must match this machine name' };
  return null;
}

/** Does a screen-control event end live app-stream viewers? A kill always; a change only when it switches control off. */
export const controlEventEnds = (type, ev = {}) => type === 'kill' || (type === 'change' && ev.enabled === false);

// ---------------------------------------------------------------- pure: flow control (§5.6)

export const MAX_BUFFERED = 2 * 1024 * 1024;
export const budgetFor = (fps) => Math.max(2, Math.ceil(fps * 0.1));

/**
 * One frame for one viewer. v = { lastSent, lastAck, needsIdr }; frame = { seq, key }. Returns { send, v, requestIdr,
 * congested }. A viewer over budget gets nothing but keyframes until it has caught up, so it never receives a P-frame
 * whose reference it did not get.
 */
export function flowStep(v, frame, { fps = 60, buffered = 0 } = {}) {
  const inflight = v.lastSent == null ? 0 : Math.max(0, v.lastSent - (v.lastAck ?? v.lastSent));
  if (v.needsIdr) {
    // Resume only when nothing is in flight; the frames skipped meanwhile were never sent, so the ack baseline restarts here.
    if (frame.key && inflight === 0 && buffered <= MAX_BUFFERED) return { send: true, v: { ...v, needsIdr: false, lastSent: frame.seq, lastAck: frame.seq - 1 }, requestIdr: false, congested: false };
    return { send: false, v, requestIdr: inflight === 0 && buffered <= MAX_BUFFERED, congested: false };
  }
  if (inflight >= budgetFor(fps) || buffered > MAX_BUFFERED) return { send: false, v: { ...v, needsIdr: true }, requestIdr: false, congested: true };
  // The first frame sent sets the ack baseline: from then on every unacked frame counts as in flight.
  return { send: true, v: { ...v, lastSent: frame.seq, lastAck: v.lastAck ?? frame.seq - 1 }, requestIdr: false, congested: false };
}

/** Is this viewer over its budget (frames in flight or bytes buffered)? Waiting for an IDR alone is not. */
export function overBudget(v, { fps = 60, buffered = 0 } = {}) {
  const inflight = v.lastSent == null ? 0 : Math.max(0, v.lastSent - (v.lastAck ?? v.lastSent));
  return inflight >= budgetFor(fps) || buffered > MAX_BUFFERED;
}

/** Drop raw frames before the encoder only when every viewer is over budget (§5.6); never with no viewer at all. */
export const shouldSkip = (viewers, opts) => viewers.length > 0 && viewers.every((v) => overBudget(v.st, { ...opts, buffered: v.buffered }));

/** AIMD bitrate: ×0.7 on congestion (floor 1000), +10 % after 5 s calm, up to the preset. */
export function aimd(current, { congested = false, calmMs = 0, target } = {}) {
  if (congested) return Math.max(1000, Math.round(current * 0.7));
  if (calmMs >= 5000 && current < target) return Math.min(target, Math.round(current * 1.1));
  return current;
}

// ---------------------------------------------------------------- pure: input (§5.3, §5.4)

const BUTTONS = [0, 1, 2, 3, 4];
const num = (v) => typeof v === 'number' && Number.isFinite(v);
const CODE_RE = /^[A-Za-z0-9]{1,24}$/;

/**
 * Validate one input batch {seq, e:[…]} against the stream size. → { seq, e, dropped }: invalid events are dropped
 * (and counted), more than 64 events are cut, and consecutive pointer moves are coalesced to the latest.
 */
export function validateInput(batch = {}, { width = 1e5, height = 1e5, maxEvents = 64 } = {}) {
  const seq = Number.isInteger(batch.seq) && batch.seq >= 0 ? batch.seq >>> 0 : 0;
  const list = Array.isArray(batch.e) ? batch.e : [];
  const out = [];
  let dropped = 0;
  for (const ev of list.slice(0, maxEvents)) {
    const k = ev?.k;
    let ok = null;
    if (k === 'pm' && num(ev.x) && num(ev.y)) ok = { k, x: Math.min(width - 1, Math.max(0, ev.x)), y: Math.min(height - 1, Math.max(0, ev.y)) };
    else if (k === 'pb' && BUTTONS.includes(ev.b) && (ev.d === 0 || ev.d === 1)) ok = { k, b: ev.b, d: ev.d };
    else if (k === 'pw' && num(ev.dx) && num(ev.dy) && ['px', 'line'].includes(ev.mode || 'px')) ok = { k, dx: Math.max(-10000, Math.min(10000, ev.dx)), dy: Math.max(-10000, Math.min(10000, ev.dy)), mode: ev.mode || 'px' };
    else if (k === 'kc' && typeof ev.c === 'string' && CODE_RE.test(ev.c) && CODE_TO_EVDEV[ev.c] && (ev.d === 0 || ev.d === 1)) ok = { k, c: ev.c, code: CODE_TO_EVDEV[ev.c], d: ev.d };
    else if (k === 'tx' && typeof ev.s === 'string' && ev.s.length && [...ev.s].length <= 4000 && !ev.s.includes('\0')) ok = { k, s: ev.s };
    else if (k === 'tc' && Number.isInteger(ev.id) && ev.id >= 0 && ev.id < 10 && ['down', 'move', 'up'].includes(ev.ph) && num(ev.x) && num(ev.y)) ok = { k, id: ev.id, ph: ev.ph, x: Math.min(width - 1, Math.max(0, ev.x)), y: Math.min(height - 1, Math.max(0, ev.y)) };
    else if (k === 'ra') ok = { k };
    if (!ok) { dropped++; continue; }
    if (ok.k === 'pm' && out.at(-1)?.k === 'pm') out[out.length - 1] = ok; else out.push(ok);
  }
  return { seq, e: out, dropped: dropped + Math.max(0, list.length - maxEvents) };
}

/** KeyboardEvent.code → evdev keycode (linux/input-event-codes.h). Shared with the runner, which only sees codes. */
export const CODE_TO_EVDEV = Object.freeze({
  Escape: 1, Digit1: 2, Digit2: 3, Digit3: 4, Digit4: 5, Digit5: 6, Digit6: 7, Digit7: 8, Digit8: 9, Digit9: 10, Digit0: 11,
  Minus: 12, Equal: 13, Backspace: 14, Tab: 15, KeyQ: 16, KeyW: 17, KeyE: 18, KeyR: 19, KeyT: 20, KeyY: 21, KeyU: 22, KeyI: 23,
  KeyO: 24, KeyP: 25, BracketLeft: 26, BracketRight: 27, Enter: 28, ControlLeft: 29, KeyA: 30, KeyS: 31, KeyD: 32, KeyF: 33,
  KeyG: 34, KeyH: 35, KeyJ: 36, KeyK: 37, KeyL: 38, Semicolon: 39, Quote: 40, Backquote: 41, ShiftLeft: 42, Backslash: 43,
  KeyZ: 44, KeyX: 45, KeyC: 46, KeyV: 47, KeyB: 48, KeyN: 49, KeyM: 50, Comma: 51, Period: 52, Slash: 53, ShiftRight: 54,
  NumpadMultiply: 55, AltLeft: 56, Space: 57, CapsLock: 58, F1: 59, F2: 60, F3: 61, F4: 62, F5: 63, F6: 64, F7: 65, F8: 66,
  F9: 67, F10: 68, NumLock: 69, ScrollLock: 70, Numpad7: 71, Numpad8: 72, Numpad9: 73, NumpadSubtract: 74, Numpad4: 75,
  Numpad5: 76, Numpad6: 77, NumpadAdd: 78, Numpad1: 79, Numpad2: 80, Numpad3: 81, Numpad0: 82, NumpadDecimal: 83,
  IntlBackslash: 86, F11: 87, F12: 88, IntlRo: 89, NumpadEnter: 96, ControlRight: 97, NumpadDivide: 98, PrintScreen: 99,
  AltRight: 100, Home: 102, ArrowUp: 103, PageUp: 104, ArrowLeft: 105, ArrowRight: 106, End: 107, ArrowDown: 108,
  PageDown: 109, Insert: 110, Delete: 111, NumpadEqual: 117, Pause: 119, IntlYen: 124, MetaLeft: 125, MetaRight: 126,
  ContextMenu: 127,
});

// ---------------------------------------------------------------- pure: lifecycle (§3.4)

const TRANSITIONS = {
  starting: { ready: 'running', error: 'failed', stop: 'stopping', 'app-exit': 'stopping', 'runner-exit': 'failed' },
  running: { 'last-viewer-left': 'parked', stop: 'stopping', 'app-exit': 'stopping', 'park-expired': 'stopping', 'runner-exit': 'ended', kill: 'parked' },
  parked: { 'viewer-joined': 'running', stop: 'stopping', 'app-exit': 'stopping', 'park-expired': 'stopping', 'runner-exit': 'ended' },
  stopping: { stopped: 'ended', 'runner-exit': 'ended', 'app-exit': 'stopping' },
  failed: { stopped: 'ended', stop: 'ended', 'runner-exit': 'failed' },
  ended: {},
};
/** The session state after `event`; unchanged when the event does not apply in that state. */
export const nextState = (state, event) => TRANSITIONS[state]?.[event] || state;
export const LIVE = new Set(['starting', 'running', 'parked']);

export class AppStreamError extends Error {
  constructor(status, message, fix) {
    super(message);
    this.name = 'AppStreamError';
    this.code = status;
    this.status = ENDINGS[status]?.http || 500;
    if (fix) this.fix = fix;
  }
}

const SID_RE = /^as-[0-9a-f]{8}$/;
export const newSessionId = () => 'as-' + crypto.randomBytes(4).toString('hex');
const monoUs = () => process.hrtime.bigint() / 1000n;
const callerInfo = (c = {}) => Object.fromEntries(['via', 'who', 'from', 'agent', 'session', 'seat', 'human'].filter((k) => c[k] != null).map((k) => [k, typeof c[k] === 'string' ? c[k].slice(0, 500) : c[k]]));

// ---------------------------------------------------------------- host facts (probed once, cached)

/** What this machine can host: compositor, encoders, python/gi, systemd-run. Probed with the injected `run`/`which`. */
export async function probeHost({ run, which, platform = process.platform }) {
  if (platform !== 'linux') return { platform, compositor: compositorFor({ platform }), encoders: [], missing: [] };
  const has = async (el) => (await run('gst-inspect-1.0', ['--exists', el], { timeout: 8000 }).catch(() => ({ code: 1 }))).code === 0;
  const els = ['nvh264enc', 'vah264lpenc', 'vah264enc', 'x264enc', 'openh264enc', 'cudaupload', 'glupload', 'pipewiresrc', 'h264parse', 'appsink'];
  const gst = Object.fromEntries(await Promise.all(els.map(async (e) => [e, await has(e)])));
  const shellV = await run('gnome-shell', ['--version'], { timeout: 8000 }).then((r) => Number(/(\d+)\./.exec(r.stdout || '')?.[1]) || null).catch(() => null);
  const gi = (await run('python3', ['-c', "import gi; gi.require_version('Gst','1.0'); from gi.repository import Gst, Gio, GLib"], { timeout: 10000 }).catch(() => ({ code: 1 }))).code === 0;
  const facts = {
    platform, gst, gnomeShell: shellV, mutter: !!which('mutter'), nvidia: fs.existsSync('/proc/driver/nvidia/version'),
    systemdRun: !!which('systemd-run'), dbusDaemon: !!which('dbus-daemon'), gi, pwCli: !!which('pw-cli'),
  };
  const missing = [
    ...(!gst.pipewiresrc ? ['gstreamer1.0-pipewire'] : []), ...(!gst.h264parse ? ['gstreamer1.0-plugins-bad'] : []),
    ...(!gst.x264enc && !facts.nvidia ? ['gstreamer1.0-plugins-ugly'] : []), ...(!gi ? ['python3-gi gir1.2-gstreamer-1.0'] : []),
    ...(!facts.dbusDaemon ? ['dbus-daemon'] : []),
  ];
  return { ...facts, missing };
}

/** The host block of GET appstream (§7): supported, why, compositor, encoders. */
export function hostSummary(facts, prefs = streamSettings()) {
  if (!facts) return { supported: false, why: 'probing' };
  const comp = compositorFor(facts, prefs.compositor);
  const encoders = pickEncoder(facts, prefs.encoder);
  const why = comp.why || (facts.missing?.length ? `missing packages: ${facts.missing.join(', ')}` : !encoders.length ? 'no H.264 encoder (install gstreamer1.0-plugins-ugly for x264)' : null);
  return { supported: !why, ...(why ? { why } : {}), compositor: comp.name, ...(comp.hint ? { hint: comp.hint } : {}), encoders, ...(facts.missing?.length ? { missing: facts.missing } : {}) };
}

// ---------------------------------------------------------------- the host manager

/**
 * deps: getConfig/persistConfig, home (RIGS_HOME), appDir, nodeName(), control (events, for kill/change), findApp(id)
 * (src/app-catalog.js findItem), run/which/spawn (src/util.js), log, now, systemd (use systemd-run), probe (host facts).
 * Returns the REST handler, the WS attach and
 * an attention source.
 */
export function createAppStream(deps) {
  const { getConfig, persistConfig, home, appDir, nodeName = () => os.hostname(), control, findApp = async () => null, run, which, spawn, log = () => {}, now = Date.now, systemd = !process.env.RIGS_NO_SYSTEMD, probe = probeHost } = deps;
  const events = new EventEmitter();
  const dirs = { sessions: path.join(home, 'appstream', 'sessions'), run: path.join(home, 'run', 'appstream'), logs: path.join(home, 'logs', 'appstream') };
  const stateFile = path.join(home, 'appstream-state.json'), auditFile = path.join(home, 'logs', 'appstream.jsonl');
  const runner = path.join(appDir, 'scripts', 'appstream', 'rigs-appstream-linux.py');
  let state = {};
  try { state = JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch {}
  const sessions = new Map();
  let facts = null, factsAt = 0, closing = false;
  const prefs = () => streamSettings(getConfig().appStream);

  function saveState() {
    fs.mkdirSync(home, { recursive: true, mode: 0o700 });
    fs.writeFileSync(stateFile + '.tmp', JSON.stringify(state), { mode: 0o600 });
    fs.renameSync(stateFile + '.tmp', stateFile);
  }
  function audit(op, args = {}, caller = {}, ok = true, error = null) {
    const line = { ts: new Date(now()).toISOString(), node: nodeName(), op, ok, caller: callerInfo(caller), ...args, ...(error ? { error: { code: error.code || error.status, message: error.message } } : {}) };
    try {
      fs.mkdirSync(path.dirname(auditFile), { recursive: true, mode: 0o700 });
      if (fs.existsSync(auditFile) && fs.statSync(auditFile).size >= 5 * 1024 * 1024) fs.renameSync(auditFile, auditFile + '.1');
      fs.appendFileSync(auditFile, JSON.stringify(line) + '\n', { mode: 0o600 });
    } catch (e) { log('appstream audit:', e.message); }
    events.emit('audit', line);
  }
  const gate = (caller, act = false, role) => gateDecision({ settings: prefs(), killed: state.killed || null, caller, act, role });

  async function hostFacts(force = false) {
    if (!force && facts && now() - factsAt < 10 * 60 * 1000) return facts;
    facts = await probe({ run, which });
    factsAt = now();
    return facts;
  }

  // ---- session records
  const stateOf = (sid) => path.join(dirs.sessions, sid + '.json');
  const sockOf = (sid) => path.join(dirs.run, sid + '.sock');
  const unitOf = (sid) => 'rigs-appstream-' + sid;
  function persist(s) {
    fs.mkdirSync(dirs.sessions, { recursive: true, mode: 0o700 });
    const { conn: _c, viewers: _v, timers: _t, waiters: _w, ...rest } = s;
    fs.writeFileSync(stateOf(s.id), JSON.stringify(rest, null, 1), { mode: 0o600 });
  }
  function publicSession(s) {
    return {
      id: s.id, node: nodeName(), app: s.app, mode: 'app', state: s.state, createdAt: s.createdAt, lastViewerAt: s.lastViewerAt || null,
      ...(s.state === 'parked' ? { parkUntil: new Date(s.parkUntil).toISOString() } : {}),
      width: s.width, height: s.height, fps: s.fps, bitrateKbps: s.bitrate, encoder: s.encoder || null, compositor: s.compositor || null, display: s.display || null,
      viewers: [...s.viewers.values()].map((v) => ({ id: v.id, from: v.caller.from || '', who: v.caller.who || '', role: v.role, since: new Date(v.since).toISOString() })),
      ...(s.exit ? { exit: s.exit } : {}), ...(s.error ? { error: s.error } : {}), unit: s.unit,
    };
  }
  function transition(s, event) {
    const next = nextState(s.state, event);
    if (next === s.state) return false;
    s.state = next;
    if (LIVE.has(next)) persist(s);
    events.emit('session', publicSession(s));
    return true;
  }

  // ---- runner connection
  function send(s, obj) { if (s.conn && !s.conn.destroyed) s.conn.write(packMessage(1, obj)); }
  function connect(s, timeoutMs = 15000) {
    const deadline = now() + timeoutMs;
    return new Promise((resolve, reject) => {
      const attempt = () => {
        const c = net.createConnection(sockOf(s.id));
        c.once('connect', () => { attach(s, c); resolve(c); });
        c.once('error', (e) => {
          c.destroy();
          if (now() > deadline || s.state === 'ended') return reject(new Error(`runner socket: ${e.code || e.message}`));
          setTimeout(attempt, 150);
        });
      };
      attempt();
    });
  }
  function attach(s, c) {
    s.conn = c;
    const read = messageReader();
    c.on('data', (chunk) => {
      let msgs;
      try { msgs = read(chunk); } catch (e) { log('appstream runner:', e.message); c.destroy(); return; }
      for (const m of msgs) {
        if (m.type === 2) onFrame(s, m.body);
        else if (m.type === 1) { try { onRunner(s, JSON.parse(m.body.toString('utf8'))); } catch (e) { log('appstream runner message:', e.message); } }
      }
    });
    c.on('close', () => {
      if (s.conn !== c) return;
      s.conn = null;
      // Runner gone: the session is over (a daemon restart keeps the runner; only the runner's own exit closes it).
      if (!closing && !s.stopping && s.state !== 'ended') finish(s, s.exit ? 'app-exited' : 'runner-exit');
    });
    c.on('error', () => {});
  }

  function onRunner(s, m) {
    if (m.ev === 'ready') {
      Object.assign(s, { compositor: m.compositor || s.compositor, display: m.display || s.display });
      if (transition(s, 'ready')) audit('ready', { session: s.id, compositor: s.compositor, display: s.display });
      if (s.state === 'running' && !s.viewers.size) park(s);
      for (const w of s.waiters.splice(0)) w();
      // A reconnect after a daemon restart: the runner keeps its stream state; restart it for current viewers.
      if (s.viewers.size) startStream(s);
    } else if (m.ev === 'stream') {
      s.encoder = m.encoder; s.width = m.width; s.height = m.height; s.streaming = true;
      if (m.fallback) for (const v of s.viewers.values()) v.message({ type: 'status', status: 'encoder-fallback', message: `${m.fallbackReason || 'Hardware encoder unavailable'}; using ${m.encoder?.name}` });
      for (const v of s.viewers.values()) { if (!v.helloSent) hello(s, v); else v.message({ type: 'meta', width: s.width, height: s.height }); v.st = { ...v.st, needsIdr: true }; }
      // The pipeline's first IDR went out before the viewers had their hello: ask for a fresh one.
      s.lastIdrAt = 0;
      keyframe(s);
      persist(s);
      log(`appstream ${s.id}: streaming ${s.width}x${s.height}@${s.fps} with ${m.encoder?.name}/${m.encoder?.path}`);
    } else if (m.ev === 'meta') {
      // A rebuild already announced its size with its 'stream' event.
      if (m.width === s.width && m.height === s.height && s.streaming === true) return;
      s.width = m.width; s.height = m.height;
      for (const v of s.viewers.values()) { v.message({ type: 'meta', width: m.width, height: m.height }); v.st = { ...v.st, needsIdr: true }; }
      s.lastIdrAt = 0;
      keyframe(s);
    } else if (m.ev === 'clipboard') {
      if (!prefs().clipboard || typeof m.text !== 'string') return;
      audit('clipboard', { session: s.id, direction: 'from-app', bytes: Buffer.byteLength(m.text) });
      for (const v of s.viewers.values()) v.message({ type: 'clipboard', text: m.text.slice(0, 1024 * 1024) });
    } else if (m.ev === 'stats') {
      s.runnerStats = m;
    } else if (m.ev === 'app-exit') {
      s.exit = { code: m.code ?? null, signal: m.signal ?? null, at: new Date(now()).toISOString() };
      audit('end', { session: s.id, reason: 'app-exited', code: m.code });
      endViewers(s, { status: 'ended', code: 'app-exited', message: `${s.app.name} exited` }, 'app-exited');
      stopSession(s, { reason: 'app-exited', force: true }).catch(() => {});
    } else if (m.ev === 'error') {
      log(`appstream ${s.id}: ${m.code}: ${m.message}`);
      if (s.state === 'starting') { s.error = { code: m.code, message: m.message }; transition(s, 'error'); for (const w of s.waiters.splice(0)) w(); }
      else for (const v of s.viewers.values()) v.message({ type: 'status', status: m.code || 'error', message: m.message });
      if (m.code === 'stream-failed') { s.streaming = false; endViewers(s, { status: 'unsupported', message: `No encoder could start: ${m.message}` }); }
    } else if (m.ev === 'log') log(`appstream ${s.id}: ${String(m.line).slice(0, 500)}`);
  }

  // ---- frames to viewers
  function onFrame(s, buf) {
    const h = decodeHeader(buf);
    if (!h) return;
    s.frames = (s.frames || 0) + 1;
    let congested = false;
    for (const v of s.viewers.values()) {
      if (!v.helloSent) continue;
      const r = flowStep(v.st, h, { fps: s.fps, buffered: v.buffered() });
      v.st = r.v;
      if (r.send) v.sendBinary(buf);
      else v.skipped++;
      if (r.requestIdr) keyframe(s);
      if (r.congested) congested = true;
    }
    if (congested) congestion(s);
    const allBehind = shouldSkip([...s.viewers.values()].filter((v) => v.helloSent).map((v) => ({ st: v.st, buffered: v.buffered() })), { fps: s.fps });
    if (allBehind !== !!s.skipping) { s.skipping = allBehind; send(s, { op: 'skip', on: allBehind }); }
  }
  function keyframe(s) {
    if (now() - (s.lastIdrAt || 0) < 500) return;
    s.lastIdrAt = now();
    send(s, { op: 'keyframe' });
  }
  function congestion(s) {
    if (now() - (s.lastCongestionAt || 0) < 1000) return;
    s.lastCongestionAt = now();
    const next = aimd(s.bitrate, { congested: true });
    if (next !== s.bitrate) {
      s.bitrate = next;
      send(s, { op: 'bitrate', kbps: next });
      for (const v of s.viewers.values()) v.message({ type: 'status', status: 'throttled', message: `Network congested: ${next} kbit/s` });
    }
  }

  function hello(s, v) {
    v.helloSent = true;
    v.message({
      type: 'hello', v: 1, session: s.id, node: nodeName(), app: s.app, transport: s.transport || 'h264', encoder: s.encoder || null,
      width: s.width, height: s.height, fps: s.fps, bitrateKbps: s.bitrate, role: v.role, input: !gate(v.caller, true, 'controller'),
      clipboard: prefs().clipboard, audio: null, viewers: s.viewers.size, serverUs: Number(monoUs()),
    });
  }

  function startStream(s) {
    const p = prefs();
    const encoders = s.transport === 'jpeg' ? [{ name: 'jpegenc', hw: false, path: 'sw' }] : pickEncoder(facts || {}, p.encoder);
    if (!encoders.length) return endViewers(s, { status: 'unsupported', message: 'No H.264 encoder on this host (install gstreamer1.0-plugins-ugly)' });
    s.streaming ||= 'pending';
    const candidates = encoders.map((enc) => ({ encoder: enc, desc: pipelineFor(enc, { width: s.width, height: s.height, fps: s.fps, kbps: s.bitrate, transport: s.transport }) }));
    send(s, { op: 'start-stream', width: s.width, height: s.height, fps: s.fps, bitrateKbps: s.bitrate, transport: s.transport || 'h264', kind: s.transport === 'jpeg' ? KIND.jpeg : KIND.h264, candidates });
  }

  function endViewers(s, refusal, reason) {
    const e = ending(refusal);
    for (const v of [...s.viewers.values()]) {
      v.message({ type: reason ? 'end' : 'error', ...(reason ? { reason } : {}), status: e.status, code: e.code, message: e.message, ...(e.fix ? { fix: e.fix } : {}) });
      v.drop(e.close, e.status);
    }
  }

  function park(s) {
    if (s.state === 'running' && !transition(s, 'last-viewer-left')) return;
    s.parkUntil = now() + prefs().parkMinutes * 60000;
    s.streaming = false;
    send(s, { op: 'release-all' });
    send(s, { op: 'stop-stream' });
    persist(s);
  }

  // ---- viewers
  let viewerSeq = 0;
  function join(s, v) {
    v.role = [...s.viewers.values()].some((x) => x.role === 'controller') || v.caller.human === false || v.caller.agent ? 'viewer' : 'controller';
    s.viewers.set(v.id, v);
    s.lastViewerAt = new Date(now()).toISOString();
    if (s.state === 'parked') transition(s, 'viewer-joined');
    audit('join', { session: s.id, viewer: v.id, role: v.role }, v.caller);
    events.emit('viewers');
    const size = sizeFor({ want: v.want, caps: v.caps, prefs: prefs(), phone: ['ios', 'android'].includes(v.caps?.platform) });
    const first = s.viewers.size === 1;
    if (first) {
      s.fps = Math.round(clampNum(v.want.fps, 5, prefs().fps, prefs().fps));
      s.bitrate = s.target = bitrateFor({ quality: v.want.quality, bitrateKbps: v.want.bitrateKbps }, prefs());
      s.transport = v.want.transport === 'jpeg' || (v.caps?.decoders && !v.caps.decoders.includes('webcodecs') && !v.caps.decoders.includes('mse')) ? 'jpeg' : 'h264';
    }
    if (s.state !== 'running' && s.state !== 'starting') return;
    if (first || !s.streaming) { Object.assign(s, size); if (s.state === 'running') startStream(s); }
    else { hello(s, v); keyframe(s); }
  }
  function leave(s, v) {
    if (!s.viewers.delete(v.id)) return;
    audit('leave', { session: s.id, viewer: v.id, frames: v.sent, skipped: v.skipped, dropped: v.dropped }, v.caller);
    if (v.role === 'controller') {
      send(s, { op: 'release-all' });
      // Control passes to the longest-attached human viewer.
      const next = [...s.viewers.values()].find((x) => x.caller.human !== false && !x.caller.agent);
      if (next) { next.role = 'controller'; next.message({ type: 'role', role: 'controller' }); }
    }
    events.emit('viewers');
    if (!s.viewers.size && LIVE.has(s.state)) park(s);
  }

  /** Serve one WebSocket viewer of session `sid`. `query` is the upgrade URL's searchParams, `caller` controlCaller(). */
  function attachWs(ws, sid, query, caller = {}) {
    const v = {
      id: 'v' + (++viewerSeq), caller: callerInfo(caller), since: now(), role: 'viewer', st: { lastSent: null, lastAck: null, needsIdr: true },
      helloSent: false, sent: 0, skipped: 0, dropped: 0, batches: [], want: {}, caps: {},
      buffered: () => ws.bufferedAmount,
      sendBinary: (b) => { if (ws.readyState === 1) { ws.send(b, { binary: true }); v.sent++; } },
      message: (o) => { if (ws.readyState === 1) ws.send(JSON.stringify(o)); },
      drop: (code, reason) => { if (ws.readyState === 1) ws.close(code, reason); },
    };
    const refuse = (r) => { const e = ending(r); v.message({ type: 'error', status: e.status, code: e.code, message: e.message, ...(e.fix ? { fix: e.fix } : {}) }); v.drop(e.close, e.status); };
    const s = sessions.get(sid);
    if (!SID_RE.test(sid) || !s || !LIVE.has(s.state)) return refuse({ status: 'no-session', message: `No live session ${sid}` });
    const refused = gate(v.caller);
    if (refused) { audit('refused', { session: sid, phase: 'join' }, v.caller, false, refused); return refuse(refused); }
    // The viewer's hello carries its size and decoders; without one in 1.5 s the query (or defaults) is used.
    const q = (k) => (typeof query?.get === 'function' ? query.get(k) : query?.[k]);
    let joined = false;
    const doJoin = (want = {}, caps = {}) => {
      if (joined || ws.readyState !== 1) return;
      joined = true;
      v.want = { fit: q('fit') || undefined, width: Number(q('width')) || undefined, height: Number(q('height')) || undefined, fps: Number(q('fps')) || undefined, quality: q('quality') || undefined, transport: q('transport') || undefined, ...want };
      v.caps = caps;
      join(s, v);
    };
    const helloTimer = setTimeout(() => doJoin(), 1500);
    ws.on('message', (data, isBinary) => {
      if (isBinary) return;
      let m;
      try { m = JSON.parse(String(data).slice(0, 2 * 1024 * 1024)); } catch { return; }
      if (!m || typeof m !== 'object') return;
      if (m.type === 'hello') { clearTimeout(helloTimer); return doJoin(m.want && typeof m.want === 'object' ? m.want : {}, m.caps && typeof m.caps === 'object' ? m.caps : {}); }
      if (!joined) return;
      onViewer(s, v, m);
    });
    const bye = () => { clearTimeout(helloTimer); if (joined) leave(s, v); };
    ws.on('close', bye);
    ws.on('error', (e) => { log('appstream viewer:', e.message); bye(); });
  }

  function onViewer(s, v, m) {
    switch (m.type) {
      case 'ack': if (Number.isInteger(m.seq)) v.st = { ...v.st, lastAck: Math.max(v.st.lastAck ?? -1, m.seq) }; return;
      case 'keyframe': return keyframe(s);
      case 'ping': return v.message({ type: 'pong', t0: m.t0, serverUs: Number(monoUs()) });
      case 'in': {
        const refused = gate(v.caller, true, v.role);
        if (refused) { if (!v.inputRefused) { v.inputRefused = true; audit('refused', { session: s.id, phase: 'input' }, v.caller, false, refused); v.message({ type: 'status', status: refused.status, code: refused.code, message: refused.message }); } return; }
        v.inputRefused = false;
        const t = now();
        v.batches = v.batches.filter((x) => t - x < 1000);
        if (v.batches.length >= 240) { v.dropped++; return; }
        v.batches.push(t);
        const b = validateInput(m, { width: s.width, height: s.height });
        v.dropped += b.dropped;
        if (b.e.length) send(s, { op: 'input', seq: b.seq, e: b.e });
        return;
      }
      case 'clipboard': {
        if (!prefs().clipboard || v.role !== 'controller' || gate(v.caller, true, v.role) || typeof m.text !== 'string' || m.text.length > 1024 * 1024) return;
        audit('clipboard', { session: s.id, direction: 'to-app', bytes: Buffer.byteLength(m.text) }, v.caller);
        return send(s, { op: 'clipboard-set', text: m.text });
      }
      case 'resize': {
        if (v.role !== 'controller' || !(m.width > 0 && m.height > 0)) return;
        const size = sizeFor({ want: { fit: 'fixed', width: m.width, height: m.height }, caps: v.caps, prefs: prefs() });
        if (size.width === s.width && size.height === s.height) return;
        Object.assign(s, size);
        return send(s, { op: 'resize', ...size });
      }
      case 'config': {
        if (v.role !== 'controller') return;
        if (m.quality || m.bitrateKbps) { s.target = s.bitrate = bitrateFor(m, prefs()); send(s, { op: 'bitrate', kbps: s.bitrate }); }
        if (m.fps && Math.round(clampNum(m.fps, 5, prefs().fps, s.fps)) !== s.fps) { s.fps = Math.round(clampNum(m.fps, 5, prefs().fps, s.fps)); startStream(s); }
        return;
      }
      case 'take-control': {
        if (v.role === 'controller' || v.caller.human === false || v.caller.agent) return;
        for (const x of s.viewers.values()) if (x.role === 'controller') { x.role = 'viewer'; x.message({ type: 'role', role: 'viewer', by: v.caller.from || '' }); }
        send(s, { op: 'release-all' });
        v.role = 'controller';
        audit('role', { session: s.id, viewer: v.id, role: 'controller' }, v.caller);
        return v.message({ type: 'role', role: 'controller' });
      }
      case 'stop': if (v.role === 'controller') stopSession(s, { reason: 'stopped', caller: v.caller }).catch(() => {}); return;
      default:
    }
  }

  // ---- start / stop
  function runnerEnv() {
    const keep = ['PATH', 'HOME', 'USER', 'LOGNAME', 'LANG', 'LC_ALL', 'XDG_RUNTIME_DIR', 'XDG_DATA_DIRS', 'XDG_CONFIG_DIRS', 'SHELL'];
    const env = Object.fromEntries(keep.filter((k) => process.env[k]).map((k) => [k, process.env[k]]));
    env.XDG_RUNTIME_DIR ||= `/run/user/${os.userInfo().uid}`;
    env.RIGS_HOME = home;
    return env;
  }

  async function launchRunner(s) {
    fs.mkdirSync(dirs.run, { recursive: true, mode: 0o700 });
    fs.mkdirSync(dirs.logs, { recursive: true, mode: 0o700 });
    fs.rmSync(sockOf(s.id), { force: true });
    const env = runnerEnv();
    const args = [runner, '--session', s.id, '--socket', sockOf(s.id), '--state', stateOf(s.id), '--log', path.join(dirs.logs, s.id + '.log')];
    if (systemd && facts?.systemdRun) {
      s.unit = unitOf(s.id);
      persist(s);
      const r = await run('systemd-run', ['--user', '--unit', s.unit, '--collect', '--description', `RIGS app stream ${s.id} (${home})`,
        '-p', 'KillMode=control-group', '-p', 'TimeoutStopSec=15', ...Object.entries(env).map(([k, val]) => `--setenv=${k}=${val}`), 'python3', ...args], { timeout: 15000 });
      if (r.code !== 0) throw new AppStreamError('unsupported', `systemd-run failed: ${(r.stderr || r.stdout || '').trim().slice(0, 300)}`);
    } else {
      s.unit = null;
      const out = fs.openSync(path.join(dirs.logs, s.id + '.log'), 'a');
      const p = spawn('python3', args, { detached: true, stdio: ['ignore', out, out], env });
      p.unref();
      s.pid = p.pid;
      persist(s);
    }
  }

  async function startSession(body = {}, caller = {}) {
    const refused = gate(caller);
    if (refused) { audit('refused', { phase: 'start', app: body.app || null }, caller, false, refused); throw new AppStreamError(refused.status, refused.message); }
    const f = await hostFacts();
    const host = hostSummary(f, prefs());
    if (!host.supported) throw new AppStreamError('unsupported', host.why);
    if (body.mode && body.mode !== 'app') throw new AppStreamError('unsupported', 'whole-desktop mode is not available yet (Phase 3)');
    let app, launch;
    const files = Array.isArray(body.files) ? body.files.filter((x) => typeof x === 'string' && path.isAbsolute(x)).slice(0, 50) : [];
    if (body.app) {
      if (typeof body.app !== 'string' || !/^[\w.+-]{1,200}$/.test(body.app)) throw new AppStreamError('bad-args', 'app must be a catalog id');
      const item = await findApp(body.app);
      if (!item) throw new AppStreamError('no-session', `No app ${body.app} on ${nodeName()}`);
      if (item.streamable === false) throw new AppStreamError('unsupported', item.why || `${item.name} cannot be streamed`);
      if (item.launch?.kind !== 'desktop') throw new AppStreamError('unsupported', 'only .desktop apps can be streamed on Linux');
      app = { id: item.id, name: item.name, icon: `appstream/catalog/${encodeURIComponent(item.id)}/icon` };
      launch = { kind: 'desktop', file: item.launch.file, argv: item.launch.argv, dbus: !!item.launch.dbus, files };
    } else if (Array.isArray(body.command) && body.command.length && body.command.every((x) => typeof x === 'string' && x.length < 4096) && body.command.length <= 100) {
      app = { id: 'command', name: path.basename(body.command[0]), icon: null };
      launch = { kind: 'argv', argv: body.command };
    } else throw new AppStreamError('bad-args', 'Give app (a catalog id) or command (an argv array)');
    if (body.reuse !== false && app.id !== 'command') {
      const live = [...sessions.values()].find((x) => x.app.id === app.id && LIVE.has(x.state));
      if (live) return { session: publicSession(live), reused: true };
    }
    const p = prefs();
    if ([...sessions.values()].filter((x) => LIVE.has(x.state)).length >= p.maxSessions) throw new AppStreamError('busy', `${p.maxSessions} app sessions are already running on ${nodeName()}`);
    const size = sizeFor({ want: { fit: 'fixed', ...(body.size || {}) }, prefs: p });
    const comp = compositorFor(f, p.compositor);
    const s = {
      id: newSessionId(), app, state: 'starting', createdAt: new Date(now()).toISOString(), launch, compositor: comp.name, ...size,
      fps: p.fps, bitrate: p.bitrate.balanced, target: p.bitrate.balanced, viewers: new Map(), waiters: [], home,
      shareDir: path.join(appDir, 'scripts', 'appstream'), parkUntil: null,
    };
    sessions.set(s.id, s);
    audit('start', { session: s.id, app: app.id, launch: launch.kind, compositor: comp.name }, caller);
    try {
      const ready = new Promise((resolve) => { s.waiters.push(resolve); setTimeout(resolve, 30000).unref?.(); });
      await launchRunner(s);
      await connect(s);
      await ready;
    } catch (e) {
      s.error = { code: 'start-failed', message: e.message };
      transition(s, 'error');
      await cleanup(s);
      throw e instanceof AppStreamError ? e : new AppStreamError('unsupported', `The app session could not start: ${e.message}`);
    }
    if (s.state === 'failed') { await cleanup(s); throw new AppStreamError('unsupported', `The app session could not start: ${s.error?.message || 'runner failed'}`); }
    return { session: publicSession(s), reused: false };
  }

  async function stopSession(s, { reason = 'stopped', force = false, caller } = {}) {
    if (s.state === 'ended' || s.stopping) return s.stopping;
    s.stopping = (async () => {
      transition(s, 'stop');
      endViewers(s, { status: 'ended', code: reason, message: `${s.app.name} ${reason === 'app-exited' ? 'exited' : 'was stopped'}` }, reason);
      if (caller) audit('stop', { session: s.id, reason, force }, caller);
      send(s, { op: 'stop', force });
      // The runner closes its socket when everything is down (the app gets up to 10 s to save or ask).
      await new Promise((resolve) => {
        if (!s.conn) return resolve();
        const t = setTimeout(resolve, (force ? 4 : 13) * 1000);
        s.conn.once('close', () => { clearTimeout(t); resolve(); });
      });
      await cleanup(s);
    })();
    return s.stopping;
  }

  async function cleanup(s) {
    if (s.unit) await run('systemctl', ['--user', 'stop', s.unit], { timeout: 20000 }).catch(() => {});
    else if (s.pid) { try { process.kill(s.pid, 'SIGTERM'); } catch {} }
    s.conn?.destroy();
    for (const f of [stateOf(s.id), sockOf(s.id)]) fs.rmSync(f, { force: true });
    if (s.state !== 'ended' && s.state !== 'failed') s.state = 'ended';
    events.emit('session', publicSession(s));
    events.emit('viewers');
    // Ended sessions stay listed for a minute so a viewer that reconnects learns why.
    setTimeout(() => { if (sessions.get(s.id) === s) sessions.delete(s.id); }, 60000).unref?.();
  }

  function finish(s, reason) {
    audit('end', { session: s.id, reason });
    endViewers(s, { status: 'ended', code: reason, message: `${s.app.name} ended (${reason})` }, reason);
    transition(s, 'runner-exit');
    cleanup(s).catch(() => {});
  }

  // ---- kill switch, gate re-check, park expiry, AIMD recovery
  function endAllViewers(refusal, why) {
    let n = 0;
    for (const s of sessions.values()) {
      if (!s.viewers.size) continue;
      n += s.viewers.size;
      send(s, { op: 'release-all' });
      endViewers(s, refusal);
      audit('kill', { session: s.id, reason: why });
    }
    return n;
  }
  function recheck() {
    for (const s of sessions.values()) {
      for (const v of [...s.viewers.values()]) {
        const r = gate(v.caller);
        if (r) { audit('refused', { session: s.id, phase: 'view' }, v.caller, false, r); const e = ending(r); v.message({ type: 'error', status: e.status, code: e.code, message: e.message }); v.drop(e.close, e.status); }
      }
    }
  }
  const onControl = (type) => (ev) => {
    if (!controlEventEnds(type, ev)) return;
    const n = endAllViewers({ status: 'killed', code: 'killed', message: type === 'kill' ? 'Screen control was stopped on this machine; the app keeps running, parked' : 'Screen control was switched off; the app keeps running, parked' }, `control-${type}`);
    if (n) log(`appstream: control ${type} ended ${n} viewer(s)`);
  };
  control?.events?.on('kill', onControl('kill'));
  control?.events?.on('change', onControl('change'));
  const ticker = setInterval(() => {
    recheck();
    const t = now();
    for (const s of sessions.values()) {
      if (s.state === 'parked' && s.parkUntil && t > s.parkUntil) { audit('end', { session: s.id, reason: 'parked-expired' }); stopSession(s, { reason: 'parked-expired' }).catch(() => {}); continue; }
      if (s.state === 'running' && s.streaming && s.bitrate < s.target) {
        const next = aimd(s.bitrate, { calmMs: t - (s.lastCongestionAt || 0), target: s.target });
        if (next !== s.bitrate && t - (s.lastRaiseAt || 0) >= 1000) { s.bitrate = next; s.lastRaiseAt = t; send(s, { op: 'bitrate', kbps: next }); }
      }
      if (s.state === 'running' && t - (s.lastStatsAt || 0) >= 2000 && s.viewers.size) {
        s.lastStatsAt = t;
        const r = s.runnerStats || {};
        const msg = { type: 'stats', fps: r.fps ?? null, kbps: r.kbps ?? null, encodeMsP50: r.encodeMsP50 ?? null, skipped: [...s.viewers.values()].reduce((a, v) => a + v.skipped, 0) + (r.skipped || 0), viewers: s.viewers.size, encoder: s.encoder || null, bitrateKbps: s.bitrate };
        for (const v of s.viewers.values()) v.message(msg);
      }
    }
  }, 500);
  ticker.unref?.();

  // ---- daemon start: reattach live runners, drop dead ones, stop orphaned units of this RIGS_HOME
  async function reconcile() {
    let files = [];
    try { files = fs.readdirSync(dirs.sessions).filter((f) => /^as-[0-9a-f]{8}\.json$/.test(f)); } catch {}
    const known = new Set();
    for (const f of files) {
      let rec;
      try { rec = JSON.parse(fs.readFileSync(path.join(dirs.sessions, f), 'utf8')); } catch { continue; }
      if (!rec?.id || !SID_RE.test(rec.id)) continue;
      known.add(rec.id);
      const s = { ...rec, viewers: new Map(), waiters: [], conn: null, state: 'starting', streaming: false };
      sessions.set(s.id, s);
      try {
        const ready = new Promise((resolve) => { s.waiters.push(resolve); setTimeout(resolve, 3000).unref?.(); });
        await connect(s, 2000);
        await ready;
        log(`appstream: reattached ${s.id} (${s.app?.name})`);
      } catch {
        log(`appstream: ${s.id} is gone; cleaning up`);
        sessions.delete(s.id);
        await cleanup(s);
      }
    }
    if (systemd && which('systemctl')) {
      const r = await run('systemctl', ['--user', 'list-units', '--plain', '--no-legend', '--all', 'rigs-appstream-*'], { timeout: 10000 }).catch(() => ({ stdout: '' }));
      for (const line of String(r.stdout || '').split('\n')) {
        const unit = line.trim().split(/\s+/)[0];
        const m = /^rigs-appstream-(as-[0-9a-f]{8})\.service$/.exec(unit || '');
        if (!m || known.has(m[1])) continue;
        // Only units this RIGS_HOME started (the description carries it): a scratch daemon never stops the real one's.
        if (!line.includes(`(${home})`)) continue;
        log(`appstream: stopping orphaned ${unit}`);
        await run('systemctl', ['--user', 'stop', unit], { timeout: 20000 }).catch(() => {});
      }
    }
  }

  // ---- REST (§7)
  async function statusInfo() {
    const f = await hostFacts().catch(() => null);
    const p = prefs();
    return {
      node: nodeName(), os: process.platform, enabled: p.enabled && !state.killed, input: p.input, killed: state.killed || null,
      host: hostSummary(f, p), sessions: [...sessions.values()].map(publicSession),
      limits: { maxSessions: p.maxSessions, maxWidth: p.maxWidth, maxHeight: p.maxHeight, parkMinutes: p.parkMinutes },
    };
  }
  async function enable({ enabled, input, confirm } = {}, caller = {}) {
    if (typeof enabled !== 'boolean' && typeof input !== 'boolean') throw new AppStreamError('bad-args', 'Specify enabled and/or input as booleans');
    const no = mayEnable({ enabled, input }, caller, confirm, nodeName());
    if (no) { audit('enable', { enabled, input }, caller, false, no); throw new AppStreamError('not-allowed', no.message); }
    const cur = getConfig().appStream || {};
    const next = { ...cur, ...(enabled != null ? { enabled } : {}), ...(input != null ? { input } : {}) };
    if (next.enabled === false) next.input = false;
    persistConfig({ ...getConfig(), appStream: next });
    if (enabled === true || input === true) { delete state.killed; saveState(); }
    audit('enable', { enabled: next.enabled !== false, input: next.input !== false }, caller);
    if (next.enabled === false) endAllViewers({ status: 'appstream-off', code: 'off', message: 'App streaming was switched off on this machine' }, 'switched-off');
    else if (input === false) for (const s of sessions.values()) send(s, { op: 'release-all' });
    return statusInfo();
  }
  async function kill({ reason = '' } = {}, caller = {}) {
    state.killed = { at: new Date(now()).toISOString(), by: callerInfo(caller), reason: String(reason).slice(0, 500) };
    saveState();
    const ended = endAllViewers({ status: 'appstream-off', code: 'killed', message: 'App streaming was stopped on this machine' }, 'appstream-kill');
    audit('kill', { reason: state.killed.reason, ended }, caller);
    return { ok: true, ended };
  }

  /** /api/local/appstream* (sub without the 'appstream' prefix: '', 'sessions', 'sessions/<sid>', …). */
  async function api(sub, method, q, body, caller) {
    if (sub === '' && method === 'GET') return statusInfo();
    if (sub === 'enable' && method === 'POST') return enable(await body(), caller);
    if (sub === 'kill' && method === 'POST') return kill(await body(), caller);
    if (sub === 'sessions' && method === 'GET') return { sessions: [...sessions.values()].map(publicSession) };
    if (sub === 'sessions' && method === 'POST') { const r = await startSession(await body(), caller); return { status: r.reused ? 200 : 201, body: { session: r.session, reused: r.reused } }; }
    const m = /^sessions\/([^/]+)(\/keep)?$/.exec(sub);
    if (m) {
      const s = sessions.get(m[1]);
      if (!s) throw new AppStreamError('no-session', `No session ${m[1]} on ${nodeName()}`);
      if (!m[2] && method === 'GET') return { session: publicSession(s) };
      if (!m[2] && method === 'DELETE') { await stopSession(s, { reason: 'stopped', force: q?.get?.('force') === '1', caller }); return { ok: true, state: s.state }; }
      if (m[2] && method === 'POST') {
        if (s.state !== 'parked' && s.state !== 'running') throw new AppStreamError('ended', `Session ${s.id} is ${s.state}`);
        s.parkUntil = now() + prefs().parkMinutes * 60000;
        persist(s);
        return { parkUntil: new Date(s.parkUntil).toISOString() };
      }
    }
    throw new AppStreamError('bad-args', `unknown appstream route ${method} ${sub}`);
  }

  /** Attention items: one per session while it has viewers (§6 announcement). */
  const attentionItems = () => [...sessions.values()].filter((s) => s.viewers.size).map((s) => ({
    key: `appstream:${nodeName()}:${s.id}`, kind: 'appstream', agent: 'jarvis',
    title: `${s.app.name} on ${nodeName()} is being streamed to ${[...new Set([...s.viewers.values()].map((v) => v.caller.from || 'a viewer'))].join(', ')}`,
    reason: 'app stream', since: s.lastViewerAt, stop: { method: 'DELETE', path: `appstream/sessions/${s.id}` },
  }));

  function close() {
    closing = true;
    clearInterval(ticker);
    // Runners keep going (sessions survive a daemon restart); only our sockets close.
    for (const s of sessions.values()) { endViewers(s, { status: 'host-restart', message: 'The host daemon is restarting' }); s.conn?.destroy(); s.conn = null; }
  }

  return { api, attachWs, startSession, stopSession, enable, kill, status: statusInfo, reconcile, attentionItems, events, close, sessions, hostFacts, audit };
}
