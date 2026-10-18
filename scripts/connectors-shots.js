#!/usr/bin/env node
// Connectors panel check: Mesh control › Connectors in headless Chromium (Playwright from RIGS_AUDIT_TOOLS or
// ~/.cache/rigs-audit). Disconnected is the real status route of a throwaway `rigs serve` (scratch RIGS_HOME);
// connected is the same route mocked in the page. Checks Connect opens auth/start, Disconnect POSTs the disconnect
// route, and that nothing overflows sideways at 390x844; saves screenshots.
//   node scripts/connectors-shots.js [--url http://127.0.0.1:4719/] [--out screenshots/connectors]
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
let chromium = null;
for (const d of [process.env.RIGS_AUDIT_TOOLS, path.join(os.homedir(), '.cache/rigs-audit'), ROOT].filter(Boolean)) { try { ({ chromium } = createRequire(path.join(path.resolve(d), 'x.js'))('playwright')); break; } catch { /* next */ } }
if (!chromium) { console.error('playwright not found: install it outside the repo and set RIGS_AUDIT_TOOLS=<dir>'); process.exit(2); }
const OUT = path.resolve(opt('out', path.join(ROOT, 'screenshots/connectors')));
fs.mkdirSync(OUT, { recursive: true });

async function startServer() {
  if (opt('url', '')) return { url: opt('url', ''), stop() {} };
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'rigs-conn-'));
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
const results = [];
const check = (name, ok, extra = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${extra ? ' — ' + extra : ''}`); };
const STATUS = /\/api\/local\/connectors\/google-drive\/status$/;
const browser = await chromium.launch({ channel: process.env.RIGS_CHROME_CHANNEL || 'chrome', args: ['--no-sandbox'] });
const errors = [];

async function open(page, size) {
  await page.goto(server.url, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#btn-mesh', { state: 'attached' });
  await page.evaluate(() => document.querySelector('#btn-mesh').click());
  await page.getByRole('button', { name: 'Connectors', exact: true }).click();
  await page.waitForSelector('.conn-card .chip:not(:text("checking"))');
}
/** Screenshot without the toast layer (a toast would cover the card on a phone). */
const shot = async (page, name) => { await page.addStyleTag({ content: '#toasts{display:none!important}' }); await page.screenshot({ path: path.join(OUT, name) }); };
const overflow = (page) => page.evaluate(() => {
  const win = document.querySelector('.mesh-win') || document.querySelector('.conn-card').closest('.win, .window') || document.body;
  const card = document.querySelector('.conn-card').getBoundingClientRect();
  return { doc: document.documentElement.scrollWidth - innerWidth, win: win.scrollWidth - win.clientWidth, cardRight: Math.round(card.right), vw: innerWidth };
});

for (const [label, vp] of [['desktop', { width: 1280, height: 800 }], ['phone', { width: 390, height: 844 }]]) {
  const ctx = await browser.newContext({ viewport: vp, hasTouch: label === 'phone', isMobile: label === 'phone', deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  // disconnected: the real route (a fresh RIGS_HOME has no tokens)
  await open(page, label);
  const chip = (await page.textContent('.conn-card .chip')).trim();
  check(`${label}: disconnected state`, /not (connected|set up)/.test(chip), chip);
  // configure so Connect is enabled, then the real "not connected" state
  if (chip === 'not set up') {
    await page.fill('.conn-setup input:not([type=password])', 'test-client.apps.googleusercontent.com');
    await page.fill('.conn-setup input[type=password]', 'test-secret');
    await page.click('.conn-setup .btn');
    await page.waitForSelector('.conn-card .chip:text("not connected")');
  }
  check(`${label}: Connect enabled, Disconnect disabled`, !(await page.isDisabled('.conn-actions .btn.primary')) && await page.isDisabled('.conn-actions .btn.danger'));
  await shot(page, `${label}-disconnected.png`);
  const o1 = await overflow(page);
  check(`${label}: no sideways overflow (disconnected)`, o1.doc <= 0 && o1.win <= 0 && o1.cardRight <= o1.vw, JSON.stringify(o1));
  // Connect opens auth/start in a new window (stub the Google redirect)
  await ctx.route('**/auth/start**', (r) => r.fulfill({ status: 200, contentType: 'text/html', body: '<title>consent</title>consent screen' }));
  const [popup] = await Promise.all([page.waitForEvent('popup'), page.click('.conn-actions .btn.primary')]);
  check(`${label}: Connect opens auth/start`, /\/api\/local\/connectors\/google-drive\/auth\/start\?redirect=1$/.test(popup.url()), popup.url());
  await popup.close();
  // connected: mock the status route
  let connected = true; let posted = null;
  await page.route(STATUS, (r) => r.fulfill({ json: connected ? { configured: true, connected: true, account: { email: 'sir@example.com', name: 'Sir' }, connectedAt: new Date().toISOString(), canRefresh: true } : { configured: true, connected: false, account: null } }));
  await page.route('**/connectors/google-drive/disconnect', (r) => { posted = r.request().method(); connected = false; r.fulfill({ json: { ok: true } }); });
  await page.click('.conn-actions .btn[title]');
  await page.waitForSelector('.conn-card .chip:text("connected"):not(:text("not"))');
  check(`${label}: connected state shows account`, (await page.textContent('.conn-detail')).includes('sir@example.com'));
  check(`${label}: Disconnect enabled, Connect disabled`, !(await page.isDisabled('.conn-actions .btn.danger')) && await page.isDisabled('.conn-actions .btn.primary'));
  await shot(page, `${label}-connected.png`);
  const o2 = await overflow(page);
  check(`${label}: no sideways overflow (connected)`, o2.doc <= 0 && o2.win <= 0 && o2.cardRight <= o2.vw, JSON.stringify(o2));
  page.once('dialog', (d) => d.accept());
  await page.click('.conn-actions .btn.danger');
  await page.waitForSelector('.conn-card .chip:text("not connected")');
  check(`${label}: Disconnect POSTs the disconnect route`, posted === 'POST');
  await ctx.close();
}
check('no page errors', errors.length === 0, errors.join(' | '));
await browser.close();
server.stop();
process.exit(results.every(Boolean) ? 0 : 1);
