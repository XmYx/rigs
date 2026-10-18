// The internal p5.js animation library (ui/src/p5-anim.js): its pure helpers, every sketch run against a fake `p` in
// Node (no browser, no p5), and static checks that the Exhibit window uses it. The live look is checked in a browser
// (see docs/playbooks/p5-sketch.md).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const A = await import('../ui/src/p5-anim.js');
const { KIND_LABEL } = await import('../ui/src/exhibits-model.js');

/** A p5 stand-in: every drawing call is recorded, math is real, anything unknown is a no-op. */
function fakeP(w = 320, h = 180) {
  const calls = [];
  let seed = 1;
  const base = {
    width: w, height: h, CENTER: 'center', CLOSE: 'close',
    random: (a, b) => { seed = (seed * 16807) % 2147483647; const r = seed / 2147483647; return a === undefined ? r : b === undefined ? r * a : a + r * (b - a); },
    randomSeed: (s) => { seed = (Math.abs(s) % 2147483646) + 1; },
    noise: (x, y = 0, z = 0) => 0.5 + 0.5 * Math.sin(x * 12.9898 + y * 78.233 + z * 37.719),
  };
  return new Proxy(base, {
    get(t, k) {
      if (k in t) return t[k];
      if (k === 'calls') return calls;
      return (...a) => { calls.push([k, ...a]); };
    },
    set(t, k, v) { t[k] = v; return true; },
  });
}

const PAL = A.paletteFrom((n) => ({ '--bg': '#04060a', '--accent-rgb': '45, 212, 191', '--accent-2-rgb': '94, 234, 212', '--text': '#d7e3ea', '--warn': '#fbbf24' }[n] ?? ''));

test('parseColor reads hex, "r, g, b" and rgb() and falls back', () => {
  assert.deepEqual(A.parseColor('#04060a'), [4, 6, 10]);
  assert.deepEqual(A.parseColor('#fa0'), [255, 170, 0]);
  assert.deepEqual(A.parseColor('45, 212, 191'), [45, 212, 191]);
  assert.deepEqual(A.parseColor('rgba(10 20 30 / 50%)'), [10, 20, 30]);
  assert.deepEqual(A.parseColor('', [1, 2, 3]), [1, 2, 3]);
  assert.deepEqual(A.parseColor('rebeccapurple', [1, 2, 3]), [1, 2, 3]);
});

test('paletteFrom takes the theme variables; --ex-pixel only counts between 2 and 8', () => {
  assert.deepEqual(PAL.a, [45, 212, 191]);
  assert.deepEqual(PAL.bg, [4, 6, 10]);
  assert.equal(PAL.px, 1);
  const atari = (px) => A.paletteFrom((n) => ({ '--ex-pixel': px, '--accent-rgb': '252, 148, 40' }[n] ?? ''));
  assert.equal(atari(' 4').px, 4);
  assert.equal(atari('1').px, 1);
  assert.equal(atari('99').px, 1);
  assert.equal(atari('').px, 1);
  assert.deepEqual(atari('4').a, [252, 148, 40]);
  assert.deepEqual(A.paletteFrom(() => '').a, [45, 212, 191], 'nothing set: the default theme');
});

test('easing curves start at 0, end at 1 and clamp', () => {
  for (const [name, f] of Object.entries(A.EASE)) {
    assert.ok(Math.abs(f(0)) < 1e-9, `${name}(0)`);
    assert.ok(Math.abs(f(1) - 1) < 1e-9, `${name}(1)`);
    assert.equal(f(-5), f(0), `${name} clamps below`);
    assert.equal(f(7), f(1), `${name} clamps above`);
  }
  assert.ok(A.EASE.outCubic(0.5) > 0.5 && A.EASE.inQuad(0.5) < 0.5);
  assert.ok(Math.max(...[...Array(101).keys()].map((i) => A.EASE.outBack(i / 100))) > 1, 'outBack overshoots');
});

test('mix, hash01 and hashSeed are deterministic', () => {
  assert.deepEqual(A.mix([0, 0, 0], [100, 200, 50], 0.5), [50, 100, 25]);
  assert.equal(A.hash01(3), A.hash01(3));
  assert.ok([1, 2, 3, 400, 5000].every((n) => A.hash01(n) >= 0 && A.hash01(n) < 1));
  assert.equal(A.hashSeed('span-1:end'), A.hashSeed('span-1:end'));
  assert.notEqual(A.hashSeed('a'), A.hashSeed('b'));
  assert.ok(Number.isInteger(A.hashSeed('')) && A.hashSeed('') > 0);
});

test('every entry kind has a sketch, and unknown kinds get one too', () => {
  for (const kind of Object.keys(KIND_LABEL)) assert.ok(A.SKETCHES[A.sketchFor(kind)], `sketch for ${kind}`);
  assert.ok(A.SKETCHES[A.sketchFor('nonsense')]);
  assert.deepEqual(Object.keys(A.SKETCHES).sort(), [...new Set(Object.values(A.KIND_SKETCH))].sort(), 'no sketch without a kind');
});

const INFO = A.contextFrom({ id: 'e1', kind: 'step', seq: 3, title: 'Migrate users table', caption: 'Dump 12 rows; rewrite schema; verify 100% copied' }, { title: 'Migration', total: 5, counts: { intake: 1, plan: 1, step: 2, result: 1 } });
const BAD_INFO = A.contextFrom({ id: 'e2', kind: 'result', seq: 5, title: 'Build failed', caption: 'error in 3 files' }, { total: 5, counts: { step: 4, result: 1 } });

test('contextFrom pulls keywords, numbers, steps, tone and position out of a card', () => {
  assert.deepEqual(INFO.words.slice(0, 3), ['Migrate', 'users', 'table']);
  assert.ok(!INFO.words.includes('and') && INFO.words.length <= 12);
  assert.deepEqual(INFO.nums, ['12', '100%']);
  assert.equal(INFO.steps.length, 3);
  assert.equal(INFO.tone, 'neutral');
  assert.equal(BAD_INFO.tone, 'bad');
  assert.equal(A.contextFrom({ title: 'Merged and shipped' }).tone, 'good');
  assert.equal(INFO.pos, 3 / 5);
  assert.equal(INFO.docTitle, 'Migration');
  const done = A.contextFrom({ kind: 'result', title: 't1 done: Fix the login timeout', caption: 'Fixed the crash; committed as bd41728; 660/660 pass', visual: { kind: 'status', items: [{ name: 't1', value: 'done', state: 'ok' }] } });
  assert.deepEqual(done.nums, ['660', '660'], 'no digits out of a task id or a commit hash');
  assert.equal(done.tone, 'good', 'a done task stays a check even when its summary says "timeout" or "crash"');
  assert.equal(A.contextFrom({ kind: 'milestone', title: 't2 blocked: Ship it', visual: { kind: 'status', items: [{ name: 't2', value: 'blocked', state: 'err' }] } }).tone, 'bad');
  const none = A.contextFrom();
  assert.deepEqual([none.words, none.nums, none.seq, none.pos], [[], [], 0, 0.5], 'an empty card is harmless');
});

test('a sketch shows what the card is about: its words are drawn as text, and the cards differ', () => {
  const texts = (id, info) => { const p = fakeP(); const ctx = { t: 0, seed: 5, pal: PAL, info, reset: null }; A.SKETCHES[id](p, ctx); ctx.reset?.(); for (let i = 0; i < 150; i++) { ctx.t++; p.draw(); } return p.calls.filter((c) => c[0] === 'text').map((c) => c[1]); };
  assert.ok(texts('ripple', INFO).some((t) => INFO.words.includes(t)), 'intake: keywords ride the rings');
  assert.ok(texts('constellation', INFO).length >= 3, 'plan: nodes are named');
  assert.ok(texts('flow', INFO).includes('03 / 05'), 'step: n / total');
  assert.ok(texts('orbit', INFO).includes('3 / 5'), 'milestone: n / total');
  assert.ok(texts('bloom', BAD_INFO).includes('3'), 'result: the number from the text');
  assert.ok(texts('aurora', INFO).includes('2 step'), 'summary: the kind mix');
  assert.notEqual(JSON.stringify(texts('ripple', INFO)), JSON.stringify(texts('ripple', BAD_INFO)));
  const bloomCalls = (info) => { const p = fakeP(); const ctx = { t: 0, seed: 5, pal: PAL, info, reset: null }; A.SKETCHES.bloom(p, ctx); for (let i = 0; i < 100; i++) { ctx.t++; p.draw(); } return JSON.stringify(p.calls); };
  assert.notEqual(bloomCalls(INFO), bloomCalls(BAD_INFO), 'a failed result draws a cross, not a check');
  const orbitTris = (info) => { const p = fakeP(); const ctx = { t: 0, seed: 5, pal: PAL, info, reset: null }; A.SKETCHES.orbit(p, ctx); for (let i = 0; i < 100; i++) { ctx.t++; p.draw(); } return JSON.stringify(p.calls.filter((c) => c[0] === 'triangle').at(-1)); };
  assert.notEqual(orbitTris({ ...INFO, tone: 'neutral' }), orbitTris({ ...INFO, tone: 'bad' }), 'a blocked milestone flies its flag at half-mast');
});

for (const [id, sketch] of Object.entries(A.SKETCHES)) {
  test(`sketch ${id} draws over time, inside bounds, in both themes and at tiny sizes`, () => {
    for (const [pal, w, h] of [[PAL, 320, 180], [{ ...PAL, px: 4 }, 80, 45], [PAL, 1, 1]]) {
      for (const info of [undefined, INFO, BAD_INFO]) {
      const p = fakeP(w, h);
      const ctx = { t: 0, seed: A.hashSeed(id), pal, info, reset: null };
      sketch(p, ctx);
      assert.equal(typeof p.draw, 'function', 'sets p.draw');
      ctx.reset?.();
      for (let i = 0; i < A.STILL_STEPS + 5; i++) { ctx.t++; p.draw(); }
      assert.ok(p.calls.length > 20, `${id} drew something (${p.calls.length} calls)`);
      for (const c of p.calls) for (const v of c.slice(1)) assert.ok(typeof v !== 'number' || Number.isFinite(v), `${id}: ${c[0]} got a non-finite number`);
      const bg = p.calls.filter((c) => c[0] === 'background' || (c[0] === 'rect' && c[3] >= w));
      assert.ok(bg.length > 0, `${id} paints its own background`);
      }
    }
  });
}

test('the same seed draws the same composition, another seed a different one', () => {
  const run = (seed) => { const p = fakeP(); const ctx = { t: 0, seed, pal: PAL, reset: null }; A.SKETCHES.constellation(p, ctx); ctx.reset(); for (let i = 0; i < 200; i++) { ctx.t++; p.draw(); } return JSON.stringify(p.calls); };
  assert.equal(run(7), run(7));
  assert.notEqual(run(7), run(8));
});

test('importing the library needs no DOM and does not load p5', () => {
  assert.equal(typeof globalThis.document, 'undefined');
  assert.equal(typeof A.mountSketch, 'function');
  assert.equal(typeof A.refreshSketches, 'function');
  A.refreshSketches(); // no live sketches: a no-op
});

test('the Exhibit window mounts sketches over SVG pictures only, cleans them up and follows the theme', () => {
  const win = read('ui/src/exhibits.js');
  assert.match(win, /from '\.\/p5-anim\.js'/);
  assert.match(win, /entry\.image\?\.source === 'svg'/, 'a ComfyUI picture is never covered');
  assert.match(win, /onTheme\(refreshSketches\)/);
  assert.match(win, /reducedMotion: \(\) => prefersReducedMotion\(\) \|\| st\.view === 'document'/);
  assert.match(win, /onClose: \(\) => \{[^}]*unmountAll\(\)/, 'closing the window ends every sketch');
  assert.match(win, /function renderAll\(\) \{\s*unmountAll\(\)/);
  assert.match(win, /unmount\(entry\.id\); \}; \/\/ the picture replaces the sketch/);
  const lib = read('ui/src/p5-anim.js');
  assert.match(lib, /import\('p5'\)/, 'p5 is a lazy import');
  assert.doesNotMatch(lib, /^import /m, 'no static imports: p5 stays out of the main bundle');
  assert.match(lib, /new IntersectionObserver/, 'paused when off screen');
  const css = read('ui/src/styles.css');
  assert.match(css, /\.ex-p5 \{[^}]*z-index: 1[\s\S]*\.ex-img-next\.in \{ z-index: 2; \}|\.ex-img-next\.in \{ z-index: 2; \}[\s\S]*\.ex-p5 \{[^}]*z-index: 1/);
  assert.match(css, /:root\[data-theme="atari"\] \{ --ex-pixel: 4; \}/, 'the Atari theme renders its sketches in pixels');
  assert.match(css, /@media print \{[\s\S]*\.ex-p5 \{ display: none !important; \}/, 'printing keeps the SVG picture');
  assert.equal(JSON.parse(read('package.json')).dependencies.p5.startsWith('^1.'), true, 'p5 stays on the 1.x line');
});
