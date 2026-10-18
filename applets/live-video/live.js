// The live loop: a rolling generation pipeline on one ComfyUI.
//  - start() checks the templates against a fresh /object_info (nothing is queued when a node, model or
//    option is missing), leases VRAM from the GPU overseer, opens the ComfyUI websocket and starts pumping.
//  - pump() keeps the GPU busy: up to two of our prompts in ComfyUI's queue (one running, the next waiting),
//    so the next clip is generating while the browser plays the current one. It holds back once about
//    three clips are buffered ahead of the estimated playhead, so a fast GPU doesn't run away.
//  - modes: loop (the whole prompt, a new seed each clip), drift (one prompt line per clip, cycling) and
//    chain (each clip starts from the last frame of the previous one, through the image-to-video template;
//    one prompt in flight at a time because the next needs the previous result).
//  - progress and finished clips come over the websocket; /history is polled as a backstop.
//  - stop() interrupts our running prompt (only ours: someone else's job is left alone), deletes our
//    queued prompts, closes the socket and releases the VRAM lease.
// Everything that happens is pushed through emit(type, data) for the server's SSE stream.
import crypto from 'node:crypto';
import { buildWorkflow, checkTemplate, describeMissing, fitSize, framesFor } from './workflows.js';

export class LiveError extends Error {
  constructor(message, status = 400, details = undefined) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

export const MODES = ['loop', 'drift', 'chain'];
const VIDEO_RE = /\.(webm|mp4|mov|mkv|gif|webp)$/i;

/** Validate a start request against the templates → normalized session parameters. Throws LiveError(400). */
export function normalizeRequest(req, templates) {
  const r = req || {};
  const tmpl = templates.get(String(r.template || ''));
  if (!tmpl || tmpl.kind !== 't2v') throw new LiveError('template must be one of: ' + [...templates.values()].filter((t) => t.kind === 't2v').map((t) => t.id).join(', '));
  const prompt = typeof r.prompt === 'string' ? r.prompt.trim() : '';
  if (!prompt) throw new LiveError('prompt is empty');
  if (prompt.length > 4000) throw new LiveError('prompt is longer than 4000 characters');
  const lines = prompt.split('\n').map((s) => s.trim()).filter(Boolean);
  let mode = r.mode == null || r.mode === '' ? 'loop' : String(r.mode);
  if (!MODES.includes(mode)) throw new LiveError('mode must be loop, drift or chain');
  let width = Number(r.width);
  let height = Number(r.height);
  if (typeof r.resolution === 'string' && /^\d+x\d+$/.test(r.resolution)) [width, height] = r.resolution.split('x').map(Number);
  if (!width || !height) ({ width, height } = tmpl.defaults);
  const size = fitSize(width, height, tmpl.limits);
  const fps = r.fps == null ? tmpl.defaults.fps : Number(r.fps);
  if (!Number.isFinite(fps) || fps < 4 || fps > 60) throw new LiveError('fps must be 4-60');
  const seconds = r.seconds == null ? tmpl.defaults.seconds : Number(r.seconds);
  if (!Number.isFinite(seconds) || seconds <= 0 || seconds > 20) throw new LiveError('seconds must be more than 0 and at most 20');
  const frames = framesFor(seconds, fps, tmpl.limits);
  const seed = r.seed == null || r.seed === '' ? crypto.randomInt(0, 2 ** 31) : Number(r.seed);
  if (!Number.isInteger(seed) || seed < 0) throw new LiveError('seed must be a whole number ≥ 0');
  const negative = r.negative == null ? null : String(r.negative).slice(0, 2000);
  const image = r.image == null || r.image === '' ? null : String(r.image);
  if (image && (!/^[\w./ -]{1,200}$/.test(image) || image.includes('..'))) throw new LiveError('image must be a name returned by api/image');
  const i2v = tmpl.i2v ? templates.get(tmpl.i2v) : null;
  let notice = null;
  if ((mode === 'chain' || image) && !i2v) {
    notice = `${tmpl.label} has no image-to-video template: ${image ? 'the start image is ignored' : ''}${image && mode === 'chain' ? ' and ' : ''}${mode === 'chain' ? 'continuous mode runs as prompt drift' : ''}`;
    if (mode === 'chain') mode = 'drift';
  }
  return { template: tmpl.id, tmpl, i2v, prompt, lines, mode, width: size.width, height: size.height, fps, seconds, frames, duration: frames / fps, seed, negative, image: i2v ? image : null, notice };
}

/** The files a ComfyUI output node produced ({images|gifs|videos|video: [{filename, subfolder, type}]}). */
export function outputFiles(nodeOutput) {
  const out = [];
  for (const v of Object.values(nodeOutput || {})) for (const f of Array.isArray(v) ? v : []) if (f && typeof f.filename === 'string') out.push(f);
  return out;
}

export function viewUrl(f) {
  return 'api/view?' + new URLSearchParams({ filename: f.filename, subfolder: f.subfolder || '', type: f.type || 'output' });
}

export function createLive({
  templates, getClient, getObjectInfo, getOverseer = () => null, getModelOverrides = () => ({}),
  emit = () => {}, log = () => {}, onClips = () => {}, clips: initialClips = [],
  now = Date.now, tickMs = 1000, maxAheadClips = 3, maxClips = 30, leaseRefreshMs = 10 * 60 * 1000,
}) {
  let status = 'idle';
  let error = null;
  let notice = null;
  let s = null; // the running session
  let clips = initialClips.slice(-maxClips);
  let pumping = false;

  const setNotice = (text, level = 'info') => { notice = text ? { text, level, at: now() } : null; emit('notice', notice); };
  const pendingList = () => (s ? [...s.pending.values()].map((p) => ({ promptId: p.promptId, index: p.index, prompt: p.prompt, started: !!p.startedAt, progress: p.progress })) : []);

  function snapshot() {
    return {
      status, error, notice,
      session: s && { id: s.id, template: s.template, prompt: s.prompt, mode: s.mode, width: s.width, height: s.height, frames: s.frames, fps: s.fps, seconds: s.seconds, duration: s.duration, submitted: s.next, done: s.done, socket: !!s.ws?.connected, lease: s.lease },
      pending: pendingList(),
      clips,
    };
  }
  const emitState = () => emit('state', snapshot());

  async function start(req) {
    if (s) await stop({ reason: 'restart' });
    const p = normalizeRequest(req, templates);
    let objectInfo;
    try { objectInfo = await getObjectInfo(true); }
    catch (e) { throw new LiveError(e.message, 502); }
    const overrides = getModelOverrides();
    const needed = [p.tmpl, ...(p.mode === 'chain' || p.image ? [p.i2v] : [])];
    const problems = needed.map((t) => ({ template: t.id, ...checkTemplate(t, objectInfo, overrides) })).filter((c) => !c.ok);
    if (problems.length) throw new LiveError(problems.map((c) => describeMissing(c.template, c)).join(' · '), 409, problems);

    const client = getClient();
    s = { ...p, id: crypto.randomBytes(4).toString('hex'), client, overrides, next: 0, done: 0, failures: 0, pending: new Map(), completing: new Set(), submitting: new Set(), ended: false, lastFrame: null, playEnd: 0, ticks: 0, lease: null, leaseAt: 0, ws: null, timer: null };
    status = 'starting';
    error = null;
    setNotice(p.notice, 'warn');
    emitState();
    const session = s;
    const ready = (async () => {
      await takeLease(session);
      if (s !== session) return;
      session.ws = client.connect({ onMessage: (m) => onMessage(session, m), onOpen: emitState, onClose: () => { if (s === session) emitState(); } });
      session.timer = setInterval(() => tick(session), tickMs);
      status = 'running';
      emitState();
      await pump();
    })().catch((e) => fail(session, e.message));
    return { state: snapshot(), ready };
  }

  async function takeLease(session) {
    const ov = getOverseer();
    if (!ov) return;
    const need = Math.max(session.tmpl.vramMb || 0, session.i2v && (session.mode === 'chain' || session.image) ? session.i2v.vramMb || 0 : 0);
    if (!session.lease) setNotice(`Asking the GPU overseer for ${(need / 1024).toFixed(1)} GB of VRAM…`);
    const r = await ov.acquire(need);
    session.leaseAt = now();
    if (r.unreachable) { session.lease = 'none'; setNotice('GPU overseer not reachable: running without a VRAM lease', 'warn'); }
    else if (!r.ok) { session.lease = 'short'; setNotice(`GPU overseer could free only ${r.free_mb} MB of the ${need} MB asked for: ComfyUI will offload what does not fit`, 'warn'); }
    else {
      session.lease = 'held';
      if (notice && /overseer/.test(notice.text)) setNotice(r.unloaded?.length ? `GPU overseer unloaded ${r.unloaded.join(', ')} to make room` : null);
    }
  }

  /** Seconds of video buffered ahead of the estimated playhead, counting clips still generating. */
  function aheadSeconds(session) {
    return Math.max(0, session.playEnd - now()) / 1000 + session.pending.size * session.duration;
  }

  function canSubmit(session) {
    if (status !== 'running' || s !== session || session.ended) return false;
    if (session.pending.size >= (session.mode === 'chain' ? 1 : 2)) return false;
    return aheadSeconds(session) < maxAheadClips * session.duration;
  }

  async function pump() {
    if (pumping) return;
    pumping = true;
    try {
      while (s && canSubmit(s)) await submitNext(s);
    } finally { pumping = false; }
  }

  function promptFor(session, index) {
    return session.mode === 'loop' ? session.lines.join(' ') : session.lines[index % session.lines.length];
  }

  async function submitNext(session) {
    const index = session.next++;
    const image = (session.mode === 'chain' && session.lastFrame) || session.image;
    const tmpl = image ? session.i2v : session.tmpl;
    const text = promptFor(session, index);
    const seed = (session.seed + index) % 2 ** 32;
    const wf = buildWorkflow(tmpl, { prompt: text, negative: session.negative, seed, width: session.width, height: session.height, frames: session.frames, fps: session.fps, image, prefix: `live-video/${session.id}-${String(index).padStart(4, '0')}` }, session.overrides);
    // Tracked so fail() can wait for a submit still in flight (and its take-back) before it cleans the queue.
    const job = (async () => {
      const r = await session.client.queuePrompt(wf);
      if (s !== session || session.ended) { // stopped or failed while we were submitting: take it back out
        await session.client.deleteQueued([r.prompt_id]).catch(() => {});
        return;
      }
      session.pending.set(r.prompt_id, { promptId: r.prompt_id, index, prompt: text, seed, tmpl, submittedAt: now(), startedAt: null, progress: { value: 0, max: 0 } });
      emit('queued', { promptId: r.prompt_id, index, prompt: text });
      emitState();
    })();
    session.submitting.add(job);
    try {
      await job;
    } catch (e) {
      clipFailed(session, null, `could not queue clip ${index + 1}: ${e.message}`);
    } finally {
      session.submitting.delete(job);
    }
  }

  function onMessage(session, msg) {
    if (s !== session || !msg || typeof msg !== 'object') return;
    const d = msg.data || {};
    let p = d.prompt_id ? session.pending.get(d.prompt_id) : null;
    if (!p && msg.type === 'progress' && !d.prompt_id) p = [...session.pending.values()].find((x) => x.startedAt);
    if (!p) return;
    switch (msg.type) {
      case 'execution_start': p.startedAt = now(); emitState(); break;
      case 'execution_cached': if (!p.startedAt) p.startedAt = now(); break;
      case 'executing':
        if (!p.startedAt) p.startedAt = now();
        if (d.node == null) complete(session, p.promptId);
        break;
      case 'progress':
        p.progress = { value: Number(d.value) || 0, max: Number(d.max) || 0 };
        emit('progress', { promptId: p.promptId, index: p.index, value: p.progress.value, max: p.progress.max, node: d.node ?? null });
        break;
      case 'execution_success': complete(session, p.promptId); break;
      case 'execution_error': clipFailed(session, p.promptId, `clip ${p.index + 1} failed in ${d.node_type || 'a node'}: ${d.exception_message || 'error'}`); break;
      case 'execution_interrupted': clipFailed(session, p.promptId, `clip ${p.index + 1} was interrupted`); break;
    }
  }

  async function complete(session, promptId, history) {
    const p = session.pending.get(promptId);
    if (!p || session.completing.has(promptId)) return;
    session.completing.add(promptId);
    try {
      let h = history;
      for (let i = 0; !h && i < 5; i++) {
        h = await session.client.history(promptId).catch(() => null);
        if (!h) await new Promise((r) => setTimeout(r, 200 * (i + 1)));
      }
      const outputs = h?.outputs || {};
      const video = outputFiles(outputs[p.tmpl.outputs.video]).find((f) => VIDEO_RE.test(f.filename)) || outputFiles(outputs[p.tmpl.outputs.video])[0];
      if (!video) return clipFailed(session, promptId, `clip ${p.index + 1} finished without a video output`);
      const last = p.tmpl.outputs.lastFrame ? outputFiles(outputs[p.tmpl.outputs.lastFrame])[0] : null;
      const t = now();
      const clip = {
        id: promptId, session: session.id, index: p.index, url: viewUrl(video), poster: last ? viewUrl(last) : null,
        prompt: p.prompt, seed: p.seed, template: p.tmpl.id, width: session.width, height: session.height, frames: session.frames, fps: session.fps,
        duration: session.duration, genMs: t - (p.startedAt || p.submittedAt), at: t,
      };
      session.playEnd = Math.max(t, session.playEnd) + session.duration * 1000;
      if (session.mode === 'chain' && s === session) {
        if (last) {
          try {
            const res = await session.client.view(last);
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const up = await session.client.uploadImage(Buffer.from(await res.arrayBuffer()), `live-video-${session.id}-last.png`);
            session.lastFrame = up.subfolder ? `${up.subfolder}/${up.name}` : up.name;
          } catch (e) {
            session.lastFrame = null;
            setNotice(`could not carry the last frame over (${e.message}): the next clip starts fresh`, 'warn');
          }
        } else session.lastFrame = null;
      }
      session.pending.delete(promptId);
      session.failures = 0;
      session.done++;
      clips = [...clips, clip].slice(-maxClips);
      onClips(clips);
      emit('clip', clip);
      emitState();
      pump();
    } finally {
      session.completing.delete(promptId);
    }
  }

  function clipFailed(session, promptId, message) {
    if (promptId) session.pending.delete(promptId);
    if (s !== session || status === 'stopping') return;
    session.failures++;
    log('live-video:', message);
    if (session.failures >= 3) return fail(session, `${message} (3 clips in a row failed, live stopped)`);
    setNotice(message, 'error');
    emitState();
    pump();
  }

  async function tick(session) {
    if (s !== session) return;
    session.ticks++;
    // Backstop for a dropped or missing websocket: ask /history about our prompts.
    if (!session.ws?.connected || session.ticks % 5 === 0) {
      for (const p of [...session.pending.values()]) {
        if (now() - p.submittedAt < tickMs) continue;
        const h = await session.client.history(p.promptId).catch(() => null);
        if (!h || s !== session) continue;
        if (h.status?.status_str === 'error') {
          const m = (h.status.messages || []).find(([k]) => k === 'execution_error')?.[1];
          clipFailed(session, p.promptId, `clip ${p.index + 1} failed${m ? ` in ${m.node_type}: ${m.exception_message}` : ''}`);
        } else if (h.status?.completed || Object.keys(h.outputs || {}).length) complete(session, p.promptId, h);
      }
    }
    if (session.lease && now() - session.leaseAt > leaseRefreshMs) takeLease(session).catch(() => {});
    pump();
  }

  /** Change the prompt (and mode/negative) for the clips not queued yet. */
  function update(req) {
    if (!s) throw new LiveError('live is not running', 409);
    if (req?.prompt != null) {
      const prompt = String(req.prompt).trim();
      if (!prompt) throw new LiveError('prompt is empty');
      s.prompt = prompt.slice(0, 4000);
      s.lines = s.prompt.split('\n').map((x) => x.trim()).filter(Boolean);
    }
    if (req?.negative != null) s.negative = String(req.negative).slice(0, 2000);
    if (req?.mode != null) {
      if (!MODES.includes(req.mode)) throw new LiveError('mode must be loop, drift or chain');
      if (req.mode === 'chain' && !s.i2v) throw new LiveError(`${s.tmpl.label} has no image-to-video template, so it cannot chain clips`);
      s.mode = req.mode;
    }
    emitState();
    return snapshot();
  }

  async function teardown(session) {
    clearInterval(session.timer);
    session.ws?.close();
    const ov = getOverseer();
    if (ov) await ov.release().catch(() => {});
  }

  /** Stop: interrupt our running prompt, delete our queued ones. → {interrupted:[ids], deleted:[ids]} */
  async function stop({ reason = 'stop' } = {}) {
    const session = s;
    if (!session) return { interrupted: [], deleted: [], state: snapshot() };
    status = 'stopping';
    emitState();
    const ids = [...session.pending.keys()];
    let running = null;
    try { running = ((await session.client.getQueue())?.queue_running || []).map((e) => e[1]); } catch {}
    const ours = running ? ids.filter((id) => running.includes(id)) : ids.filter((id) => session.pending.get(id).startedAt);
    // Queued ones first: once the running prompt is interrupted ComfyUI starts the next in line at once.
    const deleted = ids.filter((id) => !ours.includes(id));
    if (deleted.length) await session.client.deleteQueued(deleted).catch((e) => log('live-video: could not delete queued prompts:', e.message));
    const interrupted = [];
    for (const id of ours) {
      try { await session.client.interrupt(id); interrupted.push(id); } catch (e) { log('live-video: interrupt failed:', e.message); }
    }
    session.pending.clear();
    await teardown(session);
    if (s === session) { s = null; status = 'idle'; }
    if (reason === 'stop') setNotice(null);
    emitState();
    return { interrupted, deleted, state: snapshot() };
  }

  async function fail(session, message) {
    if (s !== session || session.ended) return;
    session.ended = true; // no new submits; one in flight takes itself back out
    log('live-video:', message);
    await Promise.allSettled([...session.submitting]);
    const ids = [...session.pending.keys()];
    if (ids.length) await session.client.deleteQueued(ids).catch(() => {});
    session.pending.clear();
    await teardown(session);
    if (s === session) s = null;
    status = 'error';
    error = message;
    setNotice(message, 'error');
    emitState();
  }

  return {
    start, stop, update, snapshot,
    get status() { return status; },
    get clips() { return clips; },
    /** The session's internals, for tests. */
    get session() { return s; },
  };
}
