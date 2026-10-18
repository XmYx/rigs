import { toast } from './api.js';
import { inTextField } from './commands.js';
import { ctxTargets } from './ctx-tag.js';
import { resolveMenu } from './ctx-providers.js';
import { isPhone } from './mobile.js';
import { closeMenus, contextMenuOpen, openMenuAt } from './menubar.js';

// The context menu: ONE delegated listener for the whole page. Right-click (or the Menu key / Shift+F10, or a long
// press on touch) finds the surfaces under the pointer through data-ctx attributes (ctx-tag.js), asks the providers
// (ctx-providers.js) for the items and shows them with the menu bar's own renderer (menubar.js openMenuAt): themed,
// animated, ARIA role=menu, arrow keys / Home / End / typeahead / Esc, submenus, shortcuts, kept inside the viewport.
//
// What keeps the browser's own menu: text fields and terminals (so Cut/Copy/Paste and spell-check work), links and
// media, anything under data-ctx="native", and any click with Shift held (the escape hatch for everything else).

const LONG_PRESS_MS = 520;
const MOVE_TOLERANCE = 10; // px a finger may drift and still be a press

/** Copy to the clipboard (async API, else the old way) and say so. */
export async function copyText(text, what = 'Text') {
  try { await navigator.clipboard.writeText(text); }
  catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.cssText = 'position:fixed;opacity:0;pointer-events:none';
    document.body.append(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch { /* blocked */ }
    ta.remove();
    if (!ok) { toast('Could not copy — the browser blocked the clipboard.', 'error'); return false; }
  }
  toast(`${what} copied`, 'ok', 2500);
  return true;
}

/** Should the browser's menu be left alone here? */
export function keepsNativeMenu(target, { shiftKey = false } = {}) {
  if (shiftKey) return true;
  if (!target?.closest) return false;
  return inTextField(target) || !!target.closest('a[href], video, audio');
}

function selectionAt(target) {
  const sel = globalThis.getSelection?.();
  const text = sel && !sel.isCollapsed ? sel.toString().trim() : '';
  return text && (sel.containsNode?.(target, true) ?? false) ? text : '';
}

/**
 * Install the listener. `providers` is the registry from createProviders() (filled by registerJarvisProviders).
 * `ctx()` adds to what providers see. Returns { openAt(x, y, target), dispose }.
 */
export function installContextMenu({ providers, ctx = () => ({}) }) {
  let press = null; // a touch that may become a long press
  let lastOpen = 0;
  const disposers = [];
  const on = (target, type, fn, opts) => { target.addEventListener(type, fn, opts); disposers.push(() => target.removeEventListener(type, fn, opts)); };

  /** Open the menu for what is under (x, y). False when the browser's own menu should show instead. */
  function openAt(x, y, target, { touch = false } = {}) {
    const { native, targets } = ctxTargets(target, x, y);
    if (native) return false;
    const entries = resolveMenu(providers, targets, { ...ctx(), phone: isPhone(), selection: selectionAt(target), copy: copyText });
    if (!entries.length) return false;
    // 2px off the pointer (like the OS menus): the button release must land on the page, not on the first item (and OrbitControls on the galaxy still gets its pointerup).
    openMenuAt(x + 2, y + (touch ? 8 : 2), entries, { label: targets[0] ? `${targets[0].kind} menu` : 'Context menu' });
    lastOpen = Date.now();
    return true;
  }

  on(document, 'contextmenu', (ev) => {
    const t = ev.target;
    if (t?.closest?.('.mb-menu')) { ev.preventDefault(); return; } // no menu on a menu
    if (keepsNativeMenu(t, ev)) { closeMenus({ restore: false }); return; }
    clearTimeout(press?.timer);
    press = null;
    let { clientX: x, clientY: y } = ev;
    if (!x && !y && t?.getBoundingClientRect) { const r = t.getBoundingClientRect(); x = r.left + Math.min(24, r.width / 2); y = r.bottom - Math.min(8, r.height / 2); } // Menu key / Shift+F10
    if (openAt(x, y, t, { touch: ev.pointerType === 'touch' })) ev.preventDefault();
  });

  // Touch has no right button: a long press stands in (iOS never sends contextmenu; Android sends it about as late as we do).
  const cancel = () => { if (press) { clearTimeout(press.timer); press = null; } };
  on(document, 'pointerdown', (ev) => {
    cancel();
    if (ev.pointerType === 'mouse' || !ev.isPrimary || ev.target?.closest?.('.mb-menu') || keepsNativeMenu(ev.target)) return;
    const p = { x: ev.clientX, y: ev.clientY, target: ev.target };
    p.timer = setTimeout(() => {
      press = null;
      if (Date.now() - lastOpen < 900) return; // the native contextmenu event got there first
      if (!openAt(p.x, p.y, p.target, { touch: true })) return;
      // The finger lifting must not also click what is underneath, and the browser must not start a text selection.
      const stop = (e) => { e.stopPropagation(); e.preventDefault(); };
      document.addEventListener('click', stop, { capture: true, once: true });
      setTimeout(() => document.removeEventListener('click', stop, true), 800);
      globalThis.getSelection?.()?.removeAllRanges();
    }, LONG_PRESS_MS);
    press = p;
  }, true);
  on(document, 'pointermove', (ev) => { if (press && Math.hypot(ev.clientX - press.x, ev.clientY - press.y) > MOVE_TOLERANCE) cancel(); }, { capture: true, passive: true });
  for (const type of ['pointerup', 'pointercancel']) on(document, type, cancel, true);
  on(document, 'scroll', (ev) => { cancel(); if (contextMenuOpen() && !ev.target?.closest?.('.mb-menu')) closeMenus({ restore: false }); }, true);

  return { openAt, dispose() { cancel(); for (const d of disposers.splice(0)) d(); } };
}
