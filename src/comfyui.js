import crypto from 'node:crypto';
import WebSocket from 'ws';
import { config, saveConfig } from './config.js';
import {
  ASPECTS, BUILDERS, SIZES, STYLES, buildPresets, checkGraph, needsModel, nodeWeight, normalizeParams, parseModels,
} from './comfyui-workflows.js';
import { log } from './util.js';

/**
 * ComfyUI connector, shared by the Krea Studio applet, the live-video applet and anything else that
 * drives a user-provided ComfyUI. Served under /api/local/comfyui/* (so /api/nodes/<id>/comfyui/*
 * reaches the ComfyUI configured on any mesh machine).
 *
 * Settings, per machine, in ~/.rigs/config.json → "comfyui":
 *   { "url": "http://127.0.0.1:8188",           // the user's ComfyUI; '' = use the detected one (capabilities.js)
 *     "authHeader": "Authorization: Bearer …",   // optional, a SECRET: never returned, logged or put in errors
 *     "gpuOverseer": "auto",                     // 'auto' (local ComfyUI → http://127.0.0.1:8195 if it answers), 'off', or a URL
 *     "gpuNeedMb": 18000,                        // VRAM asked of the overseer before a job
 *     "timeoutSec": 900 }                        // a job that has not finished by then is cancelled and fails
 *
 * Jobs: POST comfyui/jobs builds a graph from a template (txt2img, img2img, upscale) or takes a raw API
 * graph, checks every model / node / choice against /object_info (re-fetched before refusing) — never
 * queue a graph naming a missing model: some ComfyUI installs start downloading it — takes a GPU-overseer
 * lease, queues it with POST /prompt and follows it over ComfyUI's /ws, with a /history poll as a
 * backstop so a lost socket or a restarted ComfyUI ends in a clear error, never a hang. A job in a
 * "lane" supersedes that lane's unfinished jobs: realtime mode never piles up prompts.
 */

export const DEFAULTS = Object.freeze({ url: '', authHeader: '', gpuOverseer: 'auto', gpuNeedMb: 18000, timeoutSec: 900 });
export const OVERSEER_URL = 'http://127.0.0.1:8195';
const OVERSEER_CLIENT = 'comfyui'; // the overseer's id for ComfyUI (gpu-overseer/clients.json)
const TERMINAL = new Set(['done', 'error', 'cancelled']);
const NOT_CONFIGURED = 'No ComfyUI is set up. Open Settings and enter your ComfyUI URL (for example http://127.0.0.1:8188).';

export class ComfyError extends Error {
  constructor(code, message, { status, details, nodeId, nodeType } = {}) {
    super(message);
    this.code = code;
    this.status = status || ({ not_configured: 409, bad_request: 400, missing_model: 422, missing_node: 422, bad_value: 422, node_errors: 422, not_found: 404 }[code] || 502);
    if (details) this.details = details;
    if (nodeId) this.nodeId = nodeId;
    if (nodeType) this.nodeType = nodeType;
  }
}

// ---------------------------------------------------------------- settings

/** ComfyUI base URL: http(s), no credentials, query or fragment; a path prefix is fine (reverse proxies). */
export function validateUrl(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return { url: '' };
  if (s.length > 500) return { error: 'URL is too long' };
  if (/\s/.test(s)) return { error: 'URL must not contain spaces' };
  let u;
  try { u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : `http://${s}`); } catch { return { error: 'not a valid URL (example: http://127.0.0.1:8188)' }; }
  if (!/^https?:$/.test(u.protocol)) return { error: 'URL must start with http:// or https://' };
  if (u.username || u.password) return { error: 'put credentials in the auth header field, not in the URL' };
  if (u.search || u.hash) return { error: 'URL must not have a ?query or #fragment' };
  return { url: `${u.origin}${u.pathname.replace(/\/+$/, '')}` };
}

const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

/** "Name: value" → { name, value }; a bare value ("Bearer abc") means "Authorization: <value>". null when empty. */
export function parseAuthHeader(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return null;
  if (/[\0-\x08\x0a-\x1f\x7f]/.test(s)) throw new ComfyError('bad_request', 'the auth header must be a single line');
  const m = /^([^:\s]+):\s*(.+)$/.exec(s);
  if (m && HEADER_NAME.test(m[1])) return { name: m[1], value: m[2].trim() };
  return { name: 'Authorization', value: s };
}

/**
 * Validate a settings change on top of the current settings. `authHeader` undefined keeps the stored
 * secret; '' or clearAuth removes it. Returns { value, errors }; errors never echo the secret.
 */
export function validateSettings(input = {}, prev = DEFAULTS) {
  const errors = [];
  const value = { ...DEFAULTS, ...prev };
  if (input.url !== undefined) {
    const r = validateUrl(input.url);
    if (r.error) errors.push(`url: ${r.error}`); else value.url = r.url;
  }
  if (input.clearAuth) value.authHeader = '';
  else if (input.authHeader !== undefined) {
    try {
      const h = parseAuthHeader(input.authHeader);
      if (h && h.value.length > 4096) errors.push('authHeader: too long');
      else value.authHeader = h ? `${h.name}: ${h.value}` : '';
    } catch (e) { errors.push(`authHeader: ${e.message}`); }
  }
  if (input.gpuOverseer !== undefined) {
    const g = String(input.gpuOverseer || 'auto').trim();
    if (g === 'auto' || g === 'off') value.gpuOverseer = g;
    else {
      const r = validateUrl(g);
      if (r.error || !r.url) errors.push(`gpuOverseer: 'auto', 'off' or a URL${r.error ? ` (${r.error})` : ''}`); else value.gpuOverseer = r.url;
    }
  }
  if (input.gpuNeedMb !== undefined) {
    const n = Number(input.gpuNeedMb);
    if (!Number.isInteger(n) || n < 0 || n > 512000) errors.push('gpuNeedMb: a whole number of MB, 0-512000'); else value.gpuNeedMb = n;
  }
  if (input.timeoutSec !== undefined) {
    const n = Number(input.timeoutSec);
    if (!Number.isFinite(n) || n < 10 || n > 7200) errors.push('timeoutSec: 10-7200 seconds'); else value.timeoutSec = Math.round(n);
  }
  return { value, errors };
}

/** Stored settings, validated; an invalid field falls back to its default (logged by name, never by value). */
export function loadSettings(cfg = config()) {
  const stored = cfg.comfyui && typeof cfg.comfyui === 'object' ? cfg.comfyui : {};
  const { value, errors } = validateSettings(stored, DEFAULTS);
  if (!errors.length) return value;
  log(`comfyui: ignoring invalid settings (${errors.map((e) => e.split(':')[0]).join(', ')})`);
  const ok = {};
  for (const k of Object.keys(stored)) if (!errors.some((e) => e.startsWith(`${k}:`))) ok[k] = stored[k];
  return validateSettings(ok, DEFAULTS).value;
}

export function saveSettings(input) {
  const cfg = config();
  const { value, errors } = validateSettings(input, loadSettings(cfg));
  if (errors.length) throw new ComfyError('bad_request', errors.join('; '), { details: errors });
  cfg.comfyui = value;
  saveConfig(cfg);
  return value;
}

/** Settings as the UI and peers may see them: the auth header only as "set" + its name. */
export function publicSettings(s) {
  let h = null;
  try { h = s.authHeader ? parseAuthHeader(s.authHeader) : null; } catch { /* stored value unreadable: report unset */ }
  return { url: s.url, auth: h ? { set: true, name: h.name } : { set: false }, gpuOverseer: s.gpuOverseer, gpuNeedMb: s.gpuNeedMb, timeoutSec: s.timeoutSec };
}

/** Strip secrets from a message before it can reach a log, an HTTP answer or the UI. */
export function redact(text, secrets = []) {
  let out = String(text ?? '');
  for (const s of secrets) if (s && s.length >= 4) out = out.split(s).join('•••');
  return out;
}

const authValue = (h) => { try { return parseAuthHeader(h)?.value || ''; } catch { return ''; } };
const isLoopbackHost = (h) => /^(localhost|127(\.\d+){3}|\[::1\]|::1)$/i.test(h);

// ---------------------------------------------------------------- HTTP / WS client

/**
 * Minimal ComfyUI client. Every request carries the auth header; every failure is a ComfyError whose
 * message names the URL and the cause, never the header's value.
 */
export function createClient({ url, authHeader = '', fetchImpl = globalThis.fetch, WebSocketImpl = WebSocket, timeoutMs = 15000 } = {}) {
  const v = validateUrl(url);
  if (v.error) throw new ComfyError('bad_request', `ComfyUI URL: ${v.error}`);
  if (!v.url) throw new ComfyError('not_configured', NOT_CONFIGURED);
  const base = v.url;
  const auth = parseAuthHeader(authHeader);
  const secrets = auth ? [auth.value] : [];
  const headers = (extra = {}) => ({ ...(auth ? { [auth.name]: auth.value } : {}), ...extra });
  const clean = (s) => redact(s, secrets);

  async function request(path, { method = 'GET', json, body, timeout = timeoutMs, raw = false } = {}) {
    let r;
    try {
      r = await fetchImpl(base + path, {
        method,
        headers: headers(json !== undefined ? { 'content-type': 'application/json' } : {}),
        body: json !== undefined ? JSON.stringify(json) : body,
        signal: AbortSignal.timeout(timeout),
      });
    } catch (e) {
      const why = e.name === 'TimeoutError' ? `no answer in ${Math.round(timeout / 1000)} s` : (e.cause?.code || e.cause?.message || e.message);
      throw new ComfyError('unreachable', clean(`Can't reach ComfyUI at ${base} (${why}). Check that it is running and that the URL is right.`));
    }
    if (r.status === 401 || r.status === 403) {
      throw new ComfyError('auth', `ComfyUI at ${base} refused the request (HTTP ${r.status}). ${auth ? 'Check the auth header in Settings.' : 'It needs an auth header: add one in Settings.'}`);
    }
    if (raw && r.ok) return r;
    const text = await r.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
    if (!r.ok) {
      if (data && (data.node_errors || data.error)) throw promptError(data);
      const short = text && text.length < 200 && !/<html/i.test(text) ? `: ${text.trim()}` : '';
      throw new ComfyError(r.status === 404 ? 'not_found' : r.status === 405 ? 'not_allowed' : 'http', clean(`ComfyUI at ${base} answered HTTP ${r.status} for ${path.split('?')[0]}${short}`), { status: r.status === 404 ? 404 : 502 });
    }
    if (data === null && text) throw new ComfyError('http', `${base} sent a non-JSON answer for ${path.split('?')[0]}. Is this a ComfyUI URL?`);
    return data;
  }

  return {
    base,
    secrets,
    systemStats: () => request('/system_stats'),
    objectInfo: () => request('/object_info', { timeout: 60000 }),
    queue: () => request('/queue'),
    history: (id) => request(`/history/${encodeURIComponent(id)}`),
    prompt: (graph, clientId) => request('/prompt', { method: 'POST', json: { prompt: graph, client_id: clientId } }),
    /** Cancel one prompt, queued or running: the jobs API on new ComfyUI, /queue delete + targeted /interrupt on older builds. */
    async cancel(promptId) {
      try {
        await request(`/api/jobs/${encodeURIComponent(promptId)}/cancel`, { method: 'POST', json: {} });
        return;
      } catch (e) { if (e.code !== 'not_found' && e.code !== 'not_allowed') throw e; }
      await request('/queue', { method: 'POST', json: { delete: [promptId] } }).catch(() => {});
      await request('/interrupt', { method: 'POST', json: { prompt_id: promptId } });
    },
    /** Upload an input image (bytes) → { name, subfolder, type }. */
    upload(bytes, filename, mime = 'image/png', subfolder = 'rigs-krea') {
      const form = new FormData();
      form.append('image', new Blob([bytes], { type: mime }), filename);
      form.append('type', 'input');
      form.append('subfolder', subfolder);
      form.append('overwrite', 'true');
      return request('/upload/image', { method: 'POST', body: form, timeout: 60000 });
    },
    /** An output/input/temp image as a fetch Response. */
    view: ({ filename, subfolder = '', type = 'output' }) => request(`/view?${new URLSearchParams({ filename, subfolder, type })}`, { raw: true, timeout: 60000 }),
    /** ComfyUI's event socket for one client id. */
    socket(clientId) {
      return new WebSocketImpl(`${base.replace(/^http/, 'ws')}/ws?clientId=${encodeURIComponent(clientId)}`, { headers: headers(), handshakeTimeout: 10000 });
    },
  };
}

/** ComfyUI's /prompt rejection ({ error, node_errors }) → one readable ComfyError. */
export function promptError(data) {
  const parts = [];
  let first = null;
  for (const [id, ne] of Object.entries(data?.node_errors || {})) {
    for (const er of ne.errors || []) {
      first = first || { nodeId: id, nodeType: ne.class_type };
      parts.push(`${ne.class_type || 'node'} (#${id}): ${er.message}${er.details ? ` — ${er.details}` : ''}`);
    }
  }
  const head = data?.error?.message || 'ComfyUI rejected the workflow';
  return new ComfyError('node_errors', parts.length ? `${head}: ${parts.join('; ')}` : `${head}${data?.error?.details ? ` — ${data.error.details}` : ''}`, { details: parts, ...(first || {}) });
}

/** The parts of /system_stats the settings panel shows. */
export function summarizeStats(stats) {
  const sys = stats?.system || {};
  return {
    version: sys.comfyui_version || null,
    python: sys.python_version ? String(sys.python_version).split(' ')[0] : null,
    pytorch: sys.pytorch_version || null,
    os: sys.os || null,
    devices: (stats?.devices || []).map((d) => ({ name: String(d.name || '').replace(/^cuda:\d+\s*/, '').replace(/\s*:\s*\w+$/, ''), type: d.type, vramTotal: d.vram_total, vramFree: d.vram_free })),
  };
}

/** A ComfyUI execution failure (execution_error event or a history status) → a message with a hint. */
export function executionMessage(e = {}) {
  const what = e.node_type ? `${e.node_type}${e.node_id ? ` (#${e.node_id})` : ''} failed` : 'ComfyUI failed';
  const msg = String(e.exception_message || e.message || 'unknown error').trim();
  let hint = '';
  if (/out of memory|OutOfMemory/i.test(msg)) hint = ' — the GPU ran out of memory: try a smaller size, or free the GPU.';
  else if (/No space left on device/i.test(msg)) hint = ' — the disk ComfyUI writes to is full.';
  else if (/not found|No such file/i.test(msg) && /Loader/.test(e.node_type || '')) hint = ' — a model file is missing on the ComfyUI machine.';
  return `${what}: ${msg}${hint}`;
}

// ---------------------------------------------------------------- GPU overseer

/**
 * Leases from the GPU overseer so a local ComfyUI job does not run into another app's VRAM: acquire
 * before queueing, release a while after the last job ends (a realtime burst keeps one lease). When
 * the overseer is unreachable there is no lease and the job just runs.
 */
export function createOverseer({ fetchImpl = globalThis.fetch, releaseDelayMs = 20000, now = Date.now } = {}) {
  const state = new Map(); // overseer url → { active, timer, grantedAt }
  const call = (url, path, body, timeout) => fetchImpl(`${url}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(timeout) })
    .then((r) => (r.ok ? r.json() : null));
  return {
    /** The overseer URL for these settings and this ComfyUI, or '' when none applies. */
    resolve(settings, comfyUrl) {
      if (settings.gpuOverseer === 'off') return '';
      if (settings.gpuOverseer && settings.gpuOverseer !== 'auto') return settings.gpuOverseer;
      try { return isLoopbackHost(new URL(comfyUrl).hostname) ? OVERSEER_URL : ''; } catch { return ''; }
    },
    async acquire(url, needMb, timeoutSec = 60) {
      const s = state.get(url) || { active: 0, timer: null, grantedAt: 0 };
      state.set(url, s);
      s.active++;
      if (s.timer) { clearTimeout(s.timer); s.timer = null; }
      if (s.grantedAt && now() - s.grantedAt < 60000) return { ok: true, reused: true };
      try {
        const r = await call(url, '/api/acquire', { client: OVERSEER_CLIENT, need_mb: needMb, timeout: timeoutSec }, (timeoutSec + 15) * 1000);
        if (r?.ok) s.grantedAt = now();
        return r ? { ok: !!r.ok, freeMb: r.free_mb, unloaded: r.unloaded || [] } : { ok: false, unavailable: true };
      } catch { return { ok: false, unavailable: true }; }
    },
    release(url) {
      const s = state.get(url);
      if (!s) return;
      s.active = Math.max(0, s.active - 1);
      if (s.active || s.timer) return;
      s.timer = setTimeout(() => {
        s.timer = null;
        if (s.active) return;
        s.grantedAt = 0;
        call(url, '/api/release', { client: OVERSEER_CLIENT }, 5000).catch(() => {});
      }, releaseDelayMs);
      s.timer.unref?.();
    },
  };
}

// ---------------------------------------------------------------- service (jobs)

const newId = () => `cj-${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`;

function stageFor(classType = '') {
  if (/Loader/.test(classType)) return 'Loading model';
  if (classType === 'CLIPTextEncode') return 'Reading the prompt';
  if (classType === 'KSampler') return 'Sampling';
  if (classType === 'VAEDecode') return 'Decoding';
  if (classType === 'VAEEncode') return 'Encoding the input';
  if (/Upscale|ImageScale/.test(classType)) return 'Upscaling';
  if (classType === 'SaveImage') return 'Saving';
  if (classType === 'LoadImage') return 'Loading the input';
  return classType || 'Working';
}

/**
 * The connector: settings and target resolution, a cached /object_info per target, and the jobs.
 * Everything with side effects is injectable for tests (getSettings, setSettings, suggest, fetchImpl,
 * WebSocketImpl, overseer, pollMs, now).
 */
export function createComfyService({
  getSettings = loadSettings, setSettings = saveSettings, suggest = async () => null,
  fetchImpl = globalThis.fetch, WebSocketImpl = WebSocket, overseer = createOverseer({ fetchImpl }),
  pollMs = 2500, infoTtlMs = 60000, keepJobs = 60, lostAfterMs = 10000, now = Date.now,
} = {}) {
  const jobs = new Map();
  const infoCache = new Map(); // target key → { at, info, models, presets }
  let sock = null; // { key, ws, clientId, open, ready }

  /** Where jobs go: the user's URL always wins; the detected ComfyUI is only a fallback. */
  async function target() {
    const s = getSettings();
    if (s.url) return { url: s.url, source: 'configured', settings: s };
    const d = await suggest().catch(() => null);
    if (d?.url) return { url: d.url, source: 'detected', settings: s };
    return { url: '', source: 'none', settings: s };
  }
  const keyOf = (url, authHeader) => `${url}\n${crypto.createHash('sha256').update(authHeader || '').digest('hex').slice(0, 12)}`;
  const clientFor = (url, authHeader) => createClient({ url, authHeader, fetchImpl, WebSocketImpl });
  async function targetClient() {
    const t = await target();
    if (!t.url) throw new ComfyError('not_configured', NOT_CONFIGURED);
    return { t, client: clientFor(t.url, t.settings.authHeader) };
  }

  async function info(client, authHeader, force = false) {
    const key = keyOf(client.base, authHeader);
    const hit = infoCache.get(key);
    if (!force && hit && now() - hit.at < infoTtlMs) return hit;
    const raw = await client.objectInfo();
    if (!raw || typeof raw !== 'object' || !Object.keys(raw).length) throw new ComfyError('http', `ComfyUI at ${client.base} sent an empty /object_info`);
    const models = parseModels(raw);
    const entry = { at: now(), info: raw, models, presets: buildPresets(models) };
    infoCache.set(key, entry);
    return entry;
  }

  // ------------------------------------------------ the event socket

  function ensureSocket(client, authHeader) {
    const key = keyOf(client.base, authHeader);
    if (sock && sock.key === key && sock.ws.readyState <= 1) return sock.ready;
    if (sock) try { sock.ws.terminate(); } catch {}
    const clientId = crypto.randomUUID();
    let ws;
    try { ws = client.socket(clientId); } catch (e) { log(`comfyui: event socket to ${client.base}: ${redact(e.message, client.secrets)}`); return Promise.resolve(null); }
    const s = { key, ws, clientId, open: false };
    s.ready = new Promise((resolve) => {
      const t = setTimeout(() => resolve(s), 5000);
      ws.on('open', () => { s.open = true; clearTimeout(t); resolve(s); });
      ws.on('error', (e) => { clearTimeout(t); log(`comfyui: event socket to ${client.base}: ${redact(e.message, client.secrets)}`); resolve(s); });
    });
    ws.on('close', () => { s.open = false; if (sock === s) sock = null; });
    ws.on('message', (data, isBinary) => { try { onSocketMessage(data, isBinary); } catch (e) { log('comfyui: unreadable event:', e.message); } });
    sock = s;
    return s.ready;
  }

  const byPrompt = (pid) => [...jobs.values()].find((j) => j.promptId === pid);
  const runningJob = () => [...jobs.values()].find((j) => j.state === 'running');

  function onSocketMessage(data, isBinary) {
    if (isBinary) return onPreview(Buffer.from(data));
    const msg = JSON.parse(String(data));
    const d = msg.data || {};
    if (msg.type === 'status') {
      const left = d.status?.exec_info?.queue_remaining;
      for (const q of jobs.values()) if (q.state === 'queued') q.queueRemaining = left;
      return;
    }
    const j = d.prompt_id ? byPrompt(d.prompt_id) : null;
    if (!j || TERMINAL.has(j.state)) return;
    j.lastEventAt = now();
    switch (msg.type) {
      case 'execution_start': setRunning(j); break;
      case 'execution_cached': setRunning(j); for (const id of d.nodes || []) j.doneNodes.add(String(id)); bump(j); break;
      case 'executing':
        setRunning(j);
        if (j.node && j.node !== String(d.node)) j.doneNodes.add(j.node);
        if (d.node === null || d.node === undefined) { j.node = null; finishFromHistory(j); break; }
        j.node = String(d.node);
        j.step = null;
        j.stage = stageFor(j.graph[j.node]?.class_type);
        bump(j);
        break;
      case 'progress': {
        setRunning(j);
        j.node = String(d.node ?? j.node);
        j.step = { value: Number(d.value) || 0, max: Number(d.max) || 0 };
        const ct = j.graph[j.node]?.class_type;
        j.stage = ct === 'KSampler' ? `Sampling ${j.step.value}/${j.step.max}` : `${stageFor(ct)}${j.step.max ? ` ${Math.round((j.step.value / j.step.max) * 100)}%` : ''}`;
        bump(j);
        break;
      }
      case 'executed': for (const im of d.output?.images || []) addOutput(j, im, String(d.node)); break;
      case 'execution_success': finishFromHistory(j); break;
      case 'execution_error':
        fail(j, new ComfyError('execution', executionMessage(d), { nodeId: d.node_id, nodeType: d.node_type, details: d.exception_type ? [d.exception_type] : undefined }));
        break;
      case 'execution_interrupted': end(j, 'cancelled', j.cancelReason || 'Interrupted in ComfyUI'); break;
      default: break;
    }
  }

  /** Sampling previews: type 1 = [format][image], type 4 = [meta length][meta JSON][image]. */
  function onPreview(buf) {
    if (buf.length < 8) return;
    const type = buf.readUInt32BE(0);
    let mime; let image; let pid = null;
    if (type === 1) { mime = buf.readUInt32BE(4) === 2 ? 'image/png' : 'image/jpeg'; image = buf.subarray(8); }
    else if (type === 4) {
      const n = buf.readUInt32BE(4);
      let meta = {};
      try { meta = JSON.parse(buf.subarray(8, 8 + n).toString('utf8')); } catch {}
      mime = meta.image_type || 'image/jpeg';
      image = buf.subarray(8 + n);
      pid = meta.prompt_id || null;
    } else return;
    const j = (pid && byPrompt(pid)) || runningJob();
    if (!j || TERMINAL.has(j.state) || !image.length) return;
    j.preview = { mime, bytes: Buffer.from(image) };
    j.previewSeq++;
  }

  // ------------------------------------------------ job state

  function setRunning(j) {
    if (j.state === 'queued' || j.state === 'preparing') { j.state = 'running'; j.startedAt = now(); j.stage = 'Starting'; j.queuePosition = null; }
  }

  /** Weighted progress 0..1: finished/cached nodes plus the fraction of the node that reports steps. */
  function bump(j) {
    const ids = Object.keys(j.graph);
    const total = ids.reduce((a, id) => a + nodeWeight(j.graph[id].class_type), 0) || 1;
    let done = 0;
    for (const id of ids) if (j.doneNodes.has(id)) done += nodeWeight(j.graph[id].class_type);
    if (j.node && !j.doneNodes.has(j.node) && j.step?.max) done += nodeWeight(j.graph[j.node]?.class_type) * (j.step.value / j.step.max);
    j.progress = Math.max(j.progress, Math.min(0.99, done / total));
  }

  function addOutput(j, im, nodeId) {
    if (!im?.filename || im.type === 'temp') return;
    if (j.outputs.some((o) => o.filename === im.filename && o.subfolder === (im.subfolder || ''))) return;
    j.outputs.push({ filename: im.filename, subfolder: im.subfolder || '', type: im.type || 'output', node: nodeId });
  }

  function end(j, state, stage) {
    if (TERMINAL.has(j.state)) return;
    j.state = state;
    j.stage = stage;
    j.finishedAt = now();
    if (state === 'done') j.progress = 1;
    j.preview = null;
    clearInterval(j.poller);
    clearTimeout(j.deadline);
    if (j.overseerUrl) overseer.release(j.overseerUrl);
    j.overseerUrl = '';
    while (jobs.size > keepJobs) {
      const old = [...jobs.values()].find((x) => TERMINAL.has(x.state));
      if (!old) break;
      jobs.delete(old.id);
    }
  }

  function fail(j, e) {
    if (TERMINAL.has(j.state)) return;
    j.error = { code: e.code || 'error', message: redact(e.message, j.client?.secrets), ...(e.nodeId ? { nodeId: e.nodeId } : {}), ...(e.nodeType ? { nodeType: e.nodeType } : {}), ...(e.details ? { details: e.details } : {}) };
    end(j, 'error', 'Failed');
  }

  async function finishFromHistory(j) {
    if (TERMINAL.has(j.state) || j.finishing) return;
    j.finishing = true;
    try {
      const h = (await j.client.history(j.promptId))?.[j.promptId];
      const status = h?.status;
      if (status?.status_str === 'error') {
        const ev = (status.messages || []).find((m) => m[0] === 'execution_error')?.[1];
        fail(j, new ComfyError('execution', executionMessage(ev || { message: 'the workflow failed' }), { nodeId: ev?.node_id, nodeType: ev?.node_type }));
        return;
      }
      for (const [nid, out] of Object.entries(h?.outputs || {})) for (const im of out.images || []) addOutput(j, im, nid);
      if (!h) { j.finishing = false; return; } // not in history yet: the poller asks again
      if (!j.outputs.length) { fail(j, new ComfyError('execution', 'ComfyUI finished but saved no image.')); return; }
      end(j, 'done', 'Done');
    } catch (e) {
      j.finishing = false;
      if (e.code === 'auth') fail(j, e);
    }
  }

  /** Backstop for a missed or lost socket: /history says done or failed; gone from queue and history = lost. */
  async function poll(j) {
    if (TERMINAL.has(j.state) || !j.promptId || j.polling) return;
    j.polling = true;
    try {
      const h = (await j.client.history(j.promptId))?.[j.promptId];
      if (h) {
        if (h.status?.status_str === 'error' || h.status?.completed || Object.keys(h.outputs || {}).length) await finishFromHistory(j);
        return;
      }
      const q = await j.client.queue();
      const running = (q?.queue_running || []).some((it) => it[1] === j.promptId);
      const pending = (q?.queue_pending || []).slice().sort((a, b) => a[0] - b[0]);
      const idx = pending.findIndex((it) => it[1] === j.promptId);
      if (running) { setRunning(j); j.missing = 0; }
      else if (idx >= 0) { j.queuePosition = idx + 1; j.missing = 0; }
      // Neither queued, running nor finished three polls in a row, and no live event for a while: lost.
      else if (++j.missing >= 3 && now() - (j.lastEventAt || j.queuedAt || j.createdAt) > lostAfterMs) fail(j, new ComfyError('lost', 'ComfyUI no longer knows this job (it restarted, or its queue was cleared). Try again.'));
      j.pollErrors = 0;
    } catch (e) {
      if (++j.pollErrors >= 4) fail(j, e instanceof ComfyError ? e : new ComfyError('unreachable', `Lost contact with ComfyUI: ${e.message}`));
    } finally { j.polling = false; }
  }

  function view(j) {
    return {
      id: j.id, kind: j.kind, lane: j.lane || null, label: j.label || null, state: j.state, stage: j.stage,
      progress: Math.round(j.progress * 1000) / 1000, step: j.step,
      node: j.node ? { id: j.node, type: j.graph[j.node]?.class_type || null } : null,
      queuePosition: j.state === 'queued' ? j.queuePosition || null : null, promptId: j.promptId || null,
      params: j.publicParams, outputs: j.outputs.map(({ filename, subfolder, type }) => ({ filename, subfolder, type })),
      error: j.error || null, warnings: j.warnings, target: j.target,
      createdAt: j.createdAt, startedAt: j.startedAt || null, finishedAt: j.finishedAt || null,
      elapsedMs: (j.finishedAt || now()) - (j.startedAt || j.createdAt), previewSeq: j.preview ? j.previewSeq : 0,
    };
  }

  /** A preset id (or an explicit model spec) → { model, defaults, preset }. */
  function resolveModel(raw, presets) {
    if (raw.model && typeof raw.model === 'object') {
      const p = presets.find((x) => JSON.stringify(x.model) === JSON.stringify(raw.model));
      return { model: raw.model, defaults: p?.defaults || {}, preset: p };
    }
    const id = raw.preset || (typeof raw.model === 'string' ? raw.model : '');
    const p = id ? presets.find((x) => x.id === id) : presets[0];
    if (!p) {
      throw new ComfyError('missing_model', id
        ? `The model "${id.replace(/^\w+:/, '')}" is not installed on this ComfyUI. Pick another one.`
        : 'This ComfyUI has no image model Krea Studio can use (no image checkpoint, and no Krea 2 UNET with its text encoder and VAE).');
    }
    return { model: p.model, defaults: p.defaults, preset: p };
  }

  async function cancelJob(j, reason) {
    if (TERMINAL.has(j.state)) return view(j);
    j.cancelReason = reason;
    end(j, 'cancelled', reason);
    if (j.promptId) {
      try { await j.client.cancel(j.promptId); } catch (e) { j.warnings.push(`cancel: ${redact(e.message, j.client.secrets)}`); }
    }
    return view(j);
  }

  /**
   * Queue a job: { kind: 'txt2img'|'img2img'|'upscale', params } or { kind: 'raw', graph }, plus an
   * optional lane (supersedes that lane's unfinished jobs) and label. Bad input and missing models
   * throw (4xx) before anything reaches ComfyUI; later failures land on the job, which callers poll.
   */
  async function submit(body = {}) {
    const kind = String(body.kind || '');
    if (kind !== 'raw' && !BUILDERS[kind]) throw new ComfyError('bad_request', 'kind must be txt2img, img2img, upscale or raw');
    const { t, client } = await targetClient();
    let entry = await info(client, t.settings.authHeader);
    let publicParams = null;
    const build = () => {
      if (kind === 'raw') {
        if (!body.graph || typeof body.graph !== 'object' || Array.isArray(body.graph) || !Object.keys(body.graph).length) throw new ComfyError('bad_request', 'graph must be a ComfyUI API-format workflow object');
        return structuredClone(body.graph);
      }
      const raw = body.params || {};
      const need = needsModel(kind, raw);
      const r = need || raw.model || raw.preset ? resolveModel(raw, entry.presets) : { model: null, defaults: {} };
      let p;
      try { p = normalizeParams({ ...raw, model: r.model }, { defaults: r.defaults, needModel: need }); } catch (e) { throw new ComfyError(e.code || 'bad_request', e.message); }
      publicParams = {
        prompt: p.prompt, style: p.style, preset: r.preset?.id || null, presetLabel: r.preset?.label || null, seed: p.seed, width: p.width, height: p.height,
        steps: p.steps, cfg: p.cfg, sampler: p.sampler, scheduler: p.scheduler, batch: p.batch, lora: p.lora,
        ...(kind === 'img2img' ? { strength: p.strength } : {}), ...(kind === 'upscale' ? { scale: p.scale, enhance: p.enhance, upscaler: p.upscaler || null } : {}),
      };
      try { return BUILDERS[kind](p); } catch (e) { throw new ComfyError(e.code || 'bad_request', e.message); }
    };
    let graph = build();
    // Never queue a graph that names something this ComfyUI lacks. A stale cache gets one fresh
    // /object_info (a model may have just been added) before the job is refused.
    let problems = checkGraph(graph, entry.info);
    if (problems.length && now() - entry.at > 2000) {
      entry = await info(client, t.settings.authHeader, true);
      graph = build();
      problems = checkGraph(graph, entry.info);
    }
    if (problems.length) {
      const p0 = problems[0];
      throw new ComfyError(p0.code, problems.map((p) => p.message).join('; '), { nodeId: p0.nodeId, nodeType: p0.nodeType, details: problems.map((p) => p.message) });
    }

    const lane = body.lane ? String(body.lane).slice(0, 40) : '';
    if (lane) for (const old of jobs.values()) if (old.lane === lane && !TERMINAL.has(old.state)) cancelJob(old, 'Superseded by a newer request').catch(() => {});
    const j = {
      id: newId(), kind, lane, label: body.label ? String(body.label).slice(0, 80) : '', state: 'preparing', stage: 'Preparing',
      graph, client, publicParams, target: { url: t.url, source: t.source }, outputs: [], warnings: [], doneNodes: new Set(),
      progress: 0, step: null, node: null, previewSeq: 0, preview: null, missing: 0, pollErrors: 0, createdAt: now(),
    };
    jobs.set(j.id, j);
    run(j, t).catch((e) => fail(j, e));
    return view(j);
  }

  async function run(j, t) {
    const ov = overseer.resolve(t.settings, t.url);
    if (ov) {
      j.stage = 'Waiting for the GPU';
      j.overseerUrl = ov;
      const r = await overseer.acquire(ov, t.settings.gpuNeedMb, 60);
      if (r.unavailable) { overseer.release(ov); j.overseerUrl = ''; }
      else if (!r.ok) j.warnings.push(`The GPU overseer could not free ${t.settings.gpuNeedMb} MB (${r.freeMb ?? '?'} MB free); trying anyway.`);
      if (TERMINAL.has(j.state)) { if (j.overseerUrl) overseer.release(j.overseerUrl); j.overseerUrl = ''; return; }
    }
    if (TERMINAL.has(j.state)) return; // superseded or cancelled while waiting
    const s = await ensureSocket(j.client, t.settings.authHeader);
    if (!s?.open) j.warnings.push('Live progress is unavailable (the ComfyUI event socket did not connect); polling instead.');
    if (TERMINAL.has(j.state)) return;
    j.stage = 'Queueing';
    const r = await j.client.prompt(j.graph, s?.open ? s.clientId : crypto.randomUUID());
    if (r?.node_errors && Object.keys(r.node_errors).length) throw promptError(r);
    if (!r?.prompt_id) throw new ComfyError('http', 'ComfyUI accepted the workflow but returned no prompt id');
    j.promptId = r.prompt_id;
    j.queuedAt = now();
    if (TERMINAL.has(j.state)) { await j.client.cancel(j.promptId).catch(() => {}); return; }
    if (j.state === 'preparing') { j.state = 'queued'; j.stage = 'Queued'; }
    j.poller = setInterval(() => poll(j), s?.open ? pollMs * 2 : pollMs);
    j.poller.unref?.();
    j.deadline = setTimeout(() => {
      if (TERMINAL.has(j.state)) return;
      j.client.cancel(j.promptId).catch(() => {});
      fail(j, new ComfyError('timeout', `The job did not finish within ${t.settings.timeoutSec} s and was cancelled.`));
    }, t.settings.timeoutSec * 1000);
    j.deadline.unref?.();
  }

  // ------------------------------------------------ public surface

  return {
    target,
    async getConfig() {
      const t = await target();
      const d = await suggest().catch(() => null);
      return { config: publicSettings(t.settings), effective: { url: t.url, source: t.source }, suggested: d?.url ? { url: d.url, running: d.running !== false } : null };
    },
    async setConfig(input) {
      setSettings(input || {});
      infoCache.clear();
      if (sock) { try { sock.ws.terminate(); } catch {} sock = null; }
      return this.getConfig();
    },
    /**
     * Test a ComfyUI: the saved target by default, or { url, authHeader } before saving (the saved
     * header is reused when the URL is the saved one and no new header is typed). Never throws.
     */
    async test(input = {}) {
      const t = await target();
      const url = input.url ? String(input.url) : t.url;
      const same = validateUrl(url).url === t.url;
      const authHeader = input.authHeader ? String(input.authHeader) : (same ? t.settings.authHeader : '');
      const started = now();
      try {
        const client = clientFor(url, authHeader);
        const stats = await client.systemStats();
        if (!stats?.system) throw new ComfyError('http', `${client.base} answered /system_stats, but not the way ComfyUI does. Is this a ComfyUI URL?`);
        const entry = await info(client, authHeader, true);
        return { ok: true, url: client.base, latencyMs: now() - started, ...summarizeStats(stats), models: entry.models, presets: entry.presets.map(({ id, label }) => ({ id, label })) };
      } catch (e) {
        return { ok: false, url: validateUrl(url).url || '', error: { code: e.code || 'error', message: redact(e.message, [authValue(authHeader)]) } };
      }
    },
    async models(force = false) {
      const { t, client } = await targetClient();
      const entry = await info(client, t.settings.authHeader, force);
      return { url: client.base, source: t.source, models: entry.models, presets: entry.presets, styles: STYLES, aspects: ASPECTS, sizes: SIZES };
    },
    submit,
    job(id) {
      const j = jobs.get(id);
      if (!j) throw new ComfyError('not_found', 'No such job (finished jobs are only kept for a while).');
      return view(j);
    },
    jobs: () => [...jobs.values()].reverse().map(view),
    cancel(id) {
      const j = jobs.get(id);
      if (!j) throw new ComfyError('not_found', 'No such job.');
      return cancelJob(j, 'Cancelled');
    },
    preview: (id) => jobs.get(id)?.preview || null,
    async upload(bytes, filename, mime) {
      const { client } = await targetClient();
      const r = await client.upload(bytes, filename, mime);
      if (!r?.name) throw new ComfyError('http', 'ComfyUI did not accept the image.');
      return { name: r.name, subfolder: r.subfolder || '', type: r.type || 'input' };
    },
    async view(ref) {
      const { client } = await targetClient();
      return client.view(ref);
    },
    close() {
      for (const j of jobs.values()) { clearInterval(j.poller); clearTimeout(j.deadline); }
      if (sock) try { sock.ws.terminate(); } catch {}
      sock = null;
    },
  };
}

// ---------------------------------------------------------------- HTTP routes

const IMAGE_TYPES = /^image\/(png|jpeg|webp|gif|bmp)$/;

async function readRaw(req, limit) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > limit) throw new ComfyError('bad_request', `image too large (max ${Math.round(limit / 1048576)} MB)`, { status: 413 });
    chunks.push(c);
  }
  return Buffer.concat(chunks);
}

/**
 * /api/local/comfyui/* (`sub` is the part after "comfyui/"). Returns a JSON-able value, or undefined
 * after streaming an image itself. Errors carry .status (and .code) for the server's error handler.
 *   GET  config · POST config {url, authHeader | clearAuth, gpuOverseer, gpuNeedMb, timeoutSec}
 *   POST test {url?, authHeader?}          version, devices, models; or { ok:false, error }
 *   GET  models[?force=1]                  models, presets, styles, aspects, sizes
 *   POST jobs {kind, params | graph, lane?, label?} · GET jobs · GET jobs/<id> · POST jobs/<id>/cancel
 *   GET  jobs/<id>/preview                 the latest sampling preview (404 when there is none)
 *   POST upload?name=x.png  (raw image)    → { name, subfolder, type } for img2img / upscale
 *   GET  view?filename=&subfolder=&type=   an image from ComfyUI
 */
export async function comfyRoute(svc, { method, sub, q, req, res, body }) {
  try {
    return await route(svc, { method, sub, q, req, res, body });
  } catch (e) {
    if (e instanceof ComfyError) {
      const err = new Error(e.message);
      err.status = e.status;
      throw err;
    }
    throw e;
  }
}

async function route(svc, { method, sub, q, req, res, body }) {
  let mm;
  if (sub === 'config' && method === 'GET') return svc.getConfig();
  if (sub === 'config' && method === 'POST') return svc.setConfig(await body());
  if (sub === 'test' && method === 'POST') return svc.test(await body());
  if (sub === 'models' && method === 'GET') return svc.models(q.get('force') === '1');
  if (sub === 'jobs' && method === 'GET') return { jobs: svc.jobs() };
  if (sub === 'jobs' && method === 'POST') return svc.submit(await body());
  if ((mm = sub.match(/^jobs\/([\w-]+)$/)) && method === 'GET') return svc.job(mm[1]);
  if ((mm = sub.match(/^jobs\/([\w-]+)\/cancel$/)) && method === 'POST') return svc.cancel(mm[1]);
  if ((mm = sub.match(/^jobs\/([\w-]+)\/preview$/)) && method === 'GET') {
    const p = svc.preview(mm[1]);
    if (!p) throw new ComfyError('not_found', 'no preview yet');
    res.writeHead(200, { 'content-type': p.mime, 'content-length': p.bytes.length, 'cache-control': 'no-store' });
    res.end(p.bytes);
    return undefined;
  }
  if (sub === 'upload' && method === 'POST') {
    const mime = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    if (!IMAGE_TYPES.test(mime)) throw new ComfyError('bad_request', 'upload an image (PNG, JPEG or WebP)');
    let name = String(q.get('name') || '').replace(/[^\w.\- ()]/g, '_').replace(/^[.\s]+/, '').slice(-100);
    if (!name) name = `input-${Date.now()}.png`;
    const bytes = await readRaw(req, 25 * 1024 * 1024);
    if (!bytes.length) throw new ComfyError('bad_request', 'the image is empty');
    return svc.upload(bytes, name, mime);
  }
  if (sub === 'view' && method === 'GET') {
    const filename = q.get('filename') || '';
    const subfolder = q.get('subfolder') || '';
    const type = q.get('type') || 'output';
    if (!filename || /[\\/]/.test(filename) || /(^|[\\/])\.\.([\\/]|$)/.test(subfolder) || !['output', 'input', 'temp'].includes(type)) throw new ComfyError('bad_request', 'bad image reference');
    const r = await svc.view({ filename, subfolder, type });
    const bytes = Buffer.from(await r.arrayBuffer());
    res.writeHead(200, { 'content-type': r.headers.get('content-type') || 'application/octet-stream', 'content-length': bytes.length, 'cache-control': 'private, max-age=86400' });
    res.end(bytes);
    return undefined;
  }
  throw new ComfyError('not_found', `unknown endpoint: ${method} comfyui/${sub}`);
}
