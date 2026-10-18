#!/usr/bin/env node
// Live Video applet server: live video generation on a user-provided ComfyUI. Serves the UI (public/)
// with relative URLs only, because the App Cloud reaches it under /api/nodes/<node>/apps/live-video/, plus
//   GET healthz              {ok:true}
//   GET/PUT api/settings     ComfyUI URL + auth header/token (the token is never returned: set + length only)
//   GET api/status           connection (/system_stats), templates and what each lacks (/object_info)
//   GET api/live             the live loop's state; POST api/live/start · api/live/update · api/live/stop
//   GET api/events           server-sent events: state, progress, queued, clip, notice
//   GET api/view             a generated clip or frame, streamed from ComfyUI's /view (Range passed through)
//   POST api/image           a start image (raw image body) uploaded to ComfyUI for image-to-video
// ComfyUI is only ever reached from here, so its auth stays on this machine and it can live anywhere.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { HOME, log, readJsonSync } from '../../src/util.js';
import { createComfyClient } from './comfy.js';
import { createLive, LiveError } from './live.js';
import { createOverseer } from './overseer.js';
import { applyPatch, effectiveUrl, loadSettings, overseerApplies, publicSettings, saveSettings, settingsFile } from './settings.js';
import { checkTemplate, loadTemplates, templateInfo } from './workflows.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const PUBLIC_DIR = path.join(HERE, 'public');
export const DEFAULT_PORT = 8741;

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json', '.webm': 'video/webm' };
const IMAGE_TYPES = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' };

/** Port and host: LV_PORT / LV_HOST, then ~/.rigs/config.json → liveVideo, then 8741 on loopback. */
export function loadServerConfig({ env = process.env } = {}) {
  const rigsHome = env.RIGS_HOME ? path.resolve(env.RIGS_HOME) : path.join(HOME, '.rigs');
  const fromFile = readJsonSync(path.join(rigsHome, 'config.json'), {})?.liveVideo || {};
  const port = Number(env.LV_PORT || fromFile.port || DEFAULT_PORT);
  return {
    port: Number.isInteger(port) && port >= 0 && port < 65536 ? port : DEFAULT_PORT,
    host: String(env.LV_HOST || fromFile.host || '127.0.0.1'),
    dataDir: path.join(rigsHome, 'live-video'),
  };
}

/** ComfyUI found on this machine by src/capabilities.js (port 8188 or a declared capability), else null. */
async function detectComfy() {
  try {
    const { capabilities } = await import('../../src/capabilities.js');
    return (await capabilities())?.comfyui?.url || null;
  } catch { return null; }
}

function send(res, status, body, headers = {}) {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body));
  res.writeHead(status, { 'content-length': buf.length, 'content-type': 'application/json', 'cache-control': 'no-store', ...headers });
  res.end(res.req.method === 'HEAD' ? undefined : buf);
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let n = 0;
    req.on('data', (c) => {
      n += c.length;
      if (n > limit) { reject(new LiveError(`body larger than ${Math.round(limit / 1024)} KB`, 413)); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function readJsonBody(req) {
  const buf = await readBody(req, 64 * 1024);
  if (!buf.length) return {};
  try { return JSON.parse(buf.toString('utf8')); } catch { throw new LiveError('body must be JSON'); }
}

export function createLiveVideoServer({
  settingsPath = settingsFile(), dataDir = path.dirname(settingsPath), detect = detectComfy, fetchImpl, WebSocketImpl,
  publicDir = PUBLIC_DIR, templates = loadTemplates(), tickMs, overseerFactory = createOverseer,
} = {}) {
  let settings = loadSettings(settingsPath);
  let detected = null;
  let detectedAt = 0;
  let client = null;
  let clientKey = '';
  let info = { url: '', at: 0, data: null };
  const sse = new Set();
  const clipsFile = path.join(dataDir, 'clips.json');
  const root = path.resolve(publicDir);

  async function detectedUrl() {
    if (!detected || Date.now() - detectedAt > 60000) { detected = await detect().catch(() => null); detectedAt = Date.now(); }
    return detected;
  }
  const currentUrl = () => effectiveUrl(settings, detected).url;

  function getClient() {
    const url = currentUrl();
    const key = JSON.stringify([url, settings.authHeader, settings.authToken]);
    if (!client || key !== clientKey) {
      client = createComfyClient({ baseUrl: url, authHeader: settings.authHeader, authToken: settings.authToken, ...(fetchImpl && { fetchImpl }), ...(WebSocketImpl && { WebSocketImpl }) });
      clientKey = key;
    }
    return client;
  }

  async function getObjectInfo(force = false) {
    const c = getClient();
    if (!force && info.data && info.url === c.baseUrl && Date.now() - info.at < 60000) return info.data;
    const data = await c.objectInfo();
    info = { url: c.baseUrl, at: Date.now(), data };
    return data;
  }

  function emit(type, data) {
    const msg = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of sse) res.write(msg);
  }

  let clipsWrite = Promise.resolve();
  const live = createLive({
    templates, getClient, getObjectInfo, emit, log, tickMs,
    getModelOverrides: () => settings.models,
    getOverseer: () => (overseerApplies(settings, currentUrl()) ? overseerFor() : null),
    clips: readJsonSync(clipsFile, []) || [],
    // Atomic (temp file + rename): a crash or a reader mid-write never sees a truncated clips.json.
    onClips: (clips) => { clipsWrite = clipsWrite.then(() => fsp.mkdir(dataDir, { recursive: true }).then(() => fsp.writeFile(clipsFile + '.tmp', JSON.stringify(clips))).then(() => fsp.rename(clipsFile + '.tmp', clipsFile))).catch((e) => log('live-video: could not save clips:', e.message)); },
  });

  let overseer = null;
  let overseerKey = '';
  function overseerFor() {
    const key = settings.overseer.url + '|' + settings.overseer.client;
    if (!overseer || key !== overseerKey) { overseer = overseerFactory({ url: settings.overseer.url, client: settings.overseer.client, ...(fetchImpl && { fetchImpl }) }); overseerKey = key; }
    return overseer;
  }

  /** Connection + template checks. A ComfyUI that is down is reported, not thrown. */
  async function status(force) {
    await detectedUrl();
    const pub = publicSettings(settings, detected);
    const out = { settings: pub, connection: { ok: false, url: pub.comfyUrl }, templates: [], live: live.snapshot() };
    const list = [...templates.values()];
    if (!pub.comfyUrl) {
      out.connection.error = 'No ComfyUI URL set and none detected on this machine';
    } else {
      try {
        const stats = await getClient().systemStats();
        out.connection = {
          ok: true, url: pub.comfyUrl, version: stats?.system?.comfyui_version || null, os: stats?.system?.os || null,
          devices: (stats?.devices || []).map((d) => ({ name: d.name, type: d.type, vramTotal: d.vram_total, vramFree: d.vram_free })),
        };
        const oi = await getObjectInfo(force);
        out.templates = list.map((t) => ({ ...templateInfo(t), check: checkTemplate(t, oi, settings.models) }));
      } catch (e) {
        out.connection = { ok: false, url: pub.comfyUrl, error: e.message };
      }
    }
    if (!out.templates.length) out.templates = list.map((t) => ({ ...templateInfo(t), check: null }));
    return out;
  }

  async function proxyView(req, res, url) {
    const filename = url.searchParams.get('filename') || '';
    const subfolder = url.searchParams.get('subfolder') || '';
    const type = url.searchParams.get('type') || 'output';
    if (!filename || /[\\/]|\.\./.test(filename) || subfolder.includes('..') || !['output', 'temp', 'input'].includes(type)) return send(res, 400, { error: 'bad file reference' });
    const up = await getClient().view({ filename, subfolder, type }, { range: req.headers.range });
    const headers = { 'cache-control': 'private, max-age=3600' };
    for (const h of ['content-type', 'content-length', 'content-range', 'accept-ranges', 'last-modified', 'etag']) {
      const v = up.headers.get(h);
      if (v) headers[h] = v;
    }
    res.writeHead(up.status, headers);
    if (req.method === 'HEAD' || !up.body) { res.end(); return; }
    Readable.fromWeb(up.body).on('error', () => res.destroy()).pipe(res);
  }

  async function handle(req, res) {
    const url = new URL(req.url, 'http://local');
    const p = url.pathname;
    const m = req.method;
    if (p === '/healthz') return send(res, 200, { ok: true });
    if (p === '/api/settings') {
      if (m === 'GET') { await detectedUrl(); return send(res, 200, publicSettings(settings, detected)); }
      if (m !== 'PUT') return send(res, 405, { error: 'method not allowed' });
      const r = applyPatch(settings, await readJsonBody(req));
      if (r.error) return send(res, 400, { error: r.error });
      const before = JSON.stringify([settings.comfyUrl, settings.authHeader, settings.authToken]);
      await saveSettings(settingsPath, r.settings);
      settings = r.settings;
      if (before !== JSON.stringify([settings.comfyUrl, settings.authHeader, settings.authToken])) {
        info = { url: '', at: 0, data: null };
        if (live.session) await live.stop({ reason: 'settings changed' });
      }
      await detectedUrl();
      return send(res, 200, publicSettings(settings, detected));
    }
    if (p === '/api/status' && m === 'GET') return send(res, 200, await status(url.searchParams.get('refresh') === '1'));
    if (p === '/api/live' && m === 'GET') return send(res, 200, live.snapshot());
    if (p === '/api/busy' && m === 'GET') return send(res, 200, { busy: ['starting', 'running', 'stopping'].includes(live.snapshot().status) });
    if (p === '/api/live/start' && m === 'POST') {
      await detectedUrl();
      if (!currentUrl()) return send(res, 409, { error: 'Set the ComfyUI URL first' });
      const body = await readJsonBody(req);
      const { state } = await live.start(body);
      return send(res, 202, state);
    }
    if (p === '/api/live/update' && m === 'POST') return send(res, 200, live.update(await readJsonBody(req)));
    if (p === '/api/live/stop' && m === 'POST') {
      const r = await live.stop();
      return send(res, 200, r);
    }
    if (p === '/api/events' && m === 'GET') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive', 'x-accel-buffering': 'no' });
      res.write(`retry: 3000\nevent: state\ndata: ${JSON.stringify(live.snapshot())}\n\n`);
      sse.add(res);
      const ping = setInterval(() => res.write(': ping\n\n'), 15000);
      req.on('close', () => { clearInterval(ping); sse.delete(res); });
      return;
    }
    if (p === '/api/view' && (m === 'GET' || m === 'HEAD')) return proxyView(req, res, url);
    if (p === '/api/image' && m === 'POST') {
      const ext = IMAGE_TYPES[String(req.headers['content-type'] || '').split(';')[0].trim()];
      if (!ext) return send(res, 415, { error: 'send a PNG, JPEG or WebP image as the body' });
      const buf = await readBody(req, 20 * 1024 * 1024);
      if (!buf.length) return send(res, 400, { error: 'empty image' });
      const up = await getClient().uploadImage(buf, `live-video-start-${Date.now().toString(36)}.${ext}`, req.headers['content-type']);
      return send(res, 200, { name: up.subfolder ? `${up.subfolder}/${up.name}` : up.name });
    }
    if (m !== 'GET' && m !== 'HEAD') return send(res, 405, { error: 'method not allowed' });
    // Static files. Only public/ is served; anything resolving outside it is a 404.
    let rel;
    try { rel = decodeURIComponent(p); } catch { return send(res, 400, { error: 'bad path' }); }
    if (rel.endsWith('/')) rel += 'index.html';
    const file = path.resolve(root, '.' + rel);
    if (!file.startsWith(root + path.sep)) return send(res, 404, { error: 'not found' });
    fs.readFile(file, (err, buf) => {
      if (err) return send(res, 404, { error: 'not found' });
      const ext = path.extname(file).toLowerCase();
      send(res, 200, buf, { 'content-type': TYPES[ext] || 'application/octet-stream', 'cache-control': ext === '.html' ? 'no-cache' : 'max-age=300' });
    });
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch((e) => {
      const status = e instanceof LiveError ? e.status : e.status && e.status >= 400 ? 502 : 500;
      try { send(res, status, { error: String(e.message || e), ...(e.details && { details: e.details }) }); } catch {}
    });
  });
  server.live = live;
  server.on('close', () => { if (live.session) live.stop({ reason: 'shutdown' }).catch(() => {}); for (const r of sse) r.end(); });
  return server;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const cfg = loadServerConfig();
  const server = createLiveVideoServer({ settingsPath: path.join(cfg.dataDir, 'settings.json'), dataDir: cfg.dataDir });
  server.listen(cfg.port, cfg.host, () => log(`live-video applet on http://${cfg.host}:${server.address().port}/`));
  const shutdown = async () => {
    if (server.live.session) await server.live.stop({ reason: 'shutdown' }).catch(() => {});
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  };
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, shutdown);
}
