#!/usr/bin/env bash
set -euo pipefail

root=$(cd "$(dirname "$0")/.." && pwd)
bench_root=${G6_BENCH_ROOT:-${TMPDIR:-/var/tmp}/pocket-tuxemon-quickjs}
scratch="$bench_root/quickjs-host"
target="$bench_root/quickjs-target"
pocketjs="$root/vendor/pocket-rpgkit/vendor/pocketjs"
map_bundle="$bench_root/map-bundle"
map_report=${G6_MAP_REPORT:-$root/reports/G7-map-first-visits.tsv}
journey=${G6_JOURNEY:-$root/data/g6-journey.json}
expected_map=${G6_EXPECTED_MAP:-spyder_route1}
# The expected terminal state is the one the tape itself records, so a
# re-pinned tape cannot leave a stale literal behind here. G6_STATE_SHA256
# still overrides it (e.g. G6_WEATHER=rain runs, whose terminal state
# intentionally differs from the sunny tape).
terminal_sha256=$(bun -e '
  const journey = JSON.parse(await Bun.file(process.argv[1]).text());
  const value = journey.terminalStateSha256;
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) {
    throw new Error("missing or malformed terminalStateSha256");
  }
  console.log(value);
' "$journey")
expected_state=${G6_STATE_SHA256:-$terminal_sha256}
app_dist=${G6_DIST:-$root/dist/linux-app}
app_js="$app_dist/pocket-tuxemon.js"
app_pak="$app_dist/pocket-tuxemon.pak"
project_shell="$root/dist/project-shell.json"
host_stamp="$bench_root/quickjs-host-input.sha256"

for artifact in "$app_js" "$app_pak" "$project_shell"; do
  if [[ ! -f "$artifact" ]]; then
    echo "bench-g6-quickjs: missing build artifact: $artifact" >&2
    echo "run 'bun tools/desktop.ts --build-only' before this benchmark" >&2
    exit 1
  fi
done

# The desktop bundle and streamed map shards must come from the same import.
# A stale bundle can otherwise boot against newer maps and fail deep inside
# createSession with an apparently unrelated unregistered-extension error.
map_manifest_hash=$(bun -e '
  const project = JSON.parse(await Bun.file(process.argv[1]).text());
  const value = project.mapManifestHash;
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) {
    throw new Error("missing or malformed mapManifestHash");
  }
  console.log(value);
' "$project_shell")
if ! grep -Fq "$map_manifest_hash" "$app_js"; then
  echo "bench-g6-quickjs: dist/linux-app is stale relative to dist/project-shell.json" >&2
  echo "run 'bun tools/desktop.ts --build-only' before this benchmark" >&2
  exit 1
fi

app_js_sha256=$(sha256sum "$app_js" | cut -d' ' -f1)
app_pak_sha256=$(sha256sum "$app_pak" | cut -d' ' -f1)
project_shell_sha256=$(sha256sum "$project_shell" | cut -d' ' -f1)
echo "BUILD_INPUT app_js_sha256=$app_js_sha256 app_pak_sha256=$app_pak_sha256 project_shell_sha256=$project_shell_sha256 map_manifest_sha256=$map_manifest_hash"

host_input_sha256=$(
  {
    sha256sum "$root/tools/g6-quickjs-bench.rs"
    git -C "$pocketjs" rev-parse HEAD
  } | sha256sum | cut -d' ' -f1
)
echo "HOST_INPUT sha256=$host_input_sha256 reuse=${G6_REUSE_HOST:-0}"

if [[ ${G6_REUSE_HOST:-0} == 1 ]]; then
  if [[ ! -f "$host_stamp" || $(<"$host_stamp") != "$host_input_sha256" ]]; then
    echo "bench-g6-quickjs: G6_REUSE_HOST=1 requested without a matching compiled host" >&2
    echo "run once without G6_REUSE_HOST to refresh $bench_root" >&2
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

if [[ ${G6_SKIP_MAP_BENCH:-0} != 1 ]]; then
  rm -rf "$map_bundle"
  mkdir -p "$map_bundle"
  bun "$pocketjs/tools/build.ts" "$root/tools/map-benchmark-entry.tsx" \
    --framework=solid --project-root="$root" --outdir="$map_bundle"
fi

if [[ ${G6_REUSE_HOST:-0} != 1 ]]; then
  CARGO_TARGET_DIR="$target" cargo test --manifest-path "$scratch/Cargo.toml" --release --no-default-features --no-run
  printf '%s\n' "$host_input_sha256" >"$host_stamp"
fi
binary=$(find "$target/release/deps" -maxdepth 1 -type f -name 'pocket_desktop_host-*' -perm -111 -printf '%T@ %p\n' | sort -nr | head -1 | cut -d' ' -f2-)
if [[ -z $binary ]]; then
  echo "bench-g6-quickjs: compiled QuickJS host not found under $target" >&2
  exit 1
fi

if [[ -n ${G6_BENCH_VIEWPORT:-} ]]; then
  viewports=("$G6_BENCH_VIEWPORT")
else
  viewports=("480 272" "960 544")
fi
cold_runs=${G6_COLD_RUNS:-1}
if [[ ! $cold_runs =~ ^[1-9][0-9]*$ ]]; then
  echo "bench-g6-quickjs: G6_COLD_RUNS must be a positive integer" >&2
  exit 1
fi
for viewport in "${viewports[@]}"; do
  read -r width height <<<"$viewport"
  for ((run = 1; run <= cold_runs; run++)); do
    state="$bench_root/state-${width}x${height}-run${run}.json"
    echo "PROCESS_COLD suite=journey viewport=${width}x${height} run=$run/$cold_runs prewarm=none"
    G6_DIST="$app_dist" G6_JOURNEY="$journey" \
      G6_MAPS="$root/dist/maps" G6_BATTLE="$root/dist/battle" \
      G6_PORTRAITS="$root/dist/portraits" G6_CHOICE_ICONS="$root/dist/choice-icons" \
      G6_MAPS_ZH="$root/dist/maps-zh" G6_BATTLE_ZH="$root/dist/battle-zh" \
      G6_ZH_PROJECT="$root/dist/project-shell.zh_CN.json" \
      G6_ZH_BATTLE_SHELL="$root/dist/battle-runtime-shell.zh_CN.json" \
      G6_ZH_NAMES="$root/data/battle-names.zh_CN.json" \
      G6_ZH_MAP_DESCRIPTIONS="$root/dist/map-descriptions.zh_CN.json" \
      G6_ZH_MONTH_NAMES="$root/data/month-names.zh_CN.json" \
      G6_AUDIO_ROOT="$root/assets/audio" G6_AUDIO_MANIFEST="$root/assets/audio/manifest.json" \
      G6_ANIMATED="$root/dist/animated" G6_NPC_SRC="$root/dist/npc-src" \
      G6_TERRAIN_STREAM="$root/dist/terrain-stream" G6_DEMO="$root/dist/demo" \
      G6_BENCH_ROOT="$bench_root" G6_RUN_LABEL="$run" \
      G6_STATE_OUT="$state" G6_EXPECTED_MAP="$expected_map" \
      G6_BENCH_W="$width" G6_BENCH_H="$height" \
      "$binary" g6_quickjs_bench::journey --ignored --exact --nocapture
    actual=$(sha256sum "$state" | cut -d' ' -f1)
    # Complete post-Billie state, including persistent party/history, the
    # independent battle/weather RNG cursors, saved clock/daylight state, and
    # persistent shop-stock banks.
    if [[ "$actual" != "$expected_state" ]]; then
      echo "STATE MISMATCH viewport=${width}x${height} run=$run expected=$expected_state actual=$actual" >&2
      exit 1
    fi
    echo "STATE viewport=${width}x${height} run=$run canonical_sha256=$actual"
  done
done

if [[ ${G6_SKIP_MAP_BENCH:-0} != 1 ]]; then
  G6_MAP_BENCH_DIST="$map_bundle" G6_MAPS="$root/dist/maps" \
    G6_BENCH_ROOT="$bench_root" G6_MAP_REPORT="$map_report" \
    "$binary" g6_quickjs_bench::map_first_visits --ignored --exact --nocapture
  echo "MAP_REPORT $map_report"
fi
