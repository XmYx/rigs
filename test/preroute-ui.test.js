// The wording and numbers behind the Pre-routing section of the Tokens & time panel and the route chip
// (ui/src/preroute-format.js). Pure: the stats are shaped like src/preroute-stats.js output. No browser.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { barWidths, classView, headline, modeText, routeChip, signed, span, span1, tone } from '../ui/src/preroute-format.js';

const cls = (o) => ({ off: { n: 0, medianMs: null }, on: { n: 0, medianMs: null, routerMedianMs: null, routerTotalMs: 0 }, baselineMs: null, baselineSource: 'none', estimated: true, savedPerRequestMs: null, totalSavedMs: null, ...o });

test('durations: seconds, minutes and hours, one decimal under 10 s', () => {
  assert.equal(span(4200), '4s');
  assert.equal(span(65_000), '1m 05s');
  assert.equal(span(42 * 60_000), '42 min');
  assert.equal(span(3_900_000), '1h 05m');
  assert.equal(span1(4200), '4.2s');
  assert.equal(span1(51_532), '52s');
});

test('a saving always carries its sign, and a loss a real minus', () => {
  assert.equal(signed(4200), '+4.2s');
  assert.equal(signed(-51_532), '−52s');
  assert.equal(signed(0), '±0.0s');
  assert.equal(signed(null), '—');
  assert.deepEqual([tone(4200), tone(-4200), tone(100), tone(null)], ['good', 'bad', 'flat', 'none']);
});

test('headline: saved, lost (honest, with a note), none yet', () => {
  assert.deepEqual(headline({ total: { savedMs: 42 * 60_000, requests: 118 } }), { text: '42 min saved over 118 requests', tone: 'good' });
  const bad = headline({ total: { savedMs: -105_288, requests: 3 } });
  assert.equal(bad.text, '1m 45s lost over 3 requests');
  assert.equal(bad.tone, 'bad');
  assert.match(bad.note, /slower/);
  assert.equal(headline({ total: { savedMs: 100, requests: 1 } }).tone, 'flat');
  assert.equal(headline({ total: { savedMs: null, requests: 0 } }).tone, 'none');
  assert.equal(headline(null).tone, 'none');
  assert.equal(headline({ total: { savedMs: 5000, requests: 1 } }).text, '5s saved over 1 request');
});

test('class rows: measured, estimated and empty', () => {
  const measured = classView('answer', cls({ off: { n: 2, medianMs: 7306 }, on: { n: 2, medianMs: 58_838, routerMedianMs: 4471, routerTotalMs: 8942 }, baselineMs: 7306, baselineSource: 'measured', estimated: false, savedPerRequestMs: -51_532 }));
  assert.equal(measured.savedText, '−52s/req');
  assert.equal(measured.tone, 'bad');
  assert.equal(measured.estimated, false);
  assert.equal(measured.detail, 'off 7.3s (2) → on 59s (2)');
  assert.equal(measured.router, 'router 4.5s/req · 9s total');
  const est = classView('work', cls({ on: { n: 1, medianMs: 10_097, routerMedianMs: 2148, routerTotalMs: 2148 }, baselineMs: 7873, baselineSource: 'history', savedPerRequestMs: -2224 }));
  assert.equal(est.label, 'Work filed');
  assert.equal(est.estimated, true);
  assert.equal(est.detail, 'off — (0) ~7.9s → on 10s (1)');
  assert.match(est.baseline, /median chat turn/);
  assert.equal(classView('answer', cls({})), null);
  assert.equal(classView('answer', undefined), null);
});

test('diverging bars: the larger class fills half the bar, the sign decides the side', () => {
  assert.deepEqual(barWidths([{ saved: -50_000 }, { saved: 25_000 }, { saved: null }]), [50, 25, 0]);
  assert.deepEqual(barWidths([]), []);
});

test('mode line', () => {
  assert.equal(modeText({ preroute: false, engine: 'jev' }), 'off — the brain files work itself');
  assert.equal(modeText({ preroute: true, engine: 'jev', jevUrl: 'http://127.0.0.1:8198' }), 'on · LocalJev');
  assert.equal(modeText({ preroute: true, engine: 'jev', jevUrl: '' }), 'on · Jev (not reachable)');
  assert.equal(modeText({ preroute: true, engine: 'claude' }), 'on · Haiku');
  assert.equal(modeText(null), '');
});

test('route chip says whether pre-routing was used', () => {
  const on = routeChip({ route: 'implement', via: 'jev', preroute: true, continued: false, title: 'Dark mode' });
  assert.equal(on.name, 'route implement');
  assert.equal(on.detail, 'pre-routed · jev · new · Dark mode');
  assert.match(routeChip({ route: 'continue', via: 'rules', preroute: true, continued: true, title: 'Weather' }).detail, /continuing/);
  const off = routeChip({ route: 'direct', via: 'off', preroute: false, title: 'Dark mode' });
  assert.equal(off.name, 'route direct');
  assert.match(off.detail, /^pre-routing off/);
});
