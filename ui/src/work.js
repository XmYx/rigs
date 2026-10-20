import { api, h, toast } from './api.js';
import { announce } from './a11y.js';
import { tagCtx } from './ctx-tag.js';

// Two floating panels. "Active projects" (createWork): the running projects with their progress (finished
// ones at 100% drop off the list); polls /api/mesh/work while it is visible.
// "Questions" (createQuestions): the agents waiting on Sir, with reply box and option buttons; polls
// /api/mesh/attention?options=1 while it is visible. Each polls only while open (setActive).

const fmt = (n) => (n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? Math.round(n / 1e3) + 'k' : String(n || 0));
const MODEL = (m) => String(m || '').replace(/^claude-/, '').replace(/-\d{8}$/, '');
const ago = (t) => { const s = Math.max(0, (Date.now() - t) / 1000); return s < 60 ? `${Math.round(s)}s` : s < 3600 ? `${Math.round(s / 60)}m` : `${Math.round(s / 3600)}h`; };

function progress(pct) {
  return h('div', { class: 'wk-bar thin' }, h('i', { style: { width: Math.max(0, Math.min(100, pct)) + '%' } }));
}

/** Mount the Active projects panel into `el` (an aside). `getWaiting()` → the questions now open, so a
 * project row can show its "? question" badge. Returns { refresh, rerender, setActive }. */
export function createWork(el, { onOpenProject, onOpenQuestions, getWaiting = () => [] } = {}) {
  const head = h('div', { class: 'wk-head keep' }, h('span', { class: 'wk-title' }, 'Active projects'), h('span', { class: 'wk-meta' }, ''));
  const list = h('div', { class: 'wk-list' });
  el.append(head, list);
  let timer = null;
  let active = true;
  let last = null;
  const seenStatus = new Map(); // project key → progress line, to announce changes to screen readers

  // Projects only: name and how far along — the agents behind them are RIGS's business.
  function renderProjects(w) {
    const rows = [];
    const waiting = getWaiting();
    const live = new Set();
    for (const n of w.nodes || []) {
      for (const pj of n.projects || []) {
        if (pj.pct >= 100) continue; // done: nothing left to watch
        const key = `${n.node}/${pj.id}`;
        const line = `${pj.pct}% done${pj.blocked ? ', stuck' : ''}`;
        if (seenStatus.has(key) && seenStatus.get(key) !== line) announce(`Project ${pj.name}: ${line}`);
        seenStatus.set(key, line);
        live.add(key);
        const asks = waiting.filter((q) => q.project?.id === pj.id);
        rows.push(tagCtx(h('div', { class: 'wk-row' + (pj.running.length ? ' busy' : '') + (pj.blocked ? ' stuck' : '') + (asks.length ? ' asks' : ''), title: `Open ${pj.name}`, onclick: () => onOpenProject?.(n, pj) },
          h('div', { class: 'wk-rtitle' }, h('i', { class: 'wk-dot' }), pj.name,
            asks.length ? h('button', { class: 'wk-ask', title: 'An agent on this project is asking you — open the Questions panel', 'aria-label': `${pj.name}: ${asks.length} question${asks.length > 1 ? 's' : ''} waiting — open Questions`, onclick: (e) => { e.stopPropagation(); onOpenQuestions?.(asks[0]); } }, `? ${asks.length > 1 ? asks.length + ' questions' : 'question'}`) : null,
            h('b', {}, `${pj.pct}%`)),
          progress(pj.pct)), 'project', pj.id, { id: pj.id, name: pj.name, ownerId: n.nodeId, blocked: pj.blocked, running: pj.running }));
      }
    }
    for (const k of seenStatus.keys()) if (!live.has(k)) seenStatus.delete(k); // finished projects are forgotten
    if (!rows.length) rows.push(h('div', { class: 'muted small pad' }, 'No projects running.'));
    list.replaceChildren(...rows);
    head.lastChild.textContent = `${(w.nodes || []).reduce((c, n) => c + (n.projects || []).filter((p) => p.running.length).length, 0)} active`;
  }

  async function refresh(force = false) {
    try {
      const w = await api(`/api/mesh/work${force ? '?force=1' : ''}`);
      last = w;
      renderProjects(w);
    } catch (e) { if (!last) list.replaceChildren(h('div', { class: 'muted small pad' }, e.message)); }
  }
  function setActive(on) {
    active = on;
    clearInterval(timer);
    if (on) { refresh(); timer = setInterval(refresh, 8000); }
  }
  head.ondblclick = () => refresh(true);
  setActive(true);
  return { refresh, rerender: () => { if (last) renderProjects(last); }, setActive, get active() { return active; } };
}

/** Mount the Questions panel into `el`: every agent waiting on Sir. Returns { refresh, setActive }. */
export function createQuestions(el, { onOpenQuestion } = {}) {
  const head = h('div', { class: 'wk-head keep' }, h('span', { class: 'wk-title attn' }, 'Questions'), h('span', { class: 'wk-meta' }, ''));
  const list = h('div', { class: 'wk-questions on' });
  el.append(head, list);
  let timer = null;
  let active = true;
  let typing = false; // don't redraw the questions while Sir is typing an answer

  async function answer(g, it, body, path) {
    try {
      await api(`/api/nodes/${g.nodeId}/sessions/${path}`, { method: 'POST', body: { kind: it.session.kind, id: it.session.id, ...body } });
      toast(`Answered ${it.title || 'the agent'} on ${g.node}`, 'ok');
    } catch (e) { toast(e.message, 'error', 9000); }
    typing = false;
    setTimeout(refresh, 1500);
  }

  function render(groups) {
    const n = (groups || []).reduce((c, g) => c + (g.items || []).length, 0);
    head.lastChild.textContent = n ? `${n} waiting` : '';
    if (typing) return;
    const cards = [];
    for (const g of groups || []) {
      for (const it of g.items || []) {
        const who = { claude: 'Claude', codex: 'Codex' }[it.agent] || it.agent || 'Agent';
        const canType = it.session && ['tmux', 'rig', 'pty'].includes(it.session.kind);
        const input = canType ? h('input', { class: 'wk-reply', placeholder: 'Type an answer…', 'aria-label': `Answer ${it.title || who}`, onfocus: () => { typing = true; }, onblur: () => { if (!input.value) typing = false; },
          onkeydown: (e) => { if (e.key === 'Enter' && input.value.trim()) answer(g, it, { text: input.value.trim() }, 'send'); } }) : null;
        // Clicking the question (anything but its buttons and reply box) goes straight to the agent's session.
        const open = (e) => { if (!e.target.closest('button, input')) onOpenQuestion?.(g, it); };
        const card = h('div', { class: 'wk-q', title: 'Open the session', onclick: open },
          h('div', { class: 'wk-qhead' }, h('b', {}, `${who} · ${g.node}`), ' ', h('span', {}, it.title || '')),
          h('div', { class: 'wk-qtext' }, it.question || it.reason || 'Waiting for you'),
          it.options?.length ? h('div', { class: 'wk-qopts' }, ...it.options.map((o) => h('button', { class: 'btn', title: o.label, onclick: () => answer(g, it, { choice: o.n }, 'answer') }, `${o.n}. ${o.label}`))) : null,
          h('div', { class: 'wk-qfoot' }, input, h('button', { class: 'tb', title: 'Open the session', 'aria-label': 'Open the session', onclick: () => onOpenQuestion?.(g, it) }, '↗')));
        cards.push(it.session ? tagCtx(card, 'session', it.session.id, { node: { id: g.nodeId, name: g.node }, s: it.session }) : card);
      }
    }
    list.replaceChildren(...(cards.length ? cards : [h('div', { class: 'muted small pad' }, 'No agent is waiting for you.')]));
  }

  async function refresh() {
    try { render(await api('/api/mesh/attention?options=1')); } catch {}
  }
  function setActive(on) {
    active = on;
    clearInterval(timer);
    if (on) { refresh(); timer = setInterval(refresh, 8000); }
  }
  setActive(true);
  return { refresh, setActive, get active() { return active; } };
}
