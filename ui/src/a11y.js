// Accessibility layer (t3): one place for the behaviours the rest of the UI shares.
//  - announce(): a polite/assertive live region for JARVIS replies and task status changes
//  - dialogify(): role=dialog + focus move/trap + Escape + focus return, used by windows and popovers
//  - initA11y(): names icon-only controls and unlabeled fields, makes click-only elements keyboard
//    operable (role=button, tabindex, Enter/Space) and makes scrollable lists focusable. It runs over the
//    existing DOM and over everything added later, so new markup is covered without touching each call site.

export const prefersReducedMotion = () => !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

// ------------------------------------------------------------------ live region
let polite = null;
let assertive = null;
let pending = null;

function region(kind) {
  const el = document.createElement('div');
  el.className = 'sr-only';
  el.setAttribute('role', kind === 'assertive' ? 'alert' : 'status');
  el.setAttribute('aria-live', kind);
  el.setAttribute('aria-atomic', 'true');
  document.body.append(el);
  return el;
}

/** Say `text` to assistive tech. Polite announcements are debounced so a streaming reply is read once, when it settles. */
export function announce(text, { assertive: loud = false, delay = loud ? 0 : 900 } = {}) {
  polite ||= region('polite');
  assertive ||= region('assertive');
  const el = loud ? assertive : polite;
  clearTimeout(pending);
  const say = () => { el.textContent = ''; setTimeout(() => { el.textContent = String(text || '').replace(/\s+/g, ' ').trim().slice(0, 600); }, 30); };
  if (loud || !delay) say(); else pending = setTimeout(say, delay);
}

// ------------------------------------------------------------------ dialogs
const FOCUSABLE = 'a[href],button:not([disabled]),input:not([disabled]):not([type=hidden]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';
const visible = (el) => el.offsetParent !== null || el === document.activeElement;

const defaultTrigger = () => (document.activeElement && document.activeElement !== document.body ? document.activeElement : lastTrigger);

/**
 * Make `el` a dialog: role, name, focus moves in, Tab stays inside, Escape calls onClose, and release() puts
 * focus back on the trigger. Escape and Tab are left alone inside a terminal (xterm sends them to the shell).
 */
export function dialogify(el, { label, onClose, trigger = defaultTrigger(), focus = true } = {}) {
  el.setAttribute('role', 'dialog');
  if (label) el.setAttribute('aria-label', label);
  if (!el.hasAttribute('tabindex')) el.setAttribute('tabindex', '-1');
  const onKey = (e) => {
    if (e.target.closest?.('.xterm')) return;
    if (e.key === 'Escape' && onClose && !e.defaultPrevented) { e.preventDefault(); e.stopPropagation(); onClose(); return; }
    if (e.key !== 'Tab') return;
    const items = [...el.querySelectorAll(FOCUSABLE)].filter(visible);
    if (!items.length) { e.preventDefault(); el.focus(); return; }
    const first = items[0];
    const last = items[items.length - 1];
    const active = document.activeElement;
    if (e.shiftKey && (active === first || active === el)) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && (active === last || !el.contains(active))) { e.preventDefault(); first.focus(); }
  };
  el.addEventListener('keydown', onKey);
  if (focus) requestAnimationFrame(() => { if (!el.contains(document.activeElement)) el.focus({ preventScroll: true }); });
  return {
    release({ restore = true } = {}) {
      el.removeEventListener('keydown', onKey);
      if (restore && trigger && trigger !== document.body && document.contains(trigger) && (!document.activeElement || document.activeElement === document.body || el.contains(document.activeElement))) {
        trigger.focus({ preventScroll: true });
      }
    },
  };
}

/** A popover that is shown/hidden by a class (brain menu, panels menu): dialog semantics while open. */
function watchPopover(el, { label, isOpen, close }) {
  if (!el) return;
  let d = null;
  const onDocKey = (e) => { if (e.key === 'Escape' && !el.contains(document.activeElement)) { e.preventDefault(); close(); } }; // focus may still be on the trigger button
  const sync = () => {
    const open = isOpen(el);
    if (open && !d) { d = dialogify(el, { label, onClose: close, trigger: lastTrigger, focus: false }); document.addEventListener('keydown', onDocKey); }
    else if (!open && d) { d.release(); d = null; document.removeEventListener('keydown', onDocKey); }
  };
  el.setAttribute('role', 'dialog');
  el.setAttribute('aria-label', label);
  new MutationObserver(sync).observe(el, { attributes: true, attributeFilter: ['class'] });
  sync();
}

// ------------------------------------------------------------------ names, roles, keyboard
let lastTrigger = null;
let activeDialog = null;
const NATIVE = new Set(['A', 'BUTTON', 'INPUT', 'SELECT', 'TEXTAREA', 'SUMMARY', 'OPTION', 'LABEL']);
const nativeInteractive = (el) => NATIVE.has(el.tagName) && !(el.tagName === 'A' && !el.hasAttribute('href'));
const hasText = (el) => /[\p{L}\p{N}]/u.test(el.textContent || '');
const SCROLLERS = '.file-list,.sess-list,.win-body,.wk-list,#search-results,#subtitle,.files-split > div,.sess-split > div';

function labelFor(el) {
  return el.getAttribute('aria-label') || el.getAttribute('aria-labelledby') || el.labels?.length || el.closest('label');
}

function fixOne(el) {
  if (el.nodeType !== 1 || el.getAttribute('aria-hidden') === 'true') return;
  const tag = el.tagName;
  if (tag === 'BUTTON' || el.getAttribute('role') === 'button') {
    if (!el.hasAttribute('aria-label') && !hasText(el) && el.title) el.setAttribute('aria-label', el.title);
  } else if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') {
    if (!labelFor(el)) {
      const name = el.title || el.placeholder || (tag === 'SELECT' ? el.options?.[0]?.textContent : '') || el.id?.replace(/^d-|^btn-/, '');
      if (name) el.setAttribute('aria-label', name.replace(/…$/, ''));
    }
  } else if (el.dataset.a11yClick === '1' && !nativeInteractive(el)) {
    makeClickable(el);
  }
  if (el.matches?.(SCROLLERS) && !el.hasAttribute('tabindex') && el.scrollHeight > el.clientHeight + 1) {
    el.setAttribute('tabindex', '0');
    if (!el.getAttribute('role')) el.setAttribute('role', 'region');
    if (!el.hasAttribute('aria-label')) el.setAttribute('aria-label', el.getAttribute('title') || el.dataset.label || 'Scrollable content');
  }
}

/** Give a click-only element the role, focus stop and (via the document handler) Enter/Space of a button. */
export function makeClickable(el) {
  if (el.getAttribute('role') !== 'button' && !el.getAttribute('role')) el.setAttribute('role', 'button');
  if (!el.hasAttribute('tabindex')) el.setAttribute('tabindex', '0');
  if (!el.hasAttribute('aria-label') && !hasText(el) && el.title) el.setAttribute('aria-label', el.title);
}

function scan(root) {
  if (root.nodeType !== 1) return;
  fixOne(root);
  for (const el of root.querySelectorAll('button,[role=button],input,select,textarea,[data-a11y-click],' + SCROLLERS)) fixOne(el);
}

export function initA11y() {
  // Lists here re-render on a timer with replaceChildren(); keep keyboard focus on the equivalent control
  // (same position among the focusable ones) instead of letting it fall to <body>.
  const replace = Element.prototype.replaceChildren;
  Element.prototype.replaceChildren = function replaceChildren(...nodes) {
    const a = document.activeElement;
    if (!a || a === document.body || a === this || !this.contains(a)) return replace.apply(this, nodes);
    const idx = [...this.querySelectorAll(FOCUSABLE)].indexOf(a);
    replace.apply(this, nodes);
    if (idx >= 0 && (!document.activeElement || document.activeElement === document.body)) [...this.querySelectorAll(FOCUSABLE)][idx]?.focus({ preventScroll: true });
  };
  // Anything given a click handler through `el.onclick = …` or an `onclick` attribute of h() is flagged here
  // (h() sets data-a11y-click itself for addEventListener-style handlers).
  const desc = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'onclick');
  if (desc?.set) {
    Object.defineProperty(HTMLElement.prototype, 'onclick', {
      configurable: true, enumerable: desc.enumerable, get: desc.get,
      set(fn) { desc.set.call(this, fn); if (typeof fn === 'function' && !nativeInteractive(this)) { this.dataset.a11yClick = '1'; queueMicrotask(() => fixOne(this)); } },
    });
  }
  document.addEventListener('pointerdown', (e) => { lastTrigger = e.target.closest?.('button,[role=button],a,input') || lastTrigger; }, true);
  document.addEventListener('focusin', (e) => {
    const dlg = e.target.closest?.('[role=dialog]');
    if (dlg) activeDialog = dlg; else lastTrigger = e.target;
  });
  // A dialog that re-renders its list drops focus to <body>; Tab then re-enters the dialog instead of leaking out
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Tab' || document.activeElement !== document.body || !activeDialog?.isConnected || e.target.closest?.('.xterm')) return;
    const items = [...activeDialog.querySelectorAll(FOCUSABLE)].filter(visible);
    if (!items.length) return;
    e.preventDefault();
    (e.shiftKey ? items[items.length - 1] : items[0]).focus();
  }, true);
  // Enter / Space activate role=button elements that are not native buttons
  document.addEventListener('keydown', (e) => {
    const el = e.target;
    if (e.defaultPrevented || !el?.matches?.('[role=button][data-a11y-click]')) return;
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); el.click(); }
  });
  polite ||= region('polite'); // live regions exist before the first announcement so screen readers register them
  assertive ||= region('assertive');
  // Handlers assigned before this ran (main.js wire(): the orb, face, dock title…) were not seen by the setter above
  for (const el of document.body.querySelectorAll('*')) if (typeof el.onclick === 'function' && !nativeInteractive(el)) el.dataset.a11yClick = '1';
  scan(document.body);
  let queued = new Set();
  let raf = 0;
  let grown = new Set(); // scroll containers whose rows just changed: they may have started to scroll
  new MutationObserver((muts) => {
    for (const m of muts) {
      for (const n of m.addedNodes) if (n.nodeType === 1) queued.add(n);
      const s = m.addedNodes.length && m.target.closest?.(SCROLLERS);
      if (s) grown.add(s);
    }
    if (!raf && (queued.size || grown.size)) raf = requestAnimationFrame(() => {
      raf = 0;
      const q = queued; const g = grown; queued = new Set(); grown = new Set();
      for (const n of q) if (n.isConnected) scan(n);
      for (const s of g) if (s.isConnected) fixOne(s);
    });
  }).observe(document.body, { childList: true, subtree: true });
  // Content that scrolls only after it fills in (lists load async) is picked up on resize/load too
  setInterval(() => { for (const el of document.querySelectorAll(SCROLLERS)) fixOne(el); }, 3000);
}

/** Popovers that exist once the UI is wired: the brain menu. */
export function initPopovers() {
  watchPopover(document.getElementById('brain-menu'), { label: 'Brain', isOpen: (e) => e.classList.contains('open'), close: () => document.getElementById('brain-menu').classList.remove('open') });
}
