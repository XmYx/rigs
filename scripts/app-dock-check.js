#!/usr/bin/env node
// App dock check: drives JARVIS in headless Chromium (Playwright from RIGS_AUDIT_TOOLS or ~/.cache/rigs-audit, as
// scripts/dock-check.js) and checks the macOS-style app dock end to end, saving screenshots on the way: applets and
// online rigs shown, the toolbar kept clear, magnification under the pointer, drag onto → group, the group popover
// and rename, drag to reorder, drag out of a group, pin / hide / show from the menus, ungroup, left / right / bottom,
// auto-hide (hidden, revealed at the edge), magnification off, every setting surviving a reload, opening an applet
// (existing app window) and a rig (inspector), reduced motion and the 390x844 phone bar.
//   node scripts/app-dock-check.js [--url http://127.0.0.1:4719/] [--out ~/.rigs/screens/dock]
// Without --url it starts a throwaway `rigs serve` (scratch RIGS_HOME with six sample apps, no OpenRig, no migrations,
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
const OUT = path.resolve(opt('out', path.join(os.homedir(), '.rigs/screens/dock')).replace(/^~/, os.homedir()));
fs.mkdirSync(OUT, { recursive: true });

const SAMPLE_APPS = [
  ['notes', 'Notes', '📝'], ['krea', 'Krea Studio', '🎨'], ['transcriber', 'Transcriber', '🎙'],
  ['fuel', 'Fuel Tracker', '⛽'], ['comfy', 'ComfyUI', '🧪'], ['weather', 'Weather', '🌦'],
];

async function startServer() {
  if (opt('url', '')) return { url: opt('url', ''), stop() {} };
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'rigs-appdock-'));
  const port = await new Promise((resolve, reject) => { const s = net.createServer(); s.once('error', reject); s.listen(0, '127.0.0.1', () => { const { port: p } = s.address(); s.close(() => resolve(p)); }); });
  const apps = SAMPLE_APPS.map(([id, name, icon], i) => ({ id, name, icon, port: 47900 + i })); // nothing listens: they show as down, a window still opens
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ port, openrig: { registerPeers: false }, apps }));
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

const TILES = '#app-dock .adock-list > .adock-tile';
const state = (page) => page.evaluate(() => JSON.parse(JSON.stringify(globalThis.__rigsAppDock.state)));
const rects = (page, sel) => page.evaluate((s) => [...document.querySelectorAll(s)].map((el) => { const b = el.getBoundingClientRect(); return { x: b.left, y: b.top, w: b.width, h: b.height, cx: b.left + b.width / 2, cy: b.top + b.height / 2, id: el.dataset.id || el.dataset.gid }; }), sel);
const rect = async (page, sel) => (await rects(page, sel))[0];
const shot = (page, name) => page.screenshot({ path: path.join(OUT, name) });
const visibleView = (s) => s.order.filter((e) => e.type === 'group' || !s.items[e.id]?.hidden);
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** The menu item whose label is exactly `label`, else the one starting with it (in the innermost open menu). */
async function menuItem(page, label) {
  const by = (re) => page.locator('.mb-menu .mb-item').filter({ has: page.locator('.mb-label', { hasText: re }) }).last();
  const exact = by(new RegExp(`^${esc(label)}$`));
  return (await exact.count()) ? exact : by(new RegExp(`^${esc(label)}`));
}

async function ready(page) {
  await page.goto(URL, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.querySelectorAll('#app-dock .adock-tile').length >= 4, null, { timeout: 30000 });
  await sleep(1200);
  await page.mouse.move(400, 300); // pointer away from the dock
  await sleep(300);
}

/** Right-click at (x, y), then click through the menu labels (submenus open on click). */
async function menu(page, x, y, labels, { close = true } = {}) {
  await page.mouse.click(x, y, { button: 'right' });
  await page.waitForSelector('.mb-menu', { timeout: 3000 });
  await sleep(150);
  for (const label of labels) { await (await menuItem(page, label)).click(); await sleep(220); }
  if (close) { await page.keyboard.press('Escape'); await sleep(200); }
}

/** Drag from a point toward a target picked once the drag has begun (the dock un-magnifies when a drag starts). */
async function drag(page, from, pickTarget, { steps = 14 } = {}) {
  await page.mouse.move(from.x, from.y);
  await sleep(150);
  await page.mouse.down();
  await page.mouse.move(from.x + 8, from.y - 2, { steps: 2 });
  await sleep(120);
  const to = await pickTarget();
  for (let i = 1; i <= steps; i++) { await page.mouse.move(from.x + ((to.x - from.x) * i) / steps, from.y + ((to.y - from.y) * i) / steps); await sleep(16); }
  await sleep(200);
  await page.mouse.up();
  await sleep(450);
}
const toTile = (page, i) => async () => { const r = (await rects(page, TILES)).at(i); return { x: r.cx, y: r.cy }; };
const pastEnd = (page) => async () => { const r = (await rects(page, TILES)).at(-1); return { x: r.x + r.w + 5, y: r.cy }; };

const browser = await chromium.launch({ args: ['--no-sandbox'] });

// ------------------------------------------------------------------ desktop 1440x900
{
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  await ready(page);

  // (1) Bottom (the default): applets + online rigs, toolbar kept clear.
  let s = await state(page);
  const items = Object.values(s.items);
  const applets = items.filter((it) => it.kind === 'applet').length;
  const rigs = items.filter((it) => it.kind === 'rig');
  check('dock shows the applets from the App Cloud', applets >= SAMPLE_APPS.length, `${applets} applets`);
  check('dock shows online rigs, and only online ones', rigs.length >= 1 && rigs.every((it) => it.live), `${rigs.length} rigs: ${rigs.map((r) => r.title).join(', ')}`);
  const drawn = await page.evaluate((sel) => [...document.querySelectorAll(sel)].map((el) => el.dataset.id || `group:${el.dataset.gid}`), TILES);
  check('tiles are drawn in the state module\'s order (dockView)', JSON.stringify(drawn) === JSON.stringify(visibleView(s).map((e) => (e.type === 'group' ? `group:${e.id}` : e.id))));
  const dockR = await rect(page, '#app-dock .adock-list');
  const barR = await rect(page, '#bar');
  const chatR = await rect(page, '#chat-dock');
  check('bottom dock sits at the bottom edge, centred', Math.abs(dockR.cx - 720) < 2 && 900 - (dockR.y + dockR.h) < 12, JSON.stringify(dockR));
  check('toolbar and chat strip sit above the dock', barR.y + barR.h <= dockR.y && chatR.y + chatR.h <= barR.y + 1, JSON.stringify({ bar: barR.y + barR.h, dock: dockR.y }));
  await shot(page, 'bottom.png');

  // (2) Magnification under the pointer.
  let t = await rects(page, TILES);
  const base = t[2].w;
  await page.mouse.move(t[2].cx, dockR.y - 30, { steps: 6 });
  await page.mouse.move(t[2].cx, t[2].cy, { steps: 6 });
  await sleep(500);
  let m = await rects(page, TILES);
  check('hovered icon magnifies (~1.6x), neighbours less, far ones not', m[2].w > base * 1.45 && m[1].w > base && m[1].w < m[2].w && Math.abs(m.at(-1).w - base) < 2, m.map((x) => Math.round(x.w)).join(','));
  check('label shows the hovered item\'s name', await page.evaluate(() => (document.querySelector('.adock-label.show')?.textContent || '').length > 0));
  await shot(page, 'magnified-hover.png');
  await page.mouse.move(t[2].cx, 300, { steps: 4 });
  await sleep(500);
  m = await rects(page, TILES);
  check('icons shrink back when the pointer leaves', Math.abs(m[2].w - base) < 1.5, String(Math.round(m[2].w)));

  // (3) Drag one applet onto another → a group in the target's place; then one more onto the group.
  t = await rects(page, TILES);
  const [a0, a1, a2] = [t[0].id, t[1].id, t[2].id];
  await drag(page, { x: t[1].cx, y: t[1].cy }, toTile(page, 0));
  s = await state(page);
  let g = Object.values(s.groups)[0];
  check('drag onto another item creates a group of both', g && g.items.join() === [a0, a1].join() && s.order[0].type === 'group', JSON.stringify(g));
  t = await rects(page, TILES);
  await drag(page, { x: t[1].cx, y: t[1].cy }, toTile(page, 0));
  s = await state(page);
  g = Object.values(s.groups)[0];
  check('drag onto a group adds the item to it', g?.items.length === 3 && g.items[2] === a2, g?.items.join());

  // (4) Open the group's popover, rename it.
  let gt = await rect(page, '#app-dock .adock-group');
  await page.mouse.click(gt.cx, gt.cy);
  await sleep(400);
  check('clicking a group opens its popover with its items', await page.evaluate(() => document.querySelectorAll('.adock-pop.show .adock-pop-tile').length) === 3);
  await page.fill('.adock-pop-name', 'Studio');
  await page.press('.adock-pop-name', 'Enter');
  await sleep(250);
  check('group renamed from the popover title', (await state(page)).groups[g.id].name === 'Studio');
  await page.mouse.move(gt.cx + 300, gt.cy - 250);
  await sleep(250);
  await shot(page, 'group-popover.png');

  // (5) Drag an item out of the popover onto the end of the dock.
  const pt = await rects(page, '.adock-pop-tile');
  await drag(page, { x: pt[2].cx, y: pt[2].cy }, pastEnd(page));
  s = await state(page);
  check('drag out of a group puts the item back on the dock', s.groups[g.id].items.length === 2 && s.order.at(-1).id === a2, JSON.stringify(s.order.at(-1)));
  await page.mouse.click(700, 400);
  await sleep(300);
  check('the popover closes on an outside click', await page.evaluate(() => !document.querySelector('.adock-pop.show')));

  // (6) Drag to reorder: the group to the end.
  gt = await rect(page, '#app-dock .adock-group');
  await drag(page, { x: gt.cx, y: gt.cy }, pastEnd(page));
  s = await state(page);
  check('drag reorders (the group moved to the end)', s.order.at(-1).type === 'group', s.order.map((e) => e.id.split('/').pop()).join(' '));

  // (7) Menus: pin, hide, show again (dock settings menu), ungroup.
  t = await rects(page, TILES);
  const first = t[0];
  await menu(page, first.cx, first.cy, ['Keep in dock']);
  check('menu pins an item', (await state(page)).items[first.id].pinned === true);
  await menu(page, first.cx, first.cy, ['Hide from dock']);
  s = await state(page);
  const drawnNow = await page.evaluate((id) => !!document.querySelector(`#app-dock [data-id="${CSS.escape(id)}"]`), first.id);
  check('menu hides an item (kept in the state, not drawn)', s.items[first.id].hidden && !drawnNow);
  const lr = await rect(page, '#app-dock .adock-list');
  await menu(page, lr.x + 3, lr.cy, ['Hidden items'], { close: false });
  await shot(page, 'settings-menu.png');
  await (await menuItem(page, 'Show all')).click();
  await sleep(250);
  check('the dock menu shows hidden items again', !(await state(page)).items[first.id].hidden);
  // Keyboard: Shift+F10 (the Menu key on macOS, where Chrome sends no contextmenu for Shift+F10) on a focused tile gives the same menu (dock entries, then the app's own).
  await page.evaluate(() => document.querySelector('#app-dock .adock-tile.k-applet').focus());
  const menuKey = process.platform === 'darwin' ? 'ContextMenu' : 'Shift+F10';
  await page.keyboard.press(menuKey);
  await sleep(300);
  const kbd = await page.evaluate(() => [...document.querySelectorAll('.mb-menu .mb-label')].map((x) => x.textContent));
  check(`${menuKey} on a focused tile opens its dock + app menu`, kbd.includes('Keep in dock (pin)') && kbd.includes('Open in a browser tab'), kbd.slice(0, 6).join(' | '));
  await page.keyboard.press('Escape');
  await sleep(200);
  gt = await rect(page, '#app-dock .adock-group');
  await menu(page, gt.cx, gt.cy, ['Ungroup']);
  check('menu ungroups', Object.keys((await state(page)).groups).length === 0);

  // (8) An applet opens through the existing app path; a rig focuses its machine.
  t = await rects(page, `${TILES}.k-applet`);
  await page.mouse.click(t[0].cx, t[0].cy);
  await sleep(900);
  check('clicking an applet opens its app window', await page.evaluate(() => !!document.querySelector('.win.app-win')));
  await sleep(2300);
  check('an open applet gets a running dot', await page.evaluate(() => !!document.querySelector('#app-dock .adock-tile.open')));
  await page.evaluate(() => document.querySelector('.win.app-win .win-btn.close')?.click());
  await sleep(300);
  const rig = await rect(page, `${TILES}.k-rig`);
  const rigName = (await state(page)).items[rig.id].title;
  await page.mouse.click(rig.cx, rig.cy);
  await sleep(700);
  check('clicking a rig focuses that machine in the inspector', (await page.evaluate(() => document.querySelector('#inspector .ins-title')?.textContent || '')).includes(rigName), rigName);
  await page.mouse.move(400, 300);
  await sleep(600); // let the magnification settle before measuring the shelf

  // (9) Left, then reload: still left, the side panel kept clear.
  const lr2 = await rect(page, '#app-dock .adock-list');
  await menu(page, lr2.x + 3, lr2.cy, ['Position on screen', 'Left']);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#app-dock .adock-tile');
  await sleep(1500);
  await page.mouse.move(400, 300);
  await sleep(300);
  const left = await rect(page, '#app-dock .adock-list');
  const side = await rect(page, '#left');
  check('left position survives a reload', (await state(page)).settings.position === 'left' && left.x < 12 && left.h > left.w, JSON.stringify(left));
  check('the side panel keeps clear of a left dock', side.x >= left.x + left.w, JSON.stringify({ side: side.x, dock: left.x + left.w }));
  await shot(page, 'left.png');
  t = await rects(page, TILES);
  await page.mouse.move(left.cx, t[3].cy, { steps: 6 });
  await sleep(450);
  m = await rects(page, TILES);
  check('a side dock magnifies along its axis', m[3].h > t[3].h * 1.4, `${Math.round(t[3].h)} → ${Math.round(m[3].h)}`);
  await shot(page, 'left-magnified.png');
  await page.mouse.move(400, 300);
  await sleep(400);

  // (10) Right.
  const l2 = await rect(page, '#app-dock .adock-list');
  await menu(page, l2.cx, l2.y + 3, ['Position on screen', 'Right']);
  await page.mouse.move(400, 300);
  await sleep(500);
  const right = await rect(page, '#app-dock .adock-list');
  const orb = await rect(page, '#orb-wrap');
  check('right position', (await state(page)).settings.position === 'right' && right.x + right.w > 1420, JSON.stringify(right));
  check('right-anchored panels keep clear of a right dock', orb.x + orb.w <= right.x, JSON.stringify({ orb: orb.x + orb.w, dock: right.x }));
  await shot(page, 'right.png');

  // (11) Bottom + auto-hide: hidden, revealed at the edge, hidden again, survives a reload.
  await menu(page, right.cx, right.y + 3, ['Position on screen', 'Bottom']);
  await page.mouse.move(400, 300);
  await sleep(400);
  const b2 = await rect(page, '#app-dock .adock-list');
  await menu(page, b2.x + 3, b2.cy, ['Automatically hide']);
  await page.mouse.move(400, 300);
  await sleep(1000);
  let hid = await rect(page, '#app-dock .adock-list');
  const bar2 = await rect(page, '#bar');
  check('auto-hide moves the dock off screen', hid.y >= 900, String(Math.round(hid.y)));
  check('the toolbar returns to its own place while the dock is auto-hidden', Math.abs(900 - (bar2.y + bar2.h) - 22) < 2, String(900 - (bar2.y + bar2.h)));
  await shot(page, 'auto-hidden.png');
  await page.mouse.move(720, 896, { steps: 4 });
  await page.mouse.move(720, 899);
  await sleep(500);
  hid = await rect(page, '#app-dock .adock-list');
  check('the pointer at the bottom edge reveals it', hid.y + hid.h <= 900 && hid.y < 860, String(Math.round(hid.y)));
  await shot(page, 'auto-hidden-revealed.png');
  await page.mouse.move(400, 300);
  // Wait on animation frames: idle headless Chromium may not start the slide-out transition until something renders,
  // so a fixed sleep can read the dock still in place although it already dropped its `shown` class.
  const hideStart = Date.now();
  const hidAgain = await page.waitForFunction(() => document.querySelector('#app-dock .adock-list').getBoundingClientRect().y >= 900, null, { polling: 'raf', timeout: 2000 }).then(() => true, () => false);
  check('it hides again when the pointer leaves', hidAgain, `${Date.now() - hideStart}ms`);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#app-dock .adock-tile');
  await sleep(1500);
  check('auto-hide survives a reload', (await state(page)).settings.autoHide === true && (await rect(page, '#app-dock .adock-list')).y >= 900);
  await page.evaluate(() => document.querySelector('#app-dock .adock-tile[tabindex="0"]').focus());
  await sleep(500);
  check('keyboard focus reveals an auto-hidden dock', (await rect(page, '#app-dock .adock-list')).y < 860);
  const b3 = await rect(page, '#app-dock .adock-list');
  await menu(page, b3.x + 3, b3.cy, ['Automatically hide']);
  await page.evaluate(() => document.activeElement?.blur());

  // (12) Magnification off survives a reload; hovering then changes nothing.
  const b4 = await rect(page, '#app-dock .adock-list');
  await menu(page, b4.x + 3, b4.cy, ['Magnification']);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#app-dock .adock-tile');
  await sleep(1500);
  t = await rects(page, TILES);
  await page.mouse.move(t[1].cx, t[1].cy, { steps: 6 });
  await sleep(450);
  m = await rects(page, TILES);
  check('magnification off survives a reload and stops the zoom', (await state(page)).settings.magnification === false && Math.abs(m[1].w - t[1].w) < 1);
  await ctx.close();
}

// ------------------------------------------------------------------ reduced motion: no zoom
{
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  await ready(page);
  const t = await rects(page, TILES);
  await page.mouse.move(t[2].cx, t[2].cy, { steps: 6 });
  await sleep(450);
  const m = await rects(page, TILES);
  check('prefers-reduced-motion: no magnification', Math.abs(m[2].w - t[2].w) < 1);
  await ctx.close();
}

// ------------------------------------------------------------------ phone 390x844
{
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(URL, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.querySelectorAll('#app-dock .adock-tile').length >= 4, null, { timeout: 30000 });
  await sleep(1500);
  const d = await rect(page, '#app-dock .adock-list');
  const bar = await rect(page, '#bar');
  const tiles = await rects(page, TILES);
  check('phone: a bottom bar across the screen', d.x >= 0 && d.x + d.w <= 390 && 844 - (d.y + d.h) <= 12 && d.w > 300, JSON.stringify(d));
  check('phone: the toolbar sits above the dock bar', bar.y + bar.h <= d.y, JSON.stringify({ bar: bar.y + bar.h, dock: d.y }));
  check('phone: finger-sized tiles (44px)', tiles.every((x) => x.w >= 44 && x.h >= 44));
  check('phone: no page overflow', await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
  await shot(page, 'phone-390x844.png');
  // Grouping on a phone goes through the long-press menu (here: the same menu, opened with a right-click).
  const ids = await page.evaluate(() => Object.keys(globalThis.__rigsAppDock.state.items).filter((id) => id.startsWith('applet:')).slice(0, 3));
  for (const id of ids) {
    const tile = await rect(page, `#app-dock [data-id="${id}"]`);
    const hasGroup = await page.evaluate(() => Object.keys(globalThis.__rigsAppDock.state.groups).length > 0);
    await menu(page, tile.cx, tile.cy, ['Move to group', hasGroup ? 'Group' : 'New group']);
  }
  const grouped = await page.evaluate(() => Object.values(globalThis.__rigsAppDock.state.groups)[0]?.items.length || 0);
  check('phone: grouping from the menu', grouped === 3, String(grouped));
  await page.tap('#app-dock .adock-group');
  await sleep(500);
  const pop = await rect(page, '.adock-pop.show');
  const d2 = await rect(page, '#app-dock .adock-list');
  check('phone: a group opens as a sheet above the bar', pop && pop.y + pop.h <= d2.y + 1 && pop.x >= 0 && pop.x + pop.w <= 390, JSON.stringify(pop));
  await shot(page, 'phone-group-sheet-390x844.png');
  const before = (await rects(page, TILES))[0].w;
  check('phone: no magnification', before === 44, String(before));
  await ctx.close();
}

check('no page errors', !errors.length, errors.slice(0, 3).join(' | '));
await browser.close();
server.stop();
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed · screenshots in ${OUT}`);
process.exit(failed.length ? 1 : 0);
