// The router: decides where a request goes (answer · implement · plan · continue an ongoing thread) before
// any brain sees it ("pre-routing", config.router). A Jev-compatible typed-decision API (LocalJev) or a small Claude
// model makes the call; if neither answers in time, keyword rules decide. Pure functions take their inputs explicitly
// so they can be tested without a model.
import { config } from './config.js';
import { claudeFlags } from './models.js';
import { catalogLines, matchFlow, resolve as resolveWorkspace } from './workspaces.js';
import { bin } from './tools.js';
import { HOME, augmentedPath, run } from './util.js';

export const ROUTES = ['answer', 'implement', 'plan', 'continue'];
export const ENGINES = ['jev', 'claude', 'rules'];
const DEFAULT_ROUTER = {
  preroute: true, engine: 'jev', fallback: 'claude', claudeModel: 'claude-haiku-5-5',
  jev: { url: '', appId: 'localjev', model: 'jev-latest', apiKey: '', timeoutMs: 8000, minProb: 0.55 },
  baselineMs: { answer: 0, work: 0 },
};
const bool = (v, d) => (v === true || v === 'true' || v === 'on' || v === 1 || v === '1' ? true : v === false || v === 'false' || v === 'off' || v === 0 || v === '0' ? false : d);
const clampNum = (v, d, lo, hi) => (Number.isFinite(Number(v)) && v !== '' && v !== null ? Math.min(hi, Math.max(lo, Number(v))) : d);

/** config.router, validated: unknown engines, bad numbers and missing keys fall back to the defaults. Pure. */
export function routerSettings(r = {}) {
  const d = DEFAULT_ROUTER;
  const j = { ...d.jev, ...(r?.jev || {}) };
  return {
    preroute: bool(r?.preroute, d.preroute),
    engine: ENGINES.includes(r?.engine) ? r.engine : d.engine,
    fallback: ['claude', 'rules'].includes(r?.fallback) ? r.fallback : d.fallback,
    claudeModel: String(r?.claudeModel || d.claudeModel),
    jev: {
      url: String(j.url || '').replace(/\/+$/, ''), appId: String(j.appId || ''), model: String(j.model || d.jev.model), apiKey: String(j.apiKey || ''),
      timeoutMs: clampNum(j.timeoutMs, d.jev.timeoutMs, 500, 60000), minProb: clampNum(j.minProb, d.jev.minProb, 0, 1),
    },
    baselineMs: { answer: clampNum(r?.baselineMs?.answer, 0, 0, 36e5), work: clampNum(r?.baselineMs?.work, 0, 0, 36e5) },
  };
}

/** Is pre-routing on for this request? A per-request value (jarvis/send `preroute`) wins over config.router.preroute. */
export function prerouteOn(override, r = config().router) {
  return bool(override, routerSettings(r).preroute);
}

/**
 * A change to config.router (POST /api/local/router, `rigs preroute`) on top of the current one → the new, validated
 * settings. Throws on a value it can't take (unknown engine, non-boolean preroute…) instead of silently ignoring it. Pure.
 */
export function applyRouterPatch(current = {}, b = {}) {
  const cur = routerSettings(current);
  if (b.preroute !== undefined && bool(b.preroute, null) === null) throw new Error('preroute must be true or false');
  if (b.engine !== undefined && !ENGINES.includes(b.engine)) throw new Error(`engine must be one of ${ENGINES.join(', ')}`);
  if (b.fallback !== undefined && !['claude', 'rules'].includes(b.fallback)) throw new Error('fallback must be claude or rules');
  for (const k of ['timeoutMs', 'minProb']) if (b.jev?.[k] !== undefined && !Number.isFinite(Number(b.jev[k]))) throw new Error(`jev.${k} must be a number`);
  const jev = { ...cur.jev, ...(b.jev || {}) };
  if (jev.apiKey === '••••') jev.apiKey = cur.jev.apiKey; // the masked value the view hands out
  return routerSettings({ ...cur, ...b, jev, baselineMs: { ...cur.baselineMs, ...(b.baselineMs || {}) } });
}

/** config.router for the UI / API: validated, key masked, plus where the Jev API resolves to on this machine. */
export function routerView(r = config().router, apps = config().apps || []) {
  const s = routerSettings(r);
  return { ...s, jev: { ...s.jev, apiKey: s.jev.apiKey ? '••••' : '' }, jevUrl: jevUrl(s, apps) };
}

/** Where the Jev API is: jev.url, else the App Cloud app jev.appId registered on this machine. '' when there is none. */
export function jevUrl(s, apps = config().apps || []) {
  if (s.jev.url) return s.jev.url;
  const app = apps.find((a) => a && a.id === s.jev.appId);
  if (!app) return '';
  return app.port ? `http://127.0.0.1:${app.port}` : String(app.url || '').replace(/\/+$/, '');
}
const QUESTION = /^\s*(what|why|how|when|where|who|which|is|are|was|were|did|does|do|can|could|should|would|will)\b|\?\s*$/i;
// A request about JARVIS / RIGS itself: changed in a RIGS dev worktree and shipped through the merge steward.
const SELF = /\b(jarvis|rigs(?: os)?)\b/i;
const WORDS = (s) => new Set(String(s || '').toLowerCase().match(/[a-zà-ž0-9]{4,}/g) || []);

// Leading verbs that ask for something to be made, changed, improved, run or updated.
const IMPERATIVE_VERBS = 'make|build|add|fix|change|improve|update|upgrade|run|deploy|create|rename|remove|delete|refactor|separate|split|set up|setup|implement|write|move|merge|install|enable|disable|stop|start|restart|ensure|rewrite|redesign|replace|clean up|cleanup|extend|connect|wire|configure|patch|migrate|optimi[sz]e|develop|generate|publish|release|commit|test|verify';
// Polite openers that don't change what is being asked: "please", "can you", "lets", "I want you to", "JARVIS,"…
const OPENERS = /^\s*(?:(?:(?:hey|hi|ok|okay|so|and|also|then) )?(?:jarvis|rigs)\b[\s,:;-]*|please\b[\s,]*|(?:can|could|would|will) you(?: please)?\b[\s,]*|(?:i |we )?(?:want|need|would like|'d like|wish) (?:you |us )?to\b[\s,]*|(?:you |we )?(?:should|must|have to|need to|ought to)\b[\s,]*|let'?s\b[\s,]*|let us\b[\s,]*|go ahead and\b[\s,]*|just\b[\s,]*|kindly\b[\s,]*)+/i;
const IMPERATIVE = new RegExp(`^(?:${IMPERATIVE_VERBS})\\b(?!\\s+(?:sense|a difference)\\b)`, 'i');

/** A plain question ("what…?", "how is…") that asks for nothing to be made or changed. */
export function isClearQuestion(text) {
  return QUESTION.test(String(text || '')) && !isImperative(text);
}

/** Is this an imperative work request (after stripping polite openers)? */
export function isImperative(text) {
  const rest = String(text || '').trim().replace(OPENERS, '');
  // "make sure that's not happening" is a request too, although "sure" isn't a verb.
  return IMPERATIVE.test(rest);
}

// "open my Downloads folder", "show me the files in ~/x on magix-system", "show it in Files": a one-step ui_open call.
const BROWSE = /^(?:open(?: up)?|show(?: me)?|browse(?: to)?|bring up|pull up|take me to|go to|navigate to|reveal|jump to)\b/i;
const BROWSE_TARGET = /(?:^|[\s"'(])(?:~|\/|[a-z]:\\)|\b(?:folders?|director(?:y|ies)|dir|files?|downloads|desktop|documents?|home|pdfs?|images?|photos?|pictures?|screenshots?|videos?)\b|\w\.[a-z0-9]{2,5}\b/i;
const NOT_BROWSE = /\b(?:should|so that|instead|make sure|fix|bug|feature|implement|handled?|code|pull request|issue|ticket|apps?|terminal|session|window|dashboard|panel)\b/i;

/** A request to open / show / browse a folder or file in the JARVIS file browser (never work). Pure. */
export function isBrowseRequest(text) {
  const t = String(text || '').trim();
  if (!t || t.length > 200 || isImperative(t)) return false;
  const rest = t.replace(OPENERS, '');
  return BROWSE.test(rest) && BROWSE_TARGET.test(rest) && !NOT_BROWSE.test(rest);
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

// Words too common to say two requests share a subject.
const STOP = new Set('this that these those with from into onto have been were will would should could does done make sure also just only then than them they their there what when where which while about after before again other some such very more most need want lets please jarvis rigs machine machines thing things work working round test'.split(' '));
const SUBJECT = (s) => new Set([...WORDS(s)].filter((w) => !STOP.has(w)));
// Phrases that tie a request to earlier work.
const FOLLOW_ON = /\b(continue|carry on|keep going|pick (it|that|this) up|resume|follow[- ]up|as before|same (task|project|thread|thing)|(that|the) (last|previous|earlier) (task|project|request|one)|again)\b/i;

/** How much of an ongoing thread's subject a request shares: n words, and that as a share of the thread title's words. */
export function threadOverlap(text, title) {
  const a = SUBJECT(text), b = SUBJECT(title);
  const n = [...a].filter((w) => b.has(w)).length;
  return { n, share: b.size ? n / b.size : 0 };
}

/** Keyword rules: the fallback when no model answers, and a sanity check on model output. */
export function heuristicRoute(text, threads = []) {
  const t = String(text || '');
  const best = threads.map((th) => ({ th, ...threadOverlap(t, th.title) })).sort((a, b) => b.n - a.n)[0];
  // A long, several-part goal is new work unless it says it follows on; sharing a few words with an old thread title
  // ("this", a machine name) is not enough to swallow it into that thread's brain without a project.
  const newGoal = hasSeveralParts(t) && !FOLLOW_ON.test(t);
  if (best && !newGoal && (best.n >= 3 || (best.n >= 2 && best.share >= 0.5))) {
    return { route: 'continue', threadId: best.th.id, title: best.th.title, reason: 'shares its subject with an ongoing thread' };
  }
  if (isBrowseRequest(t)) return { route: 'answer', reason: 'opens a folder or file in the file browser' };
  if (newGoal || /\b(plan|roadmap|break (it )?down|end[- ]to[- ]end|from scratch|architecture|design (the|a|an)|several|multi[- ]?(step|part)|phases?|feature)\b/i.test(t) || t.length > 600) {
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
    'A request that asks to implement, build, fix, improve or change something is "implement" (or "plan" when it has several parts), even when it names JARVIS, RIGS or the router itself — "JARVIS feature: …" is work on RIGS, give it workspace "rigs". A request naming a workspace flow ("Mad Mike update" = the flow madmikeupdate) means: run that flow — "implement", bound to that workspace. Polite or casual phrasing does not make a request a question: "can you …", "please …", "lets …", "I want you to …", "make sure …" followed by make/build/add/fix/change/improve/update/run/create/separate are work. Talk ("answer") is only for real questions, status checks, chat and one-step actions like opening a window or reading a file; never answer a work request with a description of what you would do. Opening, showing or browsing a folder or a file ("open the Downloads folder", "open ~/rigs-dev on magix-system", "show me the files in my home folder", "show it in Files") is always "answer": JARVIS opens its file browser there in one step. Only a request to change how that works (fix, make sure, should have…) is work.',
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

/** Ask the Claude router model. Resolves to a decision, or null when it fails or times out. */
export async function modelRoute(text, ctx, { timeoutMs = 25000, model = DEFAULT_ROUTER.claudeModel } = {}) {
  const claude = bin('claude');
  if (!claude) return null;
  const env = { ...process.env, PATH: augmentedPath() };
  for (const k of Object.keys(env)) if (k.startsWith('CLAUDECODE') || k === 'CLAUDE_CODE_ENTRYPOINT') delete env[k];
  const prompt = routerPrompt(text, ctx);
  // ctx.capture (optional) receives what the model was asked and said, for the request trace (src/trace.js).
  if (ctx.capture) Object.assign(ctx.capture, { engine: 'claude', model, prompt, reply: undefined, error: undefined });
  const r = await run(claude, ['-p', prompt, '--output-format', 'text', ...claudeFlags({ model, effort: 'low', permissionMode: 'plan' })],
    { cwd: HOME, env, timeout: timeoutMs });
  if (ctx.capture) Object.assign(ctx.capture, { reply: r.stdout, code: r.code, ...(r.code !== 0 ? { error: String(r.stderr || '').trim().slice(-500) } : {}) });
  if (r.code !== 0) return null;
  return parseDecision(r.stdout, ctx.threads, ctx.projects);
}

const ROUTE_CRITERIA = {
  answer: 'a real question, a status check, chat, or a one-step action like opening a window, opening or showing a folder or file, or reading a file',
  implement: 'one piece of work: asks to make, build, add, fix, change, improve, update or run something (polite phrasing like "can you", "please", "lets" is still work)',
  plan: 'a goal with several parts or several projects that needs planning first',
  continue: 'clearly belongs to one of the ongoing threads listed in the state',
};
const MAX_JEV_WORKSPACES = 40;

/**
 * The Jev request for a routing decision (POST /v1/systemone): a `route` choice decided first in a short pre-pass
 * (LocalJev's `predecide`), then only what that route needs — `thread` for continue, `workspace` for implement/plan,
 * nothing for answer. Pure.
 */
export function jevRequest(text, { threads = [], catalog = [], selfNode = '' } = {}, model = DEFAULT_ROUTER.jev.model) {
  const route = { ...ROUTE_CRITERIA };
  if (!threads.length) delete route.continue;
  const questions = { route: { type: 'choice', instructions: 'Where should JARVIS send this request?', criteria: route } };
  const gates = { answer: [], implement: [], plan: [] };
  if (threads.length) {
    questions.thread = { type: 'choice', instructions: 'Which ongoing thread does this request continue?', criteria: { ...Object.fromEntries(threads.map((t) => [t.id, String(t.title || t.id).slice(0, 120)])), none: 'none of them' } };
    gates.continue = ['thread'];
  }
  const ws = {};
  if (selfNode) ws.rigs = 'RIGS OS / JARVIS itself (this assistant, its router, UI, agents or mesh)';
  for (const c of catalog) for (const w of c.items || []) {
    if (Object.keys(ws).length >= MAX_JEV_WORKSPACES) break;
    const key = `${w.name}@${c.node}`;
    if (!ws[key]) ws[key] = `${w.title || w.name} — folder ${w.name} on ${c.node}`.slice(0, 160);
  }
  if (Object.keys(ws).length) {
    questions.workspace = { type: 'choice', instructions: 'Which code project is this work about?', criteria: { ...ws, none: 'none of these' } };
    gates.implement = gates.plan = ['workspace'];
  }
  const state = [`Request to JARVIS: ${text}`, threads.length ? `Ongoing threads:\n${threads.map((t) => `- ${t.id}: ${t.title}`).join('\n')}` : ''].filter(Boolean).join('\n\n');
  return { model, state, questions, predecide: { question: 'route', enabled: true, gates } };
}

/**
 * A Jev answer → a router decision, or null when it is unusable or not sure enough (the chosen route's probability
 * below minProb, or "continue" without a confident thread): the fallback engine then decides. The workspace pick is
 * kept only when it is confident and the keyword resolver finds nothing in the request itself. Pure.
 */
export function parseJev(resp, { threads = [], catalog = [] } = {}, text = '', minProb = DEFAULT_ROUTER.jev.minProb) {
  const a = resp?.answers;
  const r = a?.route;
  if (!r || !ROUTES.includes(r.choice)) return null;
  const p = (q) => Number(q?.probabilities?.[q.choice] ?? 0);
  if (p(r) < minProb) return null;
  // A small local model can lean towards work for plain questions; a question is never filed as work on its say-so.
  if (['implement', 'plan'].includes(r.choice) && isClearQuestion(text)) return null;
  const d = { route: r.choice, reason: `jev: ${r.choice} (p=${p(r).toFixed(2)})`, title: '', confidence: p(r) };
  if (d.route === 'continue') {
    const th = threads.find((t) => t.id === a.thread?.choice);
    if (!th || p(a.thread) < minProb) return null;
    Object.assign(d, { threadId: th.id, title: th.title });
  }
  const w = a.workspace;
  if (['implement', 'plan'].includes(d.route) && w && w.choice !== 'none' && p(w) >= minProb && !heuristicWork(text, catalog).length) {
    const [name, machine = ''] = String(w.choice).split('@');
    d.work = [{ title: '', goal: text, workspace: name, machine }];
  }
  return d;
}

/** Ask the Jev API. Resolves to a decision, or null when there is none, it fails, times out or is not sure. */
export async function jevRoute(text, ctx, s = routerSettings(), { fetchImpl = fetch, apps } = {}) {
  const url = jevUrl(s, apps);
  if (ctx.capture) Object.assign(ctx.capture, { engine: 'jev', model: `jev ${s.jev.model}`, prompt: undefined, reply: undefined, error: undefined, unsure: false });
  if (!url) { if (ctx.capture) ctx.capture.error = `no Jev API (config.router.jev.url, or an app "${s.jev.appId}" on this machine)`; return null; }
  const body = jevRequest(text, ctx, s.jev.model);
  if (ctx.capture) Object.assign(ctx.capture, { url, prompt: JSON.stringify(body) });
  try {
    const r = await fetchImpl(`${url}/v1/systemone`, {
      method: 'POST', body: JSON.stringify(body), signal: AbortSignal.timeout(s.jev.timeoutMs),
      headers: { 'content-type': 'application/json', ...(s.jev.apiKey ? { authorization: `Bearer ${s.jev.apiKey}` } : {}) },
    });
    const t = await r.text();
    if (ctx.capture) ctx.capture.reply = t;
    if (!r.ok) { if (ctx.capture) ctx.capture.error = `HTTP ${r.status}`; return null; }
    const d = parseJev(JSON.parse(t), ctx, text, s.jev.minProb);
    if (!d && ctx.capture) Object.assign(ctx.capture, { error: 'not confident enough', unsure: true });
    return d;
  } catch (e) { if (ctx.capture) ctx.capture.error = e.message; return null; }
}

/** "- id · name · status (…)" lines (the brain's project list) → [{ id, name, status }]. */
export function parseProjects(text = '') {
  return String(text).split('\n').map((l) => l.match(/^- (\S+) · (.+?) · (\S+)/)).filter(Boolean).map((m) => ({ id: m[1], name: m[2], status: m[3] }));
}

/**
 * The full decision: the configured engine (config.router.engine), then its fallback, then keyword rules. `via` says
 * who decided: jev | model (Claude) | rules; ctx.capture.tried lists engines that could not answer. A plain question
 * Jev answered unsure (capture.unsure) goes to the keyword rules at once rather than the slower fallback. Engines are injectable for tests.
 */
export async function route(text, ctx, { settings = routerSettings(config().router), engines = {} } = {}) {
  const call = { jev: engines.jev || ((t, c) => jevRoute(t, c, settings)), claude: engines.claude || ((t, c) => modelRoute(t, c, { model: settings.claudeModel })) };
  const tried = [];
  for (const e of [...new Set([settings.engine, settings.fallback])]) {
    if (!call[e]) continue; // 'rules'
    const d = await call[e](text, ctx).catch(() => null);
    if (d) { if (ctx.capture && tried.length) ctx.capture.tried = tried; return withWork({ ...d, via: e === 'jev' ? 'jev' : 'model' }, text, ctx); }
    tried.push({ engine: e, error: ctx.capture?.error || 'no answer' });
    // A plain question Jev answered but was unsure about needs no slower model: the keyword rules answer it (or find its
    // thread). Jev being unreachable is different: then the fallback decides, as on machines without LocalJev.
    const h = e === 'jev' && ctx.capture?.unsure && isClearQuestion(text) ? heuristicRoute(text, ctx.threads) : null;
    if (h && (h.route === 'answer' || h.route === 'continue')) {
      if (ctx.capture) ctx.capture.tried = tried;
      return withWork({ ...h, reason: `${h.reason} (jev unsure)`, via: 'rules' }, text, ctx);
    }
  }
  if (ctx.capture && tried.length) ctx.capture.tried = tried;
  return withWork({ ...heuristicRoute(text, ctx.threads), via: 'rules' }, text, ctx);
}

/** Second opinion on the decision + work items bound to folders. Pure given the decision (tested). */
export function withWork(d, text, { catalog = [], selfNode = '' } = {}) {
  d = Object.assign(d, guardRoute(d, text));
  // Opening a folder or file is a one-step ui_open call: never filed as work, whatever the model said.
  if ((d.route === 'implement' || d.route === 'plan') && isBrowseRequest(text)) {
    Object.assign(d, { route: 'answer', reason: 'opens a folder or file in the file browser (ui_open), not work', work: undefined, guarded: true });
    delete d.work;
    return d;
  }
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

