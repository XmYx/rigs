// Moonlight on Wayland: the stream goes native Wayland + Vulkan, VDPAU (which locked up / crashed XWayland on
// NVIDIA) is unavailable, and GUI launches find the X display that is really live.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

process.env.RIGS_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'rigs-moonlight-'));
const { moonlightWrapperText } = await import('../src/desktop-install.js');
const { liveXDisplay } = await import('../src/desktop.js');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rigs-ml-'));
const appRun = path.join(dir, 'AppRun');
fs.writeFileSync(appRun, '#!/bin/sh\necho "SDL=$SDL_VIDEODRIVER VK=$PREFER_VULKAN VDPAU=$VDPAU_DRIVER ARGS=$*"\n', { mode: 0o755 });
const wrapper = path.join(dir, 'moonlight');
fs.writeFileSync(wrapper, moonlightWrapperText(appRun, '/nonexistent.AppImage'), { mode: 0o755 });
const runW = (env) => execFileSync('/bin/sh', [wrapper, 'stream', 'host', 'Desktop'], { env: { PATH: '/usr/bin:/bin', ...env }, encoding: 'utf8' }).trim();

test('Wayland session: native Wayland stream window, Vulkan renderer, no VDPAU', { skip: process.platform === 'win32' }, () => {
  assert.equal(runW({ WAYLAND_DISPLAY: 'wayland-0', DISPLAY: ':0' }), 'SDL=wayland VK=1 VDPAU=rigs-disabled ARGS=stream host Desktop');
});

test('X11 session: untouched; explicit choices win', { skip: process.platform === 'win32' }, () => {
  assert.equal(runW({ DISPLAY: ':0' }), 'SDL= VK= VDPAU= ARGS=stream host Desktop');
  assert.equal(runW({ WAYLAND_DISPLAY: 'wayland-0', SDL_VIDEODRIVER: 'x11', RIGS_MOONLIGHT_VDPAU: '1' }), 'SDL=x11 VK=1 VDPAU= ARGS=stream host Desktop');
});

test('the live X display is used when the session still names a dead one', () => {
  const ss = 'u_str LISTEN 0 1 @/tmp/.X11-unix/X1 10301680 * 0 users:(("gnome-shell",pid=2485002,fd=19))\n';
  assert.equal(liveXDisplay(ss, ':0'), ':1', 'XWayland moved to :1 after a crash');
  assert.equal(liveXDisplay(ss + 'u_str LISTEN 0 1 /tmp/.X11-unix/X0 1 * 0\n', ':0'), ':0', 'a live wanted display is kept');
  assert.equal(liveXDisplay('', ':0'), ':0', 'nothing known: keep what the session says');
});
