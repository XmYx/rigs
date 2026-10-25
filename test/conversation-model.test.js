// Clicking the main chat opens the agent session behind it (ui/src/conversation-model.js, src/main-chat.js turnSession).
import assert from 'node:assert/strict';
import { test } from 'node:test';

const C = await import('../ui/src/conversation-model.js');
const { turnSession } = await import('../src/main-chat.js');

const chat = { id: 'main', brain: 'claude', claudeSessionId: 'S-main', quickSessionId: 'S-quick', codexThreadId: 'T1', messages: [
  { role: 'user', text: 'hi' },
  { role: 'assistant', text: 'quick', session: { kind: 'claude', id: 'S-quick' } },
  { role: 'assistant', text: 'work', mirror: true, chatId: 'thread-2' },
] };

test('a reply opens the session that wrote it; a mirror opens its thread; else the main session', () => {
  assert.deepEqual(C.messageSession(chat, chat.messages[1]), { kind: 'claude', id: 'S-quick' });
  assert.deepEqual(C.messageSession(chat, chat.messages[2]), { chatId: 'thread-2' });
  assert.deepEqual(C.messageSession(chat, { role: 'assistant', text: 'old' }), { kind: 'claude', id: 'S-main' });
  assert.deepEqual(C.messageSession(chat, null), { kind: 'claude', id: 'S-main' });
  assert.equal(C.shownMessage(chat).text, 'work');
});

test('mainSession follows the thread brain and is null without a session', () => {
  assert.deepEqual(C.mainSession({ brain: 'codex', codexThreadId: 'T' }), { kind: 'codex', id: 'T' });
  assert.deepEqual(C.mainSession({ brain: 'ollama', claudeSessionId: 'S' }), { kind: 'claude', id: 'S' });
  assert.equal(C.mainSession({ brain: 'ollama' }), null);
  assert.equal(C.mainSession(null), null);
});

test('turnSession records the right id per lane and brain', () => {
  assert.deepEqual(turnSession(chat, 'claude'), { kind: 'claude', id: 'S-main' });
  assert.deepEqual(turnSession(chat, 'claude', 'quick'), { kind: 'claude', id: 'S-quick' });
  assert.deepEqual(turnSession(chat, 'codex'), { kind: 'codex', id: 'T1' });
  assert.equal(turnSession(chat, 'ollama'), null);
  assert.equal(turnSession(null, 'claude'), null);
});
