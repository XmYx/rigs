// Lipsync timing: which mouth shape the face shows at a given moment of a viseme timeline.
import assert from 'node:assert/strict';
import { test } from 'node:test';

const { shapeAt, VISEMES } = await import('../ui/src/face.js');

test('shapeAt follows the cue under the clock, rests between words, blends into the next shape', () => {
  const cues = [[0.2, 0.3, 'PP'], [0.3, 0.5, 'aa'], [1.0, 1.1, 'SS']];
  assert.deepEqual(shapeAt(cues, 0.0).shape, VISEMES.sil); // before speech
  assert.deepEqual(shapeAt(cues, 0.22).shape, VISEMES.PP);
  assert.deepEqual(shapeAt(cues, 0.4).shape, VISEMES.aa);
  assert.deepEqual(shapeAt(cues, 0.8).shape, VISEMES.sil); // pause between words
  const blend = shapeAt(cues, 0.295).shape; // end of PP, moving towards aa
  assert.ok(blend[0] > VISEMES.PP[0] && blend[0] < VISEMES.aa[0]);
  assert.equal(shapeAt(cues, 1.05, 0).i, 2); // scanning forwards from an old hint
  assert.equal(shapeAt(cues, 0.25, 2).i, 0); // and backwards
});
