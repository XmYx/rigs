#!/usr/bin/env node
// Live check of macOS control through a daemon's /api/local/control/* (docs/control-implementation.md, "macOS helper").
// Needs RIGS Control's Screen Recording and Accessibility grants, an unlocked screen, and control + input on in
// that daemon (use a scratch RIGS_HOME dev daemon, never the real one):
//   node scripts/control/macos/live-check.js [http://127.0.0.1:4791]
// Writes /tmp/rigs-mac-shot.png, /tmp/rigs-mac-windows.json and /tmp/rigs-mac-textedit.png, and types into the scratch
// TextEdit document /tmp/rigs-mac-textedit.txt, which it saves (⌘S) and reads back. Exit code 0 only if all passed.
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

const base = (process.argv[2] || 'http://127.0.0.1:4791').replace(/\/$/, '') + '/api/local/control';
const doc = '/tmp/rigs-mac-textedit.txt', text = `RIGS mac live check ${new Date().toISOString()}`;
let failed = 0;
const check = (ok, what, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'} ${what}${detail ? ` — ${detail}` : ''}`); if (!ok) failed++; return ok; };
async function call(route, body) {
  const r = await fetch(route.startsWith('?') ? base + route : `${base}/${route}`, body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {});
  const type = r.headers.get('content-type') || '';
  const data = type.startsWith('image/') ? Buffer.from(await r.arrayBuffer()) : await r.json();
  if (!r.ok) throw Object.assign(new Error(`${route}: HTTP ${r.status} ${data.code}: ${data.error}${data.fix?.text ? ` (fix: ${data.fix.text})` : ''}`), { data });
  return data;
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function shot(file) {
  const png = await call('screenshot');
  fs.writeFileSync(file, png);
  const desc = execFileSync('file', [file], { encoding: 'utf8' }).trim();
  // A blank capture (no Screen Recording) compresses to almost nothing.
  return check(/PNG image data/.test(desc) && png.length > 50000, `screenshot ${file}`, `${desc.split(': ')[1]}, ${png.length} bytes`);
}

const st = await call('?force=1');
console.log(`status: ready ${JSON.stringify(st.ready)}, locked ${st.locked}, helper ${st.backend.helper?.path || st.backend.capture}`);
for (const k of ['screenCapture', 'input', 'accessibility']) check(st.permissions[k]?.ok === true, `grant ${k}`, st.permissions[k]?.fix?.text || st.permissions[k]?.via);
if (st.locked !== false || !st.ready.see || !st.ready.act) { console.log('Not ready (see above): unlock the Mac, switch control and input on in this daemon, grant RIGS Control.'); process.exit(1); }

try {
  await shot('/tmp/rigs-mac-shot.png');
  fs.writeFileSync(doc, '');
  execFileSync('open', ['-a', 'TextEdit', doc]);
  let win;
  for (let i = 0; i < 40 && !win; i++) {
    await sleep(250);
    const list = await call('windows');
    fs.writeFileSync('/tmp/rigs-mac-windows.json', JSON.stringify(list, null, 2));
    win = list.find((w) => w.app === 'TextEdit' && w.title.includes('rigs-mac-textedit'));
  }
  if (!check(!!win, 'window list has the scratch TextEdit document', '/tmp/rigs-mac-windows.json')) throw new Error('no TextEdit window');
  const list = JSON.parse(fs.readFileSync('/tmp/rigs-mac-windows.json', 'utf8'));
  check(list.length > 1 && list.every((w) => w.id && w.app && w.bounds), 'window list entries', `${list.length} windows: ${list.slice(0, 6).map((w) => `${w.app} "${w.title}"`).join(', ')}`);
  check((await call('focus', { id: win.id })).ok === true, 'focus', `window ${win.id}`);
  // Window bounds are global points; pointer coordinates are display pixels.
  const d = st.displays.find((x) => String(x.id) === String(win.display)) || st.displays[0];
  const x = Math.round((win.bounds.x + win.bounds.width / 2 - d.x) * d.scale), y = Math.round((win.bounds.y + win.bounds.height / 2 - d.y) * d.scale);
  check((await call('pointer', { action: 'click', x, y, display: d.id })).ok === true, 'pointer click into the document', `(${x}, ${y}) px on display ${d.id}`);
  const typed = await call('type', { text });
  check(typed.typed === [...text].length, 'type', `${typed.typed} characters via ${typed.via}`);
  await call('key', { combo: 'cmd+s' });
  let saved = '';
  for (let i = 0; i < 20 && !saved.includes(text); i++) { await sleep(250); saved = fs.readFileSync(doc, 'utf8'); }
  check(saved.includes(text), 'typed text reached TextEdit (saved with ⌘S and read back)', JSON.stringify(saved.slice(0, 80)));
  await shot('/tmp/rigs-mac-textedit.png');
} catch (e) { check(false, 'live check', e.message); }
console.log(failed ? `${failed} check(s) failed` : 'all checks passed');
process.exit(failed ? 1 : 0);
