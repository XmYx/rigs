// App proxy tests (src/proxy.js): rewriting helpers, then two real daemons — "front" relays to
// "app-node", which hosts a fake web app — exercising HTTP, redirects, cookies, HTML, SSE and WebSockets.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';
import WebSocket, { WebSocketServer } from 'ws';

process.env.RIGS_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'rigs-proxy-unit-'));
process.env.RIGS_NAME = 'unit-node';
const P = await import('../src/proxy.js');
const { isSelfRef } = await import('../src/apps.js');
const { config } = await import('../src/config.js');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PREFIX = '/api/nodes/app-node/apps/demo';
const ctx = (over = {}) => ({
  prefix: PREFIX, publicOrigin: 'http://front:4719', publicProto: 'http', targetOrigin: 'http://127.0.0.1:8787', targetPath: '',
  upstreamPath: '/a/b', documentUrl: PREFIX + '/a/b?q=1', rewrite: {}, shim: true, ...over,
});

// ---------------------------------------------------------------- pure helpers

test('appRoute: parses node, app and rest; ignores other node routes', () => {
  assert.deepEqual(P.appRoute('/api/nodes/mac/apps/szuf/x/y'), { nodeRef: 'mac', appId: 'szuf', rest: '/x/y', prefix: '/api/nodes/mac/apps/szuf' });
  assert.equal(P.appRoute('/api/nodes/mac/apps/szuf').rest, undefined);
  assert.equal(P.appRoute('/api/nodes/mac/apps'), null, 'the app list endpoint is not a proxy route');
  assert.equal(P.appRoute('/api/nodes/mac/files'), null);
});

test('isSelfRef: this node by name, id or alias, without waiting for discovery', () => {
  for (const ref of ['self', 'local', '', 'unit-node', 'UNIT-NODE', config().nodeId]) assert.equal(isSelfRef(ref), true, ref);
  assert.equal(isSelfRef('other-node'), false);
});

test('rewriteLocation: root-relative and app-absolute → prefixed; foreign hosts untouched', () => {
  const c = ctx();
  assert.equal(P.rewriteLocation('/login?next=/x', c), PREFIX + '/login?next=/x');
  assert.equal(P.rewriteLocation('http://127.0.0.1:8787/done#ok', c), PREFIX + '/done#ok');
  assert.equal(P.rewriteLocation('http://front:4719/x', c), PREFIX + '/x', 'app that honours X-Forwarded-Host but not the prefix');
  assert.equal(P.rewriteLocation(PREFIX + '/already', c), PREFIX + '/already', 'never double-prefixed');
  assert.equal(P.rewriteLocation('c', c), PREFIX + '/a/c', 'relative to the request path');
  assert.equal(P.rewriteLocation('https://example.com/x', c), 'https://example.com/x');
  const based = ctx({ targetOrigin: 'http://127.0.0.1:3000', targetPath: '/base' });
  assert.equal(P.rewriteLocation('/base/inner', based), PREFIX + '/inner', 'url-form targets strip their own base path');
});

test('rewriteSetCookie: Path under the prefix, Domain dropped, Secure dropped on http', () => {
  const c = ctx();
  assert.equal(P.rewriteSetCookie('sid=1; Path=/; Domain=127.0.0.1; HttpOnly', c), `sid=1; Path=${PREFIX}/; HttpOnly`);
  assert.equal(P.rewriteSetCookie('pref=2; path=/settings', c), `pref=2; Path=${PREFIX}/settings`);
  assert.equal(P.rewriteSetCookie('bare=3', c), `bare=3; Path=${PREFIX}/`);
  assert.equal(P.rewriteSetCookie('x=1; Secure; SameSite=None', c), `x=1; SameSite=Lax; Path=${PREFIX}/`);
  assert.equal(P.rewriteSetCookie('x=1; Secure; SameSite=None', ctx({ publicProto: 'https' })), `x=1; Secure; SameSite=None; Path=${PREFIX}/`);
});

test('rewriteResponseHeaders: frame blockers removed, other CSP kept', () => {
  const h = P.rewriteResponseHeaders({ 'x-frame-options': 'DENY', 'content-security-policy': "default-src 'self'; frame-ancestors 'none'", 'content-length': '5', connection: 'close' }, ctx(), { transformed: true });
  assert.equal(h['x-frame-options'], undefined);
  assert.deepEqual(h['content-security-policy'], ["default-src 'self'"]);
  assert.equal(h['content-length'], undefined);
  assert.equal(h.connection, undefined);
  assert.equal(P.rewriteResponseHeaders({ etag: '"abc"' }, ctx(), { transformed: true }).etag, 'W/"abc"', 'rewritten bodies only keep a weak validator');
  assert.equal(P.rewriteResponseHeaders({ 'content-security-policy': "frame-ancestors 'self'" }, ctx())['content-security-policy'], undefined);
});

async function runHtml(chunks, c = ctx()) {
  const out = [];
  await new Promise((resolve, reject) => {
    const t = P.htmlRewriter(c);
    t.on('data', (d) => out.push(d)).on('end', resolve).on('error', reject);
    Readable.from(chunks.map((s) => Buffer.from(s, 'latin1'))).pipe(t);
  });
  return Buffer.concat(out).toString('latin1');
}

test('htmlRewriter: shim first in <head>, neutral <base>, root-relative attributes, CSS url()', async () => {
  const html = await runHtml(['<!doctype html><html><head><title>t</title><link rel="stylesheet" href="/s.css"></head>',
    '<body><img src="/img/a.png" srcset="/a1.png 1x, /a2.png 2x"><a href=\'/x?y=1&amp;z=2\'>x</a><a href="rel">r</a><a href="//cdn.example/x">c</a>',
    '<form action="/lookup" method="post"></form><div style="background:url(/bg.png)"></div><script>fetch("/api")</script></body></html>']);
  assert.match(html, new RegExp(`<head><script src="${PREFIX}/__rigs-proxy/shim\\.js" data-prefix="${PREFIX}"></script><title>`));
  assert.match(html, new RegExp(`<base href="${PREFIX}/a/b\\?q=1"></head>`), 'base equals the document URL');
  assert.ok(html.includes(`href="${PREFIX}/s.css"`));
  assert.ok(html.includes(`src="${PREFIX}/img/a.png"`));
  assert.ok(html.includes(`srcset="${PREFIX}/a1.png 1x, ${PREFIX}/a2.png 2x"`));
  assert.ok(html.includes(`href='${PREFIX}/x?y=1&amp;z=2'`));
  assert.ok(html.includes('href="rel"') && html.includes('href="//cdn.example/x"'), 'relative and protocol-relative untouched');
  assert.ok(html.includes(`action="${PREFIX}/lookup"`));
  assert.ok(html.includes(`url(${PREFIX}/bg.png)`));
  assert.ok(html.includes('fetch("/api")'), 'script bodies are left to the runtime shim');
});

test('htmlRewriter: tags split across chunks, existing <base> rewritten, fragments get no shim', async () => {
  const split = await runHtml(['<html><he', 'ad></head><body><img s', 'rc="/a.png"></body></html>']);
  assert.ok(split.includes(`src="${PREFIX}/a.png"`));
  assert.ok(split.includes('shim.js'));
  const based = await runHtml(['<html><head><base href="/app/"></head><body></body></html>']);
  assert.ok(based.includes(`<base href="${PREFIX}/app/">`));
  assert.equal((based.match(/<base /g) || []).length, 1, 'no second base when the page has one');
  const frag = await runHtml(['<tr><td><a href="/row/1">1</a></td></tr>']);
  assert.ok(!frag.includes('shim.js') && !frag.includes('<base'), 'partial HTML (htmx, fetch) is not a document');
  assert.ok(frag.includes(`href="${PREFIX}/row/1"`));
  const latin = await runHtml([Buffer.from('<html><head></head><body>ÁRVÍZTŰRŐ ✓</body></html>', 'utf8').toString('latin1')]);
  assert.ok(Buffer.from(latin, 'latin1').toString('utf8').includes('ÁRVÍZTŰRŐ ✓'), 'non-ASCII bytes survive');
});

test('rewriteCss: url() and @import', () => {
  const css = P.rewriteCss('a{background:url("/i.png")} b{background:url(rel.png)} @import "/x.css"; c{src:url(//cdn/x)}', ctx());
  assert.ok(css.includes(`url("${PREFIX}/i.png")`));
  assert.ok(css.includes('url(rel.png)') && css.includes('url(//cdn/x)'));
  assert.ok(css.includes(`@import "${PREFIX}/x.css"`));
});

test('appRefererRedirect: escaped same-origin requests go back into the app', () => {
  const req = (url, referer, host = 'front:4719') => ({ url, headers: { host, referer } });
  assert.equal(P.appRefererRedirect(req('/img/a.png?v=1', `http://front:4719${PREFIX}/page`)), `${PREFIX}/img/a.png?v=1`);
  assert.equal(P.appRefererRedirect(req('/api/nodes', 'http://front:4719/')), null, 'JARVIS itself is never redirected');
  assert.equal(P.appRefererRedirect(req('/x', `http://other:1${PREFIX}/page`)), null, 'cross-origin referer ignored');
  assert.equal(P.appRefererRedirect(req(`${PREFIX}/x`, `http://front:4719${PREFIX}/page`)), null);
});

// ---------------------------------------------------------------- end to end: front → app-node → fake app

const TOKEN = 'proxy-test-token';
const homes = [];
const procs = [];
let appServer;
let appPort;
let releaseSse = () => {};
const B_PORT = 20000 + Math.floor(Math.random() * 20000);
const A_PORT = B_PORT + 1;
const DEAD_PORT = B_PORT + 2;
// A non-loopback, non-tailnet address lets us prove the app-node daemon authorizes the relayed hop itself.
const LAN = Object.values(os.networkInterfaces()).flat().find((i) => i && i.family === 'IPv4' && !i.internal && !/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(i.address))?.address;
const B_HOST = LAN || '127.0.0.1';
const A = `http://127.0.0.1:${A_PORT}`;
const B = `http://127.0.0.1:${B_PORT}`;
const VIA_A = `${A}/api/nodes/app-node/apps/demo`;
const VIA_B = `${B}/api/nodes/self/apps/demo`;

function fakeApp() {
  const server = http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://x');
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks).toString();
    const page = '<!doctype html><html><head><title>demo</title></head><body><img src="/logo.png"><form action="/lookup"></form></body></html>';
    switch (u.pathname) {
      case '/': res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'x-frame-options': 'SAMEORIGIN', 'content-security-policy': "default-src 'self'; frame-ancestors 'none'" }); return res.end(page);
      case '/gz': res.writeHead(200, { 'content-type': 'text/html', 'content-encoding': 'gzip' }); return res.end(zlib.gzipSync(page));
      case '/echo': res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ method: req.method, url: req.url, headers: req.headers, body }));
      case '/redirect': res.writeHead(302, { location: '/login?next=%2F' }); return res.end();
      case '/redirect-abs': res.writeHead(301, { location: `http://127.0.0.1:${appPort}/abs` }); return res.end();
      case '/cookie': res.writeHead(200, { 'set-cookie': ['sid=abc; Path=/; Domain=127.0.0.1; HttpOnly', 'pref=2; Path=/settings', 'bare=3'] }); return res.end('ok');
      case '/logo.png': res.writeHead(200, { 'content-type': 'image/png' }); return res.end(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
      case '/sse':
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
        res.write('data: one\n\n');
        releaseSse = () => { res.write('data: two\n\n'); res.end(); };
        return undefined;
      default: res.writeHead(404); return res.end('nope');
    }
  });
  const wss = new WebSocketServer({ server });
  wss.on('connection', (ws, req) => {
    ws.send(JSON.stringify({ path: req.url, origin: req.headers.origin || null, cookie: req.headers.cookie || null, token: req.headers['x-rigs-token'] || null }));
    ws.on('message', (d, bin) => ws.send(d, { binary: bin }));
  });
  return server;
}

function daemon(name, port, extraEnv, cfg) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), `rigs-proxy-${name}-`));
  homes.push(home);
  if (cfg) fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify(cfg));
  const env = { ...process.env, RIGS_NO_MIGRATIONS: '1', RIGS_NO_AUTOUPDATE: '1', RIGS_NO_OPENRIG: '1', RIGS_HOME: home, RIGS_SSH_DIR: path.join(home, 'ssh'), RIGS_PORT: String(port), RIGS_NAME: name, RIGS_PEERS: '', RIGS_MESH_TOKEN: TOKEN, RIGS_BIND: '127.0.0.1', ...extraEnv };
  const p = spawn(process.execPath, [path.join(ROOT, 'bin/rigs.js'), 'serve'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  p.log = '';
  p.stdout.on('data', (d) => { p.log += d; });
  p.stderr.on('data', (d) => { p.log += d; });
  procs.push(p);
  return p;
}

async function waitFor(fn, what, proc) {
  for (let i = 0; i < 150; i++) {
    try { if (await fn()) return; } catch {}
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`${what} never became ready\n${proc?.log || ''}`);
}

before(async () => {
  appServer = fakeApp();
  await new Promise((r) => appServer.listen(0, '127.0.0.1', r));
  appPort = appServer.address().port;
  const b = daemon('app-node', B_PORT, { RIGS_BIND: LAN ? `127.0.0.1,${LAN}` : '127.0.0.1' }, {
    apps: [{ id: 'demo', name: 'Demo', port: appPort }, { id: 'dead', name: 'Dead', port: DEAD_PORT }, { id: 'nows', port: appPort, rewrite: { websocket: false } }],
  });
  await waitFor(async () => (await fetch(B + '/api/self')).ok, 'app-node', b);
  const a = daemon('front', A_PORT, { RIGS_PEERS: `http://${B_HOST}:${B_PORT}` });
  await waitFor(async () => (await fetch(A + '/api/self')).ok, 'front', a);
  await waitFor(async () => {
    const nodes = await (await fetch(A + '/api/mesh/refresh', { method: 'POST' })).json();
    return nodes.some((n) => n.name === 'app-node' && n.online && n.rigs);
  }, 'front discovering app-node', a);
});

after(() => {
  for (const p of procs) p.kill();
  appServer?.close();
  for (const h of homes) fs.rmSync(h, { recursive: true, force: true });
});

test('routing: bare prefix redirects to the slash, unknown app 404, unknown node 404, app down 502 (JSON)', async () => {
  const bare = await fetch(`${A}/api/nodes/app-node/apps/demo?x=1`, { redirect: 'manual' });
  assert.equal(bare.status, 308);
  assert.equal(bare.headers.get('location'), '/api/nodes/app-node/apps/demo/?x=1');
  for (const base of [A + '/api/nodes/app-node', B + '/api/nodes/self']) {
    const missing = await fetch(`${base}/apps/nope/`);
    assert.equal(missing.status, 404);
    assert.match((await missing.json()).error, /unknown app nope/);
    const dead = await fetch(`${base}/apps/dead/`);
    assert.equal(dead.status, 502);
    assert.match((await dead.json()).error, /dead .*not responding/);
  }
  const noNode = await fetch(`${A}/api/nodes/ghost/apps/demo/`);
  assert.equal(noNode.status, 404);
  assert.match((await noNode.json()).error, /unknown node ghost/);
});

test('HTTP: method, path, query and body reach the app; forwarded headers set; mesh credentials stripped', async () => {
  for (const [via, host] of [[VIA_A, `127.0.0.1:${A_PORT}`], [VIA_B, `127.0.0.1:${B_PORT}`]]) {
    const r = await fetch(`${via}/echo?a=1&b=%2F`, { method: 'POST', body: 'hello app', headers: { 'x-rigs-token': TOKEN, cookie: 'sid=abc', origin: `http://${host}` } });
    assert.equal(r.status, 200);
    const e = await r.json();
    assert.equal(e.method, 'POST');
    assert.equal(e.url, '/echo?a=1&b=%2F');
    assert.equal(e.body, 'hello app');
    assert.equal(e.headers['x-forwarded-prefix'], via.slice(via.indexOf('/api/')));
    assert.equal(e.headers['x-forwarded-host'], host, 'the browser-facing host, even after the relay hop');
    assert.equal(e.headers['x-forwarded-proto'], 'http');
    assert.equal(e.headers.host, `127.0.0.1:${appPort}`);
    assert.equal(e.headers.origin, `http://127.0.0.1:${appPort}`, 'Origin points at the app for CSRF checks');
    assert.equal(e.headers.cookie, 'sid=abc', 'app cookies pass through');
    assert.equal(e.headers['x-rigs-token'], undefined, 'the mesh token never reaches an app');
  }
});

test('redirects: Location rewritten into the prefix (root-relative and absolute)', async () => {
  const r1 = await fetch(`${VIA_A}/redirect`, { redirect: 'manual' });
  assert.equal(r1.status, 302);
  assert.equal(r1.headers.get('location'), `${PREFIX}/login?next=%2F`);
  const r2 = await fetch(`${VIA_B}/redirect-abs`, { redirect: 'manual' });
  assert.equal(r2.status, 301);
  assert.equal(r2.headers.get('location'), '/api/nodes/self/apps/demo/abs');
});

test('cookies: Set-Cookie Path moved under the prefix and Domain dropped', async () => {
  const r = await fetch(`${VIA_A}/cookie`);
  assert.deepEqual(r.headers.getSetCookie(), [`sid=abc; Path=${PREFIX}/; HttpOnly`, `pref=2; Path=${PREFIX}/settings`, `bare=3; Path=${PREFIX}/`]);
});

test('HTML: rewritten and frameable through the relay, gzip decoded, shim served, binary untouched', async () => {
  const r = await fetch(`${VIA_A}/`);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('x-frame-options'), null);
  assert.equal(r.headers.get('content-security-policy'), "default-src 'self'");
  const html = await r.text();
  assert.ok(html.includes(`<script src="${PREFIX}/__rigs-proxy/shim.js" data-prefix="${PREFIX}"></script>`));
  assert.ok(html.includes(`<base href="${PREFIX}/">`));
  assert.ok(html.includes(`src="${PREFIX}/logo.png"`) && html.includes(`action="${PREFIX}/lookup"`));
  const gz = await (await fetch(`${VIA_A}/gz`, { headers: { 'accept-encoding': 'gzip' } })).text();
  assert.ok(gz.includes(`src="${PREFIX}/logo.png"`), 'compressed HTML is decoded and rewritten');
  const shim = await fetch(`${VIA_A}/__rigs-proxy/shim.js`);
  assert.match(shim.headers.get('content-type'), /javascript/);
  assert.match(await shim.text(), /XMLHttpRequest\.prototype\.open/);
  const png = Buffer.from(await (await fetch(`${VIA_A}/logo.png`)).arrayBuffer());
  assert.deepEqual([...png], [0x89, 0x50, 0x4e, 0x47]);
});

test('escaped root-relative request with an app Referer is sent back into the app', async () => {
  const r = await fetch(`${A}/logo.png?v=2`, { redirect: 'manual', headers: { referer: `${VIA_A}/page` } });
  assert.equal(r.status, 307);
  assert.equal(r.headers.get('location'), `${PREFIX}/logo.png?v=2`);
});

test('SSE streams through both hops without buffering', async () => {
  const r = await fetch(`${VIA_A}/sse`);
  assert.equal(r.headers.get('content-type'), 'text/event-stream');
  const reader = r.body.getReader();
  const dec = new TextDecoder();
  let got = '';
  while (!got.includes('data: one')) got += dec.decode((await reader.read()).value);
  assert.ok(!got.includes('two'), 'first event arrives while the app is still holding the stream open');
  releaseSse();
  for (;;) { const { value, done } = await reader.read(); if (done) break; got += dec.decode(value); }
  assert.match(got, /data: one\n\n[\s\S]*data: two\n\n/);
});

async function wsOpen(url, opts) {
  const ws = new WebSocket(url, opts);
  const msgs = [];
  ws.on('message', (d, bin) => msgs.push(bin ? d : d.toString()));
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); ws.once('unexpected-response', (_q, res) => reject(new Error(`HTTP ${res.statusCode}`))); });
  const next = async () => { for (let i = 0; i < 100 && !msgs.length; i++) await new Promise((r) => setTimeout(r, 30)); return msgs.shift(); };
  return { ws, next };
}

test('WebSocket echo through the relay and locally (text + binary), Origin and cookies passed', async () => {
  for (const via of [VIA_A, VIA_B]) {
    const { ws, next } = await wsOpen(via.replace('http', 'ws') + '/ws?room=1', { headers: { cookie: 'sid=abc', 'x-rigs-token': TOKEN }, origin: new URL(via).origin });
    const hello = JSON.parse(await next());
    assert.equal(hello.path, '/ws?room=1');
    assert.equal(hello.origin, `http://127.0.0.1:${appPort}`);
    assert.equal(hello.cookie, 'sid=abc');
    assert.equal(hello.token, null, 'mesh token stripped on the way to the app');
    ws.send('ping');
    assert.equal(await next(), 'ping');
    ws.send(Buffer.from([1, 2, 3]), { binary: true });
    assert.deepEqual([...(await next())], [1, 2, 3]);
    ws.close();
  }
});

test('WebSocket: unknown app 404, app down 502, websocket disabled 404', async () => {
  const status = (url) => new Promise((resolve) => {
    const ws = new WebSocket(url);
    ws.on('unexpected-response', (_q, res) => { resolve(res.statusCode); ws.terminate(); });
    ws.on('open', () => { resolve(101); ws.close(); });
    ws.on('error', () => resolve('error'));
  });
  assert.equal(await status(`ws://127.0.0.1:${A_PORT}/api/nodes/app-node/apps/nope/ws`), 404);
  assert.equal(await status(`ws://127.0.0.1:${A_PORT}/api/nodes/app-node/apps/dead/ws`), 502);
  assert.equal(await status(`ws://127.0.0.1:${B_PORT}/api/nodes/self/apps/nows/ws`), 404);
});

test('auth: callers who fail src/auth.js are rejected for HTTP and WebSocket', async () => {
  const stranger = { 'tailscale-user-login': 'stranger@example.com' };
  const r = await fetch(`${VIA_A}/echo`, { headers: stranger });
  assert.equal(r.status, 403);
  const code = await new Promise((resolve) => {
    const ws = new WebSocket(VIA_A.replace('http', 'ws') + '/ws', { headers: stranger });
    ws.on('unexpected-response', (_q, res) => resolve(res.statusCode));
    ws.on('open', () => { resolve(101); ws.close(); });
    ws.on('error', () => resolve('error'));
  });
  assert.equal(code, 403);
});

test('auth: the hosting node authorizes the relayed hop itself (mesh token required off-tailnet)', { skip: !LAN && 'no non-loopback, non-tailnet IPv4 address to test with' }, async () => {
  const direct = `http://${LAN}:${B_PORT}/api/nodes/self/apps/demo/echo`;
  const denied = await fetch(direct);
  assert.equal(denied.status, 403, 'a LAN caller without the mesh token is refused by app-node');
  const ok = await fetch(direct, { headers: { 'x-rigs-token': TOKEN } });
  assert.equal(ok.status, 200);
  // front reached app-node over that same LAN address in every relayed test above, so it presented the token.
  const relayed = await (await fetch(`${VIA_A}/echo`)).json();
  assert.equal(relayed.headers['x-rigs-token'], undefined);
});
