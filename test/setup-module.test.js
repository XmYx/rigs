import test from 'node:test';
import assert from 'node:assert/strict';

// The agent-instructions text is one template literal: an unescaped backtick makes the whole module a syntax error,
// which broke `rigs setup` and the autonomy-instructions migration.
test('src/setup.js loads (its agent-instructions template literal is valid)', async () => {
  const m = await import('../src/setup.js');
  assert.equal(typeof m, 'object');
});
