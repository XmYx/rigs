// Home Security — camera discovery (docs/home-security.md §2). Owner: t2.
// Pure parts (exported, unit-testable): device-list parsers per OS, subnet selection, WS-Discovery parsing, redaction,
// URL credential stripping. I/O parts: webcam enumeration via ffmpeg/sysfs, ONVIF WS-Discovery + GetStreamUri, the
// bounded LAN port probe, and the camera registry (cameras.json / secrets.json).
import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import dgram from 'node:dgram';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

// ── small pure helpers ────────────────────────────────────────────────────────────────────────────────────────────

export function slug(s) {
  return String(s || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'camera';
}

export const CAMERA_ID_RE = /^[a-z0-9][a-z0-9._-]{0,100}$/;

/** Hide credentials in any text that may reach a log, an error or a response. */
export function redact(text) {
  return String(text ?? '')
    .replace(/(\/\/)[^/@\s"'<>]+@/g, '$1***@')
    .replace(/((?:password|passwd|pwd|pass)=)[^&\s"'<>]*/gi, '$1***');
}

/** Split user info off a camera URL. → { url (no user info), username, password } or throws Error(400-ish). */
export function stripUserInfo(raw) {
  let u;
  try { u = new URL(String(raw || '').trim()); } catch { throw new Error('invalid URL'); }
  if (!['rtsp:', 'rtsps:', 'http:', 'https:'].includes(u.protocol)) throw new Error('URL scheme must be rtsp, rtsps, http or https');
  if (!u.hostname) throw new Error('URL has no host');
  const username = u.username ? decodeURIComponent(u.username) : '';
  const password = u.password ? decodeURIComponent(u.password) : '';
  u.username = ''; u.password = '';
  return { url: u.toString(), username, password };
}

/** Put credentials back into a URL for ffmpeg/ffprobe (never returned to a client). */
export function withCredentials(url, creds) {
  if (!creds || (!creds.username && !creds.password)) return url;
  const u = new URL(url);
  u.username = encodeURIComponent(creds.username || '');
  u.password = encodeURIComponent(creds.password || '');
  return u.toString();
}

// ── webcam device-list parsers (pure, over ffmpeg stderr / sysfs listings) ─────────────────────────────────────────

const stripLogPrefix = (line) => line.replace(/^\s*\[[^\]]*@\s*[0-9a-fx]+\]\s?/i, '');

/** macOS: `ffmpeg -f avfoundation -list_devices true -i ""` stderr → [{ index, name }], screens dropped. */
export function parseAvfoundationDevices(stderr) {
  const out = [];
  let inVideo = false;
  for (const raw of String(stderr || '').split(/\r?\n/)) {
    const line = stripLogPrefix(raw);
    if (/AVFoundation video devices/i.test(line)) { inVideo = true; continue; }
    if (/AVFoundation audio devices/i.test(line)) { inVideo = false; continue; }
    if (!inVideo) continue;
    const m = line.match(/^\[(\d+)\]\s+(.+?)\s*$/);
    if (!m) continue;
    if (/^Capture screen \d+/i.test(m[2])) continue;
    out.push({ index: Number(m[1]), name: m[2] });
  }
  return out;
}

/** Windows: `ffmpeg -f dshow -list_devices true -i dummy` stderr → [{ name, altName }] video devices only.
 *  Handles both the modern `"Name" (video)` form and the older "DirectShow video devices" section form. */
export function parseDshowDevices(stderr) {
  const out = [];
  let section = null; // legacy format: 'video' | 'audio'
  let last = null;
  for (const raw of String(stderr || '').split(/\r?\n/)) {
    const line = stripLogPrefix(raw);
    if (/DirectShow video devices/i.test(line)) { section = 'video'; last = null; continue; }
    if (/DirectShow audio devices/i.test(line)) { section = 'audio'; last = null; continue; }
    const alt = line.match(/^\s*Alternative name\s+"([^"]+)"/i);
    if (alt) { if (last) last.altName = alt[1]; continue; }
    const m = line.match(/^\s*"([^"]+)"\s*(?:\((video|audio|none)\))?\s*$/i);
    if (!m) { if (line.trim()) last = null; continue; }
    const kind = m[2] ? m[2].toLowerCase() : section;
    if (kind === 'video') { last = { name: m[1], altName: null }; out.push(last); } else last = null;
  }
  return out;
}

/** Linux: sysfs entries [{ node: 'video0', index: '0', name, byId?: '/dev/v4l/by-id/…' }] → capture nodes only. */
export function parseV4l2Sysfs(entries) {
  return (entries || [])
    .filter((e) => e && /^video\d+$/.test(e.node) && String(e.index ?? '0').trim() === '0')
    .map((e) => ({ name: String(e.name || e.node).trim(), device: e.byId || `/dev/${e.node}`, node: e.node }))
    .sort((a, b) => Number(a.node.slice(5)) - Number(b.node.slice(5)));
}

/** Webcam list (any OS) → camera records (no runtime fields). */
export function webcamCameras(platform, devices) {
  const seen = new Map();
  const out = [];
  for (const d of devices) {
    const key = platform === 'linux' ? (d.device.startsWith('/dev/v4l/by-id/') ? path.basename(d.device) : d.name) : d.name;
    let id = `webcam-${slug(key)}`;
    const n = (seen.get(id) || 0) + 1; seen.set(id, n);
    if (n > 1) id = `${id}-${n}`;
    const source = platform === 'darwin' ? { format: 'avfoundation', device: d.name }
      : platform === 'win32' ? { format: 'dshow', device: d.altName || d.name, label: d.name }
        : { format: 'v4l2', device: d.device };
    out.push({ id, name: d.name, kind: 'webcam', source, fingerprint: `webcam:${os.hostname()}:${key}` });
  }
  return out;
}

// ── subnets (pure) ────────────────────────────────────────────────────────────────────────────────────────────────

export function ipToInt(ip) {
  const p = String(ip).split('.').map(Number);
  if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
  return ((p[0] << 24) | (p[1] << 16) | (p[2] << 8) | p[3]) >>> 0;
}
export const intToIp = (n) => [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.');

export function parseCidr(cidr) {
  const m = String(cidr || '').trim().match(/^(\d+\.\d+\.\d+\.\d+)\/(\d{1,2})$/);
  if (!m) return null;
  const ip = ipToInt(m[1]); const bits = Number(m[2]);
  if (ip === null || bits > 32) return null;
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return { network: (ip & mask) >>> 0, bits, mask, cidr: `${intToIp((ip & mask) >>> 0)}/${bits}` };
}

export function cidrContains(cidr, ip) {
  const c = typeof cidr === 'string' ? parseCidr(cidr) : cidr;
  const n = typeof ip === 'number' ? ip : ipToInt(ip);
  return !!c && n !== null && ((n & c.mask) >>> 0) === c.network;
}

export const EXCLUDED_CIDRS = ['100.64.0.0/10', '127.0.0.0/8', '169.254.0.0/16', '224.0.0.0/4', '0.0.0.0/8', '240.0.0.0/4'];
export const EXCLUDED_IFACE_RE = /^(tailscale|utun|docker|br-|veth|virbr|vboxnet|vmnet|zt|wg|lo|bridge|awdl|llw|ap\d|anpi|gif|stf|ipsec|ppp|tun|tap)/i;
const RFC1918 = ['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16'];
export const isRfc1918 = (ip) => RFC1918.some((c) => cidrContains(c, ip));

/** Validate discovery.extraCidrs → { ok: [normalized cidr], errors: [msg] }. RFC1918 and /22 or narrower only. */
export function validateExtraCidrs(list) {
  const ok = []; const errors = [];
  for (const raw of list || []) {
    const c = parseCidr(raw);
    if (!c) { errors.push(`discovery.extraCidrs: "${raw}" is not an IPv4 CIDR`); continue; }
    if (c.bits < 22) { errors.push(`discovery.extraCidrs: ${c.cidr} is wider than /22`); continue; }
    const last = (c.network + (2 ** (32 - c.bits)) - 1) >>> 0;
    if (!isRfc1918(c.network) || !isRfc1918(last) || EXCLUDED_CIDRS.some((x) => cidrContains(x, c.network))) {
      errors.push(`discovery.extraCidrs: ${c.cidr} is not a private (RFC1918) range`); continue;
    }
    ok.push(c.cidr);
  }
  return { ok, errors };
}

/**
 * The subnets this node may scan: its own LANs only.
 * @param ifaces os.networkInterfaces()
 * @param settings full settings or { discovery: { excludeCidrs, extraCidrs } }
 * → [{ cidr, iface, address }]  (extraCidrs have iface null and the address of the interface whose LAN is nearest)
 */
export function localSubnets(ifaces, settings = {}) {
  const d = settings.discovery || settings || {};
  const excluded = [...EXCLUDED_CIDRS, ...(d.excludeCidrs || [])].map(parseCidr).filter(Boolean);
  const isExcluded = (ip) => excluded.some((c) => cidrContains(c, ip));
  const out = []; const seen = new Set();
  for (const [name, addrs] of Object.entries(ifaces || {})) {
    if (EXCLUDED_IFACE_RE.test(name)) continue;
    for (const a of addrs || []) {
      if (!a || a.internal || (a.family !== 'IPv4' && a.family !== 4)) continue;
      const ip = ipToInt(a.address);
      if (ip === null || isExcluded(ip)) continue;
      let bits = a.cidr ? Number(a.cidr.split('/')[1]) : maskBits(a.netmask);
      if (!Number.isInteger(bits) || bits < 24) bits = 24; // clamp: never sweep wider than the /24 we sit in
      if (bits > 30) continue; // point-to-point / host routes: nothing to scan
      const c = parseCidr(`${a.address}/${bits}`);
      if (!c || isExcluded(c.network) || seen.has(c.cidr)) continue;
      seen.add(c.cidr);
      out.push({ cidr: c.cidr, iface: name, address: a.address });
    }
  }
  const { ok } = validateExtraCidrs(d.extraCidrs || []);
  for (const cidr of ok) {
    const c = parseCidr(cidr);
    if (seen.has(c.cidr) || excluded.some((x) => cidrContains(x, c.network))) continue;
    seen.add(c.cidr);
    out.push({ cidr: c.cidr, iface: null, address: out[0]?.address || null });
  }
  return out;
}

function maskBits(netmask) {
  const n = ipToInt(netmask);
  if (n === null) return NaN;
  let bits = 0;
  for (let i = 31; i >= 0 && (n >>> i) & 1; i--) bits++;
  return bits;
}

/** Hosts of a subnet, without network, broadcast and skip addresses. */
export function subnetHosts(cidr, skip = []) {
  const c = parseCidr(cidr);
  if (!c || c.bits < 22) return [];
  const size = 2 ** (32 - c.bits);
  const skipSet = new Set(skip);
  const out = [];
  for (let i = 1; i < size - 1; i++) {
    const ip = intToIp((c.network + i) >>> 0);
    if (!skipSet.has(ip)) out.push(ip);
  }
  return out;
}

// ── ONVIF WS-Discovery (parse is pure) ────────────────────────────────────────────────────────────────────────────

export function buildProbe(messageId = crypto.randomUUID()) {
  return '<?xml version="1.0" encoding="UTF-8"?>'
    + '<e:Envelope xmlns:e="http://www.w3.org/2003/05/soap-envelope" xmlns:w="http://schemas.xmlsoap.org/ws/2004/08/addressing"'
    + ' xmlns:d="http://schemas.xmlsoap.org/ws/2005/04/discovery" xmlns:dn="http://www.onvif.org/ver10/network/wsdl">'
    + `<e:Header><w:MessageID>uuid:${messageId}</w:MessageID>`
    + '<w:To e:mustUnderstand="true">urn:schemas-xmlsoap-org:ws:2005:04:discovery</w:To>'
    + '<w:Action e:mustUnderstand="true">http://schemas.xmlsoap.org/ws/2005/04/discovery/Probe</w:Action></e:Header>'
    + '<e:Body><d:Probe><d:Types>dn:NetworkVideoTransmitter</d:Types></d:Probe></e:Body></e:Envelope>';
}

const xmlUnescape = (s) => String(s).replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
const tagText = (xml, local) => {
  const m = String(xml).match(new RegExp(`<(?:[\\w.-]+:)?${local}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:[\\w.-]+:)?${local}>`));
  return m ? xmlUnescape(m[1].trim()) : '';
};

/** A WS-Discovery ProbeMatches response → [{ uuid, xaddrs: [url], scopes: [str], name, hardware, types }]. */
export function parseProbeMatches(xml) {
  const out = [];
  const re = /<(?:[\w.-]+:)?ProbeMatch(?:\s[^>]*)?>([\s\S]*?)<\/(?:[\w.-]+:)?ProbeMatch>/g;
  let m;
  while ((m = re.exec(String(xml || '')))) {
    const block = m[1];
    const address = tagText(block, 'Address');
    const uuid = (address.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i)?.[1] || address.replace(/^urn:uuid:/i, '')).toLowerCase();
    const xaddrs = tagText(block, 'XAddrs').split(/\s+/).filter((x) => /^https?:\/\//i.test(x));
    const scopes = tagText(block, 'Scopes').split(/\s+/).filter(Boolean);
    const scope = (key) => {
      const s = scopes.find((x) => x.toLowerCase().startsWith(`onvif://www.onvif.org/${key}/`));
      if (!s) return '';
      try { return decodeURIComponent(s.slice(`onvif://www.onvif.org/${key}/`.length)).replace(/_/g, ' '); } catch { return ''; }
    };
    if (!uuid && !xaddrs.length) continue;
    out.push({ uuid, xaddrs, scopes, name: scope('name'), hardware: scope('hardware'), types: tagText(block, 'Types') });
  }
  return out;
}

/** Camera record for an ONVIF device. Prefer an XAddr whose host is in our subnets. */
export function onvifCamera(match, subnets = []) {
  const inLan = (u) => { try { const h = new URL(u).hostname; return subnets.some((s) => cidrContains(s.cidr || s, h)); } catch { return false; } };
  const xaddr = match.xaddrs.find(inLan) || match.xaddrs[0] || '';
  let host = ''; try { host = new URL(xaddr).hostname; } catch { /* none */ }
  const name = [match.name, match.hardware].filter(Boolean).join(' ').trim() || `ONVIF camera ${host}`.trim();
  return {
    id: `onvif-${slug(match.uuid || host)}`, name, kind: 'onvif',
    source: { url: null, host, onvif: { xaddr, uuid: match.uuid } },
    fingerprint: `onvif:${match.uuid || host}`,
  };
}

/** Send a Probe from each selected interface; collect ProbeMatches for timeoutMs. → [match + { from }] */
export async function onvifDiscover(subnets, { timeoutMs = 3000 } = {}) {
  const ifaceAddrs = [...new Set(subnets.map((s) => s.address).filter(Boolean))];
  const found = new Map(); const errors = [];
  await Promise.all(ifaceAddrs.map((addr) => new Promise((resolve) => {
    const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    const done = () => { try { sock.close(); } catch { /* closed */ } resolve(); };
    sock.on('error', (e) => { errors.push(`onvif ${addr}: ${e.message}`); done(); });
    sock.on('message', (buf, rinfo) => {
      if (!subnets.some((s) => cidrContains(s.cidr, rinfo.address))) return; // only answers from our own LANs
      for (const m of parseProbeMatches(buf.toString('utf8'))) {
        const key = m.uuid || m.xaddrs[0];
        if (key && !found.has(key)) found.set(key, { ...m, from: rinfo.address });
      }
    });
    sock.bind(0, addr, () => {
      try { sock.setMulticastInterface(addr); sock.setMulticastTTL(1); } catch (e) { errors.push(`onvif ${addr}: ${e.message}`); }
      const msg = Buffer.from(buildProbe());
      sock.send(msg, 3702, '239.255.255.250', (e) => { if (e) errors.push(`onvif ${addr}: ${e.message}`); });
      setTimeout(() => sock.send(msg, 3702, '239.255.255.250', () => {}), 300); // UDP: one retry
      setTimeout(done, timeoutMs);
    });
  })));
  return { matches: [...found.values()], errors };
}

// ── ONVIF media: GetCapabilities → GetProfiles → GetStreamUri (WS-Security UsernameToken digest) ──────────────────

export function wsSecurityHeader(username, password, { nonce = crypto.randomBytes(16), created = new Date().toISOString() } = {}) {
  const digest = crypto.createHash('sha1').update(Buffer.concat([nonce, Buffer.from(created), Buffer.from(password || '')])).digest('base64');
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');
  return '<s:Header><Security s:mustUnderstand="1" xmlns="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-secext-1.0.xsd">'
    + `<UsernameToken><Username>${esc(username)}</Username>`
    + `<Password Type="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-username-token-profile-1.0#PasswordDigest">${digest}</Password>`
    + `<Nonce EncodingType="http://docs.oasis-open.org/wss/2004/01/oasis-200401-soap-message-security-1.0#Base64Binary">${nonce.toString('base64')}</Nonce>`
    + `<Created xmlns="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-utility-1.0.xsd">${created}</Created>`
    + '</UsernameToken></Security></s:Header>';
}

function soapPost(url, body, timeoutMs = 4000) {
  return new Promise((resolve, reject) => {
    let u; try { u = new URL(url); } catch { reject(new Error('bad xaddr')); return; }
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.request(u, {
      method: 'POST', timeout: timeoutMs, rejectUnauthorized: false,
      headers: { 'content-type': 'application/soap+xml; charset=utf-8', 'content-length': Buffer.byteLength(body) },
    }, (res) => {
      let data = ''; res.setEncoding('utf8');
      res.on('data', (c) => { if (data.length < 1e6) data += c; });
      res.on('end', () => {
        if (res.statusCode >= 400) {
          const reason = tagText(data, 'Text') || tagText(data, 'Reason') || `HTTP ${res.statusCode}`;
          reject(Object.assign(new Error(reason), { status: res.statusCode, auth: /not ?authori[sz]ed|sender|401/i.test(reason + res.statusCode) }));
        } else resolve(data);
      });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    req.end(body);
  });
}

const envelope = (header, body) => '<?xml version="1.0" encoding="UTF-8"?><s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope"'
  + ' xmlns:tds="http://www.onvif.org/ver10/device/wsdl" xmlns:trt="http://www.onvif.org/ver10/media/wsdl" xmlns:tt="http://www.onvif.org/ver10/schema">'
  + `${header}<s:Body>${body}</s:Body></s:Envelope>`;

/** → { url (rtsp, no user info) } or throws (err.auth true on bad credentials). */
export async function onvifStreamUri(xaddr, creds) {
  const hdr = () => (creds?.username ? wsSecurityHeader(creds.username, creds.password) : '');
  let media = xaddr;
  try {
    const caps = await soapPost(xaddr, envelope(hdr(), '<tds:GetCapabilities><tds:Category>Media</tds:Category></tds:GetCapabilities>'));
    const mediaBlock = caps.match(/<(?:[\w.-]+:)?Media>([\s\S]*?)<\/(?:[\w.-]+:)?Media>/)?.[1];
    const x = mediaBlock && tagText(mediaBlock, 'XAddr');
    if (x) media = x;
  } catch (e) { if (e.auth) throw e; }
  const profiles = await soapPost(media, envelope(hdr(), '<trt:GetProfiles/>'));
  const token = profiles.match(/<(?:[\w.-]+:)?Profiles[^>]*\stoken="([^"]+)"/)?.[1];
  if (!token) throw new Error('camera has no media profile');
  const resp = await soapPost(media, envelope(hdr(), '<trt:GetStreamUri><trt:StreamSetup><tt:Stream>RTP-Unicast</tt:Stream>'
    + `<tt:Transport><tt:Protocol>RTSP</tt:Protocol></tt:Transport></trt:StreamSetup><trt:ProfileToken>${token}</trt:ProfileToken></trt:GetStreamUri>`));
  const uri = tagText(resp, 'Uri');
  if (!/^rtsps?:\/\//i.test(uri)) throw new Error('camera returned no RTSP URI');
  return { url: stripUserInfo(uri).url };
}

// ── LAN port probe (bounded, rate-limited) ────────────────────────────────────────────────────────────────────────

function tcpOpen(host, port, timeoutMs) {
  return new Promise((resolve) => {
    const s = net.connect({ host, port });
    const end = (ok) => { s.destroy(); resolve(ok); };
    s.setTimeout(timeoutMs, () => end(false));
    s.once('connect', () => end(true));
    s.once('error', () => end(false));
  });
}

function rtspOptions(host, port, timeoutMs = 1500) {
  return new Promise((resolve) => {
    const s = net.connect({ host, port });
    let data = '';
    const end = (ok) => { s.destroy(); resolve(ok); };
    s.setTimeout(timeoutMs, () => end(false));
    s.once('error', () => end(false));
    s.once('connect', () => s.write(`OPTIONS rtsp://${host}:${port}/ RTSP/1.0\r\nCSeq: 1\r\nUser-Agent: rigs-home-security\r\n\r\n`));
    s.on('data', (c) => { data += c; if (data.includes('\r\n')) end(/^RTSP\/1\.\d \d{3}/.test(data)); });
  });
}

const CAMERA_HINT = /camera|ipcam|onvif|hikvision|dahua|axis|reolink|amcrest|foscam|mjpe?g|webcam|nvr|dvr|uniview|vivotek|hanwha|wisenet|tapo|motion jpeg/i;
function httpLooksLikeCamera(host, port, timeoutMs = 1500) {
  return new Promise((resolve) => {
    const req = http.get({ host, port, path: '/', timeout: timeoutMs }, (res) => {
      let body = ''; res.setEncoding('utf8');
      const hint = `${res.headers.server || ''} ${res.headers['www-authenticate'] || ''} ${res.headers['content-type'] || ''}`;
      res.on('data', (c) => { body += c; if (body.length > 16384) res.destroy(); });
      res.on('close', () => resolve(CAMERA_HINT.test(hint + body.slice(0, 16384))));
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(false));
  });
}

/** Probe every host of the selected subnets. ≤ concurrency connects in flight. → [{ ip, port, kind }] */
export async function portProbe(subnets, { ports = [554, 8554, 80, 8080], concurrency = 64, timeoutMs = 400, skipHosts = [], signal } = {}) {
  const own = subnets.map((s) => s.address).filter(Boolean);
  const jobs = [];
  for (const s of subnets) for (const ip of subnetHosts(s.cidr, [...own, ...skipHosts])) for (const port of ports) jobs.push({ ip, port });
  const hits = [];
  let next = 0;
  const worker = async () => {
    while (next < jobs.length && !signal?.aborted) {
      const { ip, port } = jobs[next++];
      if (!(await tcpOpen(ip, port, timeoutMs))) continue;
      if (port === 554 || port === 8554) { if (await rtspOptions(ip, port)) hits.push({ ip, port, kind: 'rtsp' }); }
      else if (await httpLooksLikeCamera(ip, port)) hits.push({ ip, port, kind: 'mjpeg' });
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, jobs.length) }, worker));
  return hits;
}

export function probeCamera(hit) {
  const scheme = hit.kind === 'rtsp' ? 'rtsp' : 'http';
  return {
    id: `ip-${hit.ip}-${hit.port}`, name: `${hit.kind === 'rtsp' ? 'RTSP' : 'HTTP'} camera ${hit.ip}`, kind: hit.kind,
    source: { url: `${scheme}://${hit.ip}:${hit.port}/`, host: hit.ip },
    fingerprint: `${hit.ip}:${hit.port}`, needsSetup: true,
  };
}

// ── webcam enumeration (I/O) ──────────────────────────────────────────────────────────────────────────────────────

function run(cmd, args, timeoutMs = 8000) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 4 << 20, windowsHide: true }, (err, stdout, stderr) =>
      resolve({ err, stdout: String(stdout || ''), stderr: String(stderr || '') }));
  });
}

function readSysfsV4l2(root = '/sys/class/video4linux') {
  let nodes = [];
  try { nodes = fs.readdirSync(root).filter((n) => /^video\d+$/.test(n)); } catch { return []; }
  const byId = new Map();
  try {
    for (const l of fs.readdirSync('/dev/v4l/by-id')) {
      try { byId.set(path.basename(fs.realpathSync(path.join('/dev/v4l/by-id', l))), path.join('/dev/v4l/by-id', l)); } catch { /* dangling */ }
    }
  } catch { /* no by-id */ }
  const read = (n, f) => { try { return fs.readFileSync(path.join(root, n, f), 'utf8').trim(); } catch { return ''; } };
  return nodes.map((node) => ({ node, index: read(node, 'index') || '0', name: read(node, 'name'), byId: byId.get(node) }));
}

/** → { devices: [camera records], error? } */
export async function enumerateWebcams({ ffmpeg, platform = process.platform } = {}) {
  if (platform === 'linux') return { devices: webcamCameras('linux', parseV4l2Sysfs(readSysfsV4l2())) };
  if (!ffmpeg) return { devices: [], error: 'ffmpeg not found' };
  if (platform === 'darwin') {
    const { stderr } = await run(ffmpeg, ['-hide_banner', '-f', 'avfoundation', '-list_devices', 'true', '-i', '']);
    return { devices: webcamCameras('darwin', parseAvfoundationDevices(stderr)) };
  }
  if (platform === 'win32') {
    const { stderr } = await run(ffmpeg, ['-hide_banner', '-f', 'dshow', '-list_devices', 'true', '-i', 'dummy']);
    return { devices: webcamCameras('win32', parseDshowDevices(stderr)) };
  }
  return { devices: [], error: `webcams not supported on ${platform}` };
}

// ── camera registry: cameras.json (no credentials) + secrets.json (0600) ──────────────────────────────────────────

export const RUNTIME_FIELDS = ['status', 'error', 'retryAt', 'node', 'base', 'seenBy', 'warning'];

function writeJsonAtomic(file, data, mode) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), mode ? { mode } : undefined);
  fs.renameSync(tmp, file);
  if (mode) try { fs.chmodSync(file, mode); } catch { /* windows */ }
}
const readJson = (file, dflt) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return dflt; } };

/** Default persistence; store.js (t3) functions are used instead when given. */
export function fileStore(dataDir) {
  return {
    loadCameras: () => { const j = readJson(path.join(dataDir, 'cameras.json'), []); return Array.isArray(j) ? j : (j.cameras || []); },
    saveCameras: (list) => writeJsonAtomic(path.join(dataDir, 'cameras.json'), list),
    loadSecrets: () => readJson(path.join(dataDir, 'secrets.json'), {}),
    saveSecrets: (obj) => writeJsonAtomic(path.join(dataDir, 'secrets.json'), obj, 0o600),
  };
}

const DEFAULT_CAMERA = {
  hasCredentials: false, enabled: false, mode: null, transcode: 'auto', input: null,
  motion: { enabled: true, sensitivity: null, zones: [] },
};

/** Pure: merge a scan's findings into the stored list. New cameras start disabled; known ones keep user settings. */
export function mergeDiscovered(list, found, now = Date.now()) {
  const byId = new Map(list.map((c) => [c.id, c]));
  for (const f of found) {
    const cur = byId.get(f.id);
    if (cur) {
      byId.set(f.id, { ...cur, kind: f.kind, fingerprint: f.fingerprint, lastSeenAt: now,
        source: { ...f.source, url: cur.source?.url || f.source.url || null }, missing: false, needsSetup: cur.needsSetup });
    } else byId.set(f.id, { ...structuredClone(DEFAULT_CAMERA), ...f, discoveredAt: now, lastSeenAt: now });
  }
  return [...byId.values()];
}

export class CameraRegistry {
  constructor(store) {
    this.store = store;
    this.cameras = (store.loadCameras() || []).map((c) => ({ ...structuredClone(DEFAULT_CAMERA), ...c }));
    this.secrets = store.loadSecrets() || {};
  }

  save() {
    this.store.saveCameras(this.cameras.map((c) => { const o = { ...c }; for (const k of RUNTIME_FIELDS) delete o[k]; return o; }));
  }

  saveSecrets() { this.store.saveSecrets(this.secrets); }

  get(id) { return this.cameras.find((c) => c.id === id) || null; }

  credentials(id) { return this.secrets[id] || null; }

  /** The ffmpeg-ready URL (with credentials). Never return this to a client. */
  sourceUrl(id) {
    const c = this.get(id);
    return c?.source?.url ? withCredentials(c.source.url, this.credentials(id)) : null;
  }

  setCredentials(id, { username, password }) {
    const cur = this.secrets[id] || {};
    const next = { username: username !== undefined ? String(username) : (cur.username || ''), password: password !== undefined ? String(password) : (cur.password || '') };
    if (!next.username && !next.password) delete this.secrets[id]; else this.secrets[id] = next;
    const c = this.get(id); if (c) c.hasCredentials = !!this.secrets[id];
    this.saveSecrets();
  }

  applyScan(found, { kinds, now = Date.now() } = {}) {
    const ids = new Set(found.map((f) => f.id));
    this.cameras = mergeDiscovered(this.cameras, found, now);
    // a scanned kind that was not seen this time is 'unavailable' (status computed from `missing`)
    for (const c of this.cameras) if (kinds?.includes(c.kind) && !c.id.startsWith('manual-') && !ids.has(c.id)) c.missing = true;
    for (const c of this.cameras) c.hasCredentials = !!this.secrets[c.id];
    this.save();
  }

  addManual({ name, url, username, password, transcode }) {
    const s = stripUserInfo(url);
    const u = new URL(s.url);
    const id = `manual-${crypto.randomBytes(3).toString('hex')}`;
    const kind = /^rtsps?:$/.test(u.protocol) ? 'rtsp' : 'mjpeg';
    const cam = {
      ...structuredClone(DEFAULT_CAMERA), id, name: String(name || '').trim() || `${kind.toUpperCase()} ${u.hostname}`, kind,
      source: { url: s.url, host: u.hostname }, fingerprint: `${u.hostname}:${u.port || (kind === 'rtsp' ? 554 : 80)}`,
      transcode: ['auto', 'copy', 'h264'].includes(transcode) ? transcode : 'auto',
      discoveredAt: Date.now(), lastSeenAt: Date.now(),
    };
    this.cameras.push(cam);
    const creds = { username: username ?? s.username, password: password ?? s.password };
    if (creds.username || creds.password) this.setCredentials(id, creds);
    this.save();
    return cam;
  }

  /** Validated partial update. → { camera, restart: bool } or throws Error with .status 400. */
  patch(id, body) {
    const c = this.get(id);
    if (!c) throw Object.assign(new Error('camera not found'), { status: 404 });
    const bad = (m) => { throw Object.assign(new Error(m), { status: 400 }); };
    let restart = false;
    if (body.name !== undefined) { if (typeof body.name !== 'string' || !body.name.trim()) bad('name must be a non-empty string'); c.name = body.name.trim().slice(0, 120); }
    if (body.enabled !== undefined) { if (typeof body.enabled !== 'boolean') bad('enabled must be true or false'); if (c.enabled !== body.enabled) restart = true; c.enabled = body.enabled; }
    if (body.mode !== undefined) { if (![null, 'continuous', 'motion', 'off'].includes(body.mode)) bad('mode must be continuous, motion, off or null'); if (c.mode !== body.mode) restart = true; c.mode = body.mode; }
    if (body.transcode !== undefined) { if (!['auto', 'copy', 'h264'].includes(body.transcode)) bad('transcode must be auto, copy or h264'); if (c.transcode !== body.transcode) restart = true; c.transcode = body.transcode; }
    if (body.input !== undefined) {
      if (body.input !== null && (typeof body.input !== 'object' || Array.isArray(body.input))) bad('input must be an object or null');
      const i = body.input || null;
      if (i) for (const [k, lo, hi] of [['width', 160, 3840], ['height', 120, 2160], ['fps', 1, 60]]) {
        if (i[k] !== undefined && !(Number.isInteger(i[k]) && i[k] >= lo && i[k] <= hi)) bad(`input.${k} must be an integer ${lo}–${hi}`);
      }
      c.input = i ? { width: i.width, height: i.height, fps: i.fps } : null; restart = true;
    }
    if (body.motion !== undefined) {
      if (typeof body.motion !== 'object' || body.motion === null) bad('motion must be an object');
      const m = body.motion;
      if (m.enabled !== undefined && typeof m.enabled !== 'boolean') bad('motion.enabled must be true or false');
      if (m.sensitivity !== undefined && m.sensitivity !== null && !(Number.isInteger(m.sensitivity) && m.sensitivity >= 1 && m.sensitivity <= 100)) bad('motion.sensitivity must be 1–100 or null');
      if (m.zones !== undefined && !Array.isArray(m.zones)) bad('motion.zones must be an array');
      c.motion = { ...c.motion, ...m };
    }
    if (body.url !== undefined) {
      if (c.kind === 'webcam') bad('a webcam has no URL');
      let s; try { s = stripUserInfo(body.url); } catch (e) { bad(e.message); }
      c.source = { ...c.source, url: s.url, host: new URL(s.url).hostname };
      if (/^rtsps?:/.test(s.url) && c.kind !== 'onvif') c.kind = 'rtsp'; else if (/^https?:/.test(s.url) && c.kind !== 'onvif') c.kind = 'mjpeg';
      if (s.username || s.password) this.setCredentials(id, { username: s.username, password: s.password });
      delete c.needsSetup;
      restart = true;
    }
    if (body.username !== undefined || body.password !== undefined) {
      if ((body.username !== undefined && typeof body.username !== 'string') || (body.password !== undefined && typeof body.password !== 'string')) bad('username and password must be strings');
      this.setCredentials(id, { username: body.username, password: body.password });
      if (c.kind === 'mjpeg' || c.kind === 'rtsp') delete c.needsSetup;
      restart = true;
    }
    this.save();
    return { camera: c, restart };
  }

  remove(id) {
    const before = this.cameras.length;
    this.cameras = this.cameras.filter((c) => c.id !== id);
    if (this.secrets[id]) { delete this.secrets[id]; this.saveSecrets(); }
    this.save();
    return this.cameras.length !== before;
  }
}

/** The public view of a camera: no secrets, no internal fields. */
export function publicCamera(c, runtime = {}) {
  const { missing, ...rest } = c;
  const source = { ...(rest.source || {}) };
  if (source.url) try { source.url = stripUserInfo(source.url).url; } catch { source.url = redact(source.url); }
  const { id, name, kind, ...more } = rest;
  return { id, name, kind, ...more, source, hasCredentials: !!c.hasCredentials, status: runtime.status || 'idle', error: runtime.error ? redact(runtime.error) : null, retryAt: runtime.retryAt || null };
}
