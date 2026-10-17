import { ago, api, h, node, toast } from './api.js';
import { openTerminal } from './terminal.js';
import { openWindow } from './wm.js';

const KINDS = ['plan', 'architecture', 'code', 'test', 'review', 'research', 'docs', 'text', 'reverse-engineer', 'media', 'private'];
const STATUS_CLASS = { todo: '', starting: 'warn', running: 'run', review: 'warn', done: 'ok', blocked: 'bad', failed: 'bad' };

/**
 * Projects: goal → tasks planned by the core brain → each task routed to machine + provider +
 * model + effort (editable, with the reason) → dispatched as OpenRig seats or direct agents.
 */
export function openProjects({ snapshot, voice, coreBrain, onFocus }) {
  let list = [];
  let current = null; // { owner (node id), project }
  const left = h('div', { class: 'proj-list' });
  const right = h('div', { class: 'proj-detail' });
  let timer = null;
  const w = openWindow({ title: 'Projects — plan & delegate', icon: '📋', width: 1240, height: 680, className: 'proj-win', onClose: () => clearInterval(timer) });
  w.body.append(h('div', { class: 'files-split proj-split' }, left, right));

  const machines = () => snapshot().filter((e) => e.node.online && e.node.rigs);
  const base = () => `${node(current.owner)}/projects/${current.project.id}`;

  async function loadList() {
    try { list = await api('/api/mesh/projects'); } catch (e) { toast(e.message, 'error'); }
    renderList();
  }

  function renderList() {
    left.replaceChildren(
      h('div', { class: 'toolbar' }, h('button', { class: 'btn primary', onclick: newProject }, '＋ New project'), h('button', { class: 'tb', onclick: loadList }, '↻')),
      ...list.map((p) => {
        const done = p.tasks.filter((t) => t.status === 'done').length;
        const el = h('div', { class: 'sess-row' + (current?.project.id === p.id ? ' sel' : '') },
          h('span', { class: 'sk' }, '📋'),
          h('div', { class: 'sm' }, h('div', { class: 'st' }, p.name), h('div', { class: 'ss' }, `${p.owner} · ${p.status} · ${done}/${p.tasks.length} done · ${ago(p.updatedAt)}`)),
          p.status === 'running' ? h('span', { class: 'live-dot' }) : null);
        el.onclick = () => open(p.ownerId, p.id);
        return el;
      }),
      ...(list.length ? [] : [h('div', { class: 'muted pad' }, 'No projects yet. Describe a goal and the core brain will break it down and route every task to the right model and machine.')]));
  }

  async function open(owner, id) {
    try { current = { owner, project: await api(`${node(owner)}/projects/${id}`) }; } catch (e) { toast(e.message, 'error'); return; }
    renderList();
    renderDetail();
  }

  async function refreshCurrent() {
    if (!current) return;
    try { current.project = await api(base()); renderDetail(); } catch {}
  }

  function newProject() {
    current = null;
    renderList();
    const ms = machines();
    const name = h('input', { class: 'path-input', placeholder: 'Name (optional)' });
    const goal = h('textarea', { class: 'path-input', rows: 6, placeholder: 'Goal — what should exist when this is done? Constraints, repo, quality bar…' });
    const repoNode = h('select', { class: 'mini' }, ...ms.map((e) => h('option', { value: e.node.name, selected: e.node.self }, e.node.name)));
    const repoPath = h('input', { class: 'path-input', placeholder: 'Repository path on that machine (optional)' });
    const gitUrl = h('input', { class: 'path-input', placeholder: 'Git URL — lets other machines work on the code too (optional)' });
    const dispatch = h('select', { class: 'mini' }, ...[['auto', 'auto (OpenRig when available)'], ['openrig', 'OpenRig seats + queue'], ['direct', 'direct agent sessions']].map(([v, l]) => h('option', { value: v }, l)));
    const policy = h('select', { class: 'mini' }, ...['builtin:auto', 'builtin:standard', 'builtin:open', 'builtin:locked', 'floor', 'builtin:yolo'].map((v) => h('option', { value: v }, v)));
    const cb = coreBrain();
    right.replaceChildren(h('div', { class: 'pad settings' },
      h('div', { class: 'pv-title' }, 'New project'),
      h('label', {}, 'Name', name), h('label', {}, 'Goal', goal),
      h('div', { class: 'grid2' }, h('label', {}, 'Repository machine', repoNode), h('label', {}, 'Dispatch', dispatch)),
      h('label', {}, 'Repository path', repoPath), h('label', {}, 'Git URL', gitUrl),
      h('label', {}, 'Agent permission policy (OpenRig)', policy),
      h('div', { class: 'muted small' }, `Planner: ${cb ? `${cb.brain} ${cb.model || ''} ${cb.effort ? '· ' + cb.effort : ''} on ${cb.nodeName}` : 'core brain'} — change it from the brain badge under the orb.`),
      h('div', { class: 'actions' },
        h('button', { class: 'btn primary', onclick: () => create(true) }, '✦ Create & plan'),
        h('button', { class: 'btn', onclick: () => create(false) }, 'Create empty (add tasks by hand)'))));
    async function create(plan) {
      if (!goal.value.trim()) { toast('Describe the goal first', 'error'); return; }
      const self = snapshot().find((e) => e.node.self)?.node;
      const b = coreBrain();
      try {
        const p = await api(`${node(self.id)}/projects`, { method: 'POST', body: { name: name.value, goal: goal.value, repoNode: repoNode.value, repoPath: repoPath.value, gitUrl: gitUrl.value, dispatch: dispatch.value, policy: policy.value, planner: b ? { provider: b.brain, model: b.model, effort: b.effort, node: b.nodeName } : undefined } });
        current = { owner: self.id, project: p };
        await loadList();
        renderDetail();
        if (plan) runPlan();
      } catch (e) { toast(e.message, 'error'); }
    }
  }

  async function runPlan() {
    const p = current.project;
    const cb = coreBrain();
    const pl = cb ? { provider: cb.brain, model: cb.model, effort: cb.effort, node: cb.nodeName } : p.planner || {};
    right.querySelector('.plan-status')?.replaceChildren(`Planning with ${pl.provider} ${pl.model || ''} ${pl.effort ? '(' + pl.effort + ')' : ''}… this can take a minute or two.`);
    voice?.say?.(`Planning ${p.name}.`);
    try {
      current.project = await api(`${base()}/plan`, { method: 'POST', body: { brain: pl } });
      renderDetail();
      const n = current.project.tasks.length;
      voice?.say?.(`${n} tasks planned and routed. Review the assignments, then dispatch.`);
    } catch (e) {
      toast('Planning failed: ' + e.message, 'error', 12000);
      refreshCurrent();
    }
  }

  async function act(path, body = {}, msg) {
    try { current.project = await api(`${base()}/${path}`, { method: 'POST', body }); renderDetail(); if (msg) toast(msg, 'ok'); }
    catch (e) { toast(e.message, 'error', 10000); refreshCurrent(); }
  }

  function providerOptions(machineName) {
    const e = machines().find((x) => x.node.name === machineName);
    return e?.brains || [];
  }

  function taskRow(t) {
    const a = t.assign || {};
    const editable = t.status === 'todo' || t.status === 'failed';
    const machineSel = h('select', { class: 'mini', disabled: !editable }, h('option', { value: '' }, '—'), ...machines().map((e) => h('option', { value: e.node.name, selected: e.node.name === a.node }, e.node.name)));
    const provs = providerOptions(a.node);
    const provSel = h('select', { class: 'mini', disabled: !editable }, h('option', { value: '' }, '—'), ...provs.map((b) => h('option', { value: b.id, selected: b.id === a.provider }, b.id)));
    const prov = provs.find((b) => b.id === a.provider);
    const listId = `pm-${current.project.id}-${t.id}`;
    const modelIn = h('input', { class: 'path-input mini-in', value: a.model || '', list: listId, disabled: !editable, placeholder: 'default' });
    const dl = h('datalist', { id: listId }, ...(prov?.models || []).map((m) => h('option', { value: m })));
    const effSel = h('select', { class: 'mini', disabled: !editable }, h('option', { value: '' }, 'default'), ...(prov?.efforts || []).map((x) => h('option', { value: x, selected: x === a.effort }, x)));
    const kindSel = h('select', { class: 'mini', disabled: !editable }, ...KINDS.map((k) => h('option', { value: k, selected: k === t.kind }, k)));
    const sizeSel = h('select', { class: 'mini', disabled: !editable }, ...['S', 'M', 'L'].map((k) => h('option', { value: k, selected: k === t.size }, k)));
    const saveAssign = () => act(`tasks/${t.id}`, { assign: { node: machineSel.value, provider: provSel.value, model: modelIn.value.trim(), effort: effSel.value } });
    machineSel.onchange = () => { provSel.value = ''; act(`tasks/${t.id}`, { assign: { node: machineSel.value, provider: (providerOptions(machineSel.value)[0] || {}).id || '', model: '', effort: '' } }); };
    provSel.onchange = () => { modelIn.value = ''; effSel.value = ''; saveAssign(); };
    modelIn.onchange = saveAssign;
    effSel.onchange = saveAssign;
    kindSel.onchange = () => act(`tasks/${t.id}`, { kind: kindSel.value });
    sizeSel.onchange = () => act(`tasks/${t.id}`, { size: sizeSel.value });
    const sessBtn = t.run?.session ? h('button', { class: 'tb', title: 'Open the agent session', onclick: () => openSession(t) }, '⌨') : null;
    return h('div', { class: 'task-row' },
      h('div', { class: 'tr-main' },
        h('span', { class: 'tid' }, t.id),
        h('div', { class: 'tr-title' }, h('b', {}, t.title), t.deps.length ? h('span', { class: 'muted small' }, ` ← ${t.deps.join(', ')}`) : null, t.needs?.tool ? h('span', { class: 'chip' }, t.needs.tool) : null),
        h('span', { class: `chip st-${STATUS_CLASS[t.status] || ''}` }, t.status)),
      h('div', { class: 'tr-assign' }, kindSel, sizeSel, h('span', { class: 'arrow' }, '→'), machineSel, provSel, modelIn, dl, effSel,
        sessBtn,
        t.status !== 'done' ? h('button', { class: 'tb', title: 'Mark done', onclick: () => act(`tasks/${t.id}`, { status: 'done', summary: 'marked done by hand' }) }, '✓') : null,
        (t.status === 'failed' || t.status === 'review' || t.status === 'blocked' || t.status === 'done') ? h('button', { class: 'tb', title: 'Back to todo (re-run)', onclick: () => act(`tasks/${t.id}`, { status: 'todo', summary: '' }) }, '↺') : null,
        editable ? h('button', { class: 'tb', title: 'Delete task', onclick: async () => { try { current.project = await api(`${base()}/tasks/${t.id}`, { method: 'DELETE' }); renderDetail(); } catch (e) { toast(e.message, 'error'); } } }, '✕') : null),
      h('div', { class: 'tr-reason muted small' }, t.reason || ''),
      t.description ? h('details', { class: 'tr-desc' }, h('summary', {}, 'brief'), h('div', {}, t.description)) : null,
      t.summary ? h('div', { class: 'tr-summary small' }, '↳ ' + t.summary) : null);
  }

  async function openSession(t) {
    const m = snapshot().find((e) => e.node.name === t.assign.node)?.node;
    if (!m) return toast(`${t.assign.node} is offline`, 'error');
    const s = t.run.session;
    try {
      const r = s.kind === 'pty' ? { ptyId: s.id } : await api(`${node(m.id)}/sessions/attach`, { method: 'POST', body: { kind: s.kind, id: s.id } });
      openTerminal({ nodeId: m.id, nodeName: m.name, ptyId: r.ptyId, title: `${t.id} · ${t.title}`.slice(0, 60) });
    } catch (e) { toast(e.message, 'error'); }
  }

  function renderDetail() {
    if (!current) { right.replaceChildren(h('div', { class: 'muted pad' }, 'Pick a project, or create one.')); return; }
    const p = current.project;
    const counts = p.tasks.reduce((a, t) => ((a[t.status] = (a[t.status] || 0) + 1), a), {});
    const addTitle = h('input', { class: 'path-input', placeholder: 'Add a task by hand…' });
    const addKind = h('select', { class: 'mini' }, ...KINDS.map((k) => h('option', { value: k, selected: k === 'code' }, k)));
    addTitle.addEventListener('keydown', async (e) => {
      if (e.key !== 'Enter' || !addTitle.value.trim()) return;
      try { current.project = await api(`${base()}/tasks`, { method: 'POST', body: { title: addTitle.value.trim(), kind: addKind.value } }); renderDetail(); } catch (err) { toast(err.message, 'error'); }
    });
    right.replaceChildren(
      h('div', { class: 'pad proj-head' },
        h('div', { class: 'pv-title' }, p.name, h('span', { class: `chip st-${p.status === 'running' ? 'run' : p.status === 'done' ? 'ok' : ''}` }, p.status)),
        h('div', { class: 'muted small' }, `owner ${p.owner} · repo ${p.repo.path ? `${p.repo.node}:${p.repo.path}` : '—'}${p.gitUrl ? ' · ' + p.gitUrl : ''} · dispatch ${p.dispatch} · ${p.policy}`),
        h('div', { class: 'proj-goal' }, p.goal),
        p.summary ? h('div', { class: 'muted small' }, p.summary) : null,
        h('div', { class: 'actions' },
          h('button', { class: 'btn', onclick: runPlan, disabled: p.status === 'running', title: 'Plans with the brain selected under the orb' }, `✦ ${p.tasks.length ? 'Re-plan' : 'Plan'} with ${(() => { const cb = coreBrain(); return cb ? `${cb.model || cb.brain}${cb.effort ? ' · ' + cb.effort : ''}` : 'core brain'; })()}`),
          h('button', { class: 'btn', onclick: () => act('route', { unlock: true }, 'Re-routed with the current policy and machine load'), disabled: !p.tasks.length }, '⇄ Re-route'),
          h('button', { class: 'btn primary', onclick: () => act('dispatch', {}, 'Dispatched every ready task'), disabled: !p.tasks.length || p.status === 'done' }, '▶ Dispatch ready tasks'),
          p.status === 'running' ? h('button', { class: 'btn', onclick: () => act('stop', {}, 'Stopped') }, '■ Stop') : null,
          h('button', { class: 'btn', onclick: () => onFocus?.(p) }, '◎ Galaxy'),
          h('button', { class: 'btn danger', onclick: async () => { if (!confirm(`Delete project ${p.name}? Running agents are stopped.`)) return; await api(base(), { method: 'DELETE' }).catch(() => {}); current = null; loadList(); renderDetail(); } }, '🗑')),
        h('div', { class: 'plan-status muted small' }, Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(' · '))),
      h('div', { class: 'task-list' }, ...p.tasks.map(taskRow), h('div', { class: 'task-add' }, addTitle, addKind)),
      h('details', { class: 'pad proj-log' }, h('summary', {}, `Log (${p.log.length})`), ...p.log.slice(-40).reverse().map((l) => h('div', { class: 'small' }, h('span', { class: 'muted' }, new Date(l.ts).toLocaleTimeString() + ' '), l.text))));
  }

  loadList();
  renderDetail();
  timer = setInterval(() => { if (['running', 'planning', 'merging'].includes(current?.project.status)) refreshCurrent(); }, 5000);
  return { window: w, open };
}
