import * as THREE from 'three';

// JARVIS's face: a procedural holographic head (no external model) with realtime lipsync.
//  - Lip shapes come from a viseme timeline (Kokoro sends phoneme timings with the audio; the stand-in voices do not, then the face follows the audio),
//    played against the AudioContext clock so mouth and sound stay locked together.
//  - Without a timeline (espeak, macOS say, browser speech) the live audio loudness and brightness
//    drive the mouth instead, so any voice still lip-syncs.
//  - Idle life: blinks, eye saccades, breathing sway; colour follows the JARVIS state.
//  - It looks at the mouse pointer (eyes lead, the head follows) and drifts back to idle when it rests.
//  - Expressions (setEmotion): smile/frown, eye openness, inner-eye tilt (worry), head tilt and nod.

const STATE_COLOR = { online: 0x5eead4, listening: 0x4ade80, thinking: 0xfbbf24, speaking: 0xc084fc, error: 0xf87171, offline: 0x64748b };

// Mouth parameters per viseme: [open (jaw), wide (corners out), round (pucker), press (lips together)]
export const VISEMES = {
  sil: [0.02, 0.0, 0.0, 0.3], PP: [0.0, 0.0, 0.1, 1.0], FF: [0.08, 0.15, 0.0, 0.6], TH: [0.15, 0.1, 0.0, 0.0],
  DD: [0.22, 0.15, 0.0, 0.0], kk: [0.3, 0.1, 0.0, 0.0], CH: [0.2, 0.0, 0.6, 0.0], SS: [0.1, 0.5, 0.0, 0.0],
  RR: [0.2, 0.0, 0.45, 0.0], aa: [0.85, 0.2, 0.0, 0.0], E: [0.5, 0.5, 0.0, 0.0], I: [0.28, 0.75, 0.0, 0.0],
  O: [0.6, 0.0, 0.8, 0.0], U: [0.25, 0.0, 1.0, 0.0],
};

// Expression targets: smile (-1 frown … 1 smile), eyes (openness ×), worry (inner eye corners up),
// tilt (head roll), nod (head pitch, + = down), jaw (resting mouth open), squint (lower lids up)
export const EXPRESSIONS = {
  neutral: { smile: 0, eyes: 1, worry: 0, tilt: 0, nod: 0, jaw: 0 },
  happy: { smile: 0.85, eyes: 0.82, worry: 0, tilt: 0.04, nod: -0.03, jaw: 0.04 },
  amused: { smile: 0.55, eyes: 0.72, worry: -0.25, tilt: 0.12, nod: 0, jaw: 0 },
  curious: { smile: 0.1, eyes: 1.18, worry: 0.15, tilt: -0.17, nod: -0.02, jaw: 0 },
  concerned: { smile: -0.35, eyes: 1.05, worry: 0.75, tilt: 0, nod: 0.03, jaw: 0 },
  sad: { smile: -0.7, eyes: 0.72, worry: 1, tilt: 0.06, nod: 0.09, jaw: 0 },
  surprised: { smile: 0, eyes: 1.45, worry: 0.4, tilt: 0, nod: -0.05, jaw: 0.3 },
  focused: { smile: -0.05, eyes: 0.74, worry: -0.2, tilt: 0, nod: 0.04, jaw: 0 },
};

const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
const gauss = (x, y, sx, sy) => Math.exp(-((x / sx) ** 2 + (y / sy) ** 2));

/**
 * Which mouth shape to show at time t (seconds into the sentence) from a cue list
 * [[start, end, viseme], …]. Blends into the next shape near the end of each cue (coarticulation)
 * and rests between words. `hint` is the last index (cues are scanned forwards). Pure.
 */
export function shapeAt(cues, t, hint = 0) {
  let i = Math.min(hint, cues.length - 1);
  while (i < cues.length - 1 && cues[i][1] <= t) i++;
  while (i > 0 && cues[i][0] > t) i--;
  const c = cues[i];
  if (!c || t < c[0] - 0.05 || t > c[1] + 0.12) return { shape: VISEMES.sil, i };
  const a = VISEMES[c[2]] || VISEMES.sil;
  const nx = cues[i + 1];
  if (nx && nx[0] - c[1] < 0.06) {
    const k = smooth(c[0] + (c[1] - c[0]) * 0.65, c[1], t) * 0.5;
    const b = VISEMES[nx[2]] || VISEMES.sil;
    return { shape: a.map((x, j) => x * (1 - k) + b[j] * k), i };
  }
  return { shape: a, i };
}

/** Sculpt one point of the unit sphere into the head. Returns [x, y, z, jawWeight]. */
function sculpt(px, py, pz) {
  let x = px * 0.72 * (1 + 0.07 * gauss(0, py - 0.05, 1, 0.45)); // widest at the cheekbones
  let y = py * 0.94;
  let z = pz * 0.86;
  if (y > 0.45) x *= 1 - 0.18 * (y - 0.45); // narrower crown
  if (y < -0.75) y = -0.75 - (-y - 0.75) * 0.55; // a rounded chin instead of an egg tip
  if (y < 0) { const k = 1 - 0.26 * Math.pow(-y, 1.8); x *= k; z *= 1 - 0.1 * Math.pow(-y, 2); } // jaw taper
  if (y > 0.2) z -= 0.05 * (y - 0.2); // forehead slopes back
  const front = smooth(0.15, 0.6, z);
  z += front * 0.3 * gauss(x, y + 0.1, 0.075, 0.2) * smooth(0.12, -0.25, y); // nose, growing towards the tip
  z += front * 0.06 * gauss(x, y + 0.29, 0.13, 0.045); // nostrils
  z += front * 0.06 * gauss(x, y - 0.27, 0.4, 0.045); // brow ridge
  z -= front * 0.09 * (gauss(x - 0.25, y - 0.13, 0.11, 0.075) + gauss(x + 0.25, y - 0.13, 0.11, 0.075)); // eye sockets
  z += front * 0.05 * (gauss(x - 0.4, y + 0.1, 0.12, 0.14) + gauss(x + 0.4, y + 0.1, 0.12, 0.14)); // cheekbones
  z -= front * 0.035 * gauss(x, y + 0.6, 0.22, 0.04); // groove under the lower lip
  z += front * 0.05 * gauss(x, y + 0.47, 0.18, 0.06); // lips
  z += front * 0.07 * gauss(x, y + 0.84, 0.17, 0.12); // chin
  return [x, y, z, smooth(-0.44, -0.6, y) * smooth(-0.1, 0.35, z)]; // jaw: below the mouth line, fading towards the ears
}

/**
 * The head as horizontal contour lines (a topographic hologram: the profile reads as it turns) plus a
 * faint shell for volume. Returns both geometries with their resting positions and jaw weights, and a
 * front-surface depth map so eyes and lips sit exactly on the skin.
 */
function buildHead() {
  const shell = new THREE.SphereGeometry(1, 96, 72);
  shell.rotateZ(Math.PI / 2); // poles at the ears
  const sp = shell.attributes.position;
  const shellJaw = new Float32Array(sp.count);
  for (let i = 0; i < sp.count; i++) {
    const [x, y, z, j] = sculpt(sp.getX(i), sp.getY(i), sp.getZ(i));
    sp.setXYZ(i, x, y, z);
    shellJaw[i] = j;
  }
  shell.computeVertexNormals();

  const LEVELS = 46;
  const SEG = 180;
  const pts = [];
  const nrm = [];
  const jaw = [];
  for (let l = 0; l < LEVELS; l++) {
    const py = -0.96 + (l / (LEVELS - 1)) * 1.92;
    const r = Math.sqrt(Math.max(0, 1 - py * py));
    let prev = null; // { p: [x, y, z], n: [x, y, z], j }
    for (let k = 0; k <= SEG; k++) {
      const th = (k / SEG) * Math.PI * 2;
      const [x, y, z, j] = sculpt(r * Math.sin(th), py, r * Math.cos(th));
      // true surface normal from the sculpt (so the nose, brows and sockets catch the light)
      const e = 0.004;
      const a1 = sculpt(r * Math.sin(th + e), py, r * Math.cos(th + e));
      const py2 = Math.min(0.999, py + e);
      const r2 = Math.sqrt(1 - py2 * py2);
      const a2 = sculpt(r2 * Math.sin(th), py2, r2 * Math.cos(th));
      const n = new THREE.Vector3(a1[0] - x, a1[1] - y, a1[2] - z).cross(new THREE.Vector3(a2[0] - x, a2[1] - y, a2[2] - z)).normalize();
      if (n.dot(new THREE.Vector3(x, y, z)) < 0) n.negate();
      const cur = { p: [x, y, z], n: [n.x, n.y, n.z], j };
      if (prev) { pts.push(...prev.p, ...cur.p); nrm.push(...prev.n, ...cur.n); jaw.push(prev.j, cur.j); }
      prev = cur;
    }
  }
  const contours = new THREE.BufferGeometry();
  contours.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pts), 3));
  contours.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(nrm), 3));

  // depth of the front surface on a grid
  const N = 64;
  const grid = new Float32Array(N * N).fill(-1);
  const cell = (c) => Math.max(0, Math.min(N - 1, Math.round((c + 1) / 2 * (N - 1))));
  for (let i = 0; i < sp.count; i++) {
    const k = cell(sp.getY(i)) * N + cell(sp.getX(i));
    if (sp.getZ(i) > grid[k]) grid[k] = sp.getZ(i);
  }
  const surfaceZ = (x, y) => {
    for (let r = 0; r < 4; r++) {
      for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
        const v = grid[Math.max(0, Math.min(N - 1, cell(y) + dy)) * N + Math.max(0, Math.min(N - 1, cell(x) + dx))];
        if (v > 0) return v;
      }
    }
    return 0.8;
  };
  return {
    parts: [
      { geometry: shell, jaw: shellJaw, base: Float32Array.from(sp.array) },
      { geometry: contours, jaw: Float32Array.from(jaw), base: Float32Array.from(contours.attributes.position.array) },
    ],
    surfaceZ,
  };
}

function holoMaterial(color, { points = false, alpha = 0.5 } = {}) {
  return new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    uniforms: { uColor: { value: new THREE.Color(color) }, uTime: { value: 0 }, uAlpha: { value: alpha } },
    vertexShader: `
      varying float vRim; varying float vY; varying float vLit;
      void main() {
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        vec3 n = normalize(normalMatrix * normal);
        vRim = 1.0 - abs(dot(n, normalize(-mv.xyz)));
        vLit = max(dot(n, normalize(vec3(-0.5, 0.7, 0.6))), 0.0); // key light from upper left: gives the features relief
        vY = position.y;
        gl_PointSize = ${points ? '1.5 * (3.0 / -mv.z)' : '1.0'};
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: `
      varying float vRim; varying float vY; varying float vLit;
      uniform vec3 uColor; uniform float uTime; uniform float uAlpha;
      void main() {
        float scan = 0.75 + 0.25 * sin(vY * 60.0 - uTime * 4.0);
        float a = (${points ? '0.03 + 0.9 * pow(vLit, 3.0) + 0.7 * pow(vRim, 2.0)' : '0.05 + 0.55 * vLit * vLit + pow(vRim, 2.4)'}) * scan * uAlpha;
        gl_FragColor = vec4(uColor, a);
      }`,
  });
}

import { lowPower } from './perf.js';

export function createFace(container) {
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(lowPower() ? 1.5 : 2, window.devicePixelRatio || 1));
  container.appendChild(renderer.domElement);
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(30, 1, 0.1, 20);
  camera.position.set(0, -0.05, 4.4);

  const head = new THREE.Group();
  scene.add(head);
  const { parts, surfaceZ } = buildHead();
  const shell = new THREE.Mesh(parts[0].geometry, holoMaterial(STATE_COLOR.online, { alpha: 0.28 }));
  const lines = new THREE.LineSegments(parts[1].geometry, holoMaterial(STATE_COLOR.online, { points: true, alpha: 0.95 }));
  head.add(shell, lines);

  // Eyes: glowing rings that blink and glance around
  const eyeMat = new THREE.MeshBasicMaterial({ color: STATE_COLOR.online, transparent: true, opacity: 0.95, blending: THREE.AdditiveBlending });
  const eyes = [-0.27, 0.27].map((x) => {
    const e = new THREE.Mesh(new THREE.RingGeometry(0.05, 0.065, 40), eyeMat);
    e.position.set(x * 0.93, 0.13, surfaceZ(x * 0.93, 0.13) + 0.012);
    e.scale.set(1.5, 0.62, 1); // almond-shaped glow rather than cartoon rings
    e.rotation.z = x < 0 ? -0.08 : 0.08;
    const pupil = new THREE.Mesh(new THREE.CircleGeometry(0.03, 24), eyeMat);
    pupil.scale.set(0.55, 1.3, 1);
    pupil.position.z = 0.002;
    e.add(pupil);
    head.add(e);
    return e;
  });

  // Lips: two glowing curves rebuilt every frame from the mouth parameters, dark mouth behind them
  const lipMat = new THREE.LineBasicMaterial({ color: STATE_COLOR.online, transparent: true, blending: THREE.AdditiveBlending });
  const LIP_N = 24;
  const lipLine = () => new THREE.Line(new THREE.BufferGeometry().setAttribute('position', new THREE.BufferAttribute(new Float32Array(LIP_N * 3), 3)), lipMat);
  const upper = lipLine();
  const lower = lipLine();
  const mouthFill = new THREE.Mesh(new THREE.CircleGeometry(1, 32), new THREE.MeshBasicMaterial({ color: 0x02060a, transparent: true, opacity: 0.85 }));
  const MOUTH_Y = -0.47;
  mouthFill.position.set(0, MOUTH_Y, surfaceZ(0, MOUTH_Y) + 0.004);
  const lipZ = Array.from({ length: 41 }, (_, i) => surfaceZ((i / 40) * 0.6 - 0.3, MOUTH_Y)); // across the mouth
  head.add(mouthFill, upper, lower);

  const color = new THREE.Color(STATE_COLOR.online);
  const targetColor = new THREE.Color(STATE_COLOR.online);
  const mouth = { open: 0, wide: 0, round: 0, press: 0 };
  let level = 0;
  let speech = null; // { cues, startAt, ctx, analyser, until, i }
  let blinkAt = performance.now() + 2500;
  let blink = 0;
  const gaze = new THREE.Vector2();
  const gazeTarget = new THREE.Vector2();
  let gazeAt = 0;
  let state = 'online';
  let disposed = false;
  // expression: current values ease toward the target emotion
  const expr = { ...EXPRESSIONS.neutral };
  let exprTarget = EXPRESSIONS.neutral;
  let exprUntil = 0;
  // mouse following: pointer position relative to the face (-1..1 across the viewport), last movement time
  const look = new THREE.Vector2();
  const lookTarget = new THREE.Vector2();
  let lookAt = 0;
  const onPointer = (e) => {
    const r = renderer.domElement.getBoundingClientRect();
    if (!r.width) return;
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height * 0.42; // roughly eye level
    lookTarget.set(Math.max(-1, Math.min(1, (e.clientX - cx) / (window.innerWidth * 0.5))), Math.max(-1, Math.min(1, (e.clientY - cy) / (window.innerHeight * 0.5))));
    lookAt = performance.now();
  };
  window.addEventListener('pointermove', onPointer, { passive: true });
  const freq = new Uint8Array(256);

  function resize() {
    const w = container.clientWidth || 190;
    const h = container.clientHeight || 190;
    renderer.setSize(w, h, false);
    renderer.domElement.style.width = w + 'px';
    renderer.domElement.style.height = h + 'px';
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }
  const ro = new ResizeObserver(resize);
  ro.observe(container);
  resize();

  function target() {
    if (speech && speech.ctx && speech.ctx.currentTime - speech.startAt > speech.until) speech = null;
    if (speech?.cues) {
      const r = shapeAt(speech.cues, speech.ctx.currentTime - speech.startAt, speech.i);
      speech.i = r.i;
      return r.shape;
    }
    if (speech?.analyser) {
      // No timeline: loudness opens the jaw, brightness (spectral centroid) picks wide vs round
      speech.analyser.getByteFrequencyData(freq);
      let sum = 0;
      let wsum = 0;
      for (let i = 2; i < 120; i++) { sum += freq[i]; wsum += freq[i] * i; }
      const loud = Math.min(1, sum / (118 * 140));
      const bright = smooth(18, 45, sum ? wsum / sum : 0);
      return [loud * 0.9, bright * loud * 1.2, (1 - bright) * loud * 0.8, loud < 0.04 ? 0.3 : 0];
    }
    return [level * 0.8, level * 0.3, 0, level < 0.03 ? 0.3 : 0];
  }

  function updateMouth() {
    const w = 0.2 * (1 + mouth.wide * 0.35 - mouth.round * 0.4);
    const open = mouth.open * 0.16 * (1 - mouth.press);
    const y0 = MOUTH_Y;
    const set = (line, sign) => {
      const a = line.geometry.attributes.position;
      for (let i = 0; i < LIP_N; i++) {
        const u = (i / (LIP_N - 1)) * 2 - 1; // -1..1 across the mouth
        const curve = 1 - u * u;
        const cupid = sign > 0 ? 0.012 * gauss(u, 0, 0.18, 1) : 0;
        const y = y0 + sign * (open * 0.5 * Math.pow(curve, 0.7 - mouth.round * 0.4) + 0.008 * curve + cupid) + mouth.wide * 0.015 * (1 - curve)
          + expr.smile * 0.075 * (u * u - 0.35); // corners up for a smile, down for a frown
        const zi = Math.max(0, Math.min(40, Math.round((u * w + 0.3) / 0.6 * 40)));
        a.setXYZ(i, u * w, y, lipZ[zi] + 0.015 + mouth.round * 0.05 * curve);
      }
      a.needsUpdate = true;
    };
    set(upper, 1);
    set(lower, -1);
    mouthFill.scale.set(w * 0.95, Math.max(0.001, open * 0.5), 1);
    mouthFill.visible = open > 0.01;
    // the jaw follows the mouth: drop the lower face
    const drop = mouth.open * 0.11 * (1 - mouth.press);
    for (const { geometry, jaw, base } of parts) {
      const pos = geometry.attributes.position;
      for (let i = 0; i < pos.count; i++) if (jaw[i] > 0.001) pos.setY(i, base[i * 3 + 1] - drop * jaw[i]);
      pos.needsUpdate = true;
    }
  }

  let last = performance.now();
  function frame(now) {
    if (disposed) return;
    requestAnimationFrame(frame);
    if (document.hidden) return;
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    const t = now / 1000;
    const tgt = [...target()]; // a copy: target() may hand back the shared VISEMES arrays
    if (exprUntil && now > exprUntil) { exprTarget = EXPRESSIONS.neutral; exprUntil = 0; }
    const ke = 1 - Math.exp(-dt * 5);
    for (const k of Object.keys(expr)) expr[k] += (exprTarget[k] - expr[k]) * ke;
    tgt[0] = Math.max(tgt[0], expr.jaw); // surprise drops the jaw a little even when silent
    const k = 1 - Math.exp(-dt * 28); // critically damped approach to the target shape
    mouth.open += (tgt[0] - mouth.open) * k;
    mouth.wide += (tgt[1] - mouth.wide) * k;
    mouth.round += (tgt[2] - mouth.round) * k;
    mouth.press += (tgt[3] - mouth.press) * k;
    updateMouth();
    if (now > blinkAt) { blink = 1; blinkAt = now + 2200 + Math.random() * 4200; }
    blink = Math.max(0, blink - dt * 7);
    const lid = blink > 0.5 ? (1 - blink) * 2 : blink * 2;
    eyes.forEach((e, i) => {
      e.scale.y = 0.62 * expr.eyes * Math.max(0.08, 1 - lid);
      e.rotation.z = (i ? 0.08 : -0.08) + (i ? -1 : 1) * expr.worry * 0.32; // inner corners up = worried
    });
    // Following the pointer for 4 s after it last moved, then easing back to the idle three-quarter view
    const following = now - lookAt < 4000;
    const kf = 1 - Math.exp(-dt * (following ? 7 : 1.5));
    look.x += ((following ? lookTarget.x : 0) - look.x) * kf;
    look.y += ((following ? lookTarget.y : 0) - look.y) * kf;
    const f = Math.min(1, (4000 - Math.min(4000, now - lookAt)) / 600); // 1 while following, fades to 0
    if (now > gazeAt) { gazeTarget.set((Math.random() - 0.5) * 0.03, (Math.random() - 0.5) * 0.02); gazeAt = now + 900 + Math.random() * 2600; }
    gaze.lerp(gazeTarget, 1 - Math.exp(-dt * 12));
    // eyes lead: pupils toward the pointer (wander when idle)
    const px = gaze.x * (1 - f) + look.x * 0.026 * f;
    const py = gaze.y * (1 - f) - look.y * 0.02 * f;
    for (const e of eyes) e.children[0].position.set(px, py, 0.002);
    const talk = Math.min(1, mouth.open * 1.5);
    const idleYaw = 0.28 + Math.sin(t * 0.35) * 0.16 + gaze.x * 2; // a three-quarter view reads as a face
    head.rotation.y = idleYaw * (1 - f) + look.x * 0.6 * f;
    head.rotation.x = Math.sin(t * 0.5) * 0.04 * (1 - f) + look.y * 0.38 * f - (state === 'thinking' ? 0.08 : 0) + talk * 0.02 * Math.sin(t * 9) + expr.nod;
    head.rotation.z = expr.tilt;
    head.position.y = Math.sin(t * 1.1) * 0.015;
    color.lerp(targetColor, 1 - Math.exp(-dt * 4));
    for (const m of [shell.material, lines.material]) { m.uniforms.uColor.value.copy(color); m.uniforms.uTime.value = t; }
    eyeMat.color.copy(color);
    lipMat.color.copy(color).multiplyScalar(1.3);
    renderer.render(scene, camera);
  }
  requestAnimationFrame(frame);

  return {
    el: renderer.domElement,
    /** Mic or speech level 0..1 (drives the mouth only when nothing is playing through Web Audio). */
    setLevel(v) { level = v; },
    setState(s) { state = s; targetColor.set(STATE_COLOR[s] ?? STATE_COLOR.online); },
    /**
     * A sentence starts playing. cues = [[start, end, viseme], …] in seconds from startAt (or null:
     * the analyser drives the mouth), startAt = AudioContext time the buffer starts.
     */
    speak({ cues, startAt, ctx, analyser, duration }) {
      speech = { cues: cues?.length ? cues : null, startAt, ctx, analyser, until: (duration || 60) + 0.2, i: 0 };
    },
    stop() { speech = null; },
    /** Show an emotion (EXPRESSIONS key); `hold` ms later it eases back to neutral (0 = keep). */
    setEmotion(name, { hold = 0 } = {}) {
      exprTarget = EXPRESSIONS[name] || EXPRESSIONS.neutral;
      exprUntil = hold ? performance.now() + hold : 0;
    },
    get emotion() { return Object.keys(EXPRESSIONS).find((k) => EXPRESSIONS[k] === exprTarget) || 'neutral'; },
    /** Free it for good: render loop, listeners, geometries, materials and the WebGL context. */
    dispose() {
      if (disposed) return;
      disposed = true;
      ro.disconnect();
      window.removeEventListener('pointermove', onPointer);
      scene.traverse((o) => { o.geometry?.dispose?.(); for (const m of [].concat(o.material || [])) m.dispose?.(); });
      renderer.dispose();
      renderer.forceContextLoss();
      renderer.domElement.remove();
    },
  };
}
