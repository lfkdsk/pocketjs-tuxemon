# K-CANOPY-PERF: bounded canopy occlusion without platform regression

## Outcome

The row-interleaved canopy renderer now stays within the requested 3% gates
on PSP and desktop QuickJS while preserving the K-CANOPY painter rule byte for
byte. The formal PSP steady-work p95 delta is **+1.745%**. Desktop QuickJS CPU
p95 is **+2.218%** at 480x272 and **-0.357%** at 960x544. Relative to the
pre-optimization canopy implementation, those three results improve by
0.992%, 3.192%, and 2.530%, respectively.

The implementation keeps one texture upload per resident upper chunk, shares
that handle across clip slices, and bounds rows and slices by the current
viewport. No golden, journey state, imported asset, map data, or PocketJS
source changed.

The intended publication branch is `perf/canopy-row-sync` in both repositories.
The measured implementation heads are:

| Repository | Measured head | Role |
| --- | --- | --- |
| game | `8908ac086160ba783d0d2bbe5cc3dbfae05f200e` | submodule pointer and status entry |
| component | `e72978932c27a0723cdc15ca60016bf55fa69cfc` | renderer, tests, bundle pins, status entry |
| PocketJS | `8de08a89cc2a7848b5561a2241fe879511d50f79` | unchanged engine |

This report and its receipt are documentation-only successors to the measured
game head. The raster-only comparison is game `b955710e9a35232d003eea3b45cd666e4ad6d57e`
with component `dd8a4d27216834e6776996360db324e653cde287`; the pre-fix canopy
comparison is game `3c7a0fe6615f017b4f86bbcfc2cf6155d1f1c2bd` with component
`692bf785d3b0f0da99aa8608fd8111625486d324`.

## Cause and retained fixes

The measured regression had three reinforcing causes: a camera-pixel window
invalidated every upper row on one-pixel motion; every row independently
filtered and sorted the same resident chunks; and stable frames repeatedly
resent row properties, image bindings, and a cut-mask walk over every
occluder/row pair.

The retained implementation:

- quantizes the horizontal and vertical synchronization window to tiles;
- filters and sorts visible upper chunks once per synchronization, then
  buckets them into the clip bands they overlap;
- computes depth boundaries by directly inverting `upperRowDepth`, replacing
  the siblings-times-rows cut-mask scan;
- merges adjacent tile rows whenever no actor or above-animation depth crosses
  their boundary, creating only the painter-order bands that matter;
- caches non-terrain child/style identities, so an unchanged frame skips the
  cut-mask and row synchronization entirely;
- suppresses unchanged row style, debug-name, and image writes and hides idle
  pooled bands; and
- applies the same stable debug-name rule to the ordinary
  `OccludingUpperLayer` path.

The optimization history deliberately kept only measured wins. Synchronization
alone still left PSP at +3.378%; the first band implementation regressed it to
about +6.14%; direct boundary inversion brought it to +3.533%. Caching the
occluder child/style identities removed the remaining unchanged-frame native
tree work and produced the passing +1.745% result.

## PSP software-renderer measurement

The formal comparison used pinned PPSSPPHeadless
`a2f4ce214f224c6c26b3319409ec50205ff8253d`, software rendering, a new
memory stick per leg, and baseline-final-final-baseline order. Each leg emitted
38 300-frame windows; the first window was excluded. The table uses the
median of the two same-variant legs.

| Metric | Raster baseline | Final | Delta | Result |
| --- | ---: | ---: | ---: | --- |
| steady work p95 | 7,162 us | 7,287 us | **+1.745%** | **PASS** |
| steady average work | 7,161 us | 7,285.5 us | +1.739% | PASS |
| steady average JS | - | - | +2.011% | PASS |
| steady average draw | - | - | -0.642% | PASS |
| steady average render | - | - | +2.772% | PASS |
| boot to frame 0 | 6,384,788 us | 6,381,563 us | -0.051% | PASS |
| QuickJS live high-water | 10,773,625 B | 10,791,318 B | +0.164% | PASS |
| QuickJS peak high-water | 14,113,641 B | 14,155,487 B | +0.296% | PASS |
| arena bump high-water | 21,563,504 B | 21,600,432 B | +0.171% | PASS |
| host peak RSS | 97,684 KiB | 96,680 KiB | -1.028% | PASS |

No measured frame exceeded 16 ms. The pre-fix canopy head measured 7,360 us,
so the final implementation improves that head by 0.992% while changing the
raster baseline delta from a fail to a pass.

The existing formal Flower City segment remains a passing reference: its
7,666 tape frames end at `spyder_mansion@1,13` with state SHA-256
`c0b36ae2112df49774377c30e728d03a929fba771746bf54cb14e684742a8a87`;
the pre-fix canopy head was +2.126% in average work, +0.369% in boot,
+0.619% in arena high-water, and -0.125% in host RSS. The final patch removes
delivery work from that same renderer without changing the tape, pixels, or
terminal state; the final ordinary PSP matrix above is the stricter steady
hot-path gate.

The real PPSSPP save verifier also passed every phase: normal save/load was
field-for-field identical and continued 30 frames, legacy raw JSON loaded,
autosave survived a restart, and a read-only memory stick displayed
`SAVE FAILED` without writing or crashing. A normal `build:psp --skip-assets`
then rebuilt the retained package; its build log contains no trace-in-release
warning.

## Desktop QuickJS and cold start

The production-frame comparison reused one pinned QuickJS host on CPU 15 in
baseline-final-final-baseline order. Every leg reached state SHA-256
`2ae4650cc8be15cd1f794b9440f79903220bd745f3725af020619490dbd1eba9`.

| Viewport / metric | Raster baseline | Final | Delta | Versus pre-fix | Result |
| --- | ---: | ---: | ---: | ---: | --- |
| 480x272 QuickJS CPU p95 | 3.990 ms | 4.0785 ms | **+2.218%** | -3.192% | **PASS** |
| 960x544 QuickJS CPU p95 | 6.4385 ms | 6.4155 ms | **-0.357%** | -2.530% | **PASS** |
| 480x272 total p95, diagnostic | 4.0665 ms | 4.2295 ms | +4.008% | - | non-gating |
| 960x544 total p95, diagnostic | 6.4965 ms | 6.4840 ms | -0.192% | - | non-gating |

The residual traced draw totals are +16.50% and +40.43%; the pre-fix values
were about +40% and +79%. This residual does not breach the specified desktop
QuickJS CPU-p95 acceptance gate, but it is reported rather than hidden.

Cold startup used 80 fresh processes: ten alternating ABBA/BAAB windows per
viewport, 20 samples per variant. All 80 samples stayed under 250 ms. Paired
median changes are -0.180% at 480x272 and -0.031% at 960x544; raw p95 changes
are -1.308% and -0.047%.

The throttled mobile-Web gate used three alternating BCCB windows of a
15-second city walk at 844x390, DPR 3, and 6x CPU throttle. Work p95 changed
from 28.908 to 29.408 ms (+1.730%), work over 33 ms was 0.70%, no leg produced
a Long Task, and the maintained gate passed.

## Pixels, state, and resource bounds

The final candidate re-rendered the Flower City seam through the ordinary and
connected renderers at both 480x272 and 960x544. Both comparisons report zero
differing pixels. Their comparison sheets have SHA-256
`21e87105d8565bcde9d94082cc7803d1a781a73ee3a0e220a83b11f6ef404c7e`
and are byte-identical to the committed K-CANOPY reference. I opened the
480x272 crop and both full frames: the player/tree boundary is clean, the
third diff panel is black, and the 960x544 connected map has no seam, stale
slice, or depth inversion. No golden file changed.

The component resource fixture proves:

- uploads equal resident upper textures;
- row bindings exceed texture count, demonstrating handle reuse;
- four visible above-animation depths plus the player need at most six clip
  bands rather than twenty tile rows;
- slices are at most four per clip band in the fixture; and
- the existing twelve-map/22-crossing coverage keeps texture and node
  high-water marks bounded by the viewport rather than visit count.

Two complete imports reproduced 5,077 files and 69,622,876 bytes with tree
SHA-256 `6c262abb4bf2e9fa856d40c3990b74f9e25986d117b3e0bf98af7a551788d7e0`.
The 230,322-frame English mainline still ends at `spyder_datacenter@7,4` with
SHA-256 `1977c1b0f3bd1bba2c4e5ad82332599c4fc72f0acd84d9437868976fbfb5c736`;
all 20 chapter suffixes reach that terminal, and the built replay passed 242
checkpoints.

## Mutation strength

Each mutation ran in a disposable worktree with the candidate untouched.

| Mutation | Expected focused failure | Result |
| --- | --- | --- |
| remove tile-window quantization | `rowSyncs`: expected 1, received 2 | caught |
| sort again inside each row | `chunkSorts`: expected 7, received 12 | caught |
| restore one node per tile row | `rowNodes <= 6`: received 20 | caught |

The clean focused candidate reports 16 pass, 0 fail, 0 skip. The direct depth
boundary inversion was also exhaustively compared with the former inclusive
loop over the relevant depth domain and produced identical cut masks.

## Validation

### Component and independent consumer

The component suite reports 4,624 pass, 0 fail, **0 skip**, with 731,821
assertions across 304 files. TypeScript, all production/example builds, Web
builds, and the Chrome Web verifier passed. Bundle-isolation pins were updated
only for the measured renderer source changes.

The six-round interleaved QuickJS unused-path guard passed all eight workloads:

| Workload | Branch versus component base median |
| --- | ---: |
| sunstoneIdle | +0.342% |
| sunstoneWalk | +0.157% |
| sunstoneControlWalk | +0.145% |
| streamedRoam | -0.611% |
| battleScene | -0.006% |
| sunstoneIdleImmutable | -0.013% |
| sunstoneControlWalkImmutable | +0.439% |
| battleSceneImmutable | +0.367% |

The cumulative-parent comparison also passed with zero regressions,
inconclusive cases, or errors. The isolated Wander consumer reports 523 pass,
0 fail, **0 skip**; its typecheck, build, Web build, and HTTP smoke all passed.

### Game, journeys, Web, and PSP

Localization (11/11), 2,645 CJK fallback characters, TypeScript, production
build, Wasm build, and import determinism passed. The ten CI test partitions
report 2,023 pass, 0 fail, **0 skip**; the suite was not run as one process.

All 17 journey matrix commands passed: GB6, J1, J2, J3, J4, German parity,
golden synchronization, both defeat paths, imported lock coverage, frozen-map
scan, chapters, Chinese tape/demo, English demo, save/resume, preview coverage,
and built-world replay.

The complete Web job passed: Link modes, deployable build, offline PWA,
journey, Chinese opening, demo controls, Arena, Expedition, double battles,
and audio. The additional chunk, language, link, and PWA verifiers passed.
The PSP CI sequence passed the warm build, real save verifier, and final
traceless rebuild.

At finalization both repositories were clean, their fetched `origin/main`
tips were still the measured bases, and no rebase was required. `bun.lock`
and every golden remained unchanged. No merge commit or PocketJS change is
part of the delivery.

The machine-readable companion is `findings/K-CANOPY-PERF-receipt.json`.

subagent 使用：3 个 / implementation scan, gate-matrix audit, measurement-method audit / saved time

PASS
