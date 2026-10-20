// The `ui-open` push (src/ui-open.js, MCP ui_open) → what main.js does with it. Pure (test/ui-open.test.js).
// A new view = a name in VIEWS and a branch in uiOpenAction; main.js's onUiOpen runs the result.

export const VIEWS = ['files'];

const baseName = (p) => String(p || '').split(/[\\/]/).filter(Boolean).pop() || String(p || '');

/**
 * A ui-open push → { id, view, nodeId, nodeName, path, select, showHidden, toast } or null when it is not one this UI
 * can open. `machines` are the mesh's machines ({ id, name }), for the window title when the push only names an id.
 */
export function uiOpenAction(m, { machines = [] } = {}) {
  if (!m || m.type !== 'ui-open' || !VIEWS.includes(m.view) || !m.nodeId || !m.path) return null;
  const known = machines.find((x) => x.id === m.nodeId) || machines.find((x) => x.name === m.nodeName);
  const nodeName = known?.name || m.nodeName || m.nodeId;
  const select = String(m.select || '');
  return {
    id: String(m.id || ''), view: m.view, nodeId: known?.id || m.nodeId, nodeName, path: String(m.path), select,
    // A dotfile to select only shows with hidden files on.
    showHidden: !!select && baseName(select).startsWith('.'),
    toast: m.missing ? `${m.requested || 'That path'} isn't on ${nodeName}; opened ${m.path} instead.` : '',
  };
}

/**
 * Which open file-browser window gets the push: the one for that machine (navigate it), else none (open a new one).
 * `wins` = Map nodeId → window handle; a closed handle is skipped.
 */
export function filesTarget(wins, nodeId) {
  const w = wins?.get?.(nodeId);
  return w && !w.closed ? w : null;
}

/** Trace ids this UI sent, newest last, capped (re-claimed on every reconnect). */
export function addClaim(list = [], traceId, cap = 20) {
  if (!/^tr-\d{8}-[0-9a-f]{12}$/.test(String(traceId || '')) || list.includes(traceId)) return list;
  return [...list, traceId].slice(-cap);
}
