# START party, bag, player, and exit

## Result

The in-world START menu now provides a production party browser, field bag,
player page, and upstream-style Exit flow. The title screen now publishes
save-dependent Load and Autosave rows and a host-aware Exit row. Tuxepedia is
inserted only while its imported app item is owned. All of these paths use the
live campaign session and real imported Tuxemon data; none is a fixture-only
screen.

The implementation is game-repository-only. It adds no save field, changes no
schema identity, and leaves both RPG Kit and PocketJS at their baseline
revisions. A save written by the unmodified baseline loaded in this build and
continued through the remaining campaign tape to the unchanged terminal.

Missions remain Planned because the pinned campaign's mission actions are
upstream no-ops and there is no populated mission list. Options remains
Partial because language selection exists but input remapping does not. Those
two explicitly excluded areas were not relabelled as complete.

## Upstream behavior and port mapping

The behavior was compared with the pinned Tuxemon sources rather than inferred
from the old placeholder menu:

| Feature | Upstream source | Port behavior |
| --- | --- | --- |
| Party list and submenu | `tuxemon/states/monster_menu.py` | Live party portraits, names, levels, HP, status, Info, Techniques, Move, Sort, and Release |
| Party detail | `tuxemon/states/monster_info.py` | Species/element, level and experience, gender, taste, bond, physical fields, and the six live stats |
| Techniques | `tuxemon/states/monster_moves.py` | Localized current techniques with type, range, power, potency, and accuracy |
| Reorder and sort | `MonsterMenuHandler` | Direct move plus upstream level, HP ratio, localized-name, and Tuxepedia-ID ordering; the live array is persisted |
| Release | `MonsterMenuHandler.release_monster` | Imported confirmation copy; the last party member cannot be released |
| Bag list | `tuxemon/states/item_menu.py` | Acquisition-order pages are sliced before upstream sort order; each row shows imported icon, category, quantity, name, and description |
| Field item use | upstream item conditions/effects and controllers | Target and map guards, consumption timing, success/failure copy, monster effects, and typed field directives |
| Player page | `tuxemon/states/character.py` | Live name, wallet, playtime, seen/caught counts, and player-side battle outcome summary |
| START Exit | `tuxemon/world/manager.py` `quit_world` callback | No save prompt; the world object is replaced with a fresh authored session and title reopens |
| Title Load/Autosave | `tuxemon/states/start.py` | Healthy manual saves add Load first; Autosave is offered only when both a healthy manual save and healthy automatic save exist |
| Title Exit | `StartState.exit_game` | Desktop sends PocketJS's quit service intent; a host without close authority stays on a localized terminal page |

Upstream's held-item equip/swap actions are not exposed. The current persistent
monster snapshot has no held-item slot, so presenting those rows would either
lose state or invent a second incompatible inventory model. The implemented
view, reorder, sort, and release actions all map to existing persistent state.

## Party and player pages

The party root is derived on every open from the live extension party. It
renders the imported lazy front sheet and localized species/status data rather
than copying display fields into menu state. Info and Techniques are read-only;
Move, Sort, and confirmed Release replace only the live party array. Solo
parties hide Move, Sort, and Release, matching upstream's safety rule.

The order written by Move or Sort is the same array read by battle setup, so
the first member of the next battle changes immediately. The four sort
comparators match upstream: ascending level, descending HP ratio, ascending
case-folded display name, and ascending positive Tuxepedia ID. Release requires
an explicit localized Yes/No choice and never permits an empty party.

The player page reads the current player name and gold, uses the saved 60 Hz
game clock rather than host-frame or map-frame counters, unions caught species
into the seen count, and summarizes only history entries whose fighter is the
player. Its values therefore survive transfer, save/load, and rewind without
adding a parallel profile record.

## Bag and out-of-battle item semantics

The importer now retains item `sort`, localized category, localized name and
description, world-usage locations, behaviors, conditions, effects, messages,
stat modifiers, status immunities, and item art in the localized runtime
catalog. The project-wide catalog still contains 224 unique slugs from 230
source rows; the field reducer operates on the 114 imported item definitions
that carry executable battle/world rules. The coverage report now distinguishes
the working game-owned Bag from the still-missing generic `Project.items`
description field.

The list follows `ItemMenuState`: hidden and zero-count stacks are filtered,
acquisition order is divided into eleven-item pages, and only then is each page
sorted by upstream rank and localized name. Horizontal swipes turn pages;
vertical swipes and directional input move selection. Combat-only items remain
visible and return the imported cannot-use-here message without writing state.

The pure item reducer covers:

- HP restoration and status cures, including the upstream distinction between
  a target rejected before use and a selected attempt whose condition later
  fails;
- experience tea, level/stat/move progression, item-specific evolution, and
  training-point grants with imported caps;
- TMs, including the four-move forget picker and duplicate/base-tag guards;
- repellent installation without replacing an active tracker;
- escape keys and persisted faint points;
- fishing and facing-tile/facing-sprite field tools.

The reducer never mutates its inputs. Map-facing work is returned as typed
directives and applied by the live session shell: transfers remain reducer-
owned, fishing queues a production wild battle, and destructible facing actors
write the same visibility variables used by imported events. An item is
decremented exactly once when upstream says the attempt consumes it. A potion
aimed at a full-HP monster is refused before use and consumes nothing; a
festering target that fails after selection consumes the attempted potion and
shows its failure copy.

The 73,157-byte map-rule table is a dedicated PAK entry loaded only when the
Bag actually needs a world predicate or directive. START boot keeps only the
46,768-byte feature shell; ordinary startup and party/player browsing do not
parse field-item rules.

## Title, world exit, and conditional rows

Title availability takes one refreshed storage snapshot. Empty, damaged, and
foreign manual slots do not advertise Load. A healthy automatic slot alone
does not advertise Autosave: upstream nests Autosave under the existence of a
normal save, and the port preserves that condition. Load opens the established
slot/code loader directly; Autosave loads the established read-only automatic
slot directly. Both completion paths return control through the same title
runtime rather than displaying the retired load toast.

START Exit intentionally has no save confirmation because upstream invokes
`quit_world` directly. It calls the same fresh-session constructor as New Game,
replaces the host state, clears every transient child overlay, and then opens
title. Integration tests retain the old object and seed it with changed map,
party, items, variables, and extension fields; none survives in the replacement
session.

Title Exit always enters a terminal state. Desktop hosts additionally receive
the exact service payload `{"t":"quit"}`. Web and other hosts that cannot close
their own window show localized “close this tab” copy and ignore gameplay input,
so the discarded campaign cannot be reopened accidentally.

The item-driven START rows use the imported authored positions. Tuxepedia is
absent without `app_tuxepedia`, appears while it is owned, and disappears again
when the item is removed. Nu Phone retains the same ownership behavior and
relative insertion semantics.

## Localization, input, and visual review

All menu labels, item names/descriptions/categories/messages, species, statuses,
and techniques come from the imported en_US and zh_CN catalogs. Newly reached
Chinese glyphs were added to the generated subset; the exhaustive CJK check
covers 2,643 required characters. The font subset grew from 696,580 to 716,068
bytes.

Keyboard and controller share the existing directional, confirm, back, and
START actions. Touch uses the same reducer actions through scaled hit regions:
root rows, party members, submenus, release confirmation, Bag rows and party
targets are directly tappable; horizontal and vertical swipes cover detail
pages and Bag pagination. Production browser tests navigate these public
regions rather than invoking menu reducers directly.

Sixteen new committed goldens cover START root, Party, Player, and Bag in both
languages at 480×272 and 960×544. Four title frames and two save-menu frames
were refreshed for the new rows and handoff. Pixel tests require 960×544 to be
the exact nearest-neighbour 2× composition, pin PNG/RGBA hashes, and combine
semantic strings with panel, portrait, HP, category, and cursor pixel probes.

The two Chinese four-screen contact sheets were opened at 300% scale. Labels,
descriptions, stats, quantities, HP, and the player summary are readable without
clipping; the 960×544 sheet preserves the intended fixed 2× layout.

## Save compatibility and campaign invariants

No RPG Kit schema, project schema, extension version, or save envelope field
changed. An unmodified current-main build wrote a real save at campaign frame
29,763 on `spyder_route2` (5,348 envelope bytes). This build loaded it and
replayed the remaining 86,079 inputs to the expected GB6 terminal SHA-256
`fa4a55f281b94f8c2eeb3f157d432c33746ef97cd7fa7463b4ca9edc4a7184a0`.

All maintained campaign terminals match the current baseline:

| Journey | Frames | Terminal state SHA-256 |
| --- | ---: | --- |
| GB6 | 115,842 | `fa4a55f281b94f8c2eeb3f157d432c33746ef97cd7fa7463b4ca9edc4a7184a0` |
| J1 | 128,718 | `6f21d87d7631b067e46dc306d8b3a22853c145714300679957570df0f3a7c25d` |
| J2 | 180,125 | `f0b63d5e627b4661eb8c2ecc936bc55a7fad5e3d046bb87dfe52c4c6ecacf1e4` |
| J3 | 193,227 | `1bd475f12f455ca6ad2a2bf645b9694c2e234343edb8c5200c2a51f6dea75055` |
| J4 | 206,822 | `4c7b0a0283368fa57360d73ca4f28643ab2ab6dec75d6e148d0be1e83102ed37` |

The built bundle reached all 233 J4 checkpoints. Both maintained battle-loss
recoveries passed, 343 imported locks reached their unlock state, the 263-map
freeze scan found no permanent lock, all 20 chapter suffixes completed, and
five save/resume points matched uninterrupted terminals.

The demo tapes contain no START press that enters the new menus. Their one
changed signature is the generated font digest after the larger Chinese subset;
it was refreshed with the project transcription tools. No campaign state or
input segment was re-recorded.

## Mutation strength

Four focused mutations ran in separate disposable worktrees. Each produced the
expected red result and the candidate checkout was never modified:

| Mutation | Detecting result |
| --- | --- |
| Reorder only the menu copy, not the live party | next-battle lead assertion failed |
| Apply a successful potion without decrementing inventory | three item-consumption assertions failed |
| Let a full-HP potion enter the use/consume path | full-HP refusal assertion failed |
| Return to title without replacing the old extension/session | stale-world identity and state assertion failed |

## QuickJS performance and package impact

Current main and the candidate were built separately and measured in
main → candidate → candidate → main order at both viewports. The focused tape
runs 1,151 frames, presses START at frame 1,140, and all eight runs finish on
`spyder_bedroom` with terminal SHA-256
`b2f80769856c3dc99bad9892cda194f28ea158394bf1914c783206961fa5399b`.

| Scenario | Viewport | Main median | Candidate median | Delta |
| --- | --- | ---: | ---: | ---: |
| Cold startup | 480×272 | 236.215 ms | 239.279 ms | +1.30% |
| Cold startup | 960×544 | 239.855 ms | 242.384 ms | +1.05% |
| START opening frame | 480×272 | 14.060 ms | 13.877 ms | -1.30% |
| START opening frame | 960×544 | 13.300 ms | 14.052 ms | +5.66% |
| Worst frame across tape | 480×272 | 21.023 ms | 21.040 ms | +0.08% |
| Worst frame across tape | 960×544 | 20.511 ms | 21.105 ms | +2.90% |

The 960×544 START percentage is a 0.752 ms shift on a short frame; combining
all four main and all four candidate START samples gives +1.77%. Every candidate
startup is below the 250 ms cold budget, every menu frame is below the 50 ms
production budget, and terminal state is identical. The result also confirms
that the lazy item-rule split avoids charging startup for Bag-only behavior.

| Build artifact | Main | Candidate | Delta |
| --- | ---: | ---: | ---: |
| Source bundle before runtime packaging | 3,090,450 B | 3,266,249 B | +175,799 B |
| Packaged runtime JS | 2,089,591 B | 2,194,241 B | +104,650 B |

The final lazy split removed 134,044 source bytes and 37,634 runtime bytes from
the first integrated version while retaining the rules as a keyed on-demand PAK
entry.

## Reproducibility and gates

Two consecutive imports produced identical tracked output. The second run
reported 263 maps, 430 TILESET entries, 407 battle monsters, 259 techniques,
739 textures, and the same complete diff SHA-256 before and after generation.

Every command represented by the current CI workflow was run locally:

| Gate | Result |
| --- | --- |
| Standard build, PocketJS wasm, and `bunx tsc --noEmit` | PASS; wasm 360,011 B |
| Import twice and generation stability | PASS |
| Localization and exhaustive CJK subset | PASS; 11/11 localization checks and 2,643 Chinese characters |
| Importer test group | PASS — 53/53 |
| Replay test group | PASS — 12/12 |
| Locks/battle-data/terrain test group | PASS — 22/22 |
| Rest a-l test group | PASS — 632 pass, 2 browser-conditional |
| Rest m-z test group | PASS — 624 pass, 2 browser-conditional |
| Full default suite | PASS — 1,343 pass, 4 browser-conditional, 0 fail |
| Browser-conditioned visual suite | PASS — 7 pass, 90 assertions |
| Unexecuted skips | 0; all four default conditional cases ran in the browser-conditioned suite |
| GB6/J1/J2/J3/J4 and golden sync | PASS |
| Battle failures, locks, map freeze, chapters, preview, save/resume, and built-bundle replay | PASS |
| English/Chinese demos and Chinese mainline | PASS |
| Web build, journey, Chinese opening, demo controls, and five audio lifecycle checks | PASS; 0 console errors |
| PSP snapshot bootstrap and CI `build:psp --skip-assets` | PASS |
| Current-main save load and continuation | PASS |
| Four isolated mutations | PASS — each intended suite turned red |
| Interleaved QuickJS startup and START benchmark | PASS |

The branch was rebased onto current `origin/main` before final validation and
contains no merge commit. `bun.lock` is unchanged. Generated code, data,
goldens, status documentation, coverage reports, and this report are the only
deliverables.

subagent 使用：4个 / 分别核对 Bag 上游语义、当前菜单架构、标题 Load/Autosave 集成、标题 Exit 宿主行为；其中 1 个中断，其余结果由主代理复核并集成 / 并行核对明显省时

PASS
