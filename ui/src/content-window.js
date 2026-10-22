// A generic content window on the window manager (wm.js): any page in a sandboxed iframe (`url`), a document given
// as text (`html`, srcdoc) or a ready element (`el`). ui_open's `url` view, the rendered-HTML file tool and anything
// that has a result to show use it. Looks like an App Cloud window (app-win: no padding, white stage) with ↻ reload
// and ↗ open-in-tab tools. What the frame may do is decided in content-window-model.js (allow-same-origin only for a
// same-origin /api path that is not a raw file).
import { h } from './api.js';
import { openWindow } from './wm.js';
import { contentKey, frameKind, sandboxFor, tabTarget, titleFor } from './content-window-model.js';

const open = new Map(); // key → window: the same page again raises it

/**
 * openContentWindow({ title, icon, url | html | el, width, height, key, focus }) → the wm.js window handle plus
 * { frame } (the iframe, when there is one) and `setUrl(url)` / `setHtml(html)` to show something else in it.
 */
export function openContentWindow({ title, icon = '🌐', url = '', html = '', el = null, width = 960, height = 680, key, focus = false, className = '' } = {}) {
  const kind = frameKind({ url, html, el });
  if (!kind) throw new Error('openContentWindow needs url, html or el');
  const k = contentKey({ key, url, title });
  const prev = k ? open.get(k) : null;
  if (prev && !prev.closed) { prev.raise(); if (kind === 'url' && prev.frame && prev.url !== url) prev.setUrl(url); return prev; }
  const name = titleFor({ title, url });
  let frame = null;
  let blobUrl = '';
  const stage = h('div', { class: 'app-stage content-stage' });
  const tools = [];
  const tabUrl = () => tabTarget({ url: frame?.dataset.url || url }) || blobUrl;
  if (kind !== 'el') {
    frame = h('iframe', { class: 'app-frame content-frame', title: name, sandbox: sandboxFor({ url, html }), allow: 'fullscreen; clipboard-write', referrerpolicy: 'no-referrer' });
    tools.push(
      h('button', { class: 'win-btn', title: 'Reload', onclick: () => reload() }, '↻'),
      h('button', { class: 'win-btn', title: 'Open in a browser tab', onclick: () => { const u = tabUrl(); if (u) window.open(u, '_blank', 'noopener'); } }, '↗'),
    );
    stage.append(frame);
  } else stage.append(el);
  const w = openWindow({
    title: name, icon, width, height, className: `app-win content-win${className ? ' ' + className : ''}`, key: k, focus, tools,
    onClose: () => { if (k && open.get(k) === w) open.delete(k); if (blobUrl) URL.revokeObjectURL(blobUrl); },
  });
  w.body.append(stage);
  w.frame = frame;
  w.url = url;
  const setUrl = (u) => { if (!frame) return; w.url = u; frame.dataset.url = u; frame.setAttribute('sandbox', sandboxFor({ url: u })); frame.src = u; };
  const setHtml = (text) => {
    if (!frame) return;
    w.url = '';
    delete frame.dataset.url;
    frame.setAttribute('sandbox', sandboxFor({ html: text }));
    frame.srcdoc = text;
    if (blobUrl) URL.revokeObjectURL(blobUrl);
    try { blobUrl = URL.createObjectURL(new Blob([text], { type: 'text/html' })); } catch { blobUrl = ''; } // ↗ opens the same document in a tab
  };
  function reload() {
    if (!frame) return;
    if (frame.dataset.url) { const u = frame.dataset.url; frame.src = 'about:blank'; requestAnimationFrame(() => { frame.src = u; }); } else if (frame.srcdoc) { const d = frame.srcdoc; frame.srcdoc = ''; requestAnimationFrame(() => { frame.srcdoc = d; }); }
  }
  w.setUrl = setUrl;
  w.setHtml = setHtml;
  w.reload = reload;
  if (kind === 'url') setUrl(url); else if (kind === 'html') setHtml(html);
  if (k) open.set(k, w);
  w.onCleanup(() => { w.closed = true; });
  return w;
}
