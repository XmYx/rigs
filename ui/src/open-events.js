// Open / close events for the app dock's auto-docking. No DOM, no side effects of its own: wm.js and terminal.js call
// emitOpened / emitClosed from their existing open and close paths, trackPanels() turns panel show / hide into the same
// events, and bindDock() feeds them to the dock as the t1 state transitions (onOpened / onClosed). With autoDock and
// autoTabTerminals off (the default) the state transitions change nothing, so listening costs nothing visible.
// Unit-tested in test/app-dock-auto.test.js.
import { addItem, mergeSources, onClosed, onOpened, removeItem, TERMINAL_GROUP, toItem, ungroup } from './app-dock-state.js';

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
  const shown = panels.filter((p) => !p.closed && !p.removed).map((p) => ({ id: p.id, title: p.title || p.id, icon: '▤' }));
  return dropEmptyTerminalGroup(mergeSources(s, { panels: shown }));
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
 * Windows that get no 'window' dock item: terminals (docked as terminal items) and app windows (their applet tile
 * already shows a running dot).
 */
const SKIP_WINDOW = /(^|\s)(term-win|app-win)(\s|$)/;
export const dockableWindow = (className) => !SKIP_WINDOW.test(className || '');

/**
 * Turn panel show / hide into opened / closed events. `list()` → [{ id, title, closed, removed }] (panels.js listPanels),
 * `subscribe(fn)` → unsubscribe (dockManager.subscribe). The first scan is the baseline — nothing already on screen
 * counts as "opened" — and a panel registered later is baselined on first sight too; only a known panel changing between
 * hidden and shown is an event. Returns { scan, stop }.
 */
export function trackPanels({ list, subscribe, bus = openBus, icon = '▤' }) {
  let shownBefore = null;
  const known = new Set();
  function scan() {
    const next = new Set();
    for (const p of list() || []) {
      const shown = !p.closed && !p.removed;
      if (shown) next.add(p.id);
      if (shownBefore === null || !known.has(p.id)) { known.add(p.id); continue; }
      const was = shownBefore.has(p.id);
      if (shown && !was) emitOpened('panel', { id: p.id, title: p.title || p.id, icon }, {}, bus);
      else if (!shown && was) emitClosed('panel', { id: p.id, title: p.title || p.id }, bus);
    }
    shownBefore = next;
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
 */
export function bindDock(bus, dock) {
  return bus.on((ev) => {
    const it = toItem(ev?.kind, ev?.source);
    if (!it) return;
    if (ev.type === 'opened') dock.act((s) => (s.items[it.id] ? addItem(s, it) : onOpened(s, ev)));
    else if (ev.type === 'closed') dock.act((s) => (ev.kind === 'terminal' ? dropEmptyTerminalGroup(onClosed(s, ev)) : onClosed(s, ev)));
    else if (ev.type === 'title') dock.act((s) => (s.items[it.id] ? addItem(s, it) : s));
  });
}
