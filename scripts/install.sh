#!/usr/bin/env bash
# RIGS OS installer for macOS and Linux (Ubuntu, incl. Wayland).
#   curl -fsSL https://raw.githubusercontent.com/XmYx/rigs/main/scripts/install.sh | bash
# Options (env vars):
#   RIGS_DIR=~/.rigs/app       where to clone the repo
#   RIGS_REPO=https://github.com/XmYx/rigs.git
#   RIGS_NAME=<machine name>   defaults to the short hostname
#   RIGS_AGENTS=1              install missing Claude Code / Codex / Ollama (0 to skip)
#   RIGS_DESKTOP=1             install Sunshine (host) + Moonlight (client) for HW-accelerated remote desktop
#   RIGS_HTTPS=1               expose the UI via `tailscale serve` (https, enables the microphone remotely)
#   RIGS_SETUP_ARGS="..."      extra args for `rigs setup`
set -euo pipefail

RIGS_DIR="${RIGS_DIR:-$HOME/.rigs/app}"
RIGS_REPO="${RIGS_REPO:-https://github.com/XmYx/rigs.git}"
RIGS_AGENTS="${RIGS_AGENTS:-1}"
RIGS_DESKTOP="${RIGS_DESKTOP:-0}"
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
    . "$HOME/.nvm/nvm.sh"; nvm install 22 >/dev/null; nvm alias default 22 >/dev/null; nvm use 22 >/dev/null
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
    warn "Signing in to Tailscale (follow the link). --ssh enables Tailscale SSH as well."
    $SUDO tailscale up --ssh || warn "run: sudo tailscale up --ssh"
  else
    $SUDO tailscale set --ssh >/dev/null 2>&1 || true
    ok "Tailscale up: $(tailscale ip -4 2>/dev/null | head -1)"
  fi
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
if [ "$RIGS_DESKTOP" = "1" ]; then
  c "Remote desktop (Sunshine host + Moonlight client, hardware accelerated)"
  if [ "$OS" = "Darwin" ]; then
    brew install --cask moonlight || true
    (brew tap LizardByte/homebrew && brew install sunshine) || warn "Sunshine on macOS is beta; Mac↔Mac can use Screen Sharing (High Performance) instead"
    warn "Grant Sunshine Screen Recording + Accessibility in System Settings → Privacy & Security"
  else
    . /etc/os-release
    DEB_ARCH="$(dpkg --print-architecture)"
    URL="https://github.com/LizardByte/Sunshine/releases/latest/download/sunshine-ubuntu-${VERSION_ID}-${DEB_ARCH}.deb"
    TMP="$(mktemp -d)"
    if curl -fsSL -o "$TMP/sunshine.deb" "$URL"; then
      apt_install "$TMP/sunshine.deb"
      # KMS capture works on GNOME/KDE Wayland without the portal prompt.
      $SUDO setcap cap_sys_admin+p "$(readlink -f "$(command -v sunshine)")" || true
      systemctl --user enable --now sunshine >/dev/null 2>&1 || true
      ok "Sunshine installed (KMS capture, VAAPI/NVENC encode)"
    else
      warn "No Sunshine .deb for Ubuntu ${VERSION_ID}/${DEB_ARCH} — see https://github.com/LizardByte/Sunshine/releases"
    fi
    rm -rf "$TMP"
    have flatpak || apt_install flatpak
    flatpak remote-add --user --if-not-exists flathub https://dl.flathub.org/repo/flathub.flatpakrepo || true
    flatpak install --user -y flathub com.moonlight_stream.Moonlight || warn "Moonlight install failed"
  fi
  RIGS_SETUP_ARGS="${RIGS_SETUP_ARGS:-} --desktop"
fi

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
ln -sf "$RIGS_DIR/bin/rigs.js" "$HOME/.local/bin/rigs"
ok "rigs CLI → ~/.local/bin/rigs"

[ "$RIGS_HTTPS" = "1" ] && RIGS_SETUP_ARGS="${RIGS_SETUP_ARGS:-} --https"
[ -n "${RIGS_NAME:-}" ] && RIGS_SETUP_ARGS="${RIGS_SETUP_ARGS:-} --name $RIGS_NAME"
# shellcheck disable=SC2086
node bin/rigs.js setup ${RIGS_SETUP_ARGS:-}
[ "$OS" != "Darwin" ] && $SUDO loginctl enable-linger "$USER" >/dev/null 2>&1 || true

echo
echo "Next: sign in to the agents you use (once per machine):  claude  ·  codex login  ·  gh auth login"
echo "Open the UI:  rigs open   (or http://localhost:4719)"
