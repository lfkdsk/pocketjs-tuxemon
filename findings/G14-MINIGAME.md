# Title-screen Guess the Monster and menu audit

## Result

The title screen now exposes **Adventure**, **Battle**, and **Minigame**. The
new mode reproduces Tuxemon's three-level monster quiz with imported English
and Chinese text, the complete upstream quiz pool, deterministic local random
streams, lazy front art, lossless hard-mode description pages, score/streak
rules, controller/keyboard input, and scaled touch at both supported
viewports. It can always return directly to the title screen.

Quiz state is disposable and independent of the campaign. It does not read or
replace the live session, advance campaign RNG, modify party or Tuxepedia
state, create a save field, or persist a high score. The RPG Kit and PocketJS
submodule revisions are unchanged.

The same pass audited every row constructed by Tuxemon's title and in-world
START menus. All seventeen fixed or item-driven entry points now have an
explicit Done, Partial, or Planned row in `docs/status.md`.

## Upstream behavior and port mapping

The implementation was checked line by line against the pinned Tuxemon
source:

| Behavior | Upstream source | Port behavior |
| --- | --- | --- |
| Easy, Normal, Hard picker | `tuxemon/states/start.py:135-143,195-201` | Three imported labels lead to independent deterministic streams |
| Prompt and target | `tuxemon/states/minigame.py:56-68` | Imported `who_is_that`; target is drawn from the exact cache-equivalent pool |
| Image clue | `tuxemon/states/minigame.py:70-93` | Easy and Normal acquire the selected monster's existing lazy front sheet only after the question opens |
| Description clue | `tuxemon/states/minigame.py:94-103` | Hard acquires no monster art and paginates the localized `<slug>_description` without truncation or ellipsis |
| Choice count and guaranteed answer | `tuxemon/states/minigame.py:105-128` | Easy has 3 distinct choices; Normal and Hard have 5; the target occurs exactly once |
| Score and streak display | `tuxemon/states/minigame.py:130-151` | Score and streak remain visible; the imported streak notice appears from 10 onward and adds no separate points |
| Correct answer | `tuxemon/states/minigame.py:153-166` | Adds +1/+2/+3 for Easy/Normal/Hard, increments streak, and creates the next question |
| Wrong answer | `tuxemon/states/minigame.py:168-172` | Keeps the question and score, clears streak, and shows imported `generic_wrong` until acknowledged |
| Exit | the upstream menu state's normal back path | Back or the always-visible touch Exit returns to title and discards quiz state |

Upstream initializes `score=0` and `streak=0` every time the title launches
`MinigameState` (`start.py:195-201`) and passes them only to the next in-memory
question (`minigame.py:161-166`). It never invokes save, party, discovery, or
high-score APIs. The port therefore deliberately has no high-score persistence
and does not mark a shown monster seen or caught.

## Imported data, localization, and deterministic RNG

`MonsterModel.load_cache()` admits records with `txmn_id > 0`
(`tuxemon/db.py:1310-1317`). The source contains 411 monster records: 393 are
eligible and exactly 18 zero-ID records are excluded. No other property is a
filter: records with `randomly: false`, unusual forms, or any evolution stage
remain eligible. Import tests compare the generated sorted list directly with
all real source YAML records and require bilingual names, descriptions, and a
front sheet for every eligible slug.

Every visible label, monster name, and description is resolved through the
same merged `.po` catalogs as the rest of the game. The upstream en_US and
zh_CN catalogs supply the source strings; existing reviewed zh_CN
`supplement.po` entries fill untranslated score/streak/difficulty keys, and
the existing `overrides.po` review supplies the polished `who_is_that`
translation. There are no minigame-specific UI string literals. Fourteen
newly reached Chinese description characters were added to the generated CJK
subset; the font grew from 692,436 to 696,580 bytes and the exhaustive CJK
coverage check passes.

The seed is FNV-1a over the version tag
`pocket-tuxemon/title-minigame/v1` followed by the sorted eligible slugs. The
current imported seed is `176815842`. Easy, Normal, and Hard each begin with
`seed XOR Math.imul(difficultyIndex + 1, 0x9e3779b1)`, so the same content and
action sequence reproduce exactly while campaign RNG is untouched. A future
source-pool change intentionally changes the quiz sequence.

## Runtime ownership and save compatibility

The quiz lives entirely in the title overlay runtime. A unit test holds a real
campaign object by identity, completes a Normal question, and proves that its
serialized state and campaign RNG never change. Exiting clears quiz state;
re-entering starts at score/streak/round zero and reproduces the first
question from the content seed. No schema, map identity, save extension, RPG
Kit, or PocketJS change was made.

An unmodified current-main browser build generated a real save, whose envelope
SHA-256 is
`76c0ca2598365500de001e896e5cb1fcdad5300c4e648a100018ccc0bf954aca`.
The candidate loaded and re-saved it, then replayed the next 257 inputs to the
same state SHA-256
`5c40d03f6bd42b6278914cf9874a8074a8e3c07cde04910cd0c1ae4b30bfc0fd`.

All maintained campaign terminals are unchanged:

| Journey | Total frames | Terminal state SHA-256 |
| --- | ---: | --- |
| GB6 | 115,842 | `fa4a55f281b94f8c2eeb3f157d432c33746ef97cd7fa7463b4ca9edc4a7184a0` |
| J1 | 128,718 | `e3f4a709c341a7ec617ad12da78d179f99c5e5ca99ad31cb135ec2dbf333ac71` |
| J2 | 180,125 | `f0b63d5e627b4661eb8c2ecc936bc55a7fad5e3d046bb87dfe52c4c6ecacf1e4` |
| J3 | 193,227 | `1a99a07129efa089906723f60921daeb02faaa75b2069d7ea91bf7c7ddbe4d17` |
| J4 | 206,822 | `5d22fc6decde61c569d60d3fd26ef4985e9c8bfc2973c383192185c4147cc85e` |

The built production bundle also reached all 233 J4 checkpoints. Five
save/resume points reached their uninterrupted terminals, both maintained
battle-loss recoveries passed, 343 imported locks reached their unlocks, and
the 263-map freeze scan found no permanent lock, blocked fiber, or runtime
error.

## Input, layout, and visual review

Controller and keyboard use the existing directional, confirm, and back
actions. Hard-mode left/right cycles description pages. Touch has independent
scaled hit regions for the title row, all three difficulties, all five answer
positions, and Exit. The production-bundle fixture taps those public regions
at 480×272 and 960×544; it proves opening, scoring, streak increment, and exit
at both scales rather than calling reducer helpers directly.

Twelve new committed minigame goldens cover every combination of:

- English and Chinese;
- Easy, Normal, and Hard;
- 480×272 and 960×544.

The four title goldens were also refreshed for the third row. All sixteen
changed/new frames were opened at native size and 300% scale. The two image
modes show a centered front sprite and complete answer labels; Hard shows a
four-row description panel, page indicator, and no sprite; Chinese labels and
descriptions are not clipped; and 960×544 preserves the intended nearest-
neighbour 2× composition.

The visual test also compares every production RGBA buffer byte-for-byte with
its golden, pins PNG and RGBA hashes, checks localized semantic-tree strings,
and asserts clue-mode node presence. Hard's rendered rows reconstruct the
source description losslessly and contain no ellipsis.

## Lazy art and package impact

The quiz reuses the existing battle catalog and `loadTileTexture` path. It
does not add a title-time atlas. Instrumented production captures observed
these IMG acquisitions per route:

| Screen | Acquisitions |
| --- | ---: |
| Difficulty picker | 0 |
| Easy question | 1 |
| Normal question | 1 |
| Hard question | 0 |

To cover the complete upstream pool, the generated battle repository expands
from 382 to 407 monsters, from 258 to 259 techniques, and from 714 to 739
texture sources. The delta is 25 small upstream battle sheets; every one is
still an individually keyed lazy PAK entry.

Like-for-like production sizes on current main and the candidate are:

| Target | Main | Candidate | Delta |
| --- | ---: | ---: | ---: |
| Web runtime JS | 1,968,285 B | 1,992,513 B | +24,228 B (+1.23%) |
| Web PAK | 93,561,504 B | 93,926,128 B | +364,624 B (+0.39%) |
| Desktop runtime JS | 1,968,285 B | 1,992,513 B | +24,228 B (+1.23%) |
| Desktop startup PAK | 57,492,448 B | 57,786,256 B | +293,808 B (+0.51%) |

The full PSP build produced a 1,991,939-byte runtime, 67,402,800-byte external
asset payload, 1,144,640-byte embedded startup PAK, and 5,564,956-byte
`EBOOT.PBP`.

## Complete upstream menu audit

### Title screen

The fixed title rows come from `tuxemon/states/start.py:91-156`.

| Upstream entry | Source lines | Status | `docs/status.md` mapping |
| --- | --- | --- | --- |
| Load | 91-98 | Partial | line 31: loading exists after Adventure/START, but no conditional title row |
| Autosave | 99-109 | Partial | line 32: readable from START after Adventure, but no conditional title row |
| New Game | 111-126 | Done | line 33: Adventure starts the one bundled campaign; a multi-mod picker is inapplicable |
| Battle | 127-134 | Done | line 34: all five imported recipes and disposable battles |
| Minigame | 135-144 | Done | line 35: the complete three-difficulty implementation documented here |
| Options | 145-150 | Partial | line 36: language switching exists; control remapping does not |
| Exit | 151-156 | Planned | line 37: process/window closure remains host-owned |

### In-world START menu

The fixed rows come from `tuxemon/world/manager.py:208-264`. Item-driven world
rows are inserted by `manager.py:142-180`; an exhaustive item-database scan
finds exactly `app_tuxepedia.yaml:12-16` and `nu_phone.yaml:12-16` with
`menu_type: world`.

| Upstream entry | Source lines | Status | `docs/status.md` mapping |
| --- | --- | --- | --- |
| Tuxemon / party | 208-215 | Planned | line 43: no general START party browser |
| Bag | 217-228 | Planned | line 44: inventory works elsewhere, but no general browser/use screen |
| Player | 230-233 | Planned | line 45: identity/progress are saved, but no status screen |
| Missions | 235-240 | Planned | line 46: no list; this campaign's mission actions are upstream no-ops |
| Save | 242-247 | Done | line 47: three slots and save-code export with safety refusal |
| Load | 249-254 | Done | line 48: slots, save code, automatic save, and compatible older formats |
| Options | 256 | Partial | line 49: bilingual language switcher, without remapping |
| Exit | 258-264 | Planned | line 50: no action that clears the world and returns to title |
| Tuxepedia, item-driven | 142-180 plus item row | Partial | line 51: full journal exists but is not ownership-gated |
| Nu Phone, item-driven | 142-180 plus item row | Done | line 52: ownership-gated phone and imported Map App |

No previously invisible title or START entry remains undocumented.

## Mutation strength

Four mutations ran in separate disposable worktrees, never in the candidate
checkout. Each made the intended focused suite red, then its worktree was
removed:

| Mutation | Detecting failure |
| --- | --- |
| Omit target replacement when the initial sample misses it | 128-real-round invariant found a question with zero correct options |
| Change Hard's clue from description to image | clue contract and production hard-no-art assertions failed |
| Preserve streak after a wrong choice | wrong-answer test expected streak 0 after four correct answers |
| Rotate the difficulty point values | imported `[1,2,3]` table and per-answer delta checks failed |

## QuickJS performance

The benchmark used separately built current-main and candidate bundles in
main → candidate → candidate → main order at both viewports. Every cold run
reached the same first-frame state SHA-256
`7f5a73f780c13c25e168769241853b9e4b02fd62011704342fc7297b79ad7db8`.

The common gate's prescribed hash
`a5e82cc4844ff05ff775e2870af81b5e2766818f5c3711a06574cdad461172cc`
is stale for the mandated G12 base: unmodified current main itself produces
the former hash. The comparison therefore pinned the baseline-observed hash
for both revisions rather than weakening state equality.

| Scenario | Viewport | Main median | Candidate median | Delta |
| --- | --- | ---: | ---: | ---: |
| Cold startup to first frame | 480×272 | 229.816 ms | 225.485 ms | -1.88% |
| Cold startup to first frame | 960×544 | 224.885 ms | 229.767 ms | +2.17% |
| Title-feature startup | 480×272 | 232.684 ms | 234.972 ms | +0.98% |
| Title-feature startup | 960×544 | 232.211 ms | 237.651 ms | +2.34% |

One retained baseline feature run took 250.292 ms while host load average was
18.06 and therefore tripped the 250 ms single-run gate. The same unchanged
baseline had measured 236.973 ms earlier and an immediate retained rerun
measured 228.394 ms. It was excluded from the median table as host-load noise,
not hidden as a candidate result.

Across both candidate passes and viewports, Easy entry was at most 0.596 ms
and its 120-frame steady sample at most 0.880 ms; Hard entry was at most
0.601 ms and steady state at most 0.327 ms. All are below the 50 ms scene
budget. Candidate QuickJS used heap was 9.37 MiB at title, 9.61 MiB in Easy,
and 10.02 MiB in Hard.

## Reproducibility and gates

Two imports left no tracked diff. The isolated determinism verifier reported
aggregate SHA-256
`2e45194ba3928cc5939bf8cbb08eaacf33964c0af81a99fc15b184e94857b9e7`.

Every command represented by the current CI workflow was run locally:

| Gate | Result |
| --- | --- |
| `bunx tsc --noEmit` | PASS |
| standard build and PocketJS wasm | PASS |
| localization and exhaustive CJK subset | PASS |
| importer test group | PASS — 53/53 |
| replay test group | PASS — 12/12 |
| locks/battle-data/terrain test group | PASS — 22/22 |
| rest a-l test group | PASS — 611/611 |
| rest m-z test group | PASS — 586/586 |
| all five CI test groups | PASS — 1,284 tests |
| all sixteen journey matrix commands | PASS |
| chapters / save / preview / built-bundle replay | PASS — 20 chapter suffixes, 5 save points, 21 preview states with 0 mainline rejections, 233 bundle checkpoints |
| web build and four browser gates | PASS — journey, Chinese opening, demo controls, and three audio streams; 0 console errors |
| pinned PSP bootstrap and CI `--skip-assets` build | PASS |
| full PSP build | PASS |
| current-main browser-save load/resave/continuation | PASS |
| interleaved QuickJS cold and focused feature benchmarks | PASS, with the retained baseline-load disclosure above |

The implementation, generated data, font, tests, goldens, status matrix, and
this report are game-repository changes only. `bun.lock` is unchanged.

subagent 使用：4 个 / 分别核对上游语义、数据与懒资源、UI 架构与独立状态、完整门禁与报告证据 / 并行核对明显省时

PASS
