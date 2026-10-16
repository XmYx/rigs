import { bin } from './tools.js';
import { run } from './util.js';

/** OpenRig (`rig`) integration: rigs/seats become sessions in the mesh, peers become OpenRig hosts. */

let cache = { at: 0, value: null };

async function rigJson(args, timeout = 8000) {
  const r = bin('rig');
  if (!r) return null;
  const res = await run(r, args, { timeout });
  if (res.code !== 0) return null;
  try { return JSON.parse(res.stdout); } catch { return null; }
}

export async function status(force = false) {
  if (!force && cache.value && Date.now() - cache.at < 10000) return cache.value;
  const r = bin('rig');
  if (!r) { cache = { at: Date.now(), value: { installed: false } }; return cache.value; }
  const [ver, daemon] = await Promise.all([run(r, ['--version'], { timeout: 6000 }), run(r, ['daemon', 'status'], { timeout: 6000 })]);
  const running = /running/i.test(daemon.stdout) && !/not running|stopped/i.test(daemon.stdout);
  const port = Number((daemon.stdout.match(/port (\d+)/) || [])[1] || 7433);
  let rigs = [];
  let nodes = [];
  let hosts = [];
  if (running) {
    [rigs, nodes, hosts] = await Promise.all([
      rigJson(['ps', '--json']).then((x) => (Array.isArray(x) ? x : x?.rigs || [])),
      rigJson(['ps', '--nodes', '-A', '--json']).then((x) => (Array.isArray(x) ? x : x?.nodes || [])),
      rigJson(['host', 'list', '--json']).then((x) => (Array.isArray(x) ? x : x?.hosts || [])),
    ]);
  }
  const value = {
    installed: true, version: ver.stdout.trim().split(/\s/)[0], daemon: running ? 'running' : 'stopped', port,
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
    status: n.sessionStatus || n.lifecycleState, activity: n.agentActivity?.state || 'unknown',
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
