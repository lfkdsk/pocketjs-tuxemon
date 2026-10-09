# Importer

All game content is imported, never hand-authored: maps, terrain, events,
NPCs, dialogue, shops, items, monsters and battle data come from a pinned
Tuxemon checkout by running `bun run import`. When an import is wrong, the
fix goes into the importer (or into a missing engine capability), and the
whole import is re-run.

The importer also projects Tuxemon's `.world` topology into the project's
optional `worldLayout`. It contains only corrected outdoor placements,
evidence-approved seams and their per-portal safety classification, grouped
into connected components; diagnostic gaps, rejected contacts and source
text stay in `dist/world-index.json`. The source index `contentHash` becomes
the layout's `topologyHash`. Because the splitter retains this project-level
field in `project-shell.json`, it is covered by `mapManifestHash` without
changing any map shard. Placed outdoor maps opt into Pocket RPG Kit's
component-bounded terrain renderer: neighbouring ground, upper layers and
animated tiles can be visible across a seam, while its working-set driver
bounds parsed and compiled maps and the game evicts terrain and NPC-art
provider entries outside the corresponding visible/active sets. The transfer
interpreter uses stable portal IDs to perform an eight-tick atomic handoff for
proved direct `playerTouch` crossings. A wide fixed-destination portal on a
seam funnels every lane to one authored landing; each lane whose walk across
the edge passes the final cooked-terrain exit/entry proof is emitted as its
own 1×1 event whose transfer lands on that lane's coordinate-continuous
neighbour cell (the first cell keeps the original area-event id, so no other
event is renumbered). Lanes that fail the proof keep the authored fade and
fixed landing and carry no handoff marker. The runtime resolver additionally
requires the landing to be the continuous cell, so the lowering fails closed.
Surf-only water openings (Spyder Route C to Candy Town, Paper Town and Candy
Port; Classic Route 4 to Stormpeak) stay legacy: the runtime proves a crossing
against immutable terrain, where water is solid until a map visit opens it. The deterministic inventory in
`reports/outdoor-seam-audit.json` records every promoted and retained outdoor
portal.

## Source checkout

`bun run fetch:tuxemon` checks out Tuxemon at the pinned commit
(`9e6258ff`, recorded in `tools/fetch-tuxemon.sh`) into the repo-local
`.tuxemon-src/`. The checkout is blobless and sparse: fonts and docs are
excluded, but all 24 content-resolvable music tracks and the three used SFX
are included (see [verification](verification.md) for the audio pipeline). To
reuse an existing checkout instead, set `TUXEMON_SRC` to its path; the
importer reads it from `importer/source.ts` and the art cookers, and
battle art and events always come from the same checkout.

## How Tuxemon events become kit commands

Tuxemon events live in TMX object layers and in per-map scenario YAML. Each
event is an ordered list of rules; every rule has conditions (`is`/`not`
checks) and actions. The converter in `importer/project.ts` turns each event
into a kit event page:

1. The page's trigger is chosen from the guard shape (`importer/shapes.ts`):
   a position/facing guard becomes `playerTouch`, an action-key guard becomes
   `action`, an unconditional page becomes `autorun` or `parallel`.
   Conditions such as `char_at`, `char_facing`, `button_pressed` and
   `char_moved` are consumed by this choice — the kit trigger *is* the
   predicate.
2. The remaining conditions become kit `if` clauses. Story state maps to
   switches and variables; battle state maps to `tux.*` extension calls (see
   [architecture.md](architecture.md)).
3. The actions become kit commands. The dispatch is the `switch` over
   action names in `convertActions`; each branch records its disposition in
   the coverage report (see below).

The kit's event vocabulary at the current pin is 35 command ops (text,
choices, switch, variable, transfer, moveRoute, lockInput, place, shop,
battle, ext, and so on) and 10 condition kinds. The importer emits 18 of
those ops plus the `tux.*` extensions.

## Mapping categories

Every converted rule is recorded with one of four dispositions. The
definitions below are the report's own:

- **Native** — represented by current kit commands without gameplay loss.
- **Degraded** — runs in the kit with a documented limitation or importer
  lowering.
- **Placeholder** — deliberate visible or deterministic stand-in behavior.
- **Dropped** — no equivalent output, including rules inside events the
  converter proves cannot start.

### Native examples

| Tuxemon | Kit output |
|---|---|
| `translated_dialog` | `text` boxes, translated from the selected message catalog and word-wrapped. Authored `position`, `h_alignment` and `v_alignment` values become the kit's placement/alignment fields on every continued page; omitted or default values remain omitted, so ordinary dialogs keep their previous bytes. |
| `autosave` | the native `autosave` command. After the fiber advances, the host receives that command-tick snapshot when it is recoverable (including text, choices and shop modals); otherwise publication waits for the first recoverable reference tick. Browser and desktop persist it in a separate read-only automatic slot. |
| `set_variable` / `clear_variable` | `variable` commands; string values are enum-coded globally. Variables that scripts compute with or print (`variable_math`, `format_variable`, `${{var:name}}`, joined through `copy_variable`) instead hold the literal text via `tux.set_variable_text`; their `variable_set` checks become `tux.variable_text` (only "not set" stays a native `== 0`). |
| `variable_math` / `format_variable` | `tux.variable_math` / `tux.format_variable` store Python's `str()` of the CPython result (float arithmetic, floor division to int, `int()`/`float()` with optional negation); the type is read back from that text. Upstream's error paths (missing or non-numeric operand) leave the variable unchanged. |
| `${{var:name}}` in dialogue | the kit's `{v:<id>}` text token (`system.textVariables`), printing the stored text. |
| `set_mission <character>` | nothing: upstream only walks missions already held by the character, and nothing ever creates one, so the action always logs "no missions" and stops. |
| `remove_step_tracker`, `set_step_tracker_milestone_shown`, `is step_tracker` | `tux.*` commands and condition over the saved per-character trackers: a milestone is pending while triggered and not yet shown. |
| `lock_controls` / `unlock_controls` | `lockInput` / `unlockInput`. |
| `transition_teleport` (player, in bounds) | `transfer`; a trailing facing action folds into the transfer direction. With battles on, `tux.clear_npc_parties` runs right before every transfer (also `teleport_faint`'s), and each map has one entry page (`e000_npc_parties`) that runs it once per visit for entries that are not transfers: as upstream `change_map`, every map change drops all non-persistent NPCs' parties. |
| `start_battle` (player vs trainer) | `battle` with a trainer setup; literal trainer parties are folded in. |
| `random_encounter` / `wild_encounter` | `battle` with a random-table setup. The encounter roll, daytime filtering and weighted row selection run on the saved RNG cursor (the project's deliberate determinism); repellent, level scaling and held items are unused in the corpus. |
| `set_party_status player` | `tux.set_party_status` writes `party_lost_hp` (the sum of the party's missing HP) as a text variable. |
| `modify_money player,,<var>` | `tux.modify_money` resolves the amount from the text variable (an int is direct, a float is a wallet ratio) and refuses an overdraft, matching upstream. |
| `is/not money_is player,<op>,<var>` | `tux.money_is` compares the wallet against the variable's int value, with the authored operator and negation. |
| `info <var>,<attr>` | `tux.info` reads the monster whose iid the variable holds (searched across the party, kennel, boxes and NPC parties) and writes `info_<attr>` (the corpus uses `level`). |
| `create_npc` / `remove_npc` | a presence variable plus a `place` command for the walker. With battles on, creating an NPC that is not on the map and removing one both clear its party (`tux.clear_npc_party`): as upstream, an NPC's party lasts only as long as the NPC. |
| `char_stop` | `moveControl` stop, cancelling the active route and page patrol. |
| `char_wander` | `moveControl` random wander with the source's exact 60 Hz attempt interval and inclusive bounds. The attempt clock resets before modal, movement, observation and bounds checks; cardinally adjacent NPCs pause while the player faces them, and skipped attempts consume no seeded-RNG draw. |
| `set_facing_mode` | `moveControl` facingMode (locked / followMovement). |
| `char_position` | an exact `place` after import validates that both coordinates are integers inside the map; invalid source coordinates fail the import, as upstream raises instead of clamping. An immediately following `char_face` folds into the placement direction. |
| `add_step_tracker player,…` | `tux.add_step_tracker`; the opted-in `playerStep` hook reports signed `dx`/`dy` for ordinary steps, transfers and direct placement. Trackers consume `dx+dy`; the shared daycare consumes one step per hook call. |
| `char_run` (both authored uses) | no command: Christie and Bjorn are idle at the call, so upstream's moving-only run-rate change is an exact no-op and cannot latch onto a later forced route. |
| `char_speed` | `moveControl` routeSpeed scoped to the active or next forced route, or to the first successfully committed tile after command-started wander, then cleared on idle as upstream does. The optional `tilesPerSecond` field carries the exact authored rate on the fixed 60 Hz clock; the MV grade remains as a fallback for older project documents. |
| `is battle_outcome` | `tux.battle_outcome` extension condition reading live battle history. |
| `is check_char_parameter player,moving,1` | the live `playerMoving` condition on an automatic page. It is map-wide and observes whether the player had a committed interpolating step at the start of the reference tick, matching upstream's event-before-world-update ordering. |
| `is/not check_char_parameter player,name,<value>` | `tux.player_name_is` compares the live saved player name exactly and case-sensitively. |
| `is/not has_tuxepedia player,<species>,seen/caught` | `tux.has_tuxepedia` reads the exact saved player Tuxepedia status; caught does not also count as seen. |
| `is/not char_healed player` | `tux.char_healed` requires a non-empty party whose members are all at full HP; status ailments do not change the answer. |
| `add_monster`, `set_monster_health`, `set_monster_status`, `set_monster_level`, `evolution`, `remove_monster` | the matching `tux.*` extension command. All three authored level boosts preserve the monster iid, apply the exact level and experience floors, recalculate stats while retaining the HP deficit, learn scheduled moves, and mark a newly available evolution. `remove_monster` resolves the iid globally and deletes from the player party, kennel, or an NPC party. A trainer's battle party stays in `npcParties` for the rest of the NPC's lifetime. |
| `get_party_monster` (Nimrod `Zircon Back`, ApexPlayer cheat) | `tux.get_party_monsters` writes the selected trainer's or player's iids into `iid_slot_*`, which the following `remove_monster` consumes. |
| `get_player_monster` | `extChoice` over the live party for the 15 general enum pickers. The two uses that feed an adjacent `rename_monster` open a saved, non-cancellable party-picker scene, retain the selected monster's stable iid, and skip name entry when the party is empty. |
| `choice_monster` | an authored `choices` box whose rows show the monster's static menu-face icon beside its translated name; each row writes its positive enum code into the result variable. |
| `open_shop` (item economy) | the kit `shop` command with imported goods, prices and stock. |
| `open_shop …,buy_monster` | the `tux.monsterShop` scene with the economy's monster rows (price, level, stock); purchases are saved per stock label. |
| `access_pc player` | the `tux.pc` storage scene: monster boxes plus the item locker (deposit, withdraw with a quantity picker, disband). |
| `trading <variable>,<species>` | the `tux.trade` scene, which replaces the monster whose iid the variable holds. |
| `create_kennel` / `set_kennel_visible`, `is kennel` / `is has_kennel` | `tux.create_kennel` / `tux.set_kennel_visible` commands and `tux.kennel` / `tux.has_kennel` conditions over the saved player boxes. |
| `play_music` | `playBgm`; each of the 21 valid content slugs resolves through the `Project.audio` table to a committed QOA pak entry. Six authored arguments (eight actions) are raw filenames, misspellings or absent DB slugs and stay silent, matching Tuxemon's exact DB lookup. |
| `fadeout_music` | `fadeoutBgm` (ms → seconds); `0` becomes `stopBgm`. |
| `pause_music` / `unpause_music` | `pauseBgm` / `resumeBgm`. |
| `play_sound` | `playSe` with the authored volume carried through; resolves through `Project.audio` to a WAV pak entry. |
| `is music_playing` / `not music_playing` | `bgmPlaying` (with `negate`); Tuxemon's paused/combat inversion is safe for the map-enter guard idiom. |
| `tune_radio` | the blocking `tux.radio` tuner scene, with the authored 88–108 MHz range, 0.1 MHz steps, signal threshold and map/time/variable-first broadcast selection. It imports the source-order station catalog and translated dialogue, plays static when no signal is strong enough, supports controller/keyboard/scaled touch, and resumes the originating event at the same map position. |
| `screen_transition` | two blocking `screenFade` commands that retain each fade half's source duration and RGBA colour. |
| `play_map_animation` / `play_tile_animation` | `mapAnim` at the sampled character tile or fixed source tile. |
| `set_layer` | a native screen `layer` selecting or clearing a packaged RGBA or PNG overlay. |
| `camera_position`, `set_bubble`, `change_bg`, `change_bg_char`, `set_template` | native camera, balloon and walking-appearance commands plus modal-safe backdrop lowerings within the limits in [the status list](status.md#presentation). |

### Degraded examples

| Tuxemon | Lowering |
|---|---|
| `char_face player,<dir>` | a `moveRoute` with the kit's native `faceUp`/`faceDown`/… step; the step applies on the next boundary tick (upstream faces immediately), so the turn lands one tick after the command. A `char_face` immediately after a `char_position` folds into the placement's `dir` instead, and a spawn-event `char_face npc,<dir>` becomes the NPC page's native initial `dir`. |
| `add_tracker` | a `switch`; step counters are not modeled. |
| `transition_teleport` with an out-of-range landing | coordinates clamped into the target map; an isolated landing is repaired to the nearest walkable cell by deterministic four-neighbour BFS. |
| `choice_npc` | static `extChoice` list; the shared label is extended with each option's translated name so the lines stay distinguishable (upstream tells options apart by per-option NPC portraits, which need kit option-image support). |
| `get_party_monster` (dojo, gym) | `tux.get_party_monsters` dumps the party iids into `iid_slot_*`; NPC trainer parties are staged live (not folded) when an event inspects them, so the dojo and gym calls find a party. |
| `load_yaml` | a gating variable; the referenced events are merged at import time and unlock when the action runs. |

### Degraded battle examples

The remaining non-native battle behavior is explicit and reported by source type (0 Placeholder uses remain):

| Tuxemon | Stand-in |
|---|---|
| `start_battle` (NPC vs NPC, 5 uses) | a watchable spectator fight in the real battle scene: both parties, their techniques, damage and results play out with no player menus (confirm toggles 1x/2x/4x fast-forward, cancel skips to the result); the outcome matches the headless resolver exactly — one RNG draw from the saved cursor, post-spawn seed, seeded AI policy on both sides — and a decisive fight records `battle_last_winner`/`battle_last_loser`/`battle_last_trainer` per upstream, while a true draw writes the draw code and the fighter (challenger) trainer code as a deterministic fallback (upstream raises before either result variable is written). |

`is party_infected` is a live extension condition over the per-monster plague
state (all/some/none), not a constant: `char_plague` infects or inoculates a
whole party and `quarantine` confiscates infected monsters into the hidden
`boxes.quarantine` box.

`time_is` now reads the deterministic saved calendar in all 128 materialized
uses. `update_time` writes the eight upstream time variables. The shared
Spyder and Xero `TeleporterState` events are lowered to the equivalent
destination-map entry point and therefore refresh those variables once per
transfer; the remaining source use belongs to `battle_menu.yaml`, which has no
map and is not part of the imported title-screen Battle mode.

Earlier in the project, all battles were placeholders (a text line plus win
switches). Real battles replaced them: `start_battle`, `random_encounter`,
`wild_encounter`, `add_monster`, party and battle-outcome conditions,
faint-point actions and environment checks are now native.

The shared Spyder Surf scenario is a corpus-level terrain lowering rather
than a new engine condition. The terrain import already has every exact
`surfable` cell, so the event importer coalesces the Spyder scenario's water
cells into action areas and adjacent land into touch areas. The former is only
reachable from shore while not swimming; it requires the Surfboard, shows the
upstream translated Yes/No choice, opens the facing water rectangle, switches
to the swimmer appearance and performs the authored forward step. The existing
whole-label passage pages then open the rest of the water for that map visit.
The latter restores the walking appearance and closes the label on shore.
Generated shoreline pages are coalesced separately from source-authored event
areas, so adding Surf does not split or renumber existing area-event IDs; their
item/appearance guards also keep them absent from pre-Surfboard runtime state.
This preserves the seven cooperating `char_in` uses and all five labelled
surface-facing uses without pretending the project schema has a general
live-player-cell predicate. The other two `char_facing_tile` rows are not
terrain queries: they are ordinary no-label facing triggers on Radio events,
and both now open the native imported tuner.

The 38 `is check_char_parameter player,moving,1` encounter guards use the
native map-wide `playerMoving` condition on automatic pages. The sampled value
is false on the tick that first commits a step, true on every interpolation
tick including landing, and independent of the source TMX marker. This follows
Tuxemon's event-before-world-update order, stays identical at 60/30/20 Hz and
survives save/restore and rewind. The Spyder Surf events above are intercepted
as a complete cluster before this generic path and therefore cannot also emit
source-derived pages. On Route D, the moving encounter remains its independent
parallel guard while the generated land dismount folds into the existing
arrival-trigger partition at the shared marker; the two behaviors no longer
compete for one arrival edge.

### Dropped examples

| Tuxemon | Reason |
|---|---|
| `char_facing player,top/bottom`, `button_pressed K_RETURN` | these legacy source arguments are invalid in the pinned Tuxemon runtime: directions are `up/down/left/right`, and `K_RETURN` is not an intention constant. They remain fixed false instead of being reported as native triggers, except that the five geometrically proved Route 3 south exits repair their pinned `bottom` typo to `down` in the guard, trailing face and transfer direction. |
| `add_step_tracker` and friends for a non-player character | the kit's step hook reports only the player's completed tiles (the pinned content tracks the player only). |
| `copy_variable` between enum-coded variables | enum codes are numbered per variable, so only variables that hold text copy verbatim. |
| `transition_teleport` targeting an NPC | only the player transfers. |
| `create_npc`, `random_monster`, `not char_exists`, … in `test_spyder_cotton_*` / `battle_menu` scenario YAML | these files have no same-slug TMX and no `scenario=` reference, and no `load_yaml` pulls them in, so no map ever materializes them in the pinned source either. |
| `translated_dialog` with a msgid absent from every catalog | five keys (three in `spyder_test_map`, `spyder_flower_sandy_willtrade`, `water_nice_mayor12`) exist in no `.po`; the fallback shows the raw key. |
| `set_party_status`, `get_pending_moves`/`remove_tech` in `is current_state Combat*`-guarded events | the kit does not run map fibers inside combat/menu states. The combat move-deletion choice is covered by the battle runtime's deterministic progression (auto-forget the first move). The separate shared `update_time` TeleporterState hooks are lowered at destination-map entry as described above. |
| rules inside structurally discarded events | the event never starts (inert, zero-size, fixed-false guard, trigger area outside the map, or over the 64-cell area cap), or it is not materialized by any map. |

Per-rule drop reasons are retained in `dist/import-report.json`.

## The coverage report

`bun run import` regenerates `reports/G1-coverage.md` and
`reports/G1-coverage.zh_CN.md` (the committed files in `reports/`) and the
machine-readable `dist/import-report.json`. The report contains:

- a summary table per kind (actions, conditions): number of source types,
  uses, and the four disposition tallies, plus the S1 acceptance baselines;
- the "executable" share (native + degraded + deliberate placeholder);
- a per-source-type table with the four tallies, so a regression in any
  mapping shows up as a row change;
- audits: the remaining battle/monster placeholders, the economy and item
  catalog, the outdoor world index, transfer repairs, and source/native/drop
  counts for each optional dialogue-layout parameter.

The committed report is generated with the full G6 import profile (all
maps, routes, input locks, battles). Running `importer/index.ts` directly
uses the smaller default profile, whose counts are pinned in
`tests/importer.test.ts`; a mapping change can require updating both.

Current coverage (G6 profile):

| Kind | Types | Uses | Native | Degraded | Placeholder | Dropped | Executable |
|---|---:|---:|---:|---:|---:|---:|---:|
| Actions | 98 | 13,617 | 13,108 | 242 | 0 | 267 | 98.0% |
| Conditions | 64 | 8,663 | 8,423 | 21 | 0 | 219 | 97.5% |

## Adding or changing a mapping

1. **Convert.** Add the action case to `convertActions` in
   `importer/project.ts` (conditions go in `clauses`). If the condition is
   trigger-shaped (position, facing, button), it belongs in the trigger
   classifier `importer/shapes.ts` instead.
2. **Record the disposition in the same branch** by calling `noteAction` /
   `noteCondition` with the fate code: `T1` (native), `T1-lowered`
   (degraded), `T3-placeholder` (placeholder), or `T2-dropped` /
   `T3-dropped` / `T4-dropped` (dropped). A branch that emits nothing must
   still record its disposition; unrecorded rules default to dropped. If the
   whole event must be discarded, call `dropAll` on the event coverage with
   the reason.
3. **Regenerate.** Run `bun run import` and read the new row in
   `reports/G1-coverage.md`. The import must leave `git status --porcelain`
   empty apart from the regenerated files, and two isolated imports must be
   byte-identical (`bun run verify:g6:determinism`).
4. **Pin it in tests.** `tests/importer.test.ts` pins the default-profile
   coverage counts, per-row tallies, and a sha256 of the generated output
   for two maps; update the pins. Add a focused test for the new mapping.
5. **Re-run the journeys** that exercise the area:
   - `bun run verify:g6:locks` for anything touching input locks or
     transfers;
   - `bun run verify:gb6:mainline` and `bun run verify:j1:mainline` for the
     mainline story;
   - `bun run verify:gb6:failures` for defeat and recovery paths.
   See [verification.md](verification.md) for what each proves.
