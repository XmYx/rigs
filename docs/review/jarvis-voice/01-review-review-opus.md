# Review t3 · JARVIS voice: single engine and fast replies

Reviewer: team-review-opus (Claude Opus), 2026-10-20. Target: `8ab1bec` (t1) + `faca5f8` (t2) on
`work/magix-system/jarvis-voice-single-engine-and-2705` (diff base `282d17b`).

**Verdict: ready to merge.** The goal holds. Three small fixes were made in this review (below). Nothing blocking is open.

## Checks

| Check | Result |
|---|---|
| `npm test` (branch head, before fixes) | 1020 / 1020 pass |
| `npm test` (after review fixes) | 1021 / 1021 pass |
| `npm run build` | OK |
| `grep -rniE "neural\|kokoro\|jarvis-voice\|voiceApp" src ui/src` | Only comments, the Whisper speech-to-text (`senses.js`, `hearing.js`, still wanted), and the compat check `wantsDefaultVoice` that reads retired `neural` / `neural:x` voice ids as the default voice. No Kokoro synthesis path remains: `neuralBase`, `neuralSynth` and `'neural'` in `ENGINE_CHOICES` are gone. |
| One reply = one audio stream | UI: one ordered queue (`ui/src/speech-queue.js`); 0 overlapping clips and 0 duplicate TTS requests in all 8 timed requests below. Speakers: `speakAloud` plays piper once or falls through to the machine engine, never both (`test/tts-single-voice.test.js`). Notifications: with `aloud` the speakers speak and the UIs stay silent (now pinned by a test, see fix 1). |

## Timing, re-measured

Same harness as t2 (headless Chromium, isolated scratch daemons, resident piper voice, default Claude brain): `8ab1bec` (before) vs
`faca5f8` (after). Times are ms after the request was sent. The machine was very busy (load average 35–52), so absolute numbers are noisy.

| Run | Thinking phrase audio | First reply sentence audio | Reply finished streaming |
|---|---|---|---|
| before ×3 | none | 22743 / 18630 / 20222 (first audio of any kind) | 23404 / 19281 / 21163 |
| after ×3 | **1 / 1 / 1** | 19144 / 28871 / 17794 | 20724 / 28143 / 18984 |
| after, 2 more | **1 / 0** | 18527 / 19762 | 18913 / 20461 |

- The thinking phrase plays at once in every run (0–1 ms), the same as t2's 1–8 ms.
- The first reply sentence started before the reply finished streaming in 4 of 5 runs. The exception (28871 vs 28143) was a 2.5 s stream on the busy machine, where the first chunk took 2.8 s to render. So "always before the reply finishes" depends on load. The speech still begins at the first complete sentence, not at the end of the reply.
- In one run only the first chunk played. That was a harness artifact: the harness waits only 1.5 s after the last clip, and the next question's `voice.stop()` cut the rest. Re-run with a 15 s wait, every sentence played in order.
- In one reply the fourth sentence was not spoken: the 420-char spoken cap cut it, by design (spoken 292 of 424 chars, whole sentences only).

## Fixes made in this review

1. **The one-voice rule for notifications had no test** (t1's root-cause fix, `src/server.js` broadcastNotify). The decision is now the pure
   `notifyVoice()` in `src/tts-plan.js`, used by `broadcastNotify`. `test/tts-plan.test.js` covers it: with `aloud` only the speakers
   speak, by default the UIs speak (the speakers only when no UI is open, unless speakAloud is 'never'), and `speak:false` keeps it silent. Behaviour is unchanged.
2. **Stale `mesh_notify` description** (`src/mcp.js:579-580`) still said `aloud: true` "also" speaks / "speaks it here too". Since t1 it speaks *instead of* the UIs. Agents read this text, so it now says so.
3. **A failed thinking-phrase pre-render was cached for good** (`ui/src/voice.js` cachePhrase). The `.then` without a catch left the rejected
   promise in `phraseAudio` (each later use went to the browser voice until the voice was changed) and raised an unhandled rejection on page load.
   Now a failed render is dropped and retried next time, and a late result never evicts a newer render (setVoice race).

## Open (not blocking)

- **LOW · a failed sentence render is spoken by the browser voice** (`ui/src/voice.js` play → `speakBrowser`, tested as intended in
  `test/speech-queue.test.js:184`). If `/api/local/tts` errors mid-reply (all server engines failed, or a network error), that sentence is said in a different voice. This is the one way a second voice can still appear in a reply. Skipping the sentence instead loses words. That is a product choice, so it was left as is.
- **INFO · `aloud` silences every UI on the mesh**, not only the ones on the speaking machine. If Sir is at another machine, a notification
  with `aloud: true` reaches him only as text there. This is consistent with "never twice". Agents rarely set `aloud` (no caller in RIGS itself).
- **INFO · N open JARVIS UIs voice a notification N times** (each UI speaks `notify` with `speak:true`; `server.js` notify route). This branch did not change it,
  and it only matters if two UIs are open within earshot.
- **INFO · leftover lip-sync plumbing.** The viseme timeline (`x-visemes` header, `trimSilence` cue shift, the face's cue path) has no producer now that Kokoro is gone.
  It is harmless and generic, so it was kept.
- **INFO · two copies of the `---` separator regex**: `src/tts.js` spokenPart and `ui/src/sentences.js` SEPARATOR. The UI can't import `tts.js` (it uses node:fs).
  The UI stops speaking at the first code fence, while the server drops fenced blocks and keeps the text after them. Both skip ```` ```visual ```` blocks.
- Escalation `reset` is covered by unit tests only (`test/speech-queue.test.js:131,151`), as t2 noted. My own queue edge-case checks (stop then
  say, reset during a thinking phrase, reset mid-sentence, out-of-order renders, think right after stop) all played in order with at most one clip at a time.
