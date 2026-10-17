#!/usr/bin/env node
// Headless-Chrome screenshot of the applet, over the DevTools protocol (Node's built-in WebSocket,
// no puppeteer). Waits until the demo vehicle is driving, samples the speed readout to show it
// changes, prints console errors and failed requests, then saves a PNG.
//
//   node applets/navigation/scripts/screenshot.js <url> <out.png> [WIDTHxHEIGHT] [--wait=8] [--chrome=path] [--swiftshader]
//     [--eval='<js run in the page once it is ready, before sampling>']
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { which } from '../../../src/util.js';

const args = process.argv.slice(2);
const opt = (k, d) => { const a = args.find((x) => x.startsWith(`--${k}=`)); return a ? a.split('=').slice(1).join('=') : d; };
const flag = (k) => args.includes(`--${k}`);
const [url, out, size = '1440x900'] = args.filter((a) => !a.startsWith('--'));
if (!url || !out) { console.error('usage: screenshot.js <url> <out.png> [WIDTHxHEIGHT] [--wait=8] [--chrome=path] [--swiftshader]'); process.exit(2); }
const [width, height] = size.split('x').map(Number);
const mobile = width < 700;
const waitS = Number(opt('wait', 8));
const chrome = opt('chrome', null) || which('chromium') || which('google-chrome') || which('chromium-browser') || which('google-chrome-stable');
if (!chrome) { console.error('no Chrome/Chromium found; pass --chrome=/path/to/chrome'); process.exit(2); }

const port = await new Promise((r) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
const profile = path.join(os.tmpdir(), `rigs-nav-shot-${process.pid}`);
const gl = flag('swiftshader') ? ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] : ['--enable-gpu', '--ignore-gpu-blocklist', '--use-angle=default'];
const proc = spawn(chrome, ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', '--hide-scrollbars', ...gl, 'about:blank'], { stdio: 'ignore' });
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
    if (msg.method === 'Network.loadingFailed' && !p.canceled) problems.push('request failed: ' + p.errorText + ' ' + (reqUrls.get(p.requestId) || ''));
    if (msg.method === 'Network.responseReceived' && p.response.status >= 400) problems.push(`HTTP ${p.response.status} ${p.response.url}`);
  };
  const send = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
  const evaluate = async (expr) => (await send('Runtime.evaluate', { expression: expr, returnByValue: true })).result?.result?.value;

  await send('Runtime.enable');
  await send('Network.enable');
  await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: mobile ? 2 : 1, mobile });
  if (mobile) await send('Emulation.setTouchEmulationEnabled', { enabled: true });
  await send('Page.enable');
  await send('Page.navigate', { url });

  const isDemo = /[?&]demo=(?!0)/.test(url);
  const t0 = Date.now();
  let state = null;
  while (Date.now() - t0 < 45000) {
    await sleep(500);
    state = await evaluate(`(() => { const n = window.__nav; const s = document.getElementById('screen'); return { loaded: !!n?.mapLoaded, driving: !!n?.driving, fixes: n?.fixes || 0, screen: s && !s.hidden ? document.getElementById('screen-title').textContent : null }; })()`);
    if (state?.screen) break;
    if (state?.loaded && (!isDemo || state.fixes > 5)) break;
  }
  if (opt('eval', null)) console.error('eval →', JSON.stringify((await send('Runtime.evaluate', { expression: opt('eval'), awaitPromise: true, returnByValue: true })).result?.result?.value));
  const samples = [];
  for (let i = 0; i < waitS * 2; i++) {
    await sleep(500);
    if (i % 2 === 0) samples.push(await evaluate(`document.getElementById('speed').textContent + ' ' + document.getElementById('unit').textContent + ' | ' + document.getElementById('hdg').textContent + ' | ' + document.getElementById('turn-dist').textContent + ' ' + document.getElementById('turn-text').textContent`));
  }
  const renderer = await evaluate(`(() => { try { const g = document.createElement('canvas').getContext('webgl2'); const e = g.getExtension('WEBGL_debug_renderer_info'); return e ? g.getParameter(e.UNMASKED_RENDERER_WEBGL) : 'webgl2'; } catch (e) { return 'no webgl: ' + e.message; } })()`);
  const shot = await send('Page.captureScreenshot', { format: 'png' });
  fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
  fs.writeFileSync(out, Buffer.from(shot.result.data, 'base64'));
  console.log(JSON.stringify({ out, size, state, renderer, samples, problems }, null, 2));
} catch (e) {
  console.error('screenshot failed:', e.message);
  process.exitCode = 1;
} finally {
  try { ws?.close(); } catch {}
  proc.kill('SIGTERM');
  setTimeout(() => { try { proc.kill('SIGKILL'); } catch {} process.exit(); }, 1500).unref();
}
