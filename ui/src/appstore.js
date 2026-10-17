import { api, h, node, toast } from './api.js';
import { appsCatalog, openApp, refreshApps } from './apps.js';
import { openWindow } from './wm.js';

// App Store: the catalog of installable apps (src/appstore.js) as cards, per machine. Install runs as a
// resumable job on that machine; progress comes from the job endpoint (polled while one runs, and pushed
// by the gateway's {type:'appstore'} event for this node). A finished install shows up in the Apps list
// and the galaxy through the registry, and Open uses the normal app window.

let win = null;
let machinesFn = () => [];
let selected = null; // node id the store is pointed at
const data = new Map(); // node id → list response ({ apps, … } or { error, apps: [] })
const jobs = new Map(); // `${nodeId}/${appId}` → latest job snapshot
const expanded = new Set(); // job keys whose log is open
let timer = null;
let ui = null;

export function initAppStore({ machines }) { machinesFn = machines; }

const jobKey = (nodeId, id) => `${nodeId}/${id}`;
const gb = (n) => (n >= 10 ? Math.round(n) : Math.round(n * 10) / 10);
const machines = () => {
  const list = machinesFn().filter((e) => e.node.online !== false);
  return list.length ? list.map((e) => ({ id: e.node.id, name: e.node.name, self: !!e.node.self })) : [{ id: 'self', name: 'this machine', self: true }];
};
const jobUrl = (nodeId, id) => `${node(nodeId)}/appstore/${encodeURIComponent(id)}/job`;

export function openAppStore() {
  if (win) { win.raise(); refreshStore(); return win; }
  const ms = machines();
  if (!ms.some((m) => m.id === selected)) selected = (ms.find((m) => m.self) || ms[0]).id;
  ui = {
    picker: h('select', { class: 'store-machine', 'aria-label': 'Install on machine', onchange: (e) => { selected = e.target.value; refreshStore(); } }),
    meta: h('span', { class: 'muted small store-meta' }),
    grid: h('div', { class: 'store-grid' }),
  };
  win = openWindow({ title: 'App Store', icon: '🛍', width: 920, height: 640, className: 'store-win', onClose: () => { win = null; ui = null; stopPoll(); } });
  win.body.append(h('div', { class: 'store' },
    h('div', { class: 'store-bar' }, h('label', { class: 'store-pick' }, h('span', {}, 'Machine'), ui.picker), ui.meta,
      h('button', { class: 'tb', title: 'Refresh', 'aria-label': 'Refresh', onclick: () => refreshStore() }, '↻')),
    ui.grid));
  renderPicker();
  render();
  refreshStore();
  return win;
}

function renderPicker() {
  if (!ui) return;
  ui.picker.replaceChildren(...machines().map((m) => h('option', { value: m.id }, m.self ? `${m.name} (this node)` : m.name)));
  ui.picker.value = selected;
}

async function refreshStore() {
  if (!ui) return;
  renderPicker();
  const id = selected;
  try {
    const r = await api(`${node(id)}/appstore`);
    data.set(id, r);
    // Adopt jobs already running (started elsewhere, or before this window opened).
    for (const a of r.apps) if (a.install?.state === 'installing' && !jobs.has(jobKey(id, a.id))) await api(jobUrl(id, a.id)).then((j) => jobs.set(jobKey(id, a.id), j)).catch(() => {});
  } catch (e) { data.set(id, { error: e.message, apps: [] }); }
  render();
  syncPoll();
}

const running = () => [...jobs.values()].some((j) => j.state === 'running');
function syncPoll() {
  if (win && running() && !timer) timer = setInterval(pollJobs, 1500);
  if ((!win || !running()) && timer) stopPoll();
}
function stopPoll() { clearInterval(timer); timer = null; }

async function pollJobs() {
  for (const [k, j] of [...jobs]) {
    if (j.state !== 'running') continue;
    const i = k.indexOf('/');
    try { await applyJob(k.slice(0, i), k.slice(i + 1), await api(jobUrl(k.slice(0, i), k.slice(i + 1)))); } catch { /* transient; next tick */ }
  }
  syncPoll();
}

/** Take a job snapshot; when it just finished, reload the catalog (state) and the Apps list (registry). */
async function applyJob(nodeId, id, job) {
  const k = jobKey(nodeId, id);
  const was = jobs.get(k)?.state;
  jobs.set(k, job);
  if (was === 'running' && job.state !== 'running') {
    const name = data.get(nodeId)?.apps.find((a) => a.id === id)?.name || id;
    if (job.state === 'done') toast(`${name} is installed.`, 'ok');
    else if (job.state === 'failed') toast(`${name} failed at ${job.stepLabel || job.step || 'install'}: ${job.error}`, 'error');
    await refreshStore();
    refreshApps();
    return;
  }
  render();
}

/** Gateway event for this node: {type:'appstore', node, job}. Peers' jobs are covered by polling. */
export function onAppStoreEvent(m) {
  if (!win || !m.job || m.job.op === 'uninstall') return;
  const mine = machines().find((x) => x.name === m.node);
  if (!mine) return;
  // Events carry no log; keep the last one we fetched.
  applyJob(mine.id, m.job.id, { ...m.job, log: jobs.get(jobKey(mine.id, m.job.id))?.log || [] });
  syncPoll();
}

async function install(a) {
  const id = selected;
  const k = jobKey(id, a.id);
  jobs.set(k, { id: a.id, op: 'install', state: 'running', step: '', stepLabel: 'Starting…', percent: 0, steps: [], log: [] });
  render();
  try {
    await api(`${node(id)}/appstore/${encodeURIComponent(a.id)}/install`, { method: 'POST', body: {} });
    await applyJob(id, a.id, await api(jobUrl(id, a.id)));
  } catch (e) {
    jobs.delete(k);
    toast(`Could not start the install: ${e.message}`, 'error');
    render();
  }
  syncPoll();
}

async function cancel(a) {
  try { await api(`${node(selected)}/appstore/${encodeURIComponent(a.id)}/cancel`, { method: 'POST', body: {} }); } catch (e) { toast(e.message, 'error'); }
}

async function uninstall(a) {
  if (!confirm(`Uninstall ${a.name} from ${machines().find((m) => m.id === selected)?.name || 'this machine'}?\n\nIts folder moves to ~/.rigs/trash. Models stored outside the app folder are kept.`)) return;
  const id = selected;
  try {
    await api(`${node(id)}/appstore/${encodeURIComponent(a.id)}/uninstall`, { method: 'POST', body: {} });
    jobs.delete(jobKey(id, a.id));
    toast(`${a.name} uninstalled.`, 'ok');
  } catch (e) { toast(`Uninstall failed: ${e.message}`, 'error'); }
  await refreshStore();
  refreshApps();
}

async function openInstalled(a) {
  const m = machines().find((x) => x.id === selected);
  await refreshApps();
  const hit = appsCatalog().find((x) => x.id === a.id && (x.node === m?.name || x.nodeId === m?.id));
  if (hit) openApp(hit);
  else toast(`${a.name} is not in the Apps list yet — it appears when the machine reports it.`, 'warn');
}

// ------------------------------------------------------------------ rendering

function needs(a) {
  const n = a.needs || {};
  const out = [n.gpu ? `GPU${n.gpu === 'nvidia' ? ' (NVIDIA)' : ''}${n.vramGB ? ` · ${n.vramGB} GB VRAM` : ''}` : 'No GPU', `${gb(a.diskGB ?? n.diskGB ?? 0)} GB disk`];
  if (a.downloadGB) out.push(`${gb(a.downloadGB)} GB download`);
  return out;
}

const stepIcon = (s) => ({ done: '✓', skipped: '✓', running: '●', failed: '✕' }[s.status] || '○');

function progress(j, k) {
  const failed = j.state === 'failed';
  const log = (j.log || []).slice(-60).join('\n');
  return h('div', { class: `store-job${failed ? ' bad' : ''}` },
    h('div', { class: 'store-pct' }, h('div', { class: 'track' }, h('div', { class: 'fill', style: { width: `${j.percent || 0}%` } })), h('em', {}, `${j.percent || 0}%`)),
    h('div', { class: 'store-now' }, failed ? `Failed at “${j.stepLabel || j.step || 'install'}”` : j.stepLabel || 'Starting…'),
    h('ol', { class: 'store-steps' }, ...(j.steps || []).map((s) => h('li', { class: `st-${s.status}` }, h('span', { class: 'si' }, stepIcon(s)), h('span', { class: 'sl' }, s.label),
      s.status === 'running' && s.percent ? h('span', { class: 'sp' }, `${s.percent}%`) : null,
      s.detail && (s.status === 'running' || s.status === 'failed') ? h('span', { class: 'sd' }, s.detail) : null))),
    failed && j.error ? h('div', { class: 'store-err', role: 'alert' }, j.error) : null,
    h('details', { class: 'store-log', open: expanded.has(k), ontoggle: (e) => { if (e.target.open) expanded.add(k); else expanded.delete(k); } },
      h('summary', {}, 'Log'), h('pre', {}, log || 'No output yet.')));
}

function card(a) {
  const k = jobKey(selected, a.id);
  const j = jobs.get(k);
  const st = a.install || { state: 'not-installed' };
  const busy = j?.state === 'running';
  const failed = !busy && (j?.state === 'failed' || st.state === 'failed');
  const fit = a.fit || { ok: true, reasons: [], warnings: [] };
  const jobView = busy ? j : failed ? { steps: [], ...(j?.state === 'failed' ? j : {}), state: 'failed', error: j?.error || st.error, log: j?.log?.length ? j.log : st.logTail, step: j?.step || st.failedStep } : null;
  const badge = busy ? ['Installing', 'run'] : failed ? ['Failed', 'bad'] : { installed: ['Installed', 'ok'], external: ['Installed (manual)', 'ok'], partial: ['Partly installed', 'warn'] }[st.state] || null;
  const actions = [];
  if (busy) actions.push(h('button', { class: 'btn danger', onclick: () => cancel(a) }, 'Cancel'));
  else if (failed) actions.push(h('button', { class: 'btn primary', onclick: () => install(a) }, '↻ Retry'));
  else if (st.state === 'installed' || st.state === 'external') {
    actions.push(h('button', { class: 'btn primary', onclick: () => openInstalled(a) }, 'Open'));
    if (st.updateAvailable) actions.push(h('button', { class: 'btn', onclick: () => install(a) }, 'Update'));
    if (st.state === 'installed') actions.push(h('button', { class: 'btn danger', onclick: () => uninstall(a) }, 'Uninstall'));
  } else if (st.state === 'partial') actions.push(h('button', { class: 'btn primary', onclick: () => install(a) }, 'Finish install'), h('button', { class: 'btn danger', onclick: () => uninstall(a) }, 'Uninstall'));
  else actions.push(h('button', { class: 'btn primary', disabled: !fit.ok, title: fit.ok ? '' : fit.reasons.join('; '), onclick: () => install(a) }, 'Install'));
  return h('article', { class: `store-card ${st.state}${busy ? ' busy' : ''}` },
    h('header', {}, h('span', { class: 'app-icon' }, a.icon || '▦'),
      h('div', { class: 'store-title' }, h('h3', {}, a.name), h('span', { class: 'muted small' }, `v${a.version || '?'}`)),
      badge ? h('span', { class: `store-badge ${badge[1]}` }, badge[0]) : null),
    h('p', { class: 'store-desc' }, a.description || ''),
    h('ul', { class: 'store-needs', 'aria-label': 'Needs' }, ...needs(a).map((t) => h('li', {}, t))),
    h('div', { class: `store-fit ${fit.ok ? 'ok' : 'bad'}` }, fit.ok ? '✓ Fits this machine' : `✕ ${fit.reasons.join('; ')}`),
    ...(fit.ok ? fit.warnings : []).map((w) => h('div', { class: 'store-fit warn' }, `⚠ ${w}`)),
    jobView ? progress(jobView, k) : null,
    h('div', { class: 'store-actions' }, ...actions));
}

function render() {
  if (!ui) return;
  const d = data.get(selected);
  const m = machines().find((x) => x.id === selected);
  ui.meta.textContent = d && !d.error
    ? [d.platform, d.gpus?.length ? d.gpus.map((g) => g.name + (g.vramGB ? ` ${g.vramGB} GB` : '')).join(', ') : 'no GPU', typeof d.freeGB === 'number' ? `${d.freeGB} GB free` : ''].filter(Boolean).join(' · ')
    : '';
  if (!d) { ui.grid.replaceChildren(h('div', { class: 'muted store-empty' }, `Loading the catalog from ${m?.name || 'this machine'}…`)); return; }
  if (d.error) { ui.grid.replaceChildren(h('div', { class: 'store-err', role: 'alert' }, `Could not read the catalog from ${m?.name || 'this machine'}: ${d.error}`)); return; }
  if (!d.apps.length) { ui.grid.replaceChildren(h('div', { class: 'muted store-empty' }, 'The catalog is empty. Add manifests to appstore/catalog/ or ~/.rigs/appstore/catalog/.')); return; }
  ui.grid.replaceChildren(...d.apps.map(card));
}
