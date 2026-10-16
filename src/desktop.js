import fs from 'node:fs';
import https from 'node:https';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { config, RIGS_HOME } from './config.js';
import { pruneStale } from './moonlight-hosts.js';
import { bin } from './tools.js';
import { isLinux, isMac, isWin, log, run, sleep, spawnCmd } from './util.js';

/**
 * Remote desktop. Preferred path is Sunshine (host) + Moonlight (client): hardware encode
 * (NVENC / VAAPI / QuickSync / VideoToolbox), works on Windows, macOS and Ubuntu Wayland (KMS capture).
 * Fallbacks: macOS Screen Sharing (High Performance mode between Apple-silicon Macs), RDP, VNC.
 *
 * Pairing is automatic: the viewer runs `moonlight pair <host> --pin <pin>` with a PIN RIGS picks,
 * and the target's RIGS node answers the matching pending request in its local Sunshine
 * (GET /api/pin → pairing_id, POST {pairing_id, pin}). Pairings started from Moonlight's own window
 * can be answered from JARVIS (pendingPairings / acceptPairing).
 */

function portOpen(port, host = '127.0.0.1', timeout = 600) {
  return new Promise((resolve) => {
    const s = net.connect({ port, host });
    const done = (v) => { s.destroy(); resolve(v); };
    s.setTimeout(timeout, () => done(false));
    s.on('connect', () => done(true));
    s.on('error', () => done(false));
  });
}

/** What this machine can serve to others. */
export async function hostInfo() {
  const [sunshine, vnc, rdp] = await Promise.all([portOpen(47989), portOpen(5900), portOpen(3389)]);
  return {
    sunshine: { installed: !!bin('sunshine'), running: sunshine, hw: true, capturePermission: macCapturePermission() },
    vnc: { running: vnc, hw: isMac, note: isMac ? 'macOS Screen Sharing (High Performance on Apple silicon)' : '' },
    rdp: { running: rdp, hw: isWin },
  };
}

/** What this machine can use to view others. */
export function clientInfo() {
  return {
    moonlight: !!bin('moonlight'),
    screenSharing: isMac,
    rdp: isWin || isMac || !!bin('remmina'),
    vnc: isMac || !!bin('remmina') || !!bin('vncviewer'),
  };
}

// ---------------------------------------------------------------- Sunshine (target side)

function sunshineApi(method, apiPath, body) {
  const { sunshineUser, sunshinePass } = config().desktop;
  const data = body === undefined ? null : JSON.stringify(body);
  return new Promise((resolve) => {
    const req = https.request({
      host: '127.0.0.1', port: 47990, path: apiPath, method, rejectUnauthorized: false, timeout: 8000,
      headers: { authorization: 'Basic ' + Buffer.from(`${sunshineUser}:${sunshinePass}`).toString('base64'), ...(data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {}) },
    }, (res) => {
      let d = '';
      res.on('data', (c) => { d += c; });
      res.on('end', () => { let json = null; try { json = JSON.parse(d); } catch {} resolve({ status: res.statusCode, json, text: d.slice(0, 400) }); });
    });
    req.on('error', (e) => resolve({ status: 0, error: e.message }));
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, error: 'timeout' }); });
    req.end(data || undefined);
  });
}

/** Pending Moonlight pairing requests waiting on this machine's Sunshine. */
export async function pendingPairings() {
  const r = await sunshineApi('GET', '/api/pin');
  if (r.status === 401) return { ok: false, error: 'Sunshine rejected the RIGS credentials — run `rigs desktop --force` on this machine' };
  if (!r.json || !Array.isArray(r.json.pairings)) return { ok: false, error: r.error || `Sunshine answered ${r.status}`, legacy: r.status === 404 || r.status === 405 };
  return { ok: true, pairings: r.json.pairings };
}

export async function acceptPairing(pairingId, pin, name = 'rigs') {
  const r = await sunshineApi('POST', '/api/pin', { pairing_id: pairingId, pin: String(pin), name });
  return { ok: r.json?.status === true, status: r.status, error: r.json?.error || r.error };
}

/**
 * Called on the TARGET by the viewer's node: wait for the viewer's pending request (matched by its
 * address; the only pending one otherwise) and answer it with the agreed PIN.
 */
export async function sunshinePin(pin, name = 'rigs', clientAddress = '') {
  for (let i = 0; i < 25; i++) {
    const p = await pendingPairings();
    if (!p.ok) {
      if (p.legacy) { // Sunshine before pairing ids: one POST with the PIN.
        const r = await sunshineApi('POST', '/api/pin', { pin: String(pin), name });
        return { ok: r.json?.status === true || /true/.test(r.text || ''), legacy: true };
      }
      return { ok: false, error: p.error };
    }
    const match = p.pairings.find((x) => clientAddress && x.address === clientAddress) || (p.pairings.length === 1 ? p.pairings[0] : null);
    if (match) {
      const r = await acceptPairing(match.id, pin, name);
      log(`desktop: pairing from ${match.address} (${match.name}) ${r.ok ? 'accepted' : 'failed: ' + r.error}`);
      return { ...r, pairingId: match.id, address: match.address };
    }
    await sleep(1000);
  }
  return { ok: false, error: `no pairing request from ${clientAddress || 'the viewer'} arrived at Sunshine` };
}

// ---------------------------------------------------------------- Moonlight (viewer side)

let sessionEnv = { at: 0, vars: {} };

/** Linux: the graphical session's DISPLAY / WAYLAND_DISPLAY / XAUTHORITY as GNOME/KDE export them to systemd. */
async function refreshSessionEnv() {
  if (!isLinux || Date.now() - sessionEnv.at < 30000) return;
  const r = await run('systemctl', ['--user', 'show-environment'], { timeout: 5000 });
  const vars = {};
  for (const l of r.stdout.split('\n')) {
    const m = l.match(/^(DISPLAY|WAYLAND_DISPLAY|XAUTHORITY|XDG_RUNTIME_DIR|DBUS_SESSION_BUS_ADDRESS|XDG_SESSION_TYPE|XDG_CURRENT_DESKTOP)=(.*)$/);
    if (m) vars[m[1]] = m[2];
  }
  sessionEnv = { at: Date.now(), vars };
}

/** Env for GUI apps launched by the background service: point them at the user's desktop session. */
function guiEnv() {
  const env = { ...process.env, ...sessionEnv.vars };
  if (isLinux) {
    const uid = os.userInfo().uid;
    const run_ = `/run/user/${uid}`;
    env.XDG_RUNTIME_DIR ||= run_;
    if (!env.WAYLAND_DISPLAY) { const w = fs.existsSync(path.join(run_, 'wayland-0')) ? 'wayland-0' : ''; if (w) env.WAYLAND_DISPLAY = w; }
    if (!env.DISPLAY && fs.existsSync('/tmp/.X11-unix/X0')) env.DISPLAY = ':0';
    env.DBUS_SESSION_BUS_ADDRESS ||= `unix:path=${run_}/bus`;
  }
  return env;
}

function moonlight(args) {
  const m = bin('moonlight');
  if (m) return [m, args];
  return ['flatpak', ['run', 'com.moonlight_stream.Moonlight', ...args]];
}

function detached(cmd, args, env) {
  const logFile = path.join(RIGS_HOME, 'logs', 'viewer.log');
  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  const fd = fs.openSync(logFile, 'a');
  const p = spawnCmd(cmd, args, { detached: true, stdio: ['ignore', fd, fd], env: env || guiEnv() });
  p.unref();
  return p;
}

async function moonlightPaired(address) {
  const [cmd, args] = moonlight(['list', address]);
  const r = await run(cmd, args, { timeout: 25000, env: guiEnv() });
  return { ok: r.code === 0 && /desktop/i.test(r.stdout + r.stderr), apps: (r.stdout || '').split('\n').map((s) => s.trim()).filter((s) => s && !/^Redirecting/.test(s)), out: (r.stdout + r.stderr).trim() };
}

/**
 * Launch a native viewer on THIS machine pointed at the target. `pairWithTarget(pin, myAddress)`
 * asks the target's node to accept the PIN. Returns { ok, method, message, steps }.
 */
export async function connect({ address, platform, method = 'auto', targetHost, myAddress = '' }, pairWithTarget) {
  await refreshSessionEnv();
  const c = clientInfo();
  const h = targetHost || {};
  const steps = [];
  let m = method;
  if (m === 'auto') {
    if (c.moonlight && h.sunshine?.running) m = 'moonlight';
    else if (isMac && platform === 'mac') m = 'vnc';
    else if (platform === 'windows' && h.rdp?.running) m = 'rdp';
    else if (h.vnc?.running) m = 'vnc';
    else m = h.sunshine?.running ? 'moonlight' : 'none';
  }
  if (m === 'moonlight') {
    if (!c.moonlight) return { ok: false, method: m, message: 'Moonlight is not installed on this machine (rigs desktop installs it).', steps };
    const pruned = await pruneStale(address).catch(() => ({}));
    if (pruned.dropped) steps.push(`removed ${pruned.dropped} stale Moonlight entr${pruned.dropped > 1 ? 'ies' : 'y'} for ${pruned.live.hostname}`);
    let state = await moonlightPaired(address);
    if (!state.ok) {
      if (!pairWithTarget) return { ok: false, method: m, message: 'Not paired yet.', steps };
      const pin = String(Math.floor(1000 + Math.random() * 9000));
      steps.push(`pairing with PIN ${pin}`);
      const [pc, pargs] = moonlight(['pair', address, '--pin', pin]);
      const pairing = run(pc, pargs, { timeout: 90000, env: guiEnv() });
      const accepted = await pairWithTarget(pin, myAddress).catch((e) => ({ ok: false, error: e.message }));
      steps.push(accepted?.ok ? 'target accepted the PIN' : `target could not accept the PIN: ${accepted?.error || 'unknown'}`);
      const pr = await pairing;
      state = await moonlightPaired(address);
      if (!state.ok) return { ok: false, method: m, message: `Pairing did not complete${accepted?.ok ? '' : ` — ${accepted?.error || 'the target did not accept the PIN'}`}. You can also enter Moonlight's PIN in JARVIS (target machine → Desktop → pending pairing).`, steps, detail: (pr.stdout + pr.stderr).trim().slice(-300) };
      steps.push('paired');
    } else steps.push('already paired');
    const [sc, sargs] = moonlight(['stream', address, 'Desktop', '--quit-after']);
    detached(sc, sargs);
    steps.push('stream started');
    return { ok: true, method: m, message: `Streaming ${address} with Moonlight (hardware accelerated).`, steps };
  }
  if (m === 'vnc') {
    if (isMac) { detached('open', [`vnc://${address}`]); return { ok: true, method: m, message: 'Opened macOS Screen Sharing. Pick “High Performance” for hardware-accelerated mode between Apple-silicon Macs.', steps }; }
    if (bin('remmina')) { detached(bin('remmina'), ['-c', `vnc://${address}`]); return { ok: true, method: m, message: 'Opened Remmina (VNC).', steps }; }
    if (bin('vncviewer')) { detached(bin('vncviewer'), [address]); return { ok: true, method: m, message: 'Opened vncviewer.', steps }; }
    return { ok: false, method: m, message: 'No VNC viewer found.', steps };
  }
  if (m === 'rdp') {
    if (isWin) { detached('mstsc.exe', [`/v:${address}`]); return { ok: true, method: m, message: 'Opened Remote Desktop Connection.', steps }; }
    if (isMac) { detached('open', [`rdp://full%20address=s:${address}`]); return { ok: true, method: m, message: 'Opened Windows App (RDP).', steps }; }
    if (bin('remmina')) { detached(bin('remmina'), ['-c', `rdp://${address}`]); return { ok: true, method: m, message: 'Opened Remmina (RDP).', steps }; }
    return { ok: false, method: m, message: 'No RDP client found.', steps };
  }
  return { ok: false, method: 'none', message: 'No remote-desktop host is running on the target. Install Sunshine there (rigs desktop).', steps };
}

/** End a stream this machine is viewing. */
export async function quit(address) {
  await refreshSessionEnv();
  const [cmd, args] = moonlight(['quit', address]);
  const r = await run(cmd, args, { timeout: 20000, env: guiEnv() });
  if (r.code === 0) return { ok: true, how: 'moonlight quit' };
  // Fall back to closing the viewer window(s) on this machine.
  if (isWin) await run('taskkill', ['/IM', 'Moonlight.exe', '/F'], { timeout: 10000 });
  else await run('pkill', ['-f', isMac ? 'Moonlight.app/Contents/MacOS/Moonlight' : 'Moonlight'], { timeout: 10000 });
  return { ok: true, how: 'closed the viewer', note: (r.stdout + r.stderr).trim().slice(-160) };
}

/** macOS: Sunshine can't capture the screen until it has the Screen Recording permission. */
export function macCapturePermission() {
  if (!isMac) return null;
  try {
    const t = fs.readFileSync(path.join(RIGS_HOME, 'logs', 'sunshine.log'), 'utf8');
    const lastStart = t.lastIndexOf('Sunshine version');
    const tail = lastStart >= 0 ? t.slice(lastStart) : t;
    return !/No screen capture permission/.test(tail);
  } catch { return null; }
}

export async function restartSunshine() {
  if (isMac) return run('launchctl', ['kickstart', '-k', `gui/${os.userInfo().uid}/dev.rigs.sunshine`], { timeout: 15000 });
  if (isLinux) return run('systemctl', ['--user', 'restart', 'app-dev.lizardbyte.app.Sunshine'], { timeout: 20000 });
  return run('powershell.exe', ['-NoProfile', '-Command', 'Restart-Service SunshineService -ErrorAction SilentlyContinue'], { timeout: 30000 });
}

export async function openCapturePermissionSettings() {
  if (!isMac) return { ok: false };
  await run('open', ['x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture'], { timeout: 10000 });
  return { ok: true };
}
