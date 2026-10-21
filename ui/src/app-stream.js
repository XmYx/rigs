// The app stream viewer window (docs/app-streaming.md §5, §8.2, §8.3): one JARVIS window per app session. It connects to
// /api/nodes/<node>/appstream/sessions/<sid>/stream through the usual auth and peer proxy, decodes H.264 with WebCodecs
// (hardware where the browser has it) onto a canvas — or shows JPEG frames when WebCodecs is not available (no secure
// context) — and sends pointer, wheel, keyboard, touch and clipboard input back. All logic that can run without a DOM is in
// app-stream-model.js (test/app-stream-ui.test.js); this file is the DOM, socket and decoder glue.
import { api, h, node, toast, wsUrl } from './api.js';
import { isPhone } from './mobile.js';
import { openWindow } from './wm.js';
import {
  FPS_CHOICES, H264Config, INSECURE_HINT, InputBatcher, KIND, QUALITIES, SIZE_CHOICES, SPECIAL_KEYS, ClockSync, Meter, Rolling, TouchGestures,
  afterDecodeError, applyZoom, backoffMs, beforeInputEvents, buttonOf, chord, closeAction, clampPan, compositionEndEvents, configMessage, decoderCaps, defaultFit,
  endText, fmtKbps, fmtMs, isPasteChord, isReservedKey, judgeFrame, keyEvent, shouldAskKey, lockedMove, parseFrame, pasteChord, refusalText, statusAction, streamPoint, wantSize, wheelEvent,
} from './app-stream-model.js';

const open = new Map(); // `${nodeId}:${sid}` → window: opening the same session again raises it
const isMac = () => /^Mac/.test(navigator.platform || '') && !(navigator.maxTouchPoints > 1); // an iPad reports MacIntel
const platformName = () => (/iPhone|iPad/.test(navigator.userAgent) ? 'ios' : /Android/.test(navigator.userAgent) ? 'android' : isMac() ? 'mac' : /Win/.test(navigator.platform || '') ? 'win' : 'linux');
const debug = () => { try { return localStorage.getItem('rigs.appstream.debug') === '1'; } catch { return false; } };
const storage = () => { try { return localStorage; } catch { return null; } };
const loadPrefs = () => { try { return JSON.parse(storage()?.getItem('rigs.appstream') || '{}'); } catch { return {}; } };
const savePrefs = (p) => { try { storage()?.setItem('rigs.appstream', JSON.stringify(p)); } catch { /* private mode */ } };

/** Does this browser decode H.264 with WebCodecs here? (secure context and a supported config) */
export async function webcodecsOk() {
  if (!window.isSecureContext || !('VideoDecoder' in window)) return false;
  try { return !!(await VideoDecoder.isConfigSupported({ codec: 'avc1.64001f', optimizeForLatency: true })).supported; } catch { return false; }
}

/** Open (or raise) the viewer window for one app session. `app` = { id, name, icon } as in the session answer. */
export function openAppStream({ nodeId, nodeName, sessionId, app = {} } = {}) {
  const key = `${nodeId}:${sessionId}`;
  const existing = open.get(key);
  if (existing && !existing.closed) { existing.raise(); return existing; }
  const phone = isPhone();
  const prefs = loadPrefs();
  const mac = isMac();
  const state = {
    fit: prefs.fit || defaultFit(phone), quality: prefs.quality || 'auto', fps: prefs.fps || 60, swap: prefs.swap ?? mac, capture: !!prefs.capture, stats: !!prefs.stats,
    touchMode: prefs.touchMode || 'direct', role: 'controller', input: true, clipboard: true, ready: false, locked: false,
  };
  let ws = null, closed = false, attempt = 0, retryTimer = 0, ended = false, refused = false, helloInfo = null, transport = 'h264', webcodecs = false;
  let stream = { width: 0, height: 0 };
  let frameState = { lastSeq: -1, needKey: true };
  let view = { scale: 1, tx: 0, ty: 0 };
  let cursor = { x: 0, y: 0 }; // touchpad and pointer lock work from a remembered position
  const batcher = new InputBatcher();
  const clock = new ClockSync();
  const fpsMeter = new Meter(1000), kbpsMeter = new Meter(1000);
  const decodeMs = new Rolling(120), g2g = new Rolling(120), rttMs = new Rolling(30);
  let hostStats = null, lastRtt = null, decodedTotal = 0, droppedTotal = 0;
  const pendingDecode = new Map(); // seq → { t, capture, bytes }
  let decoder = null, h264 = new H264Config(), latest = null, rafInput = 0, rafDraw = 0;
  let resizeTimer = 0, keyboardUp = false, sentSize = '';
  // On a Mac host the stream is the app's real window (its size is the window's): the viewer's window size must not resize it
  // by itself; only picking a size in the toolbar does. Linux hosts build a virtual display at the viewer's size.
  let autoResize = true;
  api(`${node(nodeId)}/appstream`).then((a) => { if (a?.os === 'darwin') autoResize = false; }).catch(() => {});

  // ---------------------------------------------------------------- DOM
  const canvas = h('canvas', { class: 'as-canvas', 'aria-label': `${app.name || 'App'} on ${nodeName}`, hidden: true });
  const img = h('img', { class: 'as-img', alt: '', hidden: true, draggable: false });
  const stage = h('div', { class: 'as-stage', tabindex: '0', 'aria-label': `${app.name || 'App'} stream`, role: 'application' }, canvas, img);
  const msg = h('div', { class: 'as-msg', role: 'status', 'aria-live': 'polite' });
  const noteEl = h('div', { class: 'as-note', hidden: true, role: 'status' });
  const statsEl = h('pre', { class: 'as-stats', hidden: !state.stats, 'aria-label': 'Stream statistics' });
  const kb = h('textarea', { class: 'as-kb', 'aria-label': 'Keyboard input', autocapitalize: 'off', autocomplete: 'off', autocorrect: 'off', spellcheck: 'false', rows: 1 });
  const wrap = h('div', { class: 'as-wrap' }, stage, msg, noteEl, statsEl, kb);
  const btn = (label, title, onclick, cls = '') => h('button', { type: 'button', class: `tb as-btn ${cls}`.trim(), title, 'aria-label': title, onclick }, label);
  const sel = (label, opts, value, onchange) => {
    const s = h('select', { class: 'mini as-sel', 'aria-label': label, title: label, onchange: () => onchange(s.value) }, ...opts.map(([v, l]) => h('option', { value: String(v), selected: String(v) === String(value) }, l)));
    return s;
  };
  const qualitySel = sel('Quality', QUALITIES, state.quality, (v) => { state.quality = v; persist(); send(configMessage({ quality: v })); });
  const fpsSel = sel('Frame rate', FPS_CHOICES.map((f) => [f, `${f} fps`]), state.fps, (v) => { state.fps = Number(v); persist(); send(configMessage({ quality: state.quality, fps: state.fps })); });
  const sizeSel = sel('Size', SIZE_CHOICES, state.fit, (v) => { state.fit = v; persist(); sendResize(true); });
  const statsBtn = btn('📊', 'Stats', () => { state.stats = !state.stats; persist(); renderBar(); drawStats(); }, 'as-stats-btn');
  const lockBtn = btn('🔒', 'Pointer lock', () => togglePointerLock());
  const fsBtn = btn('⛶', 'Full screen', () => toggleFullscreen());
  const pasteBtn = btn('📋', 'Paste from this device', () => pasteFromDevice());
  const swapBtn = btn('⌘⇄⌃', 'Swap ⌘ and Ctrl (Mac viewer, Linux host)', () => { state.swap = !state.swap; persist(); renderBar(); toast(state.swap ? '⌘ now acts as Ctrl on the host' : 'Keys sent as they are', 'info', 2500); });
  const captureBtn = btn('⌨', 'Capture browser shortcuts (Cmd+W, Cmd+T…)', () => { state.capture = !state.capture; persist(); renderBar(); toast(state.capture ? 'Every key goes to the app' : 'Browser shortcuts stay with the browser', 'info', 2500); });
  const takeBtn = btn('✋', 'Take control', () => send({ type: 'take-control' }));
  const stopBtn = btn('⏹', 'Stop the app', () => stopApp(), 'danger');
  const kbBtn = btn('⌨', 'Show keyboard', () => { kb.value = ''; kb.focus(); });
  const touchSel = sel('Touch mode', [['direct', 'Direct'], ['touchpad', 'Touchpad'], ['native', 'Native']], state.touchMode, (v) => { state.touchMode = v; persist(); gestures.setMode(v); });
  const keysMenu = h('div', { class: 'as-keys', hidden: true, role: 'menu' }, ...SPECIAL_KEYS.map(([label, codes]) => h('button', { type: 'button', class: 'tb as-key', role: 'menuitem', onclick: () => { for (const e of chord(codes)) push(e); } }, label)));
  const keysBtn = btn('⎇', 'Special keys', () => { keysMenu.hidden = !keysMenu.hidden; });
  const bar = h('div', { class: 'as-bar' }, qualitySel, fpsSel, sizeSel, h('span', { class: 'as-spacer' }), ...(phone ? [kbBtn, keysBtn, touchSel] : [lockBtn]), pasteBtn, ...(mac && !phone ? [swapBtn, captureBtn] : []), takeBtn, statsBtn, fsBtn, stopBtn);
  const root = h('div', { class: `as-view${phone ? ' phone' : ''}` }, bar, keysMenu, wrap);
  const hotspot = phone ? h('div', { class: 'as-hotspot', onclick: () => showBar() }) : null;
  if (hotspot) root.append(hotspot);

  const w = openWindow({
    title: `${app.name || 'App'} — ${nodeName}`, key: `appstream:${nodeId}:${sessionId}`, icon: '🚀', width: 1120, height: 700, className: 'as-win',
    onClose: () => { closed = true; teardown(); open.delete(key); toast(`${app.name || 'The app'} keeps running on ${nodeName} — reopen it from Applications.`, 'info', 6000); },
  });
  w.body.append(root);
  open.set(key, w);
  const persist = () => savePrefs({ fit: state.fit, quality: state.quality, fps: state.fps, swap: state.swap, capture: state.capture, stats: state.stats, touchMode: state.touchMode });

  function renderBar() {
    statsBtn.classList.toggle('on', state.stats);
    statsEl.hidden = !state.stats;
    swapBtn.classList.toggle('on', state.swap);
    captureBtn.classList.toggle('on', state.capture);
    lockBtn.classList.toggle('on', state.locked);
    takeBtn.hidden = state.role === 'controller';
    root.classList.toggle('as-viewer', state.role !== 'controller');
    for (const el of [qualitySel, fpsSel, sizeSel]) el.disabled = state.role !== 'controller';
    fsBtn.hidden = !root.requestFullscreen && !root.webkitRequestFullscreen;
  }

  /** The overlay over the stage: connecting, reconnecting, refused, ended. `actions` = [[label, fn]]. */
  function say(text, { fix = '', actions = [], kind = '' } = {}) {
    msg.className = `as-msg${kind ? ' ' + kind : ''}`;
    if (!text) { msg.replaceChildren(); msg.hidden = true; return; }
    msg.hidden = false;
    msg.replaceChildren(h('div', { class: 'as-msg-text' }, text), fix ? h('div', { class: 'as-msg-fix muted' }, fix) : null,
      actions.length ? h('div', { class: 'actions' }, ...actions.map(([l, fn]) => h('button', { type: 'button', class: 'btn', onclick: fn }, l))) : null);
  }

  // A short note over the stream (throttled, encoder fallback…); it fades after a few seconds.
  let noteTimer = 0;
  function note(text) { noteEl.textContent = text; noteEl.hidden = false; clearTimeout(noteTimer); noteTimer = setTimeout(() => { noteEl.hidden = true; }, 5000); }

  // ---------------------------------------------------------------- socket
  const send = (m) => { if (ws?.readyState === 1) ws.send(JSON.stringify(m)); };
  const nowUs = () => performance.now() * 1000;
  const controlling = () => state.input && state.role === 'controller' && state.ready;

  function size() {
    const r = stage.getBoundingClientRect();
    return wantSize({ cssW: r.width, cssH: r.height, dpr: window.devicePixelRatio || 1, fit: state.fit, screen: { width: screen.width, height: screen.height }, max: [helloInfo?.maxWidth || 3840, helloInfo?.maxHeight || 2160] });
  }
  async function connect() {
    if (closed) return;
    clearTimeout(retryTimer);
    say(attempt ? `Reconnecting to ${nodeName}…` : `Connecting to ${nodeName}…`, { kind: 'wait' });
    webcodecs = await webcodecsOk();
    if (closed) return;
    const secure = window.isSecureContext;
    const caps = decoderCaps({ secure, webcodecs, mse: false });
    if (!webcodecs && !attempt) toast(secure ? 'This browser cannot decode H.264 here: using the JPEG stream.' : INSECURE_HINT, 'info', 9000);
    ws = new WebSocket(wsUrl(`${node(nodeId)}/appstream/sessions/${encodeURIComponent(sessionId)}/stream?t=${encodeURIComponent(tabId)}`));
    ws.binaryType = 'arraybuffer';
    const mine = ws;
    let gotEnd = false, gotError = false;
    ws.onopen = () => {
      const sz = size();
      send({ type: 'hello', v: 1, caps: { decoders: caps, maxWidth: 3840, maxHeight: 2160, touch: navigator.maxTouchPoints > 0, secure, platform: platformName() }, want: { fit: 'fixed', width: sz.width, height: sz.height, dpr: Math.min(window.devicePixelRatio || 1, 2), fps: state.fps, quality: state.quality === 'auto' ? 'balanced' : state.quality, ...(webcodecs ? {} : { transport: 'jpeg' }) } });
    };
    ws.onmessage = (e) => {
      if (mine !== ws) return;
      if (typeof e.data === 'string') {
        let m; try { m = JSON.parse(e.data); } catch { return; }
        if (m.type === 'end') gotEnd = true;
        if (m.type === 'error') gotError = true;
        onMessage(m);
      } else onBinary(e.data);
    };
    ws.onclose = (e) => {
      if (mine !== ws || closed) return;
      state.ready = false;
      const a = closeAction(e.code, { ended: gotEnd || ended, refused: gotError || refused });
      if (a.reconnect) {
        say(`Connection to ${nodeName} lost. Reconnecting…`, { kind: 'wait' });
        retryTimer = setTimeout(() => { attempt++; connect(); }, backoffMs(attempt));
      } else if (a.state === 'refused' && !refused) onMessage({ type: 'error', status: e.code === 4403 ? 'killed' : 'unsupported', message: e.reason });
      else if (a.state === 'ended' && !ended) onMessage({ type: 'end', reason: e.code === 4404 ? 'stopped' : 'stopped' });
    };
  }
  const tabId = Math.random().toString(36).slice(2, 10);

  function onMessage(m) {
    if (debug() && m.type !== 'pong' && m.type !== 'stats') console.debug('[appstream] msg', JSON.stringify(m).slice(0, 200));
    switch (m.type) {
      case 'hello': {
        if (debug()) console.debug('[appstream] hello', JSON.stringify(m));
        attempt = 0; helloInfo = m; transport = m.transport || 'h264';
        stream = { width: m.width || stream.width, height: m.height || stream.height };
        state.role = m.role || 'controller'; state.input = m.input !== false; state.clipboard = m.clipboard !== false; state.ready = true;
        frameState = { lastSeq: -1, needKey: true }; h264.reset(); closeDecoder();
        say('');
        showMode();
        renderBar();
        sentSize = `${stream.width}x${stream.height}`; // the host built the stream for the size in the hello: no resize until the window really changes
        break;
      }
      case 'meta': stream = { width: m.width, height: m.height }; frameState = { ...frameState, needKey: true }; break;
      case 'status': {
        const a = statusAction(m);
        if (a.kind === 'ok') { if (stream.width) say(''); } else if (a.kind === 'wait') say(a.text.replace(/^Starting the app…$/, `Starting ${app.name || 'the app'}…`), { kind: 'wait' });
        else if (a.kind === 'note') { note(a.text); } else toast(a.fix ? `${a.text} ${a.fix}` : a.text, 'error', 8000);
        break;
      }
      case 'role': state.role = m.role; renderBar(); if (m.role !== 'controller') { releaseAll(); toast('Another viewer has control. Use ✋ to take it back.', 'info', 4000); } break;
      case 'clipboard': onHostClipboard(m.text); break;
      case 'pong': { const r = clock.sample(m.t0 * 1000, nowUs(), m.serverUs); if (r != null) { lastRtt = r; rttMs.add(r); } break; }
      case 'stats': hostStats = m; break;
      case 'end': ended = true; closeStreamUi(); say(endText(m), { actions: [['Reopen from Applications', () => w.close()]], kind: 'end' }); break;
      case 'error': {
        refused = true; closeStreamUi();
        const r = refusalText(m, nodeName);
        say(r.text, { fix: r.fix, kind: 'refused', actions: r.action === 'enable' ? [[`Turn on app streaming on ${nodeName}`, () => enableStreaming()]] : [],
        });
        break;
      }
      default: break;
    }
  }
  function closeStreamUi() { canvas.hidden = true; img.hidden = true; closeDecoder(); releaseAll(); }
  function showMode() { canvas.hidden = transport !== 'h264'; img.hidden = transport !== 'jpeg'; }

  // ---------------------------------------------------------------- frames
  let imgUrl = '';
  let binCount = 0, lastKeyReq = 0;
  function onBinary(buf) {
    binCount++;
    const f = parseFrame(buf);
    if (!f) return;
    if (debug() && binCount < 12) console.debug('[appstream] frame', f.seq, 'key', f.key, 'flags', f.flags, f.width + 'x' + f.height, f.payload.length, 'queue', decoder?.decodeQueueSize, decoder?.state);
    const t = performance.now();
    kbpsMeter.add(t, f.payload.length * 8 / 1000);
    if (f.width && f.height && (f.width !== stream.width || f.height !== stream.height)) stream = { width: f.width, height: f.height };
    if (f.kind === KIND.jpeg) { showJpeg(f); return; }
    if (f.kind !== KIND.h264 || !webcodecs) return;
    const j = judgeFrame(frameState, f, { queueSize: decoder?.decodeQueueSize || 0 });
    frameState = j.st;
    if (j.request) { droppedTotal++; lastKeyReq = t; send({ type: 'keyframe', reason: j.request }); }
    if (j.action === 'drop') {
      droppedTotal++;
      send({ type: 'ack', seq: f.seq });
      if (!j.request && shouldAskKey(frameState, t, lastKeyReq)) { lastKeyReq = t; send({ type: 'keyframe', reason: 'gap' }); }
      return;
    }
    const u = h264.update(f.payload);
    if (!u.avcc) { frameState = { ...frameState, needKey: true }; return; }
    if (u.configure || !decoder || decoder.state === 'closed') { if (!configureDecoder(u.configure)) return; }
    if (decoder.state !== 'configured') return;
    pendingDecode.set(f.seq, { t, capture: f.captureUs, bytes: f.payload.length });
    try { decoder.decode(new EncodedVideoChunk({ type: f.key || u.idr ? 'key' : 'delta', timestamp: f.seq, data: u.avcc })); } catch (e) { decodeFailed(e); }
  }
  function configureDecoder(cfg) {
    try {
      if (!decoder || decoder.state === 'closed') {
        decoder = new VideoDecoder({ output: onDecoded, error: (e) => decodeFailed(e) });
      }
      if (cfg) {
        decoder.configure({ codec: cfg.codec, description: cfg.description, optimizeForLatency: true, hardwareAcceleration: 'prefer-hardware' });
      }
      return true;
    } catch (e) { decodeFailed(e); return false; }
  }
  function closeDecoder() { try { if (decoder && decoder.state !== 'closed') decoder.close(); } catch { /* closed */ } decoder = null; pendingDecode.clear(); latest?.close?.(); latest = null; }
  function decodeFailed(e) {
    if (debug()) console.debug('[appstream] decode failed', e?.message || e);
    console.warn('app stream decode error:', e?.message || e);
    closeDecoder(); h264.reset();
    const r = afterDecodeError(frameState);
    frameState = r.st;
    send({ type: 'keyframe', reason: r.request });
  }
  function onDecoded(frame) {
    const p = pendingDecode.get(frame.timestamp);
    pendingDecode.delete(frame.timestamp);
    const t = performance.now();
    decodedTotal++;
    if (p) decodeMs.add(t - p.t);
    send({ type: 'ack', seq: frame.timestamp, decodeMs: p ? Math.round(t - p.t) : undefined });
    latest?.close?.();
    latest = frame;
    latestMeta = p;
    if (!rafDraw) rafDraw = requestAnimationFrame(draw);
  }
  let latestMeta = null;
  function draw() {
    rafDraw = 0;
    const f = latest;
    if (!f) return;
    latest = null;
    if (canvas.width !== f.displayWidth || canvas.height !== f.displayHeight) { canvas.width = f.displayWidth; canvas.height = f.displayHeight; }
    canvas.getContext('2d').drawImage(f, 0, 0);
    f.close();
    const t = performance.now();
    fpsMeter.add(t);
    if (latestMeta && clock.ready) g2g.add(clock.glassToGlassMs(latestMeta.capture, nowUs()));
    if (canvas.hidden && transport === 'h264') canvas.hidden = false;
  }
  function showJpeg(f) {
    const url = URL.createObjectURL(new Blob([f.payload], { type: 'image/jpeg' }));
    const old = imgUrl;
    imgUrl = url;
    img.onload = () => { if (old) URL.revokeObjectURL(old); fpsMeter.add(performance.now()); };
    img.src = url;
    img.hidden = false;
    send({ type: 'ack', seq: f.seq });
  }

  // ---------------------------------------------------------------- stats
  function drawStats() {
    if (!state.stats) return;
    const t = performance.now();
    const enc = helloInfo?.encoder;
    const lines = [
      `${stream.width}×${stream.height} · ${state.role}`,
      `fps ${Math.round(fpsMeter.rate(t))} (host ${hostStats?.fps ?? '–'}) · ${fmtKbps(kbpsMeter.rate(t))}`,
      `decoder ${transport === 'jpeg' ? 'jpeg (no WebCodecs)' : webcodecs ? 'webcodecs' : '–'} · decode ${fmtMs(decodeMs.p(0.5))} ms`,
      `encoder ${enc ? `${enc.name}${enc.hw ? ' (hw)' : ''} ${enc.path || ''}` : '–'}${hostStats?.encodeMsP50 != null ? ` · ${fmtMs(hostStats.encodeMsP50)} ms` : ''}`,
      `RTT ${fmtMs(lastRtt)} ms (p50 ${fmtMs(rttMs.p(0.5))})`,
      `glass-to-glass ${fmtMs(g2g.p(0.5))} / ${fmtMs(g2g.p(0.95))} ms`,
      `dropped ${droppedTotal} · host skipped ${hostStats?.skipped ?? '–'} · viewers ${hostStats?.viewers ?? helloInfo?.viewers ?? 1}`,
    ];
    statsEl.textContent = lines.join('\n');
    // Read by the checks (scripts/appstream-viewer-check.js) and t6's measurements.
    root.dataset.fps = String(Math.round(fpsMeter.rate(t)));
    root.dataset.rtt = lastRtt == null ? '' : lastRtt.toFixed(1);
    root.dataset.kbps = String(Math.round(kbpsMeter.rate(t)));
    root.dataset.bin = String(binCount);
    root.dataset.decoded = String(decodedTotal);
    root.dataset.dropped = String(droppedTotal);
    root.dataset.decoder = decoder ? `${decoder.state}/${decoder.decodeQueueSize}` : 'none';
  }
  w.interval(drawStats, 500);
  w.interval(() => { if (state.ready) send({ type: 'ping', t0: Math.round(nowUs() / 1000) }); }, 1000);

  // ---------------------------------------------------------------- input
  function push(e) {
    if (!controlling()) return;
    batcher.push(e);
    if (!rafInput) rafInput = requestAnimationFrame(flushInput);
  }
  function flushInput() {
    rafInput = 0;
    for (let m = batcher.flush(); m; m = batcher.flush()) { if (debug()) console.debug('[appstream] in', JSON.stringify(m).slice(0, 200)); send(m); }
  }
  function flushNow() { if (rafInput) { cancelAnimationFrame(rafInput); rafInput = 0; } flushInput(); }
  function releaseAll() { held.clear(); batcher.clear(); send({ type: 'in', seq: ++batcher.seq, e: [{ k: 'ra' }] }); }
  const held = new Set();
  const rect = () => canvas.hidden && !img.hidden ? img.getBoundingClientRect() : canvas.getBoundingClientRect();
  const pointAt = (cx, cy) => streamPoint(cx, cy, rect(), stream);

  stage.addEventListener('contextmenu', (e) => e.preventDefault());
  stage.addEventListener('pointerdown', (e) => {
    stage.focus({ preventScroll: true });
    if (e.pointerType === 'touch') { touchDown(e); return; }
    if (!controlling()) return;
    try { stage.setPointerCapture(e.pointerId); } catch { /* not capturable */ }
    const p = pointFor(e);
    push({ k: 'pm', x: p.x, y: p.y });
    push({ k: 'pb', b: buttonOf(e.button), d: 1 });
    e.preventDefault();
  });
  stage.addEventListener('pointermove', (e) => {
    if (e.pointerType === 'touch') { touchMove(e); return; }
    if (!controlling()) return;
    const p = pointFor(e);
    push({ k: 'pm', x: p.x, y: p.y });
  });
  const pointerUp = (e) => {
    if (e.pointerType === 'touch') { touchUp(e); return; }
    if (!controlling()) return;
    const p = pointFor(e);
    push({ k: 'pm', x: p.x, y: p.y });
    push({ k: 'pb', b: buttonOf(e.button), d: 0 });
  };
  stage.addEventListener('pointerup', pointerUp);
  stage.addEventListener('pointercancel', (e) => { if (e.pointerType === 'touch') touchCancel(); else if (controlling()) releaseAll(); });
  function pointFor(e) {
    if (document.pointerLockElement === stage) { cursor = lockedMove(cursor, e.movementX || 0, e.movementY || 0, rect(), stream); return cursor; }
    const p = pointAt(e.clientX, e.clientY);
    cursor = { x: p.x, y: p.y };
    return p;
  }
  stage.addEventListener('wheel', (e) => {
    if (!controlling()) return;
    e.preventDefault();
    push(wheelEvent(e));
  }, { passive: false });

  stage.addEventListener('keydown', (e) => {
    if (!controlling() || e.target === kb) return;
    const locked = !!document.fullscreenElement && navigator.keyboard?.lock;
    if (!state.capture && !locked && isReservedKey(e, { mac })) return; // the browser or OS keeps it
    if (e.isComposing || e.code === 'Unidentified') return;
    if (isPasteChord(e) && state.clipboard) { e.preventDefault(); e.stopPropagation(); pasteFromDevice(); return; }
    e.preventDefault();
    e.stopPropagation();
    if (e.repeat && !/^(Arrow|Backspace|Delete|Page)/.test(e.code) && !/^Key|^Digit|^Space|^Enter|^Tab/.test(e.code)) return;
    held.add(e.code);
    push(keyEvent(e.code, true, { swap: state.swap && mac }));
  });
  stage.addEventListener('keyup', (e) => {
    if (!controlling() || e.target === kb) return;
    if (!held.has(e.code)) { if (!state.capture && isReservedKey(e, { mac })) return; }
    e.preventDefault();
    e.stopPropagation();
    held.delete(e.code);
    push(keyEvent(e.code, false, { swap: state.swap && mac }));
  });
  stage.addEventListener('blur', () => { if (controlling() && held.size) { releaseAll(); } });
  w.listen(document, 'visibilitychange', () => { if (document.hidden && state.ready) releaseAll(); });
  w.listen(window, 'blur', () => { if (state.ready && held.size) releaseAll(); });

  // Soft keyboard (phones): a hidden textarea inside the tap handler; text becomes tx, Enter/Backspace key chords.
  kb.addEventListener('beforeinput', (e) => {
    if (!controlling()) return;
    if (e.inputType === 'insertCompositionText') return;
    const ev = beforeInputEvents({ inputType: e.inputType, data: e.data ?? kb.value });
    if (ev.length) { e.preventDefault(); for (const x of ev) push(x); }
  });
  kb.addEventListener('compositionend', (e) => { for (const x of compositionEndEvents(e.data)) push(x); kb.value = ''; });
  kb.addEventListener('input', () => { if (!kb.matches(':active') && !kb.composing) kb.value = ''; });
  kb.addEventListener('focus', () => { keyboardUp = true; root.classList.add('kb-up'); });
  kb.addEventListener('blur', () => { keyboardUp = false; root.classList.remove('kb-up'); });
  if (window.visualViewport) {
    const vv = () => { root.style.setProperty('--as-kb', `${Math.max(0, window.innerHeight - window.visualViewport.height - window.visualViewport.offsetTop)}px`); };
    w.listen(window.visualViewport, 'resize', vv);
  }

  // Clipboard: ⌘/Ctrl+V and 📋 read this device's clipboard (needs a secure context and a gesture), set the session's, then paste.
  async function pasteFromDevice() {
    if (!controlling()) return;
    try {
      const text = await navigator.clipboard.readText();
      if (!text) { toast('The clipboard is empty', 'info', 2000); return; }
      send({ type: 'clipboard', text: text.slice(0, 1024 * 1024) });
      setTimeout(() => { for (const e of pasteChord()) push(e); }, 60);
    } catch (e) { toast(window.isSecureContext ? `Cannot read the clipboard: ${e.message}` : 'Pasting needs HTTPS (a secure context).', 'error', 5000); }
  }
  async function onHostClipboard(text) {
    if (typeof text !== 'string' || !text) return;
    try { await navigator.clipboard.writeText(text); toast(`Copied from ${app.name || 'the app'}`, 'info', 1800); } catch {
      toast(`Copied on ${app.name || 'the app'} — tap to copy`, 'info', 10000, { label: 'Copy', run: () => navigator.clipboard?.writeText(text).catch(() => {}) });
    }
  }

  // Touch: Direct and Touchpad through the gesture recognizer; Native passes touches through as tc.
  const gestures = new TouchGestures({ mode: state.touchMode === 'native' ? 'direct' : state.touchMode });
  const touchIds = new Map();
  const slotOf = (id) => { if (!touchIds.has(id)) touchIds.set(id, touchIds.size); return touchIds.get(id); };
  function act(list) {
    for (const a of list) {
      if (a.a === 'move') { const p = pointAt(a.x, a.y); cursor = { x: p.x, y: p.y }; push({ k: 'pm', x: p.x, y: p.y }); }
      else if (a.a === 'rel') { cursor = lockedMove(cursor, a.dx, a.dy, rect(), stream); push({ k: 'pm', x: cursor.x, y: cursor.y }); }
      else if (a.a === 'btn') push({ k: 'pb', b: a.b, d: a.d });
      else if (a.a === 'click') {
        if (a.x != null) { const p = pointAt(a.x, a.y); cursor = { x: p.x, y: p.y }; }
        // The pointer has to be at the point before the press, and the press seen before the release: separate frames, not one batch.
        // Two moves: the first absolute motion into a fresh surface only makes the pointer enter it (the host side swallows it).
        push({ k: 'pm', x: Math.max(0, cursor.x - 2), y: cursor.y });
        setTimeout(() => push({ k: 'pm', x: cursor.x, y: cursor.y }), 20);
        setTimeout(() => push({ k: 'pb', b: a.b, d: 1 }), 60);
        setTimeout(() => push({ k: 'pb', b: a.b, d: 0 }), 110);
      } else if (a.a === 'wheel') push({ k: 'pw', dx: a.dx, dy: a.dy, mode: 'px' });
      else if (a.a === 'zoom') { view = applyZoom(view, a.k, a.cx, a.cy, stage.getBoundingClientRect()); applyView(); } else if (a.a === 'pan') { view = clampPan({ ...view, tx: view.tx + a.dx, ty: view.ty + a.dy }, stage.getBoundingClientRect()); applyView(); }
    }
  }
  function applyView() {
    const t = `translate(${view.tx}px, ${view.ty}px) scale(${view.scale})`;
    canvas.style.transform = t; img.style.transform = t;
  }
  function touchDown(e) {
    if (debug()) console.debug('[appstream] touchdown', e.clientX, e.clientY, 'controlling', controlling(), state.touchMode);
    e.preventDefault();
    try { stage.setPointerCapture(e.pointerId); } catch { /* ok */ }
    if (!controlling()) return;
    if (state.touchMode === 'native') { const p = pointAt(e.clientX, e.clientY); push({ k: 'tc', id: slotOf(e.pointerId), ph: 'down', x: p.x, y: p.y }); return; }
    act(gestures.down(e.pointerId, e.clientX, e.clientY, e.timeStamp));
  }
  function touchMove(e) {
    if (!controlling()) return;
    if (state.touchMode === 'native') { if (touchIds.has(e.pointerId)) { const p = pointAt(e.clientX, e.clientY); push({ k: 'tc', id: slotOf(e.pointerId), ph: 'move', x: p.x, y: p.y }); } return; }
    act(gestures.move(e.pointerId, e.clientX, e.clientY, e.timeStamp));
  }
  function touchUp(e) {
    if (debug()) console.debug('[appstream] touchup', e.clientX, e.clientY);
    if (!controlling()) return;
    if (state.touchMode === 'native') { const p = pointAt(e.clientX, e.clientY); push({ k: 'tc', id: slotOf(e.pointerId), ph: 'up', x: p.x, y: p.y }); touchIds.delete(e.pointerId); return; }
    act(gestures.up(e.pointerId, e.timeStamp));
  }
  function touchCancel() { if (state.touchMode === 'native') { touchIds.clear(); releaseAll(); } else act(gestures.cancel()); }
  w.interval(() => { if (state.touchMode !== 'native') act(gestures.tick(performance.now())); }, 100);

  // Pointer lock and full screen.
  function togglePointerLock() {
    if (document.pointerLockElement === stage) document.exitPointerLock();
    else stage.requestPointerLock?.();
  }
  w.listen(document, 'pointerlockchange', () => { state.locked = document.pointerLockElement === stage; renderBar(); });
  function toggleFullscreen() {
    if (document.fullscreenElement) { document.exitFullscreen?.(); return; }
    (root.requestFullscreen?.() || Promise.resolve()).then(() => navigator.keyboard?.lock?.().catch(() => {})).catch((e) => toast(`Full screen: ${e.message}`, 'error', 3000));
  }
  w.listen(document, 'fullscreenchange', () => { if (!document.fullscreenElement) navigator.keyboard?.unlock?.(); root.classList.toggle('fs', !!document.fullscreenElement); });

  // Window resize → remote resize (fit 'window' only; not while the soft keyboard is up).
  function sendResize(force = false) {
    if (!state.ready || state.role !== 'controller') return;
    if (state.fit === 'window' && keyboardUp && !force) return;
    const sz = size();
    const k = `${sz.width}x${sz.height}`;
    // A few pixels of layout settling are not worth rebuilding the host's pipeline for.
    const [sw, sh] = sentSize.split('x').map(Number);
    if (!force && (k === sentSize || (Math.abs(sz.width - sw) < 24 && Math.abs(sz.height - sh) < 24))) return;
    sentSize = k;
    send({ type: 'resize', width: sz.width, height: sz.height });
  }
  const ro = new ResizeObserver(() => { if (state.fit !== 'window' || !autoResize) return; clearTimeout(resizeTimer); resizeTimer = setTimeout(() => sendResize(false), 250); });
  ro.observe(stage);
  w.onCleanup(() => ro.disconnect());

  // Phones: the toolbar hides after 3 s; the top-edge hotspot brings it back.
  let barTimer = 0;
  function showBar() { root.classList.remove('bar-hidden'); clearTimeout(barTimer); if (phone) barTimer = setTimeout(() => { if (!keyboardUp && keysMenu.hidden) root.classList.add('bar-hidden'); }, 3000); }
  if (phone) { showBar(); stage.addEventListener('pointerdown', () => { if (root.classList.contains('bar-hidden')) showBar(); }); bar.addEventListener('pointerdown', showBar); }

  // Stop the app (DELETE the session, as the design says), after asking.
  async function stopApp() {
    if (!window.confirm(`Stop ${app.name || 'the app'} on ${nodeName}? Unsaved work in it is lost.`)) return;
    try {
      await api(`${node(nodeId)}/appstream/sessions/${encodeURIComponent(sessionId)}`, { method: 'DELETE' });
      ended = true; closeStreamUi();
      say(endText({ reason: 'stopped' }), { kind: 'end', actions: [['Close', () => w.close()]] });
    } catch (e) { toast(`Could not stop ${app.name || 'the app'}: ${e.message}`, 'error', 6000); }
  }

  /** A person switches app streaming on: confirmed by typing the machine's name (the host refuses agents and anything unconfirmed). */
  async function enableStreaming() {
    const typed = window.prompt(`Type the machine name (${nodeName}) to switch app streaming on there.`);
    if (typed == null) return;
    try {
      await api(`${node(nodeId)}/appstream/enable`, { method: 'POST', body: { enabled: true, confirm: typed.trim() } });
      toast(`App streaming is on for ${nodeName}`, 'info', 3000);
      refused = false; attempt = 0; connect();
    } catch (e) { toast(`Could not switch it on: ${e.message}`, 'error', 6000); }
  }

  function teardown() {
    clearTimeout(retryTimer); clearTimeout(resizeTimer); clearTimeout(barTimer);
    if (rafDraw) cancelAnimationFrame(rafDraw);
    if (rafInput) cancelAnimationFrame(rafInput);
    try { if (ws?.readyState === 1) { releaseAll(); ws.close(1000); } else ws?.close(); } catch { /* closed */ }
    ws = null;
    closeDecoder();
    if (imgUrl) URL.revokeObjectURL(imgUrl);
    if (document.pointerLockElement === stage) document.exitPointerLock();
  }
  w.onCleanup(teardown);

  Object.defineProperties(w, {
    appStream: { value: { sessionId, nodeId, get state() { return { ...state, stream, transport, webcodecs, ended, refused }; }, get stats() { const t = performance.now(); return { fps: fpsMeter.rate(t), kbps: kbpsMeter.rate(t), rtt: lastRtt, decodeMs: decodeMs.p(0.5), g2gMs: g2g.p(0.5), dropped: droppedTotal, decoded: decodedTotal }; }, send, push, flush: flushNow, canvas, img, stage } },
  });
  renderBar();
  connect();
  return w;
}
