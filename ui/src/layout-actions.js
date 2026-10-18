import { toast } from './api.js';
import { focusPanel as focusFloating, hasPanel, listPanels as floatingPanels, resetLayout as resetFloating, setClosed, setRemoved, showPanel } from './panels.js';
import { focusWindow, listWindows } from './wm.js';
import { createRemovedStore } from './removed-store.js';

// The layout adapter: every open / hide / remove / restore / focus of a panel, app or window goes through here, so
// the menus never talk to panels.js or wm.js directly. Today it wraps those two; the dockable panel layout engine
// plugs in with useLayoutEngine() (same shape as `floatingEngine` below) without touching the menus.
//
// A ref names what to act on: { kind: 'panel' | 'app' | 'window', id } (a bare string means a panel id).
// Removal is reversible: the item goes to the persisted Removed list (removed-store.js), the toast offers Undo, and
// Edit > Undo and Window > Removed items bring it back. Apps are never deleted, only hidden from galaxy and lists.

const floatingEngine = {
  name: 'floating-panels',
  panels: () => floatingPanels(),
  has: (id) => hasPanel(id),
  show: (id) => showPanel(id),
  hide: (id) => setClosed(id, true),
  focus: (id) => focusFloating(id),
  setRemoved: (id, on) => setRemoved(id, on),
  reset: () => resetFloating(),
  windows: () => listWindows(),
  focusWindow: (id) => focusWindow(id),
};

let engine = floatingEngine;
export const removed = createRemovedStore();
let appsApi = { list: () => [], open: () => {}, close: () => {}, changed: () => {} };
let lastPanel = null; // the panel last clicked or focused (File > Close panel, Window > Hide others)

/** Swap in another layout engine (the dockable layout); missing methods fall back to the floating panels. */
export function useLayoutEngine(e) { engine = { ...floatingEngine, ...e }; applyRemoved(); }
export const layoutEngine = () => engine;

export const appKey = (a) => `${a.nodeId || a.node}/${a.id}`;
export const isAppRemoved = (a) => removed.isRemoved('app', appKey(a));
const norm = (ref) => (typeof ref === 'string' ? { kind: 'panel', id: ref } : ref || {});

/**
 * Call once after the panels exist. `apps`: { list() → [{ id, nodeId, node, name, icon, open? }], open(app), close(app),
 * changed() } — how JARVIS opens, closes and re-renders apps (main.js).
 */
export function initLayout({ apps } = {}) {
  if (apps) appsApi = { ...appsApi, ...apps };
  applyRemoved();
  removed.subscribe(onChange);
  window.addEventListener('storage', (e) => { if (e.key === 'rigs.removed') removed.reload(); });
  const track = (e) => { const el = e.target?.closest?.('.floating'); const p = el && engine.panels().find((x) => x.el === el); if (p) lastPanel = p.id; };
  document.addEventListener('pointerdown', track, true);
  document.addEventListener('focusin', track, true);
}

function applyRemoved() {
  for (const p of engine.panels()) engine.setRemoved(p.id, removed.isRemoved('panel', p.id));
}

function onChange({ op, item }) {
  if (op === 'reload') { applyRemoved(); appsApi.changed(); return; }
  if (item.kind === 'panel') {
    engine.setRemoved(item.id, op === 'remove');
    if (op === 'restore') engine.show(item.id);
  } else if (item.kind === 'app') {
    if (op === 'remove') { const a = findApp(item.id); if (a) appsApi.close(a); }
    appsApi.changed();
  }
}

const findApp = (key) => appsApi.list().find((a) => appKey(a) === key) || null;

/** What can be shown in Window: panels, apps and open windows (removed ones are left out; see listRemoved). */
export function listPanels() {
  const panels = engine.panels().filter((p) => !removed.isRemoved('panel', p.id))
    .map((p) => ({ kind: 'panel', id: p.id, title: p.title, open: !p.closed }));
  const apps = appsApi.list().filter((a) => !isAppRemoved(a))
    .map((a) => ({ kind: 'app', id: appKey(a), title: a.name, icon: a.icon || '▦', node: a.node, open: !!a.open, app: a }));
  const windows = engine.windows().map((w) => ({ kind: 'window', id: w.id, title: w.title, icon: w.icon, open: true }));
  return [...panels, ...apps, ...windows];
}

export const listRemoved = () => removed.list();
export const lastFocusedPanel = () => (lastPanel && !removed.isRemoved('panel', lastPanel) && engine.panels().some((p) => p.id === lastPanel && !p.closed) ? lastPanel : null);

function titleOf(ref) {
  if (ref.kind === 'panel') return engine.panels().find((p) => p.id === ref.id)?.title || ref.id;
  if (ref.kind === 'app') return findApp(ref.id)?.name || ref.id;
  return engine.windows().find((w) => w.id === ref.id)?.title || ref.id;
}

export function openPanel(ref) {
  const r = norm(ref);
  if (r.kind === 'panel') { if (removed.isRemoved('panel', r.id)) removed.restore('panel', r.id); engine.show(r.id); return true; }
  if (r.kind === 'app') {
    if (removed.isRemoved('app', r.id)) removed.restore('app', r.id);
    const a = findApp(r.id);
    if (a) appsApi.open(a);
    return !!a;
  }
  if (r.kind === 'window') return engine.focusWindow(r.id);
  return false;
}

export function hidePanel(ref) {
  const r = norm(ref);
  if (r.kind === 'panel') { engine.hide(r.id); return true; }
  if (r.kind === 'window') { const w = engine.windows().find((x) => x.id === r.id); w?.close(); return !!w; }
  if (r.kind === 'app') { const a = findApp(r.id); if (a) appsApi.close(a); return !!a; }
  return false;
}

export function focusPanel(ref) {
  const r = norm(ref);
  if (r.kind === 'panel') { engine.focus(r.id); lastPanel = r.id; return true; }
  if (r.kind === 'window') return engine.focusWindow(r.id);
  if (r.kind === 'app') return openPanel(r);
  return false;
}

/** Remove a panel or app (reversibly) and offer Undo in a toast. Windows are just closed. */
export function removePanel(ref, { notify = true } = {}) {
  const r = norm(ref);
  if (r.kind === 'window') return hidePanel(r);
  if (r.kind !== 'panel' && r.kind !== 'app') return false;
  const a = r.kind === 'app' ? findApp(r.id) : null;
  const item = removed.remove({ kind: r.kind, id: r.id, label: titleOf(r), icon: a?.icon });
  if (!item) return false;
  if (notify) {
    toast(`Removed “${item.label}”. Bring it back from Window › Removed items.`, 'ok', undefined, {
      label: 'Undo',
      run: () => { const s = removed.peekUndo(); if (s?.op === 'remove' && s.item.kind === item.kind && s.item.id === item.id) removed.undo(); else restorePanel({ kind: item.kind, id: item.id }); },
    });
  }
  return true;
}

export function restorePanel(ref) {
  const r = norm(ref);
  return !!removed.restore(r.kind, r.id);
}

/** Hide every panel except `keep` (default: the last one used) and the toolbar. */
export function hideOthers(keep = lastFocusedPanel()) {
  for (const p of engine.panels()) if (p.id !== keep && p.id !== 'bar' && !p.closed) engine.hide(p.id);
}

/** Show every panel that is not removed. */
export function showAll() {
  for (const p of engine.panels()) if (!removed.isRemoved('panel', p.id)) engine.show(p.id);
}

export function resetLayout() { engine.reset(); }
