// Which agent session a message of the JARVIS conversation belongs to, so clicking the main chat (the subtitle, the
// chat dock's target, a row of the Conversation window) opens that session instead of a copy of the transcript.
// Pure; tests in test/conversation-model.test.js.

/**
 * → { chatId } for a message mirrored from a work thread (open that thread's session), { kind, id } for a reply that
 * recorded its session (src/main-chat.js turnSession), else the thread's main session, else null.
 */
export function messageSession(chat, msg) {
  if (msg?.mirror && msg.chatId && msg.chatId !== chat?.id) return { chatId: msg.chatId };
  if (msg?.session?.id) return { kind: msg.session.kind || 'claude', id: msg.session.id };
  return mainSession(chat);
}

/** The thread's own resumable session: Claude first (the JARVIS default), then Claude-via-Ollama, then Codex. */
export function mainSession(chat) {
  if (!chat) return null;
  if (chat.brain === 'codex' && chat.codexThreadId) return { kind: 'codex', id: chat.codexThreadId };
  if (chat.brain === 'claude-ollama' && chat.claudeOllamaSessionId) return { kind: 'claude', id: chat.claudeOllamaSessionId };
  if (chat.claudeSessionId) return { kind: 'claude', id: chat.claudeSessionId };
  if (chat.claudeOllamaSessionId) return { kind: 'claude', id: chat.claudeOllamaSessionId };
  if (chat.codexThreadId) return { kind: 'codex', id: chat.codexThreadId };
  return null;
}

/** The message the subtitle shows: the newest assistant reply (a report or mirror counts: it is what Sir saw last). */
export const shownMessage = (chat) => [...(chat?.messages || [])].reverse().find((m) => m.role === 'assistant') || null;
