import { api, h, toast } from './api.js';
import { openWindow } from './wm.js';
import { openAppStore } from './appstore.js';
import { isAppRemoved } from './layout-actions.js';
import { tagCtx } from './ctx-tag.js';
import { openYoloHistory } from './yolo.js'; // only called from the button: apps.js and yolo.js import each other

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
export const isAppOpen = (a) => appWindows.has(key(a));
export function closeApp(a) { appWindows.get(key(a))?.win.close(); }
/** Reload an open app's window (the context menu's Reload). */
export function reloadApp(a) { const w = appWindows.get(key(a)); if (w) reload(w); }
/** Re-render the launcher (an app was removed or restored). */
export function rerenderApps() { renderLauncher(); }

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

/** An app by id, on a machine when one is named (its name or id): ui_open's `app` view. */
export function appById(id, nodeRef = '') {
  const want = String(id || '');
  const n = String(nodeRef || '').toLowerCase();
  const hits = catalog.filter((a) => a.id === want && (!n || String(a.node).toLowerCase() === n || String(a.nodeId || '').toLowerCase() === n));
  return hits.find((a) => statusOf(a) === 'up') || hits[0] || null;
}

/** The url the app window loads: the app's proxy path plus the route inside it it was opened at (ui_open `path`). */
const appUrl = (w) => appPath(w.app) + String(w.route || '').replace(/^\/+/, '');

export function openApps() {
  if (launcher) { launcher.raise(); refreshApps(); return launcher; }
  launcher = openWindow({ title: 'Apps', icon: '▦', width: 560, height: 380, onClose: () => { launcher = null; ensurePoll(); } });
  launcher.grid = h('div', { class: 'apps-grid' });
  launcher.body.append(h('div', { class: 'apps-bar' }, h('button', { class: 'btn primary', onclick: () => openAppStore() }, '🛍 App Store'),
    h('button', { class: 'btn', title: 'Every past YOLO run on the mesh, kept as an app or not', onclick: () => openYoloHistory() }, '⚡ YOLO history')), launcher.grid);
  ensurePoll();
  renderLauncher();
  refreshApps();
  return launcher;
}

function renderLauncher() {
  if (!launcher) return;
  const store = h('button', { class: 'app-tile store-tile', title: 'App Store — install new apps on any machine', onclick: () => openAppStore() },
    h('span', { class: 'app-icon' }, '🛍'), h('span', { class: 'app-name' }, 'App Store'), h('span', { class: 'app-node' }, 'install apps'));
  const shown = catalog.filter((a) => !isAppRemoved(a)); // removed apps are hidden, never deleted (Window › Removed items)
  launcher.grid.replaceChildren(store, ...(shown.length ? shown.map((a) => tagCtx(h('button', { class: `app-tile ${statusOf(a)}`, title: `${a.name} on ${a.node} — ${statusOf(a)}`, onclick: () => openApp(a) },
    h('span', { class: 'app-icon' }, a.icon || '▦'),
    h('span', { class: 'app-name' }, a.name),
    h('span', { class: 'app-node' }, h('i', { class: 'app-dot' }), a.node)), 'app', `${a.nodeId || a.node}/${a.id}`, { app: a }))
    : [h('div', { class: 'muted apps-empty' }, 'No apps installed yet. Get one from the App Store, or publish your own with mesh_app_register; it appears here on its own.')]));
}

/** Open an app's window. `route` (ui_open's `path`, e.g. "/training") is the page inside it to show; an open window navigates there. */
export function openApp(a, { route = '', focus = true } = {}) {
  const k = key(a);
  const existing = appWindows.get(k);
  if (existing) {
    existing.win.raise();
    if (route && existing.route !== route) { existing.route = route; if (!existing.starting) existing.frame.src = appUrl(existing); }
    return existing;
  }
  const needsStart = statusOf(a) !== 'up' && (a.launchHere !== undefined ? a.launchHere : a.launch); // launchHere: the recipe for its host's OS (older peers send only launch)
  const w = { app: a, route: String(route || ''), overlay: null, status: statusOf(a) };
  const frame = h('iframe', { class: 'app-frame', src: needsStart ? 'about:blank' : appUrl(w), allow: 'clipboard-read; clipboard-write; fullscreen; microphone; camera; geolocation' });
  const overlay = h('div', { class: 'app-overlay hidden' });
  Object.assign(w, { frame, overlay });
  w.win = openWindow({
    title: `${a.name} — ${a.node}`, icon: a.icon || '▦', width: 1100, height: 760, className: 'app-win', focus,
    key: `app:${a.nodeId || a.node}/${a.id}`, dockRef: `applet:${a.nodeId || a.node}/${a.id}`, // minimized, it lives in its applet tile
    tools: [
      h('button', { class: 'win-btn', title: 'Reload', onclick: () => reload(w) }, '↻'),
      h('button', { class: 'win-btn', title: 'Open in a browser tab', onclick: () => window.open(appPath(a), '_blank', 'noopener') }, '↗'),
    ],
    onClose: () => { appWindows.delete(k); ensurePoll(); },
  });
  tagCtx(w.win.el.querySelector('.win-bar'), 'app', `${a.nodeId || a.node}/${a.id}`, { get app() { return w.app; } }); // the title bar is the app's; the page inside is its own document
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
    const r = await api(`/api/nodes/${encodeURIComponent(a.node)}/app-start/${encodeURIComponent(a.id)}`, { method: 'POST', body: {} });
    if (r?.starting || r?.pending) {
      // Launched, not up yet (a slow start — a Python API importing torch): the probe loop goes on in the background and
      // the `apps` event brings it up here (updateWindow: down → up reloads the frame). The overlay says so meanwhile.
      w.status = 'down';
      w.overlay.textContent = `Starting ${a.name} on ${a.node}… it can take a few minutes; it will load here as soon as it answers.`;
    } else {
      w.status = 'up';
      w.overlay.classList.add('hidden');
      w.frame.src = appUrl(w);
    }
    refreshApps();
  } catch (e) {
    w.status = 'down';
    w.overlay.textContent = `Could not start ${a.name} on ${a.node}: ${e.message}`;
  } finally { w.starting = false; }
}

function reload(w) {
  try { w.frame.contentWindow.location.reload(); } catch { w.frame.src = appUrl(w); }
}

function updateWindow(w, a) {
  if (w.starting) { w.app = a; return; }
  const was = w.status;
  const now = statusOf(a);
  w.app = a;
  w.status = now;
  w.overlay.classList.toggle('hidden', now !== 'down');
  if (now === 'down') {
    w.overlay.textContent = a.starting
      ? `Starting ${a.name} on ${a.node}… it can take a few minutes; it will load here as soon as it answers.`
      : `${a.name} on ${a.node} is down${a.health?.error ? ` (${a.health.error})` : ''}. It will reload here as soon as it is back.`;
  }
  if (was === 'down' && now === 'up') { reload(w); toast(`${a.name} is back — reloaded.`); }
}

/** Gateway events: 'apps' (a node's app list or status changed) and 'mesh' (machines came/went). */
export function onAppsEvent(m) {
  if (m.type === 'apps' || (m.type === 'mesh' && (launcher || appWindows.size))) refreshApps();
}
