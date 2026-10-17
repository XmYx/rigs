import { EventEmitter } from 'node:events';
import { createInterface } from 'node:readline';
import { ControlError } from './control-error.js';

/** JSON-lines transport shared by stdio helpers and the macOS socket. Never replay input on failure. */
export class ControlRPC extends EventEmitter {
  constructor({ connect, timeout = 10000 }) {
    super();
    this.connect = connect;
    this.timeout = timeout;
    this.pending = new Map();
    this.nextId = 0;
    this.generation = 0;
  }

  async open() {
    if (this.stream) return;
    if (this.opening) return this.opening;
    const generation = this.generation;
    this.opening = (async () => {
      const io = await this.connect();
      if (generation !== this.generation) { io.destroy(); throw new ControlError('off', 'Control stopped'); }
      this.stream = io;
      const lines = createInterface({ input: io.read });
      this.lines = lines;
      lines.on('line', (line) => {
        let msg;
        try { msg = JSON.parse(line); } catch { return; }
        if (msg.event) { this.emit('event', msg); return; }
        const p = this.pending.get(msg.id);
        if (!p) return;
        this.pending.delete(msg.id);
        clearTimeout(p.timer);
        if (msg.ok) p.resolve(msg.result);
        else p.reject(new ControlError(msg.error?.code || 'error', msg.error?.message || 'Control helper failed', msg.error?.fix));
      });
      const failed = (err) => {
        if (this.stream !== io) return;
        this.close(new ControlError('no-session', err?.message || 'Control helper disconnected'));
        this.emit('event', { event: 'closed', reason: 'helper disconnected' });
      };
      io.read.on('error', failed);
      io.write.on('error', failed);
      io.onClose(failed);
    })().finally(() => { this.opening = null; });
    return this.opening;
  }

  async request(op, args = {}) {
    await this.open();
    const io = this.stream;
    if (!io) throw new ControlError('off', 'Control stopped');
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.close(new ControlError('timeout', `Control helper timed out during ${op}`)), this.timeout);
      this.pending.set(id, { resolve, reject, timer });
      io.write.write(JSON.stringify({ ...args, id, op, ...(io.token ? { token: io.token } : {}) }) + '\n');
    });
  }

  close(error = new ControlError('off', 'Control stopped')) {
    this.generation++;
    const io = this.stream;
    this.stream = null;
    this.lines?.close();
    this.lines = null;
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(error); }
    this.pending.clear();
    io?.destroy();
  }
}
