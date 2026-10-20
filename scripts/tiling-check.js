#!/usr/bin/env node
// Window tiling check: drives JARVIS in headless Chromium (Playwright from RIGS_AUDIT_TOOLS or ~/.cache/rigs-audit, as
// scripts/dock-check.js) and checks macOS-style tiling end to end, saving screenshots: the drag preview at a corner,
// snapping on release, dragging a tiled window off (old size, grab point kept), top-centre fill, two windows left /
// right, four quarters from the keyboard, Window › Tile, keys ignored in a text field, restore, re-fit on resize,
// docking layout on (edges still dock, corners tile), reduced motion, and a 390x844 phone with no tiling.
//   node scripts/tiling-check.js [--url http://127.0.0.1:4719/] [--out screenshots/tiling]
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
const OUT = path.resolve(opt('out', path.join(ROOT, 'screenshots/tiling')));
fs.mkdirSync(OUT, { recursive: true });

async function startServer() {
  if (opt('url', '')) return { url: opt('url', ''), stop() {} };
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'rigs-tiling-'));
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
process.on('exit', () => server.stop()); // also when a step throws
const URL = server.url;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, ok, extra = '') => { results.push({ name, ok: !!ok }); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${extra && !ok ? ' — ' + extra : ''}`); };
const near = (a, b, tol = 2) => !!a && !!b && ['x', 'y', 'w', 'h'].every((k) => Math.abs(a[k] - b[k]) <= tol);

const rect = (page, sel) => page.evaluate((s) => { const b = document.querySelector(s)?.getBoundingClientRect(); return b && { x: b.left, y: b.top, w: b.width, h: b.height }; }, sel);
/** A point on a window's bar that is not a control. */
const grab = (page, sel) => page.evaluate((s) => {
  const el = document.querySelector(s);
  const r = el.getBoundingClientRect();
  const y = r.top + 14;
  for (let x = r.left + 60; x < r.right - 4; x += 4) {
    const hit = document.elementFromPoint(x, y);
    if (hit && el.contains(hit) && !hit.closest('button,a,input,select,textarea,label,[role=button]')) return { x, y };
  }
  return null;
}, sel);
/** The usable area as docking.js computes it (dockArea): 8px pad, below --mb-h, clear of --ad-*. */
const area = (page) => page.evaluate(() => {
  const v = (n) => { const x = parseFloat(getComputedStyle(document.documentElement).getPropertyValue(n)); return Number.isFinite(x) && x > 0 ? x : 0; };
  const t = v('--mb-h'); const l = v('--ad-l'); const r = v('--ad-r'); const b = v('--ad-b');
  return { x: 8 + l, y: 8 + t, w: innerWidth - 16 - l - r, h: innerHeight - 16 - t - b };
});
const zone = (a, z) => {
  const lw = Math.floor((a.w - 8) / 2);
  const th = Math.floor((a.h - 8) / 2);
  return {
    left: { x: a.x, y: a.y, w: lw, h: a.h }, right: { x: a.x + lw + 8, y: a.y, w: a.w - 8 - lw, h: a.h },
    'top-left': { x: a.x, y: a.y, w: lw, h: th }, 'top-right': { x: a.x + lw + 8, y: a.y, w: a.w - 8 - lw, h: th },
    'bottom-left': { x: a.x, y: a.y + th + 8, w: lw, h: a.h - 8 - th }, 'bottom-right': { x: a.x + lw + 8, y: a.y + th + 8, w: a.w - 8 - lw, h: a.h - 8 - th },
    fill: a,
  }[z];
};
const isTiled = (page, sel) => page.evaluate((s) => document.querySelector(s).classList.contains('tiled'), sel);

async function drag(page, from, to, { steps = 16, shot = null, hold = false, dwell = 320 } = {}) {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  for (let i = 1; i <= steps; i++) { await page.mouse.move(from.x + ((to.x - from.x) * i) / steps, from.y + ((to.y - from.y) * i) / steps); await sleep(16); }
  await sleep(dwell);
  if (shot) await page.screenshot({ path: path.join(OUT, shot) });
  if (!hold) { await page.mouse.up(); await sleep(400); }
}

/** Open a window through the UI and return its selector. */
async function openWin(page, how) {
  const before = await page.evaluate(() => [...document.querySelectorAll('.win[data-win-id]')].map((w) => w.dataset.winId));
  await how();
  await page.waitForFunction((b) => [...document.querySelectorAll('.win[data-win-id]')].some((w) => !b.includes(w.dataset.winId)), before);
  await sleep(650);
  const id = await page.evaluate((b) => [...document.querySelectorAll('.win[data-win-id]')].find((w) => !b.includes(w.dataset.winId)).dataset.winId, before);
  return `.win[data-win-id="${id}"]`;
}
async function menuItem(page, top, label) {
  await page.click(`#mb-top-${top}`);
  await sleep(250);
  await page.locator('.mb-menu .mb-item', { hasText: label }).first().click();
  await sleep(300);
}
const openShortcuts = (page) => openWin(page, () => menuItem(page, 'help', 'Keyboard shortcuts'));
const openAbout = (page) => openWin(page, () => menuItem(page, 'help', 'About RIGS'));
const openRegistry = (page) => openWin(page, () => menuItem(page, 'tools', 'Tool registry'));
const openSessions = (page) => openWin(page, () => menuItem(page, 'file', 'Open session'));
/** Put a window in front and focus one of its buttons (not a text field), so shortcuts act on it. */
const focusWin = (page, sel) => page.evaluate((s) => { const w = document.querySelector(s); w._wm.raise(); w.querySelector('.win-btn').focus(); }, sel);
const press = async (page, chord) => { await page.keyboard.press(chord); await sleep(380); };
const closeAll = (page) => page.evaluate(() => { for (const b of document.querySelectorAll('.win .win-btn.close')) b.click(); });

const browser = await chromium.launch({ args: ['--no-sandbox'] });
const errors = [];

// ------------------------------------------------------------------ desktop 1440x900, docking off
{
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(URL, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#menubar');
  await sleep(1500);
  const A = await area(page);

  // (1) Drag a window to the top-left corner: preview after the dwell, snaps to the quarter on release.
  const w1 = await openSessions(page);
  const before = await rect(page, w1);
  const g = await grab(page, w1);
  await drag(page, g, { x: 3, y: 3 }, { shot: 'drag-preview-corner.png', hold: true });
  const pv = await page.evaluate(() => { const p = document.querySelector('.dock-overlay.tile .dock-preview.show'); const b = p?.getBoundingClientRect(); return b && { x: b.left, y: b.top, w: b.width, h: b.height }; });
  const pvLabel = await page.evaluate(() => document.querySelector('.dock-label.show')?.textContent);
  check('corner drag shows the tile preview at the top-left quarter', near(pv, zone(A, 'top-left'), 1.5), JSON.stringify({ pv, want: zone(A, 'top-left') }));
  check('no docking compass while tiling', !(await page.evaluate(() => document.querySelector('.dock-compass.show'))));
  check('the preview label names the zone', /quarter/i.test(pvLabel || ''), pvLabel);
  await page.mouse.up();
  await sleep(450);
  check('release snaps to the quarter', near(await rect(page, w1), zone(A, 'top-left')), JSON.stringify(await rect(page, w1)));

  // Dragging the tiled window away: old size, grab point under the pointer, no longer tiled.
  const g0 = await grab(page, w1);
  await drag(page, g0, { x: 700, y: 400 });
  const free = await rect(page, w1);
  check('dragging a tiled window away restores its pre-tile size', Math.abs(free.w - before.w) < 2 && Math.abs(free.h - before.h) < 2, JSON.stringify({ free, before }));
  check('…with the grab point still under the pointer', free.x <= 700 && free.x + free.w >= 700 && free.y <= 400 && free.y + 40 >= 400, JSON.stringify(free));
  check('…and it is no longer tiled', !(await isTiled(page, w1)));
  // Passing over an edge and back out: the preview goes away and nothing tiles.
  const g1 = await grab(page, w1);
  await drag(page, g1, { x: 2, y: 450 }, { hold: true });
  const shownAtEdge = await page.evaluate(() => !!document.querySelector('.dock-overlay.tile .dock-preview.show'));
  await page.mouse.move(400, 450, { steps: 6 });
  await sleep(250);
  const shownAfter = await page.evaluate(() => !!document.querySelector('.dock-preview.show'));
  await page.mouse.up();
  await sleep(400);
  check('leaving an edge again hides the preview and does not tile', shownAtEdge && !shownAfter && !(await isTiled(page, w1)), JSON.stringify({ shownAtEdge, shownAfter }));

  // (2) Top-centre fills; restore from the keyboard; double-click still maximises as before.
  const preFill = await rect(page, w1);
  const g2 = await grab(page, w1);
  await drag(page, g2, { x: 720, y: 4 }, { shot: 'drag-preview-fill.png', hold: true });
  check('top-centre drag previews fill', near(await page.evaluate(() => { const b = document.querySelector('.dock-overlay.tile .dock-preview.show')?.getBoundingClientRect(); return b && { x: b.left, y: b.top, w: b.width, h: b.height }; }), A, 1.5));
  await page.mouse.up();
  await sleep(450);
  check('top-centre drop fills the usable area', near(await rect(page, w1), A), JSON.stringify(await rect(page, w1)));
  const beforeFill = await rect(page, w1);
  await focusWin(page, w1);
  await press(page, 'Control+Alt+r');
  const restored = await rect(page, w1);
  check('Ctrl+Alt+R returns to the previous size and place (where the drag started)', near(restored, preFill) && !near(restored, beforeFill), JSON.stringify({ restored, preFill }));
  const g3 = await grab(page, w1);
  await page.mouse.dblclick(g3.x, g3.y);
  await sleep(300);
  const maxed = await page.evaluate((s) => document.querySelector(s).classList.contains('max'), w1);
  const g4 = await grab(page, w1);
  await page.mouse.dblclick(g4.x, g4.y);
  await sleep(300);
  check('double-click on the bar still maximises and restores', maxed && !(await page.evaluate((s) => document.querySelector(s).classList.contains('max'), w1)));

  // (3) Two windows left / right: one by dragging to the left edge, one from the keyboard.
  const g5 = await grab(page, w1);
  await drag(page, g5, { x: 2, y: 450 });
  const w2 = await openShortcuts(page);
  await focusWin(page, w2);
  await press(page, 'Control+Alt+ArrowRight');
  check('left edge drag = left half', near(await rect(page, w1), zone(A, 'left')), JSON.stringify(await rect(page, w1)));
  check('Ctrl+Alt+→ = right half', near(await rect(page, w2), zone(A, 'right')), JSON.stringify(await rect(page, w2)));
  await page.screenshot({ path: path.join(OUT, 'two-halves.png') });

  // (4) Four quarters from the keyboard.
  const w3 = await openAbout(page);
  const w4 = await openRegistry(page);
  for (const [sel, chord, z] of [[w1, 'Control+Alt+u', 'top-left'], [w2, 'Control+Alt+i', 'top-right'], [w3, 'Control+Alt+j', 'bottom-left'], [w4, 'Control+Alt+k', 'bottom-right']]) {
    await focusWin(page, sel);
    await press(page, chord);
    check(`${chord} = ${z} quarter`, near(await rect(page, sel), zone(A, z)), JSON.stringify(await rect(page, sel)));
  }
  await page.screenshot({ path: path.join(OUT, 'four-quarters.png') });

  // (5) Keys do nothing while typing in a text field (the Tool registry search box).
  const r4 = await rect(page, w4);
  await page.focus(`${w4} input[type=search]`);
  await press(page, 'Control+Alt+ArrowLeft');
  check('tiling keys do nothing inside a text field', near(await rect(page, w4), r4), JSON.stringify(await rect(page, w4)));

  // (6) Window › Tile lists the actions with their shortcuts, and runs them on the frontmost window (w4).
  await page.click('#mb-top-window');
  await sleep(250);
  await page.locator('.mb-menu .mb-item.has-sub').filter({ has: page.locator('.mb-label', { hasText: /^Tile$/ }) }).first().hover();
  await sleep(450);
  const tileMenu = await page.evaluate(() => [...document.querySelectorAll('.mb-menu.mb-sub .mb-item')].map((i) => `${i.querySelector('.mb-label')?.textContent}|${i.querySelector('.mb-sc')?.textContent || ''}`));
  await page.screenshot({ path: path.join(OUT, 'window-tile-menu.png') });
  check('Window › Tile lists halves, quarters, fill and restore with shortcuts', tileMenu.length === 10 && tileMenu.includes('Left half|Ctrl+Alt+←') && tileMenu.includes('Fill|Ctrl+Alt+Enter'), JSON.stringify(tileMenu));
  await page.locator('.mb-menu.mb-sub .mb-item', { hasText: 'Left half' }).click();
  await sleep(400);
  check('a Tile menu item tiles the frontmost window', near(await rect(page, w4), zone(A, 'left')), JSON.stringify(await rect(page, w4)));

  // (7) Viewport resize: tiled windows re-fit to their zone.
  await page.setViewportSize({ width: 1200, height: 800 });
  await sleep(500);
  const A2 = await area(page);
  check('after a resize, a tiled quarter re-fits to its zone', near(await rect(page, w1), zone(A2, 'top-left')), JSON.stringify({ got: await rect(page, w1), want: zone(A2, 'top-left') }));
  // A tiled window that is maximised stays maximised through a resize (the re-fit leaves it alone).
  await page.evaluate((s) => document.querySelector(s).querySelector('.win-btn[aria-label="Maximize"]').click(), w1);
  await sleep(200);
  await page.setViewportSize({ width: 1440, height: 900 });
  await sleep(400);
  check('a maximised tiled window stays maximised after a resize', await page.evaluate((s) => document.querySelector(s).classList.contains('max'), w1));
  await page.evaluate((s) => document.querySelector(s).querySelector('.win-btn[aria-label="Maximize"]').click(), w1);
  await sleep(200);
  await closeAll(page);
  await sleep(400);

  // (8) Docking layout on: the screen edges still dock (as before), corners tile.
  await page.evaluate(() => { localStorage.setItem('rigs.docking', '1'); });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#menubar');
  await sleep(1500);
  const d1 = await openSessions(page);
  const dg = await grab(page, d1);
  await drag(page, dg, { x: 3, y: 450 }, { hold: true, shot: 'docking-on-edge.png' });
  const edge = await page.evaluate(() => ({ tile: !!document.querySelector('.dock-overlay.tile'), label: document.querySelector('.dock-label.show')?.textContent }));
  await page.mouse.up();
  await sleep(500);
  check('docking on: the left edge shows the docking preview, not tiling', !edge.tile && /Dock left of the screen/.test(edge.label || ''), JSON.stringify(edge));
  check('docking on: dropping on the edge docks the window (unchanged)', await page.evaluate((s) => document.querySelector(s).classList.contains('docked'), d1));
  const d2 = await openShortcuts(page);
  const dg2 = await grab(page, d2);
  await drag(page, dg2, { x: 1437, y: 897 }, { shot: 'docking-on-corner.png' });
  await sleep(400); // the lifted look (scale 1.01) eases back after the drop
  // The pointer at the bottom may reveal an auto-hidden app dock: wait until the tile has re-fitted above it.
  for (let i = 0; i < 15 && !near(await rect(page, d2), zone(await area(page), 'bottom-right')); i++) await sleep(100);
  const A3 = await area(page); // after the drop: the pointer at the bottom may have revealed an auto-hidden app dock (the tile re-fits above it)
  check('docking on: a corner still tiles into the quarter', near(await rect(page, d2), zone(A3, 'bottom-right')) && !(await page.evaluate((s) => document.querySelector(s).classList.contains('docked'), d2)),
    JSON.stringify({ got: await rect(page, d2), want: zone(A3, 'bottom-right'), A3, vars: await page.evaluate(() => ['--mb-h', '--ad-l', '--ad-r', '--ad-b'].map((n) => getComputedStyle(document.documentElement).getPropertyValue(n))), tile: await page.evaluate((s) => { const e = document.querySelector(s); return [e.className, getComputedStyle(e).scale, getComputedStyle(e).transition, e.style.cssText]; }, d2) }));
  // A docked window dragged out of the layout into a corner tiles there (it must leave the docked tree, not snap back).
  const dg3 = await grab(page, d1);
  await drag(page, dg3, { x: 3, y: 3 }, { shot: 'docking-on-docked-to-corner.png' });
  await sleep(400);
  const A4 = await area(page);
  const d1s = await page.evaluate((s) => { const e = document.querySelector(s); return { docked: e.classList.contains('docked'), tiled: e.classList.contains('tiled') }; }, d1);
  check('docking on: a docked window dragged to a corner leaves the layout and tiles', !d1s.docked && d1s.tiled && near(await rect(page, d1), zone(A4, 'top-left')),
    JSON.stringify({ ...d1s, got: await rect(page, d1), want: zone(A4, 'top-left') }));
  await closeAll(page);
  await page.evaluate(() => { localStorage.setItem('rigs.docking', '0'); });
  await ctx.close();
}

// ------------------------------------------------------------------ reduced motion: tiles without the glide
{
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, reducedMotion: 'reduce' });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(URL, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#menubar');
  await sleep(1200);
  const w = await openSessions(page);
  await focusWin(page, w);
  await page.keyboard.press('Control+Alt+ArrowLeft');
  const anim = await page.evaluate((s) => document.querySelector(s).classList.contains('tile-anim'), w);
  await sleep(50);
  check('reduced motion: tiles at once, no glide', !anim && near(await rect(page, w), zone(await area(page), 'left')), JSON.stringify(await rect(page, w)));
  await ctx.close();
}

// ------------------------------------------------------------------ smart scaling on: a tile is the window's home in the layout
{
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await ctx.addInitScript(() => { try { localStorage.setItem('rigs.scaling', '1'); } catch { /* */ } });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(URL, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#menubar');
  await sleep(1200);
  const w = await openSessions(page);
  await focusWin(page, w);
  await press(page, 'Control+Alt+ArrowRight');
  await sleep(400);
  const A = await area(page);
  check('smart scaling: a tiled window stays in its zone after the fit pass', near(await rect(page, w), zone(A, 'right')), JSON.stringify(await rect(page, w)));
  const home = await page.evaluate((s) => JSON.parse(localStorage.getItem('rigs.dock') || '{}').floating?.find((f) => f.id === `win-${document.querySelector(s).dataset.winId}`), w);
  check('smart scaling: the layout keeps the tile as the window\'s home', !home || Math.abs(home.x - zone(A, 'right').x) < 2, JSON.stringify(home));
  await page.setViewportSize({ width: 1100, height: 760 });
  await sleep(700);
  check('smart scaling: re-fits to the zone after a resize', near(await rect(page, w), zone(await area(page), 'right'), 3), JSON.stringify(await rect(page, w)));
  await ctx.close();
}

// ------------------------------------------------------------------ phone 390x844: full-screen windows, no tiling
{
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(URL, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#mb-phone');
  await sleep(1500);
  const w = await openWin(page, async () => {
    await page.click('#mb-phone'); await sleep(250);
    await page.locator('.mb-menu .mb-item', { hasText: 'Help' }).first().click(); await sleep(250);
    await page.locator('.mb-menu .mb-item', { hasText: 'About RIGS' }).first().click();
  });
  const full = await rect(page, w);
  await page.evaluate((s) => document.querySelector(s).querySelector('.win-btn').focus(), w);
  await page.keyboard.press('Control+Alt+ArrowLeft');
  await sleep(400);
  const after = await rect(page, w);
  check('phone: windows stay full-screen', full.w >= 389 && full.h > 700, JSON.stringify(full));
  check('phone: tiling keys do nothing', near(full, after) && !(await isTiled(page, w)), JSON.stringify(after));
  const g = await grab(page, w);
  if (g) await drag(page, g, { x: 2, y: 2 });
  check('phone: no tile preview, no tiling on drag', !(await page.evaluate(() => document.querySelector('.dock-overlay.tile'))) && near(await rect(page, w), full));
  await page.screenshot({ path: path.join(OUT, 'phone-390x844.png') });
  await page.evaluate((s) => document.querySelector(s).querySelector('.win-btn.close').click(), w);
  await sleep(300);
  await page.click('#mb-phone');
  await sleep(250);
  await page.locator('.mb-menu .mb-item', { hasText: 'Window' }).first().click();
  await sleep(300);
  const items = await page.evaluate(() => [...document.querySelectorAll('.mb-menu .mb-label')].map((l) => l.textContent));
  await page.screenshot({ path: path.join(OUT, 'phone-window-menu.png') });
  check('phone: Window menu has no Tile submenu', items.length > 3 && !items.includes('Tile'), JSON.stringify(items));
  await ctx.close();
}

await browser.close();
check('no page errors', errors.length === 0, errors.join(' | '));
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed · screenshots in ${OUT}`);
process.exit(failed.length ? 1 : 0);
