import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { Terminal } from '@xterm/xterm';
import { api, h, node, toast, wsUrl } from './api.js';
import { openWindow } from './wm.js';
import { currentTheme, onTheme } from './themes.js';
import { CAPS, createDisposer } from './cleanup.js';
import { emitClosed, emitOpened } from './open-events.js';

const live = new Map(); // ptyId → bring-to-front, for terminals open in this page (the app dock's terminal items)
/** Bring an open terminal's window (or tab) to the front; false when it is not open here. */
export function focusTerminal(ptyId) {
  const f = live.get(ptyId);
  if (!f) return false;
  f();
  return true;
}

let tabsHost = null; // the one window that holds auto-opened terminals as tabs (autoTabTerminals in the app dock)

/** The shared "Terminals" window: one tab per session. addTab() returns the same shape openWindow() does, so a tab is mounted like a window. */
function terminalTabs() {
  if (tabsHost) return tabsHost;
  const tabs = [];
  let active = null;
  const bar = h('div', { class: 'term-tabbar', role: 'tablist', 'aria-label': 'Terminals' });
  const panes = h('div', { class: 'term-panes' });
  const slot = h('span', { class: 'term-tab-status' });
  const win = openWindow({ title: 'Terminals', icon: '⌨', width: 900, height: 540, className: 'term-win term-tabs-win', tools: [slot], onClose: () => { tabsHost = null; for (const t of [...tabs]) t.remove(); } });
  win.body.append(bar, panes);
  win.onResize(() => active?.fit());
  const retitle = () => win.setTitle(tabs.length > 1 ? `Terminals · ${tabs.length}` : 'Terminals');
  function activate(t) {
    active = t;
    for (const x of tabs) {
      const on = x === t;
      x.pane.classList.toggle('on', on);
      x.btn.classList.toggle('on', on);
      x.btn.setAttribute('aria-selected', String(on));
      x.btn.tabIndex = on ? 0 : -1;
    }
    slot.replaceChildren(t.status);
    requestAnimationFrame(() => t.fit());
  }
  tabsHost = {
    addTab({ title, tip = title, status, onClose }) {
      const pane = h('div', { class: 'term-pane', role: 'tabpanel' });
      const label = h('span', { class: 'term-tab-label' }, title);
      const x = h('button', { class: 'term-tab-x', type: 'button', title: 'Close tab', 'aria-label': `Close ${tip}` }, '✕');
      const btn = h('div', { class: 'term-tab', role: 'tab', title: tip }, label, x);
      const bin = createDisposer(); // the tab's own cleanups (as a window's): run when the tab closes, also when the whole Terminals window does
      const t = {
        pane, btn, status, resizers: new Set(),
        fit() { for (const fn of this.resizers) fn(); },
        remove() {
          const i = tabs.indexOf(t);
          if (i < 0) return;
          tabs.splice(i, 1);
          btn.remove();
          pane.remove();
          try { onClose?.(); } catch (e) { console.error(e); }
          bin.dispose();
          if (!tabs.length) win.close();
          else { retitle(); if (active === t) activate(tabs[Math.min(i, tabs.length - 1)]); }
        },
      };
      btn.addEventListener('click', () => activate(t));
      btn.addEventListener('keydown', (e) => {
        const i = tabs.indexOf(t);
        const to = e.key === 'ArrowRight' ? tabs[i + 1] : e.key === 'ArrowLeft' ? tabs[i - 1] : e.key === 'Enter' || e.key === ' ' ? t : null;
        if (!to) return;
        e.preventDefault();
        activate(to);
        to.btn.focus();
      });
      x.addEventListener('click', (e) => { e.stopPropagation(); t.remove(); });
      tabs.push(t);
      bar.append(btn);
      panes.append(pane);
      retitle();
      activate(t);
      return {
        el: pane, body: pane, close: () => t.remove(), // el = the tab's pane, so "is the user typing in it" (main.js popup cap) is per tab
        onCleanup: (fn) => bin.add(fn), interval: (fn, ms) => bin.interval(fn, ms), listen: (tg, ev, fn, o) => bin.listen(tg, ev, fn, o),
        setTitle: (s) => { label.textContent = s; btn.title = s; },
        onResize: (fn) => t.resizers.add(fn),
        raise: () => { activate(t); win.raise(); },
      };
    },
  };
  return tabsHost;
}

/**
 * Terminal window on any machine. Either creates a new PTY (shell or a command) or attaches to an
 * existing one (`ptyId`) — several people/machines can watch and type into the same terminal.
 */
export async function openTerminal({ nodeId, nodeName, ptyId, command, cwd, title, kind, auto = false, tab = false } = {}) {
  let id = ptyId;
  if (!id) {
    try {
      const r = await api(`${node(nodeId)}/pty`, { method: 'POST', body: { command, cwd, cols: 120, rows: 32, title, kind } });
      id = r.id;
      title = title || r.title;
    } catch (e) { toast(`Terminal on ${nodeName}: ${e.message}`, 'error'); return null; }
  }
  const status = h('span', { class: 'term-status' }, 'connecting…');
  let ws;
  let closed = false;
  const short = title || 'shell';
  const label = `${nodeName} — ${short}`;
  const dispose = () => { closed = true; offTheme(); ws?.close(); term.dispose(); if (live.get(id) === toFront) live.delete(id); emitClosed('terminal', { id }); };
  // `tab` (an automatically opened session while the app dock's autoTabTerminals is on) mounts in the shared Terminals window; otherwise its own window as always.
  const w = tab ? terminalTabs().addTab({ title: short, tip: label, status, onClose: dispose }) : openWindow({ title: label, icon: '⌨', width: 900, height: 540, className: 'term-win', tools: [status], onClose: dispose });
  const toFront = () => { w.raise(); term.focus(); };
  live.set(id, toFront);
  emitOpened('terminal', { id, nodeId, title: `${short} — ${nodeName}` }, { auto }); // the app dock docks / tabs it when its settings say so
  const term = new Terminal({
    fontFamily: 'ui-monospace, SFMono-Regular, "JetBrains Mono", Menlo, Consolas, monospace', fontSize: 13, cursorBlink: true, allowProposedApi: true, scrollback: CAPS.terminalScrollback,
    theme: currentTheme().terminal,
  });
  const offTheme = onTheme((t) => { term.options.theme = t.terminal; });
  const fit = new FitAddon();
  term.loadAddon(fit);
  term.loadAddon(new WebLinksAddon());
  const holder = h('div', { class: 'term-holder' });
  w.body.append(holder);
  term.open(holder);
  setTimeout(() => { try { fit.fit(); } catch {} term.focus(); }, 30);

  let retries = 0;
  let retryTimer = null;
  w.onCleanup(() => clearTimeout(retryTimer));
  function connect() {
    if (closed) return; // closed while a reconnect was pending: no socket nobody would close
    ws = new WebSocket(wsUrl(`${node(nodeId)}/pty/${id}/ws`));
    ws.onopen = () => { retries = 0; status.textContent = 'live'; status.className = 'term-status live'; sendSize(); };
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.t === 'o') term.write(m.d);
      else if (m.t === 'x') { status.textContent = `exited (${m.code})`; status.className = 'term-status'; }
      else if (m.t === 'e') { term.write(`\r\n\x1b[31m${m.message}\x1b[0m\r\n`); closed = true; }
    };
    ws.onclose = () => {
      if (closed) return;
      status.textContent = 'reconnecting…';
      status.className = 'term-status';
      if (retries++ < 20) retryTimer = setTimeout(() => { if (closed) return; term.reset(); connect(); }, Math.min(5000, 500 * retries));
    };
  }
  function sendSize() { if (ws?.readyState === 1) ws.send(JSON.stringify({ t: 'r', c: term.cols, r: term.rows })); }
  term.onData((d) => { if (ws?.readyState === 1) ws.send(JSON.stringify({ t: 'i', d })); });
  term.onResize(sendSize);
  w.onResize(() => { try { fit.fit(); } catch {} });
  connect();

  return { id, window: w };
}
