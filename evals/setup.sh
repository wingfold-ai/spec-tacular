#!/bin/sh
# Prepares one evaluation run: an empty project for the scenario, the
# headless terminal, and the environment spec-tacular runs in.
#
#   evals/setup.sh <run-dir> <spec-tacular-binary> [<readme>]
#
# Writes <run-dir>/project (a fresh git repository with OpenSpec initialised
# for Claude Code), <run-dir>/sessions (the headless terminals),
# <run-dir>/env.sh (source it before starting spec-tacular), and
# <run-dir>/start.sh (starts spec-tacular in the headless terminal "tui").
# The spec-tacular README of the version under test is copied to
# <run-dir>/README-under-test.md: what a user of that version would read.
set -eu
run=${1:?usage: setup.sh <run-dir> <spec-tacular-binary> [<readme>]}
bin=${2:?usage: setup.sh <run-dir> <spec-tacular-binary> [<readme>]}
readme=${3:-}
evals=$(cd "$(dirname "$0")" && pwd)
repo=$(cd "$evals/.." && pwd)

mkdir -p "$run/project" "$run/sessions" "$run/shims"
run=$(cd "$run" && pwd)
bin=$(cd "$(dirname "$bin")" && pwd)/$(basename "$bin")
[ -n "$readme" ] && readme=$(cd "$(dirname "$readme")" && pwd)/$(basename "$readme")

# Python with pyte for the headless terminal.
if [ ! -x "$run/venv/bin/python" ]; then
  uv venv -q "$run/venv"
  uv pip install -q --python "$run/venv/bin/python" pyte
fi

# OpenSpec, as a user installs it.
openspec=$(command -v openspec || echo "$repo/node_modules/.bin/openspec")
[ -x "$openspec" ] || { echo "openspec not found: npm i -g @fission-ai/openspec" >&2; exit 1; }

cd "$run/project"
[ -d .git ] || git init -q
git config user.email eval@spec-tacular.invalid
git config user.name "spec-tacular eval"
"$openspec" init --tools claude . >/dev/null 2>&1 || true
git add -A
git commit -qm "Empty project" --allow-empty || true

cp "$evals/tools/shims/tmux" "$evals/tools/shims/claude" "$run/shims/"
chmod +x "$run/shims/"*
ln -sf "$bin" "$run/shims/spec-tacular"
ln -sf "$openspec" "$run/shims/openspec"
[ -n "$readme" ] && cp "$readme" "$run/README-under-test.md"

cat > "$run/env.sh" <<EOF
# Source before running spec-tacular for this evaluation.
export EVAL_RUN='$run'
export EVAL_SESSIONS='$run/sessions'
export EVAL_TOOLS='$evals/tools'
export EVAL_PYTHON='$run/venv/bin/python'
export EVAL_REAL_CLAUDE='$(command -v claude)'
export PATH='$run/shims':\$PATH
# spec-tacular opens implementing sessions through "tmux": the shim.
export TMUX=eval-shim
# No MCP servers in the agents: faster, and nothing outside the project.
export SPECTACULAR_NO_MCP=1
tui() { "\$EVAL_PYTHON" "\$EVAL_TOOLS/tui.py" "\$@"; }
EOF

cat > "$run/start.sh" <<EOF
#!/bin/sh
. '$run/env.sh'
cd '$run/project'
exec "\$EVAL_PYTHON" "\$EVAL_TOOLS/tui.py" start '$run/sessions/tui' --cols 150 --rows 45 -- spec-tacular
EOF
chmod +x "$run/start.sh"
echo "ready: $run"
