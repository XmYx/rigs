// Bundles ui/src → ui/dist (three.js, 3d-force-graph and xterm are bundled in, so the UI works
// offline inside the tailnet). Runs on `npm install` and after every self-update.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let esbuild;
try {
  esbuild = await import('esbuild');
} catch {
  console.warn('[rigs] esbuild not installed yet; skipping UI build');
  process.exit(0);
}

const watch = process.argv.includes('--watch');
// --soft (used by postinstall): never fail `npm install` because of the UI build.
const soft = process.argv.includes('--soft');
if (!fs.existsSync(path.join(root, 'ui/src/main.js'))) {
  console.warn('[rigs] ui/src not present; skipping UI build');
  process.exit(0);
}
const ctx = await esbuild.context({
  entryPoints: [path.join(root, 'ui/src/main.js')],
  bundle: true,
  format: 'esm',
  splitting: true, // lazy chunks (terminal/xterm) load on first use
  chunkNames: 'chunk-[hash]',
  minify: !watch,
  sourcemap: true,
  target: ['es2022'],
  outdir: path.join(root, 'ui/dist'),
  entryNames: 'app',
  loader: { '.woff2': 'file', '.svg': 'file' },
  logLevel: 'warning',
});
if (watch) {
  await ctx.watch();
  console.log('[rigs] watching ui/src …');
} else {
  try {
    await ctx.rebuild();
    console.log('[rigs] UI built → ui/dist');
  } catch (e) {
    console.error('[rigs] UI build failed:', e.message);
    if (!soft) process.exitCode = 1;
  } finally {
    await ctx.dispose();
  }
}
