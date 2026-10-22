// Pure parts of the 3D viewer (model-viewer.js): which loader a file needs, the camera framing maths for a bounding
// box, the triangle count and the status line. No three.js here, so tests run it in Node (test/model-viewer.test.js).

export const MODEL_EXT = /\.(glb|gltf|obj)$/i;
export const isModelFile = (name) => MODEL_EXT.test(String(name || '').split(/[\\/]/).pop() || '');

/** 'gltf' (glb and gltf, GLTFLoader) | 'obj' (OBJLoader) | null. */
export function loaderFor(name) {
  const e = (/\.([^./\\]+)$/.exec(String(name || '').split(/[?#]/)[0]) || [])[1]?.toLowerCase();
  if (e === 'glb' || e === 'gltf') return 'gltf';
  if (e === 'obj') return 'obj';
  return null;
}

/**
 * Where to put a perspective camera so a box { min: [x,y,z], max: [x,y,z] } fills the view: its centre, the size,
 * the distance along the view direction (fov in degrees, aspect = width / height) with some margin, and near / far.
 * An empty or degenerate box frames a unit cube.
 */
export function frameBox(box, { fov = 45, aspect = 1, margin = 1.25 } = {}) {
  const min = box?.min || [0, 0, 0];
  const max = box?.max || [0, 0, 0];
  const size = [0, 1, 2].map((i) => Math.max(0, (Number(max[i]) || 0) - (Number(min[i]) || 0)));
  const center = [0, 1, 2].map((i) => ((Number(min[i]) || 0) + (Number(max[i]) || 0)) / 2);
  let radius = Math.hypot(...size) / 2;
  if (!Number.isFinite(radius) || radius <= 0) radius = Math.sqrt(3) / 2; // a unit cube
  const vfov = (Math.max(1, Math.min(179, fov)) * Math.PI) / 180;
  const hfov = 2 * Math.atan(Math.tan(vfov / 2) * Math.max(0.1, aspect));
  const fit = Math.min(vfov, hfov);
  const distance = (radius / Math.sin(fit / 2)) * margin;
  return { center, size, radius, distance, near: Math.max(distance / 1000, radius / 100), far: distance + radius * 10 };
}

/** Triangles in one geometry: indexed → index / 3, else positions / 3. */
export const trianglesOf = ({ indexCount = 0, positionCount = 0 } = {}) => Math.floor((indexCount || positionCount || 0) / 3);

/** 1234567 → "1.2M", 45678 → "45.7k", 123 → "123". */
export function fmtCount(n) {
  n = Number(n) || 0;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1).replace(/\.0$/, '')}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1).replace(/\.0$/, '')}k`;
  return String(n);
}

const fmtBytes = (b) => (b >= 1024 * 1024 ? `${(b / 1024 / 1024).toFixed(1)} MB` : b >= 1024 ? `${Math.round(b / 1024)} kB` : `${b} B`);

/** The status line under the canvas: "12.3k triangles · 4 meshes · 2.1 MB · 1.20 × 0.80 × 0.45" or the error. */
export function statusLine({ loading = false, error = '', triangles = 0, meshes = 0, bytes = 0, size = null } = {}) {
  if (error) return `Could not load: ${error}`;
  if (loading) return 'Loading…';
  const parts = [`${fmtCount(triangles)} triangles`, `${meshes} mesh${meshes === 1 ? '' : 'es'}`];
  if (bytes > 0) parts.push(fmtBytes(bytes));
  if (size && size.some((x) => x > 0)) parts.push(size.map((x) => (x >= 100 ? x.toFixed(0) : x >= 10 ? x.toFixed(1) : x.toFixed(2))).join(' × '));
  return parts.join(' · ');
}

/** The files raw endpoint for a model on a machine (how finder-preview loads images and video). */
export const modelUrl = (nodeId, path) => `/api/nodes/${encodeURIComponent(nodeId || 'self')}/files/raw?path=${encodeURIComponent(path)}`;
