import { api, h, node, toast } from './api.js';
import { openWindow } from './wm.js';
import { registerTrayItem } from './tray.js';
import {
  SPEEDS, clampVolume, closeOutcome, createArbiter, errorMessage, folderOf, formatTime, mediaKind, mediaSiblings, rawUrl,
  nextSpeed, seekTarget, sessionMeta, speedLabel, stepKind, stepSpeed, titleOf, keyAction,
} from './media-player-model.js';

export { mediaKind } from './media-player-model.js';

// The media player: audio and video from any machine in the mesh (files/raw through the gateway, Range requests for
// seeking), in one wm.js window (floats, docks, full screen on phones). Play/pause, seek bar, time, volume/mute, speed,
// fullscreen and picture-in-picture for video, keyboard shortcuts (media-player-model.js keyAction), and the folder's
// other audio/video files as a playlist with next/previous. Audio lives in an element outside the window, so closing
// the window while it plays leaves it playing in a mini-player in the menu bar's tray (title, play/pause, next, close;
// on phones a now-playing strip above the toolbar).
// One media element plays at a time (the arbiter; the file browser's inline previews share it). Opened by
//   openMediaPlayer({ nodeId, nodeName, path, name?, entries?, startAt?, autoplay? })
// from the file browser (double-click and Open with through openFileTool, the preview's Open in Player), desktop icons,
// a ui_open push on a media file, the dock's ▶ tool and Tools › Media player (no path: the open player, else an empty one).
// Pure parts: media-player-model.js.

const arbiter = createArbiter();
const PREFS_KEY = 'rigs.media';
const LOAD_WATCHDOG_MS = 15000;

const prefs = (() => {
  try { const p = JSON.parse(localStorage.getItem(PREFS_KEY) || '{}'); return { volume: clampVolume(p.volume ?? 1), muted: !!p.muted, speed: SPEEDS.includes(p.speed) ? p.speed : 1 }; }
  catch { return { volume: 1, muted: false, speed: 1 }; }
})();
const savePrefs = () => { try { localStorage.setItem(PREFS_KEY, JSON.stringify(prefs)); } catch { /* private mode */ } };

let deps = { browse: null };
/** main.js hands over what the empty player's "Browse files…" opens. */
export function configureMediaPlayer(d) { deps = { ...deps, ...d }; }

let session = null; // { nodeId, nodeName, list, index, kind, el, watchdog, startAt } — what is loaded; null = nothing
let player = null; // { w, ui } — the open window; null = closed
let host = null; // the hidden holder of the audio element, outside every window

const track = () => session?.list[session.index] || null;
const playing = () => !!session?.el && !session.el.paused && !session.el.ended;

function audioHost() {
  if (!host || !host.isConnected) { host = h('div', { id: 'media-host', hidden: true }); document.body.append(host); }
  return host;
}

// ------------------------------------------------------------------ public entry points

/**
 * Play `path` on machine `nodeId` (or, without a path, show the player as it is). The same file again just raises the
 * window; another file replaces what plays. Returns the window handle.
 */
export function openMediaPlayer({ nodeId, nodeName = '', path, name, entries, startAt = 0, autoplay = true } = {}) {
  if (!path) { const p = ensureWindow(); paint(); p.w.raise(); return p.w; }
  const same = session && session.nodeId === nodeId && track()?.path === path;
  const p = ensureWindow();
  if (same) { paint(); p.w.raise(); return p.w; }
  const { list, index } = mediaSiblings(entries, path);
  if (name && list[index]) list[index].name = name;
  stopElement();
  session = { nodeId, nodeName, list, index, kind: null, el: null, watchdog: null, startAt };
  load(index, { autoplay });
  if (!entries) fillPlaylist(session);
  p.w.raise();
  return p.w;
}

/**
 * The file browser's inline preview of an audio or video file: a plain <audio>/<video> with the browser's controls, in
 * the one-at-a-time arbiter, and an Open in Player button that carries on from the same moment.
 */
export function mediaPreview({ nodeId, nodeName = '', path, name, entries }) {
  const kind = mediaKind(name || path);
  const el = h(kind, { class: kind === 'video' ? 'pv-img pv-video' : 'pv-audio', src: rawUrl(nodeId, path), controls: true, preload: 'metadata', playsinline: true });
  const note = h('div', { class: 'muted small pv-media-note', role: 'status' });
  el.addEventListener('play', () => arbiter.claim(el));
  el.addEventListener('error', () => {
    note.replaceChildren(errorMessage(el.error?.code ?? 4, { name: name || path, nodeName }), ' ',
      h('a', { href: rawUrl(nodeId, path, { download: true }), download: name || '' }, '⇩ Download'));
  });
  const open = h('button', { class: 'btn', title: 'Open in the media player, from this moment', onclick: () => { const at = el.currentTime || 0; const was = !el.paused; el.pause(); openMediaPlayer({ nodeId, nodeName, path, name, entries, startAt: at, autoplay: was || !at }); } }, '▶ Open in Player');
  return h('div', { class: 'pv-media' }, el, h('div', { class: 'actions' }, open), note);
}

// ------------------------------------------------------------------ loading and the media element

function makeElement(kind) {
  const el = h(kind, { preload: 'metadata', playsinline: true, class: kind === 'video' ? 'mp-video' : 'mp-audio' });
  el.volume = prefs.volume;
  el.muted = prefs.muted;
  const s = session;
  const mine = () => session === s && s.el === el;
  el.addEventListener('play', () => { if (mine()) { arbiter.claim(el); paint(); } });
  el.addEventListener('pause', () => { if (mine()) paint(); });
  el.addEventListener('playing', () => { if (mine()) { clearTimeout(s.watchdog); showError(null); } });
  el.addEventListener('loadedmetadata', () => {
    if (!mine()) return;
    clearTimeout(s.watchdog);
    showError(null);
    if (s.startAt > 0 && Number.isFinite(el.duration)) { el.currentTime = Math.min(s.startAt, el.duration); s.startAt = 0; }
    paint();
  });
  el.addEventListener('durationchange', () => { if (mine()) paintTime(); });
  el.addEventListener('timeupdate', () => { if (mine()) paintTime(); });
  el.addEventListener('volumechange', () => { if (mine()) { prefs.volume = el.volume; prefs.muted = el.muted; savePrefs(); paint(); } });
  el.addEventListener('ratechange', () => { if (mine()) { prefs.speed = el.playbackRate; savePrefs(); paint(); } });
  el.addEventListener('ended', () => { if (mine()) step(1, { auto: true }); });
  el.addEventListener('error', () => {
    if (!mine()) return;
    clearTimeout(s.watchdog);
    const msg = errorMessage(el.error?.code ?? 4, { name: track()?.name, nodeName: s.nodeName });
    if (player) showError(msg); else { toast(`${titleOf(track()?.name)}: ${msg}`, 'warn', 9000); paint(); }
  });
  return el;
}

/** Load track `i` of the session's playlist (a new element when audio and video swap) and play it unless told not to. */
function load(i, { autoplay = true } = {}) {
  const s = session;
  const t = s?.list[i];
  if (!t) return;
  s.index = i;
  if (s.el && s.kind !== t.kind) stopElement();
  if (!s.el) {
    s.kind = t.kind;
    s.el = makeElement(t.kind);
    if (t.kind === 'audio') audioHost().append(s.el);
  }
  placeVideo();
  showError(null);
  s.el.src = rawUrl(s.nodeId, t.path);
  s.el.playbackRate = prefs.speed;
  s.el.defaultPlaybackRate = prefs.speed;
  clearTimeout(s.watchdog);
  s.watchdog = setTimeout(() => { if (session === s && s.el && s.el.readyState === 0 && !s.el.error) showError(errorMessage(0, { name: t.name, nodeName: s.nodeName })); }, LOAD_WATCHDOG_MS);
  if (autoplay) play();
  mediaSession();
  if (player) player.w.setTitle(`${titleOf(t.name)}${s.nodeName ? ' — ' + s.nodeName : ''}`);
  paint();
}

/** The folder's media files when the opener did not pass its listing (desktop icons, ui_open, the dock). */
async function fillPlaylist(s) {
  try {
    const r = await api(`${node(s.nodeId)}/files?path=${encodeURIComponent(folderOf(track()?.path))}`);
    if (session !== s) return;
    const cur = track()?.path;
    const { list, index } = mediaSiblings(r.entries, cur);
    s.list = list;
    s.index = index;
    paint();
  } catch { /* a single-track playlist is fine */ }
}

function play() {
  const el = session?.el;
  if (!el) return;
  arbiter.claim(el);
  el.play()?.catch?.((e) => {
    if (e?.name === 'NotAllowedError') toast('Press ▶ to start playback (the browser blocked autoplay).', 'info');
  });
}

function toggle() { if (!session?.el) return; if (session.el.paused || session.el.ended) play(); else session.el.pause(); }

/**
 * Next/previous track; `auto` = the current one ended (the end of the list stops, and closes a background mini-player).
 * With the window closed only audio is stepped to: a video has nowhere to show.
 */
function step(d, { auto = false } = {}) {
  if (!session) return;
  const j = stepKind(session.list, session.index, d, player ? null : 'audio');
  if (j >= 0) { load(j, { autoplay: true }); return; }
  if (auto && !player) stopSession();
  else paint();
}

function seekBy(delta) { const el = session?.el; if (el) el.currentTime = seekTarget(el.currentTime, delta, el.duration); }
function seekTo(at) { const el = session?.el; const t = el && seekTarget(0, at, el.duration); if (Number.isFinite(t)) el.currentTime = t; }
function setVolume(v) { const el = session?.el; prefs.volume = clampVolume(v); if (el) { el.volume = prefs.volume; if (prefs.volume > 0) el.muted = false; } savePrefs(); paint(); }
function toggleMute() { const el = session?.el; prefs.muted = !prefs.muted; if (el) el.muted = prefs.muted; savePrefs(); paint(); }
function setSpeed(sp) { prefs.speed = sp; const el = session?.el; if (el) { el.playbackRate = sp; el.defaultPlaybackRate = sp; } savePrefs(); paint(); }

/** Stop and drop the media element (its download stops too). */
function stopElement() {
  const s = session;
  if (!s?.el) return;
  clearTimeout(s.watchdog);
  const el = s.el;
  s.el = null;
  s.kind = null;
  arbiter.release(el);
  if (document.pictureInPictureElement === el) document.exitPictureInPicture?.().catch(() => {});
  el.pause();
  el.removeAttribute('src');
  try { el.load(); } catch { /* detached */ }
  el.remove();
}

function stopSession() {
  stopElement();
  session = null;
  hideMini();
  mediaSession();
  paint();
}

// ------------------------------------------------------------------ the window

function ensureWindow() {
  if (player) return player;
  const ui = {};
  const w = openWindow({ title: 'Media player', icon: '▶', key: 'media-player', width: 780, height: 540, className: 'mp-win', onClose: onWindowClose });
  const btn = (cls, label, onclick, text) => h('button', { class: `tb mp-btn ${cls}`, title: label, 'aria-label': label, onclick }, text);
  ui.art = h('div', { class: 'mp-art', 'aria-hidden': 'true' }, h('div', { class: 'mp-note' }, '♪'), h('div', { class: 'mp-art-title' }), h('div', { class: 'mp-art-sub muted' }));
  ui.empty = h('div', { class: 'mp-empty' },
    h('div', { class: 'mp-note', 'aria-hidden': 'true' }, '▶'),
    h('p', {}, 'Nothing is playing. Open an audio or video file from any machine: double-click it in Files, or ask JARVIS to play it.'),
    h('button', { class: 'btn primary', onclick: () => deps.browse?.() }, '📁 Browse files…'));
  ui.error = h('div', { class: 'mp-error', role: 'alert', hidden: true });
  ui.stage = h('div', { class: 'mp-stage' }, ui.art, ui.empty, ui.error);
  ui.stage.addEventListener('click', (e) => { if (e.target === session?.el && session.kind === 'video') toggle(); });
  ui.stage.addEventListener('dblclick', (e) => { if (e.target === session?.el && session.kind === 'video') fullscreen(); });
  ui.seek = h('input', { type: 'range', class: 'mp-seek', min: '0', max: '0', step: 'any', value: '0', 'aria-label': 'Seek' });
  ui.seek.addEventListener('input', () => { ui.seeking = true; ui.time.textContent = `${formatTime(Number(ui.seek.value))} / ${formatTime(session?.el?.duration)}`; });
  ui.seek.addEventListener('change', () => { ui.seeking = false; if (session?.el) session.el.currentTime = Number(ui.seek.value); });
  ui.prev = btn('mp-prev', 'Previous (Shift+P)', () => step(-1), '⏮');
  ui.play = btn('mp-play', 'Play (Space)', toggle, '▶');
  ui.next = btn('mp-next', 'Next (Shift+N)', () => step(1), '⏭');
  ui.time = h('span', { class: 'mp-time', 'aria-live': 'off' }, '0:00 / --:--');
  ui.speed = btn('mp-speed', 'Playback speed (< >)', () => setSpeed(nextSpeed(prefs.speed)), '1×');
  ui.mute = btn('mp-mute', 'Mute (M)', toggleMute, '🔊');
  ui.vol = h('input', { type: 'range', class: 'mp-vol', min: '0', max: '1', step: '0.05', value: String(prefs.volume), 'aria-label': 'Volume' });
  ui.vol.addEventListener('input', () => setVolume(Number(ui.vol.value)));
  ui.pip = btn('mp-pip', 'Picture in picture (I)', pip, '⧉');
  ui.full = btn('mp-full', 'Full screen (F)', fullscreen, '⛶');
  ui.listBtn = btn('mp-list-btn', 'Playlist', () => { ui.root.classList.toggle('mp-list-off'); ui.listBtn.setAttribute('aria-pressed', String(!ui.root.classList.contains('mp-list-off'))); }, '☰');
  ui.listBtn.setAttribute('aria-pressed', 'true');
  ui.list = h('ol', { class: 'mp-list', 'aria-label': 'Playlist' });
  ui.controls = h('div', { class: 'mp-controls' },
    ui.prev, ui.play, ui.next, ui.time, h('span', { class: 'ft-grow' }), ui.speed, ui.mute, ui.vol, ui.pip, ui.full, ui.listBtn);
  ui.root = h('div', { class: 'mp' }, h('div', { class: 'mp-main' }, ui.stage, ui.seek, ui.controls), ui.list);
  w.body.append(ui.root);
  w.listen(w.el, 'keydown', onKey);
  w.listen(document, 'fullscreenchange', () => paint());
  player = { w, ui };
  hideMini();
  placeVideo();
  return player;
}

function onWindowClose() {
  const p = player;
  player = null;
  if (document.fullscreenElement && p?.ui.root.contains(document.fullscreenElement)) document.exitFullscreen?.().catch(() => {});
  if (!session) return;
  if (closeOutcome({ kind: session.kind, paused: !session.el || session.el.paused, ended: !!session.el?.ended }) === 'mini') showMini();
  else stopSession();
}

/** The video element goes into the open window's stage (audio stays in the hidden holder). */
function placeVideo() {
  if (!player || session?.kind !== 'video' || !session.el) return;
  if (session.el.parentNode !== player.ui.stage) player.ui.stage.prepend(session.el);
}

function onKey(e) {
  const t = e.target;
  if (t?.closest?.('select, textarea, input:not([type=range])')) return;
  if (t?.classList?.contains('mp-vol') && /^Arrow|^(Home|End|PageUp|PageDown)$/.test(e.key)) return; // the focused volume slider moves itself
  const a = keyAction(e, { kind: session?.kind || 'audio' });
  if (!a || !session?.el) return;
  e.preventDefault();
  e.stopPropagation();
  const el = session.el;
  switch (a.type) {
    case 'toggle': toggle(); break;
    case 'seek': seekBy(a.by); break;
    case 'seekTo': seekTo(a.at); break;
    case 'seekPct': if (Number.isFinite(el.duration)) el.currentTime = (el.duration * a.pct) / 100; break;
    case 'volume': setVolume((el.muted ? 0 : el.volume) + a.by); break;
    case 'mute': toggleMute(); break;
    case 'fullscreen': fullscreen(); break;
    case 'pip': pip(); break;
    case 'next': step(1); break;
    case 'prev': step(-1); break;
    case 'speed': setSpeed(stepSpeed(prefs.speed, a.dir)); break;
    default: break;
  }
}

const pipSupported = (v) => !!v && ((document.pictureInPictureEnabled && !v.disablePictureInPicture) || !!v.webkitSupportsPresentationMode?.('picture-in-picture'));
const canFullscreen = () => !!(document.fullscreenEnabled || session?.el?.webkitEnterFullscreen);

function pip() {
  const v = session?.kind === 'video' ? session.el : null;
  if (!pipSupported(v)) return;
  if (document.pictureInPictureEnabled && v.requestPictureInPicture) {
    (document.pictureInPictureElement === v ? document.exitPictureInPicture() : v.requestPictureInPicture()).catch((e) => toast(`Picture in picture: ${e.message}`, 'warn'));
  } else v.webkitSetPresentationMode(v.webkitPresentationMode === 'picture-in-picture' ? 'inline' : 'picture-in-picture');
}

function fullscreen() {
  if (!player || session?.kind !== 'video') return;
  const root = player.ui.root;
  if (document.fullscreenElement) { document.exitFullscreen?.().catch(() => {}); return; }
  if (root.requestFullscreen && document.fullscreenEnabled) root.requestFullscreen().catch(() => session?.el?.webkitEnterFullscreen?.());
  else session?.el?.webkitEnterFullscreen?.(); // iPhone: only the video element itself goes full screen
}

function showError(msg) {
  if (!player) return;
  const box = player.ui.error;
  if (!msg) { box.hidden = true; box.replaceChildren(); return; }
  const t = track();
  box.replaceChildren(h('div', { class: 'mp-error-icon', 'aria-hidden': 'true' }, '⚠'), h('p', {}, msg),
    h('div', { class: 'actions' },
      t && h('a', { class: 'btn primary', href: rawUrl(session.nodeId, t.path, { download: true }), download: t.name }, '⇩ Download'),
      h('button', { class: 'btn', onclick: () => load(session.index, { autoplay: true }) }, '↻ Try again')));
  box.hidden = false;
}

// ------------------------------------------------------------------ painting

function paintTime() {
  const el = session?.el;
  if (player) {
    const { ui } = player;
    const dur = el?.duration;
    if (!ui.seeking) {
      ui.seek.max = String(Number.isFinite(dur) ? dur : 0);
      ui.seek.value = String(el?.currentTime || 0);
      ui.time.textContent = `${formatTime(el?.currentTime || 0)} / ${formatTime(dur)}`;
    }
    ui.seek.setAttribute('aria-valuetext', `${formatTime(el?.currentTime || 0)} of ${formatTime(dur)}`);
  }
  paintMiniProgress();
}

function paint() {
  paintMini();
  if (!player) return;
  const { ui } = player;
  const t = track();
  const el = session?.el;
  const video = session?.kind === 'video';
  ui.root.classList.toggle('mp-video-mode', video);
  ui.root.classList.toggle('mp-idle', !t);
  ui.empty.hidden = !!t;
  ui.art.hidden = !t || video;
  if (t) {
    ui.art.querySelector('.mp-art-title').textContent = titleOf(t.name);
    ui.art.querySelector('.mp-art-sub').textContent = `${session.nodeName || 'this machine'} · ${folderOf(t.path)}`;
  }
  const on = playing();
  ui.play.textContent = on ? '❚❚' : '▶';
  ui.play.title = on ? 'Pause (Space)' : 'Play (Space)';
  ui.play.setAttribute('aria-label', ui.play.title);
  for (const b of [ui.play, ui.seek, ui.speed, ui.mute, ui.vol]) b.disabled = !el;
  ui.prev.disabled = !session || session.index <= 0;
  ui.next.disabled = !session || session.index >= session.list.length - 1;
  ui.speed.textContent = speedLabel(prefs.speed);
  const muted = prefs.muted || prefs.volume === 0;
  ui.mute.textContent = muted ? '🔇' : prefs.volume < 0.5 ? '🔉' : '🔊';
  ui.mute.setAttribute('aria-pressed', String(muted));
  ui.mute.title = muted ? 'Unmute (M)' : 'Mute (M)';
  ui.mute.setAttribute('aria-label', ui.mute.title);
  ui.vol.value = String(prefs.muted ? 0 : prefs.volume);
  ui.pip.hidden = !video || !pipSupported(el);
  ui.full.hidden = !video || !canFullscreen();
  ui.full.setAttribute('aria-pressed', String(!!document.fullscreenElement));
  const items = session?.list || [];
  ui.list.hidden = items.length < 2;
  ui.listBtn.hidden = items.length < 2;
  ui.list.replaceChildren(...items.map((x, i) => h('li', {},
    h('button', { class: `mp-item${i === session.index ? ' cur' : ''}`, ...(i === session.index ? { 'aria-current': 'true' } : {}), title: x.path, onclick: () => load(i, { autoplay: true }) },
      h('span', { class: 'mp-item-ico', 'aria-hidden': 'true' }, i === session.index && on ? '♪' : x.kind === 'video' ? '🎬' : '🎵'),
      h('span', { class: 'mp-item-name' }, x.name)))));
  paintTime();
}

// ------------------------------------------------------------------ the mini-player (menu bar tray)

const miniEls = new Set();
let unregisterMini = null;
let phoneBar = null; // phones: a now-playing strip above the toolbar (the phone header's tray has no room for it)

/** The mini-player's controls: title (reopens the player), play/pause, next (audio only), stop and close. */
function miniElement(cls) {
  const el = h('div', { class: cls, role: 'group', 'aria-label': 'Now playing' },
    h('button', { class: 'tray-media-title', title: 'Open the player', onclick: () => openMediaPlayer() }, h('span', { class: 'tray-media-note', 'aria-hidden': 'true' }, '♪'), h('span', { class: 'tray-media-name' })),
    h('button', { class: 'tray-btn tray-media-play', onclick: toggle }),
    h('button', { class: 'tray-btn tray-media-next', title: 'Next', 'aria-label': 'Next', onclick: () => step(1) }, '⏭'),
    h('button', { class: 'tray-btn tray-media-close', title: 'Stop and close', 'aria-label': 'Stop and close', onclick: stopSession }, '✕'),
    h('i', { class: 'tray-media-bar', 'aria-hidden': 'true' }));
  miniEls.add(el);
  paintMiniEl(el);
  return el;
}

function showMini() {
  if (!unregisterMini) {
    unregisterMini = registerTrayItem({ id: 'media', order: 5, label: 'Now playing', render: () => miniElement('tray-item tray-media'), update: paintMiniEl });
  }
  if (!phoneBar) { phoneBar = miniElement('mp-mini-phone'); document.body.append(phoneBar); document.body.classList.add('mp-mini-on'); }
  paintMini();
}

function hideMini() {
  unregisterMini?.();
  unregisterMini = null;
  phoneBar?.remove();
  phoneBar = null;
  document.body.classList.remove('mp-mini-on');
  miniEls.clear();
}

function paintMiniEl(el) {
  const t = track();
  if (!t) return;
  const on = playing();
  el.querySelector('.tray-media-name').textContent = titleOf(t.name);
  const title = el.querySelector('.tray-media-title');
  title.setAttribute('aria-label', `Now playing: ${titleOf(t.name)} — open the player`);
  const p = el.querySelector('.tray-media-play');
  p.textContent = on ? '❚❚' : '▶';
  p.title = on ? 'Pause' : 'Play';
  p.setAttribute('aria-label', p.title);
  el.querySelector('.tray-media-next').disabled = !session || stepKind(session.list, session.index, 1, 'audio') < 0;
  paintMiniProgress();
}

function paintMini() {
  for (const el of miniEls) { if (!el.isConnected) miniEls.delete(el); else paintMiniEl(el); }
}

function paintMiniProgress() {
  if (!miniEls.size) return;
  const el = session?.el;
  const pct = el && Number.isFinite(el.duration) && el.duration > 0 ? (el.currentTime / el.duration) * 100 : 0;
  for (const m of miniEls) m.querySelector('.tray-media-bar').style.width = pct.toFixed(1) + '%';
}

// ------------------------------------------------------------------ OS media keys (Media Session API)

function mediaSession() {
  const ms = navigator.mediaSession;
  if (!ms) return;
  const t = track();
  try {
    ms.metadata = t && window.MediaMetadata ? new window.MediaMetadata(sessionMeta(t, session.nodeName)) : null;
    const set = (a, fn) => { try { ms.setActionHandler(a, t ? fn : null); } catch { /* not supported here */ } };
    set('play', play);
    set('pause', () => session?.el?.pause());
    set('previoustrack', () => step(-1));
    set('nexttrack', () => step(1));
    set('seekbackward', (d) => seekBy(-(d?.seekOffset || 10)));
    set('seekforward', (d) => seekBy(d?.seekOffset || 10));
    set('seekto', (d) => { if (session?.el && Number.isFinite(d?.seekTime)) session.el.currentTime = d.seekTime; });
    set('stop', stopSession);
  } catch { /* an old browser */ }
}
