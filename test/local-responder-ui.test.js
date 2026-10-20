// Local responder control: the view model (dots and wording) and the reply label.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { replyLabel, responderView } from '../ui/src/local-responder-model.js';

const tts = { engine: 'neural' };

test('off by default: grey dot, says quick replies use Haiku', () => {
  const v = responderView({ settings: {}, tts });
  assert.equal(v.on, false);
  assert.equal(v.modelDot, 'off');
  assert.match(v.modelText, /Haiku/);
  assert.equal(v.voiceDot, 'ok');
});

test('on: loaded model is green with VRAM, installed-but-cold is amber, missing/unreachable/host down are red', () => {
  const settings = { enabled: true, node: 'magix-system', model: 'qwen3:8b' };
  const ok = responderView({ settings, status: { reachable: true, installed: true, loaded: true, sizeVramMb: 7800 }, tts });
  assert.equal(ok.modelDot, 'ok');
  assert.match(ok.modelText, /qwen3:8b loaded · 7\.6 GB/);
  assert.equal(responderView({ settings, status: { reachable: true, installed: true, loaded: false }, tts }).modelDot, 'warn');
  assert.equal(responderView({ settings, status: { reachable: true, installed: false }, tts }).modelDot, 'bad');
  const down = responderView({ settings, status: { reachable: false, error: 'Ollama at x is not reachable' }, tts });
  assert.equal(down.modelDot, 'bad');
  assert.match(down.modelText, /not reachable/);
  assert.equal(responderView({ settings, status: null, hostKnown: false, tts }).modelDot, 'bad');
});

test('voice dot: red with a plain explanation when no speech engine answers', () => {
  const v = responderView({ settings: { enabled: true }, status: { loaded: true }, tts: { engine: null } });
  assert.equal(v.voiceDot, 'bad');
  assert.match(v.voiceText, /browser voice/);
  assert.match(responderView({ settings: {}, tts: { engine: 'neural' } }).voiceText, /Kokoro/);
});

test('title names the host and the config location is shown', () => {
  const v = responderView({ settings: { enabled: true, node: 'magix-system' }, tts });
  assert.equal(v.title, 'Local responder (magix-system)');
  assert.match(v.where, /config\.quick\.local/);
});

test('replyLabel marks only locally answered quick turns', () => {
  assert.deepEqual(replyLabel({ lane: 'quick', tier: 'local', model: 'qwen3:8b', node: 'magix-system' }), { name: 'local', detail: 'qwen3:8b · magix-system' });
  assert.equal(replyLabel({ lane: 'quick', tier: 'simple', model: 'claude-haiku-5-5' }), null);
  // the done event of a turn that fell back (model not loaded) carries the Haiku tier: no local label
  assert.equal(replyLabel({ type: 'done', lane: 'quick', tier: 'haiku', model: 'claude-haiku-5-5' }), null);
  assert.equal(replyLabel({ brain: 'claude' }), null);
});
