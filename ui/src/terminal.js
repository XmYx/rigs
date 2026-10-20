import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { Terminal } from '@xterm/xterm';
import { api, h, node, toast, wsUrl } from './api.js';
import { openWindow } from './wm.js';
import { currentTheme, onTheme } from './themes.js';
import { CAPS } from './cleanup.js';

/**
 * Terminal window on any machine. Either creates a new PTY (shell or a command) or attaches to an
 * existing one (`ptyId`) — several people/machines can watch and type into the same terminal.
 */
export async function openTerminal({ nodeId, nodeName, ptyId, command, cwd, title, kind } = {}) {
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
  const w = openWindow({ title: `${nodeName} — ${title || 'shell'}`, icon: '⌨', width: 900, height: 540, className: 'term-win', tools: [status], onClose: () => { closed = true; offTheme(); ws?.close(); term.dispose(); } });
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
