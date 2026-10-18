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
  maxTurns: 8, timeoutMs: 90000,
};
/** The fast brain says it needs the full brain with this marker (then a short reason); the request re-runs there. */
export const ESCALATE_MARKER = '[[ESCALATE]]';

const bool = (v, d) => (v === true || v === 'true' || v === 'on' || v === 1 || v === '1' ? true : v === false || v === 'false' || v === 'off' || v === 0 || v === '0' ? false : d);
const clampNum = (v, d, lo, hi) => (Number.isFinite(Number(v)) && v !== '' && v !== null ? Math.min(hi, Math.max(lo, Math.round(Number(v)))) : d);

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
  for (const k of ['maxTurns', 'timeoutMs']) if (b[k] !== undefined && !Number.isFinite(Number(b[k]))) throw new Error(`${k} must be a number`);
  return quickSettings({ ...cur, ...b, simple: { ...cur.simple, ...(b.simple || {}) }, standard: { ...cur.standard, ...(b.standard || {}) } });
}

/** The per-request override (jarvis/send `quick`): true | false | 'haiku' | 'sonnet', or undefined (use config). Pure. */
export function quickOverride(v) {
  if (v === undefined || v === null || v === '') return undefined;
  const s = String(v).toLowerCase();
  if (TIERS.includes(s)) return s;
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
 * maxTurns, timeoutMs, forced } or { on: false, reason }. Only requests routed "answer" qualify. A per-request
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
  return { on: true, tier: t.tier, why: t.why, provider: cfg.provider, model: cfg.model, effort: cfg.effort, maxTurns: s.maxTurns, timeoutMs: s.timeoutMs, forced: o !== undefined };
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
    `If answering well needs the full JARVIS brain (deep reasoning, a long investigation, many steps), do not start it: reply with only ${ESCALATE_MARKER} followed by one short reason, and nothing else. The full brain then takes the request over.`,
  ].join('\n');
}
