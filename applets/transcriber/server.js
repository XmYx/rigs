#!/usr/bin/env node
// Transcriber applet server: serves the page (public/) with relative URLs only, because the App Cloud reaches it
// under /api/nodes/<node>/apps/transcriber/, plus
//   GET    healthz                  {ok:true}
//   GET    api/status               engine state (unloaded/loading/ready, device), model, languages, queue length
//   POST   api/jobs?lang=hu&name=…&source=mic|file    body = the audio as is (a MediaRecorder blob or any audio/video file) → 202 {id}
//   GET    api/jobs                 history, newest first (finished jobs are kept in dataDir/history.json)
//   GET    api/jobs/<id>            {status, progress, segments[], text, language, duration, elapsed, device, error}
//   DELETE api/jobs/<id>            cancel a queued/running job (stops the worker) or drop a finished one from the history
// Speech-to-text is faster-whisper in a Python worker (worker.py) that this server starts on demand, feeds one job
// at a time over a JSON-lines pipe and stops after an idle timeout so the GPU memory goes back to the others.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { HOME, log, readJsonSync } from '../../src/util.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const PUBLIC_DIR = path.join(HERE, 'public');
export const WORKER = path.join(HERE, 'worker.py');
export const LANGUAGES = {
  hu: 'Magyar (Hungarian)', en: 'English', de: 'Deutsch', ro: 'Română', sk: 'Slovenčina', sr: 'Српски', hr: 'Hrvatski',
  sl: 'Slovenščina', cs: 'Čeština', pl: 'Polski', fr: 'Français', es: 'Español', it: 'Italiano', ru: 'Русский', uk: 'Українська',
};
export const DEFAULTS = {
  port: 8741, host: '127.0.0.1', model: 'large-v3-turbo', device: 'auto', compute: 'float16,int8_float16', python: '',
  defaultLanguage: 'hu', dataDir: '', idleSec: 300, maxMb: 500, historyMax: 50, overseer: 'http://127.0.0.1:8195', workerCommand: null,
};
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json' };
const EXT_BY_MIME = { 'audio/webm': '.webm', 'video/webm': '.webm', 'audio/ogg': '.ogg', 'audio/mp4': '.m4a', 'audio/mpeg': '.mp3', 'audio/wav': '.wav', 'audio/x-wav': '.wav', 'audio/flac': '.flac' };

export const validLang = (l) => typeof l === 'string' && /^(auto|[a-z]{2,3})$/.test(l);

/** Settings from env (TRANSCRIBER_*), then ~/.rigs/config.json → transcriber, then defaults. */
export function loadConfig({ env = process.env, configFile } = {}) {
  const rigsHome = env.RIGS_HOME ? path.resolve(env.RIGS_HOME) : path.join(HOME, '.rigs');
  const rigsCfg = readJsonSync(configFile || path.join(rigsHome, 'config.json'), {}) || {};
  const own = rigsCfg.transcriber && typeof rigsCfg.transcriber === 'object' ? rigsCfg.transcriber : {};
  const cfg = { ...DEFAULTS, ...own };
  const warnings = [];
  const E = (k) => env[`TRANSCRIBER_${k}`];
  if (E('PORT')) cfg.port = Number(E('PORT'));
  if (E('HOST')) cfg.host = E('HOST');
  if (E('MODEL')) cfg.model = E('MODEL');
  if (E('DEVICE')) cfg.device = E('DEVICE');
  if (E('PYTHON')) cfg.python = E('PYTHON');
  if (E('DATA_DIR')) cfg.dataDir = E('DATA_DIR');
  if (E('IDLE_SEC')) cfg.idleSec = Number(E('IDLE_SEC'));
  if (E('MAX_MB')) cfg.maxMb = Number(E('MAX_MB'));
  if (E('LANGUAGE')) cfg.defaultLanguage = E('LANGUAGE');
  if (E('OVERSEER') !== undefined) cfg.overseer = E('OVERSEER');
  if (!Number.isInteger(cfg.port) || cfg.port < 1 || cfg.port > 65535) { warnings.push('port is invalid; using the default'); cfg.port = DEFAULTS.port; }
  if (!['auto', 'cuda', 'cpu'].includes(cfg.device)) { warnings.push('device must be auto, cuda or cpu; using auto'); cfg.device = 'auto'; }
  if (!(cfg.idleSec >= 0)) { warnings.push('idleSec is invalid; using the default'); cfg.idleSec = DEFAULTS.idleSec; }
  if (!(cfg.maxMb > 0)) { warnings.push('maxMb is invalid; using the default'); cfg.maxMb = DEFAULTS.maxMb; }
  if (!validLang(cfg.defaultLanguage)) { warnings.push('defaultLanguage is invalid; using hu'); cfg.defaultLanguage = 'hu'; }
  cfg.dataDir = path.resolve(cfg.dataDir || path.join(rigsHome, 'transcriber'));
  cfg.rigsHome = rigsHome;
  return { cfg, warnings };
}

/** The Python that has faster-whisper: config/env, this applet's own venv, else the JARVIS Voice venv on this machine. */
export function findPython(cfg, exists = fs.existsSync) {
  const bin = process.platform === 'win32' ? ['Scripts', 'python.exe'] : ['bin', 'python'];
  const candidates = [
    cfg.python,
    path.join(cfg.rigsHome, 'transcriber', 'venv', ...bin),
    path.join(HOME, 'apps', 'jarvis-voice', '.venv', ...bin),
  ].filter(Boolean);
  return candidates.find((p) => exists(p)) || null;
}

/** Does this Python import faster_whisper? → {ok, error?} */
export function checkPython(py) {
  return new Promise((resolve) => {
    const p = spawn(py, ['-c', 'import faster_whisper, numpy'], { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    p.stderr.on('data', (d) => { err += d; });
    p.on('error', (e) => resolve({ ok: false, error: e.message }));
    p.on('close', (code) => resolve(code === 0 ? { ok: true } : { ok: false, error: (err.trim().split('\n').pop() || `exit ${code}`).slice(0, 200) }));
  });
}

/** The speech engine: one worker process, started on first use, stopped after cfg.idleSec without work. */
export function createEngine({ cfg, spawnFn = spawn, find = findPython }) {
  let child = null;
  let state = 'unloaded';
  let info = { device: null, compute: null };
  let current = null; // { id, onEvent }
  let idle = null;

  const armIdle = () => {
    clearTimeout(idle);
    if (cfg.idleSec > 0) { idle = setTimeout(() => { if (!current) stop(); }, cfg.idleSec * 1000); idle.unref?.(); }
  };
  const command = () => {
    if (cfg.workerCommand) return cfg.workerCommand;
    const py = find(cfg);
    if (!py) throw new Error('No speech engine installed: run applets/transcriber/scripts/setup.sh in the RIGS checkout (faster-whisper in ~/.rigs/transcriber/venv)');
    return [py, WORKER, '--model', cfg.model, '--device', cfg.device, '--compute', cfg.compute, '--overseer', cfg.overseer || ''];
  };
  function start() {
    const [cmd, ...args] = command();
    const proc = spawnFn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, PYTHONUNBUFFERED: '1' } });
    child = proc;
    state = 'loading';
    readline.createInterface({ input: proc.stdout }).on('line', (line) => {
      let ev; try { ev = JSON.parse(line); } catch { return; }
      if (ev.type === 'loaded') { state = 'ready'; info = { device: ev.device, compute: ev.compute }; }
      if (current && (ev.id === current.id || ev.id == null)) current.onEvent(ev);
    });
    proc.stderr.on('data', (d) => { const s = String(d).trim(); if (s) log(`transcriber worker: ${s.slice(-300)}`); });
    proc.on('error', (e) => fail(proc, `could not start the speech engine: ${e.message}`));
    proc.on('exit', (code, sig) => fail(proc, `the speech engine stopped (${sig || `exit ${code}`})`));
  }
  function fail(proc, message) {
    if (child !== proc) return;
    child = null;
    state = 'unloaded';
    if (current) { const c = current; c.onEvent({ type: 'error', id: c.id, error: message }); }
  }
  function stop() {
    clearTimeout(idle);
    const proc = child;
    child = null;
    state = 'unloaded';
    if (proc) { proc.stdin.end(); proc.kill('SIGTERM'); setTimeout(() => proc.kill('SIGKILL'), 3000).unref(); }
  }
  return {
    get state() { return state; },
    get info() { return info; },
    get busy() { return !!current; },
    /** Run one request; resolves with the terminal event ({type:'done'|'error'}). */
    run(request, onEvent) {
      return new Promise((resolve) => {
        clearTimeout(idle);
        const finish = (ev) => { current = null; armIdle(); resolve(ev); };
        const entry = { id: request.id, onEvent: (ev) => { onEvent(ev); if (ev.type === 'done' || ev.type === 'error') finish(ev); } };
        current = entry;
        try {
          if (!child) start();
          child.stdin.write(`${JSON.stringify(request)}\n`);
        } catch (e) { entry.onEvent({ type: 'error', id: request.id, error: e.message }); }
      });
    },
    /** Abort the running request by stopping the worker (it restarts on the next job). */
    cancel() { const c = current; stop(); if (c) c.onEvent({ type: 'error', id: c.id, error: 'cancelled' }); },
    stop,
  };
}

/** Job queue + history on top of an engine. */
export function createJobs({ cfg, engine, now = Date.now }) {
  const jobs = new Map(); // queued + running
  const finished = new Map(); // recently finished, still readable by id
  const queue = [];
  const histFile = path.join(cfg.dataDir, 'history.json');
  const uploads = path.join(cfg.dataDir, 'uploads');
  let history = (() => { const h = readJsonSync(histFile, []); return Array.isArray(h) ? h.filter((j) => j && typeof j.id === 'string') : []; })();
  let running = null;

  const persist = () => {
    fs.mkdirSync(cfg.dataDir, { recursive: true });
    fs.writeFileSync(`${histFile}.tmp`, JSON.stringify(history, null, 1));
    fs.renameSync(`${histFile}.tmp`, histFile);
  };
  const view = (j) => ({ id: j.id, name: j.name, source: j.source, lang: j.lang, status: j.status, stage: j.stage, progress: j.progress, segments: j.segments, text: j.text,
    language: j.language, probability: j.probability, duration: j.duration, elapsed: j.elapsed, device: j.device, error: j.error || null, createdAt: j.createdAt });
  const finish = (j, status) => {
    j.status = status;
    if (j.file) { fs.rm(j.file, { force: true }, () => {}); j.file = null; }
    jobs.delete(j.id);
    if (status === 'cancelled') return;
    const v = view(j);
    history = [v, ...history].slice(0, cfg.historyMax);
    persist();
    finished.set(j.id, v);
    if (finished.size > 200) finished.delete(finished.keys().next().value);
  };

  async function pump() {
    if (running || !queue.length) return;
    const j = queue.shift();
    running = j;
    j.status = 'running';
    const terminal = await engine.run({ id: j.id, path: j.file, language: j.lang }, (ev) => {
      if (running !== j) return;
      if (ev.type === 'loading') j.stage = 'loading';
      if (ev.type === 'loaded') { j.device = ev.device; j.stage = 'transcribing'; }
      if (ev.type === 'info' && ev.duration) j.duration = ev.duration;
      if (ev.type === 'segment') {
        j.stage = 'transcribing';
        j.segments.push({ start: ev.start, end: ev.end, text: ev.text });
        j.progress = ev.progress;
        j.text = j.segments.map((s) => s.text).join(' ');
      }
    });
    if (running === j) {
      running = null;
      if (terminal.type === 'done') Object.assign(j, { text: terminal.text, language: terminal.language, probability: terminal.probability, duration: terminal.duration, elapsed: terminal.elapsed, progress: 1, device: engine.info.device || j.device });
      else j.error = terminal.error || 'transcription failed';
      finish(j, terminal.type === 'done' ? 'done' : 'error');
    }
    pump();
  }

  return {
    get queued() { return queue.length + (running ? 1 : 0); },
    uploadPath(id, ext) { fs.mkdirSync(uploads, { recursive: true }); return path.join(uploads, `${id}${ext}`); },
    newId: () => `t-${now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    add({ id, file, name, lang, source }) {
      const j = { id, file, name: name || 'recording', lang, source: source === 'mic' ? 'mic' : 'file', status: 'queued', stage: 'queued', progress: 0, segments: [], text: '', createdAt: now() };
      jobs.set(id, j);
      queue.push(j);
      pump();
      return j;
    },
    get: (id) => (jobs.has(id) ? view(jobs.get(id)) : finished.get(id) || history.find((h) => h.id === id) || null),
    list: () => [...jobs.values()].reverse().map(view).concat(history),
    remove(id) {
      const j = jobs.get(id);
      if (j) {
        const wasRunning = running === j;
        const qi = queue.indexOf(j);
        if (qi >= 0) queue.splice(qi, 1);
        finish(j, 'cancelled');
        if (wasRunning) { running = null; engine.cancel(); pump(); }
        return true;
      }
      const i = history.findIndex((h) => h.id === id);
      if (i < 0) return false;
      history.splice(i, 1);
      finished.delete(id);
      persist();
      return true;
    },
  };
}

// ---------------------------------------------------------------- server

function send(res, status, body, headers = {}) {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
  res.writeHead(status, { 'content-length': buf.length, 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers });
  res.end(res.req.method === 'HEAD' ? undefined : buf);
}

/** Stream the request body into a file; rejects with status 413 above limit bytes. Resolves with the byte count. */
function saveBody(req, file, limit) {
  return new Promise((resolve, reject) => {
    const out = fs.createWriteStream(file);
    let size = 0;
    let failed = false;
    const abort = (err) => { if (failed) return; failed = true; req.unpipe(out); out.destroy(); fs.rm(file, { force: true }, () => {}); req.resume(); reject(err); };
    req.on('data', (c) => { size += c.length; if (size > limit) abort(Object.assign(new Error(`file is larger than ${Math.round(limit / 1048576)} MB`), { status: 413 })); });
    req.on('error', abort);
    req.pipe(out);
    out.on('finish', () => { if (!failed) resolve(size); });
    out.on('error', abort);
  });
}

export function createTranscriberServer({ cfg = loadConfig().cfg, engine = createEngine({ cfg }), publicDir = PUBLIC_DIR, now = Date.now } = {}) {
  const root = path.resolve(publicDir);
  const jobs = createJobs({ cfg, engine, now });
  let pyCheck = null; // cached { python, ok, error, at }
  const checkEngine = async () => {
    if (cfg.workerCommand) return { python: 'custom', ok: true };
    if (pyCheck && (pyCheck.ok || now() - pyCheck.at < 15000)) return pyCheck;
    const python = findPython(cfg);
    pyCheck = python ? { python, ...(await checkPython(python)), at: now() } : { python: null, ok: false, error: 'faster-whisper is not installed: run applets/transcriber/scripts/setup.sh', at: now() };
    return pyCheck;
  };

  async function api(req, res, url) {
    const p = url.pathname.replace(/^\/api\//, '');
    if (p === 'status' && req.method === 'GET') {
      const { at, ...py } = await checkEngine();
      return send(res, 200, { ok: true, model: cfg.model, engine: py, state: engine.state, busy: engine.busy, device: engine.info.device, queued: jobs.queued,
        languages: LANGUAGES, defaultLanguage: cfg.defaultLanguage, maxMb: cfg.maxMb, idleSec: cfg.idleSec });
    }
    if (p === 'jobs' && req.method === 'GET') return send(res, 200, { jobs: jobs.list() });
    if (p === 'jobs' && req.method === 'POST') {
      const lang = url.searchParams.get('lang') || cfg.defaultLanguage;
      if (!validLang(lang)) { req.resume(); return send(res, 400, { error: 'lang must be "auto" or a language code like hu' }); }
      if (Number(req.headers['content-length']) > cfg.maxMb * 1048576) { req.resume(); return send(res, 413, { error: `file is larger than ${cfg.maxMb} MB` }); }
      const name = String(url.searchParams.get('name') || '').slice(0, 120) || 'recording';
      const mime = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
      const id = jobs.newId();
      const ext = (path.extname(name).match(/^\.[A-Za-z0-9]{1,5}$/) || [EXT_BY_MIME[mime] || ''])[0];
      const file = jobs.uploadPath(id, ext);
      let size;
      try { size = await saveBody(req, file, cfg.maxMb * 1048576); } catch (e) { return send(res, e.status || 500, { error: e.message }); }
      if (!size) { fs.rm(file, { force: true }, () => {}); return send(res, 400, { error: 'empty audio' }); }
      jobs.add({ id, file, name, lang, source: url.searchParams.get('source') });
      return send(res, 202, { id });
    }
    const m = p.match(/^jobs\/([\w-]+)$/);
    if (m && req.method === 'GET') { const j = jobs.get(m[1]); return j ? send(res, 200, j) : send(res, 404, { error: 'no such job' }); }
    if (m && req.method === 'DELETE') return jobs.remove(m[1]) ? send(res, 200, { ok: true }) : send(res, 404, { error: 'no such job' });
    return send(res, 404, { error: 'not found' });
  }

  function serveStatic(req, res, url) {
    let rel;
    try { rel = decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname); } catch { return send(res, 400, { error: 'bad url' }); }
    const file = path.resolve(root, `.${rel}`);
    if (!file.startsWith(root + path.sep)) return send(res, 403, { error: 'forbidden' });
    fs.readFile(file, (err, buf) => {
      if (err) return send(res, 404, { error: 'not found' });
      send(res, 200, buf, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' });
    });
  }

  const server = http.createServer((req, res) => {
    let url;
    try { url = new URL(req.url, 'http://x'); } catch { return send(res, 400, { error: 'bad url' }); }
    if (url.pathname === '/healthz') return send(res, 200, { ok: true });
    const handler = url.pathname.startsWith('/api/') ? api(req, res, url)
      : (req.method === 'GET' || req.method === 'HEAD') ? serveStatic(req, res, url) : send(res, 405, { error: 'method not allowed' });
    Promise.resolve(handler).catch((e) => { log(`transcriber: ${e.stack || e}`); if (!res.headersSent) send(res, 500, { error: e.message }); });
  });
  server.on('close', () => engine.stop());
  return { server, jobs, engine, cfg };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const { cfg, warnings } = loadConfig();
  for (const w of warnings) log(`transcriber: ${w}`);
  const { server } = createTranscriberServer({ cfg });
  server.listen(cfg.port, cfg.host, () => log(`transcriber applet on http://${cfg.host}:${server.address().port}/ (model ${cfg.model}, python ${findPython(cfg) || 'none'})`));
  for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => { server.close(); setTimeout(() => process.exit(0), 200).unref(); });
}
