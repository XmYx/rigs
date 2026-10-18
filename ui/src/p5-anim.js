// The internal p5.js animation library. The Exhibit window (exhibits.js) draws one small looping sketch per card
// instead of a static picture; this file is the whole kit, so other surfaces can reuse it:
//   mountSketch(host, { id, seed, reducedMotion, onReady, onError }) → { destroy, refresh() }
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

// ------------------------------------------------------------------ the sketches

/** intake — rings leaving a glowing core: a request arriving. */
function ripple(p, ctx) {
  const PERIOD = 34;
  const LIFE = 150;
  p.draw = () => {
    const { bg, a, b } = ctx.pal;
    const w = p.width; const h = p.height; const s = Math.min(w, h);
    p.background(bg[0], bg[1], bg[2]);
    p.noFill();
    const last = Math.floor(ctx.t / PERIOD);
    for (let k = 0; k < 5; k++) {
      const i = last - k;
      const age = (ctx.t - i * PERIOD) / LIFE;
      if (i < 0 || age > 1) continue;
      strokeC(p, mix(a, b, age), 255 * (1 - age));
      p.strokeWeight(Math.max(1, s * 0.014 * (1 - age)));
      p.circle(w / 2, h / 2, EASE.outCubic(age) * Math.hypot(w, h) * 0.8);
    }
    const pulse = 1 + 0.14 * Math.sin(ctx.t * 0.12);
    p.noStroke();
    fillC(p, a, 70); p.circle(w / 2, h / 2, s * 0.2 * pulse);
    fillC(p, b); p.circle(w / 2, h / 2, s * 0.055);
  };
}

/** plan — nodes appear and link up one after the other, then a pulse travels the chain: a blueprint being drawn. */
function constellation(p, ctx) {
  const N = 9;
  let nodes = [];
  ctx.reset = () => {
    p.randomSeed(ctx.seed);
    nodes = Array.from({ length: N }, (_, i) => ({ x: (i + 0.5 + (p.random() - 0.5) * 0.5) / N, y: 0.22 + 0.56 * p.random(), ph: p.random(TAU) }));
  };
  const at = (n, t) => ({ x: (n.x + 0.012 * Math.sin(t * 0.02 + n.ph)) * p.width, y: (n.y + 0.02 * Math.cos(t * 0.017 + n.ph)) * p.height });
  p.draw = () => {
    const { bg, a, b } = ctx.pal;
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
    if (prog >= N - 1) { // the pulse
      const u = (ctx.t * 0.025) % (N - 1);
      const i = Math.floor(u);
      const p0 = at(nodes[i], ctx.t); const p1 = at(nodes[i + 1], ctx.t);
      fillC(p, ctx.pal.text); p.circle(p0.x + (p1.x - p0.x) * (u - i), p0.y + (p1.y - p0.y) * (u - i), s * 0.03);
    }
  };
}

/** step — particles drifting along a noise field, leaving fading trails: machinery in motion. */
function flow(p, ctx) {
  const COUNT = 80;
  let ps = [];
  let clear = true;
  ctx.reset = () => {
    p.randomSeed(ctx.seed); p.noiseSeed(ctx.seed);
    ps = Array.from({ length: COUNT }, (_, i) => ({ x: p.random(), y: p.random(), px: 0, py: 0, life: p.random(80, 260), c: i % 3 }));
    for (const q of ps) { q.px = q.x; q.py = q.y; }
    clear = true;
  };
  p.draw = () => {
    const { bg, a, b } = ctx.pal;
    const w = p.width; const h = p.height;
    if (clear) { p.background(bg[0], bg[1], bg[2]); clear = false; }
    p.noStroke(); p.fill(bg[0], bg[1], bg[2], 26); p.rect(0, 0, w, h);
    p.strokeWeight(Math.max(1, Math.min(w, h) * 0.008));
    for (const q of ps) {
      const ang = p.noise(q.x * 2.4, q.y * 2.4, ctx.t * 0.004) * TAU * 2;
      q.px = q.x; q.py = q.y;
      q.x += Math.cos(ang) * 0.004; q.y += Math.sin(ang) * 0.004 * (w / h);
      strokeC(p, q.c === 2 ? ctx.pal.text : q.c ? b : a, 210);
      p.line(q.px * w, q.py * h, q.x * w, q.y * h);
      if (--q.life < 0 || q.x < 0 || q.x > 1 || q.y < 0 || q.y > 1) { q.x = p.random(); q.y = p.random(); q.px = q.x; q.py = q.y; q.life = p.random(80, 260); }
    }
  };
}

const GLYPHS = '01{}[]<>/=;+-*#';

/** code — columns of glyphs falling with a bright head (blocks in a pixel theme): luminous code on glass. */
function rain(p, ctx) {
  const TAIL = 9;
  p.draw = () => {
    const { bg, a, b } = ctx.pal;
    const blocks = ctx.pal.px > 1;
    const cell = blocks ? 5 : 14;
    const cols = Math.ceil(p.width / cell); const rows = Math.ceil(p.height / cell);
    p.background(bg[0], bg[1], bg[2]);
    p.noStroke();
    if (!blocks) { p.textFont('monospace'); p.textSize(cell - 2); p.textAlign(p.CENTER, p.CENTER); }
    for (let c = 0; c < cols; c++) {
      const speed = 0.05 + hash01(c + ctx.seed) * 0.12;
      const head = Math.floor(ctx.t * speed + hash01(c * 3 + ctx.seed) * (rows + TAIL)) % (rows + TAIL);
      for (let d = 0; d < TAIL; d++) {
        const r = head - d;
        if (r < 0 || r >= rows) continue;
        const col = d === 0 ? ctx.pal.text : d < 3 ? b : a;
        const alpha = 255 * (1 - d / TAIL) ** 1.5;
        fillC(p, col, alpha);
        if (blocks) p.rect(c * cell, r * cell, cell - 1, cell - 1);
        else p.text(GLYPHS[Math.floor(hash01(c * 97 + r * 13 + (d < 2 ? Math.floor(ctx.t / 7) : 0)) * GLYPHS.length)], c * cell + cell / 2, r * cell + cell / 2);
      }
    }
  };
}

/** result — a burst of rays settling into a ring, then a check mark drawn in: something finished. */
function bloom(p, ctx) {
  const RAYS = 40;
  p.draw = () => {
    const { bg, a, b } = ctx.pal;
    const w = p.width; const h = p.height; const s = Math.min(w, h);
    p.background(bg[0], bg[1], bg[2]);
    const burst = EASE.outBack(ctx.t / 70);
    const breathe = 1 + 0.03 * Math.sin(ctx.t * 0.08);
    p.push(); p.translate(w / 2, h / 2);
    p.strokeWeight(Math.max(1, s * 0.008));
    for (let i = 0; i < RAYS; i++) {
      const ang = (i / RAYS) * TAU;
      const len = s * (0.3 + 0.2 * hash01(i + ctx.seed)) * burst;
      strokeC(p, i % 2 ? a : b, 170 * (1 - 0.4 * hash01(i * 5)));
      p.line(Math.cos(ang) * s * 0.28 * breathe, Math.sin(ang) * s * 0.28 * breathe, Math.cos(ang) * len, Math.sin(ang) * len);
    }
    p.noFill(); strokeC(p, b); p.strokeWeight(Math.max(2, s * 0.02));
    p.circle(0, 0, s * 0.5 * burst * breathe);
    const k = EASE.outCubic((ctx.t - 40) / 40); // the check mark: two strokes, drawn along
    const pts = [[-0.1, 0.01], [-0.03, 0.08], [0.11, -0.08]].map(([x, y]) => [x * s, y * s]);
    strokeC(p, ctx.pal.text); p.strokeWeight(Math.max(2, s * 0.025));
    const first = clamp01(k * 2); const second = clamp01(k * 2 - 1);
    if (first > 0) p.line(pts[0][0], pts[0][1], pts[0][0] + (pts[1][0] - pts[0][0]) * first, pts[0][1] + (pts[1][1] - pts[0][1]) * first);
    if (second > 0) p.line(pts[1][0], pts[1][1], pts[1][0] + (pts[2][0] - pts[1][0]) * second, pts[1][1] + (pts[2][1] - pts[1][1]) * second);
    p.pop();
  };
}

/** milestone — three tilted orbits around a core with a pennant rising on it: a flag planted. */
function orbit(p, ctx) {
  p.draw = () => {
    const { bg, a, b } = ctx.pal;
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
      const ang = ctx.t * (0.02 + i * 0.008) + i * 2;
      p.noStroke(); fillC(p, i % 2 ? a : b); p.circle(Math.cos(ang) * s * 0.43, Math.sin(ang) * s * 0.15, s * 0.04);
      p.pop();
    });
    p.noStroke(); fillC(p, a, 50); p.circle(0, 0, s * 0.3); fillC(p, b, 120); p.circle(0, 0, s * 0.18);
    const k = EASE.outBack((ctx.t - 10) / 50); // the pennant
    const top = -s * 0.2 * k;
    strokeC(p, ctx.pal.text); p.strokeWeight(Math.max(1, s * 0.008)); p.line(0, 0, 0, top);
    p.noStroke(); fillC(p, ctx.pal.warn);
    p.triangle(0, top, s * 0.1 * k, top + s * 0.035 * k, 0, top + s * 0.07 * k);
    p.pop();
  };
}

/** summary — layered noise ribbons: a finished control room. */
function aurora(p, ctx) {
  p.draw = () => {
    const { bg, a, b } = ctx.pal;
    const w = p.width; const h = p.height;
    p.background(bg[0], bg[1], bg[2]);
    p.noStroke();
    const step = Math.max(4, Math.round(w / 70));
    for (let i = 0; i < 4; i++) {
      fillC(p, mix(a, b, i / 3), 46);
      p.beginShape();
      const edge = [];
      for (let x = 0; x <= w + step; x += step) {
        const y = h * (0.28 + 0.1 * i) + (p.noise(x * 0.004 + i * 7 + ctx.seed, ctx.t * 0.006) - 0.5) * h * 0.55;
        p.vertex(x, y);
        edge.push([x, y + h * (0.12 + 0.1 * p.noise(x * 0.006, i * 3 + ctx.t * 0.004))]);
      }
      for (let k = edge.length - 1; k >= 0; k--) p.vertex(edge[k][0], edge[k][1]);
      p.endShape(p.CLOSE);
    }
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
export function mountSketch(host, { id, seed = 1, reducedMotion = () => false, onReady = null, onError = null } = {}) {
  const def = SKETCHES[id] || SKETCHES.flow;
  const ctx = { t: 0, seed: hashSeed(seed), pal: readPalette(), reset: null };
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
