#!/usr/bin/env node
// Dock layout sync check: two throwaway daemons peered with each other (separate RIGS_HOME and ports, static peers,
// one mesh token), one JARVIS page on each, driven in headless Chromium (Playwright from RIGS_AUDIT_TOOLS or
// ~/.cache/rigs-audit, as scripts/dock-check.js). It checks the dock layout + app dock sync end to end:
//   1. migration: A's first load with a localStorage-only layout uploads it (and B's daemon gets it)
//   2. a fresh page on B starts with that layout
//   3. live: rearranging A's app dock and docking a panel on A shows up on the open B page without a reload,
//      and nothing echoes back (no PUT from B, A's stamps unchanged)
//   4. a drag held on B is not disturbed by a change from A; the change lands when the pointer is released
//   5. B reloaded with cleared storage restores the synced layout
//   6. a 390x844 phone on B shows the synced app dock and never writes a panel layout back
//   7. Dock settings says the layout is synced; "Reset layout for all machines" resets A and, live, B
//   8. a layout saved by a newer JARVIS (higher version) is neither applied nor overwritten by these pages
//   node scripts/dock-sync-check.js [--out ~/.rigs/screens/dock/sync]
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
const OUT = path.resolve(opt('out', path.join(os.homedir(), '.rigs/screens/dock/sync')).replace(/^~/, os.homedir()));
fs.mkdirSync(OUT, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, ok, extra = '') => { results.push({ name, ok: !!ok }); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${extra ? ' — ' + extra : ''}`); };
const shots = [];
const shot = async (page, name) => { const p = path.join(OUT, name); await page.screenshot({ path: p }); shots.push(p); };
const freePort = () => new Promise((resolve, reject) => { const s = net.createServer(); s.once('error', reject); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }); });

// ------------------------------------------------------------------ two peered daemons
const TOKEN = `dock-sync-${process.pid}-${Date.now()}`;
const ports = [await freePort(), await freePort()];
const daemons = [];
for (const [i, name] of ['dock-A', 'dock-B'].entries()) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), `rigs-${name}-`));
  const peer = `http://127.0.0.1:${ports[1 - i]}`;
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ port: ports[i], name, peers: [peer], openrig: { registerPeers: false } }));
  const log = fs.openSync(path.join(home, 'serve.log'), 'a');
  const child = spawn(process.execPath, ['bin/rigs.js', 'serve'], {
    cwd: ROOT, stdio: ['ignore', log, log],
    env: { ...process.env, RIGS_HOME: home, RIGS_PORT: String(ports[i]), RIGS_SSH_DIR: path.join(home, 'ssh'), RIGS_MESH_TOKEN: TOKEN, RIGS_NO_MIGRATIONS: '1', RIGS_NO_AUTOUPDATE: '1', RIGS_NO_OPENRIG: '1' },
  });
  daemons.push({ name, home, child, url: `http://127.0.0.1:${ports[i]}/` });
}
const stop = () => { for (const d of daemons) { try { d.child.kill(); } catch { /* gone */ } } };
process.on('exit', () => { stop(); for (const d of daemons) fs.rmSync(d.home, { recursive: true, force: true }); });
const [A, B] = daemons;
const getJson = async (d, p) => (await fetch(new URL(p, d.url))).json();
const layoutOf = (d) => getJson(d, '/api/local/ui-layout');

async function waitFor(fn, ms = 30000, step = 250) {
  const end = Date.now() + ms;
  for (;;) { try { const v = await fn(); if (v) return v; } catch { /* not yet */ } if (Date.now() > end) return null; await sleep(step); }
}
for (const d of daemons) if (!(await waitFor(async () => (await fetch(d.url)).ok))) { console.error(`${d.name} did not come up:\n${fs.readFileSync(path.join(d.home, 'serve.log'), 'utf8').slice(-2000)}`); process.exit(1); }
// Static peers are probed every 15 s; wait until each daemon sees the other online.
const peered = await waitFor(async () => {
  const [a, b] = await Promise.all([getJson(A, '/api/nodes'), getJson(B, '/api/nodes')]);
  return a.some((n) => n.name === 'dock-B' && n.online && n.rigs) && b.some((n) => n.name === 'dock-A' && n.online && n.rigs);
}, 45000, 500);
check('the two daemons see each other', peered);

// ------------------------------------------------------------------ helpers (as scripts/dock-check.js / app-dock-check.js)
const TILES = '#app-dock .adock-list > .adock-tile';
const rect = (page, sel) => page.evaluate((s) => { const b = document.querySelector(s)?.getBoundingClientRect(); return b && { x: b.left, y: b.top, w: b.width, h: b.height, cx: b.left + b.width / 2, cy: b.top + b.height / 2 }; }, sel);
const rects = (page, sel) => page.evaluate((s) => [...document.querySelectorAll(s)].map((el) => { const b = el.getBoundingClientRect(); return { x: b.left, y: b.top, w: b.width, h: b.height, cx: b.left + b.width / 2, cy: b.top + b.height / 2 }; }), sel);
const dockState = (page) => page.evaluate(() => JSON.parse(JSON.stringify(globalThis.__rigsAppDock.state)));
const orderKey = (s) => s.order.map((e) => `${e.type}:${e.id}`).join(' ');
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
let dropAt = 0; // when the last drag() let go
async function drag(page, from, to, { steps = 14, hold = false } = {}) {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  for (let i = 1; i <= steps; i++) { await page.mouse.move(from.x + ((to.x - from.x) * i) / steps, from.y + ((to.y - from.y) * i) / steps); await sleep(16); }
  await sleep(260);
  if (!hold) { await page.mouse.up(); dropAt = Date.now(); await sleep(420); }
}
/** The app dock's own drag: the dock un-magnifies when it begins, so the target is picked after the first move. */
async function dragTile(page, from, pickTarget, { steps = 14 } = {}) {
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
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
async function menuItem(page, label) {
  const by = (re) => page.locator('.mb-menu .mb-item').filter({ has: page.locator('.mb-label', { hasText: re }) }).last();
  const exact = by(new RegExp(`^${esc(label)}$`));
  return (await exact.count()) ? exact : by(new RegExp(`^${esc(label)}`));
}
async function menu(page, x, y, labels) {
  await page.mouse.click(x, y, { button: 'right' });
  await page.waitForSelector('.mb-menu', { timeout: 3000 });
  await sleep(150);
  for (const label of labels) { await (await menuItem(page, label)).click(); await sleep(220); }
}
async function open(ctx, d, { errors }) {
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(`${d.name}: ${e.message}`));
  page.puts = [];
  page.putLog = [];
  page.on('request', (r) => { if (r.method() === 'PUT' && r.url().includes('/api/local/ui-layout')) { let k = '?'; try { k = r.postDataJSON().key; } catch { /* keep ? */ } page.puts.push(k); page.putLog.push({ key: k, at: Date.now() }); } });
  await page.goto(d.url, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.querySelectorAll('#app-dock .adock-tile').length >= 4 && globalThis.__rigsSyncedStorage, null, { timeout: 30000 });
  await sleep(1500);
  await page.mouse.move(700, 450);
  return page;
}

const browser = await chromium.launch({ args: ['--no-sandbox'] });
const errors = [];
const VP = { width: 1920, height: 1080 };

// ------------------------------------------------------------------ 1. migration from a localStorage-only layout on A
const legacyDock = { version: 1, root: { type: 'panel', id: 'stage' }, floating: [{ id: 'work', x: 777, y: 333, w: 420, h: 300, z: 1, vw: 1920, vh: 1080 }], hidden: {}, collapsed: [] };
const legacyAppdock = { v: 2, settings: { position: 'left' } };
const ctxA = await browser.newContext({ viewport: VP });
await ctxA.addInitScript(([dockV, appV]) => {
  if (sessionStorage.getItem('seeded')) return;
  sessionStorage.setItem('seeded', '1');
  localStorage.setItem('rigs.dock', JSON.stringify(dockV));
  localStorage.setItem('rigs.appdock', JSON.stringify(appV));
}, [legacyDock, legacyAppdock]);
check('A starts with an empty daemon layout', Object.keys((await layoutOf(A)).keys).length === 0);
const pageA = await open(ctxA, A, { errors });
const migrated = await waitFor(async () => { const k = (await layoutOf(A)).keys; return k['rigs.dock'] && k['rigs.appdock'] ? k : null; }, 5000);
const wk = migrated?.['rigs.dock']?.value?.floating?.find((f) => f.id === 'work');
check('migration: the localStorage-only layout is uploaded on first load', wk && wk.x === 777 && wk.y === 333 && migrated['rigs.appdock'].value.settings.position === 'left', JSON.stringify({ wk, pos: migrated?.['rigs.appdock']?.value?.settings?.position }));
check('migration: the page keeps that layout', (await rect(pageA, '#work'))?.x === 777 && (await dockState(pageA)).settings.position === 'left');
const onB = await waitFor(async () => { const k = (await layoutOf(B)).keys; return k['rigs.dock']?.by === 'dock-A' && k['rigs.appdock'] ? k : null; }, 15000);
check('migration: B\'s daemon adopted it from A', !!onB, JSON.stringify(Object.fromEntries(Object.entries(onB || {}).map(([k, e]) => [k, e.by]))));

// ------------------------------------------------------------------ 2. a fresh page on B starts with A's layout
const ctxB = await browser.newContext({ viewport: VP });
const pageB = await open(ctxB, B, { errors });
check('B starts with the synced layout (work panel where A put it, dock on the left)', (await rect(pageB, '#work'))?.x === 777 && (await dockState(pageB)).settings.position === 'left');
await shot(pageA, 'A-before@1920x1080.png');
await shot(pageB, 'B-before@1920x1080.png');

// ------------------------------------------------------------------ 3. live changes from A, no echo
pageB.puts.length = 0;
const before = await dockState(pageB);
// Rearrange A's app dock: drag the first tile past the last one (the dock is on the left: along y).
const ta = await rects(pageA, TILES);
await dragTile(pageA, { x: ta[0].cx, y: ta[0].cy }, async () => { const r = (await rects(pageA, TILES)).at(-1); return { x: r.cx, y: r.y + r.h + 5 }; });
const afterA = await dockState(pageA);
check('A: the app dock was rearranged', orderKey(afterA) !== orderKey(before), `${before.order[0]?.id} → last`);
// Dock a panel on A: docking on from ☰, then the side panel onto the galaxy's left zone.
await pageA.click('#panels-btn');
await sleep(250);
await pageA.check('#panels-menu .pm-dock input');
await pageA.click('#panels-btn');
await sleep(300);
const lg = await grab(pageA, '#left .brand');
await drag(pageA, lg, { x: 420, y: 560 });
check('A: side panel docked', await pageA.evaluate(() => document.querySelector('#left').classList.contains('docked')));
const t0 = dropAt;
pageA.putLog.length = 0;
const saved = await waitFor(async () => { const k = (await layoutOf(A)).keys; return JSON.stringify(k['rigs.dock']?.value?.root || '').includes('"left"') && k['rigs.docking']?.value === 1 && orderKey(k['rigs.appdock'].value) === orderKey(afterA) ? k : null; }, 5000, 100);
const savedMs = Date.now() - t0;
check('saved to A\'s daemon within about a second (GET /api/local/ui-layout)', !!saved && savedMs < 1500, `seen ${savedMs} ms after the drop; PUTs at ${pageA.putLog.map((x) => `${x.key} +${x.at - t0} ms`).join(', ')}`);
const live = await waitFor(async () => (await pageB.evaluate(() => document.querySelector('#left').classList.contains('docked'))) && orderKey(await dockState(pageB)) === orderKey(afterA), 8000, 100);
check('B: the docked panel and the app dock order arrive live, without a reload', live);
await sleep(1500);
const stampsA = (await layoutOf(A)).keys;
check('B sends nothing back (no echo PUT from B)', pageB.puts.length === 0, JSON.stringify(pageB.puts));
check('A\'s stamps are still its own', ['rigs.dock', 'rigs.appdock', 'rigs.docking'].every((k) => stampsA[k]?.by === 'dock-A'), JSON.stringify(Object.fromEntries(Object.entries(stampsA).map(([k, e]) => [k, e.by]))));
await shot(pageA, 'A-after@1920x1080.png');
await shot(pageB, 'B-after@1920x1080.png');

// ------------------------------------------------------------------ 4. a drag held on B is not disturbed
const wg = await grab(pageB, '#work .wk-head');
const wr = await rect(pageB, '#work');
await drag(pageB, wg, { x: wg.x - 200, y: wg.y + 120 }, { hold: true });
const midBefore = await rect(pageB, '#work');
// Meanwhile A moves its app dock to the bottom (Dock settings › Position on screen › Bottom).
const tA = (await rects(pageA, TILES))[0];
await menu(pageA, tA.cx, tA.cy, ['Dock settings', 'Position on screen', 'Bottom']);
await pageA.keyboard.press('Escape');
await waitFor(async () => (await layoutOf(B)).keys['rigs.appdock']?.value?.settings?.position === 'bottom', 5000, 100);
await sleep(800); // the event has reached B's page by now
await pageB.mouse.move(wg.x - 210, wg.y + 130);
await sleep(200);
const midAfter = await rect(pageB, '#work');
const heldState = await dockState(pageB);
await shot(pageB, 'B-mid-drag@1920x1080.png');
check('B mid-drag: the remote change waits (dock still on the left)', heldState.settings.position === 'left');
check('B mid-drag: the dragged panel still follows the pointer', Math.abs(midAfter.x - midBefore.x + 10) < 3 && Math.abs(midAfter.y - midBefore.y - 10) < 3, JSON.stringify({ wr, midBefore, midAfter }));
await pageB.keyboard.press('Escape'); // cancel the drag: nothing changed on B
await pageB.mouse.up();
const landed = await waitFor(async () => (await dockState(pageB)).settings.position === 'bottom', 3000, 100);
check('B: the change lands once the pointer is released', landed);
check('B: the cancelled drag put the panel back', Math.abs((await rect(pageB, '#work')).x - wr.x) < 3);
check('still no PUT from B', pageB.puts.length === 0, JSON.stringify(pageB.puts));

// ------------------------------------------------------------------ 5. B reloaded with cleared storage
await pageB.evaluate(() => localStorage.clear());
await pageB.reload({ waitUntil: 'domcontentloaded' });
await pageB.waitForFunction(() => document.querySelectorAll('#app-dock .adock-tile').length >= 4, null, { timeout: 30000 });
await sleep(1500);
const restored = { docked: await pageB.evaluate(() => document.querySelector('#left').classList.contains('docked')), order: orderKey(await dockState(pageB)) === orderKey(await dockState(pageA)), position: (await dockState(pageB)).settings.position };
check('B reloaded with cleared storage: the layout is restored from the daemon', restored.docked && restored.order && restored.position === 'bottom', JSON.stringify(restored));
await shot(pageB, 'B-reloaded-cleared@1920x1080.png');

// ------------------------------------------------------------------ 6. phone on B
const dockStamp = (await layoutOf(B)).keys['rigs.dock'];
const ctxP = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
const phone = await open(ctxP, B, { errors });
const ph = await phone.evaluate(() => ({ docked: document.querySelectorAll('.docked').length, hscroll: document.documentElement.scrollWidth > window.innerWidth + 1 }));
const phoneDock = await dockState(phone);
const sameItems = Object.keys(phoneDock.items).sort().join() === Object.keys((await dockState(pageA)).items).sort().join();
check('phone: shows the synced app dock (same items, same order)', sameItems && orderKey(phoneDock) === orderKey(await dockState(pageA)));
check('phone: no docking, no sideways scroll (CSS phone layout)', ph.docked === 0 && !ph.hscroll, JSON.stringify(ph));
// Close a panel on the phone (a layout change there) and give the debounce time.
await phone.evaluate(() => { const b = document.querySelector('#work .pctl .pclose:not(.pcollapse)'); if (b && !document.querySelector('#work').classList.contains('panel-closed')) b.click(); });
await sleep(1500);
const dockStampAfter = (await layoutOf(B)).keys['rigs.dock'];
check('phone: never writes a panel layout back', !phone.puts.includes('rigs.dock') && dockStampAfter.rev === dockStamp.rev, JSON.stringify({ puts: phone.puts, rev: [dockStamp.rev, dockStampAfter.rev] }));
await shot(phone, 'phone@390x844.png');

// ------------------------------------------------------------------ 7. Dock settings: sync line + Reset layout for all machines
{
  const t = (await rects(pageA, TILES))[0];
  await menu(pageA, t.cx, t.cy, ['Dock settings']);
  const labels = await pageA.evaluate(() => [...document.querySelectorAll('.mb-menu')].at(-1).innerText);
  await shot(pageA, 'A-dock-settings@1920x1080.png');
  check('Dock settings shows that the layout is synced across the mesh', /Synced across the mesh/.test(labels) && /last change: dock-a/i.test(labels) && /Reset layout for all machines/.test(labels), labels.replace(/\s+/g, ' ').slice(-160));
  pageA.once('dialog', (d) => d.accept());
  await (await menuItem(pageA, 'Reset layout for all machines')).click();
  await sleep(300);
  const resetHere = await pageA.evaluate(() => !document.querySelector('#left').classList.contains('docked'));
  const resetThere = await waitFor(async () => pageB.evaluate(() => !document.querySelector('#left').classList.contains('docked')), 5000, 100);
  check('Reset layout for all machines resets here and, live, on B', resetHere && resetThere);
  await shot(pageB, 'B-after-reset-all@1920x1080.png');
}

// ------------------------------------------------------------------ 8. a layout from a newer JARVIS (higher version) is never overwritten
{
  pageA.puts.length = 0;
  pageB.puts.length = 0;
  const future = { version: 99, root: { type: 'panel', id: 'stage' }, floating: [], hidden: {}, collapsed: [], windows: { 'files:x': { state: 'normal', rect: null } } };
  await fetch(new URL('/api/local/ui-layout', A.url), { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ key: 'rigs.dock', value: future }) });
  await waitFor(async () => (await layoutOf(B)).keys['rigs.dock']?.value?.version === 99, 5000, 100);
  await sleep(800);
  const workBefore = await rect(pageB, '#work');
  await pageB.click('#work .pcollapse'); // a local layout change on the old page
  await sleep(250);
  await pageB.click('#work .pcollapse');
  await sleep(1500);
  const [la, lb] = [(await layoutOf(A)).keys['rigs.dock'], (await layoutOf(B)).keys['rigs.dock']];
  check('a newer-format layout stays on the mesh: old pages neither apply nor overwrite it', la.value.version === 99 && lb.value.version === 99 && la.value.windows?.['files:x'] && !pageA.puts.includes('rigs.dock') && !pageB.puts.includes('rigs.dock'), JSON.stringify({ a: la.value.version, b: lb.value.version, putsA: pageA.puts, putsB: pageB.puts }));
  const workAfter = await rect(pageB, '#work');
  check('the old page keeps its own layout meanwhile', Math.abs(workAfter.x - workBefore.x) < 3 && Math.abs(workAfter.y - workBefore.y) < 3, JSON.stringify({ workBefore, workAfter }));
}

check('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
await browser.close();
console.log(`\nScreenshots:\n${shots.join('\n')}`);
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
