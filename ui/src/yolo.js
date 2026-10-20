import { api, h } from './api.js';
import { openWindow } from './wm.js';
import { STATUS_LABEL, applyEvent, prettyActivity, elapsed, errorCount, errorsUrl, eventKey, isYoloEvent, startRun, stopUrl, windowTitle } from './yolo-model.js';

// YOLO windows: "yolo a bouncing ball in p5" opens a floating window the moment the daemon pushes yolo-start (before the
// agent writes anything), shows the run's sandbox page in an iframe through /api/nodes/<node>/yolo/<runId>/ (so a run
// on another machine looks the same), reloads it on every yolo-update and settles a slim status strip on yolo-done.
// Events (src/yolo.js has the contract) arrive on /ws and in the jarvis/send stream: onYoloEvent takes both and dedupes.
// A finished window stays until closed; several runs make several windows. Window chrome (tiling, docking, the phone
// full-screen sheet) is wm.js's.

const runs = new Map(); // runId → { state, win, frame, ... }
const seen = new Set();

/** Feed a yolo-* event from either path. Anything else is ignored. */
export function onYoloEvent(m) {
  if (!isYoloEvent(m)) return;
  const k = eventKey(m);
  if (seen.has(k)) return;
  seen.add(k);
  if (seen.size > 2000) seen.delete(seen.values().next().value);
  let r = runs.get(m.runId);
  if (!r) {
    if (m.type !== 'yolo-start') return; // an update for a run whose window was closed
    r = openRun(startRun(m));
    runs.set(m.runId, r);
    return;
  }
  const prev = r.state;
  r.state = applyEvent(prev, m);
  if (r.state === prev) return;
  render(r);
  if (m.type === 'yolo-update') postReload(r);
  if (m.type === 'yolo-done') finish(r);
}

export const openYoloRuns = () => [...runs.keys()];

function postReload(r) {
  try { r.frame.contentWindow?.postMessage({ type: 'yolo-reload' }, '*'); } catch { /* the page's own SSE reloads it too */ }
}

function reload(r) { r.frame.src = r.state.url; } // a fresh load; the in-page client reloads on updates itself

async function pollErrors(r) {
  try { const n = errorCount(await api(errorsUrl(r.state))); if (n !== r.state.errors) { r.state = { ...r.state, errors: n }; render(r); } } catch { /* run gone or peer unreachable */ }
}

async function stop(r) {
  r.stopBtn.disabled = true;
  try { await api(stopUrl(r.state), { method: 'POST', body: {} }); } catch (e) { r.step.textContent = `Could not stop: ${e.message}`; r.stopBtn.disabled = false; }
}

function finish(r) {
  clearInterval(r.timer);
  r.time.textContent = elapsed(r.state);
  pollErrors(r);
  r.win.el.classList.add('yolo-finished');
}

function render(r) {
  const s = r.state;
  r.win.el.dataset.yoloStatus = s.status;
  r.dot.className = `yolo-dot ${s.status}`;
  r.label.textContent = STATUS_LABEL[s.status];
  r.step.textContent = s.activity;
  r.step.title = s.summary || s.activity;
  r.time.textContent = elapsed(s);
  r.errs.textContent = s.errors ? `${s.errors} error${s.errors === 1 ? '' : 's'}` : 'no errors';
  r.errs.classList.toggle('bad', s.errors > 0);
  r.stopBtn.disabled = s.status !== 'live';
}

function openRun(state) {
  const r = { state };
  r.frame = h('iframe', { class: 'app-frame yolo-frame', title: state.title, src: state.url, allow: 'fullscreen; clipboard-write', sandbox: 'allow-scripts allow-forms allow-popups allow-modals allow-pointer-lock' });
  r.dot = h('i', { class: 'yolo-dot live' });
  r.label = h('b', { class: 'yolo-label' }, 'live');
  r.step = h('span', { class: 'yolo-step' }, state.activity);
  r.time = h('span', { class: 'yolo-time' }, '0:00');
  r.errs = h('span', { class: 'yolo-errs' }, 'no errors');
  const btn = (text, title, fn, extra = {}) => h('button', { class: 'btn yolo-btn', title, 'aria-label': title, onclick: fn, ...extra }, text);
  r.stopBtn = btn('■ Stop', 'Stop the agent', () => stop(r));
  r.win = openWindow({
    title: windowTitle(state), icon: '⚡', width: 960, height: 680, className: 'yolo-win', focus: false,
    onClose: () => { clearInterval(r.timer); runs.delete(state.runId); },
  });
  const keep = btn('★ Keep as app', 'Promoting a YOLO run to an app is not available yet', () => {}, { disabled: true });
  const strip = h('div', { class: 'yolo-strip' },
    h('div', { class: 'yolo-status' }, r.dot, r.label, r.step, r.time, r.errs),
    h('div', { class: 'yolo-btns' }, r.stopBtn,
      btn('↻ Reload', 'Reload the page', () => reload(r)),
      btn('↗ Open', 'Open in a new tab', () => window.open(r.state.url, '_blank', 'noopener')),
      btn('⤢ Full size', 'Pop the window to full size', () => r.win.el.querySelector('.win-btn[aria-label="Maximize"]')?.click()),
      keep));
  r.win.body.append(strip, h('div', { class: 'app-stage yolo-stage' }, r.frame));
  r.timer = setInterval(() => { r.time.textContent = elapsed(r.state); }, 1000);
  r.win.interval(() => { if (r.state.status === 'live') pollErrors(r); }, 2500);
  render(r);
  return r;
}
