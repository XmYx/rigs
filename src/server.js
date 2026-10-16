import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import http from 'node:http';
import path from 'node:path';
import { WebSocketServer } from 'ws';
import { authorize, clientIp, isLoopback } from './auth.js';
import * as access from './access.js';
import * as attention from './attention.js';
import { osNotify } from './osnotify.js';
import * as caps from './capabilities.js';
import * as appsReg from './apps.js';
import * as chat from './chat.js';
import { config, loadConfig, patchConfig, publicConfig, RIGS_HOME, saveConfig } from './config.js';
import * as desktop from './desktop.js';
import * as desktopInstall from './desktop-install.js';
import * as merge from './merge.js';
import * as migrations from './migrations.js';
import * as rootsteps from './rootsteps.js';
import { Discovery } from './discovery.js';
import * as files from './files.js';
import * as models from './models.js';
import * as openrig from './openrig.js';
import * as planner from './planner.js';
import { forwardHttp, forwardWs, peerJson } from './proxy.js';
import * as pty from './pty.js';
import * as sessions from './sessions.js';
import * as ssh from './ssh.js';
import { stats, systemInfo } from './system.js';
import * as ts from './tailscale.js';
import * as tts from './tts.js';
import { detectTools, ollamaModels } from './tools.js';
import * as updater from './updater.js';
import { APP_DIR, isWin, log, run, truncate } from './util.js';
import * as work from './work.js';

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
  const [sys, st, tools, tsStatus, ver, capabilities] = await Promise.all([systemInfo(), stats(), detectTools(), ts.status(), appVersion(), caps.capabilities()]);
  const ip = tsStatus?.self?.ips?.find((x) => x.includes('.'));
  return {
    id: cfg.nodeId, name: cfg.name, version: ver.short, versionInfo: ver, port: cfg.port,
    url: `http://${ip || '127.0.0.1'}:${cfg.port}`,
    ...sys, stats: st, tools: compactTools(tools), capabilities, ptyAvailable: pty.ptyAvailable(),
    tailscale: tsStatus ? { ip, dnsName: tsStatus.self.dnsName, login: tsStatus.self.login, state: tsStatus.backendState } : null,
    sshPubKey: ssh.publicKey(), sshUser: ssh.sshUser(), sshAlias: cfg.name,
    canPush: await merge.canPush().catch(() => false),
    desktopInstall: await desktopInstall.status().then((d) => ({ state: d.state, command: d.command, note: d.note, sunshine: d.sunshine, moonlight: d.moonlight, steps: d.steps.slice(-4) })).catch(() => null),
    rootSteps: rootsteps.pending(),
    access: await access.status().then((a) => ({ ok: a.ok, home: a.home, blocked: a.blocked, fullDiskAccess: a.fullDiskAccess, controlledFolderAccess: a.controlledFolderAccess, runtime: a.runtime })).catch(() => null),
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

  /** Stable address for streaming: the tailnet IP (MagicDNS name only as a fallback). */
  function desktopAddress(t) {
    return t.tailscale?.ip || t.tailscale?.dnsName || new URL(t.url || 'http://127.0.0.1').hostname;
  }

  /** Launch a viewer on THIS machine for `targetRef`, pairing Moonlight with its Sunshine if needed. */
  async function connectDesktop(targetRef, method = 'auto') {
    const target = discovery.get(targetRef);
    if (!target) throw new HttpError(404, 'unknown machine ' + targetRef);
    if (target.self) throw new HttpError(400, 'that is this machine — pick another one to view');
    const host = target.rigs ? (await peerJson(target, 'desktop').catch(() => ({}))).host : null;
    const myAddress = (await ts.selfIps()).find((x) => x.includes('.')) || '';
    const r = await desktop.connect({ address: desktopAddress(target), platform: target.platform, method: method || 'auto', targetHost: host, myAddress },
      (pin, addr) => peerJson(target, 'desktop/pin', { method: 'POST', body: { pin, name: config().name, clientAddress: addr }, timeout: 45000 }));
    log(`desktop: ${config().name} → ${target.name}: ${r.ok ? 'ok' : 'failed'} (${[...r.steps, r.message].join('; ')})`);
    return { ...r, viewer: config().name, target: target.name };
  }

  async function rolloutAll() {
    const peers = discovery.list().filter((n) => !n.self && n.online && n.rigs);
    const results = await Promise.all(peers.map((n) => peerJson(n, 'update', { method: 'POST', body: {}, timeout: 15 * 60 * 1000 }).then((r) => ({ node: n.name, ...r })).catch((e) => ({ node: n.name, updated: false, message: e.message }))));
    const self = await updater.apply();
    if (self.restart) setTimeout(() => process.exit(updater.RESTART_CODE), 1200);
    return [{ node: config().name, ...self }, ...results];
  }

  /** Download a binary from a peer's local API to a file (git bundles for the merge steward). */
  async function peerDownload(node, localPath, dest) {
    const headers = node.viaToken ? { 'x-rigs-token': config().meshToken } : {};
    const r = await fetch(node.url.replace(/\/$/, '') + '/api/local/' + localPath, { headers, signal: AbortSignal.timeout(10 * 60 * 1000) });
    if (!r.ok) throw new Error(`${node.name}: ${(await r.text()).slice(0, 200)}`);
    await fsp.mkdir(path.dirname(dest), { recursive: true });
    await fsp.writeFile(dest, Buffer.from(await r.arrayBuffer()));
    return dest;
  }

  const mergeCtx = {
    fetchBundle: async (req) => {
      const worker = discovery.get(req.node);
      if (!worker) throw new Error(`${req.node} is offline`);
      if (worker.self) return merge.bundle(req.dir, req.branch);
      return peerDownload(worker, `git/bundle?dir=${encodeURIComponent(req.dir)}&branch=${encodeURIComponent(req.branch)}`, path.join(RIGS_HOME, 'merge', `in-${req.id}.bundle`));
    },
    rollout: () => rolloutAll().catch((e) => log('rollout after merge:', e.message)),
    cleanup: async (req) => {
      const worker = discovery.get(req.node);
      if (!worker) return { removed: false, reason: `${req.node} offline` };
      return worker.self ? merge.cleanupWork(req.dir, req.branch) : peerJson(worker, 'dev/cleanup', { method: 'POST', body: { dir: req.dir, branch: req.branch }, timeout: 60000 });
    },
    notify: (text, level = 'info') => broadcastNotify({ text, level, speak: false, from: `${config().name} (merge steward)` }),
    // Only on a real conflict: an agent resolves it in the steward's scratch worktree.
    resolve: async (req) => {
      const p = await planner.createProject({ name: `Merge conflict: ${req.branch}`, goal: `Merge branch ${req.branch} from ${req.node} into main without losing anyone's work.`, repoNode: config().name, repoPath: req.worktree, dispatch: 'direct', policy: 'builtin:standard' });
      const pr = await planner.getProject(p.id);
      const log_ = (req.commits || []).join('\n');
      pr.tasks = [{
        id: 't1', kind: 'merge', size: 'L', deps: [], needs: { platform: 'any', gpu: false, tool: '' }, suggest: {}, status: 'todo', assign: null, reason: '', run: null, summary: '',
        title: `Resolve merge conflicts: ${req.branch}`,
        description: `The merge steward is merging ${req.branch} (from ${req.node}) into the latest main in this worktree:\n  ${req.worktree}\nThe merge stopped on conflicts in:\n${req.conflicts.map((f) => '  - ' + f).join('\n')}\n\nThe branch's commits (its intent):\n${log_}\n\nResolve every conflict so BOTH sides' changes survive (read 'git log origin/main' for what landed on main meanwhile; never drop either side's work silently). Then run 'npm test', 'git add' the files and finish the merge with 'git commit --no-edit'. Do not push — when the merge is committed, call the rigs MCP tool rigs_merge_resolved with {"id": "${req.id}"}; the steward re-runs the checks and pushes.`,
      }];
      planner.routeProject(pr, await meshSnapshot());
      pr.tasks[0].assign = { ...(pr.tasks[0].assign || { provider: 'claude', model: 'claude-opus-5-5', effort: 'high' }), node: config().name, locked: true };
      pr.status = 'planned';
      await planner.saveProject(pr);
      const d = await planner.dispatchReady(p.id, plannerCtx);
      const t = d.tasks[0];
      return { project: p.id, task: 't1', node: t.assign.node, provider: t.assign.provider, model: t.assign.model, status: t.status };
    },
  };

  async function iAmSteward() {
    const st = merge.electSteward(discovery.list());
    return !!st?.self;
  }

  function kickMerge() {
    iAmSteward().then((yes) => yes && merge.processQueue(mergeCtx)).catch((e) => log('merge steward:', e.message));
  }

  function meshSummary() {
    return discovery.list().map((n) => `- ${n.name}${n.self ? ' (this machine)' : ''}: ${n.platform || '?'} ${n.online ? 'online' : 'offline'}${n.rigs ? '' : ' (no RIGS agent)'}${n.tools ? ` · agents: ${['claude', 'codex', 'ollama', 'rig', 'rea'].filter((k) => n.tools[k]).join(', ') || 'none'}` : ''}${n.capabilities && Object.keys(n.capabilities).length ? ` · tools: ${Object.keys(n.capabilities).join(', ')}` : ''}${n.stats ? ` · cpu ${n.stats.cpu}% mem ${Math.round((n.stats.memUsed / n.stats.memTotal) * 100)}%` : ''}`).join('\n');
  }

  async function snapshotFor(node) {
    const get = (p) => (node.self ? localCall(p) : peerJson(node, p, { timeout: 7000 }));
    const [sess, brains, rig, info, projects, att] = await Promise.all([
      get('sessions').catch(() => []), get('brains').catch(() => []), get('openrig').catch(() => null), node.self ? selfInfo() : get('info').catch(() => node),
      get('projects').catch(() => []), get('attention').catch(() => []),
    ]);
    return { node: stripNode({ ...node, ...info, self: node.self, url: node.url, online: true }), sessions: sess, brains, openrig: rig, projects, attention: att };
  }

  async function meshSnapshot() {
    const nodes = discovery.list().filter((n) => n.online && n.rigs);
    const results = await Promise.all(nodes.map((n) => snapshotFor(n).catch((e) => ({ node: stripNode(n), error: e.message, sessions: [], brains: [] }))));
    const offline = discovery.list().filter((n) => !(n.online && n.rigs)).map((n) => ({ node: stripNode(n), sessions: [], brains: [], offline: true }));
    return [...results, ...offline];
  }

  /** Mesh-wide app catalog: this node's apps plus every online peer's, with health (src/apps.js). */
  async function meshApps() {
    const nodes = discovery.list().filter((n) => n.online && n.rigs);
    const results = await Promise.all(nodes.map((n) => (n.self ? Promise.resolve(appsReg.localApps()) : peerJson(n, 'apps', { timeout: 7000 }))
      .then((r) => ({ node: n, apps: r.apps })).catch((e) => ({ node: n, error: e.message }))));
    const out = appsReg.aggregateApps(results);
    appsReg.setMeshCatalog(out.apps);
    return out;
  }

  /** Call any node's local API by id or name (direct function call for this node). */
  async function callNode(nodeRef, p, { method = 'GET', body, timeout = 30000 } = {}) {
    const node = discovery.get(nodeRef);
    if (!node) throw new Error(`unknown machine ${nodeRef}`);
    if (node.self) return localCall(p, method, body);
    if (!node.rigs || !node.online) throw new Error(`${node.name} is offline`);
    return peerJson(node, p, { method, body, timeout });
  }

  /** One-shot question to the brain on any machine (used by the planner). */
  async function askNode(nodeRef, text, { brain, model, effort, title } = {}) {
    const c = await callNode(nodeRef, 'chats', { method: 'POST', body: { brain, model, effort, title } });
    return callNode(nodeRef, `chats/${c.id}/send?wait=1`, { method: 'POST', body: { text, brain, model, effort }, timeout: 15 * 60 * 1000 });
  }

  const plannerCtx = {
    snapshot: meshSnapshot,
    call: callNode,
    ask: askNode,
    notify: (text, level = 'info') => broadcastNotify({ text, level, speak: true, from: config().name }),
  };

  async function broadcastNotify(b) {
    const all = discovery.list().filter((n) => n.online && n.rigs);
    const results = await Promise.all(all.map((n) => (n.self ? localCall('notify', 'POST', b) : peerJson(n, 'notify', { method: 'POST', body: b })).then((r) => ({ node: n.name, ...r })).catch((e) => ({ node: n.name, error: e.message }))));
    // Nobody is looking at a JARVIS UI (or the caller asked for it): say it through this machine's speakers.
    const seen = results.some((r) => r.delivered > 0);
    if (b.speak !== false && (b.aloud === true || (!seen && config().persona.speakAloud !== 'never'))) {
      tts.speakAloud(String(b.text || '').slice(0, 2000)).catch((e) => log('tts', e.message));
      results.push({ node: config().name, aloud: true });
    }
    return results;
  }

  // Local handlers are invoked directly for the self node so the gateway never loops over HTTP.
  async function localCall(p, method = 'GET', body) {
    const fake = { method, url: '/api/local/' + p, body };
    return localApi(fake, null, p.split('?')[0], new URL('http://x/' + p).searchParams, body === undefined ? {} : body);
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
      if (!res || q.get('wait') === '1') {
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

    // model catalog + this machine's core brain (provider / exact model / effort)
    if (sub === 'models') return models.catalog();
    if (sub === 'brain/core' && method === 'GET') return models.coreBrain();
    if (sub === 'brain/core' && method === 'POST') {
      const b = await body();
      const cfg = config();
      cfg.brain.core = { provider: b.provider || 'auto', model: b.model || '', effort: b.effort || '', node: b.node || '' };
      patchConfig({ brain: { core: cfg.brain.core } });
      return models.coreBrain();
    }
    if (sub === 'capabilities' && method === 'GET') return { tools: await caps.capabilities(q.get('force') === '1'), known: caps.knownTools() };
    if (sub === 'capabilities' && method === 'POST') {
      // { id, label, kinds, url, command, notes } declares/updates a tool; { id, remove: true } removes it.
      const b = await body();
      if (!/^[\w-]{1,40}$/.test(b.id || '')) throw new HttpError(400, 'tool id must be letters, digits, - or _');
      const all = { ...(config().capabilities || {}) };
      if (b.remove) delete all[b.id];
      else all[b.id] = { label: b.label || b.id, kinds: Array.isArray(b.kinds) ? b.kinds : String(b.kinds || '').split(',').map((x) => x.trim()).filter(Boolean), url: b.url || '', command: b.command || '', notes: b.notes || '', ...(b.disabled ? { disabled: true } : {}) };
      const cfg = config();
      cfg.capabilities = all;
      saveConfig(cfg);
      return { tools: await caps.capabilities(true) };
    }
    if (sub === 'apps' && method === 'GET') return appsReg.localApps();
    if (sub === 'routing' && method === 'GET') return config().routing;
    if (sub === 'routing' && method === 'POST') {
      const b = await body();
      if (b.reset) { const cfg = config(); cfg.routing.customized = false; cfg.routing.rulesVersion = 0; saveConfig(cfg); loadConfig(); return config().routing; }
      patchConfig({ routing: { ...b, customized: b.rules ? true : config().routing.customized } });
      return config().routing;
    }

    // projects (owned by this machine) and the work they dispatch to machines
    if (sub === 'projects' && method === 'GET') return planner.listProjects();
    if (sub === 'projects' && method === 'POST') return planner.createProject(await body());
    if ((mm = m(/^projects\/([\w-]+)$/))) {
      if (method === 'DELETE') { await planner.stopProject(mm[1], plannerCtx).catch(() => {}); return { ok: await planner.deleteProject(mm[1]) }; }
      const pr = await planner.getProject(mm[1]);
      if (!pr) throw new HttpError(404, 'project not found');
      if (method === 'POST') { const b = await body(); for (const k of ['name', 'goal', 'gitUrl', 'dispatch', 'policy', 'planner']) if (b[k] !== undefined) pr[k] = b[k]; if (b.repo) pr.repo = { ...pr.repo, ...b.repo }; return planner.saveProject(pr); }
      return pr;
    }
    if ((mm = m(/^projects\/([\w-]+)\/plan$/)) && method === 'POST') return planner.planProject(mm[1], plannerCtx, await body());
    if ((mm = m(/^projects\/([\w-]+)\/route$/)) && method === 'POST') {
      const b = await body();
      const pr = await planner.getProject(mm[1]);
      if (!pr) throw new HttpError(404, 'project not found');
      if (b.unlock) for (const t of pr.tasks) if (t.assign) delete t.assign.locked;
      planner.routeProject(pr, await meshSnapshot(), { onlyUnassigned: !!b.onlyUnassigned });
      if (pr.status === 'draft' && pr.tasks.length) pr.status = 'planned';
      return planner.saveProject(pr);
    }
    if ((mm = m(/^projects\/([\w-]+)\/dispatch$/)) && method === 'POST') return planner.dispatchReady(mm[1], plannerCtx);
    if ((mm = m(/^projects\/([\w-]+)\/stop$/)) && method === 'POST') return planner.stopProject(mm[1], plannerCtx);
    if ((mm = m(/^projects\/([\w-]+)\/tasks$/)) && method === 'POST') {
      const pr = await planner.getProject(mm[1]);
      if (!pr) throw new HttpError(404, 'project not found');
      const b = await body();
      const id = b.id && /^[\w-]{1,12}$/.test(b.id) && !pr.tasks.some((t) => t.id === b.id) ? b.id : `t${pr.tasks.length + 1}${pr.tasks.some((t) => t.id === `t${pr.tasks.length + 1}`) ? 'b' : ''}`;
      pr.tasks.push({ id, title: b.title || 'New task', description: b.description || b.title || '', kind: planner.KINDS.includes(b.kind) ? b.kind : 'code', size: b.size || 'M', deps: b.deps || [], needs: { platform: 'any', gpu: false, ...(b.needs || {}) }, suggest: {}, status: 'todo', assign: b.assign ? { ...b.assign, locked: true } : null, reason: b.assign ? 'set by hand' : '', run: null, summary: '' });
      if (!b.assign) planner.routeProject(pr, await meshSnapshot(), { onlyUnassigned: true });
      if (pr.status === 'draft') pr.status = 'planned';
      return planner.saveProject(pr);
    }
    if ((mm = m(/^projects\/([\w-]+)\/tasks\/([\w-]+)$/))) {
      if (method === 'DELETE') {
        const pr = await planner.getProject(mm[1]);
        if (!pr) throw new HttpError(404, 'project not found');
        pr.tasks = pr.tasks.filter((t) => t.id !== mm[2]);
        for (const t of pr.tasks) t.deps = t.deps.filter((d) => d !== mm[2]);
        return planner.saveProject(pr);
      }
      if (method === 'POST') {
        const b = await body();
        const pr = await planner.getProject(mm[1]);
        if (!pr) throw new HttpError(404, 'project not found');
        const t = pr.tasks.find((x) => x.id === mm[2]);
        if (!t) throw new HttpError(404, 'task not found');
        for (const k of ['title', 'description', 'kind', 'size', 'deps', 'needs']) if (b[k] !== undefined) t[k] = b[k];
        await planner.saveProject(pr);
        return planner.updateTask(mm[1], mm[2], { status: b.status, summary: b.summary, assign: b.assign }, plannerCtx);
      }
    }
    if (sub === 'work/start' && method === 'POST') return work.startTask(await body());
    if (sub === 'work/status' && method === 'POST') return work.taskStatus(await body());
    if (sub === 'work/stop' && method === 'POST') return work.stopTask(await body());

    // change policy: work branches → merge steward (see src/merge.js)
    if (sub === 'dev/start' && method === 'POST') { const b = await body(); return merge.startWork(b.topic, { repo: b.repo || undefined }); }
    if (sub === 'dev/propose' && method === 'POST') {
      const b = await body();
      const dir = files.resolvePath(b.dir || '.');
      const d = await merge.describe(dir);
      const st = merge.electSteward(discovery.list());
      if (!st) throw new HttpError(503, 'no merge steward online (a machine that can push to the repo)');
      const reqBody = { node: config().name, dir, branch: d.branch, title: b.title || d.commits[0].replace(/^\w+ /, ''), summary: b.summary || '', commits: d.commits, session: b.session || null };
      const r = st.self ? await merge.enqueue(reqBody) : await peerJson(st, 'merge/requests', { method: 'POST', body: reqBody, timeout: 20000 });
      if (st.self) kickMerge();
      return { ...r, steward: st.name };
    }
    if (sub === 'dev/cleanup' && method === 'POST') { const b = await body(); return merge.cleanupWork(files.resolvePath(b.dir), b.branch); }
    if (sub === 'git/bundle' && method === 'GET') {
      if (!res) throw new HttpError(400, 'stream only');
      const file = await merge.bundle(files.resolvePath(q.get('dir')), q.get('branch'));
      res.writeHead(200, { 'content-type': 'application/octet-stream' });
      await pipeline(fs.createReadStream(file), res);
      await fsp.rm(file, { force: true });
      return undefined;
    }
    if (sub === 'merge' && method === 'GET') return { steward: (merge.electSteward(discovery.list()) || {}).name || null, queue: merge.queue() };
    if (sub === 'merge/requests' && method === 'POST') { const r = await merge.enqueue(await body()); kickMerge(); return r; }
    if ((mm = m(/^merge\/(\w+)\/(resolved|retry|drop)$/)) && method === 'POST') {
      const r = mm[2] === 'resolved' ? await merge.markResolved(mm[1]) : mm[2] === 'retry' ? await merge.retry(mm[1]) : await merge.drop(mm[1]);
      kickMerge();
      return r;
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
    if (sub === 'desktop/pin' && method === 'POST') { const b = await body(); return desktop.sunshinePin(b.pin, b.name, b.clientAddress); }
    if (sub === 'desktop/pairings' && method === 'GET') return desktop.pendingPairings();
    if (sub === 'desktop/pairings' && method === 'POST') { const b = await body(); return desktop.acceptPairing(b.pairingId, b.pin, b.name || 'moonlight'); }
    // Open a viewer ON THIS machine (e.g. from the phone: "show magix-system on the mac").
    if (sub === 'desktop/connect' && method === 'POST') { const b = await body(); return connectDesktop(b.target, b.method); }
    if (sub === 'desktop/permission' && method === 'POST') return desktop.openCapturePermissionSettings();
    if (sub === 'desktop/restart' && method === 'POST') { await desktop.restartSunshine(); return { ok: true }; }
    if (sub === 'desktop/quit' && method === 'POST') { const b = await body(); const t = discovery.get(b.target); return desktop.quit(t ? desktopAddress(t) : b.target); }
    if (sub === 'desktop/install' && method === 'GET') return desktopInstall.status();
    if (sub === 'desktop/install' && method === 'POST') {
      const b = await body();
      const r = await desktopInstall.ensure({ force: !!b.force });
      announceDesktop(r);
      return r;
    }
    if (sub === 'migrations') return migrations.status();
    if (sub === 'root-steps') return rootsteps.pending();
    if (sub === 'attention' && method === 'GET') return attention.list();
    if (sub === 'attention/codex' && method === 'POST') return attention.codexEvent(await body());
    if (sub === 'access' && method === 'GET') return access.status(q.get('force') === '1');
    if (sub === 'access/full-disk' && method === 'POST') return access.grantFullDiskAccess();

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

    // text-to-speech on this machine (the UI plays it; browsers block speechSynthesis outside gestures)
    if (sub === 'tts' && method === 'GET') return tts.info();
    if (sub === 'tts' && method === 'POST') {
      const b = await body();
      const wav = await tts.synthesize(b.text, b.voice);
      if (!res) return { bytes: wav ? wav.length : 0 };
      if (!wav) { res.writeHead(204, { 'cache-control': 'no-store' }); res.end(); return undefined; }
      res.writeHead(200, { 'content-type': 'audio/wav', 'content-length': wav.length, 'cache-control': 'no-store' });
      res.end(wav);
      return undefined;
    }
    if (sub === 'tts/say' && method === 'POST') { const b = await body(); return tts.speakAloud(b.text, b.voice); }

    // notifications to the JARVIS UI on this node
    if (sub === 'notify' && method === 'POST') {
      const b = await body();
      broadcast({ type: 'notify', text: String(b.text || '').slice(0, 2000), speak: b.speak !== false, from: b.from || config().name, level: b.level || 'info', action: b.action || null });
      return { ok: true, delivered: uiSockets.size };
    }

    throw new HttpError(404, `unknown endpoint ${method} /api/local/${sub}`);
  }

  async function meshApi(req, res, url) {
    const p = url.pathname;
    let mm;
    if (p === '/api/nodes') {
      // The first scan can take seconds (Windows GPU/tool probes); never answer without this node.
      if (!discovery.list().some((n) => n.self)) await discovery.tick();
      return discovery.list().map(stripNode);
    }
    if (p === '/api/self') return { id: config().nodeId, name: config().name, via: req.rigsAuth };
    if (p === '/api/mesh/refresh' && req.method === 'POST') { await discovery.tick(); return discovery.list().map(stripNode); }
    if (p === '/api/apps') return meshApps();
    if (p === '/api/mesh/snapshot') return meshSnapshot();
    if (p === '/api/mesh/summary') return { text: meshSummary() };
    if (p === '/api/mesh/update' && req.method === 'POST') return rolloutAll();
    if (p === '/api/mesh/merge') {
      const st = merge.electSteward(discovery.list());
      if (!st) return { steward: null, queue: [], note: 'no online machine can push to the repo (gh auth login on one of them)' };
      const queue = st.self ? merge.queue() : await peerJson(st, 'merge', { timeout: 10000 }).then((r) => r.queue).catch(() => []);
      return { steward: st.name, queue };
    }
    if (p === '/api/mesh/notify' && req.method === 'POST') return broadcastNotify(await readBody(req));
    if (p === '/api/mesh/attention') {
      const nodes = discovery.list().filter((n) => n.online && n.rigs);
      return Promise.all(nodes.map((n) => (n.self ? Promise.resolve(attention.list()) : peerJson(n, 'attention', { timeout: 5000 }))
        .then((items) => ({ node: n.name, nodeId: n.id, items })).catch(() => ({ node: n.name, nodeId: n.id, items: [] }))));
    }
    if (p === '/api/mesh/projects') {
      const snap = await meshSnapshot();
      return snap.flatMap((e) => (e.projects || []).map((x) => ({ ...x, ownerId: e.node.id })));
    }
    if (p === '/api/desktop/connect' && req.method === 'POST') {
      // This node is where the person sits; launch the native viewer here, pointed at the target.
      const b = await readBody(req);
      if (!isLoopback(clientIp(req)) && !req.headers['tailscale-user-login']) throw new HttpError(400, 'open the UI from this machine (localhost) to launch a native viewer here — or use “view on” another machine');
      return connectDesktop(b.target, b.method);
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
  if (!process.env.RIGS_NO_AUTOUPDATE) updater.startAutoUpdate((r) => {
    broadcast({ type: 'notify', text: `Updated to ${r.to}. Restarting.`, speak: false, from: config().name });
    setTimeout(() => process.exit(updater.RESTART_CODE), 1000);
  });
  function announceRoot() {
    const p = rootsteps.pending();
    if (!p.steps.length) return;
    broadcastNotify({ text: `${config().name} needs your password once to finish: ${p.steps.map((x) => x.title.split(' (')[0].split(':')[0]).join(' · ')}.`, speak: false, level: 'action', from: config().name, action: { type: 'run', node: config().name, command: p.command, label: 'Finish setup', title: `Finish setup · ${config().name}` } }).catch(() => {});
  }

  function announceDesktop(st) {
    if (st.state === 'needs-sudo') announceRoot();
    else if (st.state === 'done') broadcastNotify({ text: `${config().name}: Sunshine + Moonlight ready — hardware-accelerated remote desktop is available.`, speak: false, from: config().name }).catch(() => {});
    else if (st.state === 'failed') broadcastNotify({ text: `${config().name}: remote desktop install failed — ${st.steps.slice(-1)[0] || ''}`, speak: false, level: 'error', from: config().name }).catch(() => {});
  }

  // One-time steps shipped by updates (SSH session hook, Sunshine + Moonlight…), in the background.
  // RIGS_NO_MIGRATIONS: throwaway nodes (tests) must never install software or touch dotfiles.
  if (!process.env.RIGS_NO_MIGRATIONS) setTimeout(() => migrations.runPending((m, res) => {
    if (m.id.includes('desktop') && res.ok && res.result?.state !== 'needs-sudo') desktopInstall.status().then(announceDesktop).catch(() => {});
  }).then(() => announceRoot()).catch((e) => log('migrations:', e.message)), 4000).unref();

  // "An agent needs you": watch every agent on this machine; announce new waits mesh-wide.
  attention.events.on('new', (items) => {
    for (const it of items) {
      const who = it.agent === 'claude' ? 'Claude' : it.agent === 'codex' ? 'Codex' : it.agent;
      const text = `${who} on ${config().name} needs you — ${it.title}: ${it.reason}`;
      broadcastNotify({ text, speak: true, level: 'attention', from: config().name, action: { type: 'attention', node: config().name, item: it } }).catch(() => {});
      osNotify(`${who} needs you on ${config().name}`, `${it.title} — ${it.reason}`).catch(() => {});
    }
  });
  const attentionTick = async () => {
    const projects = await planner.listProjects().catch(() => []);
    await attention.refresh({ projects });
  };
  setTimeout(() => attentionTick().catch(() => {}), 3000).unref();
  setInterval(() => attentionTick().catch((e) => log('attention:', e.message)), 5000).unref();

  // Merge steward: process proposed branches (also kicked on every proposal / resolution).
  setInterval(kickMerge, 30000).unref();
  appsReg.startHealthChecks();

  // Project tracker: finished seats/sessions → start what became ready.
  setInterval(() => planner.tick(plannerCtx).catch((e) => log('planner tick:', e.message)), 20000).unref();
  // Live stats push for the HUD.
  setInterval(async () => { if (uiSockets.size) broadcast({ type: 'stats', id: config().nodeId, stats: await stats() }); }, 5000).unref();

  return { discovery, close: () => { for (const s of servers.values()) s.close(); discovery.stop(); } };
}
