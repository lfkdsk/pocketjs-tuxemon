#!/usr/bin/env bash
# Weather overlay allocation diff versus the real main branch (QuickJS).
#
# weather-alloc-regression.sh is the strict gate: it diffs the overlay's
# frame handler on/off on one bundle and asserts a zero delta. This script
# is the measurement behind that gate: it builds the desktop bundle for the
# current worktree and for MAIN_REF (in a throwaway worktree), replays the
# same GB6 tape windows on both with the counting allocator, and prints a
# per-frame allocation diff (branch - main). QuickJS allocation counts are
# deterministic for a fixed tape, so every nonzero frame is a real
# branch/main difference and is listed individually.
#
# Fair-weather rule: main's main.tsx does not read the
# __pocketTuxemonInitialWeather global, so a main bundle always boots with
# the default "sunny" weather no matter what G6_WEATHER says. Comparing a
# rain branch against a sunny main confounds weather state with branch
# code. This script therefore defaults to --weather sunny so both bundles
# run the same weather state; use --weather rain to reproduce the
# confounded comparison (the diff then includes weather-state effects,
# which are not a branch-code regression).
#
# Windows (data/gb6-mainline-journey.json):
#   steady     [1500, 2000)   spyder_paper_town, overlay active, no transfer
#   activation [1430, 1490)   downstairs -> paper_town transfer, first activation
#
# A small nonzero diff on a few event frames (for example the frame an
# add_monster event runs) is a one-time event allocation, not a per-frame
# steady-state cost, and is accepted. A diff that appears on ordinary
# background frames, or grows window over window, is a real regression.
#
# Args:
#   --weather <slug>   initial weather for both runs (default: sunny)
#   --overlay-off      also measure the branch with the overlay unmounted
#   --keep             keep the throwaway main worktree after the run
#
# Env:
#   MAIN_REF          git ref for the baseline (default: main)
#   MAIN_DIFF_ROOT    scratch root for the throwaway worktree (default:
#                     \$TMPDIR/pocket-tuxemon-main-diff-<pid>)
#   TUXEMON_SRC       tuxemon source tree (required by the build)
#   G6_BENCH_ROOT     bench scratch root (default: same as the regression)
set -euo pipefail

root=$(cd "$(dirname "$0")/.." && pwd)
main_ref=${MAIN_REF:-main}
weather=sunny
overlay_off=0
keep=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --weather) weather=$2; shift 2 ;;
    --overlay-off) overlay_off=1; shift ;;
    --keep) keep=1; shift ;;
    *) echo "weather-alloc-main-diff: unknown arg: $1" >&2; exit 2 ;;
  esac
done
: "${TUXEMON_SRC:?weather-alloc-main-diff: export TUXEMON_SRC first}"
if ! command -v cargo >/dev/null 2>&1 && [[ -f "$HOME/.cargo/env" ]]; then
  source "$HOME/.cargo/env"
fi

scratch="${MAIN_DIFF_ROOT:-${TMPDIR:-/var/tmp}/pocket-tuxemon-main-diff-$$}"
main_wt="$scratch/main-wt"
bench_root=${G6_BENCH_ROOT:-${TMPDIR:-/tmp}/pocket-tuxemon-quickjs}
target="$bench_root/quickjs-target"
pocketjs="$root/vendor/pocket-rpgkit/vendor/pocketjs"
journey="$root/data/gb6-mainline-journey.json"
mkdir -p "$scratch"

cleanup() {
  if [[ $keep -eq 1 ]]; then
    echo "weather-alloc-main-diff: kept main worktree at $main_wt"
  else
    git -C "$root" worktree remove --force "$main_wt" 2>/dev/null || true
    rm -rf "$scratch"
  fi
}
trap cleanup EXIT

echo "weather-alloc-main-diff: building baseline $main_ref in $main_wt"
git -C "$root" worktree add --detach "$main_wt" "$main_ref" >/dev/null
git -C "$main_wt" submodule update --init --recursive >/dev/null
( cd "$main_wt" && bun install >/dev/null && TUXEMON_SRC="$TUXEMON_SRC" bun run desktop --build-only >/dev/null )

echo "weather-alloc-main-diff: building branch in $root"
( cd "$root" && TUXEMON_SRC="$TUXEMON_SRC" bun run desktop --build-only >/dev/null )

# Build the bench binary from this worktree (same runner for both bundles).
host_scratch="$scratch/quickjs-host"
rm -rf "$host_scratch"
mkdir -p "$host_scratch"
cp -a "$pocketjs/hosts/desktop/." "$host_scratch/"
cp "$root/tools/g6-quickjs-bench.rs" "$host_scratch/src/g6-quickjs-bench.rs"
sed -i "s#path = \"../../engine#path = \"$pocketjs/engine#g" "$host_scratch/Cargo.toml"
sed -i '$a include!("g6-quickjs-bench.rs");' "$host_scratch/src/main.rs"
CARGO_TARGET_DIR="$target" cargo test --manifest-path "$host_scratch/Cargo.toml" --release --no-default-features --no-run >/dev/null
binary=$(find "$target/release/deps" -maxdepth 1 -type f -name 'pocket_desktop_host-*' -perm -111 -printf '%T@ %p\n' | sort -nr | head -1 | cut -d' ' -f2-)

# run_mem_walk <dist-root> <start> <frames> <out-file> [extra-env...]
# The bundle lives in <dist-root>/linux-app; the seeded data dirs are its
# siblings (<dist-root>/maps, /battle, ...), matching the regression script.
run_mem_walk() {
  local dist_root=$1 start=$2 frames=$3 out=$4
  shift 4
  env G6_COUNT_ALLOCS=1 G6_DIST="$dist_root/linux-app" G6_JOURNEY="$journey" \
    G6_MAPS="$dist_root/maps" G6_BATTLE="$dist_root/battle" \
    G6_AUDIO_ROOT="$app_root/assets/audio" G6_AUDIO_MANIFEST="$app_root/assets/audio/manifest.json" \
    G6_ANIMATED="$dist_root/animated" G6_NPC_SRC="$dist_root/npc-src" \
    G6_TERRAIN_STREAM="$dist_root/terrain-stream" G6_BENCH_ROOT="$bench_root" \
    G6_BENCH_W=480 G6_BENCH_H=272 G6_WEATHER="$weather" \
    G6_MEM_START="$start" G6_MEM_FRAMES="$frames" G6_MEM_PER_FRAME=1 "$@" \
    "$binary" g6_quickjs_bench::mem_walk --ignored --exact --nocapture \
    | grep -E '^MEM_FRAME' > "$out"
}

# diff_frames <label> <main-file> <branch-file> — prints the per-frame table.
diff_frames() {
  local label=$1 main_file=$2 branch_file=$3
  python3 - "$label" "$main_file" "$branch_file" <<'EOF'
import sys
label, main_path, branch_path = sys.argv[1], sys.argv[2], sys.argv[3]
def load(path):
    counts = {}
    with open(path) as handle:
        for line in handle:
            if not line.startswith("MEM_FRAME"):
                continue
            fields = {}
            for token in line.split():
                key, _, value = token.partition("=")
                fields[key] = value
            counts[int(fields["frame"])] = int(fields["allocs"])
    return counts
main = load(main_path)
branch = load(branch_path)
frames = sorted(set(main) | set(branch))
main_total = sum(main.values())
branch_total = sum(branch.values())
diff_total = branch_total - main_total
nonzero = [(f, main.get(f, 0), branch.get(f, 0), branch.get(f, 0) - main.get(f, 0)) for f in frames if branch.get(f, 0) != main.get(f, 0)]
print(f"WEATHER_MAIN_DIFF window={label} main_total={main_total} branch_total={branch_total} diff={diff_total:+d} nonzero_frames={len(nonzero)}/{len(frames)}")
if nonzero:
    print("  frame    main  branch  diff")
    for frame, main_count, branch_count, delta in nonzero:
        print(f"  {frame:>5}  {main_count:>6}  {branch_count:>6}  {delta:+d}")
EOF
}

for window in "steady 1500 500" "activation 1430 60"; do
  read -r name start frames <<<"$window"
  main_out="$scratch/main-$name.frames"
  branch_out="$scratch/branch-$name.frames"
  run_mem_walk "$main_wt/dist" "$start" "$frames" "$main_out"
  run_mem_walk "$root/dist" "$start" "$frames" "$branch_out"
  diff_frames "$name" "$main_out" "$branch_out"
  if [[ $overlay_off -eq 1 ]]; then
    off_out="$scratch/branch-off-$name.frames"
    run_mem_walk "$root/dist" "$start" "$frames" "$off_out" G6_WEATHER_OVERLAY_OFF=1
    diff_frames "$name-off" "$main_out" "$off_out"
  fi
done

echo "WEATHER_MAIN_DIFF done: per-frame tables above (weather=$weather, ref=$main_ref)"
