# CI screenshot tests: order-independent captures

## Result

The screenshot failures were caused by leaked game boot globals, not by a font
atlas or text-layout cache. A PSP bundle probe evaluated a generated bundle in
Bun's shared test realm. The generated prefix installed a chapter snapshot and
timeline frame, but the probe did not restore those properties. The next visual
fixture therefore resumed the radio-broadcast chapter instead of starting a
fresh game.

The probe now restores the complete property descriptors of every global it
touches. Deterministic visual boots also explicitly clear all chapter-wrapper
globals and explicitly select their language. The committed goldens did not
change, and all requested order, standalone, memory, TypeScript, suite, journey,
web and PSP checks pass.

## Root cause and reproduction

`bakeSegmentBundle()` prepends assignments to
`__pocketTuxemonInitialCivilTime`, `__pocketTuxemonBootSnapshot` and
`__pocketTuxemonBootFrame` before the production bundle. The PSP wrapper test
executes that bundle with `new Function(bundle)()` for the `radio-broadcast`
segment. Bun keeps one global realm for the files in this test process, while
the simulator does not know that these game-specific globals should be erased.

Before the fix, the probe restored `frame`, the PSP callbacks,
`__pocketTuxemonBootReady` and `__rpgSessionState`, but omitted the three prefix
properties. In particular, the leaked radio-broadcast snapshot was truthy at
the next `bootWorld()` call. The Chinese UI fixture then restored that chapter
and could not drive its opening tape to the expected battle command menu.

Minimal pre-fix reproduction:

```text
bun test tests/psp-segment.test.ts tests/ui-text-zh-visual.test.ts \
  -t '(terminal is logged|matches every production surface)'

1 pass, 1 fail
uiText zh fixture: zh smoke journey did not reach the battle command menu
```

The same command after the fix reports `2 pass, 0 fail`. The focused three-file
regression run (`psp-segment`, `ui-text-zh-visual`, `tuxepedia-visual`) reports
`38 pass, 0 fail, 435 expect() calls`.

This also disproves the initial font-cache hypothesis: every `bootWorld()`
evaluates a fresh production IIFE, so the production text-measure cache belongs
to that bundle instance. The cross-file state that survived was on
`globalThis`, and the two-test reproduction isolates the writer and reader.

## Fix

| Area | Change |
|---|---|
| Fixed visual boot globals | `FIXED_TIME_HOST_GLOBALS` now supplies `undefined` for the boot snapshot, boot frame and boot-ready flag, in addition to the fixed civil time. Every consumer therefore asks for a fresh-game boot explicitly. |
| Generated-bundle probe | The PSP probe snapshots full descriptors for all nine touched globals, deletes the probe values in `finally`, reinstalls any original descriptors, and asserts exact post-test restoration. This preserves the distinction between an absent property and an own property whose value is `undefined`. |
| Language isolation | Tuxepedia captures now force both `en_US` and `zh_CN`; an English capture can no longer inherit a previous Chinese override. The Chinese UI fixture already uses fresh in-memory storage and explicitly forces `zh_CN`. |
| Semantic visual checks | The Chinese UI test now locates the actual glyph mask for all nine production surfaces at both 480×272 and 960×544: save menu, save success, save failure, demo menu, shop, name input, button hints, event error and battle prompt. No pixel threshold was widened. |
| Documentation | The CI guide documents five test legs, sixteen journey legs, the two rest halves and the shared-realm restoration rule. The feature status page marks order-independent visual tests Done. |

## Golden regeneration and visual review

The repository tools were used after rebuilding the production bundle:

```text
bun run goldens:ui-text:zh
bun tools/update-tuxepedia-goldens.ts
```

The two manifests and all 30 associated PNGs (18 Chinese UI captures and 12
English/Chinese Tuxepedia captures) were byte-identical before and after
regeneration. Their aggregate SHA-256 stayed:

```text
e88de346cde65ab82e6fddc22831bf737a9f166668bb5618dc3eca3c86968f68
```

There are consequently no per-image changes to attribute: removing the order
dependency restores the already-committed fresh-boot rendering.

The nine Chinese UI cases were also opened at 3× for each source tier. At
480×272 and 960×544, Chinese glyphs are present and shaped correctly; there is
no tofu, inserted ellipsis, clipping or overlap. The 960×544 captures retain the
intended centered/letterboxed layout. The glyph-mask assertions independently
check those same 18 source frames at their native capture sizes.

## Order and standalone matrix

All commands used the pinned Tuxemon source. `rest (a-l)` contains 79 files and
`rest (m-z)` contains 53 files.

| Registration/execution order | rest (a-l) | rest (m-z) | Result |
|---|---:|---:|---|
| Workflow filename order | 592 pass, 0 fail | 542 pass, 0 fail | PASS |
| Exact reverse filename order | 592 pass, 0 fail | 542 pass, 0 fail | PASS |
| `bun test --randomize --seed=3992` | 592 pass, 0 fail | 542 pass, 0 fail | PASS |
| `bun test --randomize --seed=3993` | 592 pass, 0 fail | 542 pass, 0 fail | PASS |

The reverse run uses one driver that dynamically imports every file in exact
reverse basename order, so it tests registration order rather than merely test
case order. In seed 3992, the formerly failing `ui-text-zh-visual.test.ts` ran
first in the m-z half and still passed.

Every screenshot-oriented file was also run in its own fresh Bun process:

```text
files=$(rg --files tests | rg '(visual|golden).*\.test\.ts$' | sort)
for file in $files \
  tests/battle-presentation-sim.test.ts \
  tests/battle-scene.test.ts \
  tests/battle-spectator-pixel.test.ts \
  tests/choice-icons-lazy.test.ts \
  tests/g-identity-e2e.test.ts
do
  bun test "$file" || exit $?
done
```

All 28 visual/golden files plus the five extra screenshot/pixel harnesses exited
zero. In particular, `ui-text-zh-visual.test.ts` reports 3/3 and
`tuxepedia-visual.test.ts` reports 7/7 when run alone.

## Resident-memory measurement

Each workflow half was run as its own process under `/usr/bin/time -v` using
the exact CI file selection. A full unsplit `bun run test` measurement is shown
for context.

| Process | Files/tests | Maximum RSS | GiB | Share of 16 GiB |
|---|---:|---:|---:|---:|
| `rest (a-l)` | 79 files, 592 pass | 6,503,428 KiB | 6.20 | 38.8% |
| `rest (m-z)` | 53 files, 542 pass | 8,107,680 KiB | 7.73 | 48.3% |
| Full suite, one process | 139 files, 1,221 pass | 16,022,200 KiB | 15.28 | 95.5% |

Both split jobs remain below half of a 16 GiB runner, leaving at least 8.27 GiB
of headroom. The full-suite measurement nearly consumes the runner by itself,
which independently confirms that keeping the two rest halves separate is
necessary. Neither split process swapped.

## CI workflow gates

Every executable command in the workflow's import, test, journey, web and PSP
jobs was run locally. GitHub artifact upload and Pages deployment actions have
no local command equivalent.

### Import

- Re-import completed and `git status --porcelain` remained empty.
- `bunx tsc --noEmit`: exit 0.
- Isolated import determinism: 4,774 files, 67,277,255 bytes, SHA-256
  `9df974fca2606745097452ab8bd73f68083b1ccd03079d6becdd8708f2937929`.
- Translation supplement: 11/11 checks; the CJK audit covers all 2,482 fallback
  characters.

### Test matrix and full suite

| Workflow leg | Result |
|---|---:|
| importer | 53 pass, 0 fail |
| replays | 12 pass, 0 fail |
| locks, battle data and terrain | 22 pass, 0 fail |
| rest (a-l) | 592 pass, 0 fail |
| rest (m-z) | 542 pass, 0 fail |

`bun run test` also completed in one process: `1221 pass`, `0 fail`, 139 files,
228,444 assertions, 405.10 seconds, exit 0.

### Journey matrix

All sixteen workflow legs passed:

- GB6, J1, J2, J3 and J4 mainlines through frame 206,830;
- 11 golden checkpoints synchronized with their authoritative tapes;
- both defeat/recovery tapes and all imported input-lock executions;
- freeze scan over 263 maps: 0 permanent input locks, 0 permanent fibers and
  0 errors;
- 20 chapter snapshots/thumbnails, with every suffix reaching terminal hash
  prefix `3fedbe7d8486`;
- English and Chinese tape/demo synchronization;
- five save/resume points;
- neighbour preview coverage over 21 states with 0 mainline rejects; and
- production-bundle replay over 233 checkpoints and 206,830 frames.

### Web

- `bun run web`: exit 0.
- Web journey: correct 480×272 logical / 960×544 physical raster, all state and
  framebuffer pins matched, browser save/load round-tripped, 0 console errors,
  `WEB JOURNEY PASS`.
- Chinese opening: 3,188 frames, 22 captures, 13/13 assertions, subset-font and
  glyph-mask checks passed, `PASS`.
- Demo: chapter selection, deep links, English/Chinese autoplay and reducer
  state hashes passed with 0 console errors, `WEB DEMO PASS`.
- Audio: three imported tracks produced nonzero AudioWorklet samples with 0
  underruns and 0 errors, `WEB AUDIO PASS`.

### PSP

LLVM 18 and the pinned PocketJS PSP SDK/toolchain passed `bun run bootstrap`.
`bun run build:psp --skip-assets` then exited 0 and produced the release package:

| Artifact | Bytes |
|---|---:|
| `EBOOT.PBP` | 6,284,848 |
| `assets.pak` | 65,979,232 |
| `pocket-tuxemon.prx` | 6,284,516 |
| `AUDIO-ATTRIBUTIONS.md` | 4,917 |
| `build-receipt.json` | 1,539 |

No `bun.lock` changed, and the root repository plus both nested submodules were
clean after all gates.

subagent 使用：3 个 / 分别只读追踪共享状态根因、盘点截图与肉眼核对工具、核对 CI 与顺序矩阵 / 并行调查缩短了定位时间，重测试与性能测量均由主 agent 串行完成

PASS
