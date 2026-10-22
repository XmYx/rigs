#!/usr/bin/env node
// YOLO history check (ui/src/yolo.js openYoloHistory, GET /api/local/yolo/history): two throwaway `rigs serve` nodes — "front"
// (the UI) and "yolo-peer" (a mesh peer) — each with finished runs written to disk: on front a never-kept v1 run, a kept run and an
// idle v2 run with a conversation; on the peer a finished run. Browser (Chrome through Playwright), desktop 1440x900 and phone
// 390x844: the panel never opens by itself; the Apps list button opens it; one list with every machine's runs, icon, title,
// machine, age, status, kept badge; a click opens a never-kept finished run's page in a YOLO window, a second click focuses it
// (no duplicate); the v2 conversation and the feedback box; Keep as app / Open app; text and machine filters; a ui_open push
// (view yolo) opens it; with the peer stopped its rows are greyed and not clickable. Screenshots go to --out.
//   node scripts/yolo-history-check.js [--out screenshots/yolo-history]
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
let chromium = null;
for (const d of [process.env.RIGS_AUDIT_TOOLS, path.join(os.homedir(), '.cache/rigs-audit'), ROOT].filter(Boolean)) { try { ({ chromium } = createRequire(path.join(path.resolve(d), 'x.js'))('playwright')); break; } catch { /* next */ } }
if (!chromium) { console.error('playwright not found: install it outside the repo and set RIGS_AUDIT_TOOLS=<dir>'); process.exit(2); }
const OUT = path.resolve(opt('out', path.join(ROOT, 'screenshots/yolo-history')));
fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const TOKEN = `yolo-hist-${process.pid}`;
const NOW = Date.now();

const freePort = () => new Promise((resolve, reject) => { const s = net.createServer(); s.once('error', reject); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }); });
const runId = (secAgo, hex) => { const d = new Date(NOW - secAgo * 1000); const p = (n) => String(n).padStart(2, '0'); return `y-${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}-${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}-${hex}`; };
const page$ = (title, color, emoji) => `<!doctype html><meta charset=utf-8><title>${title}</title><body style="margin:0;display:grid;place-items:center;height:100vh;background:${color};font:700 28px system-ui;color:#fff"><div style="text-align:center"><div style="font-size:72px">${emoji}</div>${title}</div></body>`;

/** Write a finished run into a node's sandbox the way the daemon leaves it (page + meta). */
function seedRun(home, { id, secAgo, title, task, status = 'done', color, emoji, ...meta }) {
  const root = path.join(home, 'yolo');
  fs.mkdirSync(path.join(root, id), { recursive: true });
  fs.writeFileSync(path.join(root, id, 'index.html'), page$(title, color, emoji));
  const createdAt = NOW - secAgo * 1000;
  fs.writeFileSync(path.join(root, `${id}.json`), JSON.stringify({ runId: id, title, task, status, ok: status !== 'failed', createdAt, startedAt: createdAt, endedAt: createdAt + 9000, files: ['index.html'], updates: 2, ...meta }));
}

async function startNode(name, seed, extraEnv = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), `rigs-yh-${name}-`));
  const port = await freePort();
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ port, openrig: { registerPeers: false } }));
  seed(home);
  const env = { ...process.env, RIGS_HOME: home, RIGS_PORT: String(port), RIGS_NAME: name, RIGS_SSH_DIR: path.join(home, 'ssh'), RIGS_NO_MIGRATIONS: '1', RIGS_NO_AUTOUPDATE: '1', RIGS_NO_OPENRIG: '1', RIGS_PEERS: '', RIGS_MESH_TOKEN: TOKEN, RIGS_BIND: '127.0.0.1', ...extraEnv };
  const child = spawn(process.execPath, ['bin/rigs.js', 'serve'], { cwd: ROOT, stdio: 'ignore', env });
  const url = `http://127.0.0.1:${port}/`;
  for (let i = 0; i < 60; i++) {
    await sleep(500);
    try { if ((await fetch(url + 'api/self')).ok) return { url, home, port, stop: () => { child.kill(); } , clean: () => fs.rmSync(home, { recursive: true, force: true }) }; } catch { /* wait */ }
  }
  child.kill();
  throw new Error(`${name} did not come up`);
}

const IDS = { planets: runId(40, 'a1a1a1'), kept: runId(2 * 86400, 'b2b2b2'), idle: runId(6 * 60, 'c3c3c3'), peer: runId(3 * 3600, 'd4d4d4') };
const peer = await startNode('yolo-peer', (home) => seedRun(home, { id: IDS.peer, secAgo: 3 * 3600, title: 'Peer flow field', task: 'a flow field', color: '#7c3aed', emoji: '🌊', icon: { emoji: '🌊', at: 1 } }));
const front = await startNode('yolo-front', (home) => {
  seedRun(home, { id: IDS.planets, secAgo: 40, title: 'Orbiting planets', task: 'orbiting planets', color: '#0f766e', emoji: '🪐', icon: { emoji: '🪐', at: 1 } });
  seedRun(home, { id: IDS.kept, secAgo: 2 * 86400, title: 'CPU history chart', task: 'a cpu chart', color: '#b45309', emoji: '📈', keptAs: { id: 'cpu-chart', node: 'yolo-front', name: 'CPU chart', path: '/p/' } });
  seedRun(home, { id: IDS.idle, secAgo: 6 * 60, title: 'Bouncing ball v2', task: 'a bouncing ball', status: 'idle', v2: true, turn: 2, color: '#1d4ed8', emoji: '⚽', sessionId: 's1',
    messages: [{ role: 'user', text: 'a bouncing ball', turn: 1, at: NOW - 400e3 }, { role: 'assistant', text: 'Here is a ball that bounces off the walls.', turn: 1, at: NOW - 380e3 }, { role: 'user', text: 'make it red', turn: 2, at: NOW - 370e3 }, { role: 'assistant', text: 'Red now, sir.', turn: 2, at: NOW - 360e3 }] });
}, { RIGS_PEERS: `http://127.0.0.1:${peer.port}` });
for (let i = 0; i < 60; i++) {
  const nodes = await (await fetch(front.url + 'api/mesh/refresh', { method: 'POST' })).json().catch(() => []);
  if (nodes.some((n) => n.name === 'yolo-peer' && n.online && n.rigs)) break;
  await sleep(500);
}

const results = [];
const errors = [];
const check = (name, ok, extra = '') => { results.push(!!ok); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${extra ? ' — ' + extra : ''}`); };
const browser = await chromium.launch({ channel: process.env.RIGS_CHROME_CHANNEL || 'chrome', args: ['--no-sandbox'] });
const uiOpen = (body) => fetch(new URL('api/mesh/ui/open', front.url), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json());
const shot = async (page, name) => { await page.addStyleTag({ content: '#toasts{display:none!important}' }); await sleep(400); await page.screenshot({ path: path.join(OUT, name) }); };
const hist = (page) => page.locator('.yolo-hist-win');
const rowOf = (page, id) => page.locator(`.yolo-hist-row[data-run="${id}"]`);
const yoloWins = (page) => page.locator('.win.yolo-win');
const frameText = async (page, id) => {
  const f = page.frames().find((x) => x.url().includes(`/yolo/${id}/`));
  return f ? (await f.locator('body').innerText().catch(() => '')) : '';
};

async function run(label, vp) {
  const phone = label === 'phone';
  const ctx = await browser.newContext({ viewport: vp, hasTouch: phone, isMobile: phone, deviceScaleFactor: phone ? 2 : 1 });
  const page = await ctx.newPage();
  page.setDefaultTimeout(30000);
  page.on('pageerror', (e) => errors.push(`${label} pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error' && !/favicon|net::ERR|Failed to load resource/.test(m.text())) errors.push(`${label} console: ${m.text().slice(0, 200)}`); });
  const wsUp = new Promise((r) => page.on('websocket', (ws) => { if (new URL(ws.url()).pathname === '/ws') r(); }));
  await page.goto(front.url, { waitUntil: 'domcontentloaded', timeout: 120000 });
  await page.waitForSelector('#app-dock, #bar', { state: 'attached' });
  await Promise.race([wsUp, sleep(60000)]);
  await sleep(1500);
  check(`${label}: the history panel and the YOLO windows do not open by themselves`, (await hist(page).count()) === 0 && (await yoloWins(page).count()) === 0);

  // Apps list → ⚡ YOLO history
  await page.evaluate(() => document.querySelector('#btn-apps')?.click());
  await page.locator('.apps-bar button', { hasText: 'YOLO history' }).click();
  await hist(page).waitFor();
  await page.locator('.yolo-hist-row').first().waitFor();
  const ids = await page.locator('.yolo-hist-row').evaluateAll((els) => els.map((e) => e.dataset.run));
  check(`${label}: the Apps list button opens one list with the runs of both machines, newest first`, JSON.stringify(ids) === JSON.stringify([IDS.planets, IDS.idle, IDS.peer, IDS.kept]), ids.join(' '));
  const planets = rowOf(page, IDS.planets);
  const txt = (loc) => loc.innerText();
  const t1 = await txt(planets);
  check(`${label}: a row has icon, title, machine, age and status`, /🪐/.test(t1) && /Orbiting planets/.test(t1) && /yolo-front/.test(t1) && /(just now|\d+m ago)/.test(t1) && /done/.test(t1), JSON.stringify(t1));
  check(`${label}: a kept run carries the kept badge and an Open app button; others do not`, /kept as app/.test(await txt(rowOf(page, IDS.kept))) && (await rowOf(page, IDS.kept).locator('.yolo-hist-app').count()) === 1 && !/kept as app/.test(t1));
  check(`${label}: the peer's run is in the same list`, /yolo-peer/.test(await txt(rowOf(page, IDS.peer))) && /🌊/.test(await txt(rowOf(page, IDS.peer))));
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  const listOverflow = await hist(page).evaluate((w) => { const l = w.querySelector('.yolo-hist-list'); return l.scrollWidth - l.clientWidth; });
  check(`${label}: layout holds (no horizontal overflow)`, overflow <= 0 && listOverflow <= 0, `page ${overflow}, list ${listOverflow}`);
  await shot(page, `history-${label}.png`);

  // a never-kept finished run opens in a YOLO window, once
  await planets.locator('.yolo-hist-main').click();
  await yoloWins(page).first().waitFor();
  await page.waitForFunction((id) => [...document.querySelectorAll('iframe.yolo-frame')].some((f) => f.src.includes(`/yolo/${id}/`)), IDS.planets);
  await sleep(1200);
  check(`${label}: clicking a never-kept finished run opens its page in a YOLO window`, (await frameText(page, IDS.planets)).includes('Orbiting planets'), JSON.stringify(await frameText(page, IDS.planets)));
  const w1 = yoloWins(page).last();
  check(`${label}: the window shows it as done with Keep as app offered`, (await w1.locator('.yolo-label').innerText()) === 'DONE' || /done/i.test(await w1.locator('.yolo-label').innerText()), await w1.locator('.yolo-label').innerText());
  check(`${label}: Keep as app is offered for the unkept run`, (await w1.locator('.yolo-keep-btn').innerText()).includes('Keep as app') && !(await w1.locator('.yolo-keep-btn').isDisabled()));
  await shot(page, `reopened-run-${label}.png`);
  if (phone) await page.keyboard.press('Escape').catch(() => {});
  // clicking it again focuses, never duplicates
  const wins = await yoloWins(page).count();
  await uiOpen({ view: 'yolo' }); // raises the open list over the YOLO window
  await hist(page).waitFor();
  await rowOf(page, IDS.planets).locator('.yolo-hist-main').click();
  await sleep(600);
  check(`${label}: an already-open run is focused, not duplicated`, (await yoloWins(page).count()) === wins, `${wins} → ${await yoloWins(page).count()}`);

  // an idle v2 run: conversation + feedback box
  await uiOpen({ view: 'yolo' });
  await rowOf(page, IDS.idle).locator('.yolo-hist-main').click();
  await page.waitForFunction(() => document.querySelectorAll('.yolo-msg').length >= 4);
  const win = page.locator('.win.yolo-win', { has: page.locator('.yolo-msg') }).last();
  if (phone) await win.locator('.yolo-convo-btn').click().catch(() => {});
  check(`${label}: a v2 run shows its conversation from the meta`, (await page.locator('.yolo-msg-text', { hasText: 'Red now, sir.' }).count()) >= 1 && (await page.locator('.yolo-msg').count()) >= 4);
  check(`${label}: an idle v2 run keeps its feedback box`, !(await win.locator('.yolo-input').isDisabled()) && !(await win.locator('.yolo-composer button', { hasText: 'Send feedback' }).isDisabled()));
  await shot(page, `reopened-v2-${label}.png`);

  if (!phone) {
    // kept run: ★ Kept in the window opens the app (tries to); filters
    await uiOpen({ view: 'yolo' });
    await rowOf(page, IDS.kept).locator('.yolo-hist-main').click();
    await page.waitForFunction((id) => [...document.querySelectorAll('iframe.yolo-frame')].some((f) => f.src.includes(`/yolo/${id}/`)), IDS.kept);
    const kw = yoloWins(page).last();
    check(`${label}: a kept run's window reads ★ Kept (it opens the app)`, (await kw.locator('.yolo-keep-btn').innerText()).includes('Kept'));
    // the peer run opens through the node proxy
    await uiOpen({ view: 'yolo' });
    await rowOf(page, IDS.peer).locator('.yolo-hist-main').click();
    await page.waitForFunction((id) => [...document.querySelectorAll('iframe.yolo-frame')].some((f) => f.src.includes(`/api/nodes/yolo-peer/yolo/${id}/`)), IDS.peer);
    await sleep(1200);
    check(`${label}: a run from the other machine opens through the node proxy`, (await frameText(page, IDS.peer)).includes('Peer flow field'), JSON.stringify(await frameText(page, IDS.peer)));
    // filters
    const h$ = hist(page);
    await h$.locator('.yolo-hist-find').fill('planets');
    check(`${label}: the text filter narrows the list`, (await h$.locator('.yolo-hist-row').count()) === 1);
    await h$.locator('.yolo-hist-find').fill('');
    await h$.locator('.yolo-hist-machine').selectOption('yolo-peer');
    check(`${label}: the machine filter narrows the list`, (await h$.locator('.yolo-hist-row').count()) === 1 && (await h$.locator('.yolo-hist-row').first().getAttribute('data-run')) === IDS.peer);
    await h$.locator('.yolo-hist-machine').selectOption('');
    // ui_open view yolo opens it (from a closed state)
    await h$.evaluate((el) => el.querySelector('.win-btn[aria-label="Close"]')?.click());
    await sleep(400);
    check(`${label}: closed`, (await hist(page).count()) === 0);
    const r = await uiOpen({ view: 'yolo' });
    await hist(page).waitFor();
    check(`${label}: a ui_open view "yolo" push opens the history`, r.ok === true && r.view === 'yolo', JSON.stringify(r));
  }

  // the other machine stops answering: its rows are greyed and not clickable
  if (!phone) {
    peer.stop();
    for (let i = 0; i < 40; i++) {
      const nodes = await (await fetch(front.url + 'api/mesh/refresh', { method: 'POST' })).json().catch(() => []);
      if (!nodes.some((n) => n.name === 'yolo-peer' && n.online && n.rigs)) break;
      await sleep(500);
    }
    await hist(page).locator('button[aria-label="Reload the list"]').click();
    await page.waitForFunction((id) => document.querySelector(`.yolo-hist-row[data-run="${id}"]`)?.classList.contains('offline'), IDS.peer);
    const off = rowOf(page, IDS.peer);
    check(`${label}: an offline machine's row is greyed and not clickable`, await off.locator('.yolo-hist-main').isDisabled() && !(await rowOf(page, IDS.planets).locator('.yolo-hist-main').isDisabled()));
    check(`${label}: the note says which machine is not reachable`, /yolo-peer not reachable/.test(await hist(page).locator('.yolo-hist-note').innerText()), await hist(page).locator('.yolo-hist-note').innerText());
    await shot(page, `history-offline-${label}.png`);
  }
  await ctx.close();
}

try {
  await run('desktop', { width: 1440, height: 900 });
  await run('phone', { width: 390, height: 844 });
} catch (e) {
  check('script ran to the end', false, e.stack || e.message);
}
check('no page errors', errors.length === 0, errors.join(' | '));
await browser.close();
front.stop(); peer.stop();
await sleep(300);
front.clean(); peer.clean();
const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed}/${results.length} checks passed · screenshots in ${OUT}`);
process.exit(failed ? 1 : 0);
