import { api, h, node } from './api.js';
import { barWidths, classView, headline, modeText, span1 } from './preroute-format.js';

// "Tokens & time" floating panel: what each model spent (time, tokens, cost) on which tasks and what came out of it,
// from the usage ledger (GET /api/usage, mesh-wide). Range chips, totals, by model / project / task and the latest
// runs, and the Pre-routing section (mesh /api/preroute/stats: time saved by the router, per route class). Polls only
// while open (setActive).

const RANGES = [['24h', '24h'], ['7d', '7 days'], ['30d', '30 days'], ['', 'All']];
const fmt = (n) => (n >= 1e9 ? (n / 1e9).toFixed(1) + 'B' : n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? Math.round(n / 1e3) + 'k' : String(Math.round(n || 0)));
const dur = (ms) => { const s = Math.round((ms || 0) / 1000); return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${Math.floor(s / 3600)}h ${Math.round((s % 3600) / 60)}m`; };
const usd = (c) => (c == null ? '' : c < 0.01 && c > 0 ? '<$0.01' : '$' + c.toFixed(2));
const MODEL = (m) => String(m || '').replace(/^claude-/, '').replace(/-\d{8}$/, '');
const when = (t) => new Date(t).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
const STATUS = { done: '✓', failed: '✗', blocked: '⏸', stopped: '■' };

function sectionRows(title, groups, label, max = 8) {
  const rows = (groups || []).slice(0, max);
  const top = Math.max(1, ...rows.map((g) => g.totalTokens));
  return [h('div', { class: 'wk-section' }, title),
    ...(rows.length ? rows.map((g) => h('div', { class: 'wk-row us-row', title: `${label(g)} — ${g.count} run${g.count === 1 ? '' : 's'}, in ${fmt(g.inputTokens)} · out ${fmt(g.outputTokens)} · cache ${fmt(g.cacheReadTokens + g.cacheWriteTokens)}${g.estimated ? ' (partly estimated)' : ''}` },
      h('div', { class: 'wk-rtitle' }, label(g), h('b', {}, fmt(g.totalTokens))),
      h('div', { class: 'wk-bar thin' }, h('i', { style: { width: Math.round((g.totalTokens / top) * 100) + '%' } })),
      h('div', { class: 'wk-rmeta' }, `${dur(g.durationMs)} · ${g.count}×${g.costUsd != null ? ' · ' + usd(g.costUsd) : ''}${g.estimated ? ' · ~est' : ''}`)))
      : [h('div', { class: 'muted small pad' }, 'Nothing recorded.')])];
}

/** The Pre-routing section: headline, mode, per-class saving as a diverging bar (left of centre = slower), router cost. */
function prerouteNodes(pre) {
  const out = [h('div', { class: 'wk-section' }, 'Pre-routing')];
  if (!pre || (!pre.stats && !pre.router)) { out.push(h('div', { class: 'muted small pad' }, pre?.error || 'Not measured yet.')); return out; }
  const s = pre.stats;
  const hl = s ? headline(s) : { text: 'Savings unavailable', tone: 'none', note: pre.error };
  out.push(h('div', { class: 'us-pr-head ' + hl.tone, role: 'status' },
    h('b', {}, hl.text),
    s?.estimated ? h('span', { class: 'chip warn', title: 'Some of the baseline is estimated: no request has run with pre-routing off yet. Switch it off for a few requests to measure it.' }, 'estimated') : null));
  if (hl.note) out.push(h('div', { class: 'muted small' }, hl.note));
  const mode = modeText(pre.router);
  if (mode) out.push(h('div', { class: 'us-pr-mode' }, h('span', { class: 'chip ' + (pre.router?.preroute === false ? '' : 'st-ok') }, 'mode'), ' ', mode));
  const views = ['answer', 'work'].map((c) => classView(c, s?.classes?.[c])).filter(Boolean);
  const widths = barWidths(views);
  views.forEach((v, i) => out.push(h('div', { class: 'wk-row us-row us-pr-row', title: `${v.label}: ${v.detail}\n${v.router}\n${v.baseline}` },
    h('div', { class: 'wk-rtitle' }, v.label, v.estimated ? h('span', { class: 'chip warn us-est', title: v.baseline }, 'est.') : null, h('b', { class: 'us-sv ' + v.tone }, v.savedText)),
    h('div', { class: 'us-div', role: 'img', 'aria-label': `${v.label}: ${v.savedText}` }, h('i', { class: v.tone, style: { width: widths[i] + '%', [v.saved < 0 ? 'right' : 'left']: '50%' } })),
    h('div', { class: 'wk-rmeta' }, v.detail),
    v.router ? h('div', { class: 'wk-rmeta' }, v.router) : null)));
  if (s && !views.length) out.push(h('div', { class: 'muted small pad' }, 'No requests in this range.'));
  const t = s?.total;
  if (t?.requests) out.push(h('div', { class: 'muted small' }, `${s.preroute?.on ?? t.requests} pre-routed · ${s.preroute?.off || 0} direct${t.savedPerRequestMs == null ? '' : ' · ' + span1(Math.abs(t.savedPerRequestMs)) + (t.savedPerRequestMs < 0 ? ' slower' : ' faster') + ' per request'}`));
  if (s?.errors?.length) out.push(h('div', { class: 'muted small' }, `No answer from ${s.errors.map((e) => e.node).join(', ')}.`));
  return out;
}

// Tool reuse (src/toolbox.js): how often agents ran filed tools instead of writing a helper, and how often tool_list found one.
function toolReuseRows(u) {
  if (!u || !(u.runs || u.lists || u.hinted)) return [];
  const stat = (k, v) => h('div', { class: 'us-stat' }, h('b', {}, String(v)), h('span', {}, k));
  const rows = (u.byTool || []).slice(0, 6);
  return [h('div', { class: 'wk-section' }, 'Tool reuse'),
    h('div', { class: 'us-stats' }, stat('tool runs', u.runs), stat('searches', `${u.listHits}/${u.lists}`), stat('named in briefs', u.hinted), stat('failed', u.failed)),
    ...rows.map((t) => h('div', { class: 'wk-row us-row', title: `${t.id}: ${t.runs} run${t.runs === 1 ? '' : 's'}${t.failed ? ` (${t.failed} failed)` : ''}, found by ${t.listed} search${t.listed === 1 ? '' : 'es'}, named in ${t.hinted} brief${t.hinted === 1 ? '' : 's'}` },
      h('div', { class: 'wk-rtitle' }, t.id, h('b', {}, `${t.runs}×`)),
      h('div', { class: 'wk-rmeta' }, `listed ${t.listed} · named ${t.hinted}${t.failed ? ` · ${t.failed} failed` : ''}`)))];
}

/** Claude accounts of this machine (src/claude-accounts.js): 5-hour / weekly use each, which one the next run uses, and the mode. */
function accountRows(acc, onMode) {
  if (!acc?.accounts?.length) return [];
  const pct = (w) => (w ? Math.round(w.pct) + '%' : '—');
  const mode = h('select', { class: 'mini', 'aria-label': 'Which Claude account new runs use', onchange: (e) => onMode(e.target.value) },
    h('option', { value: 'auto', selected: acc.mode === 'auto' }, 'auto — most room'), ...acc.accounts.map((a) => h('option', { value: a.id, selected: acc.mode === a.id }, a.label || a.id)));
  return [h('div', { class: 'wk-section' }, 'Claude accounts'),
    h('div', { class: 'wk-row us-row' }, h('div', { class: 'wk-rtitle' }, 'New runs', mode), h('div', { class: 'wk-rmeta' }, `next → ${acc.next} · ${acc.why}`)),
    ...acc.accounts.map((a) => h('div', { class: 'wk-row us-row', title: a.limits?.error ? `Not readable: ${a.limits.error}. Log in with: ${a.login}` : a.dir || '~/.claude' },
      h('div', { class: 'wk-rtitle' }, `${a.id === acc.next ? '● ' : ''}${a.label || a.id}`, h('b', {}, `5h ${pct(a.limits?.session)} · wk ${pct(a.limits?.week)}`)),
      h('div', { class: 'wk-bar thin' }, h('i', { style: { width: Math.min(100, Math.round(a.limits?.week?.pct || 0)) + '%' } })),
      a.limits?.error ? h('div', { class: 'wk-rmeta' }, `not logged in? ${a.login}`) : null)),
    acc.accounts.length < 2 ? h('div', { class: 'muted small' }, 'Add another login with `rigs claude add <name>` to spread runs across accounts.') : null];
}

/** Mount the Tokens & time panel into `el`. opts.routerNode() = the machine whose pre-routing mode to show. Returns { refresh, setActive }. */
export function createUsage(el, opts = {}) {
  const meta = h('span', { class: 'wk-meta' }, '');
  const head = h('div', { class: 'wk-head keep' }, h('span', { class: 'wk-title' }, 'Tokens & time'), meta);
  const chips = h('div', { class: 'us-chips', role: 'group', 'aria-label': 'Time range' });
  const body = h('div', { class: 'wk-list' });
  el.append(head, chips, body);
  let range = '7d';
  try { range = localStorage.getItem('rigs.usage.range') ?? range; } catch {}
  let timer = null;
  let last = null;
  let pre = null;
  let acc = null;

  function drawChips() {
    chips.replaceChildren(...RANGES.map(([v, l]) => h('button', { class: 'tb' + (v === range ? ' on' : ''), 'aria-pressed': String(v === range), onclick: () => { range = v; try { localStorage.setItem('rigs.usage.range', v); } catch {} drawChips(); refresh(); } }, l)));
  }

  function render(r, preroute = pre) {
    const t = r.totals || {};
    meta.textContent = `${t.count || 0} runs`;
    const stat = (k, v) => h('div', { class: 'us-stat' }, h('b', {}, v), h('span', {}, k));
    const nodes = [h('div', { class: 'us-stats' }, stat('tokens', fmt(t.totalTokens)), stat('time', dur(t.durationMs)), stat('cost', usd(t.costUsd) || '—'), stat('done', `${t.done || 0}/${t.count || 0}`))];
    if (t.estimated) nodes.push(h('div', { class: 'muted small' }, `${t.estimated} of ${t.count} runs are estimates (backfilled, no harness counts).`));
    if (r.errors?.length) nodes.push(h('div', { class: 'muted small' }, `No answer from ${r.errors.map((e) => e.node).join(', ')}.`));
    nodes.push(...accountRows(acc, setMode));
    nodes.push(...prerouteNodes(preroute));
    nodes.push(...sectionRows('By model', r.groups?.model, (g) => MODEL(g.label)));
    nodes.push(...sectionRows('By project', r.groups?.project, (g) => g.label, 6));
    nodes.push(...sectionRows('By task', r.groups?.task, (g) => g.label, 10));
    nodes.push(...toolReuseRows(r.toolReuse));
    nodes.push(h('div', { class: 'wk-section' }, 'Latest runs'));
    const recs = (r.records || []).slice(0, 12);
    nodes.push(...(recs.length ? recs.map((x) => h('div', { class: 'wk-row us-row', title: x.outcome || '' },
      h('div', { class: 'wk-rtitle' }, h('span', { class: 'us-st ' + x.status, title: x.status }, STATUS[x.status] || '·'), x.taskTitle || (x.kind === 'chat-turn' ? 'chat turn' : x.kind), h('b', {}, fmt((x.inputTokens || 0) + (x.outputTokens || 0) + (x.cacheReadTokens || 0) + (x.cacheWriteTokens || 0)))),
      h('div', { class: 'wk-rmeta' }, `${MODEL(x.model)} · ${x.node} · ${dur(x.durationMs)} · ${when(x.tsStart)}`),
      x.outcome ? h('div', { class: 'wk-rnow' }, x.outcome) : null)) : [h('div', { class: 'muted small pad' }, 'No runs in this range.')]));
    body.replaceChildren(...nodes);
  }

  async function refresh() {
    const qs = new URLSearchParams({ groupBy: 'model,project,task', limit: '12' });
    if (range) qs.set('since', range);
    const ps = new URLSearchParams({ since: range || '2020-01-01' }); // "All" = since before RIGS existed (the stats default to 30 days)
    const [u, st, rt, ac] = await Promise.allSettled([api('/api/usage?' + qs), api('/api/preroute/stats?' + ps), api(`${node(opts.routerNode?.() || 'self')}/router`), api('/api/local/claude-accounts')]);
    acc = ac.value || acc;
    pre = { stats: st.value || null, router: rt.value || null, error: st.reason?.message || rt.reason?.message || '' };
    if (u.status === 'fulfilled') { last = u.value; render(last); }
    else if (!last) body.replaceChildren(h('div', { class: 'muted small pad' }, u.reason.message));
  }
  async function setMode(mode) {
    try { await api('/api/local/claude-accounts', { method: 'POST', body: { mode } }); } catch {}
    refresh();
  }
  function setActive(on) {
    clearInterval(timer);
    if (on) { refresh(); timer = setInterval(refresh, 15000); }
  }
  window.addEventListener('rigs:router', () => { if (timer) refresh(); }); // the pre-routing switch flipped: show the new mode
  drawChips();
  setActive(true);
  return { refresh, setActive };
}
