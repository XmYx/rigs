// Transcriber page: microphone or file in, transcript out. All URLs are relative (the App Cloud serves the page
// under /api/nodes/<node>/apps/transcriber/), and every string from the server goes in through textContent.
import { EXPORTS, clock, engineLine, exportName, pickMime, recordingName } from './transcript.js';

const $ = (id) => document.getElementById(id);
const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* private window */ } },
};

let status = null;
let shown = null; // the job on screen
let pollTimer = null;
let rec = null; // { recorder, stream, chunks, ctx, started, tick, raf }

async function api(path, opts = {}) {
  const r = await fetch(path, opts);
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(body.error || `HTTP ${r.status}`);
  return body;
}

function notice(text) {
  $('notice').textContent = text || '';
  $('notice').hidden = !text;
}

// ---------------------------------------------------------------- engine status + language

function renderEngine() {
  const line = engineLine(status);
  $('engine').className = `engine ${line.cls}`;
  $('engineText').textContent = line.text;
}

async function loadStatus() {
  try {
    const first = !status;
    status = await api('api/status');
    if (first) {
      const sel = $('lang');
      for (const [code, label] of [['auto', 'Auto-detect'], ...Object.entries(status.languages)]) sel.add(new Option(label, code));
      const saved = store.get('transcriber.lang');
      sel.value = [...sel.options].some((o) => o.value === saved) ? saved : status.defaultLanguage;
    }
  } catch { status = null; }
  renderEngine();
}

// ---------------------------------------------------------------- transcript view

function describe(job) {
  const bits = [];
  if (job.language) bits.push(job.lang === 'auto' ? `detected ${job.language}` : job.language);
  if (job.duration) bits.push(clock(job.duration));
  if (job.elapsed) bits.push(`${job.elapsed.toFixed(1)} s${job.device ? ` on ${job.device === 'cuda' ? 'GPU' : 'CPU'}` : ''}`);
  return bits.join(' · ');
}

function render(job) {
  shown = job;
  const box = $('transcript');
  box.replaceChildren();
  $('title').textContent = job ? job.name : 'Transcript';
  $('meta').textContent = job ? describe(job) : '';
  const active = job && (job.status === 'queued' || job.status === 'running');
  $('progress').hidden = !active;
  if (active) {
    $('bar').style.width = `${Math.round((job.progress || 0) * 100)}%`;
    $('stage').textContent = job.status === 'queued' ? 'Waiting in the queue…'
      : job.stage === 'loading' ? 'Loading the speech model…' : `Transcribing… ${Math.round((job.progress || 0) * 100)}%`;
  }
  const done = job && job.status === 'done' && job.text;
  $('actions').hidden = !done;
  if (!job) {
    const p = document.createElement('p');
    p.className = 'empty muted';
    p.textContent = 'Record from the microphone or choose a file. Hungarian is the default language.';
    box.append(p);
    return;
  }
  for (const s of job.segments || []) {
    const row = document.createElement('div');
    row.className = 'seg';
    const t = document.createElement('time');
    t.textContent = clock(s.start);
    const p = document.createElement('p');
    p.textContent = s.text;
    row.append(t, p);
    box.append(row);
  }
  if (job.status === 'error') {
    const p = document.createElement('p');
    p.className = 'err';
    p.textContent = job.error || 'Transcription failed.';
    box.append(p);
  } else if (job.status === 'done' && !job.text) {
    const p = document.createElement('p');
    p.className = 'muted';
    p.textContent = 'No speech was found in this audio.';
    box.append(p);
  }
  for (const li of $('history').children) li.classList.toggle('on', li.dataset.id === job.id);
}

// ---------------------------------------------------------------- history

async function loadHistory() {
  let jobs = [];
  try { jobs = (await api('api/jobs')).jobs; } catch { return; }
  const ul = $('history');
  ul.replaceChildren();
  $('historyEmpty').hidden = jobs.length > 0;
  for (const j of jobs) {
    const li = document.createElement('li');
    li.dataset.id = j.id;
    if (shown && shown.id === j.id) li.className = 'on';
    const pick = document.createElement('button');
    pick.type = 'button';
    pick.className = 'pick';
    const t = document.createElement('span');
    t.className = 't';
    t.textContent = j.name;
    const s = document.createElement('span');
    s.className = 's';
    s.textContent = j.status === 'done' ? (j.text || '(no speech)').slice(0, 90) : j.status === 'error' ? `Failed: ${j.error || ''}` : j.status;
    pick.append(t, s);
    pick.addEventListener('click', () => { stopPolling(); render(j); if (j.status === 'queued' || j.status === 'running') poll(j.id); });
    const x = document.createElement('button');
    x.type = 'button';
    x.className = 'x';
    x.title = 'Remove';
    x.setAttribute('aria-label', `Remove ${j.name}`);
    x.textContent = '✕';
    x.addEventListener('click', async () => {
      try { await api(`api/jobs/${j.id}`, { method: 'DELETE' }); } catch { /* already gone */ }
      if (shown && shown.id === j.id) { stopPolling(); render(null); }
      loadHistory();
    });
    li.append(pick, x);
    ul.append(li);
  }
}

// ---------------------------------------------------------------- jobs

function stopPolling() { clearInterval(pollTimer); pollTimer = null; }

function poll(id) {
  stopPolling();
  const tick = async () => {
    try {
      const job = await api(`api/jobs/${id}`);
      render(job);
      if (job.status !== 'queued' && job.status !== 'running') { stopPolling(); loadHistory(); loadStatus(); }
    } catch (e) { stopPolling(); notice(`Lost the job: ${e.message}`); }
  };
  pollTimer = setInterval(tick, 700);
  tick();
}

async function submit(blob, name, source) {
  notice('');
  const lang = $('lang').value;
  try {
    const q = new URLSearchParams({ lang, name, source });
    const { id } = await api(`api/jobs?${q}`, { method: 'POST', headers: { 'content-type': blob.type || 'application/octet-stream' }, body: blob });
    render({ id, name, status: 'queued', progress: 0, segments: [], lang });
    poll(id);
    loadHistory();
  } catch (e) { notice(e.message); }
}

$('cancel').addEventListener('click', async () => {
  if (!shown) return;
  try { await api(`api/jobs/${shown.id}`, { method: 'DELETE' }); } catch { /* finished meanwhile */ }
  stopPolling();
  render(null);
  loadHistory();
});

$('lang').addEventListener('change', () => store.set('transcriber.lang', $('lang').value));

// ---------------------------------------------------------------- export

for (const [fmt, def] of Object.entries(EXPORTS)) $('exportFmt').add(new Option(def.label, fmt));

$('copy').addEventListener('click', async () => {
  if (!shown) return;
  const text = EXPORTS.txt.make(shown);
  try { await navigator.clipboard.writeText(text); $('copy').textContent = 'Copied'; } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.append(ta);
    ta.select();
    try { document.execCommand('copy'); $('copy').textContent = 'Copied'; } catch { $('copy').textContent = 'Copy failed'; }
    ta.remove();
  }
  setTimeout(() => { $('copy').textContent = 'Copy'; }, 1500);
});

$('download').addEventListener('click', () => {
  if (!shown) return;
  const fmt = $('exportFmt').value;
  const def = EXPORTS[fmt];
  const url = URL.createObjectURL(new Blob([def.make(shown)], { type: def.mime }));
  const a = document.createElement('a');
  a.href = url;
  a.download = exportName(shown.name, fmt);
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
});

// ---------------------------------------------------------------- tabs

function selectTab(name) {
  for (const b of document.querySelectorAll('.tabs button')) b.setAttribute('aria-selected', String(b.dataset.tab === name));
  $('paneMic').hidden = name !== 'mic';
  $('paneFile').hidden = name !== 'file';
}
for (const b of document.querySelectorAll('.tabs button')) b.addEventListener('click', () => selectTab(b.dataset.tab));

// ---------------------------------------------------------------- file input

function takeFile(file) {
  if (!file) return;
  const player = $('filePlayer');
  if (player.dataset.url) URL.revokeObjectURL(player.dataset.url);
  player.dataset.url = URL.createObjectURL(file);
  player.src = player.dataset.url;
  player.hidden = false;
  submit(file, file.name, 'file');
}
$('file').addEventListener('change', (e) => { takeFile(e.target.files[0]); e.target.value = ''; });
$('drop').addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); $('file').click(); } });
for (const ev of ['dragenter', 'dragover']) $('drop').addEventListener(ev, (e) => { e.preventDefault(); $('drop').classList.add('over'); });
for (const ev of ['dragleave', 'drop']) $('drop').addEventListener(ev, (e) => { e.preventDefault(); $('drop').classList.remove('over'); });
$('drop').addEventListener('drop', (e) => takeFile(e.dataTransfer.files[0]));

// ---------------------------------------------------------------- microphone

function setRecording(on) {
  $('rec').setAttribute('aria-pressed', String(on));
  $('recLabel').textContent = on ? 'Stop and transcribe' : 'Start recording';
  $('recHint').textContent = on ? 'Recording… speak now.' : 'Speak, then press stop: the recording is transcribed right away.';
  if (!on) { $('level').style.width = '0'; $('recTime').textContent = '0:00'; }
}

async function startRecording() {
  notice('');
  if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
    notice('This browser cannot record audio here (it needs a secure https:// or localhost page). Use the Audio file tab instead.');
    return;
  }
  let stream;
  // The browser's noise suppression and gain control leave artefacts that hurt Whisper more than plain room noise does.
  try { stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: false, autoGainControl: false } }); } catch (e) {
    notice(e.name === 'NotAllowedError' ? 'Microphone access was blocked. Allow it for this page and try again.'
      : e.name === 'NotFoundError' ? 'No microphone was found.' : `Could not open the microphone: ${e.message}`);
    return;
  }
  const mime = pickMime((m) => MediaRecorder.isTypeSupported(m));
  // Chrome's default Opus rate (~32 kbit/s) smears consonants; 128 kbit/s costs ~1 MB/min and keeps Hungarian clean.
  const recorder = new MediaRecorder(stream, { ...(mime ? { mimeType: mime } : {}), audioBitsPerSecond: 128000 });
  const r = { recorder, stream, chunks: [], started: Date.now(), mime: recorder.mimeType || mime };
  recorder.ondataavailable = (e) => { if (e.data.size) r.chunks.push(e.data); };
  recorder.onstop = () => finishRecording(r);
  // level meter
  try {
    r.ctx = new AudioContext();
    const analyser = r.ctx.createAnalyser();
    analyser.fftSize = 512;
    r.ctx.createMediaStreamSource(stream).connect(analyser);
    const buf = new Uint8Array(analyser.fftSize);
    const loop = () => {
      analyser.getByteTimeDomainData(buf);
      let peak = 0;
      for (const v of buf) peak = Math.max(peak, Math.abs(v - 128));
      $('level').style.width = `${Math.min(100, Math.round((peak / 128) * 140))}%`;
      r.raf = requestAnimationFrame(loop);
    };
    loop();
  } catch { /* no meter, recording still works */ }
  r.tick = setInterval(() => { $('recTime').textContent = clock((Date.now() - r.started) / 1000); }, 250);
  rec = r;
  recorder.start(1000);
  setRecording(true);
}

function finishRecording(r) {
  clearInterval(r.tick);
  cancelAnimationFrame(r.raf);
  r.ctx?.close().catch(() => {});
  for (const t of r.stream.getTracks()) t.stop();
  rec = null;
  setRecording(false);
  const blob = new Blob(r.chunks, { type: r.mime || 'audio/webm' });
  if (!blob.size) { notice('Nothing was recorded.'); return; }
  const player = $('recPlayer');
  if (player.dataset.url) URL.revokeObjectURL(player.dataset.url);
  player.dataset.url = URL.createObjectURL(blob);
  player.src = player.dataset.url;
  player.hidden = false;
  submit(blob, recordingName(new Date(), r.mime), 'mic');
}

$('rec').addEventListener('click', () => { if (rec) rec.recorder.stop(); else startRecording(); });

// ---------------------------------------------------------------- start

render(null);
loadStatus();
loadHistory();
setInterval(loadStatus, 4000);
