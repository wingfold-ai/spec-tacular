#!/bin/sh
# Starts a built spectacular's TUI in a pseudo-terminal, in an empty folder,
# checks that it draws its start screen, and quits it with `q`.
#
#   scripts/smoke-tui.sh dist/spectacular
#
# `--version` never loads the terminal renderer, so this is what shows the
# binary carries a native library that loads on this platform. Linux and
# macOS both ship `script`, with different arguments.

set -eu

bin=$(cd "$(dirname "$1")" && pwd)/$(basename "$1")
work=$(mktemp -d)
log="$work/terminal.log"
mkdir "$work/project"
cd "$work/project"
# The binary must ignore the folder's own Bun config (scripts/build.ts): a
# preload that does not exist would stop it starting if it read this.
printf 'preload = ["./missing-preload.ts"]\n' > bunfig.toml

run="stty cols 100 rows 30; exec '$bin'"
export TERM="${TERM:-xterm-256color}"
[ "$TERM" = dumb ] && TERM=xterm-256color

# Keys go in after the first frame has had time to draw.
{ sleep 5; printf q; sleep 5; } | case "$(uname -s)" in
  Darwin) script -q "$log" sh -c "$run" ;;
  *) script -qfec "$run" "$log" ;;
esac >/dev/null &
pid=$!

# A TUI that ignores `q` must not hang the build.
( sleep 60; kill "$pid" 2>/dev/null ) &
watchdog=$!

status=0
wait "$pid" || status=$?
kill "$watchdog" 2>/dev/null || true

# The frame, with escape sequences removed (BSD sed knows no \x1b).
esc=$(printf '\033')
screen=$(LC_ALL=C sed "s/$esc\\[[0-9;?<>=\$]*[a-zA-Z~]//g" "$log" | tr -s ' \n' ' ')

if ! printf '%s' "$screen" | grep -q 'spec-driven development'; then
  echo "The TUI did not draw its start screen. Terminal output:" >&2
  cat -v "$log" | head -c 4000 >&2
  exit 1
fi
if [ "$status" -ne 0 ]; then
  echo "The TUI drew its start screen but exited with status $status." >&2
  exit 1
fi
echo "The TUI drew its start screen and quit cleanly."
rm -rf "$work"
