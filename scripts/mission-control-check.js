#!/usr/bin/env node
// Mission Control check: drives JARVIS in headless Chromium (Playwright from RIGS_AUDIT_TOOLS or ~/.cache/rigs-audit, as
// scripts/spaces-check.js) and checks ui/src/mission-control.js end to end, saving screenshots: six windows (a terminal,
// an App Cloud app in an iframe, a minimized one) on two desktops; every trigger opens it (Ctrl+↑, F3, Window › Mission
// Control, the desktops menu, the app dock, "show me all my windows"); previews don't overlap and carry titles; Esc and
// empty space close it with every window back at its exact rect; a click or arrows + Enter focus a window; the Spaces
// bar switches, adds and removes desktops; dragging a preview onto a desktop moves the window; the terminal and the
// app's iframe are never reloaded; nothing opens while typing or in a terminal; reduced motion; a 390x844 phone list.
//   node scripts/mission-control-check.js [--out screenshots/mission-control]
// It starts a throwaway `rigs serve` (scratch RIGS_HOME, no OpenRig, no migrations, no autoupdate) and a tiny app that
// counts its page loads. Exit code 1 when a check fails.
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import http from 'node:http';
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
const OUT = path.resolve(opt('out', path.join(ROOT, 'screenshots/mission-control')));
fs.mkdirSync(OUT, { recursive: true });

const freePort = () => new Promise((resolve, reject) => { const s = net.createServer(); s.once('error', reject); s.listen(0, '127.0.0.1', () => { const { port: p } = s.address(); s.close(() => resolve(p)); }); });

// The app: every page load is counted, so a reloaded iframe shows.
let appLoads = 0;
const appPort = await freePort();
const app = http.createServer((req, res) => {
  if (req.url.startsWith('/healthz')) { res.end('ok'); return; }
  if (req.url === '/' || req.url.startsWith('/?')) appLoads++;
  res.setHeader('content-type', 'text/html');
  res.end(`<!doctype html><body style="margin:0;font:28px sans-serif;background:#1d3b2a;color:#e8ffe8;display:grid;place-items:center;height:100vh">Counter app · load #${appLoads}</body>`);
});
await new Promise((r) => app.listen(appPort, '127.0.0.1', r));

async function startServer() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'rigs-mc-'));
  const port = await freePort();
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({
    port, openrig: { registerPeers: false },
    apps: [{ id: 'counter', name: 'Counter', port: appPort, icon: '🔢', healthPath: '/healthz' }],
  }));
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
process.on('exit', () => { server.stop(); app.close(); });
const URL = server.url;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, ok, extra = '') => { results.push({ name, ok: !!ok }); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${extra && !ok ? ' — ' + extra : ''}`); };
const near = (a, b, tol = 1) => !!a && !!b && ['x', 'y', 'w', 'h'].every((k) => Math.abs(a[k] - b[k]) <= tol);

const look = (page, sel) => page.evaluate((s) => {
  const el = document.querySelector(s);
  if (!el) return null;
  const b = el.getBoundingClientRect();
  return { shown: getComputedStyle(el).display !== 'none', rect: { x: b.left, y: b.top, w: b.width, h: b.height }, state: el._wm?.state(), desktop: el.dataset.desktop, z: Number(el.style.zIndex), mc: el.classList.contains('mc-win') };
}, sel);
const blur = (page) => page.evaluate(() => document.activeElement?.blur?.());
const isOpen = (page) => page.evaluate(() => !!document.querySelector('.mc'));
const active = (page) => page.evaluate(() => document.querySelector('#mb-tray [data-tray-item="spaces"] .tray-space-name')?.textContent || '');
/** The previews: id, rect of the hit button, the label text, and the window's own on-screen (transformed) rect. */
const previews = (page) => page.evaluate(() => [...document.querySelectorAll('.mc-hit')].map((b) => {
  const r = b.getBoundingClientRect();
  const w = document.querySelector(`.win[data-win-id="${b.dataset.winId}"]`).getBoundingClientRect();
  return { id: b.dataset.winId, title: b.textContent.trim(), rect: { x: r.left, y: r.top, w: r.width, h: r.height }, win: { x: w.left, y: w.top, w: w.width, h: w.height } };
}));

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
const clickBtn = (page, id) => page.evaluate((i) => document.getElementById(i).click(), id); // a #bar button (the dock's tool tiles run these)
const winId = (sel) => sel.match(/"(\d+)"/)[1];

const browser = await chromium.launch({ args: ['--no-sandbox'] });
const errors = [];

// ------------------------------------------------------------------ desktop 1440x900
{
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(URL, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#menubar');
  await sleep(2500);

  // Desktop 1: a terminal, the Counter app, sessions, shortcuts, and About minimized. Desktop 2: the tool registry.
  // The terminal button needs this machine from the first snapshot: press it until a window shows.
  await openWin(page, async () => {
    for (let i = 0; i < 8; i++) {
      await clickBtn(page, 'btn-term');
      if (await page.waitForSelector('.win.term-win', { timeout: 5000 }).then(() => true, () => false)) return;
    }
  });
  await sleep(1500);
  await page.evaluate(() => [...document.querySelectorAll('.win.term-win')].slice(1).forEach((w) => w._wm.close())); // a slow first press can still land
  await sleep(300);
  const T = await page.evaluate(() => `.win[data-win-id="${document.querySelector('.win.term-win').dataset.winId}"]`);
  await page.waitForSelector(`${T} .xterm`, { timeout: 15000 }).catch(() => {});
  const P = await openWin(page, () => menuItem(page, 'file', 'Open app'));
  await page.locator(`${P} .app-tile`, { hasText: 'Counter' }).first().click();
  await page.waitForFunction(() => [...document.querySelectorAll('.win.app-win iframe')].some((f) => f.contentDocument?.body?.textContent.includes('Counter app')), null, { timeout: 15000 }).catch(() => {});
  const AP = await page.evaluate(() => `.win[data-win-id="${document.querySelector('.win.app-win').dataset.winId}"]`);
  await page.evaluate((s) => document.querySelector(s)._wm.close(), P); // the Apps launcher: not needed any more
  await sleep(300);
  const S = await openWin(page, () => menuItem(page, 'file', 'Open session'));
  const K = await openWin(page, () => menuItem(page, 'help', 'Keyboard shortcuts'));
  const A = await openWin(page, () => menuItem(page, 'help', 'About RIGS'));
  await page.click(`${A} .win-bar .win-btn.win-min`);
  await sleep(400);
  await page.evaluate(() => document.querySelector('#mb-tray [data-tray-item="spaces"]').click());
  await sleep(250);
  await page.locator('.mb-menu.mb-ctx .mb-item', { hasText: 'Add desktop' }).first().click();
  await sleep(500);
  const R = await openWin(page, () => menuItem(page, 'tools', 'Tool registry'));
  await page.keyboard.press('Control+1');
  await sleep(500);
  const D1 = [T, AP, S, K];
  // Marks that a reload would lose: the xterm element and the iframe's window.
  await page.evaluate(([t, a]) => {
    window.__mcXterm = document.querySelector(`${t} .xterm`);
    window.__mcFrame = document.querySelector(`${a} iframe`);
    try { window.__mcFrame.contentWindow.__mcMark = 42; } catch { /* cross-origin */ }
  }, [T, AP]);
  const loads0 = appLoads;
  const before = Object.fromEntries(await Promise.all([...D1, A, R].map(async (s) => [s, await look(page, s)])));
  check('six windows on two desktops: terminal, app, sessions, shortcuts on Desktop 1 (+ About minimized), the registry on Desktop 2',
    D1.every((s) => before[s]?.shown && before[s].desktop === 'd1') && before[A].state === 'minimized' && before[R].desktop === 'd2' && !before[R].shown && (await page.evaluate(() => !!window.__mcXterm && !!window.__mcFrame)),
    JSON.stringify(before));
  await blur(page);
  await page.screenshot({ path: path.join(OUT, 'before.png') });

  // ---- Ctrl+↑ opens it.
  await page.keyboard.press('Control+ArrowUp');
  await sleep(500);
  const pv = await previews(page);
  check('Ctrl+↑ opens Mission Control', await isOpen(page));
  check('one preview per window on the stage of this desktop (4), the minimized one in its own row', pv.length === 4 && (await page.evaluate(() => document.querySelectorAll('.mc-minrow .mc-minwin').length)) === 1, `${pv.length}`);
  const overlap = (a, b) => a.x < b.x + b.w - 1 && b.x < a.x + a.w - 1 && a.y < b.y + b.h - 1 && b.y < a.y + a.h - 1;
  check('the previews do not overlap', pv.every((a, i) => pv.every((b, j) => i === j || !overlap(a.rect, b.rect))), JSON.stringify(pv.map((p) => p.rect)));
  check('each window is scaled exactly under its preview (the real window, transformed)', pv.every((p) => near(p.rect, p.win, 1.5)), JSON.stringify(pv.map((p) => [p.rect, p.win])));
  const titles = await page.evaluate((ids) => ids.map((s) => document.querySelector(s)._wm.title()), D1);
  check('each preview carries its window\'s title', titles.every((t) => pv.some((p) => p.title.includes(t))), JSON.stringify(pv.map((p) => p.title)));
  check('the previews are inside the screen, below the Spaces bar', await page.evaluate(() => {
    const bar = document.querySelector('.mc-spaces').getBoundingClientRect().bottom;
    return [...document.querySelectorAll('.mc-hit')].every((b) => { const r = b.getBoundingClientRect(); return r.top >= bar && r.left >= 0 && r.right <= innerWidth && r.bottom <= innerHeight; });
  }));
  const bar = await page.evaluate(() => [...document.querySelectorAll('.mc-desk')].map((d) => ({ id: d.dataset.desktop, on: d.classList.contains('on'), minis: d.querySelectorAll('.mc-mini').length, name: d.textContent.trim() })));
  check('the Spaces bar shows both desktops with a miniature of their windows (4 and 1) and a +', bar.length === 2 && bar[0].on && bar[0].minis === 4 && bar[1].minis === 1 && (await page.evaluate(() => !!document.querySelector('.mc-add'))), JSON.stringify(bar));
  await page.screenshot({ path: path.join(OUT, 'mission-control-open.png') });

  // ---- Esc closes; every window is back at its exact rect.
  await page.keyboard.press('Escape');
  await sleep(500);
  const back1 = await Promise.all(D1.map((s) => look(page, s)));
  check('Esc closes it', !(await isOpen(page)));
  check('…and every window is back at its exact rect, with no transform left', D1.every((s, i) => near(back1[i].rect, before[s].rect, 0.5) && !back1[i].mc), JSON.stringify(back1.map((b) => b.rect)));

  // ---- F3 opens; a click on empty space closes.
  await blur(page);
  await page.keyboard.press('F3');
  await sleep(450);
  check('F3 opens it', await isOpen(page));
  await page.mouse.click(10, 450);
  await sleep(500);
  check('a click on empty space closes it, windows back in place', !(await isOpen(page)) && (await Promise.all(D1.map((s) => look(page, s)))).every((b, i) => near(b.rect, before[D1[i]].rect, 0.5)));

  // ---- Window › Mission Control; the trigger again closes.
  await menuItem(page, 'window', 'Mission Control');
  await sleep(300);
  check('Window › Mission Control opens it', await isOpen(page));
  await page.keyboard.press('Control+ArrowUp');
  await sleep(450);
  check('the shortcut again closes it', !(await isOpen(page)));

  // ---- the desktops menu (menu bar indicator)
  await page.evaluate(() => document.querySelector('#mb-tray [data-tray-item="spaces"]').click());
  await sleep(250);
  await page.locator('.mb-menu.mb-ctx .mb-item', { hasText: 'Mission Control' }).first().click();
  await sleep(450);
  check('the desktop indicator\'s menu opens it', await isOpen(page));
  await page.keyboard.press('Escape');
  await sleep(450);

  // ---- the app dock: System › Mission Control
  let dockOk = false;
  try {
    await page.evaluate(() => { const g = document.querySelector('.adock-group[data-gid="g-tools-system"]'); g.scrollIntoView?.(); });
    await page.click('.adock-group[data-gid="g-tools-system"]', { timeout: 3000 });
    await sleep(350);
    await page.click('.adock-pop-tile[data-id="tool:mission"]', { timeout: 3000 });
    await sleep(450);
    dockOk = await isOpen(page);
  } catch (e) { console.log(`  (dock: ${e.message.split('\n')[0]})`); }
  check('the app dock\'s Mission Control tile opens it', dockOk);
  if (await isOpen(page)) { await page.keyboard.press('Escape'); await sleep(450); }

  // ---- JARVIS: "show me all my windows"
  await page.evaluate(() => { const a = document.getElementById('ask'); a.focus(); a.value = 'show me all my windows'; a.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); });
  await sleep(600);
  check('asking JARVIS "show me all my windows" opens it', await isOpen(page));

  // ---- click a preview: it closes and that window is focused, on top
  const sTitle = await page.evaluate((s) => document.querySelector(s)._wm.title(), S);
  await page.click(`.mc-hit[data-win-id="${winId(S)}"]`);
  await sleep(500);
  const sNow = await look(page, S);
  const topZ = Math.max(...(await Promise.all(D1.map((s) => look(page, s)))).map((b) => b.z));
  check(`clicking the "${sTitle}" preview closes it and focuses that window, on top`, !(await isOpen(page)) && sNow.z === topZ && (await page.evaluate((s) => document.querySelector(s).contains(document.activeElement), S)), JSON.stringify({ z: sNow.z, topZ }));

  // ---- arrows + Enter
  await blur(page);
  await page.keyboard.press('Control+ArrowUp');
  await sleep(450);
  const f0 = await page.evaluate(() => document.activeElement?.dataset?.winId || null);
  await page.keyboard.press('ArrowRight');
  await sleep(80);
  const f1 = await page.evaluate(() => document.activeElement?.dataset?.winId || null);
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowLeft');
  await sleep(80);
  const f2 = await page.evaluate(() => document.activeElement?.dataset?.winId || null);
  check('arrow keys move the highlight between previews', !!f0 && !!f1 && f0 !== f1 && !!f2, JSON.stringify({ f0, f1, f2 }));
  await page.keyboard.press('Enter');
  await sleep(500);
  check('Enter focuses the highlighted window', !(await isOpen(page)) && (await page.evaluate((id) => document.querySelector(`.win[data-win-id="${id}"]`).contains(document.activeElement), f2)));

  // ---- Spaces bar: switch (stays open, grid follows), +, ×
  await blur(page);
  await page.keyboard.press('Control+ArrowUp');
  await sleep(450);
  await page.click('.mc-desk[data-desktop="d2"]');
  await sleep(500);
  const pv2 = await previews(page);
  check('clicking Desktop 2 switches to it and the grid follows, still open', (await isOpen(page)) && (await active(page)) === 'Desktop 2' && pv2.length === 1 && pv2[0].id === winId(R), JSON.stringify({ n: pv2.length, a: await active(page) }));
  await page.screenshot({ path: path.join(OUT, 'mission-control-desktop-2.png') });
  await page.click('.mc-desk[data-desktop="d1"]');
  await sleep(500);
  check('…and back to Desktop 1', (await previews(page)).length === 4 && (await active(page)) === 'Desktop 1');
  await page.click('.mc-add');
  await sleep(400);
  let desks = await page.evaluate(() => [...document.querySelectorAll('.mc-desk')].map((d) => d.dataset.desktop));
  check('+ adds a desktop (Mission Control stays on this one)', desks.length === 3 && (await active(page)) === 'Desktop 1', JSON.stringify(desks));
  const third = desks[2];
  await page.hover(`.mc-desk[data-desktop="${third}"]`);
  await sleep(250);
  const xVisible = await page.evaluate((d) => getComputedStyle(document.querySelector(`.mc-desk[data-desktop="${d}"]`).closest('.mc-desk-cell').querySelector('.mc-desk-x')).opacity, third);
  await page.click(`.mc-desk-cell:has(.mc-desk[data-desktop="${third}"]) .mc-desk-x`);
  await sleep(400);
  desks = await page.evaluate(() => [...document.querySelectorAll('.mc-desk')].map((d) => d.dataset.desktop));
  check('hovering a desktop shows its ×, which removes it', Number(xVisible) > 0.9 && desks.length === 2, JSON.stringify({ xVisible, desks }));
  await page.click('.mc-add');
  await sleep(400);
  desks = await page.evaluate(() => [...document.querySelectorAll('.mc-desk')].map((d) => d.dataset.desktop));
  const D3 = desks[2];

  // ---- drag the shortcuts window's preview onto the new desktop
  const kp = (await previews(page)).find((p) => p.id === winId(K));
  const target = await page.evaluate((d) => { const r = document.querySelector(`.mc-desk[data-desktop="${d}"] .mc-thumb`).getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; }, D3);
  await page.mouse.move(kp.rect.x + kp.rect.w / 2, kp.rect.y + kp.rect.h / 2);
  await page.mouse.down();
  await page.mouse.move(kp.rect.x + kp.rect.w / 2 + 20, kp.rect.y + kp.rect.h / 2 - 20, { steps: 4 });
  await page.mouse.move(target.x, target.y, { steps: 12 });
  await sleep(150);
  const dropLit = await page.evaluate((d) => document.querySelector(`.mc-desk[data-desktop="${d}"]`).classList.contains('drop'), D3);
  await page.screenshot({ path: path.join(OUT, 'mission-control-dragging.png') });
  await page.mouse.up();
  await sleep(600);
  const kAfter = await look(page, K);
  const pv3 = await previews(page);
  const d3minis = await page.evaluate((d) => document.querySelectorAll(`.mc-desk[data-desktop="${d}"] .mc-mini`).length, D3);
  check('dragging a preview onto a desktop moves the window there (the target lights up on the way)', dropLit && kAfter.desktop === D3 && !kAfter.shown && pv3.length === 3 && d3minis === 1 && (await isOpen(page)), JSON.stringify({ dropLit, k: kAfter.desktop, n: pv3.length, d3minis }));
  await page.screenshot({ path: path.join(OUT, 'mission-control-after-drag.png') });

  // ---- close: the rest are back where they were
  await page.keyboard.press('Escape');
  await sleep(500);
  const rest = [T, AP, S];
  const back2 = await Promise.all(rest.map((s) => look(page, s)));
  check('after closing, the windows left on Desktop 1 are exactly where they were', rest.every((s, i) => back2[i].shown && near(back2[i].rect, before[s].rect, 0.5)), JSON.stringify(back2.map((b) => b.rect)));
  await page.screenshot({ path: path.join(OUT, 'after-close.png') });
  await page.evaluate((s) => document.querySelector(s)._wm.raise(), K);
  await sleep(500);
  const kThere = await look(page, K);
  check('the moved window is on Desktop 3 at its old rect', kThere.shown && (await active(page)) === 'Desktop 3' && near(kThere.rect, before[K].rect, 0.5), JSON.stringify(kThere));
  await page.keyboard.press('Control+1');
  await sleep(450);

  // ---- nothing was reloaded
  const alive = await page.evaluate(([t, a]) => {
    let mark = null;
    try { mark = document.querySelector(`${a} iframe`).contentWindow.__mcMark; } catch { /* cross-origin */ }
    return { xterm: document.querySelector(`${t} .xterm`) === window.__mcXterm, frame: document.querySelector(`${a} iframe`) === window.__mcFrame, mark };
  }, [T, AP]);
  check('the terminal and the app\'s iframe were never re-created or reloaded', alive.xterm && alive.frame && alive.mark === 42 && appLoads === loads0, JSON.stringify({ ...alive, loads0, appLoads }));

  // ---- not while typing, not in a terminal
  await page.evaluate(() => document.getElementById('ask').focus());
  await page.keyboard.press('Control+ArrowUp');
  await page.keyboard.press('F3');
  await sleep(300);
  check('Ctrl+↑ and F3 in a text field do nothing', !(await isOpen(page)));
  const inTerm = await page.evaluate((t) => { const ta = document.querySelector(`${t} .xterm textarea, ${t} .xterm-helper-textarea`); ta?.focus(); return !!ta && document.activeElement === ta; }, T);
  await page.keyboard.press('F3');
  await sleep(300);
  check('F3 in a terminal goes to the terminal, not Mission Control', inTerm && !(await isOpen(page)), String(inTerm));
  await ctx.close();
}

// ------------------------------------------------------------------ reduced motion
{
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, reducedMotion: 'reduce' });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(URL, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#menubar');
  await sleep(2000);
  const W = await openWin(page, () => menuItem(page, 'help', 'Keyboard shortcuts'));
  const w0 = await look(page, W);
  await blur(page);
  await page.keyboard.press('Control+ArrowUp');
  await sleep(40);
  const moved = await page.evaluate((s) => { const el = document.querySelector(s); return { t: el.style.transform, dur: getComputedStyle(el).transitionDuration }; }, W);
  const pv = await previews(page);
  check('reduced motion: the grid is there at once, without a transition', /scale/.test(moved.t) && moved.dur.split(',').every((d) => parseFloat(d) === 0) && near(pv[0].rect, pv[0].win, 1.5), JSON.stringify(moved));
  await page.keyboard.press('Escape');
  await sleep(40);
  check('reduced motion: closing puts it back at once', !(await isOpen(page)) && near((await look(page, W)).rect, w0.rect, 0.5));
  await ctx.close();
}

// ------------------------------------------------------------------ phone 390x844
{
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(URL, { waitUntil: 'domcontentloaded' });
  await sleep(2500);
  const W1 = await openWin(page, () => clickBtn(page, 'btn-sess'));
  const W2 = await openWin(page, () => page.evaluate(() => document.querySelector('#btn-proj').click()));
  await page.evaluate((s) => document.querySelector(s)._wm.act('minimize'), W2);
  await sleep(300);
  await clickBtn(page, 'btn-mission');
  await sleep(400);
  const ph = await page.evaluate(() => {
    const root = document.querySelector('.mc.mc-phone');
    const cards = [...document.querySelectorAll('.mc-card')];
    const over = [root, ...cards, ...document.querySelectorAll('.mc-phone-desk, .mc-phone-head')].filter((el) => { const r = el.getBoundingClientRect(); return r.left < -0.5 || r.right > innerWidth + 0.5; }).length;
    return { root: !!root, cards: cards.length, min: cards.filter((c) => c.classList.contains('min')).length, desks: document.querySelectorAll('.mc-phone-desk').length, over, sw: document.documentElement.scrollWidth, drag: !!document.querySelector('.mc-hit, .mc-spaces') };
  });
  check('phone: a list of window cards (the minimized one marked) and a desktop row, no previews or drag', ph.root && ph.cards === 2 && ph.min === 1 && ph.desks === 1 && !ph.drag, JSON.stringify(ph));
  check('phone: nothing overflows 390px', ph.over === 0 && ph.sw <= 390, JSON.stringify(ph));
  await page.screenshot({ path: path.join(OUT, 'phone-390x844.png') });
  await page.click(`.mc-card[data-win-id="${winId(W2)}"]`);
  await sleep(500);
  const w2 = await look(page, W2);
  check('phone: tapping a card closes the list and opens that window', !(await isOpen(page)) && w2.shown && w2.state !== 'minimized', JSON.stringify(w2));
  await clickBtn(page, 'btn-mission');
  await sleep(300);
  await page.goBack().catch(() => {});
  await sleep(400);
  check('phone: the back gesture closes it, the windows stay open', !(await isOpen(page)) && (await look(page, W1)) !== null);
  await ctx.close();
}

await browser.close();
check('no page errors', errors.length === 0, errors.join(' | '));
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed · screenshots in ${OUT}`);
process.exit(failed.length ? 1 : 0);
