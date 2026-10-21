#!/usr/bin/env node
// Spaces (virtual desktops) check: drives JARVIS in headless Chromium (Playwright from RIGS_AUDIT_TOOLS or
// ~/.cache/rigs-audit, as scripts/tiling-check.js) and checks wm.js Spaces end to end, saving screenshots: the menu bar
// indicator and its menu, adding a desktop, windows of the other desktop hidden and back with the same rect and
// tiled / maximized / minimized state, Ctrl+←/→ and Ctrl+1…9 (ignored in a text field), focusing a window on another
// desktop switches there, moving a window from its context menu, a reload putting a keyed window back on its desktop,
// removing a desktop that holds windows, and a 390x844 phone with no indicator.
//   node scripts/spaces-check.js [--url http://127.0.0.1:4719/] [--out screenshots/spaces]
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
const OUT = path.resolve(opt('out', path.join(ROOT, 'screenshots/spaces')));
fs.mkdirSync(OUT, { recursive: true });

async function startServer() {
  if (opt('url', '')) return { url: opt('url', ''), stop() {} };
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'rigs-spaces-'));
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
const near = (a, b, tol = 1) => !!a && !!b && ['x', 'y', 'w', 'h'].every((k) => Math.abs(a[k] - b[k]) <= tol);

const rect = (page, sel) => page.evaluate((s) => { const b = document.querySelector(s)?.getBoundingClientRect(); return b && { x: b.left, y: b.top, w: b.width, h: b.height }; }, sel);
/** What the window looks like: on stage, rect, classes that carry its state. */
const look = (page, sel) => page.evaluate((s) => {
  const el = document.querySelector(s);
  if (!el) return null;
  const b = el.getBoundingClientRect();
  return {
    shown: getComputedStyle(el).display !== 'none', rect: { x: b.left, y: b.top, w: b.width, h: b.height },
    off: el.classList.contains('off-space'), tiled: el.classList.contains('tiled'), tile: el.dataset.tile || '', max: el.classList.contains('max'),
    min: el.classList.contains('min'), state: el._wm?.state(), desktop: el.dataset.desktop,
  };
}, sel);
const indicator = (page) => page.evaluate(() => { const b = document.querySelector('#mb-tray [data-tray-item="spaces"]'); return b && b.offsetParent !== null ? b.textContent.trim() : null; });
const blur = (page) => page.evaluate(() => document.activeElement?.blur?.());
const press = async (page, chord) => { await blur(page); await page.keyboard.press(chord); await sleep(420); };

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
  await sleep(350);
}
/** Open the indicator's menu; with `pick`, click that item. */
async function spacesMenu(page, pick, { shot } = {}) {
  await page.click('#mb-tray [data-tray-item="spaces"]');
  await sleep(300);
  if (shot) await page.screenshot({ path: path.join(OUT, shot) });
  if (pick) { await page.locator('.mb-menu.mb-ctx .mb-item', { hasText: pick }).first().click(); await sleep(450); }
}
const openSessions = (page) => openWin(page, () => menuItem(page, 'file', 'Open session'));
const openShortcuts = (page) => openWin(page, () => menuItem(page, 'help', 'Keyboard shortcuts'));
const openAbout = (page) => openWin(page, () => menuItem(page, 'help', 'About RIGS'));
const openRegistry = (page) => openWin(page, () => menuItem(page, 'tools', 'Tool registry'));
const winBtn = (page, sel, cls) => page.click(`${sel} .win-bar .win-btn.${cls}`);

const browser = await chromium.launch({ args: ['--no-sandbox'] });
const errors = [];

// ------------------------------------------------------------------ desktop 1440x900
{
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(URL, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#menubar');
  await sleep(1500);

  check('the menu bar shows the desktop indicator', (await indicator(page)) === 'Desktop 1', await indicator(page));

  // Desktop 1: a tiled window, a moved one, a minimized one.
  const A = await openSessions(page);
  await blur(page);
  await page.evaluate((s) => { document.querySelector(s)._wm.raise(); document.querySelector(`${s} .win-btn`).focus(); }, A);
  await page.keyboard.press('Control+Alt+ArrowLeft');
  await sleep(450);
  const B = await openShortcuts(page);
  const C = await openAbout(page);
  await winBtn(page, C, 'win-min');
  await sleep(400);
  const a1 = await look(page, A);
  const b1 = await look(page, B);
  check('desktop 1 holds a tiled, a normal and a minimized window', a1.tiled && a1.tile === 'left' && b1.shown && !b1.max && (await look(page, C)).min, JSON.stringify({ a1, b1 }));
  await page.screenshot({ path: path.join(OUT, 'desktop-1.png') });

  // The indicator menu: add a desktop (it switches there).
  await spacesMenu(page, null, { shot: 'indicator-menu.png' });
  const items = await page.evaluate(() => [...document.querySelectorAll('.mb-menu.mb-ctx .mb-item')].map((i) => i.textContent.trim()));
  check('the indicator menu lists desktops and add / remove', items.some((t) => t.includes('Desktop 1')) && items.some((t) => t.includes('Add desktop')) && items.some((t) => t.includes('Remove')), items.join(' | '));
  await page.locator('.mb-menu.mb-ctx .mb-item', { hasText: 'Add desktop' }).first().click();
  await sleep(500);
  check('Add desktop switches to Desktop 2', /Desktop 2$/.test((await indicator(page)) || ''), await indicator(page));
  const off = await Promise.all([A, B, C].map((s) => look(page, s)));
  check('desktop 1\'s windows are hidden on desktop 2', off.every((w) => !w.shown && w.off), JSON.stringify(off.map((w) => ({ shown: w.shown, off: w.off }))));
  check('hiding does not minimize them or change their state', off[0].state === 'normal' && off[0].tiled && off[1].state === 'normal' && off[2].state === 'minimized');

  // Desktop 2: a maximized window.
  const D = await openRegistry(page);
  await winBtn(page, D, 'win-max');
  await sleep(400);
  check('a window opened on desktop 2 is on desktop 2', (await look(page, D)).desktop === 'd2' && (await look(page, D)).max);
  await page.screenshot({ path: path.join(OUT, 'desktop-2.png') });
  await spacesMenu(page, null, { shot: 'indicator-menu-2-desktops.png' });
  await page.keyboard.press('Escape');
  await sleep(200);

  // Ctrl+← back to desktop 1: everything as it was.
  await press(page, 'Control+ArrowLeft');
  const [a2, b2, c2, d2] = await Promise.all([A, B, C, D].map((s) => look(page, s)));
  check('Ctrl+← switches to Desktop 1', (await indicator(page))?.endsWith('Desktop 1'), await indicator(page));
  check('the tiled window comes back tiled at the same rect', a2.shown && a2.tiled && a2.tile === 'left' && near(a2.rect, a1.rect), JSON.stringify({ a1: a1.rect, a2: a2.rect }));
  check('the normal window comes back at the same rect and size', b2.shown && near(b2.rect, b1.rect), JSON.stringify({ b1: b1.rect, b2: b2.rect }));
  check('the minimized window stays minimized', c2.min && !c2.shown && c2.state === 'minimized');
  check('desktop 2\'s window is hidden', !d2.shown && d2.off);
  await sleep(300);
  await page.screenshot({ path: path.join(OUT, 'desktop-1-back.png') });

  // Ctrl+2 jumps; the maximized window is still maximized.
  await press(page, 'Control+2');
  const d3 = await look(page, D);
  check('Ctrl+2 jumps to Desktop 2; the maximized window is still maximized', (await indicator(page))?.endsWith('Desktop 2') && d3.shown && d3.max && d3.state === 'maximized', JSON.stringify(d3));
  await press(page, 'Control+1');
  check('Ctrl+1 jumps to Desktop 1', (await indicator(page))?.endsWith('Desktop 1'));
  await press(page, 'Control+ArrowLeft');
  check('Ctrl+← on the first desktop stays there', (await indicator(page))?.endsWith('Desktop 1'));
  await press(page, 'Control+9');
  check('Ctrl+9 with two desktops does nothing', (await indicator(page))?.endsWith('Desktop 1'));

  // Not while typing.
  const field = await page.evaluate(() => { const f = [...document.querySelectorAll('input[type=text], input:not([type]), textarea')].find((e) => e.offsetParent !== null); if (!f) return false; f.focus(); return true; });
  if (field) { await page.keyboard.press('Control+ArrowRight'); await sleep(400); }
  check('Ctrl+→ in a text field does not switch', field && (await indicator(page))?.endsWith('Desktop 1'));

  // Focusing a window that lives on desktop 2 switches there (Window menu › Open windows).
  const dTitle = await page.evaluate((s) => document.querySelector(s)._wm.title(), D);
  await menuItem(page, 'window', dTitle);
  check('focusing a window on another desktop switches to it', (await indicator(page))?.endsWith('Desktop 2') && (await look(page, D)).shown, await indicator(page));
  // Restoring a minimized window of desktop 1 (its app dock / Window menu entry) switches back.
  await page.evaluate((s) => document.querySelector(s)._wm.raise(), C);
  await sleep(500);
  const c3 = await look(page, C);
  check('restoring a minimized window on another desktop switches there and restores it', (await indicator(page))?.endsWith('Desktop 1') && c3.shown && c3.state === 'normal', JSON.stringify(c3));

  // Move a window to desktop 2 from its title bar's context menu.
  await page.click(`${B} .win-bar .win-title-text`, { button: 'right' });
  await sleep(300);
  await page.locator('.mb-menu .mb-item', { hasText: 'Move to desktop' }).first().hover();
  await sleep(350);
  await page.screenshot({ path: path.join(OUT, 'move-to-desktop-menu.png') });
  await page.locator('.mb-menu .mb-item', { hasText: 'Desktop 2' }).last().click();
  await sleep(400);
  check('Move to desktop › Desktop 2 hides it here and puts it on desktop 2', !(await look(page, B)).shown && (await look(page, B)).desktop === 'd2');

  // A reload: the active desktop and a keyed window's desktop are remembered.
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#menubar');
  await sleep(1500);
  check('after a reload the indicator shows the desktop this browser was on', (await indicator(page))?.endsWith('Desktop 1'), await indicator(page));
  const B2 = await openShortcuts(page);
  check('a keyed window reopened after a reload goes back to its desktop (and takes you there)', (await look(page, B2)).desktop === 'd2' && (await indicator(page))?.endsWith('Desktop 2'), JSON.stringify(await look(page, B2)));
  // Sessions was open on desktop 1 when the page reloaded: reopened by hand, it goes back there.
  const E = await openSessions(page);
  check('…and another goes back to desktop 1, where it was', (await look(page, E)).desktop === 'd1' && (await indicator(page))?.endsWith('Desktop 1'), JSON.stringify(await look(page, E)));
  await press(page, 'Control+2');
  const F = await openRegistry(page); // it was on desktop 2 before the reload
  check('…and one that was on desktop 2 opens there', (await look(page, F)).desktop === 'd2' && (await indicator(page))?.endsWith('Desktop 2'));

  // Remove desktop 2 (it holds windows): they move to desktop 1, which becomes active.
  await spacesMenu(page, 'Remove');
  const [b3, e3, f3] = await Promise.all([B2, E, F].map((s) => look(page, s)));
  check('removing a desktop moves its windows to its neighbour', (await indicator(page)) === 'Desktop 1' && [b3, e3, f3].every((w) => w.shown && w.desktop === 'd1'), JSON.stringify({ ind: await indicator(page), b3, e3, f3 }));
  await spacesMenu(page);
  const removeOff = await page.evaluate(() => [...document.querySelectorAll('.mb-menu.mb-ctx .mb-item')].find((i) => i.textContent.includes('Remove'))?.getAttribute('aria-disabled'));
  check('the last desktop can\'t be removed', removeOff === 'true', String(removeOff));
  await page.keyboard.press('Escape');
  await page.screenshot({ path: path.join(OUT, 'after-remove.png') });
  await ctx.close();
}

// ------------------------------------------------------------------ phone 390x844
{
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(URL, { waitUntil: 'domcontentloaded' });
  await sleep(2000);
  const shown = await page.evaluate(() => [...document.querySelectorAll('[data-tray-item="spaces"]')].some((b) => b.offsetParent !== null));
  check('no desktop indicator on a 390x844 phone', !shown);
  await page.screenshot({ path: path.join(OUT, 'phone-390x844.png') });
  await ctx.close();
}

await browser.close();
check('no page errors', errors.length === 0, errors.join(' | '));
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed · screenshots in ${OUT}`);
process.exit(failed.length ? 1 : 0);
