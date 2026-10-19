import { api, toast } from '../api.js';
import { isPhone } from '../mobile.js';

// EXPERIMENTAL — the StarNet space-station view switch (spec docs/starnet-integration.md; daemon side src/starnet.js).
// This file is the only StarNet code in the main bundle: it reads the per-machine flag (GET /api/local/starnet/config),
// follows the 'starnet-config' push, and drives the menu toggle (Experimental › Space station view). Only when the
// flag is on and this machine has the station files does it load the view chunk (./view.js, which mounts the
// /starnet/ frame over the galaxy). Off — the default — means no chunk, no frame and no /starnet/ request: the galaxy
// is exactly as before. The galaxy is never torn down, so switching off just removes the frame and resumes it.
// Phones keep the galaxy (the station downloads a few hundred MB of art and is laid out for a desktop screen).

const st = { status: null, view: null, mounting: null, deps: null, failed: '', warned: false };

export const starnetEnabled = () => !!st.status?.enabled;

/** Read the flag once at start. deps: { graphEl, data, attention, hidden, onSelect, pauseGraph, resumeGraph }. */
export async function initStarnet(deps) {
  st.deps = deps;
  try { st.status = await api('/api/local/starnet/config'); } catch { return; } // an older daemon: stays off
  apply();
}

/** The daemon's 'starnet-config' push (flag switched from the CLI, the settings API or another window, or an install). */
export function onStarnetConfig(m) {
  st.status = m;
  st.failed = '';
  apply();
}

/** Experimental › Space station view: switch it for this machine (POST /api/local/starnet/config). */
export async function setStarnetEnabled(on) {
  try {
    st.status = await api('/api/local/starnet/config', { method: 'POST', body: { enabled: !!on } });
    st.failed = '';
    toast(st.status.enabled ? (st.status.installed ? 'Space station view on — boarding the station…' : 'Space station view on, but StarNet is not installed on this machine yet.') : 'Space station view off — back to the galaxy.', 'ok');
  } catch (e) { toast(`Could not change the space station view: ${e.message}`, 'error'); }
  apply();
}

/** New mesh data or attention: the station follows (no-op while the view is off). */
export function starnetUpdate() { st.view?.update(); }
/** A node was selected in the side panel: frame its room. */
export function starnetFocus(id) { st.view?.focus(id); }

async function install() {
  toast('Installing StarNet on this machine (a few hundred MB, pinned commit)…', 'ok');
  try { st.status = await api('/api/local/starnet/install', { method: 'POST', body: {} }); } catch (e) { toast(`StarNet install failed: ${e.message}`, 'error'); return; }
  apply();
}

function apply() {
  const s = st.status;
  const want = !!(s?.enabled && s.installed && !st.failed && !isPhone() && st.deps);
  if (s?.enabled && !s.installed && !st.warned) {
    st.warned = true;
    toast('Space station view is on, but StarNet is not installed here — the galaxy stays until it is (rigs starnet install).', 'info', 12000, s.installing ? null : { label: 'Install', run: install });
  }
  if (want && !st.view && !st.mounting) {
    st.mounting = import('./view.js').then(({ mountStation }) => {
      st.mounting = null;
      if (!st.status?.enabled || st.failed) return;
      st.view = mountStation({ ...st.deps, credit: s.credit, onFail: fail });
    }).catch((e) => { st.mounting = null; fail(e.message); });
  } else if (!want && st.view) {
    st.view.destroy();
    st.view = null;
  }
}

// Never a blank screen: a frame that fails to load or start hands the screen back to the galaxy for this session.
function fail(message) {
  st.failed = message || 'failed';
  if (st.view) { st.view.destroy(); st.view = null; }
  toast(`Space station view unavailable (${st.failed}) — showing the galaxy.`, 'error', 10000);
}
