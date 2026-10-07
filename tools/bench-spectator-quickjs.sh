#!/usr/bin/env bash
set -euo pipefail

root=$(cd "$(dirname "$0")/.." && pwd)
bench_root="${BATTLE_BENCH_ROOT:-${TMPDIR:-/tmp}/pocket-tuxemon-battle-bench}"
scratch="$bench_root/quickjs-spectator-host"
target="$bench_root/quickjs-spectator-target"
pocketjs="$root/vendor/pocket-rpgkit/vendor/pocketjs"
bundle="$bench_root/spectator-bench.js"

mkdir -p "$bench_root"

bun build "$root/tools/battle-oracle/spectator-bench-entry.ts" --target=browser --format=iife --minify --outfile="$bundle"

rm -rf "$scratch"
mkdir -p "$scratch"
cp -a "$pocketjs/hosts/desktop/." "$scratch/"
cp "$root/tools/spectator-quickjs-bench.rs" "$scratch/src/spectator-quickjs-bench.rs"
sed -i "s#path = \"../../engine#path = \"$pocketjs/engine#g" "$scratch/Cargo.toml"
sed -i '$a include!("spectator-quickjs-bench.rs");' "$scratch/src/main.rs"

CARGO_TARGET_DIR="$target" cargo test --manifest-path "$scratch/Cargo.toml" --release --no-default-features --no-run
binary=$(find "$target/release/deps" -maxdepth 1 -type f -name 'pocket_desktop_host-*' -perm -111 -printf '%T@ %p\n' | sort -nr | head -1 | cut -d' ' -f2-)

SPECTATOR_BENCH_JS="$bundle" "$binary" spectator_quickjs_bench::run --ignored --exact --nocapture
