import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { WebSocketServer } from 'ws';
import { authorize, clientIp, isLoopback } from './auth.js';
import * as chat from './chat.js';
import { config, patchConfig, publicConfig } from './config.js';
import * as desktop from './desktop.js';
import { Discovery } from './discovery.js';
import * as files from './files.js';
import * as openrig from './openrig.js';
import { forwardHttp, forwardWs, peerJson } from './proxy.js';
import * as pty from './pty.js';
import * as sessions from './sessions.js';
import * as ssh from './ssh.js';
import { stats, systemInfo } from './system.js';
import * as ts from './tailscale.js';
import { detectTools, ollamaModels } from './tools.js';
import * as updater from './updater.js';
import { APP_DIR, isWin, log, run, truncate } from './util.js';

const UI_DIR = path.join(APP_DIR, 'ui');
const STATIC_TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json', '.woff2': 'font/woff2', '.map': 'application/json' };

class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }

function json(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(body);
}

async function readBody(req, limit = 5 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > limit) throw new HttpError(413, 'body too large');
    chunks.push(c);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  if (!text) return {};
  try { return JSON.parse(text); } catch { throw new HttpError(400, 'invalid JSON'); }
}

// ---------------------------------------------------------------- node identity
let versionCache = { at: 0, v: null };
async function appVersion() {
  if (Date.now() - versionCache.at > 30000) versionCache = { at: Date.now(), v: await updater.version() };
  return versionCache.v;
}

function compactTools(t) {
  const pick = (k) => (t[k]?.installed ? (t[k].version || 'yes') : null);
  return {
    claude: pick('claude'), codex: pick('codex'), ollama: pick('ollama'), rig: pick('rig'), tmux: pick('tmux'),
    rea: t.rea?.available ? (t.rea.version || 'registered') : null, reaRegistered: t.reaRegistered, rigsRegistered: t.rigsRegistered,
    sunshine: pick('sunshine'), moonlight: t.moonlight?.installed ? 'yes' : null, tailscale: t.tailscale?.installed ? 'yes' : null,
    git: pick('git'), gh: pick('gh'), ssh: pick('ssh'),
  };
}

async function selfInfo() {
  const cfg = config();
  const [sys, st, tools, tsStatus, ver] = await Promise.all([systemInfo(), stats(), detectTools(), ts.status(), appVersion()]);
  const ip = tsStatus?.self?.ips?.find((x) => x.includes('.'));
  return {
    id: cfg.nodeId, name: cfg.name, version: ver.short, versionInfo: ver, port: cfg.port,
    url: `http://${ip || '127.0.0.1'}:${cfg.port}`,
    ...sys, stats: st, tools: compactTools(tools), ptyAvailable: pty.ptyAvailable(),
    tailscale: tsStatus ? { ip, dnsName: tsStatus.self.dnsName, login: tsStatus.self.login, state: tsStatus.backendState } : null,
    sshPubKey: ssh.publicKey(), sshUser: ssh.sshUser(), sshAlias: cfg.name,
  };
}

// ---------------------------------------------------------------- server
export async function startServer() {
  const cfg = config();
  await ssh.ensureKey().catch(() => null);
  const discovery = new Discovery(selfInfo);
  const uiSockets = new Set();
  const broadcast = (msg) => { const s = JSON.stringify(msg); for (const w of uiSockets) if (w.readyState === 1) w.send(s); };

  discovery.on('change', async (nodes) => {
    broadcast({ type: 'mesh', nodes: nodes.map(stripNode) });
    try {
      const r = await ssh.syncPeers(nodes);
      if (r.authorized || r.aliases) log(`ssh: ${r.authorized} peer key(s) authorized, ${r.aliases} alias(es) in ~/.ssh/config`);
      if (config().openrig.registerPeers) {
        const o = await openrig.registerPeers(nodes.filter((n) => !n.self && n.rigs).map((n) => ({ name: n.name, sshAlias: n.sshAlias || n.name, rigsTools: { rig: !!n.tools?.rig } })));
        if (o.added?.length) log(`openrig: registered host(s) ${o.added.join(', ')}`);
      }
    } catch (e) { log('peer sync failed:', e.message); }
  });

  function stripNode(n) {
    const { viaToken, ...rest } = n;
    return rest;
  }

  function meshSummary() {
    return discovery.list().map((n) => `- ${n.name}${n.self ? ' (this machine)' : ''}: ${n.platform || '?'} ${n.online ? 'online' : 'offline'}${n.rigs ? '' : ' (no RIGS agent)'}${n.tools ? ` · agents: ${['claude', 'codex', 'ollama', 'rig', 'rea'].filter((k) => n.tools[k]).join(', ') || 'none'}` : ''}${n.stats ? ` · cpu ${n.stats.cpu}% mem ${Math.round((n.stats.memUsed / n.stats.memTotal) * 100)}%` : ''}`).join('\n');
  }

  async function snapshotFor(node) {
    const get = (p) => (node.self ? localCall(p) : peerJson(node, p, { timeout: 7000 }));
    const [sess, brains, rig, info] = await Promise.all([
      get('sessions').catch(() => []), get('brains').catch(() => []), get('openrig').catch(() => null), node.self ? selfInfo() : get('info').catch(() => node),
    ]);
    return { node: stripNode({ ...node, ...info, self: node.self, url: node.url, online: true }), sessions: sess, brains, openrig: rig };
  }

  // Local handlers are invoked directly for the self node so the gateway never loops over HTTP.
  async function localCall(p, method = 'GET', body) {
    const fake = { method, url: '/api/local/' + p, body };
    return localApi(fake, null, p.split('?')[0], new URL('http://x/' + p).searchParams, body);
  }

  async function localApi(req, res, sub, q, preBody) {
    const method = req.method;
    const body = () => (preBody !== undefined ? Promise.resolve(preBody) : readBody(req));
    const m = (re) => sub.match(re);
    let mm;

    if (sub === 'info') return selfInfo();
    if (sub === 'stats') return stats();
    if (sub === 'tools') return detectTools(q.get('force') === '1');
    if (sub === 'config' && method === 'GET') return publicConfig();
    if (sub === 'config' && method === 'POST') { patchConfig(await body()); return publicConfig(); }

    // files
    if (sub === 'files' && method === 'GET') return files.list(q.get('path') || '~', { showHidden: q.get('hidden') === '1' || config().files.showHidden });
    if (sub === 'files/read') return files.readText(q.get('path'));
    if (sub === 'files/raw') { if (!res) throw new HttpError(400, 'stream only'); await files.sendFile(q.get('path'), res, { download: q.get('download') === '1' }); return undefined; }
    if (sub === 'files/write' && method === 'PUT') return files.writeStream(q.get('path'), req);
    if (sub === 'files/text' && method === 'POST') { const b = await body(); return files.writeText(b.path, b.text ?? ''); }
    if (sub === 'files/mkdir' && method === 'POST') return files.mkdir((await body()).path);
    if (sub === 'files/rename' && method === 'POST') { const b = await body(); return files.rename(b.from, b.to); }
    if (sub === 'files/trash' && method === 'POST') return files.trash((await body()).path);

    // terminals
    if (sub === 'pty' && method === 'GET') return pty.listPtys();
    if (sub === 'pty' && method === 'POST') {
      const b = await body();
      const spec = b.command ? pty.shellWrap(b.command) : {};
      const p = pty.createPty({ ...spec, cwd: b.cwd ? files.resolvePath(b.cwd) : undefined, cols: b.cols, rows: b.rows, title: b.title || (b.command ? truncate(b.command, 40) : undefined), kind: b.kind || 'shell', meta: b.meta || {} });
      return { id: p.id, title: p.title };
    }
    if ((mm = m(/^pty\/([\w]+)\/kill$/)) && method === 'POST') return { ok: pty.killPty(mm[1]) };
    if ((mm = m(/^pty\/([\w]+)\/input$/)) && method === 'POST') {
      const p = pty.getPty(mm[1]);
      if (!p || p.exited) throw new HttpError(404, 'terminal not running');
      const b = await body();
      p.write(String(b.data ?? '') + (b.enter ? '\r' : ''));
      return { ok: true };
    }
    if ((mm = m(/^pty\/([\w]+)\/output$/))) return { text: pty.ptyTranscript(mm[1], Number(q.get('max') || 20000)) };

    // sessions & agents
    if (sub === 'sessions') return sessions.listSessions({ chats: await chat.listChats() });
    if (sub === 'sessions/transcript') {
      const kind = q.get('kind');
      const id = q.get('id');
      if (kind === 'chat') { const c = await chat.getChat(id); if (!c) throw new HttpError(404, 'not found'); return c.messages.map((x) => ({ role: x.role, text: x.text, ts: x.ts, name: x.brain })); }
      const t = await sessions.transcript(kind, id);
      if (!t) throw new HttpError(404, 'session not found');
      return t;
    }
    if (sub === 'sessions/send' && method === 'POST') { const b = await body(); return sessions.send(b.kind, b.id, b.text); }
    if (sub === 'sessions/attach' && method === 'POST') { const b = await body(); return sessions.attach(b.kind, b.id, b); }
    if (sub === 'agents/start' && method === 'POST') return sessions.startAgent(await body());

    // chats / brains
    if (sub === 'brains') return chat.availableBrains();
    if (sub === 'ollama') return ollamaModels();
    if (sub === 'chats' && method === 'GET') return chat.listChats();
    if (sub === 'chats' && method === 'POST') return chat.createChat(await body());
    if ((mm = m(/^chats\/([\w-]+)$/)) && method === 'GET') { const c = await chat.getChat(mm[1]); if (!c) throw new HttpError(404, 'not found'); return c; }
    if ((mm = m(/^chats\/([\w-]+)$/)) && method === 'DELETE') return { ok: await chat.deleteChat(mm[1]) };
    if ((mm = m(/^chats\/([\w-]+)\/send$/)) && method === 'POST') {
      const b = await body();
      if (!res) {
        let final = null;
        await chat.sendMessage(mm[1], b, (e) => { if (e.type === 'done' || e.type === 'error') final = { ...(final || {}), ...e }; }, { meshSummary: meshSummary() });
        return final;
      }
      res.writeHead(200, { 'content-type': 'application/x-ndjson; charset=utf-8', 'cache-control': 'no-store', 'x-accel-buffering': 'no' });
      const ac = new AbortController();
      res.on('close', () => { if (!res.writableEnded) ac.abort(); });
      const hb = setInterval(() => res.write('{"type":"ping"}\n'), 15000);
      try {
        await chat.sendMessage(mm[1], b, (e) => res.write(JSON.stringify(e) + '\n'), { meshSummary: meshSummary(), signal: ac.signal });
      } catch (e) {
        res.write(JSON.stringify({ type: 'error', message: e.message }) + '\n');
      } finally { clearInterval(hb); res.end(); }
      return undefined;
    }

    // remote command execution (used by the mesh MCP tools)
    if (sub === 'exec' && method === 'POST') {
      const b = await body();
      const timeout = Math.min(600, Number(b.timeoutSec) || 60) * 1000;
      const cwd = b.cwd ? files.resolvePath(b.cwd) : undefined;
      const r = isWin
        ? await run('powershell.exe', ['-NoProfile', '-Command', b.command], { cwd, timeout })
        : await run(pty.defaultShell().cmd, ['-lc', b.command], { cwd, timeout });
      return { code: r.code, stdout: truncate(r.stdout, 200000), stderr: truncate(r.stderr, 50000) };
    }

    // OpenRig
    if (sub === 'openrig') return openrig.status(q.get('force') === '1');

    // remote desktop
    if (sub === 'desktop') return { host: await desktop.hostInfo(), client: desktop.clientInfo() };
    if (sub === 'desktop/pin' && method === 'POST') { const b = await body(); return desktop.sunshinePin(b.pin, b.name); }

    // ssh
    if (sub === 'ssh') return { user: ssh.sshUser(), pubKey: ssh.publicKey(), server: await ssh.serverStatus(), alias: config().name };
    if (sub === 'ssh/sync' && method === 'POST') return ssh.syncPeers(discovery.list());

    // self-update
    if (sub === 'update' && method === 'GET') return { version: await appVersion(), last: q.get('check') === '1' ? await updater.check() : updater.lastCheckResult(), checkout: updater.isCheckout() };
    if (sub === 'update' && method === 'POST') {
      const b = await body();
      const r = await updater.apply({ force: !!b.force });
      if (r.restart) setTimeout(() => process.exit(updater.RESTART_CODE), 800);
      return r;
    }
    if (sub === 'restart' && method === 'POST') { setTimeout(() => process.exit(updater.RESTART_CODE), 500); return { ok: true }; }

    // notifications to the JARVIS UI on this node
    if (sub === 'notify' && method === 'POST') {
      const b = await body();
      broadcast({ type: 'notify', text: String(b.text || '').slice(0, 2000), speak: b.speak !== false, from: b.from || config().name, level: b.level || 'info' });
      return { ok: true, delivered: uiSockets.size };
    }

    throw new HttpError(404, `unknown endpoint ${method} /api/local/${sub}`);
  }

  async function meshApi(req, res, url) {
    const p = url.pathname;
    let mm;
    if (p === '/api/nodes') return discovery.list().map(stripNode);
    if (p === '/api/self') return { id: config().nodeId, name: config().name, via: req.rigsAuth };
    if (p === '/api/mesh/refresh' && req.method === 'POST') { await discovery.tick(); return discovery.list().map(stripNode); }
    if (p === '/api/mesh/snapshot') {
      const nodes = discovery.list().filter((n) => n.online && n.rigs);
      const results = await Promise.all(nodes.map((n) => snapshotFor(n).catch((e) => ({ node: stripNode(n), error: e.message, sessions: [], brains: [] }))));
      const offline = discovery.list().filter((n) => !(n.online && n.rigs)).map((n) => ({ node: stripNode(n), sessions: [], brains: [], offline: true }));
      return [...results, ...offline];
    }
    if (p === '/api/mesh/summary') return { text: meshSummary() };
    if (p === '/api/mesh/update' && req.method === 'POST') {
      const peers = discovery.list().filter((n) => !n.self && n.online && n.rigs);
      const results = await Promise.all(peers.map((n) => peerJson(n, 'update', { method: 'POST', body: {}, timeout: 15 * 60 * 1000 }).then((r) => ({ node: n.name, ...r })).catch((e) => ({ node: n.name, updated: false, message: e.message }))));
      const self = await updater.apply();
      if (self.restart) setTimeout(() => process.exit(updater.RESTART_CODE), 1200);
      return [{ node: config().name, ...self }, ...results];
    }
    if (p === '/api/mesh/notify' && req.method === 'POST') {
      const b = await readBody(req);
      const all = discovery.list().filter((n) => n.online && n.rigs);
      return Promise.all(all.map((n) => (n.self ? localCall('notify', 'POST', b) : peerJson(n, 'notify', { method: 'POST', body: b })).then((r) => ({ node: n.name, ...r })).catch((e) => ({ node: n.name, error: e.message }))));
    }
    if (p === '/api/desktop/connect' && req.method === 'POST') {
      // This node is where the person sits; launch the native viewer here, pointed at the target.
      const b = await readBody(req);
      const target = discovery.get(b.target);
      if (!target) throw new HttpError(404, 'unknown target');
      if (!isLoopback(clientIp(req)) && !req.headers['tailscale-user-login']) throw new HttpError(400, 'open the UI from this machine (localhost) to launch a native viewer here');
      const address = target.tailscale?.dnsName || target.tailscale?.ip || new URL(target.url || 'http://127.0.0.1').hostname;
      const host = target.self ? await desktop.hostInfo() : target.rigs ? (await peerJson(target, 'desktop').catch(() => ({}))).host : null;
      return desktop.connect({ address, platform: target.platform, method: b.method || 'auto', targetHost: host }, (pin) => (target.self ? desktop.sunshinePin(pin, config().name) : peerJson(target, 'desktop/pin', { method: 'POST', body: { pin, name: config().name } })));
    }
    if ((mm = p.match(/^\/api\/nodes\/([^/]+)\/(.+)$/))) {
      const node = discovery.get(decodeURIComponent(mm[1]));
      if (!node) throw new HttpError(404, 'unknown node ' + mm[1]);
      const rest = mm[2] + url.search;
      if (node.self) return localApi(req, res, mm[2], url.searchParams);
      if (!node.rigs || !node.online) throw new HttpError(503, `${node.name} is not running RIGS`);
      forwardHttp(node, req, res, rest);
      return undefined;
    }
    throw new HttpError(404, 'not found');
  }

  async function handler(req, res) {
    const url = new URL(req.url, 'http://localhost');
    try {
      if (!url.pathname.startsWith('/api/')) return serveStatic(url.pathname, res);
      const a = await authorize(req);
      if (!a.ok) throw new HttpError(403, `forbidden (${a.via}: ${a.who})`);
      req.rigsAuth = a;
      let out;
      if (url.pathname.startsWith('/api/local/')) out = await localApi(req, res, url.pathname.slice('/api/local/'.length), url.searchParams);
      else out = await meshApi(req, res, url);
      if (out !== undefined && !res.headersSent) json(res, 200, out);
    } catch (e) {
      const status = e.status || (e.code === 'ENOENT' ? 404 : e.code === 'EACCES' || e.code === 'EPERM' ? 403 : 500);
      if (!res.headersSent) json(res, status, { error: e.message });
      else res.end();
      if (status >= 500) log('error', req.method, url.pathname, e.stack || e.message);
    }
  }

  function serveStatic(p, res) {
    let rel = decodeURIComponent(p);
    if (rel === '/' || rel === '') rel = '/index.html';
    const file = path.normalize(path.join(UI_DIR, rel));
    if (!file.startsWith(UI_DIR)) { res.writeHead(403); res.end(); return; }
    fs.stat(file, (err, st) => {
      if (err || !st.isFile()) {
        // Single-page app: unknown routes fall back to index.html.
        const idx = path.join(UI_DIR, 'index.html');
        res.writeHead(200, { 'content-type': STATIC_TYPES['.html'] });
        fs.createReadStream(idx).pipe(res);
        return;
      }
      res.writeHead(200, { 'content-type': STATIC_TYPES[path.extname(file)] || 'application/octet-stream', 'cache-control': rel.startsWith('/dist/') ? 'no-cache' : 'no-store' });
      fs.createReadStream(file).pipe(res);
    });
  }

  const wss = new WebSocketServer({ noServer: true });

  async function onUpgrade(req, socket, head) {
    const url = new URL(req.url, 'http://localhost');
    const a = await authorize(req);
    if (!a.ok) { socket.write('HTTP/1.1 403 Forbidden\r\n\r\n'); socket.destroy(); return; }
    let mm;
    if (url.pathname === '/ws') {
      wss.handleUpgrade(req, socket, head, (ws) => {
        uiSockets.add(ws);
        ws.send(JSON.stringify({ type: 'hello', self: { id: config().nodeId, name: config().name }, nodes: discovery.list().map(stripNode) }));
        ws.on('close', () => uiSockets.delete(ws));
      });
      return;
    }
    if ((mm = url.pathname.match(/^\/api\/local\/pty\/(\w+)\/ws$/))) {
      wss.handleUpgrade(req, socket, head, (ws) => pty.attachWs(mm[1], ws));
      return;
    }
    if ((mm = url.pathname.match(/^\/api\/nodes\/([^/]+)\/pty\/(\w+)\/ws$/))) {
      const node = discovery.get(decodeURIComponent(mm[1]));
      if (!node) { socket.destroy(); return; }
      if (node.self) wss.handleUpgrade(req, socket, head, (ws) => pty.attachWs(mm[2], ws));
      else forwardWs(node, req, socket, head, `pty/${mm[2]}/ws`);
      return;
    }
    socket.destroy();
  }

  // Listen on loopback + Tailscale addresses (never 0.0.0.0 unless configured explicitly).
  const servers = new Map();
  async function bindAll() {
    const want = cfg.bind === 'auto' ? ['127.0.0.1', '::1', ...(await ts.selfIps())] : cfg.bind;
    for (const host of want) {
      if (servers.has(host)) continue;
      const srv = http.createServer(handler);
      srv.on('upgrade', (req, socket, head) => onUpgrade(req, socket, head).catch(() => socket.destroy()));
      srv.requestTimeout = 0;
      srv.keepAliveTimeout = 65000;
      servers.set(host, srv);
      await new Promise((resolve) => {
        srv.once('error', (e) => { servers.delete(host); if (host !== '::1') log(`cannot listen on ${host}:${cfg.port} — ${e.code}`); resolve(); });
        srv.listen(cfg.port, host, () => { log(`listening on http://${host.includes(':') ? `[${host}]` : host}:${cfg.port}`); resolve(); });
      });
    }
  }
  await bindAll();
  if (![...servers.keys()].some((h) => h === '127.0.0.1' || h === '0.0.0.0')) throw new Error(`could not bind port ${cfg.port} — is another RIGS instance running?`);
  if (cfg.bind === 'auto') setInterval(() => bindAll().catch(() => {}), 30000).unref();

  discovery.start();
  updater.startAutoUpdate((r) => {
    broadcast({ type: 'notify', text: `Updated to ${r.to}. Restarting.`, speak: false, from: config().name });
    setTimeout(() => process.exit(updater.RESTART_CODE), 1000);
  });
  // Live stats push for the HUD.
  setInterval(async () => { if (uiSockets.size) broadcast({ type: 'stats', id: config().nodeId, stats: await stats() }); }, 5000).unref();

  return { discovery, close: () => { for (const s of servers.values()) s.close(); discovery.stop(); } };
}
