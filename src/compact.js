import { speaker } from './main-chat.js';
import { truncate } from './util.js';

/**
 * Self-compaction of the JARVIS main thread (pure, tested in test/compact.test.js; the runner is chat.compactChat).
 *
 * After each full-brain Claude turn the session's context size is recorded on the chat (`chat.context[brain]`): the
 * LAST API call's input + cache-read + cache-write tokens (contextTokens). Not the turn's summed usage, and never the
 * session's cumulative totals that claudeResultUsage keeps: those grow with every cache read (millions on a long
 * thread) and would trigger compaction on every turn. When it reaches `config.brain.compact.atTokens`, one bounded
 * summarisation call turns everything since the last compaction (the previous summary plus the messages up to the
 * cut) into a summary; the brain sessions are dropped, so the next turn starts fresh, seeded with the summary and the
 * last `keepMessages` conversation messages (main-chat.js unseenContext / threadContext read `chat.compaction`).
 * Messages are never deleted: the chat file keeps the whole history, only the brain's context is compacted.
 */
export const COMPACT_DEFAULTS = { enabled: true, atTokens: 100000, keepMessages: 12, model: 'claude-sonnet-5-5', timeoutMs: 180000 };

/** Brain → the chat field holding its session. Compaction drops all of them (each brain then starts from the summary). */
export const SESSION_KEYS = { claude: 'claudeSessionId', 'claude-ollama': 'claudeOllamaSessionId', codex: 'codexThreadId' };

// What the summarisation call is given: conversation messages up to 4000 chars, reports up to 600, ~240k chars in all
// (~60k tokens; the newest win), and it writes at most ~6000 chars (MAIN_CONTEXT.summaryChars cuts at 8000).
export const SUMMARY_INPUT = { messageChars: 4000, reportChars: 600, totalChars: 240000, summaryChars: 6000 };

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const int = (v) => (Number.isInteger(Number(v)) ? Number(v) : NaN);

/** The validated `config.brain.compact` block: unknown or invalid values fall back to the defaults. */
export function compactSettings(raw = {}) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const d = COMPACT_DEFAULTS;
  return {
    enabled: typeof r.enabled === 'boolean' ? r.enabled : d.enabled,
    atTokens: int(r.atTokens) >= 1000 ? int(r.atTokens) : d.atTokens,
    keepMessages: int(r.keepMessages) >= 0 && int(r.keepMessages) <= 200 ? int(r.keepMessages) : d.keepMessages,
    model: typeof r.model === 'string' && r.model.trim() ? r.model.trim() : d.model,
    timeoutMs: int(r.timeoutMs) >= 10000 ? int(r.timeoutMs) : d.timeoutMs,
  };
}

/** `cur` with a patch from the API / CLI applied. Throws on a bad value (the API answers 400). */
export function applyCompactPatch(cur, patch = {}) {
  const next = compactSettings(cur);
  if (patch.enabled !== undefined) {
    if (typeof patch.enabled !== 'boolean') throw new Error('enabled must be true or false');
    next.enabled = patch.enabled;
  }
  if (patch.atTokens !== undefined) {
    if (!(int(patch.atTokens) >= 1000)) throw new Error('atTokens must be a whole number of tokens, at least 1000');
    next.atTokens = int(patch.atTokens);
  }
  if (patch.keepMessages !== undefined) {
    if (!(int(patch.keepMessages) >= 0 && int(patch.keepMessages) <= 200)) throw new Error('keepMessages must be 0–200');
    next.keepMessages = int(patch.keepMessages);
  }
  if (patch.model !== undefined) {
    if (typeof patch.model !== 'string' || !patch.model.trim()) throw new Error('model must be a model name');
    next.model = patch.model.trim();
  }
  return next;
}

const callTokens = (u) => num(u?.input_tokens) + num(u?.cache_read_input_tokens) + num(u?.cache_creation_input_tokens);

/**
 * The session's context size after a `claude -p` turn: the last API call's input + cache-read + cache-write tokens.
 * `result.usage` sums every call of the turn's tool loop; `result.usage.iterations` lists the last one. Without it,
 * `lastCall` (the usage of the last `assistant` stream event) is used, and a one-call turn's usage is that call's.
 * Null when it can't be told: the cumulative totals are never a context size.
 */
export function contextTokens(result, lastCall = null) {
  const its = Array.isArray(result?.usage?.iterations) ? result.usage.iterations.filter((x) => x && (x.type ?? 'message') === 'message') : [];
  if (its.length) return callTokens(its.at(-1));
  if (lastCall) return callTokens(lastCall);
  if (num(result?.num_turns) === 1 && result.usage) return callTokens(result.usage);
  return null;
}

const isConversation = (m) => !!m && !m.report && !!String(m.text || '').trim();
const prevUpto = (chat) => Math.max(0, Math.min(num(chat?.compaction?.upto), chat?.messages?.length || 0));

/**
 * Where a compaction would cut now: the index from which the last `keep` conversation messages (reports in between
 * included) stay as they are. Never before the previous cut; equal to it when there is nothing new to summarise.
 */
export function compactionCut(chat, keep = COMPACT_DEFAULTS.keepMessages) {
  const msgs = chat?.messages || [];
  const prev = prevUpto(chat);
  if (keep <= 0) return Math.max(prev, msgs.length);
  let n = 0;
  for (let i = msgs.length - 1; i >= prev; i--) {
    if (isConversation(msgs[i]) && ++n === keep) return Math.max(prev, i);
  }
  return prev;
}

/**
 * Whether the thread should be compacted after a turn of `brain`: on, a context size measured for the session that is
 * still live, at or past atTokens, and something to summarise (the cut moved past the previous one).
 */
export function needsCompaction(chat, brain, settings) {
  const s = compactSettings(settings);
  const c = chat?.context?.[brain];
  const session = chat?.[SESSION_KEYS[brain]];
  if (!s.enabled || !c || !session || c.sessionId !== session) return false;
  return num(c.tokens) >= s.atTokens && compactionCut(chat, s.keepMessages) > prevUpto(chat);
}

export const SUMMARY_SYSTEM = 'You compact a long conversation between Sir (the user) and JARVIS, the voice of RIGS OS (his control plane for the machines on his network), so JARVIS can continue it in a fresh session. You get the summary of the conversation before this stretch (when there is one) and the messages since, in the user message. Summarise only those: leave out anything else in your context (environment, account, tool or harness details). Write the new summary that replaces both. Keep what JARVIS needs to carry on: decisions taken and why; open threads and unanswered questions; work in flight (projects, tasks, machines, ids); Sir\'s preferences and standing instructions; names, paths, URLs, numbers and facts he told JARVIS. Drop small talk, finished one-off lookups and routine RIGS reports unless they still matter. Carry still-relevant points of the previous summary forward. Use these markdown headings in this order: Decisions, Open threads, Sir\'s preferences, Projects and references, Facts to remember. Terse bullets, no preamble, at most 6000 characters.';

/**
 * The bounded summarisation prompt for the stretch the previous summary and messages[prev .. upto) cover. Over the
 * total budget the oldest messages are left out first (said so in the prompt). Returns { prompt, messages, omitted }.
 */
export function summaryPrompt(chat, upto, opts = {}) {
  const b = { ...SUMMARY_INPUT, ...opts };
  const prev = String(chat?.compaction?.summary || '').trim();
  const msgs = (chat?.messages || []).slice(prevUpto(chat), upto);
  const lines = [];
  let total = prev.length;
  let omitted = 0;
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    if (!String(m?.text || '').trim()) continue;
    const when = m.ts ? `[${new Date(m.ts).toISOString().slice(0, 16).replace('T', ' ')}] ` : '';
    const line = `${when}${speaker(m, { via: true })}: ${truncate(m.text, m.report ? b.reportChars : b.messageChars)}`;
    if (total + line.length > b.totalChars) { omitted = i + 1; break; }
    lines.push(line);
    total += line.length + 1;
  }
  lines.reverse();
  const prompt = (prev ? `Summary of the conversation before this stretch:\n${prev}\n\n` : '')
    + `Messages since${omitted ? ` (the ${omitted} oldest left out for length)` : ''}:\n${lines.join('\n')}\n\n`
    + 'Write the new summary now.';
  return { prompt, messages: lines.length, omitted };
}

/**
 * Apply a finished summary to `chat` (mutates it): `chat.compaction = { summary, upto, ts, tokensBefore, model,
 * sessions }` (the hook main-chat.js reads), one entry appended to `chat.compactions`, every brain session dropped
 * (remembered in `compaction.sessions`), each brain's `seen` mark moved back to the cut so a fresh session is seeded
 * with the kept messages, and the measured context sizes cleared (the next turn measures the new session).
 */
export function applyCompaction(chat, { summary, upto, tokensBefore = null, model = '', brain = '', reason = 'auto', ts = Date.now() }) {
  const text = truncate(String(summary || '').trim(), SUMMARY_INPUT.summaryChars + 2000);
  if (!text) throw new Error('empty summary');
  const sessions = {};
  for (const k of Object.values(SESSION_KEYS)) if (chat[k]) { sessions[k] = chat[k]; chat[k] = null; }
  chat.seen = Object.fromEntries(Object.entries(chat.seen || {}).map(([k, v]) => [k, Math.min(num(v), upto)]));
  chat.compaction = { summary: text, upto, ts, tokensBefore, model, sessions };
  chat.compactions = [...(chat.compactions || []), { ts, tokensBefore, upto, model, brain, reason, chars: text.length }];
  chat.context = {};
  delete chat.compactFailed;
  return chat;
}

/**
 * A chat object read before a compaction landed is being saved (a quick turn, a report): keep the compaction the file
 * already has instead of writing the old state back — summary, log, `seen`, context sizes, and the dropped sessions
 * (a session id still equal to the one the compaction dropped is not restored). Mutates and returns `mine`.
 */
export function keepCompaction(disk, mine) {
  const dc = disk?.compaction;
  if (!dc?.ts || num(dc.ts) <= num(mine?.compaction?.ts)) return mine;
  mine.compaction = dc;
  mine.compactions = disk.compactions || [];
  mine.seen = disk.seen || {};
  mine.context = disk.context || {};
  for (const [k, old] of Object.entries(dc.sessions || {})) if (mine[k] === old) mine[k] = disk[k] ?? null;
  if (!disk.compactFailed) delete mine.compactFailed;
  return mine;
}

/** What `GET /api/local/compact` and `rigs compact status` show for a chat. */
export function compactStatus(chat, settings) {
  const s = compactSettings(settings);
  const brain = chat?.brain && chat.brain !== 'auto' ? chat.brain : 'claude';
  const c = chat?.context?.[brain] || null;
  const live = !!c && c.sessionId === chat?.[SESSION_KEYS[brain]];
  const last = chat?.compactions?.at(-1) || null;
  return {
    chatId: chat?.id || '', brain, settings: s,
    contextTokens: live ? num(c.tokens) : null, measuredAt: live ? c.ts || 0 : 0, sessionId: chat?.[SESSION_KEYS[brain]] || '',
    percent: live ? Math.round((num(c.tokens) / s.atTokens) * 100) : null,
    messages: chat?.messages?.length || 0, compactedUpto: prevUpto(chat), compactions: chat?.compactions?.length || 0,
    last: last ? { ...last, summary: chat.compaction?.summary || '' } : null,
    failed: chat?.compactFailed || null,
    wouldCut: compactionCut(chat, s.keepMessages),
  };
}
