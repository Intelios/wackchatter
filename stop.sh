#!/usr/bin/env bash
#
# Stop a running WackChatter server.
#
#     ./stop.sh               # stops port 8787
#     WC_PORT=9000 ./stop.sh  # stops a non-default instance
#
# Companion to start.sh — same Bun discovery, one HTTP call.

set -euo pipefail

cd "$(dirname "$0")"

if [ -t 1 ]; then
  bold=$'\033[1m' red=$'\033[31m' reset=$'\033[0m'
else
  bold='' red='' reset=''
fi

fail() { printf '\n%s%s%s\n' "$red$bold" "$1" "$reset" >&2; }

# Same discovery logic as start.sh so a double-clicked script finds Bun on a non-login shell.
find_bun() {
  if command -v bun >/dev/null 2>&1; then
    command -v bun
    return 0
  fi
  local candidate
  for candidate in \
    "${BUN_INSTALL:-$HOME/.bun}/bin/bun" \
    "$HOME/.bun/bin/bun" \
    /opt/homebrew/bin/bun \
    /usr/local/bin/bun; do
    if [ -x "$candidate" ]; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done
  return 1
}

BUN="$(find_bun)" || {
  fail "Bun is not installed."
  exit 1
}

exec "$BUN" run scripts/stop.ts
