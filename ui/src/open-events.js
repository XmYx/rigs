// Open / close events for the app dock's auto-docking. No DOM, no side effects of its own: wm.js and terminal.js call
// emitOpened / emitClosed from their existing open and close paths, trackPanels() turns panel show / hide into the same
// events, and bindDock() feeds them to the dock as the t1 state transitions (onOpened / onClosed). With autoDock and
// autoTabTerminals off (the default) the state transitions change nothing, so listening costs nothing visible.
// Unit-tested in test/app-dock-auto.test.js.
import { addItem, createGroup, mergeSources, onClosed, onMinimized, onOpened, onRestored, removeItem, TERMINAL_GROUP, toItem, ungroup } from './app-dock-state.js';

/** The automatic Terminals group is not kept once its last terminal has closed. */
const dropEmptyTerminalGroup = (s) => (s.groups[TERMINAL_GROUP] && !s.groups[TERMINAL_GROUP].items.length ? ungroup(s, TERMINAL_GROUP) : s);

/**
 * Bring a persisted dock in line with a fresh page: nothing that was open before the reload is open now. Window and
 * terminal ids do not survive a reload (pinned or not), so their items go; panel items stay only for panels that are
 * shown (pinned ones dimmed); an emptied Terminals group goes. `panels` = listPanels() records.
 */
export function reconcileOnLoad(state, panels = []) {
  let s = state;
  for (const it of Object.values(state.items)) if (it.kind === 'window' || it.kind === 'terminal') s = removeItem(s, it.id);
  // A minimized panel's tile goes too (unless pinned): trackPanels' first scan gives it a minimized tile again, which goes on restore.
  const shown = panels.filter((p) => !p.closed && !p.removed && !p.minimized).map((p) => ({ id: p.id, title: p.title || p.id, icon: '▤' }));
  return dropEmptyTerminalGroup(mergeSources(s, { panels: shown }));
}

// Mesh sync (synced-storage.js): window and terminal tiles belong to this page (their ids die with it), so the dock
// the mesh shares leaves them out, and a dock arriving from another machine keeps this page's own.
const isTransient = (it) => it.kind === 'window' || it.kind === 'terminal';

/** The dock as the mesh shares it: without this page's window and terminal tiles (an emptied Terminals group goes too). */
export function withoutTransient(state) {
  let s = state;
  for (const it of Object.values(state.items)) if (isTransient(it)) s = removeItem(s, it.id);
  return s === state ? s : dropEmptyTerminalGroup(s);
}

/** A dock from another machine (`next`) with this page's window and terminal tiles from `prev` put back, in their group. */
export function keepTransient(next, prev) {
  let s = withoutTransient(next);
  for (const it of Object.values(prev.items)) {
    if (!isTransient(it)) continue;
    const g = Object.values(prev.groups).find((x) => x.items.includes(it.id));
    if (g && !s.groups[g.id]) s = createGroup(s, { id: g.id, name: g.name });
    s = addItem(s, it, { group: g ? g.id : null });
  }
  return s;
}

/** A tiny synchronous bus: a listener that throws never breaks the emitter or the other listeners. */
export function createOpenBus() {
  const listeners = new Set();
  return {
    on(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    emit(ev) { for (const fn of [...listeners]) { try { fn(ev); } catch { /* one listener must not break the rest */ } } },
  };
}

export const openBus = createOpenBus();

/** kind: 'window' | 'terminal' | 'panel'; source: the record the dock state's toItem() takes; extra: { auto } for terminals. */
export const emitOpened = (kind, source, extra = {}, bus = openBus) => bus.emit({ type: 'opened', kind, source, ...extra });
export const emitClosed = (kind, source, bus = openBus) => bus.emit({ type: 'closed', kind, source });
export const emitTitle = (kind, source, bus = openBus) => bus.emit({ type: 'title', kind, source });
/**
 * A wm.js window (kind 'window') or a JARVIS panel (kind 'panel', from trackPanels) was minimized / came back (or closed
 * while minimized). `rep`: the dock item that stands for it, if any.
 */
export const emitMinimized = (source, rep = null, bus = openBus, kind = 'window') => bus.emit({ type: 'minimized', kind, source, rep });
export const emitRestored = (source, rep = null, bus = openBus, kind = 'window') => bus.emit({ type: 'restored', kind, source, rep });

/**
 * Windows that get no 'window' dock item: terminals (docked as terminal items) and app windows (their applet tile
 * already shows a running dot).
 */
const SKIP_WINDOW = /(^|\s)(term-win|app-win)(\s|$)/;
export const dockableWindow = (className) => !SKIP_WINDOW.test(className || '');

/**
 * Turn panel show / hide into opened / closed events, and minimize / restore into minimized / restored ones (the dock
 * marks the panel's tool tile, `dockRef`, or gives it a tile of its own while it is minimized). `list()` → [{ id, title,
 * closed, minimized, removed, dockRef }] (panels.js listPanels), `subscribe(fn)` → unsubscribe (dockManager.subscribe).
 * The first scan is the baseline — nothing already on screen counts as "opened", but a panel already minimized is
 * announced as minimized — and a panel registered later is baselined on first sight too; only a known panel changing
 * between hidden and shown is an open / close event. Returns { scan, stop }.
 */
export function trackPanels({ list, subscribe, bus = openBus, icon = '▤' }) {
  let shownBefore = null;
  let minBefore = new Set();
  const known = new Set();
  function scan() {
    const next = new Set();
    const nextMin = new Set();
    for (const p of list() || []) {
      const shown = !p.closed && !p.removed;
      if (shown) next.add(p.id);
      const min = shown && !!p.minimized;
      if (min) nextMin.add(p.id);
      const src = { id: p.id, title: p.title || p.id, icon };
      if (min && !minBefore.has(p.id)) emitMinimized(src, p.dockRef ?? null, bus, 'panel');
      else if (!min && minBefore.has(p.id)) emitRestored(src, p.dockRef ?? null, bus, 'panel');
      if (shownBefore === null || !known.has(p.id)) { known.add(p.id); continue; }
      const was = shownBefore.has(p.id);
      if (shown && !was) emitOpened('panel', { id: p.id, title: p.title || p.id, icon }, {}, bus);
      else if (!shown && was) emitClosed('panel', { id: p.id, title: p.title || p.id }, bus);
    }
    shownBefore = next;
    minBefore = nextMin;
  }
  scan();
  const off = subscribe(scan);
  return { scan, stop: () => off?.() };
}

/**
 * Feed bus events to a dock (anything with `state` and `act(fn)`):
 *   opened  an item that is already in the dock (a pinned one coming back) just goes live again; a new one goes
 *           through onOpened — docked only when autoDock is on, a terminal opened automatically also tabbed when
 *           autoTabTerminals is on
 *   closed  the item leaves the dock (a pinned one stays, dimmed)
 *   title   a docked item's label follows its window's title
 *   minimized / restored   a minimized window is reached from the dock (onMinimized / onRestored)
 */
export function bindDock(bus, dock) {
  return bus.on((ev) => {
    const it = toItem(ev?.kind, ev?.source);
    if (!it) return;
    if (ev.type === 'opened') dock.act((s) => (s.items[it.id] ? addItem(s, it) : onOpened(s, ev)));
    else if (ev.type === 'closed') dock.act((s) => (ev.kind === 'terminal' ? dropEmptyTerminalGroup(onClosed(s, ev)) : onClosed(s, ev)));
    else if (ev.type === 'title') dock.act((s) => (s.items[it.id] ? addItem(s, it) : s));
    else if (ev.type === 'minimized') dock.act((s) => onMinimized(s, ev));
    else if (ev.type === 'restored') dock.act((s) => onRestored(s, ev));
  });
}
