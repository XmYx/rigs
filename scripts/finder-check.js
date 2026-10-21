#!/usr/bin/env node
// Finder-style file browser check (ui/src/files.js over ui/src/finder-model.js). Two throwaway `rigs serve` nodes that
// know each other through a shared mesh token (`mac-a` and `linux-b`, each with its own scratch HOME seeded with
// Desktop/Documents/Downloads) plus a static peer that never answers (an offline rig), opened in headless Chromium
// (Playwright from RIGS_AUDIT_TOOLS or ~/.cache/rigs-audit) at 1440x900 and 390x844. Checks: the sidebar lists every
// machine (offline greyed out, not clickable), clicking the other rig browses its home through /api/nodes/<id>/files,
// icon/list/column views, list sorting by each column, back/forward/enclosing folder and path-bar crumbs, Cmd/Shift
// click and Cmd+A, Enter rename, Cmd+Shift+N, Cmd+Backspace to <RIGS_HOME>/trash, Cmd+Shift+. hidden files, the
// preview toggle and remembered view/width, ui_open on the other machine with a file selected, the phone drawer and
// sheet; no console errors. Screenshots into --out (default <shared>/reports/finder).
//   node scripts/finder-check.js [--out dir]
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
const OUT = path.resolve(opt('out', path.join(os.homedir(), 'RIGS-Shared', 'reports', 'finder')));
fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((resolve, reject) => { const s = net.createServer(); s.once('error', reject); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }); });
const TOKEN = 'finder-check-' + Math.random().toString(36).slice(2);

function seedHome(home, flavour) {
  const w = (rel, s) => { fs.mkdirSync(path.dirname(path.join(home, rel)), { recursive: true }); fs.writeFileSync(path.join(home, rel), s); };
  for (const d of ['Desktop', 'Documents', 'Downloads']) fs.mkdirSync(path.join(home, d), { recursive: true });
  w('Documents/notes.md', `# Notes on ${flavour}\n\nThe Finder-style browser.\n`);
  w('Documents/budget.csv', 'item,cost\nrack,1200\ncables,80\n');
  w('Documents/projects/rigs/README.md', '# RIGS\n');
  w('Documents/projects/rigs/src/main.js', 'console.log("hi");\n');
  w('Documents/projects/jarvis/plan.txt', 'plan\n');
  w('Documents/report.pdf', '%PDF-1.4\n%%EOF\n');
  w('Downloads/big-video.mp4', Buffer.alloc(300000));
  w('Downloads/song.mp3', Buffer.alloc(9000));
  w('Downloads/archive.zip', Buffer.alloc(120));
  w('Desktop/todo.txt', 'buy milk\n');
  w('.secret-config', 'hidden=1\n');
  w('a-small.txt', 'a\n');
  w('b-medium.json', JSON.stringify({ x: 'y'.repeat(4000) }));
  fs.copyFileSync(path.join(ROOT, 'ui/icon-512.png'), path.join(home, 'Desktop', 'logo.png'));
  const t = (rel, daysAgo) => { const at = new Date(Date.now() - daysAgo * 86400000); fs.utimesSync(path.join(home, rel), at, at); };
  t('a-small.txt', 3); t('b-medium.json', 1);
}

const portB = await freePort();
const deadPort = await freePort();
// B first on a known port, then A with B and a dead peer.
const B = await startNodeOn('linux-b', portB, []);
const A = await startNodeOn('mac-a', await freePort(), [`http://127.0.0.1:${portB}`, `http://127.0.0.1:${deadPort}`]);
async function startNodeOn(name, port, peers) {
  const rigsHome = fs.mkdtempSync(path.join(os.tmpdir(), `rigs-finder-${name}-`));
  const home = path.join(rigsHome, 'home');
  fs.mkdirSync(home);
  seedHome(home, name);
  fs.writeFileSync(path.join(rigsHome, 'config.json'), JSON.stringify({ port, name, openrig: { registerPeers: false } }));
  const env = {
    ...process.env, HOME: home, USERPROFILE: home, RIGS_HOME: rigsHome, RIGS_PORT: String(port), RIGS_NAME: name, RIGS_SSH_DIR: path.join(rigsHome, 'ssh'),
    RIGS_NO_MIGRATIONS: '1', RIGS_NO_AUTOUPDATE: '1', RIGS_NO_OPENRIG: '1', RIGS_MESH_TOKEN: TOKEN, RIGS_PEERS: peers.join(','),
  };
  const child = spawn(process.execPath, ['bin/rigs.js', 'serve'], { cwd: ROOT, stdio: 'ignore', env });
  const url = `http://127.0.0.1:${port}/`;
  for (let i = 0; i < 60; i++) {
    await sleep(500);
    try { if ((await fetch(url)).ok) return { name, url, port, home, rigsHome, stop: () => { child.kill(); fs.rmSync(rigsHome, { recursive: true, force: true }); } }; } catch { /* wait */ }
  }
  child.kill();
  throw new Error(`rigs serve ${name} did not come up`);
}

const results = [];
const check = (name, ok, extra = '') => { results.push(!!ok); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${extra ? ' — ' + extra : ''}`); };
const browser = await chromium.launch({ channel: process.env.RIGS_CHROME_CHANNEL || 'chromium', args: ['--no-sandbox'] });
const errors = [];
const W = '.files-win:not(.win-leave)';
const names = (page, sel = '.file-row .fn') => page.$$eval(`${W} .fd-content ${sel}`, (els) => els.map((e) => e.textContent));
const row = (page, name) => page.locator(`${W} .fd-content .file-row`, { has: page.locator('.fn', { hasText: new RegExp(`^${name.replace(/[.()]/g, '\\$&')}$`) }) }).first();
const pathNow = (page) => page.$eval(`${W} .path-input`, (e) => e.value);
const shot = (page, name) => page.screenshot({ path: path.join(OUT, name) });
const mod = process.platform === 'darwin' ? 'Meta' : 'Control';

async function waitMesh(url, n) {
  for (let i = 0; i < 60; i++) {
    try { const s = await (await fetch(url + 'api/mesh/snapshot')).json(); if (s.filter((e) => e.node.online && e.node.rigs).length >= n) return s; } catch { /* wait */ }
    await sleep(500);
  }
  throw new Error('mesh did not form');
}
/** ui_open as an agent sends it; retried until the page's socket is up and takes it. */
async function uiOpen(body) {
  let r = null;
  for (let i = 0; i < 40; i++) {
    r = await fetch(A.url + 'api/mesh/ui/open', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then((x) => x.json());
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
  page.on('dialog', (d) => d.accept());
  await page.goto(A.url);
  await sleep(1500);
  return { ctx, page };
}

try {
  const snap = await waitMesh(A.url, 2);
  const nodeB = snap.find((e) => e.node.name === 'linux-b').node;
  // ---------------------------------------------------------------- desktop
  const { ctx, page } = await newPage({ width: 1440, height: 900 });
  await page.evaluate(() => localStorage.removeItem('rigs.finder'));
  const first = await uiOpen({ view: 'files', node: 'self', path: '~' });
  if (process.env.DEBUG) console.log('ui_open', JSON.stringify(first));
  await page.waitForSelector(`${W} .fd-content .file-row`);
  await sleep(400);
  check('opens at home', (await pathNow(page)) === A.home, await pathNow(page));

  const side = await page.$$eval(`${W} .fd-side-item.rig`, (els) => els.map((e) => ({ name: e.querySelector('.fd-si-label').textContent, off: e.classList.contains('off'), on: e.classList.contains('on') })));
  check('sidebar lists every machine the mesh reports', side.length === snap.length && ['mac-a', 'linux-b'].every((n) => side.some((s) => s.name === n)), JSON.stringify(side.map((s) => s.name)));
  check('this machine first and current', side[0].name === 'mac-a' && side[0].on);
  const offline = side.filter((s) => s.off);
  check('an offline rig is greyed out', offline.length >= 1, JSON.stringify(offline.map((s) => s.name)));
  const favs = await page.$$eval(`${W} .fd-side-item[data-fav]`, (els) => els.map((e) => e.textContent.trim()));
  check('favourites: Home, Desktop, Documents, Downloads, RIGS Shared', favs.join('|').includes('Home') && favs.length === 5, favs.join(', '));
  check('Home is highlighted', await page.$eval(`${W} .fd-side-item[data-fav="home"]`, (e) => e.classList.contains('on')));

  // list view + sorting
  await page.locator(`${W} .fd-seg .tb`, { hasText: '☰' }).click();
  check('list view has Name / Date Modified / Size / Kind headers', (await page.$$eval(`${W} .fd-hcell`, (els) => els.map((e) => e.textContent.replace(/[▲▼]/g, '')))).join('|') === 'Name|Date Modified|Size|Kind');
  const byName = await names(page);
  check('sorted by name, folders on top', byName.slice(0, 3).join() === 'Desktop,Documents,Downloads' && byName.indexOf('a-small.txt') < byName.indexOf('b-medium.json'), byName.join(','));
  await page.locator(`${W} .fd-hcell.c-name`).click();
  const nameDesc = await names(page);
  check('Name sorts descending on a second click', nameDesc[0] === 'Downloads' && nameDesc.at(-1) === 'a-small.txt', nameDesc.join(','));
  await page.locator(`${W} .fd-hcell.c-size`).click();
  const bySize = (await names(page)).slice(3);
  check('Size sorts largest first', bySize[0] === 'b-medium.json' && bySize.at(-1) === 'a-small.txt', bySize.join(','));
  await page.locator(`${W} .fd-hcell.c-mtime`).click();
  const byDate = (await names(page)).slice(3);
  check('Date Modified sorts newest first', byDate.indexOf('b-medium.json') < byDate.indexOf('a-small.txt'), byDate.join(','));
  await page.locator(`${W} .fd-hcell.c-kind`).click();
  const byKind = (await names(page)).slice(3);
  check('Kind sorts alphabetically by kind', byKind[0] === 'b-medium.json' && byKind.at(-1) === 'a-small.txt', byKind.join(',')); // JSON < Plain Text
  await page.locator(`${W} .fd-hcell.c-name`).click();

  // navigation: double-click, back, forward, enclosing folder, crumbs
  await row(page, 'Documents').dblclick();
  await page.waitForFunction((p) => document.querySelector('.files-win .path-input')?.value === p, path.join(A.home, 'Documents'));
  await row(page, 'projects').dblclick();
  await page.waitForFunction((p) => document.querySelector('.files-win .path-input')?.value === p, path.join(A.home, 'Documents', 'projects'));
  await page.locator(`${W} .fd-nav .tb`).first().click();
  await page.waitForFunction((p) => document.querySelector('.files-win .path-input')?.value === p, path.join(A.home, 'Documents'));
  check('Back goes to the previous folder', true);
  await page.locator(`${W} .fd-nav .tb`).nth(1).click();
  await page.waitForFunction((p) => document.querySelector('.files-win .path-input')?.value === p, path.join(A.home, 'Documents', 'projects'));
  check('Forward goes forward again', true);
  await page.locator(`${W} .fd-content`).focus();
  await page.keyboard.press(`${mod}+ArrowUp`);
  await page.waitForFunction((p) => document.querySelector('.files-win .path-input')?.value === p, path.join(A.home, 'Documents'));
  check('⌘↑ opens the enclosing folder with the folder selected', (await page.$eval(`${W} .file-row.sel .fn`, (e) => e.textContent)) === 'projects');
  await page.keyboard.press(`${mod}+BracketLeft`);
  await page.waitForFunction((p) => document.querySelector('.files-win .path-input')?.value === p, path.join(A.home, 'Documents', 'projects'));
  check('⌘[ goes back', true);
  const crumbs = await page.$$eval(`${W} .fd-crumb`, (els) => els.map((e) => e.textContent.trim()));
  check('path bar shows the machine and every folder', crumbs[0].includes('mac-a') && crumbs.at(-1).includes('projects'), crumbs.join(' › '));
  await page.locator(`${W} .fd-crumb`, { hasText: 'Documents' }).click();
  await page.waitForFunction((p) => document.querySelector('.files-win .path-input')?.value === p, path.join(A.home, 'Documents'));
  check('a crumb navigates there', true);

  // selection
  await row(page, 'budget.csv').click();
  await row(page, 'report.pdf').click({ modifiers: ['Shift'] });
  const range = await names(page, '.file-row.sel .fn');
  check('Shift-click selects a range', range.length >= 3 && range[0] === 'budget.csv' && range.at(-1) === 'report.pdf', range.join(','));
  await row(page, 'notes.md').click({ modifiers: [mod] });
  check('⌘-click removes one from the selection', !(await names(page, '.file-row.sel .fn')).includes('notes.md'));
  await page.keyboard.press(`${mod}+a`);
  const all = await names(page, '.file-row.sel .fn');
  check('⌘A selects everything', all.length === (await names(page)).length, String(all.length));
  check('the status line counts the selection', /of \d+ items selected/.test(await page.$eval(`${W} .fd-status`, (e) => e.textContent)));
  await row(page, 'notes.md').click();
  await page.keyboard.press('ArrowUp');
  check('arrow keys move the selection', (await names(page, '.file-row.sel .fn')).join() === 'budget.csv');
  await page.keyboard.press('Shift+ArrowDown');
  check('Shift+arrow extends it', (await names(page, '.file-row.sel .fn')).join() === 'budget.csv,notes.md');
  await shot(page, 'desktop-list.png');

  // preview pane
  await row(page, 'notes.md').click();
  await page.waitForSelector(`${W} .fd-preview .pv-md`); // Markdown is rendered now (finder-preview.js)
  check('the preview pane shows the selected file', (await page.$eval(`${W} .fd-preview .pv-title`, (e) => e.textContent)).includes('notes.md'));
  await page.keyboard.press(`${mod}+Shift+KeyP`);
  check('⌘⇧P hides the preview', await page.$eval(`${W} .finder`, (e) => e.classList.contains('no-preview')));
  await page.keyboard.press(`${mod}+Shift+KeyP`);
  check('⌘⇧P shows it again', !(await page.$eval(`${W} .finder`, (e) => e.classList.contains('no-preview'))));
  const split = await page.locator(`${W} .fd-split-r`).boundingBox();
  await page.mouse.move(split.x + 2, split.y + 100);
  await page.mouse.down();
  await page.mouse.move(split.x - 80, split.y + 100, { steps: 4 });
  await page.mouse.up();
  const prefs = await page.evaluate(() => JSON.parse(localStorage.getItem('rigs.finder') || '{}'));
  check('dragging the separator resizes the preview and remembers it', prefs.previewW >= 360, String(prefs.previewW));

  // rename (Enter), new folder (⌘⇧N), trash (⌘⌫)
  await row(page, 'budget.csv').click();
  await page.keyboard.press('Enter');
  await page.waitForSelector(`${W} .fd-rename`);
  await page.keyboard.press(`${mod}+a`);
  await page.keyboard.type('costs.csv');
  await page.keyboard.press('Enter');
  await row(page, 'costs.csv').waitFor();
  check('Enter renames in place', fs.existsSync(path.join(A.home, 'Documents', 'costs.csv')) && !fs.existsSync(path.join(A.home, 'Documents', 'budget.csv')));
  await page.keyboard.press(`${mod}+Shift+KeyN`);
  await page.waitForSelector(`${W} .fd-rename`);
  await page.keyboard.type('new stuff');
  await page.keyboard.press('Enter');
  await row(page, 'new stuff').waitFor();
  check('⌘⇧N makes a folder and lets you name it', fs.statSync(path.join(A.home, 'Documents', 'new stuff')).isDirectory());
  await row(page, 'costs.csv').click();
  await row(page, 'new stuff').click({ modifiers: [mod] });
  await page.keyboard.press(`${mod}+Backspace`);
  await page.waitForFunction(() => ![...document.querySelectorAll('.files-win .fd-content .fn')].some((e) => e.textContent === 'costs.csv'));
  const trash = fs.readdirSync(path.join(A.rigsHome, 'trash'));
  check('⌘⌫ moves the selection to ~/.rigs/trash', trash.some((n) => n.endsWith('-costs.csv')) && trash.some((n) => n.endsWith('-new stuff')), trash.join(','));

  // hidden files
  await page.locator(`${W} .fd-side-item[data-fav="home"]`).click();
  await page.waitForFunction((p) => document.querySelector('.files-win .path-input')?.value === p, A.home);
  check('hidden files are hidden', !(await names(page)).includes('.secret-config'));
  await page.locator(`${W} .fd-content`).focus();
  await page.keyboard.press(`${mod}+Shift+Period`);
  await row(page, '.secret-config').waitFor();
  check('⌘⇧. shows hidden files', true);
  await page.keyboard.press(`${mod}+Shift+Period`);
  await page.waitForFunction(() => ![...document.querySelectorAll('.files-win .fd-content .fn')].some((e) => e.textContent === '.secret-config'));

  // search
  await page.keyboard.press(`${mod}+f`);
  await page.keyboard.type('json');
  await sleep(150);
  check('search filters the folder', (await names(page)).join() === 'b-medium.json');
  await page.keyboard.press('Escape');
  check('Esc clears the search and keeps the window', (await names(page)).length > 3 && (await page.$$(W)).length === 1);

  // icon view
  await page.keyboard.press(`${mod}+1`);
  await page.waitForSelector(`${W} .fd-tile`);
  await page.locator(`${W} .fd-side-item[data-fav="desktop"]`).click();
  await row(page, 'logo.png').waitFor();
  await row(page, 'logo.png').click();
  await sleep(300);
  check('icon view shows tiles', (await page.$$(`${W} .fd-tile`)).length === 2);
  await shot(page, 'desktop-icon.png');

  // column view
  await page.keyboard.press(`${mod}+3`);
  await page.locator(`${W} .fd-side-item[data-fav="documents"]`).click();
  await row(page, 'projects').waitFor();
  await row(page, 'projects').click();
  await page.waitForFunction((p) => document.querySelector('.files-win .path-input')?.value === p, path.join(A.home, 'Documents', 'projects'));
  await row(page, 'rigs').click();
  await page.waitForFunction((p) => document.querySelector('.files-win .path-input')?.value === p, path.join(A.home, 'Documents', 'projects', 'rigs'));
  await row(page, 'README.md').click();
  await sleep(500);
  const cols = await page.$$eval(`${W} .fd-col`, (els) => els.map((e) => e.dataset.path));
  check('column view: one column per folder from home down', cols.length === 4 && cols[0] === A.home && cols.at(-1).endsWith('rigs'), cols.join(' | '));
  check('column view: the path is highlighted in each column', (await page.$$(`${W} .fd-crow.on-path`)).length === 3);
  await shot(page, 'desktop-column.png');
  await page.keyboard.press('ArrowLeft');
  await page.waitForFunction((p) => document.querySelector('.files-win .path-input')?.value === p, path.join(A.home, 'Documents', 'projects'));
  check('column view: ← goes to the enclosing folder', true);

  // the other rig
  await page.locator(`${W} .fd-side-item.rig`, { hasText: 'linux-b' }).click();
  await page.waitForFunction((p) => document.querySelector('.files-win .path-input')?.value === p, B.home);
  check('clicking another rig browses its home through /api/nodes/<id>/files', (await page.$eval(`${W} .fd-side-item.rig.on .fd-si-label`, (e) => e.textContent)) === 'linux-b');
  check('the window title names the rig', /linux-b/.test(await page.$eval(`${W} .win-title-text`, (e) => e.textContent)));
  await page.locator(`${W} .fd-side-item.rig.off`).first().click({ force: true });
  await sleep(300);
  check('an offline rig is not clickable', (await pathNow(page)) === B.home);
  await page.keyboard.press(`${mod}+2`);
  await shot(page, 'desktop-rig-b-list.png');
  await page.locator(`${W} .fd-nav .tb`).first().click();
  await page.waitForFunction((p) => document.querySelector('.files-win .path-input')?.value === p, path.join(A.home, 'Documents', 'projects'));
  check('Back crosses back to the first rig', (await page.$eval(`${W} .fd-side-item.rig.on .fd-si-label`, (e) => e.textContent)) === 'mac-a');

  // ui_open on the other machine with a file selected: the window now showing that machine navigates there
  await page.locator(`${W} .fd-nav .tb`).nth(1).click();
  await page.waitForFunction((p) => document.querySelector('.files-win .path-input')?.value === p, B.home);
  const r = await uiOpen({ view: 'files', node: 'linux-b', path: path.join(B.home, 'Documents', 'notes.md') });
  await page.waitForFunction((p) => document.querySelector('.files-win .path-input')?.value === p, path.join(B.home, 'Documents'));
  await sleep(400);
  check('ui_open opens the other machine at the folder with the file selected', r.ok !== false && (await names(page, '.file-row.sel .fn')).join() === 'notes.md' && (await page.$$(W)).length === 1);
  check('…and previews it', (await page.$eval(`${W} .fd-preview .pv-title`, (e) => e.textContent)).includes('notes.md'));
  await shot(page, 'desktop-ui-open-rig-b.png');

  // the view is remembered across a reload
  await page.reload();
  await sleep(1500);
  const kept = await page.evaluate(() => JSON.parse(localStorage.getItem('rigs.finder') || '{}'));
  check('view and widths are remembered', kept.view === 'list' && kept.previewW >= 360, JSON.stringify(kept));
  await ctx.close();

  // ---------------------------------------------------------------- phone
  const { ctx: pctx, page: ph } = await newPage({ width: 390, height: 844 }, { isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  await uiOpen({ view: 'files', node: 'self', path: path.join(A.home, 'Downloads') });
  await ph.waitForSelector(`${W} .fd-content .file-row`);
  await sleep(500);
  const fw = await ph.$eval(W, (e) => e.getBoundingClientRect().width);
  check('phone: the window is full width, one column', fw >= 388 && (await ph.$eval(`${W} .fd-side`, (e) => e.getBoundingClientRect().right <= 0)));
  await ph.keyboard.press(`${mod}+2`).catch(() => {});
  await shot(ph, 'phone-list.png');
  await ph.locator(`${W} .fd-drawer-btn`).tap();
  await sleep(400);
  check('phone: ☰ opens the sidebar drawer', await ph.$eval(`${W} .fd-side`, (e) => e.getBoundingClientRect().left >= 0));
  await shot(ph, 'phone-drawer.png');
  await ph.locator(`${W} .fd-side-item[data-fav="documents"]`).tap();
  await ph.waitForFunction((p) => document.querySelector('.files-win .path-input')?.value === p, path.join(A.home, 'Documents'));
  check('phone: choosing a place closes the drawer', !(await ph.$eval(`${W} .finder`, (e) => e.classList.contains('drawer-open'))));
  await row(ph, 'notes.md').tap();
  await sleep(500);
  check('phone: tapping a file brings up the preview sheet', await ph.$eval(`${W} .finder`, (e) => e.classList.contains('sheet-open')));
  await shot(ph, 'phone-sheet.png');
  await ph.locator(`${W} .fd-sheet-x`).tap();
  await sleep(300);
  await ph.locator(`${W} .fd-seg .tb`).first().tap();
  await sleep(300);
  await shot(ph, 'phone-icon.png');
  await ph.locator(`${W} .fd-seg .tb`).nth(2).tap();
  await row(ph, 'projects').tap();
  await ph.waitForFunction((p) => document.querySelector('.files-win .path-input')?.value === p, path.join(A.home, 'Documents', 'projects'));
  await sleep(300);
  check('phone: column view shows one column', (await ph.$$eval(`${W} .fd-col`, (els) => els.filter((e) => getComputedStyle(e).display !== 'none').length)) === 1);
  await shot(ph, 'phone-column.png');
  await pctx.close();
  void nodeB;
} catch (e) {
  check('run', false, e.stack);
  for (const c of browser.contexts()) for (const pg of c.pages()) await pg.screenshot({ path: path.join(OUT, 'failure.png') }).catch(() => {});
} finally {
  await browser.close();
  A.stop();
  B.stop();
}
check('no console errors', !errors.length, errors.join(' | '));
const failed = results.filter((x) => !x).length;
console.log(`\n${results.length - failed}/${results.length} passed · screenshots in ${OUT}`);
process.exit(failed ? 1 : 0);
