// Where the Ask JARVIS field lives: the pure model behind ask-panel.js (no DOM, unit-tested in test/ask-panel.test.js).
//
// Modes: 'topbar' (inline in the top menu bar's slot), 'floating' / 'docked' (the Ask panel in the dock layout) and
// 'hidden' (closed; ⌘/Ctrl+K or Window › Ask JARVIS brings it back the way it was). Persisted as
// rigs.askPanel = { mode, rect, last }: rect is the last floating rect (⏏ pops it back out there), last the visible
// mode 'hidden' returns to. The dock layout stays the authority for floating vs docked: its changes come in as
// 'layout' events. Phones never move it: the field stays in the bottom toolbar (#bar) and every event is ignored.

export const ASK_KEY = 'rigs.askPanel';
export const ASK_MODES = ['topbar', 'floating', 'docked', 'hidden'];
const VISIBLE = ['topbar', 'floating', 'docked'];
export const DEFAULT_ASK = Object.freeze({ mode: 'topbar', rect: null, last: 'topbar' });

const num = (v) => typeof v === 'number' && Number.isFinite(v);
const size = (v) => (num(v) && v > 0 ? v : null);

/** A floating rect worth keeping ({ x, y, w?, h? }), else null. */
export function cleanRect(r) {
  if (!r || typeof r !== 'object' || !num(r.x) || !num(r.y)) return null;
  return { x: r.x, y: r.y, w: size(r.w), h: size(r.h) };
}

/** The saved placement (a localStorage string or an object); anything missing or invalid falls back to the default. */
export function restoreAskPlacement(raw) {
  let v = raw;
  if (typeof v === 'string') { try { v = JSON.parse(v); } catch { v = null; } }
  if (!v || typeof v !== 'object' || Array.isArray(v)) return { ...DEFAULT_ASK };
  const mode = ASK_MODES.includes(v.mode) ? v.mode : DEFAULT_ASK.mode;
  const last = VISIBLE.includes(mode) ? mode : VISIBLE.includes(v.last) ? v.last : DEFAULT_ASK.last;
  return { mode, rect: cleanRect(v.rect), last };
}

/** What goes into localStorage. */
export const serializeAsk = (s) => JSON.stringify({ mode: s.mode, rect: s.rect, last: s.last });

/**
 * The next placement after an event (the same object when nothing changes):
 *   { type: 'topbar', rect? }  dock into the menu bar (rect: where it floated, to pop back out there)
 *   { type: 'float', rect? }   float it (at rect, else the last floating rect)
 *   { type: 'hide' } / { type: 'show' }
 *   { type: 'layout', status, rect?, cause? }  the dock layout changed: the panel is now 'floating' | 'docked' | 'hidden'
 * `phone`: phones keep the field in the bottom toolbar, so nothing moves.
 */
export function askPlacement(state, ev, { phone = false } = {}) {
  const s = state || { ...DEFAULT_ASK };
  if (phone || !ev) return s;
  switch (ev.type) {
    case 'topbar': return s.mode === 'topbar' ? s : { ...s, mode: 'topbar', last: 'topbar', rect: cleanRect(ev.rect) ?? s.rect };
    case 'float': return { ...s, mode: 'floating', last: 'floating', rect: cleanRect(ev.rect) ?? s.rect };
    case 'hide': return s.mode === 'hidden' ? s : { ...s, mode: 'hidden', last: s.mode };
    case 'show': return s.mode === 'hidden' ? { ...s, mode: s.last } : s;
    case 'layout': {
      if (ev.cause === 'reset') return s.mode === DEFAULT_ASK.mode ? s : { ...DEFAULT_ASK, rect: s.rect }; // Reset layout: back to the top bar
      // The panel is hidden in the layout while the field sits in the top bar: that is the top bar mode, not a close.
      if (ev.status === 'hidden') return s.mode === 'topbar' || s.mode === 'hidden' ? s : { ...s, mode: 'hidden', last: s.mode };
      if (ev.status === 'floating') {
        const rect = cleanRect(ev.rect) ?? s.rect;
        return s.mode === 'floating' && sameRect(rect, s.rect) ? s : { ...s, mode: 'floating', last: 'floating', rect };
      }
      if (ev.status === 'docked') return s.mode === 'docked' ? s : { ...s, mode: 'docked', last: 'docked' };
      return s;
    }
    default: return s;
  }
}

const sameRect = (a, b) => (!a && !b) || (!!a && !!b && a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h);

/** Where the field's DOM goes: 'bar' (phone toolbar), 'topbar' (menu bar slot) or 'panel'. */
export const askHost = (s, { phone = false } = {}) => (phone ? 'bar' : s.mode === 'topbar' ? 'topbar' : 'panel');

/** The status the Ask panel must have in the dock layout for this mode. */
export const panelWanted = (s) => (s.mode === 'topbar' || s.mode === 'hidden' ? 'hidden' : s.mode);

// ------------------------------------------------------------------ input history (↑/↓ in the field, rigs.askHistory)

export const HISTORY_KEY = 'rigs.askHistory';
export const HISTORY_MAX = 50;

/** The history after sending `text`: newest last, no repeats, at most `max`. */
export function pushHistory(list, text, max = HISTORY_MAX) {
  const t = String(text ?? '').trim();
  const prev = Array.isArray(list) ? list.filter((x) => typeof x === 'string' && x && x !== t) : [];
  return (t ? [...prev, t] : prev).slice(-max);
}

/**
 * One ↑ (dir -1) or ↓ (dir 1) step. `index` null = not browsing (the field shows `draft`, what was being typed).
 * ↑ walks back to the oldest and stops there; ↓ past the newest returns to the draft.
 */
export function recallHistory(list, index, dir, draft = '') {
  const n = Array.isArray(list) ? list.length : 0;
  if (!n) return { index: null, value: draft };
  if (dir < 0) { const i = index === null ? n - 1 : Math.max(0, index - 1); return { index: i, value: list[i] }; }
  if (index === null) return { index: null, value: draft };
  return index + 1 >= n ? { index: null, value: draft } : { index: index + 1, value: list[index + 1] };
}
