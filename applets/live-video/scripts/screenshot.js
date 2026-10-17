#!/usr/bin/env node
// Headless-Chrome screenshot of the Live Video applet over the DevTools protocol (no puppeteer).
// Optionally runs JS in the page first (e.g. press Start), waits, prints the page state, console errors
// and failed requests, then saves a PNG.
//
//   node applets/live-video/scripts/screenshot.js <url> <out.png> [WIDTHxHEIGHT] [--wait=10] [--chrome=path]
//     [--eval='<js run once the page has loaded>']
// Try it against the mock: scripts/mock-comfy.js on :8189 and a settings.json pointing at it.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { which } from '../../../src/util.js';

const args = process.argv.slice(2);
const opt = (k, d) => { const a = args.find((x) => x.startsWith(`--${k}=`)); return a ? a.split('=').slice(1).join('=') : d; };
const [url, out, size = '1440x900'] = args.filter((a) => !a.startsWith('--'));
if (!url || !out) { console.error('usage: screenshot.js <url> <out.png> [WIDTHxHEIGHT] [--wait=10] [--chrome=path] [--eval=js]'); process.exit(2); }
const [width, height] = size.split('x').map(Number);
const mobile = width < 700;
const waitS = Number(opt('wait', 10));
const chrome = opt('chrome', null) || which('chromium') || which('google-chrome') || which('chromium-browser') || which('google-chrome-stable');
if (!chrome) { console.error('no Chrome/Chromium found; pass --chrome=/path/to/chrome'); process.exit(2); }

const port = await new Promise((r) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
const profile = path.join(os.tmpdir(), `rigs-lv-shot-${process.pid}`);
const proc = spawn(chrome, ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', '--hide-scrollbars', '--autoplay-policy=no-user-gesture-required', 'about:blank'], { stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let ws;
try {
  let target;
  for (let i = 0; i < 100 && !target; i++) {
    await sleep(150);
    try { target = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find((t) => t.type === 'page'); } catch {}
  }
  if (!target) throw new Error('Chrome did not open a DevTools endpoint');
  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = () => j(new Error('DevTools socket failed')); });
  let id = 0;
  const pending = new Map();
  const problems = [];
  const reqUrls = new Map();
  ws.onmessage = (m) => {
    const msg = JSON.parse(m.data);
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); return; }
    const p = msg.params || {};
    if (msg.method === 'Runtime.exceptionThrown') problems.push('exception: ' + (p.exceptionDetails.exception?.description || p.exceptionDetails.text));
    if (msg.method === 'Runtime.consoleAPICalled' && p.type === 'error') problems.push('console.error: ' + p.args.map((a) => a.value ?? a.description).join(' '));
    if (msg.method === 'Network.requestWillBeSent') reqUrls.set(p.requestId, p.request.url);
    if (msg.method === 'Network.loadingFailed' && !p.canceled && !/api\/events/.test(reqUrls.get(p.requestId) || '')) problems.push('request failed: ' + p.errorText + ' ' + (reqUrls.get(p.requestId) || ''));
    if (msg.method === 'Network.responseReceived' && p.response.status >= 400) problems.push(`HTTP ${p.response.status} ${p.response.url}`);
  };
  const send = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
  const evaluate = async (expr) => (await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })).result?.result?.value;

  await send('Runtime.enable');
  await send('Network.enable');
  await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: mobile ? 2 : 1, mobile });
  if (mobile) await send('Emulation.setTouchEmulationEnabled', { enabled: true });
  await send('Page.enable');
  await send('Page.navigate', { url });
  const t0 = Date.now();
  while (Date.now() - t0 < 15000 && !(await evaluate('!!(window.__lv && window.__lv.state.status)'))) await sleep(200);
  if (opt('eval', null)) console.error('eval →', JSON.stringify(await evaluate(opt('eval'))));
  await sleep(waitS * 1000);
  const state = await evaluate(`(() => { const s = window.__lv?.state; const p = window.__lv?.player; const v = p?.els[p.cur];
    return { live: s?.live?.status, clips: s?.live?.clips?.length, playing: p?.current?.index ?? null, videoTime: v ? +v.currentTime.toFixed(2) : null, paused: v?.paused, readyState: v?.readyState,
      conn: document.getElementById('conn-text').textContent, progress: document.getElementById('progress-text').textContent,
      overflowX: document.documentElement.scrollWidth > innerWidth }; })()`);
  const shot = await send('Page.captureScreenshot', { format: 'png' });
  fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
  fs.writeFileSync(out, Buffer.from(shot.result.data, 'base64'));
  console.log(JSON.stringify({ out, size, state, problems }, null, 2));
} catch (e) {
  console.error('screenshot failed:', e.message);
  process.exitCode = 1;
} finally {
  try { ws?.close(); } catch {}
  proc.kill('SIGTERM');
  setTimeout(() => { try { proc.kill('SIGKILL'); } catch {} process.exit(); }, 1500).unref();
}
