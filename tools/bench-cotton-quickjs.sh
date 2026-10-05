#!/usr/bin/env bash
set -euo pipefail

root=$(cd "$(dirname "$0")/.." && pwd)

# Reproduce the production world-cache route up to Cotton Town, preserving
# its allocation and GC history, then report and gate only Cotton's frames.
# Run under taskset for release measurements; each repetition is a fresh
# process and QuickJS realm.
G6_WORLD_FOCUS_MAP=spyder_cotton_town \
WORLD_CACHE_COLD_RUNS=${COTTON_COLD_RUNS:-3} \
WORLD_CACHE_VARIANT=${WORLD_CACHE_VARIANT:-cotton} \
bash "$root/tools/verify-world-cache-quickjs.sh"
