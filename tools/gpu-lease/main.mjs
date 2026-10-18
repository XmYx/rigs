// GPU overseer VRAM lease (default http://127.0.0.1:8195). Acquire BEFORE loading a model and release in a finally
// block: acquiring may unload other apps' idle models by design. The lease is taken in the holder's name (client
// "comfyui" by default: the process that really holds the memory, so what it already loaded counts toward the need).
//   { "action": "acquire", "needMb": 18000, "client": "comfyui" }   { "action": "release" }   { "action": "status" }
const args = JSON.parse(process.env.RIGS_TOOL_ARGS || process.argv[2] || '{}');
const done = (o) => { console.log(JSON.stringify(o)); process.exit(o.ok ? 0 : 1); };

const action = String(args.action || 'status');
if (!['acquire', 'release', 'status'].includes(action)) done({ ok: false, error: 'action must be acquire, release or status' });
const url = String(args.url || 'http://127.0.0.1:8195').replace(/\/+$/, '');
if (!/^https?:\/\//i.test(url)) done({ ok: false, error: 'url must be http(s)://' });
const client = String(args.client || 'comfyui');
if (!/^[\w.-]{1,40}$/.test(client)) done({ ok: false, error: 'client must be a short name like comfyui' });
const timeoutS = Math.min(300, Math.max(1, Number(args.timeoutSec ?? 90)));
const needMb = Math.round(Number(args.needMb));
if (action === 'acquire' && !(needMb > 0 && needMb <= 1048576)) done({ ok: false, error: 'acquire needs needMb: the VRAM you need, in MB' });

const request = action === 'acquire' ? { method: 'POST', path: '/api/acquire', body: { client, need_mb: needMb, timeout: timeoutS } }
  : action === 'release' ? { method: 'POST', path: '/api/release', body: { client } } : { method: 'GET', path: '/healthz' };
if (args.dryRun) done({ ok: true, dryRun: true, plan: { url, ...request } });

try {
  const r = await fetch(url + request.path, {
    method: request.method, headers: request.body ? { 'content-type': 'application/json' } : {},
    body: request.body ? JSON.stringify(request.body) : undefined, signal: AbortSignal.timeout((action === 'acquire' ? timeoutS + 15 : 5) * 1000),
  });
  const text = await r.text();
  let j; try { j = JSON.parse(text); } catch { j = { raw: text.slice(0, 200) }; }
  if (!r.ok) done({ ok: false, status: r.status, error: j.error || `overseer answered HTTP ${r.status}` });
  if (action === 'acquire') done({ ok: !!j.ok, freeMb: j.free_mb ?? null, unloaded: j.unloaded || [], client, needMb });
  done({ ok: action === 'status' ? j.ok !== false : j.ok !== false, ...(action === 'status' ? { overseer: 'up' } : { released: client }), response: j });
} catch (e) {
  // No overseer is not an error for the caller's job: say so, so it can go ahead without a lease.
  done({ ok: false, unreachable: true, error: `GPU overseer at ${url} is not reachable: ${e.cause?.code || e.cause?.errors?.[0]?.code || e.cause?.message || e.message}` });
}
