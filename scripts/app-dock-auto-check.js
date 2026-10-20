#!/usr/bin/env node
// App dock auto-docking check: drives JARVIS in headless Chromium (Playwright from RIGS_AUDIT_TOOLS or ~/.cache/rigs-audit,
// as scripts/app-dock-check.js) and checks the two default-off settings end to end, saving screenshots on the way:
//   1. both off: a newly opened panel, a floating window and an automatically surfaced session behave as before and
//      nothing is docked or tabbed
//   2. the dock settings menu offers both settings
//   3. autoDock on: a new panel and a new window get dock items; closing them removes the items
//   4. autoTabTerminals on: several sessions surfaced in the background (real tmux sessions, announced through
//      POST /api/local/notify, the same path agents use) become tabs of ONE Terminals window and one Terminals group
//   5. both settings survive a reload, and a reload leaves no stale window / terminal items
//   6. the 390x844 phone bar shows the Terminals group
//   node scripts/app-dock-auto-check.js [--url http://127.0.0.1:4719/] [--out ~/.rigs/screens/dock/auto]
// Without --url it starts a throwaway `rigs serve` (scratch RIGS_HOME, no OpenRig, no migrations, no autoupdate).
// Needs tmux. Exit code 1 when a check fails.
import { spawn, execFileSync } from 'node:child_process';
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
const OUT = path.resolve(opt('out', path.join(os.homedir(), '.rigs/screens/dock/auto')).replace(/^~/, os.homedir()));
fs.mkdirSync(OUT, { recursive: true });

const SAMPLE_APPS = [['notes', 'Notes', '📝'], ['krea', 'Krea Studio', '🎨'], ['fuel', 'Fuel Tracker', '⛽'], ['comfy', 'ComfyUI', '🧪']];
const RUN = Date.now().toString(36);
const tmuxNames = [];

async function startServer() {
  if (opt('url', '')) return { url: opt('url', ''), stop() {} };
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'rigs-adauto-'));
  const port = await new Promise((resolve, reject) => { const s = net.createServer(); s.once('error', reject); s.listen(0, '127.0.0.1', () => { const { port: p } = s.address(); s.close(() => resolve(p)); }); });
  const apps = SAMPLE_APPS.map(([id, name, icon], i) => ({ id, name, icon, port: 47900 + i }));
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
const self = await (await fetch(`${URL}api/self`)).json();

const state = (page) => page.evaluate(() => JSON.parse(JSON.stringify(globalThis.__rigsAppDock.state)));
const shot = (page, name) => page.screenshot({ path: path.join(OUT, name) });
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const dockKinds = (s) => Object.values(s.items).map((i) => i.kind);
async function menuItem(page, label) {
  const by = (re) => page.locator('.mb-menu .mb-item').filter({ has: page.locator('.mb-label', { hasText: re }) }).last();
  const exact = by(new RegExp(`^${esc(label)}$`));
  return (await exact.count()) ? exact : by(new RegExp(`^${esc(label)}`));
}

async function ready(page) {
  await page.goto(URL, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.querySelectorAll('#app-dock .adock-tile').length >= 3, null, { timeout: 30000 });
  await sleep(1200);
  await page.mouse.move(400, 300);
}

const shelfEdge = (page) => page.evaluate(() => { const b = document.querySelector('#app-dock .adock-list').getBoundingClientRect(); return { x: b.left + 3, y: b.top + b.height / 2 }; });

/** Right-click the dock's shelf edge → its settings menu; click `label`, close the menu. */
async function toggleSetting(page, label) {
  const r = await shelfEdge(page);
  await page.mouse.click(r.x, r.y, { button: 'right' });
  await page.waitForSelector('.mb-menu', { timeout: 3000 });
  await sleep(150);
  await (await menuItem(page, label)).click();
  await sleep(250);
  await page.keyboard.press('Escape');
  await sleep(200);
}

async function openPanelFromMenu(page, label) {
  await page.click('#panels-btn');
  await sleep(300);
  await page.locator('#panels-menu .pm-restore', { hasText: label }).first().click();
  await sleep(500);
  await page.keyboard.press('Escape');
  await sleep(200);
  await page.mouse.move(400, 300);
}
async function closePanelFromMenu(page, label) {
  await page.click('#panels-btn');
  await sleep(300);
  await page.locator('#panels-menu label', { hasText: label }).first().locator('input').click();
  await sleep(500);
  await page.keyboard.press('Escape');
  await sleep(200);
}
async function openHelpWindow(page, label) {
  await page.click('#mb-top-help');
  await sleep(250);
  await (await menuItem(page, label)).click();
  await sleep(600);
}
/** Close the "session started" toasts so a screenshot shows the dock, not the notifications. */
async function dismissToasts(page) {
  for (const x of await page.locator('#toasts .toast-x').all()) await x.click({ timeout: 1500 }).catch(() => {});
  await sleep(500);
}
const count = (page, sel) => page.evaluate((s) => document.querySelectorAll(s).length, sel);

function tmux(name) {
  execFileSync('tmux', ['new-session', '-d', '-s', name, 'sleep 900']);
  tmuxNames.push(name);
}
async function announce(name, title) {
  const r = await fetch(`${URL}api/local/notify`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: `session ${name} started`, speak: false, session: { nodeId: self.id, nodeName: self.name, kind: 'tmux', id: name, title } }) });
  return r.ok;
}

const browser = await chromium.launch();
try {
  // ------------------------------------------------------------------ desktop: off → autoDock → autoTab
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  await ready(page);

  let s = await state(page);
  check('defaults: autoDock and autoTabTerminals are off', s.settings.autoDock === false && s.settings.autoTabTerminals === false);

  // 1) both off — a new panel, a floating window and an auto-opened session behave as before
  await openPanelFromMenu(page, 'Request traces');
  s = await state(page);
  check('off: a newly opened panel is NOT docked', !s.items['panel:traces'] && dockKinds(s).every((k) => k === 'applet' || k === 'rig'));
  await shot(page, 'auto-off-panel-not-docked.png');
  await openHelpWindow(page, 'Keyboard shortcuts');
  tmux(`adk-${RUN}-off`);
  check('notify accepted (off phase)', await announce(`adk-${RUN}-off`, 'build agent (off)'));
  await page.waitForSelector('.win.term-win', { timeout: 15000 });
  await sleep(900);
  s = await state(page);
  check('off: the new panel is visible', await page.evaluate(() => !document.getElementById('traces').classList.contains('panel-closed')));
  check('off: the new window opened', (await count(page, '.win:not(.term-win)')) >= 1);
  check('off: the auto-opened session has its OWN terminal window (no tabs host)', (await count(page, '.win.term-win:not(.term-tabs-win)')) === 1 && (await count(page, '.term-tabs-win')) === 0);
  check('off: nothing was docked or tabbed — the dock holds only applets and rigs', dockKinds(s).every((k) => k === 'applet' || k === 'rig') && Object.keys(s.groups).length === 0, JSON.stringify(dockKinds(s)));
  await dismissToasts(page);
  await shot(page, 'auto-off-window-and-session.png');
  await page.locator('.win.term-win .win-btn.close').first().click();
  await page.locator('.win:not(.term-win) .win-btn.close').first().click();
  await sleep(500);

  // 2) the settings menu
  const r0 = await shelfEdge(page);
  await page.mouse.click(r0.x, r0.y, { button: 'right' });
  await page.waitForSelector('.mb-menu', { timeout: 3000 });
  await sleep(250);
  const labels = await page.locator('.mb-menu .mb-item .mb-label').allTextContents();
  check('settings menu offers both automatic settings', labels.includes('Dock new panels and windows') && labels.includes('Tab auto-opened terminals together'), labels.join(' | '));
  await shot(page, 'auto-settings-menu.png');
  await page.keyboard.press('Escape');
  await sleep(200);

  // 3) autoDock on
  await toggleSetting(page, 'Dock new panels and windows');
  s = await state(page);
  check('autoDock switched on from the menu', s.settings.autoDock === true && s.settings.autoTabTerminals === false);
  await openPanelFromMenu(page, 'Active agents');
  await openHelpWindow(page, 'Keyboard shortcuts');
  s = await state(page);
  const panelId = 'panel:agents';
  const winId = Object.keys(s.items).find((k) => k.startsWith('window:'));
  check('autoDock on: the new panel is in the dock', !!s.items[panelId], Object.keys(s.items).join(','));
  check('autoDock on: the new window is in the dock with its title', !!winId && /shortcut/i.test(s.items[winId].title), winId && s.items[winId].title);
  check('autoDock on: the tiles are drawn', (await page.locator(`#app-dock [data-id="${panelId}"]`).count()) === 1 && (await page.locator(`#app-dock [data-id="${winId}"]`).count()) === 1);
  await shot(page, 'auto-dock-on-docked.png');
  await page.locator('.win:not(.term-win) .win-btn.close').first().click();
  await sleep(500);
  s = await state(page);
  check('closing the window removes its dock item', !s.items[winId]);
  await closePanelFromMenu(page, 'Active agents');
  s = await state(page);
  check('hiding the panel removes its dock item', !s.items[panelId], Object.keys(s.items).join(','));

  // 4) autoTabTerminals on
  await toggleSetting(page, 'Tab auto-opened terminals together');
  s = await state(page);
  check('autoTabTerminals switched on from the menu', s.settings.autoTabTerminals === true);
  const names = [1, 2, 3].map((n) => `adk-${RUN}-t${n}`);
  for (const [i, n] of names.entries()) { tmux(n); await announce(n, `agent ${i + 1} · ${['build', 'review', 'deploy'][i]}`); }
  await page.waitForFunction(() => document.querySelectorAll('.term-tabs-win .term-tab').length >= 3, null, { timeout: 25000 });
  await sleep(1200);
  await dismissToasts(page);
  s = await state(page);
  const g = s.groups['g-terminals'];
  check('autoTabTerminals on: ONE tabbed Terminals window holds all three sessions', (await count(page, '.term-tabs-win')) === 1 && (await count(page, '.term-tabs-win .term-tab')) === 3 && (await count(page, '.win.term-win:not(.term-tabs-win)')) === 0);
  check('autoTabTerminals on: one Terminals group in the dock with three terminals', !!g && g.name === 'Terminals' && g.items.length === 3 && g.items.every((i) => i.startsWith('terminal:')), JSON.stringify(g));
  await page.evaluate(() => globalThis.__rigsAppDock.openGroup('g-terminals'));
  await sleep(700);
  await shot(page, 'auto-tab-terminals-group.png');
  await page.keyboard.press('Escape');
  await sleep(300);
  await page.locator('.term-tabs-win .term-tab').nth(1).click();
  await sleep(500);
  check('tabs switch', (await page.locator('.term-tabs-win .term-tab.on').count()) === 1 && (await page.locator('.term-tabs-win .term-pane.on').count()) === 1);
  await shot(page, 'auto-tab-terminals-window.png');
  // a Terminals-group item in the dock brings its tab forward
  await page.evaluate(() => globalThis.__rigsAppDock.openGroup('g-terminals'));
  await sleep(500);
  await page.locator('.adock-pop .adock-pop-tile').first().click();
  await sleep(600);
  check('clicking a Terminals group item brings its tab to the front', await page.locator('.term-tabs-win .term-tab').first().evaluate((el) => el.classList.contains('on')));
  await page.keyboard.press('Escape');
  // closing one tab removes its item
  await page.locator('.term-tabs-win .term-tab-x').first().click();
  await sleep(500);
  s = await state(page);
  check('closing a tab removes its terminal item', (await count(page, '.term-tabs-win .term-tab')) === 2 && s.groups['g-terminals'].items.length === 2);

  // 5) reload: settings persist, no stale window/terminal items
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.querySelectorAll('#app-dock .adock-tile').length >= 3, null, { timeout: 30000 });
  await sleep(1200);
  s = await state(page);
  check('both settings survive a reload', s.settings.autoDock === true && s.settings.autoTabTerminals === true);
  check('a reload leaves no stale window or terminal items and no empty Terminals group', !dockKinds(s).includes('window') && !dockKinds(s).includes('terminal') && !s.groups['g-terminals'], JSON.stringify(dockKinds(s)));
  await toggleSetting(page, 'Dock new panels and windows');
  await toggleSetting(page, 'Tab auto-opened terminals together');
  s = await state(page);
  check('both settings can be switched back off', s.settings.autoDock === false && s.settings.autoTabTerminals === false);
  await ctx.close();

  // ------------------------------------------------------------------ phone 390x844
  const pctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  await pctx.addInitScript(() => { try { localStorage.setItem('rigs.appdock', JSON.stringify({ v: 1, settings: { autoDock: true, autoTabTerminals: true } })); } catch {} });
  const phone = await pctx.newPage();
  phone.on('pageerror', (e) => errors.push(e.message));
  await phone.goto(URL, { waitUntil: 'domcontentloaded' });
  await phone.waitForFunction(() => document.querySelectorAll('#app-dock .adock-tile').length >= 3, null, { timeout: 30000 });
  await sleep(1500);
  const pn = [1, 2].map((n) => `adk-${RUN}-p${n}`);
  for (const [i, n] of pn.entries()) { tmux(n); await announce(n, `agent ${i + 1}`); }
  await phone.waitForFunction(() => document.querySelectorAll('.term-tabs-win .term-tab').length >= 2, null, { timeout: 25000 });
  await sleep(1000);
  const ps = await state(phone);
  check('phone: settings from storage are honoured and two sessions are tabbed into one group', ps.settings.autoTabTerminals === true && ps.groups['g-terminals']?.items.length === 2);
  check('phone: the group is on the bar', (await phone.locator('#app-dock .adock-group[data-gid="g-terminals"]').count()) === 1);
  check('phone: no horizontal overflow', await phone.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1));
  await dismissToasts(phone);
  await shot(phone, 'auto-phone-390x844-terminals-window.png');
  // a phone window is full screen and covers the bar: hide it for the capture only, to show the bar with the group
  await phone.evaluate(() => { document.querySelector('.term-tabs-win').style.visibility = 'hidden'; });
  await sleep(300);
  await shot(phone, 'auto-phone-390x844.png');
  await phone.evaluate(() => { document.querySelector('.term-tabs-win').style.visibility = ''; });
  await phone.locator('.term-tabs-win .win-btn.close').click();
  await sleep(500);
  check('phone: closing the Terminals window clears the group', !(await state(phone)).groups['g-terminals']);
  await pctx.close();
} finally {
  for (const n of tmuxNames) { try { execFileSync('tmux', ['kill-session', '-t', n], { stdio: 'ignore' }); } catch { /* gone */ } }
  await browser.close();
  server.stop();
}

check('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed — screenshots in ${OUT}`);
process.exit(failed.length ? 1 : 0);
