// Window state model (pure, no DOM; tested in test/window-state.test.js).
//
// Every wm.js window is in one of four states:
//   normal     on the stage at its own rect
//   maximized  fills the stage; `rect` is kept untouched, so restoring brings back the exact previous rect
//   minimized  off the stage, reachable from the app dock; `before` is the state it returns to (normal or maximized)
//   closed     gone; the record keeps `rect` and `before`, so the window reopens where (and how) it was
//
// A record is plain JSON: { state, rect: {x, y, w, h} | null, before: 'normal' | 'maximized', at }.
// `at` is the time of the last change (ms); the dock layout store keeps the newest MAX_WINDOWS records (dock-layout.js
// `windows`), so a separate project can sync them across the mesh.

export const STATES = Object.freeze(['normal', 'minimized', 'maximized', 'closed']);
export const ACTIONS = Object.freeze(['open', 'minimize', 'maximize', 'restore', 'toggleMaximize', 'close', 'move']);
export const MAX_WINDOWS = 60;

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

/** A rect {x, y, w, h} with finite numbers and a positive size, else null. */
export function cleanRect(r) {
  if (!isObj(r)) return null;
  const x = num(r.x); const y = num(r.y); const w = num(r.w); const h = num(r.h);
  if (x === null || y === null || !(w > 0) || !(h > 0)) return null;
  return { x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h) };
}

export function sameRect(a, b) {
  if (!a || !b) return a === b;
  return a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h;
}

/** A fresh window: normal, at `rect` (null = let the window manager place it). */
export const initialRecord = (rect = null, at = 0) => ({ state: 'normal', rect: cleanRect(rect), before: 'normal', at: num(at) ?? 0 });

/** Validate and repair any value into a record (null when there is nothing usable). */
export function normalizeRecord(raw) {
  if (!isObj(raw)) return null;
  const state = STATES.includes(raw.state) ? raw.state : 'normal';
  const before = raw.before === 'maximized' ? 'maximized' : 'normal';
  return { state, rect: cleanRect(raw.rect), before, at: num(raw.at) ?? 0 };
}

export const isVisible = (rec) => rec?.state === 'normal' || rec?.state === 'maximized';

/**
 * The next record after `action`. Never mutates; returns the input itself when nothing changes.
 *   open            closed / minimized → the state it had before (normal or maximized); no record yet → normal
 *   minimize        normal / maximized → minimized (remembering which)
 *   maximize        normal / minimized → maximized; the rect stays as the restore rect
 *   restore         maximized → normal (at the remembered rect); minimized / closed → the state it had before
 *   toggleMaximize  maximized → normal, normal / minimized → maximized
 *   close           → closed (remembering normal / maximized)
 *   move            a normal window's rect changed (drag, resize, tile); other states keep their rect
 * `opts`: { rect } for move (and to seed a missing record), { at } the time of the change.
 */
export function transition(rec, action, { rect, at } = {}) {
  const cur = normalizeRecord(rec) || initialRecord(rect, at);
  const same = rec || cur;
  const when = num(at) ?? cur.at;
  const to = (state, before = cur.before) => (state === cur.state && before === cur.before && rec ? rec : { ...cur, state, before, at: when });
  switch (action) {
    case 'open':
      return cur.state === 'closed' || cur.state === 'minimized' ? to(cur.before) : same;
    case 'minimize':
      return isVisible(cur) ? to('minimized', cur.state) : same;
    case 'maximize':
      return cur.state === 'normal' || cur.state === 'minimized' ? to('maximized') : same;
    case 'restore':
      if (cur.state === 'maximized') return to('normal', 'normal');
      return cur.state === 'minimized' || cur.state === 'closed' ? to(cur.before) : same;
    case 'toggleMaximize':
      if (cur.state === 'maximized') return to('normal', 'normal');
      return cur.state === 'closed' ? same : to('maximized');
    case 'close':
      if (cur.state === 'closed') return same;
      return to('closed', cur.state === 'minimized' ? cur.before : cur.state);
    case 'move': {
      const r = cleanRect(rect);
      if (cur.state !== 'normal' || !r || sameRect(r, cur.rect)) return same;
      return { ...cur, rect: r, at: when };
    }
    default:
      return same;
  }
}

/**
 * The title bar buttons, in their fixed order: minimize (–), maximize / restore (□ / ❐), close (✕).
 * `action` is the transition a click asks for; `pressed` is the maximize toggle's aria-pressed. A minimized title strip
 * (a JARVIS panel shown folded to its bar; a minimized wm.js window is off the stage) has Restore (❐) in the first place.
 */
export function chromeButtons(rec) {
  const max = rec?.state === 'maximized';
  const min = rec?.state === 'minimized';
  return [
    min ? { action: 'restore', glyph: '❐', label: 'Restore', cls: 'win-min' } : { action: 'minimize', glyph: '–', label: 'Minimize', cls: 'win-min' },
    { action: 'toggleMaximize', glyph: max ? '❐' : '□', label: max ? 'Restore' : 'Maximize', cls: 'win-max', pressed: max },
    { action: 'close', glyph: '✕', label: 'Close', cls: 'close' },
  ];
}

// ---------------------------------------------------------------- the store's `windows` map

const validKey = (key) => typeof key === 'string' && key.length > 0 && key.length <= 200;

/** A `windows` map ({ [key]: record }) from storage: bad entries dropped, the newest `max` kept. */
export function normalizeWindows(raw, max = MAX_WINDOWS) {
  if (!isObj(raw)) return {};
  const recs = [];
  for (const [key, v] of Object.entries(raw)) {
    const rec = normalizeRecord(v);
    if (validKey(key) && rec) recs.push([key, rec]);
  }
  return Object.fromEntries(recs.sort((a, b) => b[1].at - a[1].at).slice(0, max));
}

/** Put one record into a `windows` map (null removes it), keeping the newest `max`. Never mutates; unchanged → same map. */
export function putWindow(windows, key, rec, max = MAX_WINDOWS) {
  const cur = isObj(windows) ? windows : {};
  if (rec === null) {
    if (!Object.hasOwn(cur, key)) return cur;
    const next = { ...cur };
    delete next[key];
    return next;
  }
  const r = normalizeRecord(rec);
  if (!r || !validKey(key)) return cur;
  const old = cur[key];
  if (old && old.state === r.state && old.before === r.before && sameRect(old.rect, r.rect)) return cur;
  const next = { ...cur, [key]: r };
  return Object.keys(next).length > max ? normalizeWindows(next, max) : next;
}

// ---------------------------------------------------------------- title bar wiring

/**
 * Build the three title bar buttons with `h` (api.js h in the page, a stand-in in tests). A click calls
 * `act(action)` and stops there (the bar's own drag / double-click never sees it). `sync(rec)` updates the
 * maximize / restore glyph, label and aria-pressed after every state change.
 */
export function buildChrome(h, act) {
  let cur = chromeButtons(null); // what each button does now (the first one is Restore on a minimized strip)
  const els = cur.map((b, i) => h('button', {
    class: `win-btn ${b.cls}`, type: 'button', title: b.label, 'aria-label': b.label, 'data-win-act': b.action,
    ...(b.pressed !== undefined ? { 'aria-pressed': String(b.pressed) } : {}),
    onclick: (e) => { e?.stopPropagation?.(); act(cur[i].action); },
  }, b.glyph));
  return {
    els,
    sync(rec) {
      cur = chromeButtons(rec);
      cur.forEach((b, i) => {
        const el = els[i];
        if (el.textContent !== b.glyph) el.textContent = b.glyph;
        el.title = b.label;
        el.setAttribute('aria-label', b.label);
        el.setAttribute('data-win-act', b.action);
        if (b.pressed !== undefined) el.setAttribute('aria-pressed', String(b.pressed));
      });
    },
  };
}
