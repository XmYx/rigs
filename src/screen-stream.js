/**
 * Live desktop stream: GET /api/local/screen/stream as a WebSocket (and /api/nodes/<id>/screen/stream through the
 * peer proxy). Frames come from control.frame(), i.e. the SAME gate and capture backend as mesh_screen
 * (src/control.js); there is no other capture route here and nothing on this path can switch access back on.
 *
 * Protocol (server → client): text {type:'hello', node, fps, quality, scale, maxWidth, display, viewers}, then one
 * binary message per JPEG frame, preceded by text {type:'meta', width, height, scale, display} whenever the size
 * changes; text {type:'status', status, message} for a transient problem (locked screen, rate limit, slow helper —
 * the stream keeps trying); on refusal text {type:'error', status:'control-off' | 'not-allowed' | 'needs-permission'
 * | 'unsupported' | 'no-session', code, message, fix?} and a close with a 44xx/45xx code. Client → server: text
 * {fps, quality, scale, maxWidth, display} to change the stream's settings.
 *
 * Viewers that ask for the same settings share one capture loop; the loop runs only while it has a viewer. Access
 * is re-checked before every frame, every `watchMs` while waiting, and at once on a kill or settings change, so a
 * stream ends within about a second of screen access being switched off. Pacing and the gate decisions are the
 * pure functions below (test/screen-stream.test.js).
 */

export const DEFAULTS = Object.freeze({ fps: 3, quality: 60, scale: 0.5 });
export const LIMITS = Object.freeze({ fps: [0.2, 10], quality: [10, 95], scale: [0.1, 1], maxWidth: [160, 3840] });
// Used for the first frame of a stream when no maxWidth is given; later frames use the measured source width.
const GUESS_SOURCE_WIDTH = 1920;

const clamp = (v, [lo, hi], fallback) => {
  const n = v == null || v === '' ? NaN : Number(v);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : fallback;
};

/** Normalise requested settings (a URLSearchParams or a plain object): clamped, never throws. */
export function streamOptions(input = {}) {
  const get = (k) => (typeof input.get === 'function' ? input.get(k) : input[k]);
  const maxWidth = clamp(get('maxWidth'), LIMITS.maxWidth, undefined);
  const display = get('display');
  return {
    fps: Math.round(clamp(get('fps'), LIMITS.fps, DEFAULTS.fps) * 10) / 10,
    quality: Math.round(clamp(get('quality'), LIMITS.quality, DEFAULTS.quality)),
    scale: Math.round(clamp(get('scale'), LIMITS.scale, DEFAULTS.scale) * 100) / 100,
    ...(maxWidth != null ? { maxWidth: Math.round(maxWidth) } : {}),
    ...(display != null && display !== '' ? { display: /^-?\d+$/.test(String(display)) ? Number(display) : String(display).slice(0, 100) } : {}),
  };
}

/** Viewers share a capture loop when their settings and calling node match (allowFrom depends on the node). */
export const streamKey = (o, from = '') => JSON.stringify([from, o.fps, o.quality, o.scale, o.maxWidth ?? null, o.display ?? null]);

/** The width to ask the backend for: source width × scale, capped by maxWidth, never below the minimum. */
export function targetWidth({ sourceWidth, scale = DEFAULTS.scale, maxWidth } = {}) {
  const w = Math.round((sourceWidth || GUESS_SOURCE_WIDTH) * scale);
  return Math.max(LIMITS.maxWidth[0], Math.min(maxWidth ?? Infinity, w));
}

/** Wait before the next frame so the stream holds `fps` (a slow capture just runs back to back). */
export const frameDelay = (fps, tookMs = 0) => Math.max(0, Math.round(1000 / fps - tookMs));

/** Back-off after a transient failure: at least one frame interval, doubling from 500 ms, at most 5 s. */
export const retryDelay = (fps, failures = 1) => Math.min(5000, Math.max(Math.round(1000 / fps), 500 * 2 ** Math.max(0, failures - 1)));

const ENDINGS = {
  off: { status: 'control-off', close: 4403 },
  'not-allowed': { status: 'not-allowed', close: 4403 },
  'needs-permission': { status: 'needs-permission', close: 4412 },
  unsupported: { status: 'unsupported', close: 4501 },
  'no-session': { status: 'no-session', close: 4503 },
  'bad-args': { status: 'bad-args', close: 4400 },
};

/** A refusal from control.accessFor() as the stream's ending. */
export const refusal = (r) => ({ end: true, ...(ENDINGS[r.code] || ENDINGS.off), code: r.code, message: r.message });

/**
 * Whether a stream could start, from control.status() (which never launches a helper or prompts): null when it
 * can, else the refusal a stream would end with, in the same order as control's perform(). A status that could not
 * be read (status.error) is not decisive: the stream itself decides. Lets a dashboard show "not granted" without
 * opening (and auditing) a stream that is bound to be refused.
 */
export function streamReadiness(st = {}, platform = st.platform) {
  if (st.error) return null;
  if (st.session === 'none') return { status: 'no-session', message: 'No graphical session is reachable' };
  const permission = st.permissions?.screenCapture;
  if (!st.backend?.capture && platform === 'mac' && permission?.fix) return { status: 'needs-permission', message: 'RIGS Control is not running, so the screen cannot be streamed', fix: permission.fix };
  if (!st.backend?.capture) return { status: 'unsupported', message: 'No capture backend is available for this desktop' };
  if (permission?.ok === false) return { status: 'needs-permission', message: 'Screen capture permission is required', ...(permission.fix ? { fix: permission.fix } : {}) };
  return null;
}

/**
 * What a failed frame means for the stream. `refusedNow` is control.accessFor() right after the failure: when access
 * is off, the stream ends as control-off whatever the frame said. An 'off' error while access is still on is the
 * helper restarting or a lease ending, not a switch: retry. Missing permission / backend / session ends it.
 */
export function decideOnError(error = {}, refusedNow = null) {
  if (refusedNow) return refusal(refusedNow);
  const end = error.code !== 'off' && ENDINGS[error.code];
  if (end) return { end: true, ...end, code: error.code, message: error.message, ...(error.fix ? { fix: error.fix } : {}) };
  return { end: false, status: error.code === 'off' ? 'restarting' : error.code || 'error', code: error.code || 'error', message: error.message };
}

/**
 * The viewer hub. `control` needs frame(options, caller), accessFor(caller), noteStream(phase, args, caller) and
 * events. A viewer is { send(buffer), message(object), close(code, reason) }.
 */
export function createStreamHub({ control, nodeName = () => '', now = Date.now, watchMs = 500, log = () => {} }) {
  const streams = new Map();

  function endStream(s, ending) {
    if (!s.active) return;
    s.active = false;
    clearTimeout(s.timer);
    streams.delete(s.key);
    // The settings go along so the announcement (wireControlEvents) can match this end to its start.
    control.noteStream('end', { ...s.opts, frames: s.frames,ms: now() - s.startedAt, viewers: s.viewers.size, ...(ending ? { reason: ending.status } : {}) }, s.caller);
    for (const v of s.viewers) {
      if (ending) {
        v.message({ type: 'error', status: ending.status, code: ending.code, message: ending.message, ...(ending.fix ? { fix: ending.fix } : {}) });
        v.close(ending.close, ending.status);
      }
    }
    s.viewers.clear();
    if (!streams.size) stopWatch();
  }

  function schedule(s, ms) {
    clearTimeout(s.timer);
    s.timer = setTimeout(() => tick(s), ms);
  }

  async function tick(s) {
    if (!s.active) return;
    const refused = control.accessFor(s.caller);
    if (refused) return endStream(s, refusal(refused));
    const started = now();
    let f;
    try {
      f = await control.frame({ format: 'jpeg', quality: s.opts.quality, maxWidth: targetWidth({ sourceWidth: s.sourceWidth, scale: s.opts.scale, maxWidth: s.opts.maxWidth }), display: s.opts.display }, s.caller);
    } catch (e) {
      if (!s.active) return;
      const d = decideOnError(e, control.accessFor(s.caller));
      if (d.end) return endStream(s, d);
      s.failures++;
      if (s.lastStatus !== d.status) for (const v of s.viewers) v.message({ type: 'status', status: d.status, message: d.message });
      s.lastStatus = d.status;
      return schedule(s, retryDelay(s.opts.fps, s.failures));
    }
    // The last viewer left (or access went off) while the frame was being captured: drop it.
    if (!s.active) return;
    s.failures = 0;
    if (s.lastStatus) { for (const v of s.viewers) v.message({ type: 'status', status: 'ok' }); s.lastStatus = null; }
    s.frames++;
    s.sourceWidth = Math.round(f.width * (f.scale || 1));
    const meta = { type: 'meta', width: f.width, height: f.height, scale: f.scale, display: f.display ?? null };
    const metaKey = JSON.stringify(meta);
    for (const v of s.viewers) {
      if (v.metaKey !== metaKey) { v.message(meta); v.metaKey = metaKey; }
      v.send(f.data);
    }
    schedule(s, frameDelay(s.opts.fps, now() - started));
  }

  let watcher = null;
  function recheck() {
    for (const s of [...streams.values()]) {
      const refused = control.accessFor(s.caller);
      if (refused) endStream(s, refusal(refused));
    }
  }
  function startWatch() { if (!watcher) { watcher = setInterval(recheck, watchMs); watcher.unref?.(); } }
  function stopWatch() { clearInterval(watcher); watcher = null; }
  // A kill or a settings switch ends refused streams at once (the frame in flight is already rejected by control).
  control.events?.on('kill', recheck);
  control.events?.on('change', recheck);

  /** Add a viewer. Returns null when access is refused (the viewer has been told and closed), else { leave, key }. */
  function join(viewer, requested = {}, caller = {}) {
    const opts = streamOptions(requested);
    const refused = control.accessFor(caller);
    if (refused) {
      // Every refusal is in the audit log, a viewer turned away before its stream started too.
      control.noteStream('join', { ...opts }, caller, refused);
      const r = refusal(refused);
      viewer.message({ type: 'error', status: r.status, code: r.code, message: r.message });
      viewer.close(r.close, r.status);
      return null;
    }
    const key = streamKey(opts, caller.from || '');
    let s = streams.get(key);
    if (!s) {
      s = { key, opts, caller, viewers: new Set(), frames: 0, failures: 0, startedAt: now(), sourceWidth: null, active: true, timer: null, lastStatus: null };
      streams.set(key, s);
      control.noteStream('start', { ...opts }, caller);
      startWatch();
      schedule(s, 0);
    }
    s.viewers.add(viewer);
    viewer.message({ type: 'hello', node: nodeName(), ...opts, viewers: s.viewers.size });
    let left = false;
    return {
      key,
      leave() {
        if (left) return;
        left = true;
        s.viewers.delete(viewer);
        if (!s.viewers.size) endStream(s, null);
      },
    };
  }

  function status() {
    const list = [...streams.values()].map((s) => ({ ...s.opts, from: s.caller.from || '', viewers: s.viewers.size, frames: s.frames, since: new Date(s.startedAt).toISOString(), ...(s.lastStatus ? { status: s.lastStatus } : {}) }));
    return { node: nodeName(), streams: list, viewers: list.reduce((n, s) => n + s.viewers, 0), capturing: list.length > 0 };
  }

  /** Serve one WebSocket viewer. `query` is the upgrade URL's searchParams. */
  function attachWs(ws, query, caller) {
    const viewer = {
      // A slow viewer skips frames rather than buffering them.
      send: (data) => { if (ws.readyState === 1 && ws.bufferedAmount < 4 * 1024 * 1024) ws.send(data, { binary: true }); },
      message: (obj) => { if (ws.readyState === 1) ws.send(JSON.stringify(obj)); },
      close: (code, reason) => { if (ws.readyState === 1) ws.close(code, reason); },
    };
    let handle = join(viewer, query, caller);
    let current = streamOptions(query);
    ws.on('message', (data, isBinary) => {
      if (isBinary || !handle) return;
      let next;
      try { next = JSON.parse(String(data)); } catch { return; }
      if (!next || typeof next !== 'object') return;
      const opts = streamOptions({ ...current, ...next });
      if (streamKey(opts, caller.from || '') === handle.key) return;
      handle.leave();
      viewer.metaKey = null;
      current = opts;
      handle = join(viewer, opts, caller);
    });
    const leave = () => handle?.leave();
    ws.on('close', leave);
    ws.on('error', (e) => { log('screen stream:', e.message); leave(); });
  }

  return { join, status, attachWs, recheck };
}
