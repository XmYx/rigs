// Time saved by pre-routing (config.router.preroute, src/router.js). Every request from Sir leaves one "request" record in
// the usage ledger (chat.jarvisSend → usage.recordRequest) with its timing: preroute on/off, route, routerMs,
// timeToFiledMs (intake → first work filed, by the router or by the brain's jarvis_task / project_create) and
// timeToReplyMs (intake → the brain's final reply). prerouteStats turns those into time saved per route class.
//
// Route classes: "work" = a request that filed work (or was routed implement / plan); "answer" = everything else.
// Latency per request: work → timeToFiledMs (when the work was set in motion; the reply if nothing was filed), answer →
// timeToReplyMs. Both are measured from intake, so a pre-routed request's latency already includes the router's cost.
//
// Saved per request = baseline − median latency with pre-routing on. The baseline is the median latency with
// pre-routing off, measured. While there are no "off" samples for a class it is estimated, and the result says so
// (estimated: true, baselineSource):
//   config            config.router.baselineMs[class] when set (> 0)
//   on-minus-router   answers: the pre-routed replies minus their router time (the same brain turn, no router in front)
//   history           work: the median JARVIS chat-turn duration in the ledger (a brain turn that decides and files)
//   none              nothing to go on: saved is null
// Savings can be negative: pre-routing an answer costs the router's time and saves nothing, and the figure says so.
import { config } from './config.js';
import { parseTime, readRecords } from './usage.js';

export const CLASSES = ['answer', 'work'];

/** Median of the finite numbers in xs, rounded; null when there are none. Pure. */
export function median(xs) {
  const v = xs.filter((x) => x != null && Number.isFinite(Number(x))).map(Number).sort((a, b) => a - b);
  if (!v.length) return null;
  const mid = v.length >> 1;
  return Math.round(v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2);
}

/** A request record's timing block (records carry it in `request`; bare timing objects are accepted too). Pure. */
const timingOf = (r) => r?.request || r || {};

/** "work" or "answer" for one request record. Pure. */
export function routeClass(r) {
  const t = timingOf(r);
  return t.timeToFiledMs != null || ['implement', 'plan'].includes(t.route) ? 'work' : 'answer';
}

/** The latency that counts for a request of its class, or null when it never got that far. Pure. */
export function latencyOf(r) {
  const t = timingOf(r);
  return routeClass(r) === 'work' ? (t.timeToFiledMs ?? t.timeToReplyMs ?? null) : (t.timeToReplyMs ?? null);
}

/** Historical brain-turn time from ledger records: the median duration of finished JARVIS chat turns. Pure. */
export function historyFrom(records) {
  const turns = records.filter((r) => r.kind === 'chat-turn' && r.status === 'done' && r.durationMs > 0).map((r) => r.durationMs);
  return { chatTurnMedianMs: median(turns), chatTurnN: turns.length };
}

/** Several machines' histories → one (medians weighted by their sample counts; an estimate either way). Pure. */
export function mergeHistory(list) {
  const ok = list.filter((h) => h && h.chatTurnN > 0 && h.chatTurnMedianMs != null);
  const n = ok.reduce((a, h) => a + h.chatTurnN, 0);
  return { chatTurnMedianMs: n ? Math.round(ok.reduce((a, h) => a + h.chatTurnMedianMs * h.chatTurnN, 0) / n) : null, chatTurnN: n };
}

/**
 * Request records → time saved by pre-routing, per route class and in total. Pure.
 * opts.baselineMs: { answer, work } configured baselines (0 = none); opts.history: historyFrom(…) for the estimate.
 */
export function prerouteStats(records, { baselineMs = {}, history = {} } = {}) {
  // A YOLO run (route 'yolo', src/yolo.js) is a build shown live, not an answer: it would only skew the answer medians.
  const reqs = records.filter((r) => (r.kind ? r.kind === 'request' : true) && timingOf(r).route !== 'yolo' && latencyOf(r) != null);
  const classes = {};
  for (const c of CLASSES) {
    const mine = reqs.filter((r) => routeClass(r) === c);
    const off = mine.filter((r) => timingOf(r).preroute === false);
    const on = mine.filter((r) => timingOf(r).preroute !== false);
    const offMedian = median(off.map(latencyOf));
    const onMedian = median(on.map(latencyOf));
    const routerMs = on.map((r) => Number(timingOf(r).routerMs) || 0);
    let baseline = offMedian;
    let source = 'measured';
    if (baseline == null) {
      if (Number(baselineMs[c]) > 0) { baseline = Math.round(Number(baselineMs[c])); source = 'config'; }
      else if (c === 'answer') { baseline = median(on.map((r) => latencyOf(r) - (Number(timingOf(r).routerMs) || 0))); source = 'on-minus-router'; }
      else { baseline = history.chatTurnMedianMs ?? null; source = 'history'; }
      if (baseline == null) source = 'none';
    }
    const saved = baseline != null && onMedian != null ? baseline - onMedian : null;
    classes[c] = {
      off: { n: off.length, medianMs: offMedian },
      on: { n: on.length, medianMs: onMedian, routerMedianMs: median(routerMs), routerTotalMs: routerMs.reduce((a, b) => a + b, 0) },
      baselineMs: baseline, baselineSource: source, estimated: source !== 'measured',
      savedPerRequestMs: saved, totalSavedMs: saved == null ? null : saved * on.length,
    };
  }
  const counted = CLASSES.filter((c) => classes[c].totalSavedMs != null);
  const requests = counted.reduce((a, c) => a + classes[c].on.n, 0);
  const savedMs = counted.reduce((a, c) => a + classes[c].totalSavedMs, 0);
  return {
    requests: reqs.length,
    preroute: { on: reqs.filter((r) => timingOf(r).preroute !== false).length, off: reqs.filter((r) => timingOf(r).preroute === false).length },
    estimated: counted.some((c) => classes[c].estimated && classes[c].on.n > 0),
    classes,
    total: { savedMs, requests, savedPerRequestMs: requests ? Math.round(savedMs / requests) : null },
  };
}

/** Raw inputs for the stats from this machine's ledger (query: since, default 30d; until). */
export async function localInputs(q = {}) {
  const since = parseTime(q.since || '30d');
  const until = parseTime(q.until);
  const recs = await readRecords({ since: since || 0, until: until ?? Infinity });
  return { since, until, records: recs.filter((r) => r.kind === 'request'), history: historyFrom(recs) };
}

/** GET /api/local/preroute/stats: this machine's numbers; records=1 also returns the raw records (the mesh view merges them). */
export async function report(q = {}) {
  const { since, until, records, history } = await localInputs(q);
  const r = config().router || {};
  return {
    node: config().name, since, until, preroute: r.preroute !== false, engine: r.engine || '',
    ...prerouteStats(records, { baselineMs: r.baselineMs || {}, history }), history,
    ...(q.records === '1' || q.records === true ? { records } : {}),
  };
}

/** Mesh view (GET /api/preroute/stats): results = [{ node, report } | { node, error }] of report({ records: 1 }). Pure. */
export function aggregateStats(results, { baselineMs = {} } = {}) {
  const ok = results.filter((r) => !r.error && r.report);
  const records = ok.flatMap((r) => r.report.records || []);
  const history = mergeHistory(ok.map((r) => r.report.history));
  return {
    nodes: ok.map((r) => r.node.name), errors: results.filter((r) => r.error).map((r) => ({ node: r.node.name, error: r.error })),
    byNode: Object.fromEntries(ok.map((r) => [r.node.name, { requests: r.report.requests, preroute: r.report.preroute, total: r.report.total }])),
    ...prerouteStats(records, { baselineMs, history }), history,
  };
}
