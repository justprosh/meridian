#!/usr/bin/env bash
# Run only after the infrastructure owner says ready. No SSH or live-service access.
set -euo pipefail
if [[ $# != 5 ]]; then
  echo 'usage: bench-bookkeeping-linux.sh BASELINE_ROOT BASELINE_SHA CANDIDATE_ROOT CANDIDATE_SHA ARTIFACTS' >&2
  exit 2
fi
[[ $(uname -s) == Linux ]] || { echo 'Linux required' >&2; exit 2; }
[[ $(node -p 'process.versions.node.split(".")[0]') == 22 ]] || { echo 'Node22 required' >&2; exit 2; }
for pair in '1 2' '3 4'; do
  read -r root_index sha_index <<< "$pair"
  root=${!root_index}; sha=${!sha_index}
  [[ $(git -C "$root" rev-parse HEAD) == "$sha" ]] || { echo 'SHA mismatch' >&2; exit 2; }
  [[ -z $(git -C "$root" status --porcelain) ]] || { echo 'Source worktree dirty' >&2; exit 2; }
done
mkdir -p "$5"
[[ $(stat -f -c %T "$5") == ext2/ext3 ]] || { echo 'ext4 filesystem required (confirm mount separately)' >&2; exit 2; }
# Atomic ownership of the measurement window; never remove another runner's lock.
lock="$5/.benchmark-exclusive"
mkdir "$lock" || { echo 'Another benchmark holds the measurement window' >&2; exit 2; }
trap 'rmdir "$lock"' EXIT
findmnt -T "$5" -no FSTYPE | grep -qx ext4 || { echo 'Mount is not ext4' >&2; exit 2; }
script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
node "$script_dir/bench-session-bookkeeping.mjs" --backend json --package-root "$1" \
  --compare-root "$3" --soak-minutes 10 --repeats 3 --artifacts "$5"
