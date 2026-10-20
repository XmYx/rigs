#!/usr/bin/env node
// Docking check: drives JARVIS in headless Chromium (Playwright from RIGS_AUDIT_TOOLS or ~/.cache/rigs-audit, as
// scripts/mobile-shots.js) and checks the dockable panel layout end to end, saving screenshots on the way:
// whole-title-bar drags with docking off, the ☰ docking switch, drop zones mid-drag, side-by-side and tabbed docks,
// a docked window, splitters, tab keys/reorder/drag-out, hide → reload → restore to the same place, Esc to cancel,
// switching docking off, Reset layout, and phones (390x844) ignoring a saved docked layout.
//   node scripts/dock-check.js [--url http://127.0.0.1:4719/] [--out screenshots/dock]
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
const OUT = path.resolve(opt('out', path.join(ROOT, 'screenshots/dock')));
fs.mkdirSync(OUT, { recursive: true });

async function startServer() {
  if (opt('url', '')) return { url: opt('url', ''), stop() {} };
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'rigs-dock-'));
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

/** A point on the element's bar that is not a control (what a user would grab). */
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
const rect = (page, sel) => page.evaluate((s) => { const b = document.querySelector(s)?.getBoundingClientRect(); return b && { x: b.left, y: b.top, w: b.width, h: b.height }; }, sel);

async function drag(page, from, to, { steps = 14, shot = null, hold = false } = {}) {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  for (let i = 1; i <= steps; i++) { await page.mouse.move(from.x + ((to.x - from.x) * i) / steps, from.y + ((to.y - from.y) * i) / steps); await sleep(16); }
  await sleep(260);
  if (shot) await page.screenshot({ path: path.join(OUT, shot) });
  if (!hold) { await page.mouse.up(); await sleep(420); }
}

const browser = await chromium.launch({ args: ['--no-sandbox'] });
const errors = [];

// ------------------------------------------------------------------ desktop 1920x1080
{
  const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(URL, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#panels-btn');
  await sleep(1500);

  // (1) Docking off: drag the chat dock by its header; mid-drag shot.
  const chatBefore = await rect(page, '#chat-dock');
  const g = await grab(page, '#chat-dock .dock-head');
  await drag(page, g, { x: g.x - 380, y: g.y - 300 }, { shot: 'floating-drag@1920x1080.png' });
  const chatAfter = await rect(page, '#chat-dock');
  check('mode off: whole header drags the chat dock', Math.abs(chatAfter.x - (chatBefore.x - 380)) < 3 && Math.abs(chatAfter.y - (chatBefore.y - 300)) < 3, JSON.stringify({ chatBefore, chatAfter }));
  check('mode off: no drop-zone overlay', !(await page.evaluate(() => document.querySelector('.dock-preview.show'))));
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('rigs.dock')).floating.find((f) => f.id === 'dock'));
  check('floating rect persisted in rigs.dock', saved && Math.abs(saved.x - chatAfter.x) < 2, JSON.stringify(saved));

  // Controls inside a bar still click: collapse the Active projects panel from its header and back.
  await page.click('#work .pctl .win-btn.win-min');
  await sleep(250);
  const collapsed = await page.evaluate(() => document.querySelector('#work').classList.contains('panel-min'));
  await page.click('#work .pctl .win-btn.win-min');
  await sleep(250);
  check('buttons inside the header still click (minimize/restore)', collapsed && !(await page.evaluate(() => document.querySelector('#work').classList.contains('panel-min'))));

  // A wm window: drag by its title, double-click maximises and restores.
  await page.click('#btn-sess');
  await page.waitForSelector('.win.sess-win');
  await sleep(600);
  const wb = await rect(page, '.win.sess-win');
  const wg = await grab(page, '.win.sess-win .win-bar');
  await drag(page, wg, { x: wg.x + 150, y: wg.y + 90 });
  const wa = await rect(page, '.win.sess-win');
  check('window drags by its whole title bar', Math.abs(wa.x - wb.x - 150) < 3 && Math.abs(wa.y - wb.y - 90) < 3, JSON.stringify({ wb, wa }));
  const wg2 = await grab(page, '.win.sess-win .win-bar');
  await page.mouse.dblclick(wg2.x, wg2.y);
  await sleep(300);
  const maxed = await page.evaluate(() => document.querySelector('.win.sess-win').classList.contains('max'));
  const wg3 = await grab(page, '.win.sess-win .win-bar');
  await page.mouse.dblclick(wg3.x, wg3.y);
  await sleep(300);
  check('double-click on the bar maximises and restores a window', maxed && !(await page.evaluate(() => document.querySelector('.win.sess-win').classList.contains('max'))));
  await page.click('.win.sess-win .win-btn.close');
  await sleep(400);

  // (2) Docking on from the ☰ menu.
  await page.click('#panels-btn');
  await sleep(250);
  await page.check('#panels-menu .pm-dock input');
  await page.click('#panels-btn');
  await sleep(300);
  check('docking mode persisted', await page.evaluate(() => localStorage.getItem('rigs.docking') === '1'));

  // Dock the side panel to the left of the galaxy (pointer on the stage's left zone).
  const lg = await grab(page, '#left .brand');
  await drag(page, lg, { x: 420, y: 560 }, { shot: 'drop-zones@1920x1080.png', hold: true });
  const overlay = await page.evaluate(() => ({ preview: !!document.querySelector('.dock-preview.show'), compass: !!document.querySelector('.dock-compass.show'), label: document.querySelector('.dock-label.show')?.textContent }));
  await page.mouse.up();
  await sleep(500);
  check('mid-drag shows drop-zone preview + compass', overlay.preview && overlay.compass, JSON.stringify(overlay));
  check('side panel docked', await page.evaluate(() => document.querySelector('#left').classList.contains('docked')));

  // Dock Active projects to the right of the side panel, and Filters below it.
  const wk = await grab(page, '#work .wk-head');
  const L = await rect(page, '#left');
  await drag(page, wk, { x: L.x + L.w - 20, y: L.y + L.h / 2 });
  check('Active projects docked beside the side panel', await page.evaluate(() => document.querySelector('#work').classList.contains('docked')));
  const lgd = await grab(page, '#legend .sec-h');
  const W = await rect(page, '#work');
  await drag(page, lgd, { x: W.x + W.w / 2, y: W.y + W.h - 20 });
  // A window too: open Sessions and dock it on the right of the screen.
  await page.click('#btn-sess');
  await page.waitForSelector('.win.sess-win');
  await sleep(700);
  const sg = await grab(page, '.win.sess-win .win-bar');
  await drag(page, sg, { x: 1905, y: 540 });
  check('a window docks (screen right edge)', await page.evaluate(() => document.querySelector('.win.sess-win').classList.contains('docked')));
  await page.screenshot({ path: path.join(OUT, 'side-by-side@1920x1080.png') });
  const layoutA = await page.evaluate(() => JSON.parse(localStorage.getItem('rigs.dock')).root);
  check('tree holds left + work + legend + stage', ['left', 'work', 'legend', 'stage'].every((id) => JSON.stringify(layoutA).includes(`"${id}"`)), JSON.stringify(layoutA));

  // Splitter: drag the first vertical separator 120px right.
  const sp = await page.evaluate(() => { const s = [...document.querySelectorAll('.dock-split.row')].find((x) => /and galaxy$/.test(x.getAttribute('aria-label'))); const b = s.getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2, label: s.getAttribute('aria-label'), v: s.getAttribute('aria-valuenow') }; });
  const before = await rect(page, '#work');
  await drag(page, sp, { x: sp.x + 240, y: sp.y }, { steps: 8 });
  const after = await rect(page, '#work');
  check('splitter resizes docked panels', Math.abs(after.w - before.w) > 40, `${sp.label}: ${before.w} → ${after.w}`);

  // (3) Tabs: drop Questions onto the centre of Active projects.
  if (await page.evaluate(() => document.querySelector('#questions').classList.contains('panel-closed'))) await page.click('#btn-ask');
  await sleep(500);
  const qg = await grab(page, '#questions .wk-head');
  const W2 = await rect(page, '#work');
  await drag(page, qg, { x: W2.x + W2.w / 2, y: W2.y + W2.h / 2 }, { shot: 'drop-zone-tab@1920x1080.png', hold: true });
  await page.mouse.up();
  await sleep(500);
  const tabs = await page.evaluate(() => [...document.querySelectorAll('.dock-tab')].map((t) => ({ id: t.dataset.id, sel: t.getAttribute('aria-selected'), role: t.getAttribute('role') })));
  check('Questions became a tab with Active projects', tabs.length === 2 && tabs.every((t) => t.role === 'tab') && (await page.evaluate(() => document.querySelector('.dock-tabs').getAttribute('role'))) === 'tablist', JSON.stringify(tabs));
  // Keyboard tab switching.
  await page.focus('.dock-tab[aria-selected="true"]');
  const firstSel = await page.evaluate(() => document.activeElement.dataset.id);
  await page.keyboard.press('ArrowRight');
  await sleep(200);
  const nowSel = await page.evaluate(() => ({ focus: document.activeElement.dataset.id, sel: document.querySelector('.dock-tab[aria-selected="true"]').dataset.id }));
  check('arrow keys switch tabs', nowSel.sel !== firstSel && nowSel.focus === nowSel.sel, JSON.stringify({ firstSel, nowSel }));
  const hiddenTabPanel = await page.evaluate((id) => getComputedStyle(document.querySelector(id === 'work' ? '#questions' : '#work')).display, nowSel.sel);
  check('inactive tab panel is not shown', hiddenTabPanel === 'none', hiddenTabPanel);
  // Reorder by drag within the strip.
  const order1 = await page.evaluate(() => [...document.querySelectorAll('.dock-tab')].map((t) => t.dataset.id));
  const t0 = await page.evaluate(() => { const b = document.querySelector('.dock-tab').getBoundingClientRect(); return { x: b.left + 10, y: b.top + b.height / 2, r: document.querySelector('.dock-tabs').getBoundingClientRect().right }; });
  await drag(page, t0, { x: t0.r - 6, y: t0.y }, { steps: 8 });
  const order2 = await page.evaluate(() => [...document.querySelectorAll('.dock-tab')].map((t) => t.dataset.id));
  check('tabs reorder by drag', order2[0] === order1[1] && order2[1] === order1[0], `${order1} → ${order2}`);
  await page.screenshot({ path: path.join(OUT, 'tabbed@1920x1080.png') });

  // (4) Hide the active tab panel, reload, restore from ☰ → same tab group.
  const active = await page.evaluate(() => document.querySelector('.dock-tab[aria-selected="true"]').dataset.id);
  await page.click(`#${active} .pctl .win-btn.close`);
  await sleep(500);
  check('hidden panel leaves the tab group', (await page.evaluate(() => document.querySelectorAll('.dock-tab').length)) === 0);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#panels-btn');
  await sleep(1500);
  check('layout survives reload (still docked)', await page.evaluate(() => document.querySelector('#left').classList.contains('docked') && document.querySelector('#legend').classList.contains('docked')));
  check('docked window is gone after reload (windows do not persist)', await page.evaluate(() => !JSON.stringify(JSON.parse(localStorage.getItem('rigs.dock'))).includes('win-')));
  await page.click('#panels-btn');
  await sleep(300);
  const restoreBtns = await page.evaluate(() => [...document.querySelectorAll('#panels-menu .pm-restore')].map((b) => b.textContent));
  const activeTitle = active === 'work' ? 'Active projects' : 'Questions';
  check('☰ menu lists the hidden panel', restoreBtns.some((t) => t.includes(activeTitle)), JSON.stringify(restoreBtns));
  await page.screenshot({ path: path.join(OUT, 'panels-menu-hidden@1920x1080.png') });
  await page.click(`#panels-menu .pm-restore >> text=${activeTitle}`);
  await sleep(600);
  await page.click('#panels-btn');
  await sleep(300);
  const back = await page.evaluate(() => [...document.querySelectorAll('.dock-tab')].map((t) => t.dataset.id));
  check('restored panel returns to its tab group', back.includes(active) && back.length === 2, JSON.stringify(back));
  await page.screenshot({ path: path.join(OUT, 'restored-hidden@1920x1080.png') });

  // Drag a tab out to float it again.
  const tOut = await page.evaluate(() => { const b = document.querySelector('.dock-tab').getBoundingClientRect(); return { x: b.left + 12, y: b.top + b.height / 2, id: document.querySelector('.dock-tab').dataset.id }; });
  const st = await rect(page, '.dock-stage');
  await drag(page, tOut, { x: st.x + st.w / 2, y: st.y + st.h / 2 }, { steps: 16 });
  const outState = await page.evaluate((id) => ({ docked: document.getElementById(id).classList.contains('docked'), tabs: document.querySelectorAll('.dock-tab').length, floating: JSON.parse(localStorage.getItem('rigs.dock')).floating.some((f) => f.id === id) }), tOut.id);
  check('dragging a tab out floats it', !outState.docked && outState.tabs === 0 && outState.floating, JSON.stringify(outState));
  await page.screenshot({ path: path.join(OUT, 'tab-dragged-out@1920x1080.png') });

  // Esc cancels a drag.
  const lg2 = await grab(page, '#legend .sec-h');
  await drag(page, lg2, { x: 900, y: 500 }, { hold: true });
  await page.keyboard.press('Escape');
  await page.mouse.up();
  await sleep(400);
  check('Esc cancels a dock drag', await page.evaluate(() => document.querySelector('#legend').classList.contains('docked')));

  // (5) Docking off: every panel floats where it was.
  const leftDocked = await rect(page, '#left');
  await page.click('#panels-btn');
  await sleep(250);
  await page.uncheck('#panels-menu .pm-dock input');
  await page.click('#panels-btn');
  await sleep(500);
  const leftFloat = await rect(page, '#left');
  check('mode off: nothing docked, panels stay where they were', (await page.evaluate(() => document.querySelectorAll('.docked').length)) === 0 && Math.abs(leftFloat.x - leftDocked.x) < 2 && Math.abs(leftFloat.w - leftDocked.w) < 2, JSON.stringify({ leftDocked, leftFloat }));

  // Reset layout still works.
  await page.click('#panels-btn');
  await sleep(250);
  await page.click('#panels-menu >> text=Reset layout');
  await sleep(500);
  const leftReset = await page.evaluate(() => ({ inline: document.querySelector('#left').style.left, closed: document.querySelector('#work').classList.contains('panel-closed') }));
  check('Reset layout puts panels back at their CSS places', leftReset.inline === '' && !leftReset.closed, JSON.stringify(leftReset));
  await ctx.close();
}

// ------------------------------------------------------------------ phone 390x844
{
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  // Docking on, with a docked layout saved: the phone must ignore it.
  await ctx.addInitScript(() => {
    if (sessionStorage.getItem('seeded')) return;
    sessionStorage.setItem('seeded', '1');
    localStorage.setItem('rigs.docking', '1');
    localStorage.setItem('rigs.dock', JSON.stringify({ version: 1, root: { type: 'split', dir: 'row', ratios: [0.3, 0.7], children: [{ type: 'tabs', panels: ['work', 'questions'], active: 'work' }, { type: 'panel', id: 'stage' }] }, floating: [], hidden: {}, collapsed: [] }));
  });
  await page.goto(URL, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#btn-more');
  await sleep(1500);
  const ph = await page.evaluate(() => ({ docked: document.querySelectorAll('.docked').length, layer: (() => { const l = document.getElementById('dock-layer'); return !l || getComputedStyle(l).display === 'none'; })(), hscroll: document.documentElement.scrollWidth > innerWidth }));
  check('phone: no docking, no tab strips, no sideways scroll', ph.docked === 0 && ph.layer && !ph.hscroll, JSON.stringify(ph));
  await page.screenshot({ path: path.join(OUT, 'phone-home@390x844.png') });
  await page.tap('#btn-more');
  await sleep(400);
  await page.tap('#more-sheet #panels-btn');
  await sleep(400);
  check('phone: ☰ menu hides the docking switch', await page.evaluate(() => document.querySelector('#panels-menu .pm-dock').hidden));
  await page.screenshot({ path: path.join(OUT, 'phone-panels-menu@390x844.png') });
  await page.keyboard.press('Escape');
  await sleep(300);
  await page.tap('#btn-more');
  await sleep(400);
  await page.tap('#more-sheet #btn-sess');
  await page.waitForSelector('.win.sess-win');
  await sleep(700);
  const full = await rect(page, '.win.sess-win');
  check('phone: windows stay full-screen', full.w >= 370, JSON.stringify(full));
  await page.screenshot({ path: path.join(OUT, 'phone-window@390x844.png') });
  await ctx.close();
}

await browser.close();
check('no page errors', !errors.length, errors.join(' | '));
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
server.stop();
process.exit(failed.length ? 1 : 0);
