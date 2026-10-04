# Verification

This repository verifies the imported world three ways: by replaying
deterministic input recordings ("tapes") through the runtime and checking the
final state, by comparing rendered keyframes against committed golden
images, and by re-baking the demo chapter snapshots and warp spawns and
proving each chapter resumes to the same terminal state. CI runs the fast
subset on every push (see [ci.md](ci.md)); the full multi-rate, save/load
and rewind checks are release gates you run locally.

## The verify scripts

All scripts read the committed data files; none of them need a build except
where noted. Set `TUXEMON_SRC` first (or keep a repo-local `.tuxemon-src`).

| Script | What it proves | Input | Rough duration |
|---|---|---|---|
| `verify:audio` | Two clean ffmpeg/QOA passes produce byte-identical files; all 27 committed audio containers match their manifest SHA-256, byte size, rate, channels, frame count, duration and loop bounds. | Tuxemon source, `assets/audio/manifest.json` | ~55 s |
| `verify:web:audio` | A built web game streams three newly added map tracks in real Chrome: each resolves to its logical BGM, decodes non-zero QOA PCM, writes frames accepted by the host, runs an AudioWorklet-backed real-time context, and reports no underrun or console error. | built web site | ~10 s |
| `verify:g6:determinism` | Two full imports into isolated roots produce byte-identical output (4,766 files). | Tuxemon source | ~25 s |
| `verify:terrain:determinism` | The terrain corpus alone is byte-stable across two runs. | Tuxemon source | ~15 s |
| `verify:terrain:collision` | Imported collision matches an independent Python oracle that mirrors Tuxemon's own movement code, cell by cell and direction by direction (default: 11 maps, 56,176 directed steps; `--all` for every map). | `data/terrain.json`, Tuxemon source, PyYAML | under a second for the default set; minutes for `--all` |
| `verify:g6:locks` | Every imported `lockInput` page releases its lock, either through `unlockInput` or a map transfer (331 pages, 336 checks). | imported project | ~15 s |
| `verify:g6:frozen` | The freeze scan finds no permanent input lock or blocking fiber on any imported map: every map is entered and driven for 12,000 frames, flagging held input locks, blocking fibers and interpreter errors. This is an interpreter-liveness result, not a proof that a wanderer can never spatially block the player. | imported project | ~65 s |
| `verify:gb6:mainline` | The 110,866-frame mainline tape replays at 60 Hz to the frozen terminal state, with every map checkpoint, all 107 battles (22 trainer, 85 wild) and the trainer win counts intact. | `data/gb6-mainline-journey.json` | ~72 s |
| `verify:gb6:failures` | Both committed defeat tapes (the first loss against Billie, and the later Route 3 loss) replay with their visible recovery order: faint-point teleport, heal-before-leaving block, nurse recovery. | `data/gb6-first-loss-journey.json`, `data/gb6-later-loss-journey.json` | ~40 s |
| `verify:j1:mainline` | The Captain-return continuation, concatenated with the GB6 tape and replayed from frame zero (122,386 frames), ends at the mansion with the captain's return and all 14 battles (10 trainer, 4 wild) intact. | `data/gb6-mainline-journey.json`, `data/j1-captainreturns-journey.json` | ~67 s |
| `verify:j2:mainline` | The hospital-cure continuation, concatenated with GB6 and J1 and replayed from frame zero (172,873 frames), ends in the Candy Town hospital with the cure granted and all 54 battles (50 trainer, 4 wild) won. | `data/gb6-mainline-journey.json`, `data/j1-captainreturns-journey.json`, `data/j2-hospitalcure-journey.json` | ~130 s |
| `verify:j3:mainline` | The Radio Tower continuation, concatenated with GB6, J1 and J2 and replayed from frame zero (185,802 frames), ends at the broadcast with all 13 new trainer battles won and the Omnichannel story flags intact. | the four maintained mainline tapes through `data/j3-omnichannelradioannounce-journey.json` | ~140 s |
| `verify:j4:mainline` | The Kernel continuation replays twice from the exact J3 production-save boundary, then concatenates all five segments and replays 199,189 frames from frame zero. It pins 14 wins (12 trainer plus Cataspike and Kernel), all seven correct Data Center answers and the `kernelquest=done` epilogue. | the five maintained mainline tapes through `data/j4-kernelquestdone-journey.json` | ~30 s |
| `verify:chapters` | The demo chapters re-bake byte-identical: each save envelope passes the kit's save validator (decode + map-aware restore), the 480×272 thumbnails re-render from the built game to the committed PNG hashes, and every envelope restored and resumed at its `timelineFrame` suffix-replays to the full-tape terminal state. Fails with the rebake command when the kit, the tape or the importer moves a checkpoint. | `data/chapters.json`, `docs/screenshots/chapters/`, built bundle | ~12 min |
| `verify:save` | Five saves through the game's own save path (save-point check, slot store or save code, content identity, decode, restore): after a battle, after a map change and after a late battle in the 09:00 GB6 replay, and one minute before noon plus mid-tint-tween right after the daylight stage turns in an 11:52 replay. Each restored state equals the live state at its save frame (one frame later for the rebuilt NPC table), and each resumed replay ends at the uninterrupted terminal state hash. Only the host frame counter `SessionState.frame`, which the reducer never reads, is set back for hashing. Report in `reports/save-resume.json`. | GB6 tape, generated shards | ~4 min |

Durations are wall-clock measured on a current developer machine; the CI
machines fold the mainline tapes in about a minute each.

### Modes of the five big verifiers

`verify-gb6-mainline.ts`, `verify-j1-mainline.ts`, `verify-j2-mainline.ts`,
`verify-j3-mainline.ts` and `verify-j4-mainline.ts`
share the same modes, each selected by its own env var (`GB6_VERIFY_MODE`,
`J1_VERIFY_MODE`, `J2_VERIFY_MODE`, `J3_VERIFY_MODE`, `J4_VERIFY_MODE`); the `:mainline` script
runs the CI default:

| Mode | What it adds |
|---|---|
| `ci` (default) | One 60 Hz replay of the frozen tape against the production reducer. This is the CI leg. |
| `segment` (J1, J2, J3, J4) | Replays just the continuation segment from a rebuilt ancestor terminal snapshot. |
| `stateful` | Saves mid-journey, restores the snapshot, and continues to the frozen terminal; J1, J2, J3 and J4 also verify the battle rewind. |
| `rate-60`, `rate-30`, `rate-20` | Replays the same 60 Hz-authored tape at a lower host tick rate and compares the full session state against an independent 60 Hz fold, source frame by source frame. |
| `full` | Standalone/merged replay plus save/load, rewind and all three rates. The release/acceptance gate; about ten minutes for GB6. |

### Traversal identity and the seamless migration

Every maintained tape now carries `worldTraversal: "seamless-v1"`. The chapter
manifest repeats that identity at its root and for each GB6/J1/J2/J3/J4 segment,
and the demo binary encodes it. A tape with no identity retains the historical
`legacy-transfer` meaning; unknown identities and a chapter manifest whose
segments disagree are rejected instead of being guessed.

Before migration, the old masks were replayed under both timelines and the
first different reducer state was recorded. All seven tapes first diverged at
the Paper Town north opening: source frame 3,971 for G6, GB6, its later-loss
path and J1–J3, and source frame 3,306 for the first-loss tape. The seamless
timeline starts the eight-tick atomic handoff where legacy starts its fade.
G6, both failure paths and GB6 still reached their intended endpoints with the
same masks, so only their traversal identity and derived metadata were
rebuilt. J1 no longer reached the captain endpoint with the old continuation;
J1, J2 and J3 were therefore re-recorded in order, then all chapter envelopes,
timeline frames and affected goldens were rebaked. The G6 repository test also
replays the maintained G6 masks with an explicit legacy session and pins its
legacy terminal hash, preserving the other half of the compatibility contract.

### The QuickJS benches

`bench:g6:quickjs`, `bench:gb6:quickjs`, `bench:j3:quickjs` and
`bench:j4:quickjs` measure
real-frame CPU performance
inside the actual desktop host's QuickJS guest (not Bun's JavaScriptCore):
they build the vendored Rust host with a benchmark harness, boot the built
game, replay a tape frame by frame, and assert a 250 ms startup-to-first-paint
budget and 50 ms per-frame CPU budgets per frame class (walking, map switch,
battle entry/exit/steady). The final terminal state must hash to the pinned
tape value. Use these for any performance claim; Bun/JSC timings are not
representative of the desktop or PSP targets.

The production-frame gate uses the current thread's QuickJS plus core CPU
time. Wall time, sampled drawing and boundary GC are printed as supporting
diagnostics, but scheduler pauses do not become false CPU regressions. Every
run also prints its 20 slowest production frames with first-visit/revisit,
map-tail, dialogue-open, battle entry/exit and world-stress classifications.

The harness defaults to the desktop production GC lifecycle. It creates an
idle-GC guest, evaluates the complete bundle, verifies `has_frame`, arms idle
GC, and then enters frame zero. At every frame boundary it gives GC the unused
part of the 60 Hz budget. `G6_GC_MODE=auto` selects QuickJS's automatic trigger
as an explicit comparison; it does not arm or service boundary GC. The
`G6_BUDGET_MS` and `G6_STARTUP_MS` overrides are diagnostics only and must stay
unset for a release-gate run.

The `:cold` commands run five samples at each viewport. Every sample executes
the already-built test binary as a fresh OS process with a fresh QuickJS realm
and no application prewarm; the OS page cache is deliberately not dropped.
Within each process, `TEMP_CASE temperature=cold` covers first-use work (first
map visits, first battle and first modal kind, or world-cache pass 1), while
`temperature=hot` covers revisits and world-cache pass 2. Thus each group of
five fresh processes supplies five independent maxima for both columns.
Pin the commands to one logical CPU and record `uptime` before and after a
measurement batch; choose a CPU appropriate for the test machine:

```sh
BENCH_CPU=6
uptime
taskset -c "$BENCH_CPU" bun run bench:gb6:quickjs:cold
taskset -c "$BENCH_CPU" bun run bench:j3:quickjs:cold
taskset -c "$BENCH_CPU" bun run verify:world-cache:cold
uptime
```

For the low-load acceptance matrix, run each suite/viewport cell as its own
five-process batch, keep `G6_PROFILE_FRAMES`, `G6_BUDGET_MS` and
`G6_STARTUP_MS` unset, and require every production frame to be below 45 ms
while the recorded one-minute load average is at most 6. Preserve a process
that fails the 250 ms startup gate in the record; do not replace it with a
successful sample. Run a separate five-process GB6 960×544 batch at the
highest naturally available load and judge its production frames against the
normal 50 ms gate. A diagnostic startup override may retain all five replays
for attribution, but does not turn an over-250 ms startup into a pass.

`BUILD_INPUT` identifies the exact JavaScript, pak, generated project shell and
map-manifest hash used by each batch. `HOST_INPUT` hashes the journey harness
and vendored PocketJS inputs. `PROCESS_COLD` identifies each process sample.
`STAGE` and `BOOT` split bundle startup, `TEMP_CASE` reports cold/hot p95 and
maximum thread CPU, `SLOW_FRAME` reports the ranked frames, `IDLEGC_CPU`
separates production work from GC, and `WORLD_PLATEAU` proves the second
outdoor pass did not grow native nodes or textures.

`G6_REUSE_HOST=1` may reuse only the compiled Rust test host. The wrapper
rejects it unless the saved `HOST_INPUT` stamp still matches, and every sample
remains a fresh OS process and QuickJS realm. `G6_PROFILE_FRAMES=97,123` is an
opt-in diagnosis aid: selected frames additionally retain the raw reducer,
cache, signal and mount markers. It adds native timing callbacks and is not a
release-gate mode.

Build the matching desktop bundle before any benchmark. The benchmark
checks that its embedded map-manifest hash matches the generated project shell
and stops before compiling the harness when the bundle is missing or stale:

```sh
bun run build
bun run build:wasm
bun tools/desktop.ts --build-only
bun run bench:g6:quickjs
bun run bench:gb6:quickjs
bun run bench:gb6:quickjs:cold
bun run bench:j3:quickjs
bun run bench:j4:quickjs
bun run bench:j3:quickjs:cold
bun run bench:indoor-fast-path
bun run verify:world-cache
bun run verify:world-cache:cold
```

The short G6 benchmark replays 3,990 frames at 480×272 and 960×544, then
measures the first visit to all 263 maps. The long GB6 benchmark replays all
110,866 frames and 107 battles at both viewports; set
`GB6_BENCH_VIEWPORT="960 544"` (or `"480 272"`) to select one viewport. On the
reference workstation each viewport takes roughly two minutes; a cold
isolated Rust host build adds about 40–60 seconds. GB6 reads its expected
terminal SHA-256 from the tape,
so re-pinning the tape cannot leave a second stale literal in the wrapper.
JavaScript compile/evaluation failures include the original message and stack.

The J3 benchmark restores the production `hospital-cure` chapter snapshot,
then replays the 11 remaining J2 masks plus all 12,929 J3 masks (12,940 total).
It exercises
13 battles including Beaverbrook and checks the Radio Tower terminal hash at
both 480×272 and 960×544. This also keeps chapter restore honest in the
QuickJS guest, where browser-only globals such as `TextDecoder` do not exist.

The J4 benchmark restores the production `radio-broadcast` chapter snapshot,
replays the remaining 23 J3 masks and all 13,387 J4 masks (13,410 total),
exercises 14 battles including Kernel, and checks the complete-mainline
terminal hash at both supported viewports.

The world-cache gate boots the same production bundle and session path at
480×272 and 960×544. It follows bidirectional authored openings through every
connected component, visits all 67 placed outdoor maps twice, and asserts
bounded parsed/compiled maps, provider shards, native nodes, textures and
post-GC QuickJS heap as well as a 50 ms cross-map frame budget.

The indoor fast-path probe replays the production tape into
`spyder_downstairs`, verifies that world diagnostics are disabled, then times
4,000 neutral frames at both viewports. `INDOOR_BENCH_APP_ROOT` can point it
at an already-built comparison checkout; increase `G6_INDOOR_FRAMES` for a
lower-noise release comparison.

These are manual release and performance gates, not CI jobs. Their Rust host
build and long replay are too expensive for the normal push pipeline, and
startup plus all-map first-visit measurements still contain wall-clock
sensitivity on shared runners.

The current fixed-CPU matrix below reports the median and worst per-process
maximum QuickJS-plus-core CPU frame, in milliseconds. It uses the component
release containing the reducer entry-page cache and deferred seamless
eviction, CPU 6, the `powersave` governor, and recorded one-minute load
averages of 1.30–4.89. Five fresh processes were started for every formal
cell. The 250 ms startup gate stopped both GB6 cells before replay and stopped
four of five J3 480×272 processes; those failures remain in the record. A
separate five-process diagnostic with only `G6_STARTUP_MS=500` supplied the
missing production distributions. This does not turn an over-250 ms startup
into a pass. J3 960×544 and both world-cache rows are unmodified formal runs.

| Route / viewport | Production source | Formal completed / started | Cold median / worst | Hot median / worst |
| --- | --- | ---: | ---: | ---: |
| GB6 480×272 | 500 ms startup diagnostic | 0 / 5 | 19.802 / 22.578 | 34.088 / 39.913 |
| GB6 960×544 | 500 ms startup diagnostic | 0 / 5 | 22.513 / 22.636 | 28.674 / 32.960 |
| J3 480×272 | 500 ms startup diagnostic | 1 / 5 | 36.311 / 41.500 | 19.470 / 19.545 |
| J3 960×544 | formal | 5 / 5 | 36.764 / 41.595 | 19.693 / 20.205 |
| world cache 480×272 | formal | 5 / 5 | 31.880 / 38.294 | 31.989 / 32.362 |
| world cache 960×544 | formal | 5 / 5 | 33.666 / 36.249 | 37.250 / 42.287 |

Every completed production frame is below the stricter 45 ms low-load line.
The global maximum is a hot world-cache frame at 960×544, 42.287 ms. This is
0.199 ms below the previous five-run result (42.486 ms) and 0.371 ms above its
three-run review result (41.916 ms), leaving 2.713 ms to 45 ms and 7.713 ms to
the normal 50 ms gate. Every completed journey process retained its canonical
terminal hash.

Formal startup was much less reliable than production replay. The median /
worst startup-to-first-paint times were 269.968 / 299.410 ms for GB6 480×272,
283.591 / 294.595 ms for GB6 960×544, 272.358 / 286.976 ms for J3 480×272 and
211.897 / 232.970 ms for J3 960×544. The misses happened before frame zero.
They continued the known shared-host sensitivity: CPU affinity fixes process
placement but not `powersave` frequency, page-cache state or other host work.
The current gate is intentionally unchanged.

The Chinese smoke tape was also run in three new processes at both viewports.
The formal startup gate completed zero of three 480×272 processes and one of
three 960×544 processes, so separate 500 ms startup diagnostics retained all
six production replays. The first long-dialog frame now stayed below 50 ms:

| Viewport | Cold median / worst | Hot median / worst |
| --- | ---: | ---: |
| 480×272 | 9.956 / 11.629 | 41.700 / 49.258 |
| 960×544 | 10.510 / 12.495 | 46.340 / 46.847 |

This is better than the earlier 43–64 ms range, but the 480×272 maximum still
misses the optional 45 ms low-load target. All six processes produced the same
Chinese terminal hash.

The world-cache second pass has zero native-node and texture growth in every
clean matrix sample, with only 1,467 B and 2,915 B of post-GC heap growth at
the two viewports. One discarded 480×272 batch coincided with another worktree
starting a many-core release build: one-minute load rose from 5.32 to 10.37
and its third process exceeded 50 ms. The foreign build was identified and
allowed to finish; the clean five-process batch above started only after its
compiler processes had exited and load returned below 6. Boundary collection
is not performed inside production work (`in_tick_gc=0` throughout). See the
[cold-path performance report](../findings/PERF-COLD.md) for the original
reducer attribution and component patch measurements.

## The tapes

A tape is a JSON document holding the input masks (one per 60 Hz frame), the
expected story variables, map checkpoints, battle checkpoints, and the
terminal state's SHA-256. The verifiers recompute the tape's own hash and
fail on any mismatch, so a silently corrupted tape is a red build.

| Tape | Frames | Route | Battles | Terminal |
|---|---:|---|---:|---|
| `data/g6-journey.json` | 3,990 | bedroom -> Paper Town -> first battle -> Route 1 | 1 | `spyder_route1 @14,19` |
| `data/gb6-mainline-journey.json` | 110,866 | Route 1 -> Cotton Town -> Paper Town -> Route 2 -> City Park -> Leather Center -> Route 3 -> Wayfarer Inn -> back to Route 3 | 107 (22 trainer, 85 wild) | `spyder_route3 @4,6` |
| `data/gb6-first-loss-journey.json` | 3,325 | the opening, deliberately losing the first Billie fight | 1 | `spyder_route1 @14,19` |
| `data/gb6-later-loss-journey.json` | 66,498 | the mainline prefix to Wanda, a deliberate loss, then the recovery path | 1 loss + prefix | `spyder_leather_town @23,10` |
| `data/j1-captainreturns-journey.json` | 11,520 (122,386 combined with GB6) | Wayfarer Inn -> Route 4 -> Flower City -> Route A -> Mansion -> basement -> the captain's return | 14 (10 trainer, 4 wild) | `spyder_mansion @1,13` |
| `data/j2-hospitalcure-journey.json` | 50,487 (172,873 combined) | Mansion -> Candy Town -> Greenwash -> hospital password -> the cure | 54 (50 trainer, 4 wild) | `spyder_candy_hospital3 @5,7` |
| `data/j3-omnichannelradioannounce-journey.json` | 12,929 (185,802 combined) | hospital cure -> Paper Town -> Cotton Town -> Omnichannel floors 1–4 -> Radio Tower broadcast | 13 trainer | `spyder_radiotower @9,5` |
| `data/j4-kernelquestdone-journey.json` | 13,387 (199,189 combined) | Radio Tower -> Cotton Town briefing -> Surfboard -> Route E -> Route B -> Data Center -> Kernel | 14 (12 trainer, 2 wild) | `spyder_datacenter @7,4` |
| `data/zh-smoke-journey.json` | 3,201 | Chinese bedroom opening -> downstairs dialogue -> Paper Town -> first battle | 1 | `spyder_paper_town @26,9` |

Terminal state hashes and per-checkpoint expectations live in the tapes or
their verifiers (`tools/verify-gb6-mainline.ts`, `tools/verify-j1-mainline.ts`,
`tools/verify-j2-mainline.ts`, `tools/verify-j3-mainline.ts`,
`tools/verify-j4-mainline.ts`,
`tools/verify-gb6-failures.ts`) and are asserted on every run.

### Re-recording a tape

Tapes are recorded by driving the game with the same deterministic driver the
verifiers use:

```sh
# J1, J2, J3 and J4 continuations
bun run record:j1:mainline        # writes data/j1-captainreturns-journey.json
bun run record:j2:mainline        # writes data/j2-hospitalcure-journey.json
bun run record:j3:mainline        # writes data/j3-omnichannelradioannounce-journey.json
bun run record:j4:mainline        # writes data/j4-kernelquestdone-journey.json

# GB6 mainline
GB6_JOURNEY_OUT=data/gb6-mainline-journey.json bun tools/gb6-journey.ts

# First-loss path (choose the starter that loses to Billie)
HZ=60 GB4_OUTCOME=lose GB4_JOURNEY_OUT=data/gb6-first-loss-journey.json bun tools/smoke-spyder.ts

# Later-loss path
GB6_LATER_LOSS_OUT=data/gb6-later-loss-journey.json bun tools/gb6-later-loss.ts
```

After re-recording, set the tape's explicit traversal identity, update the
verifier's pinned hashes and checkpoint lists, and regenerate every descendant
segment if an ancestor changed. Then rebake chapters (including
`timelineFrame`, snapshots and thumbnails), regenerate the affected goldens,
and re-run every verify script plus the web journey. A re-recorded tape is a
change to the game's contract, not a test fixture refresh.

## Chapter snapshots and warp spawns

The web demo menu's data lives in two committed files:

- `data/chapters.json` — twenty named checkpoints along the GB6+J1+J2+J3+J4 mainline
  (new-game bedroom, Paper Town, before the first Billie battle, starter
  chosen, Route 1, Cotton Town, City Park, the Route 3 north end, Flower
  City, the captain's return, Candy Town, Greenwash with the Aardant, the
  recovered hospital cure, the opened Omnichannel passage, the Radio Tower
  broadcast, the Kernel briefing, the Surfboard, Route B, the Data Center
  and Kernel's defeat). Each entry is a kit save envelope taken at a
  safe point (`canSave`, no input lock, no fade), the frame where its tape
  suffix starts (an offset into the concatenated GB6+J1+J2+J3+J4 masks), and the
  480×272 thumbnail hash.
- `data/warp.json` — one safe spawn per imported map: a clear incoming
  transfer landing when one exists, otherwise the standable cell nearest
  the first landing (or the first standable cell in row-major order when
  nobody transfers here). A spawn must be standable on the engine's
  passage table and clear of every event area, not just blocking ones.
  Eighteen maps have no standable event-free cell and are marked `blocked`:
  `classic_route_4` is solid everywhere, and the other seventeen are
  blanketed by Tuxemon's full-map one-shot visit-tracker regions.

Rebake both after a kit, tape or importer change that moves a checkpoint or
a spawn:

```sh
bun run import                 # refreshes data/warp.json
bun tools/bake-chapters.ts     # refreshes data/chapters.json + docs/screenshots/chapters/
```

`bun run verify:chapters` re-bakes in memory and byte-diffs `data/chapters.json`
and every thumbnail, then restores each committed envelope, sets the global
reducer frame to its `timelineFrame`, and suffix-replays to the full-tape
terminal state. The warp spawns are covered by `tests/warp-spawns.test.ts`
(every spawn stands on the engine's passage table and clear of every event
area; the eighteen `blocked` maps have no standable event-free cell) and by
the import job's cleanliness check. Open the rebaked thumbnails and look at
them before committing, the same as goldens.

## Goldens

`tests/goldens/` holds the keyframe PNGs (480x272 and 960x544) and the
gzipped battle trace fixtures. The golden tests assert exact PNG SHA-256, a
decoded-RGBA hash, per-opaque-pixel sprite matches at the reducer-derived
positions, and semantic colour-region counts per map. There is no tolerance:
a single differing pixel fails.

| Command | Regenerates |
|---|---|
| `bun run goldens:g6` | The four opening keyframes and `data/g6-goldens.json`, by re-driving the opening tape (it runs the recorder first, because the PNGs are only valid for the current tape). Also rewrites `data/g6-journey.json`. |
| `bun run goldens:gb5:battle` | The six battle scenes (menu, technique menu, hit, faint, level-up, capture shake) at both viewports, plus `data/gb5-battle-goldens.json` and the battle screenshot in `docs/`. |
| `bun run goldens:gb6:route` | The four mainline route keyframes at both viewports and `data/gb6-route-goldens.json`. |
| `bun run goldens:j1` | The three Captain-return keyframes at both viewports and `data/j1-goldens.json`. |
| `bun run goldens:j2` | The hospital-cure keyframes (Aardant acquired, hospital password, the cure) at both viewports and `data/j2-goldens.json`. |
| `bun run goldens:j3` | The Omnichannel wall, Radio Tower entry and completed broadcast at both viewports, plus `data/j3-goldens.json`. |
| `bun run goldens:j4` | The acquired Surfboard, Data Center terminal floor and completed Kernel quest at both viewports, plus `data/j4-goldens.json`. |
| `bun run goldens:world` | Phase 0–7 plus landing for one horizontal and one vertical production handoff at both viewports, plus two contact sheets and `docs/screenshots/world-seam/manifest.json`. The manifest pins PNG/RGBA hashes, visible-map ownership, camera/player geometry and cache counts; the test also asserts no fade or black frame and correct player/upper-layer compositing. |
| `bun run goldens:daylight` | The same Paper Town checkpoint at fixed 09:00 and 21:00 starts, plus `data/daylight-goldens.json`. The test recomputes luminance, blue bias and per-pixel day/night differences from the decoded PNGs. |

Regenerate goldens only when the rendering change is intentional, and always
open the regenerated PNGs and look at them. A hash pins the bytes; it cannot
tell a correct picture from a consistently wrong one. Several past rendering
bugs (a same-tick resize that only extended black borders, a wrong depth
composite) were caught by eye, not by the assertions.

## Multi-Hz, save/restore and rewind

These are the properties the `:full`, `:rates` and `:stateful` modes check:

- **Multi-Hz.** The 60 Hz-authored tape is replayed at 30 and 20 Hz. The
  runtime folds the same number of reference ticks per host frame, and the
  entire session state must match an independent 60 Hz fold at every source
  frame. This proves the simulation is driven by a reference tick, not a wall
  clock.
- **Save/restore.** A snapshot is taken at a safe mid-journey frame,
  envelope-encoded, restored into a fresh session, and the continuation must
  reach the frozen terminal with identical history.
- **Rewind.** During a battle, the rewind input must land the history exactly
  at the battle's start frame with byte-identical restored state, and
  replaying the suffix must reproduce the frozen terminal. The J1 verifier
  additionally asserts the rewind refolded from a retained keyframe rather
  than from frame zero.
- **Seam handoff boundaries.** The G6 repository test saves immediately before
  and after a real handoff, refuses a save during phase 4, rewinds from phase 4
  to the source-side state, and replays the suffix byte-identically at 60, 30
  and 20 Hz (with the 4 Hz attract stress case retained as well).

Battle scenes get the same treatment at the presentation layer: the
hit-frame rewind test clones the runtime state, steps back one event tick,
and asserts the framebuffer repaints byte-identically.

## When something fails

- **Determinism:** the output names the first differing file. That file's
  cooker (terrain, characters, battle, animated, project) is where to look;
  the usual cause is map-order-dependent iteration or a time-seeded RNG.
- **A journey verify:** the error label includes the diverging frame and
  position. Compare the run's checkpoint trace against the tape's checkpoints
  and the recorder's route in the corresponding `tools/*-journey.ts`.
- **A golden test:** diff the PNG against the committed one. If the change is
  intentional, regenerate with the matching `goldens:*` command, open every
  regenerated PNG, and commit the PNGs and the `data/*-goldens.json` manifest
  together.
- **Locks or frozen:** the JSON reports (`reports/G6-lock-report.json`,
  `dist/frozen-k1.json`) classify every failing page or map with the frame
  window where it stopped making progress.
