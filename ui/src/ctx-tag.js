// How a surface says "this element is a <kind> with this id" for context menus. No imports and no DOM calls at import
// time, so the target walk is unit-tested in Node with plain objects.
//
//   tagCtx(el, 'session', id, { node, s })   // at the place that renders the row
//   ctxTargets(el, x, y)                     // what the delegated listener asks on a right-click or long-press
//
// `data-ctx` / `data-ctx-id` are the public contract (CSS, tests, other agents); the data object rides on the element
// (`el._ctx`) because it holds live objects (a session, an app, closures). An element that contains things drawn on a
// canvas (the galaxy) sets `el._ctxAt = (x, y) => target | [target] | null` to say what is under the pointer.
// `data-ctx="native"` keeps the browser's own menu for that subtree (selectable text, previews).

export const CTX_ATTR = 'data-ctx';

export function tagCtx(el, kind, id, data) {
  if (!el) return el;
  el.dataset.ctx = kind;
  if (id != null) el.dataset.ctxId = String(id);
  el._ctx = data ?? null;
  return el;
}

/** Keep the browser's menu inside `el` (selectable text, code, previews). */
export function nativeCtx(el) { if (el) el.dataset.ctx = 'native'; return el; }

/**
 * The surfaces under a pointer, innermost first: { native, targets: [{ kind, id, data, el }] }.
 * `native` is true when the innermost tagged ancestor asked for the browser's menu.
 */
export function ctxTargets(el, x, y) {
  const targets = [];
  let native = false;
  for (let cur = el; cur; cur = cur.parentElement) {
    const kind = cur.dataset?.ctx;
    if (!kind) continue;
    if (kind === 'native') { if (!targets.length) native = true; break; }
    if (typeof cur._ctxAt === 'function') {
      let hit = null;
      try { hit = cur._ctxAt(x, y); } catch { hit = null; }
      for (const t of [].concat(hit || [])) if (t?.kind) targets.push({ id: null, data: null, el: cur, ...t });
    }
    targets.push({ kind, id: cur.dataset.ctxId ?? null, data: cur._ctx ?? null, el: cur });
  }
  return { native, targets };
}
