# Event coverage and exact character speed

## Result

All four review blockers are fixed. `pak.json` is the importer's canonical
sorted output; the frozen-map verifier registers `tux.radio`; the two real
Spyder/Xero transfer hooks publish the saved deterministic calendar before a
radio is used; and exact movement now keeps the authored tiles-per-second rate
through the committed step instead of recovering it from floating-point pixel
distance. The real Taba 10 tiles/s route lands in 6 reference ticks and the
real 1 tiles/s route lands in 60, with every authored rate checked.

The importer now executes 13,350 of 13,617 action uses (98.0%) and 8,444 of
8,663 condition uses (97.5%). Native coverage is 13,108 actions (96.3%) and
8,423 conditions (97.2%). There are no Placeholder uses. The integrated game
passes deterministic import, both test suites, every project CI gate, full
60/30/20 Hz GB6 replay, web/Chrome, PSP, current-main save continuation, and
the required QuickJS unused-feature performance gates.

The principal reachable Dropped gaps left are
the three paid `dojo_method` services and the two paid `change_taste` services.
They remain honestly Dropped because their blocking selection/report flows and
monster mutations are not implemented; changing only the coverage label would
still charge the player while doing nothing.

## Revisions and integration order

- Game baseline: `3a9e95b2c8ff0144e1290b2e1d1adcf5e615b499`.
- Game implementation HEAD before this report-only commit:
  `cb33d4a74d9a0a922c1041f57a08327e371c3566`.
- RPG Kit baseline: `0fcb5f013d87598246e554d61396ffeacbbdc549`.
- RPG Kit HEAD: `e712bd2d74da6a38d8bd288519f4e75db1ddc8bd`.
- PocketJS: `862040bd77edc49b1f815beff63952b6616a14c6`.
- Pinned Tuxemon source: `9e6258ff726b786040a267e8bdbbf037b560285e`.

The game branch already records the RPG Kit pointer above. Merge RPG Kit first,
then the game commits including that pointer. No PocketJS change is required.
The latest game baseline merge retained both its per-lane seamless transfer
lowering and this branch's transfer-time entry hook.

## Review blockers: cause, repair, evidence

| Blocker | Cause | Repair | Evidence |
|---|---|---|---|
| Canonical `pak.json` | The CJK font tool appended its license row after the importer had sorted pak entries, so the committed file differed after import. | Re-ran the importer after font generation and committed its sorted bytes. | Two isolated imports reproduce 4,774 files with aggregate SHA `babff89d…`; committed `pak.json` is `d0d2a505…`, and the isolated pre-import-order mutation makes the clean-tree assertion fail. |
| Frozen verifier | `tux.radio` was registered by the game but absent from the static scene table used by `tools/frozen-k1.ts`. | Registered it with the same conservative scan rules as the other blocking game scenes (`tools/frozen-k1.ts:45`). | `verify:g6:frozen` reports 263 maps, 0 permanent input locks, 0 permanent blocking fibers and 0 errors; deleting that row reproduces `unregistered scene ids: tux.radio`. |
| Real radio time | Every strong-signal broadcast tests `stage_of_day`, while all three upstream `update_time` uses were Dropped. The earlier test manufactured the variable. | Lowered the two shared Spyder/Xero TeleporterState hooks to one call on each destination map's entry page. `tux.update_time` reads only the saved extension clock, so save/load/rewind stay deterministic; the absent title-screen battle-map use stays Dropped. | Coverage is 2 Native / 1 Dropped (`tests/time-weather-import.test.ts:207`). The real-map test starts on an imported destination, lets its real entry page write `v.stage_of_day`, then activates the real Radio event; it never assigns that variable (`tests/radio-real-map.test.ts:106`). Removing the runtime call changes the expected programme to static. |
| Exact integer-frame speed | In-flight movement recovered speed from floating-point pixel distance and then used `ceil`; rates dividing 60 could reconstruct slightly low and gain one tick. | Store the sparse exact rate on the committed player/NPC step, use it for every tick, serialize it, and clear it on landing; legacy snapshots without it keep the tolerant old path. | All ten authored rates land on `ceil(60/rate)` from varied positions (`vendor/pocket-rpgkit/tests/km1-move-control.test.ts:793`); real Allie 10 tps lands on tick 6 and the 1-tps villager on tick 60 (`tests/npc-movement-real-map.test.ts:387`). Restoring float recovery makes both targeted tests fail. |

## Coverage before and after

Counts are source-use counts from the generated per-file report. Executable is
Native + Degraded + Placeholder; both versions have zero Placeholder uses.

| Kind | Uses | Before Native | After Native | Before executable | After executable | D/P/X before | D/P/X after |
|---|---:|---:|---:|---:|---:|---:|---:|
| Actions | 13,617 | 13,074 (96.0%) | 13,108 (96.3%) | 13,337 (97.9%) | 13,350 (98.0%) | 263/0/280 | 242/0/267 |
| Conditions | 8,663 | 8,411 (97.1%) | 8,423 (97.2%) | 8,434 (97.4%) | 8,444 (97.5%) | 23/0/229 | 21/0/219 |

Thirteen formerly Dropped action uses and ten formerly Dropped condition uses
now execute. The generated English and Chinese reports and machine report agree
with these totals (`reports/G1-coverage.md:12`,
`reports/G1-coverage.zh_CN.md:12`, `dist/import-report.json`).

### Promoted source uses

| Source row | Change | Upstream semantics and imported-map proof |
|---|---:|---|
| `char_speed` | 19 D -> N | Upstream assigns the supplied custom moverate (`tuxemon/event/actions/char_speed.py:36`). The importer emits both the compatibility grade and exact rate (`importer/project.ts:3488`). Real-map tests cover every rate that owns a following tile, including 10 tiles/s in 6 ticks, 1 tiles/s in 60 ticks, mid-step save/load, and rewind (`tests/npc-movement-real-map.test.ts:387`). |
| `get_player_monster` | 2 D -> N | Upstream selects a party monster and stores its stable id (`tuxemon/event/actions/get_player_monster.py:23`). The two rename forms are non-cancellable and retain the selected iid; the real healing-center flow attempts cancel, selects the second monster, renames it, and leaves its peer untouched (`tests/g-identity-e2e.test.ts:166`). |
| `modify_monster_bond` | 1 X -> N | The no-argument form adds one bond point to every party monster (`tuxemon/event/actions/modify_monster_bond.py:20`). The real friendship-scroll milestone checks the saved bond and its one-shot tracker flow (`tests/covb-monster-mechanics.test.ts:174`). |
| `set_char_attribute` | 3 X -> N | Upstream writes the named character attribute (`tuxemon/event/actions/set_char_attribute.py:16`). All six real `start_tuxemon` identity branches prove the three gender writes persist with their walker and combat sheet (`tests/g-identity-e2e.test.ts:282`). |
| `set_monster_level` | 3 X -> N | Upstream targets an iid or the whole party, clamps at level 1, and recalculates level state (`tuxemon/event/actions/set_monster_level.py:42`). The real Water `+10` one-shot checks both monsters' exact level, stats, HP deficit, experience, moves, persistence, and non-repeat flag (`tests/covb-monster-mechanics.test.ts:112`). |
| `translated_dialog` | 1 X -> N | Upstream opens translated blocking text (`tuxemon/event/actions/translated_dialog.py:32`). Materializing the real male/female Granny branch makes its branch-specific line executable; the real-map branch transcript is pinned (`tests/importer.test.ts:1478`). |
| `translated_dialog_choice` | 1 X -> N | Upstream displays all authored choices and writes the selected value (`tuxemon/event/actions/translated_dialog_choice.py:24`). The same real Granny branch proves the choice page and following variable-dependent text (`tests/importer.test.ts:1478`). |
| `tune_radio` | 2 X -> N | Upstream opens a blocking radio tuner at the supplied FM frequency (`tuxemon/event/actions/tune_radio.py:50`). Both authored radios select map/time broadcasts, weak signal produces static, 94.7 auto-plays once, Chinese text imports, and return restores the map (`tests/radio-real-map.test.ts:145`). |
| `update_time` | 2 X -> N | Upstream copies the current calendar into eight player variables (`tuxemon/event/actions/update_time.py:35`) from the shared TeleporterState event (`mods/tuxemon/maps/spyder.yaml:251`). The kit has no map fiber during transfer, so the importer attaches one `tux.update_time` call to each destination map's once-per-entry page (`importer/project.ts:4211`). The real destination-map entry event writes `v.stage_of_day` before the real Radio event opens; the test never assigns that variable (`tests/radio-real-map.test.ts:106`). |
| `is button_pressed` | 2 X -> N | Upstream tests an intention edge (`tuxemon/event/conditions/button_pressed.py:15`). Both real radio events require INTERACT; map-wide inspection and runtime tests prove neither fires without it (`tests/importer.test.ts:1631`, `tests/radio-real-map.test.ts:145`). |
| `is char_facing_tile` | 2 X -> N | Upstream tests whether a character faces the event's tile region (`tuxemon/event/conditions/char_facing_tile.py:19`). The two real radios remain facing-gated and playable (`tests/importer.test.ts:1631`). |
| `is/not char_gender` | 2 X -> N | Upstream compares live character gender (`tuxemon/event/conditions/char_gender.py:17`). The two real Granny pages produce different transcripts for male versus other identities (`tests/importer.test.ts:1478`). |
| `not tile_property_updated` | 2 D -> N | Upstream asks whether every relevant world tile already has the property/value (`tuxemon/event/conditions/tile_property_updated.py:17`). The shared Spyder swim pages atomically update the live surface and the negated guard prevents repeat application (`tests/importer.test.ts:462`). |
| `not variable_set` | 2 X -> N | Upstream checks absence or inequality of saved variables (`tuxemon/event/conditions/variable_set.py:14`). The newly materialized real Granny pages stay available only before the yes/no result is stored (`tests/importer.test.ts:1478`). |
| `is current_state` | 2 X -> N | The two TeleporterState guards are represented by the destination-entry lowering above. The third `update_time` use remains Dropped because its title-screen battle map is not imported (`tests/time-weather-import.test.ts:207`). |

Targeted mutations ran only in isolated copies. Replacing committed
`pak.json` with the pre-import order fails the clean-tree check; deleting the
radio scan registration crashes `verify:g6:frozen`; suppressing the entry-time
runtime call makes the real radio test receive static; and restoring the old
float-recovery movement makes both the component table and real Allie test
take 7 rather than 6 ticks. The earlier command/guard mutations also continue
to fail their domain-state, route-position, dialogue, or rendered-text
assertions. These checks observe behavior, not only command presence.

## Exhaustive remaining non-Native inventory

`N/D/P/X` below means Native / Degraded / Placeholder / Dropped source uses for
that type. Rows are ordered by outstanding uses (D + P + X). Every current
non-Native type is present; P is zero throughout.

### Actions

| Type (outstanding) | N/D/P/X | Upstream semantics | Player-visible remainder / reason |
|---|---:|---|---|
| `create_npc` (175) | 1328/0/0/175 | Create and place a database NPC, including party and behavior (`tuxemon/event/actions/create_npc.py:34`). | These 175 rules belong to source events no selected map materializes. They cannot spawn in the imported world; reachable uses are Native. |
| `char_face` (138) | 1889/124/0/14 | Turn a character toward a direction, player, or named character (`tuxemon/event/actions/char_face.py:20`). | Surf pages use route/page lowering; 14 bad or unreachable rows use `top`/`bottom`, a missing target, zero-size geometry, or run on the fading old map. Reachable result is retained, but route/presentation timing differs. |
| `random_monster` (30) | 9/0/0/30 | Add one RNG-selected eligible monster to a trainer party (`tuxemon/event/actions/random_monster.py:21`). | All 30 outstanding rules are in source events absent from selected maps, so no imported player path can request them. |
| `add_tracker` (24) | 0/24/0/0 | Add a visited location to a character tracker (`tuxemon/event/actions/add_tracker.py:23`). | A saved `tracker.<map>` switch drives every authored guard, but full tracking-point metadata and phone-map history are not modeled. |
| `open_journal` (14) | 0/14/0/0 | Open the chosen monster's journal detail page (`tuxemon/event/actions/open_journal.py:20`). | The blocking imported detail scene is usable, but it is a compact subset of upstream's full journal layout/details. |
| `char_move` (13) | 64/13/0/0 | Execute relative tile moves and block until arrival (`tuxemon/event/actions/char_move.py:20`). | Shared surf pages preserve choice, movement, appearance and dismount, but use a lowered route/page boundary flow rather than the original behavior object. |
| `access_pc` (10) | 0/10/0/0 | Open a tag-selected PC interface (`tuxemon/event/actions/access_pc.py:19`). | Monster boxes and item locker work. Upstream's always-visible unimplemented Multiplayer row and exact 30-item bag-full boundary are absent; no authored call requests email/calendar tags. |
| `translated_dialog_choice` (10) | 139/10/0/0 | Show translated options and store the result (`tuxemon/event/actions/translated_dialog_choice.py:24`). | Nested option pages preserve every option but pagination/box sequencing differs visibly from one upstream modal. |
| `change_bg` (9) | 6/9/0/0 | Push a color/image blocking backdrop (`tuxemon/event/actions/change_bg.py:25`). | Backdrop pixels are retained, but the kit deliberately does not pop a covering modal that upstream would pop. |
| `park_experience` (8) | 0/0/0/8 | Start/stop the Safari Park session and show its result state (`tuxemon/event/actions/park_experience.py:33`). | Eclipse-only park events are outside the Spyder campaign and not materialized; there is no park-session runtime. |
| `quarantine` (8) | 0/8/0/0 | Move infected monsters into/out of a hidden quarantine box and inoculate them (`tuxemon/event/actions/quarantine.py:25`). | Authored paths work, including full-party release to Kennel. Only preferred-box rename/merge on externally prefilled over-capacity state differs; the campaign admits at most six monsters to capacity 30. |
| `change_bg_monster` (7) | 0/7/0/0 | Show a monster front sprite over a blocking backdrop (`tuxemon/event/actions/change_bg_monster.py:18`). | The sprite/backdrop render, but a covering modal is retained instead of popped. |
| `load_yaml` (7) | 0/7/0/0 | Append named YAML event/init lists to the current map with name dedupe (`tuxemon/event/actions/load_yaml.py:21`). | Static import plus a saved synthetic gate gives authored results; unlike upstream's map-manager list, the gate can survive leaving/re-entering a map. |
| `transition_teleport` (7) | 1042/3/0/4 | Fade and transfer a character to a map coordinate (`tuxemon/event/actions/transition_teleport.py:19`). | Three out-of-range landings use deterministic nearest-walkable repair. Four rows are upstream-impossible `top`/`bottom` or zero-size events. |
| `set_tuxepedia` (6) | 0/6/0/0 | Set a monster to seen/caught in a character's Tuxepedia (`tuxemon/event/actions/set_tuxepedia.py:21`). | Player seen/caught state is correct; repeat counters and NPC journals are not stored or displayed. |
| `set_variable` (6) | 709/0/0/6 | Set one or more game-variable key/value pairs (`tuxemon/event/actions/set_variable.py:16`). | Rows are inside absent source events or behind the invalid `K_RETURN` condition, so upstream cannot execute them in this corpus. |
| `translated_dialog` (5) | 2063/1/0/4 | Open translated blocking text with layout/avatar options (`tuxemon/event/actions/translated_dialog.py:32`). | One post-transfer faint notice is moved to the destination map. Four rows are behind unsupported combat/menu-state or invalid-key guards. |
| `wait` (5) | 436/0/0/5 | Block an event chain for accumulated game-loop time (`tuxemon/event/actions/wait.py:15`). | These waits are in conditionless inert events or on the fading old map and never affect a playable imported chain. |
| `change_bg_char` (4) | 0/4/0/0 | Show an NPC combat/front image over a blocking backdrop (`tuxemon/event/actions/change_bg_char.py:19`). | Art is present, but a covering modal is retained instead of popped. |
| `dojo_method` (3) | 0/0/0/3 | Select a monster, then learn/replace an eligible move or devolve while transferring its properties (`tuxemon/event/actions/dojo_method.py:29`). | Reachable paid Spyder services currently charge/set follow-up state without the monster change. Exact blocking menus, learnability, devolution history and property transfer are not implemented; this is the highest-priority honest gap. |
| `quit_world` (3) | 0/0/0/3 | Clear world/map/state data and return to the start state (`tuxemon/event/actions/quit_world.py:31`). | Only non-materialized legacy/global events use it; there is no reachable world-exit loss. |
| `update_time` (1) | 2/0/0/1 | Copy the current clock fields into character variables (`tuxemon/event/actions/update_time.py:35`). | Both imported world-transfer hooks are Native. The remaining use belongs to the unimported title-screen battle map and cannot run in the imported campaign. |
| `change_taste` (2) | 0/0/0/2 | Assign or rarity-weight a new warm/cold monster taste and update stats (`tuxemon/event/actions/change_taste.py:21`). | Two reachable paid Dojo services currently charge without changing taste. Deterministic weighted selection, stat recomputation and blocking report UI are not yet implemented. |
| `get_pending_moves` (2) | 0/0/0/2 | Read `check_max_tech` event data, show pending moves and store the chosen move (`tuxemon/event/actions/get_pending_moves.py:23`). | Authored uses require the upstream combat-menu state; kit map fibers are suspended while that scene is open. Implementing only a map command would be semantically wrong. |
| `remove_tech` (2) | 0/0/0/2 | Remove the technique whose id is held in a variable, respecting forget rules (`tuxemon/event/actions/remove_tech.py:21`). | Same combat-menu-only chain as `get_pending_moves`; currently fixed-false rather than partially mutating battle state. |
| `set_template` (2) | 22/2/0/0 | Replace a character's walker/combat-sheet base template (`tuxemon/event/actions/set_template.py:18`). | Surf boundary pages preserve appearance/dismount through a shared lowered flow, not the original template action lifetime. |
| `add_item` (1) | 117/0/0/1 | Add/remove an item quantity on a specified trainer (`tuxemon/event/actions/add_item.py:20`). | The one outstanding row targets an NPC combat bag, a state the port does not expose outside battle. |
| `char_wander` (1) | 32/0/0/1 | Assign bounded, frequency-controlled wander behavior (`tuxemon/event/actions/char_wander.py:22`). | The source spawn target is unavailable, so applying wander would target no character. |
| `not` (1) | 0/0/0/1 | There is no upstream action named `not`; the source accidentally places `not music_playing` in `act2` (`mods/tuxemon/maps/taba_ba_stairwell_2.tmx:52`). | Invalid upstream data; the condition text cannot be executed as an action. |
| `play_music` (1) | 199/0/0/1 | Start a music resource with volume/loop/fade settings (`tuxemon/event/actions/play_music.py:19`). | The only dropped row is a conditionless inert source event, so silence does not change a reachable map chain. |
| `set_environment` (1) | 173/0/0/1 | Load or clear the active battle environment (`tuxemon/event/actions/set_environment.py:20`). | The sole outstanding source event is not materialized by any selected map. |
| `set_party_status` (1) | 1/0/0/1 | Calculate party missing HP and write `party_lost_hp` (`tuxemon/event/actions/set_party_status.py:33`). | The row is combat/menu-state guarded while map fibers are suspended; the reachable healing charge path uses the Native row. |
| `start_battle` (1) | 330/0/0/1 | Start combat between two named characters (`tuxemon/event/actions/start_battle.py:24`). | The only outstanding battle sits in a non-materialized source event. |
| `wild_encounter` (1) | 19/0/0/1 | Spawn one specified wild monster and enter combat (`tuxemon/event/actions/wild_encounter.py:28`). | Its event is guarded by pygame key name `K_RETURN`, which is not a Tuxemon intention and can never pass upstream. |

### Conditions

| Type (outstanding) | N/D/P/X | Upstream semantics | Player-visible remainder / reason |
|---|---:|---|---|
| `not char_exists` (175) | 1225/0/0/175 | Negate whether a character is in the current NPC list (`tuxemon/event/conditions/char_exists.py:14`). | The 175 rows belong to non-materialized source events; all selected-map spawn guards execute. |
| `is char_facing` (13) | 995/9/0/4 | Compare a character's facing with up/down/left/right (`tuxemon/event/conditions/char_facing.py:17`). | Nine surf/page lowerings preserve result. Four source rows use impossible `top`/`bottom` or zero-size geometry and remain fixed-false. |
| `is current_state` (6) | 72/0/0/6 | Test whether one of the named engine states is active (`tuxemon/event/conditions/current_state.py:14`). | The two world-transfer guards are represented by destination entry. The remaining rows are absent or ask for combat/menu states while kit map fibers are suspended; making those true in a map fiber would be wrong. |
| `is char_exists` (6) | 3/0/0/6 | Test whether a character is in the current NPC list (`tuxemon/event/conditions/char_exists.py:14`). | All six are in non-materialized source events. |
| `not char_in` (6) | 0/6/0/0 | Negate whether a character stands on tiles carrying a property (`tuxemon/event/conditions/char_in.py:18`). | Surf boundary pages preserve the shared flow, but use generated surface predicates rather than the upstream condition object. |
| `not variable_set` (6) | 665/0/0/6 | Negate existence/equality of saved variables (`tuxemon/event/conditions/variable_set.py:14`). | Rows are in absent source events or behind the invalid `K_RETURN` event; reachable variable guards are Native. |
| `is char_facing_tile` (5) | 339/5/0/0 | Test the tiles/properties immediately faced by a character (`tuxemon/event/conditions/char_facing_tile.py:19`). | Five surf boundaries use a generated shared page flow; their item, movement and dismount results remain executable. |
| `is variable_set` (5) | 725/0/0/5 | Test existence/equality of saved variables (`tuxemon/event/conditions/variable_set.py:14`). | All five occur in source events absent from selected maps. |
| `is char_at` (4) | 1807/0/0/4 | Test whether a character is within the event's map region (`tuxemon/event/conditions/char_at.py:18`). | Bad `top`/`bottom` chains or zero-size regions have no integer Tuxemon tile and are fixed-false. |
| `is battle_outcome` (3) | 227/0/0/3 | Compare a fighter's saved won/lost/draw result against an opponent (`tuxemon/event/conditions/battle_outcome.py:17`). | All three are in non-materialized source events. |
| `is party_size` (3) | 47/0/0/3 | Numerically compare a character's party size (`tuxemon/event/conditions/party_size.py:18`). | Rows are absent or combat/menu-state fixed-false; reachable party-size branches are Native. |
| `not char_defeated` (2) | 179/0/0/2 | Negate “party exists and every monster is defeated” (`tuxemon/event/conditions/char_defeated.py:17`). | Both rows belong to source events no selected map materializes. |
| `is button_pressed` (1) | 418/0/0/1 | Test a Tuxemon intention press edge (`tuxemon/event/conditions/button_pressed.py:15`). | `K_RETURN` is a pygame key name, not an accepted intention, so upstream never starts the event. |
| `is char_in` (1) | 0/1/0/0 | Test whether a character stands on tiles carrying a property (`tuxemon/event/conditions/char_in.py:18`). | One surf boundary uses the shared generated flow rather than the original condition object. |
| `is check_max_tech` (1) | 1/0/0/1 | Find party monsters over the move limit and store them in transient event data (`tuxemon/event/conditions/check_max_tech.py:19`). | The dropped use requires a combat-menu fiber and feeds the unimplemented pending-move scene; it is intentionally fixed-false. |
| `is cooldown_days` (1) | 0/0/0/1 | Compare a saved date with a day-count cooldown (`tuxemon/event/conditions/cooldown_days.py:14`). | The port has no corresponding monster/party meta timestamp for this unreachable row; guessing would alter scheduling. |
| `is player_facing_tile` (1) | 0/0/0/1 | No condition plugin exists for this name, and the source supplies no arguments (`mods/tuxemon/maps/water_underwater.tmx:257`). | Invalid upstream data; the adjacent `K_RETURN` guard is also impossible. |
| `not environment_is` (1) | 171/0/0/1 | Negate comparison with the active environment slug (`tuxemon/event/conditions/environment_is.py:14`). | The sole outstanding row is in a non-materialized source event. |

The next coverage work should implement `dojo_method` and `change_taste`
together with their actual Dojo UI, persistent monster changes and real-map
tests. `open_journal` and the exact PC edge cases are lower-severity executable
fidelity work. Non-materialized and fixed-false rows should stay Dropped until
the source corpus or selected-map reachability changes.

## Exact `char_speed`

RPG Kit's additive command shape is:

```json
{"kind":"routeSpeed","value":5,"tilesPerSecond":7}
```

`value` remains required for old consumers. `tilesPerSecond` is optional,
finite, and constrained to `(0, 20]` (`vendor/pocket-rpgkit/src/data/schema.json:1709`,
`vendor/pocket-rpgkit/src/engine/save-validate.ts:358`). When present, movement
uses `tileSize * tilesPerSecond / 60` on the fixed motion clock
(`vendor/pocket-rpgkit/src/engine/move-control.ts:225`). When absent, the engine
uses the existing MV grade and produces the same old bytes and behavior.

The review's extra tick came from reconstructing speed as `distance / phase`:
at integer frame divisors that yielded a value just below the original rate,
`ceil(tile/speed)` added one tick. A sparse `stepTilesPerSecond` latch now
records the exact rate when a step commits, drives every in-flight tick, is
saved, and is cleared on landing (`vendor/pocket-rpgkit/src/engine/movement.ts:91`).
Old snapshots without the latch use the legacy position tolerance and keep
their old behavior. Pending wander consumes its rate only when a direction
actually commits, so a blocked attempt cannot lose it
(`vendor/pocket-rpgkit/src/engine/chars.ts:936`).

The component table exercises all ten authored rates (0.5, 1, 1.5, 3, 3.75,
5, 7, 8, 9 and 10) from varied positions and directions, plus 10-tps
phase-five save/load, legacy snapshots, malformed values, direct route steps,
wander, player routes and rewind (`vendor/pocket-rpgkit/tests/km1-move-control.test.ts:793`).
The imported-map suite observes every rate with an actual following tile. In
particular Allie at 10 tps lands exactly on tick 6, the 37707 villager at 1 tps
lands on tick 60, and a mid-step save resumes byte-identically
(`tests/npc-movement-real-map.test.ts:387`). The sole 0.5 source call has no
following tile after its preceding path has already reached the destination;
the component table supplies its exact 120-tick proof.

The current schema identity is
`138048a55ff7d728806120306745c007401d62eec7e5ed1a5da39720429da022`.
Its immediate predecessor
`5eecc57a1acad4721139225b1bed1e35ae581706c29e611909d58b2c90efb41b`
is explicitly compatible because omission retains the old behavior
(`vendor/pocket-rpgkit/src/engine/schema-identity.ts:67`).

## Save compatibility and save boundaries

A genuine browser slot was generated in an untouched checkout of current game
main `3a9e95b2` with RPG Kit `ae1e6a33`, rather than synthesized by the
candidate. Its envelope SHA-256 is
`3b761d42b3930d1b1b8889251af34bd64c9e8431d28007c4bd3a91e0b686eacf`,
manifest is
`6322d4d6af2331cd68011422320424f4357d6e546e3d6f83e7e7ef47ae7c4551`,
and schema is `5eecc57a…`. The committed slot bytes are byte-for-byte equal to
that generated file (`tests/fixtures/save-compat/main-3a9e95b2/metadata.json:2`).

The candidate accepts that exact pair under its current `4b08ab85…` manifest
and `138048a5…` schema, restores frame 26 at
`spyder_paper_scoop@4,8`, and follows the unchanged tape prefix for 257 more
frames. The resumed state at frame 283 has SHA-256
`5c40d03f6bd42b6278914cf9874a8074a8e3c07cde04910cd0c1ae4b30bfc0fd`,
exactly equal to a fresh uninterrupted candidate run. Six generations of real
slots now load and resave under the current identity; forged or mixed identity
pairs remain refused (`tests/g-persist-import.test.ts:338`).

Manual saves remain intentionally refused while the player is between tiles,
an event owns control, or a modal is open. `char_stop` does not snap an already
committed tile; on real Route 1 the first safe point is the next resting tile,
where saving becomes allowed (`tests/npc-movement-real-map.test.ts:190`). Engine
autosaves may capture a waiting fiber with an NPC mid-tile; the exact-rate
latch now validates and resumes that state byte-identically
(`tests/npc-movement-real-map.test.ts:340`).

## Determinism and journeys

Two complete imports were byte-identical across 4,774 files and 67,258,548
bytes (aggregate SHA-256
`babff89d6f418cdd8b8c42b69de572dba0fdeb3c4a9635834707a0cb786ae249`).
The importer leaves its committed outputs unchanged, including sorted
`pak.json` SHA-256
`d0d2a505866c66d71d6fe922a5ae3424d06a86660f6338f6553ea75425af68e5`.
Final generated hashes are:

| Output | SHA-256 |
|---|---|
| `data/g6-assets-report.json` | `6e7392540108c23084d42c0f9745ad148acd5ec2958fbbae918533ecdb9cb321` |
| `dist/import-report.json` | `737ee656a807b1b44b3d273b278246c83972bac0597660d749b2d57435b2e518` |
| `reports/G1-coverage.md` | `474ad0b90d4b11f0527b45989ad61ffc70d384d6709935da521ccb1ffad2a693` |
| `reports/G1-coverage.zh_CN.md` | `dc661dbeec11e432583ab717194848b0e568a9c77a22d3dc2fa6b54a297840c9` |

`update_time` intentionally changes terminal state by publishing eight strings
from the saved calendar. They appear in both `sw.variables` and its interpreter
mirror; no other field differs from the baseline terminal:

| Variable | Value |
|---|---|
| `v.day_of_year` | `"167"` |
| `v.daytime` | `"true"` |
| `v.hour` | `"9"` |
| `v.leap_year` | `"true"` |
| `v.season` | `"spring"` |
| `v.stage_of_day` | `"morning"` |
| `v.weekday` | `"saturday"` |
| `v.year` | `"2024"` |

The source tapes and every descendant pin were regenerated with project tools.
Old and new terminal hashes are:

| Journey | Baseline SHA-256 | Candidate SHA-256 |
|---|---|---|
| G6 | `a1a6de7567b3…` | `8253ccefb805…` |
| GB6 | `f5b2c7ba46c2…` | `fa4a55f281b94f8c2eeb3f157d432c33746ef97cd7fa7463b4ca9edc4a7184a0` |
| J1 | `eb88bb0e69b3…` | `e3f4a709c341a7ec617ad12da78d179f99c5e5ca99ad31cb135ec2dbf333ac71` |
| J2 | `875333206c23…` | `fd8b882da71fcd5c9202458037cc1e90e5886e185613d5d0d3573d6bffc9245f` |
| J3 | `e35a750132fe…` | `590452dceb93dfe0a2a88016610e602a6bc6f5334da6fa7b35c550f1f1f2548d` |
| J4 | `f8361bb0321d…` | `3fedbe7d848623d3f80b687f087a30f0e647ff4aa064cf0986ede38629719232` |

Full GB6 stateful replay processes 115,842 source frames and 111 battles. Its
save-before/save-after suffixes both end at `92231811…`; 60, 30 and 20 Hz all
end at `fa4a55f…`. Both recorded loss paths, 20 chapter suffixes, five save
points, 233 built-world checkpoints, and Chinese mainline 13/13 also pass.

## Visual review

Four production PNGs were generated at 480x272 and 960x544 for both the tuner
and broadcast. I opened all four at original detail and also inspected 3x
nearest-neighbor enlargements. The dial, 94.7 MHz readout, station name,
100%-signal bar, controls, imported broadcast text, panel bounds, and scaling
were crisp and unobscured at both sizes; no clipping or accidental fallback
text was visible.

The visual test compares every RGBA byte and both PNG/RGBA hashes, asserts the
exact dial/station/signal text and imported broadcast, counts the accent pixels
in the full signal-bar region, and touches Play, Continue and Return through
scaled production hit regions (`tests/radio-visual.test.ts:90`). This prevents
a stable but semantically blank/wrong golden from passing.

## QuickJS performance

RPG Kit was measured main -> candidate -> candidate -> main on CPU 31, three
windows of 2,000 iterations, with PocketJS `862040bd`. The three specified
unused-feature medians all remain within the 3% gate:

| Workload | Median candidate vs main |
|---|---:|
| `sunstoneIdle` | +1.13% |
| `sunstoneWalk` | +2.18% |
| `streamedRoam` | +2.05% |

For transparency, non-gate medians were `battleScene` +0.73%, immutable idle
+1.19%, immutable battle +3.41%, controlled walk +4.59%, and immutable
controlled walk +4.55%. Exact-speed state is used on controlled movement, so
those rows are not unused-feature gates.

The game cold-start run used production one-frame bundles and ten independent
cold processes per revision and viewport in the same four-slot order. The
successful interleaved window is:

| Viewport | Main boot median/worst | Candidate boot median/worst | Boot median delta | Main/candidate first-frame median | Candidate startup-to-first worst |
|---|---:|---:|---:|---:|---:|
| 480x272 | 209.306 / 226.310 ms | 217.237 / 229.317 ms | +3.79% | 2.287 / 2.360 ms | 231.944 ms |
| 960x544 | 219.123 / 224.937 ms | 217.505 / 233.167 ms | -0.74% | 2.329 / 2.371 ms | 235.911 ms |

Every successful process is below the 250 ms startup and 50 ms frame budgets.
An attempted extra baseline window is retained as a failed measurement:
baseline startup-to-first reached 442.092 ms while three unrelated Bun
processes each occupied a CPU and a Rust compiler was also active. It exited
101 and is not relabelled or included in the successful-window statistics.

## Non-blocking review items

The Xiang Re-Learner path still has an authored success page after the Dropped
`dojo_method` call (`mods/tuxemon/maps/spyder_dojo1.yaml:271-289`). The
dedicated Dojo work owns its blocking picker, technique mutation, payment, and
success/failure flow; this branch does not claim that service as working. Its
three `dojo_method` and two `change_taste` uses remain Dropped, and the false
success text is explicitly part of that handoff rather than being hidden by a
coverage promotion.

## Gates on the integrated latest baseline

Every shell command in the current CI workflow was run locally. `deploy` has
only `actions/deploy-pages` and therefore no local shell command.

| CI job / command | Result |
|---|---|
| import: clean generated tree; `bunx tsc --noEmit`; `verify:g6:determinism`; `check:l10n`; `check:cjk` | PASS; 4,774 deterministic files, l10n 11/11, CJK complete |
| test: importer | PASS, 53 tests |
| test: replays | PASS, 12 tests |
| test: locks/battle/terrain | PASS, 22 tests |
| test: rest | PASS, 1,101 tests |
| journey: `verify:gb6:mainline`, `verify:j1:mainline`, `verify:j2:mainline`, `verify:j3:mainline`, `verify:j4:mainline` | PASS |
| journey: `verify:goldens:sync`, `verify:gb6:failures`, `verify:g6:locks`, `verify:g6:frozen`, `verify:chapters` | PASS; frozen scan 263 maps, 0 locks, 0 blocking fibers, 0 errors |
| journey: `verify:zh:tape`, `verify:zh:demo`, `verify:en:demo`, `verify:save`, `verify:preview:coverage`, `verify:bootworld:replay` | PASS; 5 save points, 21 preview states/0 mainline rejects, 233 checkpoints |
| web: `bun run web`, Chrome journey, Chinese opening, demo controls, three-track AudioWorklet | PASS; 3,500-frame journey, zh 13/13, 0 console errors, 0 audio underruns |
| PSP: pinned toolchain bootstrap; `bun run build:psp --skip-assets` | PASS; 66,069,600 bytes external, 1,219,632 bytes embedded |
| PSP runner setup: `sudo apt-get update && sudo apt-get install -y llvm-18` | Host-only setup could not elevate (`sudo: a password is required`); installed `llvm-ar`, `llvm-ranlib` and `llvm-objcopy` are LLVM 18.1.3, and both PSP builds pass with them |

Additional `_common` gates also pass: the single-process game `bun run test`
run (1,187 pass, 1 skip, 0 fail), RPG Kit TypeScript and 4,101 tests/0
failures, `bun run build`, rebuilt
PocketJS wasm, full GB6 stateful + 60/30/20 Hz, and the full (assets included)
PSP package. Radio pixel/touch goldens pass at 480x272 and 960x544. Bundle pins
were updated only for measured code growth; Sunstone is 1,002,250 bytes and
remains below its 1,004,000-byte cap. `bun.lock` is unchanged.

Subagent use: 4 / import and CI command audit; upstream radio/time semantics
and deterministic-clock audit; exact-speed math, authored-rate and mutation
audit; Dojo/save-boundary audit / yes, the parallel read-only work found the
missing current-state path, complete rate set, and edge cases while the main
agent performed integration and every heavy gate.

PASS
