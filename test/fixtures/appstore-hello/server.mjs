// A tiny App Store test app (test/smoke.test.js installs it): answers /healthz and / on HELLO_PORT.
import http from 'node:http';

const port = Number(process.env.HELLO_PORT);
http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
  res.end(req.url === '/healthz' ? 'ok' : 'hello from the app store');
}).listen(port, '127.0.0.1');
