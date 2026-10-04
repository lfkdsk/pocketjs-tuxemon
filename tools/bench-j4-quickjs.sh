#!/usr/bin/env bash
set -euo pipefail

root=$(cd "$(dirname "$0")/.." && pwd)
bench_root=${J4_BENCH_ROOT:-${TMPDIR:-/tmp}/pocket-tuxemon-j4-quickjs}
journey="$bench_root/j4-quickjs-tape.json"
mkdir -p "$bench_root"
bun "$root/tools/j4-quickjs-tape.ts" "$journey"

terminal_sha256=$(bun -e '
  const journey = JSON.parse(await Bun.file(process.argv[1]).text());
  const value = journey.terminalStateSha256;
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) {
    throw new Error("missing or malformed terminalStateSha256");
  }
  console.log(value);
' "$journey")

run=(env)
if [[ -n ${J4_BENCH_VIEWPORT:-} ]]; then
  run+=(G6_BENCH_VIEWPORT="$J4_BENCH_VIEWPORT")
else
  run+=(-u G6_BENCH_VIEWPORT)
fi
run+=(
  G6_BENCH_ROOT="$bench_root"
  G6_JOURNEY="$journey"
  G6_START_CHAPTER=radio-broadcast
  G6_EXPECTED_MAP=spyder_datacenter
  G6_STATE_SHA256="$terminal_sha256"
  G6_SKIP_MAP_BENCH=1
  G6_FAST_BENCH=1
  G6_HANDOFF_BUCKETS=1
  G6_HASH_EVERY=${J4_HASH_EVERY:-1})
"${run[@]}" bash "$root/tools/bench-g6-quickjs.sh"
