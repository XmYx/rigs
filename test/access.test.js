// Access probes: parsing and decision logic only, from fixtures. No real TCC, D-Bus or uinput is touched.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

process.env.RIGS_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'rigs-access-'));
const A = await import('../src/access.js');
const R = await import('../src/rootsteps.js');

const BUS = `NAME                                  PID PROCESS
:1.21                             2485002 gnome-shell
org.gnome.Mutter.RemoteDesktop    2485002 gnome-shell
org.gnome.Mutter.ScreenCast       2485002 gnome-shell
org.freedesktop.portal.Desktop    2485971 xdg-desktop-por
org.a11y.Bus                         1234 at-spi-bus-laun
org.freedesktop.portal.Tracker           - (activatable)`;

test('parseBusNames: well-known names only, unique ids and headers skipped', () => {
  const n = A.parseBusNames(BUS);
  assert.ok(n.has('org.gnome.Mutter.ScreenCast') && n.has('org.a11y.Bus') && n.has('org.freedesktop.portal.Tracker'));
  assert.ok(!n.has(':1.21') && !n.has('NAME'));
  assert.equal(A.parseBusNames('').size, 0);
});

test('parseBusNumber: busctl property output', () => {
  assert.equal(A.parseBusNumber('u 2\n'), 2);
  assert.equal(A.parseBusNumber('i -1'), -1);
  assert.equal(A.parseBusNumber('Failed to get property'), null);
  assert.equal(A.parseBusNumber(''), null);
});

test('parseMacProbe: swift key=value output and the JXA fallback', () => {
  assert.deepEqual(A.parseMacProbe('ax=1\nscreen=0\npost=1\nautomation=-1743\n'), { ax: true, screen: false, post: true, automation: false, automationAsks: false });
  assert.equal(A.parseMacProbe('automation=-1744').automationAsks, true);
  assert.equal(A.parseMacProbe('automation=0').automation, true);
  assert.equal(A.parseMacProbe('automation=-600').automation, null);
  assert.equal(A.parseMacProbe('true\n').ax, true);
  assert.equal(A.parseMacProbe('false').ax, false);
  assert.deepEqual(A.parseMacProbe('garbage'), { ax: null, screen: null, post: null, automation: null, automationAsks: false });
});

test('decideMac: granted is true without a fix; denied points at the right pane', () => {
  const none = A.decideMac({ probe: A.parseMacProbe('ax=0\nscreen=0\npost=0\nautomation=-1743'), fullDiskAccess: false });
  assert.equal(none.screenCapture.ok, false);
  assert.equal(none.screenCapture.fix.url, A.MAC_PANES.screenCapture);
  assert.match(none.screenCapture.fix.url, /^x-apple\.systempreferences:.*Privacy_ScreenCapture$/);
  assert.equal(none.accessibility.fix.url, A.MAC_PANES.accessibility);
  assert.equal(none.input.ok, false);
  assert.equal(none.input.fix.url, A.MAC_PANES.accessibility);
  assert.equal(none.automation.fix.url, A.MAC_PANES.automation);
  const all = A.decideMac({ probe: A.parseMacProbe('ax=1\nscreen=1\npost=1\nautomation=0'), fullDiskAccess: true });
  for (const k of ['screenCapture', 'input', 'accessibility', 'automation']) { assert.equal(all[k].ok, true); assert.equal(all[k].fix, undefined); }
  const unknown = A.decideMac({ probe: A.parseMacProbe(''), fullDiskAccess: null });
  assert.equal(unknown.input.ok, null);
  assert.equal(unknown.screenCapture.ok, null);
});

const facts = (o = {}) => ({ session: true, sessionType: 'wayland', busNames: new Set(), tools: {}, ...o });

test('decideLinux: GNOME Wayland with Mutter needs nothing else', () => {
  const r = A.decideLinux(facts({ busNames: A.parseBusNames(BUS), atspi: true, portalRemoteDesktop: 2, portalScreenCast: 5 }));
  assert.deepEqual([r.screenCapture.ok, r.screenCapture.via, r.input.via], [true, 'mutter', 'mutter']);
  assert.equal(r.accessibility.partial, true);
  assert.equal(r.accessibility.via, 'at-spi');
});

test('decideLinux: Wayland without Mutter falls back portal → consent, uinput → input', () => {
  const portal = A.decideLinux(facts({ portalRemoteDesktop: 2, portalScreenCast: 5 }));
  assert.equal(portal.screenCapture.ok, null);
  assert.equal(portal.screenCapture.fix.kind, 'consent');
  assert.equal(portal.input.via, 'portal');
  const uin = A.decideLinux(facts({ uinputWritable: true, portalRemoteDesktop: 2 }));
  assert.deepEqual([uin.input.ok, uin.input.via], [true, 'uinput']);
});

test('decideLinux: nothing available → false with fix hints, uinput fix is a rootstep', () => {
  const r = A.decideLinux(facts());
  assert.equal(r.screenCapture.ok, false);
  assert.match(r.screenCapture.fix.text, /grim/);
  assert.equal(r.input.ok, false);
  assert.deepEqual([r.input.fix.kind, r.input.fix.id], ['rootstep', 'uinput']);
  assert.equal(r.accessibility.ok, false);
  assert.match(r.accessibility.fix.text, /atspi/);
});

test('decideLinux: ydotoold needs its socket; X11 uses xdotool and screenshot tools', () => {
  assert.equal(A.decideLinux(facts({ tools: { ydotoold: true } })).input.ok, false);
  assert.equal(A.decideLinux(facts({ tools: { ydotoold: true }, ydotoolSocket: true })).input.via, 'ydotool');
  const x = A.decideLinux(facts({ sessionType: 'x11', tools: { xdotool: true, scrot: true, wmctrl: true } }));
  assert.deepEqual([x.input.via, x.screenCapture.via, x.accessibility.via], ['xdotool', 'scrot', 'wmctrl']);
  const bare = A.decideLinux(facts({ sessionType: 'x11' }));
  assert.match(bare.input.fix.text, /xdotool/);
  assert.match(bare.screenCapture.fix.text, /scrot/);
});

test('decideLinux: no session bus → unknown with a relogin hint', () => {
  const r = A.decideLinux({ session: false });
  for (const k of ['screenCapture', 'input', 'accessibility']) { assert.equal(r[k].ok, null); assert.equal(r[k].fix.kind, 'relogin'); }
});

test('uinput root step: uaccess rule, never the input group', () => {
  const lines = R.uinputStepLines().join('\n');
  assert.match(lines, /TAG\+="uaccess"/);
  assert.match(lines, /60-rigs-uinput\.rules/);
  assert.match(lines, /modprobe uinput/);
  assert.doesNotMatch(lines, /usermod|gpasswd|adduser|\binput\b.*group/);
});

test('grant: unknown permission is refused without side effects', async () => {
  const r = await A.grant('nonsense');
  assert.equal(r.ok, false);
});
