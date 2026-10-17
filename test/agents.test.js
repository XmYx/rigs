// Active agents panel: which sessions count as live agents, and their state (pure selector, no DOM).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { activeAgents, agentState, isLiveAgent } from '../ui/src/agents-data.js';

const NOW = 1_000_000;
const node = (id, online = true) => ({ id, name: id, online });

test('only live claude/codex/rig/agent-terminal sessions count; idle shells, chats and dead runs do not', () => {
  assert.equal(isLiveAgent({ kind: 'claude', live: true }), true);
  assert.equal(isLiveAgent({ kind: 'codex', live: true }), true);
  assert.equal(isLiveAgent({ kind: 'claude', live: false }), false);
  assert.equal(isLiveAgent({ kind: 'rig', live: true, agent: 'claude-code' }), true);
  assert.equal(isLiveAgent({ kind: 'tmux', live: true, agent: 'claude' }), true);
  assert.equal(isLiveAgent({ kind: 'tmux', live: true, agent: 'shell' }), false);
  assert.equal(isLiveAgent({ kind: 'tmux', live: true, agent: 'ssh' }), false);
  assert.equal(isLiveAgent({ kind: 'pty', live: true, agent: 'codex' }), true);
  assert.equal(isLiveAgent({ kind: 'pty', live: true, agent: 'shell' }), false);
  assert.equal(isLiveAgent({ kind: 'chat', live: true, agent: 'claude' }), false);
});

test('state: waiting from the attention list, working on recent output, else idle', () => {
  const waiting = new Set(['rig:seat@r']);
  assert.equal(agentState({ kind: 'rig', id: 'seat@r', updatedAt: NOW }, waiting, NOW), 'waiting');
  assert.equal(agentState({ kind: 'tmux', id: 'seat@r', updatedAt: NOW }, waiting, NOW), 'waiting');
  assert.equal(agentState({ kind: 'claude', id: 'a', updatedAt: NOW - 5000 }, waiting, NOW), 'working');
  assert.equal(agentState({ kind: 'claude', id: 'a', updatedAt: NOW - 120000 }, waiting, NOW), 'idle');
});

test('activeAgents spans online machines only, waiting first then newest', () => {
  const snap = [
    { node: node('a'), sessions: [
      { kind: 'claude', id: 'c1', live: true, updatedAt: NOW - 1000 },
      { kind: 'tmux', id: 'sh', live: true, agent: 'shell', updatedAt: NOW },
      { kind: 'codex', id: 'x1', live: true, updatedAt: NOW - 90000 },
    ], attention: [{ session: { kind: 'codex', id: 'x1' } }] },
    { node: node('b'), sessions: [{ kind: 'claude', id: 'c2', live: true, updatedAt: NOW - 500 }] },
    { node: node('off', false), sessions: [{ kind: 'claude', id: 'gone', live: true, updatedAt: NOW }] },
  ];
  const rows = activeAgents(snap, NOW);
  assert.deepEqual(rows.map((r) => [r.session.id, r.state]), [['x1', 'waiting'], ['c2', 'working'], ['c1', 'working']]);
  assert.deepEqual(activeAgents([], NOW), []);
});

test('a transcript shadowed by a running terminal in the same cwd is shown once, as the terminal', () => {
  const snap = [{ node: node('a'), sessions: [
    { kind: 'claude', id: 'tr1', live: true, cwd: '/w/x', updatedAt: NOW - 1000 },
    { kind: 'rig', id: 'seat@r', live: true, agent: 'claude-code', cwd: '/w/x', updatedAt: NOW - 2000 },
    { kind: 'claude', id: 'tr2', live: true, cwd: '/w/x', updatedAt: NOW - 3000 }, // a second claude there: not covered
    { kind: 'codex', id: 'cx', live: true, cwd: '/w/x', updatedAt: NOW - 4000 }, // other agent family: not covered
  ] }];
  assert.deepEqual(activeAgents(snap, NOW).map((r) => r.session.id).sort(), ['cx', 'seat@r', 'tr2']);
});
