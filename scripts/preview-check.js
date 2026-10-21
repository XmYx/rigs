#!/usr/bin/env node
// Preview pane + Quick Look check (ui/src/finder-preview.js over preview-model.js). Two throwaway `rigs serve` nodes
// (`mac-a`, `linux-b`) whose homes hold real media made by ffmpeg (an mp4/webm clip, mp3/m4a, png, pdf, code, Markdown),
// opened in headless Chromium (Playwright from RIGS_AUDIT_TOOLS or ~/.cache/rigs-audit) at 1440x900 and 390x844.
// Checks: each viewer shows for its kind; audio plays, scrubs, changes volume and stops when the selection changes; a
// video seek is answered by a 206 (locally and through /api/nodes/<peer>/files/raw) without downloading the whole file;
// Space opens Quick Look, arrows step, Esc closes it and stops playback. Screenshots go to --out
// (default <shared>/reports/finder-preview). Needs ffmpeg.
//   node scripts/preview-check.js [--out dir]
import { spawn, spawnSync } from 'node:child_process';
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
const OUT = path.resolve(opt('out', path.join(os.homedir(), 'RIGS-Shared', 'reports', 'finder-preview')));
fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((resolve, reject) => { const s = net.createServer(); s.once('error', reject); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }); });
const TOKEN = 'preview-check-' + Math.random().toString(36).slice(2);

// ---------------------------------------------------------------- media
const MEDIA = path.join(os.tmpdir(), 'rigs-preview-media'); // kept between runs: ffmpeg is slow on a busy machine
fs.mkdirSync(MEDIA, { recursive: true });
function ff(a) { if (fs.existsSync(a.at(-1))) return; const r = spawnSync('ffmpeg', ['-y', '-loglevel', 'error', ...a], { stdio: 'inherit' }); if (r.status !== 0) throw new Error('ffmpeg failed: ' + a.join(' ')); }
const SRC = ['-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=24:duration=40', '-f', 'lavfi', '-i', 'sine=frequency=330:duration=40', '-vf', 'noise=alls=40:allf=t'];
ff([...SRC, '-c:v', 'libx264', '-b:v', '1200k', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-movflags', '+faststart', path.join(MEDIA, 'clip.mp4')]);
ff([...SRC, '-c:v', 'libvpx', '-b:v', '1200k', '-deadline', 'realtime', '-cpu-used', '8', '-c:a', 'libopus', path.join(MEDIA, 'clip.webm')]);
ff(['-f', 'lavfi', '-i', 'sine=frequency=440:duration=40', '-c:a', 'libmp3lame', path.join(MEDIA, 'tone.mp3')]);
ff(['-f', 'lavfi', '-i', 'sine=frequency=550:duration=40', '-c:a', 'aac', path.join(MEDIA, 'tone.m4a')]);
const PDF = '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 300 200]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj\n4 0 obj<</Length 44>>stream\nBT /F1 24 Tf 40 100 Td (RIGS preview) Tj ET\nendstream endobj\n5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n';
const CODE = '// the preview pane\nimport fs from \'node:fs\';\nconst limit = 2048; /* bytes */\nexport function size(path) {\n  if (!path) return null;\n  return fs.statSync(path).size + limit; // plus the cap\n}\nconst greeting = "hello, rigs";\n';
const MD = '# Preview notes\n\nThe **pane** shows `files/raw` with *Range* support.\n\n- images\n- audio and video\n\n> Space opens Quick Look.\n\n```js\nlet a = 1;\n```\n\n| kind | viewer |\n| -- | -- |\n| mp4 | video |\n';

function seedHome(home) {
  const dir = path.join(home, 'Media');
  fs.mkdirSync(dir, { recursive: true });
  for (const f of ['clip.mp4', 'clip.webm', 'tone.mp3', 'tone.m4a']) fs.copyFileSync(path.join(MEDIA, f), path.join(dir, f));
  fs.copyFileSync(path.join(ROOT, 'ui/icon-512.png'), path.join(dir, 'logo.png'));
  fs.writeFileSync(path.join(dir, 'doc.pdf'), PDF);
  fs.writeFileSync(path.join(dir, 'size.js'), CODE);
  fs.writeFileSync(path.join(dir, 'notes.md'), MD);
  fs.writeFileSync(path.join(dir, 'archive.zip'), Buffer.alloc(300));
}

async function startNode(name, port, peers) {
  const rigsHome = fs.mkdtempSync(path.join(os.tmpdir(), `rigs-preview-${name}-`));
  const home = path.join(rigsHome, 'home');
  fs.mkdirSync(home);
  seedHome(home);
  fs.writeFileSync(path.join(rigsHome, 'config.json'), JSON.stringify({ port, name, openrig: { registerPeers: false } }));
  const env = {
    ...process.env, HOME: home, USERPROFILE: home, RIGS_HOME: rigsHome, RIGS_PORT: String(port), RIGS_NAME: name, RIGS_SSH_DIR: path.join(rigsHome, 'ssh'),
    RIGS_NO_MIGRATIONS: '1', RIGS_NO_AUTOUPDATE: '1', RIGS_NO_OPENRIG: '1', RIGS_MESH_TOKEN: TOKEN, RIGS_PEERS: peers.join(','),
  };
  const child = spawn(process.execPath, ['bin/rigs.js', 'serve'], { cwd: ROOT, stdio: 'ignore', env });
  const url = `http://127.0.0.1:${port}/`;
  for (let i = 0; i < 60; i++) {
    await sleep(500);
    try { if ((await fetch(url)).ok) return { name, url, port, home, rigsHome, stop: () => { child.kill(); fs.rmSync(rigsHome, { recursive: true, force: true }); } }; } catch { /* wait */ }
  }
  child.kill();
  throw new Error(`rigs serve ${name} did not come up`);
}
const portB = await freePort();
const B = await startNode('linux-b', portB, []);
const A = await startNode('mac-a', await freePort(), [`http://127.0.0.1:${portB}`]);

// ---------------------------------------------------------------- helpers
const results = [];
const check = (name, ok, extra = '') => { results.push(!!ok); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${extra ? ' — ' + extra : ''}`); };
const browser = await chromium.launch({ channel: process.env.RIGS_CHROME_CHANNEL || 'chromium', args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'] });
const errors = [];
const W = '.files-win:not(.win-leave)';
const P = `${W} .fd-preview`;
const row = (page, name) => page.locator(`${W} .fd-content .file-row`, { has: page.locator('.fn', { hasText: new RegExp(`^${name.replace(/[.()]/g, '\\$&')}$`) }) }).first();
const shot = (page, name) => page.screenshot({ path: path.join(OUT, name) });
const mod = process.platform === 'darwin' ? 'Meta' : 'Control';
const media = (page, sel = `${P} video, ${P} audio`) => page.$eval(sel, (m) => ({ t: m.currentTime, d: m.duration, paused: m.paused, vol: m.volume, src: m.currentSrc, err: m.error?.code || 0 })).catch(() => null);

async function waitMesh(url, n) {
  for (let i = 0; i < 60; i++) {
    try { const s = await (await fetch(url + 'api/mesh/snapshot')).json(); if (s.filter((e) => e.node.online && e.node.rigs).length >= n) return s; } catch { /* wait */ }
    await sleep(500);
  }
  throw new Error('mesh did not form');
}
async function uiOpen(body) {
  let r = null;
  for (let i = 0; i < 40; i++) {
    r = await fetch(A.url + 'api/mesh/ui/open', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then((x) => x.json());
    if (r.delivered) return r;
    await sleep(500);
  }
  return r;
}
async function newPage(viewport, extra = {}) {
  const ctx = await browser.newContext({ viewport, ...extra });
  await ctx.addInitScript(() => { try { if (!sessionStorage.getItem('pc-init')) { localStorage.setItem('rigs.cloud', 'false'); sessionStorage.setItem('pc-init', '1'); } } catch { /* first load only */ } });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(`${viewport.width}: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error' && !/favicon|Failed to load resource|Content Security|net::ERR/.test(m.text())) errors.push(`${viewport.width}: ${m.text()}`); });
  page.on('dialog', (d) => d.accept());
  await page.goto(A.url);
  await sleep(1500);
  return { ctx, page };
}
/** Every files/raw response the page gets: { status, range, contentRange, bytes }. */
function watchRaw(page, log) {
  page.on('response', async (r) => {
    if (!r.url().includes('/files/raw')) return;
    const h = r.headers();
    log.push({ url: r.url(), status: r.status(), range: r.request().headers().range || '', contentRange: h['content-range'] || '', length: Number(h['content-length'] || 0) });
  });
}
async function select(page, name) { await row(page, name).click(); await sleep(450); await page.waitForFunction(() => !/^Loading/.test(document.querySelector('.files-win .pv-body .pv-cap')?.textContent || ''), null, { timeout: 15000 }).catch(() => {}); }

try {
  await waitMesh(A.url, 2);
  const { ctx, page } = await newPage({ width: 1440, height: 900 });
  await page.evaluate(() => localStorage.removeItem('rigs.finder'));
  const raw = [];
  watchRaw(page, raw);
  await uiOpen({ view: 'files', node: 'self', path: path.join(A.home, 'Media', 'logo.png') });
  await page.waitForSelector(`${W} .fd-content .file-row`);
  await sleep(800);
  // the canPlayType answers decide whether the h264 clip or the webm one is the "video" under test
  const canMp4 = await page.evaluate(() => !!document.createElement('video').canPlayType('video/mp4; codecs="avc1.42E01E"'));
  const video = canMp4 ? 'clip.mp4' : 'clip.webm';
  console.log(`video under test: ${video}${canMp4 ? '' : ' (this Chromium has no H.264)'}`);

  // image
  check('image: <img> with its dimensions', (await page.waitForFunction(() => /\d+ × \d+ px/.test(document.querySelector('.files-win .pv-cap')?.textContent || ''), null, { timeout: 20000 }).then(() => true, () => false)));
  await shot(page, 'desktop-image.png');
  // code
  await select(page, 'size.js');
  const code = await page.$$eval(`${P} .pv-code span`, (els) => ({ kw: els.filter((e) => e.className === 'tk-kw').length, str: els.filter((e) => e.className === 'tk-str').length, com: els.filter((e) => e.className === 'tk-com').length }));
  check('code: syntax highlighting (keywords, strings, comments)', code.kw >= 4 && code.str >= 2 && code.com >= 2, JSON.stringify(code));
  await shot(page, 'desktop-code.png');
  // markdown
  await select(page, 'notes.md');
  check('markdown: rendered (heading, list, quote, code, table)', await page.$eval(`${P} .pv-md`, (e) => !!(e.querySelector('h1') && e.querySelector('ul li') && e.querySelector('blockquote') && e.querySelector('pre') && e.querySelector('table') && e.querySelector('strong'))));
  await shot(page, 'desktop-markdown.png');
  // pdf
  await select(page, 'doc.pdf');
  check('pdf: embedded viewer', await page.$eval(`${P} iframe.pv-frame`, (e) => e.src.includes('/files/raw?path=')));
  await shot(page, 'desktop-pdf.png');
  // other file: info card
  await select(page, 'archive.zip');
  check('other kinds: big icon plus details', !!(await page.$(`${P} .pv-info`)) && /Size/.test(await page.$eval(`${P} .fd-info`, (e) => e.textContent)));

  // audio: play, scrub, volume, stop on selection change
  await select(page, 'tone.mp3');
  await page.locator(`${P} .tp-play`).click();
  await page.waitForFunction(() => { const a = document.querySelector('.fd-preview audio'); return a && a.currentTime > 0.5 && Number.isFinite(a.duration); }, null, { timeout: 15000 }).catch(() => {});
  let m = await media(page);
  check('audio: plays (time advances, transport shows pause)', m && !m.paused && m.t > 0.5 && (await page.$eval(`${P} .tp-play`, (e) => e.textContent)) === '⏸', JSON.stringify(m));
  const bar = await page.locator(`${P} .tp-scrub`).boundingBox();
  await page.mouse.click(bar.x + bar.width * 0.5, bar.y + bar.height / 2);
  await sleep(700);
  m = await media(page);
  check('audio: scrubbing to the middle seeks there', m && Math.abs(m.t - m.d / 2) < 3, `t=${m?.t?.toFixed(1)} of ${m?.d?.toFixed(1)}`);
  check('audio: time readout follows', /^0:(1|2)\d$/.test(await page.$eval(`${P} .tp-time`, (e) => e.textContent)));
  await page.$eval(`${P} .tp-vol`, (e) => { e.value = '0.3'; e.dispatchEvent(new Event('input', { bubbles: true })); });
  m = await media(page);
  check('audio: volume slider sets the volume', m && Math.abs(m.vol - 0.3) < 0.01, String(m?.vol));
  await shot(page, 'desktop-audio.png');
  await select(page, 'notes.md');
  check('audio: playback stops when the selection changes', (await page.$$('audio')).every(() => true) && !(await page.evaluate(() => [...document.querySelectorAll('audio')].some((a) => !a.paused))) && !(await page.$(`${P} audio`)));
  // m4a too (AAC in MP4 container: needs ranges to start)
  await select(page, 'tone.m4a');
  await page.locator(`${P} .tp-play`).click();
  await sleep(1200);
  m = await media(page);
  check('m4a plays', m && !m.paused && m.t > 0.3 && !m.err, JSON.stringify(m));

  // video: first-frame poster, play, seek to the middle -> 206
  raw.length = 0;
  await select(page, video);
  await sleep(1200);
  m = await media(page);
  check('video: loads metadata without playing', m && m.paused && m.d > 30 && !m.err, JSON.stringify(m));
  check('video: first request was a Range request, answered 206', raw.some((x) => x.url.includes(video) && x.status === 206), JSON.stringify(raw.slice(0, 3)));
  const before = raw.length;
  const vbar = await page.locator(`${P} .tp-scrub`).boundingBox();
  await page.mouse.click(vbar.x + vbar.width * 0.5, vbar.y + vbar.height / 2); // seek while paused, before anything past the start is buffered
  await sleep(2500);
  await page.locator(`${P} .tp-play`).click();
  await sleep(1200);
  m = await media(page);
  const size = fs.statSync(path.join(A.home, 'Media', video)).size;
  const seekReqs = raw.slice(before).filter((x) => x.url.includes(video));
  const mid = raw.slice(before).filter((x) => x.url.includes(video) && x.status === 206 && /^bytes (\d+)-/.test(x.contentRange) && Number(/^bytes (\d+)-/.exec(x.contentRange)[1]) > size * 0.2);
  const downloaded = raw.filter((x) => x.url.includes(video)).reduce((n, x) => n + x.length, 0);
  check('video: seek to the middle plays from there', m && !m.paused && Math.abs(m.t - m.d / 2) < 4, `t=${m?.t?.toFixed(1)} of ${m?.d?.toFixed(1)}`);
  check('video: the seek is a 206 from a mid-file offset (no whole-file download)', mid.length >= 1, JSON.stringify(seekReqs.map((x) => [x.status, x.range, x.contentRange])));
  console.log(`  video ${size} bytes; response bodies so far ${downloaded}`);
  await shot(page, 'desktop-video.png');

  // quick look
  await page.locator(`${W} .fd-content`).focus();
  await row(page, 'logo.png').click();
  await page.keyboard.press('Space');
  await page.waitForSelector('.ql');
  await sleep(500);
  const qlTitle = () => page.$eval('.ql-title', (e) => e.textContent);
  check('Space opens Quick Look on the selection', (await qlTitle()).includes('logo.png'));
  await shot(page, 'desktop-quicklook-image.png');
  await page.keyboard.press('ArrowRight');
  await sleep(300);
  const t2 = await qlTitle();
  check('→ steps to the next file (folder order)', !t2.includes('logo.png') && /\d+ of \d+/.test(await page.$eval('.ql-count', (e) => e.textContent)), t2);
  await page.keyboard.press('ArrowLeft');
  await sleep(300);
  check('← steps back', (await qlTitle()).includes('logo.png'));
  check('the list selection follows Quick Look', (await page.$eval(`${W} .file-row.sel .fn`, (e) => e.textContent)) === 'logo.png');
  // video in Quick Look
  await page.keyboard.press('Escape');
  await sleep(300);
  check('Esc closes Quick Look and leaves the window open', !(await page.$('.ql')) && !!(await page.$(W)));
  await row(page, video).click();
  await page.keyboard.press('Space');
  await page.waitForSelector('.ql video');
  await sleep(800);
  await page.locator('.ql .tp-play').click();
  await sleep(1200);
  m = await media(page, '.ql video');
  check('Quick Look plays video with the same transport', m && !m.paused && m.t > 0.5, JSON.stringify(m));
  check('…and the pane\'s player is not playing at the same time', !(await page.evaluate(() => [...document.querySelectorAll('.fd-preview video')].some((v) => !v.paused))));
  await shot(page, 'desktop-quicklook-video.png');
  await page.keyboard.press('Escape');
  await sleep(300);
  check('closing Quick Look stops playback', !(await page.evaluate(() => [...document.querySelectorAll('video,audio')].some((v) => !v.paused))));
  await row(page, 'doc.pdf').click();
  await page.keyboard.press('Space');
  await page.waitForSelector('.ql iframe');
  await sleep(600);
  await shot(page, 'desktop-quicklook-pdf.png');
  await page.keyboard.press('Space');
  check('Space closes Quick Look too', !(await page.$('.ql')));
  await row(page, 'size.js').click();
  await page.keyboard.press('Space');
  await page.waitForSelector('.ql .pv-code');
  await sleep(400);
  await shot(page, 'desktop-quicklook-code.png');
  await page.keyboard.press('Escape');

  // closing the window stops playback
  await select(page, 'tone.mp3');
  await page.locator(`${P} .tp-play`).click();
  await sleep(800);
  await page.keyboard.press('Escape');
  await sleep(600);
  check('closing the window stops playback', !(await page.evaluate(() => [...document.querySelectorAll('audio,video')].some((v) => !v.paused))));

  // a file on the other machine, through /api/nodes/linux-b/files/raw
  await uiOpen({ view: 'files', node: 'linux-b', path: path.join(B.home, 'Media', video) });
  await page.waitForFunction((p) => document.querySelector('.files-win .path-input')?.value === p, path.join(B.home, 'Media'));
  await sleep(1200);
  raw.length = 0;
  await row(page, video).click();
  await sleep(1200);
  await page.locator(`${P} .tp-play`).click();
  await sleep(800);
  const pb = await page.locator(`${P} .tp-scrub`).boundingBox();
  await page.mouse.click(pb.x + pb.width * 0.6, pb.y + pb.height / 2);
  await sleep(2500);
  m = await media(page);
  const viaPeer = raw.filter((x) => x.url.includes('/api/nodes/') && x.url.includes(video) && x.status === 206 && /^bytes (\d+)-/.test(x.contentRange) && Number(/^bytes (\d+)-/.exec(x.contentRange)[1]) > size * 0.2);
  check('peer: video on another rig seeks through the proxy with a 206', m && Math.abs(m.t - m.d * 0.6) < 4 && viaPeer.length >= 1, `t=${m?.t?.toFixed(1)} ${JSON.stringify(viaPeer.slice(0, 2).map((x) => [x.status, x.contentRange]))}`);
  await shot(page, 'desktop-video-peer.png');
  await ctx.close();

  // ---------------------------------------------------------------- phone
  const { ctx: pctx, page: ph } = await newPage({ width: 390, height: 844 }, { isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  await uiOpen({ view: 'files', node: 'self', path: path.join(A.home, 'Media') });
  await ph.waitForSelector(`${W} .fd-content .file-row`);
  await sleep(800);
  await row(ph, 'size.js').tap();
  await sleep(900);
  await shot(ph, 'phone-code.png');
  await ph.locator(`${W} .fd-sheet-x`).tap();
  await row(ph, 'tone.mp3').tap();
  await sleep(900);
  await ph.locator(`${P} .tp-play`).tap();
  await sleep(1000);
  m = await media(ph);
  check('phone: audio plays from the preview sheet', m && !m.paused && m.t > 0.3, JSON.stringify(m));
  await shot(ph, 'phone-audio.png');
  await ph.locator(`${W} .fd-sheet-x`).tap();
  await sleep(400);
  check('phone: closing the sheet stops audio', !(await ph.evaluate(() => [...document.querySelectorAll('audio')].some((v) => !v.paused))));
  await row(ph, video).tap();
  await sleep(1200);
  await shot(ph, 'phone-video.png');
  await ph.locator(`${P} .pv-body, ${P}`).first().evaluate(() => {});
  await ph.evaluate(() => document.querySelector('.files-win .fd-content')?.focus());
  await ph.keyboard.press('Space');
  await ph.waitForSelector('.ql', { timeout: 4000 }).catch(() => {});
  const qb = await ph.$eval('.ql', (e) => { const r = e.getBoundingClientRect(); return { w: r.width, h: r.height }; }).catch(() => null);
  check('phone: Quick Look fills the screen', qb && qb.w >= 388 && qb.h >= 800, JSON.stringify(qb));
  await shot(ph, 'phone-quicklook.png');
  await pctx.close();
} catch (e) {
  check('run', false, e.stack);
  for (const c of browser.contexts()) for (const pg of c.pages()) await pg.screenshot({ path: path.join(OUT, 'failure.png') }).catch(() => {});
} finally {
  await browser.close();
  A.stop();
  B.stop();
}
check('no console errors', !errors.length, errors.join(' | '));
const failed = results.filter((x) => !x).length;
console.log(`\n${results.length - failed}/${results.length} passed · screenshots in ${OUT}`);
process.exit(failed ? 1 : 0);
