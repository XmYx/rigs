import { ControlError } from './control-error.js';

/**
 * HTTP layer for src/control.js: /api/local/control/* (and, through the mesh proxy, /api/nodes/<id>/control/*),
 * the caller identity the gate and audit log rely on, and the announcements that make every action visible
 * (WebSocket event, attention item, native notification, spoken notice). See docs/full-access.md §6–§7.
 */

const OPS_THAT_ACT = new Set(['pointer', 'type', 'key', 'focus']);
const OPS_SEEN = new Set(['screenshot', 'windows', 'pointer', 'type', 'key', 'focus']);

function httpError(status, code, message) {
  const e = new ControlError(code, message);
  e.status = status;
  return e;
}

/**
 * Who is calling. MCP tools send x-rigs-caller (agent, session, seat, cwd); a request without it comes from a
 * person at the UI or the CLI. The proxy sets x-rigs-via to the node the request entered the mesh on.
 */
export function controlCaller(req, nodeName) {
  const h = req?.headers || {};
  let agent = null;
  if (h['x-rigs-caller']) {
    try { agent = JSON.parse(h['x-rigs-caller']); } catch { agent = {}; }
    if (!agent || typeof agent !== 'object' || Array.isArray(agent)) agent = {};
  }
  return {
    via: agent ? 'mcp' : req?.rigsAuth?.via || 'local',
    who: req?.rigsAuth?.who,
    from: String(h['x-rigs-via'] || '') || nodeName,
    agent: agent?.agent || undefined,
    session: agent?.session || undefined,
    seat: agent?.seat || undefined,
    cwd: agent?.cwd || undefined,
    human: !agent,
  };
}

const num = (v, name) => {
  if (v == null || v === '') return undefined;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new ControlError('bad-args', `${name} must be a number`);
  return n;
};
const idOf = (v) => (v == null || v === '' ? undefined : /^-?\d+$/.test(v) ? Number(v) : v);

function parseRegion(v) {
  if (!v) return undefined;
  const p = String(v).split(',').map(Number);
  if (p.length !== 4 || p.some((x) => !Number.isFinite(x))) throw new ControlError('bad-args', 'region must be x,y,width,height');
  return { x: p[0], y: p[1], width: p[2], height: p[3] };
}

/**
 * Route handler: `handle(sub, req, res, q, body)` where sub is the path after `control` ('' | 'screenshot' | …).
 * `res` is null when the daemon calls itself; screenshots then come back as JSON with base64 data.
 */
export function createControlApi({ control, access, nodeName }) {
  return async function handle(sub, req, res, q, body) {
    const method = req.method;
    const caller = controlCaller(req, nodeName());
    const need = (m) => { if (method !== m) throw httpError(405, 'bad-args', `${m} required`); };
    switch (sub) {
      case '': need('GET'); return control.status({ force: q.get('force') === '1' });
      case 'windows': need('GET'); return control.listWindows(caller);
      case 'check': need('GET'); return control.check(q.get('op') || 'pointer', caller);
      case 'audit': need('GET'); return control.auditTail({ limit: num(q.get('limit'), 'limit') ?? 50 });
      case 'screenshot': {
        need('GET');
        const shot = await control.screenshot({
          display: idOf(q.get('display')), window: idOf(q.get('window')), region: parseRegion(q.get('region')),
          maxWidth: num(q.get('maxWidth'), 'maxWidth'), format: q.get('format') || undefined, quality: num(q.get('quality'), 'quality'),
        }, caller);
        const { data, ...meta } = shot;
        if (!res) return { ...meta, data: data.toString('base64') };
        res.writeHead(200, {
          'content-type': shot.mime || 'image/png', 'content-length': data.length, 'cache-control': 'no-store',
          'x-rigs-shot': String(meta.shot ?? ''), 'x-rigs-scale': String(meta.scale ?? 1), 'x-rigs-display': String(meta.display ?? ''),
          'x-rigs-width': String(meta.width ?? ''), 'x-rigs-height': String(meta.height ?? ''), 'x-rigs-region': meta.region ? JSON.stringify(meta.region) : '',
        });
        res.end(data);
        return undefined;
      }
      case 'focus': { need('POST'); const b = await body(); return control.focusWindow(b.id, caller); }
      case 'pointer': { need('POST'); return control.pointer(await body(), caller); }
      case 'type': { need('POST'); const b = await body(); return control.typeText(b.text, { delayMs: b.delayMs, secret: !!b.secret }, caller); }
      case 'key': { need('POST'); const b = await body(); return control.key(b.combo, { repeat: b.repeat }, caller); }
      case 'enable': { need('POST'); return control.enable(await body(), caller); }
      case 'kill': { need('POST'); const b = await body(); return control.kill({ reason: b.reason }, caller); }
      case 'grant': {
        need('POST');
        const b = await body();
        if (typeof b.permission !== 'string' || !b.permission) throw new ControlError('bad-args', 'permission is required');
        return access.grant(b.permission);
      }
      default: throw httpError(404, 'bad-args', `unknown control route ${sub}`);
    }
  };
}

const short = (v, n = 80) => { const s = typeof v === 'string' ? v : JSON.stringify(v ?? ''); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
const who = (h = {}) => [h.agent || h.who || 'someone', h.from ? `on ${h.from}` : ''].filter(Boolean).join(' ');

/**
 * Makes every control action visible: a live WebSocket event for each action, a notice (UI + native + spoken)
 * when a lease starts, ends or control is killed, and an attention item while someone holds the screen.
 * Returns `{ items }` for attention.addSource.
 */
export function wireControlEvents({ events, nodeName, settings, broadcast, notifyAll, osNotify, log = () => {} }) {
  let active = null; // { holder, since, actions, last, acted }
  const safe = (p) => Promise.resolve(p).catch((e) => log('control announce:', e.message));
  const quiet = () => settings().announce === 'off';

  events.on('lease', (l) => {
    if (l.phase === 'start') {
      active = { holder: l.holder, since: l.since, actions: 0, last: 'started', acted: false };
      if (quiet()) return;
      const verb = settings().input ? 'taking control of' : 'looking at';
      safe(notifyAll({ text: `${who(l.holder)} is ${verb} ${nodeName()}'s screen.`, level: 'attention', speak: true, from: nodeName() }));
      safe(osNotify('JARVIS is controlling this screen', `${who(l.holder)} is ${verb} this machine's screen. Stop it from JARVIS.`));
    } else {
      const n = active?.actions ?? l.actions ?? 0;
      active = null;
      if (!quiet()) safe(notifyAll({ text: `${who(l.holder)} released ${nodeName()}'s screen after ${n} actions.`, level: 'info', speak: false, from: nodeName() }));
    }
  });
  events.on('action', (a) => {
    if (a.ok && active && OPS_SEEN.has(a.op)) {
      active.actions++; active.last = `${a.op} ${short(a.args, 60)}`;
      if (OPS_THAT_ACT.has(a.op)) active.acted = true;
    }
    broadcast({ type: 'control', node: nodeName(), op: a.op, ok: a.ok, summary: `${a.op} ${short(a.args)}${a.ok ? '' : ` — refused: ${a.error?.code}`}`, by: who(a.caller), at: a.ts });
    if (settings().announce === 'every' && a.ok && OPS_SEEN.has(a.op)) safe(osNotify('JARVIS is controlling this screen', `${a.op} ${short(a.args, 100)}`));
  });
  events.on('kill', (k) => {
    active = null;
    safe(notifyAll({ text: `Screen control on ${nodeName()} was stopped${k.by?.agent || k.by?.who ? ` by ${who(k.by)}` : ''}.`, level: 'attention', speak: true, from: nodeName() }));
    safe(osNotify('Screen control stopped', `Control of this machine's screen is off${k.reason ? `: ${k.reason}` : ''}.`));
  });
  events.on('change', (c) => {
    broadcast({ type: 'control', node: nodeName(), op: 'config', ok: true, summary: `access ${c.enabled ? 'on' : 'off'}, input ${c.input ? 'on' : 'off'}`, by: who(c.caller) });
    if (c.enabled) safe(notifyAll({ text: `Screen ${c.input ? 'access and control are' : 'access is'} now on for ${nodeName()}.`, level: 'attention', speak: true, from: nodeName() }));
  });

  return {
    items: () => (active ? [{
      key: `control:${nodeName()}`, kind: 'control', agent: active.holder?.agent || 'agent',
      title: active.acted ? 'JARVIS is controlling this screen' : 'JARVIS is watching this screen', reason: active.last,
      since: active.since, actions: active.actions, session: null, stop: { method: 'POST', path: 'control/kill' },
    }] : []),
  };
}
