#!/usr/bin/env node
// Smart scaling check: drives JARVIS in headless Chromium (Playwright from RIGS_AUDIT_TOOLS or ~/.cache/rigs-audit,
// as scripts/dock-check.js) through 1920x1080 → 1280x720 → 900x600 → back, and checks that with smart scaling on every
// visible panel and window stays fully inside the viewport, that it glides (and is instant under prefers-reduced-motion),
// that panels drift back to where they were put when the window grows, that a continuous drag-resize neither jitters
// nor costs a frame, that docked layouts and minimum overflows (scale below 1) fit too, that phones keep the mobile
// layout, and that with the mode off nothing changes. Screenshots go to screenshots/scale/.
//   node scripts/scale-check.js [--url http://127.0.0.1:4719/] [--out screenshots/scale]
// Without --url it starts a throwaway `rigs serve` (scratch RIGS_HOME, no OpenRig, no migrations, no autoupdate).
// Exit code 1 when a check fails.
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
const tools = [process.env.RIGS_AUDIT_TOOLS, path.join(os.homedir(), '.cache/rigs-audit'), ROOT].filter(Boolean);
let chromium = null;
for (const d of tools) { try { ({ chromium } = createRequire(path.join(path.resolve(d.replace(/^~/, os.homedir())), 'x.js'))('playwright')); break; } catch { /* next */ } }
if (!chromium) { console.error('playwright not found: install it outside the repo and set RIGS_AUDIT_TOOLS=<dir>'); process.exit(2); }
const OUT = path.resolve(opt('out', path.join(ROOT, 'screenshots/scale')));
fs.mkdirSync(OUT, { recursive: true });

async function startServer() {
  if (opt('url', '')) return { url: opt('url', ''), stop() {} };
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'rigs-scale-'));
  const port = await new Promise((resolve, reject) => { const s = net.createServer(); s.once('error', reject); s.listen(0, '127.0.0.1', () => { const { port: p } = s.address(); s.close(() => resolve(p)); }); });
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ port, openrig: { registerPeers: false } }));
  const child = spawn(process.execPath, ['bin/rigs.js', 'serve'], { cwd: ROOT, stdio: 'ignore', env: { ...process.env, RIGS_HOME: home, RIGS_PORT: String(port), RIGS_SSH_DIR: path.join(home, 'ssh'), RIGS_NO_MIGRATIONS: '1', RIGS_NO_AUTOUPDATE: '1', RIGS_NO_OPENRIG: '1' } });
  const url = `http://127.0.0.1:${port}/`;
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 500));
    try { if ((await fetch(url)).ok) return { url, stop: () => { child.kill(); fs.rmSync(home, { recursive: true, force: true }); } }; } catch { /* wait */ }
  }
  child.kill();
  throw new Error('rigs serve did not come up');
}
const server = await startServer();
const URL = server.url;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, ok, extra = '') => { results.push({ name, ok: !!ok }); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${extra ? ' — ' + extra : ''}`); };
const errors = [];

const HOME = { w: 1920, h: 1080 };
/** Panels the user put near the edges of a 1920x1080 screen (what would fall off a smaller one). */
const seeded = (extra = {}) => ({
  version: 1,
  root: { type: 'panel', id: 'stage' },
  floating: [
    { id: 'left', x: 12, y: 12, w: 270, h: 1056, z: 1, vw: HOME.w, vh: HOME.h },
    { id: 'legend', x: 1738, y: 12, w: 170, h: 272, z: 2, vw: HOME.w, vh: HOME.h },
    { id: 'work', x: 1500, y: 560, w: 380, h: 420, z: 3, vw: HOME.w, vh: HOME.h },
    { id: 'questions', x: 1090, y: 640, w: 360, h: 330, z: 4, vw: HOME.w, vh: HOME.h },
    { id: 'dock', x: 600, y: 940, w: 760, h: 110, z: 5, vw: HOME.w, vh: HOME.h },
  ],
  hidden: {},
  collapsed: [],
  ...extra,
});
const seedStorage = (ctx, entries) => ctx.addInitScript((e) => {
  if (sessionStorage.getItem('seeded')) return;
  sessionStorage.setItem('seeded', '1');
  for (const [k, v] of Object.entries(e)) localStorage.setItem(k, typeof v === 'string' ? v : JSON.stringify(v));
}, entries);

/** Every visible floating panel, window and docked panel with its rect, and whether it leaves the viewport. */
const audit = (page) => page.evaluate(() => {
  const vw = innerWidth;
  const vh = innerHeight;
  const seen = new Set();
  const out = [];
  for (const e of document.querySelectorAll('.floating, .win, [data-dock-id], .dock-tabs')) {
    if (seen.has(e)) continue;
    seen.add(e);
    const cs = getComputedStyle(e);
    if (cs.display === 'none' || cs.visibility === 'hidden') continue;
    const r = e.getBoundingClientRect();
    if (!r.width || !r.height) continue;
    out.push({ id: e.id || e.className.split(' ')[0], x: r.left, y: r.top, w: r.width, h: r.height, out: r.left < -0.5 || r.top < -0.5 || r.right > vw + 0.5 || r.bottom > vh + 0.5 });
  }
  return out;
});
const outside = (a) => a.filter((r) => r.out).map((r) => `${r.id} ${Math.round(r.x)},${Math.round(r.y)} ${Math.round(r.w)}x${Math.round(r.h)}`);
const rect = (page, sel) => page.evaluate((s) => { const b = document.querySelector(s)?.getBoundingClientRect(); return b && { x: b.left, y: b.top, w: b.width, h: b.height }; }, sel);
const resize = async (page, w, h, wait = 700) => { await page.setViewportSize({ width: w, height: h }); await sleep(wait); };

async function grab(page, sel) {
  return page.evaluate((s) => {
    const el = document.querySelector(s);
    const r = el.getBoundingClientRect();
    const y = r.top + Math.min(r.height / 2, 14);
    for (let x = r.left + 6; x < r.right - 4; x += 4) {
      const hit = document.elementFromPoint(x, y);
      if (hit && el.contains(hit) && !hit.closest('button,a,input,select,textarea,label,[role=button],[role=tab],.presize,.pgrip')) return { x, y };
    }
    return null;
  }, sel);
}
async function drag(page, from, to, steps = 14) {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  for (let i = 1; i <= steps; i++) { await page.mouse.move(from.x + ((to.x - from.x) * i) / steps, from.y + ((to.y - from.y) * i) / steps); await sleep(16); }
  await sleep(200);
  await page.mouse.up();
  await sleep(450);
}
async function open(browser, ctxOpts, entries, { url = URL, wait = '#panels-btn' } = {}) {
  const ctx = await browser.newContext(ctxOpts);
  if (entries) await seedStorage(ctx, entries);
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector(wait);
  await sleep(1500);
  return { ctx, page };
}
const toggleMenu = (page) => page.evaluate(() => document.getElementById('panels-btn').click()); // a parked window may cover the button
const setSwitch = async (page, sel, on) => {
  await toggleMenu(page);
  await sleep(250);
  await page.evaluate(([q, want]) => { const el = document.querySelector(q); if (el.checked !== want) el.click(); }, [sel, on]);
  await toggleMenu(page);
  await sleep(350);
};

const browser = await chromium.launch({ args: ['--no-sandbox'] });

// ------------------------------------------------------------------ desktop: off → on → resize through the sizes → back
{
  const { ctx, page } = await open(browser, { viewport: { width: HOME.w, height: HOME.h } }, { 'rigs.dock': seeded() });
  const flags = await page.evaluate(() => ({ cls: document.documentElement.className, probe: !!document.getElementById('fit-probe'), scaling: localStorage.getItem('rigs.scaling') }));
  check('off by default: no smart-scaling class, no probe, nothing stored', !/smart-scaling/.test(flags.cls) && !flags.probe && flags.scaling !== '1', JSON.stringify(flags));

  // A window the user parked in the lower right (640x400 at 1180,500).
  await page.click('#btn-sess');
  await page.waitForSelector('.win.sess-win');
  await sleep(700);
  await page.evaluate(() => { const w = document.querySelector('.win.sess-win'); w.style.width = '640px'; w.style.height = '400px'; }); // a window that fits a small screen once moved in
  await sleep(300);
  const wg = await grab(page, '.win.sess-win .win-bar');
  const w0 = await rect(page, '.win.sess-win');
  await drag(page, wg, { x: wg.x + (1180 - w0.x), y: wg.y + (500 - w0.y) });
  const base = await audit(page);
  check('1920x1080 baseline: everything on screen', !outside(base).length, outside(base).join(' | '));

  // Mode off: shrinking leaves panels and the window off screen (the "before").
  await resize(page, 900, 600);
  const offBefore = await audit(page);
  check('mode off @900x600: some panels and the window fall off screen (before)', outside(offBefore).length >= 2, outside(offBefore).join(' | '));
  check('mode off: no eased transitions or scaling classes', await page.evaluate(() => !/smart-scaling|fit-moving|fit-live/.test(document.documentElement.className)));
  await page.screenshot({ path: path.join(OUT, 'before-mode-off@900x600.png') });

  // Mode on from the ☰ menu.
  await resize(page, HOME.w, HOME.h, 500);
  await setSwitch(page, '#panels-menu .pm-scale input', true);
  check('Smart scaling switch persists', await page.evaluate(() => localStorage.getItem('rigs.scaling') === '1' && document.documentElement.classList.contains('smart-scaling')));
  const home = await audit(page);
  const moved = home.filter((r) => { const b = base.find((x) => x.id === r.id); return !b || Math.abs(b.x - r.x) > 1.5 || Math.abs(b.y - r.y) > 1.5 || Math.abs(b.w - r.w) > 1.5 || Math.abs(b.h - r.h) > 1.5; });
  check('mode on @1920x1080: nothing moved (identity at home)', !outside(home).length && !moved.length, JSON.stringify(moved));
  await page.screenshot({ path: path.join(OUT, 'smart-scaling@1920x1080.png') });

  // The window sits inside the layout now, with its home rect.
  check('window joined the layout with its home rect', await page.evaluate(() => JSON.parse(localStorage.getItem('rigs.dock')).floating.some((f) => f.id.startsWith('win-') && f.w > 300)));

  // Shrinking glides: sample mid-flight, then settled.
  await page.setViewportSize({ width: 1280, height: 720 });
  await sleep(90);
  const mid = await rect(page, '#work');
  const movingCls = await page.evaluate(() => document.documentElement.classList.contains('fit-moving'));
  await sleep(600);
  const a1280 = await audit(page);
  const end = await rect(page, '#work');
  check('1280x720: every panel and window inside the viewport', !outside(a1280).length, outside(a1280).join(' | '));
  check('a single resize glides (mid-flight differs from settled, .fit-moving on, then off)', movingCls && (Math.abs(mid.x - end.x) > 3 || Math.abs(mid.y - end.y) > 3 || Math.abs(mid.w - end.w) > 3) && !(await page.evaluate(() => document.documentElement.classList.contains('fit-moving'))), JSON.stringify({ mid, end, movingCls }));
  await page.screenshot({ path: path.join(OUT, 'smart-scaling@1280x720.png') });

  await resize(page, 900, 600);
  const a900 = await audit(page);
  check('900x600: every panel and window inside the viewport', !outside(a900).length, outside(a900).join(' | '));
  const win900 = a900.find((r) => /win/.test(r.id));
  check('900x600: the window was brought in, still usable (≥320x180)', win900 && win900.w >= 319 && win900.h >= 179, JSON.stringify(win900));
  await page.screenshot({ path: path.join(OUT, 'smart-scaling@900x600.png') });
  await page.screenshot({ path: path.join(OUT, 'after-mode-on@900x600.png') });
  const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('rigs.dock')).floating.find((f) => f.id === 'work'));
  check('fitted rects are never stored (the home stays 1500,560)', stored && stored.x === 1500 && stored.y === 560 && stored.w === 380, JSON.stringify(stored));

  // Growing again: panels drift back to where they were put.
  await resize(page, HOME.w, HOME.h, 800);
  const back = await audit(page);
  const drift = back.filter((r) => { const b = home.find((x) => x.id === r.id); return !b || Math.abs(b.x - r.x) > 2 || Math.abs(b.y - r.y) > 2 || Math.abs(b.w - r.w) > 2 || Math.abs(b.h - r.h) > 2; });
  check('back at 1920x1080: panels and window return to their home rects', !drift.length && !outside(back).length, JSON.stringify(drift));
  // A window bigger than the one they were placed on leaves them where they are.
  await resize(page, 2560, 1440, 800);
  const big = await audit(page);
  const placed = ['left', 'legend', 'work', 'questions', 'dock', 'dock-win-1'];
  const moved2 = big.filter((r) => { const b = home.find((x) => x.id === r.id); return placed.includes(r.id) && (!b || Math.abs(b.x - r.x) > 2 || Math.abs(b.y - r.y) > 2 || Math.abs(b.w - r.w) > 2); });
  check('2560x1440: panels stay where they were put (homes never stretch)', big.filter((r) => placed.includes(r.id)).length >= 5 && !moved2.length, JSON.stringify(moved2));
  await resize(page, HOME.w, HOME.h, 600);

  // Continuous drag-resize: panels follow the edge exactly (no jitter), never leave the screen, and cost under a frame.
  await page.evaluate(() => window.__rigsFit.reset());
  const trail = [];
  const steps = 48;
  // An in-page recorder samples the frame that answers each resize event, so the steps can follow each other
  // as fast as the browser takes them (the way a dragged window edge does) without a round trip to this script.
  await page.evaluate(() => {
    window.__trail = [];
    let events = 0;
    addEventListener('resize', () => { const mine = ++events; requestAnimationFrame(() => requestAnimationFrame(() => {
      if (mine !== events) return; // another resize arrived first: this frame answers a viewport that is already gone
      const vw = innerWidth;
      const vh = innerHeight;
      const rects = [...document.querySelectorAll('.floating, .win')].filter((e) => getComputedStyle(e).display !== 'none').map((e) => { const r = e.getBoundingClientRect(); return { id: e.id || 'win', x: r.left, y: r.top, r: r.right, b: r.bottom }; });
      window.__trail.push({ t: Math.round(performance.now()), vw, vh, live: document.documentElement.classList.contains('fit-live'), work: rects.find((r) => r.id === 'work'), bad: rects.filter((r) => r.x < -1 || r.y < -1 || r.r > vw + 1 || r.b > vh + 1).length, badIds: rects.filter((r) => r.x < -1 || r.y < -1 || r.r > vw + 1 || r.b > vh + 1).map((r) => `${r.id}@${Math.round(r.x)},${Math.round(r.y)}-${Math.round(r.r)},${Math.round(r.b)}/${vw}x${vh}`) });
    })); });
  });
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    await page.setViewportSize({ width: Math.round(HOME.w + (900 - HOME.w) * t), height: Math.round(HOME.h + (600 - HOME.h) * t) });
    await sleep(70);
  }
  await sleep(600);
  trail.push(...(await page.evaluate(() => window.__trail)));
  await sleep(500);
  const lagging = trail.filter((s, i) => i >= 3 && s.bad).length;
  check('drag-resize: the page answered the resize events (≥ 20 frames sampled)', trail.length >= 12, `${trail.length} samples`);
  check('drag-resize: .fit-live switches the transitions off after the first events', trail.slice(4).every((s) => s.live), `${trail.filter((s) => s.live).length}/${trail.length} live; step gaps ms: ${trail.slice(1).map((s, i) => s.t - trail[i].t).join(',')}`);
  check('drag-resize: panels stay on screen at every step', lagging === 0, `${lagging} steps with a panel outside; e.g. ${JSON.stringify(trail.filter((s, i) => i >= 3 && s.bad).slice(0, 3).map((s) => s.badIds))}`);
  let reversals = 0;
  for (let i = 1; i < trail.length; i++) if (trail[i].work && trail[i - 1].work && trail[i].work.x > trail[i - 1].work.x + 1) reversals++;
  check('drag-resize: no jitter (a panel never moves against the shrinking window)', reversals === 0, `${reversals} reversals`);
  check('after the drag: .fit-live and .fit-moving are gone', await page.evaluate(() => !/fit-live|fit-moving/.test(document.documentElement.className)));
  const fin = await audit(page);
  check('end of the drag @900x600: all inside', !outside(fin).length, outside(fin).join(' | '));
  const stats = await page.evaluate(() => window.__rigsFit.stats());
  const f = (n) => n.toFixed(2);
  console.log(`TIMING resize handler over ${stats.runs} renders: total mean ${f(stats.total.mean)} ms, p95 ${f(stats.total.p95)} ms, max ${f(stats.total.max)} ms; solver+measure mean ${f(stats.solve.mean)} ms, p95 ${f(stats.solve.p95)} ms, max ${f(stats.solve.max)} ms`);
  fs.writeFileSync(path.join(OUT, 'timing.json'), JSON.stringify({ at: new Date().toISOString().slice(0, 10), renders: stats.runs, totalMs: stats.total, solveMs: stats.solve, note: 'headless Chromium, software rendering, 48-step drag-resize 1920x1080 → 900x600' }, null, 2));
  check('resize handler under one frame of main-thread work (p95 < 16.6 ms)', stats.runs >= 20 && stats.total.p95 < 16.6, `p95 ${f(stats.total.p95)} ms, max ${f(stats.total.max)} ms`);

  // Reload keeps the mode; switching it off puts back the old behaviour.
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#panels-btn');
  await sleep(1500);
  check('mode survives a reload', await page.evaluate(() => document.documentElement.classList.contains('smart-scaling')));
  const reloaded = await audit(page);
  check('reload @900x600: panels fitted on load', !outside(reloaded).length, outside(reloaded).join(' | '));
  await setSwitch(page, '#panels-menu .pm-scale input', false);
  await sleep(500);
  check('switching off: class gone, switch off persisted', await page.evaluate(() => !document.documentElement.classList.contains('smart-scaling') && localStorage.getItem('rigs.scaling') === '0'));
  await ctx.close();
}

// ------------------------------------------------------------------ prefers-reduced-motion: instant
{
  const { ctx, page } = await open(browser, { viewport: { width: HOME.w, height: HOME.h }, reducedMotion: 'reduce' }, { 'rigs.dock': seeded(), 'rigs.scaling': '1' });
  await page.setViewportSize({ width: 900, height: 600 });
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  await sleep(60);
  const early = await audit(page);
  const dur = await page.evaluate(() => getComputedStyle(document.querySelector('#work')).transitionDuration);
  check('reduced motion: inside the viewport within a few frames (no glide)', !outside(early).length, outside(early).join(' | '));
  check('reduced motion: no left/top/width transition on panels', await page.evaluate(() => { const cs = getComputedStyle(document.querySelector('#work')); return !/left|top|width|height|transform/.test(cs.transitionProperty) || /^0s(, 0s)*$/.test(cs.transitionDuration); }), dur);
  await ctx.close();
}

// ------------------------------------------------------------------ docked tree + tab strips
{
  const docked = seeded({
    root: { type: 'split', dir: 'row', ratios: [0.22, 0.56, 0.22], children: [
      { type: 'tabs', panels: ['left', 'legend'], active: 'left' }, { type: 'panel', id: 'stage' },
      { type: 'split', dir: 'column', ratios: [0.5, 0.5], children: [{ type: 'panel', id: 'work' }, { type: 'tabs', panels: ['questions', 'dock'], active: 'questions' }] }] },
    floating: [],
  });
  const { ctx, page } = await open(browser, { viewport: { width: HOME.w, height: HOME.h } }, { 'rigs.dock': docked, 'rigs.docking': '1', 'rigs.scaling': '1' });
  const a0 = await audit(page);
  check('docked @1920x1080: docked panels and tab strips drawn inside', a0.some((r) => r.id === 'left') && !outside(a0).length, outside(a0).join(' | '));
  for (const [w, h] of [[1280, 720], [900, 600]]) {
    await resize(page, w, h);
    const a = await audit(page);
    check(`docked @${w}x${h}: every docked panel and tab strip inside`, !outside(a).length && a.some((r) => r.id === 'left'), outside(a).join(' | '));
    await page.screenshot({ path: path.join(OUT, `docked@${w}x${h}.png`) });
  }
  // Splitters keep up with the panels.
  const seps = await page.evaluate(() => [...document.querySelectorAll('.dock-split')].map((s) => { const b = s.getBoundingClientRect(); return b.right <= innerWidth + 0.5 && b.bottom <= innerHeight + 0.5 && b.left >= -4 && b.top >= -4; }));
  check('docked @900x600: splitters inside the viewport', seps.length >= 2 && seps.every(Boolean), JSON.stringify(seps));
  await resize(page, HOME.w, HOME.h, 800);
  const a1 = await audit(page);
  const l0 = a0.find((r) => r.id === 'left');
  const l1 = a1.find((r) => r.id === 'left');
  check('docked: back at 1920x1080 the tree is as it was', l1 && Math.abs(l0.x - l1.x) < 2 && Math.abs(l0.w - l1.w) < 2 && Math.abs(l0.h - l1.h) < 2, JSON.stringify({ l0, l1 }));
  await ctx.close();
}

// ------------------------------------------------------------------ minimums that overflow → the shared scale below 1
{
  const { ctx, page } = await open(browser, { viewport: { width: 1000, height: 170 } }, { 'rigs.dock': seeded({ floating: [] }), 'rigs.scaling': '1' });
  await page.click('#btn-sess').catch(() => {});
  await page.waitForSelector('.win.sess-win', { timeout: 4000 }).catch(() => {});
  await sleep(900);
  const w = await page.evaluate(() => {
    const scaleOf = (e) => { const v = getComputedStyle(e).scale; return v === 'none' ? 1 : parseFloat(v); };
    const el = document.querySelector('.win.sess-win');
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.left, y: r.top, r: r.right, b: r.bottom, scale: scaleOf(el), vw: innerWidth, vh: innerHeight };
  });
  check('minimum taller than the screen: the window is drawn scaled and stays inside', w && w.scale < 0.99 && w.x >= -0.5 && w.y >= -0.5 && w.r <= w.vw + 0.5 && w.b <= w.vh + 0.5, JSON.stringify(w));
  await resize(page, 1000, 700, 900);
  const w2 = await page.evaluate(() => { const scaleOf = (e) => { const v = getComputedStyle(e).scale; return v === 'none' ? 1 : parseFloat(v); }; const el = document.querySelector('.win.sess-win'); const r = el?.getBoundingClientRect(); return r && { scale: scaleOf(el), w: r.width, h: r.height }; });
  check('taller screen again: scale back to 1', w2 && Math.abs(w2.scale - 1) < 0.01, JSON.stringify(w2));
  await ctx.close();
}

// ------------------------------------------------------------------ phone: keeps the mobile layout
{
  const { ctx, page } = await open(browser, { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 }, { 'rigs.dock': seeded(), 'rigs.scaling': '1' }, { wait: '#btn-more' });
  const ph = await page.evaluate(() => ({ cls: document.documentElement.className, probe: !!document.getElementById('fit-probe'), inline: [...document.querySelectorAll('.floating')].filter((e) => e.style.scale).length, hscroll: document.documentElement.scrollWidth > innerWidth }));
  check('phone: no scaling class, no probe, no scaled panels, no sideways scroll', !/smart-scaling/.test(ph.cls) && !ph.probe && ph.inline === 0 && !ph.hscroll, JSON.stringify(ph));
  await page.screenshot({ path: path.join(OUT, 'smart-scaling@390x844.png') });
  await page.tap('#btn-more');
  await sleep(400);
  await page.tap('#more-sheet #panels-btn');
  await sleep(400);
  check('phone: ☰ menu hides the Smart scaling switch', await page.evaluate(() => document.querySelector('#panels-menu .pm-scale').hidden));
  await ctx.close();
}

await browser.close();
check('no page errors', !errors.length, errors.join(' | '));
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
server.stop();
process.exit(failed.length ? 1 : 0);
