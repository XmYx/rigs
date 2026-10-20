import { isPhone } from './mobile.js';
import { announce } from './a11y.js';

// Smart scaling: the optional mode (off by default, persisted in 'rigs.scaling') that keeps every visible panel
// and window fully on screen as the browser window resizes. The maths is the fit solver in dock-layout.js;
// docking.js applies it (and animates it with CSS transitions). This module holds the switch, the commands
// for menus and the timing of the resize handler. Phones never scale: they keep the mobile layout.

const KEY = 'rigs.scaling';
const listeners = new Set();
let on = read();

function read() { try { return localStorage.getItem(KEY) === '1'; } catch { return false; } }

/** Smart scaling as the user set it (persisted). */
export const isScaling = () => on;
/** Smart scaling actually in effect: the mode is on and this is not a phone. */
export const scalingActive = () => on && !isPhone();
export const reducedMotion = () => !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
export function onScalingChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }

/** Switch smart scaling on or off (the Panels menu calls this). */
export function setScaling(next) {
  next = !!next;
  if (next === on) return on;
  on = next;
  try { localStorage.setItem(KEY, on ? '1' : '0'); } catch { /* private mode */ }
  announce(on ? 'Smart scaling on: panels stay on screen as the window resizes.' : 'Smart scaling off.');
  for (const fn of listeners) { try { fn(on); } catch { /* keep going */ } }
  return on;
}
export const toggleScaling = () => setScaling(!on);

// ---------------------------------------------------------------- timing of the resize handler

const WINDOW = 240;
const samples = []; // { total, solve } ms of the last runs: the whole render, and the solver part (measure + solve)

/** Record one fit run (called by docking.js after a render with smart scaling on). */
export function recordFit(total, solve) {
  samples.push({ total, solve });
  if (samples.length > WINDOW) samples.shift();
}

/** Main-thread cost of the resize handler (ms): last, mean, 95th percentile and worst of the recent runs. */
export function fitStats() {
  const sum = (k) => {
    const v = samples.map((s) => s[k]).sort((a, b) => a - b);
    if (!v.length) return { last: 0, mean: 0, p95: 0, max: 0 };
    return { last: samples[samples.length - 1][k], mean: v.reduce((a, b) => a + b, 0) / v.length, p95: v[Math.min(v.length - 1, Math.floor(v.length * 0.95))], max: v[v.length - 1] };
  };
  return { runs: samples.length, total: sum('total'), solve: sum('solve') };
}
export function resetFitStats() { samples.length = 0; }

/** Commands for menus (the top menu's Panels item and context menus call the same). */
export const scaleCommands = { isScaling, setScaling, toggleScaling, fitStats, resetFitStats };

// Read-only timing hook for scripts/scale-check.js and the console: __rigsFit.stats() / .reset()
try { globalThis.__rigsFit = { stats: fitStats, reset: resetFitStats }; } catch { /* frozen global */ }
