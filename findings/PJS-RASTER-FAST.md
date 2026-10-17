# Software raster textured-quad fast path

## Verdict

The raster change is pixel-compatible and mergeable: every correctness gate
passed, the maintained mainline terminal stayed unchanged, and the three
expensive mobile scenes improved by 46.1–59.1% at p95. It does not, however,
meet the complete mobile acceptance target. The candidate passes 22 of 28
cells; all six failures are the 4x city-walk, wild-encounter, and battle-turn
cells at 17.95–20.80 ms p95 versus the 16.7 ms target. The formal verdict is
therefore **FAIL**, without hiding the useful improvement behind the verdict.

## Revisions and integration

| Repository | Base | Delivery branch / integration revision |
| --- | --- | --- |
| PocketJS fork | `5a1c8b05` (`rpgkit-base-sync`) | `rpgkit-base-sync` / `8de08a89` |
| Pocket RPG Kit | `cbe136d9` | `main` / `dd8a4d27` |
| Pocket Tuxemon | `a9e73b98` | `main` / source integration `640864a9` plus this report |

PocketJS has two independent commits: `d2485a0f` implements and tests the
raster fast path; `8de08a89` adds the right/bottom dirty-upload boundary test.
The kit and game commits only advance their nested submodule and mark the
implemented feature Done in `docs/status.md`. `bun.lock` is unchanged in all
three repositories.

The raster commit cherry-picks cleanly onto upstream `main@3d098376` as
`0f59747a` with no conflict or follow-up edit, so it can be submitted directly
upstream. The dirty-edge test intentionally remains a second commit because
upstream does not yet contain the fork's dirty-upload implementation on which
that test depends.

After the measurements, fetching `origin/main` still resolved to `a9e73b98`;
the game branch was already based on it, so no rebase was required.

## Baseline profiling before implementation

The baseline is Pocket Tuxemon `a9e73b98`, Pocket RPG Kit `cbe136d9`, and the
PocketJS fork sync revision `5a1c8b05`. Chrome 138 captured one 15-second
landscape sample at DPR 3 for each scene under 4x and 6x CPU throttling. The
normal release Wasm supplied frame timings. A second local-only Wasm build
marked `tex_quad`, `glyph_run`, and the RGBA target's `blend` as non-inline so
Chrome could attribute their self time; those attributes were removed before
product changes began. The non-inline build is used only for attribution, not
as a timing baseline.

| Scene | 4x p50 / p95 / p99 (ms) | 6x p50 / p95 / p99 (ms) |
| --- | ---: | ---: |
| Cotton Town walk | 36.850 / 43.600 / 45.585 | 55.900 / 67.760 / 70.360 |
| Wild encounter | 3.600 / 35.210 / 40.000 | 6.500 / 59.260 / 76.680 |
| Battle turn | 1.700 / 12.850 / 36.300 | 2.400 / 18.600 / 57.998 |

The short profile does not replace the formal 60-second BCCB matrix. In
particular, battle's sparse expensive frames can fall above or below the p95
boundary in a single 15-second run.

### Raster attribution

Times below are aggregate Wasm self milliseconds during each 15-second
non-inline diagnostic sample. `tex_quad` excludes time attributed to its
separate `texel` and `blend` callees.

| Scene / CPU | `tex_quad` | `texel` | RGBA `blend` | `fill_rect` | `glyph_run` |
| --- | ---: | ---: | ---: | ---: | ---: |
| Walk 4x | 5,452.865 | 4,179.633 | 1,311.554 | 211.280 | below top ten |
| Walk 6x | 5,297.116 | 4,222.712 | 1,289.691 | 200.528 | below top ten |
| Encounter 4x | 1,830.735 | 1,360.055 | 568.114 | 197.824 | 174.844 |
| Encounter 6x | 2,586.057 | 2,112.724 | 796.484 | 294.674 | 212.868 |
| Battle 4x | 1,348.458 | 962.626 | 403.955 | 158.465 | 101.176 |
| Battle 6x | 1,886.384 | 1,403.598 | 534.126 | 225.285 | 172.613 |

The normal optimized profile tells the same story without the diagnostic call
overhead: for walk at 4x, `render_scaled_clipped` and `texel` account for
6,585.966 ms and 5,155.777 ms of self time, while `fill_rect` accounts for
247.219 ms. At 6x the corresponding values are 6,362.668 ms, 4,730.642 ms,
and 246.714 ms. Optimizing glyph or flat-fill rasterization first would not
address the measured dominant cost.

### Damage shape and retained-framebuffer decision

A temporary browser probe wrapped the production presenter and measured the
exact union of the half-open damage rectangles in physical pixels. It was
removed after capture.

| Scene / CPU | Full-surface frames | Damage ratio p50 / p95 | Dirty / idle frames |
| --- | ---: | ---: | ---: |
| Walk 4x | 392 / 393 (99.75%) | 1.000000 / 1.000000 | 1 / 0 |
| Walk 6x | 246 / 248 (99.19%) | 1.000000 / 1.000000 | 2 / 0 |
| Encounter 4x | 75 / 801 (9.36%) | 0.053355 / 1.000000 | 726 / 0 |
| Encounter 6x | 79 / 680 (11.62%) | 0.055319 / 1.000000 | 601 / 0 |
| Battle 4x | 40 / 850 (4.71%) | 0.013848 / 0.230858 | 598 / 212 |
| Battle 6x | 40 / 791 (5.06%) | 0.013848 / 0.639675 | 548 / 203 |

The p95 tails coincide with full-surface or large damage, so the common
textured-quad loop is relevant to all three scenes. Camera-scroll framebuffer
translation is not included. The generic DrawList and damage plan do not
expose a camera delta or distinguish scrollable world pixels from fixed
overlays, particles, translucent layers, and animations. Inferring a
translation from successive composite command streams would add a retained
scene contract and a much larger parity surface to an otherwise local raster
patch. The explicit cost is that walking still rasterizes the full surface.

## Implementation

The fast path is entered only for nearest-neighbour textures with identity
modulation. It retains the old implementation as `tex_quad_impl::<_, false>`
for the test oracle and as the production path for linear sampling,
non-identity modulation, unsupported formats, zero-sized textures, and custom
viewports wider than the fixed stack column buffer.

- `RenderTarget::write_opaque` writes the exact bytes that the old
  `blend(..., 255)` path produced for RGBA, ARGB, premultiplied RGBA, RGB565,
  and compact RGB565 windows.
- The PSM 5650, 8888, 4444, and T8 format dispatch is outside the destination
  pixel loops. PSM 5650 uses an all-opaque loop; the alpha-bearing formats
  skip alpha zero, direct-write alpha 255, and retain integer src-over for
  intermediate alpha.
- Every destination column's `tx` is computed once per quad. The code keeps
  the reference pixel-centre floating expression and operation order for each
  column; there is no accumulated fixed- or floating-point step.
- The column buffer is stack-backed and only its initialized prefix is read,
  so the hot path performs no heap allocation. Wider custom viewports take the
  old general path.

No scene, event, host, damage, or save contract changed.

## Pixel parity and mutation strength

The randomized differential test executes 384 textured-quad instructions at
each scale 1, 2, and 3. It mixes PSM 5650/8888/4444/T8, nearest and linear
textures, identity and non-identity modulation, transparent/intermediate/
opaque alpha, negative and off-screen coordinates, edge clips, reversed and
out-of-range UVs, zero extents, and randomized existing framebuffers. Each
instruction compares the fast implementation with the retained reference
implementation for RGBA, ARGB, premultiplied RGBA, full RGB565, and compact
RGB565-window targets.

The Web test additionally moves a non-full rectangle exactly onto the physical
right and bottom canvas boundaries, requires a changed final pixel, checks its
RGBA value, requires the seven-argument dirty `putImageData` overload, and
compares the whole canvas with the full-upload oracle.

Four isolated mutations demonstrated that the tests fail for the intended
reasons:

| Mutation | Result |
| --- | --- |
| Fast-path column mapping uses `tx + 1` | randomized oracle exits 101 at RGBA scale 1, instruction 16 |
| Intermediate-alpha texels use opaque direct write | randomized oracle exits 101 at instruction 30 |
| Dirty upload clamps the half-open edge to `width - 1` / `height - 1` | Web dirty test: 0 pass, 1 fail |
| PSM 4444 alpha is read from the blue nibble | randomized oracle exits 101 at instruction 60 |

The mutations ran only in isolated copies; none is present in a delivery
branch.

## Correctness and consumer gates

All reported pass counts are from the final candidate revisions. No suite was
accepted with a skipped test.

| Scope | Result |
| --- | --- |
| PocketJS core | 204 pass, 0 fail |
| PocketJS Wasm | 4 pass, 0 fail |
| RGB565 unit / strip parity | 20 + 7 pass |
| Web dirty presentation | 1 pass, 0 fail, 25 expectations |
| PocketJS pixel goldens | 54 pass, 0 fail; goldens unchanged |
| GPUI | `cargo check` passes; the host test binary reaches final link, where this machine lacks `-lxkbcommon` and `-lxkbcommon-x11` |
| Pocket RPG Kit | 4,620 pass, 0 fail, 0 skip across 304 files; typecheck passes |
| Pocket Tuxemon | 2,022 pass, 0 fail, 0 skip across the ten CI test partitions; typecheck passes |
| Wander consumer | build, typecheck, Web build, and 523 pass, 0 fail, 0 skip |

Both the single-commit and cumulative component QuickJS drift guards pass all
eight cases with `failed_cases=0 inconclusive_cases=0 errors=0`. In the
single comparison, the largest positive median is `battleScene` at +1.210%,
below the 3% limit; idle and walking cases remain between -0.705% and +0.199%.

The game gate reproduced every current CI job command, including the ten test
partitions, all maintained journey entries, all Web/Chrome entries, and the
PSP release package. The extra acceptance commands
`verify:web:chunks`, `verify:web:lang`, `verify:web:link`, `verify:web:pwa`,
and `verify:psp:save` also pass. The PSP save verifier reports
`ALL PHASES PASS`.

Two isolated imports produce 5,077 files and 69,622,876 bytes with SHA-256
`6c262abb4bf2e9fa856d40c3990b74f9e25986d117b3e0bf98af7a551788d7e0`.
The maintained campaign still terminates after 230,322 frames at
`spyder_datacenter@7,4` with state SHA-256
`1977c1b0f3bd1bba2c4e5ad82332599c4fc72f0acd84d9437868976fbfb5c736`.

The freshly rendered 3x Paper Town and battle-menu frames were also opened and
inspected, not merely hash-compared: terrain/sprite edges remain crisp, object
occlusion is intact, and the translucent battle HUD/text layers are visually
complete. Their semantic pixel assertions and pinned goldens also pass.

## Formal mobile matrix

The formal receipt contains 28 cells and 112 timed samples: seven scenes,
portrait 390×844 and landscape 844×390, DPR 3, Chrome 138, CPU 4x and 6x,
60 seconds per sample after a 3-second warm-up, with baseline/candidate legs
interleaved. The frozen baseline and candidate sites have identical JS, pak,
and project shell; their Wasm SHA-256 values are respectively
`9ce092fe46f3ba00999e1c6ef20efac3ba15a3a481d5f9b45c582b32575504ed`
and `76d13f2cd26f9a1fb75329e44501b6fb5dbb6d6dd649775bfc858d71f88b9270`.

Each timing cell below is work p50 / p95 / p99 in milliseconds. The gate is
4x p95 ≤16.7 ms or 6x p95 ≤33 ms, while also respecting the paired regression
limit.

| Scene | View | CPU | Baseline p50 / p95 / p99 | Candidate p50 / p95 / p99 | Gate |
| --- | --- | ---: | ---: | ---: | --- |
| city-walk | portrait | 4x | 35.600 / 43.915 / 45.950 | 15.750 / 18.150 / 19.450 | FAIL |
| city-walk | portrait | 6x | 55.000 / 67.435 / 70.959 | 24.850 / 28.850 / 31.621 | PASS |
| city-walk | landscape | 4x | 36.000 / 43.900 / 45.788 | 15.450 / 17.950 / 19.250 | FAIL |
| city-walk | landscape | 6x | 56.450 / 68.650 / 71.807 | 24.450 / 28.700 / 31.100 | PASS |
| map-switch | portrait | 4x | 1.650 / 4.592 / 14.438 | 1.375 / 3.900 / 15.062 | PASS |
| map-switch | portrait | 6x | 2.250 / 6.477 / 27.222 | 1.900 / 5.800 / 22.848 | PASS |
| map-switch | landscape | 4x | 1.400 / 4.250 / 14.646 | 1.250 / 3.750 / 14.655 | PASS |
| map-switch | landscape | 6x | 2.300 / 6.550 / 26.761 | 2.150 / 5.900 / 23.271 | PASS |
| wild-encounter | portrait | 4x | 2.200 / 40.340 / 56.916 | 2.200 / 20.600 / 24.650 | FAIL |
| wild-encounter | portrait | 6x | 3.450 / 66.270 / 89.166 | 2.950 / 31.650 / 39.450 | PASS |
| wild-encounter | landscape | 4x | 2.150 / 40.285 / 56.597 | 2.150 / 20.800 / 24.821 | FAIL |
| wild-encounter | landscape | 6x | 3.200 / 72.113 / 95.690 | 2.950 / 31.155 / 38.050 | PASS |
| battle-turn | portrait | 4x | 1.150 / 34.790 / 58.535 | 1.225 / 18.550 / 24.635 | FAIL |
| battle-turn | portrait | 6x | 1.650 / 51.737 / 91.024 | 1.900 / 27.907 / 39.726 | PASS |
| battle-turn | landscape | 4x | 1.150 / 35.450 / 58.552 | 1.200 / 18.450 / 24.382 | FAIL |
| battle-turn | landscape | 6x | 1.400 / 52.485 / 92.484 | 1.750 / 27.475 / 38.765 | PASS |
| menus | portrait | 4x | 0.550 / 1.150 / 1.600 | 0.550 / 1.150 / 1.500 | PASS |
| menus | portrait | 6x | 0.650 / 1.700 / 2.417 | 0.600 / 1.750 / 2.628 | PASS |
| menus | landscape | 4x | 0.450 / 1.200 / 1.600 | 0.450 / 1.100 / 1.600 | PASS |
| menus | landscape | 6x | 0.500 / 1.600 / 2.350 | 0.450 / 1.550 / 2.200 | PASS |
| dialogue | portrait | 4x | 0.700 / 3.250 / 33.281 | 0.750 / 3.000 / 16.252 | PASS |
| dialogue | portrait | 6x | 1.000 / 4.950 / 49.632 | 1.100 / 4.400 / 24.400 | PASS |
| dialogue | landscape | 4x | 0.850 / 3.565 / 33.417 | 0.750 / 3.050 / 16.300 | PASS |
| dialogue | landscape | 6x | 1.100 / 5.250 / 53.870 | 1.000 / 4.150 / 24.325 | PASS |
| web-link | portrait | 4x | 0.200 / 0.900 / 1.150 | 0.200 / 0.900 / 1.100 | PASS |
| web-link | portrait | 6x | 0.200 / 1.300 / 1.800 | 0.200 / 1.300 / 1.800 | PASS |
| web-link | landscape | 4x | 0.200 / 0.900 / 1.150 | 0.200 / 0.900 / 1.200 | PASS |
| web-link | landscape | 6x | 0.200 / 1.350 / 1.771 | 0.200 / 1.300 / 1.809 | PASS |

All 28 cells remain below their paired regression limits. The twelve heavy
cells improve as follows at p95:

| Scene | Portrait 4x / 6x | Landscape 4x / 6x |
| --- | ---: | ---: |
| city-walk | -58.7% / -57.2% | -59.1% / -58.2% |
| wild-encounter | -48.9% / -52.2% | -48.4% / -56.8% |
| battle-turn | -46.7% / -46.1% | -48.0% / -47.7% |

## Remaining 4x cost and next step

Candidate-only 15-second CPU profiles show that upload is not the remaining
limit. The table reports aggregate 4x self time in milliseconds; the three
Wasm columns are the largest raster entries and the upload column is the
browser's `putImageData`.

| Scene | nearest/identity quad | general clipped render | `fill_rect` | residual `blend` | upload |
| --- | ---: | ---: | ---: | ---: | ---: |
| city-walk | 9,149.8 | 534.7 | 541.3 | below top ten | 752.9 |
| wild-encounter | 1,495.6 | 385.1 | 231.5 | 122.3 | 159.0 |
| battle-turn | 952.4 | 292.3 | 158.0 | 78.3 | 102.6 |

The new loop is still the dominant self-time entry, while upload is small.
The next bounded raster investigation should record format, alpha class, and
adjacent-column run distributions, then test two parity-preserving options:
specialize the target/format loops far enough to remove closure/trait overhead,
and coalesce repeated nearest-neighbour opaque columns into exact
`fill_opaque` spans. The retained old loop should remain the differential
oracle. Framebuffer scroll reuse is still rejected for the scene-contract
reason above.

## Desktop QuickJS, PSP, and Wander

The production desktop QuickJS comparison used newly built baseline and
candidate packages whose JS, pak, and project-shell hashes match. Cold startup
used 80 fresh processes; production frame timing used BCCB legs, and all eight
legs ended in state SHA-256
`2ae4650cc8be15cd1f794b9440f79903220bd745f3725af020619490dbd1eba9`.

| Metric | Baseline | Candidate | Delta |
| --- | ---: | ---: | ---: |
| Cold median, 480×272 | 231.769 ms | 233.193 ms | +0.614% raw; -0.103% paired-window |
| Cold median, 960×544 | 231.661 ms | 231.376 ms | -0.123% raw; -0.560% paired-window |
| Frame CPU p95, 480×272 | 4.084 ms | 4.060 ms | -0.588% |
| Frame CPU p95, 960×544 | 6.586 ms | 6.521 ms | -0.995% |

Candidate average maximum frame CPU is 26.473 ms at 480×272 and 26.661 ms at
960×544, both below the 50 ms guard.

For PSP, baseline and candidate `--bench` packages have byte-identical JS,
startup pak, external assets pak, and native package; only the PRX differs.
Four isolated-memory-stick PPSSPP software-renderer runs used A–B–B–A order.
Both baseline legs report `6,351,421 µs` boot-to-frame-0 and both candidate
legs report `6,368,689 µs`: +17.268 ms or +0.272%, a non-regression. The
separate release build and save verifier also pass.

Wander Web used five ABBA/BAAB windows (20 fresh Chrome profiles), 960×544,
CPU 4x, and 2.5 seconds of live auto-walk per leg. JS and pak hashes match;
only Wasm differs.

| Wander Web metric | Baseline | Candidate | Delta |
| --- | ---: | ---: | ---: |
| Startup median | 624.2 ms | 585.7 ms | -6.17% raw; -6.37% paired-window |
| Frame work p95 | 32.9 ms | 18.9 ms | -42.55% |
| rAF interval p95 | 33.3 ms | 16.8 ms | -49.55% |

subagent 使用：3 个 / Ohm 核对基准与门禁，Bohr 核对 dirty-edge 与变异，Dirac 核对光栅实现与像素一致性 / 是，只读并行核对节省了主线审查时间

FAIL
