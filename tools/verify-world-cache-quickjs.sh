#!/usr/bin/env bash
set -euo pipefail

root=$(cd "$(dirname "$0")/.." && pwd)
bench_root=${WORLD_CACHE_BENCH_ROOT:-${TMPDIR:-/var/tmp}/pocket-tuxemon-world-cache}
scratch="$bench_root/quickjs-host"
target="$bench_root/quickjs-target"
pocketjs="$root/vendor/pocket-rpgkit/vendor/pocketjs"
input_root=${WORLD_CACHE_INPUT_ROOT:-$root}
app_dist=${WORLD_CACHE_DIST:-$input_root/dist/linux-app}
app_js="$app_dist/pocket-tuxemon.js"
app_pak="$app_dist/pocket-tuxemon.pak"
project_shell="$input_root/dist/project-shell.json"
audio_manifest="$input_root/assets/audio/manifest.json"
host_stamp="$bench_root/quickjs-host-input.sha256"

for artifact in \
  "$app_js" \
  "$app_pak" \
  "$project_shell"; do
  if [[ ! -f "$artifact" ]]; then
    echo "verify-world-cache: missing build artifact: $artifact" >&2
    echo "run 'bun tools/desktop.ts --build-only' first" >&2
    exit 1
  fi
done

map_manifest_hash=$(bun -e '
  const project = JSON.parse(await Bun.file(process.argv[1]).text());
  const value = project.mapManifestHash;
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) {
    throw new Error("missing or malformed mapManifestHash");
  }
  console.log(value);
' "$project_shell")
if ! grep -Fq "$map_manifest_hash" "$app_js"; then
  echo "verify-world-cache: desktop bundle is stale relative to project-shell.json" >&2
  echo "run 'bun tools/desktop.ts --build-only' first" >&2
  exit 1
fi

app_js_sha256=$(sha256sum "$app_js" | cut -d' ' -f1)
app_pak_sha256=$(sha256sum "$app_pak" | cut -d' ' -f1)
project_shell_sha256=$(sha256sum "$project_shell" | cut -d' ' -f1)
audio_manifest_sha256=$(sha256sum "$audio_manifest" | cut -d' ' -f1)
echo "BUILD_INPUT variant=${WORLD_CACHE_VARIANT:-branch} app_js_sha256=$app_js_sha256 app_pak_sha256=$app_pak_sha256 project_shell_sha256=$project_shell_sha256 map_manifest_sha256=$map_manifest_hash audio_manifest_sha256=$audio_manifest_sha256"

host_input_sha256=$(
  {
    sha256sum "$root/tools/g6-quickjs-bench.rs"
    git -C "$pocketjs" rev-parse HEAD
  } | sha256sum | cut -d' ' -f1
)
echo "HOST_INPUT sha256=$host_input_sha256 reuse=${WORLD_CACHE_REUSE_HOST:-0}"

if [[ ${WORLD_CACHE_REUSE_HOST:-0} == 1 ]]; then
  if [[ ! -f "$host_stamp" || $(<"$host_stamp") != "$host_input_sha256" ]]; then
    echo "verify-world-cache: WORLD_CACHE_REUSE_HOST=1 requested without a matching compiled host" >&2
    exit 1
  fi
else
  rm -rf "$scratch"
  mkdir -p "$scratch"
  cp -a "$pocketjs/hosts/desktop/." "$scratch/"
  cp "$root/tools/g6-quickjs-bench.rs" "$scratch/src/g6-quickjs-bench.rs"
  sed -i "s#path = \"../../engine#path = \"$pocketjs/engine#g" "$scratch/Cargo.toml"
  sed -i '$a include!("g6-quickjs-bench.rs");' "$scratch/src/main.rs"
fi

if [[ ${WORLD_CACHE_REUSE_HOST:-0} != 1 ]]; then
  CARGO_TARGET_DIR="$target" cargo test \
    --manifest-path "$scratch/Cargo.toml" \
    --release --no-default-features --no-run
  printf '%s\n' "$host_input_sha256" >"$host_stamp"
fi
binary=$(find "$target/release/deps" -maxdepth 1 -type f \
  -name 'pocket_desktop_host-*' -perm -111 -printf '%T@ %p\n' \
  | sort -nr | head -1 | cut -d' ' -f2-)

if [[ -n ${WORLD_CACHE_VIEWPORT:-} ]]; then
  viewports=("$WORLD_CACHE_VIEWPORT")
else
  viewports=("480 272" "960 544")
fi
cold_runs=${WORLD_CACHE_COLD_RUNS:-1}
if [[ ! $cold_runs =~ ^[1-9][0-9]*$ ]]; then
  echo "verify-world-cache: WORLD_CACHE_COLD_RUNS must be a positive integer" >&2
  exit 1
fi
for viewport in "${viewports[@]}"; do
  read -r width height <<<"$viewport"
  for ((run = 1; run <= cold_runs; run++)); do
    echo "PROCESS_COLD suite=world-cache viewport=${width}x${height} run=$run/$cold_runs prewarm=none"
    G6_WORLD_CACHE_STRESS=1 \
      G6_DIST="$app_dist" \
      G6_MAPS="$input_root/dist/maps" \
      G6_BATTLE="$input_root/dist/battle" \
      G6_AUDIO_ROOT="$input_root/assets/audio" \
      G6_AUDIO_MANIFEST="$audio_manifest" \
      G6_ANIMATED="$input_root/dist/animated" \
      G6_NPC_SRC="$input_root/dist/npc-src" \
      G6_TERRAIN_STREAM="$input_root/dist/terrain-stream" \
      G6_BENCH_ROOT="$bench_root" \
      G6_RUN_LABEL="$run" \
      G6_BENCH_W="$width" \
      G6_BENCH_H="$height" \
      "$binary" g6_quickjs_bench::world_cache_stress --ignored --exact --nocapture
  done
done
