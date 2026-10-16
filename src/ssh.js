import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { config } from './config.js';
import { sshServerEnabled } from './tailscale.js';
import { HOME, MANAGED_END, MANAGED_START, applyManagedBlock, isWin, run, upsertManagedBlock, which } from './util.js';

/**
 * Easy SSH: every node gets a mesh key (~/.ssh/rigs_ed25519). Peers verified by Tailscale identity
 * get each other's public keys authorized and an alias in ~/.ssh/config, so `ssh <machine-name>`
 * just works from any node to any node. Each node also publishes its OpenSSH host keys, and peers
 * pin them in ~/.ssh/known_hosts, so a changed host key (e.g. Tailscale SSH → OpenSSH) never
 * trips strict host key checking.
 */

// RIGS_SSH_DIR lets test instances keep their hands off the real ~/.ssh.
const SSH_DIR = process.env.RIGS_SSH_DIR ? path.resolve(process.env.RIGS_SSH_DIR) : path.join(HOME, '.ssh');
export const KEY = path.join(SSH_DIR, 'rigs_ed25519');
const KNOWN_HOSTS = path.join(SSH_DIR, 'known_hosts');
// Where sshd keeps its host keys (RIGS_SSH_HOST_KEY_DIR for tests).
const HOST_KEY_DIR = process.env.RIGS_SSH_HOST_KEY_DIR ? path.resolve(process.env.RIGS_SSH_HOST_KEY_DIR) : isWin ? 'C:\\ProgramData\\ssh' : '/etc/ssh';

export async function ensureKey() {
  if (fs.existsSync(KEY) && fs.existsSync(KEY + '.pub')) return KEY;
  await fsp.mkdir(SSH_DIR, { recursive: true, mode: 0o700 });
  const keygen = which('ssh-keygen', isWin ? ['C:\\Windows\\System32\\OpenSSH\\ssh-keygen.exe'] : []);
  if (!keygen) return null;
  const r = await run(keygen, ['-q', '-t', 'ed25519', '-N', '', '-C', `rigs@${config().name}`, '-f', KEY], { timeout: 20000 });
  return r.code === 0 ? KEY : null;
}

export function publicKey() {
  try { return fs.readFileSync(KEY + '.pub', 'utf8').trim(); } catch { return null; }
}

export function sshUser() {
  return os.userInfo().username;
}

/** Per-user authorized_keys (install.ps1 relaxes sshd_config so Windows admins use it too). */
function authorizedKeysFile() {
  return path.join(SSH_DIR, 'authorized_keys');
}

export async function syncPeers(peers) {
  const cfg = config();
  const result = { authorized: 0, aliases: 0 };
  // Only peers whose identity Tailscale vouched for get keys/aliases; static (token) peers need opt-in.
  const verified = peers.filter((p) => p.rigs && p.online && !p.self && (!p.viaToken || cfg.ssh.authorizeStaticPeers));
  if (cfg.ssh.autoAuthorize) {
    const keys = verified.filter((p) => p.sshPubKey && /^ssh-ed25519 [A-Za-z0-9+/=]+/.test(p.sshPubKey))
      .map((p) => `${p.sshPubKey.split(' ').slice(0, 2).join(' ')} rigs-peer:${p.name}`);
    if (keys.length) {
      const changed = await upsertManagedBlock(authorizedKeysFile(), keys.join('\n'), { mode: 0o600 });
      if (changed && !isWin) await fsp.chmod(authorizedKeysFile(), 0o600).catch(() => {});
      result.authorized = keys.length;
    }
  }
  if (cfg.ssh.manageConfig) {
    const blocks = verified.filter((p) => p.sshUser && (p.tailscale?.ip || p.address)).map((p) => [
      `Host ${p.name} ${p.name}.rigs`,
      `  HostName ${p.tailscale?.dnsName || p.tailscale?.ip || p.address}`,
      `  User ${p.sshUser}`,
      `  IdentityFile ${KEY}`,
      '  IdentitiesOnly yes',
      '  StrictHostKeyChecking accept-new',
      '  ServerAliveInterval 30',
    ].join('\n'));
    if (blocks.length) {
      await upsertManagedBlock(path.join(SSH_DIR, 'config'), blocks.join('\n\n'), { mode: 0o600 });
      result.aliases = blocks.length;
    }
    const pins = await syncKnownHosts(verified);
    result.hostKeys = pins.pinned;
    result.replaced = pins.replaced;
  }
  return result;
}

const HOST_KEY_RE = /^(ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp(?:256|384|521)) [A-Za-z0-9+/]+={0,3}$/;

/** "type base64" of a public key line, or null if it isn't a host key sshd serves. */
function hostKey(line) {
  const k = String(line || '').trim().split(/\s+/).slice(0, 2).join(' ');
  return HOST_KEY_RE.test(k) ? k : null;
}

/**
 * This machine's OpenSSH host keys, published in node info for peers to pin. Null when there are
 * none, or when Tailscale SSH answers port 22 on the tailnet instead (with its own keys).
 */
export async function hostKeys() {
  if ((await sshServerEnabled()) !== false) return null;
  let files;
  try { files = (await fsp.readdir(HOST_KEY_DIR)).filter((f) => /^ssh_host_\w+_key\.pub$/.test(f)).sort(); } catch { return null; }
  const keys = [];
  for (const f of files) {
    const k = hostKey(await fsp.readFile(path.join(HOST_KEY_DIR, f), 'utf8').catch(() => ''));
    if (k) keys.push(k);
  }
  return keys.length ? keys : null;
}

/** Names ssh looks a peer up by, as OUR tailscale status reports them: MagicDNS name, short name, tailnet IPs. */
function tailnetNames(p) {
  const dns = String(p.tailscale?.dnsName || '').toLowerCase().replace(/\.$/, '');
  return [...new Set([dns, dns.split('.')[0], ...(p.tailscale?.ips || [p.tailscale?.ip])].filter(Boolean))];
}

/** Does a known_hosts host entry (plain, or hashed as |1|salt|hash) name exactly `host`? */
function namesHost(entry, host) {
  if (!entry.startsWith('|1|')) return entry.toLowerCase() === host;
  const [, , salt, hash] = entry.split('|');
  try { return crypto.createHmac('sha1', Buffer.from(salt, 'base64')).update(host).digest('base64') === hash; } catch { return false; }
}

/**
 * Pin peers' published host keys in a known_hosts text. The managed block lists each key under the
 * peer's tailnet names; entries elsewhere that pin one of those names to a key the peer does NOT
 * publish are dropped (that stale entry is what made ssh refuse a peer after it moved from Tailscale
 * SSH to OpenSSH). Only Tailscale-verified peers count: their names come from our own tailscale
 * status and their keys from their API on that tailnet IP, so a peer can only vouch for itself.
 * Wildcards, [host]:port, @cert-authority/@revoked lines and other hosts are never touched. Pure.
 */
export function pinHostKeys(text, peers) {
  const pins = new Map(); // tailnet name → the keys its peer publishes
  const lines = [];
  let pinned = 0;
  for (const p of peers) {
    if (p.viaToken || p.self || !p.tailscale) continue;
    const keys = [...new Set((Array.isArray(p.sshHostKeys) ? p.sshHostKeys : []).map(hostKey).filter(Boolean))];
    const names = tailnetNames(p);
    if (!keys.length || !names.length) continue;
    pinned++;
    for (const n of names) pins.set(n, keys);
    for (const k of keys) lines.push(`${names.join(',')} ${k} rigs-peer:${p.name}`);
  }
  const replaced = new Set();
  const isStale = (entry, key) => {
    for (const [name, keys] of pins) if (namesHost(entry, name) && !keys.includes(key)) { replaced.add(name); return true; }
    return false;
  };
  let inBlock = false;
  const kept = [];
  for (const line of text.split('\n')) {
    if (line === MANAGED_START) inBlock = true;
    if (inBlock || !line.trim() || /^\s*[#@]/.test(line)) {
      kept.push(line);
      if (line === MANAGED_END) inBlock = false;
      continue;
    }
    const [hosts, type, b64] = line.trim().split(/\s+/);
    const all = hosts.split(',');
    const left = all.filter((h) => !isStale(h, `${type} ${b64}`));
    if (left.length === all.length) kept.push(line);
    else if (left.length) kept.push(line.replace(hosts, () => left.join(',')));
  }
  let next = kept.join('\n');
  if (lines.length || next.includes(MANAGED_START)) next = applyManagedBlock(next, lines.join('\n'));
  return { text: next, pinned, replaced: [...replaced] };
}

async function syncKnownHosts(peers) {
  let text = '';
  try { text = await fsp.readFile(KNOWN_HOSTS, 'utf8'); } catch {}
  const r = pinHostKeys(text, peers);
  if (r.text !== text) {
    await fsp.mkdir(SSH_DIR, { recursive: true, mode: 0o700 });
    // Like ssh-keygen -R: keep the previous file (as private as the original) when entries outside our block were dropped.
    if (r.replaced.length) {
      const old = KNOWN_HOSTS + '.rigs.old';
      await fsp.writeFile(old, text, { mode: 0o600 });
      if (!isWin) await fsp.chmod(old, (await fsp.stat(KNOWN_HOSTS)).mode & 0o777).catch(() => {});
    }
    await fsp.writeFile(KNOWN_HOSTS, r.text);
  }
  return r;
}

/** Is an SSH server listening on this machine? */
export async function serverStatus() {
  if (isWin) {
    const r = await run('powershell.exe', ['-NoProfile', '-Command', '(Get-Service sshd -ErrorAction SilentlyContinue).Status'], { timeout: 8000 });
    return { running: /Running/i.test(r.stdout), detail: r.stdout.trim() || 'not installed' };
  }
  const net = await import('node:net');
  const ok = await new Promise((resolve) => {
    const s = net.connect({ port: 22, host: '127.0.0.1' });
    s.setTimeout(700, () => { s.destroy(); resolve(false); });
    s.on('connect', () => { s.destroy(); resolve(true); });
    s.on('error', () => resolve(false));
  });
  return { running: ok, detail: ok ? 'listening on :22' : 'no ssh server on :22 (or use Tailscale SSH)' };
}
