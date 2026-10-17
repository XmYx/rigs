#!/usr/bin/env node
// Mobile audit capture: screenshots the main JARVIS views at phone sizes (portrait + landscape), runs
// axe-core on each and records layout/touch metrics. Dev-only tool — playwright and axe-core are NOT
// dependencies of the product. Install them anywhere outside the repo and point at them:
//
//   mkdir -p ~/.cache/rigs-audit && cd ~/.cache/rigs-audit && npm i playwright axe-core
//   RIGS_AUDIT_TOOLS=~/.cache/rigs-audit node scripts/mobile-shots.js --out docs/mobile-audit/before
//
// Options: --out <dir>            output directory (default docs/mobile-audit/after)
//          --url <url>            use a running JARVIS instead of starting one (default: spawn `rigs serve`
//                                 on port 4781 with RIGS_HOME=.rigs-dev, no migrations, no autoupdate)
//          --viewports 390x844,.. override sizes (default 390x844,360x740,844x390,740x360); a width of 1024 or more
//                                 is captured as a desktop (no touch, not mobile) and skips the touch-target check
//          --views a,b            only these views (default all)
//          --reduced-motion       emulate prefers-reduced-motion: reduce
//          --png-all              save PNGs for every viewport (default: all; use --png-primary for 390x844 only)
//          --strict               exit 1 when the overflow or touch-target check fails
// Output: <view>@<W>x<H>.png per view/viewport and report.json (axe violations + metrics per view).
// Checks: every view reports `overflow` (anything wider than the viewport that isn't clipped by a scroll container,
// or a page that scrolls sideways) and, on touch viewports, `smallTargets` (visible controls under 44x44 CSS px; an
// input inside a <label> is measured by its label). The run ends with a CHECK line.
import { spawn } from 'node:child_process';
import net from 'node:net';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const opt = (name, def) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : def; };
const OUT = path.resolve(ROOT, opt('out', 'docs/mobile-audit/after'));
const PORT = 4781;
const VIEWPORTS = opt('viewports', '390x844,360x740,844x390,740x360').split(',').map((s) => s.split('x').map(Number));
const ONLY = opt('views', '') ? opt('views', '').split(',') : null;
const PRIMARY_ONLY = args.includes('--png-primary');
const STRICT = args.includes('--strict');

function loadTools() {
  const dirs = [process.env.RIGS_AUDIT_TOOLS, path.join(os.homedir(), '.cache/rigs-audit'), ROOT].filter(Boolean);
  for (const d of dirs) {
    try {
      const req = createRequire(path.join(path.resolve(d.replace(/^~/, os.homedir())), 'x.js'));
      const pw = req('playwright');
      return { chromium: pw.chromium, axePath: req.resolve('axe-core/axe.min.js') };
    } catch { /* try next */ }
  }
  throw new Error('playwright + axe-core not found. Install them outside the repo and set RIGS_AUDIT_TOOLS=<dir> (see header of scripts/mobile-shots.js).');
}

/** A Chromium from the Playwright cache when the installed playwright's exact revision is missing. */
function fallbackChromium() {
  const base = path.join(os.homedir(), 'Library/Caches/ms-playwright');
  const linux = path.join(os.homedir(), '.cache/ms-playwright');
  for (const root of [base, linux]) {
    try {
      const dirs = fs.readdirSync(root).filter((d) => d.startsWith('chromium_headless_shell-')).sort().reverse();
      for (const d of dirs) {
        const sub = fs.readdirSync(path.join(root, d)).find((s) => s.startsWith('chrome-headless-shell'));
        const exe = sub && path.join(root, d, sub, 'chrome-headless-shell');
        if (exe && fs.existsSync(exe)) return exe;
      }
    } catch { /* none */ }
  }
  return undefined;
}

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
  });
}

async function startServer() {
  if (opt('url', '')) return { url: opt('url', ''), stop() {} };
  const home = path.join(ROOT, '.rigs-dev');
  fs.mkdirSync(home, { recursive: true });
  const cfg = path.join(home, 'config.json');
  // Live mesh data is wanted, but this throwaway node must not register OpenRig hosts or touch the real ~/.ssh
  const c = fs.existsSync(cfg) ? JSON.parse(fs.readFileSync(cfg, 'utf8')) : { port: PORT };
  if (c.openrig?.registerPeers !== false) { c.openrig = { ...c.openrig, registerPeers: false }; fs.writeFileSync(cfg, JSON.stringify(c)); }
  // A free port per run: several worktrees run this check at once, and a fixed port made them capture (and kill) each other's server.
  const port = await freePort();
  const url = `http://127.0.0.1:${port}/`;
  const child = spawn(process.execPath, ['bin/rigs.js', 'serve'], { cwd: ROOT, stdio: 'ignore', env: { ...process.env, RIGS_HOME: home, RIGS_PORT: String(port), RIGS_SSH_DIR: path.join(home, 'ssh'), RIGS_NO_MIGRATIONS: '1', RIGS_NO_AUTOUPDATE: '1' } });
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 500));
    try { const r = await fetch(url); if (r.ok) return { url, stop: () => child.kill() }; } catch { /* wait */ }
  }
  child.kill();
  throw new Error('rigs serve did not come up');
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Phone layout: a control may sit in the ⋯ sheet or the side-panel drawer. Open whichever holds it first. */
async function reach(page, selector) {
  const where = await page.locator(selector).first().evaluate((el) => {
    const r = el.getBoundingClientRect();
    const shown = r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden';
    if (shown && r.right > 0 && r.left < window.innerWidth) return null;
    if (el.closest('#more-sheet')) return '#btn-more';
    if (el.closest('#left')) return '#drawer-btn';
    return null;
  }).catch(() => null);
  if (where && await page.locator(where).isVisible()) { await page.locator(where).click({ timeout: 3000 }).catch(() => {}); await sleep(600); }
}

/** Tap like a finger would; when another element covers the target (itself an audit finding) note it and fall back to a DOM click. */
async function tap(page, selector) {
  await reach(page, selector);
  try { await page.locator(selector).click({ timeout: 3000 }); } catch (e) {
    const by = /intercepts pointer events/.test(e.message) ? (e.message.match(/<[^>]{0,80}>[^\n]*intercepts/) || [''])[0].replace(/ intercepts$/, '') : 'not tappable';
    (page._obscured ||= []).push(`${selector} ${by}`.trim());
    await page.locator(selector).evaluate((el) => el.click());
  }
}

// Each view: how to reach it from a fresh load. `panels: 'none'` starts with every floating panel closed so
// the galaxy graph is visible on its own.
const VIEWS = [
  { name: 'orb-home', run: async () => {} },
  { name: 'galaxy-graph', closePanels: true, run: async () => {} },
  { name: 'left-panel', run: async (p) => { await tap(p, '#search'); await p.keyboard.type('mac'); await sleep(400); } },
  { name: 'more-sheet', mobileOnly: true, run: async (p) => { await tap(p, '#btn-more'); await sleep(400); } },
  { name: 'panels-menu', run: async (p) => { await tap(p, '#panels-btn'); await sleep(400); } },
  { name: 'brain-menu', run: async (p) => { await tap(p, '#brain-badge'); await sleep(400); } },
  { name: 'window-files', run: async (p) => { await tap(p, '#btn-files'); await sleep(1500); } },
  { name: 'terminal', run: async (p) => { await tap(p, '#btn-term'); await sleep(2500); } },
  { name: 'projects', run: async (p) => { await tap(p, '#btn-proj'); await sleep(1500); } },
  { name: 'work-dashboard', run: async (p) => { await tap(p, '#btn-work'); await sleep(1500); } },
  { name: 'sessions', run: async (p) => { await tap(p, '#btn-sess'); await sleep(2000); } },
  { name: 'apps-launcher', run: async (p) => { await tap(p, '#btn-apps'); await sleep(1500); } },
  { name: 'mesh-settings', run: async (p) => { await tap(p, '#btn-mesh'); await sleep(1500); } },
  { name: 'stage-visual-cards', run: async (p) => { await reach(p, '#ask'); await p.locator('#ask').fill('status'); await p.keyboard.press('Enter'); await sleep(2500); } },
  { name: 'voice-controls', run: async (p) => { await tap(p, '#btn-hands'); await sleep(600); await tap(p, '#btn-mic'); await sleep(800); } },
];

/** Layout + touch metrics evaluated in the page. */
function metrics() {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const doc = document.documentElement;
  const vis = (el) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none' && s.opacity !== '0' && (!el.checkVisibility || el.checkVisibility({ opacityProperty: true, visibilityProperty: true })); };
  const sel = (el) => el.id ? `#${el.id}` : `${el.tagName.toLowerCase()}${el.className && typeof el.className === 'string' ? '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.') : ''}`;
  const interactive = [...document.querySelectorAll('button, a[href], a:not([href])[id], input, select, textarea, summary, [role=button], [tabindex]:not([tabindex="-1"]), .hub, .conn, .flt, .bm-item')].filter(vis);
  // A control's hit area: an input wrapped in a <label> is hit anywhere on the label. Off-screen controls (a closed
  // drawer) and scroll regions (focusable for keyboard scrolling, not tap targets) don't count.
  const hit = (el) => (/^(INPUT|SELECT|TEXTAREA)$/.test(el.tagName) && el.closest('label') ? el.closest('label') : el).getBoundingClientRect();
  const onScreen = (r) => r.right > 0 && r.bottom > 0 && r.left < vw && r.top < vh;
  const small = interactive.filter((el) => el.getAttribute('role') !== 'region' && !el.closest('.xterm') && onScreen(el.getBoundingClientRect()))
    .map((el) => { const r = hit(el); return { sel: sel(el), w: Math.round(r.width), h: Math.round(r.height), label: (el.getAttribute('aria-label') || el.getAttribute('title') || el.textContent || '').trim().slice(0, 30) }; })
    .filter((x) => x.w < 44 || x.h < 44);
  // Horizontal overflow: the page scrolls sideways, or a visible element (outside the galaxy) pokes out of the
  // viewport without a scroll container (other than html/body, which only hide it) clipping it.
  const clippedByScroller = (el) => { for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) if (getComputedStyle(p).overflowX !== 'visible') return true; return false; };
  const overflow = [...document.querySelectorAll('body *')].filter((el) => !el.closest('#graph, .scene-tooltip') && vis(el))
    .map((el) => ({ el, r: el.getBoundingClientRect() }))
    .filter(({ el, r }) => onScreen(r) && (r.right > vw + 1 || r.left < -1) && !clippedByScroller(el))
    .map(({ el, r }) => ({ sel: sel(el), left: Math.round(r.left), right: Math.round(r.right) }));
  if (doc.scrollWidth > vw + 1) overflow.unshift({ sel: 'document', left: 0, right: doc.scrollWidth });
  const clipped = [...document.querySelectorAll('body > *, .win, .panel')].filter(vis).map((el) => ({ el, r: el.getBoundingClientRect() }))
    .filter(({ r }) => r.left < -1 || r.top < -1 || r.right > vw + 1 || r.bottom > vh + 1)
    .map(({ el, r }) => ({ sel: sel(el), left: Math.round(r.left), top: Math.round(r.top), right: Math.round(r.right), bottom: Math.round(r.bottom) }));
  const fixed = [...document.querySelectorAll('body > *')].filter((el) => vis(el) && el.id !== 'graph' && getComputedStyle(el).position === 'fixed' && !/^(SCRIPT|STYLE)$/.test(el.tagName)).map((el) => ({ el, r: el.getBoundingClientRect() }));
  const overlaps = [];
  for (let i = 0; i < fixed.length; i++) for (let j = i + 1; j < fixed.length; j++) {
    const a = fixed[i].r; const b = fixed[j].r;
    const w = Math.min(a.right, b.right) - Math.max(a.left, b.left); const hh = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
    if (w > 8 && hh > 8) overlaps.push({ a: sel(fixed[i].el), b: sel(fixed[j].el), w: Math.round(w), h: Math.round(hh) });
  }
  const tiny = [...document.querySelectorAll('body *')].filter((el) => el.children.length === 0 && el.textContent.trim() && vis(el) && parseFloat(getComputedStyle(el).fontSize) < 12).length;
  return {
    viewport: { w: vw, h: vh },
    hScroll: doc.scrollWidth > vw + 1, docScroll: { w: doc.scrollWidth, h: doc.scrollHeight },
    smallTargets: small.length, smallTargetSamples: small.slice(0, 25), overflow,
    clipped, overlaps, textUnder12px: tiny,
    meta: document.querySelector('meta[name=viewport]')?.content || null,
    safeAreaCss: [...document.styleSheets].some((s) => { try { return [...s.cssRules].some((r) => /safe-area-inset/.test(r.cssText)); } catch { return false; } }),
    orientationLandscape: vw > vh,
  };
}

async function main() {
  const { chromium, axePath } = loadTools();
  const server = await startServer();
  fs.mkdirSync(OUT, { recursive: true });
  let browser;
  const launchArgs = ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'];
  try { browser = await chromium.launch({ args: launchArgs }); } catch {
    const exe = fallbackChromium();
    if (!exe) throw new Error('No Chromium for playwright: run `npx playwright install chromium`.');
    browser = await chromium.launch({ executablePath: exe, args: launchArgs });
  }
  const report = { generated: new Date().toISOString(), url: server.url, views: [] };
  try {
    for (const [w, h] of VIEWPORTS) {
      for (const view of VIEWS.filter((v) => !ONLY || ONLY.includes(v.name))) {
        const desktop = w >= 1024;
        if (view.mobileOnly && desktop) continue;
        const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 1, isMobile: !desktop, hasTouch: !desktop, reducedMotion: args.includes('--reduced-motion') ? 'reduce' : 'no-preference', permissions: [] });
        if (view.closePanels) {
          await ctx.addInitScript(() => localStorage.setItem('rigs.panels', JSON.stringify(Object.fromEntries(['left', 'legend', 'topbar', 'dock', 'work', 'footer'].map((id) => [id, { closed: true }])))));
        }
        const page = await ctx.newPage();
        const errors = [];
        page.on('pageerror', (e) => errors.push(String(e.message).slice(0, 200)));
        const key = `${view.name}@${w}x${h}`;
        try {
          await page.goto(server.url, { waitUntil: 'load', timeout: 90000 });
          await sleep(2500);
          let note = null;
          page._obscured = [];
          try { await view.run(page); } catch (e) { note = `interaction failed: ${String(e.message).split('\n')[0]}`; }
          note = [note, page._obscured.length ? `obscured tap target: ${[...new Set(page._obscured)].join('; ')}` : null].filter(Boolean).join(' | ') || null;
          await sleep(500);
          if (!PRIMARY_ONLY || (w === 390 && h === 844)) await page.screenshot({ path: path.join(OUT, `${key}.png`), timeout: 120000 });
          await page.addScriptTag({ path: axePath });
          const axe = await page.evaluate(async () => {
            const r = await window.axe.run(document, { resultTypes: ['violations'] });
            return r.violations.map((v) => ({ id: v.id, impact: v.impact, help: v.help, nodes: v.nodes.length, targets: v.nodes.slice(0, 4).map((n) => n.target.join(' ')) }));
          });
          const m = await page.evaluate(metrics);
          const failures = { overflow: m.overflow.length, smallTargets: desktop ? 0 : m.smallTargets };
          report.views.push({ view: view.name, viewport: `${w}x${h}`, desktop, screenshot: `${key}.png`, note, errors, failures, axeViolationRules: axe.length, axeViolationNodes: axe.reduce((a, v) => a + v.nodes, 0), axe, metrics: m });
          console.log(`${key.padEnd(34)} axe rules ${String(axe.length).padStart(2)} nodes ${String(axe.reduce((a, v) => a + v.nodes, 0)).padStart(3)}  small-targets ${desktop ? '-' : m.smallTargets}  overflow ${m.overflow.length}${note ? '  (' + note + ')' : ''}`);
          if (failures.overflow || failures.smallTargets) for (const x of [...m.overflow, ...(desktop ? [] : m.smallTargetSamples)].slice(0, 8)) console.log(`    ${JSON.stringify(x)}`);
        } catch (e) { // a busy machine can stall one view; record it and keep going instead of losing the whole run
          const msg = String(e.message).split('\n')[0];
          report.views.push({ view: view.name, viewport: `${w}x${h}`, desktop, note: `capture failed: ${msg}`, errors, failures: { overflow: 0, smallTargets: 0 }, captureFailed: true });
          console.log(`${key.padEnd(34)} CAPTURE FAILED (${msg})`);
        } finally {
          await ctx.close();
        }
      }
    }
  } finally {
    await browser.close();
    server.stop();
  }
  const sum = (k) => report.views.reduce((a, v) => a + v.failures[k], 0);
  report.check = { overflow: sum('overflow'), smallTargets: sum('smallTargets'), pageErrors: report.views.reduce((a, v) => a + v.errors.length, 0), captureFailed: report.views.filter((v) => v.captureFailed).length };
  fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(report, null, 1));
  console.log(`\nwrote ${path.relative(ROOT, OUT)}/report.json`);
  console.log(`CHECK overflow ${report.check.overflow} · small touch targets ${report.check.smallTargets} · page errors ${report.check.pageErrors} · capture failed ${report.check.captureFailed}`);
  if (STRICT && (report.check.overflow || report.check.smallTargets || report.check.captureFailed)) process.exitCode = 1;
}

main().catch((e) => { console.error(e.message); process.exit(1); });
