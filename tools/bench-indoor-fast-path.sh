#!/usr/bin/env bash
set -euo pipefail

root=$(cd "$(dirname "$0")/.." && pwd)
app_root=${INDOOR_BENCH_APP_ROOT:-$root}
app_dist=${INDOOR_BENCH_DIST:-$app_root/dist/linux-app}
bench_root=${INDOOR_BENCH_ROOT:-${TMPDIR:-/tmp}/pocket-tuxemon-indoor-bench}
scratch="$bench_root/quickjs-host"
target="$bench_root/quickjs-target"
pocketjs="$root/vendor/pocket-rpgkit/vendor/pocketjs"

for artifact in \
  "$app_dist/pocket-tuxemon.js" \
  "$app_dist/pocket-tuxemon.pak" \
  "$app_root/dist/maps" \
  "$app_root/dist/battle" \
  "$app_root/dist/animated" \
  "$app_root/dist/npc-src" \
  "$app_root/dist/terrain-stream"; do
  if [[ ! -e "$artifact" ]]; then
    echo "bench-indoor-fast-path: missing build artifact: $artifact" >&2
    echo "run 'bun tools/desktop.ts --build-only' in the selected app root first" >&2
    exit 1
  fi
done

rm -rf "$scratch"
mkdir -p "$scratch"
cp -a "$pocketjs/hosts/desktop/." "$scratch/"
cp "$root/tools/g6-quickjs-bench.rs" "$scratch/src/g6-quickjs-bench.rs"
sed -i "s#path = \"../../engine#path = \"$pocketjs/engine#g" "$scratch/Cargo.toml"
sed -i '$a include!("g6-quickjs-bench.rs");' "$scratch/src/main.rs"

CARGO_TARGET_DIR="$target" cargo test \
  --manifest-path "$scratch/Cargo.toml" \
  --release --no-default-features --no-run
binary=$(find "$target/release/deps" -maxdepth 1 -type f \
  -name 'pocket_desktop_host-*' -perm -111 -printf '%T@ %p\n' \
  | sort -nr | head -1 | cut -d' ' -f2-)

if [[ -n ${INDOOR_BENCH_VIEWPORT:-} ]]; then
  viewports=("$INDOOR_BENCH_VIEWPORT")
else
  viewports=("480 272" "960 544")
fi
for viewport in "${viewports[@]}"; do
  read -r width height <<<"$viewport"
  G6_DIST="$app_dist" \
    G6_MAPS="$app_root/dist/maps" \
    G6_BATTLE="$app_root/dist/battle" \
    G6_AUDIO_ROOT="$app_root/assets/audio" \
    G6_AUDIO_MANIFEST="$app_root/assets/audio/manifest.json" \
    G6_ANIMATED="$app_root/dist/animated" \
    G6_NPC_SRC="$app_root/dist/npc-src" \
    G6_TERRAIN_STREAM="$app_root/dist/terrain-stream" \
    G6_JOURNEY="$app_root/data/gb6-mainline-journey.json" \
    G6_BENCH_ROOT="$bench_root" \
    G6_BENCH_W="$width" \
    G6_BENCH_H="$height" \
    "$binary" g6_quickjs_bench::indoor_fast_path --ignored --exact --nocapture
done
