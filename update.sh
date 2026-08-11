#!/usr/bin/env bash
#
# Pull the latest WackChatter and start it (macOS / Linux).
#
# Nothing you own is touched: data/ is gitignored, so characters, chats, presets and keys
# are invisible to git and survive every update.

set -euo pipefail

cd "$(dirname "$0")"

if [ -t 1 ]; then
  bold=$'\033[1m' dim=$'\033[2m' red=$'\033[31m' reset=$'\033[0m'
else
  bold='' dim='' red='' reset=''
fi

step() { printf '%s==>%s %s%s%s\n' "$dim" "$reset" "$bold" "$1" "$reset"; }
fail() { printf '\n%s%s%s\n' "$red$bold" "$1" "$reset" >&2; }

if ! command -v git >/dev/null 2>&1; then
  fail "git is not installed, so there is nothing to update from."
  echo "Install git, or download the latest release manually." >&2
  exit 1
fi

if ! git rev-parse --git-dir >/dev/null 2>&1; then
  fail "This folder isn't a git clone, so there is nothing to pull."
  echo "Updating in place needs: git clone https://github.com/Intelios/wackchatter.git" >&2
  exit 1
fi

# Whatever this branch tracks — naming it beats guessing origin/main, which is wrong for
# anyone following a different branch and produces advice that quietly does the wrong thing.
UPSTREAM="$(git rev-parse --abbrev-ref --symbolic-full-name '@{u}' 2>/dev/null || echo 'origin/main')"

# --ff-only keeps this honest. With work of your own the pull stops rather than inventing a
# merge commit on your behalf, and the message below says what to do about it.
step "Updating $(git rev-parse --abbrev-ref HEAD) from $UPSTREAM"
if ! git pull --ff-only; then
  fail "Could not fast-forward — this clone has diverged from $UPSTREAM."
  cat >&2 <<EOF

If you have edits you haven't committed, set them aside and put them back after:

  git stash && ./update.sh && git stash pop

If you have commits of your own, replay them on top of the update:

  git pull --rebase && ./start.sh

Or discard your changes entirely and take the update as it is:

  git reset --hard $UPSTREAM

Your data folder survives all three — it is gitignored, so git cannot touch it.
EOF
  exit 1
fi

exec ./start.sh "$@"
