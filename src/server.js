import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import http from 'node:http';
import path from 'node:path';
import { WebSocketServer } from 'ws';
import { authorize, clientIp, isLoopback } from './auth.js';
import * as access from './access.js';
import * as control from './control.js';
import { createControlApi, wireControlEvents, controlCaller } from './control-api.js';
import { createStreamHub, streamReadiness } from './screen-stream.js';
import { ensureControlSetup } from './control-setup.js';
import * as attention from './attention.js';
import { osNotify } from './osnotify.js';
import * as caps from './capabilities.js';
import * as appsReg from './apps.js';
import * as appstore from './appstore.js';
import * as chat from './chat.js';
import { comfyRoute, createComfyService } from './comfyui.js';
import { createSlack, slackRoute } from './connectors/slack.js';
import { createGoogleDrive, googleDriveRoute } from './connectors/google-drive.js';
import { adoptGlobal, config, currentGlobal, loadConfig, markGlobalChanged, onGlobalChange, patchConfig, publicConfig, RIGS_HOME, saveConfig } from './config.js';
import { homeNode, relayTarget } from './globalbrain.js';
import * as uilayout from './uilayout.js';
import { createLinearService, linearRoute } from './linear.js';
import * as desktop from './desktop.js';
import * as desktopInstall from './desktop-install.js';
import * as merge from './merge.js';
import * as migrations from './migrations.js';
import * as rootsteps from './rootsteps.js';
import { Discovery } from './discovery.js';
import * as files from './files.js';
import * as shared from './shared.js';
import * as models from './models.js';
import * as hubs from './hubs.js';
import * as openrig from './openrig.js';
import * as planner from './planner.js';
import { appRefererRedirect, appRoute, forwardHttp, forwardWs, peerJson, proxyApp, proxyAppWs, rejectUpgrade, relayApp, relayAppWs } from './proxy.js';
import * as pty from './pty.js';
import * as senses from './senses.js';
import * as usage from './usage.js';
import * as trace from './trace.js';
import * as exhibits from './exhibits.js';
import * as starnet from './starnet.js';
import * as prerouteStats from './preroute-stats.js';
import { applyQuickPatch, localSettings, quickSettings } from './quick.js';
import * as responder from './responder.js';
import { applyRouterPatch, routerView } from './router.js';
import * as sessions from './sessions.js';
import * as ssh from './ssh.js';
import { stats, systemInfo } from './system.js';
import * as ts from './tailscale.js';
import * as toolbox from './toolbox.js';
import * as tts from './tts.js';
import { notifyVoice } from './tts-plan.js';
import { detectTools, ollamaModels } from './tools.js';
import * as updater from './updater.js';
import { APP_DIR, isWin, log, run, truncate } from './util.js';
import * as work from './work.js';
import * as processes from './processes.js';
import * as workspaces from './workspaces.js';
import * as uiOpen from './ui-open.js';
import * as yolo from './yolo.js';
import * as yoloKeep from './yolo-keep.js';

const UI_DIR = path.join(APP_DIR, 'ui');
const STATIC_TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.woff2': 'font/woff2', '.map': 'application/json' };

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
    pinnedProjects: cfg.pinnedProjects || [],
    id: cfg.nodeId, name: cfg.name, version: ver.short, versionInfo: ver, port: cfg.port,
    url: `http://${ip || '127.0.0.1'}:${cfg.port}`,
    ...sys, stats: st, tools: compactTools(tools), capabilities, ptyAvailable: pty.ptyAvailable(),
    tailscale: tsStatus ? { ip, dnsName: tsStatus.self.dnsName, login: tsStatus.self.login, state: tsStatus.backendState } : null,
    sshPubKey: ssh.publicKey(), sshUser: ssh.sshUser(), sshAlias: cfg.name, sshHostKeys: await ssh.hostKeys().catch(() => null),
    canPush: await merge.canPush().catch(() => false),
    desktopInstall: await desktopInstall.status().then((d) => ({ state: d.state, command: d.command, note: d.note, sunshine: d.sunshine, moonlight: d.moonlight, steps: d.steps.slice(-4) })).catch(() => null),
    rootSteps: rootsteps.pending(),
    access: await access.status().then((a) => ({ ok: a.ok, home: a.home, blocked: a.blocked, fullDiskAccess: a.fullDiskAccess, screenCapture: a.screenCapture, input: a.input, accessibility: a.accessibility, controlledFolderAccess: a.controlledFolderAccess, runtime: a.runtime })).catch(() => null),
  };
}

// ---------------------------------------------------------------- server
export async function startServer() {
  const cfg = config();
  await ssh.ensureKey().catch(() => null);
  const discovery = new Discovery(selfInfo);
  // The shared folder (src/shared.js): synced with every online RIGS peer, authenticated like any other peer call.
  const rigsPeers = () => discovery.list().filter((n) => !n.self && n.rigs);
  const sharedCfg = cfg.shared || {};
  const sharedEngine = sharedCfg.enabled === false ? null : shared.createShared({
    root: files.sharedRoot(), stateDir: path.join(RIGS_HOME, 'shared'), trashDir: path.join(RIGS_HOME, 'trash'), node: cfg.name,
    intervalSec: Number(sharedCfg.intervalSec) || 60, maxFileBytes: (Number(sharedCfg.maxFileMb) || 256) * 1024 * 1024,
    ignore: Array.isArray(sharedCfg.ignore) ? sharedCfg.ignore : [], log,
    peers: () => rigsPeers().filter((n) => n.online),
    fetchPeer: (n, p, { method = 'GET' } = {}) => fetch(n.url.replace(/\/$/, '') + '/api/local/' + p, {
      method, headers: n.viaToken ? { 'x-rigs-token': config().meshToken } : {},
      signal: AbortSignal.timeout(p.startsWith('shared/file') ? 30 * 60 * 1000 : 20000),
    }),
  });
  responder.setPeers((name) => discovery.get(name)); // the local responder streams turns from the machine hosting its model
  // ComfyUI connector (/api/local/comfyui/*): the user's URL wins; the detected ComfyUI is the fallback.
  const comfy = createComfyService({ suggest: async () => { const c = (await caps.capabilities()).comfyui; return c?.url ? { url: c.url, running: c.running !== false } : null; } });
  // Linear connector (/api/local/linear/*): API key from config.linear or LINEAR_API_KEY, never returned or logged.
  const linear = createLinearService();
  // Slack connector (/api/local/connectors/slack/*): reads, plus a post that needs confirm: true (src/connectors/slack.js).
  const slack = createSlack();
  // Google Drive connector (/api/local/connectors/google-drive/*): OAuth via this daemon's loopback callback, read-only Drive.
  const drive = createGoogleDrive();
  // Exhibits (src/exhibits.js, opt-in): spans + project saves → illustrated documents, off the request path.
  const exhibitSvc = exhibits.createExhibits({ comfy });
  const uiSockets = new Set();
  // Dock layout + app dock (src/uilayout.js): saved here, pushed to peers, pulled when they come back.
  const layoutStore = uilayout.createStore({ file: path.join(RIGS_HOME, 'ui-layout.json'), name: () => config().name });
  const layoutErr = (e) => { throw e instanceof uilayout.LayoutError ? new HttpError(e.status, e.message) : e; };
  const broadcast = (msg) => { const s = JSON.stringify(msg); for (const w of uiSockets) if (w.readyState === 1) w.send(s); };

  discovery.on('change', async (nodes) => {
    broadcast({ type: 'mesh', nodes: nodes.map(stripNode) });
    try {
      const r = await ssh.syncPeers(nodes);
      if (r.authorized || r.aliases) log(`ssh: ${r.authorized} peer key(s) authorized, ${r.aliases} alias(es) in ~/.ssh/config`);
      if (r.replaced?.length) log(`ssh: peer host key changed for ${r.replaced.join(', ')}; replaced the stale known_hosts entries (previous file: known_hosts.rigs.old)`);
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
        description: `The merge steward is merging ${req.branch} (from ${req.node}) into the latest main in this worktree:\n  ${req.worktree}\nThe merge stopped on conflicts in:\n${req.conflicts.map((f) => '  - ' + f).join('\n')}\n\nThe branch's commits (its intent):\n${log_}\n\nResolve every conflict so BOTH sides' changes survive (read 'git log origin/main' for what landed on main meanwhile; never drop either side's work silently). Then run 'npm test' and 'git add' the resolved files. Do not commit and do not push: call the rigs MCP tool rigs_merge_resolved with {"id": "${req.id}"} — it commits the merge, and the steward re-runs the checks and pushes.`,
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

  /** Hand a committed work branch (a worktree on this machine) to the merge steward. */
  async function proposeBranch(b) {
    const dir = files.resolvePath(b.dir || '.');
    if (b.stripManaged) await merge.stripManagedBlocks(dir);
    const d = await merge.describe(dir);
    if (d.empty) return { empty: true, branch: d.branch };
    const st = merge.electSteward(discovery.list());
    if (!st) throw new HttpError(503, 'no merge steward online (a machine that can push to the repo)');
    const reqBody = { node: config().name, dir, branch: d.branch, title: b.title || d.commits[0].replace(/^\w+ /, ''), summary: b.summary || '', commits: d.commits, session: b.session || null };
    const r = st.self ? await merge.enqueue(reqBody) : await peerJson(st, 'merge/requests', { method: 'POST', body: reqBody, timeout: 20000 });
    if (st.self) kickMerge();
    return { ...r, steward: st.name };
  }

  async function iAmSteward() {
    const st = merge.electSteward(discovery.list());
    return !!st?.self;
  }

  function kickMerge() {
    iAmSteward().then((yes) => yes && merge.processQueue(mergeCtx)).catch((e) => log('merge steward:', e.message));
  }

  /** Projects on every machine, one line each, for JARVIS to file instructions under (cached 30 s). */
  let projCache = { at: 0, text: '' };
  async function projectsSummary() {
    if (Date.now() - projCache.at < 30000) return projCache.text;
    try {
      const snap = await meshSnapshot();
      const rows = snap.flatMap((e) => (e.projects || []).map((p) => {
        const live = (p.tasks || []).filter((t) => t.status === 'running').length;
        return `- ${p.id} · ${p.name} · ${p.status}${live ? ` (${live} running)` : ''} · on ${e.node.name}`;
      }));
      if (!rows.some((r) => r.startsWith(`- ${planner.MAIN_ID} `))) rows.unshift(`- ${planner.MAIN_ID} · RIGS · JARVIS · main project (created on first use)`);
      projCache = { at: Date.now(), text: rows.slice(0, 40).join('\n') };
    } catch { /* keep the old list */ }
    return projCache.text;
  }

  function meshSummary() {
    return discovery.list().map((n) => `- ${n.name}${n.self ? ' (this machine)' : ''}: ${n.platform || '?'} ${n.online ? 'online' : 'offline'}${n.rigs ? '' : ' (no RIGS agent)'}${n.tools ? ` · agents: ${['claude', 'codex', 'ollama', 'rig', 'rea'].filter((k) => n.tools[k]).join(', ') || 'none'}` : ''}${n.capabilities && Object.keys(n.capabilities).length ? ` · tools: ${Object.keys(n.capabilities).join(', ')}` : ''}${n.stats ? ` · cpu ${n.stats.cpu}% mem ${Math.round((n.stats.memUsed / n.stats.memTotal) * 100)}%` : ''}`).join('\n');
  }

  async function snapshotFor(node) {
    const get = (p) => (node.self ? localCall(p) : peerJson(node, p, { timeout: 7000 }));
    const [sess, brains, rig, info, projects, att, apps, hubsSt] = await Promise.all([
      get('sessions').catch(() => []), get('brains').catch(() => []), get('openrig').catch(() => null), node.self ? selfInfo() : get('info').catch(() => node),
      get('projects').catch(() => []), get('attention').catch(() => []), get('apps').then((r) => r.apps || []).catch(() => []), get('hubs').catch(() => null),
    ]);
    return { node: stripNode({ ...node, ...info, self: node.self, url: node.url, online: true }), sessions: sess, brains, openrig: rig, projects, attention: att, apps, hubs: hubsSt };
  }

  async function meshSnapshot() {
    const nodes = discovery.list().filter((n) => n.online && n.rigs);
    const results = await Promise.all(nodes.map((n) => snapshotFor(n).catch((e) => ({ node: stripNode(n), error: e.message, sessions: [], brains: [] }))));
    const offline = discovery.list().filter((n) => !(n.online && n.rigs)).map((n) => ({ node: stripNode(n), sessions: [], brains: [], offline: true }));
    return [...results, ...offline];
  }

  /** Folders agents recently worked in (so a project outside the usual roots is still found). */
  async function sessionDirs() {
    const list = await sessions.listSessions({ chats: [] }).catch(() => []);
    return [...new Set(list.map((s) => s.cwd).filter(Boolean))];
  }

  /** Every machine's workspaces: [{ node, platform, items }] (a first scan on a machine can take a few seconds). */
  async function meshWorkspaces({ force = false } = {}) {
    const nodes = discovery.list().filter((n) => n.online && n.rigs);
    return Promise.all(nodes.map((n) => (n.self ? sessionDirs().then((extraDirs) => workspaces.list({ force, extraDirs })) : peerJson(n, `workspaces${force ? '?force=1' : ''}`, { timeout: 45000 }))
      .then((items) => ({ node: n.name, platform: n.platform, items: Array.isArray(items) ? items : [] }))
      .catch((e) => ({ node: n.name, platform: n.platform, items: [], error: e.message }))));
  }

  /** "Mad Mike's Garage — Codex developer guide" → "Mad Mike's Garage"; a heading that is just a guide's name → the folder name. */
  function workspaceLabel(ws) {
    const head = String(ws.title || '').split(/\s+[—–-]\s+/)[0].trim();
    return head && !/agents\.md|claude\.md|readme|guide/i.test(head) && head.length <= 40 ? head : ws.name;
  }

  /** A handoff span's output: the project and where each of its tasks went. */
  function handoffOutput(p) {
    return { projectId: p.id, name: p.name, owner: p.owner, status: p.status, tasks: (p.tasks || []).map((t) => ({ id: t.id, title: t.title, status: t.status, node: t.assign?.node || '', model: t.assign?.model || '' })) };
  }

  /** The trace context a request carries: body.trace, then the x-rigs-trace header (the rigs MCP sets both). */
  function traceOf(req, b) {
    return trace.parseContext(b?.trace) || trace.parseContext(req?.headers?.['x-rigs-trace']);
  }

  /** The OpenRig seat (or session) behind an API call: the rigs MCP's x-rigs-caller header. */
  function callerSeat(req) {
    try { const c = JSON.parse(req?.headers?.['x-rigs-caller'] || '{}'); return c.seat || c.session || ''; } catch { return ''; }
  }

  /**
   * A tool_run is tool reuse: one event in the usage log and, when the call carries a request trace (x-rigs-trace),
   * an event span under it. Only the argument names are kept, never their values. Never throws.
   */
  function recordToolRun(req, b, id, t0, r, error = '') {
    try {
      const ok = !error && r?.ok !== false;
      const tc = traceOf(req, b);
      usage.recordToolEvent({ event: 'run', toolId: id, ok, durationMs: Date.now() - t0, trace: tc?.traceId, seat: callerSeat(req), error: error || (ok ? '' : r?.error || r?.stderr || '') });
      if (tc) trace.recordSpan({ traceId: tc.traceId, parentId: tc.parentId || '', kind: 'event', name: `tool_run ${id}`, start: t0, input: { args: Object.keys(b.args || {}) }, output: ok ? { ok: true, durationMs: Date.now() - t0 } : error || r?.error || 'failed', status: ok ? 'ok' : 'error', meta: { toolId: id, reuse: true, seat: callerSeat(req) } });
    } catch (e) { log('tool reuse log: ' + e.message); }
  }

  /** Which agent harness made this API call (the rigs MCP's x-rigs-caller header): claude | codex | agent | ''. */
  function callerAgent(req) {
    try { return JSON.parse(req?.headers?.['x-rigs-caller'] || '{}').agent || ''; } catch { return ''; }
  }

  /** A request from Sir comes in: the root (intake) span of its new trace. */
  function startIntake(req, text, name, b = {}) {
    return trace.startSpan({ kind: 'intake', name, input: text, meta: { via: req?.rigsAuth?.via || '', who: req?.rigsAuth?.who || '', brain: b.brain || '', model: b.model || '', effort: b.effort || '' } });
  }

  /** Watches a turn's stream events and says how the intake span ends: its reply, or its error. */
  function intakeWatcher() {
    let done = null;
    let error = '';
    let timing = null;
    return {
      see(e) { if (e.type === 'done') done = e; else if (e.type === 'error') error = e.message; else if (e.type === 'timing') timing = e; },
      result: (aborted) => ({
        status: aborted ? 'stopped' : error && !done?.text ? 'error' : 'ok',
        // jarvisSend's measurement (pre-routing on/off, routerMs, timeToFiledMs, timeToReplyMs) on the root span too.
        ...(timing ? { meta: { timing: { preroute: timing.preroute, route: timing.route, via: timing.via, routerMs: timing.routerMs, timeToFiledMs: timing.timeToFiledMs, timeToReplyMs: timing.timeToReplyMs, filedBy: timing.filedBy, ...(timing.lane === 'yolo' ? { lane: 'yolo', runId: timing.runId, timeToFirstFrameMs: timing.timeToFirstFrameMs } : timing.lane ? { lane: timing.lane, tier: timing.tier, ...(timing.escalated ? { escalated: timing.escalated } : {}) } : {}) } } } : {}),
        output: done ? { text: done.text, chatId: done.chatId, brain: done.brain, model: done.model, ...(error ? { error } : {}) } : { error: error || 'no reply' },
      }),
    };
  }

  /**
   * The router bound parts of a request to workspaces: one project per part, bound to that folder on that
   * machine, planned by the core brain with the project's own agent guide, then dispatched (an OpenRig team
   * per project). Returns at once; planning and casting run in the background and report via notify.
   */
  async function fileWork(items, { chatId = '', trace: tctx = null } = {}) {
    const out = [];
    for (const it of items) {
      const ws = it.workspace;
      if (it.tool) {
        // A helper tool for a task: an ordinary task under the main rigs project — no dev worktree, no merge-steward proposal.
        const r = await planner.intake({ title: it.title, instruction: it.goal, kind: 'code', trace: tctx || undefined }, plannerCtx);
        out.push({ id: r.project.id, name: r.project.name, owner: r.project.owner, node: config().name, path: '', workspace: 'RIGS · JARVIS', self: false, tool: true, flow: '', note: it.note || 'ad-hoc tool, filed in the ad-hoc store' });
        continue;
      }
      // One handoff span per project filed, under the router's span; the project keeps its context so its planning
      // call and task briefs attach to the same trace. It ends once planning and dispatch have run.
      const hs = tctx ? trace.startSpan({ ...tctx, kind: 'handoff', name: 'file-work', input: { goal: it.goal, workspace: ws?.name || '', node: it.node || '', self: !!it.self, flow: it.flow?.name || '' } }) : null;
      const label = it.self ? 'JARVIS' : workspaceLabel(ws);
      const name = truncate(`${label} · ${it.flow ? it.flow.name : it.title || 'work'}`, 60);
      let p;
      if (it.self) {
        // A change to RIGS itself: its own dev worktree off the latest main (never the installed checkout); the
        // merge steward tests, merges and rolls it out when every task is done (planner.settle → ctx.propose).
        const topic = work.slug(`${it.title || it.goal}`, 30) + '-' + crypto.randomBytes(2).toString('hex');
        const dev = await merge.startWork(topic);
        p = await planner.createProject({ name, goal: it.goal, repoNode: config().name, repoPath: dev.dir });
        p.selfDev = { branch: dev.branch, topic };
        p.workspace = { name: 'rigs', title: ws.title, label, kinds: ws.kinds, parts: [], guides: ws.guides };
      } else {
        p = await planner.createProject({ name, goal: it.goal, repoNode: it.node, repoPath: ws.path });
        p.workspace = { name: ws.name, title: ws.title, label, kinds: ws.kinds, parts: ws.parts, guides: ws.guides, unity: ws.unity };
        if (it.flow) p.flow = { name: it.flow.name, description: it.flow.description, prompt: it.flow.prompt, source: it.flow.source };
      }
      p.request = it.request || '';
      p.chatId = chatId;
      p.autoRun = true;
      if (hs) p.trace = hs.ctx;
      if (it.note) p.note = it.note;
      p = await planner.saveProject(p);
      out.push({ id: p.id, name: p.name, owner: p.owner, node: p.repo.node, path: p.repo.path, workspace: label, self: !!it.self, flow: it.flow?.name || '', note: it.note || '' });
      hs?.update({ meta: { projectId: p.id, owner: p.owner, name: p.name } });
      (async () => {
        if (p.flow) await planner.planFlow(p.id, plannerCtx);
        else await planner.planProject(p.id, plannerCtx);
        const d = await planner.dispatchReady(p.id, plannerCtx);
        hs?.end({ output: handoffOutput(d), meta: { projectId: p.id, owner: p.owner, taskIds: d.tasks.map((t) => t.id) } });
        if (!d.tasks.some((t) => t.status === 'running')) plannerCtx.notify(`${p.name}: planned ${d.tasks.length} tasks, but none could start — open it on the Work dashboard.`, 'error');
      })().catch((e) => { hs?.end({ status: 'error', output: { error: e.message }, meta: { projectId: p.id, owner: p.owner } }); log('work:', e.message); plannerCtx.notify(`Couldn't start "${name}": ${e.message}`, 'error'); });
    }
    projCache.at = 0;
    return out;
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

  /** Every online node's registered tools plus the App Cloud apps as kind "applet": { entries, errors }. */
  async function toolEntries() {
    if (!discovery.list().some((n) => n.self)) await discovery.tick();
    const nodes = discovery.list().filter((n) => n.online && n.rigs);
    const [results, apps] = await Promise.all([
      Promise.all(nodes.map((n) => (n.self ? toolbox.listLocal() : peerJson(n, 'tools', { timeout: 7000 }))
        .then((r) => ({ node: n, tools: r.tools })).catch((e) => ({ node: n, error: e.message })))),
      meshApps().catch((e) => ({ apps: [], errors: [{ node: config().name, error: e.message }] })),
    ]);
    const { tools, errors } = toolbox.aggregateTools(results);
    const meta = toolbox.appletMeta(); // descriptions and tags for applets that registered without their own
    return { entries: [...tools, ...apps.apps.map((a) => toolbox.appletEntry(a, meta))], errors: [...errors, ...apps.errors.map((e) => ({ ...e, error: `apps: ${e.error}` }))] };
  }

  /**
   * The catalog the planner and task briefs match tasks against. Cached for a minute and never slow: a dispatch waits
   * at most 4 s for it and goes ahead without hints when the mesh does not answer.
   */
  let catalogCache = { at: 0, entries: [] };
  async function toolCatalog() {
    if (Date.now() - catalogCache.at < 60000) return catalogCache.entries;
    try {
      const { entries } = await Promise.race([toolEntries(), new Promise((_, no) => setTimeout(() => no(new Error('timeout')), 4000))]);
      catalogCache = { at: Date.now(), entries };
    } catch { catalogCache = { at: Date.now() - 45000, entries: catalogCache.entries }; }
    return catalogCache.entries;
  }

  /**
   * Mesh-wide tool search: every online node's registered tools plus the App Cloud apps as kind "applet", ranked
   * together by toolbox.searchCatalog (q, tag, kind, node, limit). `track=1` (set by the rigs MCP's tool_list) also
   * logs the search as tool reuse (usage.recordToolEvent) with the ids it returned.
   */
  async function meshTools(searchParams, req) {
    const { entries: all, errors } = await toolEntries();
    const want = (searchParams.get('node') || '').toLowerCase();
    const entries = all.filter((e) => !want || e.node.toLowerCase() === want);
    const limit = searchParams.has('limit') ? Math.max(0, Number(searchParams.get('limit')) || 0) : 50;
    const results = toolbox.searchCatalog(entries, { q: searchParams.get('q') || '', tag: searchParams.get('tag') || '', kind: searchParams.get('kind') || '', limit });
    if (searchParams.get('track') === '1') usage.recordToolEvent({ event: 'list', query: searchParams.get('q') || searchParams.get('tag') || '', toolIds: results.map((r) => r.id), trace: traceOf(req)?.traceId, seat: callerSeat(req) });
    return { results, errors };
  }

  /**
   * The ad-hoc tools of every online node (toolbox.listAdhoc), merged like the tool catalog: { tools, errors }.
   * all=1 includes the merged ones; node= one machine.
   */
  async function meshAdhoc(searchParams) {
    if (!discovery.list().some((n) => n.self)) await discovery.tick();
    const all = searchParams.get('all') === '1';
    const want = (searchParams.get('node') || '').toLowerCase();
    const nodes = discovery.list().filter((n) => n.online && n.rigs && (!want || n.name.toLowerCase() === want || n.id === want));
    const results = await Promise.all(nodes.map((n) => (n.self ? toolbox.listAdhoc({ all }) : peerJson(n, `tools/adhoc${all ? '?all=1' : ''}`, { timeout: 7000 }))
      .then((r) => ({ node: n, tools: r.tools })).catch((e) => ({ node: n, error: e.message }))));
    return toolbox.aggregateAdhoc(results);
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
  async function askNode(nodeRef, text, { brain, model, effort, title, usage: tag, trace: tctx } = {}) {
    const c = await callNode(nodeRef, 'chats', { method: 'POST', body: { brain, model, effort, title } });
    return callNode(nodeRef, `chats/${c.id}/send?wait=1`, { method: 'POST', body: { text, brain, model, effort, usage: tag, ...(tctx ? { trace: tctx } : {}) }, timeout: 15 * 60 * 1000 });
  }

  /** Mesh-wide request traces (src/trace.js): every online node's summaries merged per traceId, like meshUsage. */
  async function meshTraces(searchParams) {
    const qs = new URLSearchParams(searchParams);
    if (!discovery.list().some((n) => n.self)) await discovery.tick();
    const nodes = discovery.list().filter((n) => n.online && n.rigs);
    const results = await Promise.all(nodes.map((n) => (n.self ? localCall('traces?' + qs) : peerJson(n, 'traces?' + qs, { timeout: 15000 }))
      .then((report) => ({ node: n, report })).catch((e) => ({ node: n, error: e.message }))));
    return { since: usage.parseTime(searchParams.get('since')) ?? null, ...trace.aggregateTraces(results, Object.fromEntries(searchParams)) };
  }

  /** Mesh-wide exhibit documents (src/exhibits.js): every online node's list, newest first. */
  async function meshExhibits() {
    if (!discovery.list().some((n) => n.self)) await discovery.tick();
    const nodes = discovery.list().filter((n) => n.online && n.rigs);
    const results = await Promise.all(nodes.map((n) => (n.self ? localCall('exhibits') : peerJson(n, 'exhibits', { timeout: 15000 }))
      .catch((e) => ({ node: n.name, error: e.message }))));
    return exhibits.aggregateExhibits(results);
  }

  /** One trace across the mesh: the spans every machine holds for it, in one tree. */
  async function meshTrace(id, searchParams) {
    if (!trace.isTraceId(id)) throw new HttpError(400, 'not a trace id');
    if (!discovery.list().some((n) => n.self)) await discovery.tick();
    const qs = new URLSearchParams(searchParams);
    const nodes = discovery.list().filter((n) => n.online && n.rigs);
    // RIGS machines that are down now still count: a trace that sent work there shows the hole (trace.mergeTrace gaps).
    const down = discovery.list().filter((n) => n.rigs && !n.online).map((n) => ({ node: n, error: n.error || 'offline' }));
    const results = [...await Promise.all(nodes.map((n) => (n.self ? localCall(`traces/${id}?${qs}`) : peerJson(n, `traces/${id}?${qs}`, { timeout: 15000 }))
      .then((report) => ({ node: n, report })).catch((e) => (/not found/.test(e.message) ? { node: n, report: { spans: [] } } : { node: n, error: e.message })))), ...down];
    const t = trace.mergeTrace(id, results);
    if (!t.spans.length && !searchParams.get('after')) throw new HttpError(404, 'trace not found on any machine');
    return t;
  }

  /** Mesh-wide usage ledger: every online node's records for the range, merged and aggregated (src/usage.js). */
  async function meshUsage(searchParams) {
    const qs = new URLSearchParams(searchParams);
    if (!discovery.list().some((n) => n.self)) await discovery.tick(); // the first scan may still be running
    const nodes = discovery.list().filter((n) => n.online && n.rigs);
    const results = await Promise.all(nodes.map((n) => (n.self ? localCall('usage?' + qs) : peerJson(n, 'usage?' + qs, { timeout: 15000 }))
      .then((report) => ({ node: n, report })).catch((e) => ({ node: n, error: e.message }))));
    try { return usage.aggregateUsage(results, Object.fromEntries(searchParams)); } catch (e) { throw new HttpError(400, e.message); }
  }

  /** Mesh-wide time saved by pre-routing: every online node's request records, merged, then one set of medians. */
  async function meshPrerouteStats(searchParams) {
    const qs = new URLSearchParams(searchParams);
    qs.set('records', '1');
    if (!discovery.list().some((n) => n.self)) await discovery.tick();
    const nodes = discovery.list().filter((n) => n.online && n.rigs);
    const results = await Promise.all(nodes.map((n) => (n.self ? localCall('preroute/stats?' + qs) : peerJson(n, 'preroute/stats?' + qs, { timeout: 15000 }))
      .then((report) => ({ node: n, report })).catch((e) => ({ node: n, error: e.message }))));
    return { since: usage.parseTime(searchParams.get('since') || '30d'), ...prerouteStats.aggregateStats(results, { baselineMs: config().router?.baselineMs || {} }) };
  }

  const plannerCtx = {
    snapshot: meshSnapshot,
    tools: toolCatalog,
    call: callNode,
    ask: askNode,
    notify: (text, level = 'info') => broadcastNotify({ text, level, speak: true, from: config().name }),
    // Results and problems are also written into the JARVIS thread (and the request's own thread), then the UI refreshes it.
    report: async (p, text, level = 'info') => {
      const r = await chat.postReport({ text, level, chatId: p.chatId || '', project: p });
      broadcast({ type: 'chat-updated', chats: r.chats });
      return r;
    },
    // A finished project lets its agent team go (rig down keeps transcripts and a snapshot).
    release: (p) => {
      const rigs = new Map();
      // Pinned projects' hub rigs are persistent (idle workers are reaped by hubs.reapIdle): never downed here.
      for (const t of p.tasks) if (t.run?.mode === 'openrig' && t.run.rig && !t.run.hub) rigs.set(`${t.assign?.node}|${t.run.rig}`, { node: t.assign?.node, run: t.run });
      for (const { node, run: r } of rigs.values()) callNode(node, 'work/stop', { method: 'POST', body: r, timeout: 150000 }).catch((e) => log('release:', e.message));
    },
    // A finished RIGS self-change: its worktree lives on the project's own machine (this one — fileWork made it here).
    propose: (p) => callNode(p.repo.node, 'dev/propose', { method: 'POST', body: { dir: p.repo.path, stripManaged: true, title: p.name, summary: truncate(`${p.goal}\n\n${p.tasks.map((t) => `- ${t.title}: ${t.summary}`).join('\n')}`, 4000) }, timeout: 60000 }),
  };

  async function broadcastNotify(b) {
    // One notification, one voice (tts-plan.js notifyVoice): when the speakers on this machine are asked for (aloud), the
    // open UIs must not speak it as well, or Sir hears it twice. Otherwise the UIs speak it, and the speakers only when no UI saw it.
    const voiced = notifyVoice(b);
    b = voiced.ui;
    const all = discovery.list().filter((n) => n.online && n.rigs);
    const results = await Promise.all(all.map((n) => (n.self ? localCall('notify', 'POST', b) : peerJson(n, 'notify', { method: 'POST', body: b })).then((r) => ({ node: n.name, ...r })).catch((e) => ({ node: n.name, error: e.message }))));
    // Nobody is looking at a JARVIS UI (or the caller asked for it): say it through this machine's speakers.
    const seen = results.some((r) => r.delivered > 0);
    if (!process.env.RIGS_NO_NOTIFY && voiced.speakers(seen, config().persona.speakAloud)) {
      tts.speakAloud(String(b.text || '').slice(0, 2000)).catch((e) => log('tts', e.message));
      results.push({ node: config().name, aloud: true });
    }
    return results;
  }

  /**
   * ui_open: open a view (the file browser) in JARVIS at a machine + path. The path is looked up on that machine (a
   * file opens its folder with it selected; a missing one its nearest parent), then pushed to the UI that sent the
   * request (sockets that claimed its trace, on any machine), else to every open UI on the mesh.
   */
  async function openUiView(b, tctx) {
    const args = uiOpen.validateOpen(b);
    if (!discovery.list().some((n) => n.self)) await discovery.tick(); // the first scan has not finished yet
    const nodes = discovery.list();
    const findWorkspace = async (name, machine) => {
      const r = workspaces.resolve({ workspace: name, machine }, await meshWorkspaces());
      return r.workspace ? { node: r.node, path: r.workspace.path, name: r.workspace.name } : null;
    };
    const t = await uiOpen.resolveTarget(args, { nodes, findWorkspace });
    if (!t.node) throw new HttpError(404, 'no machine to open it on');
    if (!t.node.self && !(t.node.online && t.node.rigs)) throw new HttpError(503, `${t.node.name} is offline`);
    const located = await callNode(t.node.id, `ui/locate?path=${encodeURIComponent(t.path)}`, { timeout: 15000 });
    const traceId = tctx?.traceId || '';
    const event = uiOpen.uiOpenEvent({ view: args.view, node: t.node, located, requested: args.path || t.path, trace: traceId, workspace: t.workspace });
    const live = nodes.filter((n) => n.self || (n.online && n.rigs));
    const push = (only) => Promise.all(live.map((n) => callNode(n.id, 'ui/push', { method: 'POST', body: { event, only }, timeout: 8000 })
      .then((r) => ({ node: n.name, delivered: r.delivered || 0 })).catch((e) => ({ node: n.name, delivered: 0, error: e.message }))));
    let rounds = traceId ? await push(traceId) : [];
    const target = uiOpen.deliveredCount(rounds) ? 'requester' : 'all';
    if (target === 'all') rounds = await push('');
    const delivered = uiOpen.deliveredCount(rounds);
    return {
      ok: delivered > 0, view: args.view, node: t.node.name, path: event.path, select: event.select || undefined, missing: event.missing,
      requested: event.requested, via: t.via, ...(t.workspace ? { workspace: t.workspace } : {}), ...(t.moved ? { note: `${t.workspace} lives on ${t.node.name}, not ${t.moved}` } : {}),
      shownOn: target, delivered, ...(delivered ? {} : { message: 'No JARVIS window is open anywhere on the mesh, so nothing could be shown.' }),
    };
  }

  /** A background agent session just started here: pop it up as a terminal in every open JARVIS UI (unless surface:false). */
  function announceSession(req, session, { agent, title }) {
    if (req?.surface === false || !session?.id) return;
    const self = config();
    const t = String(title || session.id).slice(0, 80);
    broadcastNotify({ text: `${agent} · ${t} started on ${self.name}`, speak: false, from: self.name, session: { nodeId: self.nodeId, nodeName: self.name, kind: session.kind, id: session.id, title: t } }).catch((e) => log('session-popup', e.message));
  }

  /** Every new OpenRig seat surfaces as a terminal in every JARVIS UI (the session-popups mechanism). */
  function announceSeats(req, seats, where) {
    for (const seat of seats || []) announceSession(req, { kind: 'rig', id: seat }, { agent: 'OpenRig', title: `${seat.split('@')[0].replace(/^team-/, '')} seat${where ? ' · ' + String(where).split(/[\\/]/).pop() : ''}` });
  }

  /** Calls to the machine that hosts the jarvis rig (the core brain's). */
  function jarvisCall(sub, method = 'GET', body) {
    const core = config().brain?.core?.node;
    // A lookup must not hold up Sir's instruction: a slow or absent overseer just means no overseer this time.
    const call = callNode(!core || core === config().name ? 'self' : core, sub, { method, body, timeout: method === 'GET' ? 5000 : 30000 });
    return method === 'GET' ? Promise.race([call, new Promise((r) => setTimeout(r, 5000, null))]) : call; // local calls have no timeout of their own
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
    if (sub === 'bins') return detectTools(q.get('force') === '1');
    // tool registry (src/toolbox.js): scripts filed by agents, listed, read, registered and run here
    if (sub === 'tools' && method === 'GET') return toolbox.listLocal();
    if (sub === 'tools/register' && method === 'POST') return toolbox.registerTool(await body());
    // ad-hoc tools: what is filed here and not merged yet; promote copies them into a dev worktree for a later merge
    if (sub === 'tools/adhoc' && method === 'GET') return toolbox.listAdhoc({ all: q.get('all') === '1' });
    if (sub === 'tools/promote' && method === 'POST') {
      const b = await body();
      const ids = [].concat(b.ids ?? b.id ?? []);
      const worktree = b.worktree ? files.resolvePath(b.worktree) : (await merge.startWork(b.topic || `tools ${ids.join(' ')}`)).dir;
      return toolbox.promoteTools(ids, { worktree });
    }
    if (sub === 'tools/drop' && method === 'POST') { const b = await body(); return toolbox.dropAdhoc([].concat(b.ids ?? b.id ?? []), { force: b.force === true }); }
    if ((mm = m(/^tools\/([^/]+)$/)) && method === 'GET') return toolbox.getTool(decodeURIComponent(mm[1]));
    if ((mm = m(/^tools\/([^/]+)\/run$/)) && method === 'POST') {
      const b = await body();
      const id = decodeURIComponent(mm[1]);
      const t0 = Date.now();
      let r;
      try { r = await toolbox.runTool(id, { args: b.args ?? {}, allowMutating: b.allowMutating === true, timeoutSec: b.timeoutSec, cwd: b.cwd }); } catch (e) { if (e.code !== 'not-found' && e.code !== 'bad-id') recordToolRun(req, b, id, t0, null, e.message); throw e; }
      recordToolRun(req, b, id, t0, r);
      return r;
    }
    if (sub === 'config' && method === 'GET') return publicConfig();
    if (sub === 'config' && method === 'POST') {
      const b = await body();
      patchConfig(b);
      if (b?.experimental?.starnet) starnet.events.emit('config', starnet.status()); // open UIs switch views at once
      return publicConfig();
    }

    // shared folder (src/shared.js): status, manifest, raw files, forced sync, peer nudges
    if (sub === 'shared' || sub.startsWith('shared/')) {
      return shared.sharedRoute(sharedEngine, { method, sub, q, req, res, known: () => rigsPeers().map((n) => ({ name: n.name, online: n.online })) });
    }

    // files
    if (sub === 'files' && method === 'GET') return files.list(q.get('path') || '~', { showHidden: q.get('hidden') === '1' || config().files.showHidden });
    if (sub === 'files/read') return files.readText(q.get('path'));
    if (sub === 'files/raw') { // GET or HEAD; Range → 206 (media seeking), see files.sendFile
      if (!res) throw new HttpError(400, 'stream only');
      await files.sendFile(q.get('path'), res, { download: q.get('download') === '1', range: req.headers?.range, head: method === 'HEAD' });
      return undefined;
    }
    if (sub === 'files/write' && method === 'PUT') return files.writeStream(q.get('path'), req);
    if (sub === 'files/text' && method === 'POST') { const b = await body(); return files.writeText(b.path, b.text ?? ''); }
    if (sub === 'files/mkdir' && method === 'POST') return files.mkdir((await body()).path);
    if (sub === 'files/rename' && method === 'POST') { const b = await body(); return files.rename(b.from, b.to); }
    if (sub === 'files/trash' && method === 'POST') return files.trash((await body()).path);
    if (sub === 'files/zip' && method === 'POST') { const b = await body(); return files.zip(b.paths, b.dest, { config: config().files?.zip }); }
    if (sub === 'files/unzip' && method === 'POST') { const b = await body(); return files.unzip(b.path, b.dest, { config: config().files?.zip }); }

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
    if (sub === 'workspaces' && method === 'GET') return workspaces.list({ force: q.get('force') === '1', extraDirs: await sessionDirs() });
    if (sub === 'sessions/transcript') {
      const kind = q.get('kind');
      const id = q.get('id');
      if (kind === 'chat') { const c = await chat.getChat(id); if (!c) throw new HttpError(404, 'not found'); return c.messages.map((x) => ({ role: x.role, text: x.text, ts: x.ts, name: x.brain })); }
      const t = await sessions.transcript(kind, id);
      if (!t) throw new HttpError(404, 'session not found');
      return t;
    }
    if (sub === 'sessions/send' && method === 'POST') { const b = await body(); return sessions.send(b.kind, b.id, b.text); }
    if (sub === 'sessions/state') return sessions.resumeState(q.get('kind'), q.get('id'));
    if (sub === 'sessions/prompt') return sessions.promptOptions(q.get('kind'), q.get('id'));
    if (sub === 'sessions/answer' && method === 'POST') { const b = await body(); return sessions.answerOption(b.kind, b.id, b.choice); }
    if (sub === 'sessions/attach' && method === 'POST') { const b = await body(); return sessions.attach(b.kind, b.id, b); }
    if (sub === 'agents/start' && method === 'POST') {
      const b = await body();
      const r = await sessions.startAgent(b);
      const id = r.kind === 'pty' ? r.ptyId || r.id : r.id;
      announceSession(b, { kind: r.kind, id }, { agent: b.agent || 'claude', title: b.name || r.id });
      return r;
    }

    // chats / brains
    if (sub === 'brains') return chat.availableBrains();
    if (sub === 'ollama') return ollamaModels();
    if (sub === 'chats' && method === 'GET') return chat.listChats();
    if (sub === 'chats' && method === 'POST') return chat.createChat(await body());
    if (sub === 'chats/main/clear' && method === 'POST') return chat.clearMainChat();
    if ((mm = m(/^chats\/([\w-]+)$/)) && method === 'GET') { const c = await chat.getChat(mm[1]); if (!c) throw new HttpError(404, 'not found'); return c; }
    if ((mm = m(/^chats\/([\w-]+)$/)) && method === 'DELETE') return { ok: await chat.deleteChat(mm[1]) };
    if (sub === 'jarvis/send' && method === 'POST') {
      // One JARVIS for the whole mesh: a request that reaches any machine goes to the main-brain machine (src/globalbrain.js),
      // which answers and delegates. Relayed once (x-rigs-relayed marks our relay; gateway proxy hops don't set it); if the
      // main brain is offline we answer here.
      const relay = relayTarget(config(), config().name, { via: req?.headers?.['x-rigs-relayed'] || '' });
      const home = relay ? discovery.get(relay) : null;
      if (home && !home.self && home.online && home.rigs && res) { req.headers['x-rigs-relayed'] = config().name; forwardHttp(home, req, res, 'jarvis/send'); return undefined; }
      const b = await body();
      const ac = new AbortController();
      res.on('close', () => { if (!res.writableEnded) ac.abort(); });
      res.writeHead(200, { 'content-type': 'application/x-ndjson; charset=utf-8', 'cache-control': 'no-store', 'x-accel-buffering': 'no' });
      const hb = setInterval(() => res.write('{"type":"ping"}\n'), 15000);
      // Intake: the request gets its trace here (src/trace.js); router, brain turn, tools and handoffs hang off this span.
      const intake = startIntake(req, String(b.text || ''), 'jarvis/send', b);
      res.write(JSON.stringify({ type: 'trace', traceId: intake.traceId }) + '\n');
      if (relay) res.write(JSON.stringify({ type: 'status', text: `The main brain on ${relay} is unreachable — answering on ${config().name}.` }) + '\n');
      const seen = intakeWatcher();
      try {
        await chat.jarvisSend(String(b.text || ''), b, (e) => { seen.see(e); res.write(JSON.stringify(e) + '\n'); }, { meshSummary: meshSummary(), projects: await projectsSummary(), signal: ac.signal, workspaces: meshWorkspaces, onWork: fileWork, trace: intake.ctx, preroute: b.preroute, quick: b.quick, yolo: b.yolo });
      } catch (e) {
        seen.see({ type: 'error', message: e.message });
        res.write(JSON.stringify({ type: 'error', message: e.message }) + '\n');
      } finally { clearInterval(hb); intake.end(seen.result(ac.signal.aborted)); res.end(); }
      return undefined;
    }
    if ((mm = m(/^chats\/([\w-]+)\/send$/)) && method === 'POST') {
      const b = await body();
      // A turn that belongs to a traced request (a project's planning call) attaches to it; Sir typing into a chat
      // directly is a request of its own and gets its own trace. Other untagged calls (mesh_ask…) are not traced.
      const parent = traceOf(req, b);
      const intake = !parent && !b.usage && res && q.get('wait') !== '1' ? startIntake(req, String(b.text || ''), `chats/${mm[1]}/send`, b) : null;
      const tctx = parent || intake?.ctx || null;
      if (!res || q.get('wait') === '1') {
        let final = null;
        await chat.sendMessage(mm[1], b, (e) => { if (e.type === 'done' || e.type === 'error') final = { ...(final || {}), ...e }; }, { meshSummary: meshSummary(), projects: await projectsSummary(), trace: tctx });
        return final;
      }
      res.writeHead(200, { 'content-type': 'application/x-ndjson; charset=utf-8', 'cache-control': 'no-store', 'x-accel-buffering': 'no' });
      const ac = new AbortController();
      res.on('close', () => { if (!res.writableEnded) ac.abort(); });
      const hb = setInterval(() => res.write('{"type":"ping"}\n'), 15000);
      if (intake) res.write(JSON.stringify({ type: 'trace', traceId: intake.traceId }) + '\n');
      const seen = intakeWatcher();
      try {
        await chat.sendMessage(mm[1], b, (e) => { seen.see(e); res.write(JSON.stringify(e) + '\n'); }, { meshSummary: meshSummary(), projects: await projectsSummary(), signal: ac.signal, trace: tctx });
      } catch (e) {
        seen.see({ type: 'error', message: e.message });
        res.write(JSON.stringify({ type: 'error', message: e.message }) + '\n');
      } finally { clearInterval(hb); intake?.end(seen.result(ac.signal.aborted)); res.end(); }
      return undefined;
    }

    // model catalog + this machine's core brain (provider / exact model / effort)
    if (sub === 'models') return models.catalog();
    if (sub === 'brain/core' && method === 'GET') return models.coreBrain();
    // Global JARVIS settings: { rev, by, settings, home }. POST adopts a peer's newer revision (never re-broadcast).
    if (sub === 'global' && method === 'GET') return { ...currentGlobal(), home: homeNode(config()) };
    if (sub === 'global' && method === 'POST') { const adopted = adoptGlobal(await body()); if (adopted) broadcast({ type: 'global', ...currentGlobal() }); return { adopted, ...currentGlobal() }; }
    // Dock layout + app dock, per-key revisions. PUT stamps and pushes; POST ui-layout/adopt is the peer-facing, never re-broadcast one.
    if (sub === 'ui-layout' && method === 'GET') return layoutStore.snapshot();
    if (sub === 'ui-layout' && method === 'PUT') { const b = await body(); try { return layoutStore.set(b.key, b.value, { baseRev: b.baseRev }); } catch (e) { layoutErr(e); } }
    if (sub === 'ui-layout/adopt' && method === 'POST') return { adopted: layoutStore.adopt(await body()) };
    // The main brain: the machine (and its conversational brain) every JARVIS on the mesh talks to.
    if (sub === 'brain/home' && method === 'POST') {
      const b = await body();
      const n = b.node ? discovery.get(b.node) : null;
      if (b.node && !n) throw new HttpError(400, `unknown machine ${b.node}`);
      const chat = b.provider ? { chat: { provider: b.provider, model: b.model || '', effort: b.effort || '' } } : {};
      patchConfig({ brain: { home: n ? n.name : '', ...chat } });
      return { ...currentGlobal(), home: homeNode(config()) };
    }
    if (sub === 'brain/chat' && method === 'GET') return models.chatBrain();
    if (sub === 'brain/chat' && method === 'POST') {
      const b = await body();
      patchConfig({ brain: { chat: { provider: b.provider || 'claude', model: b.model || '', effort: b.effort || '' } } });
      if (b.provider === models.CLAUDE_OLLAMA && b.model) patchConfig({ brain: { claudeOllama: { model: b.model } } });
      return models.chatBrain();
    }
    if (sub === 'emotion' && method === 'POST') { const b = await body(); return senses.emotion(b.text); }
    if (sub === 'stt' && method === 'POST') {
      // raw audio body (webm/ogg/mp4/wav) → text, via the jarvis-voice app's Whisper
      const chunks = [];
      let size = 0;
      for await (const c of req) { size += c.length; if (size > 25 * 1024 * 1024) throw new HttpError(413, 'recording too long'); chunks.push(c); }
      if (!size) throw new HttpError(400, 'no audio');
      try { return await senses.stt(Buffer.concat(chunks), { contentType: req.headers['content-type'], lang: q.get('lang') || undefined }); } catch (e) { throw new HttpError(e.status || 502, e.message); }
    }
    if (sub === 'brain/core' && method === 'POST') {
      const b = await body();
      const cfg = config();
      cfg.brain.core = { provider: b.provider || 'auto', model: b.model || '', effort: b.effort || '', node: b.node || cfg.name };
      patchConfig({ brain: { core: cfg.brain.core } });
      // the local-model brain remembers its model (it is the default when a chat doesn't name one)
      if (cfg.brain.core.provider === models.CLAUDE_OLLAMA && cfg.brain.core.model) patchConfig({ brain: { claudeOllama: { model: cfg.brain.core.model } } });
      return models.coreBrain();
    }
    if (sub === 'connectors/google-drive' || sub.startsWith('connectors/google-drive/')) return googleDriveRoute(drive, { method, sub: sub.slice('connectors/google-drive/'.length), q, req, res, body });
    if (sub.startsWith('comfyui/')) return comfyRoute(comfy, { method, sub: sub.slice('comfyui/'.length), q, req, res, body });
    if (sub.startsWith('linear/')) return linearRoute(linear, { method, sub: sub.slice('linear/'.length), q, body });
    if (sub.startsWith('connectors/slack/')) return slackRoute(slack, { method, sub: sub.slice('connectors/slack/'.length), q, body });
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
    if (sub === 'pins' && method === 'GET') return { pinnedProjects: config().pinnedProjects || [] };
    if (sub === 'pins' && method === 'POST') {
      // Pin / unpin a project folder on this machine ({ path, name?, remove? }).
      const b = await body();
      const p = String(b.path || '').trim().replace(/(.)[\\/]+$/, '$1');
      if (!p) throw new HttpError(400, 'path required');
      const cfg = config();
      const rest = (cfg.pinnedProjects || []).filter((x) => x.path !== p);
      if (!b.remove) rest.push({ name: String(b.name || '').trim() || p.split(/[\\/]/).filter(Boolean).pop() || p, path: p });
      cfg.pinnedProjects = rest;
      saveConfig(cfg);
      return { pinnedProjects: rest };
    }
    // usage ledger: what each chat turn, planning call and task run spent on this machine (src/usage.js)
    if (sub === 'usage' && method === 'GET') {
      try { return await usage.report(Object.fromEntries(q)); } catch (e) { throw new HttpError(400, e.message); }
    }
    if (sub === 'usage/slice' && method === 'POST') return usage.taskUsage(await body());
    // request traces kept on this machine (src/trace.js)
    if (sub === 'traces' && method === 'GET') {
      try { return await trace.list(Object.fromEntries(q), usage.parseTime); } catch (e) { throw new HttpError(400, e.message); }
    }
    if ((mm = m(/^traces\/([\w-]+)$/)) && method === 'GET') {
      const t = await trace.get(mm[1], { after: q.get('after') || 0 });
      if (!t) throw new HttpError(400, 'not a trace id');
      if (!t.spans.length && !q.get('after')) throw new HttpError(404, 'trace not found on this machine');
      return t;
    }
    // exhibit documents kept on this machine (src/exhibits.js)
    if (sub === 'exhibits' && method === 'GET') return exhibitSvc.list();
    if (sub === 'exhibits/attach' && method === 'POST') {
      const b = await body();
      const pid = String(b?.projectId || '').replace(/^pr-/, '');
      if (!/^[\w-]+$/.test(pid)) throw new HttpError(400, 'projectId required');
      const pr = await planner.getProject(pid);
      if (!pr) throw new HttpError(404, 'project not found on this machine (attach on the machine that owns it)');
      try { return await exhibitSvc.attach(pr); } catch (e) { throw new HttpError(/off/.test(e.message) ? 409 : 400, e.message); }
    }
    if (sub === 'exhibits/config' && method === 'GET') return exhibits.settings();
    if (sub === 'exhibits/config' && method === 'POST') { try { return exhibits.saveSettings(await body()); } catch (e) { throw new HttpError(400, e.message); } }
    // experimental StarNet space-station view (src/starnet.js): the flag and the pinned install on this machine
    if (sub === 'starnet/config' && method === 'GET') return starnet.status();
    if (sub === 'starnet/config' && method === 'POST') { try { return starnet.saveSettings(await body()); } catch (e) { throw new HttpError(400, e.message); } }
    if (sub === 'starnet/install' && method === 'POST') { const b = await body(); try { return await starnet.install({ from: b?.from || '', force: !!b?.force }); } catch (e) { throw new HttpError(/already running/.test(e.message) ? 409 : 500, e.message); } }
    if ((mm = m(/^exhibits\/([\w-]+)$/)) && method === 'GET') {
      if (!exhibits.isDocId(mm[1])) throw new HttpError(400, 'not an exhibit document id');
      const d = await exhibitSvc.get(mm[1]);
      if (!d) throw new HttpError(404, 'no such exhibit document on this machine');
      return d;
    }
    if ((mm = m(/^exhibits\/([\w-]+)\/images\/([\w.-]+)$/)) && method === 'GET') {
      const img = await exhibitSvc.image(mm[1], mm[2]);
      if (!img) throw new HttpError(404, 'no such image');
      if (!res) return { mime: img.mime, base64: img.bytes.toString('base64') };
      res.writeHead(200, { 'content-type': img.mime, 'cache-control': 'max-age=86400' });
      res.end(img.bytes);
      return undefined;
    }
    if ((mm = m(/^exhibits\/([\w-]+)\/export$/)) && method === 'GET') {
      const format = q.get('format') || 'html';
      if (!['md', 'html'].includes(format)) throw new HttpError(400, 'format must be md or html');
      const x = await exhibitSvc.exportDoc(mm[1], format);
      if (!x) throw new HttpError(404, 'no such exhibit document on this machine');
      if (!res) return x;
      res.writeHead(200, { 'content-type': x.mime, 'cache-control': 'no-store', ...(q.get('download') === '1' ? { 'content-disposition': `attachment; filename="${mm[1]}.${x.ext}"` } : {}) });
      res.end(x.body);
      return undefined;
    }
    // a task run that ran here ended: its transcript slice → spans under its task span (trace.recordRunEnd)
    if (sub === 'traces/run-end' && method === 'POST') return (await trace.recordRunEnd(await body(), { transcripts: usage.runTranscripts })) || { skipped: true };
    if (sub === 'usage/backfill' && method === 'POST') return usage.backfill();

    if (sub === 'apps' && method === 'GET') return appsReg.localApps();
    if ((mm = m(/^app-start\/([^/]+)$/)) && method === 'POST') {
      // Spin an app up on this machine (its launch recipe) and wait until it answers its health check.
      try { return { ...(await appsReg.startApp(decodeURIComponent(mm[1]))), apps: appsReg.localApps().apps }; } catch (e) { throw new HttpError(e.status || 500, e.message); }
    }
    if (sub === 'apps' && method === 'POST') {
      // Register / update / remove one app in this node's config ({ ...app } or { id, remove: true }).
      try { return await appsReg.upsertApp(await body()); } catch (e) { throw new HttpError(e.status || 500, e.message); }
    }
    // App Store (src/appstore.js): the catalog with fit + install state, and install jobs on this machine.
    if (sub === 'appstore' && method === 'GET') return appstore.list();
    if ((mm = m(/^appstore\/([^/]+)(?:\/(install|uninstall|cancel|job))?$/))) {
      const id = decodeURIComponent(mm[1]);
      const op = mm[2] || '';
      try {
        if (!op && method === 'GET') return await appstore.detail(id);
        if (op === 'job' && method === 'GET') return appstore.jobFor(id);
        if (op === 'install' && method === 'POST') return appstore.install(id, await body());
        if (op === 'uninstall' && method === 'POST') return await appstore.uninstall(id);
        if (op === 'cancel' && method === 'POST') return appstore.cancel(id);
      } catch (e) { throw new HttpError(e.status || 500, e.message); }
    }
    // Pre-routing (src/router.js): on/off, engine (LocalJev · Claude · rules) and the time it saves (src/preroute-stats.js).
    if (sub === 'router' && method === 'GET') return routerView();
    if (sub === 'router' && method === 'POST') {
      let next;
      try { next = applyRouterPatch(config().router, await body()); } catch (e) { throw new HttpError(400, e.message); }
      const cfg = config();
      cfg.router = next;
      saveConfig(cfg);
      markGlobalChanged();
      return routerView();
    }
    if (sub === 'preroute/stats' && method === 'GET') return prerouteStats.report(Object.fromEntries(q));
    // Quick-task fast path (src/quick.js): on/off and the model per tier; `local` = the local responder (src/responder.js).
    if (sub === 'quick' && method === 'GET') return { ...quickSettings(config().quick), local: localSettings(config().quick?.local) };
    if (sub === 'quick' && method === 'POST') {
      const b = await body();
      let next;
      try { next = applyQuickPatch(config().quick, b); } catch (e) { throw new HttpError(400, e.message); }
      // Switched on without a host: the machine it was switched on at hosts the model (its own Ollama).
      if (b.local?.enabled !== undefined && next.local?.enabled && !next.local.node) next.local.node = config().name;
      const cfg = config();
      cfg.quick = next;
      saveConfig(cfg);
      if (b.local !== undefined) {
        markGlobalChanged(); // config.quick is a mesh-global setting: the main-brain machine must see the switch
        if (next.local?.enabled && next.local.node === config().name) responder.warm(next.local, { soul: chat.soul() }); // background
      }
      return { ...next, local: localSettings(next.local) };
    }
    // YOLO mode (src/yolo.js, contract at its top): the runs kept here, the settings, and each run's sandbox — its files
    // (path-confined, served as an opaque-origin sandbox), live-reload events, the page's runtime errors, stop.
    if (sub === 'yolo' && method === 'GET') return { settings: yolo.yoloSettings(config().yolo), runs: await yolo.listRuns({ limit: Number(q.get('limit')) || 50 }) };
    if (sub === 'yolo/config' && method === 'GET') return yolo.yoloSettings(config().yolo);
    if (sub === 'yolo/config' && method === 'POST') {
      let next;
      try { next = yolo.applyYoloPatch(config().yolo, await body()); } catch (e) { throw new HttpError(400, e.message); }
      const cfg = config();
      cfg.yolo = next;
      saveConfig(cfg);
      markGlobalChanged(); // mesh-global: requests run on the main-brain machine, which must see the switch
      return yolo.yoloSettings(next);
    }
    if ((mm = m(/^yolo\/(y-\d{8}-\d{6}-[0-9a-f]{6})\/keep$/)) && method === 'POST') {
      // Keep as app (src/yolo-keep.js): the finished run → <shared>/apps/<id>/ + a static server, published to the App
      // Cloud. A YOLO page (Origin: null) never gets here: opaqueOriginRefused answered 403 already.
      try { return await yoloKeep.keepRun(mm[1], await body().catch(() => ({}))); } catch (e) { throw new HttpError(e.status || 500, e.message); }
    }
    if ((mm = m(/^yolo\/([^/]+)(?:\/([\s\S]*))?$/))) {
      try { return await yolo.handle(req, res, mm[1], mm[2], { query: q, body }); } catch (e) { throw new HttpError(e.status || 500, e.message); }
    }
    // The local responder on this machine (src/responder.js): status, warm-up, busy (for the GPU overseer), and the
    // host side of a turn another machine's fast path streams from here (NDJSON).
    if (sub === 'responder' && method === 'GET') return responder.status();
    if (sub === 'responder/warm' && method === 'POST') return responder.warm(config().quick?.local, { soul: chat.soul() });
    if (sub === 'responder/busy' && method === 'GET') return { busy: responder.isBusy() };
    if (sub === 'responder/turn' && method === 'POST') {
      const b = await body();
      if (!res) return responder.hostTurn(b, () => {}, { soul: config().persona?.soul === false ? '' : chat.soul() });
      const ac = new AbortController();
      res.on('close', () => { if (!res.writableEnded) ac.abort(); });
      res.writeHead(200, { 'content-type': 'application/x-ndjson; charset=utf-8', 'cache-control': 'no-store', 'x-accel-buffering': 'no' });
      const hb = setInterval(() => res.write('{"type":"ping"}\n'), 15000);
      try {
        await responder.hostTurn(b, (e) => res.write(JSON.stringify(e) + '\n'), { soul: config().persona?.soul === false ? '' : chat.soul(), signal: ac.signal });
      } catch (e) { res.write(JSON.stringify({ type: 'error', message: e.message }) + '\n'); } finally { clearInterval(hb); res.end(); }
      return undefined;
    }
    if (sub === 'routing' && method === 'GET') return config().routing;
    if (sub === 'routing' && method === 'POST') {
      const b = await body();
      if (b.reset) { const cfg = config(); cfg.routing.customized = false; cfg.routing.rulesVersion = 0; saveConfig(cfg); loadConfig(); return config().routing; }
      patchConfig({ routing: { ...b, customized: b.rules ? true : config().routing.customized } });
      return config().routing;
    }

    // projects (owned by this machine) and the work they dispatch to machines
    if (sub === 'projects' && method === 'GET') return planner.listProjects();
    if (sub === 'work' && method === 'GET') {
      // the work dashboard: live agent sessions, JARVIS replies in progress, projects in flight (+ plan limits with ?plan=1, for the tray)
      const [sess, projects, codex] = await Promise.all([usage.liveSessions().catch(() => []), Promise.resolve(planner.listProjects()).catch(() => []), usage.codexLimits().catch(() => null)]);
      return {
        node: config().name, sessions: sess, jarvis: [...chat.activeTurns.values()], projects: usage.projectProgress(projects), codex,
        plan: q.get('plan') === '1' ? await usage.planLimits({ force: q.get('force') === '1' }) : undefined,
      };
    }
    if (sub === 'projects' && method === 'POST') {
      const b = await body();
      const tctx = traceOf(req, b) || chat.soleActiveTrace(callerAgent(req));
      if (!tctx) return planner.createProject(b);
      // project_create inside a traced request: the project keeps the handoff span's context for its plan and tasks.
      const hs = trace.startSpan({ ...tctx, kind: 'handoff', name: 'project_create', input: { goal: b.goal, name: b.name || '', repoNode: b.repoNode || '', repoPath: b.repoPath || '' } });
      try {
        const p = await planner.createProject(b);
        p.trace = hs.ctx;
        await planner.saveProject(p);
        hs.end({ output: handoffOutput(p), meta: { projectId: p.id, owner: p.owner, taskIds: [] } });
        return p;
      } catch (e) { hs.end({ status: 'error', output: { error: e.message } }); throw e; }
    }
    if (sub === 'projects/intake' && method === 'POST') {
      // JARVIS files an instruction under a project and casts an agent for it. Matched before projects/<id>, which
      // would otherwise read "intake" as a project id ("project not found"). The project may live on another
      // machine: forward to its owner. The main "rigs" project is created here when no machine has it — or when
      // the machine that has it does not answer — so the default project never fails.
      const b = await body();
      // The request trace this instruction belongs to: from the MCP call, or the one traced brain turn running here.
      const tctx = traceOf(req, b) || chat.soleActiveTrace(callerAgent(req));
      if (tctx) b.trace = tctx;
      const want = b.newProject ? null : (b.project || planner.MAIN_ID);
      if (want && !(await planner.getProject(want))) {
        const owner = (await meshSnapshot()).find((e) => !e.node.self && !e.offline && (e.projects || []).some((x) => x.id === want));
        if (owner) {
          try { return await callNode(owner.node.id, 'projects/intake', { method: 'POST', body: b, timeout: 10 * 60 * 1000 }); }
          catch (e) { if (want !== planner.MAIN_ID) throw e; log(`intake: ${owner.node.name} (owner of "${want}") did not answer (${e.message}) — filing it here`); }
        } else if (want !== planner.MAIN_ID) throw new HttpError(404, `project ${want} not found on any machine`);
      }
      // JARVIS's overseer seat hands the work out: it is the recorded source, and gets Sir's instruction to own.
      if (!b.source) b.source = (await jarvisCall('hubs/jarvis', 'GET').catch(() => null))?.overseer || undefined;
      const hs = tctx ? trace.startSpan({ ...tctx, kind: 'handoff', name: 'jarvis_task', input: { title: b.title, instruction: b.instruction, project: b.project || '', newProject: b.newProject || null, kind: b.kind, size: b.size } }) : null;
      if (hs) b.trace = hs.ctx;
      let r;
      try { r = await planner.intake(b, plannerCtx); } catch (e) { hs?.end({ status: 'error', output: { error: e.message } }); throw e; }
      hs?.end({ status: r.task?.status === 'failed' ? 'error' : 'ok', output: { project: r.project, task: r.task ? { id: r.task.id, title: r.task.title, status: r.task.status, node: r.task.assign?.node || '', model: r.task.assign?.model || '' } : null, started: !!r.started, why: r.why || '' }, meta: { projectId: r.project?.id || '', owner: r.project?.owner || '', taskIds: r.task ? [r.task.id] : [] } });
      if (b.source && r.task) {
        jarvisCall('hubs/jarvis/intake', 'POST', { instruction: String(b.instruction || b.title), project: r.project, task: r.task, run: r.task.run })
          .catch((e) => log('intake → overseer:', e.message));
      }
      return { ...r, overseer: b.source || null };
    }
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
    if ((mm = m(/^projects\/([\w-]+)\/dispatch$/)) && method === 'POST') {
      const b = await body().catch(() => ({}));
      const pr = await planner.getProject(mm[1]);
      const tctx = traceOf(req, b) || pr?.trace || null;
      if (!tctx) return planner.dispatchReady(mm[1], plannerCtx);
      const t0 = Date.now();
      const hs = trace.startSpan({ ...tctx, kind: 'handoff', name: 'project_dispatch', input: { project: mm[1] }, start: t0 });
      try {
        const p = await planner.dispatchReady(mm[1], plannerCtx);
        const started = p.tasks.filter((t) => t.run?.startedAt >= t0).map((t) => t.id);
        hs.end({ output: handoffOutput(p), meta: { projectId: p.id, owner: p.owner, taskIds: started } });
        return p;
      } catch (e) { hs.end({ status: 'error', output: { error: e.message } }); throw e; }
    }
    if ((mm = m(/^projects\/([\w-]+)\/(stop|pause)$/)) && method === 'POST') { const b = await body().catch(() => ({})); return planner.stopProject(mm[1], plannerCtx, { reason: b?.reason, by: b?.by }); }
    if ((mm = m(/^projects\/([\w-]+)\/resume$/)) && method === 'POST') return planner.resumeProject(mm[1], plannerCtx);
    // Sir's answer to "How did it work out?" (the completion loop's last question), kept on the project.
    if ((mm = m(/^projects\/([\w-]+)\/feedback$/)) && method === 'POST') { const b = await body(); return planner.addFeedback(mm[1], { text: b.text, by: b.by }); }
    if ((mm = m(/^projects\/([\w-]+)\/tasks$/)) && method === 'POST') {
      if (!(await planner.getProject(mm[1]))) throw new HttpError(404, 'project not found');
      return (await planner.addTask(mm[1], await body(), await meshSnapshot())).project;
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
    if (sub === 'work/start' && method === 'POST') {
      const b = await body();
      const r = await work.startTask(b);
      if (r?.session) announceSession(b, r.session, { agent: b.task?.assign?.provider || r.mode, title: `${b.task?.id || ''} ${b.task?.title || ''}`.trim() || r.session.id });
      announceSeats(b, (r?.newSeats || []).filter((x) => x !== r.session?.id), b.project?.name);
      return r;
    }
    // persistent OpenRig rigs: pinned-project hubs and JARVIS's own rig (src/hubs.js)
    if (sub === 'hubs' && method === 'GET') return hubs.status();
    if (sub === 'hubs/up' && method === 'POST') { const b = await body(); const r = await hubs.up(b.path); announceSeats(b, r.newSeats, b.path); return r; }
    if (sub === 'hubs/down' && method === 'POST') return hubs.down((await body()).path);
    if (sub === 'hubs/send' && method === 'POST') { const b = await body(); const r = await hubs.sendToHub(b.path, b.text, b.seat); announceSeats(b, r.newSeats, b.path); return r; }
    if (sub === 'hubs/jarvis' && method === 'GET') return { overseer: await hubs.overseer(), core: hubs.isCoreNode() };
    if (sub === 'hubs/jarvis' && method === 'POST') { const r = await hubs.ensureJarvis(); announceSeats({}, r.newSeats, 'JARVIS'); return r; }
    if (sub === 'hubs/jarvis/intake' && method === 'POST') return hubs.overseerIntake(await body());
    if (sub === 'work/status' && method === 'POST') return work.taskStatus(await body());
    if (sub === 'work/stop' && method === 'POST') return work.stopTask(await body());
    if (sub === 'work/nudge' && method === 'POST') return work.nudgeTask(await body());
    if (sub === 'work/revive' && method === 'POST') return work.reviveTask(await body());
    if (sub === 'work/find' && method === 'POST') return work.findTask(await body());

    // change policy: work branches → merge steward (see src/merge.js)
    if (sub === 'dev/start' && method === 'POST') { const b = await body(); return merge.startWork(b.topic, { repo: b.repo || undefined }); }
    if (sub === 'dev/propose' && method === 'POST') return proposeBranch(await body());
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
    if (sub === 'processes' && method === 'GET') return processes.list({ filter: q.get('filter') || '', sort: q.get('sort') || 'cpu', limit: Number(q.get('limit')) || 80 });
    if (sub === 'processes/kill' && method === 'POST') return processes.kill(await body());
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
    if (sub === 'attention' && method === 'GET') {
      // ?options=1: each waiting terminal agent's question and numbered choices, read off its screen,
      // so it can be answered from the Work panel without opening the session.
      const items = attention.list();
      if (q.get('options') !== '1') return items;
      return Promise.all(items.map(async (it) => {
        const s = it.session;
        if (!s || !['tmux', 'rig'].includes(s.kind)) return it;
        const o = await sessions.promptOptions(s.kind, s.id).catch(() => null);
        return o ? { ...it, question: o.question, options: o.options } : it;
      }));
    }
    if (sub === 'attention/codex' && method === 'POST') return attention.codexEvent(await body());
    if (sub === 'access' && method === 'GET') return access.status(q.get('force') === '1');
    if (sub === 'access/full-disk' && method === 'POST') return access.grantFullDiskAccess();
    if (sub === 'access/grant' && method === 'POST') return access.grant((await body()).permission);
    if (sub === 'control' || sub.startsWith('control/')) return controlApi(sub.slice('control'.length).replace(/^\//, ''), req, res, q, body);
    // Live desktop stream: the WebSocket upgrade is in onUpgrade; a plain GET reports viewers and whether access is on.
    if (sub === 'screen/stream' && method === 'GET') {
      const refused = control.accessFor(controlCaller(req, config().name));
      if (refused) return { ...streamHub.status(), access: { ok: false, status: refused.code === 'off' ? 'control-off' : refused.code, message: refused.message } };
      const notReady = streamReadiness(await control.status());
      return { ...streamHub.status(), access: notReady ? { ok: false, ...notReady } : { ok: true } };
    }

    // ssh
    if (sub === 'ssh') return { user: ssh.sshUser(), pubKey: ssh.publicKey(), hostKeys: await ssh.hostKeys(), server: await ssh.serverStatus(), alias: config().name };
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
      const r = await tts.synthesize(b.text, b.voice);
      if (!res) return { bytes: r ? r.audio.length : 0, engine: r?.engine };
      if (!r) { res.writeHead(204, { 'cache-control': 'no-store' }); res.end(); return undefined; }
      // x-visemes: base64 JSON lipsync timeline when the engine provides one (Kokoro sends one; empty for the stand-in voices: the face follows the audio)
      res.writeHead(200, { 'content-type': 'audio/wav', 'content-length': r.audio.length, 'cache-control': 'no-store', 'x-tts-engine': r.engine, ...(r.visemes ? { 'x-visemes': r.visemes } : {}) });
      res.end(r.audio);
      return undefined;
    }
    if (sub === 'tts/say' && method === 'POST') { const b = await body(); return tts.speakAloud(b.text, b.voice); }

    // notifications to the JARVIS UI on this node
    if (sub === 'notify' && method === 'POST') {
      const b = await body();
      broadcast({ type: 'notify', text: String(b.text || '').slice(0, 2000), speak: b.speak !== false, from: b.from || config().name, level: b.level || 'info', action: b.action || null, session: b.session?.id ? { nodeId: b.session.nodeId, nodeName: b.session.nodeName, kind: b.session.kind, id: b.session.id, title: b.session.title } : null });
      return { ok: true, delivered: uiSockets.size };
    }

    // ui_open (src/ui-open.js): what to open for a path here, and the push to this machine's JARVIS UIs.
    if (sub === 'ui/locate' && method === 'GET') return files.locate(q.get('path') || '~');
    if (sub === 'ui/push' && method === 'POST') {
      const b = await body();
      const ev = b.event;
      if (!ev || ev.type !== 'ui-open' || !uiOpen.UI_VIEWS.includes(ev.view)) throw new HttpError(400, 'event must be a ui-open push');
      // only = a trace id: just the UIs that sent that request (none here → delivered 0, the caller widens it).
      const to = [...uiSockets].filter((w) => w.readyState === 1 && (!b.only || w.rigsTraces?.includes(b.only)));
      const s = JSON.stringify(ev);
      for (const w of to) w.send(s);
      return { ok: true, delivered: to.length };
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
    if (p === '/api/tools') return meshTools(url.searchParams, req);
    if (p === '/api/tools/adhoc') return meshAdhoc(url.searchParams);
    if (p === '/api/usage') return meshUsage(url.searchParams);
    if (p === '/api/preroute/stats') return meshPrerouteStats(url.searchParams);
    if (p === '/api/traces') return meshTraces(url.searchParams);
    if (p === '/api/exhibits') return meshExhibits();
    if ((mm = p.match(/^\/api\/traces\/([\w-]+)$/))) return meshTrace(mm[1], url.searchParams);
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
    if (p === '/api/mesh/ui/open' && req.method === 'POST') { const b = await readBody(req); return openUiView(b, traceOf(req, b)); }
    if (p === '/api/mesh/control/kill' && req.method === 'POST') {
      // "Hands off everywhere": switch screen control off on every online machine.
      const b = await readBody(req);
      const nodes = discovery.list().filter((n) => n.online && n.rigs);
      return Promise.all(nodes.map((n) => (n.self ? localCall('control/kill', 'POST', b) : peerJson(n, 'control/kill', { method: 'POST', body: b, timeout: 15000 }))
        .then((r) => ({ node: n.name, ...r })).catch((e) => ({ node: n.name, error: e.message }))));
    }
    if (p === '/api/mesh/workspaces') {
      const catalog = await meshWorkspaces({ force: url.searchParams.get('force') === '1' });
      const query = url.searchParams.get('q');
      if (!query) return catalog;
      return workspaces.resolve({ workspace: query, machine: url.searchParams.get('machine') || '' }, catalog);
    }
    if (p === '/api/mesh/attention') {
      const nodes = discovery.list().filter((n) => n.online && n.rigs);
      const opt = url.searchParams.get('options') === '1' ? '?options=1' : '';
      return Promise.all(nodes.map((n) => (n.self ? localCall('attention' + opt) : peerJson(n, 'attention' + opt, { timeout: 8000 }))
        .then((items) => ({ node: n.name, nodeId: n.id, items })).catch(() => ({ node: n.name, nodeId: n.id, items: [] }))));
    }
    if (p === '/api/mesh/work') {
      // every machine's work
      const nodes = discovery.list().filter((n) => n.online && n.rigs);
      const per = await Promise.all(nodes.map((n) => (n.self ? localCall('work') : peerJson(n, 'work', { timeout: 8000 }))
        .then((w) => ({ ...w, node: n.name, nodeId: n.id })).catch((e) => ({ node: n.name, nodeId: n.id, error: e.message, sessions: [], jarvis: [], projects: [] }))));
      return { nodes: per };
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
    const route = appRoute(p);
    if (route) { await appHttp(req, res, url, route); return undefined; }
    if ((mm = p.match(/^\/api\/nodes\/([^/]+)\/(.+)$/))) {
      const node = discovery.get(decodeURIComponent(mm[1]));
      // This machine is known from config alone: its own URLs (a YOLO window opened right after start) answer while the
      // first discovery scan still runs, as the App Cloud routes do.
      if (!node && appsReg.isSelfRef(decodeURIComponent(mm[1]))) return localApi(req, res, mm[2], url.searchParams);
      if (!node) throw new HttpError(404, 'unknown node ' + mm[1]);
      const rest = mm[2] + url.search;
      if (node.self) return localApi(req, res, mm[2], url.searchParams);
      if (!node.rigs || !node.online) throw new HttpError(503, `${node.name} is not running RIGS`);
      forwardHttp(node, req, res, rest);
      return undefined;
    }
    throw new HttpError(404, 'not found');
  }

  /**
   * App Cloud: /api/nodes/<node>/apps/<id>/* (src/proxy.js). Local apps are forwarded to their port;
   * apps on a peer are relayed to that peer's daemon, which authorizes the hop again.
   * Returns { app } for a local app, { peer } for a remote one; throws 404/502 HttpErrors.
   */
  async function appTarget(route) {
    const ref = decodeURIComponent(route.nodeRef);
    // This node is known from config alone, so apps answer while the first discovery scan still runs.
    let node = appsReg.isSelfRef(ref) ? { self: true, name: config().name } : discovery.get(ref);
    if (!node && !discovery.list().some((n) => n.self)) { await discovery.tick(); node = discovery.get(ref); }
    if (!node) throw new HttpError(404, `unknown node ${ref}`);
    if (!node.self) {
      if (!node.rigs || !node.online) throw new HttpError(502, `${node.name} is not reachable (offline or not running RIGS)`);
      return { peer: node };
    }
    const r = appsReg.resolveApp('self', decodeURIComponent(route.appId));
    if (!r) throw new HttpError(404, `unknown app ${decodeURIComponent(route.appId)} on ${node.name}`);
    return { app: r.app };
  }

  async function appHttp(req, res, url, route) {
    if (route.rest === undefined) {
      // Relative URLs in the app only resolve inside the prefix with a trailing slash.
      res.writeHead(308, { location: url.pathname + '/' + url.search, 'cache-control': 'no-store' });
      res.end();
      return;
    }
    const t = await appTarget(route);
    if (t.peer) relayApp(t.peer, req, res, route, url.search);
    else proxyApp(req, res, t.app, route, url.search);
  }

  async function handler(req, res) {
    const url = new URL(req.url, 'http://localhost');
    try {
      const back = appRefererRedirect(req);
      if (back) { res.writeHead(307, { location: back, 'cache-control': 'no-store' }); res.end(); return; }
      if (url.pathname === '/starnet' || url.pathname.startsWith('/starnet/')) return await starnet.serve(req, res, url.pathname); // 404 unless experimental.starnet is on
      if (!url.pathname.startsWith('/api/')) return serveStatic(url.pathname, res);
      if (starnet.blockedApiCall(req)) throw new HttpError(403, 'the StarNet station frame has no RIGS API access');
      // A YOLO page (opaque origin) can't read the API, and must not change it blind either (src/yolo.js).
      if (yolo.opaqueOriginRefused({ method: req.method, pathname: url.pathname, origin: req.headers.origin })) throw new HttpError(403, 'a page in an opaque origin (a YOLO sandbox) may not change anything here');
      const a = await authorize(req);
      if (!a.ok) throw new HttpError(403, `forbidden (${a.via}: ${a.who})`);
      req.rigsAuth = a;
      let out;
      if (url.pathname.startsWith('/api/local/')) out = await localApi(req, res, url.pathname.slice('/api/local/'.length), url.searchParams);
      else out = await meshApi(req, res, url);
      if (out !== undefined && !res.headersSent) json(res, 200, out);
    } catch (e) {
      const status = e.status || (e.code === 'ENOENT' ? 404 : e.code === 'EACCES' || e.code === 'EPERM' ? 403 : 500);
      if (!res.headersSent) json(res, status, { error: e.message, ...(e.name === 'ToolError' || e.name === 'LinearError' ? { code: e.code } : {}), ...(e.name === 'SlackError' ? { code: e.code, ...(e.retryAfter !== undefined ? { retryAfter: e.retryAfter } : {}) } : {}), ...(e.name === 'ControlError' ? { code: e.code, ...(e.fix ? { fix: e.fix } : {}) } : {}) });
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
      res.writeHead(200, { 'content-type': STATIC_TYPES[path.extname(file)] || 'application/octet-stream', 'cache-control': rel.startsWith('/dist/') ? 'no-cache' : /\.(png|svg|webmanifest)$/.test(rel) ? 'public, max-age=3600' : 'no-store' });
      fs.createReadStream(file).pipe(res);
    });
  }

  const wss = new WebSocketServer({ noServer: true });

  async function onUpgrade(req, socket, head) {
    const url = new URL(req.url, 'http://localhost');
    if (yolo.opaqueOriginRefused({ pathname: url.pathname, origin: req.headers.origin, upgrade: true })) { socket.write('HTTP/1.1 403 Forbidden\r\n\r\n'); socket.destroy(); return; }
    const a = await authorize(req);
    if (!a.ok) { socket.write('HTTP/1.1 403 Forbidden\r\n\r\n'); socket.destroy(); return; }
    req.rigsAuth = a;
    let mm;
    if (url.pathname === '/ws') {
      wss.handleUpgrade(req, socket, head, (ws) => {
        uiSockets.add(ws);
        ws.send(JSON.stringify({ type: 'hello', self: { id: config().nodeId, name: config().name }, nodes: discovery.list().map(stripNode) }));
        // A UI says which requests it sent ({type:'claim-trace', traceId}), so ui-open pushes reach that UI first.
        ws.rigsTraces = [];
        ws.on('message', (data) => {
          let m;
          try { m = JSON.parse(String(data).slice(0, 2000)); } catch { return; }
          if (m?.type === 'claim-trace' && /^tr-\d{8}-[0-9a-f]{12}$/.test(m.traceId || '') && !ws.rigsTraces.includes(m.traceId)) ws.rigsTraces = [...ws.rigsTraces, m.traceId].slice(-20);
        });
        ws.on('close', () => uiSockets.delete(ws));
      });
      return;
    }
    const streamViewer = () => wss.handleUpgrade(req, socket, head, (ws) => streamHub.attachWs(ws, url.searchParams, controlCaller(req, config().name)));
    if (url.pathname === '/api/local/screen/stream') { streamViewer(); return; }
    if ((mm = url.pathname.match(/^\/api\/nodes\/([^/]+)\/screen\/stream$/))) {
      const node = discovery.get(decodeURIComponent(mm[1]));
      if (!node) { socket.destroy(); return; }
      if (node.self) streamViewer();
      else forwardWs(node, req, socket, head, 'screen/stream' + url.search);
      return;
    }
    if ((mm = url.pathname.match(/^\/api\/local\/pty\/(\w+)\/ws$/))) {
      wss.handleUpgrade(req, socket, head, (ws) => pty.attachWs(mm[1], ws));
      return;
    }
    const appR = appRoute(url.pathname);
    if (appR) {
      const route = { ...appR, rest: appR.rest ?? '/' };
      try {
        const t = await appTarget(route);
        if (t.peer) relayAppWs(t.peer, req, socket, head, route, url.search);
        else proxyAppWs(req, socket, head, t.app, route, url.search);
      } catch (e) { rejectUpgrade(socket, e.status || 500, e.message); }
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

  // Global JARVIS settings: push our change to every peer at once; pull the newest revision when peers (re)appear.
  onGlobalChange((g) => {
    broadcast({ type: 'global', ...g });
    for (const n of discovery.list().filter((x) => !x.self && x.online && x.rigs)) {
      peerJson(n, 'global', { method: 'POST', body: g, timeout: 8000 }).catch((e) => log(`global → ${n.name}:`, e.message));
    }
  });
  // Dock layout: tell our browsers about every change; push only what this machine changed to the online peers.
  layoutStore.onChange((key, entry, source) => {
    broadcast({ type: 'ui-layout', key, ...entry });
    if (source !== 'local') return;
    for (const n of discovery.list().filter((x) => !x.self && x.online && x.rigs)) {
      peerJson(n, 'ui-layout/adopt', { method: 'POST', body: { keys: { [key]: entry } }, timeout: 8000 }).catch(() => { /* offline or an old peer: it pulls when it is back */ });
    }
  });
  let pullingLayout = null;
  const pullLayout = () => (pullingLayout ||= (async () => {
    for (const n of discovery.list().filter((x) => !x.self && x.online && x.rigs)) {
      try { const adopted = layoutStore.adopt(await peerJson(n, 'ui-layout', { timeout: 8000 })); if (adopted.length) log(`dock layout: adopted ${adopted.join(', ')} from ${n.name}`); }
      catch { /* an old peer without /ui-layout, or offline: the next pull tries again */ }
    }
  })().finally(() => { pullingLayout = null; }));
  let pulling = null;
  const pullGlobal = () => (pulling ||= (async () => {
    for (const n of discovery.list().filter((x) => !x.self && x.online && x.rigs)) {
      try { const g = await peerJson(n, 'global', { timeout: 8000 }); if (adoptGlobal(g)) { log(`global settings: adopted revision ${g.rev} from ${n.name} (set on ${g.by})`); broadcast({ type: 'global', ...currentGlobal() }); } }
      catch { /* an old peer without /global, or offline: the next pull tries again */ }
    }
  })().finally(() => { pulling = null; }));
  discovery.on('change', () => { pullGlobal(); pullLayout(); });
  setInterval(() => { pullGlobal(); pullLayout(); }, 2 * 60 * 1000).unref();
  discovery.start();
  if (sharedEngine) {
    // A local change tells the online peers to pull now, so it lands everywhere within seconds; a peer (re)appearing
    // brings a reconcile too.
    sharedEngine.start({ notify: () => Promise.all(rigsPeers().filter((n) => n.online).map((n) => peerJson(n, 'shared/nudge', { method: 'POST', body: { from: config().name }, timeout: 8000 }).catch(() => null))) });
    discovery.on('change', () => sharedEngine.nudge());
    log(`shared folder: ${sharedEngine.root}`);
  }
  if (!process.env.RIGS_NO_AUTOUPDATE) updater.startAutoUpdate((r) => {
    if (!r.restart) return;
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
  }).then(() => setupControl()).then(() => announceRoot()).catch((e) => log('migrations:', e.message)), 4000).unref();

  // Control is on by default: its first-run setup (helper, Linux uinput root step, GNOME extension) runs at boot and
  // again when a person switches it back on, never only on enable(). Same throwaway-node rule as the migrations.
  function setupControl() {
    return ensureControlSetup({ control }).then((r) => { if (!r.skipped) log('control setup:', JSON.stringify(r)); })
      .catch((e) => log('control setup:', e.message));
  }
  if (!process.env.RIGS_NO_MIGRATIONS) control.events.on('change', (c) => { if (c.enabled) setupControl().then(() => announceRoot()); });

  // "An agent needs you": watch every agent on this machine; announce new waits mesh-wide.
  // Screen access/control: routes for this machine, plus the announcements that make every action visible.
  const controlApi = createControlApi({ control, access, nodeName: () => config().name });
  const streamHub = createStreamHub({ control, nodeName: () => config().name, log });
  attention.addSource(wireControlEvents({
    events: control.events, nodeName: () => config().name, settings: () => config().control || {}, broadcast, log,
    notifyAll: (b) => broadcastNotify(b), osNotify,
  }).items);

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
  // OpenRig's daemon is not a boot service: keep it running so seats and queues survive reboots and crashes.
  const keepOpenRig = () => (config().openrig?.keepDaemon === false ? null : work.ensureDaemon()
    .then((r) => { if (r.started !== undefined) log(`OpenRig daemon was down — ${r.started ? 'started it' : 'could not start it: ' + r.output}`); })
    .catch((e) => log('openrig keep-alive:', e.message)));
  setTimeout(keepOpenRig, 12000).unref();
  setInterval(keepOpenRig, 2 * 60 * 1000).unref();
  // Persistent rigs: JARVIS's overseer rig on the core-brain machine; idle hub workers stopped (leads stay).
  // Throwaway nodes (tests) never start agents.
  if (!process.env.RIGS_NO_MIGRATIONS) {
    const keepHubs = () => hubs.keep().then((r) => {
      if (r.jarvis?.newSeats?.length) announceSeats({}, r.jarvis.newSeats, 'JARVIS');
      if (r.jarvis?.error) log('jarvis rig:', r.jarvis.error);
      if (r.reaped?.stopped?.length) log(`openrig: stopped idle worker seat(s) ${r.reaped.stopped.join(', ')}`);
    }).catch((e) => log('hubs:', e.message));
    setTimeout(keepHubs, 45000).unref();
    setInterval(keepHubs, 2 * 60 * 1000).unref();
  }

  // Warm the workspace index so the first routed request doesn't wait for a scan.
  setTimeout(() => sessionDirs().then((extraDirs) => workspaces.list({ extraDirs })).catch(() => {}), 10000).unref();
  setInterval(() => attentionTick().catch((e) => log('attention:', e.message)), 5000).unref();

  // Merge steward: process proposed branches (also kicked on every proposal / resolution).
  setInterval(kickMerge, 30000).unref();
  appsReg.onAppsChange(() => broadcast({ type: 'apps', node: config().name }));
  appstore.onJobEvent((job) => broadcast({ type: 'appstore', node: config().name, job }));
  appsReg.startHealthChecks({ intervalMs: 5000 });

  // Usage ledger: a finished task run's tokens are read from its transcript on the machine it ran on.
  usage.setSlicer((node, q) => callNode(node, 'usage/slice', { method: 'POST', body: q, timeout: 120000 }));
  // Request traces: each span written here goes to the open UIs as it happens (live view); old day files are pruned.
  trace.events.on('span', (span) => broadcast({ type: 'trace-span', span }));
  yolo.events.on('event', (e) => broadcast(e)); // yolo-start · yolo-update · yolo-done (src/yolo.js)
  // Exhibits: fed from the same span stream and the planner's saves; each new entry is pushed live ('exhibit').
  trace.events.on('span', (span) => exhibitSvc.handleSpan(span));
  planner.onProjectSaved((p) => exhibitSvc.handleProject(p));
  exhibits.events.on('entry', ({ docId, entry, final }) => broadcast({ type: 'exhibit', docId, entry, final }));
  exhibits.events.on('live', (l) => broadcast({ type: 'exhibit-live', ...l }));
  exhibits.events.on('image',({ docId, entry }) => broadcast({ type: 'exhibit-image', docId, entry }));
  exhibits.events.on('final', ({ docId, at }) => broadcast({ type: 'exhibit-final', docId, at }));
  starnet.events.on('config', (st) => broadcast({ type: 'starnet-config', ...st }));
  const pruneTraces = () => trace.prune().then((f) => f.length && log(`traces: pruned ${f.length} day file(s)`)).catch((e) => log('traces prune:', e.message));
  pruneTraces();
  setInterval(pruneTraces, 24 * 3600 * 1000).unref();
  planner.onRunEnd((e) => {
    // The ledger record is filed here; the run's spans are written by the machine that ran it, from its transcript.
    const tb = trace.runEndBody(e);
    if (tb) callNode(e.node, 'traces/run-end', { method: 'POST', body: tb, timeout: 120000 }).catch((err) => log(`traces: run end on ${e.node}: ${err.message}`));
    return usage.recordTaskRun(e);
  });

  // Project tracker: finished seats/sessions → start what became ready.
  setInterval(() => planner.tick(plannerCtx).catch((e) => log('planner tick:', e.message)), 20000).unref();
  // Live stats push for the HUD.
  setInterval(async () => { if (uiSockets.size) broadcast({ type: 'stats', id: config().nodeId, stats: await stats() }); }, 5000).unref();

  return { discovery, close: () => { for (const s of servers.values()) s.close(); discovery.stop(); sharedEngine?.stop(); } };
}
