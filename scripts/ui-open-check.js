#!/usr/bin/env node
// ui_open check: the JARVIS file browser opened by the MCP tool / POST /api/mesh/ui/open, in headless Chromium
// (Playwright from RIGS_AUDIT_TOOLS or ~/.cache/rigs-audit, as scripts/dock-check.js), saving screenshots:
// desktop 1440x900 — ui_open through `rigs mcp` opens ~/Downloads; a file opens its folder with it selected and
// previewed in the SAME window; a missing path opens its nearest parent with a toast; a request sent from one tab
// (jarvis/send stubbed: it only returns the trace id) opens on that tab and not on another; phone 390x844 — the
// browser opens full-screen at ~/Downloads and at a selected file.
//   node scripts/ui-open-check.js [--url http://127.0.0.1:4719/] [--out .rigs-evidence/ui-open]
// Without --url it starts a throwaway `rigs serve` from this checkout (scratch RIGS_HOME, no OpenRig, no migrations,
// no autoupdate). Exit code 1 when a check fails.
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
const tools = [process.env.RIGS_AUDIT_TOOLS, path.join(os.homedir(), '.cache/rigs-audit'), ROOT].filter(Boolean);
let chromium = null;
for (const d of tools) { try { ({ chromium } = createRequire(path.join(path.resolve(d.replace(/^~/, os.homedir())), 'x.js'))('playwright')); break; } catch { /* next */ } }
if (!chromium) { console.error('playwright not found: install it outside the repo and set RIGS_AUDIT_TOOLS=<dir>'); process.exit(2); }
const OUT = path.resolve(opt('out', path.join(ROOT, '.rigs-evidence', 'ui-open')));
fs.mkdirSync(OUT, { recursive: true });

const freePort = () => new Promise((resolve, reject) => { const s = net.createServer(); s.once('error', reject); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }); });
async function startServer() {
  if (opt('url', '')) return { url: opt('url', '').replace(/\/?$/, '/'), env: process.env, stop() {} };
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'rigs-ui-open-'));
  const port = await freePort();
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ port, openrig: { registerPeers: false } }));
  const env = { ...process.env, RIGS_HOME: home, RIGS_PORT: String(port), RIGS_SSH_DIR: path.join(home, 'ssh'), RIGS_NO_MIGRATIONS: '1', RIGS_NO_AUTOUPDATE: '1', RIGS_NO_OPENRIG: '1' };
  const child = spawn(process.execPath, ['bin/rigs.js', 'serve'], { cwd: ROOT, stdio: 'ignore', env });
  const url = `http://127.0.0.1:${port}/`;
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 500));
    try { if ((await fetch(url)).ok) return { url, env, home, stop: () => { child.kill(); fs.rmSync(home, { recursive: true, force: true }); } }; } catch { /* wait */ }
  }
  child.kill();
  throw new Error('rigs serve did not come up');
}
const server = await startServer();
const URL = server.url;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, ok, extra = '') => { results.push({ name, ok: !!ok }); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${extra ? ' — ' + extra : ''}`); };

// A fixture folder with a small real PDF, so "a file opens its folder with it selected and previewed" is visible.
const FIX = path.join(server.home || fs.mkdtempSync(path.join(os.tmpdir(), 'rigs-ui-open-fix-')), 'fixture', 'training_runs', 'ro_t3');
fs.mkdirSync(FIX, { recursive: true });
const PDF = '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj 2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj 3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 300 200]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj 4 0 obj<</Length 52>>stream\nBT /F1 18 Tf 30 100 Td (Romanian training report) Tj ET\nendstream endobj 5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n';
fs.writeFileSync(path.join(FIX, 'report.pdf'), PDF);
fs.writeFileSync(path.join(FIX, 'README.md'), '# ro_t3\n\nRomanian training run.\n');
fs.writeFileSync(path.join(FIX, 'findings.md'), '# Findings\n');
const DOWNLOADS = path.join(os.homedir(), 'Downloads');

async function uiOpen(body) {
  const r = await fetch(new globalThis.URL('api/mesh/ui/open', URL), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return r.json();
}
/** The real MCP tool: `rigs mcp` (this checkout) talking to the server under test. */
async function mcpUiOpen(a) {
  const mcp = spawn(process.execPath, [path.join(ROOT, 'bin/rigs.js'), 'mcp'], { env: server.env, stdio: ['pipe', 'pipe', 'ignore'] });
  const lines = readline.createInterface({ input: mcp.stdout });
  const got = new Map();
  lines.on('line', (l) => { try { const m = JSON.parse(l); if (m.id !== undefined) got.set(m.id, m); } catch { /* not ours */ } });
  const call = async (id, method, params) => { mcp.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'); for (let i = 0; i < 150 && !got.has(id); i++) await sleep(100); return got.get(id); };
  try {
    await call(1, 'initialize', { protocolVersion: '2025-06-18' });
    const r = await call(2, 'tools/call', { name: 'ui_open', arguments: a });
    return { isError: !!r?.result?.isError, out: (() => { try { return JSON.parse(r.result.content[0].text); } catch { return r?.result?.content?.[0]?.text; } })() };
  } finally { mcp.kill(); }
}

const state = (page) => page.evaluate(() => {
  const wins = [...document.querySelectorAll('.files-win')];
  const w = wins.at(-1);
  return {
    windows: wins.length, path: w?.querySelector('.path-input')?.value || '', rows: w?.querySelectorAll('.file-row').length || 0,
    selected: w?.querySelector('.file-row.sel .fn')?.textContent || '', pdf: !!w?.querySelector('.file-preview iframe.pv-frame'),
    title: w?.querySelector('.win-title, .title')?.textContent || '',
    toast: [...document.querySelectorAll('#toasts .toast')].map((t) => t.textContent).join(' | '),
    rect: w ? (({ left, top, width, height }) => ({ left, top, width, height }))(w.getBoundingClientRect()) : null,
  };
});
async function waitFor(page, fn, ms = 15000) {
  const t0 = Date.now();
  let s;
  while (Date.now() - t0 < ms) { s = await state(page); if (fn(s)) return s; await sleep(150); }
  return s;
}
async function newPage(ctx) {
  const page = await ctx.newPage();
  page.setDefaultTimeout(60000);
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error' && !/favicon|net::ERR|Failed to load resource/.test(m.text())) errors.push(`console: ${m.text().slice(0, 200)}`); });
  await page.goto(URL, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#panels-btn', { state: 'attached' });
  await page.waitForFunction(() => !document.getElementById('orb')?.classList.contains('offline'), null, { timeout: 20000 }).catch(() => {});
  await sleep(1500); // the /ws push socket is open
  return page;
}

const browser = await chromium.launch({ args: ['--no-sandbox'] });
const errors = [];
try {
  // ------------------------------------------------------------------ desktop 1440x900
  {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await newPage(ctx);
    const r = await mcpUiOpen({ view: 'files', node: 'self', path: 'downloads' });
    check('desktop: ui_open through rigs mcp succeeds', !r.isError && r.out?.ok, JSON.stringify(r.out).slice(0, 200));
    let s = await waitFor(page, (x) => x.path === DOWNLOADS && x.rows > 0);
    check('desktop: the file browser opened at ~/Downloads', s.windows === 1 && s.path === DOWNLOADS, `${s.windows} window(s), path ${s.path}, ${s.rows} rows`);
    await sleep(500);
    await page.screenshot({ path: path.join(OUT, 'desktop-downloads.png') });

    await uiOpen({ path: path.join(FIX, 'report.pdf') });
    s = await waitFor(page, (x) => x.path === FIX && x.selected === 'report.pdf' && x.pdf);
    check('desktop: a file opens its folder in the same window, selected and previewed', s.windows === 1 && s.path === FIX && s.selected === 'report.pdf' && s.pdf, `${s.windows} window(s), path ${s.path}, selected ${s.selected}, pdf ${s.pdf}`);
    await sleep(800);
    await page.screenshot({ path: path.join(OUT, 'desktop-file-selected.png') });

    await uiOpen({ path: path.join(FIX, 'no-such-run', 'deeper') });
    s = await waitFor(page, (x) => x.path === FIX && /isn't on/.test(x.toast));
    check('desktop: a missing path opens its nearest parent with a toast', s.windows === 1 && s.path === FIX && /opened .* instead/.test(s.toast), s.toast.slice(0, 160));
    await page.screenshot({ path: path.join(OUT, 'desktop-missing-fallback.png') });
    await ctx.close();
  }

  // ------------------------------------------------------------------ the tab that asked gets it, the other does not
  {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const traceId = `tr-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-${Math.random().toString(16).slice(2, 14).padEnd(12, '0')}`;
    const asker = await newPage(ctx);
    const other = await newPage(ctx);
    // Sending needs a brain in the snapshot (the badge stops saying NO BRAIN once the first mesh scan is in).
    const brain = await asker.waitForFunction(() => !/NO BRAIN/.test(document.getElementById('brain-badge')?.textContent || ''), null, { timeout: 45000 }).then(() => true, () => false);
    check('targeting: this machine has a brain to send to', brain);
    // jarvis/send stubbed: the stream says which trace this request is, as the real one does first, then ends.
    await asker.route('**/jarvis/send', (route) => route.fulfill({ status: 200, contentType: 'application/x-ndjson', body: `${JSON.stringify({ type: 'trace', traceId })}\n${JSON.stringify({ type: 'done', text: 'Of course, sir.' })}\n` }));
    await asker.click('#ask').catch(() => {});
    await asker.fill('#ask', 'open my Downloads folder');
    await asker.keyboard.press('Enter');
    await sleep(1200);
    const r = await uiOpen({ path: 'downloads', trace: traceId });
    const a = await waitFor(asker, (x) => x.path === DOWNLOADS);
    await sleep(800);
    const o = await state(other);
    check('targeting: the request\'s own tab opened it', r.shownOn === 'requester' && a.windows === 1 && a.path === DOWNLOADS, `shownOn ${r.shownOn}, delivered ${r.delivered}`);
    check('targeting: another open tab was left alone', o.windows === 0, `${o.windows} window(s) there`);
    await asker.screenshot({ path: path.join(OUT, 'desktop-requesting-tab.png') });
    await ctx.close();
  }

  // ------------------------------------------------------------------ phone 390x844
  {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    const page = await newPage(ctx);
    const r = await mcpUiOpen({ path: 'my Downloads folder' });
    let s = await waitFor(page, (x) => x.path === DOWNLOADS && x.rows > 0);
    check('phone: ui_open opens the file browser at ~/Downloads', !r.isError && s.windows === 1 && s.path === DOWNLOADS, `path ${s.path}, ${s.rows} rows`);
    await sleep(700); // the window's open animation (a scale-in) has settled
    s = await state(page);
    check('phone: it fills the screen', s.rect && s.rect.width >= 380 && s.rect.height >= 600, JSON.stringify(s.rect));
    await sleep(500);
    await page.screenshot({ path: path.join(OUT, 'phone-downloads.png') });
    await uiOpen({ path: path.join(FIX, 'report.pdf') });
    s = await waitFor(page, (x) => x.path === FIX && x.selected === 'report.pdf');
    check('phone: a file opens its folder selected, in the same window', s.windows === 1 && s.selected === 'report.pdf', `${s.windows} window(s), selected ${s.selected}`);
    await sleep(800);
    await page.screenshot({ path: path.join(OUT, 'phone-file-selected.png') });
    await ctx.close();
  }
} finally {
  await browser.close();
  server.stop();
}
check('no console errors or page exceptions', !errors.length, errors.slice(0, 5).join(' · '));
console.log(`\nscreenshots: ${OUT}`);
const failed = results.filter((r) => !r.ok);
console.log(`${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
