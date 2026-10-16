import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { config, RIGS_HOME } from './config.js';
import { agentModes, claudeFlags, codexFlags } from './models.js';
import { CODEX_AUTO_PROFILE, codexAutoProfileReady, wrapperTarget } from './agentmodes.js';
import * as openrig from './openrig.js';
import { createPty, shellWrap } from './pty.js';
import { bin } from './tools.js';
import { HOME, expandHome, isWin, run } from './util.js';

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
  // The full brief lives on disk; agents get a short pointer to it (robust quoting on every OS).
  const briefDir = path.join(dir, '.rigs', 'tasks');
  await fsp.mkdir(briefDir, { recursive: true });
  const brief = path.join(briefDir, `${project.slug}-${task.id}.md`);
  await fsp.writeFile(brief, prompt);
  const pointer = `Read ${path.relative(dir, brief).split(path.sep).join('/')} and carry out the task it describes. Report back with the project_task_update tool when you are done.`;
  const a = task.assign;
  const rigOk = ['claude', 'codex', 'stub'].includes(a.provider) && !isWin && openrigAgentsDir() && (await openrig.status(true)).daemon === 'running';
  const useRig = mode === 'openrig' ? rigOk : mode === 'direct' ? false : rigOk;
  if (mode === 'openrig' && !rigOk) throw new Error('OpenRig is not available on this machine (needs `rig` + a running daemon, Claude Code or Codex)');
  if (useRig || a.provider === 'stub') return startOpenRig({ project, task, dir, brief, policy });
  return startDirect({ project, task, dir, pointer });
}

async function startOpenRig({ project, task, dir, brief, policy }) {
  const a = task.assign;
  const agents = openrigAgentsDir();
  const rigName = `${project.slug}-${task.id}`.slice(0, 40);
  const member = slug(task.kind || 'work', 16);
  const specDir = path.join(RIGS_HOME, 'rigs', rigName);
  await fsp.mkdir(specDir, { recursive: true });
  const runtime = a.provider === 'codex' ? 'codex' : a.provider === 'stub' ? 'stub' : 'claude-code';
  const yaml = [
    'version: "0.2"',
    `name: ${rigName}`,
    `summary: ${JSON.stringify(`RIGS project ${project.name}: ${task.title}`)}`,
    ...(policy && policy !== 'floor' ? [`permission_policy: ${policy}`] : []),
    'pods:',
    '  - id: task',
    `    label: ${JSON.stringify(task.title.slice(0, 60))}`,
    '    members:',
    `      - id: ${member}`,
    `        agent_ref: ${JSON.stringify('path:' + path.join(agents, AGENT_REF[task.kind] || AGENT_REF.code))}`,
    `        runtime: ${runtime}`,
    '        profile: default',
    `        cwd: ${JSON.stringify(dir)}`,
    ...(a.model ? [`        model: ${JSON.stringify(a.model)}`] : []),
    ...(a.effort ? [`        effort: ${JSON.stringify(a.effort)}`] : []),
    // Codex has no auto mode of its own; under builtin:auto OpenRig launches it "at the floor", which with a named
    // profile means `-p rigs-auto`: workspace-write + network, asking only to escalate (see agentmodes.js).
    ...(runtime === 'codex' && policy !== 'builtin:yolo' && codexAutoProfileReady() ? [`        codex_config_profile: ${CODEX_AUTO_PROFILE}`] : []),
    `        role: ${slug(task.kind || 'builder', 20)}`,
    '    edges: []',
    'edges: []',
    '',
  ].join('\n');
  const spec = path.join(specDir, 'rig.yaml');
  await fsp.writeFile(spec, yaml);
  const rig = bin('rig');
  const v = await run(rig, ['spec', 'validate', spec], { timeout: 30000 });
  if (v.code !== 0) throw new Error('rig spec invalid: ' + (v.stdout + v.stderr).trim().slice(-400));
  const up = await run(rig, ['up', spec, '--yes', '--json'], { timeout: 300000 });
  let upJson = null;
  try { upJson = JSON.parse(up.stdout.slice(up.stdout.indexOf('{'))); } catch {}
  const node = upJson?.stages?.flatMap((s) => s.detail?.nodes || [])[0];
  if (up.code !== 0 || !node?.sessionName) throw new Error('rig up failed: ' + (up.stdout + up.stderr).trim().slice(-400));
  const seat = node.sessionName;
  const qc = await run(rig, ['queue', 'create', '--source', `rigs-planner@${config().name}`, '--destination', seat, '--body-file', brief,
    '--summary', task.title.slice(0, 120), '--tags', `project:${project.id},task:${task.id}`, '--tier', task.size === 'L' ? 'deep' : 'routine'], { timeout: 60000 });
  const qitem = (qc.stdout.match(/qitem-[\w-]+/) || [])[0];
  if (!qitem) throw new Error('rig queue create failed: ' + (qc.stdout + qc.stderr).trim().slice(-300));
  return { mode: 'openrig', rig: rigName, seat, qitem, cwd: dir, session: { kind: 'rig', id: seat } };
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
  const name = `${project.slug}-${task.id}`.replace(/[^\w.-]/g, '-');
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

/** Where is a dispatched task at? (queue state for OpenRig, liveness for direct sessions) */
export async function taskStatus(run_) {
  if (run_.mode === 'openrig' && run_.qitem) {
    const r = await run(bin('rig'), ['queue', 'show', run_.qitem, '--json'], { timeout: 15000 });
    try {
      const j = JSON.parse(r.stdout.slice(r.stdout.indexOf('{')));
      const state = j.state || j.qitem?.state || j.waiting?.state;
      return { state, closure: j.closureReason || j.qitem?.closureReason || null };
    } catch { return { state: 'unknown' }; }
  }
  if (run_.session?.kind === 'tmux') {
    const r = await run(bin('tmux') || 'tmux', ['has-session', '-t', run_.session.id], { timeout: 5000 });
    return { state: r.code === 0 ? 'running' : 'ended' };
  }
  return { state: 'running' };
}

export async function stopTask(run_) {
  if (run_.mode === 'openrig' && run_.rig) return run(bin('rig'), ['down', run_.rig, '--json'], { timeout: 120000 });
  if (run_.session?.kind === 'tmux') return run(bin('tmux') || 'tmux', ['kill-session', '-t', run_.session.id], { timeout: 5000 });
  return null;
}

export const DEFAULT_WORKROOT = path.join(HOME, 'rigs-work');
