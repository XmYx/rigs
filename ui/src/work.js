import { api, h, toast } from './api.js';

// The work dashboard: a floating panel with everything working right now across the mesh — agent
// sessions (model, tokens, context, todo progress), JARVIS answers in progress, projects with their
// task progress — and the plan limits: 5-hour session, week, per-model week (Fable…), and Codex.
// Polls /api/mesh/work while it is visible.

const fmt = (n) => (n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? Math.round(n / 1e3) + 'k' : String(n || 0));
const MODEL = (m) => String(m || '').replace(/^claude-/, '').replace(/-\d{8}$/, '');
const until = (iso) => {
  if (!iso) return '';
  const ms = (typeof iso === 'number' ? iso * 1000 : Date.parse(iso)) - Date.now();
  if (!(ms > 0)) return 'resetting';
  const hh = Math.floor(ms / 3.6e6);
  const mm = Math.round((ms % 3.6e6) / 6e4);
  return hh >= 24 ? `resets in ${Math.floor(hh / 24)}d ${hh % 24}h` : hh ? `resets in ${hh}h ${mm}m` : `resets in ${mm}m`;
};
const ago = (t) => { const s = Math.max(0, (Date.now() - t) / 1000); return s < 60 ? `${Math.round(s)}s` : s < 3600 ? `${Math.round(s / 60)}m` : `${Math.round(s / 3600)}h`; };

function bar(label, pct, sub = '') {
  const v = Math.max(0, Math.min(100, Number(pct) || 0));
  const lvl = v >= 90 ? 'hot' : v >= 70 ? 'warm' : '';
  return h('div', { class: 'wk-limit' },
    h('div', { class: 'wk-lrow' }, h('span', {}, label), h('b', {}, `${Math.round(v)}%`)),
    h('div', { class: `wk-bar ${lvl}` }, h('i', { style: { width: v + '%' } })),
    sub ? h('div', { class: 'wk-sub' }, sub) : null);
}

function progress(pct) {
  return h('div', { class: 'wk-bar thin' }, h('i', { style: { width: Math.max(0, Math.min(100, pct)) + '%' } }));
}

/** Mount the dashboard into `el` (an aside). Returns { refresh, setActive }. */
export function createWork(el, { onOpenProject, onOpenQuestion } = {}) {
  const head = h('div', { class: 'wk-head keep' }, h('span', { class: 'wk-title' }, 'Work'), h('span', { class: 'wk-meta' }, ''));
  const limits = h('div', { class: 'wk-limits' });
  const questions = h('div', { class: 'wk-questions' });
  const list = h('div', { class: 'wk-list' });
  el.append(head, limits, questions, list);
  let timer = null;
  let active = true;
  let last = null;
  let typing = false; // don't redraw the questions while Sir is typing an answer
  let waiting = []; // [{ g, it }] every question now, so a project row can lead straight to its agent

  function renderLimits(w) {
    const p = w.plan || {};
    const lims = [];
    if (p.session) lims.push(bar('5-hour session', p.session.pct, until(p.session.resetsAt)));
    if (p.week) lims.push(bar('Week · all models', p.week.pct, until(p.week.resetsAt)));
    for (const m of p.models || []) lims.push(bar(`Week · ${m.name}`, m.pct, until(m.resetsAt)));
    if (!lims.length) lims.push(h('div', { class: 'muted small' }, p.error ? `Limits unavailable: ${p.error}` : 'Reading plan limits…'));
    limits.replaceChildren(...lims);
  }

  // Projects only: name and how far along — the agents behind them are RIGS's business.
  function renderProjects(w) {
    const rows = [];
    for (const n of w.nodes || []) {
      for (const pj of n.projects || []) {
        const asks = waiting.filter((q) => q.it.project?.id === pj.id);
        rows.push(h('div', { class: 'wk-row' + (pj.running.length ? ' busy' : '') + (pj.blocked ? ' stuck' : '') + (asks.length ? ' asks' : ''), title: `Open ${pj.name}`, onclick: () => onOpenProject?.(n, pj) },
          h('div', { class: 'wk-rtitle' }, h('i', { class: 'wk-dot' }), pj.name,
            asks.length ? h('button', { class: 'wk-ask', title: 'An agent on this project is asking you — open its session', onclick: (e) => { e.stopPropagation(); onOpenQuestion?.(asks[0].g, asks[0].it); } }, `? ${asks.length > 1 ? asks.length + ' questions' : 'question'}`) : null,
            h('b', {}, `${pj.pct}%`)),
          progress(pj.pct)));
      }
    }
    if (!rows.length) rows.push(h('div', { class: 'muted small pad' }, 'No projects running.'));
    list.replaceChildren(h('div', { class: 'wk-section' }, 'Projects'), ...rows);
    head.lastChild.textContent = `${rows.filter((r) => r.classList?.contains('busy')).length} active`;
  }

  async function answer(g, it, body, path) {
    try {
      await api(`/api/nodes/${g.nodeId}/sessions/${path}`, { method: 'POST', body: { kind: it.session.kind, id: it.session.id, ...body } });
      toast(`Answered ${it.title || 'the agent'} on ${g.node}`, 'ok');
    } catch (e) { toast(e.message, 'error', 9000); }
    typing = false;
    setTimeout(loadQuestions, 1500);
  }

  function renderQuestions(groups) {
    waiting = (groups || []).flatMap((g) => (g.items || []).map((it) => ({ g, it })));
    if (last) renderProjects(last);
    if (typing) return;
    const cards = [];
    for (const g of groups || []) {
      for (const it of g.items || []) {
        const who = { claude: 'Claude', codex: 'Codex' }[it.agent] || it.agent || 'Agent';
        const canType = it.session && ['tmux', 'rig', 'pty'].includes(it.session.kind);
        const input = canType ? h('input', { class: 'wk-reply', placeholder: 'Type an answer…', onfocus: () => { typing = true; }, onblur: () => { if (!input.value) typing = false; },
          onkeydown: (e) => { if (e.key === 'Enter' && input.value.trim()) answer(g, it, { text: input.value.trim() }, 'send'); } }) : null;
        // Clicking the question (anything but its buttons and reply box) goes straight to the agent's session.
        const open = (e) => { if (!e.target.closest('button, input')) onOpenQuestion?.(g, it); };
        cards.push(h('div', { class: 'wk-q', title: 'Open the session', onclick: open },
          h('div', { class: 'wk-qhead' }, h('b', {}, `${who} · ${g.node}`), ' ', h('span', {}, it.title || '')),
          h('div', { class: 'wk-qtext' }, it.question || it.reason || 'Waiting for you'),
          it.options?.length ? h('div', { class: 'wk-qopts' }, ...it.options.map((o) => h('button', { class: 'btn', title: o.label, onclick: () => answer(g, it, { choice: o.n }, 'answer') }, `${o.n}. ${o.label}`))) : null,
          h('div', { class: 'wk-qfoot' }, input, h('button', { class: 'tb', title: 'Open the session', onclick: () => onOpenQuestion?.(g, it) }, '↗'))));
      }
    }
    questions.classList.toggle('on', cards.length > 0);
    questions.replaceChildren(...(cards.length ? [h('div', { class: 'wk-section attn' }, `Questions · ${cards.length}`), ...cards] : []));
  }

  async function loadQuestions() {
    try { renderQuestions(await api('/api/mesh/attention?options=1')); } catch {}
  }

  async function refresh(force = false) {
    loadQuestions();
    try {
      const w = await api(`/api/mesh/work${force ? '?force=1' : ''}`);
      last = w;
      renderLimits(w);
      renderProjects(w);
    } catch (e) { if (!last) limits.replaceChildren(h('div', { class: 'muted small' }, e.message)); }
  }
  function setActive(on) {
    active = on;
    clearInterval(timer);
    if (on) { refresh(); timer = setInterval(refresh, 8000); }
  }
  head.ondblclick = () => refresh(true);
  setActive(true);
  return { refresh, setActive, get active() { return active; } };
}
