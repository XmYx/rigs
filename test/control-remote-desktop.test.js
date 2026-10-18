import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { test, after } from 'node:test';

// Regressions for docs/remote-desktop-diagnosis.md: the lease taken by refused calls, the lease keyed on the
// transport, the read-only check, the grant reporting, and the peer relay of screenshots.
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rigs-rd-test-'));
process.env.RIGS_HOME = path.join(root, 'default');
const { createControl, holderKey, permissionMessage } = await import('../src/control.js');
const { createControlApi } = await import('../src/control-api.js');
const { decideMacHelper, decideLinux, missingGrants } = await import('../src/access.js');
const { forwardHttp } = await import('../src/proxy.js');
const cleanups = [];
after(async () => { for (const cleanup of cleanups) await cleanup(); fs.rmSync(root, { recursive: true, force: true }); });

const png = Buffer.from('89504e470d0a1a0a0000000d494844520000064000000384', 'hex');
const facts = { session: 'wayland', desktop: 'gnome', available: { gi: true, mutterScreenCast: 4, mutterRemoteDesktop: 1, 'gst-launch-1.0': true, rigsExtension: true }, displays: [{ id: 'DP-1', width: 3840, height: 2160 }], locked: false };
const granted = { screenCapture: { ok: true, via: 'mutter' }, input: { ok: true, via: 'mutter' }, accessibility: { ok: true, via: 'gnome-extension' } };
const noScreen = { ...granted, screenCapture: { ok: false, via: 'RIGS Control · CGPreflightScreenCaptureAccess', fix: { kind: 'settings', permission: 'screenCapture', app: '/Users/x/.rigs/bin/RIGS Control.app', text: 'Open System Settings' } } };

function fixture({ permissions = granted, control = {}, behavior = {} } = {}) {
  const home = fs.mkdtempSync(path.join(root, 'instance-'));
  let cfg = { name: 'target', control: { enabled: true, input: true, leaseIdleSec: 60, maxActionsPerMin: 120, maxShotsPerMin: 2, ...control } };
  let time = 10000;
  const calls = [];
  const adapter = {
    events: new EventEmitter(),
    inspect: async () => ({ ...structuredClone(facts), permissions: typeof permissions === 'function' ? permissions() : permissions }),
    configure: async () => { calls.push('configure'); },
    stop: async () => { calls.push('stop'); },
    request: async (op, a) => {
      calls.push(op);
      if (behavior[op]) return behavior[op](a);
      if (op === 'locked') return { locked: false };
      if (op === 'shot') { fs.writeFileSync(a.file, png); return { display: 'DP-1', sourceWidth: 3840 }; }
      if (op === 'windows') return [{ id: '1', title: 'Scratch' }];
      return {};
    },
  };
  const c = createControl({ platform: 'linux', home, getConfig: () => cfg, persistConfig: (v) => { cfg = v; }, adapter, now: () => time, timeoutMs: 200 });
  cleanups.push(() => c.kill());
  return { c, calls, advance: (n) => { time += n; }, home };
}

const agentA = { from: 'macbookpro', agent: 'claude', session: 'a', via: 'mcp', who: 'local' };
const agentB = { from: 'mac', agent: 'claude', session: 'b', via: 'mcp', who: 'peer' };

test('a call refused for a missing permission takes no lease, so another caller is not locked out', async () => {
  let perms = noScreen;
  const f = fixture({ permissions: () => perms });
  await assert.rejects(f.c.screenshot({}, agentA), { code: 'needs-permission' });
  assert.equal((await f.c.status({ force: true })).lease, null, 'refused call holds no lease');
  // Before the fix the refused screenshot held the lease for 60 s and this was 409 busy.
  assert.deepEqual(await f.c.listWindows(agentB), [{ id: '1', title: 'Scratch' }]);
  assert.equal((await f.c.status()).lease.holder.session, 'b');
  perms = granted;
});

test('locked and rate refusals take no lease; a refusal does not use up the rate budget', async () => {
  let locked = true, perms = noScreen;
  const f = fixture({ permissions: () => perms, behavior: { locked: () => ({ locked }) } });
  await assert.rejects(f.c.listWindows(agentA), { code: 'locked' });
  assert.equal((await f.c.status()).lease, null);
  locked = false;
  // maxShotsPerMin is 2: three refused screenshots must leave the budget untouched.
  for (let i = 0; i < 3; i++) await assert.rejects(f.c.screenshot({}, agentA), { code: 'needs-permission' });
  assert.equal((await f.c.status()).lease, null);
  assert.ok(f.calls.includes('stop'), 'a refusal after the helper was opened stops it when no lease would idle it out');
  perms = granted; f.advance(6000); // past the 5 s status cache
  await f.c.screenshot({}, agentA);
  await f.c.screenshot({}, agentA);
  await assert.rejects(f.c.screenshot({}, agentA), { code: 'rate' });
});

test('the lease follows the agent session, not the transport it arrived on', async () => {
  const f = fixture();
  await f.c.listWindows({ ...agentA, via: 'token', who: 'peer' });
  // Same session, other path (tailscale login instead of the mesh token): same holder.
  await f.c.listWindows({ ...agentA, via: 'tailscale', who: 'sir@example.com' });
  await assert.rejects(f.c.listWindows(agentB), { code: 'busy' });
  await assert.rejects(f.c.listWindows({ ...agentA, session: 'other' }), { code: 'busy' });
  assert.equal(holderKey({ from: 'm', human: true, who: 'local' }), holderKey({ from: 'm', human: true, who: 'sir@example.com', via: 'tailscale' }));
  assert.equal(holderKey({ from: 'm', agent: 'codex', seat: 'team.x' }), holderKey({ from: 'm', agent: 'codex', seat: 'team.x', who: 'peer' }));
  assert.notEqual(holderKey({ from: 'm', agent: 'codex', seat: 'team.x' }), holderKey({ from: 'm', agent: 'codex', seat: 'team.y' }));
  assert.notEqual(holderKey({ from: 'm', human: true }), holderKey({ from: 'mac', human: true }));
  assert.notEqual(holderKey({ from: 'm', human: true }), holderKey({ from: 'm', agent: 'claude', session: 's' }));
  // An agent call whose x-rigs-caller names no agent is still an agent, never the person at the UI.
  assert.notEqual(holderKey({ from: 'm', human: false }), holderKey({ from: 'm', human: true }));
});

test('check reports a spent rate budget like the real call, and never spends it', async () => {
  const f = fixture();
  for (let i = 0; i < 3; i++) assert.equal((await f.c.check('screenshot', agentA)).ok, true);
  await f.c.screenshot({}, agentA);
  await f.c.screenshot({}, agentA); // maxShotsPerMin is 2: the checks above used none of it
  await assert.rejects(f.c.check('screenshot', agentA), { code: 'rate' });
  assert.equal((await f.c.check('pointer', agentA)).ok, true, 'the actions budget is separate');
});

test('check runs the real gate read-only: no lease, no input, same refusals', async () => {
  let perms = granted;
  const f = fixture({ permissions: () => perms });
  const ok = await f.c.check('pointer', agentA);
  assert.deepEqual([ok.ok, ok.dryRun, ok.backend, ok.lease], [true, true, 'mutter', null]);
  assert.equal((await f.c.status()).lease, null, 'check takes no lease');
  assert.deepEqual(f.calls.filter((op) => !['configure', 'locked', 'stop'].includes(op)), [], 'check sends no input');
  assert.equal(f.calls.at(-1), 'stop', 'check leaves no helper running without a lease');
  perms = noScreen; f.advance(6000);
  await assert.rejects(f.c.check('screenshot', agentA), (e) => e.code === 'needs-permission' && /screen capture/.test(e.message) && !!e.fix.app);
  perms = granted; f.advance(6000);
  await f.c.listWindows(agentB);
  await assert.rejects(f.c.check('pointer', agentA), { code: 'busy' });
  const mine = await f.c.check('windows', agentB);
  assert.equal(mine.lease.session, 'b');
  await assert.rejects(f.c.check('bogus', agentA), { code: 'bad-args' });
  const audit = f.c.auditTail({ limit: 10 }).filter((l) => l.op === 'check');
  assert.ok(audit.length >= 4 && audit.every((l) => l.args.op), 'every check is audited with the op it checked');
});

test('check honours the switches: input off and kill refuse it exactly like a real call', async () => {
  const off = fixture({ control: { input: false } });
  await assert.rejects(off.c.check('key', agentA), { code: 'input-off' });
  assert.equal((await off.c.check('screenshot', agentA)).ok, true, 'a see-only op still checks out with input off');
  const killed = fixture();
  await killed.c.kill({ reason: 'test' }, { who: 'desktop' });
  await assert.rejects(killed.c.check('screenshot', agentA), { code: 'off' });
});

test('control API exposes GET control/check?op=', async () => {
  const seen = [];
  const handle = createControlApi({ control: { check: async (op, caller) => { seen.push([op, caller.agent]); return { ok: true }; } }, access: {}, nodeName: () => 'n' });
  const req = (method) => ({ method, headers: { 'x-rigs-caller': JSON.stringify({ agent: 'claude', session: 's' }) } });
  assert.deepEqual(await handle('check', req('GET'), null, new URLSearchParams('op=key')), { ok: true });
  await handle('check', req('GET'), null, new URLSearchParams(''));
  assert.deepEqual(seen, [['key', 'claude'], ['pointer', 'claude']]);
  await assert.rejects(handle('check', req('POST'), null, new URLSearchParams('')), { status: 405 });
});

test('permissionMessage names the grant, the app and the machine', () => {
  assert.equal(permissionMessage('screenshot', 'screenCapture', noScreen.screenCapture, { platform: 'mac', node: 'mac' }),
    'screenshot needs Screen Recording for RIGS Control.app (/Users/x/.rigs/bin/RIGS Control.app), which is not granted on mac');
  const mac = decideMacHelper({ running: true, grants: { screen: true, ax: false, post: false }, app: '/h/RIGS Control.app' });
  assert.match(permissionMessage('pointer', 'input', mac.input, { platform: 'mac', node: 'm' }), /^pointer needs Accessibility for RIGS Control\.app \(\/h\/RIGS Control\.app\)/);
  const linux = decideLinux({ session: true, sessionType: 'wayland', busNames: new Set(), tools: {} });
  assert.match(permissionMessage('pointer', 'input', linux.input, { platform: 'linux', node: 'magix' }), /^pointer needs input injection, which is not granted on magix$/);
});

test('missingGrants: one entry per grant a person gives, with app, how and the grant step', () => {
  const app = '/Users/x/.rigs/bin/RIGS Control.app';
  const mac = missingGrants(decideMacHelper({ running: true, grants: { screen: false, ax: false, post: false }, app, name: 'RIGS Control' }), 'mac');
  assert.deepEqual(mac.map((g) => [g.grant, g.permission, g.for, g.state, g.app]), [
    ['Screen Recording', 'screenCapture', ['screenCapture'], 'missing', app],
    ['Accessibility', 'accessibility', ['input', 'accessibility'], 'missing', app],
  ]);
  assert.match(mac[0].how, /Privacy & Security > Screen Recording and switch on RIGS Control \(\/Users\/x\/\.rigs\/bin\/RIGS Control\.app\)/);
  assert.match(mac[0].url, /Privacy_ScreenCapture$/);
  assert.equal(mac[1].step, 'mesh_access grant:"accessibility" (a person confirms it at the machine)');
  assert.deepEqual(missingGrants(decideMacHelper({ running: true, grants: { screen: true, ax: true, post: true }, app }), 'mac'), []);
  const down = missingGrants(decideMacHelper({ running: false, app, error: 'stopped' }), 'mac');
  assert.equal(down.length, 1, 'a stopped helper is one thing to fix, not three');
  assert.deepEqual([down[0].grant, down[0].for.length, down[0].app], ['RIGS Control running', 3, app]);
  const portal = missingGrants(decideLinux({ session: true, sessionType: 'wayland', busNames: new Set(), portalScreenCast: 5, portalRemoteDesktop: 2, tools: {} }), 'linux');
  assert.deepEqual(portal.map((g) => [g.grant, g.state]), [['screen capture', 'unconfirmed'], ['input injection', 'unconfirmed'], ['accessibility (window list)', 'missing']]);
  const uinput = missingGrants(decideLinux({ session: true, sessionType: 'wayland', busNames: new Set(['org.gnome.Mutter.ScreenCast', 'org.gnome.Mutter.RemoteDesktop', 'dev.rigs.Control']), tools: {} }), 'linux');
  assert.deepEqual(uinput, []);
});

test('status reports needs next to permissions', async () => {
  const f = fixture({ permissions: noScreen });
  const s = await f.c.status({ force: true });
  assert.deepEqual(s.needs.map((g) => g.permission), ['screenCapture']);
  assert.equal(s.ready.see, false);
});

test('peer relay passes a screenshot through byte for byte with its headers, and a 412 with its JSON', async () => {
  const image = Buffer.concat([png, Buffer.alloc(2 * 1024 * 1024, 7)]); // 2 MB, larger than any socket chunk
  const seen = [];
  const peer = http.createServer((req, res) => {
    seen.push({ url: req.url, headers: req.headers });
    if (req.url.startsWith('/api/local/control/screenshot')) {
      res.writeHead(200, { 'content-type': 'image/png', 'content-length': image.length, 'x-rigs-scale': '6.4', 'x-rigs-shot': 'abc', 'x-rigs-width': '600' });
      res.end(image);
    } else {
      res.writeHead(412, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'screenshot needs Screen Recording', code: 'needs-permission', fix: { kind: 'settings' } }));
    }
  });
  await new Promise((r) => peer.listen(0, '127.0.0.1', r));
  const node = { name: 'peer', url: `http://127.0.0.1:${peer.address().port}`, viaToken: true };
  const front = http.createServer((req, res) => forwardHttp(node, req, res, req.url.replace(/^\/api\/nodes\/peer\//, '')));
  await new Promise((r) => front.listen(0, '127.0.0.1', r));
  cleanups.push(() => new Promise((r) => peer.close(r)), () => new Promise((r) => front.close(r)));
  const base = `http://127.0.0.1:${front.address().port}`;
  const r = await fetch(`${base}/api/nodes/peer/control/screenshot?maxWidth=600`, { headers: { 'x-rigs-caller': '{"agent":"claude"}', 'x-rigs-token': 'caller-secret', cookie: 'c=1' } });
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('x-rigs-scale'), '6.4');
  assert.equal(r.headers.get('content-type'), 'image/png');
  assert.ok(Buffer.from(await r.arrayBuffer()).equals(image), 'image bytes unchanged');
  assert.equal(seen[0].url, '/api/local/control/screenshot?maxWidth=600');
  assert.equal(seen[0].headers['x-rigs-caller'], '{"agent":"claude"}', 'the agent identity reaches the target gate');
  assert.ok(seen[0].headers['x-rigs-via'], 'the target learns which node the call entered on');
  assert.notEqual(seen[0].headers['x-rigs-token'], 'caller-secret', 'the caller token is replaced by the mesh token');
  assert.equal(seen[0].headers.cookie, undefined);
  const refused = await fetch(`${base}/api/nodes/peer/control/windows`);
  assert.equal(refused.status, 412);
  assert.deepEqual(await refused.json(), { error: 'screenshot needs Screen Recording', code: 'needs-permission', fix: { kind: 'settings' } });
});
