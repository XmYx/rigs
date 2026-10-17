// Auto-open terminals for agent sessions started in the background anywhere on the mesh.
// Pure bookkeeping (no DOM) so it can be unit-tested.

export const STAGGER_MS = 350;

export function createPopups({ enabled = () => true, open, now = () => Date.now(), schedule = (fn, ms) => setTimeout(fn, ms) } = {}) {
  const seen = new Set();
  let nextAt = 0;
  const keyOf = (nodeId, kind, id) => `${nodeId}:${kind}:${id}`;
  return {
    keyOf,
    /** Remember a session the user already has a window for (attach/start from this UI). */
    mark: (nodeId, kind, id) => { seen.add(keyOf(nodeId, kind, id)); },
    has: (nodeId, kind, id) => seen.has(keyOf(nodeId, kind, id)),
    /** Handle a WS notify message; returns true when a window was (or will be) opened. */
    handle(m) {
      const s = m?.session;
      if (!s?.id || !s.nodeId || !enabled()) return false;
      const k = keyOf(s.nodeId, s.kind, s.id);
      if (seen.has(k)) return false;
      seen.add(k);
      // Several arriving at once open one after another instead of all in the same frame.
      const t = now();
      nextAt = Math.max(nextAt, t);
      const delay = nextAt - t;
      nextAt += STAGGER_MS;
      schedule(() => open(s), delay);
      return true;
    },
  };
}
