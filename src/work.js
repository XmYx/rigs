import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { config, RIGS_HOME } from './config.js';
import { agentModes, claudeFlags, codexFlags } from './models.js';
import { CODEX_AUTO_PROFILE, codexAutoProfileReady, wrapperTarget } from './agentmodes.js';
import * as openrig from './openrig.js';
import { createPty, shellWrap } from './pty.js';
import { bin } from './tools.js';
import { HOME, expandHome, isWin, run, sleep } from './util.js';

/**
 * Runs ONE planned task on THIS machine. Called by the project's owner node through the mesh.
 * Two ways to run it:
 *  - openrig: a one-seat rig (runtime/model/effort set in the spec) + the task as an owned queue item
 *  - direct: the agent CLI in a tmux session (or a terminal on Windows) with model/effort flags
 */

const AGENT_REF = {
  code: 'development/implementer', test: 'development/qa', review: 'review/independent-reviewer',
  research: 'research/analyst', docs: 'research/analyst', 'reverse-engineer': 'research/analyst',
  architecture: 'orchestration/orchestrator', plan: 'orchestration/orchestrator',
};

function q(s) {
  return isWin ? `'${String(s).replace(/'/g, "''")}'` : `'${String(s).replace(/'/g, `'\\''`)}'`;
}

export function slug(s, n = 24) {
  return String(s || 'x').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, n) || 'x';
}

function openrigAgentsDir() {
  const r = bin('rig');
  if (!r) return null;
  try {
    const real = wrapperTarget(r) || fs.realpathSync(r); // …/@openrig/cli/dist/bin-wrapper.js
    const dir = path.join(path.dirname(path.dirname(real)), 'daemon', 'specs', 'agents');
    return fs.existsSync(dir) ? dir : null;
  } catch { return null; }
}

async function prepareWorkdir(workdir, gitUrl) {
  const dir = path.resolve(expandHome(workdir || '~'));
  if (gitUrl && !fs.existsSync(path.join(dir, '.git'))) {
    await fsp.mkdir(path.dirname(dir), { recursive: true });
    const r = await run(bin('git') || 'git', ['clone', gitUrl, dir], { timeout: 600000 });
    if (r.code !== 0) throw new Error('git clone failed: ' + r.stderr.trim().slice(-300));
  } else if (gitUrl) {
    await run(bin('git') || 'git', ['pull', '--ff-only'], { cwd: dir, timeout: 120000 });
  }
  await fsp.mkdir(dir, { recursive: true });
  return dir;
}

export async function startTask({ project, task, prompt, workdir, mode = 'auto', policy = config().agents?.rigPolicy || 'builtin:auto' }) {
  const dir = await prepareWorkdir(workdir, project.gitUrl);
  // The full brief lives on disk — under ~/.rigs, never inside the user's project folder; agents get a short
  // pointer to it (robust quoting on every OS), OpenRig seats get it as their queue item.
  const briefDir = path.join(RIGS_HOME, 'briefs', project.slug);
  await fsp.mkdir(briefDir, { recursive: true });
  const brief = path.join(briefDir, `${project.slug}-${task.id}.md`);
  await fsp.writeFile(brief, prompt);
  const pointer = `Read ${brief.split(path.sep).join('/')} and carry out the task it describes. Report back with the project_task_update tool when you are done.`;
  const a = task.assign;
  if (mode !== 'direct' && !isWin) await ensureDaemon().catch(() => {});
  const rigOk = ['claude', 'codex', 'stub'].includes(a.provider) && !isWin && openrigAgentsDir() && (await openrig.status(true)).daemon === 'running';
  const useRig = mode === 'openrig' ? rigOk : mode === 'direct' ? false : rigOk;
  if (mode === 'openrig' && !rigOk) throw new Error('OpenRig is not available on this machine (needs `rig` + a running daemon, Claude Code or Codex)');
  if (useRig || a.provider === 'stub') return { ...(await startOpenRig({ project, task, dir, brief, policy })), brief };
  return { ...(await startDirect({ project, task, dir, pointer })), brief };
}

/** A short, stable tag for a seat id: claude-opus-5-5 → opus, gpt-6.1-sol → codex. */
export function modelTag(a) {
  const m = String(a.model || '').toLowerCase();
  const fam = (m.match(/opus|sonnet|haiku|fable/) || [])[0];
  if (fam) return fam;
  if (a.provider === 'codex' || a.provider === 'stub') return a.provider;
  return slug(m || a.provider || 'agent', 10);
}

function memberYaml(mb, indent = '') {
  return [
    `${indent}id: ${mb.id}`,
    `${indent}agent_ref: ${JSON.stringify('path:' + mb.agentRef)}`,
    `${indent}runtime: ${mb.runtime}`,
    `${indent}profile: default`,
    `${indent}cwd: ${JSON.stringify(mb.cwd)}`,
    ...(mb.model ? [`${indent}model: ${JSON.stringify(mb.model)}`] : []),
    ...(mb.effort ? [`${indent}effort: ${JSON.stringify(mb.effort)}`] : []),
    // Codex has no auto mode of its own; under builtin:auto OpenRig launches it "at the floor", which with a named
    // profile means `-p rigs-auto`: workspace-write + network, asking only to escalate (see agentmodes.js).
    ...(mb.codexProfile ? [`${indent}codex_config_profile: ${mb.codexProfile}`] : []),
    `${indent}role: ${mb.role}`,
  ];
}

function specYaml(rigName, summary, policy, members) {
  return [
    'version: "0.2"',
    `name: ${rigName}`,
    `summary: ${JSON.stringify(summary)}`,
    ...(policy && policy !== 'floor' ? [`permission_policy: ${policy}`] : []),
    'pods:',
    '  - id: team',
    `    label: ${JSON.stringify('team')}`,
    '    members:',
    ...members.flatMap((mb) => memberYaml(mb, '        ').map((l, i) => (i === 0 ? '      - ' + l.trimStart() : l))),
    '    edges: []',
    'edges: []',
    '',
  ].join('\n');
}

const GONE = /detached|stopped|exited|dead|failed/i;

/**
 * One OpenRig team per project on each machine: rig `<project>-<id>`, pod `team`, one seat per role + model
 * (`team-code-opus@…`). A task goes to an idle seat of its kind; a new role — or every same-role seat busy —
 * adds a seat with `rig add`. Seats keep their context between tasks, like colleagues on the project.
 */
async function startOpenRig({ project, task, dir, brief, policy }) {
  const a = task.assign;
  const agents = openrigAgentsDir();
  const rig = bin('rig');
  const rigName = slug(`${project.slug}-${String(project.id || '').slice(0, 4)}`, 40);
  const runtime = a.provider === 'codex' ? 'codex' : a.provider === 'stub' ? 'stub' : 'claude-code';
  const base = slug(`${task.kind || 'work'}-${modelTag(a)}`, 22);
  const member = (id) => ({
    id, agentRef: path.join(agents, AGENT_REF[task.kind] || AGENT_REF.code), runtime, cwd: dir, model: a.model, effort: a.effort,
    role: slug(task.kind || 'builder', 20), codexProfile: runtime === 'codex' && policy !== 'builtin:yolo' && codexAutoProfileReady() ? CODEX_AUTO_PROFILE : '',
  });
  const specDir = path.join(RIGS_HOME, 'rigs', rigName);
  await fsp.mkdir(specDir, { recursive: true });

  let seats = (await openrig.status(true)).nodes?.filter((n) => n.rig === rigName) || [];
  if (seats.length && seats.every((n) => GONE.test(n.status || ''))) {
    // The team was stopped (or the machine restarted): start it fresh rather than half-restoring it.
    await run(rig, ['down', rigName, '--delete', '--force', '--json'], { timeout: 120000 });
    seats = [];
  }
  const live = (id) => seats.find((n) => n.session === `team-${id}@${rigName}` && !GONE.test(n.status || ''));
  let id = base;
  for (let k = 2; live(id) && live(id).work > 0 && k <= 4; k++) id = `${base}-${k}`;
  let seat = live(id)?.session;

  if (!seats.length) {
    const spec = path.join(specDir, 'rig.yaml');
    await fsp.writeFile(spec, specYaml(rigName, `RIGS project ${project.name}`, policy, [member(id)]));
    const v = await run(rig, ['spec', 'validate', spec], { timeout: 30000 });
    if (v.code !== 0) throw new Error('rig spec invalid: ' + (v.stdout + v.stderr).trim().slice(-400));
    const up = await run(rig, ['up', spec, '--yes', '--json'], { timeout: 300000 });
    let upJson = null;
    try { upJson = JSON.parse(up.stdout.slice(up.stdout.indexOf('{'))); } catch {}
    const node = upJson?.stages?.flatMap((s) => s.detail?.nodes || [])[0];
    if (up.code !== 0 || !node?.sessionName) throw new Error('rig up failed: ' + (up.stdout + up.stderr).trim().slice(-400));
    seat = node.sessionName;
  } else if (!seat) {
    const frag = path.join(specDir, `${id}.member.yaml`);
    await fsp.writeFile(frag, memberYaml(member(id)).join('\n') + '\n');
    const add = await run(rig, ['add', rigName, 'team', frag, '--json'], { timeout: 300000 });
    let addJson = null;
    try { addJson = JSON.parse(add.stdout.slice(add.stdout.indexOf('{'))); } catch {}
    seat = addJson?.result?.node?.sessionName;
    if (!seat) {
      // The CLI gives up on the daemon after a few seconds while the seat is still launching ("outcome UNKNOWN"):
      // look for the seat itself before calling it a failure.
      const want = `team-${id}@${rigName}`;
      for (let i = 0; i < 30 && !seat; i++) {
        await sleep(2000);
        if ((await openrig.status(true)).nodes?.some((n) => n.session === want && !GONE.test(n.status || ''))) seat = want;
      }
    }
    if (!seat) throw new Error('rig add failed: ' + (add.stdout + add.stderr).trim().slice(-400));
  }

  const qc = await run(rig, ['queue', 'create', '--source', `rigs-planner@${config().name}`, '--destination', seat, '--body-file', brief,
    '--summary', task.title.slice(0, 120), '--tags', `project:${project.id},task:${task.id}`, '--tier', task.size === 'L' ? 'deep' : 'routine'], { timeout: 60000 });
  const qitem = (qc.stdout.match(/qitem-[\w-]+/) || [])[0];
  if (!qitem) throw new Error('rig queue create failed: ' + (qc.stdout + qc.stderr).trim().slice(-300));
  return { mode: 'openrig', rig: rigName, seat, qitem, cwd: dir, team: true, session: { kind: 'rig', id: seat } };
}

async function startDirect({ project, task, dir, pointer }) {
  const a = task.assign;
  let line;
  const modes = agentModes();
  if (a.provider === 'claude') line = ['claude', ...claudeFlags({ ...a, ...modes.claude }).map(q), q(pointer)].join(' ');
  else if (a.provider === 'codex') line = ['codex', ...codexFlags({ ...a, ...modes.codex }).map(q), q(pointer)].join(' ');
  else if (a.provider === 'ollama') {
    // Codex drives local Ollama models as a real agent (tools + MCP incl. REA); plain `ollama run` otherwise.
    line = bin('codex') ? ['codex', '--oss', '--local-provider', 'ollama', ...(a.model ? ['-m', q(a.model)] : []), q(pointer)].join(' ') : `ollama run ${q(a.model || 'llama3.2')} ${q(pointer)}`;
  } else throw new Error('unknown provider ' + a.provider);
  const name = `${project.slug}-${task.id}${task.attempts ? `-r${task.attempts}` : ''}`.replace(/[^\w.-]/g, '-');
  const t = bin('tmux');
  if (t && !isWin) {
    const sh = shellWrap(line);
    const r = await run(t, ['new-session', '-d', '-s', name, '-c', dir, '-x', '200', '-y', '50', sh.cmd, ...sh.args], { timeout: 10000 });
    if (r.code !== 0) throw new Error(r.stderr.trim() || 'tmux new-session failed');
    return { mode: 'direct', cwd: dir, session: { kind: 'tmux', id: name } };
  }
  const p = createPty({ ...shellWrap(line), cwd: dir, title: `${task.id} · ${task.title}`.slice(0, 60), kind: a.provider, meta: { agent: a.provider, project: project.id, task: task.id } });
  return { mode: 'direct', cwd: dir, session: { kind: 'pty', id: p.id } };
}

/**
 * Where is a dispatched task at? state: running | done | ended (| OpenRig queue states). For the watchdog also:
 * idle (the agent sits at its prompt), needsInput (it waits on a permission/question), fingerprint (pane content
 * hash — unchanged between checks means nothing is happening).
 */
/**
 * OpenRig's daemon is not a boot service: after a reboot (or a crash) RIGS starts it again, so seats and their
 * queues come back. Returns what it did.
 */
export async function ensureDaemon() {
  const rig = bin('rig');
  if (!rig || isWin) return { skipped: true };
  const st = await openrig.status(true);
  if (st.daemon === 'running') return { running: true };
  const r = await run(rig, ['daemon', 'start'], { timeout: 120000 });
  const after = await openrig.status(true);
  return { started: after.daemon === 'running', output: (r.stdout + r.stderr).trim().slice(-200) };
}

/** Is this OpenRig seat's session alive? (false after a reboot, a killed tmux session, a crashed daemon) */
async function seatAlive(seat) {
  const st = await openrig.status(true);
  if (st.daemon !== 'running') return null;
  const n = (st.nodes || []).find((x) => x.session === seat);
  return !!n && !GONE.test(n.status || '');
}

/**
 * Bring a dead seat back so its agent can carry on: the whole team down (a reboot) → `rig up <rig> --existing`
 * restores it with every conversation resumed; one seat down among live ones → a fresh occupant for that seat
 * (`rig seat clean` + `rig seat launch`), which picks the task up from its brief. Waits until the seat is live.
 */
export async function reviveTask(run_) {
  if (run_.mode !== 'openrig' || !run_.seat) return { ok: false, reason: 'not an OpenRig seat' };
  const rig = bin('rig');
  const d = await ensureDaemon();
  if (await seatAlive(run_.seat)) return { ok: true, how: d.started ? 'daemon restarted; seat was alive' : 'alive' };
  const team = ((await openrig.status(true)).nodes || []).filter((n) => n.rig === run_.rig);
  const anyLive = team.some((n) => !GONE.test(n.status || ''));
  let how;
  if (!anyLive) {
    const r = await run(rig, ['up', run_.rig, '--existing', '--yes', '--json'], { timeout: 300000 });
    how = `restored the team (${r.code === 0 ? 'conversations resumed' : 'restore said: ' + (r.stdout + r.stderr).trim().slice(-160)})`;
  } else {
    await run(rig, ['seat', 'clean', run_.seat], { timeout: 60000 });
    const r = await run(rig, ['seat', 'launch', run_.seat], { timeout: 300000 });
    how = `fresh occupant for the seat (${r.code === 0 ? 'launched' : (r.stdout + r.stderr).trim().slice(-160)})`;
  }
  for (let i = 0; i < 45; i++) {
    if (await seatAlive(run_.seat)) { await sleep(5000); return { ok: true, how }; }
    await sleep(2000);
  }
  return { ok: false, how, reason: 'the seat did not come back' };
}

export async function taskStatus(run_) {
  if (run_.mode === 'openrig' && run_.qitem) {
    // A seat that died (reboot, killed session) leaves its queue item "in progress" forever: say so, so it is revived.
    const alive = await seatAlive(run_.seat).catch(() => true);
    if (alive === null) return { state: 'daemon-down' };
    const r = await run(bin('rig'), ['queue', 'show', run_.qitem, '--json'], { timeout: 15000 });
    try {
      const j = JSON.parse(r.stdout.slice(r.stdout.indexOf('{')));
      const state = j.state || j.qitem?.state || j.waiting?.state;
      const live = j.waiting?.liveness || {};
      if (state !== 'done' && !alive) return { state: 'seat-down' };
      return { state, closure: j.closureReason || j.qitem?.closureReason || null, activity: live.activity || null,
        idle: live.activity === 'idle-at-prompt', needsInput: (live.needsInput?.count || 0) > 0 };
    } catch { return { state: 'unknown' }; }
  }
  if (run_.session?.kind === 'tmux') {
    const t = bin('tmux') || 'tmux';
    const r = await run(t, ['has-session', '-t', run_.session.id], { timeout: 5000 });
    if (r.code !== 0) return { state: 'ended' };
    const pane = await run(t, ['capture-pane', '-p', '-t', run_.session.id], { timeout: 5000 });
    // Strip clocks/spinners so a frozen screen hashes the same.
    const text = pane.stdout.replace(/\d+(\.\d+)?\s?(s|m|ms|min|tokens?)\b|[⠀-⣿✻✶✳✢·*]/g, '');
    return { state: 'running', fingerprint: crypto.createHash('sha1').update(text).digest('hex').slice(0, 16),
      needsInput: /Do you want to|\(y\/n\)|Allow .*\?|approve|permission/i.test(pane.stdout.split('\n').slice(-15).join('\n')) };
  }
  return { state: 'running' };
}

/** Is an agent already working on this task here? (a lost start reply) → its run handle, or null. */
export async function findTask({ project, task }) {
  const tags = [`project:${project.id}`, `task:${task.id}`];
  if (bin('rig')) {
    const r = await run(bin('rig'), ['queue', 'list', '--json'], { timeout: 20000 });
    try {
      const j = JSON.parse(r.stdout.slice(r.stdout.search(/[[{]/)));
      const items = (Array.isArray(j) ? j : j.items || j.qitems || []).filter((q) => tags.every((x) => (q.tags || []).includes(x)) && ['in-progress', 'pending'].includes(q.state));
      const q = items.sort((a, b) => (a.state === 'in-progress' ? -1 : 1) - (b.state === 'in-progress' ? -1 : 1) || String(b.tsCreated).localeCompare(String(a.tsCreated)))[0];
      if (q) return { run: { mode: 'openrig', rig: q.destinationSession.split('@')[1], seat: q.destinationSession, qitem: q.qitemId, team: true, session: { kind: 'rig', id: q.destinationSession } } };
    } catch {}
  }
  const t = bin('tmux');
  if (t && !isWin && project.slug) {
    const name = `${project.slug}-${task.id}${task.attempts ? `-r${task.attempts}` : ''}`.replace(/[^\w.-]/g, '-');
    if ((await run(t, ['has-session', '-t', name], { timeout: 5000 })).code === 0) return { run: { mode: 'direct', session: { kind: 'tmux', id: name } } };
  }
  return { run: null };
}

/** The watchdog's nudge: a message typed into the agent's session (OpenRig seat or tmux). */
export async function nudgeTask({ text, ...run_ }) {
  if (!text) throw new Error('nothing to send');
  if (run_.mode === 'openrig' && run_.seat) {
    const r = await run(bin('rig'), ['send', run_.seat, text], { timeout: 30000 });
    if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim().slice(-200) || 'rig send failed');
    return { ok: true, via: 'rig send' };
  }
  if (run_.session?.kind === 'tmux') {
    const t = bin('tmux') || 'tmux';
    await run(t, ['send-keys', '-t', run_.session.id, '-l', text], { timeout: 5000 });
    await sleep(300);
    const r = await run(t, ['send-keys', '-t', run_.session.id, 'Enter'], { timeout: 5000 });
    if (r.code !== 0) throw new Error(r.stderr.trim() || 'tmux send-keys failed');
    return { ok: true, via: 'tmux' };
  }
  return { ok: false, reason: 'this session kind cannot be nudged' };
}

export async function stopTask(run_) {
  if (run_.mode === 'openrig' && run_.rig) return run(bin('rig'), ['down', run_.rig, '--json'], { timeout: 120000 });
  if (run_.session?.kind === 'tmux') return run(bin('tmux') || 'tmux', ['kill-session', '-t', run_.session.id], { timeout: 5000 });
  return null;
}

export const DEFAULT_WORKROOT = path.join(HOME, 'rigs-work');
