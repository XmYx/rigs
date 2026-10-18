// The router: decides where a request goes (answer · implement · plan · continue an ongoing thread) before
// any brain sees it. A small model reads AGENTS.md's rules and the candidates; if it can't answer in time,
// keyword rules decide. Pure functions take their inputs explicitly so they can be tested without a model.
import { claudeFlags } from './models.js';
import { catalogLines, matchFlow, resolve as resolveWorkspace } from './workspaces.js';
import { bin } from './tools.js';
import { HOME, augmentedPath, run } from './util.js';

export const ROUTES = ['answer', 'implement', 'plan', 'continue'];
const ROUTER_MODEL = 'claude-haiku-5-5';
const QUESTION = /^\s*(what|why|how|when|where|who|which|is|are|was|were|did|does|do|can|could|should|would|will)\b|\?\s*$/i;
// A request about JARVIS / RIGS itself: changed in a RIGS dev worktree and shipped through the merge steward.
const SELF = /\b(jarvis|rigs(?: os)?)\b/i;
const WORDS = (s) => new Set(String(s || '').toLowerCase().match(/[a-zà-ž0-9]{4,}/g) || []);

// Leading verbs that ask for something to be made, changed, improved, run or updated.
const IMPERATIVE_VERBS = 'make|build|add|fix|change|improve|update|upgrade|run|deploy|create|rename|remove|delete|refactor|separate|split|set up|setup|implement|write|move|merge|install|enable|disable|stop|start|restart|ensure|rewrite|redesign|replace|clean up|cleanup|extend|connect|wire|configure|patch|migrate|optimi[sz]e|develop|generate|publish|release|commit|test|verify';
// Polite openers that don't change what is being asked: "please", "can you", "lets", "I want you to", "JARVIS,"…
const OPENERS = /^\s*(?:(?:(?:hey|hi|ok|okay|so|and|also|then) )?(?:jarvis|rigs)\b[\s,:;-]*|please\b[\s,]*|(?:can|could|would|will) you(?: please)?\b[\s,]*|(?:i |we )?(?:want|need|would like|'d like|wish) (?:you |us )?to\b[\s,]*|(?:you |we )?(?:should|must|have to|need to|ought to)\b[\s,]*|let'?s\b[\s,]*|let us\b[\s,]*|go ahead and\b[\s,]*|just\b[\s,]*|kindly\b[\s,]*)+/i;
const IMPERATIVE = new RegExp(`^(?:${IMPERATIVE_VERBS})\\b(?!\\s+(?:sense|a difference)\\b)`, 'i');

/** Is this an imperative work request (after stripping polite openers)? */
export function isImperative(text) {
  const rest = String(text || '').trim().replace(OPENERS, '');
  // "make sure that's not happening" is a request too, although "sure" isn't a verb.
  return IMPERATIVE.test(rest);
}

/** Does the request spell out several parts (a list, several sentences, a very long ask)? Then it is a plan. */
function hasSeveralParts(text) {
  const t = String(text || '').trim();
  if (t.length > 400) return true;
  const joins = (t.match(/,\s*\S|\s(?:and|also|then|plus)\s/gi) || []).length;
  if (joins >= 3) return true;
  const verbs = t.split(/(?:[.;!,]\s+|\s+(?:and|then|also)\s+)/i).filter((c) => isImperative(c.trim().replace(/^(and|then|also)\s+/i, ''))).length;
  return verbs >= 3 || /\b(plan|roadmap|break (it )?down|end[- ]to[- ]end|from scratch|architecture|several|multi[- ]?(step|part)|phases?)\b/i.test(t);
}

/**
 * Deterministic guard on the decision: an imperative work request is never "answer". It is upgraded to implement,
 * or plan when it spans several parts. Questions, status checks and one-step actions the model left as answer
 * (open a window, read a file) are untouched because their leading word is not a work verb.
 */
export function guardRoute(d, text) {
  if (!d || d.route !== 'answer' || !isImperative(text)) return d;
  const route = hasSeveralParts(text) ? 'plan' : 'implement';
  return { ...d, route, reason: `an imperative work request, not a question (${route})`, guarded: true };
}

/** Keyword rules: the fallback when no model answers, and a sanity check on model output. */
export function heuristicRoute(text, threads = []) {
  const t = String(text || '');
  const best = threads
    .map((th) => ({ th, n: [...WORDS(t)].filter((w) => WORDS(th.title).has(w)).length }))
    .sort((a, b) => b.n - a.n)[0];
  if (best && best.n >= 2) return { route: 'continue', threadId: best.th.id, title: best.th.title, reason: 'shares its subject with an ongoing thread' };
  if (/\b(plan|roadmap|break (it )?down|end[- ]to[- ]end|from scratch|architecture|design (the|a|an)|several|multi[- ]?(step|part)|phases?|feature)\b/i.test(t) || t.length > 600) {
    return { route: 'plan', reason: 'a goal with several parts' };
  }
  if (isImperative(t)) return { route: 'implement', reason: 'an imperative work request' };
  if (QUESTION.test(t)) return { route: 'answer', reason: 'a question' };
  if (/\b(implement|build|fix|refactor|patch|develop|wire up|add (a |an |the )?(feature|button|page|endpoint|test)|write (the |a |an )?(code|script|test)|change the code|update the code|bug|commit|deploy|rename|migrate|improve|redesign|optimi[sz]e|make (the|it|this|them) \w+( \w+)? (more|less|faster|better|work)|run the|nightly|(an? |the )?update (on|for|to|of)? ?\w+|upgrade)\b/i.test(t)) {
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
    const r = resolveWorkspace({ text: c, machine: c }, catalog);
    // The machine stays as Sir said it, so binding can tell him when the project lives elsewhere.
    if (r.workspace && !items.some((x) => x.workspace === r.workspace.name)) items.push({ title: '', goal: c, workspace: r.workspace.name, machine: r.elsewhere ? c : r.node });
  }
  return items;
}

/**
 * Bind each work item to a real folder on a real machine. Items that can't be bound clearly come back with
 * candidates (JARVIS asks Sir) — nothing is filed for them.
 */
export function bindWork(items, catalog, request = '', { selfNode = '' } = {}) {
  const out = [];
  let previousNode = '';
  for (const it of items || []) {
    const title = it.title || it.goal.split(/\s+/).slice(0, 5).join(' ');
    const r = resolveWorkspace({ workspace: it.workspace, machine: it.machine, text: it.goal }, catalog, { previousNode });
    // "JARVIS feature: …" is a change to RIGS itself — unless it clearly names some other project. A match on a
    // RIGS checkout (the installed app, a dev clone) is the same thing: never let agents edit the live install.
    const aboutSelf = selfNode && (isRigsCheckout(r.workspace) || (!r.workspace && SELF.test(`${it.workspace} ${it.goal}`)));
    if (aboutSelf) {
      previousNode = selfNode;
      out.push({ ...it, title, request, node: selfNode, self: true, workspace: SELF_WORKSPACE });
    } else if (r.workspace) {
      previousNode = r.node;
      out.push({ ...it, title, request, node: r.node, workspace: r.workspace, flow: r.flow || null, score: r.score, alternatives: r.alternatives,
        ...(r.elsewhere ? { note: `asked for ${r.wanted.join('/') || it.machine}, but ${r.workspace.name} lives on ${r.node} — it runs there` } : {}) });
    } else out.push({ ...it, title, request, unresolved: true, candidates: r.candidates || [] });
  }
  return out;
}

/** The workspace a RIGS self-change is bound to (the folder itself is a fresh dev worktree, made at filing time). */
export const SELF_WORKSPACE = { name: 'rigs', title: 'RIGS OS · JARVIS', kinds: ['git', 'node'], guides: ['AGENTS.md'], parts: [], self: true };

export function isRigsCheckout(ws) {
  return !!ws && (ws.self || /^RIGS OS\b/.test(ws.title || '') || /[\\/]\.rigs[\\/]app$/.test(ws.path || ''));
}

/** Does the request name a known flow (a project's scheduled job)? Then it is work, not chat. */
export function namedFlow(text, catalog = []) {
  for (const c of catalog) for (const ws of c.items || []) { const f = matchFlow(text, ws); if (f) return { node: c.node, workspace: ws, flow: f }; }
  return null;
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
    'A request that asks to implement, build, fix, improve or change something is "implement" (or "plan" when it has several parts), even when it names JARVIS, RIGS or the router itself — "JARVIS feature: …" is work on RIGS, give it workspace "rigs". A request naming a workspace flow ("Mad Mike update" = the flow madmikeupdate) means: run that flow — "implement", bound to that workspace. Polite or casual phrasing does not make a request a question: "can you …", "please …", "lets …", "I want you to …", "make sure …" followed by make/build/add/fix/change/improve/update/run/create/separate are work. Talk ("answer") is only for real questions, status checks, chat and one-step actions like opening a window or reading a file; never answer a work request with a description of what you would do.',
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
  const prompt = routerPrompt(text, ctx);
  // ctx.capture (optional) receives what the model was asked and said, for the request trace (src/trace.js).
  if (ctx.capture) Object.assign(ctx.capture, { model: ROUTER_MODEL, prompt });
  const r = await run(claude, ['-p', prompt, '--output-format', 'text', ...claudeFlags({ model: ROUTER_MODEL, effort: 'low', permissionMode: 'plan' })],
    { cwd: HOME, env, timeout: timeoutMs });
  if (ctx.capture) Object.assign(ctx.capture, { reply: r.stdout, code: r.code, ...(r.code !== 0 ? { error: String(r.stderr || '').trim().slice(-500) } : {}) });
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
  return withWork(d, text, ctx);
}

/** Second opinion on the decision + work items bound to folders. Pure given the decision (tested). */
export function withWork(d, text, { catalog = [], selfNode = '' } = {}) {
  d = Object.assign(d, guardRoute(d, text));
  // Requests that are clearly work never stay as talk: a named flow, or "JARVIS feature: …".
  if (d.route === 'answer' || d.route === 'continue') {
    const flow = !QUESTION.test(text) && namedFlow(text, catalog);
    const self = selfNode && !QUESTION.test(text) && SELF.test(text) && heuristicRoute(text).route !== 'answer';
    if (flow) Object.assign(d, { route: 'implement', reason: `runs the ${flow.flow.name} flow of ${flow.workspace.name}`, threadId: undefined });
    else if (self) Object.assign(d, { route: heuristicRoute(text).route, reason: 'a change to JARVIS itself', threadId: undefined });
  }
  if (['implement', 'plan'].includes(d.route) && (catalog.length || selfNode)) {
    let items = d.work?.length ? d.work : heuristicWork(text, catalog);
    if (!items.length && selfNode && SELF.test(text)) items = [{ title: '', goal: text, workspace: 'rigs', machine: '' }];
    d.work = bindWork(items, catalog, text, { selfNode });
  }
  return d;
}

