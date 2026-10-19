import { EventEmitter } from 'node:events';
import { config } from './config.js';
import { status as tsStatus } from './tailscale.js';
import { log } from './util.js';

/**
 * A peer that answered recently stays online through this many ms of failed probes. One slow answer (a busy
 * machine, a RIGS restart after an update, a Tailscale path change) must not drop it from every view.
 */
export const GRACE_MS = 75000;
const PROBE_TIMEOUT_MS = 6000;

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
    this.ticking = null;
  }

  start() {
    this.tick().catch(() => {});
    this.timer = setInterval(() => this.tick().catch(() => {}), 15000);
    this.timer.unref?.();
  }

  stop() { clearInterval(this.timer); }

  headersFor(node) {
    return node?.viaToken ? { 'x-rigs-token': config().meshToken } : {};
  }

  async probe(url, viaToken) {
    const headers = viaToken ? { 'x-rigs-token': config().meshToken } : {};
    try {
      const r = await fetch(url.replace(/\/$/, '') + '/api/local/info?brief=1', { headers, signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
      if (!r.ok) return { error: `HTTP ${r.status}` };
      return { info: await r.json() };
    } catch (e) {
      return { error: e.cause?.code || e.name || 'unreachable' };
    }
  }

  /**
   * One discovery round. Rounds never overlap (on a loaded machine they would only pile up and slow each other):
   * a call during a round waits for that round.
   */
  tick() {
    if (!this.ticking) this.ticking = this.round().finally(() => { this.ticking = null; });
    return this.ticking;
  }

  /** The previous entry for this candidate, if it was a RIGS node seen within the grace window. */
  recent(url) {
    if (!url) return null;
    const prev = [...this.nodes.values()].find((n) => !n.self && n.rigs && n.url === url);
    return prev && prev.lastSeen && Date.now() - prev.lastSeen < GRACE_MS ? prev : null;
  }

  async round() {
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
      const recent = this.recent(c.url);
      // Tailscale's Online flag is control-plane presence and blips; still probe a node that answered recently.
      const res = c.url && (c.ts ? c.ts.online || recent : true) ? await this.probe(c.url, c.viaToken) : { error: c.ts && !c.ts.online ? 'offline' : 'no address' };
      if (!res.info && recent) {
        next.set(recent.id, { ...recent, online: true, stale: true, error: res.error });
      } else if (res.info && res.info.id && res.info.id !== self.id) {
        next.set(res.info.id, {
          ...res.info, url: c.url, address: new URL(c.url).hostname, self: false, online: true, rigs: true, stale: false, error: undefined, viaToken: c.viaToken, lastSeen: Date.now(),
          tailscale: c.ts ? { ip: c.ts.ips[0], ips: c.ts.ips, dnsName: c.ts.dnsName, os: c.ts.os, online: c.ts.online, login: c.ts.login } : res.info.tailscale,
        });
      } else if (c.ts) {
        // MagicDNS label is unique and DNS-safe (HostName can be "localhost" on iOS or contain spaces).
        const label = (c.ts.dnsName || '').split('.')[0] || c.ts.hostName.toLowerCase().replace(/[^a-z0-9-]+/g, '-');
        const id = 'ts:' + label;
        next.set(id, {
          id, name: label, url: c.url, self: false, rigs: false, online: c.ts.online,
          platform: tsOsToPlatform(c.ts.os), error: res.error,
          tailscale: { ip: c.ts.ips[0], ips: c.ts.ips, dnsName: c.ts.dnsName, os: c.ts.os, online: c.ts.online, login: c.ts.login },
        });
      } else if (c.url) {
        const prev = [...this.nodes.values()].find((n) => n.url === c.url && !n.self);
        const id = prev?.id || 'peer:' + c.url;
        next.set(id, { ...(prev || {}), id, name: prev?.name || c.url.replace(/^https?:\/\//, ''), url: c.url, self: false, rigs: !!prev?.rigs, online: false, viaToken: true, error: res.error });
      }
    }));

    this.nodes = next;
    // Host keys are in the signature so a peer switching SSH servers re-pins them everywhere.
    const sig = JSON.stringify([...next.values()].map((n) => [n.id, n.online, n.rigs, n.name, n.version, n.sshHostKeys]).sort());
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
