// The 3D viewer pulls in three's GLTFLoader, OBJLoader and OrbitControls, only needed once a model is opened, so
// model-viewer.js is a lazy chunk (bundled by esbuild like terminal.js: offline, no CDN).
export const openModelViewer = (...args) => import('./model-viewer.js').then((m) => m.openModelViewer(...args));
export const mountModelViewer = (...args) => import('./model-viewer.js').then((m) => m.mountModelViewer(...args));
