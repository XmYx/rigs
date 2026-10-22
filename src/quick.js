// The quick-task fast path (config.quick): a request the router classified "answer" — a question, a web search, a quick
// tool use, a summary, a short report — runs as one bounded brain turn on a cheaper model instead of the full JARVIS
// brain: Haiku at effort low for simple asks, Sonnet at effort medium for web research, multi-step tool use or reports.
// Same persona, same rigs MCP and WebSearch/WebFetch; no project, jarvis_task or OpenRig seat is involved unless the
// fast brain files work itself. Everything here is pure (src/chat.js runs the turn) and tested in test/quick.test.js.
import { PROVIDERS } from './models.js';

export const TIERS = ['haiku', 'sonnet'];
// The fast path runs on the Claude Code harness (`claude -p`); the tiers name a model in its catalog.
export const QUICK_PROVIDERS = ['claude'];
const DEFAULT_QUICK = {
  enabled: true,
  simple: { provider: 'claude', model: 'claude-haiku-5-5', effort: 'low' },
  standard: { provider: 'claude', model: 'claude-sonnet-5-5', effort: 'medium' },
  // stallMs: the quick-lane watchdog — a Claude fast turn that shows no progress (no delta, tool or tool-done event) for
  // this long, once past the cold-start grace, is stopped and handed to the full brain like [[ESCALATE]]. 0 = off.
  maxTurns: 8, timeoutMs: 90000, stallMs: 20000,
};
/** The fast brain says it needs the full brain with this marker (then a short reason); the request re-runs there. */
export const ESCALATE_MARKER = '[[ESCALATE]]';
/** A fast turn's first seconds (harness boot, MCP start, the first model call) count as progress: no stall before this. */
export const QUICK_STALL_GRACE_MS = 8000;
/** Stream events that show a fast turn is getting somewhere. */
export const QUICK_PROGRESS_EVENTS = ['delta', 'tool', 'tool-done'];

/**
 * The quick-lane watchdog's timing decision: has the turn stalled? A turn stalls when nothing has arrived for `stallMs`
 * since its last progress event — or, before any event, since the end of the cold-start grace (graceMs after start).
 * → { stalled, reason, checkInMs }: checkInMs says when to look again if nothing else happens (0 when stalled or off). Pure.
 */
export function quickStall({ now = Date.now(), startedAt = now, lastEventAt = 0, stallMs = DEFAULT_QUICK.stallMs, graceMs = QUICK_STALL_GRACE_MS } = {}) {
  const limit = Number(stallMs) || 0;
  if (limit <= 0) return { stalled: false, reason: '', checkInMs: 0 };
  const since = Math.max(Number(lastEventAt) || 0, startedAt + graceMs);
  const idle = now - since;
  if (idle >= limit) return { stalled: true, reason: `quick turn made no progress for ${Math.round(limit / 1000)} s`, checkInMs: 0 };
  return { stalled: false, reason: '', checkInMs: limit - idle };
}

/**
 * The local first responder (config.quick.local, src/responder.js, design in docs/local-responder.md): a model on a
 * machine's own Ollama answers the fast path's tiers it lists, with read-only tools only. Off by default.
 * READ_ONLY_TOOLS is the hard limit: config can narrow it, never widen it. ui_open is in it because it changes only what
 * the JARVIS screen shows (it opens the file browser at a folder), never data: "open my Downloads" stays local.
 */
export const READ_ONLY_TOOLS = ['mesh_status', 'mesh_sessions', 'mesh_apps', 'project_list', 'mesh_processes', 'usage_report', 'trace_list', 'ui_open'];
const DEFAULT_LOCAL = {
  enabled: false, node: '', model: 'qwen3:8b', tiers: ['haiku'], tools: READ_ONLY_TOOLS,
  think: false, numCtx: 16384, keepAlive: '30m', maxRounds: 4, guard: true, firstTokenMs: 2500, timeoutMs: 30000,
};

const bool = (v, d) => (v === true || v === 'true' || v === 'on' || v === 1 || v === '1' ? true : v === false || v === 'false' || v === 'off' || v === 0 || v === '0' ? false : d);
const clampNum = (v, d, lo, hi) => (Number.isFinite(Number(v)) && v !== '' && v !== null ? Math.min(hi, Math.max(lo, Math.round(Number(v)))) : d);
const KEEP_ALIVE = /^(?:-1|0|\d+(?:\.\d+)?(?:ms|s|m|h)?)$/;

/**
 * config.quick.local, validated: { enabled, node ('' = the machine running the fast path), model, tiers, tools (only
 * names in READ_ONLY_TOOLS survive), think, numCtx, keepAlive, maxRounds, guard, firstTokenMs, timeoutMs }. Pure.
 */
export function localSettings(l = {}) {
  const d = DEFAULT_LOCAL;
  const tiers = Array.isArray(l?.tiers) ? [...new Set(l.tiers.map((x) => String(x).trim().toLowerCase()).filter((x) => TIERS.includes(x)))] : d.tiers;
  const tools = Array.isArray(l?.tools) ? [...new Set(l.tools.map(String).filter((x) => READ_ONLY_TOOLS.includes(x)))] : d.tools;
  return {
    enabled: bool(l?.enabled, d.enabled),
    node: typeof l?.node === 'string' ? l.node.trim() : d.node,
    model: String(l?.model || '').trim() || d.model,
    tiers,
    tools,
    think: bool(l?.think, d.think),
    numCtx: clampNum(l?.numCtx, d.numCtx, 2048, 131072),
    keepAlive: KEEP_ALIVE.test(String(l?.keepAlive ?? '')) ? String(l.keepAlive) : d.keepAlive,
    maxRounds: clampNum(l?.maxRounds, d.maxRounds, 1, 10),
    guard: bool(l?.guard, d.guard),
    firstTokenMs: clampNum(l?.firstTokenMs, d.firstTokenMs, 200, 60000),
    timeoutMs: clampNum(l?.timeoutMs, d.timeoutMs, 2000, 600000),
  };
}

function tierSettings(t, d) {
  const provider = QUICK_PROVIDERS.includes(t?.provider) ? t.provider : d.provider;
  const efforts = PROVIDERS[provider]?.efforts || [];
  return { provider, model: String(t?.model || d.model), effort: efforts.includes(t?.effort) ? t.effort : d.effort };
}

/** config.quick, validated: unknown providers/efforts, bad numbers and missing keys fall back to the defaults. Pure. */
export function quickSettings(q = {}) {
  const d = DEFAULT_QUICK;
  return {
    enabled: bool(q?.enabled, d.enabled),
    simple: tierSettings(q?.simple, d.simple),
    standard: tierSettings(q?.standard, d.standard),
    maxTurns: clampNum(q?.maxTurns, d.maxTurns, 1, 50),
    timeoutMs: clampNum(q?.timeoutMs, d.timeoutMs, 5000, 600000),
    stallMs: clampNum(q?.stallMs, d.stallMs, 0, 600000),
    // only when configured: a config without it reads exactly as before (the responder's defaults: localSettings())
    ...(q?.local !== undefined && q?.local !== null ? { local: localSettings(q.local) } : {}),
  };
}

/**
 * A change to config.quick (POST /api/local/quick, `rigs quick`) on top of the current one → the new, validated
 * settings. Throws on a value it can't take instead of silently ignoring it. Pure.
 */
export function applyQuickPatch(current = {}, b = {}) {
  const cur = quickSettings(current);
  if (b.enabled !== undefined && bool(b.enabled, null) === null) throw new Error('enabled must be true or false');
  for (const k of ['simple', 'standard']) {
    const t = b[k];
    if (t === undefined) continue;
    if (!t || typeof t !== 'object') throw new Error(`${k} must be { provider, model, effort }`);
    const provider = t.provider ?? cur[k].provider;
    if (!QUICK_PROVIDERS.includes(provider)) throw new Error(`${k}.provider must be one of ${QUICK_PROVIDERS.join(', ')}`);
    if (t.effort !== undefined && !PROVIDERS[provider].efforts.includes(t.effort)) throw new Error(`${k}.effort must be one of ${PROVIDERS[provider].efforts.join(', ')}`);
    if (t.model !== undefined && !String(t.model).trim()) throw new Error(`${k}.model must not be empty`);
  }
  for (const k of ['maxTurns', 'timeoutMs', 'stallMs']) if (b[k] !== undefined && !Number.isFinite(Number(b[k]))) throw new Error(`${k} must be a number`);
  const local = b.local === undefined ? undefined : checkLocalPatch(b.local);
  return quickSettings({ ...cur, ...b, simple: { ...cur.simple, ...(b.simple || {}) }, standard: { ...cur.standard, ...(b.standard || {}) },
    ...(local ? { local: { ...localSettings(cur.local), ...local } } : {}) });
}

/** A `local` patch, checked: throws on a value it can't take. Pure. */
function checkLocalPatch(l) {
  if (!l || typeof l !== 'object' || Array.isArray(l)) throw new Error('local must be { enabled, node, model, … }');
  for (const k of ['enabled', 'think', 'guard']) if (l[k] !== undefined && bool(l[k], null) === null) throw new Error(`local.${k} must be true or false`);
  if (l.model !== undefined && !String(l.model).trim()) throw new Error('local.model must not be empty');
  if (l.node !== undefined && typeof l.node !== 'string') throw new Error('local.node must be a machine name (or "" for this machine)');
  if (l.tiers !== undefined && (!Array.isArray(l.tiers) || l.tiers.some((t) => !TIERS.includes(String(t).toLowerCase())))) throw new Error(`local.tiers must be a list of ${TIERS.join(', ')}`);
  if (l.tools !== undefined && (!Array.isArray(l.tools) || l.tools.some((t) => !READ_ONLY_TOOLS.includes(t)))) throw new Error(`local.tools must be among the read-only tools: ${READ_ONLY_TOOLS.join(', ')}`);
  for (const k of ['numCtx', 'maxRounds', 'firstTokenMs', 'timeoutMs']) if (l[k] !== undefined && !Number.isFinite(Number(l[k]))) throw new Error(`local.${k} must be a number`);
  if (l.keepAlive !== undefined && !KEEP_ALIVE.test(String(l.keepAlive))) throw new Error('local.keepAlive must be an Ollama duration like "30m", "1h" or -1');
  return l;
}

/**
 * The per-request override (jarvis/send `quick`): true | false | 'haiku' | 'sonnet' | 'local', or undefined (use
 * config). 'local' = the fast path on the local responder for this request. Pure.
 */
export function quickOverride(v) {
  if (v === undefined || v === null || v === '') return undefined;
  const s = String(v).toLowerCase();
  if (TIERS.includes(s) || s === 'local') return s;
  if (s === 'simple') return 'haiku';
  if (s === 'standard') return 'sonnet';
  return bool(v, undefined);
}

// Asks that need a stronger model: the web, research, reports, comparisons, several machines at once, depth.
const STANDARD_WORDS = /\b(search(?:es|ing)?|research|browse|google|the web|web|online|internet|latest|news|current (?:version|release)|reports?|compare|comparison|versus|vs\.?|analy[sz]e|analysis|investigate|benchmark|pros and cons|trade-?offs?|in (?:depth|detail)|thorough(?:ly)?|step by step|explain why|across (?:all|every|the)|each (?:machine|node|project)|every (?:machine|node|project)|all (?:the )?(?:machines|nodes|projects|sessions))\b/i;
// Asks that one quick call answers: a lookup, a status, a single read.
const SIMPLE_WORDS = /\b(look up|lookup|what(?:'s| is) the|time|date|status|read|show|list|open|check|how much|how many|define|definition|spell|translate)\b/i;
const SUMMARY = /\b(summari[sz]e|summary|tl;?dr|recap|gist|condense|shorten)\b/i;
const MULTI_STEP = /\b(?:and then|after that|afterwards|followed by)\b|,\s*then\b|\bfirst\b.*\bthen\b/i;
const SIMPLE_MAX_CHARS = 2000; // a summary of up to about this much text stays on the simple tier
const SIMPLE_MAX_ASK = 300; // a question longer than this is not a "short single question"

/**
 * The instruction part of a request: what comes before pasted material ("summarize this: <text>"), so words inside the
 * material ("report", "web") don't decide the tier. The whole request when nothing is pasted. Pure.
 */
export function askPart(text) {
  const t = String(text || '').trim();
  const m = t.match(/^([^\n:]{1,240})[:\n]\s*([\s\S]+)$/);
  return m && m[2].length >= 80 ? m[1].trim() : t;
}

/**
 * Which fast-path tier a request needs, with the reason: { tier: 'haiku' | 'sonnet', why }. 'haiku' for simple asks —
 * a short single question, a lookup, a single tool call, a summary of under about 2k chars; 'sonnet' for web research,
 * multi-step tool use, reports and comparisons. Signals: an explicit hint (routeInfo.tier / routeInfo.quick, e.g. from
 * the router or the request), length, and keywords in the instruction part. Pure.
 */
export function quickTierWhy(request, routeInfo = {}) {
  const hint = quickOverride(routeInfo?.tier ?? routeInfo?.quick);
  if (TIERS.includes(hint)) return { tier: hint, why: `hint: ${hint}` };
  const text = String(request || '').trim();
  const ask = askPart(text);
  if (SUMMARY.test(ask) && !STANDARD_WORDS.test(ask.replace(SUMMARY, ''))) {
    return text.length <= SIMPLE_MAX_CHARS ? { tier: 'haiku', why: 'a summary of short text' } : { tier: 'sonnet', why: `a summary of ${text.length} chars` };
  }
  const w = ask.match(STANDARD_WORDS);
  if (w) return { tier: 'sonnet', why: `asks for "${w[0].toLowerCase()}"` };
  if (text.length > SIMPLE_MAX_CHARS) return { tier: 'sonnet', why: `a long request (${text.length} chars)` };
  if ((ask.match(/\?/g) || []).length >= 2 || MULTI_STEP.test(ask)) return { tier: 'sonnet', why: 'several steps or questions' };
  if (ask.length > SIMPLE_MAX_ASK) return { tier: 'sonnet', why: `a long ask (${ask.length} chars)` };
  const s = ask.match(SIMPLE_WORDS);
  return { tier: 'haiku', why: s ? `a quick ${s[0].toLowerCase()}` : 'a short single ask' };
}

/** quickTierWhy without the reason: 'haiku' | 'sonnet'. Pure. */
export function quickTier(request, routeInfo = {}) {
  return quickTierWhy(request, routeInfo).tier;
}

/**
 * Does this request take the fast path, and on which model? → { on: true, tier, why, provider, model, effort,
 * maxTurns, timeoutMs, stallMs, forced } or { on: false, reason }. Only requests routed "answer" qualify. A per-request
 * override (`quick`) wins over config.quick.enabled: false keeps the previous behaviour exactly, true / 'haiku' /
 * 'sonnet' force the fast path (a tier name also forces that tier). Without an override the fast path also stays out
 * of the way when the request asked for a brain other than Claude (Codex, Ollama, Claude via Ollama). Pure.
 */
export function resolveQuick({ text = '', route = '', override, brain = '', routeInfo = {}, settings } = {}) {
  const s = quickSettings(settings);
  const o = quickOverride(override);
  if (o === false) return { on: false, reason: 'quick: false on this request' };
  if (route !== 'answer') return { on: false, reason: route ? `routed ${route}` : 'not pre-routed' };
  if (o === undefined && !s.enabled) return { on: false, reason: 'config.quick.enabled is false' };
  if (o === undefined && brain && !['auto', 'claude'].includes(brain)) return { on: false, reason: `the ${brain} brain was asked for` };
  const t = TIERS.includes(o) ? { tier: o, why: `quick: ${o} on this request` } : quickTierWhy(text, routeInfo);
  const cfg = t.tier === 'haiku' ? s.simple : s.standard;
  return { on: true, tier: t.tier, why: t.why, provider: cfg.provider, model: cfg.model, effort: cfg.effort, maxTurns: s.maxTurns, timeoutMs: s.timeoutMs, stallMs: s.stallMs, forced: o !== undefined,
    // a tier named on the request means that Claude model; 'local' means the local responder (localResponder)
    ...(TIERS.includes(o) ? { forcedTier: o } : {}), ...(o === 'local' ? { local: true } : {}) };
}

/**
 * Data that changes from day to day and that no read-only mesh tool returns (weather, prices, scores…). The local
 * responder has no web tools: asked about these, qwen3:8b invents an answer ("sunny, 22 °C") or declines, where the
 * Haiku turn searches. Such asks stay on the Claude tier. ("latest", "news", "search" already pick the Sonnet tier.)
 */
const LIVE_INFO = /\b(weather|forecast|rain(?:ing|y)?|snow(?:ing|y)?|prices?|stocks?|exchange rates?|bitcoin|btc|ethereum|crypto(?:currency)?|scores?|headlines?|traffic|flights?|elections?)\b/i;
/** The live-data word in a request's ask, or ''. Pure. */
export function liveInfo(text) { return (askPart(text).match(LIVE_INFO)?.[0] || '').toLowerCase(); }

/**
 * Does this fast-path turn (`q` from resolveQuick) run on the local responder? → { on: true, ...localSettings, node }
 * (node '' resolves to `self`) or { on: false, reason }. On when config.quick.local is enabled and lists the turn's tier,
 * or when the request asked for it (quick: 'local'); never when the request named a Claude tier, and not for a `text`
 * that asks about live data (liveInfo) unless the request asked for the local responder. Pure.
 */
export function localResponder(q, quick = {}, { self = '', text = '' } = {}) {
  if (!q?.on) return { on: false, reason: 'not on the fast path' };
  if (q.forcedTier) return { on: false, reason: `quick: ${q.forcedTier} on this request` };
  const l = localSettings(quick?.local);
  if (!q.local) {
    if (!l.enabled) return { on: false, reason: 'config.quick.local.enabled is false' };
    if (!l.tiers.includes(q.tier)) return { on: false, reason: `the ${q.tier} tier is not in quick.local.tiers` };
    const live = liveInfo(text);
    if (live) return { on: false, reason: `asks about ${live}: live data the local responder has no tool for` };
  }
  if (!l.tools.length) return { on: false, reason: 'quick.local.tools is empty' };
  return { on: true, ...l, node: l.node || self, forced: !!q.local };
}

/**
 * A fast-path tier mapped through this machine's brain catalog (chat.availableBrains()): the provider must be there,
 * the model is passed through as typed (like any model id in the UI), an effort the provider doesn't list is dropped.
 * → { brain, model, effort } or null when the provider isn't available here. Pure.
 */
export function quickBrain(q, brains = []) {
  const b = brains.find((x) => x.id === q?.provider && x.available !== false);
  if (!b) return null;
  return { brain: b.id, model: q.model || b.default || '', effort: (b.efforts || []).includes(q.effort) ? q.effort : '' };
}

/** The fast brain's reply → { reason } when it asked for the full brain (ESCALATE_MARKER), else null. Pure. */
export function parseEscalation(text) {
  const t = String(text || '');
  const i = t.toUpperCase().indexOf(ESCALATE_MARKER);
  if (i < 0) return null;
  return { reason: t.slice(i + ESCALATE_MARKER.length).split('\n').map((l) => l.trim()).find(Boolean)?.slice(0, 200) || 'needs the full brain' };
}

/**
 * Wraps a turn's emit so a reply that opens with ESCALATE_MARKER never reaches the screen: text deltas are held while
 * they could still be the marker, then passed on (not the marker) or swallowed (the marker: the full brain answers).
 * Other events pass straight through. flush() releases what is held when the turn ends.
 */
export function escalationGate(emit) {
  let held = [];
  let buf = '';
  let state = 'holding'; // holding | open | escalating
  const release = () => { for (const e of held) emit(e); held = []; state = 'open'; };
  return {
    emit(e) {
      if (e?.type !== 'delta' || state === 'open') return emit(e);
      if (state === 'escalating') return undefined;
      held.push(e);
      buf += e.text || '';
      const head = buf.trimStart().toUpperCase();
      if (head.startsWith(ESCALATE_MARKER)) { state = 'escalating'; held = []; } else if (!ESCALATE_MARKER.startsWith(head)) release();
      return undefined;
    },
    flush() { if (state === 'holding') release(); },
    get escalating() { return state === 'escalating'; },
  };
}

/** The extra system-prompt paragraph for a fast-path turn. Pure. */
export function quickNote({ model = '', maxTurns = DEFAULT_QUICK.maxTurns } = {}) {
  return [
    `# Fast path`,
    `This turn runs on JARVIS's fast path (${model || 'a smaller model'}, at most ${maxTurns} tool turns): answer the question, do the quick lookup, search or tool call, summary or short report yourself, briefly, in character.`,
    `Substantial work (writing or changing code, building, long multi-step jobs) is still filed with jarvis_task as usual.`,
    `Opening or showing a folder or file ("open my Downloads", "show me the files in …", "show it in Files") is one ui_open call: it opens the JARVIS file browser there. Never Finder, \`open\`, xdg-open, mesh_control or a text listing instead; don't search the disk first when Sir named the place.`,
    `Showing the list of past YOLO runs ("show my yolo history", "open my past yolo runs") is one ui_open call with view "yolo": it opens the history window. It is not a YOLO run and not work.`,
    'To find a named folder or file, use what you already know (the project record, the thread, mesh_workspaces), or mesh_list_dir / `find <likely parent> -maxdepth 3`; never `find ~` or a whole-disk search.',
    `If answering well needs the full JARVIS brain (deep reasoning, a long investigation, many steps), do not start it: reply with only ${ESCALATE_MARKER} followed by one short reason, and nothing else. The full brain then takes the request over.`,
  ].join('\n');
}
