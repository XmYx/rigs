// The app stream viewer's pure logic (ui/src/app-stream-model.js): frame header, Annex-B → avcC and the codec string, the
// drop/keyframe policy, size policy, coordinates, input events and batching, the Mac↔Linux modifier swap, phone gestures,
// stats and clock estimate, reconnect rules. Frame headers are built here the way the host builds them (src/app-stream.js).
import assert from 'node:assert/strict';
import { test } from 'node:test';

const M = await import('../ui/src/app-stream-model.js');
const S = await import('../src/app-stream.js');

const SPS = Uint8Array.from([0x67, 0x64, 0x00, 0x1f, 0xac, 0xd9, 0x40, 0x50]);
const PPS = Uint8Array.from([0x68, 0xeb, 0xe3, 0xcb, 0x22, 0xc0]);
const IDR = Uint8Array.from([0x65, 0x88, 0x84, 0x00, 0x10]);
const P = Uint8Array.from([0x41, 0x9a, 0x02, 0x03]);
const sc4 = [0, 0, 0, 1], sc3 = [0, 0, 1];
const annexB = (...parts) => Uint8Array.from(parts.flatMap(([sc, nal]) => [...sc, ...nal]));

test('parseFrame reads the header the host writes (round trip with encodeHeader)', () => {
  const payload = Buffer.from([1, 2, 3, 4]);
  const buf = S.encodeHeader({ kind: 1, flags: 3, seq: 77, captureUs: 123456789012n, encodeUs: 4900, inputSeq: 9, width: 1920, height: 1080 }, payload);
  const f = M.parseFrame(buf);
  assert.deepEqual([f.kind, f.key, f.config, f.discontinuity, f.repeat], [1, true, true, false, false]);
  assert.deepEqual([f.seq, f.captureUs, f.encodeUs, f.inputSeq, f.width, f.height], [77, 123456789012, 4900, 9, 1920, 1080]);
  assert.deepEqual([...f.payload], [1, 2, 3, 4]);
  assert.equal(M.parseFrame(new Uint8Array(10)), null);
  // a longer header (readers skip unknown extra bytes)
  const long = new Uint8Array(40 + 2); long.set(buf.subarray(0, 32)); new DataView(long.buffer).setUint16(2, 40, true); long[40] = 9; long[41] = 8;
  assert.deepEqual([...M.parseFrame(long).payload], [9, 8]);
  assert.equal(M.HEADER_LEN, S.HEADER_LEN);
  assert.deepEqual(M.KIND, S.KIND);
});

test('splitNals: 3- and 4-byte start codes, header byte kept, trailing zeros dropped', () => {
  const nals = M.splitNals(annexB([sc4, SPS], [sc4, PPS], [sc3, IDR]));
  assert.deepEqual(nals.map((n) => n.type), [7, 8, 5]);
  assert.deepEqual([...nals[0].data], [...SPS]);
  assert.deepEqual([...nals[2].data], [...IDR]);
  assert.deepEqual(M.splitNals(Uint8Array.from([1, 2, 3])), []);
});

test('codecString from the SPS bytes after the NAL header, avcC layout, avcc length prefixes', () => {
  assert.equal(M.codecString(SPS), 'avc1.64001f');
  assert.equal(M.codecString(Uint8Array.from([0x67, 0x42, 0xc0, 0x1e])), 'avc1.42c01e');
  const c = M.buildAvcC(SPS, PPS);
  assert.deepEqual([...c.subarray(0, 8)], [1, 0x64, 0x00, 0x1f, 0xff, 0xe1, 0, SPS.length]);
  assert.deepEqual([...c.subarray(8, 8 + SPS.length)], [...SPS]);
  const o = 8 + SPS.length;
  assert.deepEqual([...c.subarray(o, o + 3)], [1, 0, PPS.length]);
  assert.deepEqual([...c.subarray(o + 3)], [...PPS]);
  const avcc = M.toAvcc(M.splitNals(annexB([sc4, SPS], [sc4, PPS], [sc4, Uint8Array.from([0x09, 0xf0])], [sc3, IDR])));
  assert.deepEqual([...avcc], [0, 0, 0, IDR.length, ...IDR]); // SPS, PPS and AUD stay out
});

test('H264Config: configure once per SPS/PPS change; nothing before both are known; idr flag', () => {
  const c = new M.H264Config();
  assert.equal(c.update(annexB([sc4, P])).configure, null); // no parameter sets yet: not decodable
  assert.equal(c.update(annexB([sc4, P])).avcc, null);
  const first = c.update(annexB([sc4, SPS], [sc4, PPS], [sc4, IDR]));
  assert.equal(first.configure.codec, 'avc1.64001f');
  assert.equal(first.idr, true);
  assert.ok(first.configure.description.length > 10);
  const again = c.update(annexB([sc4, SPS], [sc4, PPS], [sc4, IDR]));
  assert.equal(again.configure, null); // same parameter sets: no reconfigure
  const pf = c.update(annexB([sc4, P]));
  assert.equal(pf.configure, null);
  assert.equal(pf.idr, false);
  assert.deepEqual([...pf.avcc], [0, 0, 0, P.length, ...P]);
  const sps2 = Uint8Array.from([0x67, 0x64, 0x00, 0x2a, 0xac, 0xd9]);
  assert.equal(c.update(annexB([sc4, sps2], [sc4, PPS], [sc4, IDR])).configure.codec, 'avc1.64002a'); // a resize changes the level
  c.reset();
  assert.ok(c.update(annexB([sc4, P])).configure); // after reset it configures again from the remembered sets
});

test('judgeFrame: key frames decode; gaps and a long queue drop until the next IDR and ask for one', () => {
  let st = { lastSeq: -1, needKey: true };
  let r = M.judgeFrame(st, { seq: 5, key: false }); // joined mid-stream: wait for a key frame
  assert.deepEqual([r.action, r.request], ['drop', null]);
  r = M.judgeFrame(r.st, { seq: 6, key: true });
  assert.deepEqual([r.action, r.st.needKey], ['decode', false]);
  r = M.judgeFrame(r.st, { seq: 7, key: false });
  assert.equal(r.action, 'decode');
  r = M.judgeFrame(r.st, { seq: 9, key: false }); // seq gap
  assert.deepEqual([r.action, r.request, r.st.needKey], ['drop', 'gap', true]);
  r = M.judgeFrame(r.st, { seq: 10, key: false }); // still waiting: no second request
  assert.deepEqual([r.action, r.request], ['drop', null]);
  r = M.judgeFrame(r.st, { seq: 11, key: true });
  assert.equal(r.action, 'decode');
  r = M.judgeFrame(r.st, { seq: 12, key: false }, { queueSize: 4 }); // decoder backed up
  assert.deepEqual([r.action, r.request], ['drop', 'gap']);
  r = M.judgeFrame({ lastSeq: 20, needKey: false }, { seq: 25, key: true });
  assert.equal(r.action, 'decode'); // a key frame resyncs across a gap
  r = M.judgeFrame({ lastSeq: 20, needKey: false }, { seq: 20, key: false, repeat: true });
  assert.equal(r.action, 'decode'); // a keepalive repeat is not a gap
  assert.deepEqual(M.afterDecodeError({ lastSeq: 3, needKey: false }), { st: { lastSeq: 3, needKey: true }, request: 'decode-error' });
});

test('wantSize: window × min(dpr, 2), presets, screen, clamps and even numbers', () => {
  assert.deepEqual(M.wantSize({ cssW: 1000, cssH: 600, dpr: 2 }), { width: 2000, height: 1200 });
  assert.deepEqual(M.wantSize({ cssW: 1000, cssH: 600, dpr: 3 }), { width: 2000, height: 1200 }); // dpr capped at 2
  assert.deepEqual(M.wantSize({ cssW: 801, cssH: 451, dpr: 1 }), { width: 800, height: 450 });
  assert.deepEqual(M.wantSize({ cssW: 100, cssH: 100, dpr: 1 }), { width: 640, height: 360 });
  assert.deepEqual(M.wantSize({ cssW: 5000, cssH: 3000, dpr: 2, max: [3840, 2160] }), { width: 3840, height: 2160 });
  assert.deepEqual(M.wantSize({ fit: '720p', cssW: 390, cssH: 844, dpr: 3 }), { width: 1280, height: 720 });
  assert.deepEqual(M.wantSize({ fit: '1080p' }), { width: 1920, height: 1080 });
  assert.deepEqual(M.wantSize({ fit: 'screen', screen: { width: 390, height: 844 }, dpr: 2 }), { width: 780, height: 1688 });
  assert.deepEqual(M.wantSize({}), { width: 1280, height: 720 }); // nothing measured yet
  assert.equal(M.defaultFit(true), '720p');
  assert.equal(M.defaultFit(false), 'window');
  // what the host accepts: the same numbers go through its own policy unchanged
  const w = M.wantSize({ cssW: 780, cssH: 1688, dpr: 1 });
  assert.deepEqual([w.width % 2, w.height % 2], [0, 0]);
});

test('config and caps: quality auto is balanced; decoders offered by what the browser has', () => {
  assert.deepEqual(M.configMessage({ quality: 'auto', fps: 30 }), { type: 'config', fps: 30, quality: 'balanced' });
  assert.deepEqual(M.configMessage({ quality: 'max' }), { type: 'config', quality: 'max' });
  assert.deepEqual(M.decoderCaps({ secure: true, webcodecs: true, mse: true }), ['webcodecs', 'mse', 'jpeg']);
  assert.deepEqual(M.decoderCaps({ secure: false, webcodecs: true, mse: true }), ['jpeg']); // WebCodecs needs a secure context
  assert.deepEqual(M.decoderCaps({ secure: true }), ['jpeg']);
});

test('streamPoint: letterbox and clamping', () => {
  const stream = { width: 1920, height: 1080 };
  // a 1000x1000 box at (100, 50): the 16:9 picture is 1000x562.5, centred vertically
  const rect = { left: 100, top: 50, width: 1000, height: 1000 };
  assert.deepEqual(M.streamPoint(100, 50 + 218.75, rect, stream), { x: 0, y: 0, inside: true });
  const mid = M.streamPoint(600, 550, rect, stream);
  assert.deepEqual([mid.x, mid.y, mid.inside], [960, 540, true]);
  const bar = M.streamPoint(600, 60, rect, stream); // on the black bar above the picture
  assert.deepEqual([bar.inside, bar.y], [false, 0]);
  const out = M.streamPoint(5000, 5000, rect, stream);
  assert.deepEqual([out.x, out.y, out.inside], [1919, 1079, false]);
  assert.deepEqual(M.streamPoint(1, 1, { left: 0, top: 0, width: 0, height: 0 }, stream), { x: 0, y: 0, inside: false });
  assert.deepEqual(M.lockedMove({ x: 100, y: 100 }, 50, -500, { width: 960, height: 540 }, stream), { x: 200, y: 0 }); // 2 px per css px
});

test('wheelEvent: pixels stay pixels; lines and pages are line steps', () => {
  assert.deepEqual(M.wheelEvent({ deltaX: 0, deltaY: 120, deltaMode: 0 }), { k: 'pw', dx: 0, dy: 120, mode: 'px' });
  assert.deepEqual(M.wheelEvent({ deltaX: 0, deltaY: -3, deltaMode: 1 }), { k: 'pw', dx: 0, dy: -3, mode: 'line' });
  assert.deepEqual(M.wheelEvent({ deltaX: 0, deltaY: 1, deltaMode: 2 }), { k: 'pw', dx: 0, dy: 3, mode: 'line' });
});

test('Mac viewer → Linux host: Meta ↔ Control swap, only when on', () => {
  assert.equal(M.swapModifier('MetaLeft', true), 'ControlLeft');
  assert.equal(M.swapModifier('MetaRight', true), 'ControlRight');
  assert.equal(M.swapModifier('ControlLeft', true), 'MetaLeft');
  assert.equal(M.swapModifier('KeyC', true), 'KeyC');
  assert.equal(M.swapModifier('MetaLeft', false), 'MetaLeft');
  assert.deepEqual(M.keyEvent('MetaLeft', true, { swap: true }), { k: 'kc', c: 'ControlLeft', d: 1 });
  assert.deepEqual(M.keyEvent('KeyV', false), { k: 'kc', c: 'KeyV', d: 0 });
  // every code the viewer sends is one the host maps to an evdev code
  for (const [, codes] of M.SPECIAL_KEYS) for (const c of codes) assert.ok(c in S.CODE_TO_EVDEV, c);
  for (const c of ['MetaLeft', 'MetaRight', 'ControlLeft', 'ControlRight', 'KeyV', 'Enter', 'Backspace', 'Delete']) assert.ok(c in S.CODE_TO_EVDEV, c);
});

test('reserved keys stay with the browser unless capture is on; paste and copy chords', () => {
  assert.equal(M.isReservedKey({ code: 'Tab', metaKey: true }, { mac: true }), true);
  assert.equal(M.isReservedKey({ code: 'KeyW', metaKey: true }, { mac: true }), true);
  assert.equal(M.isReservedKey({ code: 'KeyC', metaKey: true }, { mac: true }), false); // copy goes to the app
  assert.equal(M.isReservedKey({ code: 'Tab', altKey: true }), true);
  assert.equal(M.isReservedKey({ code: 'F5' }), true);
  assert.equal(M.isReservedKey({ code: 'KeyA' }), false);
  assert.equal(M.isReservedKey({ code: 'KeyT', ctrlKey: true }), true);
  assert.equal(M.isPasteChord({ code: 'KeyV', metaKey: true }), true);
  assert.equal(M.isPasteChord({ code: 'KeyV', ctrlKey: true }), true);
  assert.equal(M.isPasteChord({ code: 'KeyV' }), false);
  assert.equal(M.isCopyChord({ code: 'KeyC', ctrlKey: true }), true);
  assert.deepEqual(M.pasteChord().map((e) => `${e.c}${e.d}`), ['ControlLeft1', 'KeyV1', 'KeyV0', 'ControlLeft0']);
  assert.deepEqual(M.chord(['ControlLeft', 'AltLeft', 'Delete']).map((e) => `${e.c}${e.d}`), ['ControlLeft1', 'AltLeft1', 'Delete1', 'Delete0', 'AltLeft0', 'ControlLeft0']);
});

test('soft keyboard: insertText becomes tx, Enter and Backspace become key chords, composition waits', () => {
  assert.deepEqual(M.beforeInputEvents({ inputType: 'insertText', data: 'őű' }), [{ k: 'tx', s: 'őű' }]);
  assert.deepEqual(M.beforeInputEvents({ inputType: 'insertText', data: null }), []);
  assert.deepEqual(M.beforeInputEvents({ inputType: 'insertCompositionText', data: 'ka' }), []);
  assert.deepEqual(M.compositionEndEvents('かな'), [{ k: 'tx', s: 'かな' }]);
  assert.deepEqual(M.beforeInputEvents({ inputType: 'deleteContentBackward' }).map((e) => `${e.c}${e.d}`), ['Backspace1', 'Backspace0']);
  assert.deepEqual(M.beforeInputEvents({ inputType: 'insertLineBreak' }).map((e) => e.c), ['Enter', 'Enter']);
  assert.equal(M.beforeInputEvents({ inputType: 'insertText', data: 'x'.repeat(5000) })[0].s.length, 4000);
});

test('InputBatcher: moves collapse, wheel adds up, ≤ 64 per batch, seq counts batches', () => {
  const b = new M.InputBatcher();
  assert.equal(b.flush(), null);
  b.push({ k: 'pm', x: 1, y: 1 }); b.push({ k: 'pm', x: 2, y: 2 }); b.push({ k: 'pb', b: 0, d: 1 });
  b.push({ k: 'pw', dx: 0, dy: 10, mode: 'px' }); b.push({ k: 'pw', dx: 0, dy: 5, mode: 'px' }); b.push({ k: 'pw', dx: 0, dy: 1, mode: 'line' });
  const m = b.flush();
  assert.deepEqual(m, { type: 'in', seq: 1, e: [{ k: 'pm', x: 2, y: 2 }, { k: 'pb', b: 0, d: 1 }, { k: 'pw', dx: 0, dy: 15, mode: 'px' }, { k: 'pw', dx: 0, dy: 1, mode: 'line' }] });
  for (let i = 0; i < 100; i++) b.push({ k: 'kc', c: 'KeyA', d: i % 2 });
  assert.equal(b.flush().e.length, 64);
  assert.equal(b.pending, 36);
  assert.equal(b.flush().seq, 3);
  b.push({ k: 'ra' }); b.clear();
  assert.equal(b.flush(), null);
  // the host's validator accepts what the viewer builds
  const ok = S.validateInput({ type: 'in', seq: 1, e: [{ k: 'pm', x: 5, y: 5 }, M.keyEvent('KeyA', true), { k: 'pw', dx: 0, dy: 3, mode: 'px' }, { k: 'tx', s: 'őű' }, { k: 'ra' }] }, { width: 1920, height: 1080 });
  assert.ok(ok && !ok.error, JSON.stringify(ok));
});

const acts = (g, ...steps) => steps.flatMap(([m, ...a]) => g[m](...a));

test('gestures (Direct): tap clicks at the point, a second tap clicks again', () => {
  const g = new M.TouchGestures();
  assert.deepEqual(acts(g, ['down', 1, 50, 60, 0], ['up', 1, 80]), [{ a: 'click', b: 0, x: 50, y: 60 }]);
  assert.deepEqual(acts(g, ['down', 1, 52, 61, 200], ['up', 1, 250]), [{ a: 'click', b: 0, x: 52, y: 61 }]);
});

test('gestures (Direct): press and hold is one right click; dragging is a left drag', () => {
  const g = new M.TouchGestures();
  g.down(1, 10, 10, 0);
  assert.deepEqual(g.tick(400), []);
  assert.deepEqual(g.tick(520), [{ a: 'click', b: 2, x: 10, y: 10 }]);
  assert.deepEqual(g.tick(900), []); // once
  assert.deepEqual(g.move(1, 12, 12), []); // after the hold, a small wobble does nothing
  assert.deepEqual(g.up(1, 1000), []); // and releasing does not click
  const d = new M.TouchGestures();
  d.down(1, 10, 10, 0);
  assert.deepEqual(d.move(1, 12, 11), []); // within the slop
  assert.deepEqual(d.move(1, 40, 10), [{ a: 'move', x: 10, y: 10 }, { a: 'btn', b: 0, d: 1 }, { a: 'move', x: 40, y: 10 }]);
  assert.deepEqual(d.move(1, 60, 20), [{ a: 'move', x: 60, y: 20 }]);
  assert.deepEqual(d.up(1, 500), [{ a: 'btn', b: 0, d: 0 }]);
  assert.deepEqual(d.tick(5000), []);
});

test('gestures (Direct): two-finger tap is a right click, two-finger drag scrolls, pinch zooms locally', () => {
  const tap = new M.TouchGestures();
  assert.deepEqual(acts(tap, ['down', 1, 100, 100, 0], ['down', 2, 140, 100, 20], ['up', 1, 90], ['up', 2, 95]), [{ a: 'click', b: 2, x: 120, y: 100 }]);
  const scroll = new M.TouchGestures();
  scroll.down(1, 100, 100, 0); scroll.down(2, 140, 100, 5);
  const r = scroll.move(1, 100, 80).concat(scroll.move(2, 140, 80));
  const wheel = r.filter((a) => a.a === 'wheel');
  assert.ok(wheel.length >= 1 && wheel.every((a) => a.dy > 0), JSON.stringify(r)); // fingers up → content scrolls down
  assert.deepEqual(scroll.up(1, 300), []);
  assert.deepEqual(scroll.up(2, 310), []);
  const pinch = new M.TouchGestures();
  pinch.down(1, 100, 100, 0); pinch.down(2, 140, 100, 5);
  const p = pinch.move(2, 200, 100);
  assert.ok(p.some((a) => a.a === 'zoom' && a.k > 1), JSON.stringify(p));
  assert.ok(!p.some((a) => a.a === 'wheel'));
  assert.deepEqual(pinch.up(2, 400).concat(pinch.up(1, 410)), []); // no click after a pinch
  // a second finger during a drag releases the button first
  const dr = new M.TouchGestures();
  dr.down(1, 0, 0, 0); dr.move(1, 30, 0);
  assert.deepEqual(dr.down(2, 80, 80, 100), [{ a: 'btn', b: 0, d: 0 }]);
});

test('gestures (Touchpad): drag moves relatively with gain, tap clicks at the pointer, two fingers scroll', () => {
  const g = new M.TouchGestures({ mode: 'touchpad' });
  g.down(1, 10, 10, 0);
  assert.deepEqual(g.move(1, 30, 10), [{ a: 'rel', dx: 20 * M.TOUCHPAD_GAIN, dy: 0 }]);
  assert.deepEqual(g.move(1, 30, 20), [{ a: 'rel', dx: 0, dy: 10 * M.TOUCHPAD_GAIN }]);
  assert.deepEqual(g.up(1, 300), []); // it moved: not a tap
  assert.deepEqual(acts(g, ['down', 1, 5, 5, 400], ['up', 1, 450]), [{ a: 'click', b: 0 }]);
  assert.deepEqual(acts(g, ['down', 1, 5, 5, 500], ['down', 2, 45, 5, 510], ['up', 1, 540], ['up', 2, 550]), [{ a: 'click', b: 2 }]);
  g.down(1, 100, 100, 600); g.down(2, 140, 100, 605);
  const s = g.move(1, 100, 70).concat(g.move(2, 140, 70));
  assert.ok(s.some((a) => a.a === 'wheel') && !s.some((a) => a.a === 'zoom'));
  assert.deepEqual(new M.TouchGestures().cancel(), []);
  const c = new M.TouchGestures(); c.down(1, 0, 0, 0); c.move(1, 40, 0);
  assert.deepEqual(c.cancel(), [{ a: 'btn', b: 0, d: 0 }]);
});

test('local zoom stays within 1×–4× and keeps the picture covering the stage', () => {
  const rect = { left: 0, top: 0, width: 400, height: 300 };
  let v = M.applyZoom({ scale: 1, tx: 0, ty: 0 }, 2, 300, 150, rect);
  assert.equal(v.scale, 2);
  assert.ok(Math.abs(v.tx) <= 200 && Math.abs(v.ty) <= 150);
  v = M.applyZoom(v, 10, 200, 150, rect);
  assert.equal(v.scale, 4);
  assert.deepEqual(M.applyZoom(v, 0.01, 200, 150, rect), { scale: 1, tx: 0, ty: 0 });
  assert.deepEqual(M.clampPan({ scale: 2, tx: 999, ty: -999 }, rect), { scale: 2, tx: 200, ty: -150 });
});

test('stats: percentiles over the last samples, rates over a window, host clock from the best ping', () => {
  const r = new M.Rolling(5);
  for (const x of [10, 20, 30, 40, 50, 60]) r.add(x);
  r.add(NaN);
  assert.equal(r.count, 5);
  assert.equal(r.p(0.5), 40);
  assert.equal(new M.Rolling().p(0.5), null);
  const m = new M.Meter(1000);
  for (let t = 0; t < 1000; t += 20) m.add(t);
  assert.equal(m.rate(1000), 50);
  assert.equal(m.rate(5000), 0);
  const c = new M.ClockSync();
  assert.equal(c.glassToGlassMs(1, 2), null);
  // host clock is 5 s ahead; the first ping had an asymmetric 40 ms RTT, the second a clean 10 ms
  assert.equal(c.sample(1_000_000, 1_040_000, 6_035_000), 40);
  c.sample(2_000_000, 2_010_000, 7_005_000);
  assert.equal(c.ready, true);
  // a frame captured on the host at 7_100_000 (host clock) shown at viewer 2_150_000: 2.15 s ↔ 7.15 s → 50 ms
  assert.ok(Math.abs(c.glassToGlassMs(7_100_000, 2_150_000) - 50) < 1e-6);
  assert.equal(c.sample(5, 1, 0), null); // a clock that went backwards is no sample
  assert.equal(M.fmtKbps(850), '850 kbit/s');
  assert.equal(M.fmtKbps(8200), '8.2 Mbit/s');
  assert.equal(M.fmtMs(null), '–');
  assert.equal(M.fmtMs(4.94), '4.9');
  assert.equal(M.fmtMs(31.6), '32');
});

test('connection: reconnect with backoff after drops and host restart, never after refusals or the end', () => {
  assert.deepEqual([0, 1, 2, 3, 4, 5, 9].map(M.backoffMs), [500, 1000, 2000, 4000, 8000, 8000, 8000]);
  assert.deepEqual(M.closeAction(1006), { reconnect: true, state: 'reconnecting' });
  assert.deepEqual(M.closeAction(4503), { reconnect: true, state: 'reconnecting' });
  assert.deepEqual(M.closeAction(1000), { reconnect: true, state: 'reconnecting' });
  for (const code of [4400, 4403, 4412, 4501]) assert.deepEqual(M.closeAction(code), { reconnect: false, state: 'refused' }, String(code));
  for (const code of [4404, 4410]) assert.deepEqual(M.closeAction(code), { reconnect: false, state: 'ended' }, String(code));
  assert.deepEqual(M.closeAction(1006, { ended: true }), { reconnect: false, state: 'ended' }); // an `end` message came first
  assert.deepEqual(M.closeAction(1006, { refused: true }), { reconnect: false, state: 'refused' });
  // the codes are the host's
  for (const [status, e] of Object.entries(S.ENDINGS)) assert.equal(M.closeAction(e.close).reconnect, status === 'host-restart', status);
});

test('words for refusals and endings', () => {
  const off = M.refusalText({ status: 'appstream-off', message: 'x' }, 'magix-system');
  assert.equal(off.action, 'enable');
  assert.match(off.text, /switched off on magix-system/);
  assert.match(M.refusalText({ status: 'busy' }, 'm').fix, /Stop another/);
  assert.match(M.refusalText({ status: 'no-session' }, 'm').fix, /Applications/);
  assert.equal(M.refusalText({ status: 'needs-permission', message: 'Screen Recording is off', fix: 'Open System Settings' }, 'm').fix, 'Open System Settings');
  assert.equal(M.refusalText({ message: 'nope' }, 'm').text, 'nope');
  assert.match(M.endText({ reason: 'app-exited' }), /closed/);
  assert.match(M.endText({ reason: 'killed' }), /parked/);
  assert.equal(M.endText({ reason: '?', message: 'custom' }), 'custom');
  assert.match(M.INSECURE_HINT, /HTTPS/);
});

// ---------------------------------------------------------------- low-delay SPS (decoders hold back frames without bitstream_restriction)

const hex = (h) => Uint8Array.from(h.match(/../g).map((x) => parseInt(x, 16)));
const unescape = (a) => Uint8Array.from([...a].filter((b, i) => !(i >= 2 && b === 3 && a[i - 1] === 0 && a[i - 2] === 0)));
// Real SPS captured from magix-system: NVENC (High, level 3.2, VUI with timing but no bitstream_restriction) and x264 (Constrained Baseline, VUI with it).
const NVENC_SPS = hex('67640020ac2b200a00b7602d4040405000003e80001d4c0840');
const X264_SPS = hex('6742c020da014016ec05a808200a000003000200000300f11e306540');

test('parseSps reads real encoder SPS: VUI position and bitstream_restriction', () => {
  const n = M.parseSps(unescape(NVENC_SPS.subarray(1)));
  assert.deepEqual([n.vuiPresent, n.maxNumRefFrames, n.restriction], [true, 3, null]);
  const x = M.parseSps(unescape(X264_SPS.subarray(1)));
  assert.deepEqual([x.vuiPresent, x.maxNumRefFrames, x.restriction], [true, 1, { reorder: 0, dpb: 1 }]);
});

test('lowDelaySps: adds max_num_reorder_frames=0 to the NVENC SPS, keeps profile/level, leaves a ready SPS alone', () => {
  const out = M.lowDelaySps(NVENC_SPS);
  assert.notDeepEqual([...out], [...NVENC_SPS]);
  assert.deepEqual([...out.subarray(0, 4)], [...NVENC_SPS.subarray(0, 4)]); // header, profile, constraints, level
  const info = M.parseSps(unescape(out.subarray(1)));
  assert.deepEqual(info.restriction, { reorder: 0, dpb: 3 });
  assert.equal(M.codecString(out), M.codecString(NVENC_SPS));
  assert.deepEqual([...M.lowDelaySps(out)], [...out]); // idempotent
  assert.equal(M.lowDelaySps(X264_SPS), X264_SPS); // x264 already says so: the same bytes
  const junk = Uint8Array.from([0x67, 0xff]);
  assert.equal(M.lowDelaySps(junk), junk); // unparseable: untouched, never a crash
});

test('lowDelaySps on an SPS without any VUI adds a whole one', () => {
  // Baseline, level 3.0, 1 ref frame, 1280x720 (80x45 MBs), no cropping, vui_parameters_present_flag = 0. Bits written by hand.
  const bits = [];
  const u = (n, v) => { for (let i = n - 1; i >= 0; i--) bits.push((v >> i) & 1); };
  const ue = (v) => { const x = v + 1, n = Math.floor(Math.log2(x)); u(n, 0); u(n + 1, x); };
  u(8, 66); u(8, 0xc0); u(8, 30); ue(0); ue(0); ue(2); ue(1); ue(1); u(1, 0); ue(79); ue(44); u(1, 1); u(1, 1); u(1, 0); u(1, 0);
  bits.push(1); while (bits.length % 8) bits.push(0);
  const rbsp = Uint8Array.from(Array.from({ length: bits.length / 8 }, (_, i) => parseInt(bits.slice(i * 8, i * 8 + 8).join(''), 2)));
  const sps = Uint8Array.from([0x67, ...rbsp]);
  const before = M.parseSps(unescape(sps.subarray(1)));
  assert.deepEqual([before.vuiPresent, before.maxNumRefFrames], [false, 1]);
  const out = M.lowDelaySps(sps);
  const after = M.parseSps(unescape(out.subarray(1)));
  assert.deepEqual([after.vuiPresent, after.restriction], [true, { reorder: 0, dpb: 1 }]);
  assert.deepEqual([...out.subarray(0, 4)], [...sps.subarray(0, 4)]);
});

test('H264Config hands the decoder the low-delay SPS in the avcC, with the original codec string', () => {
  const c = new M.H264Config();
  const r = c.update(annexB([sc4, NVENC_SPS], [sc4, PPS], [sc4, IDR]));
  assert.equal(r.configure.codec, 'avc1.640020');
  const d = r.configure.description;
  const spsLen = (d[6] << 8) | d[7];
  const inAvcc = d.subarray(8, 8 + spsLen);
  assert.deepEqual([...inAvcc], [...M.lowDelaySps(NVENC_SPS)]);
  assert.deepEqual(M.parseSps(unescape(inAvcc.subarray(1))).restriction, { reorder: 0, dpb: 3 });
});

test('mid-stream status messages: wait, short note, or a refusal that keeps the stream (macOS host: locked, busy-lease)', () => {
  assert.deepEqual(M.statusAction({ status: 'ok' }), { kind: 'ok' });
  assert.equal(M.statusAction({ status: 'starting', message: 'Starting FilmCraft…' }).kind, 'wait');
  assert.deepEqual(M.statusAction({ status: 'throttled', message: 'Network congested: 5600 kbit/s' }), { kind: 'note', text: 'Network congested: 5600 kbit/s' });
  assert.equal(M.statusAction({ status: 'encoder-fallback' }).kind, 'note');
  const lock = M.statusAction({ status: 'locked', code: 'locked', message: 'The screen is locked', fix: 'Unlock the Mac' });
  assert.deepEqual([lock.kind, lock.text, lock.fix], ['refusal', 'The screen is locked', 'Unlock the Mac']);
  assert.equal(M.statusAction({ status: 'busy-lease', message: 'An agent holds control' }).kind, 'refusal');
  assert.equal(M.statusAction({ status: 'needs-permission', message: 'Screen Recording is off', fix: 'Open System Settings' }).fix, 'Open System Settings');
  assert.match(M.refusalText({ status: 'busy-lease' }, 'macbookpro').text, /agent holds screen control on macbookpro/);
  assert.match(M.refusalText({ status: 'locked' }, 'macbookpro').fix, /Unlock/);
});

test('waiting for a key frame: ask again every 400 ms, never when not waiting', () => {
  assert.equal(M.shouldAskKey({ needKey: true }, 1000, 900), false);
  assert.equal(M.shouldAskKey({ needKey: true }, 1400, 1000), true);
  assert.equal(M.shouldAskKey({ needKey: false }, 9000, 0), false);
});
