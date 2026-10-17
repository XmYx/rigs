import { ago, h } from './api.js';
import { activeAgents } from './agents-data.js';

// The Active agents panel: every live agent session on every online machine (Claude Code, Codex, OpenRig
// seats, agent terminals) — one click on a row attaches to it. It redraws with each mesh snapshot.

const ICON = { claude: '✳', codex: '◈', ollama: '🦙' };
const STATE_LABEL = { waiting: 'waiting for you', working: 'working', idle: 'idle' };
const MODEL = (m) => String(m || '').replace(/^claude-/, '').replace(/-\d{8}$/, '');

/** Mount the panel into `el` (an aside). Returns { update, count }. `onCount(n)` feeds the toolbar badge. */
export function createAgents(el, { snapshot, onAttach, onChat, onCount }) {
  const head = h('div', { class: 'ag-head keep' }, h('span', { class: 'ag-title' }, 'Active agents'), h('span', { class: 'ag-meta' }, ''));
  const list = h('div', { class: 'ag-list', role: 'list' });
  el.append(head, list);
  let n = 0;

  function row({ machine, session: s, state }) {
    const agent = /claude/i.test(s.agent || s.kind) ? 'claude' : /codex/i.test(s.agent || s.kind) ? 'codex' : s.agent || s.kind;
    const where = s.project || (s.cwd ? s.cwd.split(/[\\/]/).filter(Boolean).pop() : '') || s.rig || s.title || '';
    const model = s.model ? ` · ${MODEL(s.model)}` : '';
    const open = () => onAttach(machine, s);
    const chat = h('button', { class: 'ag-chat', title: 'Chat with this agent here', 'aria-label': `Chat with ${where || agent} on ${machine.name}`, onclick: (e) => { e.stopPropagation(); onChat?.(machine, s); } }, '💬');
    return h('div', { class: `ag-row ${state}`, role: 'listitem', tabindex: '0', title: `Attach to ${s.title || s.id}${s.role ? ` (${s.role})` : ''} on ${machine.name}`,
      onclick: open, onkeydown: (e) => { if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); open(); } } },
      h('span', { class: 'ag-ico', 'aria-hidden': 'true' }, ICON[agent] || '⌨'),
      h('div', { class: 'ag-main' },
        h('div', { class: 'ag-line' }, h('b', {}, where || s.id), h('span', { class: 'ag-kind' }, `${agent}${model}`)),
        h('div', { class: 'ag-sub' }, h('span', { class: 'ag-mach' }, machine.name), ' · ', h('span', { class: `ag-state ${state}` }, STATE_LABEL[state]), s.updatedAt ? ` · ${ago(s.updatedAt)}` : '')),
      s.kind !== 'chat' && onChat ? chat : null);
  }

  function update() {
    const rows = activeAgents(snapshot());
    n = rows.length;
    const waiting = rows.filter((r) => r.state === 'waiting').length;
    head.querySelector('.ag-meta').textContent = n ? `${n} live${waiting ? ` · ${waiting} waiting` : ''}` : '';
    list.replaceChildren(...(rows.length ? rows.map(row)
      : [h('div', { class: 'ag-empty' }, 'No live agents right now. Sessions show up here the moment a Claude Code, Codex or OpenRig seat starts on any machine.')]));
    onCount?.(n, waiting);
  }

  return { update, count: () => n };
}
