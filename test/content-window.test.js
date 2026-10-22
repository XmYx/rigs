// The generic content window (ui/src/content-window.js): its pure rules (content-window-model.js) in Node, plus static
// checks that the window module uses them and that ui_open's url view and the html tool go through it.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const M = await import('../ui/src/content-window-model.js');

test('sandboxFor: scripts, forms, popups and downloads always; same-origin only for a same-origin /api path that is not a raw file', () => {
  assert.equal(M.sandboxFor({ url: 'https://example.com/' }), M.BASE_SANDBOX);
  assert.equal(M.sandboxFor({ url: '/api/nodes/n-1/apps/body-matching/training' }), `${M.BASE_SANDBOX} allow-same-origin`);
  assert.equal(M.sandboxFor({ url: '/api/local/reports/x.html' }), `${M.BASE_SANDBOX} allow-same-origin`);
  // A raw file is whatever an agent or a download put there: it never runs as the UI.
  for (const u of ['/api/nodes/n-1/files/raw?path=%2Fx.html', '/api/local/files/raw?path=a', '/api/files/raw?path=a', '/api/nodes/n/shared/file?path=a.html']) assert.equal(M.sandboxFor({ url: u }), M.BASE_SANDBOX, u);
  assert.equal(M.sandboxFor({ html: '<p>hi</p>' }), 'allow-scripts');
  assert.equal(M.sandboxFor({ url: '//evil.example/api/x' }), M.BASE_SANDBOX);
  assert.equal(M.sandboxFor({ url: '/apix/y' }), M.BASE_SANDBOX);
  assert.ok(!M.BASE_SANDBOX.includes('allow-same-origin') && !M.BASE_SANDBOX.includes('allow-top-navigation'));
});

test('isSameOriginApi / isRawFile', () => {
  assert.ok(M.isSameOriginApi('/api/') && M.isSameOriginApi('/api/x') && !M.isSameOriginApi('/apix') && !M.isSameOriginApi('https://a/api/x') && !M.isSameOriginApi(''));
  assert.ok(M.isRawFile('/api/nodes/n/files/raw?path=x') && M.isRawFile('/api/local/files/raw') && !M.isRawFile('/api/nodes/n/files/rawish') && !M.isRawFile('/api/nodes/n/apps/a/files/raw'));
});

test('frameKind, tabTarget, contentKey, titleFor', () => {
  assert.equal(M.frameKind({ url: 'https://a' }), 'url');
  assert.equal(M.frameKind({ html: '<b>' }), 'html');
  assert.equal(M.frameKind({ el: {} }), 'el');
  assert.equal(M.frameKind({}), null);
  assert.equal(M.tabTarget({ url: 'https://a/b' }), 'https://a/b');
  assert.equal(M.tabTarget({ url: '/api/x' }), '/api/x');
  assert.equal(M.tabTarget({ url: 'javascript:1' }), '');
  assert.equal(M.tabTarget({}), '');
  assert.equal(M.contentKey({ key: 'k' }), 'k');
  assert.equal(M.contentKey({ url: 'https://a' }), 'content:https://a');
  assert.equal(M.contentKey({ title: 'T' }), 'content:T');
  assert.equal(M.contentKey({}), undefined);
  assert.equal(M.titleFor({ title: 'Report' }), 'Report');
  assert.equal(M.titleFor({ url: 'https://example.com/a/b?c' }), 'example.com');
  assert.equal(M.titleFor({ url: '/api/nodes/n/files/raw?path=x' }), 'raw');
  assert.equal(M.titleFor({}), 'Page');
});

test('content-window.js builds a sandboxed iframe on wm.openWindow with reload and open-in-tab, and main.js / file-tools.js use it', () => {
  const src = read('ui/src/content-window.js');
  assert.match(src, /export function openContentWindow\(\{ title, icon = '🌐', url = '', html = '', el = null, width = 960, height = 680, key, focus = false/);
  assert.match(src, /sandbox: sandboxFor\(\{ url, html \}\)/);
  assert.match(src, /className: `app-win content-win/);
  assert.match(src, /title: 'Reload'/);
  assert.match(src, /title: 'Open in a browser tab'/);
  assert.match(src, /frame\.srcdoc = text/);
  const main = read('ui/src/main.js');
  assert.match(main, /a\.view === 'url'\) \{\s*openContentWindow\(\{ url: a\.url, title: a\.title/);
  const ft = read('ui/src/file-tools.js');
  assert.match(ft, /function htmlViewer\(/);
  assert.match(ft, /html: htmlViewer/);
  assert.doesNotMatch(read('ui/src/content-window.js') + ft + read('ui/src/model-viewer.js'), /https?:\/\/(?:cdn|unpkg|cdnjs|jsdelivr)/, 'no CDN scripts: the UI works offline');
});
