# Opaque-span and repeated-row raster specialization

## Verdict

BLOCKED. The implementation and every correctness gate are complete. A clean
short candidate profile puts all three target scenes below 16.7 ms p95, but
the required 112-sample mobile matrix could not start in an uncontaminated
host window. The mandated downstream QuickJS, PSP, and Wander timings
therefore could not start either. The short profile is not promoted to an
acceptance result, and the contaminated partial run is not reused.

## Revisions and integration

| Repository | Opening base | Delivery branch / revision |
| --- | --- | --- |
| PocketJS fork | `8de08a89` (`rpgkit-base-sync`) | `perf/raster-opaque-spans` / `7c9d1a10` |
| Pocket RPG Kit | `e7297893` | `perf/raster-opaque-spans-kit` / `5400441b` |
| Pocket Tuxemon | `180c2ce2` | `perf/raster-opaque-spans-game` / `b71f38c7` plus this report |

PocketJS contains two new reviewable commits. `1122fc00` adds the
target/format specializations, opaque spans, repeated-row copies, and
differential coverage; `7c9d1a10` classifies whole-texture alpha when texture
bytes change. The kit and game revisions only advance their nested submodule
pointers and update the feature status. `bun.lock` is unchanged in all three
repositories.

Upstream does not yet contain the preceding nearest/identity fast path. The
complete three-commit series -- prerequisite `d2485a0f`, then this change's
`1122fc00` and `7c9d1a10` -- cherry-picks without conflict or follow-up edits
onto upstream `main@3d098376` as `09fbcee7`, `0b75b2b9`, and `113e8c84`.
The upstream worktree passes the relevant Rust tests, so the series is
self-contained and can be submitted directly upstream.

## Measured raster distribution before implementation

A diagnostic-only build at the opening baseline counted the nearest-neighbour,
identity-modulated textured quads in one ten-second landscape 4x run of each
target scene. Chrome 138 used the production scene content. The counters were
removed from the delivery branch; they inform the choice below but add no
shipping per-frame work.

| Scene | Quads | Destination pixels | T8 / RGBA8888 pixels | Opaque / clear / intermediate pixels | Scale | Adjacent columns repeat | Adjacent rows repeat |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| city-walk | 19,223 | 484,188,416 | 98.33% / 1.67% | 49.68% / 50.32% / 0 | 2x: 100% | 50.18% | 50.00% |
| wild-encounter | 4,586 | 135,864,412 | 99.37% / 0.63% | 56.29% / 43.71% / 368 pixels | 2x: 100% | 60.48% | 60.25% |
| battle-turn | 3,111 | 76,695,820 | 100% / 0% | 73.60% / 26.40% / 0 | 2x: 100% | 75.22% | 74.92% |

No measured destination pixel used PSM 5650 or PSM 4444. All 368
intermediate-alpha encounter pixels are only 0.00027% of that scene's sampled
pixels; the dominant T8 traffic is binary-alpha. Whole-quad alpha classes are
less skewed because an atlas containing both clear and opaque entries is
conservatively Mixed: opaque / clear / mixed quads are 32.20% / 33.92% /
33.88% for walking, 35.54% / 15.00% / 49.45% for encounters, and 32.11% /
13.24% / 54.64% for battles.

The width and height buckets below are percentages of quads. Their buckets are
`<=4`, `5-8`, `9-16`, `17-32`, `33-64`, and `>64` destination pixels. Area
uses `<=64`, `65-256`, `257-1024`, `1025-4096`, `4097-16384`, and `>16384`.

| Scene | Width buckets | Height buckets | Area buckets | Maximum W / H / area |
| --- | --- | --- | --- | ---: |
| city-walk | 0.46 / 0.63 / 1.12 / 37.86 / 2.40 / 57.52% | 0 / 0 / 0 / 60.68 / 11.00 / 28.32% | 0 / 0.72 / 33.90 / 8.77 / 27.61 / 29.00% | 512 / 448 / 163,840 |
| wild-encounter | 0.04 / 0 / 0.13 / 25.32 / 8.20 / 66.31% | 0.37 / 0.39 / 2.77 / 42.11 / 9.49 / 44.88% | 0 / 0.37 / 21.74 / 12.15 / 24.90 / 40.84% | 960 / 512 / 491,520 |
| battle-turn | 0.19 / 0.19 / 0.26 / 14.21 / 11.48 / 73.67% | 0 / 0 / 8.20 / 46.35 / 10.61 / 34.84% | 0.19 / 0.45 / 15.11 / 27.16 / 20.83 / 36.26% | 960 / 512 / 491,520 |

This distribution selects the bounded optimizations in the specification:
static target/format dispatch, opaque repeated-texel spans, and opaque
repeated-source-row copies. It does not justify a new retained-framebuffer or
scene contract.

## Implementation

The old `tex_quad_impl::<_, false>` path remains the production fallback and
the byte-for-byte test oracle. The optimized path remains restricted to
nearest filtering with identity modulation.

- Target type and PSM 5650/8888/4444/T8 sampling are statically specialized
  outside the destination-pixel loops. The generic sampler calls are
  monomorphized; there is no closure or trait-object dispatch in those loops.
- Each destination column keeps the original pixel-centre floating expression,
  so clipping and UV edge behavior are unchanged. Equal adjacent source `tx`
  values become one exact `fill_opaque` span only when the sampled alpha is
  255. Intermediate alpha still executes the original integer source-over
  blend for every destination pixel, and alpha zero still writes nothing.
- If the next destination row maps to the preceding source row, an
  all-opaque texture copies the complete already-rendered row. A mixed texture
  copies only maximal sections whose remembered alpha class is opaque;
  intermediate sections are resampled and blended, and clear sections remain
  untouched. This is valid for clipped and non-scale-aligned edges as well as
  integer scaling.
- Whole-texture Transparent/Mixed/Opaque metadata is computed on upload and
  in-place T8 update. PSM 5650 is inherently opaque. Transparent textures can
  skip the draw, opaque textures avoid per-pixel alpha classification, and
  internally generated linear textures are conservatively Mixed. Projects
  that do not draw the fast-path shape pay no per-frame classification cost.
- RGBA, ARGB, premultiplied RGBA, full RGB565, and compact RGB565-window
  targets each implement the same bounded opaque fill and in-buffer copy
  operation. The hot path remains stack-backed and allocation-free.

No draw-list, damage, host, game-state, scene, or save contract changed.

## Pixel parity and mutation strength

The existing randomized oracle continues to cover 384 instructions per scale
at 1x, 2x, and 3x across PSM 5650/8888/4444/T8, nearest and linear filtering,
identity and non-identity modulation, transparent/intermediate/opaque alpha,
negative coordinates, clipping, UV reversal and overrun, zero extents, and
randomized initial framebuffers. New focused coverage forces every format
specialization, clipped repeated-column spans, repeated-source-row copies,
whole-texture transparent/opaque transitions, and all five target layouts.

Three isolated mutations prove the added tests distinguish the intended
behavior:

| Mutation | Result |
| --- | --- |
| Extend an opaque repeated-texel span by one destination pixel | Differential fixture fails on the first corrupted framebuffer |
| Copy a repeated row section whose alpha is intermediate | Differential fixture fails because source-over depends on the existing destination row |
| Decode the specialized PSM 5650 channel from the wrong bit field | Format-specialization differential fixture fails |

The mutations ran only in isolated worktrees and are absent from every
delivery revision.

PocketJS's relevant core, Wasm, RGB565 and backend tests pass, and all 54 pixel
goldens are unchanged. Fresh 480x272 and 960x544 frames plus the three 3x
city/battle captures were opened and inspected: terrain and sprite edges stay
crisp, occlusion is intact, and translucent battle HUD/text layers remain
complete. Their semantic pixel assertions pass as well.

## Correctness and consumer gates

No accepted suite has a skipped test.

| Scope | Result |
| --- | --- |
| PocketJS | Relevant core, Wasm, RGB565, UI C ABI and backend suites pass; 54 goldens unchanged |
| Upstream cherry-pick | The complete three-commit series applies cleanly and the relevant upstream tests pass |
| Pocket RPG Kit | Typecheck passes; 4,624 pass, 0 fail, 0 skip across the CI partitions |
| Pocket RPG Kit QuickJS drift guard | Single and cumulative comparisons pass all eight cases; 0 regressions, 0 inconclusive, 0 errors |
| Pocket Tuxemon | Ten CI test partitions, typecheck, build, all 16 journey commands, Web/Chrome, chunks, language, link, PWA, PSP package and PSP save gates pass |

The single-change QuickJS guard's largest positive median is
`sunstoneIdle +0.533243%`; every other median is no larger. All cumulative
medians are non-positive. Both runs finish with
`verdict=pass regressions=0 inconclusive=0 errors=0`.

Two isolated imports produce 5,077 files and 69,622,876 bytes with identical
SHA-256 `6c262abb4bf2e9fa856d40c3990b74f9e25986d117b3e0bf98af7a551788d7e0`.
The maintained mainline still reaches `spyder_datacenter@7,4` after 230,322
frames with state SHA-256
`1977c1b0f3bd1bba2c4e5ad82332599c4fc72f0acd84d9437868976fbfb5c736`;
all 242 boot-world checkpoints pass. The PSP save verifier reports
`ALL PHASES PASS`.

## Formal mobile matrix

No formal receipt was accepted. The unchanged matrix requires 112 samples --
seven scenes, two viewports, two throttles, and four BCCB legs -- at 60 seconds
per sample after warm-up. Its minimum measured time alone is 112 minutes.

An initial formal run was excluded after an independently started 12-worker
CPU job raised host load from the clean single digits above 50 during its
third cell. The trailing baseline leg rose from 19.4 to 38.6 ms p95 and
recorded 21 long tasks, so its partial samples are contamination evidence, not
a performance result.

A dedicated guard then required four consecutive 30-second checks below load
6 with no compiler, browser, emulator, benchmark, test, replay, or ranked
worker. From 04:14 through 06:07 PDT it never recorded one clean check.
Short-lived test and replay work finished, but five continuous ranked
controllers remained and were later restarted by their owner-side supervisor;
they were not stopped, frozen, reprioritized, or repinned without owner
authorization. By then the remaining execution budget was shorter than the
matrix itself. `mobile-web-full.json` was never created, so there is no result
to select and no pass/fail performance claim to make.

## Candidate profile and remaining cost

Before the formal matrix, a clean candidate-only ten-second landscape 4x
profile measured:

| Scene | p50 / p95 / p99 (ms) | Dominant optimized quad self time | Other remaining raster self time |
| --- | ---: | ---: | ---: |
| city-walk | 13.300 / 15.700 / 18.675 | 7,538.865 ms | `fill_rect` 526.169 ms |
| wild-encounter | 2.100 / 12.730 / 17.164 | 715.679 ms | general clipped 349.975; `fill_rect` 221.244; blend 96.555 ms |
| battle-turn | 1.400 / 5.465 / 11.339 | 334.253 ms | general clipped 262.009; `fill_rect` 154.695; blend 79.207 ms |

These candidate-only numbers are encouraging -- all three p95 values are
below 16.7 ms -- but their ten-second, one-viewport shape is deliberately not
the acceptance matrix. The optimized quad remains walking's dominant raster
entry; encounter and battle next expose the general clipped renderer,
`fill_rect`, and residual blend in that order.

The immediate next step is operational rather than another code change:
reserve a clean host window and run the already-frozen 112-sample BCCB matrix
once. If a target cell still misses, profile that exact cell before choosing
between the general clipped path and `fill_rect`; the current data does not
justify another speculative raster branch.

## Desktop QuickJS, PSP, and Wander

The frozen baseline/candidate desktop packages, 80-process QuickJS driver,
four isolated PSP memory-stick packages, and five-window Wander Web driver are
prepared. Wander's 20 non-Wasm payloads are byte-identical and its candidate
consumer gates pass 523 tests with zero failures plus typechecking.

The specification requires formal mobile to finish before any of these timing
runs. Because mobile never started, no desktop QuickJS, PSP A-B-B-A, or Wander
performance number is reported. Existing package, save, payload-equivalence,
and consumer-test results remain correctness evidence only.

subagent 使用：3 个 / 各自做只读源码、测试与门禁审查 / 是，节省了主线核对时间

BLOCKED
