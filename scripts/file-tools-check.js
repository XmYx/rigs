#!/usr/bin/env node
// Built-in file tools check (ui/src/file-tools.js): a throwaway `rigs serve` (scratch RIGS_HOME) and a fixture folder,
// the file browser opened through POST /api/mesh/ui/open, then in headless Chromium (Playwright from RIGS_AUDIT_TOOLS
// or ~/.cache/rigs-audit), at desktop 1440x900 and phone 390x844: double-click opens each file in its tool (text
// editor edit + Ctrl/⌘+S saves to disk, image next/zoom, PDF, CSV sort, JSON tree and invalid-JSON error position),
// zip of a selection then Extract here round-trips the files, no console errors; screenshots of every tool.
//   node scripts/file-tools-check.js [--out screenshots/file-tools]
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
const OUT = path.resolve(opt('out', path.join(ROOT, 'screenshots/file-tools')));
fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function startServer() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'rigs-ft-'));
  const port = await new Promise((resolve, reject) => { const s = net.createServer(); s.once('error', reject); s.listen(0, '127.0.0.1', () => { const { port: p } = s.address(); s.close(() => resolve(p)); }); });
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ port, openrig: { registerPeers: false } }));
  const env = { ...process.env, RIGS_HOME: home, RIGS_PORT: String(port), RIGS_SSH_DIR: path.join(home, 'ssh'), RIGS_NO_MIGRATIONS: '1', RIGS_NO_AUTOUPDATE: '1', RIGS_NO_OPENRIG: '1', RIGS_PEERS: '' };
  const child = spawn(process.execPath, ['bin/rigs.js', 'serve'], { cwd: ROOT, stdio: 'ignore', env });
  const url = `http://127.0.0.1:${port}/`;
  for (let i = 0; i < 60; i++) {
    await sleep(500);
    try { if ((await fetch(url + 'api/nodes/self/files?path=~')).ok) return { url, home, stop: () => { child.kill(); fs.rmSync(home, { recursive: true, force: true }); } }; } catch { /* wait */ }
  }
  child.kill();
  throw new Error('rigs serve did not come up');
}

function fixture(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const w = (n, s) => fs.writeFileSync(path.join(dir, n), s);
  w('notes.md', '# Mission notes\n\n- Shared folder synced across the mesh\n- Built-in tools: editor, viewers, zip\n\nSir asked for a quarterly report.\n');
  w('sales.csv', 'region,"product, variant",units,revenue\r\nNorth,"Widget, blue",120,"1,200.50"\r\nSouth,"Gadget ""Pro""",45,980\r\nEast,"Multi\nline",300,4500\r\nWest,Widget,8,99.9\r\nCentral,,77,1500\r\n');
  w('config.json', JSON.stringify({ name: 'rigs', version: '0.1.0', mesh: { nodes: ['magix-system', 'macbookpro', 'win-rig'], token: null, port: 4719 }, tools: [{ id: 'text', on: true }, { id: 'csv', on: true }], limits: { zip: { maxBytes: 536870912 } } }, null, 2));
  w('broken.json', '{\n  "name": "rigs",\n  "nodes": ["a", "b"]\n  "port": 4719\n}\n');
  w('report.pdf', '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj 2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj 3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 400 260]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj 4 0 obj<</Length 58>>stream\nBT /F1 20 Tf 40 140 Td (Quarterly report - RIGS mesh) Tj ET\nendstream endobj 5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n');
  fs.copyFileSync(path.join(ROOT, 'ui/icon-512.png'), path.join(dir, 'logo.png'));
  fs.copyFileSync(path.join(ROOT, 'ui/apple-touch-icon.png'), path.join(dir, 'touch.png'));
}

const server = await startServer();
const results = [];
const check = (name, ok, extra = '') => { results.push(!!ok); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${extra ? ' — ' + extra : ''}`); };
// The full Chromium build (new headless) has the built-in PDF viewer; the bare headless shell does not.
const browser = await chromium.launch({ channel: process.env.RIGS_CHROME_CHANNEL || 'chromium', args: ['--no-sandbox'] });
const errors = [];

async function uiOpen(p) {
  const r = await fetch(new URL('api/mesh/ui/open', server.url), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ view: 'files', path: p }) });
  return r.json();
}
const shot = async (page, name) => { await page.addStyleTag({ content: '#toasts{display:none!important}' }); await sleep(250); await page.screenshot({ path: path.join(OUT, name) }); };
const row = (page, name) => page.locator('.files-win .file-row', { has: page.locator('.fn', { hasText: new RegExp(`^${name.replace(/[.()]/g, '\\$&')}$`) }) });
const topTool = (page) => page.locator('.ft-win').last();
const closeTool = async (page) => { await topTool(page).locator('.win-btn.close').click(); await sleep(300); };

async function run(label, vp) {
  const FIX = path.join(server.home, 'fixture', label);
  fixture(FIX);
  const phone = label === 'phone';
  const ctx = await browser.newContext({ viewport: vp, hasTouch: phone, isMobile: phone, deviceScaleFactor: phone ? 2 : 1 });
  const page = await ctx.newPage();
  page.setDefaultTimeout(30000);
  page.on('pageerror', (e) => errors.push(`${label} pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error' && !/favicon|net::ERR|Failed to load resource/.test(m.text())) errors.push(`${label} console: ${m.text().slice(0, 200)}`); });
  await page.goto(server.url, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#panels-btn', { state: 'attached' });
  await sleep(2000); // the /ws push socket is open
  await uiOpen(FIX);
  await page.waitForSelector('.files-win .file-row');
  await row(page, 'notes.md').waitFor();

  // (a) text editor: double-click, type, dirty marker, Ctrl/⌘+S writes the file
  await row(page, 'notes.md').dblclick();
  const ed = topTool(page);
  await ed.locator('.ft-text:not([disabled])').waitFor();
  await ed.locator('.ft-text').click();
  await page.keyboard.press('Control+End');
  await page.keyboard.type('\nEdited in the JARVIS text editor.\n');
  const dirtyTitle = await ed.locator('.win-title-text').textContent();
  check(`${label}: text editor opens notes.md and shows the dirty marker`, dirtyTitle.startsWith('● notes.md'), dirtyTitle);
  await shot(page, `${label}-text-editor.png`);
  await page.keyboard.press('Control+s');
  await ed.locator('.ft-status', { hasText: 'Saved' }).waitFor();
  check(`${label}: Ctrl+S saves the edit to disk and clears the marker`, fs.readFileSync(path.join(FIX, 'notes.md'), 'utf8').includes('Edited in the JARVIS text editor.') && !(await ed.locator('.win-title-text').textContent()).startsWith('●'));
  await closeTool(page);

  // (b) image viewer: fit, next/previous through the folder, zoom
  await row(page, 'logo.png').dblclick();
  const iv = topTool(page);
  await iv.locator('.ft-status', { hasText: '512 × 512' }).waitFor();
  check(`${label}: image viewer opens logo.png fitted`, (await iv.locator('.ft-count').textContent()) === '1 / 2' && /%$/.test(await iv.locator('.ft-zoom').textContent()));
  await iv.locator('button[aria-label="Next image"]').click();
  await iv.locator('.ft-status', { hasText: '180 × 180' }).waitFor();
  check(`${label}: next goes to touch.png`, (await iv.locator('.ft-count').textContent()) === '2 / 2');
  await iv.locator('button[aria-label="Previous image"]').click();
  await iv.locator('.ft-status', { hasText: '512 × 512' }).waitFor();
  await iv.locator('button[aria-label="Zoom in"]').click();
  check(`${label}: zoom in leaves fit mode`, (await iv.locator('button:has-text("Fit")').getAttribute('aria-pressed')) === 'false');
  await iv.locator('button:has-text("Fit")').click();
  await shot(page, `${label}-image-viewer.png`);
  await closeTool(page);

  // (c) PDF viewer
  await row(page, 'report.pdf').dblclick();
  const pv = topTool(page);
  await pv.locator('iframe.ft-pdf, .ft-fallback').first().waitFor();
  const frame = await pv.locator('iframe.ft-pdf').count();
  check(`${label}: PDF viewer opens report.pdf (${frame ? 'browser viewer' : 'open/download fallback'})`, true);
  await sleep(1500);
  await shot(page, `${label}-pdf-viewer.png`);
  await closeTool(page);
  if (phone) {
    // Most phone browsers have no in-page PDF viewer (navigator.pdfViewerEnabled false): the window offers Open/Download.
    await page.evaluate(() => Object.defineProperty(Navigator.prototype, 'pdfViewerEnabled', { get: () => false, configurable: true }));
    await row(page, 'report.pdf').dblclick();
    await topTool(page).locator('.ft-fallback').waitFor();
    check(`${label}: without a PDF viewer the window offers Open in a new tab and Download`, (await topTool(page).locator('.ft-fallback .btn').count()) === 2);
    await sleep(800); // the window's open animation
    await shot(page, `${label}-pdf-fallback.png`);
    await closeTool(page);
  }

  // (d) CSV viewer: quoted fields, sort by a column, switch the delimiter
  await row(page, 'sales.csv').dblclick();
  const cv = topTool(page);
  await cv.locator('.ft-table tbody tr').first().waitFor();
  const cells = await cv.locator('.ft-table tbody tr').first().locator('td').allTextContents();
  check(`${label}: CSV viewer parses quoted commas`, cells[2] === 'Widget, blue' && cells[4] === '1,200.50', JSON.stringify(cells));
  check(`${label}: CSV has 5 rows`, (await cv.locator('.ft-table tbody tr').count()) === 5);
  await cv.locator('.ft-th', { hasText: 'units' }).click();
  await cv.locator('.ft-th', { hasText: 'units' }).click();
  const units = await cv.locator('.ft-table tbody tr td:nth-child(4)').allTextContents();
  check(`${label}: clicking "units" twice sorts descending numerically`, JSON.stringify(units) === JSON.stringify(['300', '120', '77', '45', '8']), JSON.stringify(units));
  await shot(page, `${label}-csv-viewer.png`);
  await cv.locator('select[aria-label="Delimiter"]').selectOption(';');
  check(`${label}: switching the delimiter re-parses`, (await cv.locator('.ft-table thead th').count()) === 2);
  await closeTool(page);

  // (e) JSON viewer: tree, then invalid JSON with its error position
  await row(page, 'config.json').dblclick();
  const jv = topTool(page);
  await jv.locator('.jt-node').first().waitFor();
  await jv.locator('.jt-row', { hasText: '"mesh"' }).locator('.jt-tog').click();
  check(`${label}: JSON tree expands "mesh"`, await jv.locator('.jt-key', { hasText: '"nodes"' }).count() > 0);
  await shot(page, `${label}-json-viewer.png`);
  await closeTool(page);
  await row(page, 'broken.json').dblclick();
  const bj = topTool(page);
  await bj.locator('.ft-json-err:not([hidden])').waitFor();
  const err = await bj.locator('.ft-json-err').textContent();
  check(`${label}: invalid JSON shows line 4, column 3`, /line 4, column 3/.test(err), err.slice(0, 90));
  await shot(page, `${label}-json-invalid.png`);
  await closeTool(page);

  // (f) zip a selection, then Extract here; the extracted files equal the originals
  let archive;
  if (!phone) {
    await row(page, 'notes.md').click();
    await row(page, 'sales.csv').click({ modifiers: ['Control'] });
    await row(page, 'config.json').click({ modifiers: ['Control'] });
    await row(page, 'config.json').click({ button: 'right' });
    await page.locator('[role=menuitem]', { hasText: 'Compress 3 items to zip' }).waitFor();
    await shot(page, `${label}-zip-menu.png`);
    await page.locator('[role=menuitem]', { hasText: 'Compress 3 items to zip' }).click();
    archive = 'Archive.zip';
  } else {
    await row(page, 'sales.csv').click();
    await page.locator('.files-win .file-preview button', { hasText: 'Zip' }).click();
    archive = 'sales.csv.zip';
  }
  await row(page, archive).waitFor();
  const before = new Set(fs.readdirSync(FIX)); // the extract's new folder is the one not here yet
  if (!phone) {
    await row(page, archive).click({ button: 'right' });
    await page.locator('[role=menuitem]', { hasText: 'Extract here' }).waitFor();
    await shot(page, `${label}-unzip-menu.png`);
    await page.locator('[role=menuitem]', { hasText: 'Extract here' }).click();
  } else {
    await row(page, archive).click();
    await page.locator('.files-win .file-preview button', { hasText: 'Extract' }).waitFor();
    await shot(page, `${label}-zip-unzip.png`);
    await page.locator('.files-win .file-preview button', { hasText: 'Extract' }).click();
  }
  let folder = null;
  for (let i = 0; i < 100 && !folder; i++) { await sleep(100); folder = fs.readdirSync(FIX).find((n) => !before.has(n) && fs.statSync(path.join(FIX, n)).isDirectory()); }
  check(`${label}: Extract made a new folder beside the archive`, !!folder, folder || 'none');
  await row(page, folder).waitFor();
  const names = phone ? ['sales.csv'] : ['notes.md', 'sales.csv', 'config.json'];
  const same = names.every((n) => fs.readFileSync(path.join(FIX, folder, n)).equals(fs.readFileSync(path.join(FIX, n))));
  check(`${label}: zip then unzip round-trips ${names.length} file(s)`, same);
  if (!phone) await shot(page, `${label}-zip-unzip.png`);

  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
  check(`${label}: no sideways page overflow`, overflow <= 0, String(overflow));
  await ctx.close();
}

try {
  await run('desktop', { width: 1440, height: 900 });
  await run('phone', { width: 390, height: 844 });
} catch (e) {
  check('run', false, e.stack || e.message);
} finally {
  check('no console or page errors', !errors.length, errors.join(' | '));
  await browser.close();
  server.stop();
}
console.log(`\n${results.filter(Boolean).length}/${results.length} passed · screenshots in ${path.relative(ROOT, OUT)}/`);
process.exit(results.every(Boolean) ? 0 : 1);
