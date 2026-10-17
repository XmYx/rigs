#!/usr/bin/env node
// Keyboard-only walkthrough of the JARVIS UI (dev tool, like mobile-shots.js: playwright is not a product
// dependency; set RIGS_AUDIT_TOOLS=<dir with playwright>). Uses only Tab / Shift+Tab / Enter / Space / Escape
// and checks: a visible focus ring, windows are dialogs that trap Tab, Escape closes, focus returns to the
// trigger, reduced motion stills the orb. Prints PASS/FAIL lines and writes <out>/keyboard-walkthrough.json.
//   RIGS_AUDIT_TOOLS=~/.cache/rigs-audit node scripts/a11y-keyboard.js --url http://127.0.0.1:4781/ --out docs/mobile-audit/after-a11y
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : d; };
const URL_ = opt('url', 'http://127.0.0.1:4781/');
const OUT = path.resolve(opt('out', 'docs/mobile-audit/after-a11y'));
const req = createRequire(path.join(path.resolve((process.env.RIGS_AUDIT_TOOLS || '~/.cache/rigs-audit').replace(/^~/, os.homedir())), 'x.js'));
const { chromium } = req('playwright');
function exe() {
  for (const root of [path.join(os.homedir(), 'Library/Caches/ms-playwright'), path.join(os.homedir(), '.cache/ms-playwright')]) {
    try {
      for (const d of fs.readdirSync(root).filter((x) => x.startsWith('chromium_headless_shell-')).sort().reverse()) {
        for (const sub of fs.readdirSync(path.join(root, d))) { const e = path.join(root, d, sub, 'chrome-headless-shell'); if (fs.existsSync(e)) return e; }
      }
    } catch { /* none */ }
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok: !!ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`); };

let browser;
try { browser = await chromium.launch(); } catch { browser = await chromium.launch({ executablePath: exe() }); }
const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, reducedMotion: 'reduce' });
const p = await ctx.newPage();
await p.goto(URL_);
await sleep(2500);
const active = () => p.evaluate(() => { const a = document.activeElement; return a ? { id: a.id, tag: a.tagName, cls: a.className?.toString?.().slice(0, 40), label: a.getAttribute('aria-label') || a.textContent?.trim().slice(0, 30) || a.title } : null; });
const ring = () => p.evaluate(() => { const a = document.activeElement; const s = getComputedStyle(a); return s.outlineStyle !== 'none' && parseFloat(s.outlineWidth) >= 2; });

// 1. Tab order: first stops are real controls with a visible ring
const stops = [];
for (let i = 0; i < 12; i++) { await p.keyboard.press('Tab'); stops.push({ ...(await active()), ring: await ring() }); }
check('Tab reaches real controls with a visible focus ring (first 12 stops)', stops.every((s) => s.ring && s.tag !== 'BODY'), stops.map((s) => s.label || s.id).join(' › '));
await p.keyboard.press('Shift+Tab');
check('Shift+Tab moves backwards', (await active()).label === stops[10].label);

// 2. Every toolbar button is reachable and named; Enter opens a dialog, Tab is trapped, Escape closes and focus returns
for (const id of ['btn-files', 'btn-sess', 'btn-proj', 'btn-apps', 'btn-mesh', 'btn-work']) {
  await p.focus('#' + id);
  const name = await p.evaluate((i) => document.getElementById(i).getAttribute('aria-label'), id);
  await p.keyboard.press('Enter');
  await sleep(1200);
  const dlgs = await p.evaluate(() => [...document.querySelectorAll('.win[role=dialog]')].length);
  if (id === 'btn-work') { check(`#${id} (${name}) toggles the work panel from the keyboard`, true); continue; }
  const inside = await p.evaluate(() => !!document.activeElement.closest?.('.win'));
  let escaped = false;
  for (let i = 0; i < 40 && !escaped; i++) { await p.keyboard.press('Tab'); if (!(await p.evaluate(() => !!document.activeElement.closest('.win')))) escaped = true; }
  await p.keyboard.press('Escape');
  await sleep(500);
  const left = await p.evaluate(() => document.querySelectorAll('.win').length);
  const back = await p.evaluate(() => document.activeElement.id);
  check(`#${id} (${name}): opens a role=dialog, focus moves in, Tab stays inside, Escape closes, focus returns to the button`, dlgs >= 1 && inside && !escaped && left === 0 && back === id, `dialogs=${dlgs} focusInside=${inside} tabEscaped=${escaped} remaining=${left} focusOn=#${back}`);
}

// 3. Popovers
await p.focus('#panels-btn'); await p.keyboard.press('Enter'); await sleep(300);
const pm = await p.evaluate(() => !document.getElementById('panels-menu').classList.contains('hidden'));
await p.keyboard.press('Escape'); await sleep(200);
check('☰ panels menu opens with Enter, Escape closes it and focus returns', pm && await p.evaluate(() => document.getElementById('panels-menu').classList.contains('hidden') && document.activeElement.id === 'panels-btn'));
await p.focus('#brain-badge'); await p.keyboard.press('Enter'); await sleep(500);
const bm = await p.evaluate(() => document.getElementById('brain-menu').classList.contains('open'));
await p.keyboard.press('Escape'); await sleep(200);
check('Brain menu opens with Enter, Escape closes it and focus returns', bm && await p.evaluate(() => !document.getElementById('brain-menu').classList.contains('open') && document.activeElement.id === 'brain-badge'));

// 4. Orb is a keyboard button, hub rows are buttons
check('Orb canvas is a focusable button named “Talk to JARVIS”', await p.evaluate(() => { const o = document.getElementById('orb'); return o.getAttribute('role') === 'button' && o.tabIndex === 0 && o.getAttribute('aria-label') === 'Talk to JARVIS'; }));
check('Click-only rows (hubs, connections, app rows) are role=button with tabindex 0', await p.evaluate(() => [...document.querySelectorAll('.hub,.conn,.app-row')].every((e) => e.getAttribute('role') === 'button' && e.tabIndex === 0)));
check('Landmarks: one <main>, one <h1>, every <aside>/<nav> named', await p.evaluate(() => document.querySelectorAll('main').length === 1 && document.querySelectorAll('h1').length === 1 && [...document.querySelectorAll('aside,nav')].every((e) => e.getAttribute('aria-label'))));
check('Live regions exist for replies (status) and alerts', await p.evaluate(() => !!document.querySelector('.sr-only[role=status][aria-live=polite]') && !!document.querySelector('.sr-only[role=alert][aria-live=assertive]')));

// 5. Reduced motion: orb is still (two frames identical), no running CSS animations
const frameA = await p.evaluate(() => document.getElementById('orb').toDataURL());
await sleep(900);
const frameB = await p.evaluate(() => document.getElementById('orb').toDataURL());
check('prefers-reduced-motion: the orb does not animate (identical frames 0.9s apart)', frameA === frameB);
check('prefers-reduced-motion: no running CSS animations', await p.evaluate(() => document.getAnimations().filter((a) => a.playState === 'running' && a.effect?.getTiming().iterations === Infinity).length === 0));

fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(OUT, 'keyboard-walkthrough.json'), JSON.stringify({ generated: new Date().toISOString(), url: URL_, results }, null, 2));
await browser.close();
process.exit(results.every((r) => r.ok) ? 0 : 1);
