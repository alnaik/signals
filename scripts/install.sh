#!/bin/bash
# Job Signal: one command in Terminal.
#   curl -fsSL https://raw.githubusercontent.com/alnaik/signals/main/scripts/install.sh | bash
# Installs Bun and Claude Code if missing, gets Job Signal, sets up the data folder and the
# background schedule, and opens the board. Nothing personal is sent anywhere.
set -euo pipefail

REPO="${JOBSIGNAL_REPO:-https://github.com/alnaik/signals.git}"
APP="${JOBSIGNAL_APP:-$HOME/.jobsignal-app}"
BUN_VERSION="1.4.3"

say() { printf '\033[1m%s\033[0m\n' "$*"; }

[[ "$(uname -s)" == "Darwin" ]] || { echo "Job Signal runs on macOS only."; exit 1; }
command -v git >/dev/null || { echo "Git is needed: run 'xcode-select --install', then this command again."; exit 1; }

if ! command -v bun >/dev/null && [[ ! -x "$HOME/.bun/bin/bun" ]]; then
  say "Installing Bun ${BUN_VERSION}…"
  curl -fsSL https://bun.sh/install | bash -s "bun-v$BUN_VERSION"
fi
export PATH="$HOME/.bun/bin:$HOME/.local/bin:$PATH"

if ! command -v claude >/dev/null; then
  say "Installing Claude Code…"
  curl -fsSL https://claude.ai/install.sh | bash
fi

# The newest release tag, not whatever is on main right now (JOBSIGNAL_REF picks another).
REF="${JOBSIGNAL_REF:-$(git ls-remote --tags --refs --sort=-v:refname "$REPO" 'v*' | head -1 | sed 's|.*refs/tags/||')}"
REF="${REF:-main}"
if [[ -d "$APP/.git" ]]; then
  say "Updating Job Signal to ${REF}…"
  git -C "$APP" fetch --depth 1 origin "$REF"
  git -C "$APP" checkout -q FETCH_HEAD
else
  say "Getting Job Signal ${REF}…"
  git clone --depth 1 --branch "$REF" "$REPO" "$APP"
fi
cd "$APP"

say "Installing exactly what bun.lock lists…"
bun ci
say "Installing the browser used to read careers pages and application forms…"
bunx playwright install chromium

mkdir -p "$HOME/.local/bin"
ln -sf "$APP/bin/jobsignal.ts" "$HOME/.local/bin/jobsignal"
chmod +x "$APP/bin/jobsignal.ts"

bun bin/jobsignal.ts init
bun bin/jobsignal.ts schedule install

say "Job Signal is running. Opening the board (a new install starts with a short first run)…"
sleep 2
open "http://127.0.0.1:4317/"
case ":$PATH:" in
  *":$HOME/.local/bin:"*) ;;
  *) echo "Tip: add ~/.local/bin to your PATH to use the 'jobsignal' command." ;;
esac
