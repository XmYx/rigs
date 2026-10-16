import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { config } from './config.js';
import { HOME, isWin, run, upsertManagedBlock, which } from './util.js';

/**
 * Easy SSH: every node gets a mesh key (~/.ssh/rigs_ed25519). Peers verified by Tailscale identity
 * get each other's public keys authorized and an alias in ~/.ssh/config, so `ssh <machine-name>`
 * just works from any node to any node.
 */

// RIGS_SSH_DIR lets test instances keep their hands off the real ~/.ssh.
const SSH_DIR = process.env.RIGS_SSH_DIR ? path.resolve(process.env.RIGS_SSH_DIR) : path.join(HOME, '.ssh');
export const KEY = path.join(SSH_DIR, 'rigs_ed25519');

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
  }
  return result;
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
