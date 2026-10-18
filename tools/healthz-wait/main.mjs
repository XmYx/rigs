// Wait until a URL answers, then report the status. Same rule as the App Cloud health probe: any HTTP answer below
// 500 counts as up (a login wall still means the app runs); strict:true wants a 2xx. Network errors, timeouts and
// 5xx keep it waiting. { "url": "http://127.0.0.1:8732/healthz", "timeoutSec": 30 }
const args = JSON.parse(process.env.RIGS_TOOL_ARGS || process.argv[2] || '{}');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const done = (o) => { console.log(JSON.stringify(o)); process.exit(o.ok ? 0 : 1); };

const url = String(args.url || '');
if (!/^https?:\/\//i.test(url)) done({ ok: false, error: 'url is required and must be http(s)://' });
const timeoutSec = Math.min(540, Math.max(1, Number(args.timeoutSec ?? 30)));
const intervalMs = Math.min(10000, Math.max(100, Number(args.intervalMs ?? 500)));
const strict = args.strict === true;
if (args.dryRun) done({ ok: true, dryRun: true, plan: { url, timeoutSec, intervalMs, strict, up: strict ? '2xx' : '< 500' } });

const start = Date.now();
let attempts = 0;
let last = { status: null, error: 'no attempt finished' };
while (Date.now() - start < timeoutSec * 1000) {
  attempts++;
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(Math.min(5000, intervalMs * 10)), redirect: 'manual' });
    last = { status: r.status, error: '' };
    if (strict ? r.status >= 200 && r.status < 300 : r.status < 500) done({ ok: true, status: r.status, attempts, elapsedMs: Date.now() - start });
  } catch (e) {
    last = { status: null, error: e.cause?.code || e.cause?.errors?.[0]?.code || e.cause?.message || e.message };
  }
  await sleep(intervalMs);
}
done({ ok: false, status: last.status, lastError: last.error, attempts, elapsedMs: Date.now() - start, error: `${url} did not come up within ${timeoutSec}s` });
