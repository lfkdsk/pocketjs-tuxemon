# Software raster textured-quad fast path

## Verdict

Work is in progress. The unmodified baseline misses the mobile target in the
three maintained changing-frame scenes. Profiling identifies nearest-neighbour
textured quads, their per-pixel format decode, and blend dispatch as the
dominant shared cost. The implementation therefore targets that loop without
changing sampling coordinates, DrawList semantics, or the host damage API.

## Revisions and baseline method

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
boundary in a single 15-second run; the maintained baseline matrix still has
34.065 ms at 4x and 50.410 ms at 6x for the landscape battle cell.

## Raster attribution before implementation

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

## Damage shape and retained-framebuffer decision

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
translation is not included in this patch. The generic DrawList and damage
plan do not expose a camera delta or distinguish scrollable world pixels from
fixed overlays, particles, translucent layers, and animations. Inferring a
translation from successive composite command streams would add a new retained
scene contract and a large pixel-parity surface to an otherwise local raster
patch. The cost of this decision is explicit: walking continues to rasterize
the full surface, and the final matrix will show whether the inner-loop change
alone is enough.

## Planned fast path

The fast path will require nearest-neighbour sampling and identity modulation.
It will preserve the existing pixel-center floating-point formula exactly,
calculate each destination column's `tx` once per quad, dispatch texture format
outside the pixel loop, skip zero-alpha texels, and use an opaque target write
that is byte-identical to existing `blend`. Linear sampling and non-identity
modulation will keep the reference loop. A test-only copy of the old loop will
serve as an independent randomized oracle across formats, clips, coordinates,
scales, modulation, alpha, and pre-existing destination pixels.

FAIL
