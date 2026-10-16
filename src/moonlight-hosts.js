import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { RIGS_HOME } from './config.js';
import { HOME, isLinux, isMac, log, run } from './util.js';

/**
 * Moonlight caches every host it has seen (uuid, addresses, server cert). When a host's Sunshine
 * identity changes (reinstall, new state file) the stale entry makes `moonlight pair` loop on
 * "Found unexpected PC …" and the pairing request is never sent. Before pairing, RIGS asks the
 * target's Sunshine who it is now (/serverinfo) and drops cached entries for that machine that carry
 * a different uuid.
 *   macOS: plist com.moonlight-stream.Moonlight, flat keys "hosts.N.field" + "hosts.size"
 *   Linux: INI "~/.config/Moonlight Game Streaming Project/Moonlight.conf", [hosts] "N\field" + size
 *   Windows: registry (not pruned yet — pairing falls back to the PIN entry in JARVIS)
 */

export async function serverInfo(address) {
  try {
    const r = await fetch(`http://${address.includes(':') && !address.startsWith('[') ? `[${address}]` : address}:47989/serverinfo`, { signal: AbortSignal.timeout(5000) });
    const x = await r.text();
    const get = (k) => (x.match(new RegExp(`<${k}>([^<]*)</${k}>`)) || [])[1] || '';
    return { hostname: get('hostname'), uuid: get('uniqueid').toUpperCase(), paired: get('PairStatus') === '1' };
  } catch { return null; }
}

function stale(entry, live, address) {
  const uuid = String(entry.uuid || '').toUpperCase();
  if (!uuid || uuid === live.uuid) return false;
  const addrs = [entry.localaddress, entry.manualaddress, entry.remoteaddress, entry.ipv6address].filter(Boolean);
  return entry.hostname === live.hostname || addrs.includes(address);
}

// ---------------------------------------------------------------- Linux (Qt INI)

function iniPaths() {
  const cfg = process.env.XDG_CONFIG_HOME || path.join(HOME, '.config');
  return [path.join(cfg, 'Moonlight Game Streaming Project', 'Moonlight.conf'),
    path.join(HOME, '.var', 'app', 'com.moonlight_stream.Moonlight', 'config', 'Moonlight Game Streaming Project', 'Moonlight.conf')];
}

async function pruneIni(file, live, address) {
  let text;
  try { text = await fsp.readFile(file, 'utf8'); } catch { return 0; }
  const lines = text.split('\n');
  const start = lines.findIndex((l) => l.trim() === '[hosts]');
  if (start < 0) return 0;
  let end = lines.findIndex((l, i) => i > start && /^\[.*\]$/.test(l.trim()));
  if (end < 0) end = lines.length;
  const body = lines.slice(start + 1, end);
  const entries = new Map();
  const other = [];
  for (const l of body) {
    const m = l.match(/^(\d+)\\(.*)$/);
    if (!m) { if (!/^size=/.test(l) && l.trim()) other.push(l); continue; }
    if (!entries.has(m[1])) entries.set(m[1], { lines: [], fields: {} });
    const e = entries.get(m[1]);
    e.lines.push(m[2]);
    const kv = m[2].match(/^([a-z0-9]+)=(.*)$/i);
    if (kv) e.fields[kv[1].toLowerCase()] = kv[2];
  }
  const keep = [...entries.entries()].sort((a, b) => Number(a[0]) - Number(b[0])).filter(([, e]) => !stale(e.fields, live, address));
  const dropped = entries.size - keep.length;
  if (!dropped) return 0;
  const rebuilt = [...keep.flatMap(([, e], i) => e.lines.map((x) => `${i + 1}\\${x}`)), `size=${keep.length}`, ...other];
  await fsp.copyFile(file, file + '.rigs-bak');
  await fsp.writeFile(file, [...lines.slice(0, start + 1), ...rebuilt, ...lines.slice(end)].join('\n'));
  return dropped;
}

// ---------------------------------------------------------------- macOS (plist via defaults)

const DOMAIN = 'com.moonlight-stream.Moonlight';
const PAIR = /<key>([^<]*)<\/key>\s*(<(true|false)\/>|<(string|integer|real|data|date)>[\s\S]*?<\/\4>|<(string|data)\/>)/g;

async function prunePlist(live, address) {
  const tmp = path.join(RIGS_HOME, 'moonlight-prefs.plist');
  await fsp.mkdir(RIGS_HOME, { recursive: true });
  const ex = await run('defaults', ['export', DOMAIN, tmp], { timeout: 10000 });
  if (ex.code !== 0) return 0;
  // `defaults export` writes a binary plist; work on the XML form.
  if ((await run('plutil', ['-convert', 'xml1', tmp], { timeout: 10000 })).code !== 0) return 0;
  const xml = await fsp.readFile(tmp, 'utf8');
  const pairs = [...xml.matchAll(PAIR)].map((m) => ({ key: m[1], raw: m[2] }));
  // Only rewrite when every key was understood (a nested dict/array would otherwise be lost).
  if (pairs.length !== (xml.match(/<key>/g) || []).length) { log('desktop: Moonlight prefs have an unexpected shape — not pruning'); return 0; }
  const hosts = new Map();
  const rest = [];
  for (const p of pairs) {
    const m = p.key.match(/^hosts\.(\d+)\.(.*)$/);
    if (!m) { if (p.key !== 'hosts.size') rest.push(p); continue; }
    if (!hosts.has(m[1])) hosts.set(m[1], { items: [], fields: {} });
    const h = hosts.get(m[1]);
    h.items.push({ sub: m[2], raw: p.raw });
    const val = p.raw.match(/^<string>([\s\S]*)<\/string>$/);
    if (val && !m[2].includes('.')) h.fields[m[2].toLowerCase()] = val[1];
  }
  const keep = [...hosts.entries()].sort((a, b) => Number(a[0]) - Number(b[0])).filter(([, h]) => !stale(h.fields, live, address));
  const dropped = hosts.size - keep.length;
  if (!dropped) return 0;
  const out = [...rest.map((p) => `\t<key>${p.key}</key>\n\t${p.raw}`),
    `\t<key>hosts.size</key>\n\t<integer>${keep.length}</integer>`,
    ...keep.flatMap(([, h], i) => h.items.map((it) => `\t<key>hosts.${i + 1}.${it.sub}</key>\n\t${it.raw}`))];
  const doc = `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0">\n<dict>\n${out.join('\n')}\n</dict>\n</plist>\n`;
  await fsp.copyFile(tmp, tmp + '.bak');
  await fsp.writeFile(tmp, doc);
  const im = await run('defaults', ['import', DOMAIN, tmp], { timeout: 10000 });
  if (im.code !== 0) { await run('defaults', ['import', DOMAIN, tmp + '.bak'], { timeout: 10000 }); return 0; }
  return dropped;
}

/** Drop cached Moonlight hosts for `address` whose identity no longer matches its Sunshine. */
export async function pruneStale(address) {
  const live = await serverInfo(address);
  if (!live?.uuid) return { checked: false };
  let dropped = 0;
  if (isLinux) for (const f of iniPaths()) if (fs.existsSync(f)) dropped += await pruneIni(f, live, address);
  if (isMac) dropped += await prunePlist(live, address);
  if (dropped) log(`desktop: dropped ${dropped} stale Moonlight entr${dropped > 1 ? 'ies' : 'y'} for ${live.hostname} (${address})`);
  return { checked: true, dropped, live };
}

export const _test = { pruneIni, stale, PAIR };
