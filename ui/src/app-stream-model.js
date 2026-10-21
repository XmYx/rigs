// Pure logic of the app stream viewer (docs/app-streaming.md §5, §8.2, §8.3; DOM layer: app-stream.js). No DOM at import
// time, so test/app-stream-ui.test.js runs it in Node: the 32-byte media frame header, Annex-B → avcC conversion and the
// WebCodecs codec string, the viewer's drop/keyframe policy, size policy, stage → stream coordinates, wheel/key/text input
// events and their batching, the Mac↔Linux modifier swap, the phone gesture recognizer (Direct and Touchpad), rolling
// stats and the host clock estimate, reconnect rules and the words for refusals.

// ------------------------------------------------------------------ media frames

export const HEADER_LEN = 32;
export const KIND = Object.freeze({ h264: 1, audio: 2, jpeg: 3 });
export const FLAG = Object.freeze({ key: 1, config: 2, discontinuity: 4, repeat: 8 });

/** A binary WebSocket message → { kind, flags, key, config, discontinuity, repeat, seq, captureUs, encodeUs, inputSeq, width, height, payload } or null. */
export function parseFrame(data) {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  if (bytes.length < HEADER_LEN) return null;
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const hdr = dv.getUint16(2, true);
  if (hdr < HEADER_LEN || hdr > bytes.length) return null;
  const flags = bytes[1];
  return {
    kind: bytes[0], flags, key: !!(flags & FLAG.key), config: !!(flags & FLAG.config), discontinuity: !!(flags & FLAG.discontinuity), repeat: !!(flags & FLAG.repeat),
    seq: dv.getUint32(4, true), captureUs: Number(dv.getBigUint64(8, true)), encodeUs: dv.getUint32(16, true), inputSeq: dv.getUint32(20, true),
    width: dv.getUint16(24, true), height: dv.getUint16(26, true), payload: bytes.subarray(hdr),
  };
}

// ------------------------------------------------------------------ H.264: Annex-B → avcC

/** The NAL units of an Annex-B access unit: [{ type, data }] (data without the start code, with the NAL header byte). */
export function splitNals(bytes) {
  const starts = [];
  for (let i = 0; i + 2 < bytes.length; i++) {
    if (bytes[i] === 0 && bytes[i + 1] === 0 && bytes[i + 2] === 1) { starts.push(i + 3); i += 2; }
  }
  return starts.map((s, n) => {
    let end = n + 1 < starts.length ? starts[n + 1] - 3 : bytes.length;
    while (end > s && bytes[end - 1] === 0) end--; // the zero of a 4-byte start code (and trailing_zero_8bits)
    return { type: bytes[s] & 0x1f, data: bytes.subarray(s, end) };
  }).filter((n) => n.data.length > 0);
}

export const NAL = Object.freeze({ slice: 1, idr: 5, sei: 6, sps: 7, pps: 8, aud: 9 });

/** `avc1.PPCCLL` from an SPS NAL (profile_idc, constraint flags, level_idc: bytes 1–3 after the header byte). */
export function codecString(sps) {
  const hex = (b) => b.toString(16).padStart(2, '0');
  return `avc1.${hex(sps[1])}${hex(sps[2])}${hex(sps[3])}`;
}

/** The AVCDecoderConfigurationRecord (the WebCodecs `description`) for one SPS and one PPS. */
export function buildAvcC(sps, pps) {
  const out = new Uint8Array(11 + sps.length + pps.length);
  out.set([1, sps[1], sps[2], sps[3], 0xff, 0xe1, sps.length >> 8, sps.length & 0xff]);
  out.set(sps, 8);
  const o = 8 + sps.length;
  out.set([1, pps.length >> 8, pps.length & 0xff], o);
  out.set(pps, o + 3);
  return out;
}

/** Slice NALs → one length-prefixed (4-byte) buffer; parameter sets and delimiters stay out (they live in the avcC). */
export function toAvcc(nals) {
  const keep = nals.filter((n) => n.type !== NAL.sps && n.type !== NAL.pps && n.type !== NAL.aud);
  const out = new Uint8Array(keep.reduce((s, n) => s + 4 + n.data.length, 0));
  const dv = new DataView(out.buffer);
  let o = 0;
  for (const n of keep) { dv.setUint32(o, n.data.length); out.set(n.data, o + 4); o += 4 + n.data.length; }
  return out;
}

// ------------------------------------------------------------------ H.264: low-delay SPS
// A decoder that finds no `bitstream_restriction` in the SPS assumes up to a full DPB of frames may be reordered and holds
// that many back before outputting (Chrome's VideoToolbox/D3D11/VA-API paths do). The stream has no B-frames, but the
// decoder cannot know, so nothing is output until ~16 frames are in — and the host's flow control (acks after decode) then
// stalls. Rewriting the SPS with max_num_reorder_frames = 0 (and a small DPB) makes it output every frame at once.

class Bits {
  constructor(bytes) { this.b = bytes; this.p = 0; }
  get left() { return this.b.length * 8 - this.p; }
  u(n) { let v = 0; for (let i = 0; i < n; i++) { if (this.p >= this.b.length * 8) throw new Error('sps: out of bits'); v = v * 2 + ((this.b[this.p >> 3] >> (7 - (this.p & 7))) & 1); this.p++; } return v; }
  ue() { let z = 0; while (this.u(1) === 0) { if (++z > 32) throw new Error('sps: bad exp-golomb'); } return z ? 2 ** z - 1 + this.u(z) : 0; }
  se() { const k = this.ue(); return k & 1 ? (k + 1) / 2 : -k / 2; }
}
class BitWriter {
  constructor() { this.bits = []; }
  u(n, v) { for (let i = n - 1; i >= 0; i--) this.bits.push(Math.floor(v / 2 ** i) % 2); }
  ue(v) { const x = v + 1, n = Math.floor(Math.log2(x)); this.u(n, 0); this.u(n + 1, x); }
  copy(bits, from, to) { for (let i = from; i < to; i++) this.bits.push((bits.b[i >> 3] >> (7 - (i & 7))) & 1); }
  bytes() { const out = []; const bits = [...this.bits, 1]; while (bits.length % 8) bits.push(0); for (let i = 0; i < bits.length; i += 8) out.push(parseInt(bits.slice(i, i + 8).join(''), 2)); return Uint8Array.from(out); }
}
const unescapeRbsp = (nal) => { const out = []; for (let i = 0; i < nal.length; i++) { if (i >= 2 && nal[i] === 3 && nal[i - 1] === 0 && nal[i - 2] === 0) continue; out.push(nal[i]); } return Uint8Array.from(out); };
const escapeRbsp = (rbsp) => { const out = []; let zeros = 0; for (const b of rbsp) { if (zeros >= 2 && b <= 3) { out.push(3); zeros = 0; } out.push(b); zeros = b === 0 ? zeros + 1 : 0; } return Uint8Array.from(out); };

function skipScalingList(r, size) { let last = 8, next = 8; for (let j = 0; j < size; j++) { if (next !== 0) { next = (last + r.se() + 256) % 256; } last = next === 0 ? last : next; } }
function skipHrd(r) { const n = r.ue(); r.u(4); r.u(4); for (let i = 0; i <= n; i++) { r.ue(); r.ue(); r.u(1); } r.u(20); }

/**
 * Where the SPS's VUI starts and what it has: { vuiPresent, vuiStart (bit), restrictionFlagAt (bit) | -1, maxNumRefFrames, restriction }. Throws on a
 * malformed SPS. `rbsp` = the NAL without its header byte, emulation prevention removed.
 */
export function parseSps(rbsp) {
  const r = new Bits(rbsp);
  const profile = r.u(8); r.u(8); r.u(8); r.ue();
  if ([100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134, 135].includes(profile)) {
    const chroma = r.ue();
    if (chroma === 3) r.u(1);
    r.ue(); r.ue(); r.u(1);
    if (r.u(1)) for (let i = 0; i < (chroma !== 3 ? 8 : 12); i++) if (r.u(1)) skipScalingList(r, i < 6 ? 16 : 64);
  }
  r.ue();
  const pocType = r.ue();
  if (pocType === 0) r.ue();
  else if (pocType === 1) { r.u(1); r.se(); r.se(); const n = r.ue(); for (let i = 0; i < n; i++) r.se(); }
  const maxNumRefFrames = r.ue();
  r.u(1); r.ue(); r.ue();
  if (!r.u(1)) r.u(1);
  r.u(1);
  if (r.u(1)) { r.ue(); r.ue(); r.ue(); r.ue(); }
  const vuiFlagAt = r.p;
  const vuiPresent = r.u(1) === 1;
  const out = { vuiPresent, vuiFlagAt, maxNumRefFrames, restrictionFlagAt: -1, restriction: null, bits: r.b.length * 8 };
  if (!vuiPresent) return out;
  if (r.u(1) && r.u(8) === 255) { r.u(16); r.u(16); } // aspect_ratio_info
  if (r.u(1)) r.u(1); // overscan
  if (r.u(1)) { r.u(3); r.u(1); if (r.u(1)) { r.u(8); r.u(8); r.u(8); } } // video_signal_type
  if (r.u(1)) { r.ue(); r.ue(); } // chroma_loc
  if (r.u(1)) { r.u(32); r.u(32); r.u(1); } // timing_info
  const nal = r.u(1) === 1; if (nal) skipHrd(r);
  const vcl = r.u(1) === 1; if (vcl) skipHrd(r);
  if (nal || vcl) r.u(1);
  r.u(1); // pic_struct_present
  out.restrictionFlagAt = r.p;
  if (r.u(1)) { r.u(1); r.ue(); r.ue(); r.ue(); r.ue(); out.restriction = { reorder: r.ue(), dpb: r.ue() }; }
  return out;
}

/**
 * The SPS NAL (with its header byte) rewritten so max_num_reorder_frames = 0 and max_dec_frame_buffering = max(1, refs); the same
 * NAL when it already says so or cannot be parsed. Profile, level and everything else stay as they were.
 */
export function lowDelaySps(nal) {
  try {
    const rbsp = unescapeRbsp(nal.subarray(1));
    const info = parseSps(rbsp);
    const dpb = Math.max(1, info.maxNumRefFrames);
    if (info.restriction && info.restriction.reorder === 0 && info.restriction.dpb <= Math.max(dpb, info.restriction.dpb)) return nal;
    const src = new Bits(rbsp);
    const w = new BitWriter();
    const restriction = () => { w.u(1, 1); w.u(1, 1); w.ue(0); w.ue(0); w.ue(15); w.ue(15); w.ue(0); w.ue(dpb); };
    if (!info.vuiPresent) {
      w.copy(src, 0, info.vuiFlagAt);
      w.u(1, 1);
      w.u(1, 0); w.u(1, 0); w.u(1, 0); w.u(1, 0); w.u(1, 0); w.u(1, 0); w.u(1, 0); w.u(1, 0); // aspect, overscan, video_signal, chroma_loc, timing, nal_hrd, vcl_hrd, pic_struct
      restriction();
    } else if (info.restrictionFlagAt >= 0 && !info.restriction) {
      w.copy(src, 0, info.restrictionFlagAt);
      restriction();
    } else if (info.restriction) {
      // restriction present with reordering: re-write just that tail
      w.copy(src, 0, info.restrictionFlagAt);
      restriction();
    } else return nal;
    const out = escapeRbsp(w.bytes());
    const res = new Uint8Array(1 + out.length);
    res[0] = nal[0]; res.set(out, 1);
    return res;
  } catch { return nal; }
}

const same = (a, b) => !!a && !!b && a.length === b.length && a.every((v, i) => v === b[i]);

/** Remembers the SPS/PPS seen so far; says when the decoder needs (re)configuring and with what. */
export class H264Config {
  constructor() { this.sps = null; this.pps = null; this.configured = false; }
  /** → { configure: { codec, description } | null, idr: bool, avcc: Uint8Array | null }. */
  update(payload) {
    const nals = splitNals(payload);
    const sps = nals.find((n) => n.type === NAL.sps)?.data;
    const pps = nals.find((n) => n.type === NAL.pps)?.data;
    let changed = false;
    if (sps && !same(sps, this.sps)) { this.sps = Uint8Array.from(sps); changed = true; }
    if (pps && !same(pps, this.pps)) { this.pps = Uint8Array.from(pps); changed = true; }
    const ready = !!(this.sps && this.pps);
    const configure = ready && (changed || !this.configured) ? { codec: codecString(this.sps), description: buildAvcC(lowDelaySps(this.sps), this.pps) } : null;
    if (configure) this.configured = true;
    return { configure, idr: nals.some((n) => n.type === NAL.idr), avcc: ready ? toAvcc(nals) : null };
  }
  reset() { this.configured = false; }
}

// ------------------------------------------------------------------ backpressure: what the viewer does with a frame

export const MAX_QUEUE = 3;

/**
 * §5.6: decode, or drop until the next IDR. `st` = { lastSeq (-1 at the start), needKey }; → { action: 'decode'|'drop',
 * st, request: null | 'join' | 'gap' | 'decode-error' } (a keyframe request to send). A key frame always resets the wait.
 */
export function judgeFrame(st, f, { queueSize = 0 } = {}) {
  const gap = st.lastSeq >= 0 && f.seq !== st.lastSeq + 1 && !f.repeat;
  const next = { lastSeq: f.seq, needKey: st.needKey };
  if (f.key || f.discontinuity) return { action: 'decode', st: { lastSeq: f.seq, needKey: false }, request: null };
  if (st.needKey) return { action: 'drop', st: next, request: null };
  if (gap) return { action: 'drop', st: { lastSeq: f.seq, needKey: true }, request: 'gap' };
  if (queueSize > MAX_QUEUE) return { action: 'drop', st: { lastSeq: f.seq, needKey: true }, request: 'gap' };
  return { action: 'decode', st: next, request: null };
}

/**
 * While waiting for a key frame, ask again every `every` ms: the host coalesces key frame requests (one per 500 ms) and a request
 * made right after the stream's own first IDR can be swallowed, which would leave the viewer dropping frames for ever.
 */
export const shouldAskKey = (st, now, last, every = 400) => !!st.needKey && now - last >= every;

/** A decode error: wait for a key frame and ask for one. */
export const afterDecodeError = (st) => ({ st: { ...st, needKey: true }, request: 'decode-error' });

// ------------------------------------------------------------------ size policy (§5.2)

export const SIZE_PRESETS = Object.freeze({ '720p': [1280, 720], '1080p': [1920, 1080], '1440p': [2560, 1440] });
export const MIN_SIZE = Object.freeze([640, 360]);
const even = (n) => Math.max(16, Math.floor(n / 2) * 2);

/**
 * The size to ask the host for. `fit`: 'window' (the stage × min(dpr, 2)), a preset name ('720p'…), or 'screen' (the
 * device's screen). Phones default to 720p via `defaultFit`. Clamped to [640×360, max], even numbers.
 */
export function wantSize({ cssW = 0, cssH = 0, dpr = 1, fit = 'window', screen = null, max = [3840, 2160] } = {}) {
  let w, h;
  if (SIZE_PRESETS[fit]) [w, h] = SIZE_PRESETS[fit];
  else if (fit === 'screen' && screen) { w = screen.width * Math.min(dpr, 2); h = screen.height * Math.min(dpr, 2); } else { w = cssW * Math.min(dpr, 2); h = cssH * Math.min(dpr, 2); }
  if (!(w > 0 && h > 0)) [w, h] = SIZE_PRESETS['720p'];
  w = Math.min(Math.max(w, MIN_SIZE[0]), max[0]);
  h = Math.min(Math.max(h, MIN_SIZE[1]), max[1]);
  return { width: even(w), height: even(h) };
}
export const defaultFit = (phone) => (phone ? '720p' : 'window');

export const QUALITIES = Object.freeze([['auto', 'Auto'], ['low', 'Low'], ['balanced', 'Balanced'], ['high', 'High'], ['max', 'Max']]);
export const FPS_CHOICES = Object.freeze([30, 60]);
export const SIZE_CHOICES = Object.freeze([['window', 'Match window'], ['720p', '1280×720'], ['1080p', '1920×1080'], ['screen', 'Match screen']]);
/** The `config` message for a quality choice ('auto' keeps the host's adaptive balanced default). */
export const configMessage = ({ quality, fps } = {}) => ({ type: 'config', ...(fps ? { fps } : {}), quality: !quality || quality === 'auto' ? 'balanced' : quality });

// ------------------------------------------------------------------ coordinates

/** Which of the viewer's decoders to offer, from what the browser has. */
export function decoderCaps({ secure = false, webcodecs = false, mse = false } = {}) {
  return [secure && webcodecs ? 'webcodecs' : null, secure && mse ? 'mse' : null, 'jpeg'].filter(Boolean);
}

/**
 * A client point → stream pixels. `rect` = the stage element's box (the canvas, `object-fit: contain`, so the picture is
 * letterboxed inside it); `stream` = { width, height }. → { x, y, inside } with x, y clamped into the picture.
 */
export function streamPoint(clientX, clientY, rect, stream) {
  if (!rect?.width || !rect?.height || !stream?.width || !stream?.height) return { x: 0, y: 0, inside: false };
  const k = Math.min(rect.width / stream.width, rect.height / stream.height);
  const dw = stream.width * k, dh = stream.height * k;
  const ox = (rect.width - dw) / 2, oy = (rect.height - dh) / 2;
  const px = (clientX - rect.left - ox) / k, py = (clientY - rect.top - oy) / k;
  const inside = px >= 0 && py >= 0 && px < stream.width && py < stream.height;
  return { x: Math.round(Math.min(Math.max(px, 0), stream.width - 1)), y: Math.round(Math.min(Math.max(py, 0), stream.height - 1)), inside };
}

/** Pointer lock: the cursor moved by (movementX, movementY) CSS px → new stream position, clamped. */
export function lockedMove(pos, mx, my, rect, stream) {
  const k = Math.min(rect.width / stream.width, rect.height / stream.height) || 1;
  return { x: Math.round(Math.min(Math.max(pos.x + mx / k, 0), stream.width - 1)), y: Math.round(Math.min(Math.max(pos.y + my / k, 0), stream.height - 1)) };
}

// ------------------------------------------------------------------ input events (§5.3, §8.3)

export const BUTTON = Object.freeze({ left: 0, middle: 1, right: 2, back: 3, forward: 4 });
/** DOM `MouseEvent.button` (0 left, 1 middle, 2 right, 3 back, 4 forward) is the protocol's numbering. */
export const buttonOf = (b) => (b >= 0 && b <= 4 ? b : 0);

/** A DOM wheel event → pw. Pixels stay pixels; lines and pages become line steps (a page = 3 lines). */
export function wheelEvent({ deltaX = 0, deltaY = 0, deltaMode = 0 } = {}) {
  if (deltaMode === 0) return { k: 'pw', dx: Math.round(deltaX * 100) / 100, dy: Math.round(deltaY * 100) / 100, mode: 'px' };
  const f = deltaMode === 2 ? 3 : 1;
  return { k: 'pw', dx: Math.round(deltaX * f), dy: Math.round(deltaY * f), mode: 'line' };
}

const MAC_TO_LINUX = { MetaLeft: 'ControlLeft', MetaRight: 'ControlRight', ControlLeft: 'MetaLeft', ControlRight: 'MetaRight' };
/** Mac viewer → Linux host: ⌘ acts as Ctrl and Ctrl as Super, so ⌘C/⌘V/⌘Z behave as Ctrl+C/V/Z on the host. */
export const swapModifier = (code, on) => (on && MAC_TO_LINUX[code]) || code;

/** A key event → kc. `swap`: the Mac↔Linux modifier swap. */
export const keyEvent = (code, down, { swap = false } = {}) => ({ k: 'kc', c: swapModifier(code, swap), d: down ? 1 : 0 });

const RESERVED_META = new Set(['KeyW', 'KeyT', 'KeyN', 'KeyQ', 'KeyR', 'KeyL', 'KeyM', 'KeyH', 'Tab', 'Backquote', 'Space', 'Comma']);
/**
 * Keys the browser or OS keeps when keyboard capture is off (Cmd+Tab, Cmd+W, Alt+Tab, F5, F11, F12, Ctrl+Tab…).
 * With capture on (or Keyboard Lock in full screen) everything goes to the app.
 */
export function isReservedKey({ code = '', metaKey = false, ctrlKey = false, altKey = false, shiftKey = false } = {}, { mac = false } = {}) {
  if (code === 'F5' || code === 'F11' || code === 'F12') return true;
  if (altKey && code === 'Tab') return true;
  if (ctrlKey && (code === 'Tab' || code === 'PageUp' || code === 'PageDown')) return true;
  if (mac ? metaKey && RESERVED_META.has(code) : ctrlKey && shiftKey && ['KeyI', 'KeyJ', 'KeyC', 'KeyN', 'KeyT', 'KeyW'].includes(code)) return true;
  if (!mac && ctrlKey && ['KeyW', 'KeyT', 'KeyN', 'KeyL', 'KeyR'].includes(code) && !shiftKey) return true;
  return false;
}

/** The paste shortcut (Ctrl/⌘+V) in the viewer: read the viewer's clipboard instead of forwarding the key. */
export const isPasteChord = ({ code, metaKey, ctrlKey, altKey }) => code === 'KeyV' && !!(metaKey || ctrlKey) && !altKey;
export const isCopyChord = ({ code, metaKey, ctrlKey, altKey }) => (code === 'KeyC' || code === 'KeyX') && !!(metaKey || ctrlKey) && !altKey;

/** A chord (modifiers down in order, then up in reverse) as kc events: ['ControlLeft','AltLeft','Delete']. */
export function chord(codes) {
  return [...codes.map((c) => keyEvent(c, true)), ...[...codes].reverse().map((c) => keyEvent(c, false))];
}

/** The paste chord sent to the host after the clipboard text is set (always Ctrl+V on a Linux host). */
export const pasteChord = () => chord(['ControlLeft', 'KeyV']);

export const SPECIAL_KEYS = Object.freeze([
  ['Esc', ['Escape']], ['Tab', ['Tab']], ['Enter', ['Enter']], ['Super', ['MetaLeft']], ['Ctrl+C', ['ControlLeft', 'KeyC']], ['Ctrl+V', ['ControlLeft', 'KeyV']],
  ['Ctrl+Z', ['ControlLeft', 'KeyZ']], ['Alt+Tab', ['AltLeft', 'Tab']], ['Ctrl+Alt+Del', ['ControlLeft', 'AltLeft', 'Delete']],
  ['←', ['ArrowLeft']], ['↑', ['ArrowUp']], ['↓', ['ArrowDown']], ['→', ['ArrowRight']], ['Home', ['Home']], ['End', ['End']], ['PgUp', ['PageUp']], ['PgDn', ['PageDown']],
  ...Array.from({ length: 12 }, (_, i) => [`F${i + 1}`, [`F${i + 1}`]]),
]);

/** Soft keyboard: a `beforeinput` → protocol events (composition text waits for compositionend). */
export function beforeInputEvents({ inputType = '', data = '' } = {}) {
  switch (inputType) {
    case 'insertText': case 'insertReplacementText': return data ? [{ k: 'tx', s: String(data).slice(0, 4000) }] : [];
    case 'insertLineBreak': case 'insertParagraph': return chord(['Enter']);
    case 'deleteContentBackward': case 'deleteWordBackward': return chord(['Backspace']);
    case 'deleteContentForward': return chord(['Delete']);
    default: return [];
  }
}
export const compositionEndEvents = (data) => (data ? [{ k: 'tx', s: String(data).slice(0, 4000) }] : []);

/**
 * Input batches: events collected during a frame, sent as one { type:'in', seq, e } (≤ 64 events). Consecutive pointer
 * moves collapse into the last one and consecutive wheel events of one mode add up.
 */
export class InputBatcher {
  constructor(max = 64) { this.seq = 0; this.q = []; this.max = max; }
  get pending() { return this.q.length; }
  push(e) {
    const last = this.q[this.q.length - 1];
    if (e.k === 'pm' && last?.k === 'pm') { this.q[this.q.length - 1] = e; return; }
    if (e.k === 'pw' && last?.k === 'pw' && last.mode === e.mode) { this.q[this.q.length - 1] = { ...last, dx: last.dx + e.dx, dy: last.dy + e.dy }; return; }
    this.q.push(e);
  }
  /** → null when nothing is pending, else the next message (call again while `pending`). */
  flush() {
    if (!this.q.length) return null;
    return { type: 'in', seq: ++this.seq, e: this.q.splice(0, this.max) };
  }
  clear() { this.q = []; }
}

// ------------------------------------------------------------------ phone gestures (§8.3)

export const HOLD_MS = 500;
export const TAP_MS = 300;
export const SLOP = 8;
export const TOUCHPAD_GAIN = 1.5;

/**
 * Touch → pointer, Direct or Touchpad mode. Feed `down/move/up(id, x, y, t)` (client px, ms) and `tick(t)` (for press-and-hold);
 * each returns actions for the DOM layer:
 *   { a:'move', x, y }      pointer to a client point (Direct) · { a:'rel', dx, dy } pointer by a delta (Touchpad)
 *   { a:'btn', b, d }       button down/up at the pointer · { a:'click', b, x?, y? } press+release (at the point, else at the pointer)
 *   { a:'wheel', dx, dy }   scroll (px) · { a:'zoom', k, cx, cy } local zoom factor (not sent) · { a:'pan', dx, dy } local pan
 */
export class TouchGestures {
  constructor({ mode = 'direct' } = {}) { this.mode = mode; this.reset(); this.lastTap = null; }
  reset() { this.f = new Map(); this.state = 'idle'; this.t0 = 0; this.moved = false; this.pinch = null; this.fired = false; }
  setMode(m) { this.mode = m === 'touchpad' ? 'touchpad' : 'direct'; this.reset(); }
  down(id, x, y, t) {
    const out = [];
    this.f.set(id, { x, y, sx: x, sy: y });
    if (this.f.size === 1) { this.state = 'one'; this.t0 = t; this.moved = false; this.fired = false; return out; }
    if (this.f.size === 2) {
      if (this.state === 'drag') out.push({ a: 'btn', b: 0, d: 0 });
      this.state = 'two'; this.t0 = t; this.moved = false; this.pinch = null;
      const [p, q] = [...this.f.values()];
      this.d0 = Math.hypot(p.x - q.x, p.y - q.y) || 1; this.dPrev = this.d0; this.c = { x: (p.x + q.x) / 2, y: (p.y + q.y) / 2 };
    }
    return out;
  }
  move(id, x, y) {
    const p = this.f.get(id);
    if (!p) return [];
    const dx = x - p.x, dy = y - p.y;
    p.x = x; p.y = y;
    if (this.state === 'one') {
      if (this.fired) return [];
      if (Math.hypot(x - p.sx, y - p.sy) < SLOP && !this.moved) return [];
      this.moved = true;
      if (this.mode === 'touchpad') return [{ a: 'rel', dx: dx * TOUCHPAD_GAIN, dy: dy * TOUCHPAD_GAIN }];
      this.state = 'drag';
      return [{ a: 'move', x: p.sx, y: p.sy }, { a: 'btn', b: 0, d: 1 }, { a: 'move', x, y }];
    }
    if (this.state === 'drag') return [{ a: 'move', x, y }];
    if (this.state === 'two' && this.f.size === 2) {
      const [a, b] = [...this.f.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y) || 1;
      const c = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      const mdx = c.x - this.c.x, mdy = c.y - this.c.y;
      const travelled = Math.hypot(c.x - (a.sx + b.sx) / 2, c.y - (a.sy + b.sy) / 2);
      if (!this.pinch) {
        const stretch = Math.abs(d - this.d0);
        if (stretch < SLOP && travelled < SLOP) { this.dPrev = d; this.c = c; return []; }
        this.pinch = this.mode === 'direct' && stretch > travelled ? 'zoom' : 'scroll';
        this.moved = true;
      }
      const out = this.pinch === 'zoom'
        ? [{ a: 'zoom', k: d / this.dPrev, cx: c.x, cy: c.y }, { a: 'pan', dx: mdx, dy: mdy }]
        : [{ a: 'wheel', dx: -mdx, dy: -mdy }];
      this.dPrev = d; this.c = c;
      return out;
    }
    return [];
  }
  up(id, t) {
    const p = this.f.get(id);
    if (!p) return [];
    this.f.delete(id);
    const out = [];
    if (this.state === 'one') {
      if (!this.moved && !this.fired) {
        const at = this.mode === 'direct' ? { x: p.x, y: p.y } : {};
        out.push({ a: 'click', b: 0, ...at });
        this.lastTap = t;
      }
      this.state = 'idle';
    } else if (this.state === 'drag') {
      out.push({ a: 'btn', b: 0, d: 0 });
      this.state = 'idle';
    } else if (this.state === 'two') {
      if (!this.moved && t - this.t0 < TAP_MS) {
        const at = this.mode === 'direct' ? { x: this.c.x, y: this.c.y } : {};
        out.push({ a: 'click', b: 2, ...at });
      }
      this.state = 'after-two';
    }
    if (!this.f.size) this.state = 'idle';
    return out;
  }
  /** Press and hold: one finger down for HOLD_MS without moving is a right click, once. */
  tick(t) {
    if (this.state !== 'one' || this.fired || this.moved || t - this.t0 < HOLD_MS) return [];
    const p = [...this.f.values()][0];
    this.fired = true;
    return [{ a: 'click', b: 2, ...(this.mode === 'direct' ? { x: p.x, y: p.y } : {}) }];
  }
  cancel() { const held = this.state === 'drag'; this.reset(); return held ? [{ a: 'btn', b: 0, d: 0 }] : []; }
}

/** Local zoom of the stage (not sent to the host): 1×–4×, the pan kept so the picture still covers the stage. */
export function applyZoom(view, k, cx, cy, rect) {
  const scale = Math.min(4, Math.max(1, view.scale * k));
  if (scale === 1) return { scale: 1, tx: 0, ty: 0 };
  // keep the point under (cx, cy) fixed while scaling about the stage centre
  const mx = cx - (rect.left + rect.width / 2), my = cy - (rect.top + rect.height / 2);
  const r = scale / view.scale;
  return clampPan({ scale, tx: view.tx - mx * (r - 1), ty: view.ty - my * (r - 1) }, rect);
}
export function clampPan(view, rect) {
  const mx = (rect.width * (view.scale - 1)) / 2, my = (rect.height * (view.scale - 1)) / 2;
  return { ...view, tx: Math.min(mx, Math.max(-mx, view.tx)), ty: Math.min(my, Math.max(-my, view.ty)) };
}

// ------------------------------------------------------------------ stats and clock

/** The last `n` samples with percentiles. */
export class Rolling {
  constructor(n = 120) { this.n = n; this.v = []; }
  add(x) { if (Number.isFinite(x)) { this.v.push(x); if (this.v.length > this.n) this.v.shift(); } }
  get count() { return this.v.length; }
  p(q) {
    if (!this.v.length) return null;
    const s = [...this.v].sort((a, b) => a - b);
    return s[Math.min(s.length - 1, Math.floor(q * s.length))];
  }
}

/** Events per second over the last `windowMs` (frames for fps, bytes for bitrate). */
export class Meter {
  constructor(windowMs = 1000) { this.w = windowMs; this.e = []; }
  add(t, amount = 1) { this.e.push([t, amount]); }
  rate(now) {
    while (this.e.length && this.e[0][0] < now - this.w) this.e.shift();
    return this.e.reduce((s, x) => s + x[1], 0) / (this.w / 1000);
  }
}

/**
 * Viewer clock → host monotonic clock, from ping/pong: offset = serverUs − (t0 + now)/2, kept for the lowest-RTT sample
 * (the least asymmetric one). All in µs. `glassToGlassMs` uses it for a frame's capture time.
 */
export class ClockSync {
  constructor() { this.best = null; }
  sample(t0Us, nowUs, serverUs) {
    const rtt = nowUs - t0Us;
    if (!(rtt >= 0) || !Number.isFinite(serverUs)) return null;
    if (!this.best || rtt <= this.best.rtt) this.best = { rtt, offset: serverUs - (t0Us + nowUs) / 2 };
    return rtt / 1000;
  }
  get ready() { return !!this.best; }
  glassToGlassMs(captureUs, nowUs) { return this.best ? (nowUs + this.best.offset - captureUs) / 1000 : null; }
}

export const fmtKbps = (kbps) => (kbps >= 1000 ? `${(kbps / 1000).toFixed(1)} Mbit/s` : `${Math.round(kbps)} kbit/s`);
export const fmtMs = (ms) => (ms == null ? '–' : ms < 10 ? ms.toFixed(1) : String(Math.round(ms)));

// ------------------------------------------------------------------ connection

export const backoffMs = (attempt) => Math.min(8000, 500 * 2 ** Math.max(0, attempt));

/**
 * What a WebSocket close means (§5.5): { reconnect, state: 'reconnecting'|'ended'|'refused' }. Never reconnect after
 * 4400/4403/4404/4410/4412/4501; reconnect after 1006 and 4503 (and any other drop) with backoff.
 */
export function closeAction(code, { ended = false, refused = false } = {}) {
  if (ended || code === 4410 || code === 4404) return { reconnect: false, state: 'ended' };
  if (refused || (code >= 4400 && code < 4600 && code !== 4503)) return { reconnect: false, state: 'refused' };
  return { reconnect: true, state: 'reconnecting' };
}

const END_TEXT = {
  'app-exited': 'The app was closed.', stopped: 'The session was stopped.', killed: 'Streaming was stopped on the host (the app keeps running, parked).',
  'parked-expired': 'The session expired after nobody watched it.', 'host-restart': 'The host is restarting.',
};
export const endText = (m = {}) => END_TEXT[m.reason] || m.message || 'The session ended.';

/** The words for a refusal: { text, fix?, action?: 'enable' } (the `appstream-off` refusal gets the "turn it on" action). */
export function refusalText(m = {}, nodeName = 'the host') {
  const status = m.status || m.code || '';
  if (status === 'appstream-off' || m.code === 'off') return { text: `App streaming is switched off on ${nodeName}.`, fix: m.fix || '', action: 'enable' };
  if (status === 'busy') return { text: `${nodeName} is already running the most sessions it allows.`, fix: m.fix || 'Stop another app session first.' };
  if (status === 'no-session') return { text: 'This session no longer exists.', fix: 'Open the app again from Applications.' };
  if (status === 'busy-lease') return { text: m.message || `An agent holds screen control on ${nodeName}.`, fix: m.fix || 'Wait for it to finish, or stop it from Access & control.' };
  if (status === 'locked') return { text: m.message || `${nodeName} is locked.`, fix: m.fix || 'Unlock it, then try again.' };
  if (status === 'unsupported') return { text: m.message || `${nodeName} cannot host app streaming.`, fix: m.fix || '' };
  if (status === 'needs-permission') return { text: m.message || 'A macOS permission is missing.', fix: m.fix || '' };
  if (status === 'killed' || status === 'control-off') return { text: m.message || `Streaming was stopped on ${nodeName}.`, fix: m.fix || '' };
  return { text: m.message || `${nodeName} refused the stream.`, fix: m.fix || '' };
}

/** Shown once when the viewer is not in a secure context (no WebCodecs). */
export const INSECURE_HINT = 'For hardware decoding open JARVIS over HTTPS (https://<machine>.<tailnet>.ts.net, or run `rigs setup --https` on this machine). Using the slower JPEG stream meanwhile.';

/**
 * A `status` message in the middle of a stream → what to do with it: { kind: 'wait' | 'note' | 'refusal', text, fix? }.
 * 'starting' waits for the first frame; informational statuses are a short note on the stream; anything the host marks as a
 * refusal (it carries a `fix`, or is one of the refusal codes) is a toast that keeps the stream, e.g. an input refused
 * because the screen is locked or an agent holds control.
 */
export function statusAction(m = {}) {
  const status = m.status || '';
  if (status === 'ok') return { kind: 'ok' };
  if (status === 'starting') return { kind: 'wait', text: m.message || 'Starting the app…' };
  if (['encoder-fallback', 'throttled', 'app-not-responding'].includes(status)) return { kind: 'note', text: m.message || status };
  const r = refusalText(m, 'the host');
  return { kind: 'refusal', text: r.text, fix: r.fix };
}
