#!/bin/sh
# Keeps an evaluation run: its report, log, measurements and permission
# prompts, copied into evals/results/<date>-<label>/. Run directories are
# often temporary; what is compared later must outlive them.
#
#   evals/tools/keep.sh <run-dir> <label>
set -eu
run=${1:?usage: keep.sh <run-dir> <label>}
label=${2:?usage: keep.sh <run-dir> <label>}
evals=$(cd "$(dirname "$0")/.." && pwd)
dest="$evals/results/$(date +%F)-$label"
mkdir -p "$dest"
for f in report.md log.md metrics.json metrics.md phases.tsv prompts.log; do
  if [ -f "$run/$f" ]; then cp "$run/$f" "$dest/"; fi
done
echo "kept: $dest"
