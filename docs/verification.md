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
| `verify:gb6:mainline` | The 115,842-frame mainline tape replays at 60 Hz to the frozen terminal state, with every map checkpoint, all 111 battles (22 trainer, 89 wild) and the trainer win counts intact. | `data/gb6-mainline-journey.json` | ~72 s |
| `verify:gb6:failures` | Both committed defeat tapes (the first loss against Billie, and the later Route 3 loss) replay with their visible recovery order: faint-point teleport, heal-before-leaving block, nurse recovery. | `data/gb6-first-loss-journey.json`, `data/gb6-later-loss-journey.json` | ~40 s |
| `verify:j1:mainline` | The Captain-return continuation, concatenated with the GB6 tape and replayed from frame zero (128,718 frames), ends at the mansion with the captain's return and all 16 battles (10 trainer, 6 wild) intact. | `data/gb6-mainline-journey.json`, `data/j1-captainreturns-journey.json` | ~67 s |
| `verify:j2:mainline` | The hospital-cure continuation, concatenated with GB6 and J1 and replayed from frame zero (180,129 frames), ends in the Candy Town hospital with the cure granted and all 56 player battles (50 trainer, 6 wild) won; the segment also records one spectator battle. | `data/gb6-mainline-journey.json`, `data/j1-captainreturns-journey.json`, `data/j2-hospitalcure-journey.json` | ~130 s |
| `verify:j3:mainline` | The Radio Tower continuation, concatenated with GB6, J1 and J2 and replayed from frame zero (193,231 frames), ends at the broadcast with 13 new trainer wins, one wild win and the Omnichannel story flags intact. | the four maintained mainline tapes through `data/j3-omnichannelradioannounce-journey.json` | ~140 s |
| `verify:j4:mainline` | The Kernel continuation replays twice from the exact J3 production-save boundary, then concatenates all five segments and replays 206,830 frames from frame zero. It pins 15 wins (12 trainer plus Pythwire, Sockeserp and Kernel), all seven correct Data Center answers and the `kernelquest=done` epilogue. | the five maintained mainline tapes through `data/j4-kernelquestdone-journey.json` | ~30 s |
| `verify:goldens:sync` | Validates the GB6/J1/J2/J3/J4 ancestry and tape hashes, derives all 11 GB6 route, J1, J4 and daylight checkpoints, and replays the authoritative reducer to assert the exact map, tile, reducer frame, world-idle and saveable state. It does not boot the renderer or write files. | the five maintained mainline tapes, the G6 tape and generated project | ~14 s |
| `verify:chapters` | The demo chapters re-bake byte-identical: each save envelope passes the kit's save validator (decode + map-aware restore), the 480×272 thumbnails re-render from the built game to the committed PNG hashes, and every envelope restored and resumed at its `timelineFrame` suffix-replays to the full-tape terminal state. Fails with the rebake command when the kit, the tape or the importer moves a checkpoint. | `data/chapters.json`, `docs/screenshots/chapters/`, built bundle | ~12 min |
| `verify:zh:tape` | Re-transcribes the English mainline for the Chinese build and requires `data/zh-mainline-journey.json` and `data/chapters.zh_CN.json` byte for byte: an English and a Chinese session fold in lockstep, only confirm presses inside dialog boxes may change, and the language-neutral states (everything but compiled event text, the open box and a scene title) must agree after every box, at every chapter and at the end. Fails before folding when a journey's masks, `data/chapters.json` or the dialog font no longer match the hashes the Chinese files record. | the five maintained tapes, `data/chapters.json`, generated en/zh projects | ~35 s |
| `verify:zh:demo` | Boots the built game in Chinese: every chapter jump restores exactly the reducer's Chinese chapter state, Autoplay from three chapters folds 600 frames to the Chinese reducer state (the English state apart from words), and the Chinese chapter thumbnails re-render to the committed ones. `--autoplay=all` covers every chapter, `--full` the whole tape from the bedroom (~1 min). | Chinese tape and chapters, built bundle | ~5 s |
| `verify:save` | Five saves through the game's own save path (save-point check, slot store or save code, content identity, decode, restore): after a battle, after a map change and after a late battle in the 09:00 GB6 replay, and one minute before noon plus mid-tint-tween right after the daylight stage turns in an 11:52 replay. Each restored state equals the live state at its save frame (one frame later for the rebuilt NPC table), and each resumed replay ends at the uninterrupted terminal state hash. Only the host frame counter `SessionState.frame`, which the reducer never reads, is set back for hashing. Report in `reports/save-resume.json`. | GB6 tape, generated shards | ~4 min |
| `verify:preview:coverage` | The neighbour NPC preview by sandboxed map entry, for every map at the new-game state and at all 20 chapter snapshots: no mainline (`spyder_*`) event is rejected, the sandbox never changes the live state, and the new-game result equals the import report. Writes `reports/preview-coverage.md` (and `.zh_CN.md`). | `dist/project.json`, `data/chapters.json`, `dist/import-report.json` | ~15 s |

Durations are wall-clock measured on a current developer machine; the CI
machines fold the mainline tapes in about a minute each.

The committed chapter pack is rebaked against the current 206,830-frame
recording. Route 2's `autosave` coincides with an independent parallel choices
modal, which the current tagged save format can decode and restore, so it is a
same-tick safe snapshot. Autosaves that coincide with work the v1 format cannot
resume (for example a pending transfer or battle, active scene or handoff) are
instead published at the first recoverable reference tick. `verify:chapters`
exercises the host effect path and validates every resulting envelope.

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

`bench:g6:quickjs`, `bench:gb6:quickjs`, `bench:j3:quickjs`,
`bench:j4:quickjs` and `bench:cotton:quickjs` measure
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
taskset -c "$BENCH_CPU" bun run bench:cotton:quickjs
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
`STAGE` and `BOOT` split bundle startup. In particular, `language-data`
separates the five zh_CN raw-entry reads and JSON parses from shared bundle
evaluation; it is effectively zero on an English boot. `TEMP_CASE` reports
cold/hot p95 and maximum thread CPU, `SLOW_FRAME` reports the ranked frames,
`IDLEGC_CPU` separates production work from GC, and `WORLD_PLATEAU` proves the
second outdoor pass did not grow native nodes or textures.

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
bun run bench:cotton:quickjs
bun run verify:world-cache
bun run verify:world-cache:cold
```

The short G6 benchmark replays 3,500 frames at 480×272 and 960×544, then
measures the first visit to all 263 maps. The long GB6 benchmark replays all
115,842 frames and 111 battles at both viewports; set
`GB6_BENCH_VIEWPORT="960 544"` (or `"480 272"`) to select one viewport. On the
reference workstation each viewport takes roughly two minutes; a cold
isolated Rust host build adds about 40–60 seconds. GB6 reads its expected
terminal SHA-256 from the tape,
so re-pinning the tape cannot leave a second stale literal in the wrapper.
JavaScript compile/evaluation failures include the original message and stack.

The Cotton Town benchmark is a bounded version of the production world-cache
route. It starts from the same fresh session, advances through the same prior
maps so allocation and GC history are preserved, collects the target map from
its diagnostic control frame through cache settlement, and then stops. It
runs three fresh OS processes at both 480×272 and 960×544 by default and
applies a stricter 45 ms QuickJS-plus-core CPU gate to every collected frame.
Use `COTTON_COLD_RUNS` to request more repetitions, and pin the wrapper with
`taskset` as shown above. This is the fast regression gate for Cotton-specific
cache work; the complete two-pass `verify:world-cache` remains the residency
and all-outdoor-map gate. See the [Cotton Town performance report](../findings/GP-COTTON.md)
for the attribution and reference measurements.

The J3 benchmark restores the production `hospital-cure` chapter snapshot,
then replays the 11 remaining J2 masks plus all 13,102 J3 masks (13,113 total).
It exercises
14 battles including Beaverbrook and checks the Radio Tower terminal hash at
both 480×272 and 960×544. This also keeps chapter restore honest in the
QuickJS guest, where browser-only globals such as `TextDecoder` do not exist.

The J4 benchmark restores the production `radio-broadcast` chapter snapshot,
replays the remaining 23 J3 masks and all 13,599 J4 masks (13,622 total),
exercises 15 battles including Kernel, and checks the complete-mainline
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

### Cold startup and Chinese first-open investigation

An interleaved five-process comparison at 480×272 isolates the localization
regression. Before the Chinese build (`e65dbdb`), English startup-to-first had
a 195.158 ms median. Immediately after localization (`a7f809e`), its median
was 233.433 ms. Median host initialization increased by 13.538 ms and QuickJS
compilation by 24.991 ms; together they account for almost all of the 38.275 ms
startup increase. The application-side engine, JSON-literal, battle-registration
and mount marks changed little.

The five Chinese startup documents now live as raw pak/data.fs entries rather
than shared JavaScript literals. An English boot does not read them. A Chinese
boot reads and parses them at the dedicated `language-data` stage, then caches
the result for the project, battle-name/runtime and text-token consumers. This removed
494,028 B from the desktop JavaScript bundle (2,866,673 B to 2,372,645 B).

The initial accepted fixed-CPU matrix used five fresh processes per cell. No
application prewarm or raised diagnostic limit was used:

| Language | Viewport | One-minute load, start → end | Startup-to-first median / worst |
| --- | --- | --- | ---: |
| en_US | 480×272 | 5.10 → 5.59 | 208.162 / 226.979 ms |
| en_US | 960×544 | 5.25 → 5.61 | 208.319 / 210.684 ms |
| zh_CN | 480×272 | 4.61 → 4.63 | 218.324 / 225.105 ms |
| zh_CN | 960×544 | 3.95 → 3.97 | 205.961 / 215.071 ms |

Every accepted sample is below 250 ms and every cell median is below 230 ms.

One retained English 960×544 attempt started at one-minute load 5.79 and
failed at 254.155 ms when its compile stage spiked to 152.299 ms. The gate
stopped before replay, the result was kept rather than overwritten, and no
diagnostic startup limit was used.

The earlier “first long-dialog” attribution was incorrect. On the Chinese
smoke tape, f1302 is the first text-modal open, f1358 is an ordinary idle
frame after entering downstairs, and f1446 is a background prefetch after
entering Paper Town. A nested 960×544 profile put 47.932 ms of a 50.452 ms
f1446 frame inside the repository load of `spyder_routec`; reducer, working-set,
release, signals and core work were all small. The Chinese import had bypassed
the English 128 KiB compact-decode cap. Applying the same hybrid rule leaves
260 compact and 3 canonical maps in each language and reduced a targeted
post-fix 960×544 f1446 sample to 4.145 ms. In that run the actual first modal,
f1302, was 1.848 ms including core; f1358 was 0.972 ms.

The same twenty processes enforce the 50 ms production-frame CPU limit across
the whole replay. Their per-process QuickJS-plus-core maxima summarize as:

| Language | Viewport | Median / worst whole-replay maximum |
| --- | --- | ---: |
| en_US | 480×272 | 18.625 / 24.802 ms |
| en_US | 960×544 | 18.374 / 19.728 ms |
| zh_CN | 480×272 | 17.927 / 20.999 ms |
| zh_CN | 960×544 | 19.061 / 26.879 ms |

Thus all five Chinese processes at each viewport keep every frame, including
f1302/f1358/f1446, below 50 ms. A targeted post-fix profile measures those
three 960×544 frames at 1.848, 0.972 and 4.145 ms respectively.

A post-merge release closure repeated the short English G6 and Chinese-smoke
tapes at both viewports with five fresh processes per cell, pinned to CPU 6.
The profile and budget overrides were unset and the normal 250/50 ms limits
were unchanged:

| Language | Viewport | One-minute load, start → end | CPU 6 idle, start → end | Startup median / worst | Replay-maximum CPU median / worst |
| --- | --- | --- | --- | ---: | ---: |
| en_US | 480×272 | 5.81 → 6.13 | 94.95% → 100.00% | 193.888 / 202.540 ms | 31.616 / 32.787 ms |
| en_US | 960×544 | 5.56 → 5.51 | 93.00% → 89.80% | 194.399 / 205.770 ms | 32.615 / 32.620 ms |
| zh_CN | 480×272 | 4.81 → 5.22 | 96.00% → 92.00% | 196.757 / 206.865 ms | 31.118 / 32.303 ms |
| zh_CN | 960×544 | 6.59 → 6.56 | 98.99% → 99.00% | 206.464 / 209.961 ms | 31.969 / 32.712 ms |

All 20 processes passed. The largest individual startup was 209.961 ms and the
largest production-frame CPU value was 32.787 ms. A separate English attempt
failed at 308.911 ms with CPU 6 only 58.42% idle. A separate Chinese attempt
passed three processes and then failed at 282.272 ms while closing I/O wait
reached 32.65%. Both failures remain in the raw record and neither used a
diagnostic startup override.

The tables above preserve the cold-start and Chinese-frame measurements. See
the [Cotton Town performance report](../findings/GP-COTTON.md) for the newer
outdoor-cache attribution, per-process measurements and compatibility gates.

## The tapes

A tape is a JSON document holding the input masks (one per 60 Hz frame), the
expected story variables, map checkpoints, battle checkpoints, and the
terminal state's SHA-256. The verifiers recompute the tape's own hash and
fail on any mismatch, so a silently corrupted tape is a red build.

| Tape | Frames | Route | Battles | Terminal |
|---|---:|---|---:|---|
| `data/g6-journey.json` | 3,500 | bedroom -> Paper Town -> first battle -> Route 1 | 1 | `spyder_route1 @14,19` |
| `data/gb6-mainline-journey.json` | 115,842 | Route 1 -> Cotton Town -> Paper Town -> Route 2 -> City Park -> Leather Center -> Route 3 -> Wayfarer Inn -> back to Route 3 | 111 (22 trainer, 89 wild) | `spyder_route3 @4,6` |
| `data/gb6-first-loss-journey.json` | 3,265 | the opening, deliberately losing the first Billie fight | 1 | `spyder_route1 @14,19` |
| `data/gb6-later-loss-journey.json` | 68,084 | the mainline prefix to Wanda, a deliberate loss, then the recovery path | 1 loss + prefix | `spyder_leather_town @23,10` |
| `data/j1-captainreturns-journey.json` | 12,876 (128,718 combined with GB6) | Wayfarer Inn -> Route 4 -> Flower City -> Route A -> Mansion -> basement -> the captain's return | 16 (10 trainer, 6 wild) | `spyder_mansion @1,13` |
| `data/j2-hospitalcure-journey.json` | 51,411 (180,129 combined) | Mansion -> Candy Town -> Greenwash -> hospital password -> the cure | 57 rows (50 player trainer, 6 player wild, 1 spectator) | `spyder_candy_hospital3 @5,7` |
| `data/j3-omnichannelradioannounce-journey.json` | 13,102 (193,231 combined) | hospital cure -> Paper Town -> Cotton Town -> Omnichannel floors 1–4 -> Radio Tower broadcast | 14 (13 trainer, 1 wild) | `spyder_radiotower @9,5` |
| `data/j4-kernelquestdone-journey.json` | 13,599 (206,830 combined) | Radio Tower -> Cotton Town briefing -> Surfboard -> Route E -> Route B -> Data Center -> Kernel | 15 (12 trainer, 3 wild) | `spyder_datacenter @7,4` |
| `data/zh-smoke-journey.json` | 3,189 | Chinese bedroom opening -> downstairs dialogue -> Paper Town -> first battle | 1 | `spyder_paper_town @26,9` |

The bill-terms change (char_run and bills) re-pinned both failure-path
terminals. Decoding the old and new terminal states of both tapes shows one
difference: the cathedral bill now carries `interestRate`, `lateFee` and
`shareRate`; its amount stays 0 and every other field is equal. On the
later-loss tape the Wanda battle's recorded end moved from frame 65,766 to
65,765 and the dialogs after it moved back by one or two frames; the tape's
total length and endpoint are unchanged. The cause of that one-frame shift
has not been traced.

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

## PSP emulator verification (manual, not CI)

`bun run verify:psp:emu` runs an already-built English PSP journey package
under PPSSPPHeadless (software renderer, 333 MHz) and verifies the terminal
state against the desktop replay. Build the package first with
`bun run build:psp --journey`. The gate needs a local PPSSPPHeadless build
(`HEADLESS_CROSS=1`; override the path with `PPSSPP_HEADLESS`).

The gate runs the bare `dist/psp/pocket-tuxemon.prx` (ELF), not
`EBOOT.PBP`: the journey `EBOOT.PBP` does not complete under PPSSPP
(cause not diagnosed — the SFO lacks `MEMSIZE`, yet PPSSPP grants ~46 MiB
arena in at least one PBP build, so the earlier 24 MiB / ~15 MiB OOM root
cause was withdrawn). A bare ELF takes the full PSP-2000 memory path
(arena ~46 MiB), matching what a `MEMSIZE=1` PARAM.SFO would give on real
PSP-2000+ hardware. The `.prx` is byte-identical to the PBP's `DATA.PSP`
section.

The gate prints PSP-side metrics from the host's bench JSONL: eval time,
frame intervals, slowest frames, arena high-water and QuickJS peak heap.
Env knobs: `PSP_EMU_TIMEOUT` (wall seconds, default 240), `PSP_EMU_MEMSTICK`
(isolated memstick dir).

### Mainline segments

`bun run build:psp --journey-segment=<chapter>` bakes a chapter save
envelope and a suffix of the concatenated mainline tape, so the full
GB6+J1+J2+J3+J4 mainline can run under the emulator in bounded chapter-to-
chapter pieces. The boot-snapshot overlay restores the chapter state and
corrects the frame to the chapter's global `timelineFrame` before replaying
the suffix. The build receipt's `journeySegment` block carries the chapter,
frame range, suffix length, snapshot/tape hashes, the desktop terminal pin
and the envelope itself; `bun tools/verify-psp-journey.ts <profile.jsonl>`
re-derives the pin from the committed tape and the receipt's envelope, then
compares it with both the receipt pin and the PSP terminal snapshot.
Available chapters are in `data/chapters.json`.

The three chapter windows longer than ~15,000 frames are split with
generated intermediate envelopes (deterministic desktop-replay snapshots in
`.psp-segments/`, not committed). `bun tools/psp-mainline.ts` orchestrates
the full 206,830-frame mainline as 28 bounded segments: `snapshots`
generates the intermediate envelopes, `build` builds and stashes all
segments, `run --jobs=4` runs up to 4 PPSSPPHeadless instances in parallel
(taskset affinity, isolated memsticks), verifies each terminal and collects
per-segment profile/bench/metrics into `reports/psp-mainline/`, and `report`
aggregates the high-waters. The runner is strict: a missing bench, an
incomplete bench window, a non-zero emulator exit, a verifier FAIL or a
PRX/receipt hash mismatch fails the segment, and any failed segment fails
the whole run. Each segment build bakes a single bench window covering the
boot frame plus the whole suffix, so the completed segments cover the whole
suffix (the rotating 300-frame windows lost every segment tail).

The full-run evidence (per-segment terminal hashes, wall times and bench
windows) is recorded in `findings/PSP-EMU.md`, and the latest rerun on the
minor-GC host (per-segment GC counts, totals, longest pause and residual
heap) in `findings/PSP-RERUN.md`. Segment
`06-cotton-town-a` previously hung when the PSP host stopped collecting
garbage once the arena's bump tail was spent and ran out of memory; the
PocketJS GC fix ("keep collecting once the arena's bump tail is spent")
resolved it, and the segment now reaches its desktop terminal. The
retained assets are content-addressed (a sha256-named store copy plus a
hardlink per segment), so the evidence tree is portable. `bun
tools/psp-mainline.ts verify` (no flags) is the four-way consistency gate:
retained PRX and assets.pak hash to their receipts, each receipt is bound
to its plan entry (segment id, chapter, start frame, window length and the
end boundary: `endFrame` equals the plan entry's end, `terminalFrame`
equals `endFrame`), the profile's newest session and its terminal match the
receipt's build/segment/frame and desktop pin (state compared
byte-for-byte), the bench window covers `[0, frames+1)`, and `metrics.json`
recomputes from the benches. The current run's verdict and per-segment
evidence are recorded in `findings/PSP-EMU.md`; the GC columns in
`metrics.json` and `psp-mainline report` come from the host bench's
`gc_count`/`gc_us`/`max_gc_us`/`qjs_live_bytes` fields. `--known-incomplete=<id>`
(or `--known-incomplete <id>`) tolerates a segment that ran but did not
finish (no terminal marker and/or no bench); it is fail-closed: an empty
id, an id outside the plan, a flagged segment that actually completed, or
any other bench/retention problem still fails.
The plan itself is guarded by independent invariants (28 segments, a fixed
id/chapter/start/end identity table, continuous coverage `[0, 206830)`, no
gap or overlap) enforced before plan/build/run/verify.

### PSP GC pauses

The PSP host's QuickJS is a personal fork (`lfkdsk/quickjs-rs`, based on
`pocket-nexus/quickjs-rs` `ba5bdd0`) that adds a generational ("minor")
collector; the collector branch has been proposed upstream. The host
promotes the loaded program and data at boot, then runs minor collections
(young list only). QuickJS's own size-based trigger never fires on this
host (`hosts/psp/src/gc_policy.rs`), so the frame loop decides: it collects
when the arena bump, or live bytes once the bump tail is spent, has grown
256 KiB since the last collection, and QuickJS also collects in the middle
of a frame once 8,000 young objects exist. A full `JS_RunGC` runs only when
the arena tail is spent and live bytes are high.
The latest 28-segment rerun measures the longest single GC pause at
**38.0 ms** (21-hospital-cure) and total GC time at **6,878.8 ms** over
867 collections, down from 152.5 ms / 45,359.5 ms / 520 collections with
the stock full-heap collector. The residual QuickJS live heap at segment
end is 11.5–23.4 MiB. `psp-mainline report` prints the per-segment GC
columns; the full table is in `findings/PSP-RERUN.md`.

### Same-moment captures

`bun tools/psp-capture.ts` renders six key shots (bedroom, Paper Town, the
first Billie battle, the Route 1 seam, Cotton Town, the radio-tower
segment) on both targets from the same chapter save and tape: `desktop`
renders through the sim host, `psp` builds a capture PRX and dumps the
framebuffer under PPSSPPHeadless. `bun tools/psp-capture.ts verify` checks
the PRX/receipt hash chain **and** the receipt's source provenance: a
capture built from a dirty worktree (non-empty `source.diffSha256` or
`changedFiles`) fails, and a capture whose source commit differs from HEAD
by artifact-affecting paths fails; commits drifting only by docs, reports,
findings, CI and top-level meta files are allowed. The captures and their
receipts live in `dist/captures/` (gitignored); the evidence log is in
`findings/PSP-EMU.md`.

## Goldens

`tests/goldens/` holds the keyframe PNGs (480x272 and 960x544) and the
gzipped battle trace fixtures. The golden tests assert exact PNG SHA-256, a
decoded-RGBA hash, per-opaque-pixel sprite matches at the reducer-derived
positions, and semantic colour-region counts per map. There is no tolerance:
a single differing pixel fails.

The Simplified-Chinese UI fixture also captures the localized save-success
and save-failure pages at both sizes. `bun run goldens:ui-text:zh` commits the
native-size PNGs and manifest hashes, and writes nearest-neighbour 3× review
copies to `dist/ui-text-zh-review/` for visual inspection; the 3× copies are
build artifacts and are not committed. Its test asserts the exact translated
title/body nodes and Chinese glyph masks in addition to the pixel hashes.

The GB6 route, J1, J4 and daylight tools share the checkpoint authority in
`tools/golden-sync.ts`. It verifies every segment's format, frame count, tape
hash, ancestry and traversal mode before replaying the pure reducer. At each
checkpoint it asserts the map, tile, reducer frame (`maskFrame + 1`),
world-idle state and saveability. The three long-tape generators encode that
validated state through the normal save contract, restore it into the built
production GameView, assert the restored map/tile/frame again, and only then
paint. This keeps the reducer-authored recording authoritative even when the
production UI paginates a dialog into more pages than the recorder did. The
short daylight capture still replays the production bundle to its G6 Paper
Town checkpoint, using the same tape identity and state expectations.

`bun run verify:goldens:sync` executes the shared tape and reducer checks for
all 11 checkpoints without booting the renderer or writing a manifest or PNG.
CI runs it as a journey-matrix leg. The regression test also shifts one real
checkpoint by one mask frame and requires the state assertion to reject it.

| Command | Regenerates |
|---|---|
| `bun run goldens:g6` | The four opening keyframes and `data/g6-goldens.json`, by re-driving the opening tape (it runs the recorder first, because the PNGs are only valid for the current tape). Also rewrites `data/g6-journey.json`. |
| `bun run goldens:gb5:battle` | The six battle scenes (menu, technique menu, hit, faint, level-up, capture shake) at both viewports, plus `data/gb5-battle-goldens.json` and the battle screenshot in `docs/`. |
| `bun run goldens:gb6:route` | The four mainline route keyframes at both viewports and `data/gb6-route-goldens.json`. |
| `bun run goldens:j1` | The three Captain-return keyframes at both viewports and `data/j1-goldens.json`. |
| `bun run goldens:j2` | The hospital-cure keyframes (Aardant acquired, hospital password, the cure) at both viewports and `data/j2-goldens.json`. |
| `bun run goldens:j3` | The Omnichannel wall, Radio Tower entry and completed broadcast at both viewports, plus `data/j3-goldens.json`. |
| `bun run goldens:j4` | The acquired Surfboard, Data Center terminal floor and completed Kernel quest at both viewports, plus `data/j4-goldens.json`. |
| `bun run goldens:world` | Phase 0–7 plus landing for one horizontal (a lane that upstream funnels to a fixed landing, now landing beside itself) and one vertical production handoff at both viewports, plus two contact sheets and `docs/screenshots/world-seam/manifest.json`. The manifest pins PNG/RGBA hashes, visible-map ownership, camera/player geometry and cache counts; the test also asserts no fade or black frame and correct player/upper-layer compositing. |
| `bun run goldens:preview-seam` | Six mainline seams with characters on one or both sides, at both viewports: handoff phase 0, the commit frame, the first target tick and 29 frames later, as one contact sheet per viewport plus `docs/screenshots/preview-seam/manifest.json`. The generator and the test check that every far-side character is already painted where the first target tick puts it and that the characters of the map left behind stay frozen. In every frame, each character the session state puts on screen (the source map's own, the far side's, the frozen ones behind, the live ones after the crossing) must be found at its rect against the sprite image the renderer uses, and a scan of every pixel position finds no copy of any of those sprites anywhere else, so a dropped, doubled or ghost character fails (`tools/preview-seam-plan.ts`; the test also stamps and erases characters on the committed sheets to prove it). |
| `bun run goldens:daylight` | The same Paper Town checkpoint at fixed 09:00 and 21:00 starts, plus `data/daylight-goldens.json`. The test recomputes luminance, blue bias and per-pixel day/night differences from the decoded PNGs. |

Regenerate goldens only when the rendering change is intentional, and always
run `bun run verify:goldens:sync`, open every regenerated PNG at an enlarged
scale and look at it. A hash pins the bytes; it cannot tell a correct picture
from a consistently wrong one. Compare changed images with the previous
version as well as checking their map, player and landmark semantics. Several
past rendering bugs (a same-tick resize that only extended black borders, a
wrong depth composite) were caught by eye, not by the assertions.

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
