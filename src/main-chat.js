import { truncate } from './util.js';

/**
 * The JARVIS main thread is one continuous conversation, whichever lane answers a request (pure, tested in
 * test/main-chat.test.js):
 * - the full brain resumes the thread's own session and is told, once, what happened since its last turn
 *   (unseenContext: quick-lane answers, work requests mirrored from their threads, RIGS reports);
 * - a quick-lane turn is a fresh session, so it gets the thread's recent history (threadContext);
 * - a request routed to implement / plan / continue runs in its own work thread, and its user message and JARVIS's
 *   reply are mirrored into the main thread (mirrorMessage) so the next answer knows what Sir just asked for.
 *
 * The budget (MAIN_CONTEXT): the last 30 conversation messages (Sir's requests, JARVIS's replies, mirrored work turns)
 * always fit — the newest 10 up to 2000 chars each, the 20 before them up to 600 — plus the newest 8 RIGS reports
 * from that stretch at 300 chars each (reports are most of the thread and would otherwise crowd out the conversation).
 * At most ~34k chars (~9k tokens) of history, plus a compaction summary (up to 8000 chars) when there is one.
 */
export const MAIN_CONTEXT = { messages: 30, recent: 10, recentChars: 2000, olderChars: 600, reports: 8, reportChars: 300, summaryChars: 8000 };

/**
 * The stored compaction summary of the thread, or null. Hook for compaction: `chat.compaction = { summary, upto }`
 * says that `summary` stands in for `messages.slice(0, upto)`; history is then shown from `upto` on.
 */
export function compactionSummary(chat) {
  const c = chat?.compaction;
  const text = String(c?.summary || '').trim();
  if (!text) return null;
  const upto = Math.max(0, Math.min(Number(c.upto) || 0, chat.messages?.length || 0));
  return { text, upto };
}

/** Who said a message, as the brain is shown it. `via` adds the lane / brain an answer came from. */
export function speaker(m, { via = false } = {}) {
  if (m.report) return 'RIGS report';
  if (m.mirror) return m.role === 'user' ? `User (routed to ${m.route || 'work'}${m.title ? ` · thread "${m.title}"` : ''})` : `JARVIS (in that ${m.route || 'work'} thread)`;
  if (m.role === 'user') return 'User';
  if (!via) return 'JARVIS';
  return m.lane === 'quick' ? 'JARVIS (fast path)' : m.lane === 'yolo' ? 'JARVIS (YOLO run)' : `JARVIS${m.brain ? ` (${m.brain})` : ''}`;
}

/**
 * The lines for `msgs` under the budget: the last `messages` conversation messages, newest `recent` at `recentChars`,
 * older ones at `olderChars`; the newest `reports` reports from that stretch at `reportChars`. Returns the lines in order
 * and how many messages were left out.
 */
export function budgetLines(msgs, opts = {}, { via = false } = {}) {
  const b = { ...MAIN_CONTEXT, ...opts };
  const picked = [];
  let conv = 0;
  let reports = 0;
  for (let i = msgs.length - 1; i >= 0 && conv < b.messages; i--) {
    const m = msgs[i];
    if (!m || !String(m.text || '').trim()) continue;
    if (m.report) {
      if (reports >= b.reports) continue;
      reports++;
      picked.push(`${speaker(m, { via })}: ${truncate(m.text, b.reportChars)}`);
    } else {
      picked.push(`${speaker(m, { via })}: ${truncate(m.text, conv < b.recent ? b.recentChars : b.olderChars)}`);
      conv++;
    }
  }
  const shown = picked.length;
  const nonEmpty = msgs.filter((m) => m && String(m.text || '').trim()).length;
  return { lines: picked.reverse(), omitted: Math.max(0, nonEmpty - shown) };
}

const summaryBlock = (s, b) => `Summary of the conversation before this (compacted):\n${truncate(s.text, b.summaryChars)}\n\n`;

/**
 * A quick-lane turn's view of the thread (a fresh session that resumes nothing): the compaction summary when there is
 * one, then the recent history under MAIN_CONTEXT, then the request. The last message is the request itself and is
 * left out.
 */
export function threadContext(chat, opts = {}) {
  const b = { ...MAIN_CONTEXT, ...opts };
  const s = compactionSummary(chat);
  const msgs = (chat?.messages || []).slice(s?.upto || 0, -1);
  const { lines, omitted } = budgetLines(msgs, b);
  if (!lines.length && !s) return '';
  return (s ? summaryBlock(s, b) : '')
    + (lines.length ? `${omitted ? `(${omitted} earlier message${omitted > 1 ? 's' : ''} not shown.)\n` : ''}Recently in this conversation:\n${lines.join('\n')}\n\n` : '')
    + 'Now the user says:\n';
}

/**
 * What a resumed brain hasn't seen yet: the messages since its last turn (`chat.seen[brainKey]`), which it was not part
 * of — quick-lane answers, mirrored work requests, reports, other brains. Each is shown once: the turn that sees them
 * moves `seen` past them. `withSummary` (a session that starts fresh) adds the compaction summary and starts after it.
 */
export function unseenContext(chat, brainKey, { withSummary = false, ...opts } = {}) {
  const b = { ...MAIN_CONTEXT, ...opts };
  const s = withSummary ? compactionSummary(chat) : null;
  const from = Math.max(chat?.seen?.[brainKey] ?? 0, s?.upto || 0);
  const msgs = (chat?.messages || []).slice(from, -1);
  const { lines, omitted } = budgetLines(msgs, b, { via: true });
  if (!lines.length && !s) return '';
  return (s ? summaryBlock(s, b) : '')
    + (lines.length ? `Earlier in this conversation (since your last turn — answered on the fast path, routed to work threads, or reported by RIGS)${omitted ? `, the latest ${lines.length} of ${lines.length + omitted}` : ''}:\n${lines.join('\n')}\n\n` : '')
    + 'Now the user says:\n';
}

/**
 * A message of a request that runs in its own work thread (implement / plan / continue), as it is mirrored into the
 * main thread: flagged `mirror` with the work thread's id, route and title. The request is mirrored when it is routed,
 * the reply when it is done (cut to 8000 chars, like a report). Null for an empty reply.
 */
export function mirrorMessage({ role = 'user', text, chatId, route = '', title = '', brain = '', model = '', ts = Date.now() }) {
  if (!String(text || '').trim()) return null;
  return { role, text: role === 'user' ? String(text) : truncate(String(text), 8000), ...(role === 'user' ? {} : { brain, model }), mirror: true, chatId, route, ...(title ? { title } : {}), ts };
}

/**
 * Messages another writer appended to a chat file since `base` messages were read, which `mine` doesn't hold yet (by
 * role + ts + text). Saving a chat merges them in after its own, so a mirror, report or quick answer written while a
 * long turn ran is never lost, and stays after that turn's `seen` mark (shown to the brain next time). Pure.
 */
export function appendedSince(disk, base, mine) {
  const extra = (disk?.messages || []).slice(base ?? Infinity);
  const key = (m) => `${m.role}\u0000${m.ts}\u0000${m.text}`;
  const have = new Set((mine || []).map(key));
  return extra.filter((m) => !have.has(key(m)));
}
