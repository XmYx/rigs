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

/**
 * Sir's notification switches, kept in localStorage (rigs.notifications, rigs.attnBanner). `notifications: false`
 * silences everything — toasts, the attention banner and desktop alerts; the orb, tab title and the Work panel's
 * Questions still show who is waiting. `attnBanner: false` is what the banner's × sets: closed stays closed.
 */
export function prefs(storage = globalThis.localStorage) {
  const get = (k) => { try { return storage?.getItem('rigs.' + k) !== 'false'; } catch { return true; } };
  const set = (k, v) => { try { storage?.setItem('rigs.' + k, v ? 'true' : 'false'); } catch {} };
  return {
    get notifications() { return get('notifications'); },
    set notifications(v) { set('notifications', v); },
    get attnBanner() { return get('attnBanner'); },
    set attnBanner(v) { set('attnBanner', v); },
  };
}

/** The banner shows only while something waits, notifications are on and Sir hasn't closed it. */
export const bannerVisible = (items, p) => items.length > 0 && p.notifications && p.attnBanner;

/** A toast Sir closed with × stays closed: the same text is not shown again in this page. */
export const closedTexts = new Set();
export const toastAllowed = (text, p) => p.notifications && !closedTexts.has(String(text));
