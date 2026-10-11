# Remaining event-action import report

## Result

The importer now gives exact authored-campaign semantics to the three action
families that could be made Native without hiding an observable difference:

- all 149 `translated_dialog_choice` uses are one scrollable 2–8 row choice,
  and cancel closes the menu without writing the destination variable;
- all 7 `load_yaml` uses expose the appended event set on the following world
  update, not later in the same interpreter fold;
- all 8 authored `quarantine` uses reproduce the reachable party, hidden-box,
  inoculation, release, and full-Kennel behavior.

That moves 25 action uses from Degraded to Native. No component-repository,
PocketJS, project-schema, or save-envelope change was needed. Observable timing,
UI, or state gaps remain Degraded; provably inert or non-materialized source
content remains Dropped. In particular, this work does **not** relabel
`char_face`, player/self `char_move`, `add_tracker`, `access_pc`, or
`set_tuxepedia` as exact.

All functional and platform checks pass. The interleaved QuickJS comparison
shows no startup, first-frame CPU, or heap regression. The formal 250 ms cold
startup command did not complete either baseline or candidate at both
viewports under the observed shared load, so this report does not call the
absolute startup gate green; the complete diagnostic ABBA comparison is
reported separately below.

## Coverage before and after

The baseline is game commit `f9db784a`; both columns use conversion-path
accounting over the same pinned Tuxemon source.

| Kind | Total | Baseline Native | Baseline Degraded | Baseline Dropped | Current Native | Current Degraded | Current Dropped |
|---|---:|---:|---:|---:|---:|---:|---:|
| Actions | 13,617 | 13,121 (96.4%) | 242 | 254 | 13,146 (96.5%) | 217 | 254 |
| Conditions | 8,663 | 8,423 (97.2%) | 21 | 219 | 8,423 (97.2%) | 21 | 219 |

Executable coverage (Native + Degraded) is unchanged at 13,363 / 13,617
(98.1%) actions and 8,444 / 8,663 (97.5%) conditions. The improvement is a
semantic promotion, not newly invented output. There are no Placeholder uses.

| Source action | Baseline | Current | Delta |
|---|---:|---:|---:|
| `translated_dialog_choice` | 139 Native / 10 Degraded | 149 Native | +10 Native |
| `load_yaml` | 0 Native / 7 Degraded | 7 Native | +7 Native |
| `quarantine` | 0 Native / 8 Degraded | 8 Native | +8 Native |

The generated report is deterministic across two isolated roots: 4,780 files,
67,446,630 bytes, aggregate SHA-256
`c35f05eea1892c5a7f69de6427055f6a2020188c0cb66bab9ac64c4eb5a4cb4d`.

## Native conversions and real-map tests

### Flat translated choices

Upstream splits every colon-delimited row, builds one menu, writes only in a
row callback, and opens it with `escape_key_exits=True`
(`tuxemon/event/actions/translated_dialog_choice.py:42-64`). The importer now
emits one native `choices` command with all rows, 64-character labels, and an
empty cancel branch. The real Candy Hospital passcode event supplies eight
rows (`mods/tuxemon/maps/spyder_candy_hospital1.tmx:354-360`). Its test reaches
the imported event, scrolls to the eighth row, verifies the enum write, then
reopens and verifies that cancel writes nothing
(`tests/remaining-event-actions.test.ts:26-69`).

### Next-update `load_yaml`

Upstream appends only new named events and inits
(`tuxemon/event/actions/load_yaml.py:38-64`). The event engine snapshots both
lists before processing conditions (`tuxemon/event/eventengine.py:188-201`) and
only then advances running actions (`tuxemon/event/eventengine.py:182-186`), so
newly loaded pages cannot start until the next update. The importer therefore
emits a 1/60-second yield before opening the synthetic loaded-YAML gate
(`importer/project.ts:3223-3240`). The real Flower Center `Create Nurse` event
loads `spyder_cathedral` (`mods/tuxemon/maps/spyder_flower_center.yaml:1-8`);
the test proves the gate is closed on update one and its appended refusal page
runs on update two (`tests/remaining-event-actions.test.ts:71-101`).

### Authored quarantine flows

Upstream inoculates matching monsters before transfer, uses a hidden
capacity-30 quarantine box, returns released monsters to the party when
possible, and otherwise moves them to the normal Kennel
(`tuxemon/event/actions/quarantine.py:47-120`). All eight authored calls are
one-shot player flows. Both admissions share the `confiscation_done` guard and
can move at most the six-member party; releases are bounded by the box contents.
The imported extension already matched every reachable branch, including a
full party and a full Kennel appending member 31. The disposition is now Native
for those authored calls (`importer/project.ts:4193-4205`). The real Garvan
dialogue drives the full-Kennel branch and survives save/load
(`tests/covb-monster-mechanics.test.ts:401-451`).

The generic extension still deliberately refuses one externally manufactured
state: admitting into an already-full preferred box does not rename/merge that
box into a visible successor. That state cannot be authored by this campaign,
so the action-use coverage is Native while the broader feature remains marked
Partial in `docs/status.md`.

### Random monsters and title-only drops

`random_monster` filters the database by positive id, `randomly`, evolution
level, and minimum form level, then makes one random choice and delegates to
`add_monster` (`tuxemon/event/actions/random_monster.py:51-81`). The nine
materialized campaign-map calls were already Native. A new test reaches the
real Eclipse Bank trainer trigger and verifies one deterministic level-40
opponent, both modifiers, and RNG advancement
(`tests/covb-monster-mechanics.test.ts:655-698`). The remaining 30 calls belong
to `battle_menu.yaml`, which is Battle-mode/title orchestration rather than a
campaign map; no imported map materializes them. The same scope fact explains
all three dropped `quit_world` calls. They remain Dropped rather than being
misrepresented as implemented campaign behavior.

### Mutation checks

Each mutation was made in an isolated copy; the reviewed worktree was never
edited for mutation testing.

| Native claim | Isolated mutation | Test that killed it |
|---|---|---|
| one flat choice contains every authored row | truncate the generated option list before row 8 | the real passcode test no longer sees eight options and cannot select `..---` |
| loaded pages first appear on the next update | remove the emitted 1/60-second wait | the first-update assertion sees the loaded gate opened instead of zero |
| full-Kennel release preserves upstream overflow | clamp the destination Kennel to its ordinary capacity | the real Garvan path no longer produces/saves Kennel member 31 |

The unmutated focused tests pass inside the authoritative 1,246-test run below.

## Remaining Degraded and Dropped audit

This is the exhaustive post-change list: 28 action types and 18 condition keys.
`N/D/X` means Native / Degraded / Dropped source uses. Rows are ordered by
player impact, then by reachability. Paths in the evidence column are relative
to pinned Tuxemon `9e6258ff`.

| Priority | Kind | N / D / X | Player-visible impact and exact reason | Upstream evidence |
|---:|---|---:|---|---|
| P1 | Action `transition_teleport` | 1042 / 3 / 4 | Three bad authored destinations are clamped and, if needed, repaired by deterministic nearest-walkable BFS, so the landing differs from the impossible raw coordinate. Four pages are provably inert because of invalid `top`/`bottom` guards or a zero-area event. | `tuxemon/event/actions/transition_teleport.py:48`; sample `mods/tuxemon/maps/mansion.tmx:85` |
| P1 | Action `translated_dialog` | 2063 / 1 / 4 | One post-faint notice runs on the destination map rather than the old map during transfer. Four dialogs are behind fixed-false unsupported-state/input guards. | `tuxemon/event/actions/translated_dialog.py:65`; sample `mods/tuxemon/maps/water_underwater.tmx:252` |
| P1 | Action `add_item` | 117 / 0 / 1 | The dropped call targets an NPC combat bag; it cannot mutate the player's inventory and NPC bag state is battle-only in this port. | `tuxemon/event/actions/add_item.py:40`; sample `mods/tuxemon/maps/eclipse_park_cave.yaml:32` |
| P1 | Action `access_pc` | 0 / 10 / 0 | Campaign monster storage and the item locker work, but the upstream always-visible Multiplayer placeholder row is omitted. No campaign PC has email content. The difference is visible in the PC menu, so the calls remain Degraded. | `tuxemon/event/actions/access_pc.py:57-90`; sample `mods/tuxemon/maps/bedroom_test.tmx:58` |
| P2 | Action `char_face` | 1889 / 124 / 14 | Player/self routes apply facing on the next movement tick while upstream sets it immediately (or places it on the transition apex). Invalid source directions, old-map fade actions, inert pages, zero-area pages, and missing targets account for the drops. | `tuxemon/event/actions/char_face.py:38-65`; sample `mods/tuxemon/maps/mansion.tmx:86` |
| P2 | Action `wait` | 436 / 0 / 5 | Five waits are in pages that never start or on the abandoned side of a map fade; emitting them would create time where upstream has no running map event. | `tuxemon/event/actions/wait.py:33`; sample `mods/tuxemon/maps/spyder_cotton_cafe.tmx:247` |
| P2 | Condition `is char_facing` | 995 / 9 / 4 | The repaired Route 3 typo and specialized Surf pages preserve playability but are not literal guard equivalence. Invalid `top`/`bottom` and zero-area pages are fixed false. | `tuxemon/event/conditions/char_facing.py:34`; sample `mods/tuxemon/maps/mansion.tmx:88` |
| P2 | Action `char_wander` | 32 / 0 / 1 | One source page addresses an NPC that the map never spawns, so no walker can visibly wander. | `tuxemon/event/actions/char_wander.py:49`; sample `mods/tuxemon/maps/37707_town_missing.tmx:344` |
| P2 | Action `open_journal` | 0 / 14 / 0 | The calls open a read-only imported Tuxepedia detail scene; upstream journal counters/removal and NPC-owned journal state are not retained. | `tuxemon/event/actions/open_journal.py:38`; sample `mods/tuxemon/maps/eclipse_lion_mountain_middle.yaml:170` |
| P2 | Action `char_move` | 64 / 13 / 0 | Arbitrary-NPC blocking routes are exact. Nine player/self routes begin on the next movement tick rather than immediately; four Surf moves are absorbed into shoreline geometry. The timing/representation difference remains observable. | `tuxemon/event/actions/char_move.py:50-88`; sample `mods/tuxemon/maps/cotton_town.tmx:298` |
| P2 | Action `set_tuxepedia` | 0 / 6 / 0 | Persistent player `seen`/`caught` state is kept, but repeat counters, removal, and NPC journals are not, so generic upstream state is not equivalent. | `tuxemon/event/actions/set_tuxepedia.py:40-60`; sample `mods/tuxemon/maps/spyder_dojo4.tmx:130` |
| P2 | Condition `not char_in` | 0 / 6 / 0 | Specialized Surf boundary pages preserve the shared item prompt, movement, appearance, and dismount flow rather than exposing the literal rectangle predicate. | `tuxemon/event/conditions/char_in.py:35`; sample `mods/tuxemon/maps/spyder.yaml:76` |
| P2 | Condition `is char_facing_tile` | 339 / 5 / 0 | Five labelled surface checks are compiled into the same specialized Surf boundary flow; ordinary facing-tile checks are Native. | `tuxemon/event/conditions/char_facing_tile.py:38`; sample `mods/tuxemon/maps/37707_tower.tmx:71` |
| P2 | Action `set_template` | 22 / 2 / 0 | Two template changes are absorbed into specialized Surf appearance/geometry handling rather than executing as standalone template writes. | `tuxemon/event/actions/set_template.py:57`; sample `mods/tuxemon/maps/spyder_candy_cafe.yaml:97` |
| P2 | Condition `is char_in` | 0 / 1 / 0 | The sole positive rectangle check is part of the specialized Surf boundary page, with the same representation gap as the negative checks. | `tuxemon/event/conditions/char_in.py:35`; sample `mods/tuxemon/maps/spyder.yaml:211` |
| P3 | Condition `is current_state` | 72 / 0 / 6 | Six checks are title/combat/menu/teleporter orchestration that cannot run as campaign-map fibers; they have no reachable campaign effect. | `tuxemon/event/conditions/current_state.py:33`; sample `mods/tuxemon/maps/battle_menu.yaml:49` |
| P3 | Condition `is party_size` | 47 / 0 / 3 | Three uses sit in the same non-materialized battle-menu state machine; campaign party-size guards are Native. | `tuxemon/event/conditions/party_size.py:39`; sample `mods/tuxemon/maps/battle_menu.yaml:25` |
| P3 | Action `get_pending_moves` | 0 / 0 / 2 | Both calls are move-learning UI orchestration behind fixed-false non-world state; no campaign map can trigger them. | `tuxemon/event/actions/get_pending_moves.py:74`; sample `mods/tuxemon/maps/xero.yaml:5` |
| P3 | Action `remove_tech` | 0 / 0 / 2 | Both calls are paired with the non-world pending-moves screen above and are unreachable from imported maps. | `tuxemon/event/actions/remove_tech.py:44`; sample `mods/tuxemon/maps/xero.yaml:6` |
| P3 | Action `set_party_status` | 1 / 0 / 1 | The one campaign use is Native; the dropped use is guarded by a combat/menu state that does not execute map fibers. | `tuxemon/event/actions/set_party_status.py:33`; sample `mods/tuxemon/maps/spyder.yaml:195` |
| P3 | Condition `is check_max_tech` | 1 / 0 / 1 | The dropped check belongs to the same non-world move-learning screen. | `tuxemon/event/conditions/check_max_tech.py:47`; sample `mods/tuxemon/maps/xero.yaml:8` |
| P3 | Condition `is cooldown_days` | 0 / 0 / 1 | P1 has no generic elapsed-day status clock for a monster; the sole page therefore has a fixed answer instead of fabricating mutable meta state. | `tuxemon/event/conditions/cooldown_days.py:31`; sample `mods/tuxemon/maps/spyder_candy_town.tmx:335` |
| P3 | Action `add_tracker` | 0 / 24 / 0 | The persistent visited switch used by authored guards is saved, but the NuPhone GPS map and its visited/known-location presentation are not imported. Players cannot inspect the tracker UI. | `tuxemon/event/actions/add_tracker.py:44-58`; sample `mods/tuxemon/maps/spyder_candy_town.tmx:216` |
| P3 | Action `change_bg` | 6 / 9 / 0 | The backdrop is visible and blocking, but a later covering modal is retained rather than popped exactly as upstream's state stack would. | `tuxemon/event/actions/change_bg.py:54`; sample `mods/tuxemon/maps/player_house_bedroom.yaml:34` |
| P3 | Action `change_bg_monster` | 0 / 7 / 0 | Monster front art is centered on the backdrop, but the same state-stack pop difference remains. | `tuxemon/event/actions/change_bg_monster.py:50`; sample `mods/tuxemon/maps/player_house_bedroom.yaml:21` |
| P3 | Action `change_bg_char` | 0 / 4 / 0 | Character combat-sheet front art is visible on the backdrop, but the same state-stack pop difference remains. | `tuxemon/event/actions/change_bg_char.py:57`; sample `mods/tuxemon/maps/player_house_bedroom.yaml:45` |
| P4 | Action `create_npc` | 1328 / 0 / 175 | All 175 drops belong to source events that no imported campaign map materializes, chiefly title Battle mode; there is no reachable missing NPC. | `tuxemon/event/actions/create_npc.py:55`; sample `mods/tuxemon/maps/battle_menu.yaml:16` |
| P4 | Condition `not char_exists` | 1225 / 0 / 175 | These are the guards paired with the non-materialized NPC creation pages above. | `tuxemon/event/conditions/char_exists.py:29`; sample `mods/tuxemon/maps/battle_menu.yaml:18` |
| P4 | Action `random_monster` | 9 / 0 / 30 | Nine campaign calls are Native and tested on Eclipse Bank. Thirty drops are difficulty setup in non-materialized title Battle mode, so campaign players cannot trigger them. | `tuxemon/event/actions/random_monster.py:51`; sample `mods/tuxemon/maps/battle_menu.yaml:53` |
| P4 | Action `set_variable` | 709 / 0 / 6 | Five title Battle-mode writes are not materialized; one underwater page uses `K_RETURN`, which is not a valid Tuxemon intention and is fixed false. | `tuxemon/event/actions/set_variable.py:39`; sample `mods/tuxemon/maps/battle_menu.yaml:55` |
| P4 | Condition `is char_exists` | 3 / 0 / 6 | Six title Battle-mode guards have no materialized source event. | `tuxemon/event/conditions/char_exists.py:29`; sample `mods/tuxemon/maps/battle_menu.yaml:58` |
| P4 | Condition `not variable_set` | 665 / 0 / 6 | Five title Battle-mode guards are not materialized; one is under the fixed-false `K_RETURN` page. | `tuxemon/event/conditions/variable_set.py:45`; sample `mods/tuxemon/maps/battle_menu.yaml:59` |
| P4 | Condition `is variable_set` | 725 / 0 / 5 | All five drops are title Battle-mode guards with no imported map fiber. | `tuxemon/event/conditions/variable_set.py:45`; sample `mods/tuxemon/maps/battle_menu.yaml:57` |
| P4 | Condition `is char_at` | 1807 / 0 / 4 | The four drops are behind invalid `top`/`bottom` facing or a zero-area event whose integer tile boundary contains no point. | `tuxemon/event/conditions/char_at.py:33`; sample `mods/tuxemon/maps/mansion.tmx:87` |
| P4 | Action `quit_world` | 0 / 0 / 3 | All three calls are title Battle-mode post-result control and no campaign map materializes them. | `tuxemon/event/actions/quit_world.py:31`; sample `mods/tuxemon/maps/battle_menu.yaml:46` |
| P4 | Condition `is battle_outcome` | 227 / 0 / 3 | Campaign outcome branches are Native; the three drops are the non-materialized title Battle-mode result page. | `tuxemon/event/conditions/battle_outcome.py:41`; sample `mods/tuxemon/maps/battle_menu.yaml:48` |
| P4 | Condition `not char_defeated` | 179 / 0 / 2 | Both drops guard title Battle-mode trainer creation and cannot run on a campaign map. | `tuxemon/event/conditions/char_defeated.py:33`; sample `mods/tuxemon/maps/battle_menu.yaml:27` |
| P4 | Action `not` | 0 / 0 / 1 | `not` is not an upstream action handler at all; it appears in an event with neither conditions nor behavior, which upstream never starts. | `tuxemon/event/eventaction.py:301` (no handler); sample `mods/tuxemon/maps/taba_ba_stairwell_2.tmx:52` |
| P4 | Action `play_music` | 199 / 0 / 1 | The sole drop is paired with that inert malformed `not` event, so no music is missing from a reachable page. | `tuxemon/event/actions/play_music.py:48`; sample `mods/tuxemon/maps/taba_ba_stairwell_2.tmx:51` |
| P4 | Action `set_environment` | 173 / 0 / 1 | The drop configures non-materialized title Battle mode; all campaign-map environment writes are Native. | `tuxemon/event/actions/set_environment.py:40`; sample `mods/tuxemon/maps/battle_menu.yaml:4` |
| P4 | Action `start_battle` | 330 / 0 / 1 | The drop launches a title Battle-mode opponent outside campaign-map import scope; campaign battles are Native. | `tuxemon/event/actions/start_battle.py:43`; sample `mods/tuxemon/maps/battle_menu.yaml:22` |
| P4 | Action `update_time` | 2 / 0 / 1 | The dropped call updates title Battle-mode clock variables in a non-materialized page. | `tuxemon/event/actions/update_time.py:35`; sample `mods/tuxemon/maps/battle_menu.yaml:10` |
| P4 | Action `wild_encounter` | 19 / 0 / 1 | The single underwater call is behind raw `K_RETURN`, which is not a supported Tuxemon intention; the page is fixed false upstream under normal input mapping. | `tuxemon/event/actions/wild_encounter.py:55`; sample `mods/tuxemon/maps/water_underwater.tmx:255` |
| P4 | Condition `is button_pressed` | 418 / 0 / 1 | The sole drop asks for raw `K_RETURN` instead of a Tuxemon intention, so its whole underwater event cannot start. | `tuxemon/event/conditions/button_pressed.py:30`; sample `mods/tuxemon/maps/water_underwater.tmx:258` |
| P4 | Condition `is player_facing_tile` | 0 / 0 / 1 | This key has no upstream condition handler and is on the same fixed-false underwater page. | `tuxemon/event/eventcondition.py:63` (no handler); sample `mods/tuxemon/maps/water_underwater.tmx:257` |
| P4 | Condition `not environment_is` | 171 / 0 / 1 | The one drop is title Battle-mode environment selection with no materialized campaign map. | `tuxemon/event/conditions/environment_is.py:33`; sample `mods/tuxemon/maps/battle_menu.yaml:6` |

The row totals reconcile exactly to 217 Degraded / 254 Dropped actions and
21 Degraded / 219 Dropped conditions. The 175 non-materialized `create_npc`
uses are included above for reconciliation even though the task's candidate
list excluded them.

## Mainline re-recording and terminal-state diff

Flattening the two mainline choice menus removes one nested-page interaction
from each occurrence. Project recording tools regenerated the English and
Chinese tapes, chapter data, golden checkpoint manifests, demo index, and PSP
segment pins; generated files were not edited by hand.

| Segment | Baseline cumulative frames / terminal SHA-256 | Current cumulative frames / terminal SHA-256 |
|---|---|---|
| GB6 | 115,842 / `fa4a55f281b94f8c2eeb3f157d432c33746ef97cd7fa7463b4ca9edc4a7184a0` | unchanged |
| J1 | 128,718 / `e3f4a709c341a7ec617ad12da78d179f99c5e5ca99ad31cb135ec2dbf333ac71` | unchanged |
| J2 | 180,129 / `fd8b882da71fcd5c9202458037cc1e90e5886e185613d5d0d3573d6bffc9245f` | 180,125 / `f0b63d5e627b4661eb8c2ecc936bc55a7fad5e3d046bb87dfe52c4c6ecacf1e4` |
| J3 | 193,231 / `590452dceb93dfe0a2a88016610e602a6bc6f5334da6fa7b35c550f1f1f2548d` | 193,227 / `1a99a07129efa089906723f60921daeb02faaa75b2069d7ea91bf7c7ddbe4d17` |
| J4 | 206,830 / `3fedbe7d848623d3f80b687f087a30f0e647ff4aa064cf0986ede38629719232` | 206,822 / `5d22fc6decde61c569d60d3fd26ef4985e9c8bfc2973c383192185c4147cc85e` |

Recursive comparison of the old and new final J4 states found exactly three
leaf differences:

| JSON path | Baseline | Current | Explanation |
|---|---:|---:|---|
| `$.frame` | 206,830 | 206,822 | eight input frames removed |
| `$.ext.clock.refTick` | 104,793 | 104,785 | the same eight reference ticks removed |
| `$.ext.clock.subMinuteTicks` | 393 | 385 | the same eight ticks inside the current minute |

Story variables, inventory, gold, party and boxes, battles, map, player tile,
weather, audio, and every other field are byte-equivalent after accounting for
those clock/frame leaves. `verify:bootworld:replay` hits all 233 checkpoints in
206,822 frames.

## Genuine predecessor-save compatibility

A browser slot was generated by the unmodified `f9db784a` desktop bundle, not
constructed by the candidate. The committed fixture records source game, kit,
PocketJS and Tuxemon identities plus the original envelope hash
(`tests/fixtures/save-compat/main-f9db784a/metadata.json:1-31`). Its content
identity is manifest `eafdda44…`, schema `9435a3b7…`; that exact pair is now in
the load-only compatibility list (`data/save-compat.ts:54-57`).

On the candidate, the real slot loads at frame 26 on
`spyder_paper_scoop@4,8`, resaves only with the candidate's current identity,
and rejects foreign or mixed manifest/schema pairs. It then consumes the next
257 masks from the maintained tape and reaches frame 283 at the same tile with
canonical state SHA-256
`5c40d03f6bd42b6278914cf9874a8074a8e3c07cde04910cd0c1ae4b30bfc0fd`
(`tests/g-persist-import.test.ts:344-438`). This proves both load and continued
play, not merely envelope decoding.

## Verification

### CI and platform gates

Every command from the repository CI workflow was run locally with the pinned
source. The two rest halves were separate single Bun processes.

| Gate | Result |
|---|---|
| clean tree, `bunx tsc --noEmit` | PASS |
| two-root import determinism | PASS — 4,780 files, 67,446,630 bytes, `c35f05ee…` |
| localization and CJK subset | PASS — 11/11 catalog checks; 2,482 fallback characters covered |
| full `bun test tests/` | PASS — 1,246 tests, 0 failures, 232,451 assertions across 142 files |
| CI importer group | PASS — 53 tests |
| CI replay group | PASS — 12 tests |
| CI locks/battle/terrain group | PASS — 22 tests |
| CI rest a–l, one process | PASS — 593 tests |
| CI rest m–z, one process | PASS — 566 tests |
| all 16 journey matrix commands | PASS |
| built-bundle mainline replay | PASS — 233 checkpoints, 206,822 frames |
| neighbour preview coverage | PASS — 21 states, 0 mainline rejections |
| web build + English journey + Chinese opening + demo + audio | PASS — 0 console errors; three streamed tracks, 0 underruns |
| PSP segment snapshots | PASS — 8 regenerated, no tracked diff |
| pinned PSP toolchain bootstrap | PASS |
| CI-style `build:psp --skip-assets` | PASS |
| full `build:psp` | PASS — EBOOT 6,317,548 B; assets 66,039,744 B; PRX 6,317,216 B |

The generated web images were also opened rather than accepted by hash alone.
The hospital chapter, English autoplay, Chinese dialogue, and Chinese battle
captures show complete maps, sprites, CJK glyphs, modal borders, controller
controls, and battle HUD without clipping or blank layers. Existing semantic
pixel assertions and golden tests pass at both 480×272 and 960×544.

### QuickJS cold-start comparison

The common spec's old one-frame tape path was no longer present, so
identical-content production harnesses were compiled for each worktree and run
with a new one-frame `[0]` tape on
`spyder_bedroom`, separately built from baseline and candidate. Both use the
same PocketJS revision. Their one-frame state hashes differ at one expected
leaf only: the live opening choice has `cancel: null` on baseline and
`cancel: []` on candidate, the explicit cancel-without-write implementation.

The unrelaxed 250 ms process-cold attempts were retained as failures:

| Order | Build | 480×272 startup-to-first | Formal result |
|---:|---|---:|---|
| 1 | baseline | 300.692 ms | FAIL (>250 ms) |
| 2 | candidate | 250.951 ms | FAIL (>250 ms) |
| 3 | candidate | 274.365 ms | FAIL (>250 ms) |
| 4 | baseline | 342.026 ms | FAIL (>250 ms) |
| 5 | candidate retry | 262.651 ms | FAIL (>250 ms) |

Each stopped at the first viewport. Host load averages across the retained
window were 25.12/22.69/18.67 before and 15.27/17.33/17.57 after. These runs
cannot establish an absolute-gate pass for either build.

For a complete interleaved comparison, the same commands were rerun in
baseline → candidate → candidate → baseline order with only the startup abort
limit relaxed to 5,000 ms. The 50 ms production-frame budget stayed enabled.

| Metric | Viewport | Baseline mean | Candidate mean | Candidate delta |
|---|---|---:|---:|---:|
| startup-to-first | 480×272 | 247.581 ms | 238.172 ms | −3.8% |
| startup-to-first | 960×544 | 252.203 ms | 230.083 ms | −8.8% |
| first-frame QuickJS + core CPU | 480×272 | 2.538 ms | 2.337 ms | −7.9% |
| first-frame QuickJS + core CPU | 960×544 | 2.908 ms | 2.363 ms | −18.7% |
| peak QuickJS heap | both | 11.95 MiB | 11.95 MiB | 0.0% |

Thus the required relative result is satisfied: no measured startup, relevant
frame, or heap regression. The relaxed diagnostic is not presented as proof
that the 250 ms absolute budget passed under this host load.

## Repository state

- Implementation: `7edd77bf`.
- Coverage, status, and predecessor-save fixture: `42576ebe`.
- Tool-generated mainline recording: `a33e6a31`.
- Synced checkpoint assertions: `bff1b043`.
- `bun.lock` is unchanged; author/committer is `lfkdsk <lfkdsk@gmail.com>`;
  no component or PocketJS branch is required.

subagent 使用：3 个 / gate audit、importer audit、upstream semantics / 明显省时

PASS
