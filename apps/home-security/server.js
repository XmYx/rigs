#!/usr/bin/env node
// Home Security App Cloud app (id home-security). Contract: docs/home-security.md.
// HTTP routing, mesh fan-out, discovery scheduling, ingest lifecycle and live preview (t2). Motion, recording index,
// timeline, events, settings and retention are recorder.js / store.js / retention.js (t3), wired in here.
// Plain Node, no dependencies. Env: PORT (default 8749), HOST (default 127.0.0.1 — only the RIGS proxy may reach it),
// HOME_SECURITY_DATA (default <RIGS_HOME or ~/.rigs>/home-security), RIGS_PORT (default 4719), FFMPEG / FFPROBE,
// HOME_SECURITY_TEST_CAMERA=1 (adds an ffmpeg testsrc camera, for development and integration tests).
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CAMERA_ID_RE, CameraRegistry, enumerateWebcams, fileStore, localSubnets, onvifCamera, onvifDiscover, onvifStreamUri,
  portProbe, probeCamera, publicCamera, redact, validateExtraCidrs,
} from './discovery.js';
import { IngestManager, ffprobe, findFfmpeg, livePlaylist, segmentRelPath } from './ingest.js';

export const APP_ID = 'home-security';
export const DEFAULT_PORT = 8749;
export const VERSION = '0.2.0';
const HERE = path.dirname(fileURLToPath(import.meta.url));
export const PUBLIC_DIR = path.join(HERE, 'public');
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.map': 'application/json',
};

// node:sqlite prints an ExperimentalWarning on first use; silence only that one (docs §5).
const origEmit = process.emitWarning;
process.emitWarning = function (warning, ...rest) {
  if (/SQLite/i.test(String(warning?.message ?? warning))) return;
  return origEmit.call(process, warning, ...rest);
};

export function dataDir(env = process.env) {
  return env.HOME_SECURITY_DATA || path.join(env.RIGS_HOME || path.join(os.homedir(), '.rigs'), APP_ID);
}

function sendJson(res, status, data) {
  if (res.headersSent) return;
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(data));
}
const sendErr = (res, status, error, extra = {}) => sendJson(res, status, { error: redact(error), ...extra });

function readBody(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > limit) { reject(Object.assign(new Error('body too large'), { status: 413 })); req.destroy(); } else chunks.push(c); });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { const j = JSON.parse(Buffer.concat(chunks).toString('utf8')); resolve(j && typeof j === 'object' && !Array.isArray(j) ? j : {}); }
      catch { reject(Object.assign(new Error('invalid JSON body'), { status: 400 })); }
    });
    req.on('error', reject);
  });
}

function sendFile(req, res, file, type) {
  let st; try { st = fs.statSync(file); } catch { return sendErr(res, 404, 'not found'); }
  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
  if (range && (range[1] || range[2])) {
    let start = range[1] ? Number(range[1]) : Math.max(0, st.size - Number(range[2]));
    let end = range[1] && range[2] ? Math.min(Number(range[2]), st.size - 1) : st.size - 1;
    if (start > end || start >= st.size) { res.writeHead(416, { 'content-range': `bytes */${st.size}` }); return res.end(); }
    res.writeHead(206, { 'content-type': type, 'content-length': end - start + 1, 'content-range': `bytes ${start}-${end}/${st.size}`, 'accept-ranges': 'bytes', 'cache-control': 'no-store' });
    if (req.method === 'HEAD') return res.end();
    return fs.createReadStream(file, { start, end }).pipe(res);
  }
  res.writeHead(200, { 'content-type': type, 'content-length': st.size, 'accept-ranges': 'bytes', 'cache-control': 'no-store' });
  if (req.method === 'HEAD') return res.end();
  fs.createReadStream(file).pipe(res);
}

async function tryImport(file) {
  if (!fs.existsSync(path.join(HERE, file))) return null;
  try { return await import(`./${file}`); } catch (e) { console.error(`home-security: ${file} failed to load: ${e.message}`); return null; }
}

const FALLBACK_SETTINGS = {
  version: 1,
  recording: { defaultMode: 'continuous', segmentSeconds: 2, preRollSeconds: 10, postRollSeconds: 10, ringSeconds: 60 },
  motion: { enabled: true, sensitivity: 50, minDurationMs: 500, maxEventSeconds: 600, fps: 5, width: 160 },
  retention: { maxGB: 50, maxDays: 14, eventMaxDays: 30, minFreeGB: 2, intervalMinutes: 5 },
  discovery: { onvif: true, intervalMinutes: 60, portProbe: false, ports: [554, 8554, 80, 8080], excludeCidrs: [], extraCidrs: [] },
  live: { hlsWindowSegments: 6, snapshotFps: 1 },
  ffmpeg: { path: '', hwaccel: 'auto' },
};

/**
 * The app. createApp() builds everything synchronously except the recorder (async, t3); `app.ready` resolves when it
 * is loaded. Background work (discovery, ingest, the recorder's retention/trim timers) starts only with
 * `createApp({ background: true })` + `app.start()` (the CLI entry), so tests can use the HTTP surface without
 * touching cameras or the network.
 */
export function createApp({ background = false, env = process.env, platform = process.platform, rigsPort = Number(env.RIGS_PORT) || 4719, fetchImpl = fetch } = {}) {
  const dir = dataDir(env);
  const app = { dir, recorder: null, store: null, started: false, sse: new Set() };
  let settingsCache = structuredClone(FALLBACK_SETTINGS);
  const settings = () => (app.recorder ? app.recorder.settings() : settingsCache);

  const ffmpeg = findFfmpeg(settingsCache, env);
  const registry = new CameraRegistry(fileStore(dir));
  const manager = new IngestManager({ dataDir: dir, registry, settings, ffmpeg, platform });
  app.registry = registry; app.manager = manager; app.ffmpeg = ffmpeg;

  // ── self + peers via the local daemon ──
  let selfName = null; let selfAt = 0;
  async function self() {
    if (selfName && Date.now() - selfAt < 300_000) return selfName;
    try {
      const r = await fetchImpl(`http://127.0.0.1:${rigsPort}/api/self`, { signal: AbortSignal.timeout(2000) });
      const j = await r.json();
      if (j?.name) { selfName = j.name; selfAt = Date.now(); return selfName; }
    } catch { /* daemon down */ }
    return selfName || os.hostname();
  }

  async function peers() {
    const me = await self();
    try {
      const r = await fetchImpl(`http://127.0.0.1:${rigsPort}/api/apps`, { signal: AbortSignal.timeout(3000) });
      const j = await r.json();
      const list = Array.isArray(j) ? j : j.apps || [];
      return [...new Set(list.filter((a) => a.id === APP_ID && a.node && a.node !== me).map((a) => a.node))];
    } catch { return []; }
  }

  const peerBase = (req, node) => (req.headers['x-forwarded-prefix'] ? `../../../${encodeURIComponent(node)}/apps/${APP_ID}/` : null);

  /** GET <pathWithQuery> on every peer instance through the daemon proxy (always scope=local). */
  function makeFanout(req) {
    return async (pathWithQuery) => {
      const u = new URL(pathWithQuery.replace(/^\//, ''), 'http://x/');
      u.searchParams.set('scope', 'local');
      const rel = `${u.pathname.replace(/^\//, '')}${u.search}`;
      return Promise.all((await peers()).map(async (node) => {
        const base = peerBase(req, node);
        try {
          const r = await fetchImpl(`http://127.0.0.1:${rigsPort}/api/nodes/${encodeURIComponent(node)}/apps/${APP_ID}/${rel}`, { signal: AbortSignal.timeout(3000) });
          if (!r.ok) return { node, base, online: false, error: `HTTP ${r.status}` };
          const body = await r.json();
          return { node, base, online: true, version: body?.version, body };
        } catch (e) { return { node, base, online: false, error: e.name === 'TimeoutError' ? 'timeout' : redact(e.message) }; }
      }));
    };
  }

  // ── SSE ──
  function broadcast(type, data) {
    const msg = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of app.sse) res.write(msg);
  }

  // ── cameras: public view + mesh merge ──
  function localCameras(node) {
    return registry.cameras.map((c) => ({ ...publicCamera(c, manager.runtime(c.id)), node, base: './' }));
  }

  function markShared(cameras) {
    const byFp = new Map();
    for (const c of cameras) if (c.fingerprint) (byFp.get(c.fingerprint) || byFp.set(c.fingerprint, []).get(c.fingerprint)).push(c);
    for (const c of cameras) {
      const group = c.fingerprint ? byFp.get(c.fingerprint) : [c];
      c.seenBy = [...new Set(group.map((g) => g.node))];
      const recorders = new Set(group.filter((g) => g.enabled).map((g) => g.node));
      c.warning = recorders.size > 1 ? `recorded by ${recorders.size} nodes` : null;
    }
    return cameras;
  }

  async function camerasResponse(req, url) {
    const me = await self();
    const nodes = [{ node: me, base: './', online: true, version: VERSION }];
    let cameras = localCameras(me);
    if ((url.searchParams.get('scope') || 'mesh') === 'mesh') {
      for (const p of await makeFanout(req)('api/cameras')) {
        nodes.push({ node: p.node, base: p.base, online: p.online, ...(p.version ? { version: p.version } : {}), ...(p.error ? { error: p.error } : {}) });
        if (p.online && Array.isArray(p.body?.cameras)) cameras = cameras.concat(p.body.cameras.map((c) => ({ ...c, node: p.node, base: p.base })));
      }
    }
    return { nodes, cameras: markShared(cameras) };
  }

  // ── discovery ──
  const disc = { running: false, startedAt: null, finishedAt: null, subnets: [], found: { webcam: 0, onvif: 0, rtsp: 0 }, errors: [] };
  app.discovery = disc;
  const onvifErrors = new Map();

  async function resolveOnvif(cam) {
    const creds = registry.credentials(cam.id);
    if (!cam.source?.onvif?.xaddr || !creds?.username) return false;
    try {
      const { url } = await onvifStreamUri(cam.source.onvif.xaddr, creds);
      cam.source = { ...cam.source, url };
      onvifErrors.delete(cam.id);
      registry.save();
      return true;
    } catch (e) {
      onvifErrors.set(cam.id, e.auth ? 'authentication failed — check the camera username and password' : `ONVIF: ${e.message}`);
      return false;
    }
  }

  async function scan({ webcams = true, onvif, portProbe: probe } = {}) {
    if (disc.running) return false;
    const s = settings();
    onvif = onvif ?? s.discovery.onvif;
    probe = probe ?? s.discovery.portProbe;
    Object.assign(disc, { running: true, startedAt: Date.now(), finishedAt: null, errors: [] });
    broadcast('discovery', disc);
    const found = []; const kinds = [];
    try {
      const subnets = localSubnets(os.networkInterfaces(), s);
      disc.subnets = subnets.map((x) => x.cidr);
      const jobs = [];
      if (webcams) {
        kinds.push('webcam');
        jobs.push(enumerateWebcams({ ffmpeg: ffmpeg.path, platform }).then((r) => {
          if (r.error) disc.errors.push(`webcams: ${r.error}`);
          disc.found.webcam = r.devices.length; found.push(...r.devices);
        }));
        if (env.HOME_SECURITY_TEST_CAMERA === '1') {
          found.push({ id: 'test-pattern', name: 'Test pattern (ffmpeg testsrc)', kind: 'test', source: { lavfi: 'testsrc2' }, fingerprint: `test:${os.hostname()}` });
          kinds.push('test');
        }
      }
      let onvifHosts = [];
      if (onvif && subnets.length) {
        kinds.push('onvif');
        jobs.push(onvifDiscover(subnets).then((r) => {
          disc.errors.push(...r.errors);
          const cams = r.matches.map((m) => onvifCamera(m, subnets));
          onvifHosts = cams.map((c) => c.source.host).filter(Boolean);
          disc.found.onvif = cams.length; found.push(...cams);
        }));
      }
      await Promise.all(jobs);
      if (probe && subnets.length) {
        kinds.push('rtsp', 'mjpeg');
        const hits = await portProbe(subnets, { ports: s.discovery.ports, skipHosts: onvifHosts });
        disc.found.rtsp = hits.length; found.push(...hits.map(probeCamera));
      }
      registry.applyScan(found, { kinds });
      for (const c of registry.cameras) if (c.kind === 'onvif' && !c.source?.url && registry.credentials(c.id)) await resolveOnvif(c);
      await manager.sync();
    } catch (e) {
      disc.errors.push(redact(e.message));
    } finally {
      disc.running = false; disc.finishedAt = Date.now();
      broadcast('discovery', disc);
    }
    return true;
  }
  app.scan = scan;

  let discoveryTimer = null;
  function scheduleDiscovery() {
    clearInterval(discoveryTimer);
    const m = settings().discovery.intervalMinutes;
    if (m > 0) { discoveryTimer = setInterval(() => scan().catch(() => {}), m * 60_000); discoveryTimer.unref?.(); }
  }

  // ── settings changes from recorder (PATCH api/settings) ──
  async function onSettingsChanged(next, prev) {
    const changed = (k) => JSON.stringify(next?.[k]) !== JSON.stringify(prev?.[k]);
    if (changed('discovery')) scheduleDiscovery();
    const restartAll = ['ffmpeg', 'live'].some(changed) || next.recording?.segmentSeconds !== prev.recording?.segmentSeconds
      || next.motion?.fps !== prev.motion?.fps || next.motion?.width !== prev.motion?.width;
    await manager.sync(restartAll ? [...manager.workers.keys()] : []);
  }

  // ── ingest events → recorder + SSE ──
  manager.on('segment', (s) => { try { app.recorder?.onSegment(s); } catch (e) { console.error(`home-security: index segment: ${e.message}`); } });
  manager.on('frame', (f) => { try { app.recorder?.onFrame(f); } catch (e) { console.error(`home-security: motion: ${e.message}`); } });
  manager.on('status', (s) => {
    broadcast('camera', s);
    if (s.status === 'idle' || s.status === 'error') try { app.recorder?.stopCamera?.(s.camera); } catch { /* ignore */ }
  });

  // ── storage numbers for healthz ──
  function storageNumbers() {
    let freeBytes = null;
    try { const st = fs.statfsSync(fs.existsSync(dir) ? dir : path.dirname(dir)); freeBytes = st.bavail * st.bsize; } catch { /* old node / no dir */ }
    let usedBytes = null;
    try { const r = app.recorder?.storage(); if (r) usedBytes = r.totalBytes ?? null; } catch { /* store busy */ }
    return { dataDir: dir, usedBytes, freeBytes, maxBytes: Math.round(settings().retention.maxGB * 1024 ** 3) };
  }

  async function health() {
    const cams = registry.cameras.map((c) => manager.runtime(c.id));
    return {
      ok: true, app: APP_ID, version: VERSION, node: await self(),
      ffmpeg: { found: ffmpeg.found, path: ffmpeg.path, version: ffmpeg.version, ffprobe: ffmpeg.ffprobe,
        ...(ffmpeg.found ? {} : { help: platform === 'darwin' ? 'brew install ffmpeg' : platform === 'win32' ? 'winget install Gyan.FFmpeg' : 'sudo apt install ffmpeg' }) },
      storage: storageNumbers(),
      cameras: { total: registry.cameras.length, enabled: registry.cameras.filter((c) => c.enabled).length,
        recording: cams.filter((c) => c.status === 'recording').length, failing: cams.filter((c) => c.status === 'error').length },
      recorder: !!app.recorder,
    };
  }

  // ── per-camera media ──
  const camDir = (id, ...p) => path.join(dir, ...p.map((x) => x.replace('{id}', id)));

  function liveMjpeg(req, res, id) {
    const file = camDir(id, 'live', '{id}', 'latest.jpg');
    const boundary = 'hsframe';
    res.writeHead(200, { 'content-type': `multipart/x-mixed-replace; boundary=${boundary}`, 'cache-control': 'no-store', connection: 'close' });
    let lastMtime = 0;
    const tick = () => {
      try {
        const st = fs.statSync(file);
        if (st.mtimeMs === lastMtime) return;
        lastMtime = st.mtimeMs;
        const jpg = fs.readFileSync(file);
        res.write(`--${boundary}\r\ncontent-type: image/jpeg\r\ncontent-length: ${jpg.length}\r\n\r\n`);
        res.write(jpg); res.write('\r\n');
      } catch { /* no frame yet */ }
    };
    tick();
    const t = setInterval(tick, Math.max(100, 1000 / (settings().live.snapshotFps || 1) / 2));
    req.on('close', () => clearInterval(t));
  }

  function segmentFile(id, startMs) {
    const ring = manager.rings.get(id)?.find(startMs);
    if (ring) return ring.abs;
    const fromIndex = app.recorder?.segmentPath(id, startMs);
    if (fromIndex) return fromIndex;
    return path.join(dir, ...segmentRelPath(id, startMs).split('/'));
  }

  async function purgeCamera(id) {
    const rec = app.recorder; const retention = await tryImport('retention.js');
    if (!rec || !retention?.safeRemove) return;
    const store = rec.store;
    for (const e of store.eventsBetween?.(id, -Infinity, Infinity) || []) { retention.safeRemove(dir, `events/${e.id}`); store.deleteEvent(e.id); }
    for (const s of store.segments(id, 0, Number.MAX_SAFE_INTEGER)) store.deleteSegment(s.id);
    retention.safeRemove(dir, `segments/${id}`);
  }

  async function cameraRoute(req, res, url, id, sub) {
    const m = req.method;
    const cam = registry.get(id);
    if (!cam) return sendErr(res, 404, 'camera not found');
    const view = async () => ({ ...publicCamera(cam, { ...manager.runtime(id), ...(onvifErrors.has(id) ? { error: onvifErrors.get(id) } : {}) }), node: await self(), base: './' });
    if (!sub) {
      if (m === 'GET') return sendJson(res, 200, await view());
      if (m === 'PATCH') {
        const body = await readBody(req);
        const { restart } = registry.patch(id, body);
        if (cam.kind === 'onvif' && (body.username !== undefined || body.password !== undefined) && body.url === undefined) await resolveOnvif(cam);
        await manager.sync(restart ? [id] : []);
        return sendJson(res, 200, await view());
      }
      if (m === 'DELETE') {
        registry.remove(id);
        await manager.sync();
        if (url.searchParams.get('purge') === '1') await purgeCamera(id);
        res.writeHead(204); return res.end();
      }
      return sendErr(res, 405, 'method not allowed');
    }
    if (sub === 'test' && m === 'POST') {
      if (cam.kind === 'webcam' || cam.kind === 'test') {
        const rt = manager.runtime(id);
        return sendJson(res, 200, { ok: !cam.missing && rt.status !== 'error', codec: null, width: cam.input?.width ?? null, height: cam.input?.height ?? null, fps: cam.input?.fps ?? null, ...(rt.error ? { error: rt.error } : {}) });
      }
      const urlWithCreds = registry.sourceUrl(id);
      if (!urlWithCreds) return sendJson(res, 200, { ok: false, error: cam.kind === 'onvif' ? 'needs credentials' : 'no stream URL' });
      const r = await ffprobe(ffmpeg.ffprobe, urlWithCreds);
      return sendJson(res, 200, r.ok ? r : { ok: false, error: redact(r.error) });
    }
    if (m !== 'GET' && m !== 'HEAD') return false;
    if (sub === 'live.m3u8') {
      const items = manager.rings.get(id)?.recent(settings().live.hlsWindowSegments || 6) || [];
      if (!items.length) return sendErr(res, 404, 'no live segments yet');
      res.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl', 'cache-control': 'no-store' });
      return res.end(m === 'HEAD' ? undefined : livePlaylist(items));
    }
    const seg = /^seg\/(\d{10,16})\.ts$/.exec(sub);
    if (seg) return sendFile(req, res, segmentFile(id, Number(seg[1])), 'video/mp2t');
    if (sub === 'snapshot.jpg') return sendFile(req, res, camDir(id, 'live', '{id}', 'latest.jpg'), 'image/jpeg');
    if (sub === 'live.mjpeg') return liveMjpeg(req, res, id);
    return false;
  }

  // ── router ──
  async function route(req, res) {
    let url, p;
    try { url = new URL(req.url, 'http://x'); p = decodeURIComponent(url.pathname); } catch { return sendErr(res, 404, 'not found'); }
    const m = req.method;
    if (p === '/healthz') return sendJson(res, 200, await health());
    if (p === '/api' || p.startsWith('/api/')) {
      await app.ready;
      if (p === '/api/status' && m === 'GET') return sendJson(res, 200, { ...(await health()), workers: manager.list(), discovery: disc });
      if (p === '/api/mesh' && m === 'GET') {
        const me = await self();
        const results = await makeFanout(req)('healthz');
        return sendJson(res, 200, { self: me, nodes: [{ node: me, base: './', online: true, version: VERSION },
          ...results.map((r) => ({ node: r.node, base: r.base, online: r.online, version: r.version ?? null, ...(r.error ? { error: r.error } : {}) }))] });
      }
      if (p === '/api/cameras') {
        if (m === 'GET') return sendJson(res, 200, await camerasResponse(req, url));
        if (m === 'POST') {
          const body = await readBody(req);
          let cam;
          try { cam = registry.addManual(body); } catch (e) { return sendErr(res, 400, e.message); }
          return sendJson(res, 201, { ...publicCamera(cam, manager.runtime(cam.id)), node: await self(), base: './' });
        }
        return sendErr(res, 405, 'method not allowed');
      }
      const cm = /^\/api\/cameras\/([^/]+)(?:\/(.+))?$/.exec(p);
      if (cm && CAMERA_ID_RE.test(cm[1]) && !['vod.m3u8'].includes(cm[2])) {
        const handled = await cameraRoute(req, res, url, cm[1], cm[2]);
        if (handled !== false) return;
      }
      if (p === '/api/discovery' && m === 'GET') return sendJson(res, 200, disc);
      if (p === '/api/discovery/scan' && m === 'POST') {
        const body = await readBody(req);
        if (disc.running) return sendJson(res, 409, { error: 'a scan is running', ...disc });
        if (body.extraCidrs !== undefined) { const v = validateExtraCidrs(body.extraCidrs); if (v.errors.length) return sendErr(res, 400, v.errors[0], { errors: v.errors }); }
        scan({ webcams: body.webcams !== false, onvif: body.onvif, portProbe: body.portProbe === true }).catch(() => {});
        return sendJson(res, 202, disc);
      }
      if (p === '/api/stream' && m === 'GET') {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive', 'x-accel-buffering': 'no' });
        res.write(`retry: 3000\n\nevent: hello\ndata: ${JSON.stringify({ node: await self(), version: VERSION })}\n\n`);
        app.sse.add(res);
        const ping = setInterval(() => res.write(': ping\n\n'), 25_000);
        req.on('close', () => { clearInterval(ping); app.sse.delete(res); });
        return;
      }
      if (app.recorder) {
        const me = await self();
        const handled = await app.recorder.handle(req, res, url, { self: { node: me, base: './' }, fanout: makeFanout(req), onSettingsChanged });
        if (handled) return;
        return sendErr(res, 404, 'not found');
      }
      return sendErr(res, 501, 'not available: the recorder module did not load', { contract: 'docs/home-security.md' });
    }
    if (m !== 'GET' && m !== 'HEAD') return sendErr(res, 405, 'method not allowed');
    if (p === '/') p = '/index.html';
    const file = path.join(PUBLIC_DIR, path.normalize(p));
    const type = TYPES[path.extname(file)];
    if (!type || !file.startsWith(PUBLIC_DIR + path.sep) || !fs.existsSync(file)) return sendErr(res, 404, 'not found');
    res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' });
    if (m === 'HEAD') return res.end();
    fs.createReadStream(file).pipe(res);
  }

  // ── recorder (t3), loaded async ──
  app.ready = (async () => {
    const mod = await tryImport('recorder.js');
    if (!mod?.createRecorder) return;
    try {
      app.recorder = await mod.createRecorder({
        dataDir: dir, node: await self(), ffmpegPath: ffmpeg.path || undefined, timers: background,
        getCamera: (id) => registry.get(id), getCameras: () => registry.cameras,
        emit: (type, data) => broadcast(type, data), log: (msg) => console.log(redact(msg)),
      });
      settingsCache = app.recorder.settings();
    } catch (e) { console.error(`home-security: recorder failed to start: ${redact(e.message)}`); }
  })();

  app.start = async () => {
    await app.ready;
    if (app.started) return;
    app.started = true;
    const killed = manager.killOrphans();
    if (killed) console.log(`home-security: killed ${killed} orphaned ffmpeg process(es)`);
    await manager.sync();
    scan().catch((e) => console.error(`home-security: discovery: ${redact(e.message)}`));
    scheduleDiscovery();
  };

  app.close = async () => {
    clearInterval(discoveryTimer);
    for (const res of app.sse) res.end();
    app.sse.clear();
    await manager.shutdown();
    try { app.recorder?.close(); } catch { /* ignore */ }
    app.recorder = null;
  };

  app.server = http.createServer((req, res) => {
    route(req, res).catch((e) => {
      if (!res.headersSent) sendErr(res, e.status || 500, e.message || 'internal error');
      else res.destroy();
    });
  });
  app.server.on('close', () => { app.close().catch(() => {}); });
  return app;
}

/** The HTTP server (tests use it without starting discovery or ingest). */
export function createServer(opts) {
  return createApp(opts).server;
}

/** healthz body without a running app (kept for compatibility). */
export function health() {
  return { ok: true, app: APP_ID, version: VERSION, node: os.hostname(), dataDir: dataDir() };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT) || DEFAULT_PORT;
  const host = process.env.HOST || '127.0.0.1';
  const app = createApp({ background: true });
  app.server.listen(port, host, () => {
    console.log(`${APP_ID} on http://${host}:${port}/ (data ${app.dir}, ffmpeg ${app.ffmpeg.found ? app.ffmpeg.path : 'NOT FOUND'})`);
    app.start().catch((e) => console.error(`home-security: start failed: ${redact(e.message)}`));
  });
  let stopping = false;
  for (const sig of ['SIGTERM', 'SIGINT']) {
    process.on(sig, () => {
      if (stopping) return; stopping = true;
      setTimeout(() => process.exit(0), 7000).unref();
      app.close().finally(() => app.server.close(() => process.exit(0)));
    });
  }
}
