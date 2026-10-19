import { h } from '../api.js';
import { stationFromGraph } from './model.js';

// EXPERIMENTAL — the StarNet station frame over the galaxy (lazy chunk, loaded by ./index.js only while the flag is
// on). Mounts <main id="station"> beside #graph with an iframe on /starnet/ (StarNet's renderer, served by
// src/starnet.js with ui/starnet/rigs-boot.js in front of it). The frame boots from window.__rigsStarnet.initial()
// and then follows {type:'station'} messages built by model.js from the same buildGraph(visibleSnap()) the galaxy
// draws. Until the frame says 'ready' the galaxy stays on screen; once it does, the galaxy is hidden and paused.
// A frame that errors or stays silent for BOOT_MS calls onFail (index.js puts the galaxy back). destroy() leaves
// the page exactly as it was before mount. What the frame asks for (rigs-boot.js §3) comes back here: a select or
// right-click at a point (onSelect / onContext, with page coordinates), a whitelisted room action (ACTIONS) and a
// press inside the frame (onPointer, so the host's open menu closes). Nothing else the frame sends does anything.

const BOOT_MS = 60000;
const ACTIONS = new Set(['newAgent', 'sessions']); // the room tags' buttons: ✳ New agent, +N more sessions
const CSS = `
#station { position: fixed; inset: 0; z-index: 0; background: #04060a; opacity: 0; transition: opacity .6s ease; pointer-events: none; }
#station iframe { position: absolute; inset: 0; width: 100%; height: 100%; border: 0; display: block; background: #04060a; }
#station .sn-credit { position: absolute; left: 50%; bottom: 6px; transform: translateX(-50%); font: 11px/1.3 var(--mono, ui-monospace, monospace); color: rgba(226, 232, 240, .55); text-decoration: none; padding: 2px 8px; border-radius: 6px; background: rgba(4, 6, 10, .55); pointer-events: auto; }
#station .sn-credit:hover, #station .sn-credit:focus-visible { color: #e2e8f0; }
.sn-boarding { position: fixed; left: 50%; top: 14px; transform: translateX(-50%); z-index: 30; font: 12px/1.4 var(--mono, ui-monospace, monospace); color: #e2e8f0; background: rgba(4, 6, 10, .8); border: 1px solid rgba(45, 212, 191, .4); padding: 4px 12px; border-radius: 999px; pointer-events: none; }
body.starnet #station { opacity: 1; pointer-events: auto; }
body.starnet #graph { visibility: hidden; }
`;

/**
 * deps: { graphEl, data() → buildGraph(…), attention() → Set, hidden() → [types], onSelect(id, at?), onContext(id|null, at),
 * onAction(action, id), onPointer(), pauseGraph(), resumeGraph(), credit, onFail(msg) } — `at` = { x, y } in page px.
 */
export function mountStation(deps) {
  const style = h('style', { id: 'starnet-style' }, CSS);
  document.head.append(style);
  const state = () => stationFromGraph(deps.data(), { attention: deps.attention(), hidden: deps.hidden() });
  window.__rigsStarnet = { initial: state }; // read synchronously by rigs-boot.js before StarNet's stores boot
  const frame = h('iframe', { src: '/starnet/', title: 'Space station view of the mesh (StarNet)', allow: 'fullscreen' });
  const credit = h('a', { class: 'sn-credit', href: 'https://github.com/androoAGI/starnet', target: '_blank', rel: 'noopener' }, deps.credit || 'Station view by StarNet (MIT) — github.com/androoAGI/starnet');
  const main = h('main', { id: 'station', 'aria-label': 'Space station view of the mesh — machines are rooms, agent sessions are workers; the side panel lists them for the keyboard' }, frame, credit);
  const boarding = h('div', { class: 'sn-boarding', role: 'status' }, 'Boarding the station…');
  deps.graphEl.after(main);
  document.body.append(boarding);
  let ready = false;
  let gone = false;
  const timer = setTimeout(() => { if (!ready) deps.onFail('the station did not start'); }, BOOT_MS);

  function send(msg) { try { frame.contentWindow?.postMessage(msg, location.origin); } catch { /* frame gone */ } }
  /** Frame client px → page px (null without a finite point). */
  function pageAt(m) {
    if (!Number.isFinite(m.x) || !Number.isFinite(m.y)) return null;
    const r = frame.getBoundingClientRect();
    return { x: r.left + m.x, y: r.top + m.y };
  }
  const nodeId = (id) => typeof id === 'string' && id.length < 400;
  function onMessage(e) {
    if (e.origin !== location.origin || e.source !== frame.contentWindow || !e.data || typeof e.data !== 'object') return;
    const m = e.data;
    if (m.type === 'ready' && !ready) {
      ready = true;
      clearTimeout(timer);
      boarding.remove();
      document.body.classList.add('starnet');
      deps.pauseGraph();
      update();
    } else if (!ready) {
      if (m.type === 'error') deps.onFail(String(m.message || 'error'));
    } else if (m.type === 'select' && nodeId(m.id)) deps.onSelect(m.id, pageAt(m));
    else if (m.type === 'context' && (m.id == null || nodeId(m.id))) { const at = pageAt(m); if (at) deps.onContext?.(m.id || null, at); }
    else if (m.type === 'action' && ACTIONS.has(m.action) && nodeId(m.id)) deps.onAction?.(m.action, m.id);
    else if (m.type === 'pointer') deps.onPointer?.();
  }
  window.addEventListener('message', onMessage);
  frame.addEventListener('error', () => { if (!ready) deps.onFail('the station files did not load'); });

  function update() {
    if (!ready || gone) return;
    deps.pauseGraph(); // the galaxy wakes itself on data changes; it stays asleep while hidden
    send({ type: 'station', state: state() });
  }
  return {
    update,
    focus(id) { if (ready) send({ type: 'focus', id }); },
    /** Frame the whole station (◎ Fit, Esc). */
    fit() { if (ready) send({ type: 'fit' }); return ready; },
    destroy() {
      if (gone) return;
      gone = true;
      clearTimeout(timer);
      window.removeEventListener('message', onMessage);
      document.body.classList.remove('starnet');
      main.remove();
      boarding.remove();
      style.remove();
      delete window.__rigsStarnet;
      deps.resumeGraph();
    },
  };
}
