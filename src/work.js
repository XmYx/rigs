import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { guardBrief, gitDenyRules } from './autonomy.js';
import { config, RIGS_HOME } from './config.js';
import { dashboardSection } from './dashboards.js';
import { agentModes, claudeFlags, codexFlags } from './models.js';
import * as hubs from './hubs.js';
import { AGENT_REF, GONE, agentsDir as openrigAgentsDir, memberFor, memberYaml, modelTag, slug, specYaml } from './hubs.js';
import * as openrig from './openrig.js';
import { devRoot } from './merge.js';
import { createPty, shellWrap } from './pty.js';
import { bin } from './tools.js';
import { startRun } from './trace.js';
import { APP_DIR, HOME, expandHome, isWin, run, sleep } from './util.js';

/**
 * Runs ONE planned task on THIS machine. Called by the project's owner node through the mesh.
 * Ways to run it:
 *  - hub: the folder is a pinned project → its persistent rig (src/hubs.js): a worker seat with the routed
 *    model/effort gets the task as a queue item, or a follow-up is typed into the seat that holds the context
 *  - openrig: the project's own team rig (a seat per role + model) + the task as an owned queue item
 *  - direct: the agent CLI in a tmux session (or a terminal on Windows) with model/effort flags — only where
 *    OpenRig is unavailable (not installed, unhealthy, Windows, or a provider OpenRig can't run)
 */

function q(s) {
  return isWin ? `'${String(s).replace(/'/g, "''")}'` : `'${String(s).replace(/'/g, `'\\''`)}'`;
}

export { slug, modelTag };

// The blender-glb seed tool's line for a brief that needs it but whose tool hints missed it (its tags: 3d, blender, glb, mesh, model).
const BLENDER_HINT = '- `blender-glb` (tool): Build a 3D object headless in Blender from a bpy script or a preset (cube, sphere, chair, table, mug) and export a .glb plus a turntable PNG into the shared folder\'s files/3d.';

/**
 * The brief as the agent reads it: the planner's prompt plus (D5) the dashboard Sir is watching this task on, and (D6)
 * the blender-glb tool hint when the task is 3D work (kind "3d", or the brief talks about Blender / 3D / .glb) and
 * the "Reusable tools" matches did not already name it. Pure.
 */
export function enrichBrief(prompt, task = {}) {
  let out = String(prompt || '');
  const dash = dashboardSection(task.dashboards);
  if (dash) out = out.includes('## How to work') ? out.replace('## How to work', `${dash}## How to work`) : `${out.replace(/\s+$/, '')}\n\n${dash}`;
  const threeD = task.kind === '3d' || task.needs?.tool === 'blender' || /\bblender\b|\b3d\b|\.glb\b|\bglb\b/i.test(out);
  if (threeD && !/`blender-glb`/.test(out)) {
    const m = out.match(/^Likely matches for this task \(read with `tool_get` first\):\n((?:- .*\n)*)/m);
    if (m) out = out.replace(m[0], `${m[0]}${BLENDER_HINT}\n`);
    else if (out.includes('## Reusable tools\n')) out = out.replace(/(## Reusable tools\n[^\n]*\n)/, `$1Likely matches for this task (read with \`tool_get\` first):\n${BLENDER_HINT}\n`);
    else out = `${out.replace(/\s+$/, '')}\n\n## Reusable tools\nLikely matches for this task (read with \`tool_get\` first):\n${BLENDER_HINT}\n`;
  }
  return out;
}

async function prepareWorkdir(workdir, gitUrl) {
  const dir = path.resolve(expandHome(workdir || '~'));
  if (gitUrl && !fs.existsSync(path.join(dir, '.git'))) {
    await fsp.mkdir(path.dirname(dir), { recursive: true });
    const r = await run(bin('git') || 'git', ['clone', gitUrl, dir], { timeout: 600000 });
    if (r.code !== 0) throw new Error('git clone failed: ' + r.stderr.trim().slice(-300));
  } else if (gitUrl && within(dir, DEFAULT_WORKROOT)) {
    // Only RIGS's own clones are fast-forwarded; the user's folder keeps whatever branch tip he left it on.
    await run(bin('git') || 'git', ['pull', '--ff-only'], { cwd: dir, timeout: 120000 });
  }
  await fsp.mkdir(dir, { recursive: true });
  return dir;
}

export async function startTask({ trace, ...b }) {
  const r = await launchTask(b);
  // Request trace (src/trace.js): this run is a "task" span written here, on the machine that runs it; the run handle
  // keeps it (traceRun) so the end of the run — reported to the owner — comes back here to finish it.
  const traceRun = startRun(trace, { project: b.project, task: b.task, prompt: b.prompt, run: r, gitGuard: r.guard });
  const { guard, ...run } = r;
  return traceRun ? { ...run, traceRun } : run;
}

async function launchTask({ project, task, prompt, workdir, mode = 'auto', policy = config().agents?.rigPolicy || 'builtin:auto', source }) {
  const dir = await prepareWorkdir(workdir, project.gitUrl);
  // The installed checkout is production: agents change RIGS in a dev worktree (rigs_dev_start), never here.
  if (isInstall(dir)) throw new Error(`refusing to run an agent in the installed RIGS checkout (${dir}) — RIGS changes go through a dev worktree`);
  // Git guard: commits only inside a RIGS dev worktree, pushes and branch switches never (see autonomy.js).
  const devWorktree = isDevWorktree(dir);
  if (project.selfDev && !devWorktree) throw new Error(`refusing to run a RIGS change outside a dev worktree (${dir} is not under ${devRoot()}) — start one with rigs_dev_start`);
  const guarded = guardBrief(enrichBrief(prompt, task), { devWorktree, branch: project.selfDev?.branch || '' });
  prompt = guarded.prompt;
  const guard = { devWorktree, branch: project.selfDev?.branch || '', stripped: guarded.stripped };
  // The full brief lives on disk — under ~/.rigs, never inside the user's project folder; agents get a short
  // pointer to it (robust quoting on every OS), OpenRig seats get it as their queue item.
  const briefDir = path.join(RIGS_HOME, 'briefs', project.slug);
  await fsp.mkdir(briefDir, { recursive: true });
  const brief = path.join(briefDir, `${project.slug}-${task.id}.md`);
  await fsp.writeFile(brief, prompt);
  const pointer = `Read ${brief.split(path.sep).join('/')} and carry out the task it describes. Report back with the project_task_update tool when you are done.`;
  const a = task.assign;
  if (mode !== 'direct' && !isWin) await ensureDaemon().catch(() => {});
  const st = await openrig.status(true);
  const rigOk = ['claude', 'codex', 'stub'].includes(a.provider) && !isWin && !!openrigAgentsDir() && st.healthy !== false && st.daemon === 'running';
  const useRig = mode === 'openrig' ? rigOk : mode === 'direct' ? false : rigOk;
  if (mode === 'openrig' && !rigOk) throw new Error(st.health || 'OpenRig is not available on this machine (needs `rig` + a running daemon, Claude Code or Codex)');
  const pin = hubs.hubSettings().enabled ? hubs.pinFor(dir) : null;
  if (useRig && pin) return { ...(await hubs.dispatchTask({ pin, project, task, dir, brief, pointer, policy, source })), brief, guard };
  if (useRig || a.provider === 'stub') return { ...(await startOpenRig({ project, task, dir, brief, policy, source })), brief, guard };
  return { ...(await startDirect({ project, task, dir, pointer, devWorktree })), brief, guard };
}

const real = (p) => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };
const within = (dir, root) => { const d = real(dir); const r = real(root); return d === r || d.startsWith(r + path.sep); };

export function isInstall(dir) {
  return within(dir, APP_DIR);
}

/** A RIGS dev worktree (rigs_dev_start): a folder inside the dev root, never the root itself. */
export function isDevWorktree(dir) {
  return within(dir, devRoot()) && real(dir) !== real(devRoot());
}

/** The tmux session of a directly started task: unique per project (two "Merge conflict: …" projects share a slug). */
export function sessionName(project, task) {
  return `${project.slug}-${String(project.id || '').slice(0, 4)}-${task.id}${task.attempts ? `-r${task.attempts}` : ''}`.replace(/--+/g, '-').replace(/[^\w.-]/g, '-');
}

/**
 * The command line that starts a task's agent directly. Claude gets the git guard as deny rules (it cannot run a
 * forbidden git step even if a brief asked); the prompt goes after `--` so the variadic flag can't swallow it.
 */
export function directLine(a, pointer, { devWorktree = false } = {}) {
  const modes = agentModes();
  if (a.provider === 'claude') return ['claude', ...claudeFlags({ ...a, ...modes.claude }).map(q), '--disallowedTools', q(gitDenyRules({ devWorktree }).join(',')), '--', q(pointer)].join(' ');
  if (a.provider === 'codex') return ['codex', ...codexFlags({ ...a, ...modes.codex }).map(q), q(pointer)].join(' ');
  if (a.provider === 'ollama') {
    // Codex drives local Ollama models as a real agent (tools + MCP incl. REA); plain `ollama run` otherwise.
    return bin('codex') ? ['codex', '--oss', '--local-provider', 'ollama', ...(a.model ? ['-m', q(a.model)] : []), q(pointer)].join(' ') : `ollama run ${q(a.model || 'llama3.2')} ${q(pointer)}`;
  }
  throw new Error('unknown provider ' + a.provider);
}

/**
 * One OpenRig team per project on each machine: rig `<project>-<id>`, pod `team`, one seat per role + model
 * (`team-code-opus@…`). A task goes to an idle seat of its kind; a new role — or every same-role seat busy —
 * adds a seat with `rig add`. Seats keep their context between tasks, like colleagues on the project.
 */
async function startOpenRig({ project, task, dir, brief, policy, source }) {
  const a = task.assign;
  const rigName = slug(`${project.slug}-${String(project.id || '').slice(0, 4)}`, 40);
  const base = slug(`${task.kind || 'work'}-${modelTag(a)}`, 22);
  const member = (id) => memberFor({ id, kind: task.kind, assign: a, cwd: dir, policy });
  const specDir = path.join(RIGS_HOME, 'rigs', rigName);
  await fsp.mkdir(specDir, { recursive: true });

  let seats = (await openrig.status(true)).nodes?.filter((n) => n.rig === rigName) || [];
  if (seats.length && seats.every((n) => GONE.test(n.status || ''))) {
    // The team was stopped (or the machine restarted): start it fresh rather than half-restoring it.
    await openrig.rigRun(['down', rigName, '--delete', '--force', '--json'], { timeout: 120000 });
    seats = [];
  }
  const live = (id) => seats.find((n) => n.session === `team-${id}@${rigName}` && !GONE.test(n.status || ''));
  let id = base;
  for (let k = 2; live(id) && live(id).work > 0 && k <= 4; k++) id = `${base}-${k}`;
  let seat = live(id)?.session;

  if (!seats.length) {
    const spec = path.join(specDir, 'rig.yaml');
    await fsp.writeFile(spec, specYaml(rigName, `RIGS project ${project.name}`, policy, [member(id)]));
    const v = await openrig.rigRun(['spec', 'validate', spec], { timeout: 30000 });
    if (v.code !== 0) throw new Error('rig spec invalid: ' + (v.stdout + v.stderr).trim().slice(-400));
    const up = await openrig.rigRun(['up', spec, '--yes', '--json'], { timeout: 300000 });
    let upJson = null;
    try { upJson = JSON.parse(up.stdout.slice(up.stdout.indexOf('{'))); } catch {}
    const node = upJson?.stages?.flatMap((s) => s.detail?.nodes || [])[0];
    if (up.code !== 0 || !node?.sessionName) throw new Error('rig up failed: ' + (up.stdout + up.stderr).trim().slice(-400));
    seat = node.sessionName;
  } else if (!seat) {
    const frag = path.join(specDir, `${id}.member.yaml`);
    await fsp.writeFile(frag, memberYaml(member(id)).join('\n') + '\n');
    const add = await openrig.rigRun(['add', rigName, 'team', frag, '--json'], { timeout: 300000 });
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

  const qc = await openrig.rigRun(['queue', 'create', '--source', source || `rigs-planner@${config().name}`, '--destination', seat, '--body-file', brief,
    '--summary', task.title.slice(0, 120), '--tags', `project:${project.id},task:${task.id}`, '--tier', task.size === 'L' ? 'deep' : 'routine'], { timeout: 60000 });
  const qitem = (qc.stdout.match(/qitem-[\w-]+/) || [])[0];
  if (!qitem) throw new Error('rig queue create failed: ' + (qc.stdout + qc.stderr).trim().slice(-300));
  return { mode: 'openrig', rig: rigName, seat, qitem, cwd: dir, team: true, session: { kind: 'rig', id: seat } };
}

async function startDirect({ project, task, dir, pointer, devWorktree }) {
  const a = task.assign;
  const line = directLine(a, pointer, { devWorktree });
  const name = sessionName(project, task);
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
  if (!bin('rig') || isWin) return { skipped: true };
  const st = await openrig.status(true);
  if (st.daemon === 'running') return { running: true };
  if (st.daemon !== 'stopped') return { unknown: true }; // slow to answer is not down: never start a second daemon
  const r = await openrig.rigRun(['daemon', 'start'], { timeout: 120000 });
  const after = await openrig.status(true);
  return { started: after.daemon === 'running', output: (r.stdout + r.stderr).trim().slice(-200) };
}

/** Is this OpenRig seat's session alive? (false after a reboot, a killed tmux session, a crashed daemon) */
async function seatAlive(seat) {
  const st = await openrig.status(true);
  if (st.daemon === 'stopped') return null;
  if (st.daemon !== 'running' || !st.nodesOk) return true; // can't tell right now: assume alive, look again next tick
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
  const d = await ensureDaemon();
  // Nothing to bring back: the agent is fine (a daemon that was down and is up again doesn't kill its seats).
  if (await seatAlive(run_.seat)) return { ok: true, restored: false, how: d.started ? 'OpenRig was down — restarted it; the agent was unaffected' : 'the seat was alive' };
  const team = ((await openrig.status(true)).nodes || []).filter((n) => n.rig === run_.rig);
  const anyLive = team.some((n) => !GONE.test(n.status || ''));
  let how;
  let out = { stdout: '', stderr: '' };
  if (!anyLive) {
    out = await openrig.rigRun(['up', run_.rig, '--existing', '--yes', '--json'], { timeout: 300000 });
    how = 'restored the team from its snapshot (conversations resumed)';
  } else {
    await openrig.rigRun(['seat', 'clean', run_.seat], { timeout: 60000 });
    out = await openrig.rigRun(['seat', 'launch', run_.seat], { timeout: 300000 });
    how = 'gave the seat a fresh occupant';
  }
  // Success is the seat being live again (the CLI can exit non-zero on warnings while the restore worked).
  for (let i = 0; i < 45; i++) {
    if (await seatAlive(run_.seat)) { await sleep(5000); return { ok: true, restored: true, how }; }
    await sleep(2000);
  }
  return { ok: false, how, reason: 'the seat did not come back: ' + (out.stdout + out.stderr).trim().slice(-200) };
}

// Seat activity that means the agent is mid-turn (thinking, running a tool or a background job).
export const BUSY = /running|working|busy|thinking|streaming|tool|in[-_ ]?progress/i;

/** When the seat's transcript last grew (ms), or 0: a quiet prompt line does not mean a quiet agent. */
function transcriptMtime(run_) {
  try { return fs.statSync(path.join(HOME, '.openrig', 'transcripts', run_.rig, `${run_.seat}.log`)).mtimeMs; } catch { return 0; }
}

export async function taskStatus(run_) {
  if (run_.mode === 'openrig' && run_.qitem) {
    // A seat that died (reboot, killed session) leaves its queue item "in progress" forever: say so, so it is revived.
    const alive = await seatAlive(run_.seat).catch(() => true);
    if (alive === null) return { state: 'daemon-down' };
    const r = await openrig.rigRun(['queue', 'show', run_.qitem, '--json'], { timeout: 15000 });
    try {
      const j = JSON.parse(r.stdout.slice(r.stdout.indexOf('{')));
      const state = j.state || j.qitem?.state || j.waiting?.state;
      const live = j.waiting?.liveness || {};
      if (state !== 'done' && !alive) return { state: 'seat-down' };
      return { state, closure: j.closureReason || j.qitem?.closureReason || null, activity: live.activity || null,
        idle: live.activity === 'idle-at-prompt', needsInput: (live.needsInput?.count || 0) > 0, question: live.needsInput?.reason || '',
        busy: BUSY.test(live.activity || ''), activityAt: transcriptMtime(run_) };
    } catch { return { state: 'unknown' }; }
  }
  if (run_.session?.kind === 'tmux') {
    const t = bin('tmux') || 'tmux';
    const r = await run(t, ['has-session', '-t', run_.session.id], { timeout: 5000 });
    if (r.code !== 0) return { state: 'ended' };
    const pane = await run(t, ['capture-pane', '-p', '-t', run_.session.id], { timeout: 5000 });
    // Strip clocks/spinners so a frozen screen hashes the same.
    const text = pane.stdout.replace(/\d+(\.\d+)?\s?(s|m|ms|min|tokens?)\b|[⠀-⣿✻✶✳✢·*]/g, '');
    const act = await run(t, ['display-message', '-p', '-t', run_.session.id, '#{session_activity}'], { timeout: 5000 });
    const activityAt = (parseInt(act.stdout, 10) || 0) * 1000;
    const tail = pane.stdout.split('\n').slice(-15).join('\n');
    const needsInput = /Do you want to|\(y\/n\)|Allow .*\?|approve|permission/i.test(tail);
    return { state: 'running', activityAt, fingerprint: crypto.createHash('sha1').update(text).digest('hex').slice(0, 16),
      needsInput, question: needsInput ? tail.replace(/[│╭╮╰╯─]+/g, ' ').replace(/\s+/g, ' ').trim().slice(-400) : '' };
  }
  return { state: 'running' };
}

/** Is an agent already working on this task here? (a lost start reply) → its run handle, or null. */
export async function findTask({ project, task }) {
  const tags = [`project:${project.id}`, `task:${task.id}`];
  if (bin('rig')) {
    const r = await openrig.rigRun(['queue', 'list', '--json'], { timeout: 20000 });
    try {
      const j = JSON.parse(r.stdout.slice(r.stdout.search(/[[{]/)));
      const items = (Array.isArray(j) ? j : j.items || j.qitems || []).filter((q) => tags.every((x) => (q.tags || []).includes(x)) && ['in-progress', 'pending'].includes(q.state));
      const q = items.sort((a, b) => (a.state === 'in-progress' ? -1 : 1) - (b.state === 'in-progress' ? -1 : 1) || String(b.tsCreated).localeCompare(String(a.tsCreated)))[0];
      const rig = q && q.destinationSession.split('@')[1];
      if (q) return { run: { mode: 'openrig', rig, hub: /^hub-/.test(rig), seat: q.destinationSession, qitem: q.qitemId, team: true, session: { kind: 'rig', id: q.destinationSession } } };
    } catch {}
  }
  const t = bin('tmux');
  if (t && !isWin && project.slug) {
    const name = sessionName(project, task);
    if ((await run(t, ['has-session', '-t', name], { timeout: 5000 })).code === 0) return { run: { mode: 'direct', session: { kind: 'tmux', id: name } } };
  }
  return { run: null };
}

/** The watchdog's nudge: a message typed into the agent's session (OpenRig seat or tmux). */
export async function nudgeTask({ text, dismiss = false, ...run_ }) {
  if (!text) throw new Error('nothing to send');
  if (run_.mode === 'openrig' && run_.seat) {
    // A permission prompt holds the seat: decline it (Escape — the safe default), then the answer can be typed.
    if (dismiss) { await openrig.rigRun(['send', run_.seat, '\u001b', '--dangerously-interact', '--reason', 'RIGS self-answer: decline the pending prompt (safe default)'], { timeout: 30000 }).catch(() => {}); await sleep(800); }
    const r = await openrig.rigRun(['send', run_.seat, text], { timeout: 30000 });
    if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim().slice(-200) || 'rig send failed');
    return { ok: true, via: 'rig send' };
  }
  if (run_.session?.kind === 'tmux') {
    const t = bin('tmux') || 'tmux';
    if (dismiss) { await run(t, ['send-keys', '-t', run_.session.id, 'Escape'], { timeout: 5000 }); await sleep(800); }
    await run(t, ['send-keys', '-t', run_.session.id, '-l', text], { timeout: 5000 });
    await sleep(300);
    const r = await run(t, ['send-keys', '-t', run_.session.id, 'Enter'], { timeout: 5000 });
    if (r.code !== 0) throw new Error(r.stderr.trim() || 'tmux send-keys failed');
    return { ok: true, via: 'tmux' };
  }
  return { ok: false, reason: 'this session kind cannot be nudged' };
}

export async function stopTask(run_) {
  // A pinned project's rig is persistent: stopping a task cancels its queue item (so no seat picks it up again) and
  // stops its worker seat, never the rig. A task running in the lead is told to stop; the lead itself stays.
  if (run_.mode === 'openrig' && run_.hub) {
    if (run_.qitem) await openrig.rigRun(['queue', 'update', run_.qitem, '--state', 'canceled', '--note', 'RIGS: Sir stopped this task'], { timeout: 30000 });
    if (!run_.seat) return null;
    if (run_.seat === run_.lead) return openrig.rigRun(['send', run_.seat, 'RIGS: Sir stopped the task you were given. Stop working on it now and wait for new instructions.'], { timeout: 30000 });
    return openrig.rigRun(['seat', 'stop', run_.seat, '--reason', 'RIGS: task stopped', '--json'], { timeout: 60000 });
  }
  if (run_.mode === 'openrig' && run_.rig) return openrig.rigRun(['down', run_.rig, '--json'], { timeout: 120000 });
  if (run_.session?.kind === 'tmux') return run(bin('tmux') || 'tmux', ['kill-session', '-t', run_.session.id], { timeout: 5000 });
  return null;
}

export const DEFAULT_WORKROOT = path.join(HOME, 'rigs-work');
