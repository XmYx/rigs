import https from 'node:https';
import net from 'node:net';
import { config } from './config.js';
import { bin } from './tools.js';
import { isMac, isWin, run, spawnCmd } from './util.js';

/**
 * Remote desktop. Preferred path is Sunshine (host) + Moonlight (client): hardware encode
 * (NVENC / VAAPI / QuickSync / VideoToolbox), works on Windows, macOS and Ubuntu Wayland (KMS capture).
 * Fallbacks: macOS Screen Sharing (High Performance mode between Apple-silicon Macs), RDP, VNC.
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
    sunshine: { installed: !!bin('sunshine'), running: sunshine, hw: true },
    vnc: { running: vnc, hw: isMac, note: isMac ? 'macOS Screen Sharing (High Performance on Apple silicon)' : '' },
    rdp: { running: rdp, hw: isWin },
  };
}

/** What this machine can use to view others. */
export function clientInfo() {
  return {
    moonlight: !!bin('moonlight') || !!flatpakMoonlight(),
    screenSharing: isMac,
    rdp: isWin || isMac || !!bin('remmina'),
    vnc: isMac || !!bin('remmina') || !!bin('vncviewer'),
  };
}

function flatpakMoonlight() {
  return !isMac && !isWin && bin('flatpak') ? 'flatpak' : null;
}

function moonlightCmd(args) {
  const m = bin('moonlight');
  if (m) return [m, args];
  return ['flatpak', ['run', 'com.moonlight_stream.Moonlight', ...args]];
}

/** Called on the TARGET by the client node during pairing: hand the PIN to the local Sunshine. */
export function sunshinePin(pin, name = 'rigs') {
  const { sunshineUser, sunshinePass } = config().desktop;
  const body = JSON.stringify({ pin: String(pin), name });
  return new Promise((resolve) => {
    const req = https.request({
      host: '127.0.0.1', port: 47990, path: '/api/pin', method: 'POST', rejectUnauthorized: false,
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), authorization: 'Basic ' + Buffer.from(`${sunshineUser}:${sunshinePass}`).toString('base64') },
      timeout: 8000,
    }, (res) => {
      let d = '';
      res.on('data', (c) => { d += c; });
      res.on('end', () => resolve({ ok: res.statusCode === 200 && !/"status":\s*false/.test(d), status: res.statusCode, body: d.slice(0, 300) }));
    });
    req.on('error', (e) => resolve({ ok: false, error: e.message }));
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, error: 'timeout' }); });
    req.end(body);
  });
}

function detached(cmd, args) {
  const p = spawnCmd(cmd, args, { detached: true, stdio: 'ignore' });
  p.unref();
  return p;
}

/**
 * Launch a native viewer on THIS machine (the one the person is sitting at) pointed at `target`.
 * `pairWithTarget(pin)` asks the target node to accept the Moonlight PIN.
 */
export async function connect({ address, platform, method = 'auto', targetHost }, pairWithTarget) {
  const c = clientInfo();
  const h = targetHost || {};
  let m = method;
  if (m === 'auto') {
    if (c.moonlight && h.sunshine?.running) m = 'moonlight';
    else if (isMac && platform === 'mac') m = 'vnc';
    else if (platform === 'windows' && h.rdp?.running) m = 'rdp';
    else if (h.vnc?.running) m = 'vnc';
    else if (h.sunshine?.running) m = 'moonlight';
    else m = 'none';
  }
  if (m === 'moonlight') {
    if (!c.moonlight) return { ok: false, method: m, message: 'Moonlight is not installed on this machine.' };
    const [cmd, listArgs] = moonlightCmd(['list', address]);
    const listed = await run(cmd, listArgs, { timeout: 15000 });
    if (listed.code !== 0 && pairWithTarget) {
      const pin = String(Math.floor(1000 + Math.random() * 9000));
      const [pc, pargs] = moonlightCmd(['pair', address, '--pin', pin]);
      const pairing = run(pc, pargs, { timeout: 60000 });
      await new Promise((r) => setTimeout(r, 2500));
      const accepted = await pairWithTarget(pin);
      const pr = await pairing;
      if (pr.code !== 0) return { ok: false, method: m, message: `Moonlight pairing failed: ${(pr.stderr || pr.stdout).trim().slice(0, 200)}${accepted?.ok ? '' : ' (target did not accept the PIN: ' + (accepted?.error || accepted?.status) + ')'}` };
    }
    const [sc, sargs] = moonlightCmd(['stream', address, 'Desktop']);
    detached(sc, sargs);
    return { ok: true, method: m, message: `Streaming ${address} with Moonlight (hardware accelerated).` };
  }
  if (m === 'vnc') {
    if (isMac) { detached('open', [`vnc://${address}`]); return { ok: true, method: m, message: 'Opened macOS Screen Sharing. Pick “High Performance” for hardware-accelerated mode between Apple-silicon Macs.' }; }
    if (bin('remmina')) { detached(bin('remmina'), ['-c', `vnc://${address}`]); return { ok: true, method: m, message: 'Opened Remmina (VNC).' }; }
    if (bin('vncviewer')) { detached(bin('vncviewer'), [address]); return { ok: true, method: m, message: 'Opened vncviewer.' }; }
    return { ok: false, method: m, message: 'No VNC viewer found.' };
  }
  if (m === 'rdp') {
    if (isWin) { detached('mstsc.exe', [`/v:${address}`]); return { ok: true, method: m, message: 'Opened Remote Desktop Connection.' }; }
    if (isMac) { detached('open', [`rdp://full%20address=s:${address}`]); return { ok: true, method: m, message: 'Opened Windows App (RDP).' }; }
    if (bin('remmina')) { detached(bin('remmina'), ['-c', `rdp://${address}`]); return { ok: true, method: m, message: 'Opened Remmina (RDP).' }; }
    return { ok: false, method: m, message: 'No RDP client found.' };
  }
  return { ok: false, method: 'none', message: 'No remote-desktop host is running on the target. Install Sunshine there (rigs setup --desktop).' };
}
