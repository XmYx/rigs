import { h } from './api.js';
import { isClosed, showPanel } from './panels.js';

// Phone layout (t2). Below 640px wide, or a short touch screen in landscape, the screen becomes:
// a header (side-panel button, Fit/↻, orb + brain badge), the galaxy, the chat dock and a one-row toolbar
// (ask, mic, ⋯). The side panel is a slide-over drawer with a backdrop, the other toolbar buttons live in
// the ⋯ sheet, windows open full-screen (wm.js) and the browser/OS back gesture closes them.
// Geometry is CSS (the "MOBILE LAYOUT (t2)" block in styles.css); this module only moves a few nodes,
// opens/closes the drawer and the sheet, and keeps the bottom bar above the on-screen keyboard.

export const PHONE_QUERY = '(max-width: 640px), (max-height: 500px) and (pointer: coarse)';
const mq = window.matchMedia?.(PHONE_QUERY);
export const isPhone = () => !!mq?.matches;

const $ = (s) => document.querySelector(s);
const root = document.documentElement;

// Short labels for the buttons in the ⋯ sheet (the toolbar shows icons only).
const SHEET = [
  ['btn-hands', 'Hands-free'], ['btn-term', 'Terminal'], ['btn-files', 'Files'], ['btn-desk', 'Desktop'],
  ['btn-sess', 'Sessions'], ['btn-proj', 'Projects'], ['btn-ask', 'Questions'], ['btn-agents', 'Active agents'], ['btn-work', 'Active projects'], ['btn-usage', 'Tokens & time'], ['btn-desktops', 'Desktops'], ['btn-traces', 'Traces'], ['btn-apps', 'Apps'],
  ['btn-mesh', 'Mesh'], ['btn-mute', 'Voice'], ['panels-btn', 'Layout'],
];

let drawerBtn;
let backdrop;
let sheet;
let moreBtn;

// ------------------------------------------------------------------ drawer (#left)
export function drawerOpen() { return document.body.classList.contains('drawer-open'); }

export function openDrawer({ focus = true } = {}) {
  if (!isPhone() || drawerOpen()) return;
  document.body.classList.add('drawer-open');
  drawerBtn?.setAttribute('aria-expanded', 'true');
  closeSheet();
  if (focus) requestAnimationFrame(() => $('#drawer-close')?.focus({ preventScroll: true }));
}

export function closeDrawer({ restore = true } = {}) {
  if (!drawerOpen()) return;
  const inside = $('#left')?.contains(document.activeElement);
  document.body.classList.remove('drawer-open');
  drawerBtn?.setAttribute('aria-expanded', 'false');
  if (restore && inside) drawerBtn?.focus({ preventScroll: true });
}

/** Tapping a node in the galaxy on a phone: show its inspector, which lives in the drawer. */
export function revealInspector() {
  if (!isPhone()) return;
  openDrawer({ focus: false });
  $('#left')?.scrollTo?.({ top: 0 });
}

// ------------------------------------------------------------------ ⋯ sheet
function openSheet() {
  sheet.classList.add('open');
  moreBtn.setAttribute('aria-expanded', 'true');
  closeDrawer({ restore: false });
}
function closeSheet() {
  if (!sheet?.classList.contains('open')) return;
  sheet.classList.remove('open');
  moreBtn.setAttribute('aria-expanded', 'false');
}

/** Toolbar buttons go into the sheet on a phone and back into #bar (in their original order) on a wide screen. */
function placeButtons() {
  const bar = $('#bar');
  const phone = isPhone();
  for (const [id, label] of SHEET) {
    const b = document.getElementById(id);
    if (!b) continue;
    b.dataset.label = label;
    if (phone) { if (b.parentElement !== sheet) sheet.append(b); continue; }
    if (id === 'panels-btn') { if (b.parentElement !== document.body) document.body.insertBefore(b, $('#panels-menu')); continue; }
    if (b.parentElement !== bar) bar.insertBefore(b, moreBtn);
  }
  if (!phone) { closeSheet(); closeDrawer({ restore: false }); }
}

// ------------------------------------------------------------------ on-screen keyboard
// iOS Safari keeps the layout viewport when the keyboard opens, so fixed bottom elements end up behind it.
// --kb is the keyboard's height (0 when the layout viewport already shrank, as on Android with
// interactive-widget=resizes-content); the bar, dock, sheet and windows sit that much higher.
function trackViewport() {
  const vv = window.visualViewport;
  if (!vv) return;
  const update = () => {
    const zoomed = vv.scale > 1.01;
    const kb = zoomed ? 0 : Math.max(0, Math.round(window.innerHeight - vv.height - vv.offsetTop));
    root.style.setProperty('--kb', (kb > 60 ? kb : 0) + 'px');
    // Pinch-zoomed in: let one-finger pans move the page instead of spinning the galaxy, so nobody gets stuck zoomed.
    document.body.classList.toggle('zoomed', zoomed);
  };
  vv.addEventListener('resize', update);
  vv.addEventListener('scroll', update);
  update();
}

// ------------------------------------------------------------------ setup
/** Call once after the panels and the ☰ menu exist (main.js wire()). */
export function initMobile() {
  const left = $('#left');
  drawerBtn = h('button', { id: 'drawer-btn', class: 'round', title: 'Side panel — search, inspector, hubs', 'aria-label': 'Side panel', 'aria-controls': 'left', 'aria-expanded': 'false',
    onclick: () => (drawerOpen() ? closeDrawer() : openDrawer()) }, '☰');
  backdrop = h('div', { id: 'drawer-backdrop', 'aria-hidden': 'true', onclick: () => closeDrawer() });
  const closeBtn = h('button', { id: 'drawer-close', class: 'round', title: 'Close the side panel', 'aria-label': 'Close the side panel', onclick: () => closeDrawer() }, '✕');
  left?.querySelector('.brand')?.append(closeBtn);
  $('#topbar')?.prepend(drawerBtn);
  document.body.append(backdrop);

  moreBtn = h('button', { id: 'btn-more', class: 'round', title: 'More — terminal, files, sessions, projects, questions, active projects, tokens & time, traces, apps, mesh, voice', 'aria-label': 'More controls', 'aria-controls': 'more-sheet', 'aria-expanded': 'false',
    onclick: (e) => { e.stopPropagation(); if (sheet.classList.contains('open')) closeSheet(); else openSheet(); } }, '⋯');
  sheet = h('div', { id: 'more-sheet', class: 'panel', role: 'group', 'aria-label': 'More controls' });
  // A tap on a sheet button does its job and puts the sheet away (☰ Layout opens its own menu above it).
  sheet.addEventListener('click', (e) => { if (e.target.closest('button')) setTimeout(closeSheet, 0); });
  $('#bar')?.append(moreBtn);
  document.body.append(sheet);
  document.addEventListener('pointerdown', (e) => { if (!sheet.contains(e.target) && !moreBtn.contains(e.target) && !e.target.closest?.('#panels-menu')) closeSheet(); });
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (sheet.classList.contains('open')) { closeSheet(); moreBtn.focus(); } else if (drawerOpen()) closeDrawer();
  });
  // The panel's own ✕ is hidden on phones; if it was closed on a wide screen, the drawer button brings it back.
  drawerBtn.addEventListener('click', () => { if (isClosed('left')) showPanel('left'); }, { capture: true });

  placeButtons();
  mq?.addEventListener?.('change', placeButtons);
  trackViewport();
}
