import { api, h, toast } from './api.js';
import { prefersReducedMotion } from './a11y.js';
import { isPhone } from './mobile.js';
import { openWindow } from './wm.js';
import { renderVisual } from './visual.js';
import { contextFrom, mountSketch, refreshSketches, sketchFor } from './p5-anim.js';
import { onTheme } from './themes.js';
import * as M from './exhibits-model.js';

// EXPERIMENTAL — the Exhibit window. While a request or project is being worked on, src/exhibits.js turns what happens
// into illustrated entries; this window shows them as a vertical storyboard that fills in live:
//   - 'exhibit-live' pushes ("Thinking with …", "Using Write on …") run a ticker at the top within milliseconds of
//     a request, before any entry exists; a shimmering ghost card at the end of the list marks where the next one lands
//   - each 'exhibit' push animates in as a card (rise + unblur, image wipe-reveal, slow Ken-Burns drift), its visual
//     drawn by visual.js; 'exhibit-image' crossfades a ComfyUI picture over the SVG; 'exhibit-final' ends the story
//   - a picker switches between recent request and project documents (mesh /api/exhibits); a final document can be
//     exported (HTML, Markdown), printed, or read as a plain document view
// The toggle lives in the menu bar: Experimental › Exhibits (POST /api/local/exhibits/config). With it on, the window
// opens by itself (without taking the cursor) for the first push of each new request or project. A card whose picture is
// the built-in SVG (not a ComfyUI one) is drawn live by an internal p5.js sketch for its kind (p5-anim.js: lazy-loaded,
// themed from the CSS variables, paused off-screen, one settled frame under reduced motion or in Document view); the SVG
// stays underneath as the fallback if p5 cannot load, and a ComfyUI picture replaces the sketch. Pure logic:
// exhibits-model.js (tested in test/exhibits-ui.test.js). Styles: the "EXHIBITS" block of styles.css.

const pref = (k, d) => { try { return localStorage.getItem('rigs.exhibits.' + k) ?? d; } catch { return d; } };
const setPref = (k, v) => { try { localStorage.setItem('rigs.exhibits.' + k, v); } catch { /* private mode */ } };
const pad = (n) => String(n ?? 0).padStart(2, '0');
const clock = (t) => (t ? new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '');
const MAX_DOCS = 40;

const st = {
  enabled: false,
  docs: new Map(), // docId → { doc, node, hydrated, loading }
  seen: new Set(), // docIds this page has had a push for (the window opens for a new one)
  ticker: new Map(), // docId → [{ text, kind, at }]
  listed: [], // the picker's list from the mesh
  current: null,
  follow: true, // the window follows new work until the person picks an older document
  view: pref('view', 'cards'), // 'cards' | 'document'
  ui: null,
};

onTheme(refreshSketches);

export const exhibitsEnabled = () => st.enabled;

/** Read the opt-in switch (GET /api/local/exhibits/config). Call once at start. */
export async function initExhibits() {
  try { st.enabled = !!(await api('/api/local/exhibits/config')).enabled; } catch { /* an older daemon: stays off */ }
  return st.enabled;
}

/** Experimental › Exhibits: switch the feature on or off for this machine (POST /api/local/exhibits/config). */
export async function setExhibitsEnabled(on) {
  try {
    const r = await api('/api/local/exhibits/config', { method: 'POST', body: { enabled: !!on } });
    st.enabled = !!r.enabled;
    toast(st.enabled ? 'Exhibits on — the window opens when the next request or project starts.' : 'Exhibits off.', 'ok');
  } catch (e) { toast(`Could not change Exhibits: ${e.message}`, 'error'); }
  st.ui?.renderEmpty();
  return st.enabled;
}

// ------------------------------------------------------------------ documents

function ensure(docId, node = '') {
  let rec = st.docs.get(docId);
  if (!rec) {
    rec = { doc: { ...M.emptyDoc(docId), created: Date.now() }, node, hydrated: false, loading: false };
    st.docs.set(docId, rec);
    for (const k of st.docs.keys()) { if (st.docs.size <= MAX_DOCS) break; if (k !== st.current) st.docs.delete(k); }
  }
  if (node && !rec.node) rec.node = node;
  return rec;
}

/** Fetch the stored document and fold it in (a live-only document has none yet: a 404 is fine). */
async function hydrate(rec) {
  if (rec.loading || rec.hydrated) return;
  rec.loading = true;
  try {
    const d = await api(M.docUrl(rec.node, rec.doc.docId));
    M.mergeDoc(rec.doc, d);
    rec.hydrated = true;
    if (st.current === rec.doc.docId) st.ui?.sync();
  } catch { /* not stored yet, or the machine is away */ } finally { rec.loading = false; }
}

async function loadList() {
  let r = null;
  try { r = await api('/api/exhibits'); } catch { try { const l = await api('/api/local/exhibits'); r = { docs: (l.docs || []).map((d) => ({ ...d, node: l.node })) }; } catch { /* keep the last list */ } }
  if (r) { st.listed = (r.docs || []).slice(0, MAX_DOCS); st.ui?.renderPicker(); }
}

// ------------------------------------------------------------------ the WebSocket feed

/** Every { type: 'exhibit' | 'exhibit-entry' | 'exhibit-image' | 'exhibit-final' | 'exhibit-live' } push, from main.js. */
export function onExhibitEvent(m) {
  const kind = M.pushKind(m);
  if (!kind) return;
  st.enabled = true; // pushes only flow while the feature is on
  const fresh = M.startsDocument(st.seen, m);
  st.seen.add(m.docId);
  const rec = ensure(m.docId);
  if (kind === 'live') st.ticker.set(m.docId, M.pushLive(st.ticker.get(m.docId), m));
  const r = M.applyPush(rec.doc, m);
  if (kind === 'final') { st.ticker.delete(m.docId); loadList(); if (!rec.hydrated) hydrate(rec); }

  if (fresh) {
    if (!st.ui) openExhibits({ docId: m.docId, auto: true });
    else if (M.shouldFollow({ current: st.current, currentFinal: !!st.docs.get(st.current)?.doc.final, follow: st.follow })) st.ui.show(m.docId);
    if (kind !== 'live') hydrate(rec);
  }
  if (!st.ui) return;
  st.ui.renderPicker();
  if (m.docId !== st.current) return;
  if (kind === 'live') st.ui.renderTicker();
  else if (kind === 'entry') { st.ui.put(r.entry, r.isNew); st.ui.renderHead(); st.ui.renderTicker(); }
  else if (kind === 'image') { if (r.entry) st.ui.swapImage(r.entry); }
  else if (kind === 'final') { st.ui.renderHead(); st.ui.renderTicker(); }
}

// ------------------------------------------------------------------ the window

/** Open (or raise) the Exhibit window. `docId` picks the document; `auto` = opened by a push, so it keeps the cursor where it was. */
export function openExhibits({ docId = null, auto = false } = {}) {
  if (st.ui) { st.ui.win.raise(); if (docId) st.ui.show(docId); return st.ui; }
  let timer = null;
  const sketches = new Map(); // entry id → { handle, host }: the p5 sketch drawing that card's picture
  const unmount = (id) => { const s = sketches.get(id); if (s) { s.handle.destroy(); s.host.remove(); sketches.delete(id); } };
  const unmountAll = () => { for (const id of [...sketches.keys()]) unmount(id); };
  const win = openWindow({ title: 'Exhibits', icon: '🎞', width: 540, height: 720, className: 'win-exhibits', focus: !auto, onClose: () => { clearInterval(timer); unmountAll(); st.ui = null; } });
  if (!isPhone()) { // beside the work: the right edge, under the menu bar
    const w = win.el.offsetWidth;
    Object.assign(win.el.style, { left: Math.max(16, window.innerWidth - w - 20) + 'px', top: (parseInt(getComputedStyle(document.documentElement).getPropertyValue('--mb-h')) || 0) + 56 + 'px' });
  }
  const cards = new Map(); // entry id → card element
  const picker = h('select', { class: 'ex-picker', 'aria-label': 'Document', onchange: (e) => pick(e.target.value) });
  const title = h('h2', { class: 'ex-title' }, '');
  const badge = h('span', { class: 'ex-badge' }, '');
  const count = h('span', { class: 'ex-count' }, '');
  const viewBtn = h('button', { class: 'tb', 'aria-pressed': 'false', title: 'Plain document view: no motion, reads top to bottom', onclick: () => { st.view = st.view === 'document' ? 'cards' : 'document'; setPref('view', st.view); applyView(); } }, 'Document view');
  const htmlBtn = h('button', { class: 'tb ex-needs-final', title: 'Open the finished document as a web page', onclick: () => { const r = cur(); if (r) window.open(M.exportUrl(r.node, r.doc.docId, 'html'), '_blank', 'noopener'); } }, 'Export HTML');
  const mdBtn = h('a', { class: 'tb ex-needs-final', role: 'button', download: '', title: 'Download the finished document as Markdown' }, 'Export MD');
  const printBtn = h('button', { class: 'tb ex-needs-final', title: 'Print the document', onclick: () => window.print() }, 'Print');
  const head = h('div', { class: 'ex-head' },
    h('div', { class: 'ex-titlebox' }, badge, title, count),
    h('div', { class: 'ex-bar' }, picker, viewBtn, htmlBtn, mdBtn, printBtn));
  const nowTrail = h('div', { class: 'ex-trail' });
  const nowText = h('div', { class: 'ex-now-text' });
  const ticker = h('div', { class: 'ex-ticker', 'aria-hidden': 'true' }, h('span', { class: 'ex-pulse' }), h('div', { class: 'ex-now' }, nowTrail, nowText), h('span', { class: 'ex-scan' }));
  const ghost = h('div', { class: 'ex-ghost', 'aria-hidden': 'true' }, h('i', { class: 'ex-g-fig' }), h('i', {}), h('i', { class: 'short' }));
  const empty = h('div', { class: 'ex-empty' });
  const list = h('div', { class: 'ex-list', role: 'log', 'aria-live': 'polite', 'aria-relevant': 'additions', 'aria-label': 'Exhibit storyboard', tabindex: '0' }, empty, ghost);
  win.body.append(head, ticker, list);

  const cur = () => st.docs.get(st.current) || null;
  const nearBottom = () => list.scrollHeight - list.scrollTop - list.clientHeight < 90;
  const toBottom = () => requestAnimationFrame(() => list.scrollTo({ top: list.scrollHeight, behavior: prefersReducedMotion() ? 'auto' : 'smooth' }));

  function applyView() {
    list.classList.toggle('ex-doc', st.view === 'document');
    viewBtn.setAttribute('aria-pressed', String(st.view === 'document'));
    viewBtn.classList.toggle('on', st.view === 'document');
    for (const { handle } of sketches.values()) handle.refresh(); // Document view is motionless: each sketch settles to one still frame
  }

  /** Draw the card's picture live with the p5 sketch for its kind, over the built-in SVG (kept as the fallback). */
  function mountFor(entry, el) {
    const fig = entry.image?.source === 'svg' ? el.querySelector('.ex-fig') : null;
    if (!fig) return;
    const host = h('div', { class: 'ex-p5', 'aria-hidden': 'true' });
    fig.prepend(host);
    const rec = cur();
    const entries = rec?.doc.entries || [];
    const counts = {};
    for (const e of entries) counts[e.kind] = (counts[e.kind] || 0) + 1;
    const handle = mountSketch(host, {
      id: sketchFor(entry.kind), seed: `${rec?.doc.title || ''}|${entry.id}`, // the document's title too: the same step in two tasks looks different
      info: contextFrom(entry, { title: rec?.doc.title, total: entries.length, counts }), // what the card is about, drawn as data
      reducedMotion: () => prefersReducedMotion() || st.view === 'document',
      onReady: () => host.classList.add('in'),
      onError: () => { sketches.delete(entry.id); host.remove(); },
    });
    sketches.set(entry.id, { handle, host });
  }

  function figure(entry, rec, next = false) {
    const src = M.imageSrc(entry, rec.node, rec.doc.docId);
    if (!src) return null;
    const img = h('img', { class: 'ex-img' + (next ? ' ex-img-next' : ''), alt: entry.image?.alt || entry.title, decoding: 'async', draggable: 'false' });
    const show = () => img.classList.add('in');
    img.addEventListener('load', show, { once: true });
    img.addEventListener('error', () => { img.classList.add('in', 'broken'); }, { once: true });
    img.src = src;
    if (img.complete && img.naturalWidth) show();
    return img;
  }

  function card(entry, rec, { animate, index = 0 }) {
    const img = figure(entry, rec);
    const odd = (entry.seq ?? index) % 2;
    return h('article', { class: `ex-card k-${entry.kind}${animate ? ' ex-new' : ''}`, 'data-id': entry.id, 'data-seq': String(entry.seq ?? 0), style: { '--i': String(Math.min(index, 8)), '--kbx': odd ? '-2%' : '2%', '--kby': odd ? '-1.2%' : '1.4%' } },
      h('header', { class: 'ex-meta' }, h('span', { class: 'ex-seq' }, pad(entry.seq)), h('span', { class: 'ex-kind' }, M.KIND_LABEL[entry.kind] || entry.kind), h('time', { class: 'ex-time' }, clock(entry.at))),
      h('h3', { class: 'ex-h' }, entry.title),
      img ? h('figure', { class: 'ex-fig' }, img, h('span', { class: 'ex-sheen', 'aria-hidden': 'true' })) : null,
      entry.caption ? h('p', { class: 'ex-cap' }, entry.caption) : null,
      entry.visual ? h('div', { class: 'ex-vis' }, renderVisual(entry.visual)) : null);
  }

  /** Place a card by seq, before the first later one (or the ghost). */
  function place(el, seq) {
    const after = [...list.querySelectorAll('.ex-card')].find((c) => Number(c.dataset.seq) > seq);
    list.insertBefore(el, after || ghost);
  }

  /** Show an entry: a new one animates in, a changed one replaces its card. */
  function put(entry, isNew, index = 0) {
    const rec = cur();
    if (!entry || !rec) return;
    empty.hidden = true;
    const stick = nearBottom();
    const old = cards.get(entry.id);
    const el = card(entry, rec, { animate: isNew && !prefersReducedMotion(), index });
    unmount(entry.id);
    if (old) { old.replaceWith(el); el.classList.add('ex-updated'); } else place(el, entry.seq ?? 0);
    cards.set(entry.id, el);
    mountFor(entry, el); // after the card is in the list: the sketch sizes itself from its host
    if (isNew && stick) toBottom();
  }

  /** A ComfyUI picture arrived for an entry already shown: fade it in over the SVG. */
  function swapImage(entry) {
    const rec = cur();
    const el = cards.get(entry.id);
    if (!rec || !el) return;
    const next = figure(entry, rec, true);
    if (!next) return;
    let fig = el.querySelector('.ex-fig');
    if (!fig) { fig = h('figure', { class: 'ex-fig' }, h('span', { class: 'ex-sheen', 'aria-hidden': 'true' })); el.querySelector('.ex-h').after(fig); }
    const prev = [...fig.querySelectorAll('.ex-img')];
    fig.prepend(next);
    const done = () => { prev.forEach((p) => p.remove()); next.classList.remove('ex-img-next'); unmount(entry.id); }; // the picture replaces the sketch
    if (prefersReducedMotion()) done(); else setTimeout(done, 900);
  }

  function renderAll() {
    unmountAll();
    for (const c of cards.values()) c.remove();
    cards.clear();
    const rec = cur();
    // A document opened from the picker settles in with a short staggered rise; live entries animate as they arrive.
    rec?.doc.entries.forEach((e, i) => put(e, i < 8, i));
    list.scrollTop = 0;
  }

  /** Add cards for entries the document has and the list lacks (after a fetch), without touching the rest. */
  function sync() {
    const rec = cur();
    if (!rec) return;
    for (const e of rec.doc.entries) if (!cards.has(e.id)) put(e, false, 0);
    empty.hidden = !!rec.doc.entries.length;
    renderHead(); renderTicker();
  }

  function renderHead() {
    const rec = cur();
    const d = rec?.doc;
    win.el.classList.toggle('ex-final', !!d?.final);
    title.textContent = d ? M.titleOf(d) : 'Exhibits';
    badge.textContent = d ? (d.final ? 'FINAL' : 'LIVE') : (st.enabled ? 'READY' : 'OFF');
    badge.className = `ex-badge ${d ? (d.final ? 'final' : 'live') : 'idle'}`;
    count.textContent = d ? M.countText(d.entries.length) + (d.dropped ? ` · ${d.dropped} left out` : '') : '';
    for (const b of [htmlBtn, mdBtn, printBtn]) b.hidden = !d?.final;
    if (d) mdBtn.href = M.exportUrl(rec.node, d.docId, 'md', true);
    ghost.hidden = !d || d.final;
  }

  let lastNow = '';
  function renderTicker() {
    const rec = cur();
    const d = rec?.doc;
    const lines = (d && st.ticker.get(d.docId)) || [];
    let now = '';
    let trail = [];
    if (!d) now = st.enabled ? 'Standing by — the next request builds its story here.' : 'Exhibits are off.';
    else if (d.final) now = `Finished — ${M.countText(d.entries.length)}.`;
    else if (lines.length) { now = lines.at(-1).text; trail = lines.slice(-3, -1).map((l) => l.text); }
    else now = d.entries.length ? 'Working…' : 'Listening…';
    ticker.classList.toggle('done', !!d?.final);
    ticker.classList.toggle('idle', !d);
    nowTrail.replaceChildren(...trail.map((t) => h('div', { class: 'ex-trail-line' }, t)));
    if (now !== lastNow) { lastNow = now; nowText.replaceChildren(h('span', { class: 'ex-type' }, now)); } // a new element restarts the typing animation
  }

  function renderPicker() {
    const live = [...st.docs.values()].filter((r) => r.hydrated || r.doc.entries.length || !st.listed.some((d) => d.docId === r.doc.docId)).map((r) => M.summaryOf(r.doc, r.node));
    const rows = M.pickerRows(st.listed, live);
    picker.replaceChildren(...(rows.length
      ? rows.map((r) => h('option', { value: r.docId, title: M.docHeading(r), selected: r.docId === st.current }, M.rowLabel(r)))
      : [h('option', { value: '' }, 'No documents yet')]));
    picker.disabled = !rows.length;
  }

  function renderEmpty() {
    empty.replaceChildren(
      h('div', { class: 'ex-empty-art', 'aria-hidden': 'true' }, '🎞'),
      h('p', {}, st.enabled ? 'No exhibits yet. Send JARVIS a request or start a project — its story builds here as it happens.' : 'Exhibits are off. They turn each request and project into an illustrated story as it happens.'),
      st.enabled ? null : h('button', { class: 'btn primary', onclick: async () => { await setExhibitsEnabled(true); renderEmpty(); } }, 'Turn on Exhibits'));
    empty.hidden = !!cur()?.doc.entries.length;
    renderHead(); renderTicker();
  }

  function show(docId) {
    if (!docId) { st.current = null; renderAll(); renderEmpty(); renderPicker(); return; }
    const row = st.listed.find((d) => d.docId === docId);
    const rec = ensure(docId, row?.node || '');
    st.current = docId;
    renderAll();
    empty.hidden = !!rec.doc.entries.length;
    renderHead(); renderTicker(); renderPicker();
    hydrate(rec);
  }

  function pick(docId) {
    if (!docId) return;
    const newest = M.pickerRows(st.listed, [...st.docs.values()].map((r) => M.summaryOf(r.doc, r.node)))[0];
    st.follow = newest?.docId === docId; // picking the newest document means "follow the work" again
    show(docId);
  }

  timer = setInterval(loadList, 20000);
  st.ui = { win, show, put: (e, isNew) => put(e, isNew, cards.size), swapImage, sync, renderHead, renderTicker, renderPicker, renderEmpty };
  applyView();
  renderEmpty();
  renderPicker();
  // Start on the given document, else the newest on the list.
  if (docId) show(docId);
  loadList().then(() => {
    if (!st.ui || st.current) return;
    const first = M.keepSelection(M.pickerRows(st.listed, []), null);
    if (first) { st.follow = true; show(first); }
  });
  return st.ui;
}

export const closeExhibits = () => st.ui?.win.close();
