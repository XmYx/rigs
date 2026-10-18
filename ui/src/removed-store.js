// Removed items: an app or panel removed from JARVIS is never deleted, only listed here and hidden from the galaxy,
// lists and menus until it is restored. The list persists in localStorage (rigs.removed); the undo/redo history
// lives for the page. Pure (storage injected) so the remove → restore round trip is unit-tested.
//
// An item: { kind: 'panel' | 'app', id, label, icon?, at }

const keyOf = (kind, id) => `${kind}:${id}`;

export function createRemovedStore({ storage = globalThis.localStorage, key = 'rigs.removed', now = () => Date.now(), limit = 50 } = {}) {
  let items = load();
  const undoStack = []; // { op: 'remove' | 'restore', item }
  const redoStack = [];
  const listeners = new Set();

  function load() {
    try {
      const v = JSON.parse(storage?.getItem(key) || '[]');
      return Array.isArray(v) ? v.filter((x) => x && x.kind && x.id != null) : [];
    } catch { return []; }
  }
  function save() { try { storage?.setItem(key, JSON.stringify(items)); } catch { /* private mode */ } }
  function emit(change) { for (const fn of listeners) { try { fn(change, api); } catch { /* one listener must not break the rest */ } } }
  const find = (kind, id) => items.find((x) => keyOf(x.kind, x.id) === keyOf(kind, id)) || null;
  const record = (step) => { undoStack.push(step); if (undoStack.length > limit) undoStack.shift(); redoStack.length = 0; };

  // The two primitive moves; `rec` puts them on the undo history.
  function doRemove(item, rec) {
    if (!item?.kind || item.id == null || find(item.kind, item.id)) return null;
    const it = { kind: item.kind, id: String(item.id), label: item.label || String(item.id), ...(item.icon ? { icon: item.icon } : {}), at: now() };
    items.push(it);
    save();
    if (rec) record({ op: 'remove', item: it });
    emit({ op: 'remove', item: it });
    return it;
  }
  function doRestore(kind, id, rec) {
    const it = find(kind, id);
    if (!it) return null;
    items = items.filter((x) => x !== it);
    save();
    if (rec) record({ op: 'restore', item: it });
    emit({ op: 'restore', item: it });
    return it;
  }
  const apply = (op, item) => (op === 'remove' ? doRemove(item, false) : doRestore(item.kind, item.id, false));

  const api = {
    /** Remove an item (no-op if it already is). Returns the stored item or null. */
    remove: (item) => doRemove(item, true),
    /** Bring an item back. Returns it, or null if it was not removed. */
    restore: (kind, id) => doRestore(kind, id, true),
    restoreAll() { return [...items].map((x) => doRestore(x.kind, x.id, true)).filter(Boolean); },
    isRemoved: (kind, id) => !!find(kind, id),
    list: (kind) => items.filter((x) => !kind || x.kind === kind).map((x) => ({ ...x })),
    get size() { return items.length; },
    canUndo: () => undoStack.length > 0,
    canRedo: () => redoStack.length > 0,
    /** The step Edit > Undo would revert ({op, item}) — for its label. */
    peekUndo: () => undoStack.at(-1) || null,
    peekRedo: () => redoStack.at(-1) || null,
    /** Revert the last remove/restore. Returns the step undone, or null. */
    undo() {
      const step = undoStack.pop();
      if (!step) return null;
      apply(step.op === 'remove' ? 'restore' : 'remove', step.item);
      redoStack.push(step);
      return step;
    },
    /** Do the last undone step again. */
    redo() {
      const step = redoStack.pop();
      if (!step) return null;
      apply(step.op, step.item);
      undoStack.push(step);
      return step;
    },
    /** Re-read storage (another tab changed it). */
    reload() { items = load(); emit({ op: 'reload' }); },
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
  };
  return api;
}
