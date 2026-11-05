#!/usr/bin/env node
// Home Security App Cloud app (id home-security). Contract: docs/home-security.md.
// This is the t1 stub: GET healthz answers, everything under api/ is 501 until t2/t3 implement it, and public/ (t4)
// is served with relative URLs only (the App Cloud reaches it under /api/nodes/<node>/apps/home-security/).
// Plain Node, no dependencies. Env: PORT (default 8749), HOST (default 127.0.0.1 — only the RIGS proxy may reach it),
// HOME_SECURITY_DATA (default <RIGS_HOME or ~/.rigs>/home-security).
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const APP_ID = 'home-security';
export const DEFAULT_PORT = 8749;
export const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'public');
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.ico': 'image/x-icon',
};

export function dataDir(env = process.env) {
  return env.HOME_SECURITY_DATA || path.join(env.RIGS_HOME || path.join(os.homedir(), '.rigs'), APP_ID);
}

function sendJson(res, status, data) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(data));
}

export function health() {
  return { ok: true, app: APP_ID, stub: true, node: os.hostname(), dataDir: dataDir() };
}

export function createServer() {
  return http.createServer((req, res) => {
    let p;
    try { p = decodeURIComponent(new URL(req.url, 'http://x').pathname); } catch { p = ''; }
    if (p === '/healthz') return sendJson(res, 200, health());
    if (p === '/api' || p.startsWith('/api/')) return sendJson(res, 501, { error: 'not implemented yet', contract: 'docs/home-security.md' });
    if (req.method !== 'GET' && req.method !== 'HEAD') return sendJson(res, 405, { error: 'method not allowed' });
    if (p === '/') p = '/index.html';
    const file = path.join(PUBLIC_DIR, path.normalize(p));
    const type = TYPES[path.extname(file)];
    if (!type || !file.startsWith(PUBLIC_DIR + path.sep) || !fs.existsSync(file)) return sendJson(res, 404, { error: 'not found' });
    res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' });
    fs.createReadStream(file).pipe(res);
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT) || DEFAULT_PORT;
  const host = process.env.HOST || '127.0.0.1';
  const server = createServer().listen(port, host, () => console.log(`${APP_ID} on http://${host}:${port}/`));
  for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => server.close(() => process.exit(0)));
}
