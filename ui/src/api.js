import { COALESCE_MS, MAX_VISIBLE, resumeAfter, toastDuration } from './toasts.js';
// Thin client for the gateway node this page was loaded from. Every machine is reachable as
// /api/nodes/<id>/… — the gateway proxies to peers over Tailscale.

export async function api(path, { method = 'GET', body, raw = false, signal } = {}) {
  const r = await fetch(path, {
    method, signal,
    headers: body !== undefined && !(body instanceof Blob) && !(body instanceof File) ? { 'content-type': 'application/json' } : {},
    body: body === undefined ? undefined : body instanceof Blob || body instanceof File ? body : JSON.stringify(body),
  });
  if (raw) return r;
  const text = await r.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  if (!r.ok) throw new Error((data && data.error) || `HTTP ${r.status}`);
  return data;
}

export const node = (id) => `/api/nodes/${encodeURIComponent(id || 'self')}`;

/** POST that streams NDJSON events. */
export async function stream(path, body, onEvent, signal) {
  const r = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal });
  if (!r.ok) {
    let msg = `HTTP ${r.status}`;
    try { msg = (await r.json()).error || msg; } catch {}
    throw new Error(msg);
  }
  const reader = r.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      try { onEvent(JSON.parse(line)); } catch {}
    }
  }
}

export function wsUrl(path) {
  return (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + path;
}

export function fmtBytes(n) {
  if (!n && n !== 0) return '';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n < 10 && i ? n.toFixed(1) : Math.round(n)} ${u[i]}`;
}

export function ago(ts) {
  if (!ts) return '';
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'html') el.innerHTML = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c != null && c !== false) el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return el;
}

/**
 * A small notification, top-right: closes itself (level default 4–8 s, clamped 3–30 s; 20 s with a button),
 * has a × to close it now, pauses while hovered or focused, and at most four stay on screen.
 */
export function toast(text, level = 'info', ms, action = null) {
  let box = document.getElementById('toasts');
  if (!box) { box = h('div', { id: 'toasts', role: 'status', 'aria-live': 'polite' }); document.body.append(box); }
  const shown = [...box.querySelectorAll(':scope > .toast:not(.out)')];
  // The same message again within 2 s refreshes the one on screen instead of stacking a copy.
  const same = shown.at(-1);
  if (same && same.dataset.text === String(text) && Date.now() - Number(same.dataset.at) < COALESCE_MS) { same._restart?.(); return same; }
  const total = toastDuration(level, ms, !!action);
  let timer = null;
  let left = total;
  let startedAt = 0;
  const close = () => {
    clearTimeout(timer);
    if (t.classList.contains('out')) return;
    t.classList.add('out');
    setTimeout(() => t.remove(), 300);
  };
  const start = (d) => { clearTimeout(timer); left = d; startedAt = Date.now(); timer = setTimeout(close, d); };
  const pause = () => { if (!timer) return; clearTimeout(timer); timer = null; left -= Date.now() - startedAt; };
  const resume = () => { if (!timer && !t.classList.contains('out') && !t.matches(':hover, :focus-within')) start(resumeAfter(left)); };
  const t = h('div', { class: `toast ${level}`, 'data-text': String(text), 'data-at': String(Date.now()) },
    h('span', { class: 'toast-text' }, text),
    action ? h('button', { class: 'btn primary toast-btn', onclick: () => { close(); action.run(); } }, action.label) : null,
    h('button', { class: 'toast-x', title: 'Close', 'aria-label': 'Close notification', onclick: close }, '×'));
  t._restart = () => { t.dataset.at = String(Date.now()); start(total); };
  if (window.matchMedia?.('(hover: hover)').matches) {
    t.addEventListener('mouseenter', pause);
    t.addEventListener('mouseleave', resume);
  }
  t.addEventListener('focusin', pause);
  t.addEventListener('focusout', () => setTimeout(resume, 0));
  box.append(t);
  for (const old of shown.slice(0, Math.max(0, shown.length + 1 - MAX_VISIBLE))) old._close ? old._close() : old.remove();
  t._close = close;
  start(total);
  return t;
}
