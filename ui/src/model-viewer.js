// 3D model viewer: a .glb / .gltf (GLTFLoader) or .obj (OBJLoader) from any machine's files/raw endpoint, in a three.js
// scene with OrbitControls, a hemisphere + directional light rig, a grid and the camera framed on the model's bounding
// box. `mountModelViewer(container, url, opts)` draws into any element (the Finder preview pane and Quick Look use it,
// compact and auto-rotating); `openModelViewer({ nodeId, nodeName, path, url, title })` is the wm.js window with a
// toolbar (reset view, wireframe, auto-rotate, download) and a status line (triangles, meshes, size, load errors).
// Everything is disposed when the container goes (renderer, geometries, materials, controls, the resize observer).
// The pure parts (loader choice, framing maths, counts, status text) are model-viewer-model.js.
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { h, toast } from './api.js';
import { openWindow } from './wm.js';
import { pixelRatio, lowPower } from './perf.js';
import { frameBox, loaderFor, modelUrl, statusLine, trianglesOf } from './model-viewer-model.js';

const open = new Map(); // `${nodeId}|${path}` → window

/**
 * Draw the model at `url` into `container` (any sized element). Returns the viewer handle:
 * { dispose(), reset(), setWireframe(on), setAutoRotate(on), wireframe, autoRotate, onStatus(fn), status }.
 */
export function mountModelViewer(container, url, { autoRotate = false, name = '', onStatus = null } = {}) {
  const kind = loaderFor(name || url);
  const state = { loading: true, error: '', triangles: 0, meshes: 0, bytes: 0, size: null };
  let statusFn = onStatus;
  const report = () => statusFn?.(statusLine(state), state);
  if (!kind) { state.loading = false; state.error = 'not a .glb, .gltf or .obj file'; report(); return { dispose() {}, reset() {}, setWireframe() {}, setAutoRotate() {}, onStatus(fn) { statusFn = fn; report(); }, get status() { return statusLine(state); } }; }

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(45, 1, 0.01, 1000);
  camera.position.set(2, 1.5, 3);
  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({ antialias: !lowPower(), alpha: true, powerPreference: 'high-performance' });
  } catch (e) {
    state.loading = false; state.error = `WebGL is not available (${e.message})`; report();
    container.append(h('div', { class: 'mv-fail muted pad' }, statusLine(state)));
    return { dispose() {}, reset() {}, setWireframe() {}, setAutoRotate() {}, onStatus(fn) { statusFn = fn; report(); }, get status() { return statusLine(state); } };
  }
  renderer.setPixelRatio(pixelRatio());
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.domElement.className = 'mv-canvas';
  container.append(renderer.domElement);

  const hemi = new THREE.HemisphereLight(0xe8f1ff, 0x1c2430, 1.6);
  const key = new THREE.DirectionalLight(0xffffff, 2.2);
  key.position.set(3, 5, 4);
  const fill = new THREE.DirectionalLight(0x9fc5ff, 0.6);
  fill.position.set(-4, 2, -3);
  scene.add(hemi, key, fill);
  const grid = new THREE.GridHelper(10, 20, 0x3a4a60, 0x233040);
  grid.material.transparent = true;
  grid.material.opacity = 0.55;
  scene.add(grid);

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.autoRotate = !!autoRotate;
  controls.autoRotateSpeed = 1.6;

  let model = null;
  let wire = false;
  let home = null; // { position, target } after framing
  let raf = 0;
  let alive = true;

  const size = () => {
    const w = Math.max(1, container.clientWidth);
    const hh = Math.max(1, container.clientHeight);
    renderer.setSize(w, hh, false);
    camera.aspect = w / hh;
    camera.updateProjectionMatrix();
    if (model && !home) frame();
  };
  const ro = new ResizeObserver(size);
  ro.observe(container);
  size();

  function frame() {
    if (!model) return;
    const box = new THREE.Box3().setFromObject(model);
    if (box.isEmpty()) return;
    const f = frameBox({ min: box.min.toArray(), max: box.max.toArray() }, { fov: camera.fov, aspect: camera.aspect });
    const c = new THREE.Vector3(...f.center);
    const dir = new THREE.Vector3(1, 0.65, 1.2).normalize();
    camera.position.copy(c).addScaledVector(dir, f.distance);
    camera.near = f.near; camera.far = f.far;
    camera.updateProjectionMatrix();
    controls.target.copy(c);
    controls.minDistance = f.radius * 0.2;
    controls.maxDistance = f.distance * 8;
    // The grid sits under the model, scaled to it.
    grid.position.set(c.x, box.min.y, c.z);
    const g = Math.max(1, Math.ceil(f.radius * 4));
    grid.scale.setScalar(g / 10);
    controls.update();
    home = { position: camera.position.clone(), target: controls.target.clone() };
    state.size = f.size;
  }

  function applyWire(on) {
    model?.traverse((o) => { if (o.isMesh) for (const m of [].concat(o.material)) if (m && 'wireframe' in m) m.wireframe = on; });
  }

  function tick() {
    if (!alive) return;
    raf = requestAnimationFrame(tick);
    controls.update();
    renderer.render(scene, camera);
  }
  tick();

  const loader = kind === 'gltf' ? new GLTFLoader() : new OBJLoader();
  const onProgress = (ev) => { if (ev?.total) state.bytes = ev.total; else if (ev?.loaded) state.bytes = ev.loaded; };
  loader.load(url, (res) => {
    if (!alive) return;
    model = kind === 'gltf' ? res.scene || res.scenes?.[0] : res;
    if (!model) { state.loading = false; state.error = 'the file holds no scene'; report(); return; }
    let tri = 0; let meshes = 0;
    model.traverse((o) => {
      if (!o.isMesh || !o.geometry) return;
      meshes++;
      tri += trianglesOf({ indexCount: o.geometry.index?.count || 0, positionCount: o.geometry.attributes?.position?.count || 0 });
      // OBJ files without a material come grey and flat; give them something to shade.
      for (const m of [].concat(o.material)) if (m && m.isMeshBasicMaterial && kind === 'obj') o.material = new THREE.MeshStandardMaterial({ color: 0xb8c4d6, metalness: 0.1, roughness: 0.65 });
    });
    scene.add(model);
    frame();
    applyWire(wire);
    Object.assign(state, { loading: false, triangles: tri, meshes });
    report();
  }, onProgress, (err) => {
    if (!alive) return;
    state.loading = false;
    state.error = err?.message || (err?.target?.status ? `HTTP ${err.target.status}` : 'load failed');
    report();
  });
  report();

  function dispose() {
    alive = false;
    cancelAnimationFrame(raf);
    ro.disconnect();
    controls.dispose();
    scene.traverse((o) => {
      o.geometry?.dispose?.();
      for (const m of [].concat(o.material || [])) { for (const v of Object.values(m || {})) if (v?.isTexture) v.dispose(); m?.dispose?.(); }
    });
    renderer.dispose();
    renderer.forceContextLoss?.();
    renderer.domElement.remove();
  }

  return {
    dispose,
    reset() { if (home) { camera.position.copy(home.position); controls.target.copy(home.target); controls.update(); } },
    setWireframe(on) { wire = !!on; applyWire(wire); },
    setAutoRotate(on) { controls.autoRotate = !!on; },
    get wireframe() { return wire; },
    get autoRotate() { return controls.autoRotate; },
    onStatus(fn) { statusFn = fn; report(); },
    get status() { return statusLine(state); },
  };
}

/** The viewer window for a model on a machine (or at a url). The same file again raises its window. */
export function openModelViewer({ nodeId = 'self', nodeName = '', path = '', url = '', title = '', name = '', autoRotate = false } = {}) {
  const src = url || modelUrl(nodeId, path);
  name = name || String(path || url).split(/[\\/]/).pop().split(/[?#]/)[0] || 'model';
  const key = `${nodeId}|${path || url}`;
  const prev = open.get(key);
  if (prev && !prev.closed) { prev.raise(); return prev; }
  const stage = h('div', { class: 'mv-stage', tabindex: '0', 'aria-label': `3D view of ${name}` });
  const st = h('span', { class: 'ft-status muted mv-status', role: 'status', 'aria-live': 'polite' }, 'Loading…');
  const pressed = (btn, on) => { btn.setAttribute('aria-pressed', String(!!on)); btn.classList.toggle('on', !!on); };
  let v = null;
  const wireBtn = h('button', { class: 'tb', title: 'Wireframe', 'aria-pressed': 'false', onclick: () => { v?.setWireframe(!v.wireframe); pressed(wireBtn, v?.wireframe); } }, '⬡ Wireframe');
  const rotBtn = h('button', { class: 'tb', title: 'Turn the model slowly', 'aria-pressed': String(!!autoRotate), onclick: () => { v?.setAutoRotate(!v.autoRotate); pressed(rotBtn, v?.autoRotate); } }, '↻ Auto-rotate');
  const w = openWindow({
    title: `${title || name}${nodeName ? ' — ' + nodeName : ''}`, icon: '🧊', width: 900, height: 680, className: 'ft-win ft-win-model mv-win', key: `model:${key}`,
    onClose: () => { v?.dispose(); if (open.get(key) === w) open.delete(key); },
  });
  w.body.append(
    h('div', { class: 'toolbar ft-bar' },
      h('button', { class: 'tb', title: 'Reset the view', onclick: () => v?.reset() }, '⌂ Reset view'),
      wireBtn, rotBtn, st, h('span', { class: 'ft-grow' }),
      h('a', { class: 'tb', href: `${src}${src.includes('?') ? '&' : '?'}download=1`, download: name, title: 'Download the file' }, '⇩ Download')),
    stage);
  v = mountModelViewer(stage, src, { autoRotate, name, onStatus: (text, s) => { st.textContent = text; st.classList.toggle('bad', !!s.error); if (s.error) toast(`${name}: ${text}`, 'error'); } });
  if (autoRotate) pressed(rotBtn, true);
  open.set(key, w);
  w.onCleanup(() => { w.closed = true; });
  return w;
}
