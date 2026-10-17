import { api, h } from './api.js';
import { announce } from './a11y.js';

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
export function createWork(el, { onOpenSession, onOpenTask, onOpenProject } = {}) {
  const head = h('div', { class: 'wk-head keep' }, h('span', { class: 'wk-title' }, 'Work'), h('span', { class: 'wk-meta' }, ''));
  const limits = h('div', { class: 'wk-limits' });
  const list = h('div', { class: 'wk-list' });
  el.append(head, limits, list);
  let timer = null;
  let active = true;
  let last = null;
  const seenStatus = new Map(); // task/project key → status line, to announce changes to screen readers

  function render(w) {
    last = w;
    for (const n of w.nodes || []) for (const pj of n.projects || []) {
      const key = `${n.node}/${pj.name}`;
      const line = `${pj.done} of ${pj.total} tasks done${pj.blocked ? `, ${pj.blocked} stuck` : ''}`;
      if (seenStatus.has(key) && seenStatus.get(key) !== line) announce(`Project ${pj.name}: ${line}`);
      seenStatus.set(key, line);
    }
    const p = w.plan || {};
    const lims = [];
    if (p.session) lims.push(bar('5-hour session', p.session.pct, until(p.session.resetsAt)));
    if (p.week) lims.push(bar('Week · all models', p.week.pct, until(p.week.resetsAt)));
    for (const m of p.models || []) lims.push(bar(`Week · ${m.name}`, m.pct, until(m.resetsAt)));
    const codex = (w.nodes || []).map((n) => n.codex).find(Boolean);
    if (codex?.session) lims.push(bar('Codex 5-hour', codex.session.pct, until(codex.session.resetsAt)));
    if (codex?.week) lims.push(bar('Codex week', codex.week.pct, until(codex.week.resetsAt)));
    if (!lims.length) lims.push(h('div', { class: 'muted small' }, p.error ? `Limits unavailable: ${p.error}` : 'Reading plan limits…'));
    limits.replaceChildren(...lims);

    const rows = [];
    let busy = 0;
    for (const n of w.nodes || []) {
      for (const j of n.jarvis || []) {
        busy++;
        rows.push(h('div', { class: 'wk-row busy' },
          h('div', { class: 'wk-rtitle' }, h('i', { class: 'wk-dot' }), `◆ JARVIS — ${j.title || j.text}`),
          h('div', { class: 'wk-rmeta' }, `${n.node} · ${MODEL(j.model) || j.brain} · answering for ${ago(j.startedAt)}`)));
      }
      for (const pj of n.projects || []) {
        // A project and, under it, every agent it has cast — click a project to open it, an agent to watch its session
        rows.push(h('div', { class: 'wk-row' + (pj.running.length ? ' busy' : ''), title: 'Open the project', onclick: () => onOpenProject?.(n, pj) },
          h('div', { class: 'wk-rtitle' }, h('i', { class: 'wk-dot' }), `${pj.main ? '◆' : '📋'} ${pj.name}`, h('b', {}, `${pj.pct}%`)),
          progress(pj.pct),
          h('div', { class: 'wk-rmeta' }, `${pj.done}/${pj.total} tasks${pj.running.length ? ` · ${pj.running.length} agent${pj.running.length > 1 ? 's' : ''} working` : ''}${pj.blocked ? ` · ${pj.blocked} stuck` : ''}`)));
        for (const t of pj.running) {
          busy++;
          rows.push(h('div', { class: 'wk-row wk-agent busy', title: t.via ? `Watch ${t.via}` : '', onclick: (e) => { e.stopPropagation(); onOpenTask?.(t); } },
            h('div', { class: 'wk-rtitle' }, h('i', { class: 'wk-dot' }), `↳ ${t.title}`),
            h('div', { class: 'wk-rmeta' }, [MODEL(t.model), t.effort, t.node, t.via, t.startedAt ? `for ${ago(t.startedAt)}` : ''].filter(Boolean).join(' · '))));
        }
      }
      for (const s of n.sessions || []) {
        const recent = s.status === 'busy' || Date.now() - (s.lastAt || 0) < 20 * 60000;
        if (!recent) continue;
        if (s.status === 'busy') busy++;
        const tok = s.tokens ? `${fmt(s.tokens.input + s.tokens.cacheRead + s.tokens.cacheWrite)} in · ${fmt(s.tokens.output)} out` : '';
        const models = (s.models || []).map((m) => MODEL(m.model)).join(', ');
        rows.push(h('div', { class: `wk-row ${s.status === 'busy' ? 'busy' : ''}`, title: `${s.cwd}\n${s.id}${s.pids.length > 1 ? `\nopen in ${s.pids.length} processes` : ''}`, onclick: () => onOpenSession?.(n, s) },
          h('div', { class: 'wk-rtitle' }, h('i', { class: 'wk-dot' }), `✳ ${s.title}`, s.progress ? h('b', {}, `${s.progress.pct}%`) : null),
          s.progress ? progress(s.progress.pct) : null,
          h('div', { class: 'wk-rmeta' }, [n.node, models || MODEL(s.model), tok, s.context ? `ctx ${fmt(s.context)}` : '', s.status === 'busy' ? 'working' : `idle ${ago(s.lastAt)}`].filter(Boolean).join(' · ')),
          s.progress?.current ? h('div', { class: 'wk-rnow' }, '→ ' + s.progress.current) : null));
      }
    }
    if (!rows.length) rows.push(h('div', { class: 'muted small pad' }, 'Nothing is running.'));
    list.replaceChildren(...rows);
    head.lastChild.textContent = `${busy} working`;
  }

  async function refresh(force = false) {
    try { render(await api(`/api/mesh/work${force ? '?force=1' : ''}`)); } catch (e) { if (!last) limits.replaceChildren(h('div', { class: 'muted small' }, e.message)); }
  }
  function setActive(on) {
    active = on;
    clearInterval(timer);
    if (on) { refresh(); timer = setInterval(refresh, 15000); }
  }
  head.ondblclick = () => refresh(true);
  setActive(true);
  return { refresh, setActive, get active() { return active; } };
}
