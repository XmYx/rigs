#!/usr/bin/env node
// Drive the studio in headless Chrome over the DevTools protocol (Node's built-in WebSocket, no
// puppeteer) and take screenshots. Steps come from a JSON file, run in order:
//   { "viewport": "1440x900" }            set the viewport (a width under 700 emulates a phone)
//   { "eval": "<js>" }                    run in the page (promises are awaited); the result is printed
//   { "waitFor": "<js>", "timeout": ms }  poll until the expression is truthy (fails the run on timeout)
//   { "sleep": ms }
//   { "shot": "docs/screenshots/x.png" }  save a PNG of the viewport
//
//   node applets/krea-studio/scripts/drive.js <url> <steps.json> [--chrome=path]
// Console errors, exceptions and failed requests are printed at the end.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { which } from '../../../src/util.js';

const args = process.argv.slice(2);
const opt = (k, d) => { const a = args.find((x) => x.startsWith(`--${k}=`)); return a ? a.split('=').slice(1).join('=') : d; };
const [url, stepsFile] = args.filter((a) => !a.startsWith('--'));
if (!url || !stepsFile) { console.error('usage: drive.js <url> <steps.json> [--chrome=path]'); process.exit(2); }
const steps = JSON.parse(fs.readFileSync(stepsFile, 'utf8'));
const chrome = opt('chrome', null) || which('chromium') || which('google-chrome') || which('chromium-browser') || which('google-chrome-stable');
if (!chrome) { console.error('no Chrome/Chromium found; pass --chrome=/path/to/chrome'); process.exit(2); }

const port = await new Promise((r) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
const profile = path.join(os.tmpdir(), `rigs-krea-drive-${process.pid}`);
const proc = spawn(chrome, ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', '--hide-scrollbars', 'about:blank'], { stdio: 'ignore' });
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
  const send = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
  ws.onmessage = (m) => {
    const msg = JSON.parse(m.data);
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); return; }
    const p = msg.params || {};
    if (msg.method === 'Runtime.exceptionThrown') problems.push(`exception: ${p.exceptionDetails.exception?.description || p.exceptionDetails.text}`);
    if (msg.method === 'Runtime.consoleAPICalled' && p.type === 'error') problems.push(`console.error: ${p.args.map((a) => a.value ?? a.description).join(' ')}`);
    if (msg.method === 'Network.requestWillBeSent') reqUrls.set(p.requestId, p.request.url);
    if (msg.method === 'Network.loadingFailed' && !p.canceled) problems.push(`request failed: ${p.errorText} ${reqUrls.get(p.requestId) || ''}`);
    if (msg.method === 'Network.responseReceived' && p.response.status >= 400) problems.push(`HTTP ${p.response.status} ${p.response.url}`);
    if (msg.method === 'Page.javascriptDialogOpening') send('Page.handleJavaScriptDialog', { accept: true });
  };
  const evaluate = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.result?.exceptionDetails) throw new Error(`eval failed: ${r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text}`);
    return r.result?.result?.value;
  };
  const viewport = async (size) => {
    const [width, height] = size.split('x').map(Number);
    const mobile = width < 700;
    await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: mobile ? 2 : 1, mobile });
    await send('Emulation.setTouchEmulationEnabled', { enabled: mobile });
  };

  await send('Runtime.enable');
  await send('Network.enable');
  await send('Page.enable');
  await viewport('1440x900');
  await send('Page.navigate', { url });
  await sleep(800);
  for (const s of steps) {
    if (s.viewport) await viewport(s.viewport);
    if (s.eval) console.log('eval →', JSON.stringify(await evaluate(s.eval)));
    if (s.waitFor) {
      const until = Date.now() + (s.timeout || 30000);
      let v;
      while (!(v = await evaluate(s.waitFor)) && Date.now() < until) await sleep(300);
      if (!v) throw new Error(`timed out waiting for: ${s.waitFor}`);
      console.log('ready →', JSON.stringify(v));
    }
    if (s.sleep) await sleep(s.sleep);
    if (s.shot) {
      const shot = await send('Page.captureScreenshot', { format: 'png' });
      fs.mkdirSync(path.dirname(path.resolve(s.shot)), { recursive: true });
      fs.writeFileSync(s.shot, Buffer.from(shot.result.data, 'base64'));
      console.log('saved', s.shot);
    }
  }
  console.log(JSON.stringify({ problems }, null, 2));
} catch (e) {
  console.error('drive failed:', e.message);
  process.exitCode = 1;
} finally {
  try { ws?.close(); } catch {}
  proc.kill('SIGTERM');
  setTimeout(() => { try { proc.kill('SIGKILL'); } catch {} fs.rmSync(profile, { recursive: true, force: true }); process.exit(); }, 1500).unref();
}
