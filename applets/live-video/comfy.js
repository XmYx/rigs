// A small ComfyUI client for one instance (base URL + optional auth header):
//   systemStats()  GET /system_stats       connection check, version, GPUs
//   objectInfo()   GET /object_info        node classes and model lists (the missing-node/model check)
//   queuePrompt()  POST /prompt            an API-format workflow, tagged with our client id
//   getQueue() · deleteQueued(ids) · interrupt(promptId) · history(id)
//   view()         GET /view               a generated file, streamed (passes Range through for <video>)
//   uploadImage()  POST /upload/image      a start frame for image-to-video
//   connect()      /ws?clientId=           progress / executing / executed events, reconnecting
// The auth value never appears in errors or logs.
import crypto from 'node:crypto';
import WebSocket from 'ws';

export class ComfyError extends Error {
  constructor(message, { status = 0, body = null } = {}) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

/** Header value for the token: a bare token in Authorization becomes "Bearer <token>". */
export function authValue(header, token) {
  if (!token) return null;
  return String(header || '').toLowerCase() === 'authorization' && !/\s/.test(token) ? `Bearer ${token}` : token;
}

/** ComfyUI's /prompt rejection → one readable line (error message + the first node errors). */
export function promptErrorMessage(body) {
  const e = body?.error;
  let msg = typeof e === 'string' ? e : e?.message || 'ComfyUI rejected the workflow';
  if (e?.details && typeof e.details === 'string') msg += `: ${e.details}`;
  const nodes = Object.entries(body?.node_errors || {}).slice(0, 3).map(([id, n]) => `${n.class_type || 'node'} #${id}: ${(n.errors || []).map((x) => x.details ? `${x.message} (${x.details})` : x.message).join('; ')}`);
  return nodes.length ? `${msg} — ${nodes.join(' | ')}` : msg;
}

export function createComfyClient({ baseUrl, authHeader = 'Authorization', authToken = null, fetchImpl = globalThis.fetch, WebSocketImpl = WebSocket, clientId = 'live-video-' + crypto.randomUUID(), timeoutMs = 15000 } = {}) {
  const base = String(baseUrl || '').replace(/\/+$/, '');
  const auth = authValue(authHeader, authToken);
  const headers = (extra = {}) => ({ ...(auth ? { [authHeader]: auth } : {}), ...extra });
  const url = (p) => base + p;

  async function request(method, p, { json, body, extraHeaders, timeout = timeoutMs, raw = false } = {}) {
    if (!base) throw new ComfyError('no ComfyUI URL is set');
    const h = headers(extraHeaders);
    if (json !== undefined) { h['content-type'] = 'application/json'; body = JSON.stringify(json); }
    let res;
    try {
      res = await fetchImpl(url(p), { method, headers: h, body, signal: AbortSignal.timeout(timeout) });
    } catch (e) {
      const why = e.name === 'TimeoutError' ? `timed out after ${Math.round(timeout / 1000)} s` : (e.cause?.code || e.message);
      throw new ComfyError(`ComfyUI unreachable at ${base} (${why})`);
    }
    if (raw) return res;
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = text; }
    if (res.status === 401 || res.status === 403) throw new ComfyError(`ComfyUI refused the request (${res.status}): check the auth header and token`, { status: res.status, body: data });
    if (!res.ok) throw new ComfyError(p === '/prompt' && data && typeof data === 'object' ? promptErrorMessage(data) : `ComfyUI ${method} ${p} failed: HTTP ${res.status}`, { status: res.status, body: data });
    return data;
  }

  function connect({ onMessage, onOpen, onClose } = {}) {
    let ws = null;
    let closed = false;
    let delay = 500;
    let timer = null;
    const open = () => {
      if (closed) return;
      const wsUrl = url('/ws?clientId=' + encodeURIComponent(clientId)).replace(/^http/, 'ws');
      try { ws = new WebSocketImpl(wsUrl, { headers: headers() }); } catch { return retry(); }
      ws.on('open', () => { delay = 500; onOpen?.(); });
      ws.on('message', (data, isBinary) => {
        if (isBinary) return; // live preview frames: not used
        try { onMessage?.(JSON.parse(data.toString())); } catch {}
      });
      ws.on('error', () => {});
      ws.on('close', () => { onClose?.(); retry(); });
    };
    const retry = () => {
      if (closed || timer) return;
      timer = setTimeout(() => { timer = null; open(); }, delay);
      delay = Math.min(delay * 2, 10000);
    };
    open();
    return {
      get connected() { return ws?.readyState === 1; },
      close() { closed = true; clearTimeout(timer); try { ws?.close(); } catch {} },
    };
  }

  return {
    baseUrl: base, clientId,
    systemStats: () => request('GET', '/system_stats'),
    objectInfo: () => request('GET', '/object_info', { timeout: 60000 }),
    async queuePrompt(workflow) {
      const r = await request('POST', '/prompt', { json: { prompt: workflow, client_id: clientId } });
      if (!r?.prompt_id) throw new ComfyError(promptErrorMessage(r), { body: r });
      return r;
    },
    getQueue: () => request('GET', '/queue'),
    deleteQueued: (ids) => request('POST', '/queue', { json: { delete: ids } }),
    interrupt: (promptId) => request('POST', '/interrupt', { json: promptId ? { prompt_id: promptId } : {} }),
    async history(id) { return (await request('GET', '/history/' + encodeURIComponent(id)))?.[id] || null; },
    view({ filename, subfolder = '', type = 'output' }, { range } = {}) {
      const q = new URLSearchParams({ filename, subfolder, type });
      return request('GET', '/view?' + q, { raw: true, extraHeaders: range ? { range } : {}, timeout: 120000 });
    },
    async uploadImage(buf, filename, mime = 'image/png') {
      const form = new FormData();
      form.append('image', new Blob([buf], { type: mime }), filename);
      form.append('type', 'input');
      form.append('overwrite', 'true');
      return request('POST', '/upload/image', { body: form, timeout: 60000 });
    },
    connect,
  };
}
