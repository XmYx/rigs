#!/usr/bin/env node
// Vertex Cow applet: a spinning 3D cow drawn as green points. Serves public/ with relative URLs only
// (the App Cloud reaches it under /api/nodes/<node>/apps/vertex-cow/) and GET healthz -> {ok:true}.
// Plain Node, no dependencies, nothing fetched from outside. Env: PORT (default 8231), HOST (default 127.0.0.1).
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'public');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8' };

export function createServer() {
  return http.createServer((req, res) => {
    let p;
    try { p = decodeURIComponent(new URL(req.url, 'http://x').pathname); } catch { p = ''; }
    if (p === '/healthz') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end('{"ok":true}');
    }
    if (p === '/') p = '/index.html';
    const file = path.join(PUBLIC_DIR, path.normalize(p));
    const type = TYPES[path.extname(file)];
    if (!type || !file.startsWith(PUBLIC_DIR + path.sep) || !fs.existsSync(file)) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      return res.end('not found');
    }
    res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' });
    fs.createReadStream(file).pipe(res);
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT) || 8231;
  const host = process.env.HOST || '127.0.0.1';
  createServer().listen(port, host, () => console.log(`vertex-cow on http://${host}:${port}/`));
}
