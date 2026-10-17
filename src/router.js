// The router: decides where a request goes (answer · implement · plan · continue an ongoing thread) before
// any brain sees it. A small model reads AGENTS.md's rules and the candidates; if it can't answer in time,
// keyword rules decide. Pure functions take their inputs explicitly so they can be tested without a model.
import { claudeFlags } from './models.js';
import { catalogLines, resolve as resolveWorkspace } from './workspaces.js';
import { bin } from './tools.js';
import { HOME, augmentedPath, run } from './util.js';

export const ROUTES = ['answer', 'implement', 'plan', 'continue'];
const ROUTER_MODEL = 'claude-haiku-5-5';
const WORDS = (s) => new Set(String(s || '').toLowerCase().match(/[a-zà-ž0-9]{4,}/g) || []);

/** Keyword rules: the fallback when no model answers, and a sanity check on model output. */
export function heuristicRoute(text, threads = []) {
  const t = String(text || '');
  const best = threads
    .map((th) => ({ th, n: [...WORDS(t)].filter((w) => WORDS(th.title).has(w)).length }))
    .sort((a, b) => b.n - a.n)[0];
  if (best && best.n >= 2) return { route: 'continue', threadId: best.th.id, title: best.th.title, reason: 'shares its subject with an ongoing thread' };
  if (/\b(plan|roadmap|break (it )?down|end[- ]to[- ]end|from scratch|architecture|design (the|a|an)|several|multi[- ]?(step|part)|phases?)\b/i.test(t) || t.length > 600) {
    return { route: 'plan', reason: 'a goal with several parts' };
  }
  if (/\b(implement|build|fix|refactor|patch|develop|wire up|add (a |an |the )?(feature|button|page|endpoint|test)|write (the |a |an )?(code|script|test)|change the code|update the code|bug|commit|deploy|rename|migrate)\b/i.test(t)) {
    return { route: 'implement', reason: 'a code or build change' };
  }
  return { route: 'answer', reason: 'can be answered now' };
}

/** Validate a model's JSON decision against the real threads and projects. Returns null when unusable. */
export function parseDecision(raw, threads = [], projects = []) {
  const m = String(raw || '').match(/\{[\s\S]*\}/);
  if (!m) return null;
  let d;
  try { d = JSON.parse(m[0]); } catch { return null; }
  if (!ROUTES.includes(d.route)) return null;
  const out = { route: d.route, reason: String(d.reason || '').slice(0, 160), title: String(d.title || '').slice(0, 80) };
  if (d.route === 'continue') {
    const th = threads.find((x) => x.id === d.threadId);
    if (!th) return null; // the model named a thread that isn't a candidate
    out.threadId = th.id;
    out.title = th.title;
  }
  if (d.projectId && projects.some((p) => p.id === d.projectId)) out.projectId = d.projectId;
  if (['implement', 'plan'].includes(out.route) && Array.isArray(d.work)) {
    out.work = d.work.slice(0, 6).filter((w) => w && typeof w === 'object' && String(w.goal || w.title || '').trim()).map((w) => ({
      title: String(w.title || '').slice(0, 60), goal: String(w.goal || w.title).slice(0, 1200),
      workspace: String(w.workspace || '').slice(0, 120), machine: String(w.machine || '').slice(0, 80),
    }));
  }
  return out;
}

/**
 * Keyword fallback for work items: one item per workspace the request names (clauses split on "and"/";").
 * Only used when the router model can't answer.
 */
export function heuristicWork(text, catalog) {
  const clauses = String(text || '').split(/;|\.\s|\band (?:also |then )?(?=\w+\b)/i).map((c) => c.trim()).filter((c) => c.length > 6);
  const items = [];
  for (const c of clauses) {
    const r = resolveWorkspace({ text: c }, catalog);
    if (r.workspace && !items.some((x) => x.workspace === r.workspace.name)) items.push({ title: '', goal: c, workspace: r.workspace.name, machine: r.node });
  }
  return items;
}

/**
 * Bind each work item to a real folder on a real machine. Items that can't be bound clearly come back with
 * candidates (JARVIS asks Sir) — nothing is filed for them.
 */
export function bindWork(items, catalog, request = '') {
  const out = [];
  let previousNode = '';
  for (const it of items || []) {
    const r = resolveWorkspace({ workspace: it.workspace, machine: it.machine, text: it.goal }, catalog, { previousNode });
    const title = it.title || it.goal.split(/\s+/).slice(0, 5).join(' ');
    if (r.workspace) {
      previousNode = r.node;
      out.push({ ...it, title, request, node: r.node, workspace: r.workspace, score: r.score, alternatives: r.alternatives });
    } else out.push({ ...it, title, request, unresolved: true, candidates: r.candidates || [] });
  }
  return out;
}

function routerPrompt(text, { rules, threads, projects, catalog = [] }) {
  const ws = catalogLines(catalog);
  return [
    'You are the router of JARVIS. Decide where this request goes. Reply with ONLY one JSON object:',
    '{"route":"answer|implement|plan|continue","threadId":"<id if continue>","projectId":"<id of the most relevant active project or empty>","title":"<3-6 word title>","reason":"<one short sentence>","work":[{"title":"<3-6 words>","goal":"<the part of the request this item covers, in the user\'s words, with its details>","workspace":"<workspace name from WORKSPACES, or the name as the user said it>","machine":"<machine name from WORKSPACES>"}]}',
    '',
    'work: for "implement" and "plan" only — one entry per independent piece of work. Split a request that names several projects or goals into separate entries, each with its own workspace. Users misspell or nickname projects ("MadMikeUnity" may be the folder MadMaxUnity whose guide is titled "Mad Mike\'s Garage"): match by meaning against names AND titles. "the linux machine", "the same machine" → the concrete machine name. Leave workspace empty only when the work is not about any listed workspace. Empty list for answer/continue.',
    '',
    'Operating rules:',
    rules,
    '',
    'A request that asks to implement, build, fix or change code is "implement", even when it names JARVIS, RIGS or the router itself.',
    '',
    'Ongoing threads (continue ONLY if the request clearly belongs to one; otherwise do not pick one):',
    threads.length ? threads.map((t) => `- ${t.id} · ${t.title} · project ${t.project || '—'}`).join('\n') : '(none)',
    '',
    'Active projects:',
    projects.length ? projects.map((p) => `- ${p.id} · ${p.name} · ${p.status}`).join('\n') : '(none)',
    '',
    'WORKSPACES (code projects on each machine: machine (os): folder — "title from its guide" [kinds] path):',
    ws.length ? ws.join('\n') : '(none known)',
    '',
    `Request: ${text}`,
  ].join('\n');
}

/** Ask the router model. Resolves to a decision, or null when it fails or times out. */
export async function modelRoute(text, ctx, { timeoutMs = 25000 } = {}) {
  const claude = bin('claude');
  if (!claude) return null;
  const env = { ...process.env, PATH: augmentedPath() };
  for (const k of Object.keys(env)) if (k.startsWith('CLAUDECODE') || k === 'CLAUDE_CODE_ENTRYPOINT') delete env[k];
  const r = await run(claude, ['-p', routerPrompt(text, ctx), '--output-format', 'text', ...claudeFlags({ model: ROUTER_MODEL, effort: 'low', permissionMode: 'plan' })],
    { cwd: HOME, env, timeout: timeoutMs });
  if (r.code !== 0) return null;
  return parseDecision(r.stdout, ctx.threads, ctx.projects);
}

/** "- id · name · status (…)" lines (the brain's project list) → [{ id, name, status }]. */
export function parseProjects(text = '') {
  return String(text).split('\n').map((l) => l.match(/^- (\S+) · (.+?) · (\S+)/)).filter(Boolean).map((m) => ({ id: m[1], name: m[2], status: m[3] }));
}

/** The full decision: model first, keyword rules when the model can't say. */
export async function route(text, ctx) {
  const viaModel = await modelRoute(text, ctx).catch(() => null);
  const d = viaModel ? { ...viaModel, via: 'model' } : { ...heuristicRoute(text, ctx.threads), via: 'rules' };
  if (['implement', 'plan'].includes(d.route) && ctx.catalog?.length) {
    const items = d.work?.length ? d.work : heuristicWork(text, ctx.catalog);
    d.work = bindWork(items, ctx.catalog, text);
  }
  return d;
}

