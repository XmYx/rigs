// Server-side text-to-speech. Browsers block speechSynthesis outside a user gesture (Safari most
// strictly), so the UI fetches WAV audio from here, and JARVIS can talk through this machine's
// speakers when no UI is open. Engines: macOS `say`, Windows SAPI (System.Speech via PowerShell),
// Linux piper (persona.voice = path to an .onnx model) or espeak-ng / espeak.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { config } from './config.js';
import { expandHome, isMac, isWin, run, which } from './util.js';

const PREFERRED = ['Daniel', 'Oliver', 'Arthur', 'Microsoft George', 'Microsoft Ryan', 'Microsoft David'];
const MAX_CHARS = 4000;

// PowerShell scripts read everything from env vars, so no user text is ever quoted into a command line.
const PS_PREAMBLE = 'Add-Type -AssemblyName System.Speech; $s = New-Object System.Speech.Synthesis.SpeechSynthesizer; if ($env:RIGS_TTS_VOICE) { try { $s.SelectVoice($env:RIGS_TTS_VOICE) } catch {} }; $t = [IO.File]::ReadAllText($env:RIGS_TTS_IN);';
const PS_TO_WAV = PS_PREAMBLE + ' $s.SetOutputToWaveFile($env:RIGS_TTS_OUT); $s.Speak($t); $s.Dispose()';
const PS_ALOUD = PS_PREAMBLE + ' $s.SetOutputToDefaultAudioDevice(); $s.Speak($t); $s.Dispose()';
const PS_VOICES = 'Add-Type -AssemblyName System.Speech; (New-Object System.Speech.Synthesis.SpeechSynthesizer).GetInstalledVoices() | ForEach-Object { $_.VoiceInfo.Name + \'|\' + $_.VoiceInfo.Culture.Name }';

function powershell() { return which('powershell') || which('pwsh') || 'powershell'; }

function piperModel() {
  const v = config().persona?.voice || '';
  return /\.onnx$/i.test(v) ? expandHome(v) : null;
}

/** Which engine this machine uses, or null when it has none. */
export function engine() {
  if (isMac) return which('say') ? 'say' : null;
  if (isWin) return 'sapi';
  if (piperModel() && which('piper')) return 'piper';
  if (which('espeak-ng')) return 'espeak-ng';
  if (which('espeak')) return 'espeak';
  return null;
}

let voiceCache = null;

/** Installed voices: [{ name, lang }]. Cached for the life of the process. */
export async function voices() {
  if (voiceCache) return voiceCache;
  const e = engine();
  let list = [];
  if (e === 'say') {
    const r = await run('say', ['-v', '?'], { timeout: 10000 });
    for (const line of r.stdout.split('\n')) {
      const m = line.match(/^(.+?)\s{2,}([a-z]{2,3}_[A-Za-z0-9]+)\s/);
      if (m) list.push({ name: m[1].trim(), lang: m[2].replace('_', '-') });
    }
  } else if (e === 'sapi') {
    const r = await run(powershell(), ['-NoProfile', '-NonInteractive', '-Command', PS_VOICES], { timeout: 20000 });
    for (const line of r.stdout.split(/\r?\n/)) {
      const [name, lang] = line.trim().split('|');
      if (name) list.push({ name, lang: lang || '' });
    }
  } else if (e === 'piper') {
    list = [{ name: path.basename(piperModel(), '.onnx'), lang: '' }];
  } else if (e) {
    const r = await run(e, ['--voices'], { timeout: 10000 });
    for (const line of r.stdout.split('\n').slice(1)) {
      const cols = line.trim().split(/\s+/);
      if (cols.length >= 4 && cols[1]) list.push({ name: cols[1], lang: cols[1] });
    }
  }
  voiceCache = list;
  return list;
}

/** Requested voice → persona.voice → a preferred British-ish voice → the engine default (''). */
export async function pickVoice(requested) {
  const list = await voices();
  const names = list.map((v) => v.name);
  const has = (n) => n && names.includes(n);
  if (has(requested)) return requested;
  const persona = config().persona?.voice;
  if (has(persona)) return persona;
  for (const p of PREFERRED) {
    const hit = names.find((n) => n === p || n.startsWith(p + ' '));
    if (hit) return hit;
  }
  return '';
}

/** Plain speakable text: no code blocks, markdown or link targets; capped in length. */
export function speakable(text) {
  let s = String(text ?? '');
  s = s.replace(/```[\s\S]*?(```|$)/g, ' ');
  s = s.replace(/`([^`]*)`/g, '$1');
  s = s.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1');
  s = s.replace(/^\s{0,3}(#{1,6}|>|[-*+]|\d+\.)\s+/gm, '');
  s = s.replace(/[*_~#>|]/g, '');
  s = s.replace(/https?:\/\/\S+/g, 'a link');
  s = s.replace(/\s+/g, ' ').trim();
  return s.length > MAX_CHARS ? s.slice(0, MAX_CHARS) : s;
}

async function withTemp(fn) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'rigs-tts-'));
  try { return await fn(dir); } finally { await fsp.rm(dir, { recursive: true, force: true }).catch(() => {}); }
}

async function renderWav(e, text, voice, inFile, outFile) {
  await fsp.writeFile(inFile, text, 'utf8');
  let r;
  if (e === 'say') {
    r = await run('say', [...(voice ? ['-v', voice] : []), '-o', outFile, '--file-format=WAVE', '--data-format=LEI16@22050', '-f', inFile], { timeout: 60000 });
  } else if (e === 'sapi') {
    r = await run(powershell(), ['-NoProfile', '-NonInteractive', '-Command', PS_TO_WAV], { timeout: 60000, env: { ...process.env, RIGS_TTS_IN: inFile, RIGS_TTS_OUT: outFile, RIGS_TTS_VOICE: voice || '' } });
  } else if (e === 'piper') {
    r = await run('piper', ['--model', piperModel(), '--output_file', outFile], { timeout: 60000, input: text });
  } else {
    r = await run(e, [...(voice ? ['-v', voice] : []), '-w', outFile, '-f', inFile], { timeout: 60000 });
  }
  if (!fs.existsSync(outFile)) throw new Error(`tts (${e}) failed: ${(r.stderr || '').trim().slice(0, 300) || 'no audio'}`);
}

/** Render text to a WAV Buffer, or null when there is nothing to say. */
export async function synthesize(text, voice) {
  const e = engine();
  if (!e) throw new Error('no text-to-speech engine on this machine (install espeak-ng or piper)');
  const t = speakable(text);
  if (!t) return null;
  const v = await pickVoice(voice);
  return withTemp(async (dir) => {
    const out = path.join(dir, 'out.wav');
    await renderWav(e, t, v, path.join(dir, 'in.txt'), out);
    return fsp.readFile(out);
  });
}

function player() {
  if (which('paplay')) return 'paplay';
  if (which('aplay')) return 'aplay';
  if (which('pw-play')) return 'pw-play';
  return null;
}

async function speakNow(text, voice) {
  const e = engine();
  if (!e) throw new Error('no text-to-speech engine on this machine');
  const t = speakable(text);
  if (!t) return { ok: true, spoken: false };
  const v = await pickVoice(voice);
  return withTemp(async (dir) => {
    const inFile = path.join(dir, 'in.txt');
    await fsp.writeFile(inFile, t, 'utf8');
    if (e === 'say') await run('say', [...(v ? ['-v', v] : []), '-f', inFile], { timeout: 5 * 60000 });
    else if (e === 'sapi') await run(powershell(), ['-NoProfile', '-NonInteractive', '-Command', PS_ALOUD], { timeout: 5 * 60000, env: { ...process.env, RIGS_TTS_IN: inFile, RIGS_TTS_VOICE: v || '' } });
    else if (e === 'piper') {
      const p = player();
      if (!p) throw new Error('piper needs paplay or aplay to play audio');
      const out = path.join(dir, 'out.wav');
      await renderWav(e, t, v, inFile, out);
      await run(p, [out], { timeout: 5 * 60000 });
    } else await run(e, [...(v ? ['-v', v] : []), '-f', inFile], { timeout: 5 * 60000 });
    return { ok: true, spoken: true, engine: e, voice: v };
  });
}

let chain = Promise.resolve();

/** Speak through this machine's speakers. Calls are queued so they never talk over each other. */
export function speakAloud(text, voice) {
  const p = chain.then(() => speakNow(text, voice));
  chain = p.catch(() => {});
  return p;
}

export async function info() {
  const e = engine();
  return { engine: e, voice: e ? await pickVoice() : '', voices: e ? await voices() : [] };
}
