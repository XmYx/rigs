// Top menu bar tray: the pure helpers (clock text, month grid, limit tone/view) and the item registry's ordering.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { clampPct, formatClock, limitTone, limitView, monthGrid, msToNextMinute, parseHour12, shiftMonth, untilText } from '../ui/src/tray-model.js';
import { createTrayRegistry } from '../ui/src/tray-registry.js';

test('formatClock: 24h pads, 12h wraps midnight and noon', () => {
  assert.equal(formatClock(new Date(2026, 9, 20, 9, 5)), '09:05');
  assert.equal(formatClock(new Date(2026, 9, 20, 0, 0), true), '12:00 AM');
  assert.equal(formatClock(new Date(2026, 9, 20, 12, 30), true), '12:30 PM');
  assert.equal(formatClock(new Date(2026, 9, 20, 23, 59), true), '11:59 PM');
});

test('msToNextMinute lands on the minute and never returns 0', () => {
  assert.equal(msToNextMinute(60000 * 5 + 15000), 45000);
  assert.equal(msToNextMinute(60000 * 5), 60000);
});

test('parseHour12 only accepts h12', () => {
  assert.equal(parseHour12('h12'), true);
  assert.equal(parseHour12('h24'), false);
  assert.equal(parseHour12(null), false);
});

test('monthGrid: Monday-first, weeks of 7, today flagged once, neighbours dimmed', () => {
  const g = monthGrid(2026, 9, new Date(2026, 9, 20)); // October 2026 starts on a Thursday
  assert.ok(g.every((w) => w.length === 7));
  assert.equal(g[0][3].day, 1);
  assert.equal(g[0][3].inMonth, true);
  assert.equal(g[0][0].inMonth, false); // Mon 28 Sep
  assert.equal(g[0][0].day, 28);
  const todays = g.flat().filter((c) => c.today);
  assert.equal(todays.length, 1);
  assert.equal(todays[0].day, 20);
  assert.equal(g.flat().filter((c) => c.inMonth).length, 31);
});

test('monthGrid: Sunday-first option, and a month needing five weeks has five rows', () => {
  const g = monthGrid(2026, 1, new Date(2026, 0, 1), 0); // Feb 2026 starts on a Sunday and has 28 days
  assert.equal(g.length, 4);
  assert.equal(g[0][0].day, 1);
  assert.equal(g.flat().some((c) => c.today), false);
});

test('shiftMonth rolls the year', () => {
  assert.deepEqual(shiftMonth(2026, 11, 1), { year: 2027, month: 0 });
  assert.deepEqual(shiftMonth(2026, 0, -1), { year: 2025, month: 11 });
});

test('limitTone: ok below 70, warn 70–89, bad from 90, unknown for non-numbers', () => {
  assert.equal(limitTone(0), 'ok');
  assert.equal(limitTone(69.9), 'ok');
  assert.equal(limitTone(70), 'warn');
  assert.equal(limitTone(89), 'warn');
  assert.equal(limitTone(90), 'bad');
  assert.equal(limitTone(100), 'bad');
  assert.equal(limitTone(null), 'unknown');
  assert.equal(limitTone(NaN), 'unknown');
  assert.equal(limitTone('50'), 'unknown');
});

test('clampPct and untilText', () => {
  assert.equal(clampPct(104.4), 100);
  assert.equal(clampPct(-3), 0);
  assert.equal(clampPct(undefined), null);
  const now = Date.parse('2026-10-20T10:00:00Z');
  assert.equal(untilText('2026-10-20T12:05:00Z', now), 'in 2h 5m');
  assert.equal(untilText('2026-10-20T10:20:00Z', now), 'in 20m');
  assert.equal(untilText('2026-10-24T14:00:00Z', now), 'in 4d 4h');
  assert.equal(untilText('2026-10-20T09:00:00Z', now), 'now');
  assert.equal(untilText(null, now), '');
  assert.equal(untilText('garbage', now), '');
});

test('limitView: unknown without data, with the error in the tooltip', () => {
  assert.equal(limitView(null).tone, 'unknown');
  assert.equal(limitView({ session: null, error: 'Claude Code is not installed here' }).title, 'Session limit unavailable: Claude Code is not installed here');
  assert.deepEqual(limitView({ session: { pct: null } }).rows, []);
});

test('limitView: session tone, label, tooltip and week rows', () => {
  const now = Date.parse('2026-10-20T10:00:00Z');
  const v = limitView({ session: { pct: 72.4, resetsAt: '2026-10-20T12:05:00Z' }, week: { pct: 95, resetsAt: '2026-10-24T14:00:00Z' }, models: [{ name: 'Sonnet', pct: 10, resetsAt: null }, { name: 'Opus', pct: null }] }, now);
  assert.equal(v.tone, 'warn');
  assert.equal(v.label, '72%');
  assert.equal(v.title, 'Session limit: 72% used, resets in 2h 5m');
  assert.deepEqual(v.rows.map((r) => [r.name, r.pct, r.tone]), [['5-hour session', 72, 'warn'], ['Week · all models', 95, 'bad'], ['Week · Sonnet', 10, 'ok']]);
});

test('tray registry: sorted by order then id, replace by id, phone filter, unregister', () => {
  const r = createTrayRegistry();
  assert.throws(() => r.register({ order: 1, render() {} }));
  assert.throws(() => r.register({ id: 'x' }));
  r.register({ id: 'b', order: 20, render() {} });
  r.register({ id: 'a', order: 10, phone: true, render() {} });
  r.register({ id: 'c', order: 10, render() {} });
  assert.deepEqual(r.items().map((i) => i.id), ['a', 'c', 'b']);
  assert.deepEqual(r.items({ phone: true }).map((i) => i.id), ['a']);
  r.register({ id: 'b', order: 1, render() {} });
  assert.deepEqual(r.items().map((i) => i.id), ['b', 'a', 'c']);
  const seen = [];
  const off = r.onChange(() => seen.push(1));
  r.unregister('c');
  off();
  r.unregister('a');
  assert.deepEqual(seen, [1]);
  assert.deepEqual(r.items().map((i) => i.id), ['b']);
  // register()'s returned function removes its own item, but not a later replacement under the same id
  const offD = r.register({ id: 'd', render() {} });
  const items = r.items();
  assert.strictEqual(r.items().find((i) => i.id === 'd'), items.find((i) => i.id === 'd'), 'entries are stable (the tray keeps nodes by identity)');
  offD();
  assert.deepEqual(r.items().map((i) => i.id), ['b']);
  const offB = r.register({ id: 'b', render() {} });
  r.register({ id: 'b', order: 5, render() {} });
  offB();
  assert.deepEqual(r.items().map((i) => i.id), ['b']);
});

// ---- JARVIS tray menu mapping
import { brainSummary, effortChoices, modelChoices, pickBrain, providerChoices } from '../ui/src/tray-brain-model.js';
const BRAINS = [
  { id: 'claude', label: 'Claude Code', models: ['opus', 'sonnet'], default: 'opus', efforts: ['low', 'high'], defaultEffort: 'high' },
  { id: 'codex', label: 'Codex', models: ['gpt-6'], efforts: ['low'] },
  { id: 'claude-ollama', label: 'Claude via Ollama', models: ['qwen', 'llama'], toolModels: ['qwen'], efforts: [], available: false, reason: 'Ollama not reachable' },
  { id: 'ollama', label: 'Ollama (local)', models: ['llama'], efforts: ['off', 'on'], defaultEffort: 'off' },
];
const ENTRY = { node: { id: 'n1', name: 'mac' }, brains: BRAINS };

test('tray brain menu: codex is never offered, unavailable providers are disabled with their reason, current is checked', () => {
  const p = providerChoices(BRAINS, { brain: 'claude' });
  assert.deepEqual(p.map((x) => x.id), ['claude', 'claude-ollama', 'ollama']);
  assert.equal(p[0].checked, true);
  assert.deepEqual([p[1].disabled, p[1].reason], [true, 'Ollama not reachable']);
});

test('tray brain menu: models and efforts mark the selection, falling back to the provider default', () => {
  assert.deepEqual(modelChoices(BRAINS[0], { brain: 'claude', model: 'sonnet' }).map((m) => m.checked), [false, true]);
  assert.deepEqual(modelChoices(BRAINS[0], { brain: 'claude', model: '' }).map((m) => m.checked), [true, false]);
  assert.equal(modelChoices(BRAINS[2], {})[0].label, 'qwen · tools');
  assert.deepEqual(effortChoices(BRAINS[0], { brain: 'claude', effort: 'low' }).map((m) => m.checked), [true, false]);
  assert.deepEqual(effortChoices(BRAINS[2], {}), []);
});

test('tray brain menu: picks keep the choice within a provider and reset it on a provider switch', () => {
  const cur = { brain: 'claude', model: 'sonnet', effort: 'low' };
  assert.deepEqual(pickBrain(ENTRY, BRAINS[0], { effort: 'high' }, cur), { nodeId: 'n1', nodeName: 'mac', brain: 'claude', model: 'sonnet', effort: 'high' });
  assert.deepEqual(pickBrain(ENTRY, BRAINS[3], {}, cur), { nodeId: 'n1', nodeName: 'mac', brain: 'ollama', model: 'llama', effort: 'off' });
  assert.equal(pickBrain(ENTRY, BRAINS[2], {}, cur).effort, '');
});

test('tray brain menu: tooltip and badge show model and effort', () => {
  assert.deepEqual(brainSummary({ brain: 'claude', model: 'claude-opus-5-5', effort: 'high', nodeName: 'mac' }), { badge: 'opus-5-5', title: 'JARVIS brain: opus-5-5 · high on mac' });
  assert.equal(brainSummary(null).badge, '');
});
