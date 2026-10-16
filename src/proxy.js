import http from 'node:http';
import https from 'node:https';
import { WebSocket, WebSocketServer } from 'ws';
import { config } from './config.js';

const HOP = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade', 'host']);

function peerHeaders(node, incoming = {}) {
  const h = {};
  for (const [k, v] of Object.entries(incoming)) {
    if (HOP.has(k) || k.startsWith('tailscale-') || k === 'x-rigs-token' || k === 'authorization' || k === 'cookie') continue;
    h[k] = v;
  }
  if (node.viaToken) h['x-rigs-token'] = config().meshToken;
  h['x-rigs-via'] = config().name;
  return h;
}

/** Stream an HTTP request through to a peer's /api/local/* endpoint. */
export function forwardHttp(node, req, res, localPath) {
  const target = new URL(node.url.replace(/\/$/, '') + '/api/local/' + localPath);
  const lib = target.protocol === 'https:' ? https : http;
  const preq = lib.request(target, { method: req.method, headers: peerHeaders(node, req.headers), timeout: 0 }, (pres) => {
    const headers = {};
    for (const [k, v] of Object.entries(pres.headers)) if (!HOP.has(k)) headers[k] = v;
    res.writeHead(pres.statusCode || 502, headers);
    pres.pipe(res);
  });
  // Idle timeout; long streams (chat) send heartbeats so they stay under it.
  preq.setTimeout(120000, () => preq.destroy(new Error('peer timeout')));
  preq.on('error', (e) => {
    if (!res.headersSent) {
      res.writeHead(502, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: `peer ${node.name} unreachable: ${e.message}` }));
    } else {
      res.end();
    }
  });
  res.on('close', () => preq.destroy());
  req.pipe(preq);
}

/** JSON call to a peer (used by the gateway for aggregation and by broadcast actions). */
export async function peerJson(node, localPath, { method = 'GET', body, timeout = 8000 } = {}) {
  const headers = { 'content-type': 'application/json' };
  if (node.viaToken) headers['x-rigs-token'] = config().meshToken;
  const r = await fetch(node.url.replace(/\/$/, '') + '/api/local/' + localPath, {
    method, headers, body: body !== undefined ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(timeout),
  });
  const text = await r.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }
  if (!r.ok) throw new Error(data?.error || `HTTP ${r.status}`);
  return data;
}

const wss = new WebSocketServer({ noServer: true });

/** Bridge a browser WebSocket to the same WebSocket endpoint on a peer. */
export function forwardWs(node, req, socket, head, localPath) {
  const base = node.url.replace(/^http/, 'ws').replace(/\/$/, '');
  const headers = node.viaToken ? { 'x-rigs-token': config().meshToken } : {};
  const upstream = new WebSocket(base + '/api/local/' + localPath, { headers, handshakeTimeout: 8000 });
  const pending = [];
  let client = null;
  upstream.on('open', () => {
    wss.handleUpgrade(req, socket, head, (ws) => {
      client = ws;
      ws.on('message', (d, isBinary) => upstream.readyState === 1 && upstream.send(d, { binary: isBinary }));
      ws.on('close', () => upstream.close());
      ws.on('error', () => upstream.close());
      for (const [d, b] of pending) ws.send(d, { binary: b });
    });
  });
  upstream.on('message', (d, isBinary) => {
    if (client?.readyState === 1) client.send(d, { binary: isBinary });
    else pending.push([d, isBinary]);
  });
  upstream.on('close', () => client?.close());
  upstream.on('error', () => {
    if (client) client.close(); else socket.destroy();
  });
}

// ---------------------------------------------------------------- App Cloud: forward to a local web app

const APP_DROP = new Set([...HOP, 'x-rigs-token', 'x-rigs-via', 'x-rigs-app-base']);
const FRAME_BLOCKERS = new Set(['x-frame-options']);

function appRequestHeaders(target, incoming, base, { upgrade = false } = {}) {
  const h = {};
  for (const [k, v] of Object.entries(incoming)) {
    if (k.startsWith('tailscale-')) continue;
    if (APP_DROP.has(k) && !(upgrade && (k === 'connection' || k === 'upgrade'))) continue;
    h[k] = v;
  }
  h.host = target.host;
  h['x-forwarded-prefix'] = base;
  return h;
}

/**
 * Response headers for the browser: drop hop headers and frame blockers (JARVIS shows apps in an
 * iframe), drop frame-ancestors from CSP, and keep root-relative redirects/cookies under `base`.
 */
export function appResponseHeaders(headers, base) {
  const out = {};
  for (const [k, v] of Object.entries(headers)) {
    if (HOP.has(k) || FRAME_BLOCKERS.has(k)) continue;
    if (k === 'content-security-policy') {
      const csp = String(v).split(';').filter((d) => !/^\s*frame-ancestors\b/i.test(d)).join(';').trim();
      if (csp) out[k] = csp;
      continue;
    }
    if (k === 'location' && typeof v === 'string' && v.startsWith('/') && !v.startsWith('//') && !v.startsWith(base + '/')) { out[k] = base + v; continue; }
    if (k === 'set-cookie') { out[k] = [].concat(v).map((c) => c.replace(/;\s*path=\/(?=;|$)/i, `; Path=${base}/`)); continue; }
    out[k] = v;
  }
  return out;
}

/** Stream one HTTP request to a web app hosted on this machine. `subPath` excludes the leading slash. */
export function forwardApp(app, req, res, subPath, base) {
  const target = new URL(app.target + '/' + subPath);
  const lib = target.protocol === 'https:' ? https : http;
  const preq = lib.request(target, { method: req.method, headers: appRequestHeaders(target, req.headers, base), timeout: 0 }, (pres) => {
    res.writeHead(pres.statusCode || 502, appResponseHeaders(pres.headers, base));
    pres.pipe(res);
  });
  preq.setTimeout(300000, () => preq.destroy(new Error('app timeout')));
  preq.on('error', (e) => {
    if (!res.headersSent) {
      res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
      res.end(`${app.name} on ${app.node} is not answering (${e.code || e.message}).`);
    } else res.end();
  });
  res.on('close', () => preq.destroy());
  req.pipe(preq);
}

/** Bridge a WebSocket (or any HTTP upgrade) to a web app hosted on this machine. */
export function forwardAppUpgrade(app, req, socket, head, subPath, base) {
  const target = new URL(app.target + '/' + subPath);
  const lib = target.protocol === 'https:' ? https : http;
  const preq = lib.request(target, { method: req.method, headers: appRequestHeaders(target, req.headers, base, { upgrade: true }) });
  preq.on('upgrade', (pres, psock, phead) => {
    const lines = [`HTTP/1.1 ${pres.statusCode} ${pres.statusMessage}`];
    for (let i = 0; i < pres.rawHeaders.length; i += 2) lines.push(`${pres.rawHeaders[i]}: ${pres.rawHeaders[i + 1]}`);
    socket.write(lines.join('\r\n') + '\r\n\r\n');
    if (phead?.length) socket.write(phead);
    if (head?.length) psock.write(head);
    psock.pipe(socket).pipe(psock);
    psock.on('error', () => socket.destroy());
    socket.on('error', () => psock.destroy());
  });
  preq.on('response', (pres) => { socket.end(`HTTP/1.1 ${pres.statusCode} ${pres.statusMessage}\r\n\r\n`); pres.resume(); });
  preq.on('error', () => socket.destroy());
  preq.end();
}
