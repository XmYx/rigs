// The J.A.R.V.I.S. arc-reactor orb: concentric HUD rings whose motion reflects state
// (online / listening / thinking / speaking), drawn on a canvas.

import { currentTheme, onTheme } from './themes.js';

const STATE_COLOR = {
  online: [94, 234, 212],
  listening: [74, 222, 128],
  thinking: [251, 191, 36],
  speaking: [192, 132, 252],
  error: [248, 113, 113],
  offline: [100, 116, 139],
};

import { lowPower } from './perf.js';

export function createOrb(canvas, label = 'J.A.R.V.I.S.') {
  const ctx = canvas.getContext('2d');
  let state = 'online';
  let level = 0; // mic / speech level 0..1
  const stateColor = (k) => currentTheme().orb?.[k] || STATE_COLOR[k] || STATE_COLOR.online;
  let target = stateColor('online');
  onTheme(() => { target = stateColor(state); });
  let color = [...target];
  let t0 = performance.now();

  function size() {
    const dpr = Math.min(window.devicePixelRatio || 1, lowPower() ? 1.5 : 2);
    const r = canvas.getBoundingClientRect();
    canvas.width = r.width * dpr;
    canvas.height = r.height * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  size();
  window.addEventListener('resize', size);

  function rgba(a) { return `rgba(${color[0] | 0},${color[1] | 0},${color[2] | 0},${a})`; }

  function arc(cx, cy, r, a0, a1, w, alpha) {
    ctx.beginPath();
    ctx.arc(cx, cy, r, a0, a1);
    ctx.lineWidth = w;
    ctx.strokeStyle = rgba(alpha);
    ctx.stroke();
  }

  // prefers-reduced-motion: a still ring (no rotation, pulse or wobble) redrawn only when state or level changes
  const mq = window.matchMedia?.('(prefers-reduced-motion: reduce)');
  const calm = () => !!mq?.matches;

  function frame(now) {
    if (document.hidden) { setTimeout(() => requestAnimationFrame(frame), 500); return; }
    const still = calm();
    const t = still ? 0 : (now - t0) / 1000;
    for (let i = 0; i < 3; i++) color[i] += (target[i] - color[i]) * (still ? 1 : 0.08);
    const w = canvas.clientWidth;
    const hgt = canvas.clientHeight;
    const cx = w / 2;
    const cy = hgt / 2;
    const R = Math.min(w, hgt) / 2 - 4;
    ctx.clearRect(0, 0, w, hgt);
    const speed = still ? 0 : state === 'thinking' ? 3.2 : state === 'speaking' ? 1.6 : state === 'listening' ? 1.2 : 0.5;
    const pulse = still ? 0.15 : state === 'speaking' || state === 'listening' ? level : 0.15 + Math.sin(t * 1.6) * 0.05;

    // glow
    const g = ctx.createRadialGradient(cx, cy, R * 0.1, cx, cy, R);
    g.addColorStop(0, rgba(0.22 + pulse * 0.25));
    g.addColorStop(0.6, rgba(0.05));
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(cx, cy, R, 0, Math.PI * 2); ctx.fill();

    // outer dashed ticks
    for (let i = 0; i < 72; i++) {
      const a = (i / 72) * Math.PI * 2 + t * 0.05 * speed;
      const long = i % 6 === 0;
      const r1 = R * 0.93;
      const r2 = R * (long ? 0.84 : 0.88);
      ctx.beginPath();
      ctx.moveTo(cx + Math.cos(a) * r1, cy + Math.sin(a) * r1);
      ctx.lineTo(cx + Math.cos(a) * r2, cy + Math.sin(a) * r2);
      ctx.lineWidth = long ? 1.6 : 0.8;
      ctx.strokeStyle = rgba(long ? 0.7 : 0.35);
      ctx.stroke();
    }
    // rotating segment rings
    const rot = t * speed;
    arc(cx, cy, R * 0.76, rot, rot + Math.PI * 0.9, 3, 0.9);
    arc(cx, cy, R * 0.76, rot + Math.PI, rot + Math.PI * 1.35, 3, 0.5);
    arc(cx, cy, R * 0.66, -rot * 1.3, -rot * 1.3 + Math.PI * 1.4, 1.5, 0.6);
    arc(cx, cy, R * 0.58, rot * 0.7 + 1, rot * 0.7 + 1 + Math.PI * 0.5, 5, 0.35);
    arc(cx, cy, R * 0.58, rot * 0.7 + 1 + Math.PI, rot * 0.7 + 1 + Math.PI * 1.5, 5, 0.35);
    // inner reactive ring (audio level)
    const ir = R * (0.42 + pulse * 0.12);
    ctx.beginPath();
    for (let i = 0; i <= 96; i++) {
      const a = (i / 96) * Math.PI * 2;
      const wob = !still && (state === 'speaking' || state === 'listening') ? Math.sin(a * 6 + t * 8) * level * R * 0.05 : 0;
      const x = cx + Math.cos(a) * (ir + wob);
      const y = cy + Math.sin(a) * (ir + wob);
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.lineWidth = 2;
    ctx.strokeStyle = rgba(0.85);
    ctx.stroke();
    // label
    ctx.fillStyle = rgba(0.95);
    ctx.font = `600 ${Math.max(10, R * 0.15)}px ui-monospace, SFMono-Regular, Menlo, monospace`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.shadowColor = rgba(0.9);
    ctx.shadowBlur = lowPower() ? 0 : 12;
    ctx.fillText(label, cx, cy);
    ctx.shadowBlur = 0;
    if (still) setTimeout(() => requestAnimationFrame(frame), 400); else requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);

  return {
    setState(s) { state = s; target = stateColor(s); },
    setLevel(v) { level = Math.max(0, Math.min(1, v)); },
    get state() { return state; },
  };
}
