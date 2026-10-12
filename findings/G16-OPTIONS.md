# Options settings and PC menu parity

## Result

The title screen and in-world START menu now share one bilingual Options
implementation.  It owns installation preferences outside campaign state,
remaps the seven upstream controls, applies mute and volume at the final audio
output boundary, formats party measurements in the selected units, and makes
the selected hemisphere affect season conditions immediately.  The PC menu
also carries upstream's permanent Multiplayer placeholder, so all ten
`access_pc` actions are Native.

The implementation is confined to the game repository.  No RPG Kit or
PocketJS change is required, and `bun.lock` is unchanged.

## Upstream comparison

| Upstream behavior | Source evidence | Port behavior |
| --- | --- | --- |
| Up, left, right, down, primary, secondary and back are independently configurable | `tuxemon/states/control_state.py:60-94`; input capture and live keyboard reload at `tuxemon/states/set_key_state.py:44-65` | The same seven semantic slots accept normalized keyboard or controller buttons.  A duplicate first raises an explicit conflict; confirmation swaps the two slots so the mapping remains a total bijection.  Restore Default resets only controls. |
| Restore Default, language and screen size appear in title Options | `tuxemon/states/control_state.py:96-135` | Title Options exposes those rows.  Web and desktop keep PocketJS's logical 480x272 canvas and show its host-owned size read-only; their browser/window chooses physical scale.  PSP is fixed at 480x272 and omits the row. |
| Mute, music volume, effect volume, units and hemisphere appear only in the in-game menu | `tuxemon/states/control_state.py:138-258` | START Options adds precisely that subset.  Both volume sliders use the upstream 0..100 range and ten-point steps. |
| Defaults are metric, northern, music 0.5 and effects 0.2 | `tuxemon/config.py:70-84` | Defaults are metric, northern, music 50%, effects 20%, unmuted and identity controls (`ui/settings.ts:64-76`). |
| Preferences live in `tuxemon.yaml`, separately from the save directory | `tuxemon/config.py:341-420`; `tuxemon/constants/paths.py:58-76` | Preferences use `pocket-tuxemon/settings` in Web Storage, `settings.json` in desktop data storage and `save/settings.json` on the PSP memory stick (`ui/settings.ts:12-16`, `ui/settings.ts:207-272`).  They never enter reducer, extension or save envelopes. |
| Units affect monster height/weight and party walking-distance presentation | `tuxemon/states/monster_info.py:56-76`; `tuxemon/states/party.py:143-164` | Party detail height and weight use the chosen metric/imperial format (`ui/settings.ts:79-93`).  This port has no walking-distance field, so there is no corresponding display to convert. |
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
state is read (`ui/weather-effects.tsx:180-181`).  Music mute/volume and effect
volume therefore alter real Web, desktop and PSP PCM output without changing
simulation state, rewind state or saves.  Unchanged input identity and
settings revision return the same adapted object, avoiding per-frame work when
Options is closed (`ui/settings.ts:517-530`).

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

The PC Chinese goldens were regenerated and inspected as well; Multiplayer is
between the dynamic rows and Log Off at both resolutions.

## Focused behavior and mutation checks

Focused tests exercise real imported project data and generated PO copy:

| Area | Positive gate |
| --- | --- |
| Versioned defaults, all three stores, malformed/unreadable fallback, binding conflict/swap, mounted remapping and real `AudioDriver` output | `tests/settings.test.ts` |
| Title/START row split, touch/PSP capabilities, live sliders, unit/hemisphere changes, conflict confirmation and navigation | `tests/options-runtime.test.ts` |
| Byte-identical production save before/after preference changes and absence of preference fields | `tests/options-save-separation.test.ts` |
| Upstream PC order and localized no-op semantics | `tests/pc-multiplayer.test.ts` |
| Real en_US/zh_CN PO extraction | `tests/feature-modes-import.test.ts` |
| Immediate southern-season result through the production extension | `tests/time-weather-import.test.ts` |

Four isolated worktree mutations were each required to turn the matching gate
red, then discarded:

| Mutation | Detecting assertion |
| --- | --- |
| Return the physical mask without applying remapping | CROSS/CIRCLE swap and mounted-frame semantic-mask assertions fail |
| Bypass the audio settings adapter | emitted BGM/SFX volume and mute assertions fail |
| Add preferences to the campaign snapshot | byte identity and recursive forbidden-key scan fail |
| Let malformed JSON escape the loader | corrupt desktop/PSP/Web store fallback assertions fail by throwing |

No mutation was made in the delivery worktree.

## Save and deterministic-story compatibility

The two isolated imports are byte-identical: 5,076 generated files,
68,890,970 bytes, aggregate SHA-256
`0c34d856a6908a81b08b9f84ea6ae78fe0082eb3d1f7e5dc268e0d5867525c64`.
The GB6 and four continuation terminal hashes remain:

| Tape | Terminal SHA-256 |
| --- | --- |
| GB6 | `fa4a55f281b94f8c2eeb3f157d432c33746ef97cd7fa7463b4ca9edc4a7184a0` |
| J1 | `6f21d87d7631b067e46dc306d8b3a22853c145714300679957570df0f3a7c25d` |
| J2 | `f0b63d5e627b4661eb8c2ecc936bc55a7fad5e3d046bb87dfe52c4c6ecacf1e4` |
| J3 | `1bd475f12f455ca6ad2a2bf645b9694c2e234343edb8c5200c2a51f6dea75055` |
| J4 | `4c7b0a0283368fa57360d73ca4f28643ab2ab6dec75d6e148d0be1e83102ed37` |

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

The following completed before the final report pass:

| Gate | Result |
| --- | --- |
| `bunx tsc --noEmit` | exit 0 |
| `bun run check:l10n` / `bun run check:cjk` | 11/11 supplements; 2,643 CJK characters covered |
| `bun run build` / `bun run build:wasm` | main bundle 2,219,798 bytes; wasm 360,011 bytes |
| CI five test matrix groups plus browser-condition supplement | 1,376 unique tests passed, 0 failed, 0 outstanding skip |
| `bun run web` plus English journey, Chinese opening, demo and real AudioWorklet verification | PASS; all five exercised audio phases emitted non-zero output |
| CI-style `bun run build:psp --skip-assets` | runtime 2,219,967 bytes; external assets 67,639,568 bytes; EBOOT 5,821,928 bytes; assets pak 67,639,568 bytes; PRX 5,821,596 bytes |
| Current-main fixture load/resave/continue | 12 assertions passed, 0 failed |

The local `ci.yml` test groups report importer 53 pass; replays 12 pass;
locks/battle/terrain 22 pass; rest a-l 635 pass plus two SSR-only conditional
skips; and rest m-z 650 pass plus two SSR-only conditional skips.  The
browser-condition supplement passes seven assertions, including all four
conditional cases, so the final unique result is 1,376 pass, 0 fail and 0
outstanding skip.

Every journey-matrix command passes: GB6 and J1-J4 mainline, golden sync, both
defeat paths, 343 dynamic lock checks with zero unresolved locks, the 263-map
freeze scan, 20 chapters over 206,822 frames, Chinese tape/demo, English demo,
five save-resume points, 21 preview states, and 233 built-game checkpoints.
The web and PSP job commands also pass locally.  This is the final HEAD; no
source or generated file changed after these gates.

## QuickJS performance

The specified historical startup tape and state pin no longer match current
main.  The comparison therefore uses the nearest maintained one-frame live
startup tape (no frozen metadata), expected map `spyder_bedroom`, and a state
hash first confirmed identical on main and this branch.  Both hosts are built
from their own worktree because the host input stamp includes the absolute
source path.  Measurements are pinned to one logical CPU and interleaved
main -> branch -> branch -> main, five fresh 480x272 processes per leg.  The
outer runner continues after a failed process so a slow sample is retained
instead of being replaced.  The measured window started at one-minute load
5.94 and ended at 5.24; all processes used the default 250 ms release limit,
with `G6_STARTUP_MS`, profiling and budget overrides unset.

| Leg | Startup-to-first-paint samples (ms) | Median (ms) |
| --- | --- | --- |
| main A | 239.463, 243.366, 244.743, 245.972, 241.782 | 243.366 |
| branch A | 239.833, 238.923, 247.456, 244.859, **250.481** | 244.859 |
| branch B | 232.916, 229.952, 247.887, 249.826, 249.326 | 247.887 |
| main B | 236.913, 243.980, 241.926, 238.661, 234.285 | 238.661 |

The forward paired median is +0.613% and the reverse paired median is +3.866%;
their two-pair median is **+2.240%**, below the 3% no-regression threshold.
The bold branch sample exceeded the absolute wall-clock gate by 0.481 ms and
is deliberately retained as failed; the relative result does not relabel it
as a pass.  Two earlier incomplete windows likewise retain branch stops at
256.298 and 257.437 ms.  A saturated-host attempt is also retained: main
itself rose from approximately 254 ms to 536.772 ms when all 32 logical CPUs
were busy.  A later idle-core probe was rejected when the selected core
changed from idle to busy and all five main samples rose to 341-364 ms.  None
of these incomplete environmental windows replaces a sample in the complete
table.

The per-frame comparison uses the maintained 3,500-frame G6 tape on the same
main -> branch -> branch -> main order.  All four default-gate processes pass
startup, the 50 ms frame limit and terminal hash
`d4add57567f04b5b12b7ef3ebd8cbfeac3fdb33009d89f0ef28b9ebc6a80cdf9`:

| Leg | QuickJS+core total (ms) | Maximum frame CPU (ms) |
| --- | ---: | ---: |
| main A | 5,245.429 | 25.879 |
| branch A | 5,232.638 | 25.799 |
| branch B | 5,319.657 | 23.883 |
| main B | 5,241.274 | 23.849 |

The paired total-time deltas are -0.244% and +1.495%, for a two-pair median of
**+0.626%**.  Options is closed throughout this production journey, so this
directly covers the always-installed remap adapter and idle overlay path.  The
focused visual/runtime tests separately exercise open Options, capture,
sliders and touch.

## Commits and repository hygiene

The work is split into small linear commits on top of the published baseline;
there are no merge commits.  `bun.lock` is unchanged, generated imports are
clean, and no component submodule pointer moved.

Subagent use: 4 read-only agents / host capability audit, UI integration audit,
upstream behavior comparison, and validation/mutation planning / parallel
reading shortened exploration without sharing writes.

PASS
