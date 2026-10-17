# K-CANOPY: row-interleaved canopies in the seamless world

## Outcome

The connected-world renderer now applies the same Tuxemon-compatible
two-pixel-foot rule as the ordinary renderer. Static upper terrain, above
animated cells, the active player and NPCs, neighbouring sandbox previews,
the frozen map just left, followers, vehicles, and their shadow all share one
flat depth plane. The fix also preserves isolated-map rendering, seamless
handoff frames, bounded node residency, and one uploaded texture per resident
upper chunk.

The change was developed against game
`a9e73b982abda660b9e53bbb6683a45f5f0bc4f5` and component
`cbe136d9e75925a233c290e87543718107e7c5be` with PocketJS
`5a1c8b054e94ab82db4bd7d8e716e30d23a2401b`. It was integrated on top of the
textured-quad raster fast path: component `main` carries the four canopy
commits above `dd8a4d27`, and the game points at that component revision with
PocketJS `8de08a89cc2a7848b5561a2241fe879511d50f79`.

## Reproduction and visual evidence

`tools/capture-canopy-parity.ts` boots exactly the same reducer state through
the ordinary and connected-world renderers, waits 180 frames for streamed
assets, captures both logical resolutions, and compares either the whole
frame or a player-centred crop where component camera clamping is necessarily
different. The paired states have the same canonical hash in every case.

Before the fix, all differing pixels were inside the player rectangle:

| Place | Map and cell | 480×272 | 960×544 | Difference bounds |
| --- | --- | ---: | ---: | --- |
| Town | `taba_town` (14, 4) | 46 px | 46 px | 12×5 px |
| Route | `rubberduck_route_01` (27, 11) | 34 px | 34 px | 12×4 px |
| Near a seam | `spyder_flower_city` (38, 4) | 23 px | 23 px | 8×5 px |

The complete machine-readable result is in
`findings/K-CANOPY-screenshots/before/manifest.json`. Its six comparisons all
report `outsidePlayer: 0`. After the fix,
`findings/K-CANOPY-screenshots/after/manifest.json` reports zero differing
pixels for all six pairs. The `comparison-3x.png` files place the ordinary and
seamless crops side by side; I opened all six before sheets and all six after
sheets. Before the fix the seamless player head is visibly covered by canopy
pixels; afterward the pairs are visually identical. The full screenshots,
3× crops, and comparison sheets are retained beside the manifests.

The source locations are deliberately not hand-authored test art: they are
real imported Tuxemon maps selected by the diagnostic capture tool. Production
launches do not set its `renderer` switch and continue to select the seamless
renderer.

The relevant code trail is explicit: `ui/world-diagnostics.ts:31` declares
the simulation-only selector, `main.tsx:614` leaves the connected renderer in
place unless that selector requests `legacy`, and
`tools/capture-canopy-parity.ts:172` boots each real-game state through both
paths. The comparison rejects reducer drift at
`tools/capture-canopy-parity.ts:253` and counts pixels outside the player
overlap at `tools/capture-canopy-parity.ts:272-295`.

## Component implementation

`src/ui/occlusion-depth.ts` is the single definition of the ordering rule:

```
actorDepth(px, py, width) = floor(py) * (floor(width) + 1) + floor(px)
upperRowDepth(tileY, width) = (tileY * 16 + 2) * (floor(width) + 1) - 1
```

Consequently a foot at `rowY + 1` is behind the upper row and a foot at
`rowY + 2` is in front. The ordinary `OccludingUpperLayer` imports those
helpers rather than keeping a second formula.

The connected renderer exposes one actor host and one normalized actor space
for each connected component. Its upper root contains all actors and the
above-animation nodes as siblings of the static upper rows, because sibling
depth is required for interleaving. Active actors are projected from local to
world coordinates; preview and frozen actors already use their placement
origins; followers, vehicles and the vehicle shadow use the same projection.
Signed component origins are subtracted before depth calculation, so negative
world placements remain in the same non-negative ordering space. Unplaced
maps are represented as isolated one-map components and retain ordinary-path
pixels.

`WorldStreamedTerrain` keeps a circular pool of visible 16-pixel rows and only
the horizontal chunk slices intersecting those rows. The pool covers the
viewport plus one tile of margin and is recomputed from the active connected
component, not accumulated per visited map. A resident upper chunk is loaded
once; every row slice calls `setImage` with that existing handle. Above
animated cells use the same `upperRowDepth` and host. Below animations remain
on the ground plane.

Projects without a world renderer do not execute actor projection or create
the row plane. The shared GameView plumbing does add 1,795 source bytes to a
minimal GameView consumer (`1,108,708 → 1,110,503` in Sunstone); this is the
cost of keeping one active-actor implementation rather than duplicating it in
the optional renderer. Meadow, which does not reach GameView, stays exactly
684,525 bytes. Bundle isolation tests pin those sizes and confirm that no
optional world implementation becomes reachable. The QuickJS guard below
shows no measurable unused-path regression.

## Pixel, resource, and mutation tests

The component pixel fixture compares ordinary and seamless output byte for
byte with the same state and locally equivalent camera. It covers no overlap,
`rowY + 1`, `rowY + 2`, a row fully behind the actor, semi-transparent upper
pixels, two same-column actors, above animation depth, a neighbouring preview
under its own upper row, and the preview-to-live seam handoff frame.

Resource assertions require:

- upper uploads equal resident upper textures;
- row bindings exceed textures, proving handle reuse rather than duplicate
  uploads;
- row count is at most `ceil(viewportHeight / 16) + 3`;
- slice count is bounded by visible rows and chunks; and
- after visiting twelve maps over 22 crossings, texture and node high-water
  marks remain bounded by the viewport rather than visit count.

Four isolated mutations were applied outside the delivery worktree and each
made its targeted test fail:

| Mutation | Test that rejected it |
| --- | --- |
| Move upper-row depth by one pixel | ordinary/seamless boundary parity |
| Paint neighbour previews above the upper plane | preview-under-canopy pixel assertion |
| Upload a texture for every row slice | upload/resident/binding count assertions |
| Omit signed-origin normalization | signed component boundary test |

The focused tests are part of the full component suite; no mutation remains in
either delivery branch.

The shared formulas are at
`vendor/pocket-rpgkit/src/ui/occlusion-depth.ts:18-27`. The connected actor
space is formed at `vendor/pocket-rpgkit/src/ui/world/renderer.tsx:133-143`
and attached to the flat upper host at
`vendor/pocket-rpgkit/src/ui/world/renderer.tsx:203-205`. Static rows bind
the resident chunk handle at
`vendor/pocket-rpgkit/src/ui/WorldStreamedTerrain.tsx:299-318`, while
the viewport-sized circular row pool is maintained at
`vendor/pocket-rpgkit/src/ui/WorldStreamedTerrain.tsx:321-374`. Preview actors
and above animations use the same helpers at
`vendor/pocket-rpgkit/src/ui/WorldNpcPreview.tsx:306` and
`vendor/pocket-rpgkit/src/ui/WorldAnimatedTiles.tsx:191`.

## Golden and state impact

Nine 960×544 vertical world-seam frames changed. Every changed pixel is inside
the same 16×8 actor/sign overlap region; the retained old/new/diff contact
sheet is `findings/K-CANOPY-screenshots/world-golden-960x544.old-new-diff.png`.
Horizontal seam frames did not change.

One chapter thumbnail, Flower City, changed by 26 pixels in bounds
`[232,123,241,127]`, exclusively where the player overlaps the canopy. I
opened the old/new/magenta-diff crop at 8× and confirmed the surrounding
terrain, UI and text are unchanged. Re-recording the Chinese and English demo
tapes changed only their source chapter hash; masks, checkpoints and terminal
behaviour are unchanged.

All maintained terminal state hashes remain pinned:

| Journey | SHA-256 |
| --- | --- |
| GB6 | `748f84174b32011c4419588650a41d6c57c31c79d3f9e772fcc72b25c3bf9b80` |
| J1 | `c0b36ae2112df49774377c30e728d03a929fba771746bf54cb14e684742a8a87` |
| J2 | `b40b13672d7fd34db52e7607ebcf600f5740fe54c2b0915c7ff60bdb392b763d` |
| J3 | `49307027321e7f51ab1a8c81e48ca615cd70d636c289f4170e63fc408b1774bf` |
| J4 / English | `1977c1b0f3bd1bba2c4e5ad82332599c4fc72f0acd84d9437868976fbfb5c736` |

The game source bundle grows from 1,434,888 to 1,439,309 bytes (+4,421 B).
The 120,652,736-byte game pak is byte-identical. The deployable Web runtime is
1,491,176 compressed bytes; startup chunks total 6,586,991 bytes and 2,124
deferred chunks total 29,315,968 bytes.

## Validation

### Component and independent consumer

| Gate | Result |
| --- | --- |
| `bunx tsc --noEmit` | PASS |
| Full component suite | 4,623 pass, 0 fail, 0 skip |
| QuickJS single-parent and cumulative-parent drift guards | all 8 workloads PASS under 3% |
| Wander consumer suite | 523 pass, 0 fail, 0 skip |
| Wander typecheck, build, and Web build | PASS |
| Wander application JS and pak comparison | byte-identical to baseline |

QuickJS branch-versus-parent median changes were:

| Workload | Delta |
| --- | ---: |
| `sunstoneIdle` | -0.329% |
| `sunstoneWalk` | -0.078% |
| `sunstoneControlWalk` | +0.006% |
| `streamedRoam` | -0.843% |
| `battleScene` | -0.290% |
| `sunstoneIdleImmutable` | -0.146% |
| `sunstoneControlWalkImmutable` | +0.218% |
| `battleSceneImmutable` | -0.564% |

### Game, journeys, and Web

Two complete imports were byte-identical. TypeScript, localization, CJK font
coverage, production build and Wasm build passed. The ten CI test groups
reported 2,022 pass, 0 fail, 0 skip. Every `ci.yml` journey command passed:
GB6, J1, J2, J3, J4, German parity, golden synchronization, both battle-loss
paths, locks, frozen-map scan, chapters, Chinese transcription/demo, English
demo, save/resume, preview coverage, and built-world replay.

The ordinary Web build and every CI Web command passed: PWA/offline, journey,
Chinese opening, demo controls, Arena, Expedition, double-battle keyboard and
touch, and audio. The additional chunk, language, link and PSP-save gates also
passed. The Link verifier first found port 49190 legitimately occupied by
another worktree; it was rerun on isolated port 49268 and passed without
touching that process. Web journey boot was 541 ms and its 3,629 frames ran in
842 ms.

The real PPSSPP save matrix passed all phases. A normal save wrote 3,935 bytes;
loading restored `spyder_downstairs@[6,6]` at frame 115 field for field and
continued 30 frames. Legacy raw JSON, autosave restart, and a read-only memory
stick were also exercised; the last case displayed `SAVE FAILED`, wrote no
file, and did not crash.

### PSP and ABBA performance

The first PSP journey run reached the correct terminal at frame 3,629 and
produced non-zero victory PCM, but exposed a pre-existing attribution error in
the host-only audio probe: `native.play()` runs after the reducer selects a
new track but before the probe's frame-tail observation, so every play was
charged to the preceding phase. Replaying that exact ordering against game
`origin/main` produced
`mapPlays=1, battlePlays=1, victoryPlays=0`. The verifier was not weakened;
`tools/host-audio-probe.ts:55-59` now observes the reducer state immediately
before counting native PCM writes and plays, and
`tests/host-audio-probe.test.ts:78-114` locks the frame-internal transition
order. All four focused probe tests pass.

The real PPSSPP save matrix and the ordinary release rebuild passed. The
remaining journey first-frame/memory run, desktop QuickJS cold-start ABBA, and
mobile Web frame ABBA have not yet been sampled: the host is running a separate
formal mobile benchmark, and overlapping another timed workload would make
both records invalid. Functional and component QuickJS gates are green, but a
release-performance verdict therefore cannot yet be claimed.

The normal PSP release was rebuilt after the instrumented save matrix. It
contains 1,439,215 source bytes, 68,828,784 external bytes, and 1,181,392
embedded bytes.

`bun.lock` is unchanged. Both upstream baselines were fetched immediately
before delivery and had not advanced. No background process started for this
work remains running.

subagent 使用：3 个 / 组件架构与资源模型、真实游戏复现与 golden 影响、CI 与性能门禁梳理 / 并行调研节省了时间

BLOCKED
