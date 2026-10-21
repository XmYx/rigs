#!/usr/bin/env node
// Live check of the app stream viewer (ui/src/app-stream.js) against a REAL host: a scratch `rigs serve` on this machine
// (the viewer's JARVIS) with a Linux host as its peer — a scratch daemon of the same branch on magix-system, reached through
// an SSH tunnel — and Google Chrome (WebCodecs H.264) through Playwright (RIGS_AUDIT_TOOLS or ~/.cache/rigs-audit).
// Prerequisites on the host (see the t4 notes in docs/app-streaming.md): the scratch daemon on 127.0.0.1:4798 with
// RIGS_MESH_TOKEN=t4-scratch, and a .desktop entry "RIGS Stream Test Client" running scripts/appstream/test-client-gtk4.py with
// RIGS_TEST_STATE=<file> (the client writes the last input it got, which this script reads back over SSH).
// Checks: Applications → open the test client → the viewer decodes it with WebCodecs (fps, bitrate, RTT in the stats overlay),
// mouse move/click, wheel and keys reach the app, the window resize resizes the remote display, touch drives the pointer at
// 390x844, and ⏹ ends the session on the host. Screenshots into --out (default docs/screenshots/app-stream).
//   node scripts/appstream-viewer-check.js [--out dir] [--host magix-system] [--state <remote file>] [--app "RIGS Stream Test Client"]
import { execFile, spawn } from 'node:child_process';
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
const OUT = path.resolve(opt('out', path.join(ROOT, 'docs/screenshots/app-stream')));
const HOST = opt('host', 'magix-system');
const STATE = opt('state', '/home/magix/rigs-scratch/test-client-state.json');
const APP = opt('app', 'RIGS Stream Test Client');
const HOST_PORT = Number(opt('host-port', '4798'));
const HOST_TOKEN = opt('token', 't4-scratch');
fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((resolve, reject) => { const s = net.createServer(); s.once('error', reject); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }); });
const ssh = (cmd) => new Promise((resolve) => execFile('ssh', ['-o', 'ConnectTimeout=8', HOST, cmd], { timeout: 20000 }, (_e, out) => resolve(String(out || ''))));
const remoteState = async () => { try { return JSON.parse(await ssh(`cat ${STATE}`)); } catch { return null; } };

// SSH tunnel to the host's scratch daemon, then this machine's scratch node with that daemon as its peer.
const tunnelPort = await freePort();
const tunnel = spawn('ssh', ['-N', '-o', 'ExitOnForwardFailure=yes', '-L', `${tunnelPort}:127.0.0.1:${HOST_PORT}`, HOST], { stdio: 'ignore' });
const port = await freePort();
const rigsHome = fs.mkdtempSync(path.join(os.tmpdir(), 'rigs-asv-check-'));
fs.mkdirSync(path.join(rigsHome, 'home'));
fs.writeFileSync(path.join(rigsHome, 'config.json'), JSON.stringify({ port, name: 'viewer-a', openrig: { registerPeers: false } }));
const child = spawn(process.execPath, ['bin/rigs.js', 'serve'], {
  cwd: ROOT, stdio: 'ignore',
  env: { ...process.env, RIGS_HOME: rigsHome, RIGS_PORT: String(port), RIGS_NAME: 'viewer-a', RIGS_SSH_DIR: path.join(rigsHome, 'ssh'), RIGS_NO_MIGRATIONS: '1', RIGS_NO_AUTOUPDATE: '1', RIGS_NO_OPENRIG: '1', RIGS_MESH_TOKEN: HOST_TOKEN, RIGS_PEERS: `http://127.0.0.1:${tunnelPort}` },
});
const URL_ = `http://127.0.0.1:${port}/`;
const stop = () => { child.kill(); tunnel.kill(); fs.rmSync(rigsHome, { recursive: true, force: true }); };
let up = false;
for (let i = 0; i < 60 && !up; i++) { await sleep(500); try { up = (await fetch(URL_)).ok; } catch { /* wait */ } }
if (!up) { stop(); throw new Error('rigs serve did not come up'); }

const results = [];
const check = (name, ok, extra = '') => { results.push(!!ok); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${extra ? ' — ' + extra : ''}`); };
const browser = await chromium.launch({ channel: process.env.RIGS_CHROME_CHANNEL || 'chrome', args: ['--no-sandbox'] });
const errors = [];
const shot = (page, name) => page.screenshot({ path: path.join(OUT, name) });
const V = '.as-win:not(.win-leave)';

async function waitHost() {
  for (let i = 0; i < 80; i++) {
    try { const s = await (await fetch(URL_ + 'api/mesh/snapshot')).json(); const n = s.find((e) => e.node.name === 'magix-t4' && e.node.online); if (n) return n.node; } catch { /* wait */ }
    await sleep(500);
  }
  throw new Error('the host scratch daemon did not join the mesh (is the tunnel and daemon up?)');
}
async function uiOpen(body) {
  for (let i = 0; i < 40; i++) {
    const r = await fetch(URL_ + 'api/mesh/ui/open', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then((x) => x.json());
    if (r.delivered) return r;
    await sleep(500);
  }
  return null;
}
async function newPage(viewport, extra = {}) {
  const ctx = await browser.newContext({ viewport, ...extra });
  await ctx.addInitScript(() => { try { if (!sessionStorage.getItem('fc-init')) { localStorage.setItem('rigs.cloud', 'false'); localStorage.removeItem('rigs.appstream'); if (location.search || true) localStorage.setItem('rigs.appstream.debug', '1'); sessionStorage.setItem('fc-init', '1'); } } catch { /* first load only */ } });
  await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: URL_.replace(/\/$/, '') }).catch(() => {});
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(`${viewport.width}: ${e.message}`));
  page.on('console', (m) => { if (process.env.DEBUG && /appstream/.test(m.text())) console.log('  console:', m.text().slice(0, 300)); if (m.type() === 'error' && !/favicon|Failed to load resource/.test(m.text())) errors.push(`${viewport.width}: ${m.text()}`); });
  page.on('dialog', (d) => d.accept());
  await page.goto(URL_);
  await sleep(1500);
  return { ctx, page };
}
const hostSessions = async (id) => ((await (await fetch(`${URL_}api/nodes/${encodeURIComponent(id)}/appstream/sessions`)).json()).sessions || []).filter((x) => !['ended', 'stopping'].includes(x.state));
async function openApp(page, node, { phone = false } = {}) {
  await uiOpen({ view: 'files', node: node.name, path: 'applications' });
  await page.waitForSelector('.files-win .fd-app');
  await page.fill('.files-win .fd-search', APP);
  await sleep(300);
  if (phone) { await page.locator('.files-win .fd-app', { hasText: APP }).first().tap(); await sleep(500); await page.locator('.files-win .fd-preview .btn.primary', { hasText: 'Open' }).tap(); } else await page.locator('.files-win .fd-app', { hasText: APP }).first().dblclick();
}
const stats = (page) => page.evaluate(() => { const r = document.querySelector('.as-win:not(.win-leave) .as-view'); return r ? { fps: Number(r.dataset.fps), rtt: Number(r.dataset.rtt), kbps: Number(r.dataset.kbps), bin: Number(r.dataset.bin), decoded: Number(r.dataset.decoded), dropped: Number(r.dataset.dropped), decoder: r.dataset.decoder } : null; });

try {
  const host = await waitHost();
  check('the host scratch daemon joined the mesh', !!host.id, `${host.name} ${host.id}`);
  for (const s of await hostSessions(host.id)) await fetch(`${URL_}api/nodes/${encodeURIComponent(host.id)}/appstream/sessions/${s.id}`, { method: 'DELETE' });

  // ---------------------------------------------------------------- desktop
  const { ctx, page } = await newPage({ width: 1440, height: 900 });
  await openApp(page, host);
  await page.waitForSelector(`${V} .as-canvas:not([hidden])`, { timeout: 40000 });
  if (process.env.DEBUG) { await shot(page, 'debug.png'); console.log(await page.evaluate(() => document.querySelector('.as-win')?.outerHTML.slice(0, 1500))); }
  await sleep(3500);
  const st = await page.evaluate(() => { const w = document.querySelector('.as-win:not(.win-leave)'); return { title: w?.querySelector('.win-title-text')?.textContent, canvas: !!w?.querySelector('.as-canvas:not([hidden])') }; });
  check('opening the app from Applications lands in the viewer window', /RIGS Stream Test Client — /.test(st.title || ''), st.title);
  const info = await page.evaluate(async () => ({ secure: window.isSecureContext, vd: 'VideoDecoder' in window }));
  check('WebCodecs is available here (secure context)', info.secure && info.vd);
  await page.locator(`${V} .as-stats-btn`).click();
  for (let i = 0; i < (process.env.DEBUG ? 8 : 0); i++) { await sleep(1000); console.log('  sample', JSON.stringify(await stats(page)), 'app frames', (await remoteState())?.frames); }
  if (process.env.DEBUG) console.log('  host session', JSON.stringify(await hostSessions(host.id)).slice(0, 1200));
  await sleep(2500);
  const s1 = await stats(page);
  check('live: decoded frames at a real frame rate', s1.fps >= 20, JSON.stringify(s1));
  check('stats overlay shows bitrate and RTT', s1.kbps > 0 && s1.rtt >= 0, JSON.stringify(s1));
  const overlay = await page.$eval(`${V} .as-stats`, (e) => e.textContent);
  check('stats overlay text names the decoder and encoder', /decoder webcodecs/.test(overlay) && /encoder nvh264enc|encoder x264enc|encoder openh264enc/.test(overlay), overlay.split('\n').slice(0, 4).join(' | '));
  const sess = (await hostSessions(host.id)).find((x) => ['running', 'parked', 'starting'].includes(x.state));
  check('the session is running on the host', sess && ['running', 'parked'].includes(sess.state), JSON.stringify({ id: sess?.id, state: sess?.state, w: sess?.width, h: sess?.height }));
  await shot(page, 'viewer-desktop-stats.png');

  // input: the client writes what it got
  const box = await page.locator(`${V} .as-canvas`).boundingBox();
  const sw = sess.width, sh = sess.height;
  const k = Math.min(box.width / sw, box.height / sh);
  const at = (x, y) => [box.x + (box.width - sw * k) / 2 + x * k, box.y + (box.height - sh * k) / 2 + y * k];
  const [mx, my] = at(sw * 0.6, sh * 0.6);
  await page.mouse.move(mx - 40, my - 30);
  await page.mouse.move(mx, my, { steps: 4 });
  await page.mouse.down(); await page.mouse.up();
  await page.mouse.wheel(0, 240);
  await page.locator(`${V} .as-stage`).focus();
  await page.keyboard.type('rigs');
  await sleep(1800);
  const got = await remoteState();
  check('mouse click reached the app at the right place', got && got.clicks >= 1 && Math.abs(got.x - sw * 0.6) < 40 && Math.abs(got.y - (sh * 0.6 - 130)) < 150, got && JSON.stringify({ x: got.x, y: got.y, clicks: got.clicks, want: [sw * 0.6, sh * 0.6] }));
  check('wheel reached the app', got && got.wheel > 0, got && String(got.wheel));
  check('keyboard reached the app', got && /rigs/.test(got.text), got && `typed text in the app: "${got.text}"`);
  check('the app is animating (frame counter runs)', got && got.frames > 60);
  await shot(page, 'viewer-desktop-input.png');

  // remote resize: change the window size, the remote display follows
  const before = (await hostSessions(host.id))[0];
  await page.setViewportSize({ width: 1200, height: 760 });
  await page.evaluate(() => { const w = document.querySelector('.as-win:not(.win-leave)'); w.style.width = '700px'; w.style.height = '520px'; });
  await sleep(2500);
  const after = (await hostSessions(host.id))[0];
  check('resizing the window resizes the remote display', after && (after.width !== before.width || after.height !== before.height), `${before.width}x${before.height} → ${after?.width}x${after?.height}`);
  check('the stream keeps decoding after the resize', (await stats(page)).fps >= 10);

  // stop from the toolbar ends the session on the host
  await page.locator(`${V} .as-btn.danger`).click();
  await sleep(14000);
  const left = await hostSessions(host.id);
  check('⏹ stops the app: the session is gone on the host', left.length === 0, JSON.stringify(left.map((s) => s.state)));
  check('the viewer says the session ended', /stopped|ended/i.test(await page.$eval(`${V} .as-msg`, (e) => e.textContent).catch(() => '')));
  await ctx.close();

  // ---------------------------------------------------------------- phone: touch
  const m = await newPage({ width: 390, height: 844 }, { isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  await openApp(m.page, host, { phone: true });
  await sleep(6000);
  if (process.env.DEBUG) { await shot(m.page, 'debug-phone.png'); console.log(await m.page.evaluate(() => document.querySelector('.as-win')?.innerText?.slice(0, 400) || document.body.innerText.slice(0, 300))); }
  await m.page.waitForSelector(`${V} .as-canvas:not([hidden])`, { timeout: 40000 });
  await sleep(3500);
  const sess2 = (await hostSessions(host.id))[0];
  check('phone: 1280x720 fixed by default, letterboxed', sess2 && sess2.width === 1280 && sess2.height === 720, sess2 && `${sess2.width}x${sess2.height}`);
  const pb = await m.page.locator(`${V} .as-canvas`).boundingBox();
  const kk = Math.min(pb.width / 1280, pb.height / 720);
  const tx = pb.x + pb.width / 2 + (500 - 640) * kk, ty = pb.y + pb.height / 2 + (420 - 360) * kk; // inside the client's drawing area, below its header
  const c0 = (await remoteState())?.clicks || 0;
  await m.page.touchscreen.tap(tx, ty);
  await sleep(1500);
  const g2 = await remoteState();
  check('phone: a tap drives the pointer (click at the touched point)', g2 && g2.clicks > c0 && Math.abs(g2.x - (500 - 176)) < 40, // the client is centred in the 1280x720 display, its drawing area starts ~176 px in
   g2 && JSON.stringify({ x: g2.x, y: g2.y, clicks: g2.clicks }));
  await m.page.locator(`${V} .as-stats-btn`).tap().catch(async () => { await m.page.locator(`${V} .as-hotspot`).tap(); await sleep(300); await m.page.locator(`${V} .as-stats-btn`).tap(); });
  await sleep(1500);
  check('phone: no sideways overflow', await m.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1));
  await shot(m.page, 'viewer-390x844-stats.png');
  await m.page.locator(`${V} .as-btn.danger`).tap().catch(() => {});
  await sleep(500);
  for (const s of await hostSessions(host.id)) await fetch(`${URL_}api/nodes/${encodeURIComponent(host.id)}/appstream/sessions/${s.id}`, { method: 'DELETE' });
  await m.ctx.close();

  check('no console errors', errors.length === 0, errors.join(' | '));
} catch (e) {
  check('script ran to the end', false, e.stack || e.message);
} finally {
  await browser.close();
  stop();
}
const failed = results.filter((x) => !x).length;
console.log(`\n${results.length - failed}/${results.length} checks passed; screenshots in ${OUT}`);
process.exit(failed ? 1 : 0);
