import { h } from './api.js';

// Visual replies: the brain can put a fenced ```visual block (JSON) in its written part and JARVIS draws it
// as an animated card instead of plain text. Kinds: weather, code, metrics, steps, status, bars.
// Unknown or malformed blocks fall back to showing their text, so a bad block never hides an answer.

const FENCE = /```visual[ \t]*\n([\s\S]*?)\n```/g;

/** JSON object from a block, tolerating raw line breaks inside string values (models often emit them). */
export function parseSpec(src) {
  for (const candidate of [src, src.replace(/"(?:[^"\\]|\\[\s\S])*"/g, (q) => q.replace(/\n/g, '\\n'))]) {
    try { const v = JSON.parse(candidate); if (v && typeof v === 'object') return v; } catch { /* next */ }
  }
  return null;
}

/** Split text into [{ text }|{ visual }] segments, in order. Pure. */
export function splitVisuals(text) {
  const out = [];
  let last = 0;
  for (const m of text.matchAll(FENCE)) {
    if (m.index > last) out.push({ text: text.slice(last, m.index) });
    const spec = parseSpec(m[1]);
    out.push(spec && typeof spec === 'object' ? { visual: spec } : { text: m[0] });
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push({ text: text.slice(last) });
  return out;
}

const ICON = { clear: '☀', sun: '☀', cloud: '☁', clouds: '☁', rain: '🌧', drizzle: '🌦', storm: '⛈', thunder: '⛈', snow: '❄', fog: '🌫', wind: '💨', night: '☾' };

const SVG = (w, h2, ...kids) => { const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); s.setAttribute('viewBox', `0 0 ${w} ${h2}`); s.classList.add('vz-svg'); kids.forEach((k) => s.append(k)); return s; };
const el = (tag, attrs = {}) => { const e = document.createElementNS('http://www.w3.org/2000/svg', tag); for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v); return e; };

function countUp(node, to, { decimals = 0, suffix = '', ms = 900 } = {}) {
  const t0 = performance.now();
  const step = (now) => {
    const k = Math.min(1, (now - t0) / ms);
    const eased = 1 - Math.pow(1 - k, 3);
    node.textContent = (to * eased).toFixed(decimals) + suffix;
    if (k < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

function weather(s) {
  const key = String(s.condition || '').toLowerCase();
  const icon = Object.entries(ICON).find(([k]) => key.includes(k))?.[1] || '◌';
  const temp = h('div', { class: 'vz-temp' }, '0°');
  countUp(temp, Number(s.temp ?? 0), { decimals: 0, suffix: s.unit || '°' });
  const cloud = SVG(120, 60, el('ellipse', { cx: 60, cy: 36, rx: 40, ry: 16, class: 'vz-cloud' }));
  cloud.classList.add('vz-deco');
  return h('div', { class: `vz-card vz-weather ${key.includes('rain') || key.includes('storm') ? 'wet' : ''}` },
    h('div', { class: 'vz-hero' }, h('span', { class: 'vz-icon' }, icon), temp),
    h('div', { class: 'vz-meta' }, h('b', {}, s.place || ''), h('span', {}, s.condition || ''), s.detail ? h('span', { class: 'muted' }, s.detail) : ''),
    s.forecast?.length ? h('div', { class: 'vz-days' }, ...s.forecast.slice(0, 7).map((d, i) => h('div', { class: 'vz-day', style: { animationDelay: `${i * 90}ms` } }, h('small', {}, d.day), h('span', {}, icon2(d.condition)), h('b', {}, `${d.high ?? ''}°`), h('i', {}, `${d.low ?? ''}°`)))) : '',
    cloud);
}
const icon2 = (c) => Object.entries(ICON).find(([k]) => String(c || '').toLowerCase().includes(k))?.[1] || '◌';

function code(s) {
  const lines = String(s.code || '').split('\n');
  const body = h('pre', { class: 'vz-code' });
  const cap = h('div', { class: 'vz-cap' }, h('span', {}, s.file || s.language || 'code'), s.language && s.file ? h('i', {}, s.language) : '');
  let i = 0;
  const type = () => { if (i < lines.length) { body.append(h('div', { class: `vz-line ${markLine(lines[i])}` }, lines[i] || ' ')); i++; setTimeout(type, 35); } };
  setTimeout(type, 120);
  return h('div', { class: 'vz-card vz-codecard' }, cap, body);
}
const markLine = (l) => (/^\s*(\+|add)/i.test(l) ? 'add' : /^\s*-(?!-)/.test(l) ? 'del' : /^\s*(\/\/|#)/.test(l) ? 'com' : '');

function metrics(s) {
  return h('div', { class: 'vz-card vz-metrics' }, h('div', { class: 'vz-cap' }, s.title || ''), ...(s.items || []).slice(0, 8).map((m, i) => {
    const v = Number(m.value ?? 0);
    const max = Number(m.max ?? 100) || 100;
    const num = h('b', {}, '0');
    countUp(num, v, { decimals: m.decimals ?? 0, suffix: m.unit || '' , ms: 800 + i * 80 });
    return h('div', { class: 'vz-metric' }, h('span', {}, m.label || ''), h('div', { class: 'vz-track' }, h('i', { style: { width: `${Math.min(100, (v / max) * 100)}%`, animationDelay: `${i * 80}ms` }, class: m.tone || '' })), num);
  }));
}

function steps(s) {
  return h('div', { class: 'vz-card vz-steps' }, s.title ? h('div', { class: 'vz-cap' }, s.title) : '', ...(s.items || []).slice(0, 12).map((t, i) => {
    const done = t.done === true || t.status === 'done';
    const run = t.status === 'running';
    return h('div', { class: `vz-step ${done ? 'done' : run ? 'run' : ''}`, style: { animationDelay: `${i * 110}ms` } }, h('span', { class: 'vz-dot' }, done ? '✓' : run ? '' : String(i + 1)), h('span', {}, t.text || t.label || ''));
  }));
}

function status(s) {
  return h('div', { class: 'vz-card vz-status' }, h('div', { class: 'vz-cap' }, s.title || 'status'), h('div', { class: 'vz-grid' }, ...(s.items || []).slice(0, 16).map((it, i) => h('div', { class: `vz-tile ${it.state || 'ok'}`, style: { animationDelay: `${i * 60}ms` }, title: it.detail || '' }, h('i', {}), h('b', {}, it.name || ''), h('small', {}, it.value || it.state || '')))));
}

function bars(s) {
  const data = (s.items || []).slice(0, 12);
  const max = Math.max(1, ...data.map((d) => Number(d.value) || 0));
  return h('div', { class: 'vz-card vz-bars' }, h('div', { class: 'vz-cap' }, s.title || ''), h('div', { class: 'vz-chart' }, ...data.map((d, i) => h('div', { class: 'vz-col' }, h('span', { style: { height: `${Math.max(2, ((Number(d.value) || 0) / max) * 100)}%`, animationDelay: `${i * 70}ms` } }), h('small', {}, d.label || '')))));
}

const RENDER = { weather, code, metrics, steps, status, bars };

/** Build the card for one visual spec, or a text fallback. */
export function renderVisual(spec) {
  const fn = RENDER[String(spec.kind || spec.type || '').toLowerCase()];
  if (!fn) return h('div', { class: 'vz-card vz-fallback' }, JSON.stringify(spec, null, 1));
  try { return fn(spec); } catch { return h('div', { class: 'vz-card vz-fallback' }, 'visual unavailable'); }
}

/** Replace the children of `box` with the text and cards of `text`. */
export function renderReply(box, text) {
  box.replaceChildren(...splitVisuals(text).map((seg) => (seg.visual ? renderVisual(seg.visual) : h('div', { class: 'vz-text' }, seg.text.trim()))).filter(Boolean));
}
