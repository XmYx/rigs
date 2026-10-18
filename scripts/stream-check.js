#!/usr/bin/env node
// Live check of the desktop stream (src/screen-stream.js): connects to a /screen/stream WebSocket, counts frames for
// a while and prints one JSON line (fps, frame sizes, first-frame latency, how it closed).
//   node scripts/stream-check.js <ws-url> [--seconds 10] [--token T] [--off <http-url> --off-body '<json>' --off-at 5]
// --off POSTs <http-url> after --off-at seconds (e.g. .../control/enable with {"enabled":false}, or .../control/kill)
// and reports how long the stream took to end after that switch.
// Example: node scripts/stream-check.js 'ws://127.0.0.1:4719/api/nodes/magix-system/screen/stream?fps=3'
import { WebSocket } from 'ws';

const args = process.argv.slice(2);
const opt = (name, def) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : def; };
const url = args.find((a) => /^wss?:/.test(a));
if (!url) { console.error('usage: stream-check.js <ws-url> [--seconds 10] [--token T] [--off <url> --off-body <json> --off-at <s>]'); process.exit(2); }
const seconds = Number(opt('seconds', 10)), token = opt('token'), off = opt('off'), offBody = opt('off-body', '{}'), offAt = Number(opt('off-at', seconds / 2));

const t0 = Date.now(), out = { url, seconds, frames: 0, bytes: 0, messages: [] };
const ws = new WebSocket(url, { headers: token ? { 'x-rigs-token': token } : {} });
let offSentAt = null, lastFrameAt = null;
ws.on('open', () => { out.openMs = Date.now() - t0; });
ws.on('message', (d, isBinary) => {
  const at = Date.now();
  if (isBinary) {
    if (!out.frames) out.firstFrameMs = at - t0;
    out.frames++; out.bytes += d.length; lastFrameAt = at;
    if (offSentAt) out.framesAfterOff = (out.framesAfterOff || 0) + 1;
  } else {
    const m = JSON.parse(String(d));
    if (m.type === 'hello' || m.type === 'error' || m.type === 'status' || out.messages.filter((x) => x.type === 'meta').length < 1) out.messages.push({ ...m, atMs: at - t0 });
  }
});
ws.on('unexpected-response', (_, res) => { out.error = `HTTP ${res.statusCode}`; finish(); });
ws.on('error', (e) => { out.error ||= e.message; finish(); });
ws.on('close', (code, reason) => { out.closed = { code, reason: String(reason), atMs: Date.now() - t0 }; if (offSentAt) out.endedAfterOffMs = Date.now() - offSentAt; finish(); });
if (off) setTimeout(async () => {
  offSentAt = Date.now();
  const r = await fetch(off, { method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { 'x-rigs-token': token } : {}) }, body: offBody }).catch((e) => ({ status: e.message }));
  out.off = { url: off, body: JSON.parse(offBody), status: r.status, atMs: offSentAt - t0 };
}, offAt * 1000);
const timer = setTimeout(() => { ws.close(); }, seconds * 1000);
let done = false;
function finish() {
  if (done) return;
  done = true; clearTimeout(timer);
  const span = ((lastFrameAt || Date.now()) - t0 - (out.firstFrameMs || 0)) / 1000;
  out.fps = out.frames > 1 && span > 0 ? Math.round(((out.frames - 1) / span) * 100) / 100 : 0;
  out.avgFrameKB = out.frames ? Math.round(out.bytes / out.frames / 102.4) / 10 : 0;
  console.log(JSON.stringify(out));
  process.exit(out.error && !out.closed ? 1 : 0);
}
