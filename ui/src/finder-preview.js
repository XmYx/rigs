// The file browser's preview pane and Quick Look (Space): image, code, Markdown, PDF, audio and video viewers with a
// JARVIS-styled transport. Which viewer a file gets and the maths live in preview-model.js. Media streams straight from
// files/raw (local or /api/nodes/<id>/files/raw), which answers HTTP Range requests, so a seek fetches only the part
// that is wanted. Playback stops when the selection changes, Quick Look closes or the window closes (the cleanups).
import { api, fmtBytes, h, node } from './api.js';
import { iconOf, kindOf } from './finder-model.js';
import { nativeCtx } from './ctx-tag.js';
import {
  TEXT_SHOWN, fmtTime, highlight, langOf, parseInline, parseMarkdown, progressOf, quickLookSet, quickLookStep, seekTime, skipTime, viewerFor,
} from './preview-model.js';

const stopMedia = (root) => {
  for (const m of root.querySelectorAll('video,audio')) { try { m.pause(); m.removeAttribute('src'); m.load?.(); } catch { /* element already gone */ } }
};

// ------------------------------------------------------------------ transport

/** A custom play/pause · scrub · time · volume (· fullscreen) bar for an <audio> or <video> element. */
function transport(media, { fullscreenTarget } = {}) {
  const play = h('button', { type: 'button', class: 'tp-btn tp-play', 'aria-label': 'Play' }, '▶');
  const cur = h('span', { class: 'tp-time' }, '0:00');
  const dur = h('span', { class: 'tp-time' }, '--:--');
  const fill = h('div', { class: 'tp-fill' });
  const buf = h('div', { class: 'tp-buf' });
  const scrub = h('div', { class: 'tp-scrub', role: 'slider', tabindex: '0', 'aria-label': 'Seek', 'aria-valuemin': '0', 'aria-valuenow': '0' }, buf, fill);
  const vol = h('input', { type: 'range', class: 'tp-vol', min: '0', max: '1', step: '0.05', value: '1', 'aria-label': 'Volume' });
  const mute = h('button', { type: 'button', class: 'tp-btn', 'aria-label': 'Mute' }, '🔊');
  const fs = fullscreenTarget ? h('button', { type: 'button', class: 'tp-btn', 'aria-label': 'Fullscreen' }, '⛶') : null;
  const bar = h('div', { class: 'tp' }, play, cur, scrub, dur, mute, vol, fs);

  const sync = () => {
    const d = media.duration;
    fill.style.width = `${progressOf(media.currentTime, d) * 100}%`;
    cur.textContent = fmtTime(media.currentTime);
    dur.textContent = fmtTime(d);
    scrub.setAttribute('aria-valuenow', String(Math.round(media.currentTime || 0)));
    scrub.setAttribute('aria-valuemax', String(Math.round(Number.isFinite(d) ? d : 0)));
    const b = media.buffered;
    buf.style.width = Number.isFinite(d) && d > 0 && b.length ? `${progressOf(b.end(b.length - 1), d) * 100}%` : '0%';
  };
  const paint = () => {
    const on = !media.paused && !media.ended;
    play.textContent = on ? '⏸' : '▶';
    play.setAttribute('aria-label', on ? 'Pause' : 'Play');
  };
  const volIcon = () => { mute.textContent = media.muted || media.volume === 0 ? '🔇' : '🔊'; };
  const toggle = () => { if (media.paused) media.play?.().catch(() => {}); else media.pause(); };
  play.addEventListener('click', toggle);
  for (const ev of ['timeupdate', 'durationchange', 'loadedmetadata', 'progress', 'seeked']) media.addEventListener(ev, sync);
  for (const ev of ['play', 'pause', 'ended']) media.addEventListener(ev, paint);
  media.addEventListener('volumechange', volIcon);
  vol.addEventListener('input', () => { media.muted = false; media.volume = Number(vol.value); });
  mute.addEventListener('click', () => { media.muted = !media.muted; });
  fs?.addEventListener('click', () => { const t = fullscreenTarget; if (document.fullscreenElement) document.exitFullscreen?.(); else (t.requestFullscreen || t.webkitRequestFullscreen)?.call(t); });

  const seekTo = (clientX) => {
    const r = scrub.getBoundingClientRect();
    media.currentTime = seekTime((clientX - r.left) / (r.width || 1), media.duration);
  };
  scrub.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    scrub.setPointerCapture?.(e.pointerId);
    seekTo(e.clientX);
    const move = (ev) => seekTo(ev.clientX);
    const up = () => { scrub.removeEventListener('pointermove', move); scrub.removeEventListener('pointerup', up); scrub.removeEventListener('pointercancel', up); };
    scrub.addEventListener('pointermove', move);
    scrub.addEventListener('pointerup', up);
    scrub.addEventListener('pointercancel', up);
  });
  scrub.addEventListener('keydown', (e) => {
    const d = e.key === 'ArrowLeft' ? -5 : e.key === 'ArrowRight' ? 5 : 0;
    if (!d) return;
    e.preventDefault();
    e.stopPropagation(); // the arrows belong to the scrubber here, not to the file list or Quick Look
    media.currentTime = skipTime(media.currentTime, d, media.duration);
  });
  paint(); volIcon(); sync();
  bar.toggle = toggle;
  return bar;
}

// ------------------------------------------------------------------ viewers

const info = (e, { rigName, sep = '/', dims } = {}) => h('dl', { class: 'fd-info' },
  h('dt', {}, 'Kind'), h('dd', {}, kindOf(e)),
  e.type === 'dir' ? null : [h('dt', {}, 'Size'), h('dd', {}, fmtBytes(e.size))],
  dims ? [h('dt', {}, 'Dimensions'), h('dd', {}, dims)] : null,
  e.birthtime ? [h('dt', {}, 'Created'), h('dd', {}, new Date(e.birthtime).toLocaleString())] : null,
  h('dt', {}, 'Modified'), h('dd', {}, e.mtime ? new Date(e.mtime).toLocaleString() : '--'),
  h('dt', {}, 'Where'), h('dd', {}, `${rigName ? `${rigName}: ` : ''}${e.path}`));

function renderInline(src) {
  return parseInline(src).map((r) => {
    if (r.t === 'code') return h('code', {}, r.s);
    if (r.t === 'strong') return h('strong', {}, r.s);
    if (r.t === 'em') return h('em', {}, r.s);
    if (r.t === 'del') return h('del', {}, r.s);
    if (r.t === 'link') return r.href ? h('a', { href: r.href, target: '_blank', rel: 'noopener noreferrer' }, r.s) : r.s;
    if (r.t === 'image') return r.href ? h('img', { src: r.href, alt: r.s, class: 'md-img' }) : r.s;
    return r.s;
  });
}

function renderMarkdown(src) {
  const root = h('div', { class: 'pv-md' });
  for (const b of parseMarkdown(src)) {
    if (b.type === 'h') root.append(h(`h${b.level}`, {}, ...renderInline(b.text)));
    else if (b.type === 'p') root.append(h('p', {}, ...renderInline(b.text)));
    else if (b.type === 'hr') root.append(h('hr'));
    else if (b.type === 'quote') root.append(h('blockquote', {}, ...renderInline(b.text)));
    else if (b.type === 'code') root.append(codeBlock(b.text, b.lang ? langOf(`x.${b.lang}`) : 'plain'));
    else if (b.type === 'ul' || b.type === 'ol') root.append(h(b.type, {}, ...b.items.map((t) => h('li', {}, ...renderInline(t)))));
    else if (b.type === 'table') {
      root.append(h('table', {}, h('thead', {}, h('tr', {}, ...b.head.map((c) => h('th', {}, ...renderInline(c))))),
        h('tbody', {}, ...b.rows.map((r) => h('tr', {}, ...r.map((c) => h('td', {}, ...renderInline(c))))))));
    }
  }
  return root;
}

function codeBlock(text, lang) {
  const pre = h('pre', { class: 'pv-text pv-code' });
  for (const r of highlight(text, lang)) pre.append(r.t ? h('span', { class: `tk-${r.t}` }, r.s) : r.s);
  return nativeCtx(pre); // file text: the browser's menu (copy, search)
}

/** Draw `e` in `el` (the pane, or Quick Look's stage). Returns a cleanup. `big` = Quick Look's larger layout. */
function drawViewer(el, e, ctx, { big = false } = {}) {
  const kind = viewerFor(e);
  const url = ctx.rawUrl(e.path);
  let alive = true;
  const fail = (msg) => h('div', { class: 'muted pad pv-fail' }, msg);
  const cls = big ? ' big' : '';

  if (kind === 'image') {
    const cap = h('div', { class: 'pv-cap muted' }, 'Loading…');
    const img = h('img', { class: `pv-img${cls}`, src: url, alt: e.name });
    const dims = () => { cap.textContent = `${img.naturalWidth} × ${img.naturalHeight} px`; };
    img.addEventListener('load', dims);
    if (img.complete && img.naturalWidth) dims(); // already decoded (cached)
    img.addEventListener('error', () => { cap.textContent = 'Could not load this image'; });
    el.append(h('div', { class: `pv-stage${cls}` }, img), cap);
  } else if (kind === 'video' || kind === 'audio') {
    const media = h(kind, { class: `pv-media pv-${kind}${cls}`, preload: 'metadata', playsinline: '', 'aria-label': e.name });
    const wrap = h('div', { class: `pv-player pv-${kind}-wrap${cls}` });
    const note = h('div', { class: 'pv-cap muted' });
    media.addEventListener('error', () => { note.textContent = `This browser can't play ${kind === 'video' ? 'this video' : 'this audio'} (${kindOf(e)}). Download it to open it elsewhere.`; });
    let bar;
    if (kind === 'video') {
      media.src = `${url}${url.includes('#') ? '' : '#t=0.1'}`; // #t=0.1 shows the first frame as the poster without playing
      media.addEventListener('click', () => bar.toggle());
      media.addEventListener('dblclick', () => (document.fullscreenElement ? document.exitFullscreen?.() : wrap.requestFullscreen?.()));
      bar = transport(media, { fullscreenTarget: wrap });
      wrap.append(media, bar);
    } else {
      media.src = url;
      bar = transport(media);
      wrap.append(media, h('div', { class: 'pv-art', 'aria-hidden': 'true' }, iconOf(e)), h('div', { class: 'pv-track' }, e.name), bar);
    }
    el.append(wrap, note);
  } else if (kind === 'pdf') {
    el.append(h('iframe', { class: `pv-frame${cls}`, src: url, title: e.name }));
  } else if (kind === 'text' || kind === 'markdown') {
    const holder = h('div', { class: 'pv-doc' }, h('div', { class: 'pv-cap muted' }, 'Loading…'));
    el.append(holder);
    api(`${node(ctx.nodeId)}/files/read?path=${encodeURIComponent(e.path)}`)
      .then((r) => {
        if (!alive) return;
        const text = r.text.slice(0, TEXT_SHOWN);
        holder.replaceChildren(
          kind === 'markdown' ? nativeCtx(renderMarkdown(text)) : codeBlock(text, langOf(e.name)),
          r.truncated || r.text.length > TEXT_SHOWN ? h('div', { class: 'pv-cap muted' }, `Showing the first ${fmtBytes(Math.min(TEXT_SHOWN, r.text.length))} of ${fmtBytes(e.size)}`) : null);
      })
      .catch((err) => { if (alive) holder.replaceChildren(fail(err.message)); });
  } else {
    el.append(h('div', { class: `pv-info${cls}` }, h('div', { class: 'fd-pv-big', 'aria-hidden': 'true' }, iconOf(e)), h('div', { class: 'pv-title' }, e.name),
      big ? info(e, { rigName: ctx.nodeName, sep: ctx.sep }) : null));
  }
  return () => { alive = false; stopMedia(el); };
}

// ------------------------------------------------------------------ pane

/** The pane's renderer (setPreviewRenderer): files get a viewer under the browser's own title, info and actions. */
export function renderPreview(el, ctx) {
  const { entry } = ctx;
  if (!entry || entry.type === 'dir') return ctx.defaultPreview(el);
  const head = h('div', { class: 'pv-head' });
  const body = h('div', { class: 'pv-body' });
  el.append(head, body);
  ctx.header(head, entry);
  const stop = drawViewer(body, entry, ctx);
  if (viewerFor(entry) !== 'info') {
    head.append(h('div', { class: 'actions' }, h('button', { type: 'button', class: 'btn', onclick: () => quickLook(ctx) }, '👁 Quick Look (Space)')));
  }
  return stop;
}

// ------------------------------------------------------------------ Quick Look

let open = null; // the one Quick Look overlay at a time

export function closeQuickLook() { open?.close(); }

/**
 * Space: a large overlay for the selected file. ← → ↑ ↓ step through the selection (or the folder, from a single
 * selection), Esc or Space or a click outside closes it. `ctx` is the pane's context (files.js): ctx.siblings are the
 * files the list shows, ctx.entries the selection, ctx.actions.select(path) moves the list's selection along.
 */
export function quickLook(ctx) {
  closeQuickLook();
  const set = quickLookSet(ctx.entries, ctx.siblings || [], ctx.entry);
  if (!set) return;
  let { list, index } = set;
  const prev = document.activeElement;
  const title = h('div', { class: 'ql-title' });
  const count = h('div', { class: 'ql-count muted' });
  const closeBtn = h('button', { type: 'button', class: 'ql-x', 'aria-label': 'Close Quick Look', onclick: () => close() }, '✕');
  const openBtn = h('button', { type: 'button', class: 'btn', onclick: () => { const e = list[index]; close(); ctx.actions.open?.(e); } }, 'Open');
  const stage = h('div', { class: 'ql-stage' });
  const side = h('div', { class: 'ql-side' });
  const box = h('div', { class: 'ql', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Quick Look', tabindex: '-1' },
    h('div', { class: 'ql-bar' }, title, count, openBtn, closeBtn), h('div', { class: 'ql-body' }, stage, side));
  const scrim = h('div', { class: 'ql-scrim' }, box);
  let stop = null;
  let closed = false;

  function show() {
    stop?.();
    stage.replaceChildren();
    side.replaceChildren();
    const e = list[index];
    title.textContent = `${iconOf(e)} ${e.name}`;
    count.textContent = list.length > 1 ? `${index + 1} of ${list.length}` : '';
    const c = { ...ctx, entry: e };
    stop = drawViewer(stage, e, c, { big: true });
    if (viewerFor(e) !== 'info') side.append(info(e, { rigName: ctx.nodeName, sep: ctx.sep }));
    ctx.actions.select?.(e.path, { quiet: true });
  }
  function go(key) { index = quickLookStep(index, list.length, key); show(); }
  function close() {
    if (closed) return;
    closed = true;
    stop?.();
    document.removeEventListener('keydown', onKey, true);
    scrim.remove();
    open = null;
    try { prev?.focus?.(); } catch { /* the previous element is gone */ }
  }
  function onKey(ev) {
    if (ev.target?.closest?.('.ql-stage input, .ql-stage .tp-scrub') && ['ArrowLeft', 'ArrowRight', ' '].includes(ev.key)) return; // the transport's own keys
    if (ev.key === 'Escape' || (ev.key === ' ' && !ev.target?.closest?.('button'))) { ev.preventDefault(); ev.stopPropagation(); close(); return; }
    if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(ev.key) && !ev.target?.closest?.('input')) { ev.preventDefault(); ev.stopPropagation(); go(ev.key); }
  }
  scrim.addEventListener('pointerdown', (ev) => { if (ev.target === scrim) close(); });
  // Anything playing in the pane stops while the larger player is up.
  for (const m of document.querySelectorAll('.fd-preview video, .fd-preview audio')) { try { m.pause(); } catch { /* gone */ } }
  document.addEventListener('keydown', onKey, true);
  document.body.append(scrim);
  open = { close };
  show();
  box.focus();
}
