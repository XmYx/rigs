import crypto from 'node:crypto';
import { config } from './config.js';
import { isTailscaleIp, status, whois } from './tailscale.js';

export function clientIp(req) {
  return (req.socket?.remoteAddress || '').replace(/^::ffff:/, '');
}

export function isLoopback(ip) {
  return ip === '127.0.0.1' || ip === '::1' || ip.startsWith('127.');
}

function tokenOk(req) {
  const cfg = config();
  const given = req.headers['x-rigs-token'] || (req.headers.authorization || '').replace(/^Bearer\s+/i, '') || '';
  if (!given || !cfg.meshToken) return false;
  const a = Buffer.from(String(given));
  const b = Buffer.from(cfg.meshToken);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

async function loginAllowed(login, tags) {
  const cfg = config();
  if (cfg.allowedUsers?.length) return !!login && cfg.allowedUsers.includes(login);
  // Default: same owner as this machine. Tagged devices (servers) have no user login.
  const ts = await status();
  if (!login || login === 'tagged-devices') return !!cfg.allowTaggedDevices && (tags?.length > 0 || login === 'tagged-devices');
  return !!ts?.self?.login && login === ts.self.login;
}

/**
 * Who may talk to this node:
 *  - loopback (the person at this machine, or `tailscale serve` which adds identity headers)
 *  - peers presenting the mesh token (non-Tailscale LAN/container peers)
 *  - tailnet devices owned by the same Tailscale user (verified with `tailscale whois`)
 * Returns { ok, who, via }.
 */
export async function authorize(req) {
  const ip = clientIp(req);
  if (tokenOk(req)) return { ok: true, who: 'peer', via: 'token' };
  if (isLoopback(ip)) {
    const tsLogin = req.headers['tailscale-user-login'];
    if (tsLogin) {
      const ok = await loginAllowed(String(tsLogin), []);
      return { ok, who: String(tsLogin), via: 'tailscale-serve' };
    }
    return { ok: true, who: 'local', via: 'loopback' };
  }
  if (isTailscaleIp(ip)) {
    const w = await whois(ip);
    if (!w) return { ok: false, who: ip, via: 'tailscale-unknown' };
    const ok = await loginAllowed(w.login, w.tags);
    return { ok, who: w.login || w.node, via: 'tailscale' };
  }
  return { ok: false, who: ip, via: 'denied' };
}
