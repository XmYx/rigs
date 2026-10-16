import { api, h, toast } from './api.js';
import { openWindow } from './wm.js';

// App Cloud: web apps hosted anywhere on the mesh, opened in floating windows through the daemon's
// proxy (/api/nodes/<node>/apps/<id>/). The catalog refreshes on its own: on 'apps'/'mesh' events
// from the gateway and on a short poll while anything app-related is open. An open app window reloads
// itself when its app comes back up (redeploy, restart) and shows a notice while it is down.
// Opening an app that is not up spins it up on its own machine first (its launch recipe).

let catalog = [];
let launcher = null;
const appWindows = new Map(); // key → { app, frame, overlay, status, win }
let pollTimer = null;
let inflight = null;

const key = (a) => `${a.node}/${a.id}`;
export const appPath = (a) => `/api/nodes/${encodeURIComponent(a.node)}/apps/${encodeURIComponent(a.id)}/`;
const statusOf = (a) => a.health?.status || 'unknown';

export function appsCatalog() { return catalog; }

/** Fetch the mesh-wide catalog and push it into the launcher and every open app window. */
export function refreshApps() {
  if (inflight) return inflight;
  inflight = api('/api/apps').then((r) => {
    catalog = r.apps || [];
    renderLauncher();
    for (const [k, w] of appWindows) {
      const a = catalog.find((x) => key(x) === k);
      if (a) updateWindow(w, a);
    }
    return catalog;
  }).catch(() => catalog).finally(() => { inflight = null; });
  return inflight;
}

function ensurePoll() {
  const want = launcher || appWindows.size;
  if (want && !pollTimer) pollTimer = setInterval(refreshApps, 10000);
  if (!want && pollTimer) { clearInterval(pollTimer); pollTimer = null; }
}

/** Find an app by spoken/typed name or id ("krea studio", "krea-studio", "szuf"). */
export function findApp(q) {
  const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
  const t = norm(q);
  if (!t) return null;
  return catalog.find((a) => norm(a.id) === t || norm(a.name) === t)
    || catalog.find((a) => norm(a.name).includes(t) || norm(a.id).includes(t) || (t.length > 3 && t.includes(norm(a.name))));
}

export function openApps() {
  if (launcher) { launcher.raise(); refreshApps(); return launcher; }
  launcher = openWindow({ title: 'Apps', icon: '▦', width: 560, height: 380, onClose: () => { launcher = null; ensurePoll(); } });
  launcher.grid = h('div', { class: 'apps-grid' });
  launcher.body.append(launcher.grid);
  ensurePoll();
  renderLauncher();
  refreshApps();
  return launcher;
}

function renderLauncher() {
  if (!launcher) return;
  launcher.grid.replaceChildren(...(catalog.length ? catalog.map((a) => h('button', { class: `app-tile ${statusOf(a)}`, title: `${a.name} on ${a.node} — ${statusOf(a)}`, onclick: () => openApp(a) },
    h('span', { class: 'app-icon' }, a.icon || '▦'),
    h('span', { class: 'app-name' }, a.name),
    h('span', { class: 'app-node' }, h('i', { class: 'app-dot' }), a.node)))
    : [h('div', { class: 'muted apps-empty' }, 'No apps yet. Publish one with mesh_app_register (or "apps" in ~/.rigs/config.json); it appears here on its own.')]));
}

export function openApp(a) {
  const k = key(a);
  const existing = appWindows.get(k);
  if (existing) { existing.win.raise(); return existing; }
  const needsStart = statusOf(a) !== 'up' && a.launch;
  const frame = h('iframe', { class: 'app-frame', src: needsStart ? 'about:blank' : appPath(a), allow: 'clipboard-read; clipboard-write; fullscreen; microphone; camera' });
  const overlay = h('div', { class: 'app-overlay hidden' });
  const w = { app: a, frame, overlay, status: statusOf(a) };
  w.win = openWindow({
    title: `${a.name} — ${a.node}`, icon: a.icon || '▦', width: 1100, height: 760, className: 'app-win',
    tools: [
      h('button', { class: 'win-btn', title: 'Reload', onclick: () => reload(w) }, '↻'),
      h('button', { class: 'win-btn', title: 'Open in a browser tab', onclick: () => window.open(appPath(a), '_blank', 'noopener') }, '↗'),
    ],
    onClose: () => { appWindows.delete(k); ensurePoll(); },
  });
  w.win.body.append(h('div', { class: 'app-stage' }, frame, overlay));
  appWindows.set(k, w);
  ensurePoll();
  if (needsStart) startApp(w); else updateWindow(w, a);
  return w;
}

/** Spin the app up on its machine, then load it. */
export async function startApp(w) {
  const a = w.app;
  w.starting = true;
  w.overlay.classList.remove('hidden');
  w.overlay.textContent = `Starting ${a.name} on ${a.node}…`;
  try {
    await api(`/api/nodes/${encodeURIComponent(a.node)}/app-start/${encodeURIComponent(a.id)}`, { method: 'POST', body: {} });
    w.status = 'up';
    w.overlay.classList.add('hidden');
    w.frame.src = appPath(a);
    refreshApps();
  } catch (e) {
    w.status = 'down';
    w.overlay.textContent = `Could not start ${a.name} on ${a.node}: ${e.message}`;
  } finally { w.starting = false; }
}

function reload(w) {
  try { w.frame.contentWindow.location.reload(); } catch { w.frame.src = appPath(w.app); }
}

function updateWindow(w, a) {
  if (w.starting) { w.app = a; return; }
  const was = w.status;
  const now = statusOf(a);
  w.app = a;
  w.status = now;
  w.overlay.classList.toggle('hidden', now !== 'down');
  if (now === 'down') w.overlay.textContent = `${a.name} on ${a.node} is down${a.health?.error ? ` (${a.health.error})` : ''}. It will reload here as soon as it is back.`;
  if (was === 'down' && now === 'up') { reload(w); toast(`${a.name} is back — reloaded.`); }
}

/** Gateway events: 'apps' (a node's app list or status changed) and 'mesh' (machines came/went). */
export function onAppsEvent(m) {
  if (m.type === 'apps' || (m.type === 'mesh' && (launcher || appWindows.size))) refreshApps();
}
