import { ago, h } from './api.js';
import { activeAgents, filterAgents, pruneDismissed, agentKey, agentSig } from './agents-data.js';
import { tagCtx } from './ctx-tag.js';

// The Active agents panel: every live agent session on every online machine (Claude Code, Codex, OpenRig
// seats, agent terminals) plus ones that finished in the last 12h — one click on a row attaches to it, the X
// removes it (per browser; it comes back if its state changes). It redraws with each mesh snapshot.

const ICON = { claude: '✳', codex: '◈', ollama: '🦙' };
const STATE_LABEL = { waiting: 'waiting for you', working: 'working', idle: 'idle', done: 'finished' };
const STORE = 'rigs.agents.dismissed';
const loadDismissed = () => { try { return JSON.parse(localStorage.getItem(STORE)) || {}; } catch { return {}; } };
const saveDismissed = (d) => { try { localStorage.setItem(STORE, JSON.stringify(d)); } catch { /* private mode: dismissal lasts until reload */ } };
const MODEL = (m) => String(m || '').replace(/^claude-/, '').replace(/-\d{8}$/, '');

/** Mount the panel into `el` (an aside). Returns { update, count }. `onCount(n)` feeds the toolbar badge. */
export function createAgents(el, { snapshot, onAttach, onChat, onCount }) {
  const head = h('div', { class: 'ag-head keep' }, h('span', { class: 'ag-title' }, 'Active agents'), h('span', { class: 'ag-meta' }, ''));
  const list = h('div', { class: 'ag-list', role: 'list' });
  el.append(head, list);
  let n = 0;
  let dismissed = pruneDismissed(loadDismissed());

  function row(r) {
    const { machine, session: s, state } = r;
    const agent = /claude/i.test(s.agent || s.kind) ? 'claude' : /codex/i.test(s.agent || s.kind) ? 'codex' : s.agent || s.kind;
    const where = s.project || (s.cwd ? s.cwd.split(/[\\/]/).filter(Boolean).pop() : '') || s.rig || s.title || '';
    const model = s.model ? ` · ${MODEL(s.model)}` : '';
    const open = () => onAttach(machine, s);
    const chat = h('button', { class: 'ag-chat', title: 'Chat with this agent here', 'aria-label': `Chat with ${where || agent} on ${machine.name}`, onclick: (e) => { e.stopPropagation(); onChat?.(machine, s); } }, '💬');
    const x = h('button', { class: 'ag-x', title: 'Remove from list', 'aria-label': `Remove ${where || s.id} from list`, onclick: (e) => {
      e.stopPropagation();
      dismissed = { ...pruneDismissed(dismissed), [agentKey(r)]: { sig: agentSig(r), at: Date.now() } };
      saveDismissed(dismissed);
      update();
    } }, '✕');
    return tagCtx(h('div', { class: `ag-row ${state}`, role: 'listitem', tabindex: '0', title: `Attach to ${s.title || s.id}${s.role ? ` (${s.role})` : ''} on ${machine.name}`,
      onclick: open, onkeydown: (e) => { if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); open(); } } },
      h('span', { class: 'ag-ico', 'aria-hidden': 'true' }, ICON[agent] || '⌨'),
      h('div', { class: 'ag-main' },
        h('div', { class: 'ag-line' }, h('b', {}, where || s.id), h('span', { class: 'ag-kind' }, `${agent}${model}`)),
        h('div', { class: 'ag-sub' }, h('span', { class: 'ag-mach' }, machine.name), ' · ', h('span', { class: `ag-state ${state}` }, STATE_LABEL[state]), s.updatedAt ? ` · ${ago(s.updatedAt)}` : '')),
      s.kind !== 'chat' && onChat && state !== 'done' ? chat : null, x), 'session', s.id, { node: machine, s });
  }

  function update() {
    dismissed = pruneDismissed(dismissed);
    const rows = filterAgents(activeAgents(snapshot()), { dismissed });
    const finished = rows.filter((r) => r.state === 'done').length;
    n = rows.length - finished;
    const waiting = rows.filter((r) => r.state === 'waiting').length;
    head.querySelector('.ag-meta').textContent = rows.length ? `${n} live${waiting ? ` · ${waiting} waiting` : ''}${finished ? ` · ${finished} finished` : ''}` : '';
    list.replaceChildren(...(rows.length ? rows.map(row)
      : [h('div', { class: 'ag-empty' }, 'No running agents, and none finished in the last 12 hours. Sessions show up here the moment a Claude Code, Codex or OpenRig seat starts on any machine.')]));
    onCount?.(n, waiting);
  }

  return { update, count: () => n };
}
