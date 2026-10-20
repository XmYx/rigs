// Global JARVIS settings: what is mesh-wide, what stays on the machine, which revision wins, where requests go.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { applyGlobal, globalSettings, homeNode, isNewer, nextRev, relayTarget, touchesGlobal } from '../src/globalbrain.js';

const cfg = () => ({
  name: 'mac',
  brain: { core: { provider: 'claude', model: 'claude-opus-5-5', effort: 'high', node: 'mac' }, chat: { provider: 'claude', model: 'claude-haiku-5-5', effort: 'low' },
    home: 'mac', ollamaUrl: 'http://127.0.0.1:11434', workRoot: '~' },
  router: { preroute: true, engine: 'jev', jev: { url: 'http://10.0.0.5:9000', apiKey: 'sekrit', timeoutMs: 8000 } },
  routing: { rules: [{ kind: '*', provider: 'claude' }], customized: false },
  quick: { enabled: true },
  ssh: { autoAuthorize: true },
});

test('globalSettings: brains, router, routing and quick are global; machine-bound keys and secrets are not', () => {
  const g = globalSettings(cfg());
  assert.deepEqual(Object.keys(g).sort(), ['brain.chat', 'brain.core', 'brain.home', 'quick', 'router', 'routing']);
  assert.equal(g.router.jev.apiKey, undefined, 'the LocalJev API key never leaves the machine');
  assert.equal(g.router.jev.url, undefined, 'the LocalJev url is per machine');
  assert.equal(g.router.jev.timeoutMs, 8000);
  assert.equal(JSON.stringify(g).includes('11434'), false, 'ollamaUrl stays local');
});

test('applyGlobal: adopts the global settings and keeps this machine\'s own LocalJev url and key', () => {
  const other = { name: 'linux', brain: { core: { provider: 'claude', model: 'claude-haiku-5-5', effort: 'low', node: '' }, ollamaUrl: 'http://127.0.0.1:11435' },
    router: { preroute: false, jev: { url: 'http://127.0.0.1:7000', apiKey: 'mine' } }, routing: { rules: [], customized: true } };
  applyGlobal(other, globalSettings(cfg()));
  assert.equal(other.brain.core.model, 'claude-opus-5-5');
  assert.equal(other.brain.chat.model, 'claude-haiku-5-5');
  assert.equal(other.brain.home, 'mac');
  assert.equal(other.brain.ollamaUrl, 'http://127.0.0.1:11435');
  assert.equal(other.router.preroute, true);
  assert.equal(other.router.jev.url, 'http://127.0.0.1:7000');
  assert.equal(other.router.jev.apiKey, 'mine');
  assert.equal(other.routing.customized, false);
});

test('touchesGlobal: only patches to global settings are stamped and pushed', () => {
  assert.equal(touchesGlobal({ brain: { core: { model: 'x' } } }), true);
  assert.equal(touchesGlobal({ brain: { home: 'mac' } }), true);
  assert.equal(touchesGlobal({ routing: { avoid: ['codex'] } }), true);
  assert.equal(touchesGlobal({ brain: { ollamaUrl: 'http://x' } }), false);
  assert.equal(touchesGlobal({ ssh: { autoAuthorize: false } }), false);
  assert.equal(touchesGlobal(null), false);
});

test('revisions: newer wins, ties break by machine name, a new stamp is always newer', () => {
  assert.equal(isNewer({ rev: 2, by: 'a' }, { rev: 1, by: 'z' }), true);
  assert.equal(isNewer({ rev: 1, by: 'a' }, { rev: 2, by: 'a' }), false);
  assert.equal(isNewer({ rev: 5, by: 'mac' }, { rev: 5, by: 'linux' }), true);
  assert.equal(isNewer({ rev: 5, by: 'linux' }, { rev: 5, by: 'mac' }), false);
  assert.equal(isNewer({ rev: 5, by: 'mac' }, { rev: 5, by: 'mac' }), false, 'the same revision is not adopted again');
  const c = { globalRev: { rev: 10_000, by: 'x' } };
  assert.equal(nextRev(c, 'mac', 5).rev, 10_001, 'a clock behind the last stamp still moves forward');
});

test('homeNode / relayTarget: requests go to the main brain once, never in a loop', () => {
  assert.equal(homeNode(cfg()), 'mac');
  assert.equal(homeNode({ brain: { core: { node: 'linux' } } }), 'linux', 'the core brain machine when no home is set');
  assert.equal(homeNode({ brain: {} }), '');
  assert.equal(relayTarget(cfg(), 'linux'), 'mac');
  assert.equal(relayTarget(cfg(), 'MAC'), '', 'the main brain answers itself');
  assert.equal(relayTarget(cfg(), 'linux', { via: 'phone-gw' }), '', 'already relayed: answer here');
  assert.equal(relayTarget({ brain: {} }, 'linux'), '', 'no main brain: every machine answers itself');
});
