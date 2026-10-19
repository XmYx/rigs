#!/usr/bin/env node
// Graphify window check: drives JARVIS in headless Chromium (Playwright from RIGS_AUDIT_TOOLS or ~/.cache/rigs-audit,
// as scripts/dock-check.js) and checks the Graphify window end to end, saving screenshots: it opens from the Window
// menu on the Structure view (legend, jump list, detail card, Mesh toggle, remembered choice), draws the graph with no console errors, closes and reopens from Tools, docks beside a panel and undocks by
// dragging, keeps its place across a reload, and is usable on a phone (390x844, nothing clipped).
//   node scripts/graphify-check.js [--url http://127.0.0.1:4719/] [--out docs/screenshots/graphify]
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
const OUT = path.resolve(opt('out', path.join(ROOT, 'docs/screenshots/graphify')));
fs.mkdirSync(OUT, { recursive: true });

async function startServer() {
  if (opt('url', '')) return { url: opt('url', ''), stop() {} };
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'rigs-graphify-'));
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
const rect = (page, sel) => page.evaluate((s) => { const b = document.querySelector(s)?.getBoundingClientRect(); return b && { x: b.left, y: b.top, w: b.width, h: b.height }; }, sel);
const is = (page, sel, cls) => page.evaluate(([s, c]) => !!document.querySelector(s)?.classList.contains(c), [sel, cls]);
const state = (page) => page.evaluate(() => {
  const el = document.querySelector('#graphify');
  return { closed: el.classList.contains('panel-closed'), docked: el.classList.contains('docked'), canvas: !!el.querySelector('.gfy-canvas canvas'), w: el.getBoundingClientRect().width, h: el.getBoundingClientRect().height };
});
const GL = ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'];

/** Open a top-level menu and click the row with this label. */
async function menuItem(page, top, label) {
  await page.click(`#mb-top-${top}`);
  await sleep(250);
  const item = page.locator('.mb-menu .mb-item', { hasText: label }).first();
  await item.waitFor({ state: 'visible' });
  const box = await item.boundingBox();
  await page.mouse.click(box.x + 12, box.y + box.height / 2);
  await sleep(500);
}
async function drag(page, from, to, { steps = 14, shot = null } = {}) {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  for (let i = 1; i <= steps; i++) { await page.mouse.move(from.x + ((to.x - from.x) * i) / steps, from.y + ((to.y - from.y) * i) / steps); await sleep(16); }
  await sleep(260);
  if (shot) await page.screenshot({ path: path.join(OUT, shot) });
  await page.mouse.up();
  await sleep(500);
}
const headPoint = (page) => page.evaluate(() => { const b = document.querySelector('#graphify .wk-title').getBoundingClientRect(); return { x: b.left + b.width / 2 + 40, y: b.top + b.height / 2 }; });

const browser = await chromium.launch({ args: GL });
const errors = [];
const watch = (page) => {
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource|favicon|net::ERR/.test(m.text())) errors.push(`console: ${m.text()}`); });
};

// ------------------------------------------------------------------ desktop 1440x900
{
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  watch(page);
  await page.goto(URL, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#panels-btn');
  await sleep(1800);
  check('closed by default', (await state(page)).closed);

  // Window menu lists it, and clicking the row opens it.
  await page.click('#mb-top-window');
  await sleep(250);
  const listed = await page.locator('.mb-menu .mb-item', { hasText: 'Graphify' }).count();
  check('Window menu lists Graphify', listed >= 1, `${listed} row(s)`);
  await page.keyboard.press('Escape');
  await menuItem(page, 'window', 'Graphify');
  await sleep(4500); // layout simulation + zoom to fit
  let s = await state(page);
  check('opens from the Window menu', !s.closed && s.canvas, JSON.stringify(s));
  const stage = await rect(page, '#graphify .gfy-stage');
  check('graph fills the window', stage.w > 300 && stage.h > 150, JSON.stringify(stage));
  check('no "waiting" note once the graph has data', await page.evaluate(() => getComputedStyle(document.querySelector('#graphify .gfy-empty')).display === 'none'));
  check('graph draws (canvas has pixels)', await page.evaluate(() => { const c = document.querySelector('#graphify .gfy-canvas canvas'); return !!c && c.width > 0 && c.height > 0; }));
  await page.screenshot({ path: path.join(OUT, 'graphify-open@1440x900.png') });

  // Structure view (the default): how JARVIS is built — legend, jump list, detail card, Mesh toggle, remembered choice.
  const view = () => page.evaluate(() => document.querySelector('#graphify').dataset.view);
  const shown = (sel) => page.evaluate((q) => { const e = document.querySelector(q); return !!e && !e.hidden && getComputedStyle(e).display !== 'none'; }, sel);
  const meta = () => page.textContent('#graphify .wk-meta');
  check('opens on the Structure view', (await view()) === 'structure' && /decisions/.test(await meta()), await meta());
  check('Structure toggle is pressed', (await page.getAttribute('#graphify .gfy-view >> nth=0', 'aria-pressed')) === 'true');
  check('legend is shown for the structure', await shown('#graphify .gfy-legend'));
  check('no detail card until a node is chosen', !(await shown('#graphify .gfy-detail')));
  await page.selectOption('#graphify .gfy-jump', 'd-route');
  await sleep(2500);
  const card = await page.evaluate(() => document.querySelector('#graphify .gfy-detail')?.innerText || '');
  check('Jump to a node opens its detail card', (await shown('#graphify .gfy-detail')) && /Which route\?/.test(card) && /src\/router\.js/.test(card) && /ROUTES/.test(card) && /implement/.test(card), card.slice(0, 120).replace(/\n/g, ' | '));
  await page.screenshot({ path: path.join(OUT, 'graphify-structure-detail@1440x900.png') });
  await page.locator('#graphify .gfy-conn', { hasText: 'implement' }).first().click();
  await sleep(2000);
  check('a connection in the card moves to that node', /^implement/.test((await page.textContent('#graphify .gfy-d-head b')) || ''), await page.textContent('#graphify .gfy-d-head b'));
  await page.click('#graphify .gfy-d-x');
  await sleep(300);
  check('× closes the detail card', !(await shown('#graphify .gfy-detail')));
  await page.selectOption('#graphify .gfy-jump', 'mcp-projects');
  await sleep(1800);
  check('a tool family lists its MCP tools', /project_task_update/.test(await page.evaluate(() => document.querySelector('#graphify .gfy-d-tools')?.innerText || '')));
  await page.click('#graphify .gfy-d-x');
  await page.click('#graphify .gfy-view >> nth=1');
  await sleep(7000); // the galaxy frames itself as its layout settles
  check('Mesh toggle switches to the mesh graph', (await view()) === 'mesh' && !(await shown('#graphify .gfy-legend')) && !/decisions/.test(await meta()), await meta());
  await page.screenshot({ path: path.join(OUT, 'graphify-mesh@1440x900.png') });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#panels-btn');
  await sleep(2500);
  check('the chosen view is remembered across a reload', (await view()) === 'mesh');
  await page.click('#graphify .gfy-view >> nth=0');
  await sleep(3500);
  check('Structure toggle brings the diagram back', (await view()) === 'structure' && /decisions/.test(await meta()));
  await page.screenshot({ path: path.join(OUT, 'graphify-structure@1440x900.png') });

  // Close with ✕, reopen from Tools.
  await page.click('#graphify .pclose:not(.pcollapse)');
  await sleep(500);
  check('closes with ✕', (await state(page)).closed);
  await menuItem(page, 'tools', 'Graphify');
  check('reopens from the Tools menu', !(await state(page)).closed);

  // Dock: turn docking on from ☰, drag the window by its header onto the galaxy's right edge.
  await page.click('#panels-btn');
  await sleep(250);
  await page.check('#panels-menu .pm-dock input');
  await page.click('#panels-btn');
  await sleep(300);
  const g = await headPoint(page);
  await drag(page, g, { x: 1425, y: 450 }, { shot: 'graphify-docking@1440x900.png' });
  s = await state(page);
  check('docks', s.docked && !s.closed, JSON.stringify(s));
  check('docked window still renders the graph', s.canvas && s.w > 150 && s.h > 150, JSON.stringify(s));
  await page.screenshot({ path: path.join(OUT, 'graphify-docked@1440x900.png') });

  // The layout survives a reload.
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#panels-btn');
  await sleep(2500);
  s = await state(page);
  check('docked layout survives a reload', s.docked && !s.closed && s.canvas, JSON.stringify(s));
  await page.screenshot({ path: path.join(OUT, 'graphify-after-reload@1440x900.png') });

  // Undock by dragging it out to the middle of the stage.
  const g2 = await headPoint(page);
  const st = await rect(page, '.dock-stage');
  await drag(page, g2, { x: st.x + st.w / 2, y: st.y + st.h / 2 }, { steps: 18 });
  s = await state(page);
  check('undocks by dragging out', !s.docked && !s.closed, JSON.stringify(s));
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#panels-btn');
  await sleep(2500);
  s = await state(page);
  check('floating window survives a reload', !s.docked && !s.closed && s.canvas, JSON.stringify(s));
  await page.screenshot({ path: path.join(OUT, 'graphify-floating@1440x900.png') });

  // Collapse and close persist as well.
  await page.click('#graphify .pcollapse');
  await sleep(300);
  check('collapses to its header', await is(page, '#graphify', 'panel-collapsed'));
  await page.click('#graphify .pcollapse');
  await sleep(300);
  await page.click('#graphify .pclose:not(.pcollapse)');
  await sleep(400);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#panels-btn');
  await sleep(1500);
  check('closed state survives a reload', (await state(page)).closed);
  await ctx.close();
}

// ------------------------------------------------------------------ phone 390x844
{
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  watch(page);
  await page.goto(URL, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#btn-more');
  await sleep(1500);
  check('phone: closed by default', (await state(page)).closed);
  await page.tap('#btn-more');
  await sleep(400);
  await page.tap('#more-sheet #btn-graphify');
  await sleep(11000); // swiftshader is slow: let the layout settle and the view frame the graph
  const s = await state(page);
  check('phone: opens from the ⋯ sheet', !s.closed && s.canvas, JSON.stringify(s));
  const fit = await page.evaluate(() => {
    const vw = innerWidth;
    const vh = innerHeight;
    const clipped = [...document.querySelectorAll('#graphify .pclose, #graphify .gfy-bar button, #graphify .gfy-bar input, #graphify .gfy-bar label, #graphify .gfy-bar select')].filter((e) => e.offsetParent).map((e) => ({ e, r: e.getBoundingClientRect() }))
      .filter(({ r }) => r.left < 0 || r.right > vw + 0.5 || r.top < 0 || r.bottom > vh + 0.5).map(({ e }) => e.className || e.tagName);
    const small = [...document.querySelectorAll('#graphify .pclose, #graphify .gfy-bar button, #graphify .gfy-bar select')].filter((e) => e.offsetParent && (e.getBoundingClientRect().height < 40 || e.getBoundingClientRect().width < 40)).map((e) => e.className);
    return { clipped, small, hscroll: document.documentElement.scrollWidth > vw, box: document.querySelector('#graphify').getBoundingClientRect().toJSON() };
  });
  check('phone: no clipped controls, no sideways scroll', !fit.clipped.length && !fit.hscroll, JSON.stringify(fit));
  check('phone: controls are touch-sized', !fit.small.length, JSON.stringify(fit.small));
  check('phone: window spans the width', fit.box.width >= 360, JSON.stringify(fit.box));
  check('phone: Structure is the view and its legend gives way to the graph', await page.evaluate(() => document.querySelector('#graphify').dataset.view === 'structure' && getComputedStyle(document.querySelector('#graphify .gfy-legend')).display === 'none'));
  await page.selectOption('#graphify .gfy-jump', 'checks');
  await sleep(2500);
  const pc = await page.evaluate(() => { const d = document.querySelector('#graphify .gfy-detail'); const r = d.getBoundingClientRect(); const st = document.querySelector('#graphify .gfy-stage').getBoundingClientRect(); return { shown: !d.hidden, inside: r.left >= st.left - 1 && r.right <= st.right + 1 && r.bottom <= st.bottom + 1 && r.top >= st.top - 1, text: d.innerText.slice(0, 80) }; });
  check('phone: the jump list opens a detail card inside the window', pc.shown && pc.inside, JSON.stringify(pc));
  await page.screenshot({ path: path.join(OUT, 'graphify-open@390x844.png') });
  await ctx.close();
}

await browser.close();
check('no console errors or page errors', !errors.length, errors.join(' | '));
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed — screenshots in ${path.relative(ROOT, OUT)}`);
server.stop();
process.exit(failed.length ? 1 : 0);
