#!/usr/bin/env node
// macOS app-stream encode check (docs/app-streaming.md §16): runs RIGS Control's `--selftest-encode` (a moving NV12
// test pattern through the session's VideoToolbox encoder, Annex-B conversion and §5.3 frame header; no capture, no
// grant), parses the runner messages with src/app-stream.js and decodes the stream with ffprobe when it is installed.
//   node scripts/appstream/mac-encode-check.js [path/to/rigs-control | ''] [width height frames]
// The default binary is RIGS_HOME's RIGS Control.app (build it with `rigs control helper install`). Exit 0 only if
// every frame parsed, keyframes came where they were forced, and ffprobe (if present) decoded every frame.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { messageReader, decodeHeader } from '../../src/app-stream.js';

const home = process.env.RIGS_HOME || path.join(os.homedir(), '.rigs');
const [given, w = '1280', h = '720', n = '60'] = process.argv.slice(2);
const bin = given || path.join(home, 'bin', 'RIGS Control.app', 'Contents', 'MacOS', 'rigs-control');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rigs-vt-'));
const raw = path.join(dir, 'frames.bin'), es = path.join(dir, 'stream.h264');
const info = JSON.parse(execFileSync(bin, ['--selftest-encode', raw, w, h, n], { encoding: 'utf8' }));
const msgs = messageReader()(fs.readFileSync(raw));
const hello = JSON.parse(msgs[0].body);
const frames = msgs.filter((m) => m.type === 2).map((m) => decodeHeader(m.body));
fs.writeFileSync(es, Buffer.concat(frames.map((f) => f.payload)));
const enc = frames.map((f) => f.encodeUs / 1000).sort((a, b) => a - b);
const keys = frames.filter((f) => f.key).map((f) => f.seq);
let decoded = null, probe = null;
try {
  probe = execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_name,profile,level,width,height', '-of', 'compact=p=0', es], { encoding: 'utf8' }).trim();
  decoded = Number(execFileSync('ffprobe', ['-v', 'error', '-count_frames', '-show_entries', 'stream=nb_read_frames', '-of', 'csv=p=0', es], { encoding: 'utf8' }).trim());
} catch { /* no ffprobe */ }
const want = Number(n);
const ok = frames.length === want && keys[0] === 1 && keys.includes(Math.floor(want / 2) + 1) && (decoded == null || decoded === want);
console.log(JSON.stringify({ ok, encoder: hello.encoder, helper: info, frames: frames.length, keyframes: keys, size: `${frames[0]?.width}x${frames[0]?.height}`,
  encodeMs: { p50: enc[enc.length >> 1], p95: enc[Math.floor(enc.length * 0.95)] }, ffprobe: probe, decoded }, null, 1));
fs.rmSync(dir, { recursive: true, force: true });
process.exit(ok ? 0 : 1);
