// The Conversation window's transcript with compaction points, the pure part: the JARVIS thread keeps every message,
// and each compaction (src/compact.js, `chat.compactions[]`) says the brain's context was summarised up to message
// `upto`. A divider goes before that message. No DOM: main.js draws it, test/compact.test.js checks it in Node.

/**
 * The rows to draw for `messages` from index `from` on: { kind: 'msg', m, i } and, before the first message after each
 * compaction, { kind: 'compacted', c } (several compactions at one index: the latest). A compaction before `from` is
 * not shown (its messages are not on screen); one at the very end (nothing after it yet) closes the list.
 */
export function transcriptRows(messages = [], compactions = [], from = 0) {
  const at = new Map();
  for (const c of compactions || []) if (Number.isInteger(c?.upto) && c.upto >= from && c.upto > 0) at.set(c.upto, c);
  const rows = [];
  for (let i = Math.max(0, from); i < messages.length; i++) {
    if (at.has(i)) rows.push({ kind: 'compacted', c: at.get(i) });
    rows.push({ kind: 'msg', m: messages[i], i });
  }
  if (at.has(messages.length)) rows.push({ kind: 'compacted', c: at.get(messages.length) });
  return rows;
}

/** The divider's label and tooltip. */
export function compactedLabel(c) {
  const k = (t) => (t >= 1000 ? `${Math.round(t / 1000)}k` : String(t));
  const when = c?.ts ? new Date(c.ts).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '';
  return {
    text: 'earlier conversation compacted',
    title: [when, c?.tokensBefore ? `at ${k(c.tokensBefore)} tokens of context` : '', c?.reason === 'manual' ? 'by hand' : '', 'every message is still here; JARVIS continues from a summary of the ones above'].filter(Boolean).join(' · '),
  };
}
