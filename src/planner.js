import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as autonomy from './autonomy.js';
import * as chat from './chat.js';
import { config, RIGS_HOME } from './config.js';
import { dashboardsFor, knownApps, openDashboards } from './dashboards.js';
import { FILES_RULE, cacheCopies, filesBrief, mergeFiles } from './file-cache.js';
import { PROVIDERS, claudeFlags, coreBrain } from './models.js';
import { briefSection, matchTools, planNote, projectAdhocNote, ADHOC_RULE } from './toolbox.js';
import { bin } from './tools.js';
import * as trace from './trace.js';
import * as usage from './usage.js';
import { parseContext } from './trace.js';
import { HOME, augmentedPath, log, readJson, run, truncate, writeJsonAtomic } from './util.js';
import { slug } from './work.js';

/**
 * Projects: a goal → tasks (planned by the core brain) → each task routed to a machine +
 * provider + model + effort (deterministic, explained, editable) → dispatched through OpenRig
 * seats/queues or direct agent sessions → tracked until done. Lives on the node that owns it.
 */

const DIR = path.join(RIGS_HOME, 'projects');
export const KINDS = ['plan', 'architecture', 'code', 'test', 'review', 'merge', 'research', 'docs', 'text', 'reverse-engineer', 'media', '3d', 'private'];
// Fallback order when the policy's provider isn't available. Ollama is opt-in only (kind "private" or a rule/hand pick).
const PROVIDER_ORDER = ['claude', 'codex'];

export async function listProjects() {
  await fsp.mkdir(DIR, { recursive: true });
  const files = (await fsp.readdir(DIR)).filter((f) => f.endsWith('.json'));
  const all = (await Promise.all(files.map((f) => readJson(path.join(DIR, f))))).filter(Boolean);
  return all.map((p) => ({
    id: p.id, name: p.name, goal: truncate(p.goal, 200), status: p.status, owner: p.owner, updatedAt: p.updatedAt,
    main: !!p.main,
    tasks: p.tasks.map((t) => ({ id: t.id, title: t.title, kind: t.kind, status: t.status, stalled: !!t.stalled, assign: t.assign, run: t.run ? { mode: t.run.mode, seat: t.run.seat || '', rig: t.run.rig || '', session: t.run.session || null, startedAt: t.run.startedAt } : null })),
  })).sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function getProject(id) {
  if (!/^[\w-]+$/.test(id)) return null;
  return readJson(path.join(DIR, id + '.json'));
}

export async function saveProject(p) {
  p.updatedAt = Date.now();
  await writeJsonAtomic(path.join(DIR, p.id + '.json'), p);
  for (const fn of savedSinks) try { fn(p); } catch (e) { log('project saved listener: ' + e.message); }
  return p;
}

// Listeners told after each project save (the exhibit service); they must return at once and never throw.
const savedSinks = new Set();
export function onProjectSaved(fn) { savedSinks.add(fn); return () => savedSinks.delete(fn); }

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

// ------------------------------------------------------------------ request traces (src/trace.js)

/** The request trace a task's work belongs to — the task's own, else its project's — as { traceId, parentId }, or null. */
const traceOf = (p, t) => parseContext(t?.trace || p?.trace);

/** Where each task went and why: the routing decisions a plan span records. */
const routingOf = (p) => p.tasks.map((t) => ({ task: t.id, title: t.title, kind: t.kind, size: t.size, deps: t.deps, node: t.assign?.node || '', provider: t.assign?.provider || '', model: t.assign?.model || '', effort: t.assign?.effort || '', why: t.reason || '' }));

/**
 * Something that happened to a task (a retry, a step up the model ladder, an automatic answer…) as an "event" span of
 * its request trace: under the run it happened to (`run`, a run.traceRun) or else under the task's handoff.
 */
function traceEvent(p, t, name, { run = t.run?.traceRun, input, output, status = 'ok', meta = {} } = {}) {
  const c = traceOf(p, t);
  if (!c) return;
  const parentId = run?.traceId === c.traceId && run.spanId ? run.spanId : c.parentId;
  trace.recordSpan({ traceId: c.traceId, parentId, kind: 'event', name, input, output, status, meta: { projectId: p.id, taskId: t.id, ...meta } });
}

/** A planning step that made no brain call (a playbook, a workspace flow): its plan span, written whole. */
function tracePlan(p, via, input) {
  const c = parseContext(p.trace);
  if (c) trace.recordSpan({ ...c, kind: 'plan', name: `plan ${p.name}`, input, output: { summary: p.summary || '', tasks: p.tasks.map((t) => ({ id: t.id, title: t.title, kind: t.kind, size: t.size, deps: t.deps })) }, meta: { via, routing: routingOf(p) } });
}

// ------------------------------------------------------------------ planning (core brain)

function meshBrief(snapshot) {
  return snapshot.filter((e) => e.node.online && e.node.rigs).map((e) => {
    const n = e.node;
    const providers = (e.brains || []).filter((b) => b.available !== false).map((b) => (b.id === 'ollama' ? `ollama[${b.models.slice(0, 6).join(', ')}]` : b.id)).join(', ') || 'none';
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

export function planningPrompt(p, snapshot, guide = '', tools = []) {
  const rules = config().routing.rules.map((r) => `${r.kind}${r.size ? '/' + r.size : ''}${r.tool ? ' [needs ' + r.tool + ']' : ''} → ${r.provider} ${r.model || '(default)'} effort=${r.effort || 'default'}`).join('; ');
  return `You are the planning brain of RIGS, a mesh of the user's workstations with coding agents on each.
Break this project into concrete, independently executable tasks for coding agents.

PROJECT: ${p.name}
GOAL: ${p.goal}${p.request && p.request !== p.goal ? `\nTHE USER'S WHOLE REQUEST (other parts go to other projects): ${p.request}` : ''}
REPOSITORY: ${p.repo.path ? `${p.repo.path} on machine ${p.repo.node}` : 'none given'}${p.gitUrl ? ` (git: ${p.gitUrl})` : ''}
${p.workspace ? `\nWORKSPACE:\n${workspaceBrief(p)}\n` : ''}${guide ? `\nTHE PROJECT'S OWN AGENT GUIDE (authoritative for how work is done in this folder — roles, which model does what, how to verify, what not to touch; shape the tasks and suggested providers/models to it):\n<<<\n${guide}\n>>>\n` : ''}
MACHINES:
${meshBrief(snapshot)}

ROUTING POLICY (task kind → provider/model/effort; machines are chosen by RIGS afterwards): ${rules}${avoided().length ? `\nSWITCHED OFF FOR NOW (never suggest them): ${avoided().join(', ')}` : ''}

Rules:
- Use the FEWEST tasks that get the goal done well: every extra task costs a whole agent session (minutes and tokens).
  1 to 12 tasks. Each must be doable by one agent in one session and have a verifiable outcome.
- A small or well-scoped change (one feature, style, setting, fix or doc in a known area) is ONE task that implements,
  tests and screenshots its own work; RIGS adds the final review. Split only when parts need different machines, tools
  or skills, can truly run in parallel, or are too large for one session. Never a separate audit/test task for small work.
- Every task has "acceptance": 1-5 concrete, checkable criteria (what must be true when it is done), and "verify": how the agent
  proves it (exact test/build commands, a run, or evidence such as a screenshot path). UI work verifies with screenshots,
  including a phone-sized viewport (e.g. 390x844) when layout or mobile use is involved.
- Larger work: measure/audit → change → test → review. The LAST task is always kind "review": an independent check of the
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
${planNote(matchTools(tools, `${p.goal} ${p.request || ''}`, { limit: 5 }))}
- kind is one of: ${KINDS.join(', ')}. Use "review" for an independent check of another task's output (list it in deps).
  Use "reverse-engineer" when existing software/binaries must be understood (agents have REA for that).
  Use "text" for simple writing/transformation, "docs" for documentation, "media" for image/video/audio generation
  (set needs.tool to the tool that does it, e.g. "comfyui"), "3d" for a 3D object or scene built headless in Blender
  (needs.tool "blender"; the agent runs the \`blender-glb\` tool and saves a .glb under the shared folder's files/3d),
  and "private" ONLY when the user asked for local-only models.
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

/** What a small, single task is told instead of getting its own review task (D3). */
export const SELF_VERIFY = 'Verify every acceptance criterion yourself before reporting done; put the evidence in the summary.';

/**
 * Every plan ends in an independent review of the whole result. If the planner left it out (or its last review
 * doesn't wait for everything), add one that depends on every task nothing else depends on.
 * Exception: a plan of exactly one S or M task verifies itself (the brief says so) — a separate review would double
 * a small job. `reviewSmall` (config autonomy.reviewSmall, a per-project `autonomy` override) restores the review.
 */
export function ensureFinalReview(tasks, goal = '', { reviewSmall = autonomy.settings().reviewSmall } = {}) {
  if (!tasks.length) return tasks;
  const dependedOn = new Set(tasks.flatMap((t) => t.deps));
  const leaves = tasks.filter((t) => !dependedOn.has(t.id));
  if (leaves.length === 1 && leaves[0].kind === 'review') return tasks;
  if (tasks.length === 1 && ['S', 'M'].includes(tasks[0].size) && tasks[0].kind !== 'review' && !reviewSmall) {
    const t = tasks[0];
    if (!String(t.description || '').includes(SELF_VERIFY)) t.description = `${String(t.description || '').replace(/\s+$/, '')}\n\n${SELF_VERIFY}`;
    if (!(t.acceptance || []).includes(SELF_VERIFY)) t.acceptance = [...(t.acceptance || []), SELF_VERIFY];
    t.selfVerify = true;
    return tasks;
  }
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

/**
 * Playbooks (docs/playbooks/*.md): saved, proven methods for recurring RIGS changes. Front matter `match` (a regex
 * on the goal), `title`, `size`. A RIGS change that matches one skips LLM planning: one agent follows the playbook,
 * the final review checks it. Write one whenever a kind of request repeats.
 */
export const PLAYBOOK_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'docs', 'playbooks');

export function parsePlaybook(text, file = '') {
  const m = String(text).match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) return null;
  const meta = Object.fromEntries(m[1].split(/\r?\n/).map((l) => l.match(/^(\w+):\s*(.*)$/)).filter(Boolean).map((x) => [x[1], x[2].trim()]));
  if (!meta.match) return null;
  let re;
  try { re = new RegExp(meta.match, 'i'); } catch { return null; }
  return { file, title: meta.title || path.basename(file, '.md'), size: ['S', 'M', 'L'].includes(meta.size) ? meta.size : 'M', re, body: m[2].trim() };
}

export async function findPlaybook(goal, dir = PLAYBOOK_DIR) {
  let files = [];
  try { files = (await fsp.readdir(dir)).filter((f) => f.endsWith('.md')).sort(); } catch { return null; }
  for (const f of files) {
    const pb = parsePlaybook(await fsp.readFile(path.join(dir, f), 'utf8').catch(() => ''), f);
    if (pb && pb.re.test(goal)) return pb;
  }
  return null;
}

export function playbookTasks(p, pb) {
  // A playbook is a saved method whose final review is part of the method: it keeps its review whatever the size.
  return ensureFinalReview(normalizeTasks({ tasks: [{
    id: 't1', title: truncate(`${pb.title}: ${p.goal}`, 120), kind: 'code', size: pb.size,
    description: `Sir asked: "${p.request || p.goal}". Do it end to end in one go by following the saved playbook (docs/playbooks/${pb.file}) below: implement, build, test, screenshot, commit. If the playbook is wrong or out of date, fix it in the same commit.\n\n${pb.body}`,
    acceptance: ['the request is implemented as the playbook describes', '`npm run build` and `npm test` pass', 'a screenshot or run output proves it for anything visible'],
    verify: 'npm run build && npm test, plus the playbook\'s own checks',
  }] }), p.goal, { reviewSmall: true });
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

// The bounded planning call (D2): one `claude -p` with the planning prompt only — no persona, no tool schemas, no MCP
// servers, one turn — on the `plan` routing rule's model. Five minutes is generous for a JSON plan.
export const PLAN_CALL_MS = 5 * 60 * 1000;

/** The model/effort the planning call runs with: the `plan` routing rule, else the planner brain's own. */
export function planBrain(b = coreBrain()) {
  const rule = (config().routing?.rules || []).find((r) => r.kind === 'plan' && (!r.provider || r.provider === 'claude'));
  return { provider: 'claude', model: rule?.model || b.model || '', effort: rule?.effort || b.effort || '' };
}

/**
 * Spawn the bounded planning call. Resolves to { text, usage } or { error, usage }; never throws for a model answer,
 * throws when claude itself is missing or the process fails so the caller can fall back to the agentic turn.
 */
export async function boundedPlanCall(prompt, { model, effort } = {}) {
  const claude = bin('claude');
  if (!claude) throw new Error('claude is not installed on this machine');
  const env = { ...process.env, PATH: augmentedPath() };
  for (const k of Object.keys(env)) if (k.startsWith('CLAUDECODE') || k === 'CLAUDE_CODE_ENTRYPOINT') delete env[k];
  const args = ['-p', '--output-format', 'json', '--tools', '', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--no-session-persistence', '--max-turns', '1', ...claudeFlags({ model, effort })];
  const r = await run(claude, args, { input: prompt, cwd: HOME, env, timeout: PLAN_CALL_MS });
  let e = null;
  try { e = JSON.parse(r.stdout.trim().split('\n').filter(Boolean).at(-1)); } catch {}
  if (e?.type !== 'result') throw new Error(truncate(r.stderr.trim() || r.stdout.trim(), 300) || `claude exited with ${r.code}`);
  let u = null;
  try { u = usage.claudeResultUsage(e); delete u.cumulative; } catch {}
  if (e.is_error) return { error: truncate(e.result || (Array.isArray(e.errors) && e.errors.join('; ')) || 'Claude Code returned an error', 300), usage: u };
  return { text: String(e.result || '').trim(), usage: u };
}

/**
 * Ask the planner brain for tasks. Runs on the owner node. A Claude planner gets the bounded call (ctx.planCall, or
 * boundedPlanCall) and falls back to the agentic ctx.ask turn when that fails or returns no plan; Codex/Ollama
 * planners keep the agentic turn. The three lookups before the call (mesh snapshot, the folder's guide, the tool
 * catalog) run in parallel.
 */
export async function planProject(id, ctx, { brain } = {}) {
  const p = await getProject(id);
  if (!p) throw new Error('project not found');
  const b = brain?.provider ? brain : p.planner || coreBrain();
  p.planner = b;
  const [snapshot, guide, tools] = await Promise.all([ctx.snapshot(), readGuide(p, ctx), ctx.tools ? ctx.tools().catch(() => []) : []]);
  const pb = p.selfDev && !brain?.provider ? await findPlaybook(`${p.goal} ${p.request || ''}`) : null;
  if (pb) {
    p.tasks = playbookTasks(p, pb);
    p.summary = `Follows the ${pb.title} playbook`;
    routeProject(p, snapshot);
    p.status = 'planned';
    event(p, `follows playbook ${pb.file}: ${p.tasks.length} tasks, no planning call`);
    tracePlan(p, 'playbook', { goal: p.goal, playbook: pb.file });
    return saveProject(p);
  }
  const prompt = planningPrompt(p, snapshot, guide, tools);
  const planHints = matchTools(tools, `${p.goal} ${p.request || ''}`, { limit: 5 });
  if (planHints.length) usage.recordToolEvent({ event: 'hint', toolIds: planHints.map((x) => x.id), query: p.goal, trace: parseContext(p.trace)?.traceId });
  // The bounded call applies to a Claude planner (coreBrain's provider 'auto' resolves to Claude for this call). It is
  // injectable (ctx.planCall; null = never); a scratch node (RIGS_NO_OPENRIG=1: tests, a second instance) or the node
  // test runner (NODE_TEST_CONTEXT) never spawns the real brain on its own and keeps the agentic ctx.ask path.
  const scratch = process.env.RIGS_NO_OPENRIG === '1' || !!process.env.NODE_TEST_CONTEXT;
  const planCall = ctx.planCall !== undefined ? ctx.planCall : scratch ? null : boundedPlanCall;
  const bounded = ['claude', 'auto', ''].includes(b.provider || '') && typeof planCall === 'function';
  const pbrain = bounded ? planBrain(b) : null;
  p.status = 'planning';
  event(p, bounded ? `planning with claude ${pbrain.model} ${pbrain.effort ? '(' + pbrain.effort + ')' : ''} on ${p.owner} (bounded call)`.replace(/\s+/g, ' ')
    : `planning with ${b.provider} ${b.model || ''} ${b.effort ? '(' + b.effort + ')' : ''} on ${b.node || p.owner}`.replace(/\s+/g, ' '));
  await saveProject(p);
  // The planning call is a span of Sir's request; the brain turn it makes (on any machine) is its child.
  const tc = parseContext(p.trace);
  const ps = tc ? trace.startSpan({ ...tc, kind: 'plan', name: `plan ${p.name}`, input: { goal: p.goal, prompt }, meta: { provider: bounded ? 'claude' : b.provider, model: (pbrain || b).model || '', effort: (pbrain || b).effort || '', node: bounded ? p.owner : b.node || p.owner, via: bounded ? 'bounded' : 'brain' } }) : null;
  let out = null;
  let via = 'brain';
  if (bounded) {
    const startedAt = Date.now();
    try {
      out = await planCall(prompt, pbrain);
      // The ledger record ctx.ask made through the chat turn (kind 'plan'); the bounded call files it here.
      usage.recordChatTurn({ chat: null, tag: { kind: 'plan', projectId: p.id, projectName: p.name }, brain: 'claude', model: pbrain.model, effort: pbrain.effort, startedAt, out, aborted: false, lane: 'plan' });
      if (out.error && !out.text) throw new Error(out.error);
      try { extractJson(out.text); via = 'bounded'; } catch (e) { throw new Error(`no plan in the answer (${e.message})`); }
    } catch (e) {
      event(p, `bounded planning call failed (${truncate(e.message, 160)}) — fell back to agentic turn`);
      log(`project ${p.id}: bounded planning call failed: ${e.message}`);
      out = null;
    }
  }
  if (!out) {
    try {
      out = await ctx.ask(b.node || 'self', prompt, { brain: b.provider, model: b.model, effort: b.effort, title: `Plan · ${p.name}`, usage: { kind: 'plan', projectId: p.id, projectName: p.name }, ...(ps ? { trace: ps.ctx } : {}) });
    } catch (e) { ps?.end({ status: 'error', output: e.message }); throw e; }
  }
  if (out.error && !out.text) { ps?.end({ status: 'error', output: out.error }); p.status = 'draft'; event(p, 'planning failed: ' + out.error); await saveProject(p); throw new Error(out.error); }
  let parsed;
  try { parsed = extractJson(out.text); } catch (e) { ps?.end({ status: 'error', output: out.text, meta: { error: e.message } }); p.status = 'draft'; event(p, 'planning failed: ' + e.message); await saveProject(p); throw new Error(`${e.message}: ${truncate(out.text, 300)}`); }
  p.tasks = ensureFinalReview(normalizeTasks(parsed), p.goal, { reviewSmall: autonomy.settings(p).reviewSmall });
  p.summary = parsed.summary || '';
  routeProject(p, snapshot);
  p.status = 'planned';
  event(p, `planned ${p.tasks.length} tasks (${via === 'bounded' ? 'planned with bounded call' : bounded ? 'fell back to agentic turn' : 'agentic turn'})`);
  ps?.end({ output: parsed, meta: { tasks: p.tasks.length, via, routing: routingOf(p) } });
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
    acceptance: ['the flow ran to its end and its deliverables exist (changes listed for Sir, build or release, notes as the flow prescribes)', 'its build and tests pass on the result'],
    verify: 'the checks the flow and the workspace guide prescribe; list commands and results',
  }] }), p.goal, { reviewSmall: autonomy.settings(p).reviewSmall });
  routeProject(p, await ctx.snapshot());
  p.status = 'planned';
  event(p, `runs the ${f.name} flow: ${p.tasks.length} tasks`);
  tracePlan(p, 'flow', { goal: p.goal, flow: f.name });
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
  // Installed but signed out (e.g. Codex without a login) can't run a task: place it elsewhere or fall back.
  return (entry.brains || []).some((b) => b.id === provider && b.signedIn !== false && (provider !== 'ollama' || b.models.length));
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
  const codeLocal = (t) => !['media', '3d', 'private'].includes(t.kind) && p.repo.path && !p.gitUrl;

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
    // A retry stepped up the model ladder: that provider/model/effort, on whichever machine can run it.
    if (t.escalate?.provider && t.kind !== 'private') providers = [t.escalate.provider];
    providers = providers.filter((x) => !avoided().includes(x));
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
    if (t.escalate?.provider === best.provider) { a.model = t.escalate.model || a.model; a.effort = t.escalate.effort || a.effort; }
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
    const how2 = t.escalate?.provider === best.provider ? `escalation after attempt ${t.attempts || 1}` : how;
    t.reason = `${t.kind}${t.size === 'L' ? ' (large)' : ''} → ${a.provider}${a.model ? ' ' + a.model : ''}${a.effort ? ' · ' + a.effort : ''} by ${how2}${hint}; ${best.node.name}: ${best.why.join(', ') || 'least loaded'}`;
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
  return `## What you may do without asking
- Pre-approved by Sir: everything non-destructive — reading, editing files in the project folder, builds, tests,
  profiling and benchmark runs, launching the app, game or editor, project-local installs. This overrides any saved
  habit of confirming such steps first: do them.
- Not pre-approved: destructive or irreversible steps — deleting or overwriting data you did not create, reverting,
  resetting, stashing or discarding changes, force-pushes and history rewrites, publishing or deploying, spending money,
  changing system settings. Reversible steps (pausing, archiving, restarting your own processes) are not destructive.
  If a destructive step is truly needed, don't do it: finish everything else, report "done" and list the skipped step
  as a follow-up for Sir.
- A declined permission prompt or a safety-classifier denial means: take another route (a different tool, a smaller
  step) — not "blocked". If you still have a question, RIGS answers it with the safe default; nobody else will.
- Helper tools: ${ADHOC_RULE}
${p.selfDev ? '- Commits: this is RIGS itself — commit in your dev worktree; RIGS proposes the branch to the merge steward, which tests and pushes it.'
    : '- Commits: Sir approves commits on this project. Do not commit, push, merge, rebase or switch branches in its repositories — leave your changes in the working tree and list every file you changed plus a suggested commit message in your summary.'}
`;
}

/** The brief's pointer to Sir's request trace (src/trace.js), or nothing for untraced work. */
export function traceLine(c) {
  const ctx = parseContext(c);
  return ctx ? `- Request trace: \`${ctx.traceId}\`${ctx.parentId ? ` (parent span \`${ctx.parentId}\`)` : ''} — what is done for this task is recorded under Sir's original request; pass it on as \`trace\` when you file follow-up work.\n` : '';
}

/** The tool registry entries a task's brief should name: matched on its title and description (a 3d task also on Blender/glb). */
export function toolHints(tools, t) { return matchTools(tools, `${t.title} ${t.description || ''}${t.kind === '3d' || t.needs?.tool === 'blender' ? ' blender glb mesh model' : ''}`); }

export function taskPrompt(p, t, tools = []) {
  const done = t.deps.map((d) => p.tasks.find((x) => x.id === d)).filter(Boolean);
  const others = p.tasks.filter((x) => x.id !== t.id && x.status === 'running').map((x) => `- ${x.id} ${x.title} (${x.assign?.provider} on ${x.assign?.node})`);
  return `# ${t.title}

You are one agent in a RIGS project run across the user's machines.

- Project: **${p.name}** (id \`${p.id}\`, coordinated by machine \`${p.owner}\`)
- Project goal: ${p.goal}
- Your task id: \`${t.id}\` · kind: ${t.kind} · size: ${t.size}
- You run on \`${t.assign.node}\` as ${t.assign.provider}${t.assign.model ? ' ' + t.assign.model : ''}${t.assign.effort ? ' (effort ' + t.assign.effort + ')' : ''}
${traceLine(t.trace || p.trace)}${p.workspace ? `
## Workspace
${workspaceBrief(p)}
- Read the project's ${p.workspace.guides?.length ? p.workspace.guides.join(' / ') : 'README'} first and follow it — it overrides the generic notes below.
- The folder may hold uncommitted work by the user or other agents: never revert, stash, reset or commit changes you didn't make.
- OpenRig may add "OpenRig MANAGED BLOCK" sections to CLAUDE.md / AGENTS.md here: they are for your seat, never commit them (stage files by name, not \`git add -A\`).
` : ''}
## Task
${t.description}

${done.length ? `## Already finished (inputs for you)\n${done.map((d) => `- ${d.id} ${d.title}${d.summary ? ': ' + d.summary : ''}`).join('\n')}\n` : ''}${others.length ? `## Running in parallel elsewhere\n${others.join('\n')}\n` : ''}
${t.needs?.tool ? `## Tool for this task\nThis machine provides **${t.needs.tool}**${t.toolInfo ? ` — ${t.toolInfo}` : ''}. Use it for the actual generation/processing.\n\n` : ''}${p.flow ? `## The workspace's own flow: ${p.flow.name}\nSir asked for this project's recurring "${p.flow.name}" job (${p.flow.source} on ${p.repo.node}). Its instructions:\n<<<\n${p.flow.prompt}\n>>>\n\n` : ''}${p.selfDev ? `## This is a change to RIGS itself
- Work ONLY in the dev worktree \`${p.repo.path}\` (branch \`${p.selfDev.branch}\`) and commit there. Never touch the installed checkout (~/.rigs/app) or main.
- Do not call rigs_dev_start or rigs_propose: when every task of this project is done, RIGS proposes the branch to the merge steward, which re-runs build + tests, merges, pushes and rolls out.
- Before reporting done: \`npm test\` passes (and \`npm run build\` when ui/ changed), and your work is committed.

` : ''}${autonomyBrief(p)}
${t.acceptance?.length ? `## Acceptance criteria\n${t.acceptance.map((a) => `- [ ] ${a}`).join('\n')}\n\n` : ''}${t.verify ? `## Verify with\n${t.verify}\n\n` : ''}${t.attempts ? `## Previous attempt ${t.attempts} did not finish\n${t.lastFailure || 'It ended without a report.'}\n${(t.history || []).length > 1 ? `Earlier: ${t.history.slice(0, -1).map((h) => `attempt ${h.attempt} (${[h.model, h.effort].filter(Boolean).join(' ')}): ${truncate(h.why, 160)}`).join('; ')}\n` : ''}This is attempt ${t.attempts + 1}${t.escalate ? `, escalated to ${[t.assign.model, t.assign.effort].filter(Boolean).join(' ')}` : ''}. Pick up from what it left (check the folder and git state) instead of starting over.\n\n` : ''}${briefSection(toolHints(tools, t))}${filesBrief(p.files, { taskId: t.id })}## How to work
- Stay inside your task. If you need something from another machine, use the rigs MCP tools (mesh_*).
- A new folder this project needs (outside its repository) is created in the shared folder, under projects/${p.slug}/ (\`@shared/projects/${p.slug}\`), never in the home folder or a temp folder, so every machine and the next task see it.
- Other output that belongs in no repository goes in the shared folder, which RIGS keeps in sync on every machine (\`rigs shared path\` prints it, default ~/RIGS-Shared): an ad-hoc app in apps/<id>/, a file made for Sir's request in files/, a report in reports/. A web app there is still published to the App Cloud (mesh_app_register); name the shared path in your summary.
${FILES_RULE}
- To understand existing software, binaries or apps, use REA (the \`rea\` MCP / \`npx -y rea-agents@latest\`).
- Nobody is watching this session: never stop to ask a question or wait for a reply. Decide sensibly, note the assumption in your summary.
- Never end your turn while waiting on a background job (a build, a test run, a capture): wait for it, read its result, carry on.

## Definition of done
1. Every acceptance criterion holds, and you checked it yourself (run the tests/build, run the thing, capture a screenshot for anything visual).
2. If a check fails, fix it and check again. Only report "failed" when you cannot make it pass — with the exact failing output.
3. Your summary says what changed, where, and the verification evidence (commands + results, screenshot paths).

## When you finish or get stuck
Call the rigs MCP tool \`project_task_update\` with
\`{"owner": "${p.owner}", "project": "${p.id}", "task": "${t.id}", "status": "done" | "blocked" | "failed", "summary": "<what you did, where the result is, the verification evidence — or what failed / what you need>", "files": [{"path": "<new file>", "reason": "<why>"}]}\`.
This report is the only way RIGS knows you finished: the next tasks start from it, and Sir hears the result.
${'If you are an OpenRig seat, also close your queue item.'}
`;
}

function ready(p, t, now = Date.now()) {
  return t.status === 'todo' && t.assign && !(t.retryAt > now) && t.deps.every((d) => p.tasks.find((x) => x.id === d)?.status === 'done');
}

// Anything that was "in flight" before this process started (planning, a dispatch) cannot still be in flight:
// it died with the old process (an update, a restart, a reboot) and is recovered right away, not after a timeout.
export const BOOT = Date.now();
// A seat that keeps dying is revived at most this often per task before the task is retried from scratch.
export const MAX_REVIVES = 3;

// Autonomy limits: a task gets one fresh retry; an idle agent is nudged every STALL_MS, then escalated.
export const MAX_ATTEMPTS = 2;
export const STALL_MS = 15 * 60 * 1000;
export const MAX_NUDGES = 3;
const STARTING_MS = 15 * 60 * 1000;
const PLANNING_MS = 20 * 60 * 1000;

/**
 * One project's state changes one at a time. Agents report (updateTask), the tick and dispatch all read-modify-write
 * the same JSON file; without this, two writers each saved their own copy and one silently undid the other (a task
 * "starting" again while its agent ran, a second agent cast for the same task).
 */
const locks = new Map();
export function withProject(id, fn) {
  const next = (locks.get(id) || Promise.resolve()).then(fn, fn);
  const tail = next.catch(() => {});
  locks.set(id, tail);
  tail.then(() => { if (locks.get(id) === tail) locks.delete(id); });
  return next;
}

/**
 * Route tasks that have no machine. A platform need that no online machine can meet next to the project's folder
 * (a "mac" test for a repo on the linux box) would strand the task in todo forever: drop that need once, say so,
 * and route again. Whatever still has no machine is timed, so settle() can tell it apart from a brief outage.
 */
export function placeUnassigned(p, snapshot, now = Date.now()) {
  routeProject(p, snapshot, { onlyUnassigned: true });
  const strand = () => p.tasks.filter((t) => t.status === 'todo' && !t.assign);
  if (autonomy.settings(p).enabled) {
    const relax = strand().filter((t) => t.needs?.platform && t.needs.platform !== 'any');
    for (const t of relax) {
      t.relaxed = `needs.platform ${t.needs.platform} dropped: no online machine had it next to the project's folder`;
      t.needs = { ...t.needs, platform: 'any' };
      event(p, `${t.id}: ${t.relaxed}`);
    }
    if (relax.length) routeProject(p, snapshot, { onlyUnassigned: true });
  }
  for (const t of p.tasks) {
    if (t.status === 'todo' && !t.assign) t.unroutableSince ||= now;
    else delete t.unroutableSince;
  }
  return p;
}

/**
 * Claim every task whose dependencies are done (`starting`, under the lock) — the earliest point a task is placed.
 * Dashboards that watch this kind of work (src/dashboards.js) are matched here, kept on the task for its brief, and
 * opened in Sir's UI. Returns { p, ts } with copies of the claimed tasks.
 */
export async function claimReady(id, ctx, { only, now = Date.now() } = {}) {
  const apps = await knownApps(ctx);
  const claim = await withProject(id, async () => {
    const p = await getProject(id);
    if (!p) throw new Error('project not found');
    if (!only && !['planned', 'running', 'blocked'].includes(p.status)) throw new Error(`project is ${p.status}`);
    if (!only) p.status = 'running';
    // Tasks that lost their machine (dispatch failed, machine offline) are placed again before starting.
    if (p.tasks.some((t) => t.status === 'todo' && !t.assign) && ctx.snapshot) placeUnassigned(p, await ctx.snapshot());
    const ts = p.tasks.filter((x) => ready(p, x, now) && (!only || x.id === only));
    for (const t of ts) {
      t.status = 'starting'; t.startingAt = Date.now(); delete t.usageFrom;
      const d = dashboardsFor(p, t, apps);
      if (d.length) t.dashboards = d; else delete t.dashboards;
    }
    await saveProject(p);
    return { p, ts: ts.map((t) => ({ ...t })) };
  });
  // Not awaited: the UI push must never hold up a start. What opened (or failed) is logged on the project afterwards.
  for (const t of claim.ts.filter((x) => x.dashboards?.length)) {
    openDashboards(claim.p, t, ctx, { trace: traceOf(claim.p, t)?.traceId }).then((rs) => withProject(id, async () => {
      const p = await getProject(id);
      if (!p) return;
      for (const r of rs) event(p, r.ok ? `opened dashboard ${r.app} for ${t.id}` : `could not open dashboard ${r.app} for ${t.id}${r.error ? `: ${r.error}` : r.skipped ? ` (${r.skipped})` : ''}`);
      await saveProject(p);
    })).catch((e) => log(`project ${id} ${t.id}: dashboards: ${e.message}`));
  }
  return claim;
}

/**
 * Start every task whose dependencies are done. Tasks are claimed ("starting") under the lock, started outside it
 * (a start can take minutes), and each result is written back onto the then-current project.
 */
export async function dispatchReady(id, ctx, { only, now = Date.now() } = {}) {
  const claim = await claimReady(id, ctx, { only, now });
  return startClaimed(id, ctx, claim, { only, now });
}

/**
 * Where a task works when the project has no folder on that machine. A git project clones into ~/rigs-work (the
 * shared folder never syncs .git); everything else gets one folder in the shared storage, synced to every machine, so
 * a project's files are in one place whichever machine runs the next task. Pure.
 */
export function defaultWorkdir(p) {
  return p.gitUrl ? `~/rigs-work/${p.slug}` : `@shared/projects/${p.slug}`;
}

/** The second half of dispatchReady: start the claimed tasks on their machines and record each result. */
export async function startClaimed(id, ctx, claim, { only, now = Date.now() } = {}) {
  // The registry's tools that fit each task go into its brief (cached catalog, empty when the mesh is slow).
  const catalog = ctx.tools ? await ctx.tools().catch(() => []) : [];
  const started = [];
  for (const t0 of claim.ts) {
    const p0 = claim.p;
    const workdir = t0.assign.node === p0.repo.node && p0.repo.path ? p0.repo.path : defaultWorkdir(p0);
    let r = null;
    let err = null;
    // The start is a "dispatch" span of the request trace; the run's own span (written by the machine that runs it)
    // hangs under it.
    const tc = traceOf(p0, t0);
    const attempt = (t0.attempts || 0) + 1;
    const hints = toolHints(catalog, t0);
    if (hints.length) usage.recordToolEvent({ event: 'hint', toolIds: hints.map((x) => x.id), query: t0.title, trace: tc?.traceId });
    const ds = tc ? trace.startSpan({ ...tc, kind: 'dispatch', name: `${t0.id} → ${t0.assign.node}`,
      input: { task: { id: t0.id, title: t0.title, kind: t0.kind, size: t0.size }, node: t0.assign.node, provider: t0.assign.provider, model: t0.assign.model, effort: t0.assign.effort, why: t0.reason, workdir, mode: p0.dispatch, attempt, ...(t0.escalate ? { escalated: t0.escalate } : {}) },
      meta: { projectId: p0.id, taskId: t0.id, attempt, target: t0.assign.node } }) : null;
    try {
      r = await ctx.call(t0.assign.node, 'work/start', { method: 'POST', body: { project: { id: p0.id, slug: p0.slug, name: p0.name, gitUrl: p0.gitUrl, selfDev: p0.selfDev ? { branch: p0.selfDev.branch } : null }, task: t0, prompt: taskPrompt(p0, t0, catalog), workdir, mode: p0.dispatch, policy: p0.policy, source: t0.source || undefined, trace: ds ? ds.ctx : t0.trace || p0.trace || undefined }, timeout: 10 * 60 * 1000 });
    } catch (e) { err = e; }
    ds?.end(r ? { output: { mode: r.mode, seat: r.seat || '', rig: r.rig || '', qitem: r.qitem || '', session: r.session?.id || '', run: r.traceRun?.spanId || '' } } : { status: 'error', output: err?.message || 'no answer' });
    await withProject(id, async () => {
      const p = await getProject(id);
      const t = p?.tasks.find((x) => x.id === t0.id);
      if (!t) return;
      if (t.status !== 'starting') {
        if (r && p.status === 'paused') {
          event(p, `${t.id} came up on ${t0.assign.node} after the project was paused — stopped it`);
          ctx.call(t0.assign.node, 'work/stop', { method: 'POST', body: r, timeout: 120000 }).catch(() => {});
        } else if (r) event(p, `${t.id} started on ${t0.assign.node} after it had moved to ${t.status} — check for a stray agent`);
        await saveProject(p);
        return;
      }
      if (r) {
        t.run = { ...r, startedAt: Date.now() };
        t.status = 'running';
        t.summary = '';
        t.watch = null;
        started.push(t.id);
        event(p, `${t.id} started on ${t.assign.node} via ${r.mode === 'openrig' ? `OpenRig seat ${r.seat}` : `${r.session.kind} ${r.session.id}`}${t.attempts ? ` (attempt ${t.attempts + 1})` : ''}`);
      } else {
        // The machine or its agent runtime failed, not the model: same model, after a pause, maybe elsewhere.
        const rr = retryOrFail(p, t, `dispatch to ${t.assign.node} failed: ${err.message}`, { escalate: false, delayMs: autonomy.settings(p).retryDelayMs });
        if (rr === 'retry' && !t.assign?.locked) t.assign = null; // let routing pick another machine
        event(p, `${t.id} dispatch failed on ${t.assign?.node || 'its machine'}: ${err.message}`);
      }
      await saveProject(p);
    });
  }
  return withProject(id, async () => {
    const p = await getProject(id);
    if (started.length) tell(ctx, p, `${p.name}: started ${started.length} task${started.length > 1 ? 's' : ''} (${started.map((x) => p.tasks.find((t) => t.id === x).assign.node).join(', ')}).`);
    if (!only) await settle(p, ctx, now);
    return p;
  });
}

/**
 * Usage ledger: where a finished stretch of a task run goes (wired by the server to usage.recordTaskRun; unset in
 * tests). Each call covers the run from where the last one ended, so a "blocked" report followed by "done" never
 * counts the same transcript twice.
 */
let runSink = null;
export function onRunEnd(fn) { runSink = fn; }

export function runEnded(p, t, status, summary = '') {
  if (!t.run || !t.assign?.node) return null;
  const until = Date.now();
  const since = t.usageFrom || t.startingAt || t.run.startedAt || until;
  t.usageFrom = until;
  const e = {
    node: t.assign.node, project: { id: p.id, name: p.name }, task: { id: t.id, title: t.title, kind: t.kind, attempts: t.attempts || 0 },
    assign: { provider: t.assign.provider, model: t.assign.model, effort: t.assign.effort }, run: { ...t.run }, since, until, status, summary: String(summary || ''),
  };
  if (runSink) Promise.resolve().then(() => runSink(e)).catch((err) => log(`project ${p.id} ${t.id}: usage capture: ${err.message}`));
  return e;
}

/**
 * A task that failed, stalled or ended silently gets a fresh attempt with the failure in its brief, one rung up the
 * model ladder (Sonnet medium → Opus high → Opus xhigh) unless the failure was the machine's (`escalate: false`, e.g.
 * a dispatch error, retried after `delayMs`). When the project's attempt budget (config.autonomy.maxAttempts) is
 * spent the task is failed for good. Returns 'retry' or 'failed'.
 */
export function retryOrFail(p, t, why, { escalate = true, delayMs = 0, now = Date.now() } = {}) {
  const A = autonomy.settings(p);
  const max = A.enabled ? A.maxAttempts : MAX_ATTEMPTS;
  runEnded(p, t, 'failed', why);
  const run = t.run?.traceRun;
  const from = t.assign ? { node: t.assign.node, provider: t.assign.provider, model: t.assign.model, effort: t.assign.effort } : null;
  t.attempts = (t.attempts || 0) + 1;
  t.lastFailure = truncate(String(why || ''), 1500);
  (t.history ||= []).push({ attempt: t.attempts, at: now, node: t.assign?.node || '', provider: t.assign?.provider || '', model: t.assign?.model || '', effort: t.assign?.effort || '', why: truncate(String(why || ''), 300) });
  if (t.history.length > 10) t.history = t.history.slice(-10);
  // The seat that held the work keeps its context: a retry in a persistent rig is typed into it if it is idle.
  if (t.run?.seat) t.lastSeat = t.run.seat;
  t.run = null;
  t.watch = null;
  t.answers = 0;
  if (t.attempts < max) {
    t.status = 'todo';
    let how = '';
    // A "private" task stays on local models: the ladder (cloud models) never applies to it.
    const nx = A.enabled && escalate && t.kind !== 'private' ? autonomy.nextAssign(t.assign, A.ladder) : null;
    if (nx && !(nx.provider === t.assign?.provider && nx.model === t.assign?.model && nx.effort === t.assign?.effort)) {
      t.escalate = { provider: nx.provider, model: nx.model, effort: nx.effort };
      // A different model needs a fresh seat; the same provider stays on its machine, another one is routed again.
      delete t.lastSeat;
      if (t.assign && (t.assign.provider === nx.provider || t.assign.locked)) t.assign = { ...t.assign, ...t.escalate };
      else t.assign = null;
      how = ` with ${nx.model} ${nx.effort}`;
    }
    if (delayMs > 0) t.retryAt = now + delayMs; else delete t.retryAt;
    event(p, `${t.id} will be retried (attempt ${t.attempts + 1}/${max}${how}${delayMs > 0 ? `, in ${Math.round(delayMs / 1000)} s` : ''}): ${truncate(why, 160)}`);
    traceEvent(p, t, how ? 'escalate' : 'retry', { run, input: why, output: `attempt ${t.attempts + 1}/${max}${how}`,
      meta: { attempt: t.attempts, nextAttempt: t.attempts + 1, maxAttempts: max, from, to: how ? { ...t.escalate, rung: nx.rung } : null, escalate, delayMs } });
    return 'retry';
  }
  t.status = 'failed';
  delete t.retryAt;
  t.summary = truncate(String(why || ''), 4000);
  event(p, `${t.id} failed after ${t.attempts} attempt${t.attempts > 1 ? 's' : ''}: ${truncate(why, 160)}`);
  traceEvent(p, t, 'failed', { run, input: why, output: `gave up after ${t.attempts} attempt${t.attempts > 1 ? 's' : ''}`, status: 'error', meta: { attempt: t.attempts, maxAttempts: max, from } });
  return 'failed';
}

/**
 * The loop's end — 100%, the attempt budget spent, or a hand-off that can't finish: Sir gets ONE report (what was
 * done, retried, still open, "How did it work out, sir?"). The same end state is never reported twice.
 */
export function completionNotify(p, ctx, { why = 'done', merged = '' } = {}) {
  const sig = `${p.status}|${p.tasks.map((t) => `${t.id}:${t.status}`).join(',')}`;
  if (p.loop?.notified === sig) return false;
  p.loop = { ...(p.loop || {}), notified: sig, endedAt: Date.now(), why };
  event(p, `loop ended (${why}) — asked Sir how it worked out`);
  const text = autonomy.completionReport(p, { why, merged });
  tell(ctx, p, withAdhocNote(p, text), why === 'done' ? 'info' : 'error', { keep: true });
  return true;
}

/** `text` plus a line on the project's unmerged ad-hoc tools, when it filed any (the tools are filed per origin project). */
export function withAdhocNote(p, text, deps) {
  const note = projectAdhocNote(p.id, deps);
  return note ? `${text}\n\n${note}` : text;
}

/** finalReport + the ad-hoc note, told to Sir (autonomy off). */
function tellFinal(ctx, p, opts) {
  tell(ctx, p, withAdhocNote(p, finalReport(p, opts)), 'info', { keep: true });
}

/** Sir's answer to "How did it work out?", kept on the project. */
export async function addFeedback(id, { text, by = 'Sir' } = {}) {
  if (!String(text || '').trim()) throw new Error('no feedback text');
  return withProject(id, async () => {
    const p = await getProject(id);
    if (!p) throw new Error('project not found');
    (p.feedback ||= []).push({ ts: Date.now(), by: truncate(String(by), 80), text: truncate(String(text), 4000) });
    event(p, `feedback from ${by}: ${truncate(String(text), 160)}`);
    return saveProject(p);
  });
}

/**
 * Work that can never start on its own: a task an agent left "blocked", or tasks whose dependencies wait on each
 * other. Blocked tasks are retried (within the budget); a dependency cycle loses the edges that close it.
 * Returns true if anything changed.
 */
export function requeueDeadlocks(p, now = Date.now()) {
  let changed = false;
  for (const t of p.tasks.filter((x) => x.status === 'blocked')) {
    retryOrFail(p, t, `was blocked: ${t.summary || 'no reason given'}`, { now });
    t.stalled = false;
    changed = true;
  }
  const byId = new Map(p.tasks.map((t) => [t.id, t]));
  const state = new Map(); // 1 = on the DFS stack, 2 = finished
  const visit = (t) => {
    state.set(t.id, 1);
    for (const d of [...t.deps]) {
      const dt = byId.get(d);
      if (!dt || dt.status === 'done') continue;
      if (state.get(d) === 1) {
        t.deps = t.deps.filter((x) => x !== d);
        event(p, `${t.id} and ${d} waited on each other — ${t.id} no longer waits for ${d}`);
        changed = true;
      } else if (!state.get(d)) visit(dt);
    }
    state.set(t.id, 2);
  };
  for (const t of p.tasks) if (t.status === 'todo' && !state.get(t.id)) visit(t);
  return changed;
}

/** What Sir hears when a project is finished (autonomy off): one spoken line, the evidence written below it. */
export function finalReport(p, { merged = '' } = {}) {
  const n = p.tasks.length;
  const spoken = `${p.name} is done: ${n} task${n === 1 ? '' : 's'} finished${merged ? ', merged and rolled out to every machine' : ''}.`;
  const lines = p.tasks.map((t) => `- **${t.title}** (${t.assign?.node || '?'}, ${t.assign?.provider || '?'}): ${truncate(t.summary || 'done', 400)}`);
  return `${spoken}\n---\n${merged ? `Merged as ${merged}.\n\n` : ''}${lines.join('\n')}`;
}

/**
 * Tell Sir about a project: a toast + speech now, and — for results and problems — a message written into the
 * JARVIS thread (and the thread the request came from), so nothing is lost when no screen is open.
 */
export function tell(ctx, p, text, level = 'info', { keep = false } = {}) {
  ctx?.notify?.(text, level);
  if ((keep || level === 'error') && ctx?.report) Promise.resolve(ctx.report(p, text, level)).catch(() => {});
}

/** Providers Sir switched off for now (routing.avoid, e.g. ["codex"]): never planned or placed. */
export function avoided() {
  return (config().routing?.avoid || []).map((x) => String(x).toLowerCase());
}

/**
 * After any change: finish (and ask Sir how it went), hand a RIGS change to the merge steward, re-queue work that
 * can't start on its own, or end the loop when the budget is spent. Never touches a paused project.
 */
async function settle(p, ctx, now = Date.now()) {
  if (p.main || p.status === 'paused') return; // the standing project never finishes; each task reports on its own
  const A = autonomy.settings(p);
  if (p.tasks.length && p.tasks.every((x) => x.status === 'done')) {
    if (['done', 'merging'].includes(p.status)) return;
    if (p.selfDev && ctx?.propose) {
      if (p.selfDev.proposeRetryAt > now) return;
      try {
        const r = await ctx.propose(p);
        if (r?.empty) {
          // Nothing was committed (an action, not a code change): there is nothing to merge — the project is done.
          p.status = 'done';
          event(p, `all tasks done — ${p.selfDev.branch} has no commits ahead of main, nothing to merge`);
          if (A.enabled) completionNotify(p, ctx); else tellFinal(ctx, p);
          ctx?.release?.(p);
        } else {
          p.selfDev = { ...p.selfDev, request: r.id, steward: r.steward, proposedAt: now, proposeFails: 0, proposeRetryAt: 0 };
          p.status = 'merging';
          event(p, `all tasks done — proposed ${p.selfDev.branch} to the merge steward on ${r.steward}`);
          tell(ctx, p, `${p.name}: all tasks done and verified — handed to the merge steward for tests, merge and rollout.`, 'info', { keep: true });
        }
      } catch (e) {
        const fails = (p.selfDev.proposeFails || 0) + 1;
        if (A.enabled && fails < A.maxAttempts) {
          // Often transient (steward offline, a guide block left in the tree): try again on a later tick.
          p.selfDev = { ...p.selfDev, proposeFails: fails, proposeRetryAt: now + Math.max(A.retryDelayMs, 20000) };
          event(p, `propose failed (${fails}/${A.maxAttempts}) — trying again: ${e.message}`);
        } else {
          p.status = 'blocked';
          event(p, 'propose failed: ' + e.message);
          if (A.enabled) completionNotify(p, ctx, { why: `the work is done but handing it to the merge steward failed ${fails} times (${truncate(e.message, 160)})` });
          else tell(ctx, p, `${p.name}: the work is done but proposing it failed — ${truncate(e.message, 160)}.`, 'error');
        }
      }
    } else {
      p.status = 'done';
      event(p, 'all tasks done');
      if (A.enabled) completionNotify(p, ctx); else tellFinal(ctx, p);
      ctx?.release?.(p);
    }
    await saveProject(p);
    return;
  }
  if (A.enabled && p.status === 'running' && requeueDeadlocks(p, now)) await saveProject(p);
  const moving = p.tasks.some((x) => ['running', 'starting'].includes(x.status) || ready(p, x, now) || (x.status === 'todo' && x.retryAt > now));
  // A task no machine can run counts as stuck once that has lasted (a machine rebooting is not a reason to stop).
  const stranded = p.tasks.filter((x) => x.status === 'todo' && !x.assign && x.unroutableSince && now - x.unroutableSince > 10 * 60000);
  const stuck = [...p.tasks.filter((x) => ['failed', 'blocked'].includes(x.status)), ...(A.enabled ? stranded : [])];
  if (!moving && stuck.length && p.status === 'running') {
    p.status = 'blocked';
    event(p, `blocked on ${stuck.map((x) => x.id).join(', ')}`);
    if (A.enabled) completionNotify(p, ctx, { why: `the attempt budget is spent (${A.maxAttempts} per task) — ${stuck.map((x) => `“${x.title}” ${x.status === 'todo' ? 'has no machine that can run it' : x.status}`).join('; ')}` });
    else tell(ctx, p, `${p.name} needs you: ${stuck.map((x) => `“${x.title}” ${x.status}${x.summary ? ' — ' + truncate(x.summary, 120) : ''}`).join('; ')}.`, 'error');
    await saveProject(p);
  }
}

export async function updateTask(id, taskId, change, ctx) {
  const p = await withProject(id, () => applyUpdate(id, taskId, change, ctx));
  if (p.status === 'running' && ctx) return dispatchReady(id, ctx);
  return p;
}

async function applyUpdate(id, taskId, { status, summary, assign, files }, ctx) {
  const p = await getProject(id);
  if (!p) throw new Error('project not found');
  const t = p.tasks.find((x) => x.id === taskId);
  if (!t) throw new Error('task not found');
  if (assign) { t.assign = { ...t.assign, ...assign, locked: true }; t.reason = 'set by hand'; }
  if (files?.length) {
    // New files are kept, explained or not (src/file-cache.js); an unexplained one gets a cached copy for later tasks.
    const m = mergeFiles(p.files, files, { task: t.id, node: t.assign?.node || '' });
    p.files = m.files;
    if (m.added.length || m.explained.length) event(p, `${t.id} files: ${m.added.length} new${m.added.some((f) => f.cached) ? ` (${m.added.filter((f) => f.cached).length} cached without a reason)` : ''}${m.explained.length ? `, ${m.explained.length} explained` : ''}`);
    if (ctx?.call) await cacheCopies(p.id, m.added, ctx.call);
  }
  const A = autonomy.settings(p);
  // Sir paused it: a late report is recorded, but nothing is retried, answered or started.
  const live = A.enabled && ctx && p.status !== 'paused';
  if (status) {
    event(p, `${t.id} → ${status}${summary ? ': ' + truncate(summary, 160) : ''}`);
    const was = t.status;
    if (status === 'blocked' && live && t.status === 'running' && t.run && (t.answers || 0) < A.maxAnswers) {
      // A question, not a dead end: answer it with the safe default, log it, and the task keeps running.
      selfAnswer(p, t, summary || 'the agent reported blocked without saying why', ctx);
    } else if (status === 'blocked' && live && t.status === 'running' && t.run) {
      retryOrFail(p, t, `still blocked after ${t.answers} automatic answers: ${summary || 'no reason given'}`);
    } else if (status === 'failed' && ctx && retryOrFail(p, t, summary || 'the agent reported failure') === 'retry') {
      // On a paused project this only records the next attempt; it starts when Sir resumes.
      if (p.status !== 'paused') tell(ctx, p, `${p.name}: “${t.title}” failed — retrying (attempt ${t.attempts + 1}${t.escalate ? `, ${t.escalate.model} ${t.escalate.effort}` : ''}) with what went wrong.`);
    } else {
      if (was !== status && ['done', 'failed', 'blocked'].includes(status)) runEnded(p, t, status, summary);
      t.status = status;
      t.stalled = false; // an agent's own report replaces the watchdog's verdict
      if (summary !== undefined) t.summary = truncate(summary, 4000);
      if (status === 'todo') { t.run = null; t.attempts = 0; }
      if (status === 'done') tell(ctx, p, `${p.name}: task “${t.title}” finished on ${t.assign?.node}${summary ? ' — ' + truncate(summary, 600) : '.'}`, 'info', { keep: true });
      if ((status === 'blocked' || status === 'failed') && was !== status) tell(ctx, p, `${p.name}: task “${t.title}” is ${status}${summary ? ' — ' + truncate(summary, 140) : ''}.`, 'error');
    }
    // Sir (or an agent) moving a task again un-blocks the project.
    if (p.status === 'blocked' && ['todo', 'running', 'done'].includes(t.status)) p.status = 'running';
  }
  await saveProject(p);
  if (p.status !== 'running' && ctx) await settle(p, ctx);
  return p;
}

/**
 * Answer an agent's question on Sir's behalf (the standing safe default), log it on the task and keep the task
 * running. `dismiss` first declines a permission prompt that holds the session (Escape) — the safe choice.
 */
function selfAnswer(p, t, question, ctx, { dismiss = false, now = Date.now() } = {}) {
  t.answers = (t.answers || 0) + 1;
  const q = truncate(String(question || ''), 500);
  (t.questions ||= []).push({ ts: now, attempt: (t.attempts || 0) + 1, question: q, answer: 'safe default (automatic)' });
  if (t.questions.length > 20) t.questions = t.questions.slice(-20);
  t.status = 'running';
  event(p, `${t.id} asked: “${truncate(q, 140)}” — answered automatically with the safe default (${t.answers}/${autonomy.settings(p).maxAnswers})`);
  traceEvent(p, t, 'question', { input: q, output: autonomy.selfAnswerText(p, t, q), meta: { attempt: (t.attempts || 0) + 1, answer: 'safe default (automatic)', answers: t.answers, maxAnswers: autonomy.settings(p).maxAnswers, dismiss } });
  // Not awaited: the agent may be waiting on this very report (project_task_update) to return.
  if (!ctx?.call) return;
  Promise.resolve(ctx.call(t.assign.node, 'work/nudge', { method: 'POST', body: { ...t.run, dismiss, text: autonomy.selfAnswerText(p, t, q) }, timeout: 30000 }))
    .catch((e) => log(`project ${p.id} ${t.id}: answering failed: ${e.message}`));
}

const nudgeText = (p, t, idleMin) => `RIGS watchdog: you have been idle for ${idleMin} min on task ${t.id} of project ${p.id} without reporting. If a background job is running, wait for it and carry on. If the task is done, verify it against its acceptance criteria and call project_task_update (owner "${p.owner}", project "${p.id}", task "${t.id}", status "done", with the evidence). If you cannot finish, call it with status "failed" or "blocked" and say exactly why.`;

/** Does the status show an agent that is working: mid-turn, or a transcript/session that moved within the stall window? */
export const isActive = (st, now = Date.now()) => st.busy === true || (st.activityAt > 0 && now - st.activityAt < STALL_MS);

/** A task the watchdog blocked as stalled: back to running once its agent shows life again; the project recovers with it. */
export function recoverStalled(p, t, st, now = Date.now()) {
  if (!t.stalled || t.status !== 'blocked' || !isActive(st, now)) return false;
  t.status = 'running'; t.stalled = false; t.summary = ''; t.watch = null;
  if (p.status === 'blocked' && !p.tasks.some((x) => ['failed', 'blocked'].includes(x.status))) p.status = 'running';
  event(p, `${t.id} → running (agent active again)`);
  return true;
}

/** One running task: finished? ended silently? idle without reporting (nudge, then escalate)? Returns true if changed. */
export async function watchTask(p, t, st, ctx, now = Date.now()) {
  // A seat that reported "blocked" may close its queue item as blocked/denied/canceled/escalated: that is not the
  // task finishing. Under the loop it was answered (or will be nudged) and must still report — keep watching it.
  const unfinished = st.state === 'done' && /^(blocked_on|denied|canceled|escalation)$/.test(st.closure || '') && autonomy.settings(p).enabled;
  if (st.state === 'done' && !unfinished) {
    t.status = 'done'; t.summary ||= `queue item closed (${st.closure || 'done'})`; event(p, `${t.id} → done (OpenRig queue)`);
    runEnded(p, t, 'done', t.summary);
    return true;
  }
  if (st.state === 'ended') {
    event(p, `${t.id} session ended without a report`);
    const r = retryOrFail(p, t, 'the agent session ended without reporting (no project_task_update)', { now });
    if (r === 'failed' && !autonomy.settings(p).enabled) tell(ctx, p, `${p.name}: “${t.title}” ended twice without finishing.`, 'error');
    return true;
  }
  if (st.state === 'seat-down' || st.state === 'daemon-down') return reviveTask(p, t, st, ctx);
  const A = autonomy.settings(p);
  const w = t.watch || (t.watch = { fp: '', idleSince: 0, nudges: 0, nudgedAt: 0 });
  if (st.needsInput) {
    if (!A.enabled) return false; // a permission/question wait — the attention feed asks Sir
    return answerWait(p, t, st, ctx, now, A);
  }
  if (w.inputSince) w.inputSince = 0;
  // No sign of progress for the whole stall window (not busy, transcript/session untouched): failed → retried.
  if (A.enabled && !st.busy && st.activityAt > 0 && now - st.activityAt >= A.stallMs && now - (t.run?.startedAt || 0) >= A.stallMs) {
    return failStalled(p, t, ctx, now, `stalled: no progress for ${Math.round((now - st.activityAt) / 60000)} min without a report`);
  }
  // Idle only when nothing shows life: not busy, no transcript/session activity within the stall window.
  const idle = !isActive(st, now) && (st.idle === true || (st.fingerprint && st.fingerprint === w.fp));
  let changed = false;
  if (st.fingerprint) w.fp = st.fingerprint;
  if (!idle) { if (w.idleSince) { w.idleSince = 0; w.nudges = 0; changed = true; } return changed; }
  if (!w.idleSince) { w.idleSince = now; return true; }
  if (A.enabled && w.nudges && now - w.idleSince >= A.stallMs) return failStalled(p, t, ctx, now, `stalled: idle ${Math.round((now - w.idleSince) / 60000)} min without a report after ${w.nudges} nudges`);
  if (now - w.idleSince < STALL_MS || now - w.nudgedAt < STALL_MS) return false;
  if (w.nudges >= MAX_NUDGES && A.enabled) return failStalled(p, t, ctx, now, `stalled: idle ${Math.round((now - w.idleSince) / 60000)} min without a report after ${w.nudges} nudges`);
  if (w.nudges >= MAX_NUDGES) {
    t.status = 'blocked';
    t.stalled = true;
    t.summary = `stalled: idle ${Math.round((now - w.idleSince) / 60000)} min without a report after ${w.nudges} nudges — check its session`;
    runEnded(p, t, 'blocked', t.summary);
    event(p, `${t.id} → blocked (stalled)`);
    tell(ctx, p, `${p.name}: “${t.title}” has stalled on ${t.assign?.node} and does not respond to nudges.`, 'error');
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

/** The watchdog's verdict on a task that stopped making progress: stop its agent and feed it into the retry. */
async function failStalled(p, t, ctx, now, why) {
  const old = t.run;
  const node = t.assign?.node;
  event(p, `${t.id} → failed (${why})`);
  retryOrFail(p, t, why, { now });
  if (old && node) await ctx.call(node, 'work/stop', { method: 'POST', body: old, timeout: 120000 }).catch((e) => log(`project ${p.id} ${t.id}: stopping a stalled agent: ${e.message}`));
  return true;
}

/**
 * The agent sits on a permission prompt or a question. After answerAfterSec RIGS answers it (declining the prompt,
 * then the standing safe-default answer) and logs it; one that keeps waiting after maxSelfAnswers answers is failed
 * and retried.
 */
async function answerWait(p, t, st, ctx, now, A) {
  const w = t.watch;
  if (!w.inputSince) { w.inputSince = now; return true; }
  if (now - w.inputSince < A.answerAfterMs || now - (w.answeredAt || 0) < A.answerAfterMs) return false;
  const q = st.question || 'a permission prompt or question held the session';
  if ((t.answers || 0) >= A.maxAnswers) return failStalled(p, t, ctx, now, `kept waiting for input after ${t.answers} automatic answers: ${truncate(q, 200)}`);
  selfAnswer(p, t, q, ctx, { dismiss: true, now });
  w.answeredAt = now;
  return true;
}

const resumeText = (p, t) => `RIGS: this session was interrupted (a machine or agent restart) while you were working on task ${t.id} of project ${p.id} ("${t.title}").${t.run?.brief ? ` Your brief is ${t.run.brief}.` : ''} Check where you left off (files, git state, notes), then carry on and finish it; report with project_task_update (owner "${p.owner}", project "${p.id}", task "${t.id}") when done.`;

/** A running task whose agent died (reboot, crash, killed session): bring the seat back and tell it to carry on. */
async function reviveTask(p, t, st, ctx) {
  t.revives = (t.revives || 0) + 1;
  if (t.revives > MAX_REVIVES) {
    const r = retryOrFail(p, t, `its agent session kept dying (${t.revives - 1} revives)`);
    t.revives = 0;
    event(p, `${t.id} keeps losing its agent${r === 'retry' ? ' — starting it again from its brief' : ''}`);
    if (r === 'failed') tell(ctx, p, `${p.name}: “${t.title}” keeps losing its agent on ${t.assign?.node}.`, 'error');
    return true;
  }
  try {
    const r = await ctx.call(t.assign.node, 'work/revive', { method: 'POST', body: t.run, timeout: 6 * 60 * 1000 });
    if (!r.ok) throw new Error(r.reason || 'revive failed');
    if (r.restored === false) {
      // A false alarm (a slow daemon) or only OpenRig itself was down: the agent kept working — don't interrupt it.
      t.revives = Math.max(0, t.revives - 1);
      if (/restarted/.test(r.how || '')) event(p, `${t.id}: ${r.how}`);
      return /restarted/.test(r.how || '');
    }
    await ctx.call(t.assign.node, 'work/nudge', { method: 'POST', body: { ...t.run, text: resumeText(p, t) }, timeout: 30000 }).catch(() => {});
    t.watch = null;
    event(p, `${t.id}: its agent was down (${st.state}) — ${r.how}; told it to carry on`);
    tell(ctx, p, `${p.name}: “${t.title}” lost its agent on ${t.assign?.node} (${st.state === 'daemon-down' ? 'OpenRig was down' : 'the session died'}) — brought it back and it carries on.`);
  } catch (e) {
    event(p, `${t.id}: reviving its agent failed (${e.message}) — will try again`);
    log(`project ${p.id} ${t.id}: revive failed: ${e.message}`);
  }
  return true;
}

/**
 * Background loop on the owner node: notice finished seats/sessions, retry what ended silently, nudge idle agents,
 * recover stuck planning/dispatch, follow RIGS changes through the merge steward, and start what became ready.
 */
export async function tick(ctx, now = Date.now()) {
  for (const s of await listProjects()) {
    if (!['running', 'planning', 'merging'].includes(s.status) && !(s.status === 'blocked' && s.tasks?.some((t) => t.stalled))) continue;
    const next = await withProject(s.id, () => tickProject(s.id, ctx, now)).catch((e) => { log(`project ${s.id}: tick: ${e.message}`); return null; });
    if (next === 'dispatch') await dispatchReady(s.id, ctx, { now }).catch((e) => log(`project ${s.id}: dispatch: ${e.message}`));
  }
}

async function tickProject(id, ctx, now) {
  const p = await getProject(id);
  if (!p || !['running', 'planning', 'merging', 'blocked'].includes(p.status)) return null;
  let changed = false;
  // D4: the per-task status checks run in parallel (one slow machine no longer holds the others' verdicts back).
  const checks = await Promise.all(p.tasks.filter((x) => x.stalled && x.status === 'blocked' && x.run).map(async (t) => {
    try {
      const st = await ctx.call(t.assign.node, 'work/status', { method: 'POST', body: t.run, timeout: 20000 });
      return st.state === 'done' ? await watchTask(p, t, st, ctx, now) : recoverStalled(p, t, st, now);
    } catch (e) { log(`project ${p.id} ${t.id}: status check failed: ${e.message}`); return false; }
  }));
  if (checks.some(Boolean)) changed = true;
  if (p.status === 'blocked') { if (changed) await saveProject(p); return null; }
  if (p.status === 'planning' && (now - p.updatedAt > PLANNING_MS || p.updatedAt < BOOT)) {
    // The planner's brain call died with the daemon (restart, update): plan again (up to 3 times) if Sir asked for it to run.
    const again = p.autoRun && (p.replans || (p.replanned ? 1 : 0)) < 3;
    p.status = 'draft';
    p.replanned = true;
    p.replans = (p.replans || 0) + 1;
    event(p, `planning never finished${again ? ' — planning again' : ''}`);
    if (p.autoRun && !again) tell(ctx, p, `${p.name}: planning died ${p.replans} times — it needs a fresh start.`, 'error');
    await saveProject(p);
    if (again) planProject(p.id, ctx).then(() => dispatchReady(p.id, ctx)).catch((e) => tell(ctx, p, `Couldn't plan ${p.name}: ${e.message}`, 'error'));
    return null;
  }
  if (p.status === 'merging') return (await followMerge(p, ctx, now)) || null;
  for (const t of p.tasks) {
    const startedAt = t.startingAt || p.updatedAt;
    if (t.status !== 'starting' || (now - startedAt <= STARTING_MS && startedAt >= BOOT)) continue;
    // Its agent may well be running (the start reply was lost): adopt it rather than casting a second one.
    const found = await ctx.call(t.assign.node, 'work/find', { method: 'POST', body: { project: { id: p.id, slug: p.slug }, task: { id: t.id, attempts: t.attempts || 0 } }, timeout: 20000 }).catch(() => null);
    if (found?.run) { t.run = { ...found.run, startedAt: t.startingAt || now }; t.status = 'running'; t.watch = null; event(p, `${t.id} was already running (${found.run.seat || found.run.session?.id}) — adopted`); }
    else { t.status = 'todo'; event(p, `${t.id} never started — trying again`); }
    changed = true;
  }
  const watched = await Promise.all(p.tasks.filter((x) => x.status === 'running' && x.run).map(async (t) => {
    try {
      const st = await ctx.call(t.assign.node, 'work/status', { method: 'POST', body: t.run, timeout: 20000 });
      return watchTask(p, t, st, ctx, now);
    } catch (e) { log(`project ${p.id} ${t.id}: status check failed: ${e.message}`); return false; }
  }));
  if (watched.some(Boolean)) changed = true;
  if (changed) await saveProject(p);
  if (changed || p.tasks.some((x) => ready(p, x, now) || (x.status === 'todo' && !x.assign))) return 'dispatch';
  await settle(p, ctx, now); // a blocked task to re-queue, a propose to retry, or nothing can move → end the loop once
  return null;
}

// D4: an unreachable merge steward is logged once per project, then left alone for STEWARD_BACKOFF_MS before the next
// check (1182 "merge status: … is offline" lines per absent steward before). In memory only: a restart checks again.
export const STEWARD_BACKOFF_MS = 5 * 60 * 1000;
const stewardDown = new Map(); // project id → { at: when it was last found unreachable, error }

/**
 * The backoff decision for one project's steward check, pure: `state` is { at, error } from the last failure (or
 * undefined). → { check: whether to call the steward now, log: whether a failure now should be logged }.
 */
export function stewardBackoff(state, now = Date.now(), backoffMs = STEWARD_BACKOFF_MS) {
  if (!state) return { check: true, log: true };
  if (now - state.at < backoffMs) return { check: false, log: false };
  return { check: true, log: true };
}

/** A finished RIGS change waits for the merge steward: merged → report; checks failed → a fix task, then propose again. */
async function followMerge(p, ctx, now) {
  const sd = p.selfDev || {};
  const back = stewardBackoff(stewardDown.get(p.id), now);
  if (!back.check) return;
  let req;
  try { req = (await ctx.call(sd.steward, 'merge', { timeout: 20000 })).queue?.find((r) => r.id === sd.request); stewardDown.delete(p.id); }
  catch (e) {
    stewardDown.set(p.id, { at: now, error: e.message });
    if (back.log) log(`project ${p.id}: merge status: ${e.message} — checking again in ${Math.round(STEWARD_BACKOFF_MS / 60000)} min`);
    return;
  }
  if (!req) return;
  const A = autonomy.settings(p);
  if (req.status === 'merged') {
    p.status = 'done';
    event(p, `merged to main as ${req.sha} and rolled out`);
    if (A.enabled) completionNotify(p, ctx, { merged: req.sha || 'main' });
    await saveProject(p);
    if (!A.enabled) tellFinal(ctx, p, { merged: req.sha || 'main' });
    ctx.release?.(p);
  } else if (req.status === 'conflict' && A.enabled) {
    // A conflict belongs to a resolver agent (routing kind "merge"). One that failed, stalled or never started is
    // replaced by re-queuing the request (the steward merges again and casts a new resolver); one Sir paused stays.
    // A resolver Sir deleted counts as one he paused: it is never replaced (an unreachable steward is not "deleted").
    const resolver = req.resolver?.project ? await ctx.call(sd.steward, `projects/${req.resolver.project}`, { timeout: 20000 }).catch((e) => (/project not found/.test(e.message) ? { status: 'deleted' } : null)) : null;
    const act = conflictAction(req, resolver, sd, now, A);
    if (act === 'retry') {
      try {
        // A resolver that finished without saying so may have left the merge resolved: keep its work if so.
        const kept = resolver?.status === 'done' && await ctx.call(sd.steward, `merge/${req.id}/resolved`, { method: 'POST', body: {}, timeout: 60000 }).then(() => true, () => false);
        if (!kept) await ctx.call(sd.steward, `merge/${req.id}/retry`, { method: 'POST', body: {}, timeout: 20000 });
        p.selfDev = { ...sd, conflictRetries: (sd.conflictRetries || 0) + 1, conflictRetryAt: now + 15 * 60000 };
        event(p, `merge conflict had no working resolver (${resolver?.status || req.resolver?.error || 'none'}) — re-queued it for a new resolver (${p.selfDev.conflictRetries}/${A.maxAttempts})`);
      } catch (e) { log(`project ${p.id}: re-queue merge ${req.id}: ${e.message}`); }
      await saveProject(p);
    } else if (act === 'paused' && !sd.resolverPaused) {
      p.selfDev = { ...sd, resolverPaused: true };
      event(p, `merge conflict: its resolver ${req.resolver.project} was ${resolver?.status === 'deleted' ? 'deleted' : 'paused'} by Sir — left as it is`);
      await saveProject(p);
    } else if (act === 'exhausted') {
      p.status = 'blocked';
      event(p, 'merge conflict: resolvers kept failing');
      completionNotify(p, ctx, { why: `the merge stays in conflict after ${sd.conflictRetries || 0} resolver attempts` });
      await saveProject(p);
    }
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
    return 'dispatch'; // the caller dispatches once this project's lock is released
  } else if (['checks-failed', 'dropped'].includes(req.status) || (req.status === 'conflict' && now - (sd.proposedAt || now) > 6 * 3600000)) {
    p.status = 'blocked';
    event(p, `merge ${req.status}`);
    const what = req.status === 'conflict' ? 'is stuck on a conflict' : req.status === 'dropped' ? 'was dropped' : 'checks keep failing';
    if (A.enabled) completionNotify(p, ctx, { why: `the merge ${what}${req.failedStage ? ` (${req.failedStage})` : ''}` });
    await saveProject(p);
    if (!A.enabled) tell(ctx, p, `${p.name}: the merge ${what} — it needs you.`, 'error');
  }
}

/**
 * What to do about a merge request parked in "conflict", given its resolver project (null if unknown/missing):
 * 'wait' (a resolver is on it, or is just being cast), 'paused' (Sir paused or deleted the resolver — never revived),
 * 'retry' (no working resolver: re-queue the request) or 'exhausted' (the budget of resolver attempts is spent).
 */
export function conflictAction(req, resolver, sd = {}, now = Date.now(), A = autonomy.settings()) {
  if (['paused', 'deleted'].includes(resolver?.status)) return 'paused';
  if (resolver && ['draft', 'planning', 'planned', 'running', 'merging'].includes(resolver.status)) return 'wait';
  // No resolver recorded yet: the steward may be casting it right now.
  if (!resolver && !req.resolver?.error && now - (req.updatedAt || 0) < 10 * 60000) return 'wait';
  if ((sd.conflictRetryAt || 0) > now) return 'wait';
  return (sd.conflictRetries || 0) < A.maxAttempts ? 'retry' : 'exhausted';
}

/**
 * Sir said stop / pause / hold: the project is "paused" and stays that way until he resumes it — nothing is
 * dispatched, watched, nudged or revived. Runs under the project lock so an in-flight tick (which may be about to
 * revive a seat) can't write a stale "running" copy back. The agents are stopped once the lock is released;
 * their uncommitted edits stay in the working tree.
 */
export async function stopProject(id, ctx, { reason = '', by = '' } = {}) {
  const live = await withProject(id, async () => {
    const p = await getProject(id);
    if (!p) throw new Error('project not found');
    const out = [];
    for (const t of p.tasks) {
      if (t.run && ['running', 'review', 'starting'].includes(t.status)) { out.push({ node: t.assign.node, run: t.run }); runEnded(p, t, 'stopped', `paused by ${by || 'Sir'}${reason ? ': ' + reason : ''}`); }
      if (['running', 'starting'].includes(t.status)) { t.status = 'todo'; t.run = null; t.watch = null; }
    }
    if (p.status !== 'done') p.status = 'paused';
    p.paused = { at: Date.now(), by: by || 'Sir', reason: truncate(String(reason || ''), 500) };
    event(p, `paused${by ? ' by ' + by : ''}${reason ? ': ' + truncate(reason, 160) : ''}`);
    await saveProject(p);
    return out;
  });
  for (const x of live) await ctx.call(x.node, 'work/stop', { method: 'POST', body: x.run, timeout: 120000 }).catch((e) => log(`project ${id}: stopping ${x.run.seat || x.run.session?.id}: ${e.message}`));
  return getProject(id);
}

/** Sir picked a paused project up again: back to running, ready tasks start. */
export async function resumeProject(id, ctx) {
  await withProject(id, async () => {
    const p = await getProject(id);
    if (!p) throw new Error('project not found');
    if (p.status !== 'paused') throw new Error(`project is ${p.status}, not paused`);
    p.status = p.tasks.length ? 'running' : 'draft';
    delete p.paused;
    event(p, 'resumed');
    await saveProject(p);
  });
  const p = await getProject(id);
  return p.status === 'running' && ctx ? dispatchReady(id, ctx) : p;
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
  // Who handed it out (JARVIS's overseer seat) and a seat that already holds the context (a follow-up).
  if (spec.source) t.source = String(spec.source);
  if (spec.followUp) t.followUp = String(spec.followUp);
  // The request trace this task belongs to (src/trace.js): its brief names it so later spans attach there.
  const tctx = parseContext(spec.trace);
  if (tctx) t.trace = tctx;
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
    source: body.source, followUp: body.followUp, trace: body.trace,
  }, await ctx.snapshot());
  if (!task.assign) return { project: brief(p), task, started: false, why: task.reason };
  // The main project and projects already running stay "running" (the planner tick tracks them); a project
  // Sir only planned keeps its other tasks waiting — just this one starts.
  const cur = await getProject(p.id);
  if (cur.status === 'paused') return { project: brief(cur), task, started: false, why: 'the project is paused — resume it to start this' };
  if (cur.main || cur.status === 'running' || cur.status === 'done') await saveProject(Object.assign(cur, { status: 'running' }));
  // D1: the task is claimed and placed ("starting") now; the seat is cast in the background, so the brain's reply
  // reaches Sir in seconds. A start that fails is handled where it always was (retryOrFail on the dispatch, the tick).
  const claim = await claimReady(p.id, ctx, { only: task.id });
  const t = claim.p.tasks.find((x) => x.id === task.id);
  const pending = t.status === 'starting';
  if (pending) startClaimed(p.id, ctx, claim, { only: task.id }).catch((e) => log(`project ${p.id} ${t.id}: background start failed: ${e.message}`));
  return {
    project: brief(claim.p),
    task: { id: t.id, title: t.title, kind: t.kind, status: t.status, assign: t.assign, reason: t.reason, run: t.run, summary: t.summary, ...(t.dashboards?.length ? { dashboards: t.dashboards } : {}) },
    // started = claimed and placed on its machine/model; pending = the agent seat is still being cast.
    started: pending || t.status === 'running', pending, ...(pending ? {} : { why: t.reason }),
  };
}

function brief(p) { return { id: p.id, name: p.name, owner: p.owner, main: !!p.main }; }
