#!/usr/bin/env node
// Krea Studio applet server: serves the studio UI (public/) with relative URLs only, because the App
// Cloud reaches it under /api/nodes/<node>/apps/krea/, plus
//   GET  healthz               {ok:true}
//   api/comfy/*                → the RIGS daemon's ComfyUI connector (/api/local/comfyui/*, src/comfyui.js), or
//                                /api/nodes/<node>/comfyui/* when the studio is pointed at another machine
//   POST api/generate          queue a job there; finished non-realtime results go into the gallery on their own
//   api/gallery…               the history gallery on this machine: list, keep a realtime result, image, delete
//   GET/POST api/settings      which machine's ComfyUI connector to use ({ node: '' } = this one)
//   GET  api/nodes             mesh machines running RIGS, for that choice
// The ComfyUI URL and auth header live in the daemon's config (per machine) and never pass through here.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HOME, log, readJsonSync } from '../../src/util.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const PUBLIC_DIR = path.join(HERE, 'public');
export const DEFAULTS = { port: 8732, host: '127.0.0.1', rigsUrl: '', dataDir: '', galleryMax: 300 };
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json' };
const TERMINAL = new Set(['done', 'error', 'cancelled']);

/** Settings from env (KREA_*), then ~/.rigs/config.json → kreaStudio, then defaults. */
export function loadKreaConfig({ env = process.env, configFile } = {}) {
  const rigsHome = env.RIGS_HOME ? path.resolve(env.RIGS_HOME) : path.join(HOME, '.rigs');
  const rigsCfg = readJsonSync(configFile || path.join(rigsHome, 'config.json'), {}) || {};
  const own = rigsCfg.kreaStudio && typeof rigsCfg.kreaStudio === 'object' ? rigsCfg.kreaStudio : {};
  const cfg = { ...DEFAULTS, ...own };
  const warnings = [];
  if (env.KREA_PORT) cfg.port = Number(env.KREA_PORT);
  if (env.KREA_HOST) cfg.host = env.KREA_HOST;
  if (env.KREA_RIGS_URL) cfg.rigsUrl = env.KREA_RIGS_URL;
  if (env.KREA_DATA_DIR) cfg.dataDir = env.KREA_DATA_DIR;
  if (!Number.isInteger(cfg.port) || cfg.port < 1 || cfg.port > 65535) { warnings.push('port is invalid; using the default'); cfg.port = DEFAULTS.port; }
  if (!Number.isInteger(cfg.galleryMax) || cfg.galleryMax < 1) { warnings.push('galleryMax is invalid; using the default'); cfg.galleryMax = DEFAULTS.galleryMax; }
  // The daemon on this machine: loopback is authorized without a token (src/auth.js).
  const rigsPort = Number(env.RIGS_PORT) || Number(rigsCfg.port) || 4719;
  if (cfg.rigsUrl && !/^https?:\/\/[^\s]+$/i.test(cfg.rigsUrl)) { warnings.push('rigsUrl is not an http(s) URL; using this machine'); cfg.rigsUrl = ''; }
  cfg.rigsUrl = (cfg.rigsUrl || `http://127.0.0.1:${rigsPort}`).replace(/\/+$/, '');
  cfg.dataDir = path.resolve(cfg.dataDir || path.join(rigsHome, 'krea-studio'));
  return { cfg, warnings };
}

/** PNG/JPEG pixel size from the header bytes, or null. */
export function imageSize(buf) {
  if (buf.length > 24 && buf.readUInt32BE(0) === 0x89504e47) return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  if (buf.length > 4 && buf[0] === 0xff && buf[1] === 0xd8) {
    for (let i = 2; i + 9 < buf.length;) {
      if (buf[i] !== 0xff) return null;
      const m = buf[i + 1];
      if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return { width: buf.readUInt16BE(i + 7), height: buf.readUInt16BE(i + 5) };
      i += 2 + buf.readUInt16BE(i + 2);
    }
  }
  return null;
}

// ---------------------------------------------------------------- gallery

/** The history gallery: gallery.json (newest first) + images/<id>.<ext> under dir. */
export function createGallery({ dir, max = DEFAULTS.galleryMax, now = Date.now }) {
  const file = path.join(dir, 'gallery.json');
  const imgDir = path.join(dir, 'images');
  let items = null;
  const load = () => {
    if (items) return items;
    const raw = readJsonSync(file, []);
    items = Array.isArray(raw) ? raw.filter((x) => x && typeof x.id === 'string' && typeof x.file === 'string') : [];
    return items;
  };
  const persist = () => {
    fs.mkdirSync(dir, { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(items, null, 1));
    fs.renameSync(tmp, file);
  };
  const imagePath = (it) => path.join(imgDir, path.basename(it.file));
  return {
    list: () => load(),
    get: (id) => load().find((x) => x.id === id) || null,
    hasJob: (jobId) => load().some((x) => x.jobId === jobId),
    imagePath,
    add(meta, bytes, mime) {
      load();
      fs.mkdirSync(imgDir, { recursive: true });
      const ext = mime === 'image/jpeg' ? 'jpg' : mime === 'image/webp' ? 'webp' : 'png';
      const id = `g-${now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
      fs.writeFileSync(path.join(imgDir, `${id}.${ext}`), bytes);
      const it = { ...meta, id, file: `${id}.${ext}`, mime, ...(imageSize(bytes) || {}), createdAt: now() };
      items.unshift(it);
      for (const old of items.splice(max)) fs.rmSync(imagePath(old), { force: true });
      persist();
      return it;
    },
    remove(id) {
      load();
      const i = items.findIndex((x) => x.id === id);
      if (i < 0) return false;
      const [it] = items.splice(i, 1);
      fs.rmSync(imagePath(it), { force: true });
      persist();
      return true;
    },
  };
}

// ---------------------------------------------------------------- server

function send(res, status, body, headers = {}) {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
  res.writeHead(status, { 'content-length': buf.length, 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers });
  res.end(res.req.method === 'HEAD' ? undefined : buf);
}

async function readBody(req, limit = 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > limit) throw Object.assign(new Error('body too large'), { status: 413 });
    chunks.push(c);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  if (!text) return {};
  try { return JSON.parse(text); } catch { throw Object.assign(new Error('invalid JSON'), { status: 400 }); }
}

export function createKreaServer({ cfg = loadKreaConfig().cfg, fetchImpl = globalThis.fetch, publicDir = PUBLIC_DIR, watchMs = 1000, now = Date.now } = {}) {
  const root = path.resolve(publicDir);
  const gallery = createGallery({ dir: cfg.dataDir, max: cfg.galleryMax, now });
  const settingsFile = path.join(cfg.dataDir, 'settings.json');
  const watching = new Set();

  const settings = () => {
    const s = readJsonSync(settingsFile, {}) || {};
    return { node: typeof s.node === 'string' ? s.node : '' };
  };
  /** Daemon API base for the chosen machine ('' = this one). */
  const apiBase = (node) => (node ? `${cfg.rigsUrl}/api/nodes/${encodeURIComponent(node)}/` : `${cfg.rigsUrl}/api/local/`);
  const unreachable = (e) => Object.assign(new Error(`The RIGS daemon at ${cfg.rigsUrl} is not answering (${e.cause?.code || e.message}).`), { status: 502 });

  async function daemon(pathPart, { method = 'GET', json, node = settings().node } = {}) {
    try {
      return await fetchImpl(apiBase(node) + pathPart, { method, headers: json !== undefined ? { 'content-type': 'application/json' } : {}, body: json !== undefined ? JSON.stringify(json) : undefined, signal: AbortSignal.timeout(90000) });
    } catch (e) { throw unreachable(e); }
  }
  async function daemonJson(pathPart, opts) {
    const r = await daemon(pathPart, opts);
    const text = await r.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = { error: text.slice(0, 200) }; }
    if (!r.ok) throw Object.assign(new Error(data?.error || `HTTP ${r.status}`), { status: r.status });
    return data;
  }

  /** Copy a finished job's images into the gallery (once per job). */
  async function saveJob(job, node) {
    if (gallery.hasJob(job.id)) return gallery.list().filter((x) => x.jobId === job.id);
    const out = [];
    for (const o of job.outputs || []) {
      const ref = { filename: o.filename, subfolder: o.subfolder || '', type: o.type || 'output' };
      const r = await daemon(`comfyui/view?${new URLSearchParams(ref)}`, { node });
      if (!r.ok) throw Object.assign(new Error(`could not fetch ${o.filename} from ComfyUI (HTTP ${r.status})`), { status: 502 });
      const bytes = Buffer.from(await r.arrayBuffer());
      const p = job.params || {};
      out.push(gallery.add({
        jobId: job.id, kind: job.kind, node: node || '', prompt: p.prompt || '', style: p.style || 'none', preset: p.preset || null,
        presetLabel: p.presetLabel || null, seed: p.seed ?? null, params: p, elapsedMs: job.elapsedMs, source: ref,
      }, bytes, (r.headers.get('content-type') || 'image/png').split(';')[0]));
    }
    return out;
  }

  /** Follow a submitted job until it ends; save its images when it succeeds. */
  function watch(jobId, node, timeoutMs = 20 * 60 * 1000) {
    if (watching.has(jobId)) return;
    watching.add(jobId);
    const until = now() + timeoutMs;
    const tick = async () => {
      try {
        const j = await daemonJson(`comfyui/jobs/${encodeURIComponent(jobId)}`, { node });
        if (j.state === 'done') await saveJob(j, node);
        if (TERMINAL.has(j.state)) { watching.delete(jobId); return; }
      } catch (e) {
        if (e.status === 404) { watching.delete(jobId); return; }
        log('krea-studio: following job', jobId, e.message);
      }
      if (now() > until) { watching.delete(jobId); return; }
      setTimeout(tick, watchMs).unref?.();
    };
    setTimeout(tick, watchMs).unref?.();
  }

  /** Pass a request through to the daemon's comfyui/* (uploads keep their content type) and the answer back. */
  async function forward(req, res, rest, search) {
    const headers = {};
    if (req.headers['content-type']) headers['content-type'] = req.headers['content-type'];
    const hasBody = req.method !== 'GET' && req.method !== 'HEAD';
    let r;
    try {
      r = await fetchImpl(`${apiBase(settings().node)}comfyui/${rest}${search}`, { method: req.method, headers, body: hasBody ? req : undefined, duplex: hasBody ? 'half' : undefined, signal: AbortSignal.timeout(120000) });
    } catch (e) {
      return send(res, 502, { error: unreachable(e).message });
    }
    const h = { 'content-type': r.headers.get('content-type') || 'application/octet-stream' };
    if (r.headers.get('cache-control')) h['cache-control'] = r.headers.get('cache-control');
    return send(res, r.status, Buffer.from(await r.arrayBuffer()), h);
  }

  async function handle(req, res) {
    const url = new URL(req.url, 'http://local');
    const p = url.pathname;
    let mm;
    if (p === '/healthz') return send(res, 200, { ok: true });
    if ((mm = p.match(/^\/api\/comfy\/(.+)$/))) return forward(req, res, mm[1], url.search);
    if (p === '/api/settings' && req.method === 'GET') return send(res, 200, settings());
    if (p === '/api/settings' && req.method === 'POST') {
      const b = await readBody(req);
      const node = String(b.node ?? '').trim();
      if (node && !/^[\w.@-]{1,80}$/.test(node)) return send(res, 400, { error: 'node must be a machine name' });
      fs.mkdirSync(cfg.dataDir, { recursive: true });
      fs.writeFileSync(settingsFile, JSON.stringify({ node }, null, 1));
      return send(res, 200, settings());
    }
    if (p === '/api/nodes' && req.method === 'GET') {
      let list = [];
      try { list = await (await fetchImpl(`${cfg.rigsUrl}/api/nodes`, { signal: AbortSignal.timeout(10000) })).json(); } catch { /* daemon down: no choices */ }
      return send(res, 200, { nodes: (Array.isArray(list) ? list : []).map((n) => ({ name: n.name, self: !!n.self, online: n.online !== false, rigs: n.rigs !== false })) });
    }
    if (p === '/api/generate' && req.method === 'POST') {
      const b = await readBody(req, 2 * 1024 * 1024);
      const node = settings().node;
      const job = await daemonJson('comfyui/jobs', { method: 'POST', json: { kind: b.kind, params: b.params, graph: b.graph, lane: b.lane, label: b.label }, node });
      if (!b.realtime) watch(job.id, node);
      return send(res, 202, job);
    }
    if (p === '/api/gallery' && req.method === 'GET') return send(res, 200, { items: gallery.list() });
    if (p === '/api/gallery' && req.method === 'POST') {
      // Keep a finished job, e.g. a realtime result (those are not saved on their own).
      const b = await readBody(req);
      if (!/^[\w-]{1,80}$/.test(String(b.jobId || ''))) return send(res, 400, { error: 'jobId required' });
      const node = settings().node;
      const job = await daemonJson(`comfyui/jobs/${encodeURIComponent(b.jobId)}`, { node });
      if (job.state !== 'done') return send(res, 409, { error: `that job is ${job.state}, not finished` });
      return send(res, 200, { items: await saveJob(job, node) });
    }
    if ((mm = p.match(/^\/api\/gallery\/([\w-]+)\/image$/)) && (req.method === 'GET' || req.method === 'HEAD')) {
      const it = gallery.get(mm[1]);
      if (!it) return send(res, 404, { error: 'not in the gallery' });
      let buf;
      try { buf = fs.readFileSync(gallery.imagePath(it)); } catch { return send(res, 404, { error: 'image file missing' }); }
      const h = { 'content-type': it.mime || 'image/png', 'cache-control': 'private, max-age=31536000, immutable' };
      if (url.searchParams.get('download') === '1') h['content-disposition'] = `attachment; filename="krea-${it.kind}-${it.seed ?? it.id}${path.extname(it.file)}"`;
      return send(res, 200, buf, h);
    }
    if ((mm = p.match(/^\/api\/gallery\/([\w-]+)$/)) && req.method === 'DELETE') {
      return gallery.remove(mm[1]) ? send(res, 200, { ok: true }) : send(res, 404, { error: 'not in the gallery' });
    }
    if (p.startsWith('/api/')) return send(res, 404, { error: 'not found' });
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, { error: 'method not allowed' });
    // Static files. Only public/ is served; anything resolving outside it is a 404.
    let rel;
    try { rel = decodeURIComponent(p); } catch { return send(res, 400, { error: 'bad path' }); }
    if (rel.endsWith('/')) rel += 'index.html';
    const file = path.resolve(root, `.${rel}`);
    if (!file.startsWith(root + path.sep)) return send(res, 404, { error: 'not found' });
    fs.readFile(file, (err, buf) => {
      if (err) return send(res, 404, { error: 'not found' });
      const ext = path.extname(file).toLowerCase();
      send(res, 200, buf, { 'content-type': TYPES[ext] || 'application/octet-stream', 'cache-control': ext === '.html' ? 'no-cache' : 'max-age=60' });
    });
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch((e) => { try { send(res, e.status || 500, { error: String(e.message || e) }); } catch {} });
  });
  server.gallery = gallery;
  return server;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const { cfg, warnings } = loadKreaConfig();
  for (const w of warnings) log('krea-studio config:', w);
  const server = createKreaServer({ cfg });
  server.listen(cfg.port, cfg.host, () => log(`krea-studio applet on http://${cfg.host}:${server.address().port}/ (daemon ${cfg.rigsUrl})`));
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => server.close(() => process.exit(0)));
}
