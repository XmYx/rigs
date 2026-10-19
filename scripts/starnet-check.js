#!/usr/bin/env node
// StarNet space-station view check (experimental, src/starnet.js + ui/src/starnet/): drives JARVIS in headless Chromium
// (Playwright from RIGS_AUDIT_TOOLS or ~/.cache/rigs-audit, as scripts/graphify-check.js) and checks, saving screenshots:
//   flag off → the galaxy exactly as before: no #station, no /starnet/ request, no view chunk, /starnet/ is a 404;
//   flag on (settings API) → the station replaces the galaxy, its frame asks for nothing outside /starnet/, the
//     workers on the floor match the mesh model, a click on a worker's desk / JARVIS selects that node in the inspector
//     and opens its action menu there; a right-click opens the same menu (empty floor: the station's own); ◎ Fit
//     frames the whole station; every online machine room has ✳ New agent; a room with more agent sessions than
//     desks shows +N, which opens Sessions;
//   create and reach (unless --no-create): ✳ on this machine's room → the New agent dialog → a real `--agent` (default
//     claude, idle, in --agent-dir = this checkout, which must be a folder the agent already trusts) in tmux → it
//     walks onto the floor as a worker → a click on its desk → Send message… → the chat dock types "/help" into it
//     (a local command, no model call) and its transcript shows it → its tmux session is killed at the end;
//   flag off (rigs CLI) → the station is gone and the galaxy is back; on again from Experimental › Space station view;
//   a phone (390x844) keeps the galaxy; no console errors anywhere.
//   node scripts/starnet-check.js --dir <installed StarNet dir> [--url http://127.0.0.1:4719/] [--out docs/screenshots/starnet]
//     [--agent claude|codex] [--agent-dir <folder>] [--no-create]
// --dir: a `rigs starnet install` result (default: ~/.rigs/starnet/<pinned ref>). Without --url it starts a throwaway
// `rigs serve` (scratch RIGS_HOME pointing experimental.starnet.dir at --dir; no OpenRig, migrations or autoupdate).
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
const { PINNED_REF } = await import('../src/starnet.js');
const DIR = path.resolve(opt('dir', path.join(os.homedir(), '.rigs', 'starnet', PINNED_REF)));
if (!fs.existsSync(path.join(DIR, '.rigs-starnet.json'))) { console.error(`no StarNet install in ${DIR}: run rigs starnet install (or pass --dir)`); process.exit(2); }
const OUT = path.resolve(opt('out', path.join(ROOT, 'docs/screenshots/starnet')));
fs.mkdirSync(OUT, { recursive: true });

let home = null;
let port = 0;
async function startServer() {
  if (opt('url', '')) return { url: opt('url', ''), stop() {} };
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'rigs-starnet-'));
  port = await new Promise((resolve, reject) => { const s = net.createServer(); s.once('error', reject); s.listen(0, '127.0.0.1', () => { const { port: p } = s.address(); s.close(() => resolve(p)); }); });
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ port, openrig: { registerPeers: false }, experimental: { starnet: { enabled: false, dir: DIR } } }));
  const child = spawn(process.execPath, ['bin/rigs.js', 'serve'], { cwd: ROOT, stdio: 'ignore', env: { ...env(), RIGS_SSH_DIR: path.join(home, 'ssh'), RIGS_NO_MIGRATIONS: '1', RIGS_NO_AUTOUPDATE: '1', RIGS_NO_OPENRIG: '1' } });
  const url = `http://127.0.0.1:${port}/`;
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 500));
    try { if ((await fetch(url)).ok) return { url, stop: () => { child.kill(); fs.rmSync(home, { recursive: true, force: true }); } }; } catch { /* wait */ }
  }
  child.kill();
  throw new Error('rigs serve did not come up');
}
const env = () => ({ ...process.env, ...(home ? { RIGS_HOME: home, RIGS_PORT: String(port) } : {}) });
const server = await startServer();
const URL = server.url;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, ok, extra = '') => { results.push({ name, ok: !!ok }); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${extra ? ' — ' + extra : ''}`); };
const setFlag = (enabled) => fetch(new globalThis.URL('/api/local/starnet/config', URL), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ enabled }) }).then((r) => r.json());
const cli = (...a) => new Promise((resolve) => { const c = spawn(process.execPath, ['bin/rigs.js', 'starnet', ...a], { cwd: ROOT, env: env() }); let out = ''; c.stdout.on('data', (d) => { out += d; }); c.stderr.on('data', (d) => { out += d; }); c.on('close', (code) => resolve({ code, out: out.trim() })); });
const GL = ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'];
// The view chunk is the dist file holding the frame's markup: with the flag off the page must never fetch it.
const dist = path.join(ROOT, 'ui/dist');
const viewChunk = fs.readdirSync(dist).find((f) => f.endsWith('.js') && f !== 'app.js' && fs.readFileSync(path.join(dist, f), 'utf8').includes('Boarding the station'));

async function menuItem(page, top, label) {
  await page.click(`#mb-top-${top}`);
  await sleep(250);
  const item = page.locator('.mb-menu .mb-item', { hasText: label }).first();
  await item.waitFor({ state: 'visible' });
  const box = await item.boundingBox();
  await page.mouse.click(box.x + 12, box.y + box.height / 2);
  await sleep(500);
}

/** ✳ on this machine's room → New agent → a worker on the floor → its menu → Send message… → the dock types into it. */
async function createAndReach(page, frame, { inspector, pickDesk, open, menuLabels, closeMenu }) {
  const self = await fetch(new globalThis.URL('/api/self', URL)).then((r) => r.json());
  const rid = await page.evaluate((id) => window.__rigsStarnet?.initial().rooms[`m:${id}`] || null, self.id);
  if (!rid) { check('create: this machine has a room on the station', false, self.name); return; }
  await frame.evaluate((r) => World.frameReviewRoom(r), rid);
  await sleep(1200);
  await frame.locator(`.rigs-tag[data-room="${rid}"] .rigs-act:not(.rigs-more)`).click();
  const dialog = page.locator('.win', { hasText: `New agent on ${self.name}` }).last();
  const shown = await dialog.waitFor({ state: 'visible', timeout: 5000 }).then(() => true, () => false);
  check('✳ on this machine\'s room opens New agent for it', shown, self.name);
  if (!shown) return;
  const kinds = await dialog.locator('select.mini option').evaluateAll((os) => os.map((o) => o.value));
  if (!kinds.includes(AGENT)) { check(`create: ${AGENT} is not installed on ${self.name} — skipped`, true, kinds.join(', ')); return; }
  await dialog.locator('select.mini').selectOption(AGENT);
  await dialog.locator('input.path-input').first().fill(AGENT_DIR);
  const started = page.waitForResponse((r) => r.url().includes('/agents/start'), { timeout: 20000 });
  await dialog.locator('button', { hasText: 'Start' }).click();
  const res = await started.then((r) => r.json(), (e) => ({ error: e.message }));
  if (res.kind === 'tmux') created = res.id;
  check(`Start runs ${AGENT} in tmux on ${self.name} (agents/start)`, res.kind === 'tmux' && !!res.id, JSON.stringify(res));
  if (res.kind !== 'tmux') return;
  const node = `s:${self.id}:tmux:${res.id}`;
  const t1 = Date.now();
  let worker = null;
  while (!worker && Date.now() - t1 < 60000) {
    await sleep(1500);
    worker = await page.evaluate((n) => window.__rigsStarnet?.initial().workers.find((w) => w.node === n) || null, node);
  }
  const onFloor = worker && await frame.evaluate((id) => (World.crewFrames() || []).some((b) => b.agentId === id), worker.id);
  check('the new agent walks onto the floor as a worker in its machine\'s room', !!worker && worker.room === rid && onFloor, `${node} after ${((Date.now() - t1) / 1000).toFixed(1)} s`);
  if (!worker) return;
  await page.screenshot({ path: path.join(OUT, 'create-agent-on-floor@1440x900.png') });
  await page.evaluate(() => document.querySelectorAll('.win .win-btn.close').forEach((b) => b.click())); // its terminal window covers the floor
  await frame.evaluate((r) => World.frameReviewRoom(r), rid);
  await sleep(1500);
  const pt = await pickDesk(worker.id);
  if (!(await open(pt))) { check('reach: the new agent\'s desk is on screen', false, JSON.stringify(pt)); return; }
  await page.mouse.click(pt.clientX, pt.clientY);
  await sleep(800);
  const items = await menuLabels();
  check('reach: a click on its desk selects it and opens its session menu', /tmux|claude|codex/i.test(await inspector()) && items.some((l) => /Send message/.test(l)) && items.some((l) => /Attach terminal/.test(l)), items.slice(0, 5).join(' · '));
  await page.screenshot({ path: path.join(OUT, 'create-agent-menu@1440x900.png') });
  const send = page.locator('.mb-menu.mb-ctx .mb-item', { hasText: 'Send message' }).first();
  if (!(await send.count())) { await closeMenu(); return; }
  await send.click();
  await sleep(800);
  const dock = await page.evaluate(() => document.getElementById('dock-target')?.textContent || '');
  check('reach: Send message… attaches the chat dock to it', dock.includes(res.id), dock);
  await sleep(8000); // the agent's own start-up screen
  const sent = page.waitForResponse((r) => r.url().includes('/sessions/send'), { timeout: 15000 });
  await page.fill('#ask', '/help');
  await page.press('#ask', 'Enter');
  const sr = await sent.then((r) => r.json(), (e) => ({ error: e.message }));
  let shot = '';
  for (let i = 0; i < 10 && !/help/i.test(shot); i++) {
    await sleep(1000);
    shot = await fetch(new globalThis.URL(`/api/local/sessions/transcript?kind=tmux&id=${encodeURIComponent(res.id)}`, URL)).then((r) => r.json()).then((t) => t.map((x) => x.text).join('\n'), () => '');
  }
  check('reach: the dock types into it (sessions/send) and its transcript shows it', sr.ok === true && /help/i.test(shot), `${JSON.stringify(sr)} · ${shot.split('\n').filter((l) => /help/i.test(l)).slice(0, 2).join(' / ').slice(0, 140)}`);
  await page.screenshot({ path: path.join(OUT, 'create-agent-reached@1440x900.png') });
  await page.evaluate(() => document.querySelectorAll('.win .win-btn.close').forEach((b) => b.click()));
}

const browser = await chromium.launch({ args: GL });
const errors = [];
const requests = [];
const watch = (page) => {
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()} @ ${m.location()?.url || ''}`); });
  page.on('request', (r) => requests.push({ url: r.url(), main: r.frame() === page.mainFrame() }));
};
const AGENT = opt('agent', 'claude');
const AGENT_DIR = path.resolve(opt('agent-dir', ROOT));
const CREATE = !args.includes('--no-create');
let created = null; // the tmux session this check started (killed in finally)
const station = (page) => page.evaluate(() => ({ el: !!document.getElementById('station'), on: document.body.classList.contains('starnet'), bridge: !!window.__rigsStarnet, graphHidden: getComputedStyle(document.getElementById('graph')).visibility === 'hidden' }));
const frameOf = (page) => page.frames().find((f) => new globalThis.URL(f.url()).pathname.startsWith('/starnet/'));

try {
  // ---------------------------------------------------------------- flag off: as before
  check('/starnet/ is a 404 while the flag is off', (await fetch(new globalThis.URL('/starnet/', URL))).status === 404);
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  watch(page);
  await page.goto(URL, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#graph canvas');
  await sleep(5000);
  let s = await station(page);
  check('flag off: the galaxy, no station element or bridge', !s.el && !s.on && !s.bridge && !s.graphHidden, JSON.stringify(s));
  check('flag off: nothing under /starnet/ requested', !requests.some((r) => new globalThis.URL(r.url).pathname.startsWith('/starnet')));
  check('flag off: the station view chunk is never fetched', !!viewChunk && !requests.some((r) => r.url.endsWith('/' + viewChunk)), viewChunk || 'view chunk not found in ui/dist');
  check('flag off: Experimental menu offers the switch, unchecked', await (async () => { await page.click('#mb-top-experimental'); await sleep(250); const row = page.locator('.mb-menu .mb-item', { hasText: 'Space station view' }).first(); const ok = (await row.count()) > 0 && (await row.getAttribute('aria-checked')) !== 'true'; await page.keyboard.press('Escape'); return ok; })());
  await page.screenshot({ path: path.join(OUT, 'flag-off-galaxy@1440x900.png') });

  // ---------------------------------------------------------------- on through the settings API: the station
  const t0 = Date.now();
  const st = await setFlag(true);
  check('settings API switches it on', st.enabled === true && st.installed === true, JSON.stringify({ enabled: st.enabled, installed: st.installed }));
  await page.waitForFunction(() => document.body.classList.contains('starnet'), null, { timeout: 90000 }).catch(() => {});
  s = await station(page);
  check('flag on: the station replaces the galaxy (no reload)', s.el && s.on && s.graphHidden, `${JSON.stringify(s)} after ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  await sleep(6000);
  await page.screenshot({ path: path.join(OUT, 'flag-on-station@1440x900.png') });
  const frame = frameOf(page);
  const outside = requests.filter((r) => !r.main && !new globalThis.URL(r.url).pathname.startsWith('/starnet/') && !r.url.startsWith('data:'));
  check('station frame asks for nothing outside /starnet/', frame && outside.length === 0, outside.slice(0, 5).map((r) => r.url).join(' '));
  check('no StarNet UI sounds served', (await fetch(new globalThis.URL('/starnet/assets/sfx/LICENSE.md', URL))).status === 404);
  const model = await page.evaluate(() => { const m = window.__rigsStarnet.initial(); return { rooms: Object.keys(m.doc.rooms).length, workers: m.workers.map((w) => ({ id: w.id, node: w.node, working: w.working })) }; });
  const floor = await frame.evaluate(() => ({ crew: World.dbg()?.crew, hero: World.dbg()?.goal !== undefined }));
  check('floor has one body per worker in the model, plus JARVIS', floor.crew === model.workers.length && floor.hero, `${model.rooms} rooms, ${model.workers.length} workers (${model.workers.filter((w) => w.working).length} working), floor crew ${floor.crew}`);
  const sameStorage = await page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith('starnet.')).length);
  check('StarNet keeps its save in the frame (no starnet.* keys on the RIGS origin)', sameStorage === 0, `${sameStorage} key(s)`);
  const pickDesk = async (aid) => frame.evaluate((a) => World._dbgDeskClientPoint(a), aid);
  const inspector = () => page.evaluate(() => document.getElementById('inspector')?.innerText || '');
  const menuLabels = () => page.evaluate(() => [...document.querySelectorAll('.mb-menu.mb-ctx .mb-item')].map((e) => e.textContent.trim()));
  const closeMenu = async () => { await page.keyboard.press('Escape'); await sleep(300); };
  const before = await inspector();
  // the first worker whose desk is on screen and not under a JARVIS panel
  const open = (pt) => pt && page.evaluate(([x, y]) => document.elementFromPoint(x, y)?.tagName === 'IFRAME', [pt.clientX, pt.clientY]);
  let w = null;
  let pt = null;
  for (const c of model.workers) { const p = await pickDesk(c.id); if (await open(p)) { w = c; pt = p; break; } }
  if (w) {
    const was = await inspector();
    if (pt) { await page.mouse.click(pt.clientX, pt.clientY); await sleep(800); }
    check('a click on a worker\'s desk selects its session', !!pt && (await inspector()) !== was, `${w.node} → ${(await inspector()).slice(0, 80).replace(/\n/g, ' | ')}`);
    await sleep(1200);
    await page.screenshot({ path: path.join(OUT, 'flag-on-worker-selected@1440x900.png') });
    await closeMenu();
  } else check('a click on a worker\'s desk selects its session (no worker desk on screen — skipped)', true, `${model.workers.length} workers`);
  await frame.evaluate(() => World.frameReviewRoom(''));
  await sleep(1500);
  const labels = await frame.evaluate(() => [...document.querySelectorAll('.rigs-room')].map((b) => b.textContent));
  check('every machine room is named on the floor', labels.length === model.rooms - 1, labels.join(', '));
  const spots = await frame.evaluate(() => [...document.querySelectorAll('.rigs-room')].map((b) => { const r = b.getBoundingClientRect(); return { name: b.textContent, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 }; }));
  let spot = null;
  for (const c of spots) if (!/^BRIDGE/.test(c.name) && await open(c)) { spot = c; break; }
  const was = await inspector();
  if (spot) { await page.mouse.click(spot.clientX, spot.clientY); await sleep(800); }
  check('a click on a room name selects that machine', !!spot && (await inspector()) !== was, `${spot?.name} → ${(await inspector()).slice(0, 60).replace(/\n/g, ' | ')}`);
  const roomMenu = await menuLabels();
  check('…and opens its action menu with New agent', roomMenu.some((l) => /New agent/.test(l)) && roomMenu.some((l) => /Open terminal/.test(l)), roomMenu.slice(0, 6).join(' · '));
  await closeMenu();
  const tags = await frame.evaluate(() => [...document.querySelectorAll('.rigs-tag')].map((t) => ({ room: t.dataset.room, act: !!t.querySelector('.rigs-act:not(.rigs-more)'), more: t.querySelector('.rigs-more:not([hidden])')?.textContent || '' })));
  const onlineRooms = await page.evaluate(() => { const m = window.__rigsStarnet.initial(); return Object.entries(m.ids).filter(([rid, j]) => m.doc.rooms[rid] && j.startsWith('m:') && m.doc.rooms[rid].kind !== 'storage').map(([rid]) => rid); });
  check('every online machine room has ✳ New agent, no other room does', tags.filter((t) => t.act).map((t) => t.room).sort().join() === onlineRooms.sort().join(), `${onlineRooms.length} online room(s)`);
  const overflow = await page.evaluate(() => window.__rigsStarnet.initial().overflow);
  const moreOk = tags.every((t) => { const o = overflow[t.room]; const n = o ? o.desks + o.older : 0; return n ? t.more === `+${n}` : !t.more; });
  check('+N on exactly the rooms with agent sessions past the desks or idle for over 12 h', moreOk, tags.filter((t) => t.more).map((t) => `${t.room} ${t.more}`).join(', ') || 'none');
  const moreTag = tags.find((t) => t.more);
  if (moreTag) {
    const wins = await page.evaluate(() => document.querySelectorAll('.win').length);
    await frame.locator(`.rigs-tag[data-room="${moreTag.room}"] .rigs-more`).click();
    await sleep(1200);
    const title = await page.evaluate(() => [...document.querySelectorAll('.win .win-title-text')].map((e) => e.textContent).join(' | '));
    check('+N opens the machine\'s Sessions window', (await page.evaluate(() => document.querySelectorAll('.win').length)) > wins && /Sessions/i.test(title), title.slice(0, 120));
    await page.evaluate(() => document.querySelectorAll('.win .win-btn.close').forEach((b) => b.click()));
    await sleep(500);
  }

  // right-click: a worker's menu, and the station's own on empty floor
  await frame.evaluate(() => World.frameReviewRoom(''));
  await sleep(1500);
  let rw = null;
  for (const c of model.workers) { const p = await pickDesk(c.id); if (await open(p)) { rw = { ...c, pt: p }; break; } }
  if (rw) {
    await page.mouse.click(rw.pt.clientX, rw.pt.clientY, { button: 'right' });
    await sleep(600);
    const items = await menuLabels();
    check('a right-click on a worker opens its session menu', items.some((l) => /Open transcript/.test(l)) && items.some((l) => /Send message/.test(l)), items.slice(0, 6).join(' · '));
    await page.screenshot({ path: path.join(OUT, 'flag-on-worker-menu@1440x900.png') });
    await closeMenu();
  } else check('a right-click on a worker opens its session menu (no worker desk on screen — skipped)', true);
  const vp = page.viewportSize();
  await page.mouse.click(vp.width / 2, 40, { button: 'right' }); // the void above the station
  await sleep(600);
  const bg = await menuLabels();
  check('a right-click on empty floor opens the station menu', bg.some((l) => /Show the whole station/.test(l)), bg.slice(0, 4).join(' · '));
  await closeMenu();
  // ◎ Fit frames the station (it used to fit the hidden galaxy)
  await frame.evaluate((rid) => World.frameReviewRoom(rid), onlineRooms[0] || '');
  await sleep(1200);
  const zoomed = await frame.evaluate(() => World.cameraState().scale);
  await page.click('#fit');
  await sleep(1500);
  const fitted = await frame.evaluate(() => World.cameraState().scale);
  check('◎ Fit frames the whole station', fitted < zoomed, `scale ${zoomed.toFixed(2)} → ${fitted.toFixed(2)}`);

  await frame.evaluate(() => World.frameReviewRoom('')); // a selection framed its room: back to the whole station
  await sleep(1500);
  const hero = await pickDesk('jarvis');
  if (hero) { await page.mouse.click(hero.clientX, hero.clientY); await sleep(800); }
  check('a click on JARVIS\'s desk selects the mesh in the inspector', !!hero && (await inspector()) !== before && /TAILNET|tailnet/i.test(await inspector()), (await inspector()).slice(0, 80).replace(/\n/g, ' | '));
  await closeMenu();
  // ---------------------------------------------------------------- create an agent from the station and reach it
  if (CREATE) await createAndReach(page, frame, { inspector, pickDesk, open, menuLabels, closeMenu });
  else check('create and reach an agent (--no-create — skipped)', true);

  // ---------------------------------------------------------------- off through the CLI: the galaxy is back
  const off = await cli('off');
  check('rigs starnet off', off.code === 0 && /off/.test(off.out), off.out.split('\n')[0]);
  await page.waitForFunction(() => !document.getElementById('station'), null, { timeout: 15000 }).catch(() => {});
  s = await station(page);
  check('flag off again: station gone, galaxy back', !s.el && !s.on && !s.bridge && !s.graphHidden, JSON.stringify(s));
  await sleep(3000);
  await page.screenshot({ path: path.join(OUT, 'flag-off-again-galaxy@1440x900.png') });
  check('/starnet/ is a 404 again', (await fetch(new globalThis.URL('/starnet/', URL))).status === 404);

  // ---------------------------------------------------------------- on from the menu
  await menuItem(page, 'experimental', 'Space station view');
  await page.waitForFunction(() => document.body.classList.contains('starnet'), null, { timeout: 90000 }).catch(() => {});
  check('Experimental › Space station view switches it on', (await station(page)).on);
  const status = await cli('status');
  check('rigs starnet status reports on + installed', /view on · installed/.test(status.out), status.out.split('\n')[0]);
  await menuItem(page, 'experimental', 'Space station view');
  await page.waitForFunction(() => !document.getElementById('station'), null, { timeout: 15000 }).catch(() => {});
  check('…and off again', !(await station(page)).el);
  await ctx.close();

  // ---------------------------------------------------------------- phone keeps the galaxy
  await setFlag(true);
  const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  const pp = await phone.newPage();
  watch(pp);
  await pp.goto(URL, { waitUntil: 'domcontentloaded' });
  await pp.waitForSelector('#graph canvas');
  await sleep(4000);
  s = await station(pp);
  check('phone 390x844: the galaxy stays (no station frame)', !s.el && !s.graphHidden, JSON.stringify(s));
  await pp.screenshot({ path: path.join(OUT, 'flag-on-phone-galaxy@390x844.png') });
  await phone.close();
  await setFlag(false);

  check('no console errors (main page and station frame)', errors.length === 0, errors.slice(0, 8).join(' || '));
} finally {
  if (created) await new Promise((r) => spawn('tmux', ['kill-session', '-t', created]).on('close', r).on('error', r));
  await browser.close();
  server.stop();
}
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed · screenshots in ${path.relative(ROOT, OUT)}`);
process.exit(failed.length ? 1 : 0);
