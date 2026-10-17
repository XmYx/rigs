#!/usr/bin/env node
// Mobile performance probe (dev tool; playwright is not a product dependency, see mobile-shots.js).
// Loads JARVIS at 390x844 (touch, DPR 3) with 4x CPU throttling, idles for --seconds and records long-task
// time, frames per second (requestAnimationFrame), Chromium task/script durations and the ui/dist bundle
// sizes. Then hides the tab (document.hidden = true) and counts the frames drawn while hidden.
//   RIGS_AUDIT_TOOLS=~/.cache/rigs-audit node scripts/mobile-perf.js --url http://127.0.0.1:4781/ --out docs/mobile-audit/after-polish/perf.json
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : d; };
const URL_ = opt('url', 'http://127.0.0.1:4781/');
const OUT = path.resolve(ROOT, opt('out', 'docs/mobile-audit/perf.json'));
const SECONDS = Number(opt('seconds', 10));
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
const kb = (n) => Math.round(n / 102.4) / 10;

const bundle = {}; // every js/css file in ui/dist (entry + lazy chunks); chunk-* load on first use
for (const f of fs.readdirSync(path.join(ROOT, 'ui/dist')).filter((x) => /\.(js|css)$/.test(x) && !/\.map$/.test(x))) {
  const buf = fs.readFileSync(path.join(ROOT, 'ui/dist', f));
  bundle[f] = { kb: kb(buf.length), gzipKb: kb(zlib.gzipSync(buf).length) };
}

let browser;
try { browser = await chromium.launch(); } catch { browser = await chromium.launch({ executablePath: exe() }); }
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true });
await ctx.addInitScript(() => {
  window.__perf = { long: [], frames: 0, hiddenFrames: 0, fake: false };
  try { new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__perf.long.push(e.duration); }).observe({ type: 'longtask', buffered: true }); } catch { /* unsupported */ }
  const tick = () => { window.__perf.fake ? window.__perf.hiddenFrames++ : window.__perf.frames++; requestAnimationFrame(tick); };
  requestAnimationFrame(tick);
});
const p = await ctx.newPage();
const cdp = await ctx.newCDPSession(p);
await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
await cdp.send('Performance.enable');
const t0 = Date.now();
await p.goto(URL_, { waitUntil: 'load' });
const loadMs = Date.now() - t0;
await sleep(3000); // settle: first layout, mesh data, galaxy warm-up
const m0 = Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map((x) => [x.name, x.value]));
await p.evaluate(() => { window.__perf.long.length = 0; window.__perf.frames = 0; });
await sleep(SECONDS * 1000);
const m1 = Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map((x) => [x.name, x.value]));
const idle = await p.evaluate(() => ({ long: window.__perf.long, frames: window.__perf.frames }));
// hidden tab: fake document.hidden and see how many frames the page still draws
await p.evaluate(() => {
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
  document.dispatchEvent(new Event('visibilitychange'));
});
await sleep(1000);
const h0 = Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map((x) => [x.name, x.value]));
await p.evaluate(() => { window.__perf.fake = true; window.__perf.hiddenFrames = 0; });
await sleep(4000);
const h1 = Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map((x) => [x.name, x.value]));
const hid = await p.evaluate(() => window.__perf.hiddenFrames);
const info = await p.evaluate(() => ({ canvases: [...document.querySelectorAll('canvas')].map((c) => `${c.width}x${c.height}`), dpr: devicePixelRatio, nodes: document.querySelectorAll('.nlabel').length }));
const sum = (a) => Math.round(a.reduce((s, x) => s + x, 0));
const result = {
  generated: new Date().toISOString(), url: URL_, viewport: '390x844 @3x, 4x CPU throttle', bundle, loadMs,
  idle: { seconds: SECONDS, fps: Math.round((idle.frames / SECONDS) * 10) / 10, longTasks: idle.long.length, longTaskMs: sum(idle.long), maxLongTaskMs: Math.round(Math.max(0, ...idle.long)),
    taskMs: Math.round((m1.TaskDuration - m0.TaskDuration) * 1000), scriptMs: Math.round((m1.ScriptDuration - m0.ScriptDuration) * 1000), cpuBusyPct: Math.round(((m1.TaskDuration - m0.TaskDuration) / SECONDS) * 100) },
  hiddenTab: { seconds: 4, rafFrames: hid, taskMs: Math.round((h1.TaskDuration - h0.TaskDuration) * 1000), cpuBusyPct: Math.round(((h1.TaskDuration - h0.TaskDuration) / 4) * 100) },
  page: info,
};
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
await browser.close();
