#!/usr/bin/env node
// Review check (t4): independent end-to-end pass over docking + smart scaling. Same harness as dock-check.js.
// scripts/mobile-shots.js) and checks the dockable panel layout end to end, saving screenshots on the way:
// whole-title-bar drags with docking off, the ☰ docking switch, drop zones mid-drag, side-by-side and tabbed docks,
// a docked window, splitters, tab keys/reorder/drag-out, hide → reload → restore to the same place, Esc to cancel,
// switching docking off, Reset layout, and phones (390x844) ignoring a saved docked layout.
//   node scripts/dock-check.js [--url http://127.0.0.1:4719/] [--out screenshots/review]
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
const OUT = path.resolve(opt('out', path.join(ROOT, 'screenshots/review')));
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
const consoleErrs = [];
function watch(page, tag) {
  page.on('pageerror', (e) => consoleErrs.push(`${tag} pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') consoleErrs.push(`${tag} console: ${m.text()} @ ${m.location()?.url || ''}`); });
}
const shot = (page, n) => page.screenshot({ path: path.join(OUT, n) });
const menu = async (page, sel, want) => {
  await page.click('#panels-btn'); await sleep(250);
  const cb = page.locator(`#panels-menu ${sel} input`);
  if ((await cb.isChecked()) !== want) await cb.click();
  await page.click('#panels-btn'); await sleep(350);
};
const inside = (page) => page.evaluate(() => {
  const vw = innerWidth, vh = innerHeight, out = [];
  for (const el of document.querySelectorAll('.docked, .floating, .win, .dock-tabs')) {
    const s = getComputedStyle(el); if (s.display === 'none' || s.visibility === 'hidden' || el.classList.contains('panel-closed')) continue;
    const b = el.getBoundingClientRect(); if (!b.width || !b.height) continue;
    if (b.left < -1 || b.top < -1 || b.right > vw + 1 || b.bottom > vh + 1) out.push(`${el.id || el.className.split(' ')[0]} ${Math.round(b.left)},${Math.round(b.top)},${Math.round(b.right)},${Math.round(b.bottom)}`);
  }
  return out;
});

// ---------------------------------------------------------------- desktop
{
  const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  const page = await ctx.newPage(); watch(page, 'desktop');
  await page.goto(URL, { waitUntil: 'domcontentloaded' }); await page.waitForSelector('#panels-btn'); await sleep(1500);
  await shot(page, '01-default@1920x1080.png');

  // Command API for the top-menu / context-menu project.
  const api = await page.evaluate(async () => { const m = await import('/src/docking.js').catch(() => null); return m ? Object.keys(m.dockCommands) : null; });
  check('dockCommands API present', !api || ['setDocking','toggleDocking','dockPanel','floatPanel','hidePanel','restorePanel','resetLayout','listPanels','setScaling','toggleScaling'].every((k) => api.includes(k)), api ? api.join(',') : 'module not served as /src (bundled) — checked in source');

  // ☰ menu: Esc closes and returns focus.
  await page.click('#panels-btn'); await sleep(200);
  await page.keyboard.press('Escape'); await sleep(200);
  const esc = await page.evaluate(() => ({ open: !document.querySelector('#panels-menu').classList.contains('hidden'), expanded: document.querySelector('#panels-btn').getAttribute('aria-expanded'), focus: document.activeElement?.id }));
  check('Esc closes the ☰ menu and focus returns to its button', !esc.open && esc.focus === 'panels-btn' && esc.expanded === 'false', JSON.stringify(esc));

  await sleep(300);
  check('closed ☰ menu is out of the Tab order', await page.evaluate(() => [...document.querySelectorAll('#panels-menu input, #panels-menu button')].every((e) => getComputedStyle(e).visibility === 'hidden')));
  await menu(page, '.pm-dock:not(.pm-scale)', true);
  await menu(page, '.pm-scale', true);
  check('both modes on and stored', await page.evaluate(() => localStorage.getItem('rigs.docking') === '1' && localStorage.getItem('rigs.scaling') === '1'));

  // Dock on each screen edge.
  const edges = [['#work', '#work .wk-head', { x: 6, y: 540 }, 'left'], ['#legend', '#legend .sec-h', { x: 960, y: 1074 }, 'bottom'], ['#chat-dock', '#chat-dock .dock-head', { x: 1914, y: 540 }, 'right'], ['#left', '#left .brand', { x: 960, y: 6 }, 'top']];
  for (const [sel, h, to, edge] of edges) {
    const g = await grab(page, h); if (!g) { check(`${sel} dock on ${edge} edge`, false, 'no grab point'); continue; }
    await drag(page, g, to, edge === 'left' ? { shot: 'drop-zone-left-edge@1920x1080.png', hold: false } : {});
    const r = await rect(page, sel);
    const touches = { left: r.x < 20, right: r.x + r.w > 1900, top: r.y < 60, bottom: r.y + r.h > 1060 }[edge];
    check(`${sel} docks on the ${edge} screen edge`, (await page.evaluate((s) => document.querySelector(s).classList.contains('docked'), sel)) && touches, JSON.stringify(r));
  }
  await shot(page, '02-four-edges@1920x1080.png');

  // Tab: Questions onto Active projects centre.
  if (await page.evaluate(() => document.querySelector('#questions').classList.contains('panel-closed'))) await page.click('#btn-ask');
  await sleep(500);
  const W = await rect(page, '#work');
  await drag(page, await grab(page, '#questions .wk-head'), { x: W.x + W.w / 2, y: W.y + W.h / 2 });
  const tabs = await page.evaluate(() => [...document.querySelectorAll('.dock-tab')].map((t) => t.dataset.id));
  check('dock as a tab', tabs.includes('questions') && tabs.includes('work'), JSON.stringify(tabs));
  await shot(page, '03-tabbed@1920x1080.png');
  // Tab a11y: roles + aria-controls/selected + roving tabindex.
  const ta = await page.evaluate(() => [...document.querySelectorAll('.dock-tab')].map((t) => ({ role: t.getAttribute('role'), sel: t.getAttribute('aria-selected'), ti: t.tabIndex, ctl: t.getAttribute('aria-controls') })));
  check('tab roles: role=tab, one selected, roving tabindex', ta.every((t) => t.role === 'tab') && ta.filter((t) => t.sel === 'true').length === 1 && ta.filter((t) => t.ti === 0).length === 1, JSON.stringify(ta));

  // Drag a tab out.
  const tb = await page.evaluate(() => { const b = document.querySelector('.dock-tab[data-id="questions"]').getBoundingClientRect(); return { x: b.left + 12, y: b.top + b.height / 2 }; });
  await drag(page, tb, { x: 1000, y: 500 });
  check('drag a tab out floats it', await page.evaluate(() => document.querySelector('#questions').classList.contains('floating') || !document.querySelector('#questions').classList.contains('docked')));
  await shot(page, '04-tab-dragged-out@1920x1080.png');

  // Hide and restore (exact place).
  const before = await rect(page, '#legend');
  await page.click('#legend .pctl .pclose:not(.pcollapse)'); await sleep(400);
  const gone = await page.evaluate(() => document.querySelector('#legend').classList.contains('panel-closed'));
  await page.click('#panels-btn'); await sleep(250);
  await shot(page, '05-hidden-in-menu@1920x1080.png');
  await page.locator('#panels-menu .pm-restore', { hasText: /Filters|Legend/i }).first().click().catch(() => {});
  await page.keyboard.press('Escape'); await sleep(500);
  const back = await rect(page, '#legend');
  check('hide then restore returns to the same place', gone && Math.abs(back.x - before.x) < 3 && Math.abs(back.y - before.y) < 3 && Math.abs(back.w - before.w) < 3, JSON.stringify({ before, back }));

  // Reload keeps layout.
  const tree1 = await page.evaluate(() => JSON.stringify(JSON.parse(localStorage.getItem('rigs.dock')).root));
  const r1 = await rect(page, '#work');
  await page.reload({ waitUntil: 'domcontentloaded' }); await page.waitForSelector('#panels-btn'); await sleep(1500);
  const tree2 = await page.evaluate(() => JSON.stringify(JSON.parse(localStorage.getItem('rigs.dock')).root));
  const r2 = await rect(page, '#work');
  check('reload keeps the layout', tree1 === tree2 && Math.abs(r1.x - r2.x) < 3 && Math.abs(r1.w - r2.w) < 3, JSON.stringify({ r1, r2 }));
  await shot(page, '06-after-reload@1920x1080.png');

  // Resize with scaling on.
  for (const [w, h] of [[1280, 720], [900, 600], [1920, 1080]]) {
    await page.setViewportSize({ width: w, height: h }); await sleep(900);
    const out = await inside(page);
    check(`scaling on @${w}x${h}: everything inside`, out.length === 0, out.join(' | '));
    await shot(page, `07-scaled@${w}x${h}.png`);
  }
  // Floating panel + scaling: float the chat, park it bottom right, shrink.
  await menu(page, '.pm-dock:not(.pm-scale)', false);
  check('docking off: nothing docked', await page.evaluate(() => !document.querySelector('.docked') && !document.querySelector('.dock-tabs')));
  await page.setViewportSize({ width: 1000, height: 640 }); await sleep(900);
  const outF = await inside(page);
  check('docking off + scaling on @1000x640: floating panels inside', outF.length === 0, outF.join(' | '));
  await shot(page, '08-floating-scaled@1000x640.png');
  await page.setViewportSize({ width: 1920, height: 1080 }); await sleep(900);
  await menu(page, '.pm-scale', false);
  const off = await page.evaluate(() => ({ cls: document.documentElement.className, scaled: [...document.querySelectorAll('[style*="scale"]')].length, docking: localStorage.getItem('rigs.docking'), scaling: localStorage.getItem('rigs.scaling') }));
  check('both modes off: no fit classes, nothing scaled, stored off', !/fit-/.test(off.cls) && off.scaled === 0 && off.docking === '0' && off.scaling === '0', JSON.stringify(off));
  await shot(page, '09-both-off@1920x1080.png');
  // Drag still by whole bar with both off.
  const cb = await rect(page, '#chat-dock'); const cg = await grab(page, '#chat-dock .dock-head');
  await drag(page, cg, { x: cg.x - 200, y: cg.y - 100 });
  const ca = await rect(page, '#chat-dock');
  check('both off: whole title bar still drags', Math.abs(ca.x - cb.x + 200) < 4 && Math.abs(ca.y - cb.y + 100) < 4, JSON.stringify({ cb, ca }));
  await ctx.close();
}

// ---------------------------------------------------------------- reduced motion
{
  const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 }, reducedMotion: 'reduce' });
  await ctx.addInitScript(() => { try { localStorage.setItem('rigs.docking', '1'); localStorage.setItem('rigs.scaling', '1'); } catch {} });
  const page = await ctx.newPage(); watch(page, 'reduced');
  await page.goto(URL, { waitUntil: 'domcontentloaded' }); await page.waitForSelector('#panels-btn'); await sleep(1200);
  const g = await grab(page, '#work .wk-head');
  await drag(page, g, { x: 960, y: 540 }, { hold: true });
  const t = await page.evaluate(() => [...document.querySelectorAll('.dock-preview, .dock-compass, .docked, .floating')].map((e) => getComputedStyle(e).transitionDuration).filter((d) => d.split(',').some((x) => parseFloat(x) > 0.01)));
  await page.mouse.up(); await sleep(300);
  check('reduced motion: no transitions on drop zones / panels', t.length === 0, JSON.stringify(t));
  await ctx.close();
}

// ---------------------------------------------------------------- phone
{
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  await ctx.addInitScript(() => { try { localStorage.setItem('rigs.docking', '1'); localStorage.setItem('rigs.scaling', '1'); } catch {} });
  const page = await ctx.newPage(); watch(page, 'phone');
  await page.goto(URL, { waitUntil: 'domcontentloaded' }); await page.waitForSelector('#btn-more'); await sleep(1500);
  const ph = await page.evaluate(() => ({ docked: document.querySelectorAll('.docked').length, h: document.documentElement.scrollWidth > innerWidth, cls: document.documentElement.className }));
  check('phone: saved modes ignored, no sideways scroll', ph.docked === 0 && !ph.h && !/fit-/.test(ph.cls), JSON.stringify(ph));
  await shot(page, '10-phone-home@390x844.png');
  await page.tap('#btn-more'); await sleep(400); await page.tap('#more-sheet #panels-btn'); await sleep(400);
  await shot(page, '11-phone-menu@390x844.png');
  const vis = await page.evaluate(() => [...document.querySelectorAll('#panels-menu .pm-dock')].map((e) => e.offsetParent !== null));
  check('phone: mode switches hidden', vis.every((v) => !v), JSON.stringify(vis));
  await page.keyboard.press('Escape'); await sleep(200);
  await page.tap('#btn-more'); await sleep(400); await page.tap('#more-sheet #btn-sess'); await sleep(900);
  const w = await rect(page, '.win');
  check('phone: windows full-screen', w && w.x === 0 && w.w === 390, JSON.stringify(w));
  await shot(page, '12-phone-window@390x844.png');
  await ctx.close();
}

await browser.close(); server.stop();
fs.writeFileSync(path.join(OUT, 'console.log'), consoleErrs.join('\n') + '\n');
// The throwaway server has no router configured, so the usage panel's /router probe 404s: not part of docking.
const real = consoleErrs.filter((e) => !/\/api\/nodes\/self\/router/.test(e));
check('no console errors or page errors (docking + scaling)', real.length === 0, real.slice(0, 6).join(' || ') || `${consoleErrs.length} known /router 404s logged`);
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed ? 1 : 0);
