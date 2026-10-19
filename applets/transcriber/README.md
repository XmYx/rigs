# Transcriber applet

Speech-to-text with **Hungarian as the default language**, from the **microphone** or from an **audio/video file**.
It runs locally (no audio leaves the machine) and shows up in JARVIS like every other App Cloud app.

- **Engine:** [faster-whisper](https://github.com/SYSTRAN/faster-whisper) with `large-v3-turbo`, in `worker.py`, a Python
  process that `server.js` starts on first use, feeds one job at a time and stops after 5 idle minutes so the GPU memory
  goes back to ComfyUI and the others. On an NVIDIA GPU it asks the GPU overseer (`:8195`) for a lease and runs fp16
  (about 60× real time); when the GPU is busy or absent it falls back to CPU int8.
- **Language:** the picker sends `lang=hu` explicitly (Whisper is told the language, not left to guess). `Auto-detect`
  and 14 other languages are in the same list.
- **Input:** the Microphone tab records with `MediaRecorder` (Opus, 128 kbit/s, browser noise suppression and gain control
  off because they hurt recognition) and transcribes when you press stop. The file tab takes anything ffmpeg can read (wav, mp3, m4a, ogg,
  flac, webm, mp4, mkv, …), up to 500 MB. Segments appear with timestamps while a long file is still running.
- **Output:** copy, or download as `.txt`, `.srt`, `.vtt` or `.json`. The last 50 transcripts are kept in
  `~/.rigs/transcriber/history.json` (the audio itself is deleted as soon as the job ends).

## Install the speech engine

```bash
applets/transcriber/scripts/setup.sh            # venv at ~/.rigs/transcriber/venv, CUDA wheels when an NVIDIA GPU is there
applets/transcriber/scripts/setup.sh --cpu      # CPU only
```

`server.js` looks for Python in `TRANSCRIBER_PYTHON`, then `~/.rigs/transcriber/venv`, then the JARVIS Voice venv
(`~/apps/jarvis-voice/.venv`, which already has faster-whisper). Needs `ffmpeg` on PATH. On Windows: create a venv,
`pip install faster-whisper`, and set `TRANSCRIBER_PYTHON` (CPU only).

## Publish (the App Cloud rule)

Run from the RIGS checkout on the machine that has the compute:

```json
tool_run app-publish { "id": "transcriber", "name": "Transcriber", "icon": "🎙️", "port": 8741,
  "command": "node applets/transcriber/server.js", "cwd": "~/.rigs/app",
  "description": "Speech-to-text, Hungarian by default, from the microphone or an audio file (local faster-whisper large-v3-turbo).",
  "tags": ["transcribe", "speech", "whisper", "hungarian", "stt", "microphone", "audio"] }
```

That writes and enables `rigs-transcriber.service` (`systemctl --user`), waits for `/healthz` and registers the app.

## Settings

Environment (`TRANSCRIBER_*`) or `~/.rigs/config.json` → `"transcriber": { … }`:

| Setting | Default | |
| --- | --- | --- |
| `port` / `host` | `8741` / `127.0.0.1` | |
| `model` | `large-v3-turbo` | any faster-whisper model name, e.g. `large-v3` |
| `device` | `auto` | `auto` (GPU via overseer, else CPU), `cuda`, `cpu` |
| `defaultLanguage` | `hu` | |
| `idleSec` | `300` | stop the worker (free the GPU) after this long without a job; `0` = never |
| `maxMb` | `500` | upload limit |
| `python`, `dataDir`, `overseer` | see above | `overseer: ""` skips GPU arbitration |

## Test it

```bash
node --test test/transcriber.test.js     # fake worker, no model or GPU needed
```

Hungarian by hand: open the app in JARVIS, leave the language on *Magyar*, press **Start recording**, say
"A tervek szerint kedden vágták volna ki, de a bíróság rendkívüli döntése megmentette ettől." and press stop. Or drop a
Hungarian recording on the *Audio file* tab.

Measured on 15 distinct sentences of the Google FLEURS `hu_hu` dev set (298 words, real speakers), lower-cased and
without punctuation, no number/compound normalisation: `large-v3-turbo` 16.1 % WER, `large-v3` 18.1 % (both CPU int8,
beam 5), so the lighter and faster turbo model is the default. The same clips on the GPU (fp16) gave 16.4 % at about 66× real time.
Most remaining differences are compounds written apart or together and numerals (`21:20` vs `21-20`).

## API

`GET api/status`, `POST api/jobs?lang=hu&name=…&source=mic|file` (body = the audio), `GET api/jobs`, `GET|DELETE api/jobs/<id>`,
`GET healthz`. Everything is relative, so it works under `/api/nodes/<node>/apps/transcriber/`.
