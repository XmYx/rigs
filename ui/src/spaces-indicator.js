import { h } from './api.js';
import { formatShortcut, isMac } from './commands.js';
import { contextMenuOpen, openMenuAt } from './menubar.js';
import { registerTrayItem } from './tray.js';
import { desktopMenu } from './jarvis-commands.js';
import { activeDesktop, listDesktops, onSpacesChange } from './wm.js';

// The desktop indicator in the menu bar tray (Spaces, wm.js / spaces.js): the active desktop's name, with a dot per
// desktop when there are a few. A click opens the desktops menu (jarvis-commands.js desktopMenu: switch, previous /
// next, add, rename, remove). Desktop browsers only: a phone has one desktop and no indicator (not in the phone tray).

const MAX_DOTS = 6;
const btns = new Set();
let openedFrom = null; // the button whose menu is open (a second click closes it)
let wasOpen = false;

function paint(el) {
  const ds = listDesktops();
  const cur = activeDesktop();
  const keys = `${formatShortcut('Ctrl+ArrowLeft', isMac())} / ${formatShortcut('Ctrl+ArrowRight', isMac())}, ${formatShortcut('Ctrl+1', isMac())}…9`;
  const title = `${cur.name} (${cur.index + 1} of ${ds.length}) — switch, add or remove desktops · ${keys}`;
  el.title = title;
  el.setAttribute('aria-label', `Desktops: ${cur.name}, ${cur.index + 1} of ${ds.length}`);
  const dots = ds.length > 1 && ds.length <= MAX_DOTS
    ? h('span', { class: 'tray-space-dots', 'aria-hidden': 'true' }, ...ds.map((d) => h('i', { class: d.active ? 'on' : '' })))
    : null;
  el.replaceChildren(...[dots, h('span', { class: 'tray-space-name' }, cur.name)].filter(Boolean));
}

function openMenu(el) {
  const r = el.getBoundingClientRect();
  openMenuAt(r.left, r.bottom + 4, desktopMenu(), { label: 'Desktops' });
  openedFrom = el;
}

// A press on the button while its menu is open: the menu bar closes it on pointerdown, so the click must not reopen it.
window.addEventListener('pointerdown', (e) => { wasOpen = !!openedFrom?.contains(e.target) && contextMenuOpen(); }, true);

registerTrayItem({
  id: 'spaces', order: 1, label: 'Desktops',
  render() {
    const el = h('button', { class: 'tray-item tray-space', 'aria-haspopup': 'menu', 'data-spaces': '1' });
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      if (wasOpen) { wasOpen = false; openedFrom = null; return; }
      openMenu(el);
    });
    paint(el);
    btns.add(el);
    return el;
  },
  update: paint,
});

onSpacesChange(() => { for (const b of btns) if (b.isConnected) paint(b); else btns.delete(b); });
