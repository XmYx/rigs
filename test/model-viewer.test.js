// The 3D viewer (ui/src/model-viewer.js): its pure parts (model-viewer-model.js) in Node, plus static checks that the
// viewer is a lazy chunk built from the bundled three.js (no CDN), and that Finder preview, Quick Look, the file tools
// and ui_open reach it.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const M = await import('../ui/src/model-viewer-model.js');

test('loaderFor / isModelFile: glb and gltf → GLTFLoader, obj → OBJLoader, anything else none (query strings ignored)', () => {
  assert.equal(M.loaderFor('chair.glb'), 'gltf');
  assert.equal(M.loaderFor('/a/scene.GLTF'), 'gltf');
  assert.equal(M.loaderFor('mesh.obj'), 'obj');
  assert.equal(M.loaderFor('/api/nodes/n/files/raw?path=%2Fx%2Fchair.glb'), null, 'the url path ends in raw: callers pass the file name');
  assert.equal(M.loaderFor('chair.glb?download=1'), 'gltf');
  assert.equal(M.loaderFor('chair.fbx'), null);
  assert.equal(M.loaderFor(''), null);
  assert.ok(M.isModelFile('/x/a.glb') && M.isModelFile('a.gltf') && M.isModelFile('a.OBJ') && !M.isModelFile('a.stl') && !M.isModelFile('glb'));
});

test('frameBox: the camera distance fits the bounding sphere in the narrower field of view, with a margin; a degenerate box frames a unit cube', () => {
  const f = M.frameBox({ min: [-1, 0, -1], max: [1, 2, 1] }, { fov: 45, aspect: 16 / 9 });
  assert.deepEqual(f.center, [0, 1, 0]);
  assert.deepEqual(f.size, [2, 2, 2]);
  assert.ok(Math.abs(f.radius - Math.sqrt(3)) < 1e-9);
  const expect = (Math.sqrt(3) / Math.sin((45 * Math.PI) / 360)) * 1.25;
  assert.ok(Math.abs(f.distance - expect) < 1e-9, `${f.distance} vs ${expect}`);
  assert.ok(f.near > 0 && f.near < f.distance - f.radius && f.far > f.distance + f.radius);
  // A tall viewport: the horizontal field of view is the narrower one, so the model sits further away.
  const tall = M.frameBox({ min: [-1, 0, -1], max: [1, 2, 1] }, { fov: 45, aspect: 0.5 });
  assert.ok(tall.distance > f.distance);
  const unit = M.frameBox(null);
  assert.ok(Math.abs(unit.radius - Math.sqrt(3) / 2) < 1e-9 && unit.distance > unit.radius);
  assert.deepEqual(M.frameBox({ min: [1, 1, 1], max: [1, 1, 1] }).size, [0, 0, 0]);
});

test('trianglesOf, fmtCount, statusLine, modelUrl', () => {
  assert.equal(M.trianglesOf({ indexCount: 36, positionCount: 24 }), 12, 'indexed: the index wins');
  assert.equal(M.trianglesOf({ positionCount: 9 }), 3);
  assert.equal(M.trianglesOf({}), 0);
  assert.deepEqual([M.fmtCount(123), M.fmtCount(45678), M.fmtCount(1234567), M.fmtCount(2000)], ['123', '45.7k', '1.2M', '2k']);
  assert.equal(M.statusLine({ loading: true }), 'Loading…');
  assert.equal(M.statusLine({ error: 'HTTP 404' }), 'Could not load: HTTP 404');
  assert.equal(M.statusLine({ triangles: 12345, meshes: 1, bytes: 2 * 1024 * 1024 + 100000, size: [1.2, 0.8, 0.456] }), '12.3k triangles · 1 mesh · 2.1 MB · 1.20 × 0.80 × 0.46');
  assert.equal(M.statusLine({ triangles: 0, meshes: 2 }), '0 triangles · 2 meshes');
  assert.equal(M.modelUrl('n 1', '/a b/c.glb'), '/api/nodes/n%201/files/raw?path=%2Fa%20b%2Fc.glb');
  assert.equal(M.modelUrl('', '/x'), '/api/nodes/self/files/raw?path=%2Fx');
});

test('model-viewer.js: three from the bundle (GLTFLoader, OBJLoader, OrbitControls, no CDN), a lazy chunk, lights, grid, framing, dispose, status, three buttons', () => {
  const src = read('ui/src/model-viewer.js');
  assert.match(src, /from 'three'/);
  assert.match(src, /from 'three\/examples\/jsm\/loaders\/GLTFLoader\.js'/);
  assert.match(src, /from 'three\/examples\/jsm\/loaders\/OBJLoader\.js'/);
  assert.match(src, /from 'three\/examples\/jsm\/controls\/OrbitControls\.js'/);
  assert.doesNotMatch(src, /https?:\/\//, 'no remote scripts');
  for (const re of [/HemisphereLight/, /DirectionalLight/, /GridHelper/, /new ResizeObserver/, /frameBox\(/, /renderer\.dispose\(\)/, /controls\.dispose\(\)/, /cancelAnimationFrame/, /'⌂ Reset view'/, /'⬡ Wireframe'/, /'↻ Auto-rotate'/, /statusLine/]) assert.match(src, re);
  assert.match(src, /export function mountModelViewer\(container, url/);
  assert.match(src, /export function openModelViewer\(\{ nodeId = 'self', nodeName = '', path = '', url = '', title = ''/);
  const lazy = read('ui/src/model-viewer-lazy.js');
  assert.match(lazy, /import\('\.\/model-viewer\.js'\)/);
  // Who reaches it: Finder preview + Quick Look (compact, turning), the file tools (Open with → 3D viewer), ui_open's model view.
  assert.match(read('ui/src/finder-preview.js'), /kind === 'model'[\s\S]*mountModelViewer\(stage, url, \{ autoRotate: true/);
  assert.match(read('ui/src/file-tools.js'), /tool === 'model'\) return openModelViewer\(/);
  assert.match(read('ui/src/main.js'), /a\.view === 'model'\) \{\s*openModelViewer\(\{ nodeId: a\.nodeId/);
  assert.match(read('ui/src/styles.css'), /\.mv-stage \{/);
  assert.match(read('ui/src/styles.css'), /\.pv-model \{/);
  // Dynamic imports only, so the entry bundle does not carry the loaders.
  for (const f of ['ui/src/main.js', 'ui/src/file-tools.js', 'ui/src/finder-preview.js']) assert.match(read(f), /from '\.\/model-viewer-lazy\.js'/, f);
});
