#!/usr/bin/env node
// Media player check (ui/src/media-player.js, Range in src/files.js): two throwaway `rigs serve` nodes — "front" (the UI)
// and "media-peer" (a mesh peer it relays to) — each with a folder of ffmpeg-made media (a 45 s H.264/AAC mp4, two mp3s
// and a broken mkv). HTTP: Range → 206 + Content-Range locally and through /api/nodes/media-peer, 416 past the end.
// Browser (Google Chrome through Playwright, for H.264; RIGS_CHROME_CHANNEL to change), desktop 1440x900 and phone 390x844:
// the file browser's inline <video>/<audio>, double-click → the player, seeking, keys (5, m, >, <, →, Shift+N), the
// playlist, audio carrying on in the tray mini-player after the window closes (next skips video), reopening it, one
// element at a time (an inline preview pauses the player), the unplayable-file message + download, and a video from the
// peer opened through ui_open. Screenshots of the video seeked, the audio player and the mini-player.
//   node scripts/media-player-check.js [--out screenshots/media-player]
//   … --peer http://<machine>:<port> --peer-dir <folder with clip.mp4> --token <its mesh token>: a real remote node as the peer
import { execFileSync, spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
let chromium = null;
for (const d of [process.env.RIGS_AUDIT_TOOLS, path.join(os.homedir(), '.cache/rigs-audit'), ROOT].filter(Boolean)) { try { ({ chromium } = createRequire(path.join(path.resolve(d), 'x.js'))('playwright')); break; } catch { /* next */ } }
if (!chromium) { console.error('playwright not found: install it outside the repo and set RIGS_AUDIT_TOOLS=<dir>'); process.exit(2); }
const OUT = path.resolve(opt('out', path.join(ROOT, 'screenshots/media-player')));
fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PEER_URL = opt('peer', '');
const TOKEN = opt('token', `media-check-${process.pid}`);

const freePort = () => new Promise((resolve, reject) => { const s = net.createServer(); s.once('error', reject); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }); });

/** The media every node serves: made once with ffmpeg and cached in the temp folder. */
function media() {
  const dir = path.join(os.tmpdir(), 'rigs-media-check-v1');
  const ff = (out, a) => { if (!fs.existsSync(path.join(dir, out))) execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...a, path.join(dir, out)]); };
  fs.mkdirSync(dir, { recursive: true });
  ff('clip.mp4', ['-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=30:duration=45', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=45',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-preset', 'veryfast', '-crf', '30', '-c:a', 'aac', '-b:a', '96k', '-movflags', '+faststart', '-shortest']);
  ff('song.mp3', ['-f', 'lavfi', '-i', 'sine=frequency=330:duration=40', '-c:a', 'libmp3lame', '-b:a', '128k']);
  ff('02 second.mp3', ['-f', 'lavfi', '-i', 'sine=frequency=523:duration=30', '-c:a', 'libmp3lame', '-b:a', '128k']);
  fs.writeFileSync(path.join(dir, 'zz-broken.mkv'), Buffer.alloc(64 * 1024, 7));
  return dir;
}

async function startNode(name, extraEnv = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), `rigs-mp-${name}-`));
  const port = await freePort();
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ port, openrig: { registerPeers: false } }));
  fs.cpSync(media(), path.join(home, 'media'), { recursive: true });
  const env = { ...process.env, RIGS_HOME: home, RIGS_PORT: String(port), RIGS_NAME: name, RIGS_SSH_DIR: path.join(home, 'ssh'), RIGS_NO_MIGRATIONS: '1', RIGS_NO_AUTOUPDATE: '1', RIGS_NO_OPENRIG: '1', RIGS_PEERS: '', RIGS_MESH_TOKEN: TOKEN, RIGS_BIND: '127.0.0.1', ...extraEnv };
  const child = spawn(process.execPath, ['bin/rigs.js', 'serve'], { cwd: ROOT, stdio: 'ignore', env });
  const url = `http://127.0.0.1:${port}/`;
  for (let i = 0; i < 60; i++) {
    await sleep(500);
    try { if ((await fetch(url + 'api/self')).ok) return { url, home, port, dir: path.join(home, 'media'), stop: () => { child.kill(); fs.rmSync(home, { recursive: true, force: true }); } }; } catch { /* wait */ }
  }
  child.kill();
  throw new Error(`${name} did not come up`);
}

// The peer: a second local node, or (--peer) a node already running on another machine of the mesh.
const peer = PEER_URL
  ? { url: PEER_URL.replace(/\/?$/, '/'), dir: opt('peer-dir', '/tmp/rigs-media-range-check/media'), stop: () => {} }
  : await startNode('media-peer');
peer.name = PEER_URL ? (await (await fetch(peer.url + 'api/self')).json()).name : 'media-peer';
const front = await startNode('front', { RIGS_PEERS: peer.url.replace(/\/$/, '') });
for (let i = 0; i < 60; i++) {
  const nodes = await (await fetch(front.url + 'api/mesh/refresh', { method: 'POST' })).json().catch(() => []);
  if (nodes.some((n) => n.name === peer.name && n.online && n.rigs)) break;
  await sleep(500);
}
const results = [];
const check = (name, ok, extra = '') => { results.push(!!ok); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${extra ? ' — ' + extra : ''}`); };
const errors = [];

// ------------------------------------------------------------------ HTTP: Range locally and through the peer
async function httpChecks() {
  const size = fs.statSync(path.join(front.dir, 'clip.mp4')).size;
  for (const [label, base, dir] of [['local', `${front.url}api/local/files/raw`, front.dir], ['peer', `${front.url}api/nodes/${peer.name}/files/raw`, peer.dir]]) {
    const u = `${base}?path=${encodeURIComponent(path.join(dir, 'clip.mp4'))}`;
    const r = await fetch(u, { headers: { range: 'bytes=0-1023' } });
    const body = Buffer.from(await r.arrayBuffer());
    check(`${label}: Range bytes=0-1023 → 206 + Content-Range`, r.status === 206 && r.headers.get('content-range') === `bytes 0-1023/${size}` && body.length === 1024 && r.headers.get('content-type') === 'video/mp4',
      `${r.status} ${r.headers.get('content-range')} ${r.headers.get('content-type')}`);
    const bad = await fetch(u, { headers: { range: `bytes=${size}-` } });
    await bad.arrayBuffer();
    check(`${label}: a range past the end → 416`, bad.status === 416 && bad.headers.get('content-range') === `bytes */${size}`);
  }
}

// ------------------------------------------------------------------ browser
const browser = await chromium.launch({ channel: process.env.RIGS_CHROME_CHANNEL || 'chrome', args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'] });

async function uiOpen(body) {
  const r = await fetch(new URL('api/mesh/ui/open', front.url), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ view: 'files', ...body }) });
  return r.json();
}
const shot = async (page, name) => { await page.addStyleTag({ content: '#toasts{display:none!important}' }); await sleep(300); await page.screenshot({ path: path.join(OUT, name) }); };
const row = (page, name) => page.locator('.files-win .file-row', { has: page.locator('.fn', { hasText: new RegExp(`^${name.replace(/[.()]/g, '\\$&')}$`) }) });
const mp = (page) => page.locator('.mp-win');
/** The player's media element: { kind, t, paused, muted, rate, src, ready } */
const media$ = (page) => page.evaluate(() => {
  const el = document.querySelector('.mp-win video.mp-video') || document.querySelector('#media-host audio');
  return el ? { kind: el.tagName.toLowerCase(), t: el.currentTime, paused: el.paused, muted: el.muted, rate: el.playbackRate, src: el.currentSrc, ready: el.readyState, dur: el.duration } : null;
});
async function until(page, fn, what, ms = 15000) {
  const t0 = Date.now();
  let last;
  while (Date.now() - t0 < ms) { last = await media$(page); if (last && fn(last)) return last; await sleep(150); }
  throw new Error(`${what}: ${JSON.stringify(last)}`);
}
const playlistItem = (page, name) => mp(page).locator('.mp-item', { hasText: name });

async function run(label, vp) {
  const phone = label === 'phone';
  const ctx = await browser.newContext({ viewport: vp, hasTouch: phone, isMobile: phone, deviceScaleFactor: phone ? 2 : 1 });
  const page = await ctx.newPage();
  page.setDefaultTimeout(30000);
  page.on('pageerror', (e) => errors.push(`${label} pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error' && !/favicon|net::ERR|Failed to load resource/.test(m.text())) errors.push(`${label} console: ${m.text().slice(0, 200)}`); });
  const wsUp = new Promise((r) => page.on('websocket', (ws) => { if (new URL(ws.url()).pathname === '/ws') r(); }));
  await page.goto(front.url, { waitUntil: 'domcontentloaded', timeout: 120000 });
  await page.waitForSelector('#app-dock, #bar', { state: 'attached' });
  await Promise.race([wsUp, sleep(60000)]); // the /ws push socket is open (slow on a loaded machine)
  await sleep(1000);

  if (!phone) {
    // (a) the file browser's inline preview: <video> for mp4, <audio> for mp3, with Open in Player
    for (let i = 0; i < 20 && !(await uiOpen({ path: front.dir })).delivered; i++) await sleep(500); // until the UI's socket is up
    await row(page, 'clip.mp4').waitFor();
    await row(page, 'clip.mp4').click();
    await page.locator('.files-win .file-preview video.pv-video').waitFor();
    await row(page, 'song.mp3').click();
    await page.locator('.files-win .file-preview audio.pv-audio').waitFor();
    check(`${label}: file browser previews mp4 in <video> and mp3 in <audio>, with Open in Player`, await page.locator('.files-win .file-preview button', { hasText: 'Open in Player' }).count() === 1);

    // (b) double-click → the player plays the video; seek with 5 (50%), → (+5 s); m, >, <
    await row(page, 'clip.mp4').dblclick();
    await mp(page).waitFor();
    let m = await until(page, (x) => x.kind === 'video' && !x.paused && x.t > 0.5, 'video plays');
    check(`${label}: double-click opens the player and the mp4 plays`, true, `t=${m.t.toFixed(1)} dur=${m.dur}`);
    await mp(page).locator('.mp-seek').focus();
    await page.keyboard.press('5');
    m = await until(page, (x) => x.t >= 22 && x.t < 30 && !x.paused && x.ready >= 3, 'seek to 50%');
    await page.keyboard.press('ArrowRight');
    m = await until(page, (x) => x.t >= 27, 'ArrowRight +5 s');
    check(`${label}: seeking (5 → 50%, → +5 s) lands mid-file and keeps playing`, true, `t=${m.t.toFixed(1)}`);
    await page.keyboard.press('m');
    const muted = (await media$(page)).muted;
    await page.keyboard.press('m');
    await page.keyboard.press('>');
    const fast = (await media$(page)).rate;
    await page.keyboard.press('<');
    check(`${label}: m mutes and unmutes, > and < change the speed`, muted && !(await media$(page)).muted && fast === 1.25 && (await media$(page)).rate === 1);
    const buttons = await mp(page).evaluate((w) => ['.mp-full', '.mp-pip'].map((s) => !w.querySelector(s).hidden));
    check(`${label}: video has fullscreen${buttons[1] ? ' and picture-in-picture' : ''} buttons`, buttons[0], `pip ${buttons[1] ? 'available' : 'not offered by this browser'}`);
    const items = await mp(page).locator('.mp-item-name').allTextContents();
    check(`${label}: the playlist holds the folder's media in natural order`, JSON.stringify(items) === JSON.stringify(['02 second.mp3', 'clip.mp4', 'song.mp3', 'zz-broken.mkv']), items.join(' | '));
    await mp(page).locator('.mp-seek').focus();
    await page.keyboard.press('7');
    await until(page, (x) => x.t >= 31 && !x.paused && x.ready >= 3, 'seek 70%');
    await shot(page, `${label}-video-seeked.png`);

    // (c) Shift+N → the next track (song.mp3, audio): the video stops and audio plays with the art card
    await page.keyboard.press('Shift+N');
    m = await until(page, (x) => x.kind === 'audio' && !x.paused && x.t > 0.3 && /song\.mp3/.test(decodeURIComponent(x.src)), 'next → song.mp3');
    check(`${label}: Shift+N goes to song.mp3, the video element is gone`, !(await page.locator('.mp-win video').count()));
    await mp(page).locator('.mp-seek').focus();
    await page.keyboard.press('3');
    await until(page, (x) => x.t >= 11, 'audio seek');
    await shot(page, `${label}-audio-player.png`);

    // (d) the unplayable mkv: a clear message and a download link
    await playlistItem(page, 'zz-broken.mkv').click();
    await mp(page).locator('.mp-error:not([hidden])').waitFor();
    const err = await mp(page).locator('.mp-error').textContent();
    const dl = await mp(page).locator('.mp-error a[download]').getAttribute('href');
    check(`${label}: an unplayable file shows why and offers the download`, /MKV/.test(err) && /download=1/.test(dl), err.replace(/\s+/g, ' ').slice(0, 120));

    // (e) close the window while audio plays → the tray mini-player; it keeps playing; next skips the video
    await playlistItem(page, '02 second.mp3').click();
    await until(page, (x) => x.kind === 'audio' && !x.paused && x.t > 0.5 && /02%20second|02 second/.test(decodeURIComponent(x.src)), '02 second plays');
    await mp(page).locator('.win-btn.close').click();
    const mini = page.locator('#menubar [data-tray-item="media"]');
    await mini.waitFor();
    const t1 = (await media$(page)).t;
    await sleep(1500);
    m = await media$(page);
    check(`${label}: closing the window leaves the audio playing in the menu bar mini-player`, !m.paused && m.t > t1 + 0.8 && (await mini.locator('.tray-media-name').textContent()) === '02 second', `t ${t1.toFixed(1)} → ${m.t.toFixed(1)}`);
    await shot(page, `${label}-mini-player.png`);
    await mini.locator('.tray-media-next').click();
    m = await until(page, (x) => x.kind === 'audio' && !x.paused && /song\.mp3/.test(decodeURIComponent(x.src)), 'mini next → song.mp3');
    check(`${label}: the mini-player's next skips the video and plays song.mp3`, (await mini.locator('.tray-media-name').textContent()) === 'song');
    await mini.locator('.tray-media-play').click();
    m = await until(page, (x) => x.paused, 'mini pause');
    await mini.locator('.tray-media-play').click();
    m = await until(page, (x) => !x.paused, 'mini play');
    check(`${label}: the mini-player pauses and resumes`, true);

    // (f) its title reopens the player without restarting the track
    const before = (await media$(page)).t;
    await mini.locator('.tray-media-title').click();
    await mp(page).waitFor();
    m = await media$(page);
    check(`${label}: the mini-player's title reopens the player on the same track`, m.t >= before && !m.paused && !(await page.locator('#menubar [data-tray-item="media"]').count()));

    // (g) one at a time: playing an inline preview pauses the player
    await row(page, 'song.mp3').click();
    const pv = page.locator('.files-win .file-preview audio.pv-audio');
    await pv.waitFor();
    await pv.evaluate((el) => el.play());
    await until(page, (x) => x.paused, 'player paused by the preview');
    check(`${label}: starting an inline preview pauses the player (one element at a time)`, await pv.evaluate((el) => !el.paused));
    await pv.evaluate((el) => el.pause());

    // (h) a video on the peer, opened through ui_open (MCP): the player, not the file browser, from /api/nodes/<peer>
    let r = await uiOpen({ node: peer.name, path: path.join(peer.dir, 'clip.mp4') });
    for (let i = 0; i < 20 && /offline/.test(r.error || ''); i++) { // a loaded machine can miss a discovery round
      await fetch(front.url + 'api/mesh/refresh', { method: 'POST' }).catch(() => {});
      await sleep(1000);
      r = await uiOpen({ node: peer.name, path: path.join(peer.dir, 'clip.mp4') });
    }
    check(`${label}: ui_open on a peer's mp4 is delivered`, r.delivered >= 1 && r.select, JSON.stringify(r).slice(0, 160));
    m = await until(page, (x) => x.kind === 'video' && !x.paused && x.t > 0.3, 'peer video plays');
    await mp(page).locator('.mp-seek').focus();
    await page.keyboard.press('8');
    m = await until(page, (x) => x.t >= 36 && !x.paused && x.ready >= 3, 'peer seek 80%');
    const peerId = (await (await fetch(front.url + 'api/nodes')).json()).find((n) => n.name === peer.name).id;
    check(`${label}: ${peer.name}'s video plays and seeks through /api/nodes/<peer>/files/raw`, m.src.includes(`/api/nodes/${encodeURIComponent(peerId)}/files/raw`), `t=${m.t.toFixed(1)} src=${m.src.slice(0, 90)}`);
    await shot(page, `${label}-peer-video-seeked.png`);
    await mp(page).locator('.win-btn.close').click();
    await sleep(400);
    check(`${label}: closing a video window stops it (no mini-player)`, !(await media$(page)) && !(await page.locator('[data-tray-item="media"]').count()));
  } else {
    // phone: ui_open on the mp4 → the full-screen player; seek; the audio; the mini-player in the phone header
    for (let i = 0; i < 20 && !(await uiOpen({ path: path.join(front.dir, 'clip.mp4') })).delivered; i++) await sleep(500);
    await mp(page).waitFor();
    await until(page, (x) => x.kind === 'video' && !x.paused && x.t > 0.3, 'phone video plays');
    await mp(page).locator('.mp-seek').evaluate((el) => { el.value = '27'; el.dispatchEvent(new Event('input')); el.dispatchEvent(new Event('change')); });
    const m = await until(page, (x) => x.t >= 27 && !x.paused && x.ready >= 3, 'phone seek');
    check(`${label}: ui_open on an mp4 opens the player, the seek bar seeks`, true, `t=${m.t.toFixed(1)}`);
    await shot(page, `${label}-video-seeked.png`);
    await playlistItem(page, 'song.mp3').click();
    await until(page, (x) => x.kind === 'audio' && !x.paused && x.t > 0.3, 'phone audio');
    await shot(page, `${label}-audio-player.png`);
    await mp(page).locator('.win-btn.close').click();
    const mini = page.locator('.mp-mini-phone');
    await mini.waitFor();
    await sleep(1200);
    const box = await mini.boundingBox();
    const bar = await page.locator('#bar').boundingBox();
    check(`${label}: the now-playing strip shows above the toolbar and the audio plays on`, !(await media$(page)).paused && await mini.isVisible() && box.y + box.height <= bar.y && (await mini.locator('.tray-media-name').textContent()) === 'song', JSON.stringify({ box, bar }));
    await mini.locator('.tray-media-play').click();
    await until(page, (x) => x.paused, 'phone strip pause');
    await mini.locator('.tray-media-play').click();
    await until(page, (x) => !x.paused, 'phone strip play');
    await shot(page, `${label}-mini-player.png`);
  }
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
  check(`${label}: no sideways page overflow`, overflow <= 0, String(overflow));
  await ctx.close();
}

try {
  await httpChecks();
  await run('desktop', { width: 1440, height: 900 });
  await run('phone', { width: 390, height: 844 });
} catch (e) {
  check('run', false, e.stack || e.message);
  for (const c of browser.contexts()) for (const p of c.pages()) await p.screenshot({ path: path.join(OUT, 'failure.png') }).catch(() => {});
} finally {
  check('no console or page errors', !errors.length, errors.join(' | '));
  await browser.close();
  front.stop();
  peer.stop();
}
console.log(`\n${results.filter(Boolean).length}/${results.length} passed · screenshots in ${path.relative(ROOT, OUT)}/`);
process.exit(results.every(Boolean) ? 0 : 1);
