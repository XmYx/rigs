// The cow as a cloud of points: surfaces of ellipsoids, tubes and curved horns, sampled at random.
// Procedural, so there is no mesh file or licence to carry. y is up, +x is the way the head points.
// buildCow(rand) takes any () => [0,1) source; the page passes a seeded one so the cow looks the same each load.

export function seeded(seed = 1) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function buildCow(rand = Math.random) {
  const pts = [];
  const gauss = () => (rand() + rand() + rand() - 1.5) * 2;
  // surface of an ellipsoid centred (cx,cy,cz) with radii (rx,ry,rz)
  const ellipsoid = (cx, cy, cz, rx, ry, rz, n) => {
    for (let i = 0; i < n; i++) {
      const x = gauss(), y = gauss(), z = gauss();
      const l = Math.hypot(x, y, z) || 1;
      pts.push([cx + rx * x / l, cy + ry * y / l, cz + rz * z / l]);
    }
  };
  // vertical tapered tube at (x,z) from y0 down to y1
  const leg = (x, z, y0, y1, r0, r1, n) => {
    for (let i = 0; i < n; i++) {
      const t = rand(), a = rand() * 2 * Math.PI, r = r0 + (r1 - r0) * t;
      pts.push([x + r * Math.cos(a), y0 + (y1 - y0) * t, z + r * Math.sin(a)]);
    }
  };
  // a horn: a tapering tube that leaves the head sideways (side = ±1) and curls up and forward
  const horn = (side, n) => {
    for (let i = 0; i < n; i++) {
      const t = rand(), a = rand() * 2 * Math.PI, r = 0.07 * (1 - t) + 0.015;
      const cx = 2.12 + 0.12 * t * t, cy = 2.3 + 0.32 * t * t, cz = side * (0.22 + 0.36 * t);
      pts.push([cx + r * Math.cos(a), cy + r * Math.sin(a), cz]);
    }
  };

  ellipsoid(0, 1.6, 0, 1.5, 0.8, 0.75, 2600);           // barrel
  ellipsoid(1.5, 1.85, 0, 0.55, 0.55, 0.52, 700);       // shoulders and neck
  ellipsoid(2.15, 1.95, 0, 0.48, 0.36, 0.33, 700);      // head
  ellipsoid(2.6, 1.78, 0, 0.22, 0.2, 0.24, 260);        // muzzle
  for (const s of [-1, 1]) {
    horn(s, 140);
    ellipsoid(2.0, 2.12, s * 0.48, 0.12, 0.05, 0.2, 90); // ear, sticking out sideways
  }
  for (const [x, z] of [[1.0, 0.4], [1.0, -0.4], [-1.0, 0.4], [-1.0, -0.4]]) {
    leg(x, z, 1.4, 0.1, 0.22, 0.14, 420);
    leg(x, z, 0.1, 0.0, 0.17, 0.17, 40);                 // hoof
  }
  ellipsoid(-0.6, 1.0, 0, 0.42, 0.22, 0.32, 200);       // udder
  for (const z of [-0.12, 0.12]) for (const x of [-0.72, -0.48]) leg(x, z, 0.85, 0.7, 0.04, 0.03, 12); // teats
  leg(-1.5, 0, 2.0, 1.0, 0.05, 0.03, 120);             // tail
  ellipsoid(-1.5, 0.9, 0, 0.08, 0.18, 0.08, 50);        // tail tuft

  for (const p of pts) { p[0] -= 0.4; p[1] -= 1.25; }   // centre roughly on the origin
  return pts;
}
