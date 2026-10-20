#!/usr/bin/env node
// Ask JARVIS check: drives JARVIS in headless Chromium (Playwright from RIGS_AUDIT_TOOLS or ~/.cache/rigs-audit, as
// scripts/dock-check.js) and checks the Ask panel end to end, saving screenshots on the way: the default top bar
// slot, the drop target lit up mid-drag over the menu bar, ⏏ back to the last floating rect, docked beside a panel,
// the Window menu commands, ⌘/Ctrl+K with a hidden menu bar, reload persistence of every placement, sending, history,
// push-to-talk and hands-free from each placement, and phones (390x844) keeping it in the bottom toolbar.
//   node scripts/ask-check.js [--url http://127.0.0.1:4719/] [--out /tmp/ask-panel-shots]
// Without --url it starts a throwaway `rigs serve` (scratch RIGS_HOME, no OpenRig, no migrations, no autoupdate).
// Requests are stubbed in the page (jarvis/send never reaches a brain). Exit code 1 when a check fails.
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
const OUT = path.resolve(opt('out', path.join(os.tmpdir(), 'ask-panel-shots')));
fs.mkdirSync(OUT, { recursive: true });

async function startServer() {
  if (opt('url', '')) return { url: opt('url', ''), stop() {} };
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'rigs-ask-'));
  const port = await new Promise((resolve, reject) => { const s = net.createServer(); s.once('error', reject); s.listen(0, '127.0.0.1', () => { const { port: p } = s.address(); s.close(() => resolve(p)); }); });
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ port, openrig: { registerPeers: false } }));
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

const rect = (page, sel) => page.evaluate((s) => { const b = document.querySelector(s)?.getBoundingClientRect(); return b && { x: b.left, y: b.top, w: b.width, h: b.height }; }, sel);
/** Where the field is: 'topbar' | 'panel' | 'bar' | other. */
const where = (page) => page.evaluate(() => {
  const a = document.getElementById('ask');
  return a.closest('#menubar-ask-slot') ? 'topbar' : a.closest('#ask-panel') ? 'panel' : a.closest('#bar') ? 'bar' : a.parentElement?.id || '?';
});
/** Where the panel is placed (its inline geometry), not its box mid entrance animation (scale .96). */
const placed = (page) => page.evaluate(() => { const s = document.getElementById('ask-panel').style; return { x: parseFloat(s.left), y: parseFloat(s.top), w: parseFloat(s.width) }; });
const saved = (page) => page.evaluate(() => JSON.parse(localStorage.getItem('rigs.askPanel') || 'null'));
const panelShown = (page) => page.evaluate(() => { const p = document.getElementById('ask-panel'); return getComputedStyle(p).display !== 'none' && !p.classList.contains('panel-closed'); });

/** A point on the Ask panel's title bar that is not a control. */
async function grab(page, sel = '#ask-panel .ask-head') {
  return page.evaluate((s) => {
    const el = document.querySelector(s);
    const r = el.getBoundingClientRect();
    const y = r.top + Math.min(r.height / 2, 10);
    for (let x = r.left + 30; x < r.right - 4; x += 4) {
      const hit = document.elementFromPoint(x, y);
      if (hit && el.contains(hit) && !hit.closest('button,a,input,select,textarea,label,[role=button],.presize,.pgrip')) return { x, y };
    }
    return null;
  }, sel);
}

async function drag(page, from, to, { steps = 16, shot = null, hold = false } = {}) {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  for (let i = 1; i <= steps; i++) { await page.mouse.move(from.x + ((to.x - from.x) * i) / steps, from.y + ((to.y - from.y) * i) / steps); await sleep(16); }
  await sleep(300);
  if (shot) await page.screenshot({ path: path.join(OUT, shot) });
  if (!hold) { await page.mouse.up(); await sleep(450); }
}

/** Run a command from the top menu bar: open the menu, click the item by its label. */
async function menu(page, top, label) {
  await page.click(`#mb-top-${top}`);
  await sleep(200);
  await page.locator('.mb-menu .mb-item', { hasText: label }).first().click();
  await sleep(450);
}

/** Send, history, push-to-talk and hands-free from wherever the field is now. */
async function exercise(page, label) {
  const sent = page._sent;
  const n = sent.length;
  await page.click('#ask');
  await page.fill('#ask', `${label} one`);
  await page.keyboard.press('Enter');
  await sleep(250);
  await page.fill('#ask', `${label} two`);
  if (await page.evaluate(() => { const b = document.getElementById('ask-send'); return b && b.offsetParent !== null; })) await page.click('#ask-send');
  else await page.keyboard.press('Enter');
  for (let i = 0; i < 40 && sent.length < n + 2; i++) await sleep(250); // a busy machine is slow to send
  const texts = sent.slice(n).map((b) => b.text);
  check(`${label}: requests are sent`, texts.includes(`${label} one`) && texts.includes(`${label} two`), JSON.stringify(texts));
  await page.focus('#ask');
  await page.keyboard.press('ArrowUp');
  const h1 = await page.inputValue('#ask');
  await page.keyboard.press('ArrowUp');
  const h2 = await page.inputValue('#ask');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  const h3 = await page.inputValue('#ask');
  check(`${label}: ↑/↓ history`, h1 === `${label} two` && h2 === `${label} one` && h3 === '', JSON.stringify([h1, h2, h3]));
  const before = await page.evaluate(() => document.getElementById('orb-state').textContent);
  await page.click('#btn-mic');
  await sleep(500);
  const ptt = await page.evaluate(() => ({ state: document.getElementById('orb-state').textContent, toast: document.querySelector('#toasts .toast:last-child')?.textContent || '' }));
  check(`${label}: push-to-talk responds`, ptt.state !== before || /microphone|record/i.test(ptt.toast) || /LISTEN/.test(ptt.state), JSON.stringify(ptt));
  await page.click('#btn-mic').catch(() => {}); // stop listening
  await sleep(200);
  await page.click('#btn-hands');
  await sleep(300);
  const hands = await page.evaluate(() => document.getElementById('btn-hands').getAttribute('aria-pressed'));
  await page.click('#btn-hands');
  await sleep(200);
  check(`${label}: hands-free toggles`, hands === 'true', hands);
}

async function openPage(ctx) {
  const page = await ctx.newPage();
  page._sent = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('crash', () => console.log('!! page crashed'));
  // A live mesh raises "agent needs you" toasts and banners over the controls: keep the screen quiet. Auto-opened
  // session popups are off too (they would cover the panels), and so are the face and the galaxy's motion, which
  // only cost CPU here (a busy machine makes the checks time out).
  await page.addInitScript(() => {
    try {
      for (const k of ['rigs.notifications', 'rigs.attnBanner', 'rigs.autoOpenSessions', 'rigs.d-particles', 'rigs.d-rotate']) localStorage.setItem(k, 'false');
      localStorage.setItem('rigs.face', '0');
    } catch { /* ignore */ }
    // A silent microphone: push-to-talk and hands-free really start listening, but hear nothing to transcribe
    // (Chromium's fake device beeps, which keeps the hearing pipeline busy on a loaded machine).
    if (navigator.mediaDevices) navigator.mediaDevices.getUserMedia = async () => new AudioContext().createMediaStreamDestination().stream;
  });
  page.setDefaultTimeout(90000);
  if (process.env.ASK_CHECK_DEBUG) page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') console.log('console', m.type(), m.text().slice(0, 200)); });
  await page.route('**/jarvis/send', async (route) => {
    try { page._sent.push(JSON.parse(route.request().postData() || '{}')); } catch { /* keep going */ }
    await route.fulfill({ status: 200, contentType: 'application/x-ndjson', body: `${JSON.stringify({ type: 'done', text: 'Stubbed reply.' })}\n` });
  });
  return page;
}
async function load(page) {
  await page.goto(URL, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#panels-btn', { state: 'attached' }); // on a phone it lives in the ⋯ sheet
  await sleep(1300);
}
async function reload(page) { await page.reload({ waitUntil: 'domcontentloaded' }); await page.waitForSelector('#panels-btn', { state: 'attached' }); await sleep(1300); }

const browser = await chromium.launch({ args: ['--no-sandbox'] });
const errors = [];

// ------------------------------------------------------------------ desktop 1440x900
{
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, permissions: ['microphone'] });
  const page = await openPage(ctx);
  await load(page);

  // Default: docked in the top bar; the panel is hidden; #bar keeps its other buttons.
  check('default: Ask is in the top bar slot', (await where(page)) === 'topbar');
  check('default: the Ask panel is hidden', !(await panelShown(page)));
  check('#bar keeps its other buttons, not the field', await page.evaluate(() => !document.querySelector('#bar #ask') && !!document.querySelector('#bar #btn-term') && !!document.querySelector('#bar #btn-mute')));
  const slot = await rect(page, '#menubar-ask-slot');
  check('the slot sits on the right side of the menu bar', slot && slot.x > 1440 / 2 && slot.y >= 0 && slot.y + slot.h <= 32, JSON.stringify(slot));
  await page.screenshot({ path: path.join(OUT, 'topbar-docked-1440.png') });
  await exercise(page, 'topbar');
  await page.focus('#ask');
  await sleep(350);
  const grown = await rect(page, '#ask');
  check('the inline field expands on focus', grown.w > 240, JSON.stringify(grown));
  await page.screenshot({ path: path.join(OUT, 'topbar-focused-1440.png') });

  // ⏏: out to a floating panel (first time: its default place).
  await page.click('.mb-ask-undock');
  await sleep(600);
  check('⏏ floats it', (await where(page)) === 'panel' && (await panelShown(page)));
  check('floating mode persisted', (await saved(page))?.mode === 'floating', JSON.stringify(await saved(page)));

  // Drag the floating panel somewhere and resize its width (docking mode off).
  const start = await rect(page, '#ask-panel');
  const g = await grab(page);
  await drag(page, g, { x: g.x - 300, y: g.y + 260 });
  const moved = await rect(page, '#ask-panel');
  const e = await rect(page, '#ask-panel .presize-e');
  await drag(page, { x: e.x + e.w / 2, y: e.y + e.h / 2 }, { x: e.x + e.w / 2 + 120, y: e.y + e.h / 2 });
  const sized = await rect(page, '#ask-panel');
  check('floating: drags by its title bar', Math.abs(moved.x - (start.x - 300)) < 3 && Math.abs(moved.y - (start.y + 260)) < 3, JSON.stringify({ start, moved }));
  check('floating: resizes in width', sized.w > moved.w + 100, JSON.stringify({ moved, sized }));
  await reload(page);
  const afterReload = await placed(page);
  check('floating: place survives a reload', (await where(page)) === 'panel' && Math.abs(afterReload.x - sized.x) < 3 && Math.abs(afterReload.y - sized.y) < 3 && Math.abs(afterReload.w - sized.w) < 3, JSON.stringify({ sized, afterReload }));
  await page.screenshot({ path: path.join(OUT, 'floating-1440.png') });
  await exercise(page, 'floating');

  // Drag the title bar over the menu bar: the slot lights up; let go: it is docked there (docking mode off).
  const g2 = await grab(page);
  await drag(page, g2, { x: 1000, y: 14 }, { hold: true, shot: 'drop-target-mid-drag-1440.png' });
  const mid = await page.evaluate(() => ({ preview: !!document.querySelector('.dock-preview.show'), label: document.querySelector('.dock-label.show')?.textContent || '', target: document.getElementById('menubar-ask-slot').classList.contains('mb-ask-target') }));
  check('mid-drag over the menu bar: highlighted drop target (docking off)', mid.preview && mid.target && /top bar/i.test(mid.label), JSON.stringify(mid));
  await page.mouse.up();
  await sleep(600);
  check('dropping on the menu bar docks it in the top bar', (await where(page)) === 'topbar' && !(await panelShown(page)));
  check('the drop target is gone after the drop', await page.evaluate(() => !document.querySelector('.dock-preview.show') && !document.getElementById('menubar-ask-slot').classList.contains('mb-ask-target')));
  await reload(page);
  check('top bar: survives a reload', (await where(page)) === 'topbar');
  check('top bar: left out of the ☰ panel list', await page.evaluate(() => { document.getElementById('panels-btn').click(); const t = document.getElementById('panels-menu').textContent; document.getElementById('panels-btn').click(); return !/Ask JARVIS/.test(t); }));

  // ⏏ pops it back out at its last floating rect.
  await page.click('.mb-ask-undock');
  await sleep(600);
  const back = await placed(page);
  check('⏏ returns it to its last floating rect', Math.abs(back.x - sized.x) < 3 && Math.abs(back.y - sized.y) < 3, JSON.stringify({ sized, back }));

  // Window menu: Dock to top bar / Float / Hide, and ⌘/Ctrl+K reopens.
  await menu(page, 'window', 'Dock Ask JARVIS to top bar');
  check('Window › Dock Ask JARVIS to top bar', (await where(page)) === 'topbar');
  await menu(page, 'window', 'Float Ask JARVIS');
  check('Window › Float Ask JARVIS', (await where(page)) === 'panel' && (await panelShown(page)));
  await menu(page, 'window', 'Hide Ask JARVIS');
  check('Window › Hide Ask JARVIS', !(await panelShown(page)) && (await saved(page))?.mode === 'hidden');
  await reload(page);
  check('hidden: survives a reload', !(await panelShown(page)) && (await saved(page))?.mode === 'hidden');
  await page.mouse.click(720, 500);
  await page.keyboard.press('ControlOrMeta+k');
  await sleep(500);
  check('⌘/Ctrl+K reopens and focuses it', (await panelShown(page)) && (await page.evaluate(() => document.activeElement?.id)) === 'ask');
  await page.click('#ask-panel .pclose[aria-label^="Close"]');
  await sleep(400);
  check('✕ in its title bar hides it', !(await panelShown(page)) && (await saved(page))?.mode === 'hidden');
  await page.mouse.click(720, 500);
  await page.keyboard.press('ControlOrMeta+k');
  await sleep(500);

  // Hidden menu bar: a top bar Ask peeks with it on ⌘/Ctrl+K.
  await page.click('#ask-panel .ask-pin');
  await sleep(500);
  check('⤒ in the title bar docks it in the top bar', (await where(page)) === 'topbar');
  await page.mouse.click(720, 500);
  await page.keyboard.press('ControlOrMeta+Shift+m');
  await sleep(400);
  await page.mouse.click(720, 500);
  await page.keyboard.press('ControlOrMeta+k');
  await sleep(500);
  const peek = await page.evaluate(() => ({ hidden: document.body.classList.contains('mb-hidden'), peek: document.body.classList.contains('mb-peek'), focus: document.activeElement?.id, top: document.getElementById('ask').getBoundingClientRect().top }));
  check('menu bar hidden: ⌘/Ctrl+K peeks the bar and focuses the field', peek.hidden && peek.peek && peek.focus === 'ask' && peek.top >= 0, JSON.stringify(peek));
  await page.screenshot({ path: path.join(OUT, 'topbar-peek-hidden-menubar-1440.png') });
  await page.keyboard.press('Escape');
  await page.mouse.click(720, 500);
  await page.keyboard.press('ControlOrMeta+Shift+m');
  await sleep(400);

  // Docking mode on: float, then dock beside the Active projects panel.
  await page.click('#panels-btn');
  await sleep(200);
  await page.check('#panels-menu .pm-dock input');
  await page.click('#panels-btn');
  await sleep(300);
  await menu(page, 'window', 'Float Ask JARVIS');
  await sleep(800); // let the panel's entrance and focus flash settle
  const isDocked = () => page.evaluate(() => document.getElementById('ask-panel').classList.contains('docked'));
  for (let attempt = 0; attempt < 2 && !(await isDocked()); attempt++) {
    const work = await rect(page, '#work');
    const g3 = await grab(page);
    await drag(page, g3, { x: work.x + 12, y: work.y + work.h / 2 }, { hold: true, shot: 'dock-zones-mid-drag-1440.png' });
    const lifted = await page.evaluate(() => document.getElementById('ask-panel').className);
    await page.mouse.up();
    await sleep(600);
    if (!(await isDocked())) console.log(`   (dock attempt ${attempt + 1}: grab ${JSON.stringify(g3)}, panel ${lifted})`);
  }
  const docked = await isDocked();
  check('docking on: docks beside a panel', docked && (await saved(page))?.mode === 'docked', JSON.stringify(await saved(page)));
  await reload(page);
  check('docked: survives a reload', await page.evaluate(() => document.getElementById('ask-panel').classList.contains('docked')) && (await where(page)) === 'panel');
  await page.screenshot({ path: path.join(OUT, 'docked-beside-panel-1440.png') });
  await exercise(page, 'docked');
  // From docked into the top bar by dragging (docking mode on), then back out.
  const g4 = await grab(page);
  await drag(page, g4, { x: 1000, y: 12 });
  check('docking on: dragging a docked Ask onto the menu bar puts it there', (await where(page)) === 'topbar');
  await page.click('.mb-ask-undock');
  await sleep(500);
  check('⏏ after docked: floats again', (await where(page)) === 'panel' && (await saved(page))?.mode === 'floating');
  // Reset layout: back to the default, the top bar.
  await page.click('#panels-btn');
  await sleep(200);
  await page.locator('#panels-menu .ibtn', { hasText: 'Reset layout' }).click();
  await sleep(600);
  check('Reset layout puts Ask back in the top bar', (await where(page)) === 'topbar');
  await ctx.close();
}

// ------------------------------------------------------------------ phone 390x844
{
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, permissions: ['microphone'] });
  const page = await openPage(ctx);
  await page.addInitScript(() => { try { if (!sessionStorage.getItem('seeded')) { localStorage.setItem('rigs.askPanel', JSON.stringify({ mode: 'floating', rect: { x: 40, y: 80, w: 500, h: 90 }, last: 'floating' })); sessionStorage.setItem('seeded', '1'); } } catch { /* ignore */ } });
  await load(page);
  const st = await page.evaluate(() => {
    const ask = document.getElementById('ask').getBoundingClientRect();
    return {
      inBar: !!document.querySelector('#bar > #ask'), panel: getComputedStyle(document.getElementById('ask-panel')).display,
      slot: !!document.getElementById('menubar-ask-slot')?.offsetParent, bottom: ask.bottom, w: ask.width,
      overflow: document.documentElement.scrollWidth - window.innerWidth, hands: document.getElementById('btn-hands').parentElement.id,
    };
  });
  check('phone: Ask stays at the bottom in the toolbar (even with a saved floating placement)', st.inBar && st.bottom > 844 - 80 && st.w > 150, JSON.stringify(st));
  check('phone: no Ask panel, no top bar slot', st.panel === 'none' && !st.slot);
  check('phone: no horizontal overflow', st.overflow <= 0, String(st.overflow));
  check('phone: 👂 lives in the ⋯ sheet as before', st.hands === 'more-sheet', st.hands);
  await page.screenshot({ path: path.join(OUT, 'phone-390x844.png') });
  await page.tap('#ask');
  await page.fill('#ask', 'phone one');
  await page.keyboard.press('Enter');
  for (let i = 0; i < 40 && !page._sent.length; i++) await sleep(250);
  check('phone: sending works', page._sent.some((b) => b.text === 'phone one'));
  await ctx.close();
}

await browser.close();
server.stop();
check('no page errors', errors.length === 0, errors.slice(0, 5).join(' | '));
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed · screenshots in ${OUT}`);
process.exit(failed.length ? 1 : 0);
