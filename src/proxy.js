import http from 'node:http';
import https from 'node:https';
import { pipeline as pipelineCb, Transform } from 'node:stream';
import zlib from 'node:zlib';
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

/**
 * Stream an HTTP request through to a peer's /api/local/* endpoint. Request headers (Range, If-Range…) go as they are and
 * the status and headers come back unchanged (206 + Content-Range for media seeking), the body piped, never buffered.
 */
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

/** Close codes a relay may pass on (1005/1006 are reserved for "no code" and "abnormal"). */
export const relayCloseCode = (code) => (code === 1000 || (code >= 3000 && code <= 4999) ? code : 1000);

/**
 * Bridge a browser WebSocket to the same WebSocket endpoint on a peer. The peer sees x-rigs-via (the node the
 * request entered on, for control.allowFrom and the audit log) and the caller header; close codes and reasons
 * pass through (a screen stream's 4403 control-off), also when the peer closes before the browser side is up.
 */
export function forwardWs(node, req, socket, head, localPath) {
  const base = node.url.replace(/^http/, 'ws').replace(/\/$/, '');
  const headers = { 'x-rigs-via': config().name };
  if (node.viaToken) headers['x-rigs-token'] = config().meshToken;
  if (req.headers['x-rigs-caller']) headers['x-rigs-caller'] = req.headers['x-rigs-caller'];
  const upstream = new WebSocket(base + '/api/local/' + localPath, { headers, handshakeTimeout: 8000 });
  const pending = [];
  let client = null, closed = null;
  const closeClient = () => client.close(relayCloseCode(closed.code), closed.reason);
  upstream.on('open', () => {
    wss.handleUpgrade(req, socket, head, (ws) => {
      client = ws;
      ws.on('message', (d, isBinary) => upstream.readyState === 1 && upstream.send(d, { binary: isBinary }));
      ws.on('close', () => upstream.close());
      ws.on('error', () => upstream.close());
      for (const [d, b] of pending) ws.send(d, { binary: b });
      if (closed) closeClient();
    });
  });
  upstream.on('message', (d, isBinary) => {
    if (client?.readyState === 1) client.send(d, { binary: isBinary });
    else pending.push([d, isBinary]);
  });
  upstream.on('close', (code, reason) => {
    closed = { code, reason: String(reason || '') };
    if (client) closeClient();
  });
  upstream.on('error', () => {
    if (client) client.close(); else if (!closed) socket.destroy();
  });
}

// ---------------------------------------------------------------- app proxy (App Cloud)
//
// /api/nodes/<node>/apps/<id>/<path> reaches a web app declared in config.apps (src/apps.js) on any node.
//  - app on this node: forwarded to app.target, with rewriting so an app written for "/" works under the prefix
//    (Location, Set-Cookie Path/Domain, root-relative src/href/action, CSS url(), a fetch/XHR/WebSocket shim,
//    and X-Frame-Options / CSP frame-ancestors removed so JARVIS can iframe it).
//  - app on a peer: relayed byte-for-byte to the peer daemon at the same path; the peer does the local forward
//    and the rewriting. The peer authorizes the hop like any other request (tailnet identity or mesh token).
// Bodies stream in both directions (SSE, chunked, uploads); only text/html and text/css pass through a
// streaming rewriter. WebSocket upgrades are piped as raw sockets.

export const APP_ROUTE = /^\/api\/nodes\/([^/]+)\/apps\/([^/]+)(\/.*)?$/;
export const SHIM_PATH = '/__rigs-proxy/shim.js';
const APP_HOP = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade', 'host', 'proxy-connection']);
const DECODERS = { gzip: () => zlib.createGunzip(), 'x-gzip': () => zlib.createGunzip(), deflate: () => zlib.createInflate(), br: () => zlib.createBrotliDecompress() };

/** Parse an app route. Returns { nodeRef, appId, rest, prefix } (rest is undefined for the bare prefix) or null. */
export function appRoute(pathname) {
  const m = APP_ROUTE.exec(pathname);
  if (!m) return null;
  return { nodeRef: m[1], appId: m[2], rest: m[3], prefix: `/api/nodes/${m[1]}/apps/${m[2]}` };
}

/** A sane path prefix supplied by the hop before us (X-Forwarded-Prefix), else null. */
function forwardedPrefix(req) {
  const v = String(req.headers['x-forwarded-prefix'] || '').split(',')[0].trim().replace(/\/+$/, '');
  return APP_ROUTE.test(v + '/') && /^[\w%.~!$&'()*+,;=:@/-]+$/.test(v) ? v : null;
}

/** The public face of a request: what the browser sees (honours X-Forwarded-* from a previous hop). */
export function publicView(req, route) {
  const proto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() || (req.socket?.encrypted ? 'https' : 'http');
  const host = String(req.headers['x-forwarded-host'] || '').split(',')[0].trim() || req.headers.host || 'localhost';
  return { proto, host, origin: `${proto}://${host}`, prefix: forwardedPrefix(req) || route.prefix };
}

function isMeshBearer(req) {
  const tok = config().meshToken;
  const a = String(req.headers.authorization || '');
  return !!tok && /^Bearer\s+/i.test(a) && a.replace(/^Bearer\s+/i, '') === tok;
}

function forwardedFor(req) {
  const ip = (req.socket?.remoteAddress || '').replace(/^::ffff:/, '');
  return req.headers['x-forwarded-for'] ? `${req.headers['x-forwarded-for']}, ${ip}` : ip;
}

/** Headers for the next hop. Mesh credentials and tailnet identity never reach an app. */
function appRequestHeaders(req, view, { upgrade = false } = {}) {
  const h = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (APP_HOP.has(k) || k.startsWith('tailscale-') || k === 'x-rigs-token' || k === 'x-rigs-via' || k.startsWith('x-forwarded-')) continue;
    if (k === 'authorization' && isMeshBearer(req)) continue;
    h[k] = v;
  }
  if (upgrade) { h.connection = 'Upgrade'; h.upgrade = req.headers.upgrade; }
  h['x-forwarded-proto'] = view.proto;
  h['x-forwarded-host'] = view.host;
  h['x-forwarded-prefix'] = view.prefix;
  h['x-forwarded-for'] = forwardedFor(req);
  return h;
}

/** Map an app-side path ("/x", relative to the app's own root) to the public prefixed path. */
function mapPath(p, ctx) {
  const base = ctx.targetPath;
  if (p === ctx.prefix || p.startsWith(ctx.prefix + '/')) return p;
  if (base && (p === base || p.startsWith(base + '/'))) p = p.slice(base.length) || '/';
  return ctx.prefix + p;
}

/** Rewrite a URL the app emitted (Location, attribute, CSS) so it stays inside the prefix. Others are left alone. */
export function rewriteUrl(u, ctx) {
  const s = String(u);
  if (s.startsWith('/') && !s.startsWith('//')) {
    const i = s.search(/[?#]/);
    return i < 0 ? mapPath(s, ctx) : mapPath(s.slice(0, i), ctx) + s.slice(i);
  }
  if (/^https?:\/\//i.test(s) || s.startsWith('//')) {
    let x;
    try { x = new URL(s, ctx.targetOrigin); } catch { return s; }
    if (x.origin !== ctx.targetOrigin && x.origin !== ctx.publicOrigin) return s;
    return mapPath(x.pathname, ctx) + x.search + x.hash;
  }
  return s;
}

/** Location: absolute or root-relative URLs on the app (or on the public origin) → prefixed root-relative path. */
export function rewriteLocation(loc, ctx) {
  let x;
  try { x = new URL(String(loc), ctx.targetOrigin + ctx.targetPath + ctx.upstreamPath); } catch { return loc; }
  if (x.origin !== ctx.targetOrigin && x.origin !== ctx.publicOrigin) return loc;
  return mapPath(x.pathname, ctx) + x.search + x.hash;
}

/** Set-Cookie: Path moves under the prefix, Domain is dropped (host-only on the proxy), Secure is dropped on plain http. */
export function rewriteSetCookie(cookie, ctx) {
  const parts = String(cookie).split(';');
  const out = [parts[0]];
  let hasPath = false;
  let secureDropped = false;
  for (const raw of parts.slice(1)) {
    const a = raw.trim();
    const [k, ...v] = a.split('=');
    const key = k.trim().toLowerCase();
    if (key === 'domain') continue;
    if (key === 'path') { hasPath = true; const val = v.join('=').trim(); out.push(`Path=${val.startsWith('/') ? mapPath(val, ctx) : ctx.prefix + '/'}`); continue; }
    if (key === 'secure' && ctx.publicProto === 'http') { secureDropped = true; continue; }
    out.push(a);
  }
  if (!hasPath) out.push(`Path=${ctx.prefix}/`);
  // SameSite=None is only valid with Secure; same-origin iframes are fine with Lax.
  return out.map((a) => (secureDropped && /^samesite\s*=\s*none$/i.test(a) ? 'SameSite=Lax' : a)).join('; ');
}

/** CSP without frame-ancestors (null when nothing is left). */
export function stripFrameAncestors(csp) {
  const kept = String(csp).split(';').map((d) => d.trim()).filter((d) => d && !/^frame-ancestors(\s|$)/i.test(d));
  return kept.length ? kept.join('; ') : null;
}

/** Response headers for the browser, rewritten for the prefix. `transformed` drops length/encoding. */
export function rewriteResponseHeaders(headers, ctx, { transformed = false } = {}) {
  const out = {};
  for (const [k, v] of Object.entries(headers)) {
    if (APP_HOP.has(k) || k === 'x-frame-options') continue;
    if (transformed && (k === 'content-length' || k === 'content-encoding' || k === 'content-md5' || k === 'accept-ranges')) continue;
    if (transformed && k === 'etag') { out[k] = String(v).startsWith('W/') ? v : `W/${v}`; continue; }
    if (k === 'location') out[k] = rewriteLocation(v, ctx);
    else if (k === 'set-cookie') out[k] = ctx.rewrite.cookies === false ? v : [].concat(v).map((c) => rewriteSetCookie(c, ctx));
    else if (k === 'content-security-policy' || k === 'content-security-policy-report-only') {
      const kept = [].concat(v).map(stripFrameAncestors).filter(Boolean);
      if (kept.length) out[k] = kept;
    } else out[k] = v;
  }
  return out;
}

const escAttr = (s) => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
const URL_ATTRS = 'src|href|action|formaction|poster|data|background|srcset|imagesrcset';
const ATTR_RE = new RegExp(`(\\s(?:${URL_ATTRS})\\s*=\\s*)(?:"([^"]*)"|'([^']*)'|([^\\s"'>]+))`, 'gi');
const TAG_RE = /<(\/?)([a-zA-Z][\w:-]*)((?:\s+[^\s"'>/=]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'>]+))?)*)\s*(\/?)>/g;
const CSS_URL_RE = /(url\(\s*)(["']?)(\/(?!\/)[^"')\s]*)\2(\s*\))|(@import\s+)(["'])(\/(?!\/)[^"']*)\6/gi;

export function rewriteCss(text, ctx) {
  return text.replace(CSS_URL_RE, (m, a, q, u, z, imp, q2, u2) => (imp ? `${imp}${q2}${rewriteUrl(u2, ctx)}${q2}` : `${a}${q}${rewriteUrl(u, ctx)}${q}${z}`));
}

function rewriteSrcset(v, ctx) {
  return v.split(',').map((part) => {
    const m = part.match(/^(\s*)(\S+)(.*)$/);
    return m ? m[1] + rewriteUrl(m[2], ctx) + m[3] : part;
  }).join(',');
}

function rewriteTagAttrs(attrs, ctx) {
  return attrs.replace(ATTR_RE, (m, lead, dq, sq, bare) => {
    const name = lead.trim().split(/\s|=/)[0].toLowerCase();
    const val = dq ?? sq ?? bare;
    // Attribute values are HTML-encoded; "&amp;" never changes what a path starts with, so rewrite in place.
    const next = name.endsWith('srcset') ? rewriteSrcset(val, ctx) : rewriteUrl(val, ctx);
    const q = dq !== undefined ? '"' : sq !== undefined ? "'" : '';
    return `${lead}${q}${next}${q}`;
  });
}

/**
 * Streaming HTML rewriter (latin1 in/out, so bytes of any ASCII-compatible charset survive untouched).
 * Rewrites root-relative URL attributes and CSS url(), loads the runtime shim first thing in <head>,
 * and adds a <base href> equal to the document's own URL when the page has none (neutral for
 * relative links, and makes document.baseURI point inside the prefix).
 */
export function htmlRewriter(ctx) {
  let carry = '';
  let shimDone = false;
  let baseSeen = false;
  let sawHtml = false;
  const shim = () => `<script src="${escAttr(ctx.prefix + SHIM_PATH)}" data-prefix="${escAttr(ctx.prefix)}"></script>`;
  const base = () => `<base href="${escAttr(ctx.documentUrl)}">`;
  const rewrite = (text) => {
    const out = text.replace(TAG_RE, (tag, close, name, attrs, selfClose) => {
      const n = name.toLowerCase();
      let pre = '';
      let post = '';
      if (n === 'html' && !close) sawHtml = true;
      if (n === 'head' && !close && !shimDone) { shimDone = true; post = ctx.shim ? shim() : ''; }
      if (n === 'base' && !close && /\shref\s*=/i.test(attrs)) baseSeen = true;
      if (((n === 'head' && close) || (n === 'body' && !close)) && !baseSeen) { baseSeen = true; pre = base(); }
      if (n === 'body' && !close && !shimDone && sawHtml) { shimDone = true; pre = (ctx.shim ? shim() : '') + pre; }
      const rewritten = close ? tag : `<${name}${rewriteTagAttrs(attrs, ctx)}${selfClose ? ' /' : ''}>`;
      return pre + rewritten + post;
    });
    return rewriteCss(out, ctx);
  };
  return new Transform({
    transform(chunk, _enc, cb) {
      const text = carry + chunk.toString('latin1');
      // Hold back an unfinished tag (or a long run with no '>' yet, capped so we never buffer a whole document).
      const lt = text.lastIndexOf('<');
      const cut = lt > text.lastIndexOf('>') && text.length - lt < 65536 ? lt : text.length;
      carry = text.slice(cut);
      cb(null, Buffer.from(rewrite(text.slice(0, cut)), 'latin1'));
    },
    flush(cb) { cb(null, Buffer.from(rewrite(carry), 'latin1')); },
  });
}

/** Streaming CSS rewriter: rewrites complete lines/rules, carrying the unfinished tail. */
export function cssRewriter(ctx) {
  let carry = '';
  return new Transform({
    transform(chunk, _enc, cb) {
      const text = carry + chunk.toString('latin1');
      const cut = Math.max(text.lastIndexOf('\n'), text.lastIndexOf(';'), text.lastIndexOf('}')) + 1;
      carry = text.length - cut < 65536 ? text.slice(cut) : '';
      cb(null, Buffer.from(rewriteCss(text.slice(0, text.length - carry.length), ctx), 'latin1'));
    },
    flush(cb) { cb(null, Buffer.from(rewriteCss(carry, ctx), 'latin1')); },
  });
}

/**
 * Runtime shim for apps that build root-relative URLs in JavaScript: fetch, XHR, WebSocket, EventSource,
 * history.pushState/replaceState and window.open are pointed back inside the prefix. Same-origin URLs
 * outside the prefix are the app's own (an app in the frame never means the RIGS API).
 */
export const SHIM_JS = `(function () {
  var s = document.currentScript, P = s && s.getAttribute('data-prefix');
  if (!P || window.__rigsProxyPrefix) return;
  window.__rigsProxyPrefix = P;
  function fix(u, ws) {
    try {
      var x = new URL(String(u), location.href);
      if (ws && /^http/.test(x.protocol)) x.protocol = x.protocol === 'https:' ? 'wss:' : 'ws:';
      if (x.host === location.host && /^(https?|wss?):$/.test(x.protocol) && x.pathname !== P && x.pathname.indexOf(P + '/') !== 0) {
        x.pathname = P + x.pathname;
        return x.href;
      }
      if (ws) return x.href;
    } catch (e) {}
    return u;
  }
  var F = window.fetch;
  if (F) window.fetch = function (i, o) {
    if (typeof Request !== 'undefined' && i instanceof Request) { var n = fix(i.url); if (n !== i.url) i = new Request(n, i); }
    else i = fix(i);
    return F.call(this, i, o);
  };
  var XO = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (m, u) { arguments[1] = fix(u); return XO.apply(this, arguments); };
  function wrap(C, ws) {
    if (!C) return C;
    var W = function (u, p) { return arguments.length > 1 ? new C(fix(u, ws), p) : new C(fix(u, ws)); };
    W.prototype = C.prototype;
    ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED'].forEach(function (k) { if (k in C) W[k] = C[k]; });
    return W;
  }
  window.WebSocket = wrap(window.WebSocket, true);
  window.EventSource = wrap(window.EventSource, false);
  ['pushState', 'replaceState'].forEach(function (k) {
    var h = history[k];
    history[k] = function (st, t, u) { return u == null ? h.call(this, st, t) : h.call(this, st, t, fix(u)); };
  });
  var WO = window.open;
  window.open = function (u) { if (u) arguments[0] = fix(u); return WO.apply(this, arguments); };
})();
`;

function appCtx(app, view, upstreamPath, search) {
  const t = new URL(app.target);
  return {
    prefix: view.prefix, publicOrigin: view.origin, publicProto: view.proto,
    targetOrigin: t.origin, targetPath: t.pathname.replace(/\/+$/, ''),
    upstreamPath, documentUrl: view.prefix + upstreamPath + search,
    rewrite: app.rewrite || {}, shim: app.rewrite?.rootRelative !== false,
  };
}

function sendJson(res, status, data) {
  if (res.headersSent) { res.destroy(); return; }
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(data));
}

function upstreamUrl(app, upstreamPath, search) {
  return new URL(app.target.replace(/\/+$/, '') + upstreamPath + search);
}

/** Point the app's own Origin/Referer at its real address (CSRF and WebSocket origin checks). */
function appIdentityHeaders(h, ctx, upstreamPath) {
  if (h.origin === ctx.publicOrigin) h.origin = ctx.targetOrigin;
  if (typeof h.referer === 'string' && h.referer.startsWith(ctx.publicOrigin + ctx.prefix)) {
    const rest = h.referer.slice((ctx.publicOrigin + ctx.prefix).length);
    h.referer = ctx.targetOrigin + ctx.targetPath + (rest.startsWith('/') ? rest : '/' + rest);
  }
  if (h['accept-encoding']) {
    // Only codings we can undo for the HTML/CSS rewriter.
    const ok = String(h['accept-encoding']).split(',').map((s) => s.trim()).filter((s) => /^(gzip|deflate|br|identity)(;|$)/i.test(s));
    if (ok.length) h['accept-encoding'] = ok.join(', '); else delete h['accept-encoding'];
  }
  return h;
}

/** Forward one HTTP request to an app on this node. `route` from appRoute(); `search` keeps the query. */
export function proxyApp(req, res, app, route, search = '') {
  const view = publicView(req, route);
  const upstreamPath = route.rest || '/';
  const ctx = appCtx(app, view, upstreamPath, search);
  if (upstreamPath === SHIM_PATH) {
    res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'max-age=3600' });
    res.end(SHIM_JS);
    return;
  }
  const target = upstreamUrl(app, upstreamPath, search);
  const headers = appIdentityHeaders(appRequestHeaders(req, view), ctx, upstreamPath);
  headers.host = target.host;
  const lib = target.protocol === 'https:' ? https : http;
  const preq = lib.request(target, { method: req.method, headers }, (pres) => {
    preq.setTimeout(0);
    const type = String(pres.headers['content-type'] || '').toLowerCase();
    const enc = String(pres.headers['content-encoding'] || 'identity').toLowerCase();
    const untouched = req.method === 'HEAD' || pres.statusCode === 204 || pres.statusCode === 304 || pres.statusCode === 206;
    const kind = ctx.shim && !untouched ? (/^(text\/html|application\/xhtml\+xml)/.test(type) ? 'html' : /^text\/css/.test(type) ? 'css' : null) : null;
    const canDecode = enc === 'identity' || !!DECODERS[enc];
    const transform = kind && canDecode;
    res.writeHead(pres.statusCode || 502, pres.statusMessage, rewriteResponseHeaders(pres.headers, ctx, { transformed: transform }));
    res.flushHeaders();
    if (!transform) { pres.pipe(res); return; }
    const stages = [pres];
    if (enc !== 'identity') stages.push(DECODERS[enc]());
    stages.push(kind === 'html' ? htmlRewriter(ctx) : cssRewriter(ctx), res);
    pipelineCb(...stages, () => {});
  });
  // Waiting for the first byte can take a while (slow lookups); once streaming, there is no idle limit.
  preq.setTimeout(300000, () => preq.destroy(new Error('app timeout')));
  preq.on('error', (e) => sendJson(res, 502, { error: `app ${app.id} on ${app.node} is not responding: ${e.code || e.message}`, app: app.id, node: app.node }));
  res.on('close', () => { if (!res.writableFinished) preq.destroy(); });
  req.pipe(preq);
}

/** Relay an app request to the peer daemon that hosts the app (same path; the peer rewrites). */
export function relayApp(node, req, res, route, search = '') {
  const view = publicView(req, route);
  const target = new URL(node.url.replace(/\/$/, '') + route.prefix + (route.rest || '/') + search);
  const headers = appRequestHeaders(req, view);
  if (node.viaToken) headers['x-rigs-token'] = config().meshToken;
  headers['x-rigs-via'] = config().name;
  const lib = target.protocol === 'https:' ? https : http;
  const preq = lib.request(target, { method: req.method, headers }, (pres) => {
    preq.setTimeout(0);
    const out = {};
    for (const [k, v] of Object.entries(pres.headers)) if (!APP_HOP.has(k)) out[k] = v;
    res.writeHead(pres.statusCode || 502, pres.statusMessage, out);
    res.flushHeaders();
    pres.pipe(res);
  });
  preq.setTimeout(300000, () => preq.destroy(new Error('peer timeout')));
  preq.on('error', (e) => sendJson(res, 502, { error: `${node.name} unreachable: ${e.code || e.message}`, node: node.name }));
  res.on('close', () => { if (!res.writableFinished) preq.destroy(); });
  req.pipe(preq);
}

function rawResponse(socket, status, message, rawHeaders = [], body = '') {
  let head = `HTTP/1.1 ${status} ${message}\r\n`;
  for (let i = 0; i < rawHeaders.length; i += 2) head += `${rawHeaders[i]}: ${rawHeaders[i + 1]}\r\n`;
  socket.write(head + '\r\n');
  if (body) socket.write(body);
}

/** Refuse an upgrade with a JSON body (unknown app, app down, websockets disabled). */
export function rejectUpgrade(socket, status, error) {
  const body = JSON.stringify({ error });
  const msg = http.STATUS_CODES[status] || 'Error';
  if (socket.writable) rawResponse(socket, status, msg, ['Content-Type', 'application/json', 'Content-Length', String(Buffer.byteLength(body)), 'Connection', 'close'], body);
  socket.destroy();
}

/** Pipe an HTTP upgrade (WebSocket) to `target` as raw sockets; the handshake answer is passed back as-is. */
function pipeUpgrade(req, socket, head, target, headers, mapRawHeaders, label) {
  const lib = target.protocol === 'https:' || target.protocol === 'wss:' ? https : http;
  const preq = lib.request(target, { method: req.method, headers });
  const fail = (e) => rejectUpgrade(socket, 502, `${label} is not responding: ${e.code || e.message}`);
  preq.setTimeout(15000, () => preq.destroy(new Error('timeout')));
  preq.on('error', fail);
  preq.on('upgrade', (pres, psock, phead) => {
    preq.setTimeout(0);
    psock.setTimeout(0);
    socket.setTimeout(0);
    psock.setNoDelay(true);
    socket.setNoDelay(true);
    rawResponse(socket, pres.statusCode, pres.statusMessage || 'Switching Protocols', mapRawHeaders(pres.rawHeaders));
    if (phead?.length) socket.write(phead);
    if (head?.length) psock.write(head);
    psock.pipe(socket);
    socket.pipe(psock);
    const done = () => { psock.destroy(); socket.destroy(); };
    psock.on('error', done); socket.on('error', done);
    psock.on('close', done); socket.on('close', done);
  });
  preq.on('response', (pres) => {
    // The upstream answered without upgrading (auth wall, 404…): pass that answer through.
    rawResponse(socket, pres.statusCode, pres.statusMessage || '', mapRawHeaders(pres.rawHeaders.filter((_, i, a) => !(i % 2 === 0 && /^(connection|transfer-encoding)$/i.test(a[i])) && !(i % 2 === 1 && /^(connection|transfer-encoding)$/i.test(a[i - 1])))).concat(['Connection', 'close']));
    pres.pipe(socket);
  });
  socket.on('error', () => preq.destroy());
  preq.end();
}

/** WebSocket upgrade to an app on this node. */
export function proxyAppWs(req, socket, head, app, route, search = '') {
  if (app.rewrite?.websocket === false) return rejectUpgrade(socket, 404, `app ${app.id} does not accept WebSockets through the proxy`);
  const view = publicView(req, route);
  const upstreamPath = route.rest || '/';
  const ctx = appCtx(app, view, upstreamPath, search);
  const target = upstreamUrl(app, upstreamPath, search);
  const headers = appIdentityHeaders(appRequestHeaders(req, view, { upgrade: true }), ctx, upstreamPath);
  headers.host = target.host;
  const mapRaw = (raw) => {
    const out = [];
    for (let i = 0; i < raw.length; i += 2) {
      const k = raw[i].toLowerCase();
      if (k === 'set-cookie' && ctx.rewrite.cookies !== false) out.push(raw[i], rewriteSetCookie(raw[i + 1], ctx));
      else if (k === 'location') out.push(raw[i], rewriteLocation(raw[i + 1], ctx));
      else out.push(raw[i], raw[i + 1]);
    }
    return out;
  };
  pipeUpgrade(req, socket, head, target, headers, mapRaw, `app ${app.id} on ${app.node}`);
}

/** WebSocket upgrade relayed to the peer daemon that hosts the app. */
export function relayAppWs(node, req, socket, head, route, search = '') {
  const view = publicView(req, route);
  const target = new URL(node.url.replace(/\/$/, '') + route.prefix + (route.rest || '/') + search);
  const headers = appRequestHeaders(req, view, { upgrade: true });
  if (node.viaToken) headers['x-rigs-token'] = config().meshToken;
  headers['x-rigs-via'] = config().name;
  pipeUpgrade(req, socket, head, target, headers, (raw) => raw, node.name);
}

/**
 * Safety net for root-relative URLs the rewriter and shim could not catch (img.src = "/x" set from
 * script, CSS loaded by script, location.href = "/x"): a same-origin request outside any app prefix
 * whose Referer is inside one is sent back into that app. Returns the redirect target or null.
 */
export function appRefererRedirect(req) {
  const ref = req.headers.referer;
  if (!ref || !req.url || appRoute(new URL(req.url, 'http://x').pathname)) return null;
  let r;
  try { r = new URL(ref); } catch { return null; }
  if (r.host !== (String(req.headers['x-forwarded-host'] || '').split(',')[0].trim() || req.headers.host)) return null;
  const route = appRoute(r.pathname);
  if (!route || route.rest === undefined) return null;
  return route.prefix + req.url;
}
