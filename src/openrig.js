import path from 'node:path';
import { bin } from './tools.js';
import { augmentedPath, run } from './util.js';

/** OpenRig (`rig`) integration: rigs/seats become sessions in the mesh, peers become OpenRig hosts. */

let cache = { at: 0, value: null };
let runner = run;

/** Tests swap the process runner for a fake `rig` (cross-platform, no real OpenRig needed). */
export function _setRunner(fn) { runner = fn || run; cache = { at: 0, value: null }; }

const rigBin = () => bin('rig') || (runner !== run ? 'rig' : null);

/**
 * Every `rig` call goes through here. The daemon's own Node (>= 22, known good) leads PATH, so an npm-installed
 * `#!/usr/bin/env node` rig never lands on a broken `node` that happens to come first (macOS: a Homebrew node
 * missing libicu).
 */
export function rigRun(args, opts = {}) {
  const r = rigBin();
  if (!r) return Promise.resolve({ code: -1, stdout: '', stderr: 'rig is not installed' });
  return runner(r, args, { ...opts, env: { ...process.env, PATH: [path.dirname(process.execPath), augmentedPath()].join(path.delimiter), ...(opts.env || {}) } })
    .then((res) => { if (CHANGES.has(args[0])) cache.at = 0; return res; }); // the next status() sees the change
}
const CHANGES = new Set(['up', 'down', 'add', 'seat', 'queue', 'remove']);

/** What a failing `rig --version` means, in one sentence for the Mesh window. */
export function diagnose(text) {
  const t = String(text || '');
  const lib = (t.match(/Library not loaded:\s*(\S+)/) || [])[1];
  if (/libicu|Library not loaded|dyld/i.test(t)) return `OpenRig cannot run: the Node.js it starts with is broken${lib ? ` (missing ${path.basename(lib)})` : ''}. Run \`rigs setup\` to pin rig to a working Node, or reinstall that Node (brew reinstall node / brew upgrade icu4c).`;
  if (/ENOENT|not found|No such file/i.test(t)) return 'OpenRig cannot run: `rig` or its Node.js was not found under the RIGS service PATH. Run `rigs setup`.';
  if (/SyntaxError|Unsupported engine|requires? node/i.test(t)) return 'OpenRig cannot run: it needs a newer Node.js than the one it starts with. Run `rigs setup` to pin rig to Node 22+.';
  return `OpenRig cannot run: \`rig --version\` failed — ${t.trim().split(/\r?\n/).filter(Boolean).slice(-1)[0] || 'no output'}`;
}

async function rigJson(args, timeout = 8000) {
  const res = await rigRun(args, { timeout });
  if (res.code !== 0) return null;
  try { return JSON.parse(res.stdout); } catch { return null; }
}

export async function status(force = false) {
  if (!force && cache.value && Date.now() - cache.at < 10000) return cache.value;
  const r = rigBin();
  if (!r) { cache = { at: Date.now(), value: { installed: false, healthy: false, health: 'OpenRig (rig) is not installed on this machine.' } }; return cache.value; }
  const [ver, first] = await Promise.all([rigRun(['--version'], { timeout: 6000 }), rigRun(['daemon', 'status'], { timeout: 6000 })]);
  if (ver.code !== 0 && ver.code !== -2) {
    // rig itself does not start (a broken Node, a half-installed package): no daemon state can be read either.
    cache = { at: Date.now(), value: { installed: true, healthy: false, health: diagnose(`${ver.stdout}\n${ver.stderr}`), daemon: 'unknown', nodesOk: false, rigs: [], nodes: [], hosts: [], path: r } };
    return cache.value;
  }
  // "stopped" only when the daemon says so; a slow or failed answer is "unknown" (asked once more, with more time) —
  // a busy daemon must not look dead, or live seats get revived and nudged for nothing.
  const read = (d) => `${d.stdout}\n${d.stderr}`;
  const isRunning = (t) => /running/i.test(t) && !/not running|stopped/i.test(t);
  // After a reboot OpenRig says "Daemon PID is absent (stale state)": that is down, not slow.
  const isStopped = (t) => /not running|stopped|not started|no daemon|ECONNREFUSED|pid is absent|stale state/i.test(t);
  let daemon = first;
  if (!isRunning(read(daemon)) && !isStopped(read(daemon))) daemon = await rigRun(['daemon', 'status'], { timeout: 20000 });
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
    installed: true, healthy: true, health: state === 'stopped' ? 'The OpenRig daemon is stopped (RIGS starts it again within two minutes).' : '', path: r,
    version: ver.stdout.trim().split(/\s/)[0], daemon: state, port, nodesOk,
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
  if (!rigBin()) return { skipped: 'rig not installed' };
  const s = await status(true);
  if (s.daemon !== 'running') return { skipped: 'daemon not running' };
  const have = new Set((s.hosts || []).map((h) => h.id));
  const added = [];
  for (const p of peers) {
    if (!p.sshAlias || !p.rigsTools?.rig || have.has(p.name)) continue;
    const res = await rigRun(['host', 'add', '--id', p.name, '--transport', 'ssh', '--target', p.sshAlias, '--notes', 'added by rigs mesh'], { timeout: 10000 });
    if (res.code === 0) added.push(p.name);
  }
  return { added };
}
