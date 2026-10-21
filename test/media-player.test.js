// The media player's pure logic (ui/src/media-player-model.js) and how the file tools and ui_open route media to it.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import {
  SPEEDS, clampVolume, closeOutcome, createArbiter, errorMessage, folderName, folderOf, formatTime, keyAction, mediaKind,
  mediaSiblings, mimeFor, nextSpeed, rawUrl, seekTarget, sessionMeta, speedLabel, stepKind, stepSpeed, stepTrack, titleOf,
} from '../ui/src/media-player-model.js';
import { TOOLS, toolFor, toolsFor } from '../ui/src/file-tools-model.js';
import { uiOpenAction } from '../ui/src/ui-open-model.js';

test('mediaKind / mimeFor: audio and video by extension, case-blind, paths too', () => {
  for (const n of ['a.mp3', 'a.M4A', 'a.aac', 'a.wav', 'a.flac', 'a.ogg', 'a.opus', '/x/y/song.Mp3']) assert.equal(mediaKind(n), 'audio', n);
  for (const n of ['v.mp4', 'v.m4v', 'v.webm', 'v.MOV', 'v.mkv', 'C:\\clips\\v.mp4']) assert.equal(mediaKind(n), 'video', n);
  for (const n of ['a.txt', 'mp3', 'a.mp3.txt', '', null]) assert.equal(mediaKind(n), null, String(n));
  assert.equal(mimeFor('a.mp3'), 'audio/mpeg');
  assert.equal(mimeFor('v.mkv'), 'video/x-matroska');
  assert.equal(mimeFor('a.txt'), '');
});

test('titleOf / folderOf / rawUrl', () => {
  assert.equal(titleOf('/m/01 Intro.mp3'), '01 Intro');
  assert.equal(titleOf('noext'), 'noext');
  assert.equal(folderOf('/m/a/b.mp3'), '/m/a');
  assert.equal(folderOf('C:\\m\\b.mp3'), 'C:\\m');
  assert.equal(folderName('/m/Albums/b.mp3'), 'Albums');
  assert.equal(rawUrl('node 1', '/a b/c#.mp4'), '/api/nodes/node%201/files/raw?path=%2Fa%20b%2Fc%23.mp4');
  assert.equal(rawUrl('', '/x.mp3', { download: true }), '/api/nodes/self/files/raw?path=%2Fx.mp3&download=1');
});

test('formatTime: m:ss, h:mm:ss, unknown', () => {
  assert.equal(formatTime(0), '0:00');
  assert.equal(formatTime(65.9), '1:05');
  assert.equal(formatTime(600), '10:00');
  assert.equal(formatTime(3723), '1:02:03');
  assert.equal(formatTime(NaN), '--:--');
  assert.equal(formatTime(Infinity), '--:--');
  assert.equal(formatTime(-1), '--:--');
});

test('mediaSiblings: the folder\'s audio and video in natural order, the file always in it', () => {
  const entries = [
    { name: 'sub', path: '/m/sub', type: 'dir' },
    { name: '10 b.mp3', path: '/m/10 b.mp3', type: 'file' },
    { name: 'notes.txt', path: '/m/notes.txt', type: 'file' },
    { name: '2 a.mp3', path: '/m/2 a.mp3', type: 'file' },
    { name: 'clip.MP4', path: '/m/clip.MP4', type: 'file' },
    { name: 'movie.mkv', path: '/m/movie.mkv', type: 'file' },
    { name: '._clip.MP4', path: '/m/._clip.MP4', type: 'file' },
  ];
  const r = mediaSiblings(entries, '/m/10 b.mp3');
  assert.deepEqual(r.list.map((x) => x.name), ['2 a.mp3', '10 b.mp3', 'clip.MP4', 'movie.mkv']);
  assert.deepEqual(r.list.map((x) => x.kind), ['audio', 'audio', 'video', 'video']);
  assert.equal(r.index, 1);
  const lone = mediaSiblings(undefined, '/x/one.mp3');
  assert.deepEqual(lone, { list: [{ name: 'one.mp3', path: '/x/one.mp3', kind: 'audio' }], index: 0 });
  const missing = mediaSiblings(entries, '/elsewhere/z.mp3');
  assert.equal(missing.index, 0);
  assert.equal(missing.list[0].path, '/elsewhere/z.mp3');
  assert.equal(missing.list.length, 5);
});

test('stepTrack: next/previous without wrapping', () => {
  assert.equal(stepTrack(3, 0, 1), 1);
  assert.equal(stepTrack(3, 2, 1), -1, 'past the end');
  assert.equal(stepTrack(3, 0, -1), -1, 'before the start');
  assert.equal(stepTrack(0, 0, 1), -1);
  const list = [{ kind: 'audio' }, { kind: 'video' }, { kind: 'audio' }, { kind: 'video' }];
  assert.equal(stepKind(list, 0, 1, 'audio'), 2, 'the mini-player skips video');
  assert.equal(stepKind(list, 2, 1, 'audio'), -1);
  assert.equal(stepKind(list, 2, -1, 'audio'), 0);
  assert.equal(stepKind(list, 0, 1, null), 1, 'the window plays everything');
});

test('speeds: step up/down held at the ends, the button cycles, labels', () => {
  assert.ok(SPEEDS.includes(1));
  assert.equal(stepSpeed(1, 1), 1.25);
  assert.equal(stepSpeed(1, -1), 0.75);
  assert.equal(stepSpeed(2, 1), 2);
  assert.equal(stepSpeed(0.5, -1), 0.5);
  assert.equal(stepSpeed(1.1, 1), 1.25, 'from the nearest listed speed');
  assert.equal(nextSpeed(1.75), 2);
  assert.equal(nextSpeed(2), 0.5);
  assert.equal(speedLabel(1), '1×');
  assert.equal(speedLabel(1.25), '1.25×');
});

test('volume and seeking stay in range', () => {
  assert.equal(clampVolume(1.4), 1);
  assert.equal(clampVolume(-0.2), 0);
  assert.equal(clampVolume(0.3 + 0.1), 0.4, 'no float drift');
  assert.equal(clampVolume(NaN), 1);
  assert.equal(seekTarget(10, -30, 60), 0);
  assert.equal(seekTarget(50, 30, 60), 60);
  assert.equal(seekTarget(50, 30, NaN), 80, 'unknown duration: only the floor');
  assert.equal(seekTarget(0, Infinity, 42), 42, 'End');
});

test('keyAction: shortcuts, video-only keys, modifiers left to JARVIS', () => {
  const k = (key, mods = {}, kind = 'video') => keyAction({ key, ...mods }, { kind });
  assert.deepEqual(k(' '), { type: 'toggle' });
  assert.deepEqual(k('k'), { type: 'toggle' });
  assert.deepEqual(k('ArrowLeft'), { type: 'seek', by: -5 });
  assert.deepEqual(k('ArrowRight', { shiftKey: true }), { type: 'seek', by: 30 });
  assert.deepEqual(k('l'), { type: 'seek', by: 10 });
  assert.deepEqual(k('ArrowUp'), { type: 'volume', by: 0.1 });
  assert.deepEqual(k('ArrowDown'), { type: 'volume', by: -0.1 });
  assert.deepEqual(k('m'), { type: 'mute' });
  assert.deepEqual(k('f'), { type: 'fullscreen' });
  assert.equal(k('f', {}, 'audio'), null, 'no fullscreen for audio');
  assert.deepEqual(k('i'), { type: 'pip' });
  assert.equal(k('i', {}, 'audio'), null);
  assert.deepEqual(k('N', { shiftKey: true }), { type: 'next' });
  assert.deepEqual(k('P', { shiftKey: true }), { type: 'prev' });
  assert.equal(k('n'), null);
  assert.deepEqual(k('>'), { type: 'speed', dir: 1 });
  assert.deepEqual(k('<'), { type: 'speed', dir: -1 });
  assert.deepEqual(k('5'), { type: 'seekPct', pct: 50 });
  assert.deepEqual(k('Home'), { type: 'seekTo', at: 0 });
  for (const mod of ['ctrlKey', 'metaKey', 'altKey']) assert.equal(k('ArrowLeft', { [mod]: true }), null, mod);
  assert.equal(k('x'), null);
  assert.equal(keyAction(null), null);
});

test('closeOutcome: playing audio goes on in the mini-player, everything else stops', () => {
  assert.equal(closeOutcome({ kind: 'audio', paused: false }), 'mini');
  assert.equal(closeOutcome({ kind: 'audio', paused: true }), 'stop');
  assert.equal(closeOutcome({ kind: 'audio', paused: false, ended: true }), 'stop');
  assert.equal(closeOutcome({ kind: 'video', paused: false }), 'stop');
  assert.equal(closeOutcome({}), 'stop');
});

test('errorMessage: every MediaError code reads plainly and names the format', () => {
  assert.match(errorMessage(4, { name: 'a.mkv' }), /can't play this MKV file \(MKV isn't supported here\)\. Download/);
  assert.match(errorMessage(4, { name: 'a.flac' }), /FLAC isn't supported here/);
  assert.match(errorMessage(3, { name: 'a.mp4' }), /couldn't decode this MP4 file/);
  assert.match(errorMessage(2, { name: 'a.mp3', nodeName: 'linux' }), /from linux/);
  assert.match(errorMessage(0, { name: 'a.mov' }), /^This MOV file isn't loading/);
  assert.match(errorMessage(1), /stopped/);
  for (const c of [0, 2, 3, 4]) assert.match(errorMessage(c, { name: 'x.ogg' }), /[Dd]ownload/, `code ${c} points at the download`);
});

test('sessionMeta: title, machine, folder for the OS media controls', () => {
  assert.deepEqual(sessionMeta({ name: 'Song.mp3', path: '/m/Album/Song.mp3' }, 'mac'), { title: 'Song', artist: 'mac', album: 'Album' });
});

test('createArbiter: claiming pauses the one before; the same one again does not; release forgets', () => {
  const log = [];
  const p = (id) => ({ id, pause: () => log.push(id) });
  const a = createArbiter();
  const x = p('x');
  const y = p('y');
  a.claim(x);
  a.claim(x);
  assert.deepEqual(log, []);
  a.claim(y);
  assert.deepEqual(log, ['x']);
  assert.equal(a.current(), y);
  a.release(x);
  assert.equal(a.current(), y, 'releasing another one changes nothing');
  a.release(y);
  assert.equal(a.current(), null);
  a.claim({ pause() { throw new Error('gone'); } });
  a.claim(x); // a throwing pause does not break the next claim
  assert.equal(a.current(), x);
});

test('file tools: audio and video open in the media player (double-click, Open with, desktop icons)', () => {
  assert.equal(TOOLS.media.label, 'Media player');
  assert.equal(toolFor('movie.mp4'), 'media');
  assert.equal(toolFor('/m/song.MP3'), 'media');
  assert.deepEqual(toolsFor('clip.webm'), ['media']);
  assert.equal(toolFor('notes.txt'), 'text', 'unchanged for text');
  const src = fs.readFileSync(new URL('../ui/src/file-tools.js', import.meta.url), 'utf8');
  assert.match(src, /tool === 'media'\) return openMediaPlayer\(/, 'openFileTool hands media to the player');
});

test('ui_open on an audio or video file plays it; a folder or a missing file still opens the file browser', () => {
  const push = (over) => uiOpenAction({ type: 'ui-open', view: 'files', nodeId: 'n1', nodeName: 'mac', path: '/m', ...over });
  assert.equal(push({ select: '/m/song.mp3' }).play, '/m/song.mp3');
  assert.equal(push({ select: '/m/clip.mov' }).play, '/m/clip.mov');
  assert.equal(push({ select: '/m/notes.txt' }).play, '');
  assert.equal(push({}).play, '');
  assert.equal(push({ select: '/m/song.mp3', missing: true }).play, '', 'a fallback is never played');
});

test('wiring: files.js has one media hook, the dock and Tools menu reach the player', () => {
  const files = fs.readFileSync(new URL('../ui/src/files.js', import.meta.url), 'utf8');
  assert.equal((files.match(/mediaPreview\(/g) || []).length, 1, 'one hook point in the file browser');
  assert.doesNotMatch(files, /h\('video'/, 'no bare <video> left in the preview');
  const main = fs.readFileSync(new URL('../ui/src/main.js', import.meta.url), 'utf8');
  assert.match(main, /\$\('#btn-player'\)\.onclick = \(\) => openMediaPlayer\(\)/);
  assert.match(main, /a\.play\) openMediaPlayer\(/, 'onUiOpen plays a media file');
  const cmds = fs.readFileSync(new URL('../ui/src/jarvis-commands.js', import.meta.url), 'utf8');
  assert.match(cmds, /id: 'tools\.player'/);
  assert.match(cmds, /\{ cmd: 'tools\.player' \}/);
});
