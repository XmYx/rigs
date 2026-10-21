// Mission Control (mission-control.js) — the pure part: where each window's preview goes, the Spaces bar's miniature
// layouts, arrow-key movement between previews, the shortcuts and the requests JARVIS answers by opening it.
// No DOM; unit-tested in test/mission-control-model.test.js.

const num = (v, d = 0) => (Number.isFinite(Number(v)) ? Number(v) : d);
const cx = (r) => r.x + r.w / 2;
const cy = (r) => r.y + r.h / 2;

/**
 * The previews' grid: every window scaled by one factor (so their sizes stay relative to each other, as on a Mac) into
 * rows inside `area`, without overlapping, aspect kept, never bigger than it is (scale ≤ maxScale ≤ 1).
 * `wins` = [{ id, x, y, w, h }] (the windows' screen rects), `area` = { x, y, w, h }. Rows follow the windows' places:
 * the higher a window sits on screen the higher its row, and within a row left to right as on screen, so a window
 * keeps its rough place. `gap` = space between previews, `label` = room under each row for the titles.
 * Returns [{ id, x, y, w, h, scale, row, order }] in the order of `wins`; `order` = reading order (row by row).
 * Tries every row count and keeps the one that lets the previews be biggest (fewer rows on a tie).
 */
export function gridLayout(wins, area, { gap = 24, label = 24, maxScale = 1 } = {}) {
  const list = (Array.isArray(wins) ? wins : []).map((r, i) => ({
    i, id: r?.id, x: num(r?.x), y: num(r?.y), w: Math.max(1, num(r?.w, 1)), h: Math.max(1, num(r?.h, 1)),
  }));
  const n = list.length;
  if (!n) return [];
  const A = { x: num(area?.x), y: num(area?.y), w: Math.max(0, num(area?.w)), h: Math.max(0, num(area?.h)) };
  const top = Math.min(1, Math.max(0, num(maxScale, 1)));
  const byY = [...list].sort((a, b) => cy(a) - cy(b) || cx(a) - cx(b) || a.i - b.i);
  let best = null;
  for (let r = 1; r <= n; r++) {
    const rows = splitRows(byY, r);
    const fitW = Math.min(...rows.map((row) => (A.w - gap * (row.length - 1)) / row.reduce((s, w) => s + w.w, 0)));
    const fitH = (A.h - gap * (r - 1) - label * r) / rows.reduce((s, row) => s + Math.max(...row.map((w) => w.h)), 0);
    const scale = Math.min(top, fitW, fitH);
    if (!best || scale > best.scale + 1e-9) best = { rows, scale };
  }
  const s = Math.max(best.scale, 0.01); // a screen too small to fit them: tiny, never negative
  const heights = best.rows.map((row) => Math.max(...row.map((w) => w.h)) * s);
  const total = heights.reduce((a, b) => a + b, 0) + label * best.rows.length + gap * (best.rows.length - 1);
  let y = A.y + Math.max(0, (A.h - total) / 2);
  const out = new Array(n);
  let order = 0;
  best.rows.forEach((row, ri) => {
    const width = row.reduce((sum, w) => sum + w.w * s, 0) + gap * (row.length - 1);
    let x = A.x + Math.max(0, (A.w - width) / 2);
    for (const w of row) {
      const ww = w.w * s;
      const hh = w.h * s;
      out[w.i] = { id: w.id, x, y: y + (heights[ri] - hh) / 2, w: ww, h: hh, scale: s, row: ri, order: order++ };
      x += ww + gap;
    }
    y += heights[ri] + label + gap;
  });
  return out;
}

/** byY split into `r` rows (the first rows take one more when n does not divide), each sorted left to right. */
function splitRows(byY, r) {
  const n = byY.length;
  const base = Math.floor(n / r);
  const extra = n % r;
  const rows = [];
  let at = 0;
  for (let k = 0; k < r; k++) {
    const len = base + (k < extra ? 1 : 0);
    rows.push(byY.slice(at, at + len).sort((a, b) => cx(a) - cx(b) || a.i - b.i));
    at += len;
  }
  return rows;
}

/**
 * A desktop's miniature: window rects on a `screen` ({ w, h }) scaled into a thumbnail ({ w, h }), clipped to it.
 * Rects wholly off screen are left out. Returns [{ id, title, x, y, w, h }] in the order given (draw bottom first).
 */
export function miniRects(rects, screen, thumb) {
  const sw = Math.max(1, num(screen?.w, 1));
  const sh = Math.max(1, num(screen?.h, 1));
  const kx = num(thumb?.w) / sw;
  const ky = num(thumb?.h) / sh;
  const out = [];
  for (const r of Array.isArray(rects) ? rects : []) {
    const x0 = Math.max(0, num(r?.x));
    const y0 = Math.max(0, num(r?.y));
    const x1 = Math.min(sw, num(r?.x) + Math.max(0, num(r?.w)));
    const y1 = Math.min(sh, num(r?.y) + Math.max(0, num(r?.h)));
    if (x1 <= x0 || y1 <= y0) continue;
    out.push({ id: r.id, title: r.title, x: x0 * kx, y: y0 * ky, w: (x1 - x0) * kx, h: (y1 - y0) * ky });
  }
  return out;
}

/**
 * Arrow keys between previews: the index of the nearest rect from `rects[i]` in direction 'left' | 'right' | 'up' |
 * 'down' (straight ahead preferred over diagonal), or i when there is none. No highlight yet (i < 0): the first one.
 */
export function neighbor(rects, i, dir) {
  const list = Array.isArray(rects) ? rects : [];
  if (!list.length) return -1;
  if (!(i >= 0 && i < list.length)) return 0;
  const a = list[i];
  const [ax, ay] = [cx(a), cy(a)];
  let best = i;
  let bestScore = Infinity;
  list.forEach((b, j) => {
    if (j === i) return;
    const dx = cx(b) - ax;
    const dy = cy(b) - ay;
    const ahead = { left: -dx, right: dx, up: -dy, down: dy }[dir];
    const side = dir === 'left' || dir === 'right' ? Math.abs(dy) : Math.abs(dx);
    if (!(ahead > 1)) return;
    const score = ahead + side * 2;
    if (score < bestScore) { bestScore = score; best = j; }
  });
  return best;
}

/** Ctrl+↑ and F3, as on a Mac. macOS keeps Ctrl+↑ for its own Mission Control by default, so Macs also take Ctrl+Shift+↑. */
export function missionShortcuts(mac = false) {
  return mac ? ['Ctrl+ArrowUp', 'Ctrl+Shift+ArrowUp', 'F3'] : ['Ctrl+ArrowUp', 'F3'];
}

/**
 * Is a request to JARVIS asking for Mission Control? "mission control", "show me all my windows", "show all open
 * windows", "list my windows", "windows and desktops". (The live-screens Desktops panel is a different thing: "show
 * desktops" alone is not this.)
 */
export function isMissionControlAsk(text) {
  const t = String(text || '').trim().replace(/[.!?]+$/, '').replace(/\s+/g, ' ');
  if (/^(?:(?:open|show|start|launch|enter|toggle|go to|bring up)\s+)?(?:me\s+)?(?:the\s+)?mission control$/i.test(t)) return true;
  return /^(?:(?:show|list|see|view|display|bring up)\s+)?(?:me\s+)?(?:all\s+)?(?:of\s+)?(?:my\s+|the\s+)?(?:open\s+)?windows(?:\s+(?:that are\s+)?open)?(?:\s+and\s+(?:my\s+|the\s+|all\s+)?desktops)?$/i.test(t)
    && /\b(?:show|list|see|view|display|bring up|all|my|open|desktops)\b/i.test(t);
}
