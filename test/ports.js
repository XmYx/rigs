// Ports for the throwaway servers tests start. Never a bare random one: 20000–40000 overlaps Linux's ephemeral range
// (32768+), where the machine's own outgoing connections and other tests' servers live, and the merge steward saw
// EADDRINUSE. Nor port 0: what the OS hands out is ephemeral too, and free again for anyone once it is closed. So: a
// random port below every OS's ephemeral range (Linux 32768+, macOS and Windows 49152+) that answers a bind right now.
// Not a test file itself (the suite runs test/*.test.js).
import net from 'node:net';

const LOW = 10000;
const SPAN = 10000;

const bindable = (port) => new Promise((resolve) => {
  const s = net.createServer();
  s.once('error', () => resolve(false)); // in use, or reserved (Windows excludes whole blocks: EACCES)
  s.listen(port, '127.0.0.1', () => s.close(() => resolve(true)));
});

/** `n` distinct ports, each free on 127.0.0.1 when picked. */
export async function freePorts(n = 1) {
  const out = [];
  for (let i = 0; out.length < n && i < 200; i++) {
    const port = LOW + Math.floor(Math.random() * SPAN);
    if (!out.includes(port) && await bindable(port)) out.push(port);
  }
  if (out.length < n) throw new Error(`no free port in ${LOW}–${LOW + SPAN - 1}`);
  return out;
}

export const freePort = async () => (await freePorts(1))[0];
