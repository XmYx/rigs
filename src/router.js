// The router: decides where a request goes (answer · implement · plan · continue an ongoing thread) before
// any brain sees it. A small model reads AGENTS.md's rules and the candidates; if it can't answer in time,
// keyword rules decide. Pure functions take their inputs explicitly so they can be tested without a model.
import { claudeFlags } from './models.js';
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
  return out;
}

function routerPrompt(text, { rules, threads, projects }) {
  return [
    'You are the router of JARVIS. Decide where this request goes. Reply with ONLY one JSON object:',
    '{"route":"answer|implement|plan|continue","threadId":"<id if continue>","projectId":"<id of the most relevant active project or empty>","title":"<3-6 word title>","reason":"<one short sentence>"}',
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
  return viaModel ? { ...viaModel, via: 'model' } : { ...heuristicRoute(text, ctx.threads), via: 'rules' };
}

