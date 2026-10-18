#!/usr/bin/env node
// Live check of Linux (Wayland) control through a daemon run as a systemd --user service
// (docs/control-implementation.md, "Wayland service mode"). Run it on the Linux machine against a scratch dev daemon,
// never the real one:
//   node scripts/control/linux/live-check.js [http://127.0.0.1:4793]
// Checks that the helper got WAYLAND_DISPLAY and DBUS_SESSION_BUS_ADDRESS. When the screen is locked, it checks that
// every action fails with 'locked' within 10 s and exits 2. When unlocked, it writes /tmp/rigs-wayland-service-shot.png,
// opens its own GTK scratch window (a transient user unit), types into it only while AT-SPI reports that window
// as the active one, reads the text back and writes /tmp/rigs-wayland-service-typed.png. Exit code 0 only if all passed.
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

const base = (process.argv[2] || 'http://127.0.0.1:4793').replace(/\/$/, '') + '/api/local/control';
const title = 'RIGS Control service check', unit = 'rigs-live-check-scratch';
const out = '/tmp/rigs-wayland-service-text.txt', script = '/tmp/rigs-wayland-service-scratch.py';
const text = `RIGS wayland service check ${new Date().toISOString().slice(0, 19)}`;
let failed = 0;
const check = (ok, what, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'} ${what}${detail ? ` — ${detail}` : ''}`); if (!ok) failed++; return ok; };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function call(route, body) {
  const r = await fetch(route.startsWith('?') ? base + route : `${base}/${route}`, body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {});
  const type = r.headers.get('content-type') || '';
  const data = type.startsWith('image/') ? Buffer.from(await r.arrayBuffer()) : await r.json();
  if (!r.ok) throw Object.assign(new Error(`${route}: HTTP ${r.status} ${data.code}: ${data.error}`), { status: r.status, data });
  return data;
}
/** An action that must fail: the error code, and that it came back within 10 s. */
async function refused(what, route, body, code) {
  const started = Date.now();
  try { await call(route, body); return check(false, what, 'succeeded'); } catch (e) {
    const ms = Date.now() - started;
    return check(e.data?.code === code && ms < 10000, what, `HTTP ${e.status} ${e.data?.code} "${e.data?.error}" in ${ms} ms`);
  }
}
async function shot(file) {
  const png = await call('screenshot');
  fs.writeFileSync(file, png);
  const desc = execFileSync('file', [file], { encoding: 'utf8' }).trim();
  // A black or empty capture compresses to almost nothing.
  return check(/PNG image data/.test(desc) && png.length > 50000, `screenshot ${file}`, `${desc.split(': ')[1]}, ${png.length} bytes`);
}
const stopScratch = () => { try { execFileSync('systemctl', ['--user', 'stop', unit], { stdio: 'ignore' }); } catch {} };

const st = await call('?force=1');
console.log(`status: session ${st.session}, desktop ${st.desktop}, backend ${JSON.stringify({ capture: st.backend.capture, input: st.backend.input, windows: st.backend.windows })}, ready ${JSON.stringify(st.ready)}, locked ${st.locked}`);
check(st.session === 'wayland' && !!st.backend.capture && !!st.backend.input, 'Wayland session with capture and input backends');
const pid = st.backend.helper?.pid;
if (check(!!pid, 'helper running', `pid ${pid}`)) {
  const env = Object.fromEntries(fs.readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0').filter(Boolean).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
  for (const k of ['WAYLAND_DISPLAY', 'DBUS_SESSION_BUS_ADDRESS']) check(!!env[k], `helper environment has ${k}`, env[k]);
}
if (st.locked !== false) {
  await refused('screenshot while locked', 'screenshot', null, 'locked');
  await refused('type while locked', 'type', { text: 'x' }, 'locked');
  await refused('key while locked', 'key', { combo: 'ctrl++' }, 'locked');
  console.log(failed ? `${failed} check(s) failed` : 'Screen is locked: the locked path passed. Unlock it and run again for the screenshot and typing.');
  process.exit(failed ? 1 : 2);
}
if (!st.ready.see || !st.ready.act) { console.log('Not ready: switch control and input on in this scratch daemon.'); process.exit(1); }

try {
  await shot('/tmp/rigs-wayland-service-shot.png');
  fs.writeFileSync(out, '');
  fs.writeFileSync(script, `import gi
from pathlib import Path
gi.require_version('Gtk', '4.0')
from gi.repository import Gtk, GLib
class Scratch(Gtk.Application):
    def __init__(self):
        super().__init__(application_id='dev.rigs.ServiceCheck')
        self.connect('activate', self.activate)
    def activate(self, app):
        win = Gtk.ApplicationWindow(application=self, title=${JSON.stringify(title)})
        win.set_default_size(900, 220)
        entry = Gtk.Entry()
        entry.set_placeholder_text('RIGS control types here (scratch window)')
        entry.connect('changed', lambda w: Path(${JSON.stringify(out)}).write_text(w.get_text()))
        win.set_child(entry)
        win.present()
        entry.grab_focus()
        GLib.timeout_add_seconds(120, lambda: self.quit())
Scratch().run([])
`);
  stopScratch();
  execFileSync('systemd-run', ['--user', '--collect', `--unit=${unit}`, 'python3', script], { stdio: 'ignore' });
  let win;
  for (let i = 0; i < 40 && !win?.focused; i++) {
    await sleep(250);
    win = (await call('windows')).find((w) => w.title === title);
  }
  // Typing goes to whatever has focus, so never type unless the scratch window is the active one.
  if (!check(!!win?.focused, 'scratch window is the active window', win ? JSON.stringify(win) : 'not in the window list')) throw new Error('scratch window not focused');
  await refused('Unicode text is refused (no SetKeymap)', 'type', { text: 'é' }, 'unsupported');
  const typed = await call('type', { text });
  check(typed.typed === text.length, 'type', `${typed.typed} characters via ${typed.via ?? st.backend.input}`);
  let got = '';
  for (let i = 0; i < 20 && got !== text; i++) { await sleep(250); got = fs.readFileSync(out, 'utf8'); }
  check(got === text, 'typed text reached the scratch window', JSON.stringify(got));
  await shot('/tmp/rigs-wayland-service-typed.png');
} catch (e) { check(false, 'live check', e.message); } finally { stopScratch(); }
console.log(failed ? `${failed} check(s) failed` : 'all checks passed');
process.exit(failed ? 1 : 0);
