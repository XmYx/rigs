import { h } from './api.js';
import { openWindow } from './wm.js';
import { renderReply } from './visual.js';

// The Visuals stage: every animated card JARVIS produces lands here, inside JARVIS. It opens by itself when
// a reply carries a visual block, and JARVIS builds cards from live data (mesh status, apps, tool results)
// when the context calls for it. One stage window; new cards are prepended so the latest is on top.

let win = null;
let feed = null;

function ensure() {
  if (win && document.body.contains(win.el)) return win;
  feed = h('div', { class: 'stage-feed' });
  win = openWindow({ title: 'Visuals', icon: '◈', width: 620, height: 560, className: 'stage-win', onClose: () => { win = null; feed = null; } });
  win.body.append(feed);
  return win;
}

/** Show a visual block (or a reply text containing visual blocks) on the stage, newest first. */
export function showOnStage(text, { title = '' } = {}) {
  if (!/```visual/.test(text)) return;
  const w = ensure();
  const card = h('section', { class: 'stage-card', 'aria-label': title || 'Visual card' }, title ? h('div', { class: 'stage-title' }, title) : '', h('div', { class: 'stage-body' }));
  renderReply(card.querySelector('.stage-body'), text);
  feed.prepend(card);
  w.raise();
}

/** Build visual blocks from live mesh data: a status board and a metrics panel, as JSON text. */
export function meshVisualText(snap) {
  const machines = snap.map((e) => e.node);
  const status = {
    kind: 'status', title: 'Mesh',
    items: machines.map((m) => ({ name: m.name, state: !m.online ? 'bad' : m.rigs ? 'ok' : 'warn', value: !m.online ? 'offline' : m.rigs ? 'online' : 'no daemon' })),
  };
  const metrics = {
    kind: 'metrics', title: 'Machines',
    items: machines.filter((m) => m.stats).map((m) => ({ label: m.name, value: Math.round(m.stats.cpu || 0), unit: '%', tone: (m.stats.cpu || 0) > 80 ? 'bad' : (m.stats.cpu || 0) > 50 ? 'warn' : 'ok' })),
  };
  const blocks = [status, metrics.items.length ? metrics : null].filter(Boolean);
  return blocks.map((b) => '```visual\n' + JSON.stringify(b) + '\n```').join('\n\n');
}
