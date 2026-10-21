#!/usr/bin/env node
// Applications place check (ui/src/files.js @apps over ui/src/finder-model.js, src/app-catalog.js): a throwaway `rigs serve`
// node (scratch RIGS_HOME) plus a peer that never answers (an offline machine), opened in headless Chromium (Playwright
// from RIGS_AUDIT_TOOLS or ~/.cache/rigs-audit) at 1440x900 and 390x844. Checks: GET appstream/catalog answers real apps
// with icons that load (PNG), every machine has an Applications child row (the offline one greyed out), ui_open with the
// place "applications" opens it, search filters, Open is disabled with its reason on a host that cannot stream, and — on a
// Linux-style catalog served through a page route — Open POSTs appstream/sessions and opens the placeholder viewer keyed by
// the session id. Screenshots into --out (default docs/screenshots/app-stream).
//   node scripts/apps-check.js [--out dir]
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
const OUT = path.resolve(opt('out', path.join(ROOT, 'docs/screenshots/app-stream')));
fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((resolve, reject) => { const s = net.createServer(); s.once('error', reject); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }); });
const TOKEN = 'apps-check-' + Math.random().toString(36).slice(2);

const port = await freePort();
const deadPort = await freePort();
const rigsHome = fs.mkdtempSync(path.join(os.tmpdir(), 'rigs-apps-check-'));
const home = path.join(rigsHome, 'home');
fs.mkdirSync(home);
fs.writeFileSync(path.join(rigsHome, 'config.json'), JSON.stringify({ port, name: 'mac-a', openrig: { registerPeers: false } }));
const child = spawn(process.execPath, ['bin/rigs.js', 'serve'], {
  cwd: ROOT, stdio: 'ignore',
  env: { ...process.env, RIGS_HOME: rigsHome, RIGS_PORT: String(port), RIGS_NAME: 'mac-a', RIGS_SSH_DIR: path.join(rigsHome, 'ssh'), RIGS_NO_MIGRATIONS: '1', RIGS_NO_AUTOUPDATE: '1', RIGS_NO_OPENRIG: '1', RIGS_MESH_TOKEN: TOKEN, RIGS_PEERS: `http://127.0.0.1:${deadPort}` },
});
const URL_ = `http://127.0.0.1:${port}/`;
const stop = () => { child.kill(); fs.rmSync(rigsHome, { recursive: true, force: true }); };
let up = false;
for (let i = 0; i < 60 && !up; i++) { await sleep(500); try { up = (await fetch(URL_)).ok; } catch { /* wait */ } }
if (!up) { stop(); throw new Error('rigs serve did not come up'); }

const results = [];
const check = (name, ok, extra = '') => { results.push(!!ok); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${extra ? ' — ' + extra : ''}`); };
const browser = await chromium.launch({ channel: process.env.RIGS_CHROME_CHANNEL || 'chromium', args: ['--no-sandbox'] });
const errors = [];
const W = '.files-win:not(.win-leave)';
const shot = (page, name) => page.screenshot({ path: path.join(OUT, name) });

async function uiOpen(body) {
  let r = null;
  for (let i = 0; i < 40; i++) {
    r = await fetch(URL_ + 'api/mesh/ui/open', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then((x) => x.json());
    if (r.delivered) return r;
    await sleep(500);
  }
  return r;
}
async function newPage(viewport, extra = {}) {
  const ctx = await browser.newContext({ viewport, ...extra });
  await ctx.addInitScript(() => { try { if (!sessionStorage.getItem('fc-init')) { localStorage.setItem('rigs.cloud', 'false'); sessionStorage.setItem('fc-init', '1'); } } catch { /* first load only */ } });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(`${viewport.width}: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error' && !/favicon|Failed to load resource/.test(m.text())) errors.push(`${viewport.width}: ${m.text()}`); });
  await page.goto(URL_);
  await sleep(1500);
  return { ctx, page };
}

try {
  // ---------------------------------------------------------------- API
  const cat = await (await fetch(URL_ + 'api/local/appstream/catalog')).json();
  check('catalog answers apps', cat.items?.length > 0, `${cat.os}: ${cat.items?.length} apps, ${cat.items?.filter((i) => i.icon).length} with an icon`);
  const withIcon = cat.items.find((i) => i.icon);
  const ic = await fetch(URL_ + 'api/local/' + withIcon.icon + '?size=64');
  const buf = Buffer.from(await ic.arrayBuffer());
  check('icon route serves a cached image', ic.ok && /^image\/(png|svg\+xml)$/.test(ic.headers.get('content-type')) && /max-age/.test(ic.headers.get('cache-control')) && !!ic.headers.get('etag') && buf.length > 100, `${withIcon.name}: ${ic.headers.get('content-type')} ${buf.length} bytes`);
  const again = await fetch(URL_ + 'api/local/' + withIcon.icon, { headers: { 'if-none-match': ic.headers.get('etag') } });
  check('icon route honours If-None-Match', again.status === 304);
  check('unknown app icon is a 404', (await fetch(URL_ + 'api/local/appstream/catalog/no-such-app/icon')).status === 404);
  const via = await (await fetch(URL_ + 'api/nodes/self/appstream/catalog')).json().catch(() => null);
  check('reachable through /api/nodes/<id>/appstream/catalog', via?.items?.length === cat.items.length);

  // ---------------------------------------------------------------- desktop
  const { ctx, page } = await newPage({ width: 1440, height: 900 });
  await page.evaluate(() => localStorage.removeItem('rigs.finder'));
  const opened = await uiOpen({ view: 'files', node: 'self', path: 'applications' });
  check('ui_open place "applications" is delivered', opened.delivered > 0 && opened.path === '@apps', JSON.stringify({ path: opened.path, via: opened.via }));
  await page.waitForSelector(`${W} .fd-app`);
  await sleep(1200);
  const tiles = await page.$$eval(`${W} .fd-app .fn`, (els) => els.map((e) => e.textContent));
  check('the Applications place lists the machine\'s apps', tiles.length === cat.items.length, `${tiles.length} tiles`);
  check('crumb and title say Applications', (await page.$eval(`${W} .fd-title`, (e) => e.textContent)) === 'Applications' && (await page.$eval(`${W} .fd-crumb.cur`, (e) => e.textContent)).includes('Applications'));
  const imgs = await page.$$eval(`${W} .fd-app img`, (els) => els.filter((i) => i.complete && i.naturalWidth > 0).length);
  check('icons load in the grid', imgs > 0, `${imgs} loaded`);
  const kids = await page.$$eval(`${W} .fd-side-child`, (els) => els.map((e) => ({ node: e.dataset.appsNode, off: e.classList.contains('off'), on: e.classList.contains('on') })));
  check('every machine has an Applications row, the offline one greyed out', kids.length >= 2 && kids.some((k) => k.off) && kids.some((k) => !k.off && k.on), JSON.stringify(kids));
  check('Applications is highlighted under its machine', (await page.$eval(`${W} .fd-side-item[data-fav="apps"]`, (e) => e.classList.contains('on'))));
  await page.locator(`${W} .fd-seg .tb`, { hasText: '▦' }).click();
  await sleep(300);
  await shot(page, 'applications-desktop.png');

  await page.fill(`${W} .fd-search`, 'calc');
  await sleep(300);
  const found = await page.$$eval(`${W} .fd-app .fn`, (els) => els.map((e) => e.textContent));
  check('search filters apps', found.length > 0 && found.length < tiles.length && found.every((n) => /calc/i.test(n)), found.join(', '));
  await page.fill(`${W} .fd-search`, '');
  await page.locator(`${W} .fd-seg .tb`, { hasText: '☰' }).click();
  await sleep(300);
  check('list view: Name, Kind, Status', (await page.$$eval(`${W} .fd-apps-head .fd-hcell`, (els) => els.map((e) => e.textContent))).join('|') === 'Name|Kind|Status');
  await shot(page, 'applications-list-desktop.png');
  await page.locator(`${W} .fd-seg .tb`, { hasText: '▦' }).click();
  await page.locator(`${W} .fd-app`).first().click();
  await sleep(300);
  const open = page.locator(`${W} .fd-preview .btn.primary`, { hasText: 'Open' });
  const why = await open.getAttribute('title');
  check('preview shows the app with Open disabled and why when the host cannot stream', (await open.isDisabled()) === (cat.host.supported === false), `host=${JSON.stringify(cat.host)} title="${why}"`);
  await shot(page, 'applications-preview-desktop.png');

  // A Linux-style host that can stream: the catalog and the session start come through page routes.
  const linux = { node: 'magix-system', os: 'linux', host: { supported: true }, items: [
    { id: 'ai.storyteller.filmcraft', name: 'FilmCraft', generic: 'Video editor', comment: 'Storyboard to film', icon: null, source: 'desktop', path: '/home/magix/.local/share/applications/ai.storyteller.filmcraft.desktop', categories: ['Video'], terminal: false, streamable: true, running: [] },
    { id: 'org.gnome.Nautilus', name: 'Files', icon: null, source: 'desktop', path: '/usr/share/applications/org.gnome.Nautilus.desktop', categories: ['Utility'], terminal: false, streamable: true, running: [] },
    { id: 'htop', name: 'htop', icon: null, source: 'desktop', path: '/usr/share/applications/htop.desktop', categories: ['System'], terminal: true, streamable: false, why: 'a terminal program, not a window app', running: [] },
  ] };
  let posted = null;
  await ctx.route('**/appstream/catalog', (r) => r.fulfill({ json: linux }));
  await ctx.route('**/appstream/sessions', async (r) => { posted = r.request().postDataJSON(); await r.fulfill({ status: 201, json: { session: { id: 's-test-1', app: { id: posted.app, name: 'FilmCraft' }, state: 'running' } } }); });
  await page.locator(`${W} .fd-side-item[data-fav="home"]`).click();
  await sleep(300);
  await page.locator(`${W} .fd-side-item[data-fav="apps"]`).click();
  await page.waitForSelector(`${W} .fd-app`);
  await sleep(400);
  check('a streamable host shows no limit note and htop is marked not streamable', (await page.locator(`${W} .fd-apps-note`).count()) === 0 && (await page.locator(`${W} .fd-app.app-off`).count()) === 1);
  await page.locator(`${W} .fd-app`, { hasText: 'FilmCraft' }).dblclick();
  await sleep(600);
  check('double-click POSTs appstream/sessions for the app', posted?.app === 'ai.storyteller.filmcraft' && posted.reuse === true, JSON.stringify(posted));
  check('the viewer window opens keyed by the session id', (await page.locator('.win', { hasText: 'Session s-test-1' }).count()) > 0);
  await shot(page, 'applications-open-desktop.png');
  await ctx.close();

  // ---------------------------------------------------------------- phone
  const m = await newPage({ width: 390, height: 844 }, { isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  await uiOpen({ view: 'files', node: 'self', path: 'apps' });
  await m.page.waitForSelector(`${W} .fd-app`);
  await sleep(1200);
  check('phone: no sideways overflow', await m.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1));
  await m.page.locator(`${W} .fd-seg .tb`, { hasText: '▦' }).tap();
  await sleep(300);
  await shot(m.page, 'applications-390x844.png');
  await m.page.locator(`${W} .fd-drawer-btn`).tap();
  await sleep(400);
  await shot(m.page, 'applications-sidebar-390x844.png');
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
