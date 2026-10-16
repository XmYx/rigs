#!/usr/bin/env bash
# RIGS OS installer for macOS and Linux (Ubuntu, incl. Wayland).
#   curl -fsSL https://raw.githubusercontent.com/XmYx/rigs/main/scripts/install.sh | bash
# Options (env vars):
#   RIGS_DIR=~/.rigs/app       where to clone the repo
#   RIGS_REPO=https://github.com/XmYx/rigs.git
#   RIGS_NAME=<machine name>   defaults to the short hostname
#   RIGS_AGENTS=1              install missing Claude Code / Codex / Ollama (0 to skip)
#   RIGS_DESKTOP=0             skip Sunshine (host) + Moonlight (client) — installed by default
#   RIGS_HTTPS=1               expose the UI via `tailscale serve` (https, enables the microphone remotely)
#   RIGS_SETUP_ARGS="..."      extra args for `rigs setup`
set -euo pipefail

RIGS_DIR="${RIGS_DIR:-$HOME/.rigs/app}"
RIGS_REPO="${RIGS_REPO:-https://github.com/XmYx/rigs.git}"
RIGS_AGENTS="${RIGS_AGENTS:-1}"
RIGS_DESKTOP="${RIGS_DESKTOP:-1}"
RIGS_HTTPS="${RIGS_HTTPS:-0}"
OS="$(uname -s)"
ARCH="$(uname -m)"

c() { printf '\033[36m▸ %s\033[0m\n' "$*"; }
ok() { printf '  \033[32m✓\033[0m %s\n' "$*"; }
warn() { printf '  \033[33m!\033[0m %s\n' "$*"; }
have() { command -v "$1" >/dev/null 2>&1; }
SUDO=""; if [ "$(id -u)" -ne 0 ] && have sudo; then SUDO="sudo"; fi

apt_install() { $SUDO apt-get update -qq && $SUDO DEBIAN_FRONTEND=noninteractive apt-get install -y -qq "$@"; }

# ---------------------------------------------------------------- prerequisites
c "Prerequisites ($OS $ARCH)"
if [ "$OS" = "Darwin" ]; then
  if ! have brew; then
    warn "Homebrew not found — installing (needs your password once)"
    /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
    eval "$(/opt/homebrew/bin/brew shellenv 2>/dev/null || /usr/local/bin/brew shellenv)"
  fi
  for p in git tmux; do have "$p" || brew install "$p"; done
else
  have apt-get || { warn "This installer targets Ubuntu/Debian; install git, tmux, curl, build-essential and Node 22 manually."; }
  PKGS=""
  for p in git tmux curl; do have "$p" || PKGS="$PKGS $p"; done
  have ssh || PKGS="$PKGS openssh-client"
  [ -e /usr/sbin/sshd ] || PKGS="$PKGS openssh-server"
  have ps || PKGS="$PKGS procps"
  [ -n "$PKGS" ] && apt_install $PKGS
fi
ok "git $(git --version | awk '{print $3}'), tmux $(tmux -V | awk '{print $2}')"

# Node.js 22+ (OpenRig and REA require it)
node_major() { node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0; }
if [ "$(node_major)" -lt 22 ]; then
  if [ -s "$HOME/.nvm/nvm.sh" ]; then
    # shellcheck disable=SC1091
    # Install 22 next to whatever you use; RIGS pins its absolute path, your nvm default is left alone.
    . "$HOME/.nvm/nvm.sh"; nvm install 22 >/dev/null 2>&1
    NODE22="$(nvm which 22)"; export PATH="$(dirname "$NODE22"):$PATH"
  elif [ "$OS" = "Darwin" ]; then
    brew install node@22 && brew link --overwrite --force node@22
  else
    curl -fsSL https://deb.nodesource.com/setup_22.x | $SUDO -E bash - && apt_install nodejs
  fi
fi
ok "node $(node -v)"
# Global npm installs without sudo on Linux.
if [ "$OS" != "Darwin" ] && [ ! -w "$(npm prefix -g)/lib" ]; then
  npm config set prefix "$HOME/.npm-global"
  export PATH="$HOME/.npm-global/bin:$PATH"
  grep -q '.npm-global/bin' "$HOME/.profile" 2>/dev/null || echo 'export PATH="$HOME/.npm-global/bin:$PATH"' >> "$HOME/.profile"
fi

# ---------------------------------------------------------------- Tailscale
c "Tailscale"
if ! have tailscale && [ ! -x /Applications/Tailscale.app/Contents/MacOS/Tailscale ]; then
  if [ "$OS" = "Darwin" ]; then brew install --cask tailscale-app || brew install --cask tailscale; else curl -fsSL https://tailscale.com/install.sh | sh; fi
fi
if [ "$OS" = "Darwin" ]; then
  [ -x /Applications/Tailscale.app/Contents/MacOS/Tailscale ] && ok "Tailscale app installed — open it from Applications and sign in (same account on every machine)"
else
  if ! tailscale status >/dev/null 2>&1; then
    warn "Signing in to Tailscale (follow the link)."
    $SUDO tailscale up || warn "run: sudo tailscale up"
  else
    ok "Tailscale up: $(tailscale ip -4 2>/dev/null | head -1)"
  fi
  # Mesh SSH is OpenSSH with RIGS-managed keys; Tailscale SSH would take over port 22 on the tailnet.
  $SUDO tailscale set --ssh=false >/dev/null 2>&1 || true
  $SUDO systemctl enable --now ssh >/dev/null 2>&1 || $SUDO systemctl enable --now sshd >/dev/null 2>&1 || true
fi
if [ "$OS" = "Darwin" ] && ! nc -z 127.0.0.1 22 >/dev/null 2>&1; then
  warn "Enable SSH: System Settings → General → Sharing → Remote Login (or: sudo systemsetup -setremotelogin on)"
fi

# ---------------------------------------------------------------- coding agents
if [ "$RIGS_AGENTS" = "1" ]; then
  c "Coding agents"
  if ! have claude; then curl -fsSL https://claude.ai/install.sh | bash || warn "Claude Code install failed"; export PATH="$HOME/.local/bin:$PATH"; fi
  have claude && ok "Claude Code $(claude --version 2>/dev/null | head -1)"
  have codex || npm install -g @openai/codex >/dev/null 2>&1 || warn "Codex install failed"
  have codex && ok "Codex $(codex --version 2>/dev/null | head -1)"
  if ! have ollama; then
    if [ "$OS" = "Darwin" ]; then brew install ollama && (brew services start ollama >/dev/null 2>&1 || true); else curl -fsSL https://ollama.com/install.sh | sh; fi
  fi
  have ollama && ok "Ollama $(ollama --version 2>/dev/null | tail -1)"
fi

# ---------------------------------------------------------------- remote desktop
# Sunshine + Moonlight are installed by `rigs setup` (latest GitHub releases, see src/desktop-install.js).
# Here we only finish the root step interactively, since you're at the keyboard anyway (see below).
[ "$RIGS_DESKTOP" = "1" ] || RIGS_SETUP_ARGS="${RIGS_SETUP_ARGS:-} --no-desktop"

# ---------------------------------------------------------------- RIGS itself
c "RIGS → $RIGS_DIR"
if [ -d "$RIGS_DIR/.git" ]; then
  git -C "$RIGS_DIR" pull --ff-only || warn "could not fast-forward $RIGS_DIR (local edits?)"
else
  mkdir -p "$(dirname "$RIGS_DIR")"
  git clone "$RIGS_REPO" "$RIGS_DIR"
fi
cd "$RIGS_DIR"
npm install --no-audit --no-fund
mkdir -p "$HOME/.local/bin"
# A wrapper (not a symlink) so `rigs` always runs on Node 22+, whatever node your shell defaults to.
NODE_BIN="$(command -v node)"
rm -f "$HOME/.local/bin/rigs"
printf '#!/bin/sh\nexec "%s" "%s/bin/rigs.js" "$@"\n' "$NODE_BIN" "$RIGS_DIR" > "$HOME/.local/bin/rigs"
chmod +x "$HOME/.local/bin/rigs"
case ":$PATH:" in
  *":$HOME/.local/bin:"*) ;;
  *) RC="$HOME/.profile"; case "${SHELL:-}" in */zsh) RC="$HOME/.zshrc" ;; */bash) RC="$HOME/.bashrc" ;; esac
     grep -qs '.local/bin' "$RC" || printf '\nexport PATH="$HOME/.local/bin:$PATH"\n' >> "$RC"
     warn "added ~/.local/bin to PATH in $RC — open a new terminal (or: export PATH=\"\$HOME/.local/bin:\$PATH\")" ;;
esac
ok "rigs CLI → ~/.local/bin/rigs (node $(node -v))"

[ "$RIGS_HTTPS" = "1" ] && RIGS_SETUP_ARGS="${RIGS_SETUP_ARGS:-} --https"
[ -n "${RIGS_NAME:-}" ] && RIGS_SETUP_ARGS="${RIGS_SETUP_ARGS:-} --name $RIGS_NAME"
# shellcheck disable=SC2086
node bin/rigs.js setup ${RIGS_SETUP_ARGS:-}
if [ -s "$HOME/.rigs/finish-root.sh" ] && grep -q '"title"' "$HOME/.rigs/root-steps.json" 2>/dev/null; then
  c "Finishing root-only steps (Sunshine, SSH) — sudo once"
  sh "$HOME/.rigs/finish-root.sh" || warn "finish step failed — rerun: sh ~/.rigs/finish-root.sh"
fi
[ "$OS" != "Darwin" ] && $SUDO loginctl enable-linger "$USER" >/dev/null 2>&1 || true

echo
echo "Next: sign in to the agents you use (once per machine):  claude  ·  codex login  ·  gh auth login"
echo "Open the UI:  rigs open   (or http://localhost:4719)"
