// Home Security — ingest (docs/home-security.md §3). Owner: t2.
// One supervised ffmpeg per enabled camera, three outputs from one decode: rolling MPEG-TS segments, gray motion frames
// on stdout, and a latest.jpg snapshot. Pure parts (exported): ffmpeg argument building, segment-list parsing, segment
// paths, the in-memory live segment ring, backoff, error classification, motion-frame size parsing.
import { execFile, execFileSync, spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { redact } from './discovery.js';

// ── ffmpeg lookup ─────────────────────────────────────────────────────────────────────────────────────────────────

function onPath(name, env = process.env) {
  const exts = process.platform === 'win32' ? ['.exe', '.cmd', ''] : [''];
  for (const dir of String(env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const f = path.join(dir, name + ext);
      try { fs.accessSync(f, fs.constants.X_OK); if (fs.statSync(f).isFile()) return f; } catch { /* next */ }
    }
  }
  return null;
}

function versionOf(bin) {
  try {
    const out = execFileSync(bin, ['-hide_banner', '-version'], { timeout: 8000, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    return out.match(/version\s+(\S+)/)?.[1] || 'unknown';
  } catch { return null; }
}

function encodersOf(bin) {
  try {
    const out = execFileSync(bin, ['-hide_banner', '-encoders'], { timeout: 8000, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    return new Set([...out.matchAll(/^\s*V[.\w]{5}\s+(\S+)/gm)].map((m) => m[1]));
  } catch { return new Set(); }
}

/** → { found, path, version, ffprobe, encoders:Set } — never throws. */
export function findFfmpeg(settings = {}, env = process.env) {
  const candidates = [settings.ffmpeg?.path, env.FFMPEG, onPath('ffmpeg', env),
    ...(process.platform === 'darwin' ? ['/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg'] : []),
    ...(process.platform === 'linux' ? ['/usr/bin/ffmpeg', '/usr/local/bin/ffmpeg'] : [])].filter(Boolean);
  for (const c of candidates) {
    const version = versionOf(c);
    if (!version) continue;
    const sibling = path.join(path.dirname(c), path.basename(c).replace(/ffmpeg/i, 'ffprobe'));
    const ffprobe = [env.FFPROBE, fs.existsSync(sibling) ? sibling : null, onPath('ffprobe', env)].filter(Boolean).find((p) => versionOf(p)) || null;
    return { found: true, path: c, version, ffprobe, encoders: encodersOf(c) };
  }
  return { found: false, path: null, version: null, ffprobe: null, encoders: new Set() };
}

// ── pure helpers ──────────────────────────────────────────────────────────────────────────────────────────────────

/** segment list CSV (`-segment_list_type csv`) → [{ file, start, end }] in seconds. Skips partial trailing lines. */
export function parseSegmentList(text) {
  const out = [];
  const lines = String(text || '').split('\n');
  if (!String(text || '').endsWith('\n')) lines.pop(); // the last line may still be being written
  for (const line of lines) {
    const m = line.trim().match(/^"?([^",]+)"?,(-?[\d.]+),(-?[\d.]+)$/);
    if (m) out.push({ file: m[1], start: Number(m[2]), end: Number(m[3]) });
  }
  return out;
}

const pad = (n) => String(n).padStart(2, '0');
/** Where a segment lives, relative to the data dir (forward slashes). Folders are UTC day/hour. */
export function segmentRelPath(camera, startMs) {
  const d = new Date(startMs);
  return `segments/${camera}/${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}/${pad(d.getUTCHours())}/${startMs}.ts`;
}

/** The last N segments of one camera, for the live playlist. Media sequence numbers increase by one per segment. */
export class SegmentRing {
  constructor(capacity = 30) { this.capacity = Math.max(1, capacity); this.items = []; this.seq = 0; }
  push(seg) {
    const last = this.items[this.items.length - 1];
    if (last && seg.startMs <= last.startMs) return null; // out of order / duplicate
    const item = { ...seg, seq: this.seq++ };
    this.items.push(item);
    while (this.items.length > this.capacity) this.items.shift();
    return item;
  }
  recent(n = this.capacity) { return this.items.slice(-Math.max(0, n)); }
  find(startMs) { return this.items.find((s) => s.startMs === startMs) || null; }
  get last() { return this.items[this.items.length - 1] || null; }
  clear() { this.items = []; }
}

/** HLS live playlist over ring items [{ seq, startMs, durMs }] with relative seg/<startMs>.ts URIs. */
export function livePlaylist(items) {
  const target = Math.max(1, ...items.map((s) => Math.ceil(s.durMs / 1000)));
  // Segments are cut with -reset_timestamps 1, so every boundary restarts PTS: each one is a discontinuity, and the
  // discontinuity sequence of the first listed segment equals its media sequence (one per earlier boundary).
  const first = items[0]?.seq ?? 0;
  const lines = ['#EXTM3U', '#EXT-X-VERSION:3', `#EXT-X-TARGETDURATION:${target}`, `#EXT-X-MEDIA-SEQUENCE:${first}`,
    `#EXT-X-DISCONTINUITY-SEQUENCE:${first}`];
  items.forEach((s, k) => {
    if (k > 0) lines.push('#EXT-X-DISCONTINUITY');
    lines.push(`#EXT-X-PROGRAM-DATE-TIME:${new Date(s.startMs).toISOString()}`, `#EXTINF:${(s.durMs / 1000).toFixed(3)},`, `seg/${s.startMs}.ts`);
  });
  return lines.join('\n') + '\n';
}

/** Restart delay: 2 s → ×2 → 60 s, reset after 5 min healthy. */
export function nextBackoff(prevMs, ranMs, { min = 2000, max = 60000, healthyMs = 300000 } = {}) {
  if (!prevMs || ranMs >= healthyMs) return min;
  return Math.min(max, prevMs * 2);
}

/** ffmpeg stderr tail → a short, redacted, user-facing reason. */
export function classifyError(stderr, { platform = process.platform, kind } = {}) {
  const t = String(stderr || '');
  if (platform === 'darwin' && kind === 'webcam' && /not authori[sz]ed|permission|TCC|denied/i.test(t)) {
    return 'camera permission denied — allow it in System Settings › Privacy & Security › Camera';
  }
  if (/Device or resource busy|EBUSY|Could not run graph|already in use/i.test(t)) return 'device busy';
  if (/401 Unauthorized|403 Forbidden|authorization failed|Unauthorized/i.test(t)) return 'authentication failed — check the camera username and password';
  if (/Connection refused/i.test(t)) return 'connection refused';
  if (/Connection timed out|timed out|Operation timed out|No route to host|Network is unreachable/i.test(t)) return 'camera not reachable (timeout)';
  if (/404 Not Found|Server returned 404|method DESCRIBE failed: 404/i.test(t)) return 'stream not found — check the URL path';
  if (/No such file or directory|Cannot open video device|could not find video device|Could not find video device|Invalid device/i.test(t)) return 'device not found';
  if (/not supported|Selected framerate|Selected video size/i.test(t)) return 'camera does not support the requested size or frame rate';
  if (/Unknown encoder|Encoder not found/i.test(t)) return 'ffmpeg lacks the needed H.264 encoder';
  const last = t.trim().split('\n').filter((l) => /error|fail|invalid|cannot|unable/i.test(l)).pop() || t.trim().split('\n').pop() || 'ffmpeg exited';
  return redact(last.replace(/^\s*\[[^\]]*\]\s*/, '')).slice(0, 300);
}

/** A run that produced no video. On macOS a webcam that never delivers a first frame is almost always TCC: the camera
 *  permission is silently withheld from a process started in the background (ffmpeg then just waits). */
export function stallReason({ gotSegment, platform, kind }) {
  if (!gotSegment && platform === 'darwin' && kind === 'webcam') {
    return 'camera permission denied — allow it in System Settings › Privacy & Security › Camera (no frames from the camera)';
  }
  return gotSegment ? 'stalled: the camera stopped sending video' : 'stalled: no video from the camera';
}

/** From ffmpeg's startup banner: the motion output's frame size (Output #1, rawvideo gray WxH). */
export function parseMotionDims(stderr) {
  const i = String(stderr).indexOf('Output #1');
  if (i < 0) return null;
  const m = String(stderr).slice(i).match(/rawvideo[^\n]*?\bgray\b[^\n]*?\b(\d{2,5})x(\d{2,5})\b/);
  return m ? { width: Number(m[1]), height: Number(m[2]) } : null;
}

/** Effective recording mode of a camera. */
export const cameraMode = (camera, settings) => camera.mode || settings?.recording?.defaultMode || 'continuous';

/**
 * ffmpeg argv for one camera (pure).
 * @param o.camera stored camera; o.settings full settings; o.inputUrl source URL WITH credentials (network cameras);
 * @param o.copy true → -c:v copy; o.encoder 'h264_videotoolbox' | 'libx264'; o.relaxInput → no size/fps on the device.
 * Output files are relative to cwd = <data>/segments/<cam>/.incoming ; o.snapshotPath is absolute.
 */
export function buildFfmpegArgs(o) {
  const { camera, settings, platform = process.platform } = o;
  const seg = settings.recording?.segmentSeconds || 2;
  const mot = settings.motion || {};
  const live = settings.live || {};
  const input = { width: 1280, height: 720, fps: 15, ...(camera.input || {}) };
  const src = camera.source || {};
  const a = ['-hide_banner', '-nostats', '-loglevel', 'info', '-y'];

  if (camera.kind === 'test') {
    a.push('-re', '-f', 'lavfi', '-i', `${src.lavfi || 'testsrc2'}=size=${input.width}x${input.height}:rate=${input.fps}`);
  } else if (camera.kind === 'webcam') {
    const sized = o.relaxInput ? [] : ['-video_size', `${input.width}x${input.height}`];
    if (platform === 'darwin') {
      // avfoundation only accepts the device's own rates; 30 is what built-in and most UVC cameras offer
      a.push('-f', 'avfoundation', ...(o.relaxInput ? [] : ['-framerate', String(camera.input?.fps || 30)]), ...sized, '-i', `${src.device}:none`);
    } else if (platform === 'win32') {
      a.push('-f', 'dshow', '-rtbufsize', '64M', ...(o.relaxInput ? [] : ['-framerate', String(input.fps)]), ...sized, '-i', `video=${src.device}`);
    } else {
      a.push('-f', 'v4l2', ...(o.relaxInput ? [] : ['-framerate', String(input.fps)]), ...sized, '-i', src.device);
    }
  } else if (/^rtsps?:/i.test(o.inputUrl || '')) {
    a.push('-rtsp_transport', 'tcp', '-timeout', '10000000', '-fflags', '+genpts', '-i', o.inputUrl);
  } else {
    a.push('-rw_timeout', '10000000', '-use_wallclock_as_timestamps', '1', '-i', o.inputUrl);
  }

  const motion = `fps=${mot.fps || 5},scale=${mot.width || 160}:-2,format=gray`;
  const snap = `fps=${live.snapshotFps || 1},scale=640:-2`;
  if (o.copy) {
    a.push('-filter_complex', `[0:v]split=2[m0][s0];[m0]${motion}[mot];[s0]${snap}[snap]`, '-map', '0:v:0', '-c:v', 'copy');
  } else {
    const scale = `scale=${input.width}:${input.height}:force_original_aspect_ratio=decrease:force_divisible_by=2`;
    a.push('-filter_complex', `[0:v]fps=${input.fps},${scale},split=3[r0][m0][s0];[r0]format=yuv420p[rec];[m0]${motion}[mot];[s0]${snap}[snap]`, '-map', '[rec]');
    const gop = String(2 * input.fps);
    if (o.encoder === 'h264_videotoolbox') a.push('-c:v', 'h264_videotoolbox', '-realtime', '1', '-b:v', '2500k', '-allow_sw', '1');
    else a.push('-c:v', 'libx264', '-preset', 'veryfast', '-tune', 'zerolatency', '-crf', '24');
    a.push('-g', gop, '-force_key_frames', `expr:gte(t,n_forced*${seg})`);
  }
  a.push('-an', '-f', 'segment', '-segment_time', String(seg), '-segment_format', 'mpegts', '-reset_timestamps', '1',
    '-segment_list', 'list.csv', '-segment_list_type', 'csv', 'seg-%06d.ts');
  a.push('-map', '[mot]', '-f', 'rawvideo', 'pipe:1');
  a.push('-map', '[snap]', '-q:v', '5', '-f', 'image2', '-update', '1', '-atomic_writing', '1', o.snapshotPath);
  return a;
}

// ── ffprobe (stream info, used by transcode:auto and api/cameras/:id/test) ───────────────────────────────────────

export function ffprobe(ffprobePath, url, { timeoutMs = 12000 } = {}) {
  return new Promise((resolve) => {
    if (!ffprobePath) { resolve({ ok: false, error: 'ffprobe not found' }); return; }
    const args = ['-v', 'error', '-print_format', 'json', '-show_streams', '-select_streams', 'v:0'];
    if (/^rtsps?:/i.test(url)) args.push('-rtsp_transport', 'tcp', '-timeout', '8000000');
    else args.push('-rw_timeout', '8000000');
    args.push(url);
    execFile(ffprobePath, args, { timeout: timeoutMs, windowsHide: true, maxBuffer: 1 << 20 }, (err, stdout, stderr) => {
      try {
        const s = JSON.parse(stdout).streams?.[0];
        if (s) {
          const [n, d] = String(s.avg_frame_rate || s.r_frame_rate || '0/1').split('/').map(Number);
          resolve({ ok: true, codec: s.codec_name, width: s.width, height: s.height, fps: d ? Math.round((n / d) * 100) / 100 : null });
          return;
        }
      } catch { /* fall through */ }
      resolve({ ok: false, error: classifyError(stderr || err?.message || 'no video stream') });
    });
  });
}

// ── worker: one supervised ffmpeg ─────────────────────────────────────────────────────────────────────────────────

const LOG_MAX = 1 << 20;

export class CameraWorker extends EventEmitter {
  /** @param ctx { dataDir, ffmpeg (findFfmpeg result), platform, settings(), camera(), inputUrl(), ring } */
  constructor(id, ctx) {
    super();
    this.id = id; this.ctx = ctx;
    this.status = 'starting'; this.error = null; this.retryAt = null; this.pid = null; this.since = Date.now();
    this.restarts = 0; this.backoff = 0; this.stopping = false; this.relaxInput = false; this.copy = null;
    this.timers = new Set();
  }

  setStatus(status, error = null, retryAt = null) {
    const changed = status !== this.status || error !== this.error;
    this.status = status; this.error = error ? redact(error) : null; this.retryAt = retryAt;
    if (changed) { this.since = Date.now(); this.emit('status', this.snapshot()); }
  }

  snapshot() {
    return { camera: this.id, status: this.status, pid: this.pid, since: this.since, restarts: this.restarts, error: this.error, retryAt: this.retryAt };
  }

  later(fn, ms) { const t = setTimeout(() => { this.timers.delete(t); fn(); }, ms); this.timers.add(t); return t; }

  async start() {
    if (this.stopping) return;
    const camera = this.ctx.camera();
    if (!camera) return;
    const { ffmpeg, dataDir } = this.ctx;
    if (!ffmpeg.found) { this.setStatus('error', 'ffmpeg not found'); return; }
    if (camera.needsSetup) { this.setStatus('needs-setup'); return; }
    const inputUrl = camera.kind === 'webcam' || camera.kind === 'test' ? null : this.ctx.inputUrl();
    if (!inputUrl && camera.kind !== 'webcam' && camera.kind !== 'test') {
      this.setStatus(camera.kind === 'onvif' ? 'needs-credentials' : 'needs-setup'); return;
    }
    this.setStatus('starting');
    if (this.copy === null) {
      if (camera.transcode === 'copy') this.copy = true;
      else if (camera.transcode === 'h264' || !inputUrl || !/^rtsps?:/i.test(inputUrl)) this.copy = false;
      else {
        const p = await ffprobe(ffmpeg.ffprobe, inputUrl);
        if (this.stopping) return;
        if (!p.ok) return this.failed(p.error, 0);
        this.copy = p.codec === 'h264';
      }
    }
    const incoming = path.join(dataDir, 'segments', this.id, '.incoming');
    const liveDir = path.join(dataDir, 'live', this.id);
    fs.mkdirSync(incoming, { recursive: true }); fs.mkdirSync(liveDir, { recursive: true });
    fs.mkdirSync(path.join(dataDir, 'logs'), { recursive: true });
    // leftovers of a previous run of this worker: the unfinished last segment and the old list
    for (const f of fs.readdirSync(incoming)) if (/^seg-\d+\.ts$|^list\.csv$/.test(f)) fs.rmSync(path.join(incoming, f), { force: true });

    const settings = this.ctx.settings();
    const encoder = this.ctx.platform === 'darwin' && settings.ffmpeg?.hwaccel !== 'none' && ffmpeg.encoders.has('h264_videotoolbox') ? 'h264_videotoolbox' : 'libx264';
    const args = buildFfmpegArgs({ camera, settings, platform: this.ctx.platform, inputUrl, copy: this.copy, encoder,
      relaxInput: this.relaxInput, snapshotPath: path.join(liveDir, 'latest.jpg') });
    const segSeconds = settings.recording?.segmentSeconds || 2;

    const child = spawn(ffmpeg.path, args, { cwd: incoming, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    this.child = child; this.pid = child.pid || null;
    const startedAt = Date.now();
    this.emit('spawn', this.pid);
    let stderrTail = ''; let banner = ''; let dims = null; let frameBuf = Buffer.alloc(0);
    let listOffset = 0; let listRest = ''; let anchor = null; let gotSegment = false;
    let lastProgress = Date.now() + 10000; // startup grace (RTSP connect, camera warm-up)

    const logFile = path.join(dataDir, 'logs', `${this.id}.log`);
    const log = (text) => {
      try {
        if (fs.existsSync(logFile) && fs.statSync(logFile).size > LOG_MAX) fs.renameSync(logFile, `${logFile}.1`);
        fs.appendFileSync(logFile, text);
      } catch { /* logging is best effort */ }
    };
    log(`\n--- ${new Date().toISOString()} start pid ${this.pid} ${redact(args.join(' '))}\n`);

    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      const clean = redact(chunk);
      log(clean);
      stderrTail = (stderrTail + clean).slice(-6000);
      if (!dims) { banner = (banner + clean).slice(-20000); dims = parseMotionDims(banner); }
    });
    child.stdout.on('data', (chunk) => {
      if (!dims) { if (frameBuf.length < 8 << 20) frameBuf = Buffer.concat([frameBuf, chunk]); return; }
      frameBuf = frameBuf.length ? Buffer.concat([frameBuf, chunk]) : chunk;
      const size = dims.width * dims.height;
      while (frameBuf.length >= size) {
        const frame = frameBuf.subarray(0, size);
        frameBuf = frameBuf.subarray(size);
        this.emit('frame', { camera: this.id, frame: Buffer.from(frame), width: dims.width, height: dims.height, t: Date.now() });
      }
    });
    child.stdin.on('error', () => {});

    const listPath = path.join(incoming, 'list.csv');
    const poll = setInterval(() => {
      let fd;
      try {
        const st = fs.statSync(listPath);
        if (st.size < listOffset) { listOffset = 0; listRest = ''; }
        if (st.size === listOffset) return;
        fd = fs.openSync(listPath, 'r');
        const buf = Buffer.alloc(st.size - listOffset);
        fs.readSync(fd, buf, 0, buf.length, listOffset);
        listOffset = st.size;
        const text = listRest + buf.toString('utf8');
        const cut = text.lastIndexOf('\n') + 1;
        listRest = text.slice(cut);
        for (const row of parseSegmentList(text.slice(0, cut))) {
          const now = Date.now();
          const est = now - row.end * 1000;
          if (anchor === null || Math.abs(est - anchor) > 1000) anchor = est; // keep startMs within ±1 s of real time
          const startMs = Math.round(anchor + row.start * 1000);
          const durMs = Math.max(1, Math.round((row.end - row.start) * 1000));
          const rel = segmentRelPath(this.id, startMs);
          const abs = path.join(dataDir, ...rel.split('/'));
          try {
            fs.mkdirSync(path.dirname(abs), { recursive: true });
            fs.renameSync(path.join(incoming, row.file), abs);
          } catch { continue; }
          const bytes = fs.statSync(abs).size;
          lastProgress = now; gotSegment = true;
          const segInfo = { camera: this.id, startMs, durMs, path: rel, abs, bytes };
          this.ctx.ring.push(segInfo);
          if (this.status !== 'recording') { this.setStatus('recording'); }
          this.emit('segment', segInfo);
        }
      } catch { /* list not there yet */ } finally { if (fd !== undefined) fs.closeSync(fd); }
      if (Date.now() - lastProgress > (3 * segSeconds + 10) * 1000) {
        stderrTail += `\nstalled: no new segment for ${3 * segSeconds + 10} s`;
        this.stalled = true;
        child.kill('SIGKILL');
      }
    }, 300);

    child.on('error', (e) => { stderrTail += `\n${e.message}`; });
    child.on('exit', (code, sig) => {
      clearInterval(poll);
      this.child = null; this.pid = null;
      this.emit('exit', { code, sig });
      log(`--- exit code ${code} signal ${sig}\n`);
      if (this.stopping) { this.setStatus('idle'); this.emit('stopped'); return; }
      const ran = Date.now() - startedAt;
      let reason = this.stalled ? stallReason({ gotSegment, platform: this.ctx.platform, kind: camera.kind })
        : classifyError(stderrTail, { platform: this.ctx.platform, kind: camera.kind });
      this.stalled = false;
      if (reason.startsWith('camera does not support') && !this.relaxInput && camera.kind === 'webcam') {
        this.relaxInput = true; // retry with the device's own default size/rate
        reason += '; retrying with the camera defaults';
      }
      if (/encoder/i.test(reason) && camera.kind !== 'webcam') this.copy = null;
      this.failed(reason, ran);
    });
  }

  failed(reason, ranMs) {
    this.restarts++;
    this.backoff = nextBackoff(this.backoff, ranMs);
    const retryAt = Date.now() + this.backoff;
    this.setStatus('error', reason, retryAt);
    this.later(() => this.start(), this.backoff);
  }

  /** Graceful stop: 'q' on stdin, SIGKILL after 5 s. Resolves when the process is gone. */
  stop() {
    this.stopping = true;
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
    const child = this.child;
    if (!child) { this.setStatus('idle'); return Promise.resolve(); }
    return new Promise((resolve) => {
      const kill = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } }, 5000);
      child.once('exit', () => { clearTimeout(kill); resolve(); });
      try { child.stdin.write('q'); child.stdin.end(); } catch { child.kill('SIGTERM'); }
    });
  }
}

// ── manager: keeps exactly one worker per camera that should record ───────────────────────────────────────────────

export class IngestManager extends EventEmitter {
  /** @param o { dataDir, registry, settings() , ffmpeg, platform } */
  constructor(o) {
    super();
    Object.assign(this, { platform: process.platform, ...o });
    this.workers = new Map();
    this.rings = new Map();
    this.pidFile = path.join(this.dataDir, 'run', 'ffmpeg.json');
  }

  ring(id) {
    if (!this.rings.has(id)) this.rings.set(id, new SegmentRing(Math.max(30, (this.settings().live?.hlsWindowSegments || 6) * 3)));
    return this.rings.get(id);
  }

  /** Kill ffmpeg children a crashed previous run left behind. */
  killOrphans() {
    let pids = [];
    try { pids = JSON.parse(fs.readFileSync(this.pidFile, 'utf8')).map((p) => p.pid ?? p).filter(Number.isInteger); } catch { return 0; }
    let killed = 0;
    for (const pid of pids) {
      try {
        process.kill(pid, 0);
        const name = process.platform === 'win32'
          ? execFileSync('tasklist', ['/FI', `PID eq ${pid}`, '/NH'], { encoding: 'utf8', windowsHide: true })
          : execFileSync('ps', ['-p', String(pid), '-o', 'comm='], { encoding: 'utf8' });
        if (/ffmpeg/i.test(name)) { process.kill(pid, 'SIGKILL'); killed++; }
      } catch { /* not running */ }
    }
    this.writePids();
    return killed;
  }

  writePids() {
    try {
      fs.mkdirSync(path.dirname(this.pidFile), { recursive: true });
      const list = [...this.workers.values()].filter((w) => w.pid).map((w) => ({ camera: w.id, pid: w.pid }));
      fs.writeFileSync(this.pidFile, JSON.stringify(list));
    } catch { /* best effort */ }
  }

  shouldRun(c) {
    return !!c && c.enabled && !c.missing && cameraMode(c, this.settings()) !== 'off';
  }

  /** Start/stop workers so they match the registry. ids: restart these even if already running. */
  async sync(restartIds = []) {
    const want = new Set(this.registry.cameras.filter((c) => this.shouldRun(c)).map((c) => c.id));
    const stops = [];
    for (const [id, w] of this.workers) {
      if (!want.has(id) || restartIds.includes(id)) { this.workers.delete(id); stops.push(w.stop()); }
    }
    await Promise.all(stops);
    for (const id of want) if (!this.workers.has(id)) this.startWorker(id);
    this.writePids();
  }

  startWorker(id) {
    const w = new CameraWorker(id, {
      dataDir: this.dataDir, ffmpeg: this.ffmpeg, platform: this.platform, ring: this.ring(id),
      settings: () => this.settings(), camera: () => this.registry.get(id), inputUrl: () => this.registry.sourceUrl(id),
    });
    this.workers.set(id, w);
    w.on('status', (s) => this.emit('status', s));
    w.on('segment', (s) => this.emit('segment', s));
    w.on('frame', (f) => this.emit('frame', f));
    w.on('spawn', () => this.writePids());
    w.on('exit', () => this.writePids());
    w.start().catch((e) => w.failed(e.message, 0));
    return w;
  }

  runtime(id) {
    const c = this.registry.get(id);
    const w = this.workers.get(id);
    if (w) return w.snapshot();
    if (c?.missing) return { camera: id, status: 'unavailable' };
    if (c && c.kind === 'onvif' && !c.source?.url) return { camera: id, status: 'needs-credentials' };
    if (c && c.needsSetup) return { camera: id, status: 'needs-setup' };
    if (c && c.enabled && !this.ffmpeg.found) return { camera: id, status: 'error', error: 'ffmpeg not found' };
    return { camera: id, status: 'idle' };
  }

  list() { return [...this.workers.values()].map((w) => w.snapshot()); }

  async shutdown() {
    const all = [...this.workers.values()];
    this.workers.clear();
    await Promise.all(all.map((w) => w.stop()));
    this.writePids();
  }
}
