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
    tasks: p.tasks.map((t) => ({ id: t.id, title: t.title, kind: t.kind, status: t.status, assign: t.assign })),
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
    dispatch: dispatch || config().routing.dispatch || 'auto', policy: policy || 'builtin:standard',
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

function planningPrompt(p, snapshot) {
  const rules = config().routing.rules.map((r) => `${r.kind}${r.size ? '/' + r.size : ''}${r.tool ? ' [needs ' + r.tool + ']' : ''} → ${r.provider} ${r.model || '(default)'} effort=${r.effort || 'default'}`).join('; ');
  return `You are the planning brain of RIGS, a mesh of the user's workstations with coding agents on each.
Break this project into concrete, independently executable tasks for coding agents.

PROJECT: ${p.name}
GOAL: ${p.goal}
REPOSITORY: ${p.repo.path ? `${p.repo.path} on machine ${p.repo.node}` : 'none given'}${p.gitUrl ? ` (git: ${p.gitUrl})` : ''}

MACHINES:
${meshBrief(snapshot)}

ROUTING POLICY (task kind → provider/model/effort; machines are chosen by RIGS afterwards): ${rules}

Rules:
- 2 to 12 tasks. Each must be doable by one agent in one session and have a verifiable outcome.
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
{"summary":"one sentence","tasks":[{"id":"t1","title":"...","description":"what to do, inputs, definition of done","kind":"code","size":"M","deps":[],"needs":{"platform":"any","gpu":false,"tool":""},"suggest":{"machine":"","provider":"","why":""}}]}`;
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
    status: 'todo', assign: null, reason: '', run: null, summary: '',
  }));
  const ids = new Set(tasks.map((t) => t.id));
  for (const t of tasks) t.deps = t.deps.filter((d) => ids.has(d) && d !== t.id);
  return tasks;
}

/** Ask the planner brain for tasks. Runs on the owner node; the brain may be on any machine. */
export async function planProject(id, ctx, { brain } = {}) {
  const p = await getProject(id);
  if (!p) throw new Error('project not found');
  const b = brain?.provider ? brain : p.planner || coreBrain();
  p.planner = b;
  const snapshot = await ctx.snapshot();
  const prompt = planningPrompt(p, snapshot);
  p.status = 'planning';
  event(p, `planning with ${b.provider} ${b.model || ''} ${b.effort ? '(' + b.effort + ')' : ''} on ${b.node || p.owner}`.replace(/\s+/g, ' '));
  await saveProject(p);
  const out = await ctx.ask(b.node || 'self', prompt, { brain: b.provider, model: b.model, effort: b.effort, title: `Plan · ${p.name}` });
  if (out.error && !out.text) { p.status = 'draft'; event(p, 'planning failed: ' + out.error); await saveProject(p); throw new Error(out.error); }
  let parsed;
  try { parsed = extractJson(out.text); } catch (e) { p.status = 'draft'; event(p, 'planning failed: ' + e.message); await saveProject(p); throw new Error(`${e.message}: ${truncate(out.text, 300)}`); }
  p.tasks = normalizeTasks(parsed);
  p.summary = parsed.summary || '';
  routeProject(p, snapshot);
  p.status = 'planned';
  event(p, `planned ${p.tasks.length} tasks`);
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
  const codeLocal = (t) => ['code', 'test', 'review'].includes(t.kind) && p.repo.path && !p.gitUrl;

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

function taskPrompt(p, t) {
  const done = t.deps.map((d) => p.tasks.find((x) => x.id === d)).filter(Boolean);
  const others = p.tasks.filter((x) => x.id !== t.id && x.status === 'running').map((x) => `- ${x.id} ${x.title} (${x.assign?.provider} on ${x.assign?.node})`);
  return `# ${t.title}

You are one agent in a RIGS project run across the user's machines.

- Project: **${p.name}** (id \`${p.id}\`, coordinated by machine \`${p.owner}\`)
- Project goal: ${p.goal}
- Your task id: \`${t.id}\` · kind: ${t.kind} · size: ${t.size}
- You run on \`${t.assign.node}\` as ${t.assign.provider}${t.assign.model ? ' ' + t.assign.model : ''}${t.assign.effort ? ' (effort ' + t.assign.effort + ')' : ''}

## Task
${t.description}

${done.length ? `## Already finished (inputs for you)\n${done.map((d) => `- ${d.id} ${d.title}${d.summary ? ': ' + d.summary : ''}`).join('\n')}\n` : ''}${others.length ? `## Running in parallel elsewhere\n${others.join('\n')}\n` : ''}
${t.needs?.tool ? `## Tool for this task\nThis machine provides **${t.needs.tool}**${t.toolInfo ? ` — ${t.toolInfo}` : ''}. Use it for the actual generation/processing.\n\n` : ''}## How to work
- Stay inside your task. If you need something from another machine, use the rigs MCP tools (mesh_*).
- To understand existing software, binaries or apps, use REA (the \`rea\` MCP / \`npx -y rea-agents@latest\`).
- Verify your result (tests, a run, or evidence) before reporting.

## When you finish or get stuck
Call the rigs MCP tool \`project_task_update\` with
\`{"owner": "${p.owner}", "project": "${p.id}", "task": "${t.id}", "status": "done" | "blocked" | "failed", "summary": "<what you did, where the result is, or what you need>"}\`.
${'If you are an OpenRig seat, also close your queue item.'}
`;
}

function ready(p, t) {
  return t.status === 'todo' && t.assign && t.deps.every((d) => p.tasks.find((x) => x.id === d)?.status === 'done');
}

/** Start every task whose dependencies are done. */
export async function dispatchReady(id, ctx) {
  const p = await getProject(id);
  if (!p) throw new Error('project not found');
  if (!['planned', 'running'].includes(p.status)) throw new Error(`project is ${p.status}`);
  p.status = 'running';
  const started = [];
  for (const t of p.tasks.filter((x) => ready(p, x))) {
    t.status = 'starting';
    await saveProject(p);
    const workdir = t.assign.node === p.repo.node && p.repo.path ? p.repo.path : `~/rigs-work/${p.slug}`;
    try {
      const r = await ctx.call(t.assign.node, 'work/start', { method: 'POST', body: { project: { id: p.id, slug: p.slug, name: p.name, gitUrl: p.gitUrl }, task: t, prompt: taskPrompt(p, t), workdir, mode: p.dispatch, policy: p.policy }, timeout: 10 * 60 * 1000 });
      t.run = { ...r, startedAt: Date.now() };
      t.status = 'running';
      t.summary = '';
      started.push(t.id);
      event(p, `${t.id} started on ${t.assign.node} via ${r.mode === 'openrig' ? `OpenRig seat ${r.seat}` : `${r.session.kind} ${r.session.id}`}`);
    } catch (e) {
      t.status = 'failed';
      t.summary = 'dispatch failed: ' + e.message;
      event(p, `${t.id} dispatch failed on ${t.assign.node}: ${e.message}`);
    }
    await saveProject(p);
  }
  if (started.length) ctx.notify?.(`${p.name}: started ${started.length} task${started.length > 1 ? 's' : ''} (${started.map((x) => p.tasks.find((t) => t.id === x).assign.node).join(', ')}).`);
  return p;
}

export async function updateTask(id, taskId, { status, summary, assign }, ctx) {
  const p = await getProject(id);
  if (!p) throw new Error('project not found');
  const t = p.tasks.find((x) => x.id === taskId);
  if (!t) throw new Error('task not found');
  if (assign) { t.assign = { ...t.assign, ...assign, locked: true }; t.reason = 'set by hand'; }
  if (status) {
    t.status = status;
    if (summary !== undefined) t.summary = truncate(summary, 4000);
    if (status === 'todo') t.run = null;
    event(p, `${t.id} → ${status}${summary ? ': ' + truncate(summary, 160) : ''}`);
    if (status === 'done') ctx?.notify?.(`${p.name}: task “${t.title}” finished on ${t.assign?.node}.`);
    if (status === 'blocked' || status === 'failed') ctx?.notify?.(`${p.name}: task “${t.title}” is ${status}${summary ? ' — ' + truncate(summary, 140) : ''}.`, 'error');
  }
  if (p.tasks.length && p.tasks.every((x) => x.status === 'done')) { p.status = 'done'; event(p, 'all tasks done'); ctx?.notify?.(`Project ${p.name} is complete.`); }
  await saveProject(p);
  if (p.status === 'running' && ctx) return dispatchReady(id, ctx);
  return p;
}

/** Background loop on the owner node: notice finished seats/sessions and start what became ready. */
export async function tick(ctx) {
  for (const s of await listProjects()) {
    if (s.status !== 'running') continue;
    const p = await getProject(s.id);
    let changed = false;
    for (const t of p.tasks.filter((x) => x.status === 'running' && x.run)) {
      try {
        const st = await ctx.call(t.assign.node, 'work/status', { method: 'POST', body: t.run, timeout: 20000 });
        if (st.state === 'done' && t.status !== 'done') { t.status = 'done'; t.summary ||= `queue item closed (${st.closure || 'done'})`; changed = true; event(p, `${t.id} → done (OpenRig queue)`); }
        else if (st.state === 'ended' && t.status === 'running') { t.status = 'review'; t.summary ||= 'agent session ended without reporting — check its transcript'; changed = true; event(p, `${t.id} session ended`); }
      } catch (e) { log(`project ${p.id} ${t.id}: status check failed: ${e.message}`); }
    }
    if (changed) {
      if (p.tasks.every((x) => x.status === 'done')) { p.status = 'done'; event(p, 'all tasks done'); ctx.notify?.(`Project ${p.name} is complete.`); }
      await saveProject(p);
      if (p.status === 'running') await dispatchReady(p.id, ctx).catch(() => {});
    }
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
