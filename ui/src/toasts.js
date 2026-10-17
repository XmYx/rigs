// Pure bookkeeping for the notification column (timeouts, stacking, the attention banner's dismissal), kept free
// of the DOM so it can be unit-tested. Rules: docs/notes/notifications-audit.md §2.

export const LEVEL_MS = { info: 4000, ok: 4000, error: 8000, attn: 20000 };
export const MIN_MS = 3000;
export const MAX_MS = 30000;
export const ACTION_MIN_MS = 20000;
export const RESUME_MIN_MS = 2000;
export const MAX_VISIBLE = 4;
export const COALESCE_MS = 2000;

/** How long a toast stays: the level default unless the caller asked, clamped to 3–30 s; 20 s minimum with a button. */
export function toastDuration(level = 'info', ms, hasAction = false) {
  let d = ms == null ? (LEVEL_MS[level] ?? LEVEL_MS.info) : Math.min(MAX_MS, Math.max(MIN_MS, Number(ms) || 0));
  if (hasAction) d = Math.min(MAX_MS, Math.max(ACTION_MIN_MS, d));
  return d;
}

/** After hover/focus pause: what is left, but never less than 2 s. */
export const resumeAfter = (remaining) => Math.max(RESUME_MIN_MS, remaining);

/** An attention item's identity for dismissal: the same wait again keeps its key, a new wait (new `since`) is new. */
export const attnKey = (it) => `${it.key || `${it.nodeId}:${it.title}`}@${it.since || ''}`;

/** The banner shows unless every item now waiting was already there when Sir closed it. */
export function bannerVisible(items, dismissed) {
  if (!items.length) return false;
  if (!dismissed || !dismissed.size) return true;
  return items.some((it) => !dismissed.has(attnKey(it)));
}
