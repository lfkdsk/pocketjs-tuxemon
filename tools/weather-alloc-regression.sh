#!/usr/bin/env bash
# Weather overlay allocation regression (QuickJS).
#
# Proves the particle overlay's steady-state and activation frames allocate
# nothing on the QuickJS JS heap. For each of two GB6 tape windows it warms the
# real built game to the named state, then invokes the pre-registered overlay
# handler repeatedly on that frozen state and compares it with the same number
# of calls to a pre-registered no-op. The activation case freezes the handler
# for the real five-frame indoor-to-outdoor transfer first, so its first probe
# call executes profile activation. Mount, warm-up and eval-loop allocations
# are identical; the diff isolates the handler and must be exactly 0.
#
# Windows (data/gb6-mainline-journey.json map transitions):
#   steady     start=1500 frames=500  spyder_paper_town, overlay active,
#              no map transfer inside the window
#   activation start=1430 frames=60   primes through the frame-1434 transfer
#              from spyder_downstairs (indoor, overlay hidden) to
#              spyder_paper_town (outdoor), then measures first activation
#
# The steady window kills a per-frame allocation regression (e.g. an iterator
# in the envelope slug scan); the activation window kills an activation-time
# allocation regression (e.g. building styles/batches on activation instead
# of at mount).
set -euo pipefail

if ! command -v cargo >/dev/null 2>&1 && [[ -f "$HOME/.cargo/env" ]]; then
  source "$HOME/.cargo/env"
fi

root=$(cd "$(dirname "$0")/.." && pwd)
bench_root=${G6_BENCH_ROOT:-${TMPDIR:-/tmp}/pocket-tuxemon-quickjs}
scratch="$bench_root/quickjs-host"
target="$bench_root/quickjs-target"
pocketjs="$root/vendor/pocket-rpgkit/vendor/pocketjs"
app_dist="$root/dist/linux-app"
journey="$root/data/gb6-mainline-journey.json"

for artifact in "$app_dist/pocket-tuxemon.js" "$app_dist/pocket-tuxemon.pak"; do
  if [[ ! -f "$artifact" ]]; then
    echo "weather-alloc-regression: missing build artifact: $artifact" >&2
    echo "run 'bun run build' first" >&2
    exit 1
  fi
done

rm -rf "$scratch"
mkdir -p "$scratch"
cp -a "$pocketjs/hosts/desktop/." "$scratch/"
cp "$root/tools/g6-quickjs-bench.rs" "$scratch/src/g6-quickjs-bench.rs"
sed -i "s#path = \"../../engine#path = \"$pocketjs/engine#g" "$scratch/Cargo.toml"
sed -i '$a include!("g6-quickjs-bench.rs");' "$scratch/src/main.rs"

CARGO_TARGET_DIR="$target" cargo test --manifest-path "$scratch/Cargo.toml" --release --no-default-features --no-run
binary=$(find "$target/release/deps" -maxdepth 1 -type f -name 'pocket_desktop_host-*' -perm -111 -printf '%T@ %p\n' | sort -nr | head -1 | cut -d' ' -f2-)

# run_mem_walk <start> <frames> <extra-env...> — prints the MEM_WALK line.
run_mem_walk() {
  local start=$1 frames=$2
  shift 2
  env G6_COUNT_ALLOCS=1 G6_DIST="$app_dist" G6_JOURNEY="$journey" \
    G6_MAPS="$root/dist/maps" G6_BATTLE="$root/dist/battle" \
    G6_PORTRAITS="$root/dist/portraits" G6_CHOICE_ICONS="$root/dist/choice-icons" \
    G6_AUDIO_ROOT="$root/assets/audio" G6_AUDIO_MANIFEST="$root/assets/audio/manifest.json" \
    G6_ANIMATED="$root/dist/animated" G6_NPC_SRC="$root/dist/npc-src" \
    G6_TERRAIN_STREAM="$root/dist/terrain-stream" G6_BENCH_ROOT="$bench_root" \
    G6_BENCH_W=480 G6_BENCH_H=272 G6_WEATHER=rain \
    G6_MEM_START="$start" G6_MEM_FRAMES="$frames" G6_WEATHER_DIRECT_PROBE=1 "$@" \
    "$binary" g6_quickjs_bench::mem_walk --ignored --exact --nocapture \
    | grep -E '^MEM_WALK'
}

# field <MEM_WALK line> <field name>
field() {
  sed "s/.* $2=\([^ ]*\).*/\1/" <<<"$1"
}

status=0
for window in "steady 1500 500" "activation 1430 60"; do
  read -r name start frames <<<"$window"
  prime=0
  [[ "$name" == "activation" ]] && prime=5
  on=$(run_mem_walk "$start" "$frames" G6_WEATHER_PROBE_PRIME_FRAMES="$prime")
  off=$(run_mem_walk "$start" "$frames" G6_WEATHER_PROBE_PRIME_FRAMES="$prime" G6_WEATHER_OVERLAY_NO_FRAME=1)
  on_count=$(field "$on" alloc_count_delta)
  off_count=$(field "$off" alloc_count_delta)
  on_bytes=$(field "$on" alloc_bytes_delta)
  off_bytes=$(field "$off" alloc_bytes_delta)
  echo "WEATHER_ALLOC window=$name start=$start frames=$frames on=$on_count no_frame=$off_count diff=$((on_count - off_count)) bytes_on=$on_bytes bytes_no_frame=$off_bytes bytes_diff=$((on_bytes - off_bytes))"
  if [[ $on_count -ne $off_count || $on_bytes -ne $off_bytes ]]; then
    echo "WEATHER_ALLOC window=$name FAIL: overlay frame-handler allocation delta is nonzero" >&2
    status=1
  fi
done

if [[ $status -eq 0 ]]; then
  echo "WEATHER_ALLOC PASS: overlay on/off allocation delta is 0 on both windows"
fi
exit $status
