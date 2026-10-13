# ARENA-7 fix: capped encounters and replay-log regressions

## Result

Expedition action discovery now omits exploration when the current area has no
encounter row that can produce an opponent at or below the configured level
cap. The selector and legality check share the same eligible pool, so an
advertised exploration action cannot reach the former empty-pool corruption
path. The continuation, journal-boundary, malformed-source and bundle-isolation
gaps found in the ARENA-7 review are all pinned by discriminating regressions.

## Level-cap root cause and contract

The pre-fix route-6/cap-7 reproduction returned:

```json
{"exploreAdvertised":true,"ok":false,"error":"CORRUPT_STATE"}
```

`legalExpeditionActions` checked party health and provenance capacity but not
whether the level-capped encounter pool was empty. It therefore advertised
`explore`. `selectEncounter` independently filtered out every row, threw
`no eligible encounter rows`, and the public reducer converted the unexpected
exception to `CORRUPT_STATE`.

The chosen contract is that `rules.levelCap` bounds both carried player records
and generated wild opponents. Both sides enter the same Arena battle, and a
captured wild individual becomes a persistent expedition record that must pass
`validateTeam(..., { requiredKind: "expedition" })` under that cap. Generating
an above-cap opponent and trying to repair it only after capture would violate
the battle/team invariant and make provenance describe a different individual.

`eligibleEncounterPool` now owns the daytime, minimum-level, finite-weight and
positive-total checks. The legal-action builder advertises `explore` only when
that helper returns a pool, and `selectEncounter` samples that exact pool. An
ineligible area remains live: connected travel and voluntary end actions are
still available.

## Advertised-action property

The new property executes only actions returned by
`legalExpeditionActions`, across 2,000 deterministic randomized expeditions. It
first exhaustively probes every advertised action for every area/cap boundary,
then follows random advertised actions to a terminal state. Its matrix covers:

- every one of the eight starting areas;
- cap 1, the maximum cap, and each area's minimum encounter level minus one,
  equal to it and plus one;
- ranked starts, persistent continuations that retain the cap, and persistent
  continuations that lower it;
- random step budgets, encounters, battle/capture/item/shop/travel/end choices;
- zero `CORRUPT_STATE`, reducer input immutability, exact conservation and a
  fresh `validateTeam` rebuild after every accepted action.

Removing only the new legality predicate in an isolated copy made this test
fail on an advertised `explore` returning `CORRUPT_STATE`, proving that it
distinguishes the fix from the old behavior.

## Continuation and validator boundary

The two persistent continuations in the fresh-seed regression now compare each
field of their initial public observations: version, cycle, run, status, area,
destinations, team, backpack, money, remaining steps, next action, encounter,
shop, last transition and result. Only after proving complete initial equality
does the test require later explored encounters to differ. Injecting a
seed-derived starting-money offset in an isolated copy made the comparison fail
with expected 1001 and received 1002.

The README now states the journal validator's exact trust boundary. It checks a
bounded format, action/observation linkage, canonical delta reconstruction and
encoded size; it does not replay or enforce game rules. A regression raises a
monster level in an otherwise schema-consistent observation and proves that the
format validator accepts it. Journal credibility therefore belongs to the
service that publishes accepted transitions, not to the presentation format.

## Terminal and Web regressions

The remaining review gaps are automated at their production boundaries:

- A terminal journal rejects another append without mutating the valid prefix,
  and validation independently rejects a hand-forged post-terminal entry with
  the same diagnostic.
- Real Chrome loads a syntactically malformed JSON source and requires an error
  state, a null observation, disabled play/step controls and
  `executed: false` from the page sentinel.
- The Web builder snapshots the ordinary JavaScript and pak immediately after
  their production build, emits both replay applications, and byte-compares the
  ordinary artifacts afterward. The passing build retained 2,266,358 JavaScript
  bytes and 96,605,376 pak bytes exactly.

The three regressions run in the existing test and Web jobs; no serial workflow
step or new slow-test partition was added.

## Mutation evidence

Five mutations were applied only to isolated copies, observed red, restored and
then removed. None touched the delivery worktree.

| Mutation | Discriminating failure |
| --- | --- |
| Remove the capped-pool legality gate | The 2,000-run property receives `CORRUPT_STATE` from an advertised exploration |
| Add a fresh-seed-derived initial money offset | Initial continuation equality fails: expected 1001, received 1002 |
| Remove the terminal append guard | The exact post-terminal append assertion no longer throws |
| Mark malformed-source script execution true | Chrome reports `executed: true` and the malformed-JSON check fails |
| Append bytes to ordinary JavaScript after replay builds | `bun run web` fails with `web: replay entries changed the ordinary game JavaScript bundle` |

## Functional and CI gates

All source-dependent commands used the pinned Tuxemon source. Generated PSP
segments were refreshed before the journey checks.

- Two imports left the worktree clean. The isolated determinism check reported
  5,077 files, 68,957,895 bytes and aggregate SHA-256
  `981c8c86e87e3664533dbe1e9fe91f2df6f7e323e4b5318dbb7a741aa0a255bc`.
- `bun run build`, the rebuilt WebAssembly host and `bunx tsc --noEmit` all
  exited zero. Localization passed 11/11 and the CJK subset covered all 2,644
  required characters.
- A resource-stable full suite run with one worker and a 10-second per-test
  limit completed 1,497 pass, 6 browser-conditional skip, 0 fail (1,503 tests,
  265,112 expectations). Every conditional body was then executed explicitly
  under browser conditions: 9 pass, 0 fail, leaving no unexecuted test body.
  Earlier default-concurrency attempts hit local five-second timeouts; they
  produced no assertion failure and are not counted as passes.
- The five CI test partitions completed with 55 / 12 / 22 / 735 / 673 pass and
  zero failures. Their browser-conditional cases are covered by the explicit
  9-pass supplement above.
- The focused ARENA-1/3/7 regression set completed 80 pass, 0 fail.
- All 16 journey matrix commands exited zero. The built-bundle replay checked
  242 checkpoints over the unchanged 230,322-frame mainline; chapter generation
  produced 20 chapters; neighbour preview covered 21 states with zero mainline
  rejection. No tape, chapter or terminal-state pin changed.
- `bun run web` and all six real-Chrome verifiers exited zero. Expedition replay
  covered 16 entries and four screenshots, including the malformed-source
  state described above.
- PSP generation produced all eight segment snapshots. Both the CI-equivalent
  `bun run build:psp --skip-assets` and a full `bun run build:psp` exited zero.

## Visual inspection

The four expedition captures were opened and inspected, including the 480x272
capture at 3x and the 960x544 capture. Route connections, capture detail, all
five party members, the empty backpack and terminal text are readable and
unclipped. Their existing semantic colour/pixel checks passed, and the pinned
SHA-256 prefixes remain:

| Capture | SHA-256 prefix |
| --- | --- |
| `expedition.480x272.png` | `1d0123289f2d8a65` |
| `expedition.480x272.3x.png` | `b63ae69372815a7d` |
| `expedition.960x544.png` | `3fb9395cecf2488c` |
| `expedition.960x544.3x.png` | `50be23b3da926bf5` |

## QuickJS check

The legacy cold-start journey named by the shared gate is not present, so it was
not reported as executed. The current maintained G6 QuickJS journey was run
instead with a reused compiled host and a new process for each viewport. The
final complete run exited zero:

| Viewport | Boot | First QuickJS frame | Startup to first paint | Worst sampled total frame | State SHA-256 |
| --- | ---: | ---: | ---: | ---: | --- |
| 480x272 | 243.671 ms | 2.917 ms | 247.112 ms | 31.998 ms | `2ae4650cc8be15cd1f794b9440f79903220bd745f3725af020619490dbd1eba9` |
| 960x544 | 245.681 ms | 2.626 ms | 248.687 ms | 24.920 ms | `2ae4650cc8be15cd1f794b9440f79903220bd745f3725af020619490dbd1eba9` |

The 250 ms cold-start boundary is measurably noisy: the first host-compilation
run measured 256.312 ms at 480x272, and a second run passed that viewport at
245.701 ms but measured 251.629 ms at 960x544. These threshold failures are
recorded rather than relabelled. The independent final run passed both
viewports; all scene-frame maxima in every run remained below the real 50 ms
limit. The expedition reducer is imported by the isolated expedition replay
entry, not by the ordinary journey entry, and the ordinary Web artifacts also
passed the byte-isolation check.

## Repository hygiene

A final fetch found public main at `8abd63ba`; the implementation branch was
three commits ahead and zero behind before this report, so no rebase or merge
was needed. `bun.lock` and both submodule pointers are unchanged.
`git diff --check` is clean. The history is linear, every commit is authored by
`lfkdsk <lfkdsk@gmail.com>`, subjects are conventional English, and there are
no merge commits, co-author lines or AI trailers. A public-source scan found no
machine path, private host, credential, organization-only term or work-tracking
identifier.

subagent 使用：3 个 / F1 语义与根因、F2/F3 续局与文档、F4 测试与 CI 落点 / 并行分析节省了时间，主代理完成集成、变异、门禁与最终判定

PASS
