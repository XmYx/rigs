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
