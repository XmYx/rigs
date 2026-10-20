// Rendering budget. Phones, data-saver and low-memory devices get a lighter galaxy: pixel ratio 1, no bloom
// pass, fewer polygons and stars, no link particles by default, shorter layout simulation, and no WebGL face
// unless the user switched it on. Evaluated when the galaxy is created and again when the viewport changes class.

// Same query as PHONE_QUERY in mobile.js (not imported: this module must load in Node, where face.js is unit-tested).
const PHONE_QUERY = '(max-width: 640px), (max-height: 500px) and (pointer: coarse)';
const mq = globalThis.matchMedia?.(PHONE_QUERY);

export function lowPower() {
  const c = globalThis.navigator?.connection;
  return !!(mq?.matches || c?.saveData || (globalThis.navigator?.deviceMemory && globalThis.navigator.deviceMemory <= 2));
}

/** Call fn when the viewport changes power class; returns the unsubscribe. */
export function onPowerChange(fn) { mq?.addEventListener?.('change', fn); return () => mq?.removeEventListener?.('change', fn); }

/** Pixel ratio for WebGL canvases: the screen's, capped (1 on a low-power device, 2 otherwise). */
export function pixelRatio() { return lowPower() ? 1 : Math.min(2, globalThis.devicePixelRatio || 1); }
