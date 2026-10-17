# Canopy row occlusion: PSP, desktop QuickJS, and mobile Web cost

## Verdict

The candidate is a performance **FAIL** against the 3% desktop/PSP limit.
The ordinary PSP steady-work p95 regresses from 7,133 to 7,360 us
(+3.182%), and the quiet desktop BCCB run at 480x272 regresses from 4.081
to 4.213 ms in QuickJS CPU p95 (+3.235%). Total desktop p95 at that viewport
rises by 7.111%. The requested raw cold-start p95 at 480x272 also rises
3.380%, although the paired-window cold-start estimate remains below 3%.

The result is not a blanket failure: PSP boot, the complete Flower City
journey segment, all measured PSP memory high-waters, both paired cold-start
medians, and the maintained mobile-Web gate pass. The complete, path-free
machine receipt is [PERF-CANOPY-PSP-receipt.json](PERF-CANOPY-PSP-receipt.json).

## Compared builds and controls

The two versions were checked out independently with their own recursive
submodules and built fresh for desktop, Web, ordinary PSP bench, and the
Flower City PSP journey segment.

| Variant | Game commit | RPGKit commit | PocketJS commit |
| --- | --- | --- | --- |
| A, raster baseline | `b955710e9a35232d003eea3b45cd666e4ad6d57e` (`docs: report textured quad raster fast path`) | `dd8a4d27216834e6776996360db324e653cde287` | `8de08a89cc2a7848b5561a2241fe879511d50f79` |
| B, canopy candidate | `3c7a0fe6615f017b4f86bbcfc2cf6155d1f1c2bd` | `692bf785d3b0f0da99aa8608fd8111625486d324` | `8de08a89cc2a7848b5561a2241fe879511d50f79` |

Content inputs are byte-identical between A and B:

| Artifact | Shared SHA-256 |
| --- | --- |
| Desktop/startup pak | `7c2b217be24ba82b9a30e521ac5b9cd441826d536d07e657d0616d053d47ebee` |
| PSP external `assets.pak` | `bc546df22cef9ae546ec523c18b6b8cffd88de299044d4a8879165812e81260a` |
| PSP embedded pak | `9f2bd7d59bf6b4364a3c652d0d013fc2686593a19f6e6fca84636d8f5ec50d78` |
| Web pak manifest | `de00647150ebec674a4f791881f9cc0f2c6290b784aa2fe21929629e11ae79b0` |
| Web 2,124-entry chunk name/size listing | `396859eff5f9d80b21697a9bb188f059c88bec0ef7202c2450184c4908caa609` |

The executable JavaScript differs, as expected from the RPGKit/canopy
change. PocketJS is the same source commit. Separate Web builds nevertheless
produced different Wasm bytes (A: 430,182 bytes,
`2382be792e55502333ffa765d9c9942eed31fafee3e084ef202e0daba729acc2`;
B: 430,171 bytes,
`13ee66682cf355f3dc01843ad203565fa0363ec178056e8c34170a0baff683f1`).
Code, data, and name sections all differed, so this is build
nondeterminism rather than a PocketJS source change. To prevent that noise
from entering the formal Web comparison, both temporary sites used B's exact
Wasm. No checked-in product file was changed.

## PSP software-renderer measurements

All formal runs used PPSSPPHeadless commit `a2f4ce214f224c6c26b3319409ec50205ff8253d`
with `--graphics=software`, a new isolated memory stick per leg, and A-B-B-A
order. Guest time and QuickJS/arena memory come from `PocketJS-bench.jsonl`;
host peak RSS is GNU `time -v`'s maximum resident set size. Values below are
the median of each variant's two legs. Both legs of a variant produced the
same guest timings and heap values, while RSS is the median of the two host
observations.

### Ordinary bench

Each leg emitted 22 windows of 300 frames. Steady values exclude the first
window; the reported work p95 is the median guest p95 across the remaining
windows.

| Metric | A | B | Delta | 3% result |
| --- | ---: | ---: | ---: | --- |
| Boot to frame 0 | 6,384,788 us | 6,382,948 us | -0.029% | PASS |
| Steady work p95 | 7,133 us | 7,360 us | **+3.182%** | **FAIL** |
| Steady average work | 7,131 us | 7,358 us | **+3.183%** | **FAIL** |
| Steady average JS | 6,112 us | 6,138 us | +0.425% | PASS |
| Steady average draw | 779 us | 942 us | +20.924% | diagnostic |
| Steady average render | 235 us | 274 us | +16.596% | diagnostic |
| QuickJS live bytes | 10,773,625 | 10,899,342 | +1.167% | PASS |
| QuickJS peak bytes | 14,113,641 | 14,247,233 | +0.947% | PASS |
| Arena bump high-water | 21,563,504 B | 21,709,648 B | +0.678% | PASS |
| PPSSPP host peak RSS | 101,240 KiB | 101,172 KiB | -0.067% | PASS |

Draw plus render grows by 202 us while total work grows by 227 us, accounting
for about 89.0% of the regression. The JS delta is only 26 us. This makes the
ordinary PSP failure a rendering/node-delivery cost rather than a reducer or
game-simulation cost.

### Flower City canopy journey

The formal segment traverses Flower City and its outdoor route before ending
at `spyder_mansion@1,13`. Every leg consumed 7,666 tape frames, emitted 7,667
host frames, and verified terminal state SHA-256
`c0b36ae2112df49774377c30e728d03a929fba771746bf54cb14e684742a8a87`.

| Metric | A | B | Delta | 3% result |
| --- | ---: | ---: | ---: | --- |
| Boot to frame 0 | 8,581,942 us | 8,613,579 us | +0.369% | PASS |
| Average frame interval | 328,183 us | 335,501 us | +2.230% | PASS |
| Maximum frame interval | 2,313,523 us | 2,340,101 us | +1.149% | PASS |
| Average work | 321,297 us | 328,129 us | +2.126% | PASS |
| Maximum work | 2,301,419 us | 2,328,544 us | +1.179% | PASS |
| Average JS | 319,899 us | 326,461 us | +2.051% | PASS |
| Average draw | 1,035 us | 1,245 us | +20.290% | diagnostic |
| Average render | 160 us | 198 us | +23.750% | diagnostic |
| QuickJS live bytes | 17,893,448 | 18,052,217 | +0.887% | PASS |
| QuickJS peak bytes | 20,362,829 | 20,483,774 | +0.594% | PASS |
| Arena bump high-water | 33,328,800 B | 33,534,992 B | +0.619% | PASS |
| PPSSPP host peak RSS | 102,324 KiB | 102,196 KiB | -0.125% | PASS |
| Host wall time | 188.07 s | 185.55 s | -1.340% | auxiliary only |

The whole-segment gate passes because long QuickJS-heavy battle and journey
frames dominate its average and maximum. Its draw/render components still
show the same roughly 20% increase as the ordinary bench, so the passing
aggregate does not contradict the steady-render failure.

An initial 180-second segment attempt stopped at tape frame 7,216 of 7,666
and was rejected by the terminal verifier. A separate write-protection
diagnostic could not create a new profile. Neither is included in any table;
all four formal legs completed and verified.

## Desktop QuickJS

### Cold startup

Cold startup used 80 new processes: ten alternating ABBA/BAAB windows at each
viewport, or 20 samples per variant and viewport. Raw p95 uses linear
interpolation at `(n - 1) * 0.95`; the paired delta and its deterministic 95%
bootstrap interval use the existing startup harness. All samples met the
existing 250 ms absolute budget.

| Viewport | A median / p95 | B median / p95 | Paired median delta (95% interval) | Raw p95 delta |
| --- | ---: | ---: | ---: | ---: |
| 480x272 | 230.183 / 233.013 ms | 232.953 / 240.890 ms | +0.935% (+0.599%, +2.608%) | **+3.380%** |
| 960x544 | 231.462 / 235.041 ms | 234.598 / 240.187 ms | +1.447% (+0.546%, +2.085%) | +2.190% |

The maintained paired-median interpretation passes at both sizes, but the
task-requested strict per-metric reading marks the 480x272 raw p95 as a narrow
failure. The overall verdict does not depend on that interpretation because
the PSP and production-frame failures are independent.

### Production-frame BCCB

The authoritative quiet run used B-C-C-B order, where B denotes baseline and
C denotes candidate. All eight legs reached state SHA-256
`2ae4650cc8be15cd1f794b9440f79903220bd745f3725af020619490dbd1eba9`.
Each cell is the median of its two same-variant legs.

| Viewport / metric | A | B | Delta | 3% result |
| --- | ---: | ---: | ---: | --- |
| 480x272 QuickJS CPU p50 | 0.823 ms | 0.835 ms | +1.397% | PASS |
| 480x272 QuickJS CPU p95 | 4.081 ms | 4.213 ms | **+3.235%** | **FAIL** |
| 480x272 total p50 | 0.845 ms | 0.864 ms | +2.250% | PASS |
| 480x272 total p95 | 4.191 ms | 4.489 ms | **+7.111%** | **FAIL** |
| 960x544 QuickJS CPU p50 | 0.812 ms | 0.834 ms | +2.711% | PASS |
| 960x544 QuickJS CPU p95 | 6.476 ms | 6.582 ms | +1.637% | PASS |
| 960x544 total p50 | 0.834 ms | 0.863 ms | **+3.479%** | **FAIL** |
| 960x544 total p95 | 6.542 ms | 6.665 ms | +1.880% | PASS |

The renderer-specific counters have a much larger and viewport-scaled shift:

| Diagnostic | A | B | Delta |
| --- | ---: | ---: | ---: |
| 480x272 draw total | 95.173 ms | 133.445 ms | +40.214% |
| 480x272 traced objects | 120,000 | 124,527 | +3.773% |
| 480x272 QuickJS used / malloc | 22.79 / 28.79 MiB | 23.33 / 29.49 MiB | +2.37% / +2.43% |
| 960x544 draw total | 110.226 ms | 196.979 ms | +78.705% |
| 960x544 traced objects | 133,225 | 145,067 | +8.889% |
| 960x544 QuickJS used / malloc | 24.47 / 31.47 MiB | 25.86 / 33.27 MiB | +5.66% / +5.72% |

An exploratory run under higher host load was discarded. The table and
receipt contain only the final quiet rerun, which also added the required p50
output without changing the measured execution path.

## Mobile Web gate

`bun run bench:web:mobile --gate` ran the maintained city-walk cell for three
alternating ABBA/BAAB windows (12 legs, six per variant), using Chrome
138.0.7204.92, an 844x390 CSS viewport at DPR 3, 6x CPU throttling, a 3-second
warmup, and a 15-second sample. The harness spells the equivalent variant
orders BCCB/CBBC because B means baseline and C means candidate.

| Work metric | A | B | Delta |
| --- | ---: | ---: | ---: |
| p50 | 24.900 ms | 25.850 ms | +3.815% |
| p95 | 29.325 ms | 31.450 ms | +7.246% |
| p99 | 32.118 ms | 35.438 ms | +10.335% |
| Frames over 33 ms | 0.60% | 2.63% | +2.02 pp |

The maintained gate evaluates p95. Candidate p95 is below both the 33 ms
absolute limit and the paired-noise limit
`29.325 * 1.08 + 0.5 = 32.171 ms`, so Web is **PASS** with no recorded gate
failure. The high over-16.7 ms share (99.16% candidate) is expected for this
6x-throttled 33 ms-budget cell and is not the gate criterion.

## Attribution and proposed remediation

The evidence converges on the canopy row-node path:

- PSP JS rises only 0.425%, while draw and render rise 20.924% and 16.596%.
  Their 202 us increase accounts for about 89% of the 227 us steady-work
  regression.
- Desktop draw totals rise 40.214% at 480x272 and 78.705% at 960x544. The
  larger viewport also carries 8.889% more traced objects and about 5.7% more
  QuickJS used/malloc memory.
- `vendor/pocket-rpgkit/src/ui/WorldStreamedTerrain.tsx:261-295` creates one
  persistent view per upper row and image slices beneath it. At lines 325-330,
  the horizontal upper-window key uses unquantized camera pixels, so a
  one-pixel camera move invalidates the row sync. Inside the visible-row loop,
  lines 341-368 repeatedly expands `upper.live.entries()`, filters it, sorts
  it, updates row props, and rebinds slices for every row. Cost therefore
  grows with both visible row count and live chunk count. The viewport scaling
  in the BCCB counters is the expected signature of this loop.

No fix was implemented because this task is measurement-only. A follow-up
should:

1. Quantize the upper-window key to tile or chunk boundaries so sub-tile
   camera motion does not resynchronize row bindings.
2. Filter and sort visible upper chunks once per sync, outside the row loop,
   then bucket or index them by covered tile rows.
3. Reduce persistent row/slice nodes by splitting only near actor depth
   boundaries; keep larger upper textures intact where no actor can cross.
4. Suppress unchanged row `style`, `debugName`, and image writes, then rerun
   this exact PSP A-B-B-A, desktop cold/BCCB, and three-window Web matrix.

Only this report and its small JSON receipt are committed. No build output or
product code is included, and all benchmark Chrome, PPSSPP, and build
processes were stopped after measurement.

subagent 使用：3 个 / desktop、PSP、Web 测法只读调研（Web 代理被中断，未产出）/ 是，desktop 与 PSP 的并行核对节省了主线时间

FAIL
