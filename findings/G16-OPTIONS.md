# Options settings and PC menu parity

## Result

The title screen and in-world START menu now share one bilingual Options
implementation.  It owns installation preferences outside campaign state,
remaps the seven upstream controls, applies mute and volume at the final audio
output boundary, formats party measurements in the selected units, and makes
the selected hemisphere affect season conditions immediately.  The PC menu
also carries upstream's permanent Multiplayer placeholder, so all ten
`access_pc` actions are Native.

The feature remains game-owned, but the review fix also makes one narrow RPG
Kit change: `AudioDriver.sync` now accepts the original reducer timeline
object separately from the settings-projected presentation state.  That lets
gain-only changes reconcile in place without weakening the existing
same-frame load/refold detection.  PocketJS is unchanged, and `bun.lock` is
unchanged in the game, kit, and nested PocketJS checkouts.

## Upstream comparison

| Upstream behavior | Source evidence | Port behavior |
| --- | --- | --- |
| Up, left, right, down, primary, secondary and back are independently configurable | `tuxemon/states/control_state.py:60-94`; input capture and live keyboard reload at `tuxemon/states/set_key_state.py:44-65` | The same seven semantic slots accept normalized keyboard or controller buttons.  A duplicate first raises an explicit conflict; confirmation swaps the two slots so the mapping remains a total bijection.  Restore Default resets only controls. |
| Restore Default, language and screen size appear in title Options | `tuxemon/states/control_state.py:96-135` | Title Options exposes those rows.  Web and desktop keep PocketJS's logical 480x272 canvas and show its host-owned size read-only; their browser/window chooses physical scale.  PSP is fixed at 480x272 and omits the row. |
| Mute, music volume, effect volume, units and hemisphere appear only in the in-game menu | `tuxemon/states/control_state.py:138-258` | START Options adds precisely that subset.  Both volume sliders use the upstream 0..100 range and ten-point steps. |
| Defaults are metric, northern, music 0.5 and effects 0.2 | `tuxemon/config.py:70-84` | Defaults are metric, northern, music 50%, effects 20%, unmuted and identity controls (`ui/settings.ts:64-76`). |
| Preferences live in `tuxemon.yaml`, separately from the save directory | `tuxemon/config.py:341-420`; `tuxemon/constants/paths.py:58-76` | Preferences use `pocket-tuxemon/settings` in Web Storage, `settings.json` in desktop data storage and `save/settings.json` on the PSP memory stick (`ui/settings.ts:12-16`, `ui/settings.ts:207-272`).  They never enter reducer, extension or save envelopes. |
| Units affect monster height/weight and player walking-distance presentation | `tuxemon/states/journal_info.py:63-80`; `tuxemon/states/character.py:99-168` | Party detail and Tuxepedia both use the live metric/imperial setting with Python-compatible half-even rounding (`ui/settings.ts:79-117`, `ui/tuxepedia.tsx:283`).  The player page converts the saved global step counter to km/mi (`ui/start-menu.tsx:637`). |
| Southern hemisphere reverses the seasonal quarter | `tuxemon/time_handler.py:139-165` | The extension reads the live preference accessor on each season update/condition (`battle/extension.ts:3138-3147`, `battle/extension.ts:3305`, `battle/extension.ts:3401`). |
| PC providers are followed by permanent Multiplayer/not-implemented, then Log Off | `tuxemon/computer.py:163-180` | `pcMenuItems` inserts Multiplayer immediately before Log Off, and confirm shows the localized existing not-implemented message without mutating storage (`battle/storage-scenes.ts:208`, `battle/storage-scenes.ts:283`, `battle/storage-scenes.ts:434-435`). |

Touch-only presentation deliberately omits physical remapping: an on-screen
contact has no stable physical keyboard/controller key to bind, and the
existing touch controls remain directly usable.  Every other START setting is
touch-operable.  Keyboard and controllers use the same PocketJS-normalized
physical slots, so one binding applies to either host input source.

## Design and integration

`ui/settings.ts` is the non-reactive preference boundary.  It provides a
strict versioned document decoder, complete-default fallback for missing,
malformed or throwing stores, best-effort writes, conflict-safe control
binding, normalized-mask remapping and a memoized audio-state adapter.  The
host frame wrapper is installed after `mount`, preserving the raw physical
edge for binding capture while every game consumer receives the semantic mask
(`main.tsx:132-140`, `main.tsx:642`).

`ui/options-runtime.ts` owns one controller shared by both entry points.
Capability filtering omits remapping on touch-only presentation and screen
size on PSP; origin filtering keeps audio/units/hemisphere in START only
(`ui/options-runtime.ts:117-195`).  Changes are live and persisted immediately;
capture, conflict confirmation, controller/keyboard navigation and touch
activation all use the same row operations (`ui/options-runtime.ts:215-343`).

`ui/options-menu.tsx` draws a fixed 480x272 logical canvas and scales it to the
host viewport.  Hit rectangles are transformed through the same canvas, so
480x272 and 960x544 taps address the pixels that were drawn
(`ui/options-menu.tsx:148-194`).  All labels are imported from the pinned
en_US and zh_CN PO catalogs rather than being test-only copy.

The audio adapter is applied immediately before `AudioDriver`, after reducer
state is read (`ui/weather-effects.tsx`).  Music mute/volume and effect volume
therefore alter real Web, desktop and PSP PCM output without changing
simulation state, rewind state or saves.  Unchanged input identity and
settings revision return the same adapted object, avoiding per-frame work when
Options is closed.  When an audio setting does change, the adapter may return
a new presentation object but supplies the original reducer object as the
timeline identity.  The driver recognizes this as a same-timeline gain
projection, updates the existing voice, and neither destroys nor recreates its
stream (`ui/settings.ts:523-547`,
`vendor/pocket-rpgkit/src/ui/audio/driver.ts:161-190`).

The title and START callbacks open the same overlay (`main.tsx:441-467`,
`main.tsx:507`), while Language temporarily layers above Options and returns
to it.  START's party panel reads the live units accessor.  The weather/time
extension likewise reads the live hemisphere accessor, so neither preference
needs a session rebuild.

The importer now sources Options and PC labels from the real bilingual PO
catalogs.  `access_pc` is classified Native with a note covering campaign
storage, item locker and the upstream placeholder (`importer/project.ts:4167-4170`).
The generated coverage table reports Native 10, Degraded 0, Placeholder 0,
Dropped 0, Total 10 (`reports/G1-coverage.md:521`).

## Visual verification

Eight production-bundle goldens cover title and START Options in en_US and
zh_CN at 480x272 and 960x544:

- `tests/goldens/feature-options-title-en_US-480x272.png`
- `tests/goldens/feature-options-title-en_US-960x544.png`
- `tests/goldens/feature-options-title-zh_CN-480x272.png`
- `tests/goldens/feature-options-title-zh_CN-960x544.png`
- `tests/goldens/feature-options-start-en_US-480x272.png`
- `tests/goldens/feature-options-start-en_US-960x544.png`
- `tests/goldens/feature-options-start-zh_CN-480x272.png`
- `tests/goldens/feature-options-start-zh_CN-960x544.png`

All eight were opened at 3x and inspected.  Both languages remain within the
two-column panel, the Chinese labels are complete, and no text is replaced by
an ellipsis.  The tests also assert semantic nodes and pixels for title versus
START row membership, PO-derived text, the 50%/20% defaults, metric/northern
defaults, 480x272 size copy, overlay coverage and scale-matched touch regions
(`tests/feature-modes-visual.test.ts:191-218`,
`tests/feature-modes-visual.test.ts:313-316`).

Four additional production-bundle goldens cover the imperial Tuxepedia detail
in both languages and both viewports:

- `tests/goldens/tuxepedia-imperial-en_US-480x272.png`
- `tests/goldens/tuxepedia-imperial-en_US-960x544.png`
- `tests/goldens/tuxepedia-imperial-zh_CN-480x272.png`
- `tests/goldens/tuxepedia-imperial-zh_CN-960x544.png`

They were opened at 3x.  The selected species reads `1 ft / 9 lb` in both
languages, the Chinese type remains localized, and the 960x544 composition is
the intended nearest-neighbour 2x image.  The visual gate asserts the live
unit-dependent semantic text in both languages at both sizes
(`tests/tuxepedia-visual.test.ts:121-188`).

The PC Chinese goldens were regenerated and inspected as well; Multiplayer is
between the dynamic rows and Log Off at both resolutions.

## Focused behavior and mutation checks

Focused tests exercise real imported project data and generated PO copy:

| Area | Positive gate |
| --- | --- |
| Versioned defaults, all three stores, malformed/unreadable fallback, binding conflict/swap, mounted remapping, upstream measurement rounding, and real `AudioDriver` stream continuity | `tests/settings.test.ts` |
| Title/START row split, touch/PSP capabilities, clamped and normalized touch volume cycling, live sliders, unit/hemisphere changes, conflict confirmation and navigation | `tests/options-runtime.test.ts` |
| Byte-identical production save before/after preference changes and absence of preference fields | `tests/options-save-separation.test.ts` |
| Upstream PC order and localized no-op semantics | `tests/gpc-locker.test.ts` |
| Real en_US/zh_CN PO extraction | `tests/feature-modes-import.test.ts` |
| Immediate southern-season result through the production extension | `tests/time-weather-import.test.ts` |
| Metric/imperial Tuxepedia text and committed pixels at 480x272/960x544 in both languages | `tests/tuxepedia-visual.test.ts` |

Six isolated worktree mutations were each required to turn the matching gate
red, then discarded:

| Mutation | Detecting assertion |
| --- | --- |
| Return the physical mask without applying remapping | CROSS/CIRCLE swap and mounted-frame semantic-mask assertions fail |
| Bypass the audio settings adapter | emitted BGM/SFX volume and mute assertions fail |
| Add preferences to the campaign snapshot | byte identity and recursive forbidden-key scan fail |
| Let malformed JSON escape the loader | corrupt desktop/PSP/Web store fallback assertions fail by throwing |
| Restore the old same-frame refold heuristic for a settings projection | the real-driver test observes stream destruction/recreation and a reset PCM cursor |
| Hard-code Tuxepedia facts to `cm` / `kg` | the imperial bilingual visual assertions and golden comparison fail |

No mutation was made in the delivery worktree.

## Review fixes and inherited START closure

The review's two blocking findings are closed at their actual production
boundaries:

- A frozen Options overlay still calls audio sync while the reducer timeline
  is stationary.  The game now passes that unchanged timeline separately from
  the projected gain state, and the kit treats only that exact identity pair
  as a presentation update.  A real same-frame load/refold still destroys and
  reconstructs persistent voices.  The kit's real-driver test credits 32 PCM
  frames between two settings revisions and proves zero new streams, zero
  destroys, zero replays, the new gain, and the next contiguous sample window
  (`vendor/pocket-rpgkit/tests/audio-host.test.ts:356-391`).  The game-owned
  integration repeats the assertion through the settings adapter
  (`tests/settings.test.ts:419-449`).
- Tuxepedia no longer hard-codes `cm` and `kg`.  It calls the same live unit
  formatters as Party (`ui/tuxepedia.tsx:283`), including upstream thresholds
  and Python round-half-to-even behavior (`ui/settings.ts:79-117`).  Both
  language builds and both required resolutions are pixel- and text-checked.

The three smaller Options findings are also resolved.  PSP chapter playback
uses `frame.__pocketSemanticFrame || frame`, so already-semantic tape masks do
not traverse a user's physical remap a second time (`tools/psp-segment.ts:452`,
`tests/psp-segment.test.ts:443-460`).  Touch/confirm volume cycling first
normalizes arbitrary persisted values into 0..100 and then wraps, while
left/right remains clamped (`ui/options-runtime.ts:231-247`,
`tests/options-runtime.test.ts`).  Finally, this report now attributes the PC
order/no-op checks to `tests/gpc-locker.test.ts`.

All seven inherited START divergences were compared against the pinned source:

| Review item | Upstream evidence | Resolution |
| --- | --- | --- |
| TM with a full moveset | `tuxemon/core/effects/learn_tm.py:43-52`; `tuxemon/monster/moves.py:87-129` | The source appends directly and can exceed the configured move cap.  The port deliberately keeps its explicit four-move replacement picker; this safety/UX choice is now recorded in `docs/status.md`. |
| Release success message | `tuxemon/states/monster_menu.py:310-350` | Confirmation starts on No, Back cannot dismiss it, the displayed name is uppercase, and a localized success result remains until acknowledged (`ui/start-menu-runtime.ts`, `ui/start-menu.tsx:665-687`). |
| Player distance and Tuxepedia progress | `tuxemon/states/character.py:57-76`, `:99-168` | The player page now reads saved global steps, formats km/mi, unions caught into seen, and displays seen/caught/completion against the 393 positive-ID browseable species (`ui/start-menu-runtime.ts:326-361`, `ui/start-menu.tsx:637`). |
| Detail experience basis | `tuxemon/states/monster_info.py:104-128` | Detail shows experience earned within the current level over the complete interval to the next level, including level cap handling (`ui/start-menu-runtime.ts:364-391`). |
| Release-dialog details | `tuxemon/states/monster_menu.py:310-350` | The dialog behavior, row order, uppercase substitution and success acknowledgement now match; solo parties continue to hide Release. |
| Autosave visibility | `tuxemon/states/start.py:91-109` | Autosave is nested under a manual Load row as upstream requires.  The port intentionally requires both files to validate, rather than merely exist, so corrupt data never advertises a guaranteed-failing shortcut; the stricter rule is documented in `docs/status.md`. |
| Held items | `tuxemon/states/monster_menu.py:241-308`, `:367-397` | Give, Take and Swap atomically conserve bag plus party inventory; held reward method and money multiplier survive import/runtime projection and affect battle rewards (`ui/start-menu-runtime.ts:537-613`, `battle/tuxemon.ts:1344-1541`). |

The three inherited test gaps are closed as production-path tests rather than
mock-only assertions.  Detail and Techniques are entered through the default
START runtime (`tests/start-menu-runtime.test.ts:443-472`); the sort fixture
uses values that distinguish all four level/HP/name/ID comparators; and the Web
journey enables the real release title, enters a campaign, opens the real START
menu, activates Exit, and proves the title/session handoff
(`tools/verify-web-journey.ts:107-128`, `:304-337`).

## Save and deterministic-story compatibility

The two isolated imports are byte-identical: 5,076 generated files,
68,897,291 bytes, aggregate SHA-256
`e8f15b5db38ac205264683ab7279b623aea69ef8da37806cac6c20d5e753ef57`.
Enabling the imported global step counter intentionally adds `sw.steps` to
canonical state.  A before/after state comparison found no other semantic
difference, so the maintained victory and defeat terminals were re-pinned to
the following current values:

| Tape | Terminal SHA-256 |
| --- | --- |
| GB6 | `b67a786bcc27243881dbe885ddb375633d26011ababdde52904b7bd8e218f786` |
| J1 | `680f442326ce22732443e8a71c346ad47a11b0a7cf0e3d24464c13d45e83a40e` |
| J2 | `8628713acbb6f503a40f8763314bfbda1944a2f3da9d16d91de79708348c935b` |
| J3 | `04926ffae78129da1b51185f609b18aa81fa5ec81aa6ff734b715f660a725f8b` |
| J4 | `59645ed2633892775f935cd88d1a00003ff93886896ee939973ba23a9fc0ee2e` |
| first battle loss | `fa99f2773e25afe51006670ce297d278768163295d4e59aba3904743b36e709a` |
| later battle loss | `0d104154b19f08dd7cf1c4267f502a31c03a07562d4f2c09e44a7df8044bfdf0` |

Chapter verification covers 20 chapters and 206,822 frames.  Chinese tape,
Chinese and English demo replay, five mid-journey save resumes, 21 preview
states and all 233 built-game checkpoints pass.

A browser slot exported unmodified by the current published main build is
committed under `tests/fixtures/save-compat/main-88347e8e/`.  The new build
loads it, continues for 257 frames through all remaining battle/music
transitions, finishes the mainline, and rewrites it with the current content
identity.  The exact previous manifest/schema pair was appended to the
load-only compatibility list; unrelated mixed pairs remain rejected
(`data/save-compat.ts`, `tests/g-persist-import.test.ts`).

## Host and CI gates

Every command represented by the current workflow was run locally after the
final source and generated-data changes:

| Gate | Result |
| --- | --- |
| `bunx tsc --noEmit` | exit 0 |
| import twice | 5,076 files and 68,897,291 bytes both times; identical aggregate SHA-256 `e8f15b5db38ac205264683ab7279b623aea69ef8da37806cac6c20d5e753ef57` |
| localization/CJK and production build | PASS |
| importer group | 53 pass, 0 fail, 0 skip |
| replay group | 12 pass, 0 fail, 0 skip |
| locks/battle/terrain group | 22 pass, 0 fail, 0 skip |
| rest a-l | 640 pass, 0 fail; both environment-conditional cases rerun in the Bag browser supplement, 3 pass |
| rest m-z | 658 pass, 0 fail; all four environment-conditional cases rerun in the START browser supplement, 6 pass |
| RPG Kit tests after rebuilding wasm/example | four complete filename partitions: 969 + 829 + 1,365 + 1,205 = 4,368 pass, 0 fail, 0 skip |
| focused kit audio and bundle isolation | 33 pass, 0 fail, 0 skip |
| real baseline save load/resave/continuation | PASS |
| Web release journey, Chinese 13-check opening, demo, and WebAudio | PASS; 0 console errors |
| PSP full build and CI `--skip-assets` build | both exit 0; receipt clean |

The PSP output digests are EBOOT
`fabc0a7b32b3d957c5ef21f1c64eb0ff5245856de552565cc7cb7793d009269c`,
assets pak
`058345590095ad42c39db47ef460091ab7521ec81cf99033f85f9c11ef353d9b`,
and PRX
`7c3d0b8173e9dd7d6c261e7e78d379508022ad01f3121f6640453be1c887dbb1`.

Every journey-matrix command passes: GB6 and J1-J4 mainline, golden sync, both
defeat paths, 343 dynamic lock checks with zero unresolved locks, the 263-map
freeze scan, 20 chapters over 206,822 frames, Chinese tape/demo, English demo,
five save-resume points, 21 preview states, and 233 built-game checkpoints.
The web and PSP job commands also pass locally.  This is the final HEAD; no
source or generated file changed after these gates.

## QuickJS performance

The final no-feature-cost comparison used the maintained 3,500-frame G6 tape,
separate QuickJS hosts, one logical CPU, and the required adjacent interleave
main -> branch -> branch -> main.  All four runs reached the same terminal;
their maximum frames remained approximately 26-27 ms, below the 50 ms gate:

| Leg | QuickJS + core total (ms) | Paired delta |
| --- | ---: | ---: |
| main A | 5,329.865 | — |
| branch A | 5,430.618 | +1.890% |
| branch B | 5,456.003 | +1.438% |
| main B | 5,378.692 | — |

The two adjacent legs average **+1.664%**, below the 3% no-regression limit.
Options is closed throughout this production journey, so the measurement
covers the always-installed remap adapter, the default-mapping fast path and
the new kit audio timeline parameter when the feature is unused.  Focused
runtime and visual tests separately exercise open Options, capture, sliders
and touch.

The review called out one old 250.481 ms cold-start sample.  Fresh isolated
probes found the same narrow absolute-limit spikes on baseline main, the
original Options revision and the final branch: 252.936, 254.679, 255.068 and
258.013 ms.  Because the spike crosses revisions, while the adjacent
per-frame comparison is +1.664%, it is host scheduling noise rather than a
branch regression; it is retained here rather than silently discarded.

The kit source change adds 312 bytes to both consumers that contain the audio
driver.  The updated exact bundle pins are Meadow 702,647 bytes, Sunstone
1,119,735 bytes and the WAV fixture 890,172 bytes.  The battle isolation test
records that the Sunstone delta comes from shared audio reconciliation, not a
battle-UI leak.

## Commits and repository hygiene

The work is split into small linear commits on top of baseline `88347e8e`;
there are no merge commits.  Local and remote main still point to that
baseline, so no final rebase was necessary.  `bun.lock` is unchanged in all
three repositories, generated imports are clean, PocketJS remains at
`862040bd77edc49b1f815beff63952b6616a14c6`, and the game submodule points to
the reviewed kit commit `0ff3c8be59597b63ce5180e04844f373bdbe5ace`.

subagent 使用：3 个 / 音频根因、Tuxepedia 单位、G15 遗留对照 / 并行只读调查节省时间

PASS

## Exact binary64 rounding follow-up

The metric-height regression came from treating values within an epsilon of a
decimal half as ties.  That is not what Python does: `round(float, n)` rounds
the exact binary64 input, so values such as the binary representation of
`1.15` remain strictly below the decimal half.  `roundHalfEven` now decodes the
IEEE-754 sign, exponent and significand, builds the exact scaled rational with
`BigInt`, and compares twice the remainder with the denominator.  Equality is
the only half-even path; there is no tolerance (`ui/settings.ts:79-130`).

This restores all seven known metric-height displays to the upstream values:

| Monsters | Height | Display |
| --- | ---: | ---: |
| tux, chillimp, elowind, urcine | 115 cm | 1.1 m |
| aardart, weedlantis | 185 cm | 1.9 m |
| conglolem | 245 cm | 2.5 m |

The offline oracle generator reads the pinned upstream monster YAML files and
uses Python's own rounding operations and conversion constants
(`tools/generate-measurement-expectations.py:1-93`).  Its committed fixture is
numeric-only: 411 sorted monsters, each with source height/weight plus metric
and imperial height/weight results.  Regeneration wrote 411 rows and produced
no diff.  The production test validates the tuple shape and finite cells, then
checks all four formatted measurements for every monster
(`tests/settings.test.ts:357-371`).

The boundary suite covers the immediately adjacent binary64 values below and
above exact decimal ties, exact even and odd ties, the problematic `1.15`,
`1.85`, and `2.45` inputs, integer-rounding neighbours around `0.5`, and signed
zero (`tests/settings.test.ts:304-339`).  A deterministic differential probe
also compared 50,400 binary64/digits pairs, including subnormals, infinities,
NaNs, maximum finite values and the `-308`/`323` cutoffs, directly with Python:
50,400 checked, zero mismatches.  In isolated mutation copies, restoring the
epsilon implementation failed two tests (including aardart), and replacing
metric rounding with `toFixed` failed two tests (including the 125 cm and
rhinocarpe cases).

No committed Tuxepedia golden contains one of the seven corrected monsters:
the populated visual fixture selects Nut
(`tools/tuxepedia-visual-fixture.ts:33-35`).  Therefore no PNG was regenerated;
the full Tuxepedia visual suite still passed its committed RGBA and hash
comparisons.  Aardart appears only in Dojo captures that do not render height.

### Follow-up gates

| Gate | Result |
| --- | --- |
| `bunx tsc --noEmit` | exit 0 |
| import twice | 7,074 files and 140,393,220 bytes both times; identical aggregate SHA-256 `c47b8acdb42feb920095bed155364d9dd8c7758c9571623c3c15a2ffb9866f0c`; clean generated diff |
| production build and rebuilt wasm | exit 0; wasm 360,011 bytes |
| settings suite | 20 pass, 0 fail; 2,493 focused measurement expectations |
| importer / replay / locks-battle-terrain partitions | 53 / 12 / 22 pass, 0 fail |
| rest a-l | 640 pass, 0 fail; 2 browser-conditional cases accounted for below |
| rest m-z | 660 pass, 0 fail; 4 browser-conditional cases accounted for below |
| browser-condition supplement | 9 pass, 0 fail; all six default-condition skips executed |
| Chinese Web smoke | 13/13 assertions, 3,188 frames, 22 screenshots, no console errors |
| J4 mainline from frame zero | PASS; 206,822 frames; terminal SHA-256 `59645ed2633892775f935cd88d1a00003ff93886896ee939973ba23a9fc0ee2e`, unchanged from the preceding fix |

`bun.lock` is unchanged, the branch is linear, and no generated or visual
artifact changed after the deterministic import checks.

subagent 使用：3 个 / 分别核对上游舍入语义、夹具与测试辨识力、golden 影响范围 / 并行只读调查节省了探查时间

PASS
