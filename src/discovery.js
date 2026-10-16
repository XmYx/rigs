import { EventEmitter } from 'node:events';
import { config } from './config.js';
import { status as tsStatus } from './tailscale.js';
import { log } from './util.js';

/**
 * Finds every other RIGS node: all online Tailscale devices (probed on the mesh port) plus any
 * static peers from config. Tailnet devices that don't run RIGS yet still appear, so you can see
 * the whole tailnet and SSH/remote-desktop into them.
 */
export class Discovery extends EventEmitter {
  constructor(selfInfo) {
    super();
    this.selfInfo = selfInfo;
    this.nodes = new Map();
    this.timer = null;
    this.lastSig = '';
  }

  start() {
    this.tick();
    this.timer = setInterval(() => this.tick(), 15000);
    this.timer.unref?.();
  }

  stop() { clearInterval(this.timer); }

  headersFor(node) {
    return node?.viaToken ? { 'x-rigs-token': config().meshToken } : {};
  }

  async probe(url, viaToken) {
    const headers = viaToken ? { 'x-rigs-token': config().meshToken } : {};
    try {
      const r = await fetch(url.replace(/\/$/, '') + '/api/local/info?brief=1', { headers, signal: AbortSignal.timeout(3000) });
      if (!r.ok) return { error: `HTTP ${r.status}` };
      return { info: await r.json() };
    } catch (e) {
      return { error: e.cause?.code || e.name || 'unreachable' };
    }
  }

  async tick() {
    const cfg = config();
    const self = await this.selfInfo();
    const next = new Map();
    next.set(self.id, { ...self, self: true, online: true, rigs: true, lastSeen: Date.now() });

    const candidates = [];
    const ts = await tsStatus();
    if (ts) {
      for (const p of ts.peers) {
        const ip4 = p.ips.find((ip) => ip.includes('.'));
        candidates.push({ url: ip4 ? `http://${ip4}:${cfg.port}` : null, ts: p, viaToken: false });
      }
    }
    for (const url of cfg.peers || []) candidates.push({ url, ts: null, viaToken: true });

    await Promise.all(candidates.map(async (c) => {
      const res = c.url && (c.ts ? c.ts.online : true) ? await this.probe(c.url, c.viaToken) : { error: c.ts && !c.ts.online ? 'offline' : 'no address' };
      if (res.info && res.info.id && res.info.id !== self.id) {
        next.set(res.info.id, {
          ...res.info, url: c.url, address: new URL(c.url).hostname, self: false, online: true, rigs: true, viaToken: c.viaToken, lastSeen: Date.now(),
          tailscale: c.ts ? { ip: c.ts.ips[0], dnsName: c.ts.dnsName, os: c.ts.os, online: c.ts.online, login: c.ts.login } : res.info.tailscale,
        });
      } else if (c.ts) {
        // MagicDNS label is unique and DNS-safe (HostName can be "localhost" on iOS or contain spaces).
        const label = (c.ts.dnsName || '').split('.')[0] || c.ts.hostName.toLowerCase().replace(/[^a-z0-9-]+/g, '-');
        const id = 'ts:' + label;
        next.set(id, {
          id, name: label, url: c.url, self: false, rigs: false, online: c.ts.online,
          platform: tsOsToPlatform(c.ts.os), error: res.error,
          tailscale: { ip: c.ts.ips[0], dnsName: c.ts.dnsName, os: c.ts.os, online: c.ts.online, login: c.ts.login },
        });
      } else if (c.url) {
        const prev = [...this.nodes.values()].find((n) => n.url === c.url && !n.self);
        const id = prev?.id || 'peer:' + c.url;
        next.set(id, { ...(prev || {}), id, name: prev?.name || c.url.replace(/^https?:\/\//, ''), url: c.url, self: false, rigs: !!prev?.rigs, online: false, viaToken: true, error: res.error });
      }
    }));

    this.nodes = next;
    const sig = JSON.stringify([...next.values()].map((n) => [n.id, n.online, n.rigs, n.name, n.version]).sort());
    if (sig !== this.lastSig) {
      this.lastSig = sig;
      log(`mesh: ${[...next.values()].filter((n) => n.online && n.rigs).length} rigs node(s) online, ${next.size} device(s) total`);
      this.emit('change', this.list());
    }
  }

  list() {
    return [...this.nodes.values()].sort((a, b) => (b.self - a.self) || String(a.name).localeCompare(String(b.name)));
  }

  get(idOrName) {
    if (!idOrName || idOrName === 'self' || idOrName === 'local') return [...this.nodes.values()].find((n) => n.self);
    const key = String(idOrName).toLowerCase();
    return this.nodes.get(idOrName) || [...this.nodes.values()].find((n) => String(n.name).toLowerCase() === key || n.tailscale?.dnsName?.toLowerCase().startsWith(key + '.'));
  }
}

function tsOsToPlatform(os) {
  const o = String(os || '').toLowerCase();
  if (o.includes('mac')) return 'mac';
  if (o.includes('windows')) return 'windows';
  if (o.includes('ios')) return 'ios';
  if (o.includes('android')) return 'android';
  return 'linux';
}
