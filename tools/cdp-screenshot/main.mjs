// Headless Chrome screenshot / drive over the DevTools protocol (Node's built-in WebSocket, no dependencies).
// Arguments arrive as JSON (RIGS_TOOL_ARGS or argv[2]); the result is one JSON object on stdout.
//   one shot:  { "url": "http://127.0.0.1:4719", "out": "/tmp/home.png", "size": "390x844" }
//   scripted:  { "url": "...", "steps": [ { "viewport": "1440x900" }, { "eval": "document.title" },
//                { "waitFor": "!!window.app", "timeout": 20000 }, { "sleep": 500 }, { "shot": "/tmp/a.png" } ] }
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

const args = JSON.parse(process.env.RIGS_TOOL_ARGS || process.argv[2] || '{}');
const fail = (error, extra = {}) => { console.log(JSON.stringify({ ok: false, error, ...extra })); process.exit(1); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const isWin = process.platform === 'win32';

function which(name) {
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    for (const ext of isWin ? (process.env.PATHEXT || '.EXE;.CMD').split(';') : ['']) {
      const p = path.join(dir, name + ext);
      try { if (fs.statSync(p).isFile()) return p; } catch {}
    }
  }
  return null;
}
function findChrome() {
  if (args.chrome) return args.chrome;
  if (process.env.CHROME) return process.env.CHROME;
  for (const n of ['chromium', 'google-chrome', 'chromium-browser', 'google-chrome-stable', 'chrome', 'msedge']) { const p = which(n); if (p) return p; }
  const known = process.platform === 'darwin'
    ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Chromium.app/Contents/MacOS/Chromium']
    : isWin ? ['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'] : [];
  return known.find((p) => fs.existsSync(p)) || null;
}

const url = String(args.url || '');
if (!/^(https?|file):\/\//i.test(url)) fail('url is required and must be http(s):// or file://');
const size = String(args.size || '1440x900');
if (!/^\d{2,5}x\d{2,5}$/.test(size)) fail('size must look like 1440x900');
const waitS = Math.min(120, Math.max(0, Number(args.wait ?? 1)));

let steps = args.steps;
if (steps !== undefined && !Array.isArray(steps)) fail('steps must be an array');
if (!steps) {
  if (!args.out) fail('give out (a PNG path) for a one-shot screenshot, or steps');
  steps = [{ viewport: size }];
  if (args.eval) steps.push({ eval: args.eval });
  if (args.until) steps.push({ waitFor: args.until, timeout: 40000 });
  steps.push({ sleep: waitS * 1000 }, { shot: args.out });
}
const chrome = findChrome();
const plan = { url, steps, chrome, reducedMotion: !!args.reducedMotion, swiftshader: !!args.swiftshader };
if (args.dryRun) { console.log(JSON.stringify({ ok: true, dryRun: true, plan, chromeFound: !!chrome })); process.exit(0); }
if (!chrome) fail('no Chrome/Chromium found: install one or pass chrome (a path)');

const port = await new Promise((r) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'rigs-cdp-'));
const gl = args.swiftshader ? ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] : [];
const baseFlags = ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', '--hide-scrollbars', '--disable-dev-shm-usage', ...gl, 'about:blank'];
// Chrome exits at once when its sandbox cannot start (Ubuntu 24.04 restricts unprivileged user namespaces, containers, root); it is then retried with --no-sandbox.
const launch = (extra) => {
  const c = spawn(chrome, [...extra, ...baseFlags], { stdio: ['ignore', 'ignore', 'pipe'] });
  const h = { c, err: '', exited: false };
  c.stderr.on('data', (d) => { h.err = (h.err + d).slice(-2000); });
  c.on('exit', () => { h.exited = true; });
  c.on('error', (e) => { h.err += String(e.message); h.exited = true; });
  return h;
};
const waitEndpoint = async (h) => {
  for (let i = 0; i < 200 && !h.exited; i++) {
    await sleep(150);
    try { const t = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find((x) => x.type === 'page'); if (t) return t; } catch {}
  }
};
let run = launch([]);
const procs = [run];
const out = { ok: true, shots: [], evals: [], problems: [] };
let ws;
try {
  let target = await waitEndpoint(run);
  if (!target && run.exited && /sandbox|namespace|zygote/i.test(run.err)) {
    run = launch(['--no-sandbox']);
    procs.push(run);
    target = await waitEndpoint(run);
  }
  if (!target) throw new Error(`Chrome did not open a DevTools endpoint${run.exited ? ' (it exited)' : ' within 30 s'}: ${run.err.trim().split('\n').slice(-3).join(' | ') || 'no output'}`);
  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = () => j(new Error('DevTools socket failed')); });
  let id = 0;
  const pending = new Map();
  const reqUrls = new Map();
  let loaded = false;
  const send = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
  ws.onmessage = (m) => {
    const msg = JSON.parse(m.data);
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); return; }
    const p = msg.params || {};
    if (msg.method === 'Page.loadEventFired') loaded = true;
    if (msg.method === 'Runtime.exceptionThrown') out.problems.push(`exception: ${p.exceptionDetails.exception?.description || p.exceptionDetails.text}`);
    if (msg.method === 'Runtime.consoleAPICalled' && p.type === 'error') out.problems.push(`console.error: ${p.args.map((a) => a.value ?? a.description).join(' ')}`);
    if (msg.method === 'Network.requestWillBeSent') reqUrls.set(p.requestId, p.request.url);
    if (msg.method === 'Network.loadingFailed' && !p.canceled) out.problems.push(`request failed: ${p.errorText} ${reqUrls.get(p.requestId) || ''}`);
    if (msg.method === 'Network.responseReceived' && p.response.status >= 400) out.problems.push(`HTTP ${p.response.status} ${p.response.url}`);
    if (msg.method === 'Page.javascriptDialogOpening') send('Page.handleJavaScriptDialog', { accept: true });
  };
  const evaluate = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.result?.exceptionDetails) throw new Error(`eval failed: ${r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text}`);
    return r.result?.result?.value;
  };
  const viewport = async (s) => {
    const [width, height] = s.split('x').map(Number);
    const mobile = width < 700; // a width under 700 emulates a phone: touch, 2x pixels, mobile viewport
    await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: mobile ? 2 : 1, mobile });
    await send('Emulation.setTouchEmulationEnabled', { enabled: mobile });
  };

  await send('Runtime.enable');
  await send('Network.enable');
  await send('Page.enable');
  await viewport(size);
  if (args.reducedMotion) await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  await send('Page.navigate', { url });
  for (let i = 0; i < 100 && !loaded; i++) await sleep(150); // the load event, at most 15 s; pages that never finish still get their shot
  await sleep(300);
  for (const s of steps) {
    if (s.viewport) await viewport(String(s.viewport));
    if (s.eval) out.evals.push(await evaluate(String(s.eval)));
    if (s.waitFor) {
      const until = Date.now() + (s.timeout || 30000);
      let v;
      while (!(v = await evaluate(String(s.waitFor))) && Date.now() < until) await sleep(300);
      if (!v) throw new Error(`timed out waiting for: ${s.waitFor}`);
    }
    if (s.sleep) await sleep(Math.min(Number(s.sleep), 60000));
    if (s.shot) {
      const shot = await send('Page.captureScreenshot', { format: 'png' });
      const file = path.resolve(String(s.shot));
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, Buffer.from(shot.result.data, 'base64'));
      out.shots.push(file);
    }
  }
} catch (e) {
  out.ok = false;
  out.error = e.message;
} finally {
  try { ws?.close(); } catch {}
  for (const h of procs) h.c.kill('SIGTERM');
  await sleep(500);
  for (const h of procs) { try { h.c.kill('SIGKILL'); } catch {} }
  fs.rmSync(profile, { recursive: true, force: true });
}
console.log(JSON.stringify(out));
process.exit(out.ok ? 0 : 1);
