import { isMac, isWin, run, which } from './util.js';

const EXTRA = isMac
  ? ['/Applications/Tailscale.app/Contents/MacOS/Tailscale', '/opt/homebrew/bin/tailscale', '/usr/local/bin/tailscale']
  : isWin
    ? ['C:\\Program Files\\Tailscale\\tailscale.exe']
    : ['/usr/bin/tailscale', '/usr/sbin/tailscale'];

export function tailscaleBin() {
  return which('tailscale', EXTRA);
}

let statusCache = { at: 0, value: null };
let lastGood = { at: 0, value: null };
/** How long a good status stands in for a failed or timed-out `tailscale status` (a busy machine, a tailscaled hiccup). */
const STALE_OK_MS = 180000;

/** Parsed `tailscale status --json`, cached for a few seconds. Null when Tailscale isn't available. */
export async function status(maxAgeMs = 5000) {
  if (Date.now() - statusCache.at < maxAgeMs) return statusCache.value;
  const bin = tailscaleBin();
  let value = null;
  if (bin) {
    const r = await run(bin, ['status', '--json'], { timeout: 10000 });
    if (r.code === 0) {
      try {
        const j = JSON.parse(r.stdout);
        const users = j.User || {};
        const login = (uid) => users[uid]?.LoginName || null;
        const self = j.Self || {};
        value = {
          backendState: j.BackendState,
          magicDNSSuffix: j.MagicDNSSuffix || '',
          self: {
            hostName: self.HostName,
            dnsName: (self.DNSName || '').replace(/\.$/, ''),
            ips: self.TailscaleIPs || [],
            os: self.OS,
            login: login(self.UserID),
            online: true,
          },
          peers: Object.values(j.Peer || {}).map((p) => ({
            hostName: p.HostName,
            dnsName: (p.DNSName || '').replace(/\.$/, ''),
            ips: p.TailscaleIPs || [],
            os: p.OS,
            online: !!p.Online,
            login: login(p.UserID),
            tags: p.Tags || [],
            lastSeen: p.LastSeen,
          })),
        };
      } catch {}
    }
  }
  if (value) lastGood = { at: Date.now(), value };
  else if (bin && lastGood.value && Date.now() - lastGood.at < STALE_OK_MS) value = lastGood.value;
  statusCache = { at: Date.now(), value };
  return value;
}

export async function selfIps() {
  const s = await status();
  return s?.self?.ips || [];
}

let sshCache = { at: 0, value: null };

/** Does Tailscale SSH answer port 22 on the tailnet? true/false, null when Tailscale can't tell. Cached for a minute. */
export async function sshServerEnabled() {
  if (Date.now() - sshCache.at < 60000) return sshCache.value;
  const bin = tailscaleBin();
  let value = false;
  if (bin) {
    const r = await run(bin, ['debug', 'prefs'], { timeout: 6000 });
    value = r.code === 0 && /"RunSSH"\s*:/.test(r.stdout) ? /"RunSSH"\s*:\s*true/.test(r.stdout) : null;
  }
  sshCache = { at: Date.now(), value };
  return value;
}

const whoisCache = new Map();

/** Identity of a tailnet peer by IP: { login, node, tags }. Cached for a minute. */
export async function whois(ip) {
  const hit = whoisCache.get(ip);
  if (hit && Date.now() - hit.at < 60000) return hit.value;
  const bin = tailscaleBin();
  let value = null;
  if (bin) {
    const r = await run(bin, ['whois', '--json', ip], { timeout: 5000 });
    if (r.code === 0) {
      try {
        const j = JSON.parse(r.stdout);
        value = {
          login: j.UserProfile?.LoginName || null,
          node: (j.Node?.Name || '').replace(/\.$/, ''),
          tags: j.Node?.Tags || [],
        };
      } catch {}
    }
  }
  whoisCache.set(ip, { at: Date.now(), value });
  return value;
}

export function isTailscaleIp(ip) {
  if (!ip) return false;
  ip = ip.replace(/^::ffff:/, '');
  if (ip.toLowerCase().startsWith('fd7a:115c:a1e0:')) return true;
  const m = ip.match(/^(\d+)\.(\d+)\.\d+\.\d+$/);
  if (!m) return false;
  const a = Number(m[1]);
  const b = Number(m[2]);
  return a === 100 && b >= 64 && b <= 127; // 100.64.0.0/10 CGNAT range used by Tailscale
}

/** Expose the local UI over HTTPS on the tailnet (needed for the microphone in browsers). */
export async function enableServe(port) {
  const bin = tailscaleBin();
  if (!bin) return { ok: false, message: 'tailscale not installed' };
  const r = await run(bin, ['serve', '--bg', '--https=443', `http://127.0.0.1:${port}`], { timeout: 20000 });
  return { ok: r.code === 0, message: (r.stdout + r.stderr).trim() };
}
