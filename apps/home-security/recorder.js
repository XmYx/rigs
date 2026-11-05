// Home Security recorder (t3, docs/home-security.md §3–§8): segment index, motion events with pre/post-roll,
// thumbnails, clips, the motion-mode ring trimmer, retention scheduling, and the t3 REST routes.
//
// Wiring (server.js / ingest.js, owned by t2):
//   const rec = await createRecorder({ dataDir, store?, getCamera?, node?, emit?, log? });
//   ingest → rec.onSegment({ camera, startMs, durMs, path, bytes }) and rec.onFrame({ camera, frame, width, height, t })
//   server → if (await rec.handle(req, res, url, ctx)) return;   ctx = { self: { node, base }, fanout?, onSettingsChanged? }
//   shutdown → rec.close()
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { clipWindow, createDetector, createEventMachine } from './motion.js';
import { pruneEmptyDirs, runRetention, safeRemove, storageReport } from './retention.js';
import { loadCameras, openStore } from './store.js';

const HOUR = 3_600_000;
const MAX_TIMELINE_MS = 7 * 24 * HOUR;
const MAX_VOD_MS = 6 * HOUR;
const MAX_BODY = 64 * 1024;
const ID_RE = /^[A-Za-z0-9._-]{1,200}$/;

function sendJson(res, status, data) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(data));
}
const sendErr = (res, status, error, extra) => sendJson(res, status, { error, ...extra });

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > MAX_BODY) { reject(Object.assign(new Error('body too large'), { status: 413 })); req.destroy(); } else chunks.push(c); });
    req.on('end', () => {
      if (!size) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { reject(Object.assign(new Error('body must be JSON'), { status: 400 })); }
    });
    req.on('error', reject);
  });
}

const num = (v) => (v === null || v === undefined || v === '' ? undefined : Number.isFinite(Number(v)) ? Number(v) : NaN);
const boolQ = (v) => (v === 'true' || v === '1' ? true : v === 'false' || v === '0' ? false : undefined);

/** Merge sorted segments into spans; a hole > 1.5 × the segment length starts a new span. Pure. */
export function mergeSpans(segments, clampFrom = -Infinity, clampTo = Infinity) {
  const spans = [];
  for (const s of segments) {
    const a = Math.max(s.startMs, clampFrom); const b = Math.min(s.startMs + s.durMs, clampTo);
    if (b <= a) continue;
    const last = spans[spans.length - 1];
    if (last && a - last.to <= 0.5 * s.durMs) last.to = Math.max(last.to, b); else spans.push({ from: a, to: b });
  }
  return spans;
}

/** HLS VOD playlist with PROGRAM-DATE-TIME on every segment and DISCONTINUITY at gaps. `uri(seg)` gives each URI. Pure. */
export function vodPlaylist(segments, uri) {
  const target = Math.max(1, ...segments.map((s) => Math.ceil(s.durMs / 1000)));
  const lines = ['#EXTM3U', '#EXT-X-VERSION:3', `#EXT-X-TARGETDURATION:${target}`, '#EXT-X-MEDIA-SEQUENCE:0', '#EXT-X-PLAYLIST-TYPE:VOD'];
  let prevEnd = null;
  for (const s of segments) {
    // Segments are cut with -reset_timestamps 1, so each one's PTS restarts: mark every boundary that is a real gap,
    // and every boundary where timestamps restart (all of them), so players re-anchor instead of stalling.
    if (prevEnd !== null) lines.push('#EXT-X-DISCONTINUITY');
    lines.push(`#EXT-X-PROGRAM-DATE-TIME:${new Date(s.startMs).toISOString()}`);
    lines.push(`#EXTINF:${(s.durMs / 1000).toFixed(3)},`);
    lines.push(uri(s));
    prevEnd = s.startMs + s.durMs;
  }
  lines.push('#EXT-X-ENDLIST');
  return lines.join('\n') + '\n';
}

export async function createRecorder({
  dataDir, store, settings: initialSettings, getCamera, getCameras, node = null, emit = () => {}, log = (m) => console.log(m),
  ffmpegPath, now = () => Date.now(), timers = true,
} = {}) {
  if (!store) store = await openStore(dataDir);
  dataDir = store.dataDir;
  if (initialSettings) store.patchSettings(initialSettings);
  const settings = () => store.getSettings();
  const ffmpeg = () => ffmpegPath || settings().ffmpeg.path || process.env.FFMPEG || 'ffmpeg';

  // cameras.json, re-read when it changes on disk (t2 writes it)
  let camCache = { mtime: -1, list: [] };
  const camerasList = () => {
    if (getCameras) return getCameras();
    let m = 0; try { m = fs.statSync(path.join(dataDir, 'cameras.json')).mtimeMs; } catch { /* none yet */ }
    if (m !== camCache.mtime) camCache = { mtime: m, list: loadCameras(dataDir) };
    return camCache.list;
  };
  const cameraOf = (id) => (getCamera ? getCamera(id) : camerasList().find((c) => c.id === id)) || null;
  const modeOf = (cam) => cam?.mode || settings().recording.defaultMode;

  // ---------- segments ----------
  function onSegment({ camera, startMs, durMs, path: rel, bytes }) {
    if (!camera || !Number.isFinite(startMs) || !rel) return null;
    rel = rel.split(path.sep).join('/');
    if (bytes === undefined) { try { bytes = fs.statSync(path.join(dataDir, rel)).size; } catch { bytes = 0; } }
    return store.addSegment({ camera, startMs: Math.round(startMs), durMs: Math.round(durMs || settings().recording.segmentSeconds * 1000), path: rel, bytes });
  }
  const liveSegments = (camera, n) => store.lastSegments(camera, n).map(({ startMs, durMs, path: p }) => ({ startMs, durMs, path: p }));
  const segmentPath = (camera, startMs) => {
    const s = store.segmentByStart(camera, Number(startMs));
    return s ? path.join(dataDir, s.path) : null;
  };

  // ---------- motion ----------
  const cams = new Map(); // camera → { det, sm, key, eventId, lastMotionEmit, lastThumbAt }
  function camState(camera, width, height, cam) {
    const s = settings();
    const sens = cam?.motion?.sensitivity ?? s.motion.sensitivity;
    const zones = cam?.motion?.zones || [];
    const cfgKey = JSON.stringify([sens, zones]);
    let st = cams.get(camera);
    if (!st || st.det.width !== width || st.det.height !== height) {
      const prevSm = st?.sm;
      st = { det: createDetector({ width, height, sensitivity: sens, zones }), sm: prevSm || createEventMachine(), key: cfgKey, eventId: st?.eventId || null, lastMotionEmit: 0, lastThumbAt: 0 };
      cams.set(camera, st);
    } else if (st.key !== cfgKey) { st.det.configure({ sensitivity: sens, zones }); st.key = cfgKey; }
    st.sm.configure({ minDurationMs: s.motion.minDurationMs, postRollMs: s.recording.postRollSeconds * 1000, maxEventMs: s.motion.maxEventSeconds * 1000 });
    return st;
  }

  const eventDir = (id) => path.join(dataDir, 'events', id);
  function copyThumb(camera, id) {
    const src = path.join(dataDir, 'live', camera, 'latest.jpg');
    try {
      fs.mkdirSync(eventDir(id), { recursive: true });
      const tmp = path.join(eventDir(id), `thumb.${process.pid}.tmp`);
      fs.copyFileSync(src, tmp); fs.renameSync(tmp, path.join(eventDir(id), 'thumb.jpg'));
      return true;
    } catch { return false; }
  }

  let retentionSoon = null;
  function scheduleRetention(delay = 5000) {
    if (!timers || retentionSoon) return;
    retentionSoon = setTimeout(() => { retentionSoon = null; retentionNow(); }, delay);
    retentionSoon.unref?.();
  }

  function applyActions(camera, st, actions) {
    const s = settings();
    for (const a of actions) {
      if (a.type === 'open') {
        const id = `${camera}-${a.startMs}`;
        const win = clipWindow({ startMs: a.startMs, endMs: null }, s.recording.preRollSeconds, s.recording.postRollSeconds);
        if (!store.getEvent(id)) store.insertEvent({ id, camera, startMs: a.startMs, endMs: null, clipFromMs: win.from, clipToMs: null, peak: a.peak, frames: 1, zones: [], createdMs: now() });
        st.eventId = id;
        copyThumb(camera, id); st.lastThumbAt = a.peakAt;
        emit('event', { type: 'opened', event: toEvent(store.getEvent(id)) });
      } else if (a.type === 'peak' && st.eventId) {
        if (a.peakAt - st.lastThumbAt >= 1000 && copyThumb(camera, st.eventId)) st.lastThumbAt = a.peakAt;
      } else if (a.type === 'close' && st.eventId) {
        const win = clipWindow({ startMs: a.startMs, endMs: a.endMs }, s.recording.preRollSeconds, s.recording.postRollSeconds);
        store.updateEventProgress(st.eventId, { endMs: a.endMs, clipToMs: win.to, peak: a.peak, frames: a.frames, zones: a.zones });
        emit('event', { type: 'closed', event: toEvent(store.getEvent(st.eventId)) });
        st.eventId = null;
        scheduleRetention();
      }
    }
    // keep the active event's progress current (peak/frames) without closing it
    if (st.eventId && st.sm.current) {
      const c = st.sm.current;
      store.updateEventProgress(st.eventId, { endMs: null, clipToMs: null, peak: c.peak, frames: c.frames, zones: c.zones });
    }
  }

  function onFrame({ camera, frame, width, height, t }) {
    const s = settings();
    const cam = cameraOf(camera);
    if (!s.motion.enabled || cam?.motion?.enabled === false || modeOf(cam) === 'off') {
      const st = cams.get(camera);
      if (st) { applyActions(camera, st, st.sm.flush()); st.det.reset(); }
      return null;
    }
    const st = camState(camera, width, height, cam);
    const r = st.det.feed(frame, t);
    const actions = st.sm.step(t, r);
    if (actions.length || st.eventId) applyActions(camera, st, actions);
    if (r.motion && t - st.lastMotionEmit >= 500) { st.lastMotionEmit = t; emit('motion', { camera, score: Math.round(r.score * 1000) / 1000 }); }
    return r;
  }

  /** Camera stopped: close its open event. */
  function stopCamera(camera) {
    const st = cams.get(camera);
    if (st) { applyActions(camera, st, st.sm.flush()); cams.delete(camera); }
  }

  // ---------- ring trimmer (motion mode) ----------
  function trim() {
    const s = settings();
    const ringMs = Math.max(s.recording.ringSeconds, s.recording.preRollSeconds + 2 * s.recording.segmentSeconds) * 1000;
    let removed = 0;
    for (const camera of store.segmentCameras()) {
      if (modeOf(cameraOf(camera)) !== 'motion') continue;
      const cutoff = now() - ringMs;
      const wins = store.eventsBetween(camera, -Infinity, Infinity).map((e) => [e.clipFromMs, e.clipToMs ?? Infinity]);
      for (const seg of store.segmentsBefore(camera, cutoff)) {
        if (seg.startMs + seg.durMs > cutoff) continue;
        if (wins.some(([a, b]) => seg.startMs < b && seg.startMs + seg.durMs > a)) continue;
        safeRemove(dataDir, seg.path, log);
        if (!fs.existsSync(path.join(dataDir, seg.path))) { store.deleteSegment(seg.id); pruneEmptyDirs(dataDir, seg.path, log); removed++; }
      }
    }
    return removed;
  }

  // ---------- retention ----------
  let lastRetention = null;
  function retentionNow() {
    try {
      lastRetention = runRetention({ store, settings: settings(), now: now(), log });
      const d = lastRetention.deleted;
      if (d.segments || d.events || d.caches) log(`home-security retention: deleted ${d.segments} segments, ${d.events} events, ${d.caches} clip caches, ${d.bytes} bytes`);
      return lastRetention;
    } catch (e) { log(`home-security retention failed: ${e.message}`); throw e; }
  }

  // ---------- startup reconciliation (§5) ----------
  function reconcile() {
    // index rows whose file is gone (last 48 h — older ones are dropped by retention when it finds them missing)
    let dropped = 0;
    for (const seg of store.segments(null, now() - 48 * HOUR, now() + HOUR)) {
      if (!fs.existsSync(path.join(dataDir, seg.path))) { store.deleteSegment(seg.id); dropped++; }
    }
    // events left open by a crash: close them at the last segment we have (bounded by maxEventSeconds)
    const s = settings();
    for (const e of store.openEvents()) {
      const last = store.lastSegments(e.camera, 1)[0];
      const endMs = Math.max(e.startMs, Math.min(last ? last.startMs + last.durMs : e.startMs, e.startMs + s.motion.maxEventSeconds * 1000));
      const win = clipWindow({ startMs: e.startMs, endMs }, s.recording.preRollSeconds, s.recording.postRollSeconds);
      store.updateEventProgress(e.id, { endMs, clipToMs: win.to, peak: e.peak, frames: e.frames, zones: e.zones });
    }
    return dropped;
  }
  reconcile();

  // ---------- views ----------
  const camName = (id) => cameraOf(id)?.name || id;
  function toEvent(e, self = { node, base: './' }) {
    if (!e) return null;
    return {
      id: e.id, camera: e.camera, cameraName: camName(e.camera), node: self.node, base: self.base,
      start: e.startMs, end: e.endMs, clipFrom: e.clipFromMs, clipTo: e.clipToMs, peak: Math.round(e.peak * 1000) / 1000,
      zones: e.zones, locked: e.locked, reviewed: e.reviewed, note: e.note,
      thumb: `api/events/${e.id}/thumb.jpg`, clip: `api/events/${e.id}/clip.m3u8`, download: `api/events/${e.id}/clip.mp4`,
    };
  }
  const knownCameras = () => {
    const ids = new Set(camerasList().filter((c) => c.enabled).map((c) => c.id));
    for (const c of store.segmentCameras()) ids.add(c);
    return [...ids].sort();
  };

  function timelineLocal(from, to, self) {
    const segs = store.segments(null, from, to);
    const byCam = new Map(knownCameras().map((c) => [c, []]));
    for (const s of segs) { if (!byCam.has(s.camera)) byCam.set(s.camera, []); byCam.get(s.camera).push(s); }
    const evs = store.eventsBetween(null, from, to);
    return [...byCam].map(([camera, list]) => ({
      camera, name: camName(camera), node: self.node, base: self.base,
      spans: mergeSpans(list, from, to),
      events: evs.filter((e) => e.camera === camera).map((e) => ({ id: e.id, start: e.startMs, end: e.endMs, peak: Math.round(e.peak * 1000) / 1000 })),
    }));
  }

  function timelineAtLocal(t, self) {
    return knownCameras().map((camera) => {
      const seg = store.segmentAt(camera, t);
      const next = seg ? null : store.nextSegment(camera, t);
      return {
        camera, name: camName(camera), node: self.node, base: self.base,
        segment: seg ? { url: `api/cameras/${encodeURIComponent(camera)}/seg/${seg.startMs}.ts`, start: seg.startMs, dur: seg.durMs } : null,
        offsetMs: seg ? t - seg.startMs : 0, gap: !seg, nextStart: next ? next.startMs : null,
      };
    });
  }

  function buildClip(e) {
    const segs = store.segments(e.camera, e.clipFromMs, e.clipToMs ?? now());
    if (!segs.length) return Promise.reject(Object.assign(new Error('no footage for this event'), { status: 404 }));
    const dir = eventDir(e.id);
    fs.mkdirSync(dir, { recursive: true });
    const list = path.join(dir, 'concat.txt');
    fs.writeFileSync(list, segs.map((s) => `file '${path.join(dataDir, s.path).replace(/'/g, "'\\''")}'`).join('\n') + '\n');
    const out = path.join(dir, 'clip.mp4');
    const tmp = path.join(dir, `clip.${process.pid}.tmp.mp4`);
    return new Promise((resolve, reject) => {
      const p = spawn(ffmpeg(), ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', '-an', '-movflags', '+faststart', tmp], { stdio: ['ignore', 'ignore', 'pipe'] });
      let err = '';
      p.stderr.on('data', (d) => { if (err.length < 4000) err += d; });
      p.on('error', (e) => reject(Object.assign(new Error(`ffmpeg: ${e.message}`), { status: 500 })));
      p.on('close', (code) => {
        try { fs.unlinkSync(list); } catch { /* gone */ }
        if (code !== 0) { try { fs.unlinkSync(tmp); } catch { /* none */ } return reject(Object.assign(new Error(`clip build failed: ${err.trim().split('\n').pop() || code}`), { status: 500 })); }
        // Cache only when the window is complete on disk; otherwise serve this build and rebuild next time.
        const complete = e.clipToMs !== null && segs[segs.length - 1].startMs + segs[segs.length - 1].durMs >= e.clipToMs - 1000;
        if (complete) { fs.renameSync(tmp, out); resolve({ file: out, cached: true }); } else resolve({ file: tmp, cached: false });
      });
    });
  }

  function thumbFromFootage(e) {
    const seg = store.segmentAt(e.camera, e.startMs) || store.segments(e.camera, e.startMs, (e.endMs ?? now()) + 1)[0];
    if (!seg) return Promise.resolve(false);
    fs.mkdirSync(eventDir(e.id), { recursive: true });
    const out = path.join(eventDir(e.id), 'thumb.jpg');
    const ss = Math.max(0, (e.startMs - seg.startMs) / 1000).toFixed(3);
    return new Promise((resolve) => {
      const p = spawn(ffmpeg(), ['-hide_banner', '-loglevel', 'error', '-y', '-ss', ss, '-i', path.join(dataDir, seg.path), '-frames:v', '1', '-vf', 'scale=640:-2', '-q:v', '5', out], { stdio: 'ignore' });
      p.on('error', () => resolve(false));
      p.on('close', (code) => resolve(code === 0 && fs.existsSync(out)));
    });
  }

  function sendFile(req, res, file, type, extraHeaders = {}) {
    let st; try { st = fs.statSync(file); } catch { return sendErr(res, 404, 'not found'); }
    res.writeHead(200, { 'content-type': type, 'content-length': st.size, 'cache-control': 'no-store', ...extraHeaders });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(file).pipe(res);
  }

  // ---------- mesh merge helpers ----------
  async function gather(ctx, url, localItems, key) {
    const self = { node: ctx?.self?.node ?? node, base: ctx?.self?.base ?? './' };
    const nodes = [{ node: self.node, base: self.base, online: true }];
    let items = localItems(self);
    if ((url.searchParams.get('scope') || 'mesh') === 'mesh' && typeof ctx?.fanout === 'function') {
      const q = new URLSearchParams(url.searchParams); q.set('scope', 'local');
      let peers = [];
      try { peers = await ctx.fanout(`${url.pathname.replace(/^\//, '')}?${q}`); } catch (e) { log(`home-security fan-out failed: ${e.message}`); }
      for (const p of peers || []) {
        nodes.push({ node: p.node, base: p.base ?? null, online: !!p.online, ...(p.version ? { version: p.version } : {}), ...(p.error ? { error: p.error } : {}) });
        if (p.online && Array.isArray(p.body?.[key])) items = items.concat(p.body[key].map((it) => ({ ...it, node: it.node ?? p.node, base: p.base ?? null })));
      }
    }
    return { nodes, items, self };
  }

  // ---------- routes ----------
  async function handle(req, res, urlIn, ctx = {}) {
    const url = urlIn instanceof URL ? urlIn : new URL(urlIn || req.url, 'http://x');
    let p;
    try { p = decodeURIComponent(url.pathname); } catch { return false; }
    const m = req.method;
    const self = { node: ctx?.self?.node ?? node, base: ctx?.self?.base ?? './' };
    try {
      if (p === '/api/timeline' && m === 'GET') {
        const from = num(url.searchParams.get('from')); const to = num(url.searchParams.get('to'));
        if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) return sendErr(res, 400, 'from and to (epoch ms, from < to) are required'), true;
        if (to - from > MAX_TIMELINE_MS) return sendErr(res, 400, 'range is limited to 7 days'), true;
        const { nodes, items } = await gather(ctx, url, (s) => timelineLocal(from, to, s), 'cameras');
        return sendJson(res, 200, { from, to, nodes, cameras: items }), true;
      }
      if (p === '/api/timeline/at' && m === 'GET') {
        const t = num(url.searchParams.get('t'));
        if (!Number.isFinite(t)) return sendErr(res, 400, 't (epoch ms) is required'), true;
        const { nodes, items } = await gather(ctx, url, (s) => timelineAtLocal(t, s), 'cameras');
        return sendJson(res, 200, { t, nodes, cameras: items }), true;
      }
      let mm;
      if ((mm = /^\/api\/cameras\/([^/]+)\/vod\.m3u8$/.exec(p)) && (m === 'GET' || m === 'HEAD')) {
        const camera = mm[1];
        const from = num(url.searchParams.get('from')); const to = num(url.searchParams.get('to'));
        if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) return sendErr(res, 400, 'from and to (epoch ms, from < to) are required'), true;
        if (to - from > MAX_VOD_MS) return sendErr(res, 400, 'range is limited to 6 hours'), true;
        const segs = store.segments(camera, from, to);
        if (!segs.length) return sendErr(res, 404, 'no footage in this range'), true;
        res.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl', 'cache-control': 'no-store' });
        res.end(m === 'HEAD' ? undefined : vodPlaylist(segs, (s) => `seg/${s.startMs}.ts`));
        return true;
      }
      if (p === '/api/events' && m === 'GET') {
        const sp = url.searchParams;
        const limit = Math.min(200, Math.max(1, num(sp.get('limit')) || 50));
        const filters = {
          camera: sp.get('camera') || undefined, from: num(sp.get('from')), to: num(sp.get('to')),
          reviewed: boolQ(sp.get('reviewed')), locked: boolQ(sp.get('locked')), before: num(sp.get('before')), limit,
        };
        const nodeFilter = sp.get('node');
        const local = (s) => (nodeFilter && s.node && nodeFilter !== s.node ? [] : store.listEvents(filters).map((e) => toEvent(e, s)));
        const { nodes, items } = await gather(ctx, url, local, 'events');
        const events = items.filter((e) => !nodeFilter || e.node === nodeFilter).sort((a, b) => b.start - a.start).slice(0, limit);
        return sendJson(res, 200, { nodes, events, next: events.length === limit ? events[events.length - 1].start : null }), true;
      }
      if ((mm = /^\/api\/events\/([^/]+)(?:\/(thumb\.jpg|clip\.m3u8|clip\.mp4))?$/.exec(p))) {
        const [, id, sub] = mm;
        if (!ID_RE.test(id)) return sendErr(res, 400, 'bad event id'), true;
        const e = store.getEvent(id);
        if (!e) return sendErr(res, 404, 'no such event'), true;
        if (!sub && m === 'GET') return sendJson(res, 200, toEvent(e, self)), true;
        if (!sub && m === 'PATCH') {
          const body = await readBody(req);
          const patch = {};
          for (const k of ['locked', 'reviewed']) if (k in body) { if (typeof body[k] !== 'boolean') return sendErr(res, 400, `${k} must be true or false`), true; patch[k] = body[k]; }
          if ('note' in body) { if (body.note !== null && typeof body.note !== 'string') return sendErr(res, 400, 'note must be a string'), true; patch.note = body.note; }
          return sendJson(res, 200, toEvent(store.patchEvent(id, patch), self)), true;
        }
        if (!sub && m === 'DELETE') {
          for (const st of cams.values()) if (st.eventId === id) st.eventId = null;
          safeRemove(dataDir, `events/${id}`, log);
          store.deleteEvent(id);
          res.writeHead(204); res.end();
          return true;
        }
        if (sub === 'thumb.jpg' && (m === 'GET' || m === 'HEAD')) {
          const file = path.join(eventDir(id), 'thumb.jpg');
          if (!fs.existsSync(file)) await thumbFromFootage(e);
          return sendFile(req, res, file, 'image/jpeg'), true;
        }
        if (sub === 'clip.m3u8' && (m === 'GET' || m === 'HEAD')) {
          const segs = store.segments(e.camera, e.clipFromMs, e.clipToMs ?? now());
          if (!segs.length) return sendErr(res, 404, 'no footage for this event'), true;
          res.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl', 'cache-control': 'no-store' });
          // playlist is at api/events/<id>/clip.m3u8 → segments at api/cameras/<cam>/seg/<start>.ts
          res.end(m === 'HEAD' ? undefined : vodPlaylist(segs, (s) => `../../cameras/${encodeURIComponent(e.camera)}/seg/${s.startMs}.ts`));
          return true;
        }
        if (sub === 'clip.mp4' && (m === 'GET' || m === 'HEAD')) {
          let file = path.join(eventDir(id), 'clip.mp4'); let temp = false;
          if (!fs.existsSync(file)) { const r = await buildClip(e); file = r.file; temp = !r.cached; }
          sendFile(req, res, file, 'video/mp4', { 'content-disposition': `attachment; filename="${id}.mp4"` });
          if (temp) res.on('close', () => { try { fs.unlinkSync(file); } catch { /* gone */ } });
          return true;
        }
        return sendErr(res, 405, 'method not allowed'), true;
      }
      if (p === '/api/settings') {
        if (m === 'GET') return sendJson(res, 200, settings()), true;
        if (m === 'PATCH') {
          const r = store.patchSettings(await readBody(req));
          if (!r.ok) return sendErr(res, 400, r.errors[0] || 'invalid settings', { errors: r.errors }), true;
          restartTimers();
          try { await ctx?.onSettingsChanged?.(r.settings, r.previous); } catch (e) { log(`onSettingsChanged: ${e.message}`); }
          return sendJson(res, 200, r.settings), true;
        }
        return sendErr(res, 405, 'method not allowed'), true;
      }
      if (p === '/api/storage' && m === 'GET') return sendJson(res, 200, storageReport(store, settings())), true;
      if (p === '/api/storage/retention/run' && m === 'POST') {
        const r = retentionNow();
        return sendJson(res, 200, { before: r.before, after: r.after, deleted: r.deleted }), true;
      }
    } catch (e) {
      if (!res.headersSent) sendErr(res, e.status || 500, e.message);
      else res.destroy();
      return true;
    }
    return false;
  }

  // ---------- timers ----------
  let retentionTimer = null; let trimTimer = null;
  function restartTimers() {
    if (!timers) return;
    clearInterval(retentionTimer); clearInterval(trimTimer);
    retentionTimer = setInterval(() => { try { retentionNow(); } catch { /* logged */ } }, settings().retention.intervalMinutes * 60_000);
    trimTimer = setInterval(() => { try { trim(); } catch (e) { log(`home-security trim failed: ${e.message}`); } }, Math.max(2000, settings().recording.segmentSeconds * 2000));
    retentionTimer.unref?.(); trimTimer.unref?.();
  }
  restartTimers();
  if (timers) { const t = setTimeout(() => { try { retentionNow(); } catch { /* logged */ } }, 10_000); t.unref?.(); }

  return {
    store, dataDir, onSegment, onFrame, stopCamera, liveSegments, segmentPath, handle, trim, reconcile,
    runRetention: retentionNow, storage: () => storageReport(store, settings()), lastRetention: () => lastRetention,
    settings, toEvent,
    close() {
      clearInterval(retentionTimer); clearInterval(trimTimer); clearTimeout(retentionSoon);
      for (const camera of [...cams.keys()]) stopCamera(camera);
      store.close();
    },
  };
}
