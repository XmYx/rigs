import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { Terminal } from '@xterm/xterm';
import { api, h, node, toast, wsUrl } from './api.js';
import { openWindow } from './wm.js';

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
  const w = openWindow({ title: `${nodeName} — ${title || 'shell'}`, icon: '⌨', width: 900, height: 540, className: 'term-win', tools: [status], onClose: () => { closed = true; ws?.close(); term.dispose(); } });
  const term = new Terminal({
    fontFamily: 'ui-monospace, SFMono-Regular, "JetBrains Mono", Menlo, Consolas, monospace', fontSize: 13, cursorBlink: true, allowProposedApi: true, scrollback: 20000,
    theme: { background: '#05090e', foreground: '#d7e3ea', cursor: '#5eead4', selectionBackground: '#164e63', black: '#0b1218', brightBlack: '#475569', cyan: '#22d3ee', brightCyan: '#67e8f9', green: '#4ade80', magenta: '#c084fc', yellow: '#fbbf24', blue: '#60a5fa', red: '#f87171' },
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  term.loadAddon(new WebLinksAddon());
  const holder = h('div', { class: 'term-holder' });
  w.body.append(holder);
  term.open(holder);
  setTimeout(() => { try { fit.fit(); } catch {} term.focus(); }, 30);

  let retries = 0;
  function connect() {
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
      if (retries++ < 20) setTimeout(() => { term.reset(); connect(); }, Math.min(5000, 500 * retries));
    };
  }
  function sendSize() { if (ws?.readyState === 1) ws.send(JSON.stringify({ t: 'r', c: term.cols, r: term.rows })); }
  term.onData((d) => { if (ws?.readyState === 1) ws.send(JSON.stringify({ t: 'i', d })); });
  term.onResize(sendSize);
  w.onResize(() => { try { fit.fit(); } catch {} });
  connect();

  return { id, window: w };
}
