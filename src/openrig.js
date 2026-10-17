import { bin } from './tools.js';
import { run } from './util.js';

/** OpenRig (`rig`) integration: rigs/seats become sessions in the mesh, peers become OpenRig hosts. */

let cache = { at: 0, value: null };
let inflight = null;

async function rigJson(args, timeout = 8000) {
  const r = bin('rig');
  if (!r) return null;
  const res = await run(r, args, { timeout });
  if (res.code !== 0) return null;
  try { return JSON.parse(res.stdout); } catch { return null; }
}

/**
 * OpenRig's state. One refresh at a time: every caller (attention every 5 s, snapshots, the watchdog, keep-alive,
 * dispatch) shares the refresh in flight. Each refresh is 5-7 `rig` processes; without this, a refresh slower than
 * the cache under load let callers pile up (40+ concurrent `rig` processes), which made every refresh slower still.
 * `force` means "newer than 2 s", not "start another one".
 */
export function status(force = false) {
  const age = Date.now() - cache.at;
  if (cache.value && age < (force ? 2000 : 10000)) return Promise.resolve(cache.value);
  if (!inflight) inflight = refresh().finally(() => { inflight = null; });
  return inflight;
}

async function refresh() {
  const r = bin('rig');
  if (!r) { cache = { at: Date.now(), value: { installed: false } }; return cache.value; }
  const [ver, first] = await Promise.all([run(r, ['--version'], { timeout: 6000 }), run(r, ['daemon', 'status'], { timeout: 6000 })]);
  // "stopped" only when the daemon says so; a slow or failed answer is "unknown" (asked once more, with more time) —
  // a busy daemon must not look dead, or live seats get revived and nudged for nothing.
  const read = (d) => `${d.stdout}\n${d.stderr}`;
  const isRunning = (t) => /running/i.test(t) && !/not running|stopped/i.test(t);
  // After a reboot OpenRig says "Daemon PID is absent (stale state)": that is down, not slow.
  const isStopped = (t) => /not running|stopped|not started|no daemon|ECONNREFUSED|pid is absent|stale state/i.test(t);
  let daemon = first;
  if (!isRunning(read(daemon)) && !isStopped(read(daemon))) daemon = await run(r, ['daemon', 'status'], { timeout: 20000 });
  const running = isRunning(read(daemon));
  const state = running ? 'running' : isStopped(read(daemon)) ? 'stopped' : 'unknown';
  const port = Number((daemon.stdout.match(/port (\d+)/) || [])[1] || 7433);
  let rigs = [];
  let nodes = [];
  let hosts = [];
  let nodesOk = false;
  if (running) {
    [rigs, nodes, hosts] = await Promise.all([
      rigJson(['ps', '--json']).then((x) => (Array.isArray(x) ? x : x?.rigs || [])),
      rigJson(['ps', '--nodes', '-A', '--json']).then((x) => (x === null ? null : Array.isArray(x) ? x : x?.nodes || [])),
      rigJson(['host', 'list', '--json']).then((x) => (Array.isArray(x) ? x : x?.hosts || [])),
    ]);
    nodesOk = nodes !== null;
    if (!nodesOk) nodes = (await rigJson(['ps', '--nodes', '-A', '--json'], 20000).then((x) => (x === null ? null : Array.isArray(x) ? x : x?.nodes || []))) ?? null;
    nodesOk = nodes !== null;
  }
  const value = {
    installed: true, version: ver.stdout.trim().split(/\s/)[0], daemon: state, port, nodesOk,
    rigs: (rigs || []).map((g) => ({ id: g.rigId, name: g.name || g.rigName, status: g.status, nodes: g.nodeCount, running: g.runningCount, active: g.activeCount })),
    nodes: (nodes || []).map(normalizeNode),
    hosts: (hosts || []).map((h) => ({ id: h.id, transport: h.transport, target: h.target || h.url })),
  };
  cache = { at: Date.now(), value };
  return value;
}

function normalizeNode(n) {
  return {
    rig: n.rigName, role: n.logicalId, session: n.canonicalSessionName, runtime: n.runtime,
    status: n.sessionStatus || n.lifecycleState, activity: n.agentActivity?.state || 'unknown', reason: n.agentActivity?.reason || '',
    startupStatus: n.startupStatus || '', lifecycle: n.lifecycleState || '',
    attach: n.tmuxAttachCommand, resume: n.resumeCommand, work: n.assignedWorkCount || 0,
    title: `${n.logicalId || n.canonicalSessionName} @ ${n.rigName}`,
  };
}

export async function seats() {
  const s = await status();
  return s.nodes || [];
}

/**
 * Register every mesh peer as an OpenRig SSH host so `rig ps --all-hosts`, `rig capture --host`,
 * `rig file copy` etc. work across machines. Relies on the ssh aliases RIGS writes to ~/.ssh/config.
 */
export async function registerPeers(peers) {
  const r = bin('rig');
  if (!r) return { skipped: 'rig not installed' };
  const s = await status(true);
  if (s.daemon !== 'running') return { skipped: 'daemon not running' };
  const have = new Set((s.hosts || []).map((h) => h.id));
  const added = [];
  for (const p of peers) {
    if (!p.sshAlias || !p.rigsTools?.rig || have.has(p.name)) continue;
    const res = await run(r, ['host', 'add', '--id', p.name, '--transport', 'ssh', '--target', p.sshAlias, '--notes', 'added by rigs mesh'], { timeout: 10000 });
    if (res.code === 0) added.push(p.name);
  }
  return { added };
}
