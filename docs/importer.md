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
interpreter still does not perform seamless handoff.

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
| `translated_dialog` | `text` boxes, translated from the en_US message catalog and word-wrapped. |
| `set_variable` / `clear_variable` | `variable` commands; string values are enum-coded globally. Variables that scripts compute with or print (`variable_math`, `format_variable`, `${{var:name}}`, joined through `copy_variable`) instead hold the literal text via `tux.set_variable_text`; their `variable_set` checks become `tux.variable_text` (only "not set" stays a native `== 0`). |
| `variable_math` / `format_variable` | `tux.variable_math` / `tux.format_variable` store Python's `str()` of the CPython result (float arithmetic, floor division to int, `int()`/`float()` with optional negation); the type is read back from that text. Upstream's error paths (missing or non-numeric operand) leave the variable unchanged. |
| `${{var:name}}` in dialogue | the kit's `{v:<id>}` text token (`system.textVariables`), printing the stored text. |
| `set_mission <character>` | nothing: upstream only walks missions already held by the character, and nothing ever creates one, so the action always logs "no missions" and stops. |
| `remove_step_tracker`, `set_step_tracker_milestone_shown`, `is step_tracker` | `tux.*` commands and condition over the saved per-character trackers: a milestone is pending while triggered and not yet shown. |
| `lock_controls` / `unlock_controls` | `lockInput` / `unlockInput`. |
| `transition_teleport` (player, in bounds) | `transfer`; a trailing facing action folds into the transfer direction. With battles on, `tux.clear_npc_parties` runs right before every transfer (also `teleport_faint`'s), and each map has one entry page (`e000_npc_parties`) that runs it once per visit for entries that are not transfers: as upstream `change_map`, every map change drops all non-persistent NPCs' parties. |
| `start_battle` (player vs trainer) | `battle` with a trainer setup; literal trainer parties are folded in. |
| `random_encounter` / `wild_encounter` | `battle` with a random-table setup. |
| `create_npc` / `remove_npc` | a presence variable plus a `place` command for the walker. With battles on, creating an NPC that is not on the map and removing one both clear its party (`tux.clear_npc_party`): as upstream, an NPC's party lasts only as long as the NPC. |
| `char_stop` | `moveControl` stop, cancelling the active route and page patrol. |
| `set_facing_mode` | `moveControl` facingMode (locked / followMovement). |
| `is battle_outcome` | `tux.battle_outcome` extension condition reading live battle history. |
| `is/not check_char_parameter player,name,<value>` | `tux.player_name_is` compares the live saved player name exactly and case-sensitively. |
| `is/not has_tuxepedia player,<species>,seen/caught` | `tux.has_tuxepedia` reads the exact saved player Tuxepedia status; caught does not also count as seen. |
| `is/not char_healed player` | `tux.char_healed` requires a non-empty party whose members are all at full HP; status ailments do not change the answer. |
| `add_monster`, `set_monster_health`, `set_monster_status`, `evolution`, `remove_monster` | the matching `tux.*` extension command; `remove_monster` resolves the iid globally and deletes from the player party, kennel, or an NPC party. A trainer's battle party stays in `npcParties` for the rest of the NPC's lifetime. |
| `get_party_monster` (Nimrod `Zircon Back`, ApexPlayer cheat) | `tux.get_party_monsters` writes the selected trainer's or player's iids into `iid_slot_*`, which the following `remove_monster` consumes. |
| `get_player_monster`, `choice_monster` | `extChoice` over the live party or a static enum-coded list. |
| `open_shop` (item economy) | the kit `shop` command with imported goods, prices and stock. |
| `open_shop …,buy_monster` | the `tux.monsterShop` scene with the economy's monster rows (price, level, stock); purchases are saved per stock label. |
| `access_pc player` | the `tux.pc` monster-storage scene (Degraded: no item locker). |
| `trading <variable>,<species>` | the `tux.trade` scene, which replaces the monster whose iid the variable holds. |
| `create_kennel` / `set_kennel_visible`, `is kennel` / `is has_kennel` | `tux.create_kennel` / `tux.set_kennel_visible` commands and `tux.kennel` / `tux.has_kennel` conditions over the saved player boxes. |
| `play_music` | `playBgm`; each of the 21 valid content slugs resolves through the `Project.audio` table to a committed QOA pak entry. Six authored arguments (eight actions) are raw filenames, misspellings or absent DB slugs and stay silent, matching Tuxemon's exact DB lookup. |
| `fadeout_music` | `fadeoutBgm` (ms → seconds); `0` becomes `stopBgm`. |
| `pause_music` / `unpause_music` | `pauseBgm` / `resumeBgm`. |
| `play_sound` | `playSe` with the authored volume carried through; resolves through `Project.audio` to a WAV pak entry. |
| `is music_playing` / `not music_playing` | `bgmPlaying` (with `negate`); Tuxemon's paused/combat inversion is safe for the map-enter guard idiom. |
| `screen_transition` | two blocking `screenFade` commands that retain each fade half's source duration and RGBA colour. |
| `play_map_animation` / `play_tile_animation` | `mapAnim` at the sampled character tile or fixed source tile. |
| `set_layer` | a native screen `layer` selecting or clearing a packaged RGBA or PNG overlay. |
| `camera_position`, `set_bubble`, `change_bg`, `change_bg_char`, `set_template` | native camera, balloon, backdrop and walking-appearance commands within the limits in [the status list](status.md#presentation). |

### Degraded examples

| Tuxemon | Lowering |
|---|---|
| `char_face player,<dir>` | one-step `moveRoute` (the kit has no face op); a `char_face` immediately after a `char_position` folds into the placement's `dir` instead. |
| `add_tracker` | a `switch`; step counters are not modeled. |
| `add_step_tracker player,…` | `tux.add_step_tracker`; the kit's `playerStep` hook (shared with the daycare) moves every player tracker by one per completed tile, where upstream subtracts the signed tile delta (dx+dy) and also counts teleports. |
| `transition_teleport` with an out-of-range landing | coordinates clamped into the target map; an isolated landing is repaired to the nearest walkable cell by deterministic four-neighbour BFS. |
| `char_wander` | `moveControl` random wander with a deterministic seed, a seconds-to-MV frequency grade and optional bounds. |
| `char_speed` | `moveControl` speed; tiles/s maps to the nearest MV exponential grade. |
| `char_position` | a clamped `place` (out-of-map coordinates are clamped; upstream raises). |
| `choice_npc` | static `extChoice` list; the shared label is extended with each option's translated name so the lines stay distinguishable (upstream tells options apart by per-option NPC portraits, which need kit option-image support). |
| `get_party_monster` (dojo, gym) | `tux.get_party_monsters` dumps the party iids into `iid_slot_*`; NPC trainer parties are staged live (not folded) when an event inspects them, so the dojo and gym calls find a party. |
| `load_yaml` | a gating variable; the referenced events are merged at import time and unlock when the action runs. |

### Degraded battle examples

The remaining non-native battle behavior is explicit and reported by source type (0 Placeholder uses remain):

| Tuxemon | Stand-in |
|---|---|
| `start_battle` (NPC vs NPC, 5 uses) | a name card, then a headless AI-vs-AI auto-resolution through the battle rules with the saved RNG (the battle seed continues from the post-spawn cursor); a decisive fight records `battle_last_winner`/`battle_last_loser`/`battle_last_trainer` per upstream, while a true draw writes the draw code and the fighter (challenger) trainer code as a deterministic fallback (upstream raises before either result variable is written). |

`is party_infected` is a live extension condition over the per-monster plague
state (all/some/none), not a constant: `char_plague` infects or inoculates a
whole party and `quarantine` confiscates infected monsters into the hidden
`boxes.quarantine` box.

`time_is` now reads the deterministic saved calendar in all 128 materialized
uses. `update_time` writes the eight upstream time variables; its three source
uses sit in events dropped for other reasons, so the isolated importer fixture
exercises that command shape directly.

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
This preserves the seven cooperating `char_in` uses and five surface-facing
uses without pretending the project schema has a general live-player-cell
predicate. Two unrelated surface-facing uses remain dropped.

The 38 `is check_char_parameter player,moving,1` encounter guards use one
separate, consistent lowering. Trigger classification turns each source event
into a completed-step `playerTouch` page on its authored cells, and condition
conversion consumes the moving guard instead of emitting another condition or
page. This is deterministic across tick rates and cannot double-fire, but it
is narrower than Tuxemon's map-wide velocity test, so coverage reports it as
Degraded. The Spyder Surf events above are intercepted as a complete cluster
before this generic path and therefore cannot also emit source-derived pages.
At the one Route D cell where a generated land boundary overlaps a moving-
encounter page, the importer folds the dismount guard and body into that
source page's existing guard-latch chain and removes the cell from the
standalone boundary. Both matching source behaviors run once from the same
completed-step edge; neither page can consume the edge before the other.

### Dropped examples

| Tuxemon | Reason |
|---|---|
| `char_run` | upstream applies the absolute run rate only while the character is already moving and reverts on idle; the kit's run control is a persistent relative grade with no movement-scoped lifetime, so the action emits nothing. |
| unsupported live-cell terrain predicates outside the Spyder Surf cluster | project conditions still do not expose a general current/facing terrain-label query; the two remaining unrelated surface-facing uses emit nothing. Completed-step movement guards and the known Surf cluster use the specialized lowerings described above. |
| `char_facing player,top/bottom`, `button_pressed K_RETURN` | these legacy source arguments are invalid in the pinned Tuxemon runtime: directions are `up/down/left/right`, and `K_RETURN` is not an intention constant. The guards are fixed false instead of being reported as native triggers. |
| `add_step_tracker` and friends for a non-player character | the kit's step hook reports only the player's completed tiles (the pinned content tracks the player only). |
| `copy_variable` between enum-coded variables | enum codes are numbered per variable, so only variables that hold text copy verbatim. |
| `autosave` | a pure reducer event cannot request that the host persist autosave slot 0. |
| `transition_teleport` targeting an NPC | only the player transfers. |
| `modify_money` with a variable amount | only literal amounts are supported. |
| rules inside structurally discarded events | the event never starts (inert, zero-size, fixed-false guard, trigger area outside the map, or over the 64-cell area cap), or it is not materialized by any map. |

Per-rule drop reasons are retained in `dist/import-report.json`.

## The coverage report

`bun run import` regenerates `reports/G1-coverage.md` (the only committed
file in `reports/`) and the machine-readable `dist/import-report.json`. The
report contains:

- a summary table per kind (actions, conditions): number of source types,
  uses, and the four disposition tallies, plus the S1 acceptance baselines;
- the "executable" share (native + degraded + deliberate placeholder);
- a per-source-type table with the four tallies, so a regression in any
  mapping shows up as a row change;
- audits: the remaining battle/monster placeholders, the economy and item
  catalog, the outdoor world index, and transfer repairs.

The committed report is generated with the full G6 import profile (all
maps, routes, input locks, battles). Running `importer/index.ts` directly
uses the smaller default profile, whose counts are pinned in
`tests/importer.test.ts`; a mapping change can require updating both.

Current coverage (G6 profile):

| Kind | Types | Uses | Native | Degraded | Placeholder | Dropped | Executable |
|---|---:|---:|---:|---:|---:|---:|---:|
| Actions | 98 | 13,617 | 12,193 | 1,100 | 0 | 324 | 97.6% |
| Conditions | 64 | 8,663 | 8,364 | 56 | 0 | 243 | 97.2% |

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
