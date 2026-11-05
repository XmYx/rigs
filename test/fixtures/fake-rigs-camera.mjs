// A stand-in for "RIGS Camera.app" (apps/home-security/macos/RigsCamera.swift) with the same command line and files, so the
// ingest worker's helper path is tested on any OS with a real ffmpeg:
//   fake-rigs-camera.mjs status|request|run --dir D [--cwd C] [--parent PID] [-- cmd args…]
// The camera authorization is the `status` field of the JSON file named by FAKE_CAMERA_STATE (notDetermined | authorized |
// denied | restricted): a test changes it to play "the person clicked Allow". `request` answers notDetermined with
// FAKE_ANSWER (default authorized) after FAKE_ANSWER_MS.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const argv = process.argv.slice(2);
const mode = argv[0];
const opts = {}; let cmd = [];
for (let i = 1; i < argv.length;) {
  if (argv[i] === '--') { cmd = argv.slice(i + 1); break; }
  if (argv[i].startsWith('--')) { opts[argv[i].slice(2)] = argv[i + 1]; i += 2; } else i++;
}
const dir = opts.dir;
fs.mkdirSync(dir, { recursive: true });
const stateFile = process.env.FAKE_CAMERA_STATE;
const readState = () => { try { return JSON.parse(fs.readFileSync(stateFile, 'utf8')).status; } catch { return 'notDetermined'; } };
const writeJson = (name, obj) => fs.writeFileSync(path.join(dir, name), JSON.stringify(obj));
const writeAuth = () => { const status = readState(); writeJson('auth.json', { status, at: Date.now() }); return status; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (mode === 'status') { writeAuth(); process.exit(0); }

if (mode === 'request') {
  if (writeAuth() === 'notDetermined') {
    await sleep(Number(process.env.FAKE_ANSWER_MS || 200));
    fs.writeFileSync(stateFile, JSON.stringify({ status: process.env.FAKE_ANSWER || 'authorized' }));
  }
  process.exit(writeAuth() === 'authorized' ? 0 : 3);
}

if (mode === 'run') {
  writeJson('pid.json', { helper: process.pid });
  let status = writeAuth();
  while (status === 'notDetermined') { await sleep(100); status = writeAuth(); }
  if (status !== 'authorized') { writeJson('exit.json', { code: 3, signal: false, reason: status }); process.exit(3); }
  const log = fs.openSync(path.join(dir, 'ffmpeg.log'), 'w');
  const child = spawn(cmd[0], cmd.slice(1), { cwd: opts.cwd, stdio: ['ignore', 'ignore', log] });
  writeJson('pid.json', { helper: process.pid, child: child.pid });
  let stopping = false;
  const stop = () => { if (stopping) return; stopping = true; child.kill('SIGINT'); setTimeout(() => child.kill('SIGKILL'), 4000).unref(); };
  for (const s of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(s, stop);
  child.on('exit', (code, sig) => {
    writeJson('exit.json', { code: code ?? 1, signal: !!sig, at: Date.now() });
    process.exit(sig ? 1 : code ?? 1);
  });
} else process.exit(64);
