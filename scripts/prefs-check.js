#!/usr/bin/env node
// System Preferences check: drives JARVIS in headless Chromium (Playwright from RIGS_AUDIT_TOOLS or ~/.cache/rigs-audit,
// as scripts/ask-check.js) and checks the JARVIS menu and the preferences window end to end, saving screenshots:
// the menu at the far left (About RIGS OS, System Preferences…), ⌘/Ctrl+, , every category rendering a working control
// for each of its items, a server switch (quick fast path) saved through POST /api/local/settings and still there after
// a reload, a UI pref in step with the left panel both ways, secrets never in the DOM, search, keyboard (Esc order,
// focus) and the phone layout (390x844: the list drills into a category with Back).
//   node scripts/prefs-check.js [--url http://127.0.0.1:4719/] [--out screenshots/settings-menu]
// Without --url it starts a throwaway `rigs serve` (scratch RIGS_HOME with a fake Linear key, no OpenRig, no
// migrations, no autoupdate). Exit code 1 when a check fails.
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CATEGORIES } from '../ui/src/settings-model.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
const tools = [process.env.RIGS_AUDIT_TOOLS, path.join(os.homedir(), '.cache/rigs-audit'), ROOT].filter(Boolean);
let chromium = null;
for (const d of tools) { try { ({ chromium } = createRequire(path.join(path.resolve(d.replace(/^~/, os.homedir())), 'x.js'))('playwright')); break; } catch { /* next */ } }
if (!chromium) { console.error('playwright not found: install it outside the repo and set RIGS_AUDIT_TOOLS=<dir>'); process.exit(2); }
const OUT = path.resolve(ROOT, opt('out', 'screenshots/settings-menu'));
fs.mkdirSync(OUT, { recursive: true });
const SECRET = 'lin_api_SECRETVALUE123';

async function startServer() {
  if (opt('url', '')) return { url: opt('url', ''), stop() {} };
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'rigs-prefs-'));
  const port = await new Promise((resolve, reject) => { const s = net.createServer(); s.once('error', reject); s.listen(0, '127.0.0.1', () => { const { port: p } = s.address(); s.close(() => resolve(p)); }); });
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ port, openrig: { registerPeers: false }, linear: { apiKey: SECRET } }));
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
const API = new globalThis.URL('api/local/settings', URL).href;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const errors = [];
const check = (name, ok, extra = '') => { results.push({ name, ok: !!ok }); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${extra ? ' — ' + extra : ''}`); };
const shot = (page, name) => page.screenshot({ path: path.join(OUT, `${name}.png`) });
const getSetting = async (id) => { const r = await (await fetch(API)).json(); for (const c of r.categories) for (const e of c.items) if (e.id === id) return e; return null; };

async function openPage(ctx) {
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  // A quiet screen: no toasts, banners, auto-opened sessions, face or galaxy motion (as ask-check.js).
  await page.addInitScript(() => {
    try {
      if (!sessionStorage.getItem('prefs-check')) {
        for (const k of ['rigs.notifications', 'rigs.attnBanner', 'rigs.autoOpenSessions', 'rigs.d-particles', 'rigs.d-rotate']) localStorage.setItem(k, 'false');
        localStorage.setItem('rigs.face', '0');
        localStorage.setItem('rigs.cloud', 'false'); // the galaxy is the heaviest thing on the page; nothing here needs it
        sessionStorage.setItem('prefs-check', '1');
      }
    } catch { /* ignore */ }
  });
  page.setDefaultTimeout(120000);
  await page.goto(URL, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !!window.__rigsPrefs && !!document.querySelector('#menubar, #mb-phone'), null, { timeout: 180000 });
  await sleep(1200);
  return page;
}
const openPrefs = async (page) => { await page.evaluate(() => window.__rigsPrefs.open()); await page.waitForSelector('.prefs-win .prefs-row'); await sleep(400); };
const closeAllWindows = (page) => page.evaluate(() => document.querySelectorAll('.prefs-win .win-btn.close').forEach((b) => b.click()));
const rowSel = (id) => `.prefs-row[data-id="${id}"]`;
const waitSaved = (page, id) => page.waitForFunction((s) => { const t = document.querySelector(s)?.textContent || ''; return /Saved|✓/.test(t) || document.querySelector(s)?.classList.contains('err'); }, `${rowSel(id)} .pr-state`, { timeout: 20000 }).catch(() => null);

const browser = await chromium.launch();
try {
  // ------------------------------------------------------------------ desktop
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  let page = await openPage(ctx);

  const brand = await page.evaluate(() => { const b = document.querySelector('#menubar .mb-tops .mb-top'); const r = b?.getBoundingClientRect(); return b && { id: b.id, x: r.left, y: r.top, label: b.getAttribute('aria-label'), text: b.textContent }; });
  check('the JARVIS menu is the first item at the far left of the menu bar', brand?.id === 'mb-top-jarvis' && brand.x < 40 && brand.y < 10, JSON.stringify(brand));
  await page.click('#mb-top-jarvis');
  await page.waitForSelector('.mb-menu');
  const items = await page.$$eval('.mb-menu .mb-item .mb-label', (els) => els.map((e) => e.textContent));
  check('it opens About RIGS OS, System Preferences…, Rescan, Stand down', ['About RIGS OS', 'System Preferences…', 'Rescan the mesh'].every((x) => items.includes(x)) && items.some((x) => /Stand down|Muted/.test(x)), items.join(' | '));
  await shot(page, 'desktop-jarvis-menu');
  await page.click('.mb-menu .mb-item:has-text("About RIGS OS")');
  await page.waitForSelector('.win .about');
  const about = await page.$eval('.win .about', (e) => e.textContent);
  check('About RIGS OS shows version, node and brain', /Version/.test(about) && /This node/.test(about) && /Brain/.test(about), about.replace(/\s+/g, ' ').slice(0, 160));
  await shot(page, 'desktop-about');
  await page.keyboard.press('Escape');
  await sleep(300);

  await page.click('#mb-top-jarvis');
  await page.click('.mb-menu .mb-item:has-text("System Preferences")');
  await page.waitForSelector('.prefs-win .prefs-row');
  await sleep(800);
  check('System Preferences opens as a window with the categories', (await page.$$('.prefs-cat')).length === CATEGORIES.length);
  check('the search field has focus', await page.evaluate(() => document.activeElement?.classList.contains('prefs-search')));
  await shot(page, 'desktop-prefs-general');

  // Every category: a row per item, each with its control (no "Not reported" for server items).
  let bad = [];
  for (const c of CATEGORIES) {
    await page.click(`.prefs-cat[data-cat="${c.id}"]`);
    await sleep(120);
    const got = await page.$$eval('.prefs-content .prefs-row', (rows) => rows.map((r) => ({ id: r.dataset.id, ctl: !!r.querySelector('.pr-ctl > *'), missing: /Not reported|Not available/.test(r.textContent) })));
    const want = c.items.map((i) => i.id);
    if (got.length !== want.length) bad.push(`${c.id}: ${got.length}/${want.length} rows`);
    for (const g of got) if (!g.ctl || g.missing) bad.push(`${g.id}${g.missing ? ' not reported' : ' no control'}`);
  }
  check('every category renders every item with a control', !bad.length, bad.slice(0, 8).join('; '));
  const nullText = async () => page.evaluate(() => { const w = document.createTreeWalker(document.querySelector('.prefs'), NodeFilter.SHOW_TEXT); const out = []; while (w.nextNode()) if (/^\s*(null|undefined)\s*$/.test(w.currentNode.textContent)) out.push(w.currentNode.parentElement?.className); return out; });
  for (const c of ['appearance', 'routing', 'connectors', 'brain']) { await page.click(`.prefs-cat[data-cat="${c}"]`); await sleep(300); await shot(page, `desktop-prefs-${c}`); }

  // A server switch: quick fast path, saved via POST /api/local/settings and still there after a reload.
  const before = (await getSetting('quick.enabled'))?.value;
  await page.click('.prefs-cat[data-cat="routing"]');
  await sleep(200);
  await page.click(`${rowSel('quick.enabled')} .pr-switch`);
  await waitSaved(page, 'quick.enabled');
  const state = await page.$eval(`${rowSel('quick.enabled')} .pr-state`, (e) => e.textContent);
  const after = (await getSetting('quick.enabled'))?.value;
  check('flipping Fast path saves it on the server (GET /api/local/settings)', typeof before === 'boolean' && after === !before, `${before} → ${after}; row says “${state}”`);
  await shot(page, 'desktop-prefs-saved');
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !!window.__rigsPrefs);
  await sleep(1000);
  await page.evaluate(() => window.__rigsPrefs.open('routing'));
  await page.waitForSelector(`${rowSel('quick.enabled')} .pr-switch`);
  await page.waitForFunction((s) => !document.querySelector(s)?.disabled, `${rowSel('quick.enabled')} .pr-switch`);
  const shown = await page.$eval(`${rowSel('quick.enabled')} .pr-switch`, (b) => b.getAttribute('aria-checked'));
  check('…and the window shows it after a reload', shown === String(after), shown);
  await page.click(`${rowSel('quick.enabled')} .pr-switch`); // put it back
  await waitSaved(page, 'quick.enabled');
  check('…and flipping it back restores it', (await getSetting('quick.enabled'))?.value === before);

  // A bad value shows the real error and saves nothing.
  await page.click('.prefs-cat[data-cat="privacy"]');
  await sleep(200);
  await page.fill(`${rowSel('traces.days')} .pr-num`, '0');
  await page.press(`${rowSel('traces.days')} .pr-num`, 'Enter');
  await sleep(500);
  const err = await page.$eval(`${rowSel('traces.days')} .pr-state`, (e) => ({ text: e.textContent, err: e.classList.contains('err') }));
  check('an out-of-range number shows the real message', err.err && /between 1 and 3650/.test(err.text), err.text);
  check('…and nothing changed on the server', (await getSetting('traces.days'))?.value === 14);

  // Secrets: status only, never the value.
  await page.click('.prefs-cat[data-cat="connectors"]');
  await sleep(300);
  const sec = await page.$eval(`${rowSel('linear.apiKey')} .pr-secret`, (e) => e.textContent);
  const html = await page.content();
  check('a secret shows set · len=N and never its value', /set · len=22/.test(sec) && !html.includes(SECRET), sec);

  // UI pref ⇄ left panel: Labels.
  await page.click('.prefs-cat[data-cat="appearance"]');
  await sleep(200);
  const lbl0 = await page.$eval('#d-labels', (e) => e.checked);
  await page.click(`${rowSel('ui.labels')} .pr-switch`);
  await sleep(300);
  const lbl1 = await page.$eval('#d-labels', (e) => e.checked);
  const stored = await page.evaluate(() => localStorage.getItem('rigs.d-labels'));
  check('a UI pref switched here moves the left panel control and storage', lbl1 === !lbl0 && stored === String(!lbl0), `${lbl0} → ${lbl1}, rigs.d-labels=${stored}`);
  await page.evaluate(() => { const b = document.getElementById('d-labels'); b.click(); });
  await sleep(1800);
  const sw = await page.$eval(`${rowSel('ui.labels')} .pr-switch`, (b) => b.getAttribute('aria-checked'));
  check('…and the left panel control moves the switch here', sw === String(lbl0), sw);
  // Theme select → applyTheme + #d-theme.
  await page.selectOption(`${rowSel('ui.theme')} select`, 'atari').catch(() => null);
  await sleep(400);
  const th = await page.evaluate(() => ({ attr: document.documentElement.dataset.theme || 'jarvis', sel: document.getElementById('d-theme').value }));
  check('the theme select applies the theme and moves the left panel select', th.attr === 'atari' && th.sel === 'atari', JSON.stringify(th));
  await shot(page, 'desktop-prefs-appearance-atari');
  await page.selectOption(`${rowSel('ui.theme')} select`, 'jarvis');
  await sleep(300);

  // Search across categories.
  await page.fill('.prefs-search', 'token');
  await sleep(300);
  const srch = await page.$$eval('.prefs-content .prefs-sec', (els) => els.map((e) => e.textContent.trim()));
  check('search finds settings across several categories', srch.length >= 2, srch.join(', '));
  await shot(page, 'desktop-prefs-search');
  check('no stray null / undefined text in the window', !(await nullText()).length, (await nullText()).join(', '));
  await page.focus('.prefs-search');
  await page.keyboard.press('Escape');
  await sleep(200);
  const cleared = await page.evaluate(() => ({ q: document.querySelector('.prefs-search').value, open: !!document.querySelector('.prefs-win') }));
  check('Esc clears the search first, the window stays', cleared.q === '' && cleared.open);

  // Keyboard: ↓ from search into the list, ↑/↓ move between categories, Esc closes.
  await page.focus('.prefs-search');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  await sleep(200);
  const kb = await page.evaluate(() => ({ focus: document.activeElement?.dataset?.cat, title: document.querySelector('.prefs-title')?.textContent }));
  check('↓ walks the categories and shows each', kb.focus === 'appearance' && /Appearance/.test(kb.title), JSON.stringify(kb));
  const aria = await page.$$eval('.prefs-content .prefs-row', (rows) => rows.filter((r) => { const c = r.querySelector('.pr-ctl button, .pr-ctl select, .pr-ctl input, .pr-ctl textarea, .pr-ctl .pr-value, .pr-ctl .pr-secret, .pr-ctl [role=group]'); return !c || !(c.getAttribute('aria-labelledby') || c.getAttribute('aria-label')); }).map((r) => r.dataset.id));
  check('every control has an accessible name', !aria.length, aria.join(', '));
  await page.keyboard.press('Escape');
  await sleep(500);
  check('Esc closes the window', !(await page.$('.prefs-win')));
  const mod = await page.evaluate(() => /Mac/.test(navigator.platform) ? 'Meta' : 'Control');
  await page.click('#graph', { position: { x: 700, y: 500 } }).catch(() => null);
  await page.keyboard.press(`${mod}+Comma`);
  await sleep(600);
  check(`${mod}+, opens System Preferences`, !!(await page.$('.prefs-win')));
  await closeAllWindows(page);
  await ctx.close();

  // ------------------------------------------------------------------ phone 390x844
  const pctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  page = await openPage(pctx);
  await page.click('#mb-phone');
  await page.waitForSelector('.mb-phone-menu');
  await page.click('.mb-phone-menu .mb-item:has-text("JARVIS")');
  await sleep(300);
  const pitems = await page.$$eval('.mb-phone-menu .mb-item .mb-label', (els) => els.map((e) => e.textContent));
  check('phone: the ⋮ menu drills into the JARVIS menu', pitems.includes('System Preferences…'), pitems.join(' | '));
  await shot(page, 'phone-jarvis-menu');
  await page.click('.mb-phone-menu .mb-item:has-text("System Preferences")');
  await page.waitForSelector('.prefs-win .prefs-cat');
  await sleep(600);
  const list = await page.evaluate(() => ({ narrow: document.querySelector('.prefs').classList.contains('narrow'), side: getComputedStyle(document.querySelector('.prefs-side')).display, pane: getComputedStyle(document.querySelector('.prefs-pane')).display, w: document.querySelector('.prefs-win').getBoundingClientRect().width }));
  check('phone: the window is full width and shows the category list', list.narrow && list.side !== 'none' && list.pane === 'none' && list.w >= 380, JSON.stringify(list));
  await shot(page, 'phone-prefs-list');
  await page.click('.prefs-cat[data-cat="appearance"]');
  await sleep(500);
  const drilled = await page.evaluate(() => ({ side: getComputedStyle(document.querySelector('.prefs-side')).display, back: getComputedStyle(document.querySelector('.prefs-back')).display, rows: document.querySelectorAll('.prefs-content .prefs-row').length, overflow: document.querySelector('.prefs-content').scrollWidth - document.querySelector('.prefs-content').clientWidth }));
  check('phone: a category drills in with a Back button and no sideways scroll', drilled.side === 'none' && drilled.back !== 'none' && drilled.rows > 0 && drilled.overflow <= 1, JSON.stringify(drilled));
  const phoneOnly = await page.$$eval('.prefs-content .prefs-row', (rows) => rows.map((r) => r.dataset.id));
  check('phone: desktop-only items (docking, smart scaling, menu bar) are left out', !phoneOnly.includes('ui.docking') && !phoneOnly.includes('ui.scaling') && !phoneOnly.includes('ui.menubarHidden'));
  await shot(page, 'phone-prefs-appearance');
  await page.click('.prefs-cat[data-cat="appearance"]').catch(() => null);
  await page.click('.prefs-back');
  await sleep(300);
  check('phone: Back returns to the list', await page.evaluate(() => getComputedStyle(document.querySelector('.prefs-side')).display !== 'none'));
  await page.click('.prefs-cat[data-cat="routing"]');
  await sleep(600);
  await shot(page, 'phone-prefs-routing');
  await page.click('.prefs-back');
  await sleep(200);
  await page.fill('.prefs-search', 'voice');
  await sleep(400);
  const ps = await page.evaluate(() => ({ rows: document.querySelectorAll('.prefs-content .prefs-row').length, pane: getComputedStyle(document.querySelector('.prefs-pane')).display }));
  check('phone: search shows results under the field', ps.rows > 0 && ps.pane !== 'none', JSON.stringify(ps));
  await shot(page, 'phone-prefs-search');
  await pctx.close();
} finally {
  await browser.close();
  server.stop();
}
const real = errors.filter((e) => !/WebGL|ResizeObserver loop/i.test(e));
check('no page errors', !real.length, real.slice(0, 3).join(' | '));
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed · screenshots in ${OUT}`);
process.exit(failed.length ? 1 : 0);
