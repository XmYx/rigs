// Live Video page: connection status + ComfyUI URL, prompt and pickers, Start/Stop live, a double-buffered
// player that plays clips back to back as the server pushes them (SSE), generation progress and the
// recent-clips strip. Every URL is relative: the App Cloud serves this under /api/nodes/<node>/apps/live-video/.
const $ = (s) => document.querySelector(s);
const el = (tag, attrs = {}, ...kids) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') e.className = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (v != null) e.setAttribute(k, v);
  }
  for (const k of kids.flat()) if (k != null) e.append(k);
  return e;
};

const state = { status: null, templates: [], live: null, startImage: null, progress: null, playingId: null, seenClips: new Set() };

async function api(path, { method = 'GET', body, headers } = {}) {
  const raw = body instanceof Blob;
  const r = await fetch(path, { method, headers: body !== undefined && !raw ? { 'content-type': 'application/json' } : headers, body: body === undefined || raw ? body : JSON.stringify(body) });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) { const e = new Error(data.error || `HTTP ${r.status}`); e.status = r.status; e.details = data.details; throw e; }
  return data;
}

// ---- Player: two <video>s; the hidden one preloads the next clip, swapped in on 'ended' ----------------
const player = {
  els: [$('#video-a'), $('#video-b')],
  cur: 0,
  queue: [],       // clips waiting to play
  next: null,      // clip preloaded in the hidden element
  current: null,   // clip on screen
  waiting: true,   // nothing to play: the next clip that arrives starts at once
  enqueue(clip) {
    this.queue.push(clip);
    // Stay close to live: if the tab fell behind, skip to the newest few clips.
    if (this.queue.length > 3) this.queue.splice(0, this.queue.length - 3);
    this.preload();
    if (this.waiting) this.swap();
  },
  preload() {
    if (this.next || !this.queue.length) return;
    this.next = this.queue.shift();
    const v = this.els[1 - this.cur];
    v.loop = false;
    v.src = this.next.url;
    v.load();
  },
  swap() {
    if (!this.next) { this.waiting = true; updateBuffering(); return; }
    const show = this.els[1 - this.cur];
    const hide = this.els[this.cur];
    const clip = this.next;
    this.next = null;
    this.waiting = false;
    show.currentTime = 0;
    const reveal = () => { show.classList.add('on'); hide.classList.remove('on'); hide.pause(); };
    show.addEventListener('playing', reveal, { once: true });
    show.play().catch(() => reveal());
    this.cur = 1 - this.cur;
    this.current = clip;
    show.loop = !isLive(); // idle: keep looping what is on screen
    state.playingId = clip.id;
    $('#stage-empty').hidden = true;
    renderStageInfo();
    markPlaying();
    updateBuffering();
    this.preload();
  },
  /** Play one clip now (from the strip), dropping what was queued. */
  playNow(clip) {
    this.queue = [clip];
    this.next = null;
    this.preload();
    this.swap();
  },
  setLoop(on) { this.els[this.cur].loop = on; },
};
for (const [i, v] of player.els.entries()) {
  v.addEventListener('ended', () => { if (i === player.cur) player.swap(); });
}

const isLive = () => ['starting', 'running'].includes(state.live?.status);

function updateBuffering() {
  $('#buffering').hidden = !(isLive() && player.waiting && player.current);
}

function renderStageInfo() {
  const c = player.current;
  $('#stage-info').textContent = c ? `#${c.index + 1} · ${c.width}×${c.height} · ${c.duration.toFixed(1)} s` : '';
}

// ---- Connection + templates ------------------------------------------------------------------------------
async function refreshStatus(force = false) {
  let s;
  try { s = await api('api/status' + (force ? '?refresh=1' : '')); }
  catch { setConn('bad', 'Applet server unreachable'); return; }
  state.status = s;
  state.templates = s.templates;
  const c = s.connection;
  if (c.ok) {
    const gpu = c.devices?.[0];
    const name = gpu ? ' · ' + gpu.name.replace(/^cuda:\d+\s*/, '').replace(/\s*:\s*cudaMallocAsync$/, '') : '';
    const vram = gpu?.vramTotal ? ` · ${(gpu.vramFree / 2 ** 30).toFixed(1)}/${(gpu.vramTotal / 2 ** 30).toFixed(0)} GB free` : '';
    setConn('ok', `ComfyUI ${c.version || ''}${name}${vram}`);
  } else setConn(s.settings.comfyUrl ? 'bad' : 'warn', c.error || 'Not connected');
  const url = $('#comfy-url');
  if (document.activeElement !== url) url.value = s.settings.comfyUrl || '';
  $('#url-source').textContent = { saved: 'Saved in the applet settings', detected: 'Detected on this machine', none: 'Enter the address of your ComfyUI' }[s.settings.source] || '';
  renderTemplates();
  if (s.live) applyLive(s.live);
}

function setConn(kind, text) {
  $('#conn-dot').className = 'dot ' + kind;
  $('#conn-text').textContent = text;
  $('#conn-text').title = text;
}

const form = () => ({ template: $('#template').value, resolution: $('#resolution').value, seconds: Number($('#length').value), mode: $('#mode').value });

function renderTemplates() {
  const sel = $('#template');
  const saved = loadForm();
  const prev = sel.value || saved.template;
  const t2v = state.templates.filter((t) => t.kind === 't2v');
  sel.replaceChildren(...t2v.map((t) => el('option', { value: t.id }, (t.check && !t.check.ok ? '⚠ ' : '') + t.label)));
  if (t2v.some((t) => t.id === prev)) sel.value = prev;
  renderPickers(saved);
}

function currentTemplate() { return state.templates.find((t) => t.id === $('#template').value); }

function renderPickers(saved = {}) {
  const t = currentTemplate();
  if (!t) return;
  const res = $('#resolution');
  const prevRes = res.value || saved.resolution;
  res.replaceChildren(...t.resolutions.map(([w, h]) => el('option', { value: `${w}x${h}` }, `${w}×${h}`)));
  res.value = t.resolutions.some(([w, h]) => `${w}x${h}` === prevRes) ? prevRes : `${t.defaults.width}x${t.defaults.height}`;
  const len = $('#length');
  const prevLen = len.value || saved.seconds;
  const maxS = Math.floor(t.limits.maxFrames / t.defaults.fps);
  const opts = [1, 2, 3, 4, 5, 6, 8, 10].filter((s) => s <= maxS);
  len.replaceChildren(...opts.map((s) => el('option', { value: s }, `${s} s`)));
  len.value = opts.includes(Number(prevLen)) ? prevLen : t.defaults.seconds;
  const chain = $('#mode').querySelector('option[value=chain]');
  chain.disabled = !t.i2v;
  chain.textContent = t.i2v ? 'Continuous (last frame → next)' : 'Continuous (needs image-to-video)';
  if (saved.mode && $('#mode').querySelector(`option[value=${saved.mode}]:not([disabled])`)) $('#mode').value = saved.mode;
  if ($('#mode').value === 'chain' && !t.i2v) $('#mode').value = 'drift';
  $('#image-btn').disabled = !t.i2v || isLive();
  $('#image-btn').title = t.i2v ? 'Start from an image (image-to-video)' : `${t.label} has no image-to-video`;
  if (!t.i2v && state.startImage) { state.startImage = null; renderImageChip(); }
  renderPromptHint();
  renderMissing();
}

function renderPromptHint() {
  $('#prompt-hint').textContent = { loop: 'a new take every clip', drift: 'one line per clip, cycling', chain: 'one line per clip, each continues the last' }[$('#mode').value] || '';
}

/** What ComfyUI lacks for the chosen template (and its image-to-video partner when it will be used). */
function renderMissing() {
  const box = $('#missing');
  const t = currentTemplate();
  const ids = [t?.id, ...(t?.i2v && ($('#mode').value === 'chain' || state.startImage) ? [t.i2v] : [])];
  const checks = ids.map((id) => state.templates.find((x) => x.id === id)).filter((x) => x?.check && !x.check.ok);
  box.hidden = !checks.length;
  if (!checks.length) return;
  const items = [];
  const seen = new Set();
  for (const x of checks) {
    for (const n of x.check.missingNodes) {
      if (seen.has(n.classType)) continue;
      seen.add(n.classType);
      items.push(el('div', { class: 'item' }, el('span', { class: 'file' }, n.classType), el('span', {}, 'node not installed: update ComfyUI or add the custom node that provides it')));
    }
    for (const m of x.check.missingModels) {
      if (seen.has(m.want)) continue;
      seen.add(m.want);
      const pick = m.available.length ? el('select', { onchange: (e) => useModel(x.family, m.slot, e.target.value) }, el('option', { value: '' }, '…or use an installed file'), ...m.available.slice(0, 200).map((f) => el('option', { value: f }, f))) : null;
      items.push(el('div', { class: 'item' },
        el('span', { class: 'file' }, m.want),
        el('span', {}, `not in models/${m.dir || '…'}/ · `, m.url ? el('a', { href: m.url, target: '_blank', rel: 'noopener' }, 'download') : null),
        pick));
    }
    for (const b of x.check.badValues || []) items.push(el('div', { class: 'item' }, el('span', { class: 'file' }, `${b.classType}.${b.input} = ${b.want}`), el('span', {}, 'option not offered by this ComfyUI')));
  }
  box.replaceChildren(el('h3', {}, 'ComfyUI lacks what this model needs. Nothing is queued (or downloaded) until it is there:'), ...items);
}

async function useModel(family, slot, file) {
  if (!file) return;
  try {
    await api('api/settings', { method: 'PUT', body: { models: { [family]: { [slot]: file } } } });
    await refreshStatus(true);
  } catch (e) { showNotice(e.message, 'error'); }
}

// ---- Live state from the server -------------------------------------------------------------------------------
function applyLive(live) {
  state.live = live;
  const on = isLive();
  const btn = $('#start-btn');
  btn.textContent = live.status === 'stopping' ? 'Stopping…' : on ? '■ Stop live' : '▶ Start live';
  btn.classList.toggle('stop', on);
  btn.disabled = live.status === 'stopping';
  for (const id of ['#template', '#resolution', '#length', '#comfy-url', '#connect-btn']) $(id).disabled = on;
  $('#image-btn').disabled = on || !currentTemplate()?.i2v;
  $('#stage-badge').hidden = !on;
  player.setLoop(!on);
  if (live.status === 'error' && live.error) showNotice(live.error, 'error');
  else if (live.notice) showNotice(live.notice.text, live.notice.level);
  renderClips(live.clips || []);
  // On load (or reconnect) with nothing playing: show the newest clip.
  if (!player.current && live.clips?.length && !on) player.enqueue(live.clips.at(-1));
  renderProgress();
  updateBuffering();
}

function renderProgress() {
  const live = state.live;
  const bar = $('#progress-bar');
  const txt = $('#progress-text');
  if (!live || !isLive()) {
    bar.style.width = '0';
    const n = live?.clips?.length || 0;
    txt.textContent = live?.status === 'error' ? 'Stopped' : n ? `Idle · ${n} recent clip${n === 1 ? '' : 's'}` : 'Idle';
    return;
  }
  const s = live.session || {};
  const pend = live.pending || [];
  const active = pend.find((p) => p.started) || pend[0];
  const pr = state.progress && active && state.progress.promptId === active.promptId ? state.progress : active?.progress;
  bar.style.width = `${Math.round((pr?.max ? pr.value / pr.max : 0) * 100)}%`;
  if (live.status === 'starting') { txt.textContent = 'Starting: checking ComfyUI and asking for VRAM…'; return; }
  const parts = [];
  if (active) parts.push(`Generating clip ${active.index + 1}${pr?.max ? ` · step ${pr.value}/${pr.max}` : active.started ? '' : ' · in ComfyUI queue'}`);
  else parts.push('Buffered ahead, waiting for playback');
  const queued = pend.length - (active ? 1 : 0);
  if (queued > 0) parts.push(`${queued} queued`);
  const last = (live.clips || []).filter((c) => c.session === s.id).at(-1);
  if (last) parts.push(`${(last.genMs / 1000).toFixed(1)} s per ${s.duration.toFixed(1)} s clip`);
  txt.textContent = parts.join(' · ');
}

function renderClips(clips) {
  const strip = $('#clips');
  const list = [...clips].reverse();
  $('#clips-count').textContent = clips.length ? `${clips.length}` : '';
  const key = list.map((c) => c.id).join(',');
  if (strip.dataset.key === key) return markPlaying();
  strip.dataset.key = key;
  const videoThumb = (c) => el('video', { class: 'thumb', src: c.url, muted: '', preload: 'metadata' });
  strip.replaceChildren(...list.map((c) => el('button', { class: 'clip', role: 'listitem', 'data-id': c.id, title: c.prompt, onclick: () => player.playNow(c) },
    c.poster ? el('img', { class: 'thumb', src: c.poster, alt: '', loading: 'lazy', onerror: (e) => e.target.replaceWith(videoThumb(c)) }) : videoThumb(c),
    el('span', { class: 'meta' }, el('b', {}, `#${c.index + 1}`), ` · ${c.duration.toFixed(1)} s · ${new Date(c.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`))));
  markPlaying();
}

function markPlaying() {
  for (const b of document.querySelectorAll('.clip')) b.classList.toggle('playing', b.dataset.id === state.playingId);
}

let noticeTimer = null;
function showNotice(text, level = 'info') {
  const n = $('#notice');
  clearTimeout(noticeTimer);
  n.hidden = !text;
  if (!text) return;
  n.textContent = text;
  n.className = 'notice ' + (level === 'info' ? '' : level);
  if (level === 'info') noticeTimer = setTimeout(() => { n.hidden = true; }, 6000);
}

// ---- Server-sent events ---------------------------------------------------------------------------------------
function connectEvents() {
  const es = new EventSource('api/events');
  es.addEventListener('state', (e) => applyLive(JSON.parse(e.data)));
  es.addEventListener('progress', (e) => { state.progress = JSON.parse(e.data); renderProgress(); });
  es.addEventListener('clip', (e) => {
    const clip = JSON.parse(e.data);
    if (state.seenClips.has(clip.id)) return;
    state.seenClips.add(clip.id);
    if (isLive()) player.enqueue(clip);
  });
  es.addEventListener('notice', (e) => { const n = JSON.parse(e.data); if (n) showNotice(n.text, n.level); });
  es.onerror = () => setConn('warn', 'Reconnecting to the applet server…');
  es.onopen = () => refreshStatus();
}

// ---- Actions ----------------------------------------------------------------------------------------------------
async function startStop() {
  if (isLive()) {
    $('#start-btn').disabled = true;
    try { await api('api/live/stop', { method: 'POST' }); } catch (e) { showNotice(e.message, 'error'); }
    return;
  }
  const prompt = $('#prompt').value.trim();
  if (!prompt) { showNotice('Write a prompt first', 'warn'); $('#prompt').focus(); return; }
  saveForm();
  $('#start-btn').disabled = true;
  try {
    for (const c of state.live?.clips || []) state.seenClips.add(c.id);
    player.queue = [];
    player.next = null;
    player.waiting = true;
    await api('api/live/start', { method: 'POST', body: { ...form(), prompt, image: state.startImage?.name || null } });
  } catch (e) {
    if (e.status === 409 && e.details) await refreshStatus(true);
    showNotice(e.message, 'error');
  } finally {
    $('#start-btn').disabled = false;
  }
}

// While live, prompt and mode edits steer the clips that are not queued yet.
let updateTimer = null;
function liveUpdate(body) {
  if (!isLive()) return;
  clearTimeout(updateTimer);
  updateTimer = setTimeout(async () => {
    try { await api('api/live/update', { method: 'POST', body }); showNotice('Updated: applies from the next clip'); }
    catch (e) { showNotice(e.message, 'error'); }
  }, 700);
}

async function saveUrl(e) {
  e.preventDefault();
  $('#connect-btn').disabled = true;
  try {
    await api('api/settings', { method: 'PUT', body: { comfyUrl: $('#comfy-url').value.trim() } });
    setConn('warn', 'Connecting…');
    await refreshStatus(true);
  } catch (err) { showNotice(err.message, 'error'); }
  finally { $('#connect-btn').disabled = false; }
}

async function pickImage(file) {
  if (!file) return;
  try {
    const r = await api('api/image', { method: 'POST', body: file, headers: { 'content-type': file.type } });
    state.startImage = { name: r.name, label: file.name };
  } catch (e) { showNotice(e.message, 'error'); state.startImage = null; }
  renderImageChip();
  renderMissing();
}

function renderImageChip() {
  const chip = $('#image-chip');
  chip.hidden = !state.startImage;
  if (state.startImage) chip.replaceChildren(`🖼 ${state.startImage.label}`, el('button', { type: 'button', title: 'Remove', onclick: () => { state.startImage = null; renderImageChip(); renderMissing(); } }, '✕'));
}

// ---- Settings dialog --------------------------------------------------------------------------------------------
async function openSettings() {
  const s = await api('api/settings').catch(() => null);
  if (!s) return;
  $('#set-url').value = s.savedUrl || '';
  $('#set-url').placeholder = s.detectedUrl || 'http://127.0.0.1:8188';
  $('#set-url-hint').textContent = s.detectedUrl ? `Empty = the ComfyUI detected on this machine (${s.detectedUrl})` : 'No ComfyUI detected on this machine';
  $('#set-header').value = s.authHeader || 'Authorization';
  $('#set-token').value = '';
  $('#set-token').placeholder = s.authTokenSet ? `•••• saved (${s.authTokenLength} characters), type to replace` : 'none';
  $('#set-clear-token').checked = false;
  $('#set-clear-token').parentElement.hidden = !s.authTokenSet;
  $('#set-overseer').value = s.overseer?.mode || 'auto';
  $('#set-error').hidden = true;
  $('#settings').showModal();
}

async function saveSettings(e) {
  e.preventDefault();
  const body = { comfyUrl: $('#set-url').value.trim(), authHeader: $('#set-header').value.trim(), overseer: { mode: $('#set-overseer').value } };
  if ($('#set-clear-token').checked) body.authToken = '';
  else if ($('#set-token').value) body.authToken = $('#set-token').value;
  try {
    await api('api/settings', { method: 'PUT', body });
    $('#settings').close();
    setConn('warn', 'Connecting…');
    await refreshStatus(true);
  } catch (err) {
    $('#set-error').textContent = err.message;
    $('#set-error').hidden = false;
  }
}

// ---- Remember the form between visits ----------------------------------------------------------------------------
function loadForm() { try { return JSON.parse(localStorage.getItem('lv.form') || '{}'); } catch { return {}; } }
function saveForm() { try { localStorage.setItem('lv.form', JSON.stringify({ ...form(), prompt: $('#prompt').value })); } catch {} }

// ---- Wire up ------------------------------------------------------------------------------------------------------
$('#start-btn').addEventListener('click', startStop);
$('#url-form').addEventListener('submit', saveUrl);
$('#template').addEventListener('change', () => { renderPickers(); saveForm(); });
$('#resolution').addEventListener('change', saveForm);
$('#length').addEventListener('change', saveForm);
$('#mode').addEventListener('change', () => { renderPromptHint(); renderMissing(); saveForm(); liveUpdate({ mode: $('#mode').value }); });
$('#prompt').addEventListener('input', () => liveUpdate({ prompt: $('#prompt').value }));
$('#prompt').addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); if (!isLive()) startStop(); } });
$('#image-btn').addEventListener('click', () => $('#image-input').click());
$('#image-input').addEventListener('change', (e) => { pickImage(e.target.files[0]); e.target.value = ''; });
$('#settings-btn').addEventListener('click', openSettings);
$('#settings-form').addEventListener('submit', saveSettings);
$('#set-cancel').addEventListener('click', () => $('#settings').close());

const saved = loadForm();
if (saved.prompt) $('#prompt').value = saved.prompt;
refreshStatus().then(connectEvents);
setInterval(() => { if (!document.hidden) refreshStatus(); }, 20000);

// For screenshots and debugging.
window.__lv = { state, player, refreshStatus };
