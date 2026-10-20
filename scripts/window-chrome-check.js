#!/usr/bin/env node
// Window chrome check: drives JARVIS in headless Chromium (Playwright from RIGS_AUDIT_TOOLS or ~/.cache/rigs-audit, as
// scripts/app-dock-check.js) and checks the shared window chrome end to end on an app window, the file browser and
// the Exhibit window: the three title bar buttons (minimize, maximize / restore, close) in the same order and style,
// minimize → the window leaves the stage and shows in the app dock → a click there brings it back at the same rect,
// maximize → the whole stage → restore → the exact previous rect, double-click and the right-click entries, the state
// surviving a reload (rigs.dock `windows`), and the phone (390x844) layout. Screenshots of each window normal,
// maximized and minimized-in-dock at 1440x900 and 390x844.
//   node scripts/window-chrome-check.js [--url http://127.0.0.1:4719/] [--out /tmp/panels-to-windows/t1]
// Without --url it starts a throwaway `rigs serve` (scratch RIGS_HOME with sample apps, no OpenRig, no migrations,
// no autoupdate). Exit code 1 when a check fails.
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
const OUT = path.resolve(opt('out', '/tmp/panels-to-windows/t1').replace(/^~/, os.homedir()));
fs.mkdirSync(OUT, { recursive: true });

async function startServer() {
  if (opt('url', '')) return { url: opt('url', ''), stop() {} };
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'rigs-winchrome-'));
  const port = await new Promise((resolve, reject) => { const s = net.createServer(); s.once('error', reject); s.listen(0, '127.0.0.1', () => { const { port: p } = s.address(); s.close(() => resolve(p)); }); });
  const apps = [['notes', 'Notes', '📝'], ['weather', 'Weather', '🌦']].map(([id, name, icon], i) => ({ id, name, icon, port: 47950 + i })); // nothing listens: a window still opens
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ port, openrig: { registerPeers: false }, apps, exhibits: { enabled: true, images: 'off' } }));
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
const shot = (page, name) => page.screenshot({ path: path.join(OUT, name) });

async function ready(page) {
  await page.goto(URL, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => Object.keys(globalThis.__rigsAppDock?.state.items || {}).some((id) => id.startsWith('applet:')), null, { timeout: 30000 });
  await sleep(1200);
  await page.mouse.move(500, 300);
}

/** The newest window with this class → { sel, id }. */
async function winBy(page, cls) {
  const id = await page.evaluate((c) => [...document.querySelectorAll(`.win${c ? '.' + c : ''}`)].filter((w) => !w.classList.contains('win-leave')).at(-1)?.dataset.winId, cls);
  return id ? { id, sel: `.win[data-win-id="${id}"]` } : null;
}
/** Wait until the window's open / restore / maximize animations are over (a rect read mid-animation is scaled). */
const settle = (page, sel) => page.waitForFunction((s) => { const el = document.querySelector(s); return !el || el.getAnimations().every((a) => a.playState !== 'running'); }, sel, { timeout: 5000 }).catch(() => {});
const rectOf = (page, sel) => page.evaluate((s) => { const el = document.querySelector(s); if (!el) return null; const b = el.getBoundingClientRect(); return { x: Math.round(b.left), y: Math.round(b.top), w: Math.round(b.width), h: Math.round(b.height), shown: getComputedStyle(el).display !== 'none' }; }, sel);
const near = (a, b, d = 2) => a && b && ['x', 'y', 'w', 'h'].every((k) => Math.abs(a[k] - b[k]) <= d);
const buttons = (page, sel) => page.evaluate((s) => [...document.querySelectorAll(`${s} .win-bar > .win-btn`)].map((b) => { const cs = getComputedStyle(b); return { text: b.textContent, label: b.getAttribute('aria-label'), w: Math.round(b.getBoundingClientRect().width), h: Math.round(b.getBoundingClientRect().height), font: cs.fontSize, shown: cs.display !== 'none' }; }), sel);
const dockItem = (page, id) => page.evaluate((i) => { const it = globalThis.__rigsAppDock.state.items[i]; const el = document.querySelector(`#app-dock .adock-tile[data-id="${CSS.escape(i)}"]`); return { item: it ? { minimized: !!it.minimized } : null, tile: !!el, min: !!el?.classList.contains('min'), label: el?.getAttribute('aria-label') || '' }; }, id);
const stored = (page) => page.evaluate(() => JSON.parse(localStorage.getItem('rigs.dock') || 'null'));

/** Click the first applet in the dock: its own tile, or inside its group's popover (applets are grouped by default). */
async function openApp(page) {
  const { id, gid } = await page.evaluate(() => {
    const s = globalThis.__rigsAppDock.state;
    const id = Object.keys(s.items).find((i) => i.startsWith('applet:'));
    return { id, gid: Object.values(s.groups).find((g) => g.items.includes(id))?.id || null };
  });
  if (gid) { await page.click(`#app-dock .adock-tile[data-gid="${gid}"]`); await page.waitForSelector(`.adock-pop-tile[data-id="${id}"]`); await page.click(`.adock-pop-tile[data-id="${id}"]`); }
  else await page.click(`#app-dock .adock-tile[data-id="${id}"]`);
  await page.waitForSelector('.win.app-win');
  await sleep(400);
  return winBy(page, 'app-win');
}
async function openFiles(page) {
  await page.evaluate(() => document.getElementById('btn-files').click());
  await page.waitForSelector('.win.files-win');
  await sleep(400);
  return winBy(page, 'files-win');
}
async function openExhibits(page) {
  await page.getByRole('menuitem', { name: /^Experimental/ }).first().click();
  await page.getByRole('menuitem', { name: /Open the Exhibit window/ }).first().click();
  await page.waitForSelector('.win.win-exhibits', { timeout: 8000 });
  await sleep(500);
  return winBy(page, 'win-exhibits');
}

async function cycle(page, w, label, vp, { dockId, phone = false } = {}) {
  const tag = `${label}-${vp}`;
  const btns = await buttons(page, w.sel);
  const shownBtns = btns.filter((b) => b.shown).map((b) => b.text);
  check(`${tag}: title bar buttons in order`, phone ? shownBtns.join('') === '–✕' : shownBtns.join('') === '–□✕', JSON.stringify(btns.map((b) => [b.text, b.label, b.shown])));
  if (!phone) check(`${tag}: buttons share one style`, new Set(btns.map((b) => `${b.w}x${b.h}/${b.font}`)).size === 1, JSON.stringify(btns.map((b) => `${b.w}x${b.h}/${b.font}`)));
  await settle(page, w.sel);
  const before = await rectOf(page, w.sel);
  await shot(page, `${tag}-normal.png`);

  if (!phone) {
    await page.click(`${w.sel} .win-btn.win-max`);
    await sleep(350);
    const max = await rectOf(page, w.sel);
    check(`${tag}: maximize fills the stage`, max.w > before.w && max.w >= (await page.evaluate(() => innerWidth)) - 200, JSON.stringify(max));
    check(`${tag}: maximize button turns into Restore`, (await buttons(page, w.sel))[1].label === 'Restore');
    await shot(page, `${tag}-maximized.png`);
    await page.click(`${w.sel} .win-btn.win-max`);
    await sleep(350);
    await settle(page, w.sel);
    check(`${tag}: restore brings back the exact previous rect`, near(await rectOf(page, w.sel), before), `${JSON.stringify(before)} → ${JSON.stringify(await rectOf(page, w.sel))}`);
  } else {
    await shot(page, `${tag}-maximized.png`); // phones: every window is already full-screen (no separate maximize button)
  }

  await page.click(`${w.sel} .win-btn.win-min`);
  await sleep(450);
  check(`${tag}: minimize takes it off the stage`, !(await rectOf(page, w.sel)).shown);
  const di = await dockItem(page, dockId(w));
  check(`${tag}: minimized window shows in the app dock`, di.tile && di.min && di.item?.minimized, JSON.stringify(di));
  await shot(page, `${tag}-minimized-in-dock.png`);
  await page.click(`#app-dock .adock-tile[data-id="${dockId(w)}"]`);
  await sleep(450);
  await settle(page, w.sel);
  const back = await rectOf(page, w.sel);
  check(`${tag}: a click in the dock restores it in place`, back.shown && near(back, before), `${JSON.stringify(before)} → ${JSON.stringify(back)}`);
  const after = await dockItem(page, dockId(w));
  check(`${tag}: the dock no longer shows it minimized`, !after.min && !after.item?.minimized, JSON.stringify(after));
}

const browser = await chromium.launch();
try {
  // ---------------------------------------------------------------- desktop 1440x900
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(String(e)));
  await ready(page);

  const ex = await openExhibits(page); // first: a tall app window opens over the top menu bar
  await cycle(page, ex, 'exhibit', '1440x900', { dockId: (w) => `window:${w.id}` });

  const files = await openFiles(page);
  await cycle(page, files, 'files', '1440x900', { dockId: (w) => `window:${w.id}` });
  check('files: the window item added for the minimize is gone after restore', !(await dockItem(page, `window:${files.id}`)).tile);

  const app = await openApp(page);
  await cycle(page, app, 'app', '1440x900', { dockId: (w) => `window:${w.id}` }); // its applet sits in a group popover, so the minimized window gets its own tile
  check('app: the tile added for the minimized app is gone after restore', !(await dockItem(page, `window:${app.id}`)).tile);

  await page.click(`${app.sel} .win-btn.win-min`); // out of the way (it covers the others)
  await sleep(400);

  // Double-click still maximizes; the right-click menu has the same three actions.
  await page.dblclick(`${files.sel} .win-title-text`);
  await sleep(300);
  check('double-click on the title bar maximizes', await page.evaluate((s) => document.querySelector(s).classList.contains('max'), files.sel));
  await page.dblclick(`${files.sel} .win-title-text`);
  await sleep(300);
  await page.click(`${files.sel} .win-title-text`, { button: 'right' });
  await page.waitForSelector('.mb-menu');
  const menu = await page.evaluate(() => [...document.querySelectorAll('.mb-menu .mb-item .mb-label')].map((e) => e.textContent));
  const at = (l) => menu.indexOf(l);
  check('right-click: Minimize, Maximize, Close in title bar order', at('Minimize') >= 0 && at('Minimize') < at('Maximize') && at('Maximize') < at('Close'), menu.join(' | '));
  await shot(page, 'context-menu-1440x900.png');
  await page.locator('.mb-menu .mb-item').filter({ has: page.locator('.mb-label', { hasText: /^Minimize$/ }) }).first().click();
  await sleep(400);
  check('right-click Minimize minimizes', !(await rectOf(page, files.sel)).shown);
  await page.click(`#app-dock .adock-tile[data-id="window:${files.id}"]`);
  await sleep(400);

  // Esc still closes (focus in the window).
  await page.click(`${ex.sel} .win-title-text`);
  await page.keyboard.press('Escape');
  await sleep(400);
  check('Esc closes the focused window', !(await page.$(ex.sel)));

  // State across a reload: files maximized, app moved.
  await page.click(`${files.sel} .win-btn.win-max`);
  await page.click(`#app-dock .adock-tile[data-id="window:${app.id}"]`);
  await sleep(400);
  await page.evaluate((s) => { const el = document.querySelector(s); Object.assign(el.style, { left: '200px', top: '150px', width: '700px', height: '420px' }); el.dispatchEvent(new PointerEvent('pointerup', { bubbles: true })); }, app.sel);
  await sleep(300);
  const st = await stored(page);
  const keys = Object.keys(st?.windows || {});
  check('window state is stored in rigs.dock (version 2 or later, windows)', st?.version >= 2 && keys.some((k) => k.startsWith('files:')) && keys.some((k) => k.startsWith('app:')), keys.join(', '));
  check('the stored file browser is maximized, the app at its new rect', Object.entries(st.windows).some(([k, r]) => k.startsWith('files:') && r.state === 'maximized') && Object.entries(st.windows).some(([k, r]) => k.startsWith('app:') && r.rect?.x === 200 && r.rect?.w === 700), JSON.stringify(st.windows));
  await ready(page); // reload
  const f2 = await openFiles(page);
  check('after a reload the file browser opens maximized', await page.evaluate((s) => document.querySelector(s).classList.contains('max'), f2.sel));
  const a2 = await openApp(page);
  await settle(page, a2.sel); // read after the open animation (it scales the window from 96%)
  check('after a reload the app window opens at its remembered rect', near(await rectOf(page, a2.sel), { x: 200, y: 150, w: 700, h: 420 }), JSON.stringify(await rectOf(page, a2.sel)));
  check('no wm.js window id leaks into the stored layout', !JSON.stringify((await stored(page)).root || '').includes('win-'));
  await ctx.close();

  // ---------------------------------------------------------------- phone 390x844
  const pctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  const p = await pctx.newPage();
  p.on('pageerror', (e) => errors.push(String(e)));
  await ready(p);
  const pApp = await openApp(p);
  await cycle(p, pApp, 'app', '390x844', { dockId: (w) => `window:${w.id}`, phone: true });
  await p.click(`${pApp.sel} .win-btn.close`);
  await sleep(300);
  const pFiles = await openFiles(p);
  await cycle(p, pFiles, 'files', '390x844', { dockId: (w) => `window:${w.id}`, phone: true });
  // Back closes the top window on the stage, never a minimized one. A phone window covers the dock, so the way to a
  // second window is: minimize files, open the app, minimize it, bring files back from the dock.
  await p.click(`${pFiles.sel} .win-btn.win-min`);
  await sleep(450);
  const pApp2 = await openApp(p);
  await p.click(`${pApp2.sel} .win-btn.win-min`);
  await sleep(450);
  await p.click(`#app-dock .adock-tile[data-id="window:${pFiles.id}"]`);
  await sleep(450);
  await p.goBack();
  await sleep(450);
  check('phone: back closes the visible window, not the minimized one', !(await p.$(pFiles.sel)) && !!(await p.$(pApp2.sel)), `files ${!!(await p.$(pFiles.sel))}, app ${!!(await p.$(pApp2.sel))}`);
  await p.click(`#app-dock .adock-tile[data-id="window:${pApp2.id}"]`);
  await sleep(450);
  await p.goBack();
  await sleep(450);
  check('phone: a window restored from the dock owns a back entry again', !(await p.$(pApp2.sel)));
  try {
    const pEx = await openExhibitsPhone(p);
    await cycle(p, pEx, 'exhibit', '390x844', { dockId: (w) => `window:${w.id}`, phone: true });
  } catch (e) { check('exhibit-390x844: opened on the phone', false, e.message); }
  await pctx.close();
} finally {
  await browser.close();
  server.stop();
}

/** Phones: the top menu is one ⋮ button with drill-in menus. */
async function openExhibitsPhone(page) {
  await page.click('#mb-phone');
  await page.getByRole('menuitem', { name: /^Experimental/ }).first().click();
  await page.getByRole('menuitem', { name: /Open the Exhibit window/ }).first().click();
  await page.waitForSelector('.win.win-exhibits', { timeout: 8000 });
  await sleep(500);
  return winBy(page, 'win-exhibits');
}

check('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed; screenshots in ${OUT}`);
process.exit(failed.length ? 1 : 0);
