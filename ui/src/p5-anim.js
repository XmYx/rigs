// The internal p5.js animation library. The Exhibit window (exhibits.js) draws one small looping sketch per card
// instead of a static picture; this file is the whole kit, so other surfaces can reuse it:
//   mountSketch(host, { id, seed, info, reducedMotion, onReady, onError }) → { destroy, refresh() }
//   contextFrom(entry, doc)     what a card is ABOUT (keywords, numbers, steps, tone, position in the document, kind mix):
//                               every sketch draws that as data (words riding the rings, one node per plan step, a progress
//                               track, a ✓ or ✗ by outcome, the document's kind mix), so no two cards look or read alike
//   SKETCHES / sketchFor(kind)  the sketches (ripple, constellation, flow, rain, bloom, orbit, aurora), one per entry kind
//   refreshSketches()           re-read the theme and repaint every live sketch (wired to onTheme in exhibits.js)
// Approach (from the p5.js community notes and the reference):
//   - instance mode, one `new p5(fn, host)` per card: no globals, many canvases on one page
//   - p5 itself (~1 MB) is a lazy chunk: `import('p5')` runs on the first mount, so the rest of the UI never pays for it
//   - a sketch only runs while its card is on screen (IntersectionObserver → noLoop/loop) 
//   - time is our own tick (`ctx.t`), not frameCount, so a still frame can be fast-forwarded to a settled composition:
//     under prefers-reduced-motion (and in the plain Document view) a sketch draws STILL_STEPS ticks once and stops
//   - theme: colors are read from the CSS variables (--accent-rgb, --accent-2-rgb, --bg, --text) at mount and on every
//     theme change; `--ex-pixel: N` (set by a theme's CSS, e.g. Atari) renders at 1/N resolution, scaled up pixelated
//   - sketches are plain functions `(p, ctx) => void` that set p.draw (and `ctx.reset` to re-seed their state); they
//     never touch the DOM, so they can run against a fake `p` in Node (test/p5-anim.test.js)
// Importable in Node: nothing here touches `document` or p5 until mountSketch runs.

const TAU = Math.PI * 2;
export const STILL_STEPS = 120;

// ------------------------------------------------------------------ pure helpers

export const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);

/** Easing curves on 0..1. */
export const EASE = {
  linear: (t) => clamp01(t),
  inQuad: (t) => clamp01(t) ** 2,
  outCubic: (t) => 1 - (1 - clamp01(t)) ** 3,
  inOutCubic: (t) => { t = clamp01(t); return t < 0.5 ? 4 * t ** 3 : 1 - (-2 * t + 2) ** 3 / 2; },
  outBack: (t) => { t = clamp01(t); const c = 1.70158; return 1 + (c + 1) * (t - 1) ** 3 + c * (t - 1) ** 2; },
};

/** Blend two [r,g,b] colors. */
export const mix = (a, b, k) => [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k];

/** Deterministic 0..1 from a number (the same cell always gets the same glyph). */
export const hash01 = (n) => { const x = Math.sin(n * 127.1 + 311.7) * 43758.5453; return x - Math.floor(x); };

/** A stable integer seed from text (an entry id), so a card always draws the same composition. */
export function hashSeed(text) {
  let h = 2166136261;
  for (const ch of String(text ?? '')) { h ^= ch.codePointAt(0); h = Math.imul(h, 16777619); }
  return (h >>> 0) % 2147483647 || 1;
}

/** '#rgb' · '#rrggbb' · 'r, g, b' · 'rgb(r g b)' · 'rgba(r,g,b,a)' → [r,g,b], else the fallback. */
export function parseColor(s, fallback = [255, 255, 255]) {
  const t = String(s ?? '').trim();
  let m = t.match(/^#([0-9a-f]{3})$/i);
  if (m) return [...m[1]].map((c) => parseInt(c + c, 16));
  m = t.match(/^#([0-9a-f]{6})/i);
  if (m) return [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16));
  m = t.match(/(\d+(?:\.\d+)?)[\s,]+(\d+(?:\.\d+)?)[\s,]+(\d+(?:\.\d+)?)/);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : fallback;
}

/** The palette of the current theme. `read(name)` returns a CSS variable's value (readPalette passes getComputedStyle). */
export function paletteFrom(read) {
  const px = Math.round(Number(read('--ex-pixel')));
  return {
    bg: parseColor(read('--bg'), [4, 6, 10]),
    a: parseColor(read('--accent-rgb'), [45, 212, 191]),
    b: parseColor(read('--accent-2-rgb'), [94, 234, 212]),
    text: parseColor(read('--text'), [215, 227, 234]),
    warn: parseColor(read('--warn'), [251, 191, 36]),
    px: px >= 2 && px <= 8 ? px : 1,
  };
}

export function readPalette(root = document.documentElement) {
  const cs = getComputedStyle(root);
  return paletteFrom((name) => cs.getPropertyValue(name));
}

const fillC = (p, c, a = 255) => p.fill(c[0], c[1], c[2], a);
const strokeC = (p, c, a = 255) => p.stroke(c[0], c[1], c[2], a);

// ------------------------------------------------------------------ context: what a card is about

const STOP = new Set('the and for with from that this into over after before while then than are was were has have had not but its our your will can should could would been being you all any out use used using add added adds new more get got set per via also just only each one two'.split(' '));
const BAD = /\b(fail(?:s|ed|ure)?|error|errors|blocked|broke|broken|crash(?:ed)?|abort(?:ed)?|reject(?:ed)?|timeout|stuck|cannot|denied)\b/i;
const GOOD = /\b(done|pass(?:ed|es)?|complete[d]?|merged|shipped|success(?:ful)?|fixed|ready|rolled out|green)\b/i;
const SPLIT_STEPS = /;|\n|\s+(?:->|→|then|and then)\s+|,\s+(?=\p{L})/u;
const clip = (t, n) => (t.length > n ? t.slice(0, n - 1) + '…' : t);

/**
 * What an exhibit card is about, as plain data for the sketches. `entry` = { id, kind, seq, title, caption };
 * `doc` = { title, total (entries so far), counts ({ kind: n }) }. Pure; every field has a harmless default.
 *   words  keywords of the title then the caption (≤ 12, each ≤ 14 chars)   nums   numbers found in the text (≤ 6)
 *   steps  parts of the caption/title that read as a list of steps          tone   'bad' | 'good' | 'neutral'
 *   seq/total/pos  where the card sits in its document (pos 0..1)           counts how many cards of each kind
 */
export function contextFrom(entry = {}, doc = {}) {
  const title = String(entry.title ?? ''); const caption = String(entry.caption ?? '');
  const text = `${title} ${caption}`;
  const seen = new Set(); const words = [];
  for (const m of text.matchAll(/[\p{L}\p{N}_][\p{L}\p{N}_.\/-]{2,}/gu)) {
    const w = m[0].replace(/[.\/-]+$/, ''); const k = w.toLowerCase();
    if (w.length < 3 || STOP.has(k) || seen.has(k) || /^\d+$/.test(w)) continue;
    seen.add(k); words.push(clip(w, 14));
    if (words.length >= 12) break;
  }
  const nums = (text.match(/\d+(?:[.,]\d+)?%?/g) || []).slice(0, 6);
  const steps = (caption || title).split(SPLIT_STEPS).map((x) => x.trim()).filter((x) => x.length > 2);
  const tone = BAD.test(text) ? 'bad' : GOOD.test(text) ? 'good' : 'neutral';
  const seq = Number(entry.seq) > 0 ? Number(entry.seq) : 0;
  const total = Math.max(Number(doc.total) || 0, seq);
  return { kind: entry.kind || '', words, nums, steps, tone, seq, total, pos: seq && total ? clamp01(seq / total) : 0.5, counts: doc.counts || {}, docTitle: String(doc.title ?? '') };
}

const EMPTY_INFO = contextFrom();
const inf = (ctx) => ctx.info || EMPTY_INFO;

/** A small monospace label, kept inside the canvas; `bg` puts a pill of background colour behind it. Skipped on tiny canvases. */
function tag(p, ctx, str, x, y, size, col, alpha = 255, bg = false) {
  if (!str || p.height < 60 || size < 5) return;
  const t = String(str); const w = p.width; const h = p.height;
  const tw = t.length * size * 0.6;
  const cx = Math.min(Math.max(x, tw / 2 + 3), Math.max(tw / 2 + 3, w - tw / 2 - 3));
  const cy = Math.min(Math.max(y, size), Math.max(size, h - size));
  p.textFont('monospace'); p.textSize(size); p.textAlign(p.CENTER, p.CENTER); p.noStroke();
  if (bg) { fillC(p, ctx.pal.bg, 200 * (alpha / 255)); p.rect(cx - tw / 2 - size * 0.4, cy - size * 0.8, tw + size * 0.8, size * 1.6); }
  fillC(p, col, alpha); p.text(t, cx, cy);
}

// ------------------------------------------------------------------ the sketches

/** intake — rings leaving a glowing core, each carrying a keyword of the request: a request arriving. */
function ripple(p, ctx) {
  const PERIOD = 34;
  const LIFE = 150;
  p.draw = () => {
    const { bg, a, b } = ctx.pal;
    const { words } = inf(ctx);
    const w = p.width; const h = p.height; const s = Math.min(w, h);
    p.background(bg[0], bg[1], bg[2]);
    p.noFill();
    const last = Math.floor(ctx.t / PERIOD);
    const rings = [];
    for (let k = 0; k < 5; k++) {
      const i = last - k;
      const age = (ctx.t - i * PERIOD) / LIFE;
      if (i < 0 || age > 1) continue;
      const d = EASE.outCubic(age) * Math.hypot(w, h) * 0.8;
      strokeC(p, mix(a, b, age), 255 * (1 - age));
      p.strokeWeight(Math.max(1, s * 0.014 * (1 - age)));
      p.circle(w / 2, h / 2, d);
      rings.push({ i, age, d });
    }
    const pulse = 1 + 0.14 * Math.sin(ctx.t * 0.12);
    p.noStroke();
    fillC(p, a, 70); p.circle(w / 2, h / 2, s * 0.2 * pulse);
    fillC(p, b); p.circle(w / 2, h / 2, s * 0.055);
    if (words.length) for (const { i, age, d } of rings) { // the request's own words ride the rings outward, in order
      if (age < 0.1 || age > 0.85) continue;
      const ang = -Math.PI / 2 + (i % 2 ? 0.9 : -0.9) + hash01(i + ctx.seed) * 0.6;
      tag(p, ctx, words[i % words.length], w / 2 + Math.cos(ang) * d / 2, h / 2 + Math.sin(ang) * d / 2, Math.max(9, s * 0.05), ctx.pal.text, 255 * Math.min(1, (0.85 - age) * 4), true);
    }
  };
}

/** plan — one node per step of the plan appears and links up, labelled with its keyword, then a pulse travels the chain. */
function constellation(p, ctx) {
  let N = 9;
  let nodes = [];
  ctx.reset = () => {
    const I = inf(ctx);
    N = Math.max(4, Math.min(9, I.steps.length > 1 ? I.steps.length : I.words.length || 9));
    p.randomSeed(ctx.seed);
    nodes = Array.from({ length: N }, (_, i) => ({ x: (i + 0.5 + (p.random() - 0.5) * 0.5) / N, y: 0.22 + 0.56 * p.random(), ph: p.random(TAU) }));
  };
  const at = (n, t) => ({ x: (n.x + 0.012 * Math.sin(t * 0.02 + n.ph)) * p.width, y: (n.y + 0.02 * Math.cos(t * 0.017 + n.ph)) * p.height });
  p.draw = () => {
    const { bg, a, b } = ctx.pal;
    const { steps, words } = inf(ctx);
    const s = Math.min(p.width, p.height);
    p.background(bg[0], bg[1], bg[2]);
    const prog = EASE.inOutCubic(ctx.t / 130) * (N - 1);
    p.strokeWeight(Math.max(1, s * 0.008));
    for (let i = 0; i < N - 1; i++) {
      for (const j of (i % 2 ? [i + 1] : [i + 1, Math.min(N - 1, i + 2)])) {
        const k = clamp01(prog - i);
        if (k <= 0) continue;
        const p0 = at(nodes[i], ctx.t); const p1 = at(nodes[j], ctx.t);
        strokeC(p, a, 150);
        p.line(p0.x, p0.y, p0.x + (p1.x - p0.x) * k, p0.y + (p1.y - p0.y) * k);
      }
    }
    p.noStroke();
    nodes.forEach((n, i) => {
      const k = EASE.outBack(prog - i + 1);
      if (k <= 0) return;
      const { x, y } = at(n, ctx.t);
      fillC(p, a, 60); p.circle(x, y, s * 0.12 * k);
      fillC(p, b); p.circle(x, y, s * 0.045 * k);
    });
    nodes.forEach((n, i) => { // each node names its step (the step's first word, else the next keyword)
      if (prog - i + 1 < 0.9) return;
      const { x, y } = at(n, ctx.t);
      const label = steps.length > i && steps.length > 1 ? clip(steps[i].split(/\s+/).filter((x) => x.length > 2 && !STOP.has(x.toLowerCase())).slice(0, 2).join(' ') || steps[i], 13) : words[i];
      tag(p, ctx, label, x, y + (n.y > 0.5 ? -1 : 1) * s * 0.11, Math.max(8, s * 0.045), ctx.pal.text, 220);
    });
    if (prog >= N - 1) { // the pulse
      const u = (ctx.t * 0.025) % (N - 1);
      const i = Math.floor(u);
      const p0 = at(nodes[i], ctx.t); const p1 = at(nodes[i + 1], ctx.t);
      fillC(p, ctx.pal.text); p.circle(p0.x + (p1.x - p0.x) * (u - i), p0.y + (p1.y - p0.y) * (u - i), s * 0.03);
    }
  };
}

/** step — particles drifting along a noise field; a track at the bottom fills to this step's place in the document (n / total). */
function flow(p, ctx) {
  let ps = [];
  let clear = true;
  ctx.reset = () => {
    const I = inf(ctx);
    const count = Math.round(40 + 70 * I.pos); // later steps run denser
    p.randomSeed(ctx.seed); p.noiseSeed(ctx.seed);
    ps = Array.from({ length: count }, (_, i) => ({ x: p.random(), y: p.random(), px: 0, py: 0, life: p.random(80, 260), c: i % 3 }));
    for (const q of ps) { q.px = q.x; q.py = q.y; }
    clear = true;
  };
  p.draw = () => {
    const { bg, a, b, warn } = ctx.pal;
    const I = inf(ctx);
    const w = p.width; const h = p.height; const s = Math.min(w, h);
    const bad = I.tone === 'bad';
    if (clear) { p.background(bg[0], bg[1], bg[2]); clear = false; }
    p.noStroke(); p.fill(bg[0], bg[1], bg[2], 26); p.rect(0, 0, w, h);
    p.strokeWeight(Math.max(1, s * 0.008));
    const speed = bad ? 0.0022 : 0.004; // a blocked step crawls
    for (const q of ps) {
      const ang = p.noise(q.x * 2.4, q.y * 2.4, ctx.t * 0.004) * TAU * 2;
      q.px = q.x; q.py = q.y;
      q.x += Math.cos(ang) * speed; q.y += Math.sin(ang) * speed * (w / h);
      strokeC(p, q.c === 2 ? (bad ? warn : ctx.pal.text) : q.c ? b : a, 210);
      p.line(q.px * w, q.py * h, q.x * w, q.y * h);
      if (--q.life < 0 || q.x < 0 || q.x > 1 || q.y < 0 || q.y > 1) { q.x = p.random(); q.y = p.random(); q.px = q.x; q.py = q.y; q.life = p.random(80, 260); }
    }
    if (I.seq) { // the track: step n of total
      const x0 = w * 0.08; const x1 = w * 0.92; const y = h * 0.9;
      const fill = I.pos * EASE.outCubic(ctx.t / 90);
      p.strokeWeight(Math.max(2, s * 0.02)); p.strokeCap(p.ROUND);
      strokeC(p, bg, 255); p.line(x0 - 2, y, x1 + 2, y);
      strokeC(p, ctx.pal.text, 70); p.line(x0, y, x1, y);
      strokeC(p, bad ? warn : a); p.line(x0, y, x0 + (x1 - x0) * fill, y);
      p.noStroke(); fillC(p, bad ? warn : ctx.pal.text); p.circle(x0 + (x1 - x0) * fill, y, s * 0.045);
      tag(p, ctx, `${String(I.seq).padStart(2, '0')} / ${String(I.total).padStart(2, '0')}`, w / 2, y - s * 0.085, Math.max(8, s * 0.05), ctx.pal.text, 230, true);
    }
  };
}

const GLYPHS = '01{}[]<>/=;+-*#';

/** code — columns of glyphs falling with a bright head (blocks in a pixel theme). The glyphs are the characters of this
 *  card's own text, and some columns spell one of its words down their trail. */
function rain(p, ctx) {
  const TAIL = 9;
  p.draw = () => {
    const { bg, a, b } = ctx.pal;
    const { words } = inf(ctx);
    const src = words.length ? words.join('') + GLYPHS.slice(0, 5) : GLYPHS;
    const blocks = ctx.pal.px > 1;
    const cell = blocks ? 5 : 14;
    const cols = Math.ceil(p.width / cell); const rows = Math.ceil(p.height / cell);
    p.background(bg[0], bg[1], bg[2]);
    p.noStroke();
    if (!blocks) { p.textFont('monospace'); p.textSize(cell - 2); p.textAlign(p.CENTER, p.CENTER); }
    for (let c = 0; c < cols; c++) {
      const speed = 0.05 + hash01(c + ctx.seed) * 0.12;
      const head = Math.floor(ctx.t * speed + hash01(c * 3 + ctx.seed) * (rows + TAIL)) % (rows + TAIL);
      const word = words.length && hash01(c * 29 + ctx.seed) < 0.22 ? words[Math.floor(hash01(c * 31 + ctx.seed) * words.length)].slice(0, TAIL) : '';
      for (let d = 0; d < TAIL; d++) {
        const r = head - d;
        if (r < 0 || r >= rows) continue;
        const spelled = word && d < word.length;
        const col = d === 0 ? ctx.pal.text : spelled ? b : d < 3 ? b : a;
        const alpha = spelled ? 255 * (1 - d / TAIL) ** 0.7 : 255 * (1 - d / TAIL) ** 1.5;
        fillC(p, col, alpha);
        if (blocks) p.rect(c * cell, r * cell, cell - 1, cell - 1);
        else p.text(spelled ? word[word.length - 1 - d] : src[Math.floor(hash01(c * 97 + r * 13 + (d < 2 ? Math.floor(ctx.t / 7) : 0)) * src.length)], c * cell + cell / 2, r * cell + cell / 2);
      }
    }
  };
}

/** result — a burst of rays settling into a ring with a mark drawn in: a check when it worked, a cross in the warning colour
 *  when the text reports a failure; the first number found in the text is stated under it. */
function bloom(p, ctx) {
  p.draw = () => {
    const { bg, a, b, warn } = ctx.pal;
    const I = inf(ctx);
    const bad = I.tone === 'bad';
    const rays = Math.min(56, 24 + 4 * I.words.length);
    const w = p.width; const h = p.height; const s = Math.min(w, h);
    p.background(bg[0], bg[1], bg[2]);
    const burst = EASE.outBack(ctx.t / 70);
    const breathe = 1 + 0.03 * Math.sin(ctx.t * 0.08);
    p.push(); p.translate(w / 2, h / 2);
    p.strokeWeight(Math.max(1, s * 0.008));
    for (let i = 0; i < rays; i++) {
      const ang = (i / rays) * TAU;
      const len = s * (0.3 + 0.2 * hash01(i + ctx.seed)) * burst * (bad ? 0.75 : 1);
      strokeC(p, bad ? warn : i % 2 ? a : b, 170 * (1 - 0.4 * hash01(i * 5)));
      p.line(Math.cos(ang) * s * 0.28 * breathe, Math.sin(ang) * s * 0.28 * breathe, Math.cos(ang) * len, Math.sin(ang) * len);
    }
    p.noFill(); strokeC(p, bad ? warn : b); p.strokeWeight(Math.max(2, s * 0.02));
    p.circle(0, 0, s * 0.5 * burst * breathe);
    const k = EASE.outCubic((ctx.t - 40) / 40); // the mark, drawn along
    strokeC(p, ctx.pal.text); p.strokeWeight(Math.max(2, s * 0.025));
    const seg = (pts, f) => { // draw `f` (0..1) of a polyline
      const n = pts.length - 1;
      for (let i = 0; i < n; i++) {
        const u = clamp01(f * n - i);
        if (u > 0) p.line(pts[i][0] * s, pts[i][1] * s, (pts[i][0] + (pts[i + 1][0] - pts[i][0]) * u) * s, (pts[i][1] + (pts[i + 1][1] - pts[i][1]) * u) * s);
      }
    };
    if (bad) { seg([[-0.08, -0.08], [0.08, 0.08]], k); seg([[0.08, -0.08], [-0.08, 0.08]], clamp01(k * 2 - 1)); } else seg([[-0.1, 0.01], [-0.03, 0.08], [0.11, -0.08]], k);
    p.pop();
    if (I.nums.length && k > 0.5) tag(p, ctx, I.nums[0], w / 2, h * 0.9, Math.max(10, s * 0.075), bad ? warn : ctx.pal.text, 255 * clamp01((k - 0.5) * 2), true);
  };
}

/** milestone — three tilted orbits around a core carrying one body per card of the document; the first n are lit (this
 *  milestone is the n-th), and a pennant rises to the document's progress. */
function orbit(p, ctx) {
  p.draw = () => {
    const { bg, a, b } = ctx.pal;
    const I = inf(ctx);
    const T = Math.max(3, Math.min(12, I.total || 6));
    const lit = I.seq ? Math.min(T, Math.max(1, Math.round(I.pos * T))) : T;
    const w = p.width; const h = p.height; const s = Math.min(w, h);
    p.background(bg[0], bg[1], bg[2]);
    for (let i = 0; i < 24; i++) { // a few twinkling stars
      fillC(p, ctx.pal.text, 60 + 120 * Math.abs(Math.sin(ctx.t * 0.03 + i)));
      p.noStroke(); p.circle(hash01(i * 7 + ctx.seed) * w, hash01(i * 11 + ctx.seed) * h, Math.max(1, s * 0.01));
    }
    p.push(); p.translate(w / 2, h / 2);
    p.noFill(); p.strokeWeight(Math.max(1, s * 0.006));
    [0, 1, 2].forEach((i) => {
      p.push(); p.rotate((i * Math.PI) / 3 + 0.4);
      strokeC(p, a, 110); p.ellipse(0, 0, s * 0.86, s * 0.3);
      for (let j = i; j < T; j += 3) { // the cards of the document: lit when reached, a hollow ring when still ahead
        const ang = ctx.t * (0.02 + i * 0.008) + i * 2 + (j / 3) * (TAU / Math.ceil(T / 3));
        const x = Math.cos(ang) * s * 0.43; const y = Math.sin(ang) * s * 0.15;
        if (j < lit) { p.noStroke(); fillC(p, j === lit - 1 ? ctx.pal.warn : i % 2 ? a : b); } else { p.noFill(); strokeC(p, b, 160); p.strokeWeight(Math.max(1, s * 0.005)); }
        p.circle(x, y, s * (j === lit - 1 ? 0.06 : 0.04));
      }
      p.pop();
    });
    p.noStroke(); fillC(p, a, 50); p.circle(0, 0, s * 0.3); fillC(p, b, 120); p.circle(0, 0, s * 0.18);
    const k = EASE.outBack((ctx.t - 10) / 50) * (0.45 + 0.55 * I.pos); // the pennant
    const top = -s * 0.2 * k;
    strokeC(p, ctx.pal.text); p.strokeWeight(Math.max(1, s * 0.008)); p.line(0, 0, 0, top);
    p.noStroke(); fillC(p, ctx.pal.warn);
    p.triangle(0, top, s * 0.1 * k, top + s * 0.035 * k, 0, top + s * 0.07 * k);
    p.pop();
    if (I.seq) tag(p, ctx, `${I.seq} / ${I.total}`, w / 2, h * 0.9, Math.max(9, s * 0.05), ctx.pal.text, 230, true);
  };
}

/** summary — one noise ribbon per kind of card in the document, as tall as how many there are, each named ("5 step"). */
function aurora(p, ctx) {
  p.draw = () => {
    const { bg, a, b } = ctx.pal;
    const { counts } = inf(ctx);
    const kinds = Object.entries(counts).filter(([, n]) => n > 0).sort((x, y) => y[1] - x[1]).slice(0, 6);
    const R = Math.max(3, kinds.length);
    const peak = Math.max(1, ...kinds.map(([, n]) => n));
    const w = p.width; const h = p.height;
    p.background(bg[0], bg[1], bg[2]);
    p.noStroke();
    const step = Math.max(4, Math.round(w / 70));
    const ids = [];
    for (let i = 0; i < R; i++) {
      const share = kinds[i] ? 0.4 + 0.6 * (kinds[i][1] / peak) : 0.7;
      const base = R > 1 ? 0.24 + 0.52 * (i / (R - 1)) : 0.5;
      fillC(p, mix(a, b, i / Math.max(1, R - 1)), 46);
      p.beginShape();
      const edge = [];
      for (let x = 0; x <= w + step; x += step) {
        const y = h * base + (p.noise(x * 0.004 + i * 7 + ctx.seed, ctx.t * 0.006) - 0.5) * h * 0.4 * share;
        p.vertex(x, y);
        edge.push([x, y + h * (0.05 + 0.12 * share * p.noise(x * 0.006, i * 3 + ctx.t * 0.004))]);
      }
      for (let k = edge.length - 1; k >= 0; k--) p.vertex(edge[k][0], edge[k][1]);
      p.endShape(p.CLOSE);
      ids.push(h * base);
    }
    kinds.forEach(([kind, n], i) => tag(p, ctx, `${n} ${kind}`, w * 0.16, ids[i], Math.max(8, Math.min(w, h) * 0.045), ctx.pal.text, 255 * EASE.outCubic((ctx.t - 20 - i * 10) / 30), true));
  };
}

export const SKETCHES = { ripple, constellation, flow, rain, bloom, orbit, aurora };

/** Which sketch illustrates an entry kind (exhibits-model KIND_LABEL keys). */
export const KIND_SKETCH = { intake: 'ripple', plan: 'constellation', step: 'flow', code: 'rain', result: 'bloom', milestone: 'orbit', summary: 'aurora' };
export const sketchFor = (kind) => KIND_SKETCH[kind] || 'flow';

// ------------------------------------------------------------------ mounting (browser only)

let p5Promise = null;
const loadP5 = () => (p5Promise ||= import('p5').then((m) => m.default || m).catch((e) => { p5Promise = null; throw e; }));

const live = new Set();

/** The theme changed: every live sketch re-reads the palette and repaints. */
export function refreshSketches() { for (const h of live) h.refresh(); }

/**
 * Draw sketch `id` into `host` (an element with a size). Returns a handle at once; p5 loads lazily and `onReady` fires
 * after the first frame, `onError` if p5 cannot load (the caller keeps its fallback picture). `reducedMotion()` (asked on
 * every frame) = draw one settled frame and stop; `refresh()` re-reads the theme and the motion setting.
 */
export function mountSketch(host, { id, seed = 1, info = null, reducedMotion = () => false, onReady = null, onError = null } = {}) {
  const def = SKETCHES[id] || SKETCHES.flow;
  const ctx = { t: 0, seed: hashSeed(seed), pal: readPalette(), info, reset: null };
  let inst = null; let dead = false; let ready = false; let first = true; let visible = true;
  let io = null; let ro = null; let raf = 0;

  const size = () => ({ w: Math.max(1, Math.floor(host.clientWidth / ctx.pal.px)), h: Math.max(1, Math.floor(host.clientHeight / ctx.pal.px)) });
  const still = () => reducedMotion();
  const wantRun = () => !dead && visible && !still();
  const sync = () => { if (!inst || !ready) return; if (wantRun()) inst.loop(); else inst.noLoop(); };
  const density = () => (ctx.pal.px > 1 ? 1 : Math.min(window.devicePixelRatio || 1, 2));

  function destroy() {
    if (dead) return;
    dead = true; live.delete(handle);
    cancelAnimationFrame(raf); io?.disconnect(); ro?.disconnect();
    try { inst?.remove(); } catch { /* already gone */ }
    inst = null;
  }

  /** Start the composition over (new size or palette): re-seed, and settle at once when motion is off. */
  function restart() {
    if (!inst || dead) return;
    ctx.t = 0; first = true; ctx.reset?.();
    inst.redraw();
    sync();
  }

  function layout() {
    if (!inst || dead) return;
    const { w, h } = size();
    if (w === inst.width && h === inst.height) return;
    inst.resizeCanvas(w, h, true);
    restart();
  }

  const handle = {
    destroy,
    refresh() {
      if (!inst || dead) return;
      ctx.pal = readPalette();
      inst.pixelDensity(density());
      const { w, h } = size();
      if (w !== inst.width || h !== inst.height) inst.resizeCanvas(w, h, true);
      restart();
    },
  };
  live.add(handle);

  loadP5().then((P5) => {
    if (dead) return;
    inst = new P5((p) => {
      def(p, ctx);
      const inner = p.draw;
      p.setup = () => {
        const { w, h } = size();
        p.pixelDensity(density());
        p.createCanvas(w, h).elt.setAttribute('aria-hidden', 'true');
        p.frameRate(30);
        ctx.reset?.();
      };
      p.draw = () => {
        if (!host.isConnected) { destroy(); return; }
        let n = 1;
        if (first) { first = false; if (still()) n = STILL_STEPS; }
        while (n-- > 0) { ctx.t++; inner(); }
        if (!ready) { ready = true; onReady?.(); }
        sync();
      };
    }, host);
    if (!ready) inst.redraw(); // p5 skips its first loop draw if it comes within a frame of setup: paint the poster frame now
    sync(); // setup (and maybe a draw) ran inside the constructor, before `inst` was assigned
    io = new IntersectionObserver((es) => { visible = es.at(-1).isIntersecting; sync(); });
    io.observe(host);
    ro = new ResizeObserver(() => { cancelAnimationFrame(raf); raf = requestAnimationFrame(layout); });
    ro.observe(host);
  }).catch((e) => { destroy(); onError?.(e); });

  return handle;
}
