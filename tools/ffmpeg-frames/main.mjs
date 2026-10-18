// Video probe, frame extraction and contact sheets with ffprobe/ffmpeg (no shell: argument arrays only).
//   probe:  { "action": "probe", "input": "clip.mp4" }
//   frames: { "action": "frames", "input": "clip.mp4", "fps": 1, "width": 640 }  or  "timestamps": [0, 2.5, 10]
//   sheet:  { "action": "sheet", "input": "clip.mp4", "count": 12, "cols": 4 }   one PNG of evenly spaced frames
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const args = JSON.parse(process.env.RIGS_TOOL_ARGS || process.argv[2] || '{}');
const done = (o) => { console.log(JSON.stringify(o)); process.exit(o.ok ? 0 : 1); };
const isWin = process.platform === 'win32';
const which = (name) => {
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    for (const ext of isWin ? ['.exe', '.cmd', ''] : ['']) { const p = path.join(dir, name + ext); try { if (fs.statSync(p).isFile()) return p; } catch {} }
  }
  return null;
};
const exec = (cmd, a) => new Promise((resolve) => execFile(cmd, a, { maxBuffer: 64 * 1024 * 1024, timeout: 540000 }, (err, stdout, stderr) => resolve({ code: err ? (err.code ?? 1) : 0, stdout, stderr })));

const action = String(args.action || 'probe');
if (!['probe', 'frames', 'sheet'].includes(action)) done({ ok: false, error: 'action must be probe, frames or sheet' });
if (!args.input) done({ ok: false, error: 'input (a video file path) is required' });
const input = path.resolve(String(args.input).replace(/^~(?=$|[\\/])/, os.homedir()));
const format = args.format === 'jpg' ? 'jpg' : 'png';
const width = args.width ? Math.max(16, Math.min(7680, Math.round(Number(args.width)))) : null;
const scale = width ? `scale=${width}:-2` : null;
const base = path.basename(input).replace(/\.[^.]+$/, '').replace(/[^\w.-]+/g, '_');
const outDir = path.resolve(String(args.outDir || path.join(os.tmpdir(), 'rigs-frames', base)).replace(/^~(?=$|[\\/])/, os.homedir()));
const maxFrames = 500;

const probeArgs = ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', input];
const ff = (...a) => ['-y', '-v', 'error', ...a];
let plan;
if (action === 'probe') plan = [['ffprobe', probeArgs]];
else if (action === 'frames') {
  const ts = Array.isArray(args.timestamps) ? args.timestamps.map(Number) : null;
  if (ts && (!ts.length || ts.length > maxFrames || ts.some((t) => !Number.isFinite(t) || t < 0))) done({ ok: false, error: `timestamps must be 1-${maxFrames} non-negative seconds` });
  if (ts) plan = ts.map((t) => ['ffmpeg', ff('-ss', String(t), '-i', input, '-frames:v', '1', ...(scale ? ['-vf', scale] : []), path.join(outDir, `frame_${String(t).replace('.', '_')}s.${format}`))]);
  else {
    const fps = Number(args.fps ?? 1);
    if (!(fps > 0 && fps <= 60)) done({ ok: false, error: 'fps must be above 0 and at most 60' });
    plan = [['ffmpeg', ff('-i', input, '-vf', [`fps=${fps}`, scale].filter(Boolean).join(','), '-frames:v', String(maxFrames), path.join(outDir, `frame_%04d.${format}`))]];
  }
} else {
  const count = Math.round(Number(args.count ?? 12));
  const cols = Math.round(Number(args.cols ?? 4));
  if (!(count >= 1 && count <= 100) || !(cols >= 1 && cols <= 20)) done({ ok: false, error: 'count must be 1-100 and cols 1-20' });
  plan = [['ffmpeg', ff('-i', input, '-vf', [`fps=${count}/<duration>`, `scale=${width || 320}:-2`, `tile=${cols}x${Math.ceil(count / cols)}`].join(','), '-frames:v', '1', path.join(outDir, `${base}_sheet.${format}`))]];
}
if (args.dryRun) done({ ok: true, dryRun: true, plan: plan.map(([c, a]) => [c, ...a].join(' ')), outDir: action === 'probe' ? undefined : outDir });

if (!fs.existsSync(input)) done({ ok: false, error: `${input} does not exist` });
const ffprobe = which('ffprobe');
const ffmpeg = which('ffmpeg');
if (!ffprobe || (action !== 'probe' && !ffmpeg)) done({ ok: false, error: 'ffmpeg/ffprobe are not installed on this machine' });

const probe = async () => {
  const r = await exec(ffprobe, probeArgs);
  if (r.code) throw new Error(`ffprobe failed: ${r.stderr.trim().split('\n').pop()}`);
  const j = JSON.parse(r.stdout);
  const v = (j.streams || []).find((s) => s.codec_type === 'video');
  const a = (j.streams || []).find((s) => s.codec_type === 'audio');
  const [n, d] = String(v?.avg_frame_rate || '0/1').split('/').map(Number);
  return {
    durationSec: Number(j.format?.duration) || null, sizeBytes: Number(j.format?.size) || null, container: j.format?.format_name,
    video: v ? { codec: v.codec_name, width: v.width, height: v.height, fps: d ? Math.round((n / d) * 100) / 100 : null, frames: Number(v.nb_frames) || null } : null,
    audio: a ? { codec: a.codec_name, channels: a.channels, sampleRate: Number(a.sample_rate) || null } : null,
  };
};

try {
  const info = await probe();
  if (action === 'probe') done({ ok: true, input, ...info });
  if (!info.video) done({ ok: false, error: `${input} has no video stream` });
  fs.mkdirSync(outDir, { recursive: true });
  for (const [, a] of plan) {
    const argv = action === 'sheet' ? a.map((x) => x.replace('<duration>', String(info.durationSec || 1))) : a;
    const r = await exec(ffmpeg, argv);
    if (r.code) done({ ok: false, error: `ffmpeg failed: ${r.stderr.trim().split('\n').slice(-2).join(' | ')}` });
  }
  const files = fs.readdirSync(outDir).filter((f) => f.endsWith(`.${format}`)).sort();
  done({ ok: true, input, outDir, count: files.length, files: files.slice(0, 50).map((f) => path.join(outDir, f)), ...(files.length > 50 ? { more: files.length - 50 } : {}), video: info.video, durationSec: info.durationSec });
} catch (e) {
  done({ ok: false, error: e.message });
}
