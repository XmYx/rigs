import { api, h, toast } from './api.js';
import { prefersReducedMotion } from './a11y.js';
import { isPhone } from './mobile.js';
import { lowPower } from './perf.js';
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
//
// The top of the window is the ACTIVITY of the work it is about, fed by the trace span stream (main.js forwards every
// { type: 'trace-span' } push to onExhibitSpan; spans other machines hold are polled from /api/traces/<id>): the
// project or request title, its steps and progress, the files touched (read / edit / create, with a count) and the
// tool calls (newest first, status and a short redacted result). Its scope is the document picked from the picker,
// else the work running now, else the most recent work (exhibits-model.js: foldSpans, pickScope, activityOf). This part
// works whether or not the Exhibits feature (the storyboard) is on.
// Motion is decoration and follows one rule (exhibits-model.js shouldAnimate): nothing moves while nothing is working,
// while the window is hidden, under reduced motion, on lowPower() or with the Exhibit animations setting off; 'auto'
// (the default) moves only the card of the stage running now, 'always' every card while work runs. A stopped p5 sketch
// is noLoop (no requestAnimationFrame) and the window's looping CSS animations stop with it (the .ex-still class).

const pref = (k, d) => { try { return localStorage.getItem('rigs.exhibits.' + k) ?? d; } catch { return d; } };
const setPref = (k, v) => { try { localStorage.setItem('rigs.exhibits.' + k, v); } catch { /* private mode */ } };
// The Exhibit animations setting lives in the same store as the other display settings (main.js `store`: rigs.<key>, JSON).
const ANIM_KEY = 'rigs.exhibitAnim';
const readAnim = () => { try { return JSON.parse(localStorage.getItem(ANIM_KEY)); } catch { return null; } };
const pad = (n) => String(n ?? 0).padStart(2, '0');
const clock = (t) => (t ? new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '');
const MAX_DOCS = 40;
const POLL_MS = 20000;
const STATUS_ICON = { pending: '○', running: '◌', ok: '✓', error: '✗', stopped: '■' };
const MARK = { read: ['R', 'read'], edit: ['E', 'edited'], create: ['C', 'created'], delete: ['D', 'deleted'] };

const st = {
  enabled: false,
  docs: new Map(), // docId → { doc, node, hydrated, loading }
  seen: new Set(), // docIds this page has had a push for (the window opens for a new one)
  ticker: new Map(), // docId → [{ text, kind, at }]
  listed: [], // the picker's list from the mesh
  current: null,
  follow: true, // the window follows new work until the person picks an older document
  view: pref('view', 'cards'), // 'cards' | 'document'
  spans: new Map(), // traceId → { traceId, spans, lastAt }: the live activity, bounded (exhibits-model.js foldSpans)
  anim: M.animMode(readAnim()), // Exhibit animations: 'off' | 'auto' | 'always'
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

/** The Exhibit animations setting: 'off' | 'auto' (only the stage running now) | 'always' (every card while work runs). */
export const exhibitAnim = () => st.anim;

/** Change the Exhibit animations setting (persisted with the other display settings) and apply it at once. */
export function setExhibitAnim(mode) {
  st.anim = M.animMode(mode);
  try { localStorage.setItem(ANIM_KEY, JSON.stringify(st.anim)); } catch { /* private mode */ }
  window.dispatchEvent(new CustomEvent('rigs:exhibit-anim', { detail: st.anim }));
  st.ui?.motion();
  return st.anim;
}

// ------------------------------------------------------------------ the activity (trace spans)

/** Every { type: 'trace-span' } push, from main.js: kept (bounded) so the window can show what the work is doing. */
export function onExhibitSpan(span) {
  if (!span?.traceId) return;
  M.foldSpans(st.spans, span);
  st.ui?.activitySoon();
}

/** Fetch a trace's spans across the mesh (all of them, or those that moved since `after`) and fold them in. */
async function loadTrace(traceId, after = 0) {
  try {
    const r = await api(`/api/traces/${encodeURIComponent(traceId)}${after ? `?after=${after}` : ''}`);
    M.foldSpans(st.spans, r.spans || []);
    st.ui?.activitySoon();
  } catch { /* not traced, or the machines are away */ }
}

/** Nothing seen live yet (the page just loaded): the work running now, else the most recent request. */
async function loadRecent() {
  try {
    const r = await api('/api/traces?since=24h&limit=5');
    const t = (r.traces || []).find((x) => x.status === 'running') || r.traces?.[0];
    if (t) await loadTrace(t.traceId);
  } catch { /* an older daemon */ }
}

/** A project document picked to read: find its request trace through the project (p.trace, t.trace) and load it. */
async function loadProject(projectId, node) {
  try {
    const p = await api(`/api/nodes/${encodeURIComponent(node || 'self')}/projects/${encodeURIComponent(projectId)}`);
    const ids = new Set([p.trace, ...(p.tasks || []).map((t) => t.trace)].map((c) => String(c?.traceId || c || '').split(':')[0]).filter(Boolean));
    await Promise.all([...ids].slice(0, 3).map((id) => loadTrace(id)));
  } catch { /* gone, or its machine is away */ }
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
  if (kind === 'live') { st.ui.renderTicker(); st.ui.motion(); }
  else if (kind === 'entry') { st.ui.put(r.entry, r.isNew); st.ui.renderHead(); st.ui.renderTicker(); st.ui.motion(); }
  else if (kind === 'image') { if (r.entry) st.ui.swapImage(r.entry); }
  else if (kind === 'final') { st.ui.renderHead(); st.ui.renderTicker(); st.ui.motion(); }
}

// ------------------------------------------------------------------ the window

/** Open (or raise) the Exhibit window. `docId` picks the document; `auto` = opened by a push, so it keeps the cursor where it was. */
export function openExhibits({ docId = null, auto = false } = {}) {
  if (st.ui) { st.ui.win.raise(); if (docId) st.ui.show(docId); return st.ui; }
  let timer = null;
  let actTimer = null;
  const sketches = new Map(); // entry id → { handle, host }: the p5 sketch drawing that card's picture
  const unmount = (id) => { const s = sketches.get(id); if (s) { s.handle.destroy(); s.host.remove(); sketches.delete(id); } };
  const unmountAll = () => { for (const id of [...sketches.keys()]) unmount(id); };
  const win = openWindow({ title: 'Exhibits', icon: '🎞', width: 540, height: 720, className: 'win-exhibits', focus: !auto, onClose: () => { clearInterval(timer); clearTimeout(actTimer); document.removeEventListener('visibilitychange', motion); unmountAll(); st.ui = null; } });
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
  const animSel = h('select', { class: 'ex-anim', 'aria-label': 'Exhibit animations', title: 'Exhibit animations — off: never · auto: only the stage running now · always: every card while work runs. Never while idle, hidden, on reduced motion or low power.', onchange: (e) => setExhibitAnim(e.target.value) },
    ...M.ANIM_MODES.map((m) => h('option', { value: m, selected: m === st.anim }, `Motion: ${m}`)));
  const head = h('div', { class: 'ex-head' },
    h('div', { class: 'ex-titlebox' }, badge, title, count),
    h('div', { class: 'ex-bar' }, picker, viewBtn, animSel, htmlBtn, mdBtn, printBtn));
  // The activity of the work this window is about (trace spans): title, steps, files touched, tool calls.
  const act = {
    kind: h('span', { class: 'ex-act-kind' }), title: h('h3', { class: 'ex-act-title' }), prog: h('span', { class: 'ex-act-prog' }),
    bar: h('i'), now: h('div', { class: 'ex-act-now' }), steps: h('ol', { class: 'ex-steps', 'aria-label': 'Steps' }),
    filesHead: h('h4', {}), files: h('ul', { class: 'ex-files', 'aria-label': 'Files touched' }),
    toolsHead: h('h4', {}), tools: h('ul', { class: 'ex-tools', 'aria-label': 'Tool calls' }),
  };
  const activity = h('section', { class: 'ex-act', 'aria-label': 'What the work is doing' },
    h('div', { class: 'ex-act-head' }, act.kind, act.title, act.prog),
    h('div', { class: 'ex-act-bar', 'aria-hidden': 'true' }, act.bar), act.now, act.steps,
    h('div', { class: 'ex-act-cols' }, h('div', { class: 'ex-act-col' }, act.filesHead, act.files), h('div', { class: 'ex-act-col' }, act.toolsHead, act.tools)));
  const nowTrail = h('div', { class: 'ex-trail' });
  const nowText = h('div', { class: 'ex-now-text' });
  const ticker = h('div', { class: 'ex-ticker', 'aria-hidden': 'true' }, h('span', { class: 'ex-pulse' }), h('div', { class: 'ex-now' }, nowTrail, nowText), h('span', { class: 'ex-scan' }));
  const ghost = h('div', { class: 'ex-ghost', 'aria-hidden': 'true' }, h('i', { class: 'ex-g-fig' }), h('i', {}), h('i', { class: 'short' }));
  const empty = h('div', { class: 'ex-empty' });
  const list = h('div', { class: 'ex-list', role: 'log', 'aria-live': 'polite', 'aria-relevant': 'additions', 'aria-label': 'Exhibit storyboard', tabindex: '0' }, empty, ghost);
  win.body.append(head, ticker, activity, list);

  const cur = () => st.docs.get(st.current) || null;
  const nearBottom = () => list.scrollHeight - list.scrollTop - list.clientHeight < 90;
  const toBottom = () => requestAnimationFrame(() => list.scrollTo({ top: list.scrollHeight, behavior: prefersReducedMotion() ? 'auto' : 'smooth' }));

  function applyView() {
    list.classList.toggle('ex-doc', st.view === 'document');
    viewBtn.setAttribute('aria-pressed', String(st.view === 'document'));
    viewBtn.classList.toggle('on', st.view === 'document');
    for (const { handle } of sketches.values()) handle.refresh(); // Document view is motionless: each sketch settles to one still frame
    motion();
  }

  // ---- motion: one cached gate, re-evaluated when the work, the document, the setting or the visibility changes (a
  // sketch asks it on every frame, so it must be cheap: no span scans there)
  const gate = { active: false, hidden: false, current: null };
  const docSpans = () => M.scopeSpans(st.spans, M.docScope(st.current));
  /** Is the shown document's work running? Its spans say so; without spans, a live "now" line in the last 2 minutes. */
  function docActive() {
    const d = cur()?.doc;
    if (!d || d.final) return false;
    const spans = docSpans();
    if (spans.length) return M.isActive(spans);
    return Date.now() - (st.ticker.get(d.docId)?.at(-1)?.at || 0) < 120000;
  }
  const moves = (id) => M.shouldAnimate({ mode: st.anim, active: gate.active, hidden: gate.hidden || document.hidden, reducedMotion: prefersReducedMotion(), lowPower: lowPower(), documentView: st.view === 'document', current: id === gate.current });
  function motion() {
    const d = cur()?.doc;
    gate.active = docActive();
    gate.hidden = !win.el.isConnected || !win.el.getClientRects().length;
    gate.current = d && !d.final ? d.entries.at(-1)?.id ?? null : null;
    const any = M.shouldAnimate({ mode: st.anim, active: gate.active || !!st.ui?.workActive, hidden: gate.hidden || document.hidden, reducedMotion: prefersReducedMotion(), lowPower: lowPower(), documentView: false, current: true });
    win.el.classList.toggle('ex-still', !any); // the looping CSS animations (pulse, sweep, shimmer, drift) stop with the sketches
    win.el.classList.toggle('ex-motion-all', any && st.anim === 'always');
    for (const [id, c] of cards) c.classList.toggle('ex-current', id === gate.current);
    if (animSel.value !== st.anim) animSel.value = st.anim;
    for (const { handle } of sketches.values()) handle.sync();
  }
  document.addEventListener('visibilitychange', motion);

  // ---- the activity: the scope's spans → title, steps, files, tool calls
  let actScope = null;
  let actPending = false;
  const scopeKey = (s) => (s ? s.traceId || 'pr-' + s.projectId : '');
  const fetched = new Set(); // scopes fetched in full once (spans pushed before this page connected are only there)
  function activityScope() {
    const pinned = !st.follow && st.current ? M.docScope(st.current) : null;
    return M.pickScope(st.spans, { pinned });
  }
  function activitySoon() {
    if (actPending) return;
    actPending = true;
    actTimer = setTimeout(() => { actPending = false; renderActivity(); }, 200);
  }
  function ensureScope(scope) {
    const k = scopeKey(scope);
    if (!scope || fetched.has(k)) return;
    fetched.add(k);
    if (scope.traceId) loadTrace(scope.traceId); else loadProject(scope.projectId, cur()?.node);
  }
  function renderActivity() {
    if (!st.ui) return;
    actScope = activityScope();
    ensureScope(actScope);
    const a = M.activityOf(M.scopeSpans(st.spans, actScope));
    st.ui.workActive = !!a?.active;
    activity.classList.toggle('live', !!a?.active);
    if (!a) {
      act.kind.textContent = 'IDLE';
      act.kind.className = 'ex-act-kind idle';
      act.title.title = '';
      act.title.textContent = 'Nothing running';
      act.prog.textContent = '';
      act.bar.style.width = '0';
      act.now.textContent = 'The next request or task shows here: its steps, the files it touches and the tools it calls.';
      act.steps.replaceChildren();
      act.filesHead.textContent = 'Files'; act.files.replaceChildren(h('li', { class: 'ex-none' }, '—'));
      act.toolsHead.textContent = 'Tool calls'; act.tools.replaceChildren(h('li', { class: 'ex-none' }, '—'));
      motion();
      return;
    }
    act.kind.textContent = a.active ? 'NOW' : 'LAST';
    act.kind.className = `ex-act-kind ${a.active ? 'live' : 'idle'}`;
    act.title.textContent = a.title;
    act.title.title = a.request || a.title;
    act.prog.textContent = [a.tasks ? `${a.tasks.done}/${a.tasks.total} tasks` : null, `${a.done}/${a.total} steps`].filter(Boolean).join(' · ');
    act.bar.style.width = `${Math.round((a.tasks ? a.tasks.done / a.tasks.total : a.done / Math.max(1, a.total)) * 100)}%`;
    act.now.textContent = a.active ? (a.current ? `Working: ${a.current}` : 'Working…') : `Finished ${clock(a.lastAt)}${a.toolErrors ? ` · ${a.toolErrors} tool error${a.toolErrors === 1 ? '' : 's'}` : ''}`;
    act.steps.replaceChildren(...a.steps.map((s) => h('li', { class: `ex-step ${s.status}`, title: `${s.label} — ${s.status}` }, h('b', { 'aria-hidden': 'true' }, STATUS_ICON[s.status] || '·'), h('span', {}, s.label))));
    act.filesHead.textContent = `Files · ${a.filesTotal}`;
    act.files.replaceChildren(...(a.files.length ? a.files.map((f) => h('li', { class: `ex-file m-${f.mark}${f.error ? ' err' : ''}`, title: `${(f.node ? f.node + ':' : '') + f.path} — ${MARK[f.mark]?.[1] || f.mark}, ${f.count}×` },
      h('b', { class: 'ex-mark', 'aria-label': MARK[f.mark]?.[1] || f.mark }, MARK[f.mark]?.[0] || '?'), h('span', { class: 'ex-fname' }, f.name), h('span', { class: 'ex-fdir' }, `\u200e${f.node ? f.node + ':' : ''}${f.dir}\u200e`), f.count > 1 ? h('span', { class: 'ex-fcount' }, `×${f.count}`) : null))
      : [h('li', { class: 'ex-none' }, 'No files touched yet')]),
    ...(a.filesTotal > a.files.length ? [h('li', { class: 'ex-none' }, `+${a.filesTotal - a.files.length} more`)] : []));
    act.toolsHead.textContent = `Tool calls · ${a.toolsTotal}${a.toolsRunning ? ` · ${a.toolsRunning} running` : ''}`;
    act.tools.replaceChildren(...(a.tools.length ? a.tools.map((t) => h('li', { class: `ex-tool ${t.status}`, title: [t.name, t.target, t.summary].filter(Boolean).join('\n') },
      h('b', { class: 'ex-tst', 'aria-label': t.status }, STATUS_ICON[t.status] || '·'), h('span', { class: 'ex-tname' }, t.name), h('span', { class: 'ex-ttarget' }, t.target),
      h('span', { class: 'ex-tsum' }, t.status === 'running' ? 'running…' : t.summary)))
      : [h('li', { class: 'ex-none' }, 'No tool calls yet')]),
    ...(a.toolsTotal > a.tools.length ? [h('li', { class: 'ex-none' }, `+${a.toolsTotal - a.tools.length} earlier`)] : []));
    motion();
  }
  /** Spans other machines write (task runs, their tool calls) are not pushed here: poll the scope while it works. */
  function pollActivity() {
    if (!st.spans.size) { loadRecent(); return; }
    const spans = M.scopeSpans(st.spans, actScope);
    if (!spans.length || !M.isActive(spans)) { motion(); return; }
    const since = spans.reduce((x, s) => Math.max(x, s.start || 0, s.end || 0), 0) - 5000;
    for (const id of new Set(spans.map((s) => s.traceId))) loadTrace(id, since);
  }

  /** Draw the card's picture live with the p5 sketch for its kind, over the built-in SVG (kept as the fallback). */
  function mountFor(entry, el) {
    const fig = entry.image?.source === 'svg' ? el.querySelector('.ex-fig') : null;
    if (!fig) return;
    const host = h('div', { class: 'ex-p5', 'aria-hidden': 'true' });
    fig.prepend(host);
    const rec = cur();
    const handle = mountSketch(host, {
      id: sketchFor(entry.kind), seed: `${rec?.doc.title || ''}|${entry.id}`, // the document's title too: the same step in two tasks looks different
      info: contextFrom(entry, docInfo()), // what the card is about, drawn as data
      reducedMotion: () => !moves(entry.id), // the whole motion gate: still unless shouldAnimate says so
      onReady: () => host.classList.add('in'),
      onError: () => { sketches.delete(entry.id); host.remove(); },
    });
    sketches.set(entry.id, { handle, host, entry });
  }

  /** The current document as the sketches see it: title, entries so far, how many of each kind. */
  function docInfo() {
    const rec = cur();
    const entries = rec?.doc.entries || [];
    const counts = {};
    for (const e of entries) counts[e.kind] = (counts[e.kind] || 0) + 1;
    return { title: rec?.doc.title, total: entries.length, counts };
  }

  /** A live document grew: earlier cards re-read their place in it ("3 / 5", not the "3 / 3" they were mounted with). */
  function refreshInfo() {
    const d = docInfo();
    for (const { handle, entry } of sketches.values()) handle.setInfo(contextFrom(entry, d));
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
    el.classList.toggle('ex-current', entry.id === gate.current);
    mountFor(entry, el); // after the card is in the list: the sketch sizes itself from its host
    if (isNew) refreshInfo();
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
    renderHead(); renderTicker(); renderPicker(); renderActivity();
    hydrate(rec);
  }

  function pick(docId) {
    if (!docId) return;
    const newest = M.pickerRows(st.listed, [...st.docs.values()].map((r) => M.summaryOf(r.doc, r.node)))[0];
    st.follow = newest?.docId === docId; // picking the newest document means "follow the work" again
    show(docId);
  }

  timer = setInterval(() => { loadList(); pollActivity(); }, POLL_MS);
  st.ui = { win, show, put: (e, isNew) => put(e, isNew, cards.size), swapImage, sync, renderHead, renderTicker, renderPicker, renderEmpty, activitySoon, motion, workActive: false };
  applyView();
  renderEmpty();
  renderPicker();
  renderActivity();
  if (!st.spans.size) loadRecent();
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
