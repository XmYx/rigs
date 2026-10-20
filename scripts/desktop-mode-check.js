#!/usr/bin/env node
// Desktop mode check (ui/src/desktop.js): a throwaway `rigs serve` (scratch RIGS_HOME, so its shared folder is
// <home>/RIGS-Shared) seeded with files, opened with the cloud hidden in headless Chromium (Playwright from
// RIGS_AUDIT_TOOLS or ~/.cache/rigs-audit), at 1440x900 and 390x844. Checks: icons for the shared folder, a file dropped
// from the OS lands in the folder as an icon, double-click opens CSV / JSON in their tools and a folder in the file
// browser, dragging an icon moves it and the position survives a reload, dropping onto a folder moves the file there,
// Delete trashes after a confirm (into <home>/trash), the context menu, showing the cloud removes the desktop with no
// polling left, the phone grid opens a file on tap; no console errors. Screenshots into screenshots/desktop-mode/.
//   node scripts/desktop-mode-check.js [--out screenshots/desktop-mode]
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
const OUT = path.resolve(opt('out', path.join(ROOT, 'screenshots/desktop-mode')));
fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function startServer() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'rigs-dm-'));
  const port = await new Promise((resolve, reject) => { const s = net.createServer(); s.once('error', reject); s.listen(0, '127.0.0.1', () => { const { port: p } = s.address(); s.close(() => resolve(p)); }); });
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ port, openrig: { registerPeers: false } }));
  const env = { ...process.env, RIGS_HOME: home, RIGS_PORT: String(port), RIGS_SSH_DIR: path.join(home, 'ssh'), RIGS_NO_MIGRATIONS: '1', RIGS_NO_AUTOUPDATE: '1', RIGS_NO_OPENRIG: '1', RIGS_PEERS: '' };
  const child = spawn(process.execPath, ['bin/rigs.js', 'serve'], { cwd: ROOT, stdio: 'ignore', env });
  const url = `http://127.0.0.1:${port}/`;
  for (let i = 0; i < 60; i++) {
    await sleep(500);
    try { if ((await fetch(url + 'api/local/shared')).ok) return { url, home, shared: path.join(home, 'RIGS-Shared'), stop: () => { child.kill(); fs.rmSync(home, { recursive: true, force: true }); } }; } catch { /* wait */ }
  }
  child.kill();
  throw new Error('rigs serve did not come up');
}

function seed(dir) {
  const w = (rel, s) => { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), s); };
  w('notes.md', '# Notes\n\nThe desktop shows the shared folder.\n');
  w('sales.csv', 'region,units,revenue\nNorth,120,1200\nSouth,45,980\nEast,300,4500\n');
  w('config.json', JSON.stringify({ mesh: { nodes: ['magix-system', 'macbookpro'], port: 4719 }, tools: ['text', 'csv', 'json'] }, null, 2));
  w('reports/weekly.md', '# Weekly report\n');
  w('files/quote.txt', 'For Sir.\n');
  w('projects/README.md', '# Projects\n');
  fs.copyFileSync(path.join(ROOT, 'ui/icon-512.png'), path.join(dir, 'logo.png'));
  fs.writeFileSync(path.join(dir, 'old-draft.txt'), 'to be trashed\n');
}

const server = await startServer();
seed(server.shared);
const results = [];
const check = (name, ok, extra = '') => { results.push(!!ok); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${extra ? ' — ' + extra : ''}`); };
const browser = await chromium.launch({ channel: process.env.RIGS_CHROME_CHANNEL || 'chromium', args: ['--no-sandbox'] });
const errors = [];
const icon = (page, name) => page.locator(`#desktop .dt-icon[data-name="${name}"]`);
const topTool = (page) => page.locator('.ft-win').last();

async function newPage(viewport, extra = {}) {
  const ctx = await browser.newContext({ viewport, ...extra });
  await ctx.addInitScript(() => { try { if (!sessionStorage.getItem('dm-init')) { localStorage.setItem('rigs.cloud', 'false'); sessionStorage.setItem('dm-init', '1'); } } catch { /* first load only */ } });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(`${viewport.width}: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error' && !/favicon|Failed to load resource/.test(m.text())) errors.push(`${viewport.width}: ${m.text()}`); });
  page.on('dialog', (d) => d.accept());
  await page.goto(server.url);
  await page.waitForSelector('#desktop .dt-icon');
  await icon(page, 'notes.md').waitFor();
  return { ctx, page };
}

try {
  // ---------------------------------------------------------------- desktop 1440x900
  const { ctx, page } = await newPage({ width: 1440, height: 900 });
  await sleep(800);
  const names = await page.locator('#desktop .dt-icon .dt-name').allTextContents();
  check('hiding the cloud shows the shared folder as icons', ['apps', 'files', 'reports', 'projects', 'notes.md', 'sales.csv', 'config.json', 'logo.png'].every((n) => names.includes(n)), names.join(', '));
  check('images get a thumbnail', (await icon(page, 'logo.png').locator('img.dt-thumb').count()) === 1);
  check('the sync badge and shortcut row are shown', /Local only|Synced|Peers/.test(await page.locator('.dt-badge').textContent()) && (await page.locator('.dt-short').count()) === 4);
  // No icon sits under a visible panel.
  const overlap = await page.evaluate(() => {
    const panels = [...document.querySelectorAll('body > .panel, body > .floating, #app-dock')].filter((e) => getComputedStyle(e).display !== 'none' && e.getBoundingClientRect().width > 2).map((e) => e.getBoundingClientRect());
    return [...document.querySelectorAll('#desktop .dt-icon')].filter((i) => { const r = i.getBoundingClientRect(); return panels.some((p) => r.left < p.right - 6 && p.left < r.right - 6 && r.top < p.bottom - 6 && p.top < r.bottom - 6); }).map((i) => i.dataset.name);
  });
  check('icons keep clear of the panels and the dock', overlap.length === 0, overlap.join(', '));
  await page.screenshot({ path: path.join(OUT, 'desktop-icons.png') });

  // OS drop: a synthetic DataTransfer with a File, dragged over (hint shown), then dropped.
  const drop = async (eventName, name, x, y) => page.evaluate(({ eventName, name, x, y }) => {
    const dt = new DataTransfer();
    dt.items.add(new File([`dropped ${name}\n`], name, { type: 'text/plain' }));
    document.querySelector('#desktop').dispatchEvent(new DragEvent(eventName, { dataTransfer: dt, clientX: x, clientY: y, bubbles: true, cancelable: true }));
  }, { eventName, name, x, y });
  await drop('dragenter', 'dropped.txt', 760, 420);
  await drop('dragover', 'dropped.txt', 760, 420);
  await sleep(150);
  check('dragging files over the desktop shows the drop hint', await page.locator('.dt-hint').isVisible());
  await page.screenshot({ path: path.join(OUT, 'drag-in-progress.png') });
  await drop('drop', 'dropped.txt', 760, 420);
  await icon(page, 'dropped.txt').waitFor({ timeout: 8000 });
  const onDisk = fs.existsSync(path.join(server.shared, 'dropped.txt')) && fs.readFileSync(path.join(server.shared, 'dropped.txt'), 'utf8') === 'dropped dropped.txt\n';
  check('a file dropped from the OS is written into the shared folder', onDisk);
  const box = await icon(page, 'dropped.txt').boundingBox();
  check('and appears as an icon where it was dropped', Math.abs(box.x + 44 - 760) < 100 && Math.abs(box.y + 46 - 420) < 110, `${Math.round(box.x)},${Math.round(box.y)}`);
  await page.screenshot({ path: path.join(OUT, 'after-drop.png') });

  // Double-click opens the matching tool / the file browser.
  await icon(page, 'sales.csv').dblclick();
  await topTool(page).locator('.ft-table tbody tr').first().waitFor();
  check('double-click on a CSV opens the CSV viewer', (await topTool(page).locator('.ft-table tbody tr').count()) === 3);
  await page.screenshot({ path: path.join(OUT, 'open-csv.png') });
  await topTool(page).locator('.win-btn.close').click();
  await sleep(300);
  await icon(page, 'config.json').dblclick();
  await topTool(page).locator('.jt-node').first().waitFor();
  check('double-click on a JSON file opens the JSON viewer', (await topTool(page).locator('.jt-node').count()) > 0);
  await page.screenshot({ path: path.join(OUT, 'open-json.png') });
  await topTool(page).locator('.win-btn.close').click();
  await sleep(300);
  await icon(page, 'projects').dblclick();
  await page.locator('.files-win .file-row').first().waitFor();
  check('double-click on a folder opens it in the RIGS file browser', (await page.locator('.files-win .path-input').inputValue()).endsWith(`${path.sep}projects`));
  await page.locator('.files-win .win-btn.close').click();
  await sleep(300);

  // Drag an icon to a new cell; it stays there after a reload.
  const src = await icon(page, 'notes.md').boundingBox();
  await page.dragAndDrop('#desktop .dt-icon[data-name="notes.md"]', '#desktop', { sourcePosition: { x: 40, y: 30 }, targetPosition: { x: 1000, y: 560 } });
  await sleep(400);
  const moved = await icon(page, 'notes.md').boundingBox();
  check('dragging an icon moves it', Math.abs(moved.x - src.x) > 200 && Math.abs(moved.x + 40 - 1000) < 100, `${Math.round(src.x)},${Math.round(src.y)} → ${Math.round(moved.x)},${Math.round(moved.y)}`);
  await page.reload();
  await icon(page, 'notes.md').waitFor();
  await sleep(600);
  const after = await icon(page, 'notes.md').boundingBox();
  check('the icon position survives a reload', Math.abs(after.x - moved.x) < 2 && Math.abs(after.y - moved.y) < 2, `${Math.round(after.x)},${Math.round(after.y)}`);

  // Drop onto a folder icon moves the file into it.
  await page.dragAndDrop('#desktop .dt-icon[data-name="dropped.txt"]', '#desktop .dt-icon[data-name="projects"]', { sourcePosition: { x: 40, y: 30 }, targetPosition: { x: 44, y: 40 } });
  await icon(page, 'dropped.txt').waitFor({ state: 'detached', timeout: 8000 });
  check('dropping an icon onto a folder moves it there', fs.existsSync(path.join(server.shared, 'projects', 'dropped.txt')) && !fs.existsSync(path.join(server.shared, 'dropped.txt')));

  // Context menu on an icon and on the desktop.
  await icon(page, 'config.json').click({ button: 'right' });
  await page.locator('.mb-menu').first().waitFor();
  const items = await page.locator('.mb-menu').first().innerText();
  check('the icon menu has Open with, Compress to zip, Show in Files, Rename and Move to trash', ['Open with', 'Compress to zip', 'Show in Files', 'Rename', 'Move to trash'].every((x) => items.includes(x)), items.replace(/\s+/g, ' ').slice(0, 200));
  await page.screenshot({ path: path.join(OUT, 'context-menu.png') });
  await page.keyboard.press('Escape');
  await page.mouse.click(900, 300, { button: 'right' });
  await page.locator('.mb-menu').first().waitFor();
  const bg = await page.locator('.mb-menu').first().innerText();
  check('the desktop menu has New folder and New text file', bg.includes('New folder') && bg.includes('New text file'), bg.replace(/\s+/g, ' ').slice(0, 160));
  await page.screenshot({ path: path.join(OUT, 'desktop-menu.png') });
  await page.keyboard.press('Escape');

  // Delete trashes after a confirm; a rubber band selects; arrows move the selection.
  await icon(page, 'old-draft.txt').click();
  await page.keyboard.press('Delete');
  await icon(page, 'old-draft.txt').waitFor({ state: 'detached', timeout: 8000 });
  const trash = fs.existsSync(path.join(server.home, 'trash')) ? fs.readdirSync(path.join(server.home, 'trash')) : [];
  check('Delete moves the file to ~/.rigs/trash after a confirm', trash.some((f) => f.endsWith('old-draft.txt')) && !fs.existsSync(path.join(server.shared, 'old-draft.txt')), trash.join(', '));
  const a = await icon(page, 'apps').boundingBox();
  await page.mouse.move(a.x - 6, a.y - 6);
  await page.mouse.down();
  await page.mouse.move(a.x + 60, a.y + 260, { steps: 6 });
  const banded = await page.locator('#desktop .dt-icon.sel').count();
  await page.mouse.up();
  check('a rubber band selects the icons it touches', banded >= 2, `${banded} selected`);
  await page.keyboard.press('ArrowDown');
  check('arrow keys move the selection', (await page.locator('#desktop .dt-icon.sel').count()) === 1);

  // Showing the cloud removes the desktop completely; nothing polls afterwards.
  await page.evaluate(() => document.querySelector('#cloud-toggle').click());
  await sleep(500);
  const stats = await page.evaluate(() => window.__rigsDesktop.stats());
  let polls = 0;
  page.on('request', (r) => { if (/\/files\?path=|\/shared$/.test(r.url())) polls++; });
  await sleep(4000);
  check('showing the cloud removes the desktop, its listeners and its polling', !stats.mounted && !stats.inDom && stats.disposables === 0 && polls === 0, JSON.stringify({ ...stats, polls }));
  await page.evaluate(() => document.querySelector('#cloud-toggle').click());
  await icon(page, 'apps').waitFor();
  check('hiding it again brings the desktop back', (await page.evaluate(() => window.__rigsDesktop.stats())).mounted);
  await ctx.close();

  // ---------------------------------------------------------------- phone 390x844
  const ph = await newPage({ width: 390, height: 844 }, { isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  await sleep(800);
  const grid = await ph.page.evaluate(() => getComputedStyle(document.querySelector('#desktop .dt-area')).display);
  const fits = await ph.page.evaluate(() => [...document.querySelectorAll('#desktop .dt-icon')].every((i) => { const r = i.getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth; }));
  check('phone: the desktop is a grid that fits the screen', grid === 'grid' && fits);
  await ph.page.screenshot({ path: path.join(OUT, 'phone.png') });
  await icon(ph.page, 'notes.md').tap();
  await topTool(ph.page).locator('.ft-text').waitFor();
  check('phone: a tap opens the file in its tool', (await topTool(ph.page).count()) === 1);
  await ph.page.screenshot({ path: path.join(OUT, 'phone-open.png') });
  await ph.ctx.close();
} catch (e) {
  check('run', false, e.stack || e.message);
} finally {
  check('no console errors', errors.length === 0, errors.join(' | '));
  await browser.close();
  server.stop();
}
const failed = results.filter((x) => !x).length;
console.log(`\n${results.length - failed}/${results.length} passed · screenshots in ${path.relative(ROOT, OUT)}/`);
process.exit(failed ? 1 : 0);
