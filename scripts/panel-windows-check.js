#!/usr/bin/env node
// Panels-as-windows check: drives JARVIS in headless Chromium (Playwright from RIGS_AUDIT_TOOLS or ~/.cache/rigs-audit,
// as scripts/window-chrome-check.js) and checks every JARVIS panel end to end: the wm.js title bar buttons (– □ ✕, same
// classes and size as a window's), maximize → the whole stage → restore → the exact rect, minimize → its title strip +
// a minimized mark in the app dock → a dock click restores it, close → reopen from the Panels menu at the same place,
// the states surviving a reload ('rigs.dock' version 3), a saved version 2 docked layout migrating (collapsed →
// minimized, the tab coming back to its group), docked maximize / minimize, Reset layout, and the phone (390x844):
// only ✕, the back gesture closes a sheet, ☰ stays. Screenshots at 1440x900 and 390x844.
//   node scripts/panel-windows-check.js [--url http://127.0.0.1:4719/] [--out /tmp/panels-to-windows/t2]
// Without --url it starts a throwaway `rigs serve` (scratch RIGS_HOME, no OpenRig, no migrations, no autoupdate).
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
const OUT = path.resolve(opt('out', '/tmp/panels-to-windows/t2').replace(/^~/, os.homedir()));
fs.mkdirSync(OUT, { recursive: true });

async function startServer() {
  if (opt('url', '')) return { url: opt('url', ''), stop() {} };
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'rigs-panelwin-'));
  const port = await new Promise((resolve, reject) => { const s = net.createServer(); s.once('error', reject); s.listen(0, '127.0.0.1', () => { const { port: p } = s.address(); s.close(() => resolve(p)); }); });
  const apps = [['notes', 'Notes', '📝']].map(([id, name, icon], i) => ({ id, name, icon, port: 47970 + i }));
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ port, openrig: { registerPeers: false }, apps }));
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, ok, extra = '') => { results.push({ name, ok: !!ok }); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${extra ? ' — ' + extra : ''}`); };
const errors = [];
const shot = (page, name) => page.screenshot({ path: path.join(OUT, name) });
const P = (id) => `[data-dock-id="${id}"]`;

async function ready(page) {
  await page.goto(URL, { waitUntil: 'domcontentloaded' });
  // The panels are registered and the mesh snapshot is in (an applet tile shows): Files then has a machine to open.
  await page.waitForFunction(() => document.querySelectorAll('.floating .pctl').length >= 10 && Object.keys(globalThis.__rigsAppDock?.state.items || {}).some((id) => id.startsWith('applet:')), null, { timeout: 30000 });
  // The scratch server still sees this machine's live agent sessions; their "agent needs you" banner would sit over the
  // top-right corner of every screenshot (and a maximized panel's buttons). Not part of what is checked here.
  await page.addStyleTag({ content: '#attn { display: none !important; }' });
  await sleep(1200);
  await page.mouse.move(700, 450);
}
const rectOf = (page, sel) => page.evaluate((s) => { const el = document.querySelector(s); if (!el) return null; const b = el.getBoundingClientRect(); const cs = getComputedStyle(el); return { x: Math.round(b.left), y: Math.round(b.top), w: Math.round(b.width), h: Math.round(b.height), shown: cs.display !== 'none' && b.width > 0, z: Number(cs.zIndex) || 0 }; }, sel);
/** Wait until an element's animations (open / reveal / minimize) are over: a rect read mid-animation is scaled. */
const settle = (page, sel) => page.waitForFunction((x) => { const el = document.querySelector(x); return !el || (!el.classList.contains('panel-out') && el.getAnimations({ subtree: true }).every((a) => a.playState !== 'running')); }, sel, { timeout: 5000 }).catch(() => {});
const near = (a, b, d = 2) => a && b && ['x', 'y', 'w', 'h'].every((k) => Math.abs(a[k] - b[k]) <= d);
const cls = (page, sel) => page.evaluate((s) => [...(document.querySelector(s)?.classList || [])], sel);
const stored = (page) => page.evaluate(() => JSON.parse(localStorage.getItem('rigs.dock') || 'null'));
const btnInfo = (page, sel) => page.evaluate((s) => [...document.querySelectorAll(s)].map((b) => { const cs = getComputedStyle(b); const r = b.getBoundingClientRect(); return { text: b.textContent, cls: b.className, label: b.getAttribute('aria-label'), w: Math.round(r.width), h: Math.round(r.height), font: cs.fontSize, family: cs.fontFamily, shown: cs.display !== 'none' && r.width > 0 }; }), sel);
/** The stage as docking.js lays it out: below the top menu bar, inside the app dock's edges, 8px in. */
const stageRect = (page) => page.evaluate(() => { const v = (n) => parseFloat(getComputedStyle(document.documentElement).getPropertyValue(n)) || 0; const l = v('--ad-l'); const r = v('--ad-r'); const b = v('--ad-b'); const t = v('--mb-h'); return { x: 8 + l, y: 8 + t, w: innerWidth - 16 - l - r, h: innerHeight - 16 - t - b }; });
/** Click a panel's title bar button. Show all stacks panels at overlapping default places, so the click goes to the element. */
const press = (page, id, btn) => page.locator(`${P(id)} .pctl > .win-btn.${btn}`).first().dispatchEvent('click');
async function menu(page, top, item) {
  await page.click(`#mb-top-${top}`);
  await sleep(200);
  await page.locator('.mb-item').filter({ hasText: item }).first().click();
  await sleep(450);
}
/** The dock tile showing a panel minimized: its own `panel:<id>` tile or its tool tile; a popover tile counts too. */
const dockMark = (page, id) => page.evaluate((pid) => {
  const s = globalThis.__rigsAppDock.state;
  const it = Object.values(s.items).find((x) => x.minimized && (x.id === `panel:${pid}` || x.ref?.id === pid));
  const el = it && document.querySelector(`#app-dock .adock-tile[data-id="${CSS.escape(it.id)}"]`);
  return { id: it?.id || null, tile: !!el, min: !!el?.classList.contains('min'), label: el?.getAttribute('aria-label') || '' };
}, id);

const browser = await chromium.launch();
try {
  // ======================================================================== desktop 1440x900
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(String(e)));
  await ready(page);
  await shot(page, 'default-1440.png'); // the screen as it opens: every panel a window with – □ ✕
  await menu(page, 'panels', 'Show all panels');
  await sleep(500);

  // A wm.js window to compare the chrome with.
  await page.evaluate(() => document.getElementById('btn-files').click());
  await page.waitForSelector('.win.files-win');
  await sleep(400);
  // Measure after the open animation (it scales the window from 96%).
  await page.waitForFunction(() => { const w = document.querySelector('.win.files-win'); return w && !w.classList.contains('win-enter') && w.getAnimations({ subtree: true }).every((a) => a.playState !== 'running'); }, null, { timeout: 5000 }).catch(() => {});
  await sleep(250);
  const winBtns = await btnInfo(page, '.win.files-win .win-bar > .win-btn');
  const ids = await page.evaluate(() => [...document.querySelectorAll('.floating[data-dock-id]')].filter((el) => !el.classList.contains('panel-closed')).map((el) => el.dataset.dockId));
  check('every registered panel is on screen after Show all', ids.length >= 13, ids.join(','));
  const bad = [];
  for (const id of ids) {
    const b = await btnInfo(page, `${P(id)} > .pctl > .win-btn, ${P(id)} .pctl > .win-btn`);
    const sig = b.map((x) => `${x.cls}|${x.text}|${x.w}x${x.h}|${x.font}|${x.family}`);
    const want = winBtns.map((x) => `${x.cls}|${x.text}|${x.w}x${x.h}|${x.font}|${x.family}`);
    if (sig.join() !== want.join() || !b.every((x) => x.shown)) bad.push(`${id}: ${JSON.stringify(sig)}`);
  }
  check('every panel has – □ ✕ identical to a wm.js window (classes, glyphs, size, font)', !bad.length, bad.length ? `window: ${JSON.stringify(winBtns.map((x) => `${x.cls}|${x.text}|${x.w}x${x.h}|${x.font}|${x.family}`))} · ${bad.slice(0, 2).join(' ; ')}` : `${winBtns.map((x) => x.text).join(' ')} on ${ids.length} panels`);
  await page.locator('.win.files-win .win-btn.close').dispatchEvent('click'); // an "agent needs you" banner may sit over it
  await sleep(300);
  await page.mouse.move(700, 450);
  await shot(page, 'all-panels-1440.png');
  await menu(page, 'panels', 'Reset layout'); // the rest on the default screen, where the panels do not overlap
  await sleep(400);

  // ---- maximize / restore (Active projects)
  const before = await rectOf(page, P('work'));
  await press(page, 'work', 'win-max');
  await sleep(450);
  const stage = await stageRect(page);
  const max = await rectOf(page, P('work'));
  check('maximize: the panel fills the stage (below the menu bar, inside the app dock)', near(max, stage, 3), `${JSON.stringify(max)} vs ${JSON.stringify(stage)}`);
  check('maximize: over the other panels, under windows', max.z >= 90 && max.z < 100, String(max.z));
  check('maximize: the button turns into ❐ Restore', (await btnInfo(page, `${P('work')} .win-btn.win-max`))[0].label === 'Restore');
  await shot(page, 'maximized-1440.png');
  await press(page, 'work', 'win-max');
  await sleep(450);
  check('restore: back at the exact previous rect', near(await rectOf(page, P('work')), before), `${JSON.stringify(before)} → ${JSON.stringify(await rectOf(page, P('work')))}`);
  await page.locator(`${P('work')} .wk-head`).dispatchEvent('dblclick');
  await sleep(450);
  const dbl = await cls(page, P('work'));
  check('double-click on the header maximizes, like a window bar', dbl.includes('panel-max'));
  if (dbl.includes('panel-max')) { await press(page, 'work', 'win-max'); await sleep(400); }

  // ---- minimize → strip + dock mark → dock click restores (Chat)
  const chatBefore = await rectOf(page, P('dock'));
  await press(page, 'dock', 'win-min');
  await sleep(450);
  const strip = await rectOf(page, P('dock'));
  const chatCls = await cls(page, P('dock'));
  check('minimize: a floating panel folds to its title strip where it is (its top stays)', chatCls.includes('panel-min') && strip.shown && strip.h < chatBefore.h && Math.abs(strip.x - chatBefore.x) <= 2 && Math.abs(strip.y - chatBefore.y) <= 2, `${JSON.stringify(chatBefore)} → ${JSON.stringify(strip)}`);
  check('minimize: the strip\'s first button is ❐ Restore', (await btnInfo(page, `${P('dock')} .win-btn.win-min`))[0].text === '❐');
  let mark = await dockMark(page, 'dock');
  check('minimize: the app dock shows it minimized', mark.tile && mark.min && /minimized/.test(mark.label), JSON.stringify(mark));
  // Minimize the face too: it keeps its orb (`keep`).
  await press(page, 'orb', 'win-min');
  await sleep(450);
  check('the face minimized keeps its orb, where the face was', await page.evaluate(() => { const o = document.querySelector('#orb'); const f = document.querySelector('#face'); return !!o && o.getBoundingClientRect().width > 0 && o.getBoundingClientRect().top > innerHeight / 3 && (!f || getComputedStyle(f).display === 'none'); }));
  await page.mouse.move(700, 450);
  await shot(page, 'minimized-1440.png');
  await page.click(`#app-dock .adock-tile[data-id="${mark.id}"]`);
  await sleep(500);
  check('a click on the dock tile restores the panel at its rect', near(await rectOf(page, P('dock')), chatBefore) && !(await cls(page, P('dock'))).includes('panel-min'), JSON.stringify(await rectOf(page, P('dock'))));
  mark = await dockMark(page, 'dock');
  check('the dock no longer shows it minimized', !mark.id, JSON.stringify(mark));
  await press(page, 'orb', 'win-min'); // ❐ on the strip restores too
  await sleep(400);
  check('❐ on the strip restores it', !(await cls(page, P('orb'))).includes('panel-min'));

  // ---- close → reopen from the Panels menu at the same place (Filters)
  const legendBefore = await rectOf(page, P('legend'));
  await press(page, 'legend', 'close');
  await sleep(450);
  check('close: the panel goes', !(await rectOf(page, P('legend'))).shown);
  await page.click('#mb-top-panels');
  await sleep(200);
  const unchecked = await page.locator('.mb-item').filter({ hasText: 'Filters' }).first().getAttribute('aria-checked');
  check('the Panels menu lists the closed panel, unchecked', unchecked === 'false', String(unchecked));
  await page.locator('.mb-item').filter({ hasText: 'Filters' }).first().click();
  await sleep(500);
  await settle(page, P('legend'));
  check('reopened from the Panels menu at its previous place', near(await rectOf(page, P('legend')), legendBefore), `${JSON.stringify(legendBefore)} → ${JSON.stringify(await rectOf(page, P('legend')))}`);

  // ---- reload keeps the states
  await press(page, 'orb', 'win-min');
  await press(page, 'questions', 'win-max');
  await sleep(400);
  await ready(page);
  const s1 = await stored(page);
  check('reload: the face is still minimized, Questions still maximized', (await cls(page, P('orb'))).includes('panel-min') && (await cls(page, P('questions'))).includes('panel-max'));
  check("reload: stored as 'rigs.dock' version 3 with minimized / maximized", s1?.version === 3 && s1.minimized.includes('orb') && s1.maximized.includes('questions') && !('collapsed' in s1), JSON.stringify({ v: s1?.version, min: s1?.minimized, max: s1?.maximized }));
  mark = await dockMark(page, 'orb');
  check('reload: the minimized panel is in the app dock again', mark.tile && mark.min, JSON.stringify(mark));
  await shot(page, 'reload-1440.png');

  // ---- Reset layout
  await menu(page, 'panels', 'Tokens & time'); // a default-closed panel, opened
  await menu(page, 'panels', 'Reset layout');
  const s2 = await stored(page);
  check('Reset layout: nothing minimized or maximized, panels at their CSS places', s2.minimized.length === 0 && s2.maximized.length === 0 && !(await cls(page, P('orb'))).includes('panel-min') && !(await cls(page, P('questions'))).includes('panel-max'), JSON.stringify({ min: s2.minimized, max: s2.maximized }));
  check('Reset layout: default-closed panels are closed again', !(await rectOf(page, P('usage'))).shown);

  // ---- a saved version 2 docked layout: migration + docked / tabbed behaviour
  const v2 = {
    version: 2,
    root: { type: 'split', dir: 'row', ratios: [0.19, 0.22, 0.37, 0.22], children: [
      { type: 'panel', id: 'left' },
      { type: 'tabs', panels: ['work', 'questions', 'agents'], active: 'work' },
      { type: 'panel', id: 'stage' },
      { type: 'split', dir: 'column', ratios: [0.55, 0.45], children: [{ type: 'panel', id: 'traces' }, { type: 'panel', id: 'legend' }] },
    ] },
    floating: [{ id: 'dock', x: 420, y: 640, w: 560, h: 200, z: 2, vw: 1440, vh: 900 }],
    hidden: { usage: { kind: 'float', rect: { x: 600, y: 120, w: 380, h: 400, vw: 1440, vh: 900 } } },
    collapsed: ['dock', 'questions', 'usage'],
    windows: {},
  };
  await page.evaluate((L) => { localStorage.setItem('rigs.docking', '1'); localStorage.setItem('rigs.dock', JSON.stringify(L)); }, v2);
  await ready(page);
  const s3 = await stored(page);
  check('v2 docked layout migrates to version 3', s3.version === 3 && s3.minimized.includes('dock') && s3.minimized.includes('questions') && !s3.minimized.includes('usage'), JSON.stringify({ v: s3.version, min: s3.minimized }));
  const tabs = () => page.evaluate(() => [...document.querySelectorAll('.dock-tabs .dock-tab')].map((t) => t.textContent));
  check('a collapsed tab is minimized out of its group; the others stay docked', JSON.stringify(await tabs()) === JSON.stringify(['Active projects', 'Active agents']) && (await cls(page, P('traces'))).includes('docked'), JSON.stringify(await tabs()));
  check('a collapsed floating panel is a title strip; a closed+collapsed one stays closed', (await cls(page, P('dock'))).includes('panel-min') && !(await rectOf(page, P('usage'))).shown);
  await page.mouse.move(700, 450);
  await shot(page, 'docked-1440.png');
  mark = await dockMark(page, 'questions');
  check('the minimized tab is in the app dock', mark.tile && mark.min, JSON.stringify(mark));
  await page.click(`#app-dock .adock-tile[data-id="${mark.id}"]`);
  await sleep(500);
  check('restored from the dock: back in its tab group at its index', JSON.stringify(await tabs()) === JSON.stringify(['Active projects', 'Questions', 'Active agents']), JSON.stringify(await tabs()));
  // Maximize a docked panel: zooms over the stage, the tree stays; restore drops it back into its slot.
  const slot = await rectOf(page, P('traces'));
  await press(page, 'traces', 'win-max');
  await sleep(450);
  check('docked maximize zooms the panel over the whole stage', near(await rectOf(page, P('traces')), await stageRect(page), 3), JSON.stringify(await rectOf(page, P('traces'))));
  check('docked maximize keeps the tree (tabs and splitters stay)', (await tabs()).length === 3 && (await stored(page)).root.children.length === 4);
  await shot(page, 'docked-maximized-1440.png');
  await press(page, 'traces', 'win-max');
  await sleep(450);
  check('restore drops it back into its slot', near(await rectOf(page, P('traces')), slot) && (await cls(page, P('traces'))).includes('docked'), `${JSON.stringify(slot)} → ${JSON.stringify(await rectOf(page, P('traces')))}`);
  // Minimize and close act on the tab.
  await page.locator('.dock-tab:has-text("Active agents")').dispatchEvent('click');
  await sleep(300);
  await press(page, 'agents', 'win-min');
  await sleep(450);
  check('docked minimize takes the tab out of the group', JSON.stringify(await tabs()) === JSON.stringify(['Active projects', 'Questions']), JSON.stringify(await tabs()));
  await page.click(`#app-dock .adock-tile[data-id="${(await dockMark(page, 'agents')).id}"]`);
  await sleep(450);
  await page.locator('.dock-tab:has-text("Questions")').dispatchEvent('click');
  await sleep(300);
  await press(page, 'questions', 'close');
  await sleep(450);
  check('docked close takes the tab out too', JSON.stringify(await tabs()) === JSON.stringify(['Active projects', 'Active agents']), JSON.stringify(await tabs()));
  await page.click('#mb-top-panels');
  await sleep(200);
  await page.locator('.mb-item').filter({ hasText: 'Questions' }).first().click();
  await sleep(450);
  check('reopened from the Panels menu: back in its tab group', JSON.stringify(await tabs()) === JSON.stringify(['Active projects', 'Questions', 'Active agents']), JSON.stringify(await tabs()));
  check('the galaxy has no window buttons and stays in the tree', !(await page.$('.dock-stage .win-btn, #graph .win-btn')) && (await stored(page)).root.children.some((c) => c.id === 'stage'));
  await menu(page, 'panels', 'Reset layout');
  check('Reset layout still works in docking mode', (await stored(page)).minimized.length === 0 && (await tabs()).length === 0);
  await page.evaluate(() => localStorage.setItem('rigs.docking', '0'));
  await ctx.close();

  // ======================================================================== phone 390x844
  const pctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  const ph = await pctx.newPage();
  ph.on('pageerror', (e) => errors.push(String(e)));
  await ready(ph);
  await ph.evaluate(() => document.getElementById('btn-work').click());
  await sleep(600);
  const pw = await btnInfo(ph, `${P('work')} .pctl > .win-btn`);
  check('phone: a panel sheet shows only ✕ (finger size), no minimize or maximize', pw.filter((b) => b.shown).map((b) => b.text).join('') === '✕' && pw.find((b) => b.text === '✕').w >= 44, JSON.stringify(pw.map((b) => [b.text, b.shown, b.w])));
  await shot(ph, 'phone-390.png');
  await ph.goBack().catch(() => {});
  await sleep(600);
  check('phone: the back gesture closes the sheet and stays in JARVIS', !(await rectOf(ph, P('work'))).shown && ph.url().startsWith(URL));
  await ph.evaluate(() => document.getElementById('btn-work').click());
  await sleep(500);
  const pushed = await ph.evaluate(() => history.state?.rigsWin === true);
  await ph.click(`${P('work')} .win-btn.close`);
  await sleep(600);
  const given = await ph.evaluate(() => history.state?.rigsWin !== true);
  check('phone: opening a sheet owns a back entry; closing it with ✕ gives the entry back (no dead back step)', pushed && given && !(await rectOf(ph, P('work'))).shown, JSON.stringify({ pushed, given }));
  const burger = await rectOf(ph, '#drawer-btn');
  check('phone: ☰ stays on screen and cannot be closed', burger?.shown && !(await ph.$('#drawer-btn .win-btn')));
  await ph.evaluate(() => document.getElementById('btn-files').click());
  await ph.waitForSelector('.win.files-win');
  await sleep(500);
  const fw = await rectOf(ph, '.win.files-win');
  check('phone: a window is still full-screen with – and ✕', fw.w >= 388 && (await btnInfo(ph, '.win.files-win .win-bar > .win-btn')).filter((b) => b.shown).map((b) => b.text).join('') === '–✕', JSON.stringify(fw));
  await shot(ph, 'phone-window-390.png');
  await pctx.close();
} finally {
  await browser.close();
  server.stop();
}

check('no page errors', !errors.length, errors.slice(0, 3).join(' | '));
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed · screenshots in ${OUT}`);
process.exit(failed.length ? 1 : 0);
