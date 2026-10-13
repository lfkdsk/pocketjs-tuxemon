# G19-SYSTEMS: component upgrade and upstream system audit

## Result

Pocket RPG Kit is upgraded from `afbde1c529f3f96ac4551f5f2a19da101f2d3a6c`
to `310934f9b9b3efbb09d108f1de29432335609b31`. The new pin contains the
fail-closed RPG Maker screen-capability checks and the cumulative QuickJS
hot-path recovery. PocketJS remains at
`862040bd77edc49b1f815beff63952b6616a14c6`, and the canonical map schema
identity remains
`a59ec3e0a1ee74fe08fb75dff938e56b01b8b6b66ccfd102cb9dbb2866d23444`.
Existing saves therefore remain on the same compatibility chain.

The complete census contains exactly 32 shared YAML files at the pinned
upstream `mods/` root: 13 are Done, five are Partial, and 14 are Missing. A
Missing row is either sample/test data, has no campaign grant or action, or is
internally inconsistent upstream. No Missing row is a player-visible reachable
Spyder flow. The two concrete reachable gaps found while following the root
systems into their actions and states are now complete:

- Spyder Bite plague phases now participate in real battle pre-checks,
  resistance, deterministic spread, narration and post-battle persistence.
- the global Check Max Moves page now resolves an over-cap party member through
  one atomic, bilingual choice instead of exposing a list that could not safely
  remove the selected move.

Both use imported campaign data. They are covered at 480x272 and 960x544 in
English and Chinese, retain the established keyboard/controller/touch choice
surface, and have mutation-sensitive tests. No fabricated launcher was added
for an upstream system that the campaign cannot open.

## Component upgrade and compatibility

The component range consists of the K-FIX-2 screen lifecycle and K-PERF-3
performance series. It validates optional screen commands before inline,
common, staged or lazy content can silently enter an unsupported rendering
host; it also keeps optional step counting and `worldIdle` derivation out of
projects that do not use them. The game needed no compatibility shim and no
PocketJS change.

The submodule update is deliberately schema-neutral. Both pins export the same
`MAP_SCHEMA_HASH`, the PocketJS gitlink is unchanged, and the normal save/resume
gate decoded five production saves and completed their remaining tapes at the
same uninterrupted terminal state for each recording.

### Component QuickJS ABBA

The component consumer benchmark ran on CPU 7 in three complete
baseline-candidate-candidate-baseline windows, 2,000 iterations per slot and
nine internal samples. The summary is the median of the six paired directional
deltas, matching the component driver's multi-window rule. Negative is faster;
the allowed unused-feature regression is +3%.

| Consumer case | New pin vs old pin |
| --- | ---: |
| `sunstoneIdle` | -5.017654% |
| `sunstoneWalk` | -7.305112% |
| `sunstoneControlWalk` | -3.877096% |
| `streamedRoam` | -4.657149% |
| `battleScene` | -3.134998% |
| `sunstoneIdleImmutable` | -6.692800% |
| `sunstoneControlWalkImmutable` | -7.862737% |
| `battleSceneImmutable` | -2.231379% |

All eight cases improved and the guard reported zero regressions.

### Production-game cold ABBA

The real production bundle used a one-frame bedroom fixture in 40 fresh
QuickJS processes: five processes per viewport per slot, again in
baseline-candidate-candidate-baseline order. All processes reached canonical
state SHA-256
`7f5a73f780c13c25e168769241853b9e4b02fd62011704342fc7297b79ad7db8`
and remained below the genuine 50 ms first-frame CPU budget. Values below are
the averages of the two slot medians on each side.

| Viewport | Metric | Old pin | New pin | Delta |
| --- | --- | ---: | ---: | ---: |
| 480x272 | host boot | 247.500 ms | 242.621 ms | -1.971% |
| 480x272 | startup to first frame | 250.478 ms | 245.589 ms | -1.952% |
| 480x272 | first-frame CPU | 2.734 ms | 2.660 ms | -2.688% |
| 960x544 | host boot | 253.971 ms | 244.611 ms | -3.685% |
| 960x544 | startup to first frame | 257.010 ms | 247.549 ms | -3.681% |
| 960x544 | first-frame CPU | 2.752 ms | 2.649 ms | -3.725% |

An initial strict baseline sample had already exceeded the ordinary 250 ms
startup assertion. The comparative run therefore used `G6_STARTUP_MS=1000`
only as an admission ceiling for both sides; it did not relax the 50 ms frame
gate or state-hash check. The result is a relative upgrade comparison, not a
relabelling of noisy absolute startup samples.

## Complete upstream root-system census

"Reachable" below means shipped Spyder content can exercise the system, not
merely that upstream constructs a loader. Every port status links to the
corresponding row in the maintained [feature status](../docs/status.md#upstream-root-system-audit).

| Root config | Upstream entry | Spyder reachability | Port status |
| --- | --- | --- | --- |
| `ai_items.yaml` | `tuxemon/ai/ai.py:115`; item choice in `tuxemon/ai/decision_strategy.py:110` | AI is battle-reachable, but no trainer owns the configured Potion; the only three-argument trainer grant is a Wood Berry. | [Missing](../docs/status.md#audit-ai-items): the dormant row is not imported. |
| `ai_opponent.yaml` | `tuxemon/ai/ai.py:115`; `tuxemon/ai/opponent_evaluator.py:41` | Its real `default` row matters only when an AI has multiple opposing active targets; no maintained journey depends on that distinction. | [Partial](../docs/status.md#audit-ai-opponent): seeded AI selects legal moves and targets, without this weighting policy. |
| `ai_techniques.yaml` | `tuxemon/ai/ai.py:115`; lookup in `tuxemon/ai/decision_strategy.py:59` | Its only key is literal sample `slug`, matching no imported monster or technique owner. | [Missing](../docs/status.md#audit-ai-techniques): sample-only override. |
| `ai_trainers.yaml` | `tuxemon/ai/ai.py:115`; trainer rules in `tuxemon/ai/decision_strategy.py:245` | Literal `character_slug`/`monster_slug` keys match no trainer, and the nested sample HP range is malformed for its consumer. | [Missing](../docs/status.md#audit-ai-trainers): sample-only and unusable. |
| `capture_devices.yaml` | `tuxemon/database/rules.py:191`; `tuxemon/formula.py:446` | Direct: Cotton Scoop grants five Tuxeballs at `mods/tuxemon/maps/spyder_cotton_scoop.tmx:53`; shops sell base and specialized devices. | [Done](../docs/status.md#audit-capture-devices): imported modifiers drive production capture. |
| `celestial_cycles.yaml` | `tuxemon/celestial_handler.py:30`; session construction in `tuxemon/session.py:41` | Constructed globally, but the corpus has no `celestial_is` guard or state/menu exposing a body phase. | [Partial](../docs/status.md#audit-celestial-cycles): saved clock/daylight are live; unobservable body profiles are not imported. |
| `combat_layouts.yaml` | `tuxemon/states/combat_animations.py:86`; `tuxemon/ui/combat_layout.py:20` | Every visible battle needs a layout. | [Partial](../docs/status.md#audit-combat-layouts): all campaign party sizes render, using a responsive code-owned layout. |
| `combos.yaml` | `tuxemon/event/actions/add_combo.py:45` | Only `example` exists; maps have zero `add_combo`, `remove_combo` or `button_combo` calls. | [Missing](../docs/status.md#audit-combos): example-only and unreachable. |
| `config_capture.yaml` | `tuxemon/database/rules.py:191`; shake formula in `tuxemon/formula.py:336` | Every capture attempt uses it. | [Done](../docs/status.md#audit-config-capture): maximum rate and four-shake constants are imported. |
| `config_combat.yaml` | `tuxemon/database/rules.py:175`; `tuxemon/combat/sort_manager.py:24` | Every battle uses action order, speed, dodge and affinity bounds. | [Done](../docs/status.md#audit-config-combat): reachable rules are imported and oracle-covered. |
| `config_monster.yaml` | `tuxemon/database/rules.py:183` | All spawned monsters, levels, stats, bond and rewards use it. | [Done](../docs/status.md#audit-config-monster): level/move, TP/IV/body, catch, bond and experience rules are imported. |
| `db_config.yaml` | `tuxemon/database/bootstrap.py:23` | Foundational loader for the mod and its model tables. | [Done](../docs/status.md#audit-db-config): deterministic build output replaces run-time discovery. |
| `email.yaml` | `tuxemon/states/email_provider.py:63`; PC provider in `tuxemon/computer.py:72` | Unreachable: ten `access_pc` calls request default `standard`, while the sample email requires `email:example`; Nimrod's “PC Email” objects are dialogue. | [Missing](../docs/status.md#audit-email): no reachable mailbox or Email state. |
| `fishing.yaml` | `tuxemon/core/effects/fishing.py:62` | Direct: Wanda grants `fishing_rod` after the Route 3 battle at `mods/tuxemon/maps/spyder_route3.tmx:425`; the maintained journey owns it. | [Done](../docs/status.md#audit-fishing): rod profile, terrain/time filters, stages and failure flow are imported. |
| `healing_shop_config.yaml` | `tuxemon/states/shop_healing.py:67`; dispatch in `tuxemon/event/actions/open_shop.py:128` | A `cathedral` model exists, but maps have zero `open_shop ...,heal_monster` calls; story healing uses separate events. | [Missing](../docs/status.md#audit-healing-shop): unreachable specialist shop. |
| `map_types.yaml` | `tuxemon/map/manager.py:29`; `tuxemon/event/conditions/location_type.py:36` | Assigned throughout Spyder and used by location-sensitive systems. | [Done](../docs/status.md#audit-map-types): imported metadata drives presentation and conditions. |
| `movesets.yaml` | `tuxemon/event/actions/replace_techs_from_yaml.py:27` | Only `test_set` exists and maps have zero action calls. | [Missing](../docs/status.md#audit-movesets): test-only; species movesets use their real database. |
| `npc_names.yaml` | `tuxemon/menu/input.py:13`; `tuxemon/states/input.py:255` | Direct: Paper Scoop invokes `rename_player`; Candy Cafe has optional player/monster rename events. | [Done](../docs/status.md#audit-npc-names): gendered random pools feed bilingual saved name input. |
| `nu_phone_map.yaml` | `tuxemon/states/phone_map.py:45` | Direct: Mom grants `nu_phone`, `app_map` and initial trackers at `mods/tuxemon/maps/spyder_downstairs.tmx:134`. | [Done](../docs/status.md#audit-nu-phone-map): map art, pins, groups, visibility and navigation are imported. |
| `parties.yaml` | `tuxemon/event/actions/replace_party_from_yaml.py:27` | Only `test_set` exists and maps have zero action calls. | [Missing](../docs/status.md#audit-parties): test-only; trainer parties come from their authored events. |
| `phone_calls.yaml` | `tuxemon/states/phone_contacts.py:30` | Unreachable: sample plus Mom's no-answer row, no `app_contacts` grant, and zero contact mutations. | [Missing](../docs/status.md#audit-phone-calls): no reachable Contacts launcher or call. |
| `plagues.yaml` | `tuxemon/monster/plague.py:76`; combat pre-check in `tuxemon/combat/session.py:587` | Direct: 13 `char_plague` actions and three `party_infected` guards cover Wayfarer, Candy Town and the hospital. | [Done](../docs/status.md#audit-plagues): story phases plus battle eligibility, resistance, spread/cure, narration and persistence. |
| `price_policies.yaml` | `tuxemon/economy/price_policy.py:35`; `tuxemon/event/actions/set_price_policy.py:18` | Two policies exist, but maps have zero `set_price_policy` calls. | [Missing](../docs/status.md#audit-price-policies): unreachable; ordinary shops remain implemented. |
| `radio_data.yaml` | `tuxemon/states/phone_radio.py:50`; `tuxemon/event/actions/tune_radio.py:18` | Optional map-reachable: Leather House 1 and Paper Rival Bedroom contain the only two physical-radio calls; maintained journeys do not visit them. | [Done](../docs/status.md#audit-radio-data): broadcasts, conditions, frequencies and result variables are imported. |
| `radio_map_lists.yaml` | `tuxemon/states/phone_radio.py:38` | Reached by the same two physical radios; the phone app is not required. | [Done](../docs/status.md#audit-radio-map-lists): per-map lists and `all_maps` fallback drive the tuner. |
| `range_map.yaml` | `tuxemon/database/rules.py:199`; damage lookup in `tuxemon/formula.py:87` | Every damaging technique chooses attacking/defending stats through a range category. | [Done](../docs/status.md#audit-range-map): all rows and weights are imported. |
| `recipes.yaml` | `tuxemon/states/craft_menu.py:58`; `tuxemon/event/actions/crafting_station.py:17` | Real cooking recipes exist, but maps have zero `crafting_station` calls and cannot open the menu. | [Missing](../docs/status.md#audit-recipes): unreachable; no invented station. |
| `relationships.yaml` | `tuxemon/relationship.py:47`; `tuxemon/states/phone_contacts.py:108` | Constants load globally, but Contacts is never granted and maps have zero relationship/contact mutations. | [Missing](../docs/status.md#audit-relationships): no observable campaign system. |
| `routing_policies.yaml` | `tuxemon/entity/routing.py:19`; default in `tuxemon/entity/party.py:29` | The default party-to-Kennel policy is active; maps have zero `set_routing_policy` calls for other rows. | [Partial](../docs/status.md#audit-routing-policies): campaign default works; named YAML policies are not imported. |
| `training_shop_config.yaml` | `tuxemon/states/shop_training.py:67`; `tuxemon/event/actions/open_shop.py:120` | Maps have zero `open_shop ...,train_monster` calls; default state model and the file's only model also disagree. | [Missing](../docs/status.md#audit-training-shop): unreachable and inconsistent upstream. |
| `trap.yaml` | `tuxemon/core/effects/trap.py:67` | Only `example_trap` exists; no item declares its effect and no map/economy grants one. | [Missing](../docs/status.md#audit-trap): example-only and unreachable. |
| `weather_previsions.yaml` | `tuxemon/event/actions/load_weather.py:36`; schema in `tuxemon/world/weather.py:30` | Maps have zero `load_weather` calls; the action asks for `.yml`, while the shipped `.yaml` lacks required `transitions`. | [Partial](../docs/status.md#audit-weather-previsions): live weather uses its documented deterministic fallback. |

The classification totals above count only these 32 rows, not the five phone
state rows below.

### NuPhone states without separate root YAML

Applications are discovered from owned item definitions, so these states need
their own reachability audit.

| Upstream state | Campaign reachability | Port status |
| --- | --- | --- |
| Launcher and Map: `tuxemon/states/phone.py:26`, `phone_map.py:45` | Mom grants the phone and Map app in `spyder_downstairs.tmx:134`; both remain in the maintained terminal inventory. | [Done](../docs/status.md#audit-nu-phone-map). |
| Contacts: `tuxemon/states/phone_contacts.py:30` | `app_contacts` exists, but no map grants it or creates a contact. | [Missing](../docs/status.md#audit-phone-calls); no launcher was fabricated. |
| Banking: `tuxemon/states/phone_banking.py:118` | Bills are story-reachable, but no map grants `app_banking`; upstream deposit, withdrawal and bill payment cannot open. | Missing app; campaign bill state itself is [Done](../docs/status.md#monsters-and-party). |
| Monster rename: `tuxemon/states/phone_renaming.py:25` | No map grants `app_renaming`; separate scripted rename actions are reachable. | Missing app; scripted renaming is [Done](../docs/status.md#monsters-and-party). |
| Radio and physical tuner: `tuxemon/states/phone_radio.py:33`, `tuxemon/event/actions/tune_radio.py:18` | No map grants `app_radio`, but two map objects invoke the same tuner directly. | Reachable physical flow is [Done](../docs/status.md#audit-radio-data); no unreachable launcher was added. |

## Reachable gaps completed

### Spyder Bite plague behavior

The importer now normalizes the real `plagues.yaml` profile, requires its
same-named technique, and carries the eligibility ranges, type/shape weights,
spread probability, resistance modifiers, cure and localized messages into the
battle database. Story commands retain per-monster phases keyed by stable iid
for player and NPC parties. Battle construction projects those phases into the
combat snapshot.

Before an infected monster's ordinary action, the battle reducer applies the
upstream pre-check. An ineligible, inoculated or recovered target is immune;
otherwise seeded type, shape and status resistance determines whether the
target becomes infected. Only a successful pre-check substitutes the
same-named Spyder Bite technique. Its sneeze and new-infection messages are two
separate presentation events, in English and Chinese. Battle settlement writes
phases back for player monsters, NPC monsters and newly captured monsters after
their permanent iid has been assigned.

The campaign evidence is direct: nine Wayfarer NPC grants plus the player
grant, two further Wayfarer grants, the hospital inoculation, and the shared
Spyder action total 13 native `char_plague` uses. Three `party_infected`
conditions drive the all/none/some Candy Town branches. The coverage report now
records all 13 actions and all three conditions as native.

Eight committed plague PNGs cover sneeze and infection narration in both
languages and both logical resolutions. The render tests compare exact RGBA and
PNG hashes, assert the complete localized sentence, require a real full-width
production message band, and inspect visible glyph pixels. The images were
opened at 3x; names, punctuation, panel geometry and the two narration phases
are readable without clipping.

### Atomic pending-move replacement

The real `spyder_greenwash_greenhouse/e037_check_max_moves` imported event is
the test entry. It lists the exact live moves of the first party monster above
the imported move cap. Choosing an older move removes that indexed move and
keeps the newest; choosing the newest declines learning it. The choice and
mutation are one extension operation, so a different party member cannot be
changed between upstream's `get_pending_moves` and `remove_tech` actions.

The result writes both the upstream choice variable and localized report text.
English replacement produces “Frighten replaced with Lineage.”; the Chinese
decline path produces “决定不学习 血统。”. The established non-cancellable choice
surface provides keyboard/controller navigation and scaled touch rows at both
viewports. Four new pending-choice goldens cover both languages and resolutions;
semantic tests pin every key, visible row, selected newest row and panel pixels.

The source contains two action pairs: the Spyder shared page is native, while
the other is guarded by a permanently false combat-menu state and is recorded
as dropped. Thus every reachable occurrence is native without claiming the
unreachable row as executed.

## Coverage and generated output

Two complete imports produced no tracked diff on the second run. The English
and Chinese coverage reports agree: 13,377 of 13,617 actions and 8,452 of 8,663
conditions are native. The remaining rows retain their explicit degraded,
placeholder or dropped classification; none of the two newly completed
reachable paths remains a placeholder.

The normal import/build path generated both language databases, runtime slices,
visual manifests, font subset and package entries. `bun.lock` remained
byte-identical with SHA-256
`8ccfa9937302846daca5f829c3ef706f1cfa7d3e521c2fad9076842f6ab306e2`.

## Mutation strength

Both mutations ran in a disposable detached worktree with independent
submodules. Dependencies were read-only hardlinks; the delivery checkout was
never edited. The isolated checkout was removed after each result.

| Mutation | Discriminating red result |
| --- | --- |
| Return the original move after a successful plague pre-check instead of substituting Spyder Bite | `tests/plague-battle.test.ts`: 5 pass, 1 fail; expected `spyderbite`, received `ram`. |
| Replace indexed pending-move removal with `pop()` | `tests/pending-moves-real-map.test.ts`: 1 pass, 1 fail; the English path retained Frighten and removed Lineage instead of producing `bullet,buzz,blade,lineage`. |

Each implemented system therefore has a focused mutant that the shipped test
would reject.

## Mainline refresh and save compatibility

The new battle semantics intentionally alter combat decisions and RNG
consumption, so all maintained tapes were re-recorded with project tools rather
than hand-edited. Derived goldens, chapters, English/Chinese demos and the 28
PSP segment boundaries were then regenerated from those tapes.

| Segment | Segment frames | Combined frames | New battle rows |
| --- | ---: | ---: | ---: |
| GB6, bedroom through Route 3 | 116,107 | 116,107 | 111: 22 trainer, 89 wild |
| J1, Captain's return | 12,854 | 128,961 | 16: 10 trainer, 6 wild |
| J2, hospital cure | 64,794 | 193,755 | 58: 50 player trainer, 7 player wild, 1 spectator |
| J3, Omnichannel broadcast | 17,990 | 211,745 | 15: 13 trainer, 2 wild |
| J4, Kernel quest | 18,577 | 230,322 | 17: 12 trainer, 5 wild |

The old and new complete replays both finish at `spyder_datacenter @7,4`. The
old terminal was frame 206,935 with SHA-256
`faf682412dce51dc620b25f28c7c73049bd96f4bb3ee44a6dbc7394c0bdba665`;
the new terminal is frame 230,322 with SHA-256
`1977c1b0f3bd1bba2c4e5ad82332599c4fc72f0acd84d9437868976fbfb5c736`.
The complete state comparison found these intentional field groups:

| Field | Old | New | Reason |
| --- | --- | --- | --- |
| map / tile | `spyder_datacenter @7,4` | unchanged | story endpoint is preserved |
| gold | 67,773 | 63,095 | added real encounters and healing/economy consequences |
| Potion count | 1 | 0 | replay uses the real item during the longer combat path |
| RNG cursor | 3,555,185,819 | 3,931,256,701 | plague checks and added encounters consume the seeded stream |
| global steps | 8,071 | 8,326 | re-recorded route includes the real additional encounter movement |
| pending-move variables | absent | `chosen_tech=hibernate`; `pending_move.message="Hibernate replaced with Chameleon."` | reachable Check Max Moves now resolves |
| plague/story variables | no final `party_sick` result | `party_sick=1` | infected-party branch now executes natively |
| `party_lost_hp` | `-24` | `-1441` | longer real battle/healing history |
| clock | `refTick=104898`, `subMinuteTicks=498` | `refTick=107441`, `subMinuteTicks=3041` | elapsed active reference ticks changed; epoch day/minute are unchanged |
| caught species | 10 | 11, adding `puparmor` | added real capture/evolution path |
| saved plague table | 9 entries | 28 entries | player/NPC/captured phases now persist; phases remain valid infected/inoculated values |
| player party/combat snapshot | earlier encounter-derived roster and order | Aardart, Puparmor, Axolightl, Cardiling, Pawsand, Arthrobolt; first four fainted, last two surviving | real additional encounters change roster order, HP and combat history |

No unlisted schema or envelope field was introduced by the component bump.
`verify:save` created, decoded, restored and completed five real saves at battle,
map-transfer and daylight boundaries. Chapter envelopes also decoded and
suffix-replayed to the new terminal.

## Visual and interaction review

The plague suite contributes eight images and the pending-move suite four.
Every screen is generated from the production bundle and real imported data at
480x272 and 960x544, in en_US and zh_CN. Exact pixels are supplemented with
semantic assertions, so a blank/stale frame or tree-only string cannot satisfy
the test. The larger battle view scales to its viewport; the world choice keeps
its authored 480x272 playfield centred inside the larger surface.

The plague interaction itself is automatic battle behavior and uses the normal
battle acknowledgement surface. Pending moves use the shared choice modal:
direction/confirm from keyboard and controller and scaled tap regions all feed
the same reducer action. The full browser gates exercised the actual built UI,
not a fixture-only renderer. Both sets of screenshots were inspected at 3x;
the bilingual lines, selected move, full-width narration, sprites and map
backgrounds are visually intact.

## Final gates

All final commands used the pinned Tuxemon source and the upgraded component.

| Gate | Final result |
| --- | --- |
| import and determinism | two imports byte-identical; committed output clean after the second |
| wasm, production build and TypeScript | `build:wasm`, `build`, `bunx tsc --noEmit` all exit 0 |
| localization | `check:l10n` and exhaustive CJK subset checks pass |
| five CI test partitions | 55 + 12 + 22 + 719 + 673 = 1,481 pass, 0 fail |
| environment-conditioned tests | all nine browser-conditioned bodies rerun under their enabling environment and pass; zero bodies remain unexecuted |
| maintained journeys | all five mainlines, golden sync, both defeat/recovery tapes, 331 lock pages/336 checks, all-map freeze scan, 20 chapter suffixes, both language tapes/demos, five save resumes, preview coverage and built-world replay pass |
| Web | production site builds; Chrome English journey, Chinese opening, bilingual demo, Arena and real-audio gates all pass |
| PSP | segment snapshots regenerated; full package and CI-exact `build:psp --skip-assets` pass |
| component QuickJS | all eight cases improve by 2.23-7.86%; zero +3% regressions |
| production cold QuickJS | 40 valid processes, exact terminal hash, 50 ms frame gate intact; all six reported metrics improve by 1.95-3.73% |

The full PSP artifacts are `EBOOT.PBP` 5,869,760 bytes,
`pocket-tuxemon.prx` 5,869,428 bytes and `assets.pak` 67,705,552 bytes. The
current task rebuilt both package modes and regenerated all segment snapshots.
The retained 28-segment PPSSPPHeadless receipts predate this tape refresh, so a
fresh full emulator campaign remains a release operation and is not represented
as current evidence. Physical PSP completion likewise remains outside this
result.

## Repository hygiene

The delivery branch is based on current `origin/main`; a final fetch found no
new main commit requiring rebase. It contains no merge commit. Functional
commits use the configured public author, English subjects and no co-author
footer. `bun.lock` is unchanged, `git diff --check` is clean, and the public
diff contains no local filesystem path or private service address.

subagent 使用：6 个 / 分别普查根配置、核对 states/actions、追踪战役可达性、审阅移植状态缺口、评估组件升级风险、核对门禁与测试；主代理复核并整合所有结论 / 并行只读普查明显节省了时间

PASS
