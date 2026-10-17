# Web dirty-region presentation

## Verdict

PocketJS now carries its incremental raster damage plan through an additive
Wasm ABI, and both the generic PocketJS Web host and Pocket RPG Kit's production
player retain one `ImageData` and copy/upload only the changed rectangles. The
full-frame mode remains available as a parity oracle. Pixel equality, fallback
behavior, isolated mutations, all three repositories' functional gates, the
Wander consumer and the desktop no-change check pass.

The mobile result is materially better for mostly static scenes, but it does
not meet the complete performance acceptance target. Sixteen of 28 cells pass.
All map-switch, menu, dialogue and Web Link cells meet their absolute p95
budgets; all twelve city-walk, wild-encounter and battle-turn cells still miss
them. City-walk portrait at 4× is also the sole paired-noise regression. The
implementation is correct and useful, but the requested mobile target is not
fully achieved, so the final verdict is **FAIL**.

## Delivery revisions

| Repository | Branch and revision | Base | Delivery |
| --- | --- | --- | --- |
| PocketJS | fork `rpgkit-base-sync` at `5a1c8b054e94ab82db4bd7d8e716e30d23a2401b` | fork `rpgkit-base-sync` at `f1bbfb47fd07853df4bb8eb9222f01a5c3973f4d` | One independent Web/Wasm commit |
| Pocket RPG Kit | `main` at `cbe136d9e75925a233c290e87543718107e7c5be` | G27 component `0a031abbd28fc0bf640a6f39b524a2889bf4051b` | Production player integration, test, status, and PocketJS gitlink |
| Pocket Tuxemon | `main`; implementation commit `155c5a0f` plus this report | rebased on `origin/main` `4d69b549` | Component gitlink and public status/report |

The integration order is PocketJS, Pocket RPG Kit, then Pocket Tuxemon. The
game rebase skipped the equivalent G27 commits already present upstream and
resolved only the status/PWA documentation overlap. There is no merge commit,
and `bun.lock` is unchanged in every repository.

## Actual presentation path

Tuxemon and the Wander example do not present through PocketJS's standalone
`hosts/web/engine.js`. Their generated page boots Pocket RPG Kit's
`tools/web/player.js`, which imports the shared PocketJS presenter at line 51.
The production call chain is:

1. `Player.paint()` requests the retained framebuffer through
   `renderScaledIncremental(density)` and immediately obtains the matching
   `damageRects(density)` (`tools/web/player.js:1623`).
2. The player forwards both views to the shared presenter without making a
   host-level full-frame copy (`tools/web/player.js:1625`).
3. Resize and context restoration reset the retained canvas image and force
   the next complete upload (`tools/web/player.js:1371` and
   `tools/web/player.js:2227`).

The generic PocketJS page was updated as well: its `blit()` follows the same
render/damage/present path (`hosts/web/engine.js:241`), and `?upload=full`
selects the old complete upload for testing and profiling
(`hosts/web/engine.js:35`). This separation matters for upstreaming: the
PocketJS commit is useful without RPG Kit, while the component integration is
what changes the shipped Tuxemon and Wander pages.

The core already had a `DamageTracker` and returned a `DamagePlan` from
`render_scaled_incremental`; the Web Wasm adapter previously discarded that
plan. The patch preserves up to eight logical half-open rectangles in fixed
storage (`engine/wasm/src/lib.rs:54`), records the plan or a safe full-surface
fallback (`engine/wasm/src/lib.rs:728`), and exposes two additive exports:
`ui_damage_rect_count()` and `ui_damage_rects_ptr()`
(`engine/wasm/src/lib.rs:826`). Existing exports and their semantics are
unchanged.

## Presenter design and fallback behavior

- `wasm-ops.js` feature-detects both exports. Old Wasm modules return `null`
  damage and therefore retain full presentation. Its reused `Int32Array` view
  and result object keep the hot path allocation-free
  (`hosts/web/wasm-ops.js:211`).
- `canvas-presenter.js` retains one browser `ImageData`. For each valid dirty
  rectangle it copies only the affected rows and invokes the seven-argument
  `putImageData(image, 0, 0, dx, dy, dw, dh)` overload
  (`hosts/web/canvas-presenter.js:90`). No-change frames copy and upload zero
  bytes.
- First paint, explicit invalidation, resize, restored context, old Wasm,
  malformed metadata, incremental planning failure, and whole-surface damage
  all use the previous three-argument full upload
  (`hosts/web/canvas-presenter.js:40` and line 68).
- The standalone host restores its small top HUD backing band before drawing
  translucent HUD ink on a dirty frame, preventing accumulation
  (`hosts/web/engine.js:35` and line 241).
- A complete 960×544 RGBA upload is 2,088,960 bytes. Dirty frames avoid that
  fixed copy/upload cost; genuine map cuts, fades and whole-screen backgrounds
  still take the explicit full path.

## Pixel equality and mutations

`tests/web-dirty-presentation.test.ts:48` drives two independent real Wasm
instances through the same mutation tape. One instance always performs a full
upload; the other consumes damage rectangles. It compares every canvas byte
after each frame and separately covers a one-row move, color change,
whole-surface promotion, idle frame, context restoration and resize. Separate
instances are required because a compatibility full render intentionally
invalidates one instance's incremental tracker.

The component test calls the real production `Player.paint()` and proves that
the same framebuffer and damage object are forwarded at density 3 without an
intermediate full copy (`tests/web-dirty-upload.test.ts:8`).

Two isolated mutation copies demonstrate that these tests are discriminating:

| Mutation | Observed failure |
| --- | --- |
| Skip the last copied row of every dirty rectangle | Per-frame equality found 48 differing bytes |
| Disable whole-surface full fallback | Full-overload assertion failed: expected `-1`, received `1` |

The mutation work never touched the delivery worktrees. Three retained PWA
frames were also inspected at original resolution: the bedroom, sprite,
dialogue panel, touch controls and gold borders are crisp without stale bands;
the 960×544 offline recovery modal remains fitted and bilingual.

## Mobile measurement method

- Baseline: the G27 branch at game `6d215921` / component `0a031ab`, using its
  complete framebuffer presentation. Candidate: the dirty-region branches
  above. The final game rebase changed no measured presentation code.
- Chrome 138.0.7204.92 was driven over raw CDP at portrait 390×844 and
  landscape 844×390, DPR 3, under 4× and 6× CPU throttling.
- Each cell used a 3,000 ms warmup and a 60,000 ms measurement. One same-window
  BCCB sequence supplied four samples per cell. Seven scenes × two viewports ×
  two throttles produced 28 cells and 112 timed samples.
- The primary `work` duration includes reducer/core work since the prior
  presentation plus Wasm raster, framebuffer copy and canvas presentation for
  that frame. Each semantic scene guard remained active.
- Absolute p95 limits are 16.7 ms at 4× and 33 ms at 6×. The relative guard is
  `candidate p95 <= baseline p95 × 1.08 + 0.5 ms`. A candidate sample requires
  at least 30 presented frames; the observed minimum was 915.

The aggregate receipt is `mobile-matrix.json`; every cell also has its complete
raw BCCB receipt. The first detached portrait/4× battle launch exited before
Chrome started and produced no measurement; `mobile-battle-turn-portrait-4x-rerun.log`
is the authoritative log for that cell.

## Formal mobile matrix

Times are milliseconds. The change column is candidate p95 versus baseline
p95; a negative number is an improvement.

| Scene | Viewport | CPU | Baseline p50 / p95 / p99 | Candidate p50 / p95 / p99 | p95 change | Gate |
| --- | --- | ---: | ---: | ---: | ---: | --- |
| city-walk | portrait | 4× | 36.000 / 44.650 / 47.258 | 39.250 / 60.555 / 100.148 | +35.62% | FAIL |
| city-walk | portrait | 6× | 61.600 / 70.187 / 75.676 | 56.000 / 67.490 / 72.138 | −3.84% | FAIL |
| city-walk | landscape | 4× | 35.400 / 43.900 / 45.763 | 35.850 / 43.750 / 45.821 | −0.34% | FAIL |
| city-walk | landscape | 6× | 55.350 / 68.285 / 72.028 | 57.700 / 68.810 / 72.385 | +0.77% | FAIL |
| map-switch | portrait | 4× | 2.500 / 4.005 / 6.350 | 1.250 / 2.500 / 5.026 | −37.58% | PASS |
| map-switch | portrait | 6× | 4.200 / 6.900 / 12.776 | 1.800 / 3.850 / 11.158 | −44.20% | PASS |
| map-switch | landscape | 4× | 2.450 / 3.850 / 6.062 | 1.400 / 2.550 / 5.329 | −33.77% | PASS |
| map-switch | landscape | 6× | 3.750 / 6.400 / 12.154 | 1.700 / 3.850 / 10.076 | −39.84% | PASS |
| wild-encounter | portrait | 4× | 3.200 / 41.332 / 57.296 | 1.850 / 40.580 / 55.200 | −1.82% | FAIL |
| wild-encounter | portrait | 6× | 5.000 / 66.200 / 85.160 | 2.900 / 65.935 / 85.393 | −0.40% | FAIL |
| wild-encounter | landscape | 4× | 3.350 / 42.165 / 54.258 | 2.000 / 40.680 / 56.502 | −3.52% | FAIL |
| wild-encounter | landscape | 6× | 5.300 / 67.675 / 85.307 | 2.800 / 64.570 / 85.562 | −4.59% | FAIL |
| battle-turn | portrait | 4× | 2.500 / 34.323 / 55.809 | 0.950 / 34.102 / 56.783 | −0.64% | FAIL |
| battle-turn | portrait | 6× | 3.150 / 49.073 / 85.957 | 1.300 / 50.505 / 85.207 | +2.92% | FAIL |
| battle-turn | landscape | 4× | 2.150 / 33.900 / 55.573 | 0.950 / 34.065 / 57.061 | +0.49% | FAIL |
| battle-turn | landscape | 6× | 3.150 / 49.500 / 85.951 | 1.300 / 50.410 / 86.184 | +1.84% | FAIL |
| menus | portrait | 4× | 1.600 / 2.450 / 3.150 | 0.300 / 1.000 / 1.500 | −59.18% | PASS |
| menus | portrait | 6× | 2.450 / 3.750 / 5.039 | 0.450 / 1.500 / 2.350 | −60.00% | PASS |
| menus | landscape | 4× | 1.700 / 2.550 / 3.260 | 0.300 / 1.000 / 1.500 | −60.78% | PASS |
| menus | landscape | 6× | 2.650 / 4.050 / 5.150 | 0.450 / 1.500 / 2.300 | −62.96% | PASS |
| dialogue | portrait | 4× | 1.850 / 4.473 / 32.637 | 0.650 / 3.250 / 33.050 | −27.33% | PASS |
| dialogue | portrait | 6× | 2.800 / 6.970 / 48.900 | 1.000 / 5.050 / 49.282 | −27.55% | PASS |
| dialogue | landscape | 4× | 1.950 / 4.700 / 32.971 | 0.700 / 3.300 / 34.634 | −29.79% | PASS |
| dialogue | landscape | 6× | 2.750 / 6.950 / 48.560 | 1.000 / 4.900 / 49.527 | −29.50% | PASS |
| web-link | portrait | 4× | 1.450 / 2.200 / 2.621 | 0.200 / 0.850 / 1.100 | −61.36% | PASS |
| web-link | portrait | 6× | 2.100 / 3.100 / 3.850 | 0.100 / 1.250 / 1.600 | −59.68% | PASS |
| web-link | landscape | 4× | 1.400 / 2.100 / 2.550 | 0.150 / 0.800 / 1.100 | −61.90% | PASS |
| web-link | landscape | 6× | 2.100 / 3.100 / 3.850 | 0.100 / 1.200 / 1.550 | −61.29% | PASS |

Map switching improves 33.77–44.20%, menus 59.18–62.96%, dialogue
27.33–29.79%, and Web Link 59.68–61.90%. Wild encounters improve only
0.40–4.59% and battle turns range from a 0.64% improvement to a 2.92%
regression, so their p95 tails are no longer explained by the removed fixed
full-frame upload alone. City walking is mixed; the portrait/4× BCCB cell is
the only result outside both the absolute budget and the paired-noise limit.

## Unaffected consumers and host drift

### Wander Web

The Wander consumer used three alternating BCCB/CBBC windows, 3 s warmup and
15 s measurement at landscape DPR 3 / 6×. Both guards pass:

| Metric | Baseline | Candidate | Limit | Result |
| --- | ---: | ---: | ---: | --- |
| Cold median | 910.700 ms | 897.200 ms | 1003.556 ms | PASS |
| Work p50 | 129.300 ms | 129.575 ms | — | — |
| Work p95 | 136.893 ms | 137.713 ms | 148.344 ms | PASS |
| Work p99 | 140.379 ms | 141.338 ms | — | — |

Wander's full consumer suite also passes: 523 tests across 45 files, Web build,
TypeScript and the generated site.

### Desktop and QuickJS

The native host does not use the browser presenter. Baseline and candidate
desktop guest artifacts are byte-identical:

| Artifact | SHA-256 |
| --- | --- |
| `dist/main.js` | `00223f209b9033457531911448885731aa60c9503f39e285ea53eb7db5c71e22` |
| `dist/main.pak` | `e76f1dad3e45308df6efff16229e415bad4b7aeb51ef8d136006747179638b49` |

The pinned same-guest QuickJS cumulative guard used six counterbalanced
windows, twelve pairs per case and a 3% regression limit. Re-analyzing the
retained trace gives:

| Case | Median change | 95% complete-window bootstrap interval | Result |
| --- | ---: | ---: | --- |
| `sunstoneIdle` | −2.143% | [−2.216%, −2.080%] | PASS |
| `sunstoneWalk` | −2.287% | [−2.374%, −2.273%] | PASS |
| `sunstoneControlWalk` | −1.820% | [−2.257%, −1.253%] | PASS |
| `streamedRoam` | −1.044% | [−1.354%, −0.048%] | PASS |
| `battleScene` | −0.794% | [−1.344%, −0.476%] | PASS |
| `sunstoneIdleImmutable` | −1.982% | [−2.183%, −1.533%] | PASS |
| `sunstoneControlWalkImmutable` | −1.506% | [−1.676%, −1.273%] | PASS |
| `battleSceneImmutable` | −4.121% | [−4.274%, −4.061%] | PASS |

## Correctness and release gates

| Area | Result |
| --- | --- |
| PocketJS | The exhaustive staged runner covered all 18 stages; the Model AOT split alone totals 311 pass. The new real-Wasm presentation test passes. |
| Component | 4,620 pass across 304 files, 0 fail, 0 skip after Wasm/example preparation; TypeScript and builds pass. |
| Import determinism | Two imports produce 5,077 files / 69,622,876 bytes and SHA-256 `6c262abb4bf2e9fa856d40c3990b74f9e25986d117b3e0bf98af7a551788d7e0`, with no tracked diff. |
| Game tests | Every CI-equivalent explicit group passes: 2,014 pass, 0 fail, 0 skip. |
| Journey matrix | All 17 CI journey commands pass. The 230,322-frame terminal hash remains `1977c1b0f3bd1bba2c4e5ad82332599c4fc72f0acd84d9437868976fbfb5c736`; built replay checks 242 checkpoints. |
| Web | Link, deployable build, journey, Chinese, demo, Arena, expedition, doubles, audio, chunks and language verification pass. Post-rebase PWA verification passes 41/41 checks and retains nine screenshots. |
| PSP | The complete release build passes. |
| Wander | 523 pass across 45 files, 0 fail; build, TypeScript and Web pass. |
| Final repository checks | Post-rebase `bunx tsc --noEmit` passes; all delivery worktrees are clean after commits; no benchmark or Chrome process remains. |

The PWA verifier used build
`42c5385d429467940a9f7ecf777af2bb33af20043c58201f752bc589bf9aa8a9`
and reported 41 checks passed, 0 failed. The dirty presentation change does not
alter reducer state, tape data, save identity, package contents or native host
behavior.

## Upstream assessment and remaining work

The PocketJS patch is suitable to propose directly upstream. It is a single
small commit on the fork sync base, keeps the old ABI and full-upload behavior,
feature-detects its two additive exports, has a standalone generic-host test,
and has no dependency or lockfile change. The component and game commits are
consumer integration and should not be part of that upstream proposal.

The failed absolute cells need a separate optimization pass. The next useful
work is to profile changing-frame raster cost after full-upload removal,
especially scaled texel rasterization and animated battle/world damage, and to
repeat the city portrait/4× BCCB cell to distinguish its isolated tail from a
stable regression. This report does not claim that follow-up has been accepted
or scheduled.

Subagent usage: 3 / `gate_matrix` inventoried acceptance gates, `test_strategy` independently designed parity and mutation checks, and `trace_dirty_path` traced the shipped runtime call chain / they saved read-only investigation time; all edits, integration, heavy gates and measurements were performed serially by the primary agent.

FAIL
