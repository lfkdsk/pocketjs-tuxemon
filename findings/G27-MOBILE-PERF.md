# Mobile Web frame time

## Verdict

The benchmark, two application-level optimizations, mutation proof and the
cross-host functional gates are complete. Four of the seven maintained scenes
meet both absolute mobile targets in every viewport/throttle cell: map switch,
menus, dense dialogue and Web Link. Cotton Town walking, wild encounters and
battle turns improve against the baseline and stay inside the paired regression
limit, but still miss the absolute targets in all twelve of their cells.

The remaining cost is below the game/component boundary. PocketJS incrementally
rasterizes into a retained framebuffer, but its Web host still copies and sends
the complete 960×544 RGBA image through `putImageData` on every presented frame.
That is 2,088,960 bytes per presentation. A dirty-region raster/readback/upload
contract is the next material step, and this work was explicitly outside the
allowed PocketJS scope. The result is therefore **BLOCKED**, despite the clean
functional gates and bounded host regression comparisons.

`.github/workflows/ci.yml` was not changed. No service worker, Web manifest,
PocketJS source or `bun.lock` was changed.

## Measurement method

- Baseline game revision: `fb2ecdbd`; measured candidate code: game through
  `25f1ca2f` with the component runtime change at `03e4d72`. Later commits only
  fix/add tests, dependency pointers, and documentation.
- Browser: Chrome 138.0.7204.92 over raw Chrome DevTools Protocol. The viewports
  are 390×844 portrait and 844×390 landscape, both DPR 3, under Chrome 4× and 6×
  CPU throttling.
- Each sample warms for 3,000 ms and measures for 60,000 ms. Each cell runs one
  same-window BCCB sequence (baseline, candidate, candidate, baseline), giving
  two samples per build. Reported values are medians of the two per-sample
  distributions rather than one pooled trace.
- The primary `work` sample is reducer/core work accumulated since the prior
  presentation plus the Web host's wasm raster, framebuffer copy and canvas
  upload for that presented frame. Independent rAF intervals and Long Tasks are
  retained as supporting diagnostics.
- The absolute p95 target is 16.7 ms at 4× and 33 ms at 6×. The noise guard also
  rejects `candidate p95 > baseline p95 * 1.08 + 0.5 ms`. Every candidate sample
  must contain at least 30 presented frames.
- Scene checks reject invalid fast paths: Cotton Town must keep moving on its
  intended map; encounter/battle cells must actually visit battle; menus and
  dialogue must remain open; Link must reach the expected mock-service phases.

The committed local guard is `bun run bench:web:mobile --gate`. It uses three
alternating ABBA/BAAB windows by default and the same absolute and relative
thresholds. `--full` selects this complete matrix, while `--profile` captures
the ten largest JavaScript and wasm self-time nodes.

## Formal Chrome matrix

Times are milliseconds. Threshold columns are baseline → candidate percentages.
`LT` is the candidate median Long Task count / maximum duration in milliseconds.

| Scene | Viewport | CPU | Baseline p50 / p95 / p99 | Candidate p50 / p95 / p99 | >16.7 ms % | >33 ms % | LT count / max | Gate |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| city-walk | portrait | 4× | 37.600 / 46.473 / 49.025 | 35.600 / 44.200 / 46.571 | 99.57 → 99.66 | 99.46 → 97.05 | 6 / 62.5 | FAIL |
| city-walk | portrait | 6× | 60.150 / 72.200 / 76.971 | 56.300 / 68.527 / 72.028 | 99.60 → 99.14 | 99.43 → 99.14 | 921 / 91.5 | FAIL |
| city-walk | landscape | 4× | 38.200 / 46.747 / 49.748 | 36.875 / 45.150 / 47.347 | 99.82 → 99.89 | 99.82 → 99.82 | 12 / 65.0 | FAIL |
| city-walk | landscape | 6× | 64.250 / 74.058 / 78.026 | 60.250 / 69.913 / 73.743 | 99.47 → 99.35 | 98.99 → 99.35 | 903 / 92.5 | FAIL |
| map-switch | portrait | 4× | 3.350 / 5.150 / 8.178 | 2.950 / 4.500 / 6.999 | 0.84 → 0.88 | 0.84 → 0.88 | 30 / 139.0 | PASS |
| map-switch | portrait | 6× | 5.100 / 8.213 / 17.147 | 4.150 / 6.850 / 14.452 | 1.03 → 0.98 | 0.91 → 0.95 | 30 / 217.0 | PASS |
| map-switch | landscape | 4× | 3.100 / 4.950 / 8.799 | 2.450 / 4.182 / 6.629 | 0.84 → 0.87 | 0.84 → 0.87 | 30 / 131.5 | PASS |
| map-switch | landscape | 6× | 5.700 / 8.850 / 21.884 | 4.150 / 6.950 / 13.069 | 1.04 → 0.97 | 0.97 → 0.96 | 30 / 203.0 | PASS |
| wild-encounter | portrait | 4× | 3.950 / 43.140 / 57.491 | 3.600 / 40.678 / 57.691 | 13.74 → 10.12 | 9.97 → 9.26 | 117 / 109.0 | FAIL |
| wild-encounter | portrait | 6× | 6.650 / 74.000 / 91.090 | 5.250 / 66.700 / 86.836 | 27.35 → 11.89 | 11.98 → 10.43 | 267 / 197.5 | FAIL |
| wild-encounter | landscape | 4× | 4.200 / 42.600 / 58.548 | 3.650 / 41.255 / 55.757 | 13.70 → 10.30 | 9.92 → 9.22 | 92 / 110.0 | FAIL |
| wild-encounter | landscape | 6× | 6.000 / 73.018 / 90.486 | 5.150 / 66.310 / 85.879 | 25.23 → 11.84 | 11.31 → 10.43 | 267 / 197.5 | FAIL |
| battle-turn | portrait | 4× | 3.100 / 35.747 / 58.306 | 2.250 / 34.008 / 56.787 | 8.26 → 7.10 | 6.61 → 5.74 | 49 / 112.0 | FAIL |
| battle-turn | portrait | 6× | 4.100 / 52.965 / 88.396 | 3.200 / 49.497 / 85.290 | 9.65 → 6.50 | 5.73 → 5.78 | 168 / 173.5 | FAIL |
| battle-turn | landscape | 4× | 2.950 / 35.457 / 57.859 | 2.200 / 33.900 / 56.447 | 8.34 → 7.19 | 6.41 → 5.60 | 57 / 107.5 | FAIL |
| battle-turn | landscape | 6× | 4.450 / 53.320 / 88.641 | 3.650 / 50.770 / 87.123 | 9.49 → 6.74 | 5.61 → 5.69 | 170 / 147.0 | FAIL |
| menus | portrait | 4× | 2.350 / 3.400 / 4.171 | 1.900 / 2.800 / 3.410 | 0.42 → 0.42 | 0.42 → 0.42 | 0 / 0.0 | PASS |
| menus | portrait | 6× | 3.400 / 5.150 / 6.983 | 2.600 / 4.500 / 5.893 | 0.45 → 0.43 | 0.43 → 0.43 | 15 / 65.0 | PASS |
| menus | landscape | 4× | 2.250 / 3.250 / 4.050 | 1.600 / 2.400 / 3.000 | 0.42 → 0.25 | 0.42 → 0.21 | 0 / 0.0 | PASS |
| menus | landscape | 6× | 3.550 / 5.568 / 7.538 | 2.400 / 3.800 / 5.139 | 0.51 → 0.44 | 0.43 → 0.43 | 15 / 64.5 | PASS |
| dialogue | portrait | 4× | 2.550 / 5.550 / 33.690 | 1.900 / 4.500 / 32.748 | 1.72 → 1.73 | 1.26 → 0.96 | 1 / 66.5 | PASS |
| dialogue | portrait | 6× | 4.825 / 9.400 / 53.622 | 4.100 / 8.300 / 50.986 | 1.86 → 1.74 | 1.66 → 1.64 | 52 / 110.5 | PASS |
| dialogue | landscape | 4× | 2.500 / 5.300 / 33.474 | 2.050 / 4.800 / 33.050 | 1.72 → 1.73 | 1.09 → 1.02 | 1 / 71.0 | PASS |
| dialogue | landscape | 6× | 4.350 / 8.500 / 50.782 | 3.100 / 7.300 / 49.117 | 1.79 → 1.70 | 1.65 → 1.62 | 46 / 107.0 | PASS |
| web-link | portrait | 4× | 2.550 / 3.700 / 4.250 | 2.200 / 3.150 / 3.550 | 0.00 → 0.00 | 0.00 → 0.00 | 0 / 0.0 | PASS |
| web-link | portrait | 6× | 3.550 / 5.300 / 6.672 | 2.650 / 4.100 / 4.977 | 0.04 → 0.00 | 0.00 → 0.00 | 0 / 0.0 | PASS |
| web-link | landscape | 4× | 2.050 / 2.950 / 3.500 | 1.550 / 2.400 / 2.800 | 0.00 → 0.00 | 0.00 → 0.00 | 0 / 0.0 | PASS |
| web-link | landscape | 6× | 2.900 / 4.250 / 5.300 | 2.100 / 3.150 / 4.050 | 0.03 → 0.00 | 0.00 → 0.00 | 0 / 0.0 | PASS |

All 28 candidate p95 values are below their paired regression limits. Sixteen
cells also meet the absolute target; the twelve failures above are absolute
target failures only.

## Hotspots

The following tables aggregate seven 10-second landscape/6× profiles taken
before the fixes. Chromium's `(idle)` bucket (20,825.009 ms) is excluded;
`(program)` is retained because it is a real profiler attribution bucket even
though it is not an actionable source function.

### JavaScript / browser nodes

| Rank | Node | Aggregate self time (ms) | Samples |
| ---: | --- | ---: | ---: |
| 1 | `(program)` | 16,275.156 | 11,800 |
| 2 | `putImageData` | 3,647.249 | 3,346 |
| 3 | `paint` | 3,344.893 | 3,042 |
| 4 | `put` | 1,831.289 | 1,611 |
| 5 | `syncDemoControls` | 1,590.711 | 1,413 |
| 6 | `(anonymous)` | 1,461.906 | 1,343 |
| 7 | `digest` | 1,157.703 | 1,060 |
| 8 | `Blob` | 884.059 | 754 |
| 9 | `URLSearchParams` | 706.966 | 626 |
| 10 | `fetch` | 313.712 | 298 |

### wasm nodes

Rust names are shortened to their meaningful suffixes; the raw receipt keeps
the complete symbols.

| Rank | Node | Aggregate self time (ms) | Samples |
| ---: | --- | ---: | ---: |
| 1 | `raster::render_scaled_clipped` | 5,250.841 | 4,827 |
| 2 | `raster::texel` | 3,445.059 | 3,142 |
| 3 | `render_incremental_at_scale` | 519.442 | 479 |
| 4 | `raster::fill_rect` | 407.715 | 378 |
| 5 | `style::last_entry` | 141.179 | 126 |
| 6 | `RgbaTarget::blend` | 133.382 | 124 |
| 7 | `Walker::paint` | 126.916 | 133 |
| 8 | `style::resolve_layers` | 102.749 | 94 |
| 9 | `layout::assign_rect` | 76.031 | 69 |
| 10 | `Walker::emit_text` | 73.732 | 73 |

The profile shapes explain the result split. Mostly static menus, dialogue and
Link spend little time in wasm rasterization. Walking and animated battle work
are dominated by scaled texel rasterization, then still pay the whole-frame JS
copy and canvas upload.

## Optimizations and behavior preservation

### Unchanged demo controls

The generic Web player now caches the demo-control root, reparses the boot URL
only when the search string changes, and derives a compact visible-state key.
It still polls the guest hook each frame, but performs no repeated DOM queries,
class/attribute writes or fallback-link construction until readiness, chapter,
speed or URL changes. In the comparable 10-second landscape/6× battle profile,
`syncDemoControls` self time fell from 209.400 ms to 26.472 ms. A component test
counts queries and writes and proves that a second unchanged poll performs none,
then proves that a chapter change updates the controls.

### Transparent battle damage

The importer now computes RGBA4444-visible bounds for every front/back monster
cell and every technique-animation frame. The battle scene uses those bounds to
clip transparent padding before it reaches PocketJS's scaled rasterizer. It
falls back to the legacy full axis where a smaller atlas cell intentionally
exposes a neighbour frame.

The exhaustive test recomputes every imported bound from source PNG alpha,
shows average monster damage area is below 55% of the old slots, keeps Bullet's
animation area at or below 11%, and compares old/new RGBA framebuffers through
rest, faint sinking and defensive horizontal movement. The maintained 960×544
hit and faint goldens were also inspected visually: sprites, attack effect,
HUD, background and dialogue remain composed correctly.

Formal battle p95 improved by 4.4–6.5%, and wild-encounter p95 improved by
3.2–10.0%, depending on viewport/throttle. The relative gate passes every
cell, but full-frame presentation leaves the absolute failures visible in the
matrix.

## Regression guard mutation

The demo-control optimization was reverted only in an isolated mutation build.
Three alternating landscape/6× menu windows moved p95 from 5.187 ms to
6.440 ms. The paired allowance was 6.102 ms, so the committed local benchmark
failed for the intended reason. This proves the guard detects a real regression
well below the loose 33 ms absolute ceiling.

## Desktop QuickJS and PSP

The archived cold-start tape mentioned by the release instructions was not
present, so cold startup used the supported production-distribution startup-only
ABBA driver rather than inventing a replacement tape. It ran ten alternating
windows and 20 samples per build/viewport on one pinned CPU:

| Gate | Baseline | Candidate | Paired change |
| --- | ---: | ---: | ---: |
| QuickJS cold startup, 480×272 median | 227.334 ms | 229.685 ms | +1.110% |
| QuickJS cold startup, 960×544 median | 226.960 ms | 231.437 ms | +1.861% |
| QuickJS production frame p95, 480×272 | 4.144 ms | 4.207 ms | +1.53% |
| QuickJS production frame p95, 960×544 | 6.455 ms | 6.443 ms | −0.18% |
| PSP first frame | 7,201,513 µs | 7,235,483 µs | +0.471706% |

The startup medians are below 250 ms and the paired median changes are below
3%, but this is not a clean absolute-startup pass: the raw record retains four
scheduler-sensitive samples over 250 ms (two candidate at 480×272, plus one
sample from each build at 960×544) instead of silently replacing them. The
paired 95% intervals also extend above +3%, so these data establish the observed
median drift, not a tighter confidence bound. All four QuickJS frame legs end at
canonical state
`2ae4650cc8be15cd1f794b9440f79903220bd745f3725af020619490dbd1eba9`.

PSP used software-rendered PPSSPP at pinned revision
`a2f4ce214f224c6c26b3319409ec50205ff8253d`, fresh memory sticks and A/B/B/A
order. The bounded first-frame delta is under 3%. The baseline package's full
opening independently stalls after frame 3000 with `arena_tail_free_bytes=0`,
so it cannot supply an honest full-opening A/B comparison; that pre-existing
baseline failure is recorded separately. The candidate's maintained full PSP
save/legacy/autosave/read-only-failure verifier nevertheless ends
`ALL PHASES PASS`.

## Correctness and release gates

| Area | Result |
| --- | --- |
| Import determinism | Two complete imports were byte-identical and left the tracked tree unchanged. |
| TypeScript | Game and component `bunx tsc --noEmit` passed. |
| Game tests | Ten CI-equivalent groups: 2,014 pass, 0 fail, 0 skip. |
| Component tests | After building the required wasm and example artifacts: 4,619 pass, 0 fail, 0 skip across 303 files. The retained log also includes the earlier unprepared diagnostic run (4,133 pass, 496 skip, 2 missing-artifact failures) before preparation. |
| Journey matrix | All 17 commands passed. The complete mainline ends after 230,322 frames at `spyder_datacenter@[7,4]`, hash `1977c1b0f3bd1bba2c4e5ad82332599c4fc72f0acd84d9437868976fbfb5c736`. |
| Web | Link, build, journey, Chinese, demo, Arena, expedition, doubles and audio passed; the extra chunk, language and final Link verifiers also passed. |
| PSP | Bootstrap, warm build, full save verifier and final release build passed. |
| Targeted behavior | Mobile benchmark/statistics tests and battle clip bounds/framebuffer tests passed after the final component pointer update. |

The Web benchmark is a local manual performance gate, not a new CI job; the
complete 28-cell matrix is too slow for the normal push pipeline. The shorter
three-window gate is documented for release use.

## Integration order and receipts

Merge the component branch through `0a031ab` first, then the game branch; the
game's gitlink already points to that component commit. PocketJS needs no merge
from this work. Raw Fleet artifacts include the seven `mobile-final-*.json`
receipts, `mobile-before-profiles.json`, the mutation receipt, QuickJS startup
and frame receipts, the PSP A/B/B/A summary/profiles, and the four final-gate
logs.

Subagent 使用：4 / 分别核对 Web 基准场景、热点、QuickJS/PSP 方法和最终门禁清单；节省了前期只读盘点时间，所有正式计时与重门禁仍由主代理串行执行。

BLOCKED
