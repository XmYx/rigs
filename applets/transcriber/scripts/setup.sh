#!/usr/bin/env bash
# Install the speech engine for the Transcriber applet: faster-whisper in its own virtualenv at
# ${RIGS_HOME:-~/.rigs}/transcriber/venv (the applet finds it there), and optionally pre-download the model.
#   applets/transcriber/scripts/setup.sh            # GPU libraries too when an NVIDIA GPU is present
#   applets/transcriber/scripts/setup.sh --cpu      # CPU only (int8), no CUDA wheels
#   applets/transcriber/scripts/setup.sh --model large-v3   # fetch another model now (default: large-v3-turbo)
# Needs python3 (3.9+) and ffmpeg on PATH. Safe to re-run.
set -euo pipefail

HOME_DIR="${RIGS_HOME:-$HOME/.rigs}/transcriber"
VENV="$HOME_DIR/venv"
MODEL="large-v3-turbo"
CPU_ONLY=0
while [ $# -gt 0 ]; do
  case "$1" in
    --cpu) CPU_ONLY=1 ;;
    --model) MODEL="${2:?--model needs a name}"; shift ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
  shift
done

command -v ffmpeg >/dev/null || { echo "ffmpeg is required (apt install ffmpeg / brew install ffmpeg)" >&2; exit 1; }
mkdir -p "$HOME_DIR"
if [ ! -x "$VENV/bin/python" ]; then
  if command -v uv >/dev/null; then uv venv "$VENV"; else python3 -m venv "$VENV"; fi
fi
if command -v uv >/dev/null; then PIP=(uv pip install --python "$VENV/bin/python"); else PIP=("$VENV/bin/python" -m pip install); fi

PKGS=(faster-whisper)
# CTranslate2 (inside faster-whisper) is built for CUDA 12: worker.py loads these wheels itself, no system CUDA needed.
if [ "$CPU_ONLY" = 0 ] && [ "$(uname -s)" = Linux ] && command -v nvidia-smi >/dev/null && nvidia-smi -L >/dev/null 2>&1; then
  PKGS+=(nvidia-cublas-cu12 "nvidia-cudnn-cu12==9.*")
fi
"${PIP[@]}" "${PKGS[@]}"

"$VENV/bin/python" - "$MODEL" <<'PY'
import sys
from faster_whisper import download_model
import faster_whisper
print("faster-whisper", faster_whisper.__version__)
print("model cached at", download_model(sys.argv[1]))
PY
echo "Speech engine ready: $VENV/bin/python"
