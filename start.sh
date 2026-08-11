#!/usr/bin/env bash
#
# WackChatter launcher (macOS / Linux).
#
#     git clone https://github.com/Intelios/wackchatter.git
#     cd wackchatter
#     ./start.sh
#
# Updating is `git pull` and then this script again — or ./update.sh, which does both.
#
# Dependencies and the frontend bundle are refreshed on every launch. Both finish in
# well under a second when nothing changed, which is the point: there is no build step
# left to forget after a pull, and no way to end up running a stale bundle.
#
# WC_* environment variables and any arguments are passed through to the server.

set -euo pipefail

cd "$(dirname "$0")"

# Declared floor, not an exhaustively tested one — it matches the `engines` field in
# package.json. Raising it strands anyone who hasn't upgraded, so treat it as a promise.
MIN_BUN=1.2.0

if [ -t 1 ]; then
  bold=$'\033[1m' dim=$'\033[2m' red=$'\033[31m' reset=$'\033[0m'
else
  bold='' dim='' red='' reset=''
fi

step() { printf '%s==>%s %s%s%s\n' "$dim" "$reset" "$bold" "$1" "$reset"; }
fail() { printf '\n%s%s%s\n' "$red$bold" "$1" "$reset" >&2; }

# Returns success when version $1 is older than version $2.
older_than() {
  [ "$1" != "$2" ] && [ "$(printf '%s\n%s\n' "$1" "$2" | sort -V | head -n1)" = "$1" ]
}

# A double-clicked script gets a non-login shell, which never sources the PATH line Bun's
# installer appends to your profile. So an empty `command -v` is not evidence Bun is
# missing — the usual install locations have to be checked before saying so.
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

install_bun_instructions() {
  cat >&2 <<'EOF'

WackChatter runs on Bun. Install it with one of:

  curl -fsSL https://bun.sh/install | bash     (official installer)
  brew install oven-sh/bun/bun                 (Homebrew)

Then open a new terminal and run ./start.sh again.
EOF
}

BUN="$(find_bun)" || {
  fail "Bun is not installed."
  if [ -t 0 ] && [ -t 1 ]; then
    printf '\nInstall it now with the official installer from https://bun.sh? [y/N] '
    read -r reply
    case "$reply" in
      [yY] | [yY][eE][sS])
        curl -fsSL https://bun.sh/install | bash
        BUN="$(find_bun)" || {
          fail "Bun still isn't on PATH. Open a new terminal and run ./start.sh again."
          exit 1
        }
        ;;
      *)
        install_bun_instructions
        exit 1
        ;;
    esac
  else
    install_bun_instructions
    exit 1
  fi
}

BUN_VERSION="$("$BUN" --version)"
if older_than "$BUN_VERSION" "$MIN_BUN"; then
  fail "Bun $BUN_VERSION is too old — WackChatter needs $MIN_BUN or newer."
  printf 'Upgrade with: %s upgrade\n' "$BUN" >&2
  exit 1
fi

step "Installing dependencies (Bun $BUN_VERSION)"
"$BUN" install

# Deliberately not the `build` script, which also runs `tsc --noEmit` and prints the full
# asset table. A type error is a problem for whoever wrote it, not a reason to refuse to
# launch the app for someone who only ran `git pull`, and a hundred lines of font hashes
# are not something a launch is improved by. Build *errors* still surface and stop here.
step "Building the app"
"$BUN" run --silent build:app

step "Starting WackChatter"
# Mirrors the `start` script in package.json: serve dist/ and /api on one port.
NODE_ENV=production exec "$BUN" run server/index.ts "$@"
