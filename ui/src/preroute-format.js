// Pre-routing wording and numbers for the UI (no DOM, tested in test/preroute-ui.test.js). The inputs are
// /api/preroute/stats (src/preroute-stats.js): per route class the off/on medians, router cost and the saving per
// request, which may be negative, and `estimated` while there is no off-mode baseline.

/** 4s · 1m 05s · 42 min · 1h 05m — for a magnitude in ms. */
export function span(ms) {
  const s = Math.round(Math.abs(Number(ms) || 0) / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return s < 600 ? `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s` : `${Math.round(s / 60)} min`;
  return `${Math.floor(s / 3600)}h ${String(Math.round((s % 3600) / 60)).padStart(2, '0')}m`;
}

/** Sub-10s values keep a decimal: 0.5s, 4.2s. */
export function span1(ms) {
  const a = Math.abs(Number(ms) || 0);
  return a < 10000 ? `${(a / 1000).toFixed(1)}s` : span(a);
}

/** +4.2s / −51.5s: the sign is always written, so a loss never depends on colour alone. null → —. */
export function signed(ms) {
  if (ms == null || !Number.isFinite(Number(ms))) return '—';
  const v = Number(ms);
  return `${v < 0 ? '−' : v > 0 ? '+' : '±'}${span1(v)}`;
}

/** 'good' | 'bad' | 'flat' | 'none' for a saving. */
export function tone(ms) {
  if (ms == null || !Number.isFinite(Number(ms))) return 'none';
  return ms > 500 ? 'good' : ms < -500 ? 'bad' : 'flat';
}

/** The headline: "42 min saved over 118 requests", or, when pre-routing cost time, "1m 45s lost over 3 requests". */
export function headline(stats) {
  const t = stats?.total;
  if (!t || !t.requests || t.savedMs == null) return { text: 'No pre-routed requests measured yet.', tone: 'none' };
  const n = `${t.requests} request${t.requests === 1 ? '' : 's'}`;
  const tn = tone(t.savedMs / t.requests); // a verdict per request, so a long window doesn't turn a small loss into "flat"
  if (tn === 'bad') return { text: `${span(t.savedMs)} lost over ${n}`, tone: 'bad', note: 'Pre-routing was slower than the brain filing work itself.' };
  if (tn === 'flat') return { text: `No difference over ${n}`, tone: 'flat' };
  return { text: `${span(t.savedMs)} saved over ${n}`, tone: 'good' };
}

const BASELINE = {
  measured: 'baseline measured with pre-routing off',
  config: 'baseline from config',
  'on-minus-router': 'baseline = pre-routed replies minus router time',
  history: 'baseline = median chat turn',
  none: 'no baseline yet',
};

/** One route class (answer | work) as rows for the panel; null when it has no requests at all. */
export function classView(name, c) {
  if (!c || (!c.on?.n && !c.off?.n)) return null;
  const off = c.off?.n ? `off ${span1(c.off.medianMs)} (${c.off.n})` : `off — (0)${c.baselineMs != null ? ` ~${span1(c.baselineMs)}` : ''}`;
  const on = c.on?.n ? `on ${span1(c.on.medianMs)} (${c.on.n})` : 'on — (0)';
  return {
    name, label: name === 'work' ? 'Work filed' : 'Answers', saved: c.savedPerRequestMs, tone: tone(c.savedPerRequestMs), estimated: !!c.estimated,
    savedText: c.savedPerRequestMs == null ? '—' : `${signed(c.savedPerRequestMs)}/req`,
    detail: `${off} → ${on}`,
    router: c.on?.n ? `router ${span1(c.on.routerMedianMs)}/req · ${span(c.on.routerTotalMs)} total` : '',
    baseline: BASELINE[c.baselineSource] || '',
  };
}

/** Half-widths (0–50, % of the bar) for a diverging bar: the larger saving fills one side of the centre line. */
export function barWidths(views) {
  const top = Math.max(1, ...views.map((v) => Math.abs(v.saved || 0)));
  return views.map((v) => Math.round((Math.abs(v.saved || 0) / top) * 50));
}

/** The mode line: "on · LocalJev" / "off — the brain files work itself". */
export function modeText(router) {
  if (!router) return '';
  if (router.preroute === false) return 'off — the brain files work itself';
  const eng = { jev: router.jevUrl ? 'LocalJev' : 'Jev (not reachable)', claude: 'Haiku', rules: 'keyword rules' }[router.engine] || router.engine || '';
  return `on${eng ? ' · ' + eng : ''}`;
}

/** What the route chip on a request says: pre-routed (with the route) or direct (pre-routing off). */
export function routeChip(e) {
  if (e.preroute === false || e.via === 'off') return { name: 'route direct', detail: `pre-routing off · ${e.title || 'the brain files work itself'}` };
  return { name: `route ${e.route}`, detail: `pre-routed${e.via ? ' · ' + e.via : ''} · ${e.continued ? 'continuing' : 'new'} · ${e.title || ''}` };
}
