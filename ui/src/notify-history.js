// Notification history: the last notices this page received (notify events: agent reports, mesh events), so a toast
// that went by can be found again with its Open / Run button. Pure (test/notify-ui.test.js); main.js keeps the list
// and the Notifications window (Tools › Notifications) draws it.

export const HISTORY_CAP = 50;

/** The action on a notice: { kind: 'open', label, open } (a ui-open push), { kind: 'run', label, node, command, title } or null. */
export function noticeAction(m) {
  const a = m?.action;
  if (!a || typeof a !== 'object') return null;
  if (a.type === 'open' && a.open && typeof a.open === 'object') return { kind: 'open', label: String(a.label || 'Open'), open: a.open };
  if (a.type === 'run' && a.command) return { kind: 'run', label: String(a.label || 'Run'), node: a.node, command: a.command, title: a.title };
  return null;
}

/** A notify event → the history entry { at, from, text, level, action }, or null when it is not a notice to keep. */
export function noticeOf(m, at = Date.now()) {
  if (!m || m.type !== 'notify' || !m.text) return null;
  if (m.session) return null; // an agent session popping up as a terminal: not a notice
  return { at, from: String(m.from || ''), text: String(m.text).slice(0, 2000), level: String(m.level || 'info'), action: noticeAction(m) };
}

/** Push a notice, newest last, keeping the last `cap`; a repeat of the newest within 2 s is not added again. Returns the list. */
export function pushNotice(list, entry, cap = HISTORY_CAP) {
  if (!entry) return list;
  const last = list[list.length - 1];
  if (last && last.text === entry.text && last.from === entry.from && entry.at - last.at < 2000) return list;
  list.push(entry);
  if (list.length > cap) list.splice(0, list.length - cap);
  return list;
}

/** The notice's text without the part after a line holding only "---" (that part is shown, never spoken). */
export const shortText = (text) => String(text || '').split(/\n-{3,}\s*\n/)[0].trim();

/**
 * The server's history (GET notify/history, what this machine showed before the page connected) merged into the
 * list this page already holds: by time, no duplicates (same at + text), the newest `cap` kept. Pure; a new list.
 */
export function mergeNotices(list, incoming, cap = HISTORY_CAP) {
  const seen = new Set();
  const out = [];
  for (const n of [...list, ...incoming]) {
    if (!n) continue;
    const key = `${n.at}|${n.text}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(n);
  }
  out.sort((a, b) => a.at - b.at);
  return out.slice(-cap);
}
