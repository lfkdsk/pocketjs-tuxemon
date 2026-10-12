# Battle music lifecycle

## Result

Battle music is now part of the real battle lifecycle. Imported trainer,
scripted-wild, random-wild, spectator, and title-mode battles select their
opening cue from the imported data; player victories and defeats project the
corresponding result cue; leaving the scene atomically restores the complete
pre-battle map mix. The feature works through the reducer, the production
audio driver, the web AudioWorklet, the desktop QuickJS host, and the PSP
release package.

The final behavior deliberately improves one upstream edge case. Tuxemon's
single `previous_song` slot is overwritten by the result cue, so a normal
map → battle → result sequence can briefly restore the battle cue before a
map event restarts the correct map cue from the beginning. RPG Kit instead
keeps an independent snapshot of the map mix and resumes it from its frozen
position. This is an intentional repair of the upstream restoration bug, not
a claim of byte-for-byte mixer implementation parity.

No map/project schema change or PocketJS patch was required. The component
API is additive and opt-in; projects that do not return battle audio retain
the former behavior and skip the new projection path.

## Revisions and integration order

- Game baseline: `35a2af17d0f1563a2fe53b019596efeab3db4a68`.
- Game implementation tree: `580802156babf9f6ee06bad5870c10a4a6f3c1c0`.
- RPG Kit baseline: `7391af94c7aa1a14f82274d96a58562213c9d6f9`.
- RPG Kit delivery: `7e34d5480d8ec4af8a6333a1c4e9af6098d6189c`.
- PocketJS remains `862040bd77edc49b1f815beff63952b6616a14c6`.
- Tuxemon source remains `9e6258ff726b786040a267e8bdbbf037b560285e`.

The component commit must land first, followed by the game commit that updates
the `vendor/pocket-rpgkit` pointer. All delivery commits are authored by
`lfkdsk <lfkdsk@gmail.com>` and contain no co-author footer.

## Upstream semantic audit

The source model makes environment battle music a required three-cue set and
NPC music an optional complete set (`tuxemon/db.py:2140-2144,
2383-2399`). `NPC.get_active_battle_music` replaces the complete environment
set when the NPC authors one (`tuxemon/entity/npc.py:343-348`); it is not a
per-cue merge. Outcome selection applies that complete override and chooses
defeat for a defeated player or victory for a defeated opponent
(`tuxemon/combat/utils.py:127-155`, called at
`tuxemon/states/combat_state.py:1267-1273`).

The upstream opening actions themselves use the environment cue directly:
trainer battles at `tuxemon/event/actions/start_battle.py:87-90` and random
encounters at `tuxemon/event/actions/random_encounter.py:133-137` (the other
wild/double entry actions have the same shape). Applying NPC > environment to
the opening cue is therefore the task's requested consistency enhancement;
it is stricter than the current upstream entry implementation while matching
the upstream outcome helper.

Missing non-null music slugs are rejected by upstream's `MusicProperties`
validator (`tuxemon/db.py:635-645`). The importer follows that lookup behavior
and additionally rejects a valid upstream slug that is absent from the
package, because silently accepting an unshippable cue would defer the failure
until playback.

### Restoration difference

Upstream `MusicPlayer.play` assigns `previous_song = current_song` on every
cue change (`tuxemon/audio.py:47-73`). Battle completion stops the current cue
(`tuxemon/states/combat_state.py:1056-1065`), and fade shutdown plays that
single previous slot (`tuxemon/states/transition_fade.py:96-102`). After
A(map) → B(battle) → V(result), the slot contains B, not A. A later map
`not music_playing A` event can correct the cue, but it restarts A.

The upstream `music_playing` condition also returns true for every requested
slug while CombatState/FlashTransition is active or music is paused
(`tuxemon/event/conditions/music_playing.py:30-44`). In this port the map
interpreter is suspended while a battle scene owns the reducer, so authored
map guards cannot observe an intermediate battle/result cue. At scene exit
they observe the restored map state. Existing imported `fadeout_music`
semantics are unchanged; battle restoration does not route through or mutate
an authored map fade.

## Import and runtime implementation

### Complete data import

`importer/battle.ts:306-342` validates all three fields, preserves explicit
`null` as authored silence, resolves each non-null slug through both the
upstream music table and packaged logical ids, and emits actionable errors for
missing or unpackaged tracks. `importer/battle.ts:451-464` scans every
environment and every NPC record independently of battle-art scope. The
generated schema stores one complete environment set and one complete NPC
override set (`importer/battle-schema.ts:64-79`).

The pinned source produces:

| Scope | Sets | Resolved cues | Silent cues |
|---|---:|---:|---:|
| environments | 40 | 120 | 0 |
| NPC complete overrides | 0 | 0 | 0 |
| unique packaged tracks | — | 3 | — |

The three logical ids are `music_battle_loop`,
`music_win_battle_boss`, and `music_gameover`. The current source simply has
no NPC that authors `audio.battle_music`; the generic scan, complete-set
schema, synthetic override test, and failure tests remain in place so a future
upstream override cannot silently bypass validation. Both English and Chinese
generated databases carry the same catalog. `reports/G1-coverage.md` and its
Chinese counterpart record these counts and the rejection policy.

### Selection and scene ownership

`battle/runtime.ts:462-475` implements one selection point: trainer and
spectator opponents use a complete NPC override when present, otherwise the
resolved environment; wild and random encounters use the environment. The
chosen set is serialized into the battle state, making result selection
deterministic under save snapshots, rewind, replay, and different host frame
rates. Battle start returns its battle cue (`battle/runtime.ts:1261-1265`),
while the optional rules projection publishes victory or defeat after the
outcome is known (`battle/runtime.ts:1377-1383`).

RPG Kit's optional `BattleStart.audio` clones the entire pre-battle
`AudioState` into `scene.returnAudio`, and optional `BattleRules.audio(state)`
may replace the scene-owned cue without overwriting that snapshot
(`vendor/pocket-rpgkit/src/engine/session.ts:1947-1964,2248-2256`). Completion
restores a fresh clone in one reducer step. BGM, BGS, ME, saved BGM, fades,
volume, pitch, pause flags, and playback positions therefore return together,
not merely the track id.

Title Battle mode uses the same production rules and imported candidates. It
copies the campaign snapshot into a disposable battle state, installs the
battle cue and return mix, allows the result projection to play, then replaces
the temporary state with the exact original campaign object
(`ui/title-battle-runtime.ts:175-224,329-334`). The title battle consumes
neither campaign RNG nor campaign audio position.

### Native streaming and restoration

The audio driver retains the suspended map QOA stream and its decoded ring
instead of destroying and re-decoding it at battle exit. Result cues may
replace battle cues without touching the suspended stream; sound-effect
pressure no longer evicts it; a staged resource can be retried in place after
its QOA page arrives. Map playback resumes at the reducer's frozen
`positionTicks`, aligned to the retained native stream.

Desktop sidecar reads remain bounded to one QOA page per host frame. A final
race audit found that the world-cache driver reported audio idle as busy for
the whole battle, starving battle and victory pages. The coordinator now
forbids I/O on the scene-change frame, then treats the parked world cache as
available on stable battle/result frames. The regression test holds the world
cache busy for the full scene and proves that the next stable frame still
pumps one page (`tests/desktop-audio-loader.test.ts`).

## Save, rewind, demo, and terminal state

Active battle saves remain intentionally refused with an explicit battle
reason. A safe map save preserves its audio state; after load, entering and
finishing the same real imported trainer battle produces the same
battle/victory sequence and canonical final state
(`tests/battle-audio-lifecycle.test.ts:149-194`). This satisfies the
“if allowed” condition without introducing a partially specified active-scene
save format.

The component suite covers the complete suspended mix, result projection,
atomic restoration, silence, legacy omission, transfer-on-completion, malformed
tracks, and immutable battle states at 60/30/20/4 Hz
(`vendor/pocket-rpgkit/tests/audio-state.test.ts:454-649`). Existing attract
rewind tests restore the reference-tick audio position, and the native driver
rebuilds streams while suppressing historical one-shot cues. Chapter and
autoplay verification replay the production battle paths rather than
manufacturing reducer-only audio states.

A browser slot generated by unmodified current main at frame 26 on
`spyder_paper_scoop@4,8` loads on this build, consumes the next 257 maintained
inputs, and reaches frame 283 with canonical state
`c28d67db2df3bcb77cba058de030e0d2ee1d81c63b00392598347450770077f5`.
Mixed or foreign manifest/schema identities remain rejected.

The 115,842-frame GB6 tape ends on main and candidate at the identical
canonical terminal SHA-256
`fa4a55f281b94f8c2eeb3f157d432c33746ef97cd7fa7463b4ca9edc4a7184a0`.
Recursive comparison has zero differing fields. Music changes are transient:
battle/result checkpoints now contain the owned cue, but scene completion
restores the map state before the terminal snapshot, so no terminal pin change
is required. Both maintained defeat/recovery tapes, all chapter snapshots,
save continuation, L-trigger rewind/refold, and the built-world replay pass.

## Host verification

### Web

`bun run verify:web:audio` drives a real imported trainer battle inside headless
Chrome and inspects the production realtime AudioWorklet, not a reducer mock.

| Cue | Accepted frames | Non-zero samples | Peak | Underruns |
|---|---:|---:|---:|---:|
| battle | 19,029 | 19,023 | 15,794 | 0 |
| victory | 16,384 | 15,526 | 17,815 | 0 |

Both streams were 22,050 Hz mono. The observed lifecycle was
`music_town_theme → battle → victory → music_town_theme`; the realtime context
was running, an AudioWorklet node existed, and Chrome reported no console or
page errors.

### Desktop

`bun run verify:desktop:audio` builds the production Linux application and
replays all 115,842 GB6 frames under its native QuickJS host. Across 111 battle
entries, the probe observed 111 battle plays and 109 victory plays:

| Cue | Accepted frames | Non-zero samples | Plays |
|---|---:|---:|---:|
| battle | 2,067,968 | 2,067,310 | 111 |
| victory | 1,870,848 | 1,838,412 | 109 |

The native device clock credited 2,947,098 frames, reported zero underruns,
and restored `music_the_wild_places`. This machine has no ALSA playback device,
so the production host used its clocked silent sink: the check proves native
load/decode/mix/ring consumption and timing, but does not claim a physical
speaker measurement.

### PSP

The full PSP release was rebuilt from the final implementation tree. Its
receipt records clean game/component/PocketJS inputs and these external QOA
entries:

| Cue | Packaged bytes |
|---|---:|
| `music_battle_loop` | 828,160 |
| `music_win_battle_boss` | 109,024 |
| `music_gameover` | 78,248 |

The final package contains a 5,634,772-byte `EBOOT.PBP`, a 5,634,440-byte PRX,
and a 67,191,712-byte external asset pack. External-index verification opens
each indexed payload and checks its exact byte span. PPSSPPHeadless is fixed to
silent fast-forward in this environment, so its underrun behavior is not used
as evidence of physical PSP speaker output; package integrity, the production
PSP build, and the shared QOA/native audio contract are the available local
host evidence. Its dedicated journey build nevertheless completed 3,500 frames
at `spyder_route1@14,19`, accepted 5,646,336 battle and 1,727,488 victory PCM
frames with non-zero samples, and matched terminal hash
`d4add57567f04b5b12b7ef3ebd8cbfeac3fdb33009d89f0ef28b9ebc6a80cdf9`.

## Mutation sensitivity

All three required mutants ran in isolated copies; the delivery worktrees were
never edited for mutation testing.

| Mutation | Required red result |
|---|---|
| reverse NPC/environment priority | the real runtime selection test expected the NPC battle cue and received the environment cue |
| swap victory and defeat projections | the outcome test expected the NPC victory cue and received its defeat cue |
| omit map restoration on scene completion | the lifecycle test retained the result cue instead of the frozen map mix |

Each mutant failed its focused test. Restoring the unmodified code made the
same focused suites and the complete suites green.

## QuickJS performance

Measurements used the production desktop QuickJS host pinned to CPU 31, with
no tests or agents running concurrently. The order was main → candidate →
candidate → main; every run folded the same 115,842 frames and ended at the
same canonical terminal hash.

| Metric | Main mean | Candidate mean | Delta |
|---|---:|---:|---:|
| cold boot | 225.756 ms | 233.325 ms | +3.35% (+7.569 ms) |
| battle-entry frame, mean across 111/run | 9.463 ms | 9.754 ms | +3.08% (+0.292 ms) |
| battle-entry maximum, mean of run maxima | 16.157 ms | 16.194 ms | +0.24% (+0.038 ms) |
| battle-exit frame, mean across 111/run | 5.761 ms | 5.395 ms | -6.36% (-0.367 ms) |
| battle-exit maximum, mean of run maxima | 18.188 ms | 9.303 ms | -48.85% (-8.884 ms) |
| global QuickJS/core maximum, mean of runs | 41.284 ms | 33.699 ms | -18.37% (-7.585 ms) |

The candidate's worst individual relevant frames were a 16.223 ms battle entry
and a 9.792 ms battle exit. All four actual QuickJS/core maxima and every
battle entry/exit stayed below the normal 50 ms frame budget. The harness used
a 100 ms abort threshold only so unrelated shared-host idle spikes would not
discard another complete run; it masked no measured violation. The small mean
entry cost is the intended reducer/audio ownership work and is not a decode or
filesystem spike. Retaining and pre-filling the suspended stream removes the
former exit decode spike.

The separate RPG Kit opt-out bench ran two complete ABBA rounds against the
latest component base and confirms unused projects remain on the zero-call
path:

| Opt-out case | Paired mean delta |
|---|---:|
| `sunstoneIdle` | +0.89% |
| `sunstoneWalk` | -0.27% |
| `sunstoneControlWalk` | +0.33% |
| `streamedRoam` | +0.01% |
| `battleScene` | +1.04% |
| `sunstoneIdleImmutable` | +1.33% |
| `sunstoneControlWalkImmutable` | +0.83% |
| `battleSceneImmutable` | +2.65% |

Every aggregate regression remains below the required 3% ceiling.

## Reproducibility and gates

Two complete imports from the pinned source left no tracked difference. The
generated battle catalog, coverage reports, chapter assets, tapes, and package
indexes are importer/tool output rather than hand-edited generated data.

| Gate | Result |
|---|---|
| `bunx tsc --noEmit`, standard build, PocketJS wasm | PASS |
| import twice / isolated determinism / localization / CJK | PASS |
| game CI importer group | PASS — 53 tests |
| game CI replay group | PASS — 12 tests |
| game CI locks, battle data, and terrain group | PASS — 22 tests |
| game CI rest a–l | PASS — 618 tests |
| game CI rest m–z | PASS — 579 tests |
| all game CI test groups | PASS — 1,284 tests, 0 failures |
| all 16 journey matrix commands | PASS |
| current-main save load, resave, and continuation | PASS |
| web build, English/Chinese/demo journeys, AudioWorklet | PASS |
| full desktop native audio replay | PASS |
| PSP snapshots, emulator journey, and final release build | PASS |
| RPG Kit full suite | PASS — 4,008 passed, 347 skipped, 0 failed |
| RPG Kit unused-feature QuickJS ABBA | PASS |

No visual node or PNG changed, so no new screenshot golden was warranted.
Existing bilingual/two-resolution visual and semantic-pixel suites remain
green. `docs/status.md` now marks Music Done and points to battle/result/map
restoration; RPG Kit's status and engine documentation describe the additive
battle-audio ownership API. `bun.lock` is unchanged, `git diff --check` passes,
and the implementation worktrees are clean.

subagent 使用：3 / 上游语义、游戏架构、宿主验证面 / 节省了并行调查时间
PASS
