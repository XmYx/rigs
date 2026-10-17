import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import * as chat from './chat.js';
import { config, RIGS_HOME } from './config.js';
import { PROVIDERS, coreBrain } from './models.js';
import { log, readJson, truncate, writeJsonAtomic } from './util.js';
import { slug } from './work.js';

/**
 * Projects: a goal → tasks (planned by the core brain) → each task routed to a machine +
 * provider + model + effort (deterministic, explained, editable) → dispatched through OpenRig
 * seats/queues or direct agent sessions → tracked until done. Lives on the node that owns it.
 */

const DIR = path.join(RIGS_HOME, 'projects');
export const KINDS = ['plan', 'architecture', 'code', 'test', 'review', 'merge', 'research', 'docs', 'text', 'reverse-engineer', 'media', 'private'];
// Fallback order when the policy's provider isn't available. Ollama is opt-in only (kind "private" or a rule/hand pick).
const PROVIDER_ORDER = ['claude', 'codex'];

export async function listProjects() {
  await fsp.mkdir(DIR, { recursive: true });
  const files = (await fsp.readdir(DIR)).filter((f) => f.endsWith('.json'));
  const all = (await Promise.all(files.map((f) => readJson(path.join(DIR, f))))).filter(Boolean);
  return all.map((p) => ({
    id: p.id, name: p.name, goal: truncate(p.goal, 200), status: p.status, owner: p.owner, updatedAt: p.updatedAt,
    main: !!p.main,
    tasks: p.tasks.map((t) => ({ id: t.id, title: t.title, kind: t.kind, status: t.status, assign: t.assign, run: t.run ? { mode: t.run.mode, seat: t.run.seat || '', rig: t.run.rig || '', session: t.run.session || null, startedAt: t.run.startedAt } : null })),
  })).sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function getProject(id) {
  if (!/^[\w-]+$/.test(id)) return null;
  return readJson(path.join(DIR, id + '.json'));
}

export async function saveProject(p) {
  p.updatedAt = Date.now();
  await writeJsonAtomic(path.join(DIR, p.id + '.json'), p);
  return p;
}

export async function deleteProject(id) {
  if (!/^[\w-]+$/.test(id)) return false;
  await fsp.rm(path.join(DIR, id + '.json'), { force: true });
  return true;
}

export async function createProject({ name, goal, repoNode, repoPath, gitUrl, dispatch, policy, planner } = {}) {
  if (!goal?.trim()) throw new Error('a project needs a goal');
  const id = crypto.randomBytes(5).toString('hex');
  const p = {
    id, slug: slug(name || goal, 18), name: name || truncate(goal, 50), goal, owner: config().name,
    repo: { node: repoNode || config().name, path: repoPath || '' }, gitUrl: gitUrl || '',
    dispatch: dispatch || config().routing.dispatch || 'auto', policy: policy || config().agents?.rigPolicy || 'builtin:auto',
    planner: planner || coreBrain(), status: 'draft', tasks: [], log: [], createdAt: Date.now(), updatedAt: Date.now(),
  };
  return saveProject(p);
}

function event(p, text) {
  p.log.push({ ts: Date.now(), text });
  if (p.log.length > 300) p.log = p.log.slice(-300);
}

// ------------------------------------------------------------------ planning (core brain)

function meshBrief(snapshot) {
  return snapshot.filter((e) => e.node.online && e.node.rigs).map((e) => {
    const n = e.node;
    const providers = (e.brains || []).map((b) => (b.id === 'ollama' ? `ollama[${b.models.slice(0, 6).join(', ')}]` : b.id)).join(', ') || 'none';
    const mem = n.stats ? Math.round((n.stats.memUsed / n.stats.memTotal) * 100) : '?';
    const tools = Object.values(n.capabilities || {}).map((c) => `${c.id} (${c.kinds.join('/')})`).join(', ') || 'none';
    return `- ${n.name}: ${n.platform} ${n.arch || ''}; GPU: ${(n.gpus || []).join(', ') || 'n/a'}; RAM ${n.stats ? Math.round(n.stats.memTotal / 2 ** 30) + 'GB' : '?'}; load cpu ${n.stats?.cpu ?? '?'}% mem ${mem}%; providers: ${providers}; tools: ${tools}; OpenRig: ${e.openrig?.daemon === 'running' ? 'yes' : 'no'}`;
  }).join('\n');
}

/** What the planner and every agent should know about the folder a project is bound to. */
export function workspaceBrief(p) {
  const w = p.workspace;
  if (!w) return '';
  const unity = (w.parts || []).filter((x) => x.kind === 'unity').map((x) => `${x.rel || '.'} (Unity ${x.version})`);
  if (w.unity) unity.unshift(`. (Unity ${w.unity})`);
  const repos = (w.parts || []).filter((x) => x.kind === 'git').map((x) => x.rel);
  if ((w.kinds || []).includes('git') && !repos.includes('.')) repos.unshift('.');
  return [
    `- Folder: ${p.repo.path} on ${p.repo.node}${w.title ? ` — "${w.title}"` : ''}`,
    `- Kinds: ${(w.kinds || []).join(', ') || 'unknown'}`,
    unity.length ? `- Unity project(s): ${unity.join('; ')}` : '',
    repos.length ? `- Git repositories: ${repos.join(', ')}` : '',
    w.guides?.length ? `- Agent guide(s): ${w.guides.join(', ')} in that folder — they define how work is done there.` : '',
  ].filter(Boolean).join('\n');
}

function planningPrompt(p, snapshot, guide = '') {
  const rules = config().routing.rules.map((r) => `${r.kind}${r.size ? '/' + r.size : ''}${r.tool ? ' [needs ' + r.tool + ']' : ''} → ${r.provider} ${r.model || '(default)'} effort=${r.effort || 'default'}`).join('; ');
  return `You are the planning brain of RIGS, a mesh of the user's workstations with coding agents on each.
Break this project into concrete, independently executable tasks for coding agents.

PROJECT: ${p.name}
GOAL: ${p.goal}${p.request && p.request !== p.goal ? `\nTHE USER'S WHOLE REQUEST (other parts go to other projects): ${p.request}` : ''}
REPOSITORY: ${p.repo.path ? `${p.repo.path} on machine ${p.repo.node}` : 'none given'}${p.gitUrl ? ` (git: ${p.gitUrl})` : ''}
${p.workspace ? `\nWORKSPACE:\n${workspaceBrief(p)}\n` : ''}${guide ? `\nTHE PROJECT'S OWN AGENT GUIDE (authoritative for how work is done in this folder — roles, which model does what, how to verify, what not to touch; shape the tasks and suggested providers/models to it):\n<<<\n${guide}\n>>>\n` : ''}
MACHINES:
${meshBrief(snapshot)}

ROUTING POLICY (task kind → provider/model/effort; machines are chosen by RIGS afterwards): ${rules}

Rules:
- 2 to 12 tasks. Each must be doable by one agent in one session and have a verifiable outcome.
- Every task has "acceptance": 1-5 concrete, checkable criteria (what must be true when it is done), and "verify": how the agent
  proves it (exact test/build commands, a run, or evidence such as a screenshot path). UI work verifies with screenshots,
  including a phone-sized viewport (e.g. 390x844) when layout or mobile use is involved.
- Typical shape: measure/audit → change → test → review. The LAST task is always kind "review": an independent check of the
  whole result against the goal (deps: every other task), which re-runs the verification and reports what is open.${p.selfDev ? `
- This is a change to RIGS itself. Every task works in the same dev worktree (${p.repo.path}, branch ${p.selfDev.branch}) and
  commits there; \`npm test\` (and \`npm run build\` when ui/ changed) must pass before a task reports done. Do NOT plan a task
  to merge, push, propose or roll out: when every task is done RIGS proposes the branch to the merge steward itself.` : ''}
- Size the plan to the goal: an outline or survey is 1-3 tasks; a measurable improvement is measure → change → verify.${p.selfDev ? '' : `
- Commits on this project need Sir's OK: never plan a task to commit, push, merge or switch branches in its repositories.
  Tasks leave their changes in the working tree and list them; non-destructive steps (builds, tests, runs) need no asking.`}
- Unity (or any live editor): only ONE agent can drive the running editor at a time — chain editor-bound tasks with deps,
  and let other tasks work on files, data or analysis. Measure before and after (the guide may name fps/profiling hooks).
- OpenRig vocabulary: an "OpenRig project" is an OpenRig project workspace — SPEC.md (intent), project.yaml (install:
  intent/context/skills/worlds), missions/ — plus the rig spec of the team (pods, seats, runtimes, models, edges) that
  works on it. Agents can read \`rig context get reference/project-workspace.md\` and \`reference/rig-spec.md\`.
- kind is one of: ${KINDS.join(', ')}. Use "review" for an independent check of another task's output (list it in deps).
  Use "reverse-engineer" when existing software/binaries must be understood (agents have REA for that).
  Use "text" for simple writing/transformation, "docs" for documentation, "media" for image/video/audio generation
  (set needs.tool to the tool that does it, e.g. "comfyui"), and "private" ONLY when the user asked for local-only models.
- Size drives the model tier: S/M code = simpler algorithms, L = elaborate work.
- size is S, M or L. deps lists ids of tasks that must finish first (keep parallelism where possible).
- needs.platform is mac, linux, windows or any. needs.gpu is true only when the task truly needs a GPU.
  needs.tool names a machine tool from the MACHINES list (e.g. "comfyui") when the task needs it.
- suggest is optional: a machine name and/or provider you think fits better than the policy, with a short why.

Reply with ONLY a JSON object, no prose, no code fence:
{"summary":"one sentence","tasks":[{"id":"t1","title":"...","description":"what to do, inputs, definition of done","kind":"code","size":"M","acceptance":["..."],"verify":"...","deps":[],"needs":{"platform":"any","gpu":false,"tool":""},"suggest":{"machine":"","provider":"","why":""}}]}`;
}

function extractJson(text) {
  const t = String(text || '').replace(/```(?:json)?/g, '');
  const start = t.indexOf('{');
  const end = t.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('the planner did not return JSON');
  return JSON.parse(t.slice(start, end + 1));
}

function normalizeTasks(raw) {
  const tasks = (raw.tasks || []).slice(0, 20).map((t, i) => ({
    id: /^[\w-]{1,12}$/.test(t.id || '') ? t.id : `t${i + 1}`,
    title: truncate(t.title || `Task ${i + 1}`, 120),
    description: String(t.description || t.title || ''),
    kind: KINDS.includes(t.kind) ? t.kind : 'code',
    size: ['S', 'M', 'L'].includes(t.size) ? t.size : 'M',
    deps: Array.isArray(t.deps) ? t.deps.map(String) : [],
    needs: { platform: ['mac', 'linux', 'windows'].includes(t.needs?.platform) ? t.needs.platform : 'any', gpu: !!t.needs?.gpu, tool: /^[\w-]{1,40}$/.test(t.needs?.tool || '') ? t.needs.tool.toLowerCase() : '' },
    suggest: t.suggest || {},
    acceptance: (Array.isArray(t.acceptance) ? t.acceptance : t.acceptance ? [t.acceptance] : []).map((x) => truncate(String(x), 300)).slice(0, 8),
    verify: truncate(String(t.verify || ''), 600),
    status: 'todo', assign: null, reason: '', run: null, summary: '',
  }));
  const ids = new Set(tasks.map((t) => t.id));
  for (const t of tasks) t.deps = t.deps.filter((d) => ids.has(d) && d !== t.id);
  return tasks;
}

/**
 * Every plan ends in an independent review of the whole result. If the planner left it out (or its last review
 * doesn't wait for everything), add one that depends on every task nothing else depends on.
 */
export function ensureFinalReview(tasks, goal = '') {
  if (!tasks.length) return tasks;
  const dependedOn = new Set(tasks.flatMap((t) => t.deps));
  const leaves = tasks.filter((t) => !dependedOn.has(t.id));
  if (leaves.length === 1 && leaves[0].kind === 'review') return tasks;
  let n = tasks.length + 1;
  while (tasks.some((t) => t.id === `t${n}`)) n++;
  const [review] = normalizeTasks({ tasks: [{
    id: `t${n}`, title: 'Final review: verify the whole result', kind: 'review', size: 'M',
    description: `Independently check that the finished tasks achieve the goal${goal ? ` ("${truncate(goal, 300)}")` : ''}. Re-run their verification yourself (tests, build, runs, screenshots), read the changes, and fix small gaps directly. Report done only if the goal is met; otherwise report failed with exactly what is missing.`,
    acceptance: ['every earlier task\'s acceptance criteria hold when re-checked', 'the verification commands pass on the final state'],
    verify: 're-run each task\'s verify step and list the results in the summary',
  }] });
  review.deps = leaves.map((t) => t.id); // set after normalizing: it only keeps deps within its own list
  tasks.push(review);
  return tasks;
}

/** The project's AGENTS.md / CLAUDE.md (first ~9k chars), read from the machine the folder is on. */
async function readGuide(p, ctx) {
  const g = p.workspace?.guides?.[0];
  if (!g || !p.repo.path) return '';
  const sep = p.repo.path.includes('\\') && !p.repo.path.includes('/') ? '\\' : '/';
  try {
    const r = await ctx.call(p.repo.node, `files/read?path=${encodeURIComponent(p.repo.path.replace(/[\\/]$/, '') + sep + g)}`, { timeout: 20000 });
    return truncate(r.text || '', 9000);
  } catch { return ''; }
}

/** Ask the planner brain for tasks. Runs on the owner node; the brain may be on any machine. */
export async function planProject(id, ctx, { brain } = {}) {
  const p = await getProject(id);
  if (!p) throw new Error('project not found');
  const b = brain?.provider ? brain : p.planner || coreBrain();
  p.planner = b;
  const snapshot = await ctx.snapshot();
  const guide = await readGuide(p, ctx);
  const prompt = planningPrompt(p, snapshot, guide);
  p.status = 'planning';
  event(p, `planning with ${b.provider} ${b.model || ''} ${b.effort ? '(' + b.effort + ')' : ''} on ${b.node || p.owner}`.replace(/\s+/g, ' '));
  await saveProject(p);
  const out = await ctx.ask(b.node || 'self', prompt, { brain: b.provider, model: b.model, effort: b.effort, title: `Plan · ${p.name}` });
  if (out.error && !out.text) { p.status = 'draft'; event(p, 'planning failed: ' + out.error); await saveProject(p); throw new Error(out.error); }
  let parsed;
  try { parsed = extractJson(out.text); } catch (e) { p.status = 'draft'; event(p, 'planning failed: ' + e.message); await saveProject(p); throw new Error(`${e.message}: ${truncate(out.text, 300)}`); }
  p.tasks = ensureFinalReview(normalizeTasks(parsed), p.goal);
  p.summary = parsed.summary || '';
  routeProject(p, snapshot);
  p.status = 'planned';
  event(p, `planned ${p.tasks.length} tasks`);
  return saveProject(p);
}

/**
 * A request that names one of the workspace's flows ("Mad Mike update" → its nightly `madmikeupdate` job) runs
 * that flow — no planning from scratch: one agent carries it out where the workspace lives, a review verifies it.
 */
export async function planFlow(id, ctx) {
  const p = await getProject(id);
  if (!p?.flow) throw new Error('project has no flow');
  const f = p.flow;
  p.tasks = ensureFinalReview(normalizeTasks({ tasks: [{
    id: 't1', title: `Run ${f.name}${f.description ? ' — ' + f.description : ''}`, kind: 'code', size: 'L',
    description: `Sir asked: "${p.request || p.goal}". Carry out the workspace's "${f.name}" flow (below) now, exactly as its scheduled run would, following the workspace's agent guide (its worktree/branch conventions, builds, tests, notes).`,
    acceptance: ['the flow ran to its end and its deliverables exist (commits/branch, build or release, notes as the flow prescribes)', 'its build and tests pass on the result'],
    verify: 'the checks the flow and the workspace guide prescribe; list commands and results',
  }] }), p.goal);
  routeProject(p, await ctx.snapshot());
  p.status = 'planned';
  event(p, `runs the ${f.name} flow: ${p.tasks.length} tasks`);
  return saveProject(p);
}

// ------------------------------------------------------------------ routing

function ruleFor(task, provider) {
  const rules = config().routing.rules;
  const fits = (r) => (r.kind === task.kind || r.kind === '*') && (!r.size || r.size === task.size) && (!provider || r.provider === provider);
  return rules.find(fits) || (provider ? null : { provider: 'claude', model: '', effort: '' });
}

/** Planner suggestions arrive as free text ("Claude Opus", "codex-cli"…); map to a provider id. */
function normProvider(x) {
  const v = String(x || '').toLowerCase();
  return v.includes('claude') || v.includes('opus') || v.includes('sonnet') || v.includes('haiku') || v.includes('fable') ? 'claude'
    : v.includes('codex') || v.includes('gpt') ? 'codex' : v.includes('ollama') || v.includes('local') ? 'ollama' : v === 'stub' ? 'stub' : '';
}

function nodeHas(entry, provider) {
  if (provider === 'stub') return entry.openrig?.daemon === 'running';
  return (entry.brains || []).some((b) => b.id === provider && (provider !== 'ollama' || b.models.length));
}

function hasDiscreteGpu(n) {
  return (n.gpus || []).some((g) => /nvidia|geforce|rtx|quadro|radeon|amd/i.test(g));
}

/**
 * Deterministic, explainable placement. For each task: policy rule → provider/model/effort;
 * then the best machine that has that provider, meets platform/GPU needs, and keeps code next to
 * the repository, preferring idle machines and spreading work. Falls back to other providers.
 */
export function routeProject(p, snapshot, { onlyUnassigned = false } = {}) {
  const live = snapshot.filter((e) => e.node.online && e.node.rigs);
  const load = new Map(live.map((e) => [e.node.name, 0]));
  for (const t of p.tasks) if (t.assign && (onlyUnassigned || t.status !== 'todo')) load.set(t.assign.node, (load.get(t.assign.node) || 0) + 1);
  const max = config().routing.maxTasksPerMachine || 4;
  // A folder that exists only on one machine (no git URL to clone): everything that works on it runs there.
  const codeLocal = (t) => !['media', 'private'].includes(t.kind) && p.repo.path && !p.gitUrl;

  for (const t of p.tasks) {
    if (t.status !== 'todo') continue;
    if (onlyUnassigned && t.assign) continue;
    if (t.assign?.locked) continue;
    const rule = ruleFor(t);
    let first = rule.provider;
    // Cross-check: if one agent wrote everything this reviews, the review goes to the other one.
    if (rule.crossCheck) {
      const deps = t.deps.map((d) => p.tasks.find((x) => x.id === d)).filter(Boolean);
      const work = deps.filter((x) => ['code', 'test', 'architecture'].includes(x.kind));
      const authors = new Set((work.length ? work : deps).map((x) => x.assign?.provider).filter(Boolean));
      if (authors.size === 1 && authors.has(first)) first = first === 'claude' ? 'codex' : first === 'codex' ? 'claude' : first;
    }
    const picks = config().routing.plannerPicks || 'machine';
    const tool = t.needs.tool || rule.tool || '';
    const suggestText = `${t.suggest?.provider || ''} ${t.suggest?.model || ''}`.trim();
    const suggested = picks === 'all' ? normProvider(suggestText) : '';
    let providers = [suggested, first, rule.provider, ...PROVIDER_ORDER].filter((x, i, a) => x && a.indexOf(x) === i);
    if (t.kind === 'private') providers = ['ollama'];
    let best = null;
    for (const provider of providers) {
      for (const e of live) {
        const n = e.node;
        if (!nodeHas(e, provider)) continue;
        if (t.needs.platform !== 'any' && n.platform !== t.needs.platform) continue;
        if (tool && !n.capabilities?.[tool]) continue;
        if (codeLocal(t) && n.name !== p.repo.node) continue;
        const why = [];
        let score = 100 - (provider === providers[0] ? 0 : 30 * providers.indexOf(provider));
        const cpu = n.stats?.cpu ?? 50;
        const mem = n.stats ? (n.stats.memUsed / n.stats.memTotal) * 100 : 50;
        score -= cpu * 0.4 + mem * 0.2;
        const assigned = load.get(n.name) || 0;
        score -= assigned * 12 + (assigned >= max ? 60 : 0);
        if (n.name === p.repo.node && ['code', 'test', 'review'].includes(t.kind)) { score += 25; why.push('repository lives here'); }
        if (t.needs.gpu) { if (hasDiscreteGpu(n)) { score += 40; why.push('has a discrete GPU'); } else score -= 30; }
        if (provider === 'ollama' && hasDiscreteGpu(n)) { score += 15; why.push('GPU for local models'); }
        if (e.openrig?.daemon === 'running' && provider !== 'ollama') { score += 5; }
        if (picks !== 'none' && t.suggest?.machine && t.suggest.machine.toLowerCase() === n.name.toLowerCase()) { score += 30; why.push('planner suggested it'); }
        if (tool) why.push(`has ${tool}`);
        if (cpu < 25) why.push(`idle (cpu ${cpu}%)`);
        if (!best || score > best.score) best = { score, node: n, entry: e, provider, why };
      }
      if (best && best.provider === provider) break;
    }
    if (!best) {
      t.assign = null;
      t.reason = `no online machine can run this task (needs ${[providers[0], tool, t.needs.platform !== 'any' ? t.needs.platform : ''].filter(Boolean).join(' + ')})`;
      continue;
    }
    const a = { node: best.node.name, provider: best.provider, model: '', effort: '' };
    const pr = ruleFor(t, best.provider);
    if (pr) { a.model = pr.model || ''; a.effort = pr.effort || ''; }
    if (best.provider === suggested) {
      const m = (PROVIDERS[suggested]?.models || []).find((x) => suggestText.toLowerCase().includes(x));
      if (m) a.model = m;
    }
    if (best.provider === 'ollama') {
      const models = best.entry.brains.find((b) => b.id === 'ollama')?.models || [];
      a.model = models.includes(rule.model) ? rule.model : models[0] || '';
      if (!['off', 'on', 'low', 'medium', 'high'].includes(a.effort)) a.effort = 'off';
    }
    t.assign = a;
    if (tool) {
      t.needs.tool = tool;
      const c = best.node.capabilities?.[tool];
      t.toolInfo = [c?.url && `HTTP API ${c.url}`, c?.command && `CLI ${c.command}`, c?.notes].filter(Boolean).join(' · ');
    }
    const how = best.provider === suggested && suggested !== rule.provider ? `planner's pick (policy says ${rule.provider})`
      : best.provider === first && first !== rule.provider ? `cross-check: reviews ${rule.provider}'s work`
      : best.provider === rule.provider ? 'policy' : `fallback — no machine can run ${first} for this`;
    const hint = picks !== 'all' && suggestText && normProvider(suggestText) && normProvider(suggestText) !== a.provider ? ` (planner suggested ${suggestText})` : '';
    t.reason = `${t.kind}${t.size === 'L' ? ' (large)' : ''} → ${a.provider}${a.model ? ' ' + a.model : ''}${a.effort ? ' · ' + a.effort : ''} by ${how}${hint}; ${best.node.name}: ${best.why.join(', ') || 'least loaded'}`;
    load.set(best.node.name, (load.get(best.node.name) || 0) + 1);
  }
  return p;
}

// ------------------------------------------------------------------ dispatch + tracking

/**
 * What an agent may do on its own. Sir's standing rule: non-destructive work runs without asking; RIGS
 * changes go to the merge steward; work on other projects is not committed until Sir says so.
 */
export function autonomyBrief(p) {
  const commit = config().agents?.commitOtherProjects || 'ask';
  return `## What you may do without asking
- Pre-approved by Sir: everything non-destructive — reading, editing files in the project folder, builds, tests,
  profiling and benchmark runs, launching the app, game or editor, project-local installs. This overrides any saved
  habit of confirming such steps first: do them.
- Not pre-approved: destructive or irreversible steps — deleting or overwriting data you did not create, reverting,
  resetting, stashing or discarding changes, force-pushes and history rewrites, publishing or deploying, spending money,
  changing system settings. If one is truly needed, don't do it: report status "blocked" naming the exact step and why.
${p.selfDev ? '- Commits: this is RIGS itself — commit in your dev worktree; RIGS proposes the branch to the merge steward, which tests and pushes it.'
    : commit === 'branch' ? '- Commits: you may commit on a work branch of your own (never main/master, never push); say which branch in your summary.'
      : '- Commits: Sir approves commits on this project. Do not commit, push, merge, rebase or switch branches in its repositories — leave your changes in the working tree and list every file you changed plus a suggested commit message in your summary.'}
`;
}

function taskPrompt(p, t) {
  const done = t.deps.map((d) => p.tasks.find((x) => x.id === d)).filter(Boolean);
  const others = p.tasks.filter((x) => x.id !== t.id && x.status === 'running').map((x) => `- ${x.id} ${x.title} (${x.assign?.provider} on ${x.assign?.node})`);
  return `# ${t.title}

You are one agent in a RIGS project run across the user's machines.

- Project: **${p.name}** (id \`${p.id}\`, coordinated by machine \`${p.owner}\`)
- Project goal: ${p.goal}
- Your task id: \`${t.id}\` · kind: ${t.kind} · size: ${t.size}
- You run on \`${t.assign.node}\` as ${t.assign.provider}${t.assign.model ? ' ' + t.assign.model : ''}${t.assign.effort ? ' (effort ' + t.assign.effort + ')' : ''}
${p.workspace ? `
## Workspace
${workspaceBrief(p)}
- Read the project's ${p.workspace.guides?.length ? p.workspace.guides.join(' / ') : 'README'} first and follow it — it overrides the generic notes below.
- The folder may hold uncommitted work by the user or other agents: never revert, stash, reset or commit changes you didn't make.
` : ''}
## Task
${t.description}

${done.length ? `## Already finished (inputs for you)\n${done.map((d) => `- ${d.id} ${d.title}${d.summary ? ': ' + d.summary : ''}`).join('\n')}\n` : ''}${others.length ? `## Running in parallel elsewhere\n${others.join('\n')}\n` : ''}
${t.needs?.tool ? `## Tool for this task\nThis machine provides **${t.needs.tool}**${t.toolInfo ? ` — ${t.toolInfo}` : ''}. Use it for the actual generation/processing.\n\n` : ''}${p.flow ? `## The workspace's own flow: ${p.flow.name}\nSir asked for this project's recurring "${p.flow.name}" job (${p.flow.source} on ${p.repo.node}). Its instructions:\n<<<\n${p.flow.prompt}\n>>>\n\n` : ''}${p.selfDev ? `## This is a change to RIGS itself
- Work ONLY in the dev worktree \`${p.repo.path}\` (branch \`${p.selfDev.branch}\`) and commit there. Never touch the installed checkout (~/.rigs/app) or main.
- Do not call rigs_dev_start or rigs_propose: when every task of this project is done, RIGS proposes the branch to the merge steward, which re-runs build + tests, merges, pushes and rolls out.
- Before reporting done: \`npm test\` passes (and \`npm run build\` when ui/ changed), and your work is committed.

` : ''}${autonomyBrief(p)}
${t.acceptance?.length ? `## Acceptance criteria\n${t.acceptance.map((a) => `- [ ] ${a}`).join('\n')}\n\n` : ''}${t.verify ? `## Verify with\n${t.verify}\n\n` : ''}${t.attempts ? `## Previous attempt ${t.attempts} did not finish\n${t.lastFailure || 'It ended without a report.'}\nPick up from what it left (check the folder and git state) instead of starting over.\n\n` : ''}## How to work
- Stay inside your task. If you need something from another machine, use the rigs MCP tools (mesh_*).
- To understand existing software, binaries or apps, use REA (the \`rea\` MCP / \`npx -y rea-agents@latest\`).
- Nobody is watching this session: never stop to ask a question or wait for a reply. Decide sensibly, note the assumption in your summary.
- Never end your turn while waiting on a background job (a build, a test run, a capture): wait for it, read its result, carry on.

## Definition of done
1. Every acceptance criterion holds, and you checked it yourself (run the tests/build, run the thing, capture a screenshot for anything visual).
2. If a check fails, fix it and check again. Only report "failed" when you cannot make it pass — with the exact failing output.
3. Your summary says what changed, where, and the verification evidence (commands + results, screenshot paths).

## When you finish or get stuck
Call the rigs MCP tool \`project_task_update\` with
\`{"owner": "${p.owner}", "project": "${p.id}", "task": "${t.id}", "status": "done" | "blocked" | "failed", "summary": "<what you did, where the result is, the verification evidence — or what failed / what you need>"}\`.
This report is the only way RIGS knows you finished: the next tasks start from it, and Sir hears the result.
${'If you are an OpenRig seat, also close your queue item.'}
`;
}

function ready(p, t) {
  return t.status === 'todo' && t.assign && t.deps.every((d) => p.tasks.find((x) => x.id === d)?.status === 'done');
}

// Autonomy limits: a task gets one fresh retry; an idle agent is nudged every STALL_MS, then escalated.
export const MAX_ATTEMPTS = 2;
export const STALL_MS = 15 * 60 * 1000;
export const MAX_NUDGES = 3;
const STARTING_MS = 15 * 60 * 1000;
const PLANNING_MS = 20 * 60 * 1000;

/** Start every task whose dependencies are done. */
export async function dispatchReady(id, ctx, { only } = {}) {
  const p = await getProject(id);
  if (!p) throw new Error('project not found');
  if (!only && !['planned', 'running', 'blocked'].includes(p.status)) throw new Error(`project is ${p.status}`);
  if (!only) p.status = 'running';
  // Tasks that lost their machine (dispatch failed, machine offline) are placed again before starting.
  if (p.tasks.some((t) => t.status === 'todo' && !t.assign) && ctx.snapshot) routeProject(p, await ctx.snapshot(), { onlyUnassigned: true });
  const started = [];
  for (const t of p.tasks.filter((x) => ready(p, x) && (!only || x.id === only))) {
    t.status = 'starting';
    t.startingAt = Date.now();
    await saveProject(p);
    const workdir = t.assign.node === p.repo.node && p.repo.path ? p.repo.path : `~/rigs-work/${p.slug}`;
    try {
      const r = await ctx.call(t.assign.node, 'work/start', { method: 'POST', body: { project: { id: p.id, slug: p.slug, name: p.name, gitUrl: p.gitUrl }, task: t, prompt: taskPrompt(p, t), workdir, mode: p.dispatch, policy: p.policy }, timeout: 10 * 60 * 1000 });
      t.run = { ...r, startedAt: Date.now() };
      t.status = 'running';
      t.summary = '';
      t.watch = null;
      started.push(t.id);
      event(p, `${t.id} started on ${t.assign.node} via ${r.mode === 'openrig' ? `OpenRig seat ${r.seat}` : `${r.session.kind} ${r.session.id}`}${t.attempts ? ` (attempt ${t.attempts + 1})` : ''}`);
    } catch (e) {
      const r = retryOrFail(p, t, `dispatch to ${t.assign.node} failed: ${e.message}`);
      if (r === 'retry' && !t.assign?.locked) t.assign = null; // let routing pick another machine
      event(p, `${t.id} dispatch failed on ${t.assign?.node || 'its machine'}: ${e.message}`);
    }
    await saveProject(p);
  }
  if (started.length) ctx.notify?.(`${p.name}: started ${started.length} task${started.length > 1 ? 's' : ''} (${started.map((x) => p.tasks.find((t) => t.id === x).assign.node).join(', ')}).`);
  if (!only) await settle(p, ctx);
  return p;
}

/**
 * A task that failed (or ended silently) gets one fresh attempt with the failure in its brief; after that it is
 * failed for good and the project escalates to Sir. Returns 'retry' or 'failed'.
 */
export function retryOrFail(p, t, why) {
  t.attempts = (t.attempts || 0) + 1;
  t.lastFailure = truncate(String(why || ''), 1500);
  t.run = null;
  t.watch = null;
  if (t.attempts < MAX_ATTEMPTS) {
    t.status = 'todo';
    event(p, `${t.id} will be retried (attempt ${t.attempts + 1}): ${truncate(why, 160)}`);
    return 'retry';
  }
  t.status = 'failed';
  t.summary = truncate(String(why || ''), 4000);
  return 'failed';
}

/** What Sir hears when a project is finished: one spoken line, the evidence written below it. */
export function finalReport(p, { merged = '' } = {}) {
  const n = p.tasks.length;
  const spoken = `${p.name} is done: ${n} task${n === 1 ? '' : 's'} finished${merged ? ', merged and rolled out to every machine' : ''}.`;
  const lines = p.tasks.map((t) => `- **${t.title}** (${t.assign?.node || '?'}, ${t.assign?.provider || '?'}): ${truncate(t.summary || 'done', 400)}`);
  return `${spoken}\n---\n${merged ? `Merged as ${merged}.\n\n` : ''}${lines.join('\n')}`;
}

/** After any change: finish, hand a RIGS change to the merge steward, or escalate a project nothing can move. */
async function settle(p, ctx) {
  if (p.main) return; // the standing project never finishes; each task reports on its own
  if (p.tasks.length && p.tasks.every((x) => x.status === 'done')) {
    if (['done', 'merging'].includes(p.status)) return;
    if (p.selfDev && ctx?.propose) {
      try {
        const r = await ctx.propose(p);
        p.selfDev = { ...p.selfDev, request: r.id, steward: r.steward, proposedAt: Date.now() };
        p.status = 'merging';
        event(p, `all tasks done — proposed ${p.selfDev.branch} to the merge steward on ${r.steward}`);
        ctx.notify?.(`${p.name}: all tasks done and verified — handed to the merge steward for tests, merge and rollout.`);
      } catch (e) {
        p.status = 'blocked';
        event(p, 'propose failed: ' + e.message);
        ctx.notify?.(`${p.name}: the work is done but proposing it failed — ${truncate(e.message, 160)}.`, 'error');
      }
    } else {
      p.status = 'done';
      event(p, 'all tasks done');
      ctx?.notify?.(finalReport(p));
    }
    await saveProject(p);
    return;
  }
  const moving = p.tasks.some((x) => ['running', 'starting'].includes(x.status) || ready(p, x));
  const stuck = p.tasks.filter((x) => ['failed', 'blocked'].includes(x.status));
  if (!moving && stuck.length && p.status === 'running') {
    p.status = 'blocked';
    event(p, `blocked on ${stuck.map((x) => x.id).join(', ')}`);
    ctx?.notify?.(`${p.name} needs you: ${stuck.map((x) => `“${x.title}” ${x.status}${x.summary ? ' — ' + truncate(x.summary, 120) : ''}`).join('; ')}.`, 'error');
    await saveProject(p);
  }
}

export async function updateTask(id, taskId, { status, summary, assign }, ctx) {
  const p = await getProject(id);
  if (!p) throw new Error('project not found');
  const t = p.tasks.find((x) => x.id === taskId);
  if (!t) throw new Error('task not found');
  if (assign) { t.assign = { ...t.assign, ...assign, locked: true }; t.reason = 'set by hand'; }
  if (status) {
    event(p, `${t.id} → ${status}${summary ? ': ' + truncate(summary, 160) : ''}`);
    if (status === 'failed' && ctx && retryOrFail(p, t, summary || 'the agent reported failure') === 'retry') {
      ctx.notify?.(`${p.name}: “${t.title}” failed — trying once more with what went wrong.`);
    } else {
      t.status = status;
      if (summary !== undefined) t.summary = truncate(summary, 4000);
      if (status === 'todo') { t.run = null; t.attempts = 0; }
      if (status === 'done') ctx?.notify?.(`${p.name}: task “${t.title}” finished on ${t.assign?.node}.`);
      if (status === 'blocked' || status === 'failed') ctx?.notify?.(`${p.name}: task “${t.title}” is ${status}${summary ? ' — ' + truncate(summary, 140) : ''}.`, 'error');
    }
    // Sir (or an agent) moving a task again un-blocks the project.
    if (p.status === 'blocked' && ['todo', 'running', 'done'].includes(t.status)) p.status = 'running';
  }
  await saveProject(p);
  if (p.status === 'running' && ctx) return dispatchReady(id, ctx);
  if (ctx) await settle(p, ctx);
  return p;
}

const nudgeText = (p, t, idleMin) => `RIGS watchdog: you have been idle for ${idleMin} min on task ${t.id} of project ${p.id} without reporting. If a background job is running, wait for it and carry on. If the task is done, verify it against its acceptance criteria and call project_task_update (owner "${p.owner}", project "${p.id}", task "${t.id}", status "done", with the evidence). If you cannot finish, call it with status "failed" or "blocked" and say exactly why.`;

/** One running task: finished? ended silently? idle without reporting (nudge, then escalate)? Returns true if changed. */
export async function watchTask(p, t, st, ctx, now = Date.now()) {
  if (st.state === 'done') {
    t.status = 'done'; t.summary ||= `queue item closed (${st.closure || 'done'})`; event(p, `${t.id} → done (OpenRig queue)`);
    return true;
  }
  if (st.state === 'ended') {
    const r = retryOrFail(p, t, 'the agent session ended without reporting (no project_task_update)');
    event(p, `${t.id} session ended without a report${r === 'retry' ? ' — retrying' : ''}`);
    if (r === 'failed') ctx.notify?.(`${p.name}: “${t.title}” ended twice without finishing.`, 'error');
    return true;
  }
  if (st.needsInput) return false; // a permission/question wait — the attention feed already asks Sir
  const w = t.watch || (t.watch = { fp: '', idleSince: 0, nudges: 0, nudgedAt: 0 });
  const idle = st.idle === true || (st.fingerprint && st.fingerprint === w.fp);
  let changed = false;
  if (st.fingerprint) w.fp = st.fingerprint;
  if (!idle) { if (w.idleSince) { w.idleSince = 0; w.nudges = 0; changed = true; } return changed; }
  if (!w.idleSince) { w.idleSince = now; return true; }
  if (now - w.idleSince < STALL_MS || now - w.nudgedAt < STALL_MS) return false;
  if (w.nudges >= MAX_NUDGES) {
    t.status = 'blocked';
    t.summary = `stalled: idle ${Math.round((now - w.idleSince) / 60000)} min without a report after ${w.nudges} nudges — check its session`;
    event(p, `${t.id} → blocked (stalled)`);
    ctx.notify?.(`${p.name}: “${t.title}” has stalled on ${t.assign?.node} and does not respond to nudges.`, 'error');
    return true;
  }
  try {
    await ctx.call(t.assign.node, 'work/nudge', { method: 'POST', body: { ...t.run, text: nudgeText(p, t, Math.round((now - w.idleSince) / 60000)) }, timeout: 30000 });
    w.nudges++;
    w.nudgedAt = now;
    event(p, `${t.id} idle without a report — nudged (${w.nudges}/${MAX_NUDGES})`);
  } catch (e) { log(`project ${p.id} ${t.id}: nudge failed: ${e.message}`); w.nudgedAt = now; }
  return true;
}

/**
 * Background loop on the owner node: notice finished seats/sessions, retry what ended silently, nudge idle agents,
 * recover stuck planning/dispatch, follow RIGS changes through the merge steward, and start what became ready.
 */
export async function tick(ctx, now = Date.now()) {
  for (const s of await listProjects()) {
    if (!['running', 'planning', 'merging'].includes(s.status)) continue;
    const p = await getProject(s.id);
    let changed = false;
    if (p.status === 'planning' && now - p.updatedAt > PLANNING_MS) {
      // The planner's brain call died with the daemon (restart, update): plan again once if Sir asked for it to run.
      const again = p.autoRun && !p.replanned;
      p.status = 'draft';
      p.replanned = true;
      event(p, `planning never finished${again ? ' — planning again' : ''}`);
      await saveProject(p);
      if (again) planProject(p.id, ctx).then(() => dispatchReady(p.id, ctx)).catch((e) => ctx.notify?.(`Couldn't plan ${p.name}: ${e.message}`, 'error'));
      continue;
    }
    if (p.status === 'merging') { await followMerge(p, ctx, now); continue; }
    for (const t of p.tasks) {
      if (t.status === 'starting' && now - (t.startingAt || p.updatedAt) > STARTING_MS) { t.status = 'todo'; event(p, `${t.id} never started — trying again`); changed = true; }
    }
    for (const t of p.tasks.filter((x) => x.status === 'running' && x.run)) {
      try {
        const st = await ctx.call(t.assign.node, 'work/status', { method: 'POST', body: t.run, timeout: 20000 });
        if (await watchTask(p, t, st, ctx, now)) changed = true;
      } catch (e) { log(`project ${p.id} ${t.id}: status check failed: ${e.message}`); }
    }
    if (changed) await saveProject(p);
    if (changed || p.tasks.some((x) => ready(p, x) || (x.status === 'todo' && !x.assign))) await dispatchReady(p.id, ctx).catch((e) => log(`project ${p.id}: dispatch: ${e.message}`));
    else await settle(p, ctx); // e.g. a task went blocked before this tick existed: nothing can move → escalate once
  }
}

/** A finished RIGS change waits for the merge steward: merged → report; checks failed → a fix task, then propose again. */
async function followMerge(p, ctx, now) {
  const sd = p.selfDev || {};
  let req;
  try { req = (await ctx.call(sd.steward, 'merge', { timeout: 20000 })).queue?.find((r) => r.id === sd.request); } catch (e) { log(`project ${p.id}: merge status: ${e.message}`); return; }
  if (!req) return;
  if (req.status === 'merged') {
    p.status = 'done';
    event(p, `merged to main as ${req.sha} and rolled out`);
    await saveProject(p);
    ctx.notify?.(finalReport(p, { merged: req.sha || 'main' }));
  } else if (req.status === 'checks-failed' && !(sd.fixes >= MAX_ATTEMPTS)) {
    p.selfDev = { ...sd, request: null, fixes: (sd.fixes || 0) + 1 };
    const [t] = normalizeTasks({ tasks: [{ id: `fix${p.selfDev.fixes}`, title: `Fix the failing ${req.failedStage || 'checks'} after merging onto main`, kind: 'code', size: 'M',
      description: `The merge steward merged ${sd.branch} onto the latest main and ${req.failedStage || 'the checks'} failed:\n${truncate(req.output || '', 3000)}\n\nRebase or merge origin/main into the worktree, fix the failure, run npm test (and npm run build if ui/ changed), commit.`,
      acceptance: ['npm test passes on the branch merged with the latest origin/main'], verify: 'git merge origin/main && npm test && npm run build' }] });
    t.assign = { ...(p.tasks.find((x) => x.kind === 'code')?.assign || { provider: 'claude', model: '', effort: '' }), node: p.repo.node, locked: true };
    p.tasks.push(t);
    p.status = 'running';
    event(p, `merge checks failed (${req.failedStage}) — added ${t.id} to fix them`);
    await saveProject(p);
    await dispatchReady(p.id, ctx);
  } else if (['checks-failed', 'dropped'].includes(req.status) || (req.status === 'conflict' && now - (sd.proposedAt || now) > 6 * 3600000)) {
    p.status = 'blocked';
    event(p, `merge ${req.status}`);
    await saveProject(p);
    ctx.notify?.(`${p.name}: the merge ${req.status === 'conflict' ? 'is stuck on a conflict' : req.status === 'dropped' ? 'was dropped' : 'checks keep failing'} — it needs you.`, 'error');
  }
}

export async function stopProject(id, ctx) {
  const p = await getProject(id);
  if (!p) throw new Error('project not found');
  for (const t of p.tasks.filter((x) => (x.status === 'running' || x.status === 'review') && x.run)) {
    await ctx.call(t.assign.node, 'work/stop', { method: 'POST', body: t.run, timeout: 120000 }).catch(() => {});
    if (t.status === 'running') t.status = 'todo';
  }
  p.status = 'planned';
  event(p, 'stopped');
  return saveProject(p);
}

// ------------------------------------------------------------------ intake: every instruction lands in a project

/** JARVIS's own standing project: the mesh, the JARVIS interface and whatever Sir asks for on the go. */
export const MAIN_ID = 'rigs';

export async function ensureMain() {
  const have = await getProject(MAIN_ID);
  if (have) return have;
  const p = {
    id: MAIN_ID, slug: 'rigs', name: 'RIGS · JARVIS', main: true,
    goal: 'Run and evolve RIGS OS and JARVIS — the mesh, the JARVIS interface, App Cloud apps — and whatever Sir asks for on the go that belongs to no other project. Changes to RIGS itself go through rigs_dev_start → npm test → rigs_propose.',
    owner: config().name, repo: { node: config().name, path: '' }, gitUrl: '',
    dispatch: config().routing.dispatch || 'auto', policy: config().agents?.rigPolicy || 'builtin:auto',
    planner: coreBrain(), status: 'running', tasks: [], log: [], createdAt: Date.now(), updatedAt: Date.now(),
  };
  event(p, 'main project created');
  return saveProject(p);
}

/** Append one task to a project (routed, not started). `spec` = { title, description, kind, size, deps, needs, assign }. */
export async function addTask(id, spec, snapshot) {
  const p = await getProject(id);
  if (!p) throw new Error('project not found');
  let tid = spec.id && /^[\w-]{1,12}$/.test(spec.id) && !p.tasks.some((t) => t.id === spec.id) ? spec.id : '';
  for (let n = p.tasks.length + 1; !tid; n++) if (!p.tasks.some((t) => t.id === `t${n}`)) tid = `t${n}`;
  const [t] = normalizeTasks({ tasks: [{ ...spec, id: tid }] });
  t.deps = (spec.deps || []).filter((d) => p.tasks.some((x) => x.id === d));
  if (spec.assign) { t.assign = { ...spec.assign, locked: true }; t.reason = 'set by hand'; }
  p.tasks.push(t);
  if (!spec.assign) routeProject(p, snapshot, { onlyUnassigned: true });
  if (p.status === 'draft') p.status = 'planned';
  event(p, `${t.id} added: ${t.title}`);
  await saveProject(p);
  return { project: p, task: t };
}

/**
 * Sir gave an instruction that needs real work: file it under a project — the given one, the main
 * RIGS · JARVIS project, or a new one — and cast an agent for it right away (OpenRig seat when the
 * machine has OpenRig, else a direct agent session). Runs on the node that owns the project.
 * body = { project?, newProject?: { name, goal, repoNode, repoPath, gitUrl }, title, instruction, kind?, size?, needs? }
 */
export async function intake(body, ctx) {
  if (!String(body.instruction || body.title || '').trim()) throw new Error('nothing to do: give the instruction');
  let p;
  if (body.newProject?.goal || body.newProject?.name) {
    const np = body.newProject;
    p = await createProject({ name: np.name, goal: np.goal || np.name, repoNode: np.repoNode, repoPath: np.repoPath, gitUrl: np.gitUrl });
    p.status = 'running';
    event(p, 'created by JARVIS from an instruction');
    await saveProject(p);
  } else if (!body.project || body.project === MAIN_ID) p = await ensureMain();
  else p = await getProject(body.project);
  if (!p) throw new Error(`project ${body.project} not found`);
  const title = truncate(String(body.title || body.instruction).replace(/\s+/g, ' '), 100);
  const { task } = await addTask(p.id, {
    title, description: String(body.instruction || title), kind: body.kind, size: body.size, needs: body.needs, deps: body.deps,
  }, await ctx.snapshot());
  if (!task.assign) return { project: brief(p), task, started: false, why: task.reason };
  // The main project and projects already running stay "running" (the planner tick tracks them); a project
  // Sir only planned keeps its other tasks waiting — just this one starts.
  const cur = await getProject(p.id);
  if (cur.main || cur.status === 'running' || cur.status === 'done') await saveProject(Object.assign(cur, { status: 'running' }));
  const after = await dispatchReady(p.id, ctx, { only: task.id });
  const t = after.tasks.find((x) => x.id === task.id);
  return { project: brief(after), task: { id: t.id, title: t.title, kind: t.kind, status: t.status, assign: t.assign, reason: t.reason, run: t.run, summary: t.summary }, started: t.status === 'running' };
}

function brief(p) { return { id: p.id, name: p.name, owner: p.owner, main: !!p.main }; }
