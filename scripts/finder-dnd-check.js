#!/usr/bin/env node
// Drag and drop in the Finder-style file browser (ui/src/files.js, src/file-transfer.js). Two throwaway `rigs serve`
// nodes (`mac-a`, `linux-b`) that know each other, opened in headless Chromium at 1440x900 and 390x844. Checks: drag a
// row onto a folder moves it, Option-drag copies (copy badge class), a multi-item drag, drop on a sidebar place and on a
// path-bar crumb, spring-loaded folders, dropping on another rig in the sidebar copies it there (the destination pulls
// it from the source: 40 MB file, sha256 equal), drops into a second window on another rig, files dropped from the
// desktop upload with a progress row, the Keep both / Replace / Skip dialog (replace -> <RIGS_HOME>/trash), Cmd+Z
// undoing a move and a rename, '..' refused by the API. Screenshots into --out (default <shared>/reports/finder-dnd).
//   node scripts/finder-dnd-check.js [--out dir]
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
const OUT = path.resolve(opt('out', path.join(os.homedir(), 'RIGS-Shared', 'reports', 'finder-dnd')));
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
const portA = await freePort();
const B = await startNodeOn('linux-b', portB, [`http://127.0.0.1:${portA}`]); // every machine knows every other, as in the real mesh
const A = await startNodeOn('mac-a', portA, [`http://127.0.0.1:${portB}`, `http://127.0.0.1:${deadPort}`]);
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

import crypto from 'node:crypto';
const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const rowSel = (n) => `${W} .fd-content .file-row:has(.fn:text-is("${n}"))`;
const bin = (p, mb) => { fs.mkdirSync(path.dirname(p), { recursive: true }); const b = crypto.randomBytes(1024 * 1024); const fd = fs.openSync(p, 'w'); for (let i = 0; i < mb; i++) fs.writeSync(fd, b); fs.closeSync(fd); };
const cwdIs = (page, p) => page.waitForFunction((x) => document.querySelector('.files-win .path-input')?.value === x, p, { timeout: 8000 }).then(() => true, () => false);
const post = (node, sub, body) => fetch(`${node.url}api/local/files/${sub}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then(async (r) => ({ status: r.status, body: await r.json() }));
const until = async (fn, ms = 8000) => { for (let t = 0; t < ms; t += 200) { if (fn()) return true; await sleep(200); } return !!fn(); };
const gone = (p) => !fs.existsSync(p);

try {
  await waitMesh(A.url, 2);
  await waitMesh(B.url, 2); // the destination must know the source to pull from it
  const docs = path.join(A.home, 'Documents');
  const dl = path.join(A.home, 'Downloads');
  for (const n of ['one.txt', 'two.txt', 'three.txt']) fs.writeFileSync(path.join(A.home, 'Desktop', n), `content of ${n}\n`);
  fs.mkdirSync(path.join(docs, 'target'), { recursive: true });
  fs.mkdirSync(path.join(docs, 'target', 'inner'), { recursive: true });
  bin(path.join(dl, 'payload.bin'), 40);
  const payloadSha = sha(path.join(dl, 'payload.bin'));

  const { page } = await newPage({ width: 1440, height: 900 });
  await page.evaluate(() => localStorage.removeItem('rigs.finder'));
  await uiOpen({ view: 'files', node: 'self', path: path.join(A.home, 'Desktop') });
  await page.waitForSelector(`${W} .fd-content .file-row`);
  await page.locator(`${W} .fd-seg .tb`, { hasText: '☰' }).click();
  await sleep(300);

  // ---- move onto a folder (list view)
  const desk = path.join(A.home, 'Desktop');
  fs.mkdirSync(path.join(desk, 'folder'), { recursive: true });
  await uiOpen({ view: 'files', node: 'self', path: desk }); // reopen so the new folder is listed
  await page.waitForSelector(rowSel('folder'));

  await page.locator(rowSel('one.txt')).dragTo(page.locator(rowSel('folder')));
  await until(() => fs.existsSync(path.join(desk, 'folder', 'one.txt')));
  check('drag a file onto a folder moves it', fs.existsSync(path.join(desk, 'folder', 'one.txt')) && gone(path.join(desk, 'one.txt')));
  for (let i = 0; i < 25 && (await names(page)).includes('one.txt'); i++) await sleep(200);
  check('the moved file left the list', !(await names(page)).includes('one.txt'));
  await sleep(500);

  // ---- Option copies, and the drop target shows the copy badge
  await page.keyboard.down('Alt');
  const src = await page.locator(rowSel('two.txt')).boundingBox();
  const dst = await page.locator(rowSel('folder')).boundingBox();
  await page.mouse.move(src.x + 20, src.y + 8);
  await page.mouse.down();
  await page.mouse.move(src.x + 40, src.y + 12, { steps: 4 });
  await page.mouse.move(dst.x + 40, dst.y + 8, { steps: 8 });
  await sleep(200);
  const hover = await page.$eval(`${W} .drop-target`, (e) => ({ copy: e.classList.contains('copy'), name: e.querySelector('.fn')?.textContent })).catch(() => null);
  check('hovering a folder with Option held highlights it with the copy badge', hover && hover.copy && hover.name === 'folder', JSON.stringify(hover));
  await shot(page, 'desktop-drag-hover-copy.png');
  await page.mouse.up();
  await page.keyboard.up('Alt');
  await until(() => fs.existsSync(path.join(desk, 'folder', 'two.txt')));
  check('Option-drag copies: the source stays, the copy is in the folder', fs.existsSync(path.join(desk, 'two.txt')) && fs.existsSync(path.join(desk, 'folder', 'two.txt')));

  // ---- plain drag shows the move highlight (no copy badge)
  await page.waitForSelector(rowSel('three.txt'), { timeout: 5000 }).catch(async () => console.log('DEBUG rows', await names(page), 'disk', fs.readdirSync(desk), await pathNow(page)));
  {
    const s2 = await page.locator(rowSel('three.txt')).boundingBox();
    const d2 = await page.locator(rowSel('folder')).boundingBox();
    await page.mouse.move(s2.x + 20, s2.y + 8);
    await page.mouse.down();
    await page.mouse.move(s2.x + 40, s2.y + 12, { steps: 4 });
    await page.mouse.move(d2.x + 40, d2.y + 8, { steps: 8 });
    await sleep(200);
    const mv = await page.$eval(`${W} .drop-target`, (e) => e.classList.contains('copy')).catch(() => null);
    check('a plain drag highlights the folder without the copy badge', mv === false, String(mv));
    await shot(page, 'desktop-drag-hover-move.png');
    // spring-loaded: keep hovering and the folder opens
    await sleep(1100);
    check('spring-loaded folder opens while hovering', await cwdIs(page, path.join(desk, 'folder')), await pathNow(page));
    await page.mouse.up();
    await sleep(400);
  }

  // ---- multi-item drag: select two, drag one onto a crumb (the Desktop's parent = home)
  await uiOpen({ view: 'files', node: 'self', path: path.join(desk, 'folder') });
  await sleep(800);
  await row(page, 'one.txt').click();
  await row(page, 'two.txt').click({ modifiers: [mod] });
  fs.rmSync(path.join(desk, 'two.txt')); // (the Option-copy test left one there: a move onto it would ask)
  const crumb = page.locator(`${W} .fd-crumb`, { hasText: 'Desktop' });
  await row(page, 'one.txt').dragTo(crumb);
  await sleep(2500);
  check('multi-item drag onto a path-bar crumb moves both', fs.existsSync(path.join(desk, 'one.txt')) && fs.existsSync(path.join(desk, 'two.txt')) && !fs.existsSync(path.join(desk, 'folder', 'one.txt')), fs.readdirSync(desk).join(','));

  // ---- Cmd+Z puts the move back
  await page.locator(`${W} .fd-content`).focus();
  await page.keyboard.press(`${mod}+z`);
  await sleep(2500);
  check('⌘Z undoes the last move', fs.existsSync(path.join(desk, 'folder', 'one.txt')) && fs.existsSync(path.join(desk, 'folder', 'two.txt')) && gone(path.join(desk, 'one.txt')));

  // ---- sidebar place: drag a file onto "Documents"
  await uiOpen({ view: 'files', node: 'self', path: desk });
  await sleep(900);
  await page.locator(rowSel('three.txt')).dragTo(page.locator(`${W} .fd-side-item[data-fav="documents"]`));
  await sleep(2500);
  check('drop on a sidebar favourite moves it there', fs.existsSync(path.join(docs, 'three.txt')) && gone(path.join(desk, 'three.txt')));

  // ---- rename + undo
  await page.locator(rowSel('folder')).click();
  await page.keyboard.press('Enter');
  await page.keyboard.press(`${mod}+a`);
  await page.keyboard.type('folder-renamed');
  await page.keyboard.press('Enter');
  await sleep(2500);
  check('rename works', fs.existsSync(path.join(desk, 'folder-renamed')));
  await page.locator(`${W} .fd-content`).focus();
  await page.keyboard.press(`${mod}+z`);
  await sleep(2500);
  check('⌘Z undoes a rename', fs.existsSync(path.join(desk, 'folder')) && gone(path.join(desk, 'folder-renamed')));

  // ---- clash dialog: move a file onto a folder that has one of that name
  fs.writeFileSync(path.join(docs, 'target', 'three.txt'), 'OLD CONTENT');
  await uiOpen({ view: 'files', node: 'self', path: docs });
  await sleep(900);
  await page.locator(rowSel('three.txt')).dragTo(page.locator(rowSel('target')));
  await page.waitForSelector(`${W} .fd-dialog`);
  const dlg = await page.$eval(`${W} .fd-dialog`, (e) => e.textContent);
  check('a name clash asks Keep both / Replace / Skip', /already exists/.test(dlg) && ['Keep both', 'Replace', 'Skip'].every((b) => dlg.includes(b)), dlg.slice(0, 120));
  check('nothing was overwritten while the dialog is up', fs.readFileSync(path.join(docs, 'target', 'three.txt'), 'utf8') === 'OLD CONTENT' && fs.existsSync(path.join(docs, 'three.txt')));
  await shot(page, 'desktop-clash-dialog.png');
  await page.locator(`${W} .fd-dialog button[data-clash="skip"]`).click();
  await sleep(2500);
  check('Skip leaves both files where they were', fs.readFileSync(path.join(docs, 'target', 'three.txt'), 'utf8') === 'OLD CONTENT' && fs.existsSync(path.join(docs, 'three.txt')));
  await page.locator(rowSel('three.txt')).dragTo(page.locator(rowSel('target')));
  await page.waitForSelector(`${W} .fd-dialog`);
  await page.locator(`${W} .fd-dialog button[data-clash="keep"]`).click();
  await sleep(2500);
  check('Keep both stores the newcomer as "three (2).txt"', fs.existsSync(path.join(docs, 'target', 'three (2).txt')) && fs.readFileSync(path.join(docs, 'target', 'three.txt'), 'utf8') === 'OLD CONTENT');
  fs.writeFileSync(path.join(docs, 'again.txt'), 'NEW CONTENT');
  fs.writeFileSync(path.join(docs, 'target', 'again.txt'), 'OLD AGAIN');
  await uiOpen({ view: 'files', node: 'self', path: docs });
  await sleep(900);
  await page.locator(rowSel('again.txt')).dragTo(page.locator(rowSel('target')));
  await page.waitForSelector(`${W} .fd-dialog`);
  await page.locator(`${W} .fd-dialog button[data-clash="replace"]`).click();
  await sleep(900);
  const trash = path.join(A.rigsHome, 'trash');
  const trashed = fs.existsSync(trash) ? fs.readdirSync(trash).filter((x) => x.endsWith('-again.txt')) : [];
  check('Replace puts the new file in place', fs.readFileSync(path.join(docs, 'target', 'again.txt'), 'utf8') === 'NEW CONTENT');
  check('…and the replaced file lands in <RIGS_HOME>/trash', trashed.length === 1 && fs.readFileSync(path.join(trash, trashed[0]), 'utf8') === 'OLD AGAIN', trashed.join());

  // ---- OS files dropped from the desktop upload into the open folder (with a progress row)
  await uiOpen({ view: 'files', node: 'self', path: path.join(docs, 'target', 'inner') });
  await sleep(900);
  await page.evaluate(() => {
    const dt = new DataTransfer();
    dt.items.add(new File(['hello from the desktop'], 'from-os.txt', { type: 'text/plain' }));
    dt.items.add(new File([new Uint8Array(6 * 1024 * 1024)], 'os-big.bin'));
    const t = document.querySelector('.files-win .fd-content');
    for (const type of ['dragenter', 'dragover', 'drop']) t.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt }));
  });
  for (let i = 0; i < 40 && !(fs.existsSync(path.join(docs, 'target', 'inner', 'os-big.bin')) && fs.statSync(path.join(docs, 'target', 'inner', 'os-big.bin')).size === 6 * 1024 * 1024); i++) await sleep(250);
  const inner = path.join(docs, 'target', 'inner');
  check('files dropped from the OS upload into the open folder', fs.existsSync(path.join(inner, 'from-os.txt')) && fs.statSync(path.join(inner, 'os-big.bin')).size === 6 * 1024 * 1024);
  await page.evaluate(() => {
    const dt = new DataTransfer();
    dt.items.add(new File(['second version'], 'from-os.txt'));
    const t = document.querySelector('.files-win .fd-content');
    for (const type of ['dragenter', 'dragover', 'drop']) t.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt }));
  });
  await page.waitForSelector(`${W} .fd-dialog`);
  check('an OS file with an existing name asks first (and the old one is untouched)', fs.readFileSync(path.join(inner, 'from-os.txt'), 'utf8') === 'hello from the desktop');
  await page.locator(`${W} .fd-dialog button[data-clash="replace"]`).click();
  await sleep(2500);
  check('Replace uploads over it', fs.readFileSync(path.join(inner, 'from-os.txt'), 'utf8') === 'second version');
  check('…and the previous upload went to the trash', fs.readdirSync(trash).some((x) => x.endsWith('-from-os.txt')));

  // ---- across rigs: drop on linux-b in the sidebar (the destination streams it from this machine)
  await uiOpen({ view: 'files', node: 'self', path: dl });
  await sleep(900);
  await page.locator(rowSel('payload.bin')).dragTo(page.locator(`${W} .fd-side-item.rig[data-node]`, { hasText: 'linux-b' }));
  const landed = path.join(B.home, 'payload.bin');
  for (let i = 0; i < 120 && !(fs.existsSync(landed) && fs.statSync(landed).size === 40 * 1024 * 1024); i++) await sleep(500);
  check('dropping on another rig in the sidebar copies it there', fs.existsSync(landed) && fs.statSync(landed).size === 40 * 1024 * 1024);
  check('…byte for byte (sha256) and the source stays', fs.existsSync(landed) && sha(landed) === payloadSha && fs.existsSync(path.join(dl, 'payload.bin')));
  check('…the file did not go through the browser (page heap stays small)', (await page.evaluate(() => performance.memory?.usedJSHeapSize || 0)) < 60 * 1024 * 1024);
  await shot(page, 'desktop-after-cross-rig.png');

  // ---- a second window on the other rig: drop a row from window 1 into it
  await uiOpen({ view: 'files', node: 'linux-b', path: path.join(B.home, 'Documents') });
  await page.waitForFunction(() => document.querySelectorAll('.files-win:not(.win-leave)').length >= 2, null, { timeout: 8000 }).catch(() => {});
  await sleep(1200);
  const wins = await page.$$('.files-win:not(.win-leave)');
  check('two file windows are open (one per rig)', wins.length === 2, String(wins.length));
  if (wins.length === 2) {
    await page.evaluate(() => { const [a, b] = document.querySelectorAll('.files-win:not(.win-leave)'); for (const [el, left] of [[a, 10], [b, 740]]) Object.assign(el.style, { left: `${left}px`, top: '40px', width: '680px', height: '520px' }); });
    await sleep(400);
    const winA = page.locator('.files-win:not(.win-leave)', { has: page.locator('.fd-title', { hasText: /Desktop|Downloads/ }) }).first();
    const winB = page.locator('.files-win:not(.win-leave)', { has: page.locator('.fd-title', { hasText: 'Documents' }) }).first();
    await winA.locator('.file-row', { has: page.locator('.fn', { hasText: /^song\.mp3$/ }) }).first().dragTo(winB.locator('.fd-content'));
    await sleep(1500);
    check('dropping into a window showing another rig copies it into that folder', fs.existsSync(path.join(B.home, 'Documents', 'song.mp3')) && fs.existsSync(path.join(dl, 'song.mp3')));
  }

  // ---- the API refuses '..' and absolute escapes (no files touched)
  const bad1 = await post(A, 'move', { paths: [`${docs}/../Desktop/folder`], dest: dl });
  const bad2 = await post(A, 'copy', { paths: [path.join(docs, 'target', 'again.txt')], dest: `${dl}/../Desktop` });
  const bad3 = await post(A, 'copy', { paths: ['target/again.txt'], dest: dl });
  const bad4 = await post(A, 'pull', { node: 'no-such-node', paths: ['/etc/hosts'], dest: dl });
  check("the API refuses '..' and relative paths (400) and unknown nodes (404)", [bad1, bad2, bad3].every((r) => r.status === 400) && bad4.status === 404, JSON.stringify([bad1.status, bad2.status, bad3.status, bad4.status]));

  // ---- phone
  await page.context().close(); // ui_open goes to every open UI: leave only the phone
  const { page: ph } = await newPage({ width: 390, height: 844 }, { hasTouch: true, isMobile: true });
  await sleep(2000);
  await uiOpen({ view: 'files', node: 'self', path: docs });
  await ph.waitForSelector(`${W} .fd-content .file-row`);
  await sleep(600);
  await ph.evaluate((p) => {
    const root = document.querySelector('.files-win .finder');
    const row = root.querySelector('.file-row[data-drop-path]');
    row?.classList.add('drop-target', 'copy');
    const tray = root.querySelector('.fd-xfer');
    tray.insertAdjacentHTML('beforeend', '<div class="fd-xrow"><span class="fd-xtxt">Copying “payload.bin” → linux-b — 18 MB of 40 MB</span><div class="fd-xbar"><i style="width:45%"></i></div></div>');
  }, 0);
  await shot(ph, 'phone-drag-hover.png');
  await ph.evaluate(() => { document.querySelector('.files-win .fd-xfer').innerHTML = ''; document.querySelector('.files-win .drop-target')?.classList.remove('drop-target', 'copy'); });
  // the real dialog on a phone: an OS drop with a clashing name
  await ph.evaluate(() => {
    const dt = new DataTransfer();
    dt.items.add(new File(['x'], 'target', {}));
    const t = document.querySelector('.files-win .fd-content');
    for (const type of ['dragenter', 'dragover', 'drop']) t.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt }));
  });
  await ph.waitForSelector(`${W} .fd-dialog`);
  const box = await ph.$eval(`${W} .fd-dialog`, (e) => { const r = e.getBoundingClientRect(); return { l: r.left, r: r.right, w: innerWidth }; });
  check('the clash dialog fits a 390px phone', box.l >= 0 && box.r <= box.w, JSON.stringify(box));
  await shot(ph, 'phone-clash-dialog.png');
  await ph.locator(`${W} .fd-dialog button[data-clash="cancel"]`).click();

  check('no console errors', errors.length === 0, errors.slice(0, 3).join(' | '));
} catch (e) {
  check('check ran to the end', false, e.stack || String(e));
} finally {
  await browser.close();
  A.stop();
  B.stop();
}
const failed = results.filter((x) => !x).length;
console.log(`\n${results.length - failed}/${results.length} PASS${failed ? `, ${failed} FAIL` : ''} — screenshots in ${OUT}`);
process.exit(failed ? 1 : 0);
