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
//          --viewports 390x844,.. override sizes (default 390x844,360x740,844x390,740x360)
//          --views a,b            only these views (default all)
//          --png-all              save PNGs for every viewport (default: all; use --png-primary for 390x844 only)
// Output: <view>@<W>x<H>.png per view/viewport and report.json (axe violations + metrics per view).
import { spawn } from 'node:child_process';
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

async function startServer() {
  const home = path.join(ROOT, '.rigs-dev');
  fs.mkdirSync(home, { recursive: true });
  const cfg = path.join(home, 'config.json');
  if (!fs.existsSync(cfg)) fs.writeFileSync(cfg, JSON.stringify({ port: PORT }));
  const port = JSON.parse(fs.readFileSync(cfg, 'utf8')).port || PORT;
  const url = `http://127.0.0.1:${port}/`;
  try { const r = await fetch(url); if (r.ok) return { url, stop() {} }; } catch { /* not running */ }
  const child = spawn(process.execPath, ['bin/rigs.js', 'serve'], { cwd: ROOT, stdio: 'ignore', env: { ...process.env, RIGS_HOME: home, RIGS_NO_MIGRATIONS: '1', RIGS_NO_AUTOUPDATE: '1' } });
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 500));
    try { const r = await fetch(url); if (r.ok) return { url, stop: () => child.kill() }; } catch { /* wait */ }
  }
  child.kill();
  throw new Error('rigs serve did not come up');
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Tap like a finger would; when another element covers the target (itself an audit finding) note it and fall back to a DOM click. */
async function tap(page, selector) {
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
  { name: 'panels-menu', run: async (p) => { await tap(p, '#panels-btn'); await sleep(400); } },
  { name: 'brain-menu', run: async (p) => { await tap(p, '#brain-badge'); await sleep(400); } },
  { name: 'window-files', run: async (p) => { await tap(p, '#btn-files'); await sleep(1500); } },
  { name: 'terminal', run: async (p) => { await tap(p, '#btn-term'); await sleep(2500); } },
  { name: 'projects', run: async (p) => { await tap(p, '#btn-proj'); await sleep(1500); } },
  { name: 'work-dashboard', run: async (p) => { await tap(p, '#btn-work'); await sleep(1500); } },
  { name: 'sessions', run: async (p) => { await tap(p, '#btn-sess'); await sleep(2000); } },
  { name: 'apps-launcher', run: async (p) => { await tap(p, '#btn-apps'); await sleep(1500); } },
  { name: 'mesh-settings', run: async (p) => { await tap(p, '#btn-mesh'); await sleep(1500); } },
  { name: 'stage-visual-cards', run: async (p) => { await p.locator('#ask').fill('status'); await p.keyboard.press('Enter'); await sleep(2500); } },
  { name: 'voice-controls', run: async (p) => { await tap(p, '#btn-hands'); await sleep(600); await tap(p, '#btn-mic'); await sleep(800); } },
];

/** Layout + touch metrics evaluated in the page. */
function metrics() {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const doc = document.documentElement;
  const vis = (el) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none' && s.opacity !== '0'; };
  const sel = (el) => el.id ? `#${el.id}` : `${el.tagName.toLowerCase()}${el.className && typeof el.className === 'string' ? '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.') : ''}`;
  const interactive = [...document.querySelectorAll('button, a[href], a:not([href])[id], input, select, textarea, summary, [role=button], [tabindex]:not([tabindex="-1"]), .hub, .conn, .flt, .bm-item')].filter(vis);
  const small = interactive.map((el) => { const r = el.getBoundingClientRect(); return { sel: sel(el), w: Math.round(r.width), h: Math.round(r.height), label: (el.getAttribute('title') || el.textContent || '').trim().slice(0, 30) }; })
    .filter((x) => x.w < 44 || x.h < 44);
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
    smallTargets: small.length, smallTargetSamples: small.slice(0, 25),
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
        const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 1, isMobile: true, hasTouch: true, reducedMotion: 'no-preference', permissions: [] });
        if (view.closePanels) {
          await ctx.addInitScript(() => localStorage.setItem('rigs.panels', JSON.stringify(Object.fromEntries(['left', 'legend', 'topbar', 'dock', 'work', 'footer'].map((id) => [id, { closed: true }])))));
        }
        const page = await ctx.newPage();
        const errors = [];
        page.on('pageerror', (e) => errors.push(String(e.message).slice(0, 200)));
        await page.goto(server.url, { waitUntil: 'load' });
        await sleep(2500);
        let note = null;
        page._obscured = [];
        try { await view.run(page); } catch (e) { note = `interaction failed: ${String(e.message).split('\n')[0]}`; }
        note = [note, page._obscured.length ? `obscured tap target: ${[...new Set(page._obscured)].join('; ')}` : null].filter(Boolean).join(' | ') || null;
        await sleep(500);
        const key = `${view.name}@${w}x${h}`;
        if (!PRIMARY_ONLY || (w === 390 && h === 844)) await page.screenshot({ path: path.join(OUT, `${key}.png`) });
        await page.addScriptTag({ path: axePath });
        const axe = await page.evaluate(async () => {
          const r = await window.axe.run(document, { resultTypes: ['violations'] });
          return r.violations.map((v) => ({ id: v.id, impact: v.impact, help: v.help, nodes: v.nodes.length, targets: v.nodes.slice(0, 4).map((n) => n.target.join(' ')) }));
        });
        const m = await page.evaluate(metrics);
        report.views.push({ view: view.name, viewport: `${w}x${h}`, screenshot: `${key}.png`, note, errors, axeViolationRules: axe.length, axeViolationNodes: axe.reduce((a, v) => a + v.nodes, 0), axe, metrics: m });
        console.log(`${key.padEnd(34)} axe rules ${String(axe.length).padStart(2)} nodes ${String(axe.reduce((a, v) => a + v.nodes, 0)).padStart(3)}  small-targets ${m.smallTargets}${m.hScroll ? '  H-SCROLL' : ''}${note ? '  (' + note + ')' : ''}`);
        await ctx.close();
      }
    }
  } finally {
    await browser.close();
    server.stop();
  }
  fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(report, null, 1));
  console.log(`\nwrote ${path.relative(ROOT, OUT)}/report.json`);
}

main().catch((e) => { console.error(e.message); process.exit(1); });
