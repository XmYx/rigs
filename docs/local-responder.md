# Local live responder — design

Task t1 of project `4891955f45` ("JARVIS · Local live speaking LLM responder"), trace `tr-20261020-8842608d23d4`.
Research and design only: no runtime code changed. The benchmark scripts are in `scripts/bench/`.

**Goal.** An optional, locally run LLM on magix-system that speaks, can use a few tools, and answers as JARVIS's first
responder: when it is switched on it replaces today's Haiku quick-lane replies. Routing and task handling stay exactly
as they are. When it is off, nothing changes.

## Summary

| decision | choice | why (numbers in §3) |
| --- | --- | --- |
| model | **`qwen3:8b`** via Ollama on magix-system, thinking off, 16k context | first token 27 ms, first sentence 55 ms, 144 tok/s, 7.6 GB VRAM; 39/39 correct on 13 typical asks × 3 with the narration guard (31/39 without) |
| alternative | `gpt-oss:20b` | 39/39, 182 tok/s, but 13.1 GB (can't stay resident next to ComfyUI) and ~130 ms first token |
| integration | **direct Ollama `/api/chat` tool loop in the daemon** (`src/responder.js`) | 27 ms vs 5.9 s first token for the same model through `claude -p` via Ollama; 3.4k-token prompt instead of 22–44k |
| baseline replaced | Haiku quick lane (`claude -p`) | 3.5 s to first token, 5–13 s with a tool (measured); 21–27 s end-to-end in the ledger and the earlier e2e |
| where it plugs in | one branch in `chat.quickTurn`, picked by pure `localResponder()` in `quick.js` | routing, `jarvisSend`, escalation and the ledger unchanged; `router.js`, `planner.js`, `work.js`, `hubs.js`, `autonomy.js` untouched |
| config | `config.quick.local` `{ enabled: false, node: 'magix-system', model: 'qwen3:8b', tiers: ['haiku'], tools: […], … }` | rides the existing mesh-global `quick` sync; off = today's behaviour exactly |
| tools | 7 read-only rigs MCP tools (`mesh_status`, `mesh_sessions`, `mesh_apps`, `project_list`, `mesh_processes`, `usage_report`, `trace_list`) | everything else → `[[ESCALATE]]` → the full JARVIS thread, as today |
| fallback | can't start (host/Ollama down, model cold, no token in 2.5 s) → today's Haiku turn; can't answer (escalate, error, timeout) → full brain | a cold model never makes Sir wait |
| other machines | the host runs the turn: `POST /api/local/responder/turn` (NDJSON) on magix-system, called by the main-brain machine (macbookpro today) through the peer API | Ollama stays on loopback; LAN round trip 10 ms |
| voice | existing UI sentence streaming + **Kokoro-82M `bm_george`** via `jarvis-voice` (33–52 ms per sentence warm); Piper `en_GB-alan-medium` (resident, CPU) as fallback | keep the voice resident (evicted 55×/24 h) and trim Kokoro's ~280 ms lead-in silence |

## 1. How an "answer" request flows today

All references are to this worktree at `677facc`.

1. **Intake and relay.** The UI posts to `POST /api/local/jarvis/send` (`src/server.js:681`). Since `c92900b` ("One
   JARVIS brain for the whole mesh") every request is relayed once to the main-brain machine (`relayTarget`,
   `src/globalbrain.js`; `brain.home`, else `brain.core.node`, today **macbookpro**) with `forwardHttp`
   (`src/server.js:685-687`). That machine starts the trace (`startIntake`, `src/server.js:694`) and calls
   `chat.jarvisSend` (`src/chat.js:411`). So the quick lane, and any responder, runs on the main-brain machine, not on
   the machine whose UI Sir is using.
2. **Pre-routing.** `preroutedTurn` (`src/chat.js:462`) asks `router.route` (`src/router.js:363`): the `jev` engine
   (LocalJev, ~0.5 s), then the `claude` fallback (Haiku via `claude -p`), then keyword rules; `guardRoute`
   (`src/router.js:109`) turns an imperative work request that was labelled "answer" into implement/plan. An `answer`
   goes to the long-running JARVIS thread (`mainChat`, `src/chat.js:482`).
3. **Quick-lane decision.** `resolveQuick` (`src/quick.js:125`) takes only `answer` requests, honours a per-request
   `quick` override, `config.quick.enabled`, and leaves requests that asked for a non-Claude brain alone. The tier comes
   from `quickTierWhy` (`src/quick.js:96`): **haiku** for a short question, lookup, single tool call or short summary;
   **sonnet** for search, research, reports, comparisons, several steps or long text.
4. **The quick turn.** `chat.quickTurn` (`src/chat.js:562`):
   - `quickBrain` (`src/quick.js:142`, called at `src/chat.js:565`) maps the tier onto this machine's brain catalog;
     `QUICK_PROVIDERS` is `['claude']` (`src/quick.js:10`), so the lane is always `claude -p`;
   - the reply's `emit` is wrapped in `escalationGate` (`src/quick.js:161`, `src/chat.js:577`), which holds back text
     that could be `[[ESCALATE]]`;
   - an `AbortController` adds the lane's own timeout (`config.quick.timeoutMs`, 90 s; `src/chat.js:572-576`);
   - `tracedRun` (`src/chat.js:517`) runs `runClaude` (`src/chat.js:221`) with `quick: { maxTurns }`: a fresh
     `claude -p` session (never the thread's own), the last six messages as context (`recentContext`,
     `src/chat.js:187`), the full persona prompt plus `quickNote` (`src/quick.js:182`), `--max-turns 8`, every MCP
     server the user registered (rigs, rea, …) and `ToolSearch`.
5. **Outcome.** `[[ESCALATE]]` (`parseEscalation`, `src/quick.js:149`), the turn limit, an error or the timeout return
   `{ escalate }`; `jarvisSend` then emits `status` with `reset: true` (the screen drops what the fast turn streamed) and
   re-runs the request on the full JARVIS brain with a hint of what already ran (`src/chat.js:427-435`). A turn that
   already filed work is never re-run.
6. **Measurement.** `jarvisSend` emits `{ type: 'timing' }` and writes one ledger `request` record with `lane: 'quick'`,
   `tier`, `escalated`, `routerMs` and `timeToReplyMs` (`src/chat.js:440-448`, `recordRequest` in `src/usage.js:815`);
   the turn itself is a `chat-turn` record with `lane: 'quick'` (`recordChatTurn`, `src/usage.js:794`) and a
   `brain-turn` trace span with `meta.lane = 'quick'`.

What this means for a local model:
- The only place a different quick-lane brain can enter without touching routing is `quickTurn` (step 4). Everything
  after it (escalation, re-run on the full brain, timing, ledger) already works on the `{ text, error, usage }` /
  `{ escalate }` contract and needs no change.
- Today's Haiku turn pays for a process start, MCP server start-up and a ~42k-token prompt (Claude Code's system prompt,
  tool schemas, persona) before its first token; a tool question re-reads it each agentic turn (one ledger record on
  magix-system: 228k prompt tokens incl. cache for a single weather answer).
- The pre-router runs before any of this and is not ours to change: 3.4 s via rules in the one ledger record here,
  ~15 s when it falls back to Claude (`docs/quick-path-results.md`), ~0.5 s when LocalJev answers.

## 2. How JARVIS speaks and hears today

**Speaking.** JARVIS's voice is **Kokoro-82M** on magix-system's GPU, served by the App Cloud applet `jarvis-voice`
(port 8197, loopback only; source `~/apps/jarvis-voice/server.py`, outside this repo; unit
`~/.config/systemd/user/jarvis-voice.service`). Its default voice is the blend `bm_george*0.7+bm_fable*0.3` at speed
1.05 (`server.py:42`). `POST /tts` returns one whole 24 kHz WAV plus an `x-visemes` header for lipsync
(`server.py:290-301`); synthesis holds one lock and concatenates its chunks, so a call is not streamed
(`server.py:207-235`). The applet loads Kokoro only under a GPU-overseer lease of 1500 MB (`server.py:146-165`).

- Daemon: `GET/POST /api/local/tts` (`src/server.js:1155-1166`) → `tts.synthesize` (`src/tts.js:167-184`) →
  `neuralBase()` (`src/tts.js:49-64`): the local applet, or the mesh catalog's `jarvis-voice` through this daemon's
  own App Cloud proxy. The WAV is buffered whole, 45 s timeout (`src/tts.js:68-74`). Local fallbacks (`say`, SAPI,
  piper with an `.onnx` in `persona.voice`, espeak; `src/tts.js:35-42`, `148-161`) are not installed on magix-system,
  so when the applet fails the browser's `speechSynthesis` speaks (`ui/src/voice.js:101-118`).
- **The UI already speaks sentence by sentence while a reply streams**: `ask()` reads `/jarvis/send` as NDJSON
  (`ui/src/main.js:980`, `ui/src/api.js:22-46`); every `delta` goes through `spokenText` (the part before `---`, capped
  at 420 chars, `main.js:807-818`) into `voice.feed()` (`main.js:986-993`, flush `1006-1009`); the chunker releases a
  sentence once the whitespace after its punctuation arrives (`voice.js:201-210`); `speakNow`/`pump` fetch and
  prefetch `POST /api/local/tts` (relative URL: the daemon that served the page) and schedule playback on Web Audio
  (`voice.js:120-198`). The face follows the viseme cues (`ui/src/face.js:266-282`), the orb follows the audio's RMS
  (`voice.js:138-150` → `ui/src/orb.js:121`), and the expression comes from LocalJev via `/api/local/emotion`
  (`main.js:90-98`, `src/senses.js:75-96`) — another Ollama model (`qwen2.5vl:7b`) on the same GPU.
- Config: `persona.voice`, `persona.speakAloud` (`src/config.js:58-60`), plus undocumented `persona.neural`,
  `voiceApp` (`src/tts.js:50-53`), `hearingApp`, `emotionApp` (`src/senses.js:44`, `:81`). With no UI open,
  `broadcastNotify` → `tts.speakAloud` speaks a whole text in one call (`src/server.js:552-561`, `src/tts.js:186-234`).

**Hearing.** Web Speech recognition in Chrome/Edge/Safari (`voice.js:289-336`); elsewhere (Firefox, Linux Chromium,
or after a Web Speech network error) the mesh's Whisper: an energy voice detector with a 300 ms pre-roll ends an
utterance after **0.9 s of quiet hands-free, 1.2 s push-to-talk** (`ui/src/hearing.js:79-107`), then a 16 kHz WAV goes
`POST /api/local/stt` (`hearing.js:48` → `src/server.js:756-763` → `src/senses.js:43-50`) to the applet's
faster-whisper large-v3-turbo (fp16 CUDA, int8 CPU fallback, 2200 MB lease; `server.py:54-101`). The transcript goes
`onText` (wake word, `voice.js:264-282`) → `onTranscript` → `ask(t, {spoken:true})` (`main.js:102`). Measured: a
2.5 s command transcribes in 157–192 ms warm (2.3 s cold load), so end of speech → transcript is **~1.1–1.4 s, mostly
the silence wait**.

**Other machines.** A browser on macbookpro calls its own daemon's `/api/local/tts`; `neuralBase()` finds
`jarvis-voice` in the mesh catalog and goes `/api/nodes/magix-system/apps/jarvis-voice` → `relayApp`
(`src/proxy.js:442-461`) → `proxyApp` on magix-system (`src/proxy.js:405-439`). Verified: macbookpro's
`GET /api/local/tts` reports `engine: "neural"`, i.e. **macbookpro already speaks with magix-system's Kokoro**. STT
takes the same route. Measured through macbookpro's daemon: 65–72 ms to first byte when it is idle; 0.4–6 s when
macbookpro's daemon is busy — the remote daemon's load, not TTS, sets remote latency.

**GPU overseer** (`~/apps/gpu-overseer`, port 8195, outside this repo): apps lease VRAM before loading; to make room it
unloads idle holders, biggest first, and its watchdog does the same whenever less than 1200 MB is free
(`server.py:125-184`). In the last 24 h it **unloaded the voice 55 times** (27 reloads); a cold reload costs ~2.1 s
before the first WAV. Ollama's runner processes are not matched to any client (`client: null`), so the overseer can
neither see nor evict an Ollama model — it evicts the voice or ComfyUI instead.

What this means for the responder: speech needs **no new path**. A reply that streams `delta` events through
`jarvisSend` is spoken sentence by sentence by the existing UI, on every machine. What decides how live it feels is
(1) time to the first complete sentence of text, (2) whether Kokoro is loaded, (3) Kokoro's padding (below).


## 3. Benchmarks (magix-system, 2026-10-20)

### 3.1 Setup

RTX 4090 24 GB, Ollama 0.34.0 (snap), Q4_K_M weights, `num_ctx` 16384, thinking off where the model allows it
(`gpt-oss` only goes down to `think: "low"`). The GPU was cleared through the GPU overseer before each run
(`/api/acquire`, which unloads idle ComfyUI / voice models). Script: `scripts/bench/responder-bench.mjs` (§6).

The asks: the five from the brief — *How is the mesh doing?* (must call `mesh_status`), *Which sessions are running
right now?* (`mesh_sessions`), *What is the capital of Australia?* (no tool, says Canberra), *Please build me a small
web app that tracks my fuel expenses.* (must reply `[[ESCALATE]]`), *Good evening, JARVIS.* (no tool, short) — plus
eight paraphrases of the same kinds for the final rounds (*Is the MacBook online?*, *Which of my apps are down right
now?*, *What are my projects up to?*, *How many tokens did we use today?*, a joke, a thank-you, *Fix the failing test
in the router.*, *Search the web for the latest Node.js release.*). Each ask runs 3× (13 × 3 = 39 per model).
Tools are the real read-only rigs MCP tools (§5.3) against the live daemon. Scoring is automatic and strict: a status
answer without the tool call is wrong even when it sounds right.

Metrics: **first token** = first token of the spoken answer (chat asks: fact, greeting, joke, thanks); **first
sentence** = when the first complete sentence exists, i.e. when the UI can start speaking; **answer after tool** = the
model's own time to the first answer token on tool asks, tool execution subtracted (that depends on the mesh: the
`mesh_sessions` snapshot took 3 ms to 7 s during the day); **escalation decided** = time until `[[ESCALATE]]` is
complete; **tok/s** = decode speed from Ollama's final chunk; **VRAM** = `nvidia-smi` delta for the load where
measured cleanly, else Ollama's `size_vram`; **cold load** = model load from page cache/disk with the first request.

### 3.2 Local models, direct Ollama tool loop

| model | first token (chat) | first sentence | answer after tool | escalation decided | tok/s | VRAM (16k ctx) | cold load | correct, 39 asks | with narration guard |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| **qwen3:8b** | **27 ms** | **55 ms** | 325 ms | 322 ms | 144 | **7.6 GB** | 8–14 s | 31/39 | **39/39** (8 nudges, +~0.5 s on those) |
| gpt-oss:20b (MoE, think low) | 131 ms | 157 ms | 535 ms | 237 ms | 182 | 13.1 GB | 17–19 s | 35/39 | 39/39 (0 nudges) |
| mistral-small3.2:24b | 28 ms | 117 ms | 844 ms | 299 ms | 62 | 16.2 GB¹ | 13 s | 33/39 | – |
| qwen3:14b | 33 ms | 84 ms | 594 ms | 248 ms | 89 | 11.3 GB¹ | 10 s | 32/39 | 31/39 |
| glm-4.7-flash (30B MoE) | 35 ms | 71 ms | 579 ms | 1828 ms | 153 | 18.9 GB¹ | 20 s | 31/39 | – |
| qwen3.5:9b | 71 ms | 133 ms | 756 ms | 1326 ms | 121 | 7.2 GB | 7 s | 30/39 | – |
| gemma4 (7.5B) | 41 ms | 77 ms | 467 ms | 130 ms | 200 | ≈7.4 GB² | 10 s | 30/39 | – |
| llama3.1:8b | 252 ms | 409 ms | 287 ms | 467 ms | 155 | 6.7 GB¹ | 5 s | 20/39 | – |

¹ Ollama's `size_vram`. ² `nvidia-smi` delta minus the emotion model that loaded at the same moment; Ollama reports
0.3 GB for gemma4, which is wrong. The GLM-4.7 Q1 quant (84 GB) was not considered, as the brief says.

The prompt's cached prefix is what makes the first token this fast: the first ask after a load or a prompt change costs
250–940 ms of prompt evaluation (qwen3:8b 287 ms, gpt-oss 246 ms, glm 940 ms), every later ask 8–40 ms.

How each model fails (prompt v2, no guard):
- **qwen3:8b** — always the same way: *"Of course, sir. Let me check the mesh status."* and no tool call (mesh,
  online, apps). Facts, greetings, jokes and all 9 escalations right. This failure is detectable, and the fix is a
  runner rule, not a bigger model: when a reply only announces a lookup, keep it as the spoken opener and ask once for
  the tool (`narratedToolCall` + `NUDGE` in the script) → 39/39, and the spoken result sounds natural ("Let me check
  the mesh status. The MacBook is online, sir…"). Cosmetic: after the nudge it sometimes repeats "Of course, sir";
  the implementation's nudge should say not to.
- **gpt-oss:20b** — the best raw tool discipline (39/39 in the guard run, 35/39 before), but in one round it answered
  *"Sydney, sir."* to the capital question 2 of 3 times, once Ollama failed to parse its tool call (HTTP 500 `error
  parsing tool call`), and it needs 13.1 GB.
- **qwen3:14b** — invents status without calling the tool ("The mesh is stable, all machines online") — worse than
  the 8B, and the guard can't catch an invented answer.
- **mistral-small3.2** — never escalates (offers to "guide you through the process" instead), 62 tok/s, 16 GB.
- **glm-4.7-flash** — calls four tools for a greeting, won't escalate "fix the test"/"web" asks, 19 GB.
- **qwen3.5:9b** — offers to do the work itself ("I've set the build in motion") instead of escalating: 0/9.
- **gemma4** — tool calls leak into the text (`mesh_status{}`) or the reply after a tool is empty.
- **llama3.1:8b** — calls tools for greetings and jokes, writes the escalation as JSON (`{"name": "ESCALATE", …}`).

Prompt matters as much as the model. The first round used the full `SOUL.md` and a soft tool rule (prompt v1):
mesh-status asks were answered from imagination by most models, and several said *"I've filed it under RIGS and
Sonnet is already at it"* — a line from SOUL.md's "Work" section and examples — without being able to file anything.
The design's prompt (v2, §5.4) moved the 5-ask scores from v1 → v2: qwen3:8b 14→14/15, qwen3.5 9→11, gemma4 10→11,
mistral 9→14, glm 11→13, qwen3:14b 11→11, llama 6→6 (gpt-oss, added in v2: 15/15).

### 3.3 Integration styles and the Haiku baseline

Same asks (the five core ones), same safety rails (only read-only tools allowed; the claude styles load only the rigs
MCP server and disallow every other tool).

| style | model | first token (chat) | first sentence | answer with a tool | prompt tokens per turn | correct |
| --- | --- | --- | --- | --- | --- | --- |
| **direct Ollama tool loop** (design) | qwen3:8b + guard | **27 ms** | **57 ms** | 0.45–0.84 s incl. tool | 3.4k | 5/5 (39/39 extended) |
| direct Ollama tool loop | gpt-oss:20b | 131 ms | 157 ms | ~0.6 s incl. tool | 3.2k | 5/5 (39/39) |
| `claude -p` via Ollama (`claude-ollama`) | qwen3:8b | 5.9 s | 6.0 s | no reply: empty text after the tool turn | 22k (44k with a tool) | 2/5 |
| `claude -p` via Ollama (`claude-ollama`) | gpt-oss:20b | 4.8 s | 4.8 s | 13.4–24.2 s | 22k (49–87k) | 4/5 |
| **`claude -p`, today's quick lane** | Haiku 5.5, effort low | **3.5 s** | **3.6 s** | 5.1–12.7 s | 43k (129–132k with a tool) | 6/10 |

- `claude -p` via Ollama pays Claude Code's process start, MCP start-up and a ~22k-token system prompt on every turn,
  and Ollama loads the model at its default 32k context for it (qwen3:8b: 9.5 GB instead of 7.6 GB). It is 200×
  slower to the first token than the direct loop with the same model, and less correct. It stays useful as a full
  agentic brain (`brain: claude-ollama`), not as a first responder. (1 run per ask: the gap is too large to need more.)
- **Haiku baseline, measured today** (2 runs per ask, real quick-lane prompt: persona + `quickNote`): 3.3–4.0 s to the
  first token on chat asks, 5.1–12.7 s to the answer on tool asks. It answered "which sessions are running" from the
  session list that this machine's Claude Code hook injects instead of calling `mesh_sessions` (scored wrong, though
  not invented), and for "please build" it tried `Bash` and `Write` to build the app itself (both refused by the
  bench's rails; in production the router usually sends such requests to implement first).
- **Haiku baseline from the usage ledger** (`timeToReplyMs`, lane quick): the one quick-lane request on magix-system
  took **21.0 s** (router 3.4 s via rules, Haiku turn 17.6 s, a weather question with a web search, 228k prompt tokens
  incl. cache, $0.025); macbookpro's ledger could not be read when the baseline was taken (the mesh proxy reported its
  daemon as not running RIGS at that moment), and
  `docs/quick-path-results.md` (macbookpro, 2026-10-18) has Haiku at **23–27 s** for a one-tool status question
  (~15 s of it the Claude router fallback). The comparable local numbers (qwen3:8b) are **~0.15 s** for a whole chat
  reply and **~1.3–1.5 s** for a whole tool reply.

### 3.4 Text-to-speech

Medians of 5 runs after a warm-up; short text = "Good evening, sir. All systems are online." (7 words, 2 sentences),
medium = 25 words in one sentence. TTFA = time to the first audio chunk (in process) or first response byte (HTTP);
RTF = synthesis time ÷ audio duration (medium). Script: `scripts/bench/tts-bench.py`.

| engine | voice | device | cold start | TTFA short | TTFA medium | RTF | VRAM | streams |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Kokoro-82M through JARVIS (`/api/local/tts` → applet) | default blend | 4090 | 2.1 s (applet reload) | 33–35 ms | 44–52 ms | 0.006 | 1.2–1.5 GB | no (one WAV per sentence) |
| Kokoro-82M, applet direct | george / lewis / daniel / fable | 4090 | – | 39 / 37 / 43 / 41 ms | 47 / 46 / 47 / 49 ms | 0.006–0.007 | same applet | no |
| Kokoro-82M raw (`KPipeline`) | george / lewis / daniel / fable | 4090 | 6.9 s process | 31 / 30 / 28 / 29 ms | 41 / 40 / 39 / 39 ms | 0.005 | 1.3 GB | per segment |
| Kokoro-82M raw | george / lewis / daniel / fable | CPU (24 threads) | 4.6 s | 516–774 ms | 1368–1911 ms | 0.18–0.22 | 0 | per segment |
| Piper 1.8, resident | en_GB alan-medium | CPU | 1.1 s | 29 ms | 156 ms | 0.019 | 0 | per sentence |
| Piper 1.8, resident | en_GB northern_english_male-medium | CPU | 1.2 s | 23 ms | 132 ms | 0.020 | 0 | per sentence |
| Piper 1.8, resident | en_GB alan-low | CPU | 1.1 s | 23 ms | 128 ms | 0.016 | 0 | per sentence |
| Piper CLI per call (how `src/tts.js` uses it) | alan-medium | CPU | – | 1.2–1.4 s per call | – | – | 0 | no |

- Neither engine yields audio before a whole sentence is synthesized (both are non-autoregressive); at these RTFs
  sentence-level streaming — which the UI already does — is enough.
- Kokoro clips carry ~280 ms leading and 0.5–0.9 s trailing silence (Piper 55–67 ms / 95–210 ms): more than the
  synthesis itself (§5.8).
- Quality (not a listening test: from Kokoro's own `VOICES.md` grades and the voices' provenance): **bm_george C
  (target B)** and bm_fable C are the best-graded British male Kokoro voices; bm_lewis D+, bm_daniel D. Piper `alan`
  is a British male voice fine-tuned from the US "lessac" voice, flatter prosody; `northern_english_male` has a regional
  accent; `semaine` (also tried) is non-commercial and its male speakers are emotional characters — unsuitable.
- Skipped: XTTS, F5, Chatterbox, Orpheus, CSM, Kyutai (0.5–3B cloning or LLM-style TTS: slower first audio, 2–8 GB+
  of VRAM on a crowded GPU, XTTS non-commercial); kokoro-onnx (its espeak-ng loader failed on this Python).
- Samples for listening (the 25-word sentence, one WAV per engine/voice) are on magix-system in
  `~/.rigs/bench/local-responder/tts-samples/`; `kokoro_JARVIS-current_bm_george0.7+bm_fable0.3_speed1.05.wav` is
  today's voice. The raw results of every run in this document (LLM and TTS) are next to them in `results/`.

## 4. Decision

**Model: `qwen3:8b`** (Q4_K_M, thinking off, 16k context) **with the narration guard.**
- Fastest to speech of everything measured: first token 27 ms, first complete sentence 55 ms (warm, cached prefix).
- 39/39 on the extended asks with the guard; its only failure mode without the guard is announced-but-not-made tool
  calls, which the runner catches. Every escalation right (9/9), every fact right.
- 7.6 GB: fits next to the voice, Whisper and the emotion model (~18 GB together), so the responder is usually warm.
- Runner-up and switch-in: **`gpt-oss:20b`** (`quick.local.model`), the best raw tool discipline and 182 tok/s, for
  when the GPU is not shared — at 13.1 GB it can't stay resident next to ComfyUI, it starts ~100 ms later (low
  reasoning), and it got a basic fact wrong in one round. qwen3:14b, mistral-small, glm-4.7-flash and qwen3.5 fail
  the two rules that matter (call the tool, escalate work) more often; llama3.1:8b and gemma4 mangle tool calls.

**Integration: a direct Ollama `/api/chat` tool loop inside the RIGS daemon** (`src/responder.js`), not `claude -p`
against Ollama: 27 ms vs 5.9 s to the first token for the same model, a 3.4k-token prompt instead of 22–44k, and the
tool set is ours to restrict (read-only) rather than Claude Code's.

**Voice: Kokoro-82M through the existing `jarvis-voice` applet, voice `bm_george`** (or the current
george/fable blend), Piper `en_GB-alan-medium` as the resident CPU fallback.

Expected effect: a spoken answer to a simple question starts ~0.1 s after the router instead of ~3.6 s (Haiku's first
sentence), and a status answer with a tool in ~1 s instead of 5–13 s — at zero API cost. The pre-router in front of it
is unchanged and now dominates (~0.5 s with LocalJev, 3–15 s without).


## 5. Design

### 5.1 Where it plugs in: one branch in `quickTurn`

The responder is a new **quick-lane brain**, chosen inside `chat.quickTurn` (`src/chat.js:562`) and nowhere else.
`jarvisSend`, `resolveQuick`, the tiers, the escalation gate, the re-run on the full brain, timing and the ledger stay
as they are.

```js
// src/chat.js, quickTurn — today: const resolved = quickBrain(q, await availableBrains());
const local = localResponder(q, config().quick, { self: config().name });          // src/quick.js, pure
const resolved = local.on
  ? { brain: 'ollama', model: local.model, effort: '' }
  : quickBrain(q, await availableBrains());
// …unchanged: user message, start event, activeTurns, timeout, escalationGate…
out = await tracedRun({ …, runner: local.on ? runResponder : runClaude,
  meta: { lane: 'quick', tier: q.tier, …(local.on ? { local: true, node: local.node } : {}) },
  runOpts: local.on ? { local } : { quick: { maxTurns: q.maxTurns } } });
if (out.unavailable) {                       // nothing was shown yet: today's Haiku turn answers instead
  trace event 'responder-fallback' (reason); resolved = quickBrain(q, …); out = await tracedRun({ …runClaude… });
}
// …unchanged: parseEscalation / timeout / error → { escalate }, else flush + done.
```

- `localResponder(q, quickCfg, { self })` (new, pure, `src/quick.js`): `{ on: true, node, model, … }` when
  `quick.local.enabled`, the tier is in `quick.local.tiers` and the request did not force a Claude tier
  (`quick: 'haiku' | 'sonnet'` on `jarvis/send` still means Claude); otherwise `{ on: false, reason }`.
- `runResponder` (new, `src/responder.js`) has the runner signature `tracedRun` already calls
  (`(chat, text, model, effort, emit, meshSummary, signal, projects, opts)`) and returns `{ text, error, usage }`, plus
  `unavailable: reason` when it could not start answering (see 5.5). It runs locally when `local.node` is this
  machine, otherwise it streams the turn from the host (5.6).
- Because the runner returns the same shape, `[[ESCALATE]]`, the turn limit (here: tool rounds), errors and the lane
  timeout behave exactly as for Haiku: `{ escalate }` → `jarvisSend` re-runs on the full JARVIS thread with
  `reset: true`.
- `quickSettings` / `applyQuickPatch` (`src/quick.js:30`, `:45`) learn the `local` block so `POST /api/local/quick`
  and the global-settings sync keep it (today `quickSettings` drops unknown keys).

### 5.2 Configuration: `config.quick.local`

The responder lives inside `config.quick`, which is already a **mesh-global** setting (`GLOBAL_PATHS` in
`src/globalbrain.js`): switching it on anywhere switches it on for the main-brain machine, with no change to
`globalbrain.js`. Nothing machine-bound goes in it: the Ollama URL is the host's own `brain.ollamaUrl` (already
local), which is why there is no `url` key.

```jsonc
"quick": {
  "enabled": true,
  "simple":   { "provider": "claude", "model": "claude-haiku-5-5",  "effort": "low" },
  "standard": { "provider": "claude", "model": "claude-sonnet-5-5", "effort": "medium" },
  "maxTurns": 8, "timeoutMs": 90000,
  "local": {
    "enabled": false,              // off by default = today's Haiku lane, exactly
    "node": "magix-system",        // the machine whose Ollama runs the model ('' = the main-brain machine itself)
    "model": "qwen3:8b",           // see §4; gpt-oss:20b when the GPU is not shared
    "tiers": ["haiku"],            // quick tiers it replaces; Sonnet-tier asks (web search, reports) stay on Sonnet
    "tools": ["mesh_status", "mesh_sessions", "mesh_apps", "project_list",
              "mesh_processes", "usage_report", "trace_list"],
    "think": false,                // thinking off: first token in tens of ms instead of seconds
    "numCtx": 16384,               // persona + tools + one tool result fit with room; 8k is too tight after a tool call
    "keepAlive": "30m",            // Ollama keep_alive per request; the warm-up keeps it resident
    "maxRounds": 4,                // tool rounds before it hands over ([[ESCALATE]] equivalent)
    "guard": true,                 // narration guard: "Let me check…" without a tool call → one nudge (§5.4)
    "firstTokenMs": 2500,          // no token by then → Haiku answers instead (5.5)
    "timeoutMs": 30000             // whole local turn; after that → full brain, like today's quick timeout
  }
}
```

Speech settings are not part of this block: the voice that speaks a reply is the UI's existing voice output (§2,
§5.8), so a reply from the responder is spoken exactly like a Haiku reply.

CLI and API (thin additions to existing surfaces): `rigs quick local on|off|status|model <name>|node <name>`
(`bin/rigs.js`, next to `rigs quick`), `POST /api/local/quick {local:{…}}` (already the quick endpoint,
`src/server.js:909-915`), and on the host `GET /api/local/responder` (enabled, model, loaded?, VRAM, last error) and
`POST /api/local/responder/warm`.

### 5.3 Tools: a read-only subset of the rigs MCP

The responder calls the **same tool code** as every agent: `TOOLS` exported by `src/mcp.js:112`, whose `run`
functions call this daemon's HTTP API. No second implementation, and results are identical to what Haiku sees.

| tool | answers | notes |
| --- | --- | --- |
| `mesh_status` | machines, online state, CPU/memory, agents | |
| `mesh_sessions` | running sessions and agents | can take seconds (mesh snapshot); output trimmed to live sessions |
| `mesh_apps` | App Cloud apps and health | |
| `project_list` | projects, tasks, progress | |
| `mesh_processes` | processes on one machine | read-only listing |
| `usage_report` | tokens, time, cost | |
| `trace_list` | Sir's recent requests and their outcome | |

Rules:
- `src/responder.js` holds a hard-coded `READ_ONLY` set. `quick.local.tools` can only narrow it; a configured name
  outside the set is ignored (logged once), so config can never hand the local model `mesh_exec`, `mesh_write_file`,
  `mesh_send`, `mesh_start_agent`, `mesh_kill`, `jarvis_task`, `project_*`, `linear_create/update/comment`,
  `mesh_control`/`mesh_screen`/`mesh_windows` (the control gate stays untouched), `mesh_notify`, `tool_run`,
  `rigs_*` or `mesh_update`.
- Anything outside the set, and anything that needs the web, files, commands or delegation → `[[ESCALATE]]` → the
  normal JARVIS thread, as today. A tool call to a name the model was not given counts as an escalation, not an error.
- Each tool result is cut to ~6 kB before it goes back to the model (it lands in the prompt of the next round).

### 5.4 Prompt: JARVIS's character, the responder's own rules, a cacheable prefix

`responderPrompt` (pure, in `src/responder.js`; the benchmark's v2 is the reference implementation,
`scripts/bench/responder-bench.mjs`):
1. `SOUL.md` (the same file `chat.soul()` reads, Sir's own copy wins) **without** its "Work: every instruction lands
   somewhere" section and without the calibration exchanges that file work or report a status (`responderSoul`). With
   them in, small models answered "It's filed under RIGS and Sonnet is already at it" without being able to file
   anything, and "All quiet, sir" without looking (§3.2).
2. The role: first responder on a local model, the address and humour setting, the spoken/written reply format.
3. "Facts about the mesh come only from tools": a one-line map from kind of question to tool. Without it, most models
   answered "How is the mesh doing?" from imagination.
4. "What you cannot do" and the `[[ESCALATE]]` rule, last (small models weight the end).
5. The volatile line (local time, machine) at the very end; recent messages and the router hint go in the messages,
   not the system prompt.

The first ~3.3k tokens never change, so Ollama reuses their KV cache between turns: on qwen3:8b a turn's prompt costs
8–12 ms instead of ~290 ms. Anything per-request placed early in the prompt would throw that away.
`persona/AGENTS.md` (the full brain's operating rules: filing work, projects) is left out on purpose.

**Narration guard** (in the runner, `quick.local.guard`): when a round ends without a tool call and its spoken part
only announces a lookup (`narratedToolCall`: "let me check / I'll look / scanning …", under 200 chars), the runner
keeps that text as the spoken opener (it has already been streamed and spoken — "Let me check the mesh status."),
appends a one-line system nudge to call the matching tool now without repeating the opener, and runs one more round.
At most once per turn. This is what takes qwen3:8b from 31/39 to 39/39 (§3.2); it costs one extra round (~0.5 s) on
the asks where it fires and nothing elsewhere.

### 5.5 Fallback chain

| what happens | detected | what Sir gets |
| --- | --- | --- |
| responder off, tier not covered, a Claude tier forced | `localResponder` → `on: false` | today's path, unchanged |
| host offline / not running RIGS, Ollama down, model not installed | before the request (peer list, `/api/ps`, HTTP error) | Haiku quick turn (`unavailable`), trace event `responder-fallback` |
| model not loaded (evicted by the GPU overseer, first use) | `/api/ps` on the host before the turn | Haiku answers this one; the host warms the model in the background |
| no first token within `firstTokenMs` | timer in `runResponder` | abort, Haiku answers (nothing was shown, no reset needed) |
| Ollama rejects the model's tool call (`HTTP 500 error parsing tool call`, seen once with gpt-oss) | HTTP error | before any text: `unavailable` → Haiku; after text: the error row below |
| error or disconnect after text was streamed | stream error | `{ error }` → today's quick-lane error path: re-run on the full brain with `reset: true` |
| model replies `[[ESCALATE]] …`, asks for a tool it doesn't have, or uses up `maxRounds` | `parseEscalation` / runner | `{ escalate }` → full JARVIS thread, as today |
| whole local turn exceeds `timeoutMs` | quick-lane timer | full JARVIS thread, as today |
| Haiku fallback itself fails | today's handling | full JARVIS thread, as today |

The order matters: a cold or missing local model must never make Sir wait for a model load (6–20 s measured) — Haiku
is the safety net for "can't start", the full brain stays the net for "can't answer".

### 5.6 Other machines: the host runs the turn

Today the quick lane runs on the main-brain machine (macbookpro), and the GPU is on magix-system. The responder
therefore runs **where the model is** and streams back:

- **Host route** (magix-system): `POST /api/local/responder/turn`, NDJSON stream, behind the same auth as every
  `/api/local/*` route (`src/auth.js`: loopback, same-owner tailnet device, or the mesh token). Body
  `{ text, context: [{role, text}] (last 6, ≤800 chars each, like recentContext), hint, trace: {traceId, parentId} }`.
  Events: `start`, `delta`, `tool` (name, input), `status`, `done` `{ text, usage }`, `error`, and `unavailable`
  `{ reason }` (always before any `delta`). The host builds the prompt from its own `SOUL.md`, runs the model on its own
  Ollama (`127.0.0.1:11434`, which stays bound to loopback — nothing new is exposed on the tailnet) and runs the tools
  itself; the mesh tools return the same mesh-wide data on any machine.
- **Caller** (`runResponder` on the main-brain machine): `node !== self` → `discovery.get(node)`, then a streamed POST
  to the peer's `/api/local/responder/turn` with the mesh token when `viaToken` (the same headers `peerJson` sends,
  `src/proxy.js`); a peer that is offline or not running RIGS → `unavailable`.
- **Trace**: the caller records the brain-turn span; the host writes the tool-call spans under the passed `trace`
  context with its own node name (as task runs already do), so the trace explorer shows one request across both machines.
- **Latency**: the tailnet path magix-system ↔ macbookpro is direct LAN, 10 ms round trip (`tailscale ping`).
- Every UI keeps working unchanged: it posts `jarvis/send` to its own daemon, which relays to the main brain.
- If Sir makes magix-system the main-brain machine, `node` equals `self` and the turn runs in-process with no hop.

### 5.7 GPU memory and the GPU overseer

Measured on the 4090 (24 GB), `nvidia-smi` deltas:

| holder | VRAM |
| --- | --- |
| responder, qwen3:8b at 16k context | 7.6 GB (~9.5–10 GB at Ollama's default 32k, as `claude -p` loads it) |
| JARVIS Voice: Kokoro / Kokoro + Whisper | 1.2–1.5 GB / 3.6 GB |
| LocalJev emotions, `qwen2.5vl:7b` (same Ollama) | 7.0 GB |
| ComfyUI with a model loaded (its lease asks for 18 GB) | 13.4 GB |
| idle CUDA contexts (ComfyUI, voice) | ~1.1 GB |

Responder + voice + Whisper + emotions = ~18 GB: they fit together. Add ComfyUI's 13–18 GB and something has to go,
which is the overseer's job. Today it can't do that job for Ollama: its `ollama-emotion` client matches `"ollama
runner"`, but this Ollama (snap) runs each model as `…/lib/ollama/llama-server --model …/blobs/sha256-<digest> -c <ctx>`,
so every Ollama model shows up as `client: null` — invisible, never evicted, while the voice is evicted instead.

Design:
- Add an overseer client for the responder in `~/apps/gpu-overseer/clients.json` (a setup step on the host, outside
  this repo; the `rigs quick local on` path can write it when missing):
  ```json
  { "id": "ollama-responder", "name": "JARVIS live responder (Ollama)",
    "match": "blobs/sha256-<digest of the responder model's GGUF>",
    "unload": { "url": "http://127.0.0.1:11434/api/generate", "body": { "model": "qwen3:8b", "keep_alive": 0 } },
    "busy": { "url": "http://127.0.0.1:4719/api/local/responder/busy", "method": "GET" } }
  ```
  The digest comes from `GET /api/show` (the model's GGUF layer) when the responder warms up. `busy` is true while a
  turn runs, so the overseer never evicts it mid-sentence. (The same fix applies to `ollama-emotion`: match its blob.)
- The responder asks for a lease (`POST :8195/api/acquire {client:'ollama-responder', need_mb: 8000}`) before its
  warm-up and keeps the model resident with `keep_alive` (`quick.local.keepAlive`, re-sent with every request). When
  ComfyUI needs the room, the overseer unloads the idle responder; the next ask finds it cold (`/api/ps`), Haiku
  answers that one (§5.5) and the host re-warms in the background once the lease is granted again. Sir's explicit
  generation job wins over a warm responder; the conversation keeps working on Haiku meanwhile.
- **Keep the voice resident while the responder is on**: today the voice is the overseer's favourite eviction (55 times
  in 24 h, 2.1 s reload each). Mark `jarvis-voice` non-evictable (it is 1.2–1.5 GB) or give it priority over Ollama;
  otherwise a 30 ms reply is spoken 2 s late.
- If the overseer is down, the responder works without a lease (as the gpu-lease tool does).

### 5.8 Speech: what plugs in where

Nothing new on the speech path is needed to make the responder speak (§2): its `delta` events flow out of
`jarvis/send` like any brain's, and `ui/src/voice.js` turns them into sentences, Kokoro audio, lipsync and the orb on
whichever machine Sir is using. The choices this design makes:

- **Engine and voice: Kokoro-82M via the existing `jarvis-voice` applet, voice `bm_george`** (§3.4). The current
  default blend (70 % George, 30 % Fable) is equally fine if Sir prefers it after listening to the samples; the blend
  stays the default until he picks. No `tts` block in `quick.local`: the voice is JARVIS's voice for every lane.
- **Fallback voice: Piper `en_GB-alan-medium` as a resident process** (not today's per-call CLI in `src/tts.js:155-156`,
  which costs 1.2–1.4 s per sentence because it reloads the model each time): for when the GPU lease fails and for
  machines without a GPU. Kokoro on CPU (0.5–1.9 s per sentence) is too slow for a first sentence.
- **Trim Kokoro's padding** in the applet's `synth()`: every clip has ~280 ms of leading and 0.5–0.9 s of trailing
  silence ("Good evening, sir." comes back as a 2.0 s WAV). Trimming to ~30 ms lead / ~150 ms tail (and shifting the
  viseme cues by the trimmed lead) brings the first sound ~250 ms sooner and cuts the gap between sentences from
  ~0.8 s to ~0.2 s — more than the whole TTS synthesis time.
- **First sentence first**: the responder's spoken line comes first (prompt §5.4), so the first `voice.feed()`
  sentence completes ~55 ms after the first token. The escalation gate holds text only until it can no longer be
  `[[ESCALATE]]` (12 characters). Optional UI tweak: release a long first sentence at its first comma
  (`voice.js:201-210` waits for the whitespace after the punctuation).
- **Hand-over**: when the responder escalates, nothing was spoken (the gate swallowed the marker). When it is cut off
  after speaking (error → full brain), the existing `status {reset:true}` clears the subtitle but lets the current
  sentence finish; the full brain's sentences queue after it — the right first-responder behaviour, no change needed.
- **Listening**: the 0.9 s end-of-utterance silence wait (`hearing.js:99`) is now the largest fixed delay between Sir
  and the first word of a reply. It can be tuned (e.g. 0.6 s hands-free) in a separate UI task; it is not part of
  this design's acceptance.
- **Speech with no UI open** (`tts.speakAloud`) speaks whole texts; sentence chunking there is only needed if the
  responder is used for headless notifications, which it is not.

Latency budget for a spoken answer, warm, on magix-system (tool-free question): pre-router (~0.5 s with LocalJev,
3–15 s without — unchanged by this design) → responder first sentence ~0.06 s → Kokoro ~0.03–0.05 s → padding
0.28 s (0.03 s trimmed) → audio. With a read-only tool: + ~0.6–0.9 s.

### 5.9 Observability

- Trace: the brain-turn span is `ollama <model>` with `meta.lane = 'quick'`, `local: true`, `node`, tier; tool calls
  come from the Ollama stream (`toolCollector`, `src/trace.js:283` already parses Ollama `tool_calls`); a fallback is
  an `event` span `responder-fallback` with the reason.
- Ledger: the chat-turn record has `provider: 'ollama'`, the model, `lane: 'quick'`, tokens from Ollama's final chunk
  (`ollamaUsage`), cost 0. The request record is unchanged (`lane`, `tier`, `escalated`, `timeToReplyMs`), so
  `preroute_stats` and the usage panel need no change; add `local: true` to the request's timing so before/after can be
  compared.
- The UI already shows `start.brain/model` and `lane: 'quick'`; it will read "ollama · <model>".

### 5.10 Files

New: `src/responder.js` (prompt, read-only tool set, Ollama tool loop, remote client, host handler; pure parts
exported), `test/responder.test.js`.

Changed (small, additive):
- `src/quick.js` — `local` in `quickSettings` / `applyQuickPatch`; pure `localResponder()`.
- `src/chat.js` — the one branch in `quickTurn` (5.1).
- `src/server.js` — `responder/turn`, `responder` (status), `responder/warm` routes.
- `bin/rigs.js` — `rigs quick local …`.
- `AGENTS.md` — a `src/responder.js` row; the `src/quick.js` row mentions `quick.local`.
- `ui/src/graphify-structure.js` — the quick-path node gains the local responder (its test reads the source).
- `~/apps/gpu-overseer/clients.json` on magix-system (outside the repo) — the client entry from 5.7.

Must **not** change: `src/router.js`, `src/planner.js`, `src/work.js`, `src/hubs.js`, `src/autonomy.js`. Not needed
either: `src/globalbrain.js` (the block rides on the existing `quick` sync), `src/mcp.js` (its `TOOLS` are imported
as they are), `jarvisSend` and `resolveQuick` in their current form.

### 5.11 Tests the implementation should add

- `localResponder`: off by default; on for the haiku tier only; a forced `'sonnet'`/`'haiku'` request stays on Claude;
  `quickSettings` keeps and validates `local` (unknown tool names dropped, numbers clamped).
- `responderPrompt`: no "Work" section, no filing or status calibration example, tool map present, escalation rule
  last, stable prefix (two calls a minute apart differ only in the last line).
- `narratedToolCall`: true for "Let me check the mesh status." / "Scanning the mesh…", false for answers and
  pleasantries ("Canberra, sir.", "I will be here, sir."); the nudge fires at most once per turn.
- `runResponder` against a fake Ollama (an HTTP server that streams canned `/api/chat` chunks): tool round → answer;
  `[[ESCALATE]]` → `{ escalate }` via the existing gate; no first token in time → `unavailable`; a tool outside the
  set → escalate; host offline → `unavailable`.
- `quickTurn` with `opts`-injected runners: `unavailable` → Haiku runs once, nothing reset; escalate → `jarvisSend`
  re-runs on the full brain; `quick.local.enabled: false` → byte-for-byte today's path (existing `test/quick.test.js`
  keeps passing).
- An e2e like `scripts/e2e-quick-path.js` with the responder on, recording `timeToReplyMs` against Haiku.

## 6. Rerunning the benchmarks

LLM (`scripts/bench/responder-bench.mjs`, filed in the tool registry as `responder-bench`; JSON arguments as argv[2],
stdin or `RIGS_TOOL_ARGS`; progress on stderr, one JSON result on stdout with a markdown `table`):

```bash
# §3.2: the local models, direct Ollama tool loop, prompt v2, all 13 asks × 3 (≈2 min per model);
# add "guard":false for the "correct, 39 asks" column, leave it on (default) for "with narration guard"
node scripts/bench/responder-bench.mjs '{"models":["qwen3:8b","gpt-oss:20b","qwen3:14b"],"styles":["direct"],"runs":3,"questions":"all","out":"/tmp/direct.json"}'
# the first round: the 5 core asks with prompt v1
node scripts/bench/responder-bench.mjs '{"models":["qwen3:8b"],"styles":["direct"],"runs":3,"prompt":"v1","guard":false}'
# the same model through `claude -p` against Ollama (today's "Claude via Ollama")
node scripts/bench/responder-bench.mjs '{"models":["qwen3:8b"],"styles":["claude-ollama"],"runs":2}'
# the Haiku quick-lane baseline (real persona + quickNote; costs a few cents)
node scripts/bench/responder-bench.mjs '{"styles":["claude"],"runs":2}'
```

Before a run on magix-system, make room on the GPU the way every app here does (ComfyUI may hold 13 GB):
`curl -X POST 127.0.0.1:8195/api/acquire -d '{"client":"responder-bench","need_mb":21000,"timeout":120}'`, and
`/api/release` afterwards. The direct style calls the real read-only mesh tools through this machine's daemon; the
claude styles load only the rigs MCP server and disallow every tool except the read-only set, so no run can file work
or change anything. Numbers move with what else is on the GPU and with the mesh snapshot time (`mesh_sessions`);
the order of magnitude and the ranking are what reproduce.

TTS (`scripts/bench/tts-bench.py`, filed as `tts-bench`; stdlib only, one JSON object in on stdin, one out on stdout;
each engine runs in its own interpreter so Kokoro can use the jarvis-voice venv and Piper its own):

```bash
python3 -m venv /tmp/tts/venv && /tmp/tts/venv/bin/pip install piper-tts
# voices: https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_GB/<voice>/<quality>/<file>.onnx (+ .onnx.json)
python3 scripts/bench/tts-bench.py <<'EOF' > /tmp/tts/results.json
{"runs": 5, "warmup": 1, "samples_dir": "/tmp/tts/samples", "gpu_min_free_mb": 2500,
 "engines": [
  {"engine": "http", "name": "jarvis path", "url": "http://127.0.0.1:4719/api/local/tts", "gpu": true, "voices": [""]},
  {"engine": "kokoro", "python": "~/apps/jarvis-voice/.venv/bin/python", "device": "cuda",
   "voices": ["bm_george", "bm_lewis", "bm_daniel", "bm_fable"]},
  {"engine": "piper", "python": "/tmp/tts/venv/bin/python", "models": ["/tmp/tts/en_GB-alan-medium.onnx"]}
 ]}
EOF
```

GPU entries wait for `gpu_min_free_mb` of free VRAM (and for any `gpu_wait_for_absent` lock files) so the benchmark
never pushes the overseer into evicting other apps' models. For speech-to-text, the same applet's `/stt` was timed
with Piper-generated speech through `POST /api/local/stt`.

## 7. Open points

- **The pre-router dominates once the responder is on.** It is outside this design (router.js must not change), but
  LocalJev being up on magix-system is what keeps it at ~0.5 s instead of 3–15 s.
- **Listening delay**: 0.9 s of silence before Whisper is sent the utterance (§5.8) — a separate, small UI task.
- **GPU overseer fixes** (§5.7) live outside the repo (`~/apps/gpu-overseer`): the responder client entry, blob-based
  matching for Ollama models (also for `ollama-emotion`), and keeping the voice resident.
- **Kokoro padding trim** (§5.8) is a change to the jarvis-voice applet, also outside the repo.
- **Models pulled for this benchmark** (~57 GB on magix-system, disk now 96 % full): `qwen3:8b` (keep — the choice),
  `gpt-oss:20b` (keep — the alternative), and removable with `ollama rm` once Sir has no use for them:
  `llama3.1:8b`, `qwen3:14b`, `qwen3.5:9b`, `mistral-small3.2:24b`, `gemma4:latest`.

## 7. Speech engine (task t3)

Implemented on the existing path (§2, §5.8); nothing replaces the current voice.

- `persona.tts.engine`: `auto` (default: neural Kokoro → resident Piper → the machine's own engine) | `neural` | `piper` | `local`. The chosen engine goes first, the others stay as silent fallback (`src/tts-plan.js`, wired in `src/tts.js`; failures are logged `[tts] <engine> failed, falling back`, never sent to the UI). `persona.tts.piperUrl` (default `http://127.0.0.1:8210`), `persona.tts.trim: false` disables trimming.
- Resident Piper `en_GB-alan-medium`: `applets/piper-voice/server.py` (unit `jarvis-piper.service`, `~/apps/jarvis-piper`, port 8210, `/healthz`, `POST /tts`), registered as App Cloud app `piper-voice`; reachable from other nodes at `/api/nodes/magix-system/apps/piper-voice/tts`. ~60 ms per sentence.
- Silence trim in the daemon (`trimSilence`): the neural clip loses its lead/tail silence (30 ms lead, 150 ms tail kept) and the viseme cues are shifted: "Good evening, sir." 2.00 s → 1.35 s.
- UI: chunking moved to `ui/src/sentences.js` (fixes a dropped-prefix bug on "3.5 …"); the first chunk of a reply may end at a comma after 80 chars.
- Follow-up (not built): speech input is Web Speech / mesh Whisper, already local; nothing cloud-dependent to swap.

## 8. JARVIS UI control and end-to-end check (task t4)

- **Control**: Brain popover (◆ badge) → "Local responder (<host>)", under Pre-routing. Switch = `config.quick.local.enabled` (mesh-global, off by default); switching on also warms the model on the host. Model dot: green loaded (+ VRAM), amber installed but not loaded, red missing / Ollama or host unreachable. Voice dot: the speech engine `/api/local/tts` reports. The line under it says where it is configured (`config.quick.local`, `rigs quick local on|off|status`). Files: `ui/src/local-responder.js`, `ui/src/local-responder-model.js`.
- **Reply label**: a reply the local model answered shows "local · qwen3:8b" next to ◆ JARVIS (and a `local` activity chip, and "· local" in the conversation window). It is taken from the turn's `done` event, so a turn that fell back to Haiku is not labelled local.
- **End-to-end run** (2026-10-20, real UI in headless Chromium against a scratch daemon from this worktree on magix-system, loopback only): screenshots and every turn's trace summary in `docs/local-responder-e2e/` (`e2e-result.json`; 390x844 audit by the `mobile-audit` tool in `mobile-audit/`, 0 overflow, 0 small targets, 0 axe violations). Greeting, "How is the mesh doing?" (a real `mesh_status` call) and "What is the capital of Australia?" were answered by `ollama qwen3:8b`, tier local, cost 0, spoken by the neural voice; "Build me a small web app …" went router `implement` → the full brain → `jarvis_task` handoff (filed after 22 s); switched off, the same questions were answered by Haiku again.
- **Latency on that run** (GPU shared with ComfyUI's 17.5 GB lease, so qwen3:8b had 4.3 of 7.4 GB on the GPU): brain turn 7.5–10.3 s local (15.4 s with the tool call) vs 6.8–9.3 s Haiku; time to reply 14.9–17.8 s local vs 14.3–16.7 s Haiku, of which the router is ~7 s either way. With the GPU free the benchmark (§4) has a first token in tens of ms.
- **VRAM conflict found**: on magix-system the pre-router (`router.engine: jev`) and the face's emotion classifier both call localjev, which runs `qwen2.5vl:7b` on the same Ollama. While ComfyUI holds its lease only one of the two models fits, so every request first loads qwen2.5vl, which evicts qwen3:8b, and the responder falls back to Haiku ("not loaded yet (warming it up)") — every time. The run above therefore used the router's Claude engine and the emotion guess on the scratch node (routing code unchanged; jev was timing out after 8 s anyway and the Claude fallback decided). Options for Sir: point localjev and the responder at one model, give localjev a smaller model, or keep the responder on the CPU / a smaller context while the GPU is leased.
