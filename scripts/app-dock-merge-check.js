#!/usr/bin/env node
// App dock × menu-bar docking × Ask JARVIS: drives JARVIS in headless Chromium (Playwright from RIGS_AUDIT_TOOLS or
// ~/.cache/rigs-audit, as scripts/app-dock-check.js) and checks that the macOS-style app dock coexists with the Ask
// JARVIS panel (in the top menu bar, floating, docked in the docking layout) and the docking layout itself: no
// overlaps, the dock under the menus, the docked area kept clear of the dock's edge, magnification still working, and
// the phone bar beside the bottom toolbar's Ask field. Screenshots of each case are saved on the way.
//   node scripts/app-dock-merge-check.js [--url http://127.0.0.1:4719/] [--out docs/review/app-dock-merge]
// Without --url it starts a throwaway `rigs serve` (scratch RIGS_HOME with six sample apps, no OpenRig, no migrations,
// no autoupdate). Every case starts from seeded localStorage in a fresh browser context. Exit code 1 when a check fails.
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
const OUT = path.resolve(ROOT, opt('out', 'docs/review/app-dock-merge').replace(/^~/, os.homedir()));
fs.mkdirSync(OUT, { recursive: true });

const SAMPLE_APPS = [
  ['notes', 'Notes', '📝'], ['krea', 'Krea Studio', '🎨'], ['transcriber', 'Transcriber', '🎙'],
  ['fuel', 'Fuel Tracker', '⛽'], ['comfy', 'ComfyUI', '🧪'], ['weather', 'Weather', '🌦'],
];

async function startServer() {
  if (opt('url', '')) return { url: opt('url', ''), stop() {} };
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'rigs-appdock-merge-'));
  const port = await new Promise((resolve, reject) => { const s = net.createServer(); s.once('error', reject); s.listen(0, '127.0.0.1', () => { const { port: p } = s.address(); s.close(() => resolve(p)); }); });
  const apps = SAMPLE_APPS.map(([id, name, icon], i) => ({ id, name, icon, port: 47900 + i })); // nothing listens: they show as down
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, ok, extra = '') => { results.push({ name, ok: !!ok }); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${extra ? ' — ' + extra : ''}`); };
const errors = [];

const rect = (page, sel) => page.evaluate((s) => { const el = document.querySelector(s); if (!el) return null; const b = el.getBoundingClientRect(); return b.width || b.height ? { x: b.left, y: b.top, w: b.width, h: b.height, r: b.right, b: b.bottom } : null; }, sel);
const overlap = (a, b) => !!a && !!b && a.x < b.r && b.x < a.r && a.y < b.b && b.y < a.b;
const fmt = (r) => (r ? `${Math.round(r.x)},${Math.round(r.y)} ${Math.round(r.w)}x${Math.round(r.h)}` : 'none');
const shot = (page, name) => page.screenshot({ path: path.join(OUT, name) });

const DOCK = '#app-dock .adock-list';
// The galaxy (stage) with Ask JARVIS and the side panel docked on the dock's side (the side panel docked too, so no floating panel covers Ask).
const panel = (id) => ({ type: 'panel', id });
const STAGE_DOCKED = (askFirst) => ({ type: 'split', dir: 'row', ratios: askFirst ? [0.3, 0.7] : [0.7, 0.3], children: askFirst ? [{ type: 'split', dir: 'column', ratios: [0.22, 0.78], children: [panel('ask'), panel('left')] }, panel('stage')] : [panel('stage'), panel('ask')] });

/** A fresh context with `seed` (localStorage key → value) written before the page's own scripts run. */
async function open(browser, { viewport = { width: 1440, height: 900 }, seed = {}, isMobile = false } = {}) {
  const ctx = await browser.newContext({ viewport, isMobile, hasTouch: isMobile, deviceScaleFactor: isMobile ? 2 : 1 });
  await ctx.addInitScript((s) => {
    try {
      if (sessionStorage.getItem('seeded')) return;
      // A quiet screen: no toasts, banners or auto-opened sessions over the panels; no face / galaxy motion.
      for (const k of ['rigs.notifications', 'rigs.attnBanner', 'rigs.autoOpenSessions', 'rigs.d-particles', 'rigs.d-rotate']) localStorage.setItem(k, 'false');
      localStorage.setItem('rigs.face', '0');
      for (const [k, v] of Object.entries(s)) localStorage.setItem(k, typeof v === 'string' ? v : JSON.stringify(v));
      sessionStorage.setItem('seeded', '1');
    } catch { /* ignore */ }
  }, seed);
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(server.url, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.querySelectorAll('#app-dock .adock-tile').length >= 4, null, { timeout: 30000 });
  await sleep(1500);
  await page.mouse.move(viewport.width / 2, viewport.height / 3);
  await sleep(300);
  return { ctx, page };
}

/** Hover the middle of the dock (along its axis) and return the largest tile scale. */
async function magnify(page) {
  const d = await rect(page, DOCK);
  await page.mouse.move(d.x + d.w / 2, d.y + d.h / 2, { steps: 6 });
  await sleep(700);
  return page.evaluate(() => Math.max(...[...document.querySelectorAll('#app-dock .adock-list > .adock-tile')].map((t) => t.getBoundingClientRect().width)));
}

const browser = await chromium.launch({ args: ['--no-sandbox'] });

// (1) Defaults: bottom dock, Ask JARVIS docked in the top menu bar.
{
  const { ctx, page } = await open(browser);
  const dock = await rect(page, DOCK);
  const bar = await rect(page, '#menubar');
  const slot = await rect(page, '#menubar-ask-slot');
  check('defaults: Ask JARVIS sits in the top menu bar', !!slot && (await page.evaluate(() => !!document.querySelector('#menubar-ask-slot #ask'))), fmt(slot));
  check('defaults: the dock sits at the bottom, clear of the menu bar', dock && bar && dock.y > bar.b + 100 && !overlap(dock, bar), `dock ${fmt(dock)} · bar ${fmt(bar)}`);
  const big = await magnify(page);
  check('defaults: magnification works with the Ask field in the top bar', big > 52, `${Math.round(big)}px`);
  await shot(page, 'bottom-magnified-ask-topbar-1440.png');
  // The menus open over the dock (menus 10000 > dock 3000): a menu that reaches the bottom is never hidden behind it.
  const z = await page.evaluate(() => ({ dock: +getComputedStyle(document.getElementById('app-dock')).zIndex, bar: +getComputedStyle(document.getElementById('menubar')).zIndex }));
  await page.mouse.move(720, 300);
  await sleep(500);
  await page.locator('#menubar .mb-top').first().click();
  await sleep(300);
  const menuZ = await page.evaluate(() => +getComputedStyle(document.querySelector('.mb-menu')).zIndex);
  check('defaults: top-bar menus stack above the dock', menuZ > z.dock, JSON.stringify({ ...z, menu: menuZ }));
  await page.keyboard.press('Escape');
  await sleep(200);
  // Focusing the top-bar Ask field (it grows) does not move the dock.
  await page.focus('#ask');
  await sleep(400);
  const dock2 = await rect(page, DOCK);
  check('defaults: focusing the top-bar Ask field leaves the dock where it is', Math.abs(dock2.x - dock.x) < 2 && Math.abs(dock2.y - dock.y) < 2);
  await ctx.close();
}

// (2) Side dock + Ask JARVIS floating at its CSS place, on a narrow desktop: the panel narrows instead of overlapping.
for (const position of ['left', 'right']) {
  const { ctx, page } = await open(browser, { viewport: { width: 650, height: 820 }, seed: { 'rigs.appdock': { v: 1, settings: { position } }, 'rigs.askPanel': { mode: 'floating', rect: null, last: 'floating' } } });
  const dock = await rect(page, DOCK);
  const ask = await rect(page, '#ask-panel');
  check(`${position} dock, floating Ask at 650px: no overlap`, dock && ask && !overlap(dock, ask), `dock ${fmt(dock)} · ask ${fmt(ask)}`);
  await ctx.close();
}

// (3) Docking layout on, Ask JARVIS docked beside the galaxy: the docked area starts where the dock ends.
for (const position of ['left', 'right', 'bottom']) {
  const seed = {
    'rigs.appdock': { v: 1, settings: { position } },
    'rigs.docking': '1',
    'rigs.dock': { version: 1, root: STAGE_DOCKED(position !== 'right'), floating: [], hidden: {}, collapsed: [] },
    'rigs.askPanel': { mode: 'docked', rect: null, last: 'docked' },
  };
  const { ctx, page } = await open(browser, { seed });
  const dock = await rect(page, DOCK);
  const ask = await rect(page, '#ask-panel');
  const docked = await page.evaluate(() => document.getElementById('ask-panel').classList.contains('docked'));
  const ad = await page.evaluate(() => ['--ad-l', '--ad-r', '--ad-b'].map((v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim()));
  check(`${position} dock, Ask docked in the docking layout: Ask is docked`, docked);
  check(`${position} dock, Ask docked: they do not overlap`, dock && ask && !overlap(dock, ask), `dock ${fmt(dock)} · ask ${fmt(ask)} · reserve ${ad.join(' ')}`);
  const bar = await rect(page, '#menubar');
  check(`${position} dock, Ask docked: it stays below the menu bar`, ask && bar && ask.y >= bar.b - 1, `ask top ${Math.round(ask?.y)} · bar ${Math.round(bar?.b)}`);
  if (position !== 'bottom') {
    const big = await magnify(page);
    check(`${position} dock, Ask docked: magnification works`, big > 52, `${Math.round(big)}px`);
    await shot(page, `${position}-magnified-ask-docked-1440.png`);
  } else {
    await shot(page, 'bottom-ask-docked-layout-1440.png');
  }
  // Auto-hide hands the edge back to the layout.
  const side = await rect(page, '#left');
  await page.evaluate(() => globalThis.__rigsAppDock.act((s) => ({ ...s, settings: { ...s.settings, autoHide: true } })));
  await sleep(700);
  const ask2 = await rect(page, '#ask-panel');
  const side2 = await rect(page, '#left'); // under Ask in the same column: the bottom edge comes back to it
  const grew = position === 'left' ? ask2.x < ask.x - 20 : position === 'right' ? ask2.r > ask.r + 20 : side2.b > side.b + 20;
  check(`${position} dock auto-hidden: the docked layout takes the edge back`, grew, position === 'bottom' ? `side panel ${fmt(side)} → ${fmt(side2)}` : `ask ${fmt(ask)} → ${fmt(ask2)}`);
  await ctx.close();
}

// (4) Hiding the menu bar re-centres a side dock in the full height and keeps it clear of the peeking bar.
{
  const { ctx, page } = await open(browser, { seed: { 'rigs.appdock': { v: 1, settings: { position: 'left' } } } });
  const before = await rect(page, DOCK);
  await page.mouse.click(720, 500);
  await page.keyboard.press('ControlOrMeta+Shift+m');
  await sleep(600);
  const after = await rect(page, DOCK);
  const mid = (r) => r.y + r.h / 2;
  check('menu bar hidden: a side dock re-centres in the full height', Math.abs(mid(after) - 450) < 3 && Math.abs(mid(before) - (32 + (900 - 32) / 2)) < 3, `${Math.round(mid(before))} → ${Math.round(mid(after))}`);
  const big = await magnify(page);
  check('menu bar hidden: magnification still lines up with the tiles', big > 52, `${Math.round(big)}px`);
  await ctx.close();
}

// (5) Phone 390x844: dock bar under the toolbar, Ask field in the bottom toolbar, no Ask panel or top-bar slot.
{
  const { ctx, page } = await open(browser, { viewport: { width: 390, height: 844 }, isMobile: true });
  const dock = await rect(page, DOCK);
  const bar = await rect(page, '#bar');
  const ask = await rect(page, '#ask');
  const ui = await page.evaluate(() => ({ inBar: !!document.querySelector('#bar #ask'), panel: getComputedStyle(document.getElementById('ask-panel')).display, overflow: document.documentElement.scrollWidth > window.innerWidth }));
  check('phone: Ask JARVIS stays in the bottom toolbar', ui.inBar && ui.panel === 'none', JSON.stringify(ui));
  check('phone: the dock bar sits below the toolbar, not over the Ask field', dock && bar && bar.b <= dock.y + 1 && !overlap(dock, ask), `bar ${fmt(bar)} · dock ${fmt(dock)} · ask ${fmt(ask)}`);
  check('phone: no horizontal overflow', !ui.overflow);
  await shot(page, 'phone-390x844.png');
  await ctx.close();
}

check('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
await browser.close();
server.stop();
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed · screenshots in ${OUT}`);
process.exit(failed.length ? 1 : 0);
