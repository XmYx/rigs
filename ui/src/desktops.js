import { api, h, node, wsUrl } from './api.js';
import { isPhone } from './mobile.js';
import { openWindow } from './wm.js';

// "Desktops" floating panel: one small live tile per online machine, a large view on click. Frames come from
// the access-gated stream endpoint (src/screen-stream.js, /api/nodes/<id>/screen/stream). A machine whose screen
// control is off (or not granted) shows a placeholder; nothing here can switch access on — that stays with Sir in
// the Access & control panel. A stream is open only while its tile is on screen, the panel is open and expanded
// and the tab is visible, so an idle dashboard captures nothing.

const TILE = { fps: 1, quality: 45, scale: 0.3, maxWidth: 480 };
const FPS = [1, 2, 3, 5, 10];
const QUALITY = [['Low', 35], ['Medium', 60], ['High', 85]];
const POLL_MS = 10000;
const RETRY_MS = 2500;

/** What a refusal means for a person. `status` is the stream's error status or the plain GET's access status. */
export function refusalText(name, status, message) {
  if (status === 'control-off') return `Screen control is off on ${name}`;
  if (status === 'needs-permission') return `${name} has not granted RIGS Control screen access yet`;
  if (status === 'not-allowed') return `${name} does not allow this screen to watch it`;
  if (status === 'no-session') return `${name} has no desktop session`;
  if (status === 'unsupported') return `${name} cannot stream its screen`;
  return message || `${name}: screen not available`;
}

/**
 * Open a stream to one machine and hand frames to `on`. Returns { set(opts), close() }.
 * on.frame(blobUrl) · on.state('live'|'connecting'|'refused', {status,message}) · on.meta(obj).
 * Reconnects after an unexpected drop; a refusal is final until a new stream() is made.
 */
export function openStream(id, opts, on) {
  let ws = null;
  let timer = null;
  let dead = false;
  let url = null;
  let cur = { ...opts };
  const query = (o) => new URLSearchParams(Object.entries(o).map(([k, v]) => [k, String(v)])).toString();
  const frame = (blob) => { const u = URL.createObjectURL(blob); on.frame(u); if (url) URL.revokeObjectURL(url); url = u; };
  function connect() {
    if (dead) return;
    on.state('connecting');
    ws = new WebSocket(wsUrl(`${node(id)}/screen/stream?${query(cur)}`));
    ws.binaryType = 'blob';
    let refused = null;
    ws.onmessage = (e) => {
      if (typeof e.data !== 'string') { on.state('live'); frame(e.data); return; }
      let m; try { m = JSON.parse(e.data); } catch { return; }
      if (m.type === 'error') { refused = m; on.state('refused', m); }
      else if (m.type === 'meta') on.meta?.(m);
    };
    ws.onclose = (e) => {
      if (dead) return;
      if (refused || (e.code >= 4400 && e.code < 4600)) { if (!refused) on.state('refused', { status: e.code === 4403 ? 'control-off' : 'unavailable', message: e.reason }); return; }
      timer = setTimeout(connect, RETRY_MS);
    };
  }
  connect();
  return {
    set(next) { cur = { ...cur, ...next }; if (ws?.readyState === 1) ws.send(JSON.stringify(next)); },
    close() { dead = true; clearTimeout(timer); try { ws?.close(1000); } catch {} if (url) URL.revokeObjectURL(url); url = null; },
  };
}

/** The large view: higher fps, fps and quality controls, a close button. */
export function openLargeView(machine, { onClose } = {}) {
  const phone = isPhone();
  let live = null;
  let fps = phone ? 3 : 5;
  let quality = 60;
  const status = h('div', { class: 'dk-big-status muted small', role: 'status' }, 'Connecting…');
  const img = h('img', { class: 'dk-big-img', alt: `Live desktop of ${machine.name}`, hidden: true });
  const placeholder = h('div', { class: 'dk-ph', role: 'status', hidden: true });
  const fpsSel = h('select', { 'aria-label': 'Frames per second', onchange: () => { fps = Number(fpsSel.value); live?.set({ fps }); } }, ...FPS.map((f) => h('option', { value: f, selected: f === fps }, `${f} fps`)));
  const qSel = h('select', { 'aria-label': 'Image quality', onchange: () => { quality = Number(qSel.value); live?.set({ quality }); } }, ...QUALITY.map(([l, q]) => h('option', { value: q, selected: q === quality }, l)));
  const w = openWindow({ title: `Desktop · ${machine.name}`, icon: '🖥', width: 980, height: 640, className: 'dk-win', onClose: () => { document.removeEventListener('visibilitychange', vis); live?.close(); onClose?.(); } });
  const closeBtn = h('button', { class: 'btn', onclick: () => w.close() }, 'Close');
  w.body.append(h('div', { class: 'dk-big' }, h('div', { class: 'dk-bar' }, h('label', { class: 'small' }, 'Speed ', fpsSel), h('label', { class: 'small' }, 'Quality ', qSel), status, closeBtn), h('div', { class: 'dk-stage' }, img, placeholder)));
  const start = () => {
    if (live) return;
    live = openStream(machine.id, { fps, quality, scale: 1, maxWidth: phone ? 800 : 1600 }, {
      frame: (u) => { img.src = u; img.hidden = false; placeholder.hidden = true; },
      state: (s, m) => {
        if (s === 'live') status.textContent = 'Live';
        else if (s === 'connecting') status.textContent = 'Connecting…';
        else { status.textContent = ''; img.hidden = true; placeholder.hidden = false; placeholder.textContent = refusalText(machine.name, m?.status, m?.message); live?.close(); live = null; }
      },
    });
  };
  // Hidden tab: close the stream, resume when visible again (unless it was refused).
  let refusedNow = () => placeholder.hidden === false;
  const vis = () => { if (document.hidden) { live?.close(); live = null; status.textContent = 'Paused'; } else if (!refusedNow()) start(); };
  document.addEventListener('visibilitychange', vis);
  if (!document.hidden) start();
  return w;
}

/** Mount the panel into `el`. opts.machines() = online machines ({id, name}). Returns { setActive, refresh }. */
export function createDesktops(el, opts = {}) {
  const meta = h('span', { class: 'wk-meta' }, '');
  const head = h('div', { class: 'wk-head keep' }, h('span', { class: 'wk-title' }, 'Desktops'), meta);
  const grid = h('div', { class: 'dk-grid' });
  el.append(head, grid);
  const tiles = new Map(); // id → tile controller
  let active = false;
  let pollTimer = null;
  const big = new Map(); // id → window

  const io = 'IntersectionObserver' in window ? new IntersectionObserver((entries) => {
    for (const e of entries) e.target._tile?.setVisible(e.isIntersecting);
  }, { root: el, threshold: 0.1 }) : null;

  function makeTile(m) {
    let access = null; // { ok, status, message } from the plain GET
    let visible = !io;
    let live = null;
    const img = h('img', { class: 'dk-img', alt: `Live desktop of ${m.name}`, hidden: true });
    const ph = h('div', { class: 'dk-ph small', role: 'status' }, 'Checking…');
    const dot = h('i', { class: 'dk-dot' });
    const open = () => { if (!access?.ok) return; if (big.has(m.id)) { big.get(m.id).raise(); return; } const win = openLargeView(m, { onClose: () => { big.delete(m.id); sync(); } }); big.set(m.id, win); sync(); };
    const btn = h('button', { class: 'dk-tile-btn', 'aria-label': `Open ${m.name} desktop`, onclick: open }, img, ph);
    const root = h('div', { class: 'dk-tile' }, h('div', { class: 'dk-cap' }, dot, h('span', { class: 'dk-name' }, m.name)), btn);
    function stop() { live?.close(); live = null; }
    function sync() {
      const want = active && !document.hidden && visible && access?.ok && !big.has(m.id);
      if (want && !live) {
        live = openStream(m.id, TILE, {
          frame: (u) => { img.src = u; img.hidden = false; ph.hidden = true; },
          state: (s, r) => { if (s === 'refused') { stop(); setAccess({ ok: false, status: r?.status, message: r?.message }); } },
        });
      } else if (!want) stop();
    }
    function setAccess(a) {
      access = a;
      root.classList.toggle('off', !a.ok);
      dot.className = 'dk-dot ' + (a.ok ? 'ok' : 'bad');
      btn.disabled = !a.ok;
      if (a.ok) { if (!img.src) { ph.hidden = false; ph.textContent = 'Connecting…'; } }
      else { stop(); img.hidden = true; ph.hidden = false; ph.textContent = refusalText(m.name, a.status, a.message); }
      sync();
    }
    const ctl = { id: m.id, root, sync, setAccess, destroy() { stop(); io?.unobserve(root); }, setVisible(v) { visible = v; sync(); }, access: () => access };
    root._tile = ctl;
    io?.observe(root);
    return ctl;
  }

  async function poll() {
    const ms = opts.machines?.() || [];
    meta.textContent = ms.length ? `${ms.length} online` : '';
    for (const [id, t] of tiles) if (!ms.some((m) => m.id === id)) { t.destroy(); t.root.remove(); tiles.delete(id); }
    for (const m of ms) if (!tiles.has(m.id)) { const t = makeTile(m); tiles.set(m.id, t); grid.append(t.root); }
    if (!ms.length) { grid.replaceChildren(h('div', { class: 'muted small pad' }, 'No machine is online.')); tiles.clear(); return; }
    grid.querySelector(':scope > .pad')?.remove();
    await Promise.all(ms.map(async (m) => {
      const t = tiles.get(m.id);
      let a;
      try {
        const r = await api(`${node(m.id)}/screen/stream`);
        a = r?.access?.ok ? { ok: true } : { ok: false, status: r?.access?.status, message: r?.access?.message };
      } catch (e) { a = { ok: false, status: 'unavailable', message: `${m.name}: ${e.message}` }; }
      if (!tiles.has(m.id)) return;
      const prev = t.access();
      if (!prev || prev.ok !== a.ok || prev.status !== a.status) t.setAccess(a);
    }));
  }

  function setActive(on) {
    active = !!on;
    clearInterval(pollTimer);
    pollTimer = null;
    if (active) { poll(); pollTimer = setInterval(() => { if (!document.hidden) poll(); }, POLL_MS); }
    for (const t of tiles.values()) t.sync();
  }
  document.addEventListener('visibilitychange', () => { if (!active) return; if (!document.hidden) poll(); for (const t of tiles.values()) t.sync(); });
  return { setActive, refresh: poll };
}
