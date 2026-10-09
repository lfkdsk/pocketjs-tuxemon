# G8-DOJO: Dojo training and taste change take effect

## Result

All five paid services authored in `spyder_dojo1` now perform the monster
change they advertise:

- Student1 and Student2 return a stage2/stage1 monster to an earlier form;
- Xiang forgets one known technique and restores one eligible moveset
  technique;
- Zhu changes either the cold or warm taste and recalculates stats.

The importer classifies all three `dojo_method` actions and both
`change_taste` actions as Native. The complete action total is now 13,111
Native / 242 Degraded / 0 Placeholder / 264 Dropped out of 13,617: 96.3%
Native and 98.1% executable (`reports/G1-coverage.md`).

The charging and messages agree with the result on every authored path. A
successful service changes one monster, charges once, and shows the matching
English or Chinese result. Too little money uses the map's refusal and changes
nothing. Cancelling each cancellable Dojo menu leaves the monster and net
gold unchanged. An empty party, a stale/missing Xiang target, or a monster
with nothing to re-learn stops before the later charge and success line. A
student target without an imported earlier form takes the map's authored
no-choice refund path. This guarantee is for authored selection/failure paths;
forged resolver-invalid form or technique keys still throw instead of being
silently refunded.

The mainline never purchases a Dojo service, so all mainline terminal hashes
remain unchanged. Six real predecessor save fixtures load and re-save under
the current identity; the three fixtures whose tapes are still current also
continue deterministically.

## Continuation review

The interrupted worktree contained generated reports, an importer patch, a
real-map test patch, and an old report draft.

- The importer patch's intent was retained, then tightened: failed paid
  selections clear the source event's positive variable gates before `exit`,
  so the event can be retried without reaching a charge or success page.
- The real-map tests were retained and expanded to 16 cases. The additions
  cover both students' insufficient-funds paths, Zhu with an empty party,
  Xiang with no/stale or non-learnable targets, localized party prompts,
  nicknames, non-zero training points, poison, injured HP, and precise save
  persistence claims.
- The generated JSON and coverage files were not accepted as opaque output;
  they were regenerated twice from the pinned source and compared before
  committing.
- The draft report was replaced. Its 12-test count, 1,212-test full-suite
  count, HP-deficit wording, broad save-persistence claim, and fallback Bun
  timing no longer described the final branch.

## Revisions

| Repository/content | Revision |
| --- | --- |
| Original pre-Dojo game base | `97dadd0be1f0555766660530c38d4cf0552cf99f` |
| Latest game baseline merged during continuation | `3a9e95b2c8ff0144e1290b2e1d1adcf5e615b499` |
| Game implementation HEAD before this report | `17cb56e219cc2b4b1b7f6ea6400b6e7c8a17e31e` |
| RPG Kit submodule | `b2636795df87ac3d57638da2b1b4c3b79973eee6` |
| PocketJS submodule | `862040bd77edc49b1f815beff63952b6616a14c6` |
| Tuxemon source | `9e6258ff726b786040a267e8bdbbf037b560285e` |

No RPG Kit or PocketJS source change was required. Existing `extChoice`,
`ext`, `if`, `exit`, and runtime text variables carry the behavior, so this
feature adds no schema member. The current generated schema hash remains
`138048a55ff7d728806120306745c007401d62eec7e5ed1a5da39720429da022`.

## The five authored uses

All uses are on the real imported `spyder_dojo1` map. Tests stand adjacent to
and talk to these imported NPCs rather than constructing replacement events.

| Source event | Action | NPC tile | Fee |
| --- | --- | --- | ---: |
| Talk Student1 Yes | `dojo_method dojo_stage,monster` for stage2 | `spyder_dojo_fu_student1` (1,7) | 500 |
| Talk Student2 Yes | `dojo_method dojo_stage,monster` for stage1 | `spyder_dojo_fu_student2` (4,5) | 500 |
| Talk Xiang Potion | `dojo_method potion_xiang,technique` | `spyder_dojo_xiang` (21,2) | 200 |
| Talk Zhu Cold | `change_taste tasteful_zhu,cold,random` | `spyder_dojo_zhu` (16,2) | 50 |
| Talk Zhu Warm | `change_taste tasteful_zhu,warm,random` | `spyder_dojo_zhu` (16,2) | 50 |

## Semantics compared with upstream

### Devolution: `dojo_method <var>,monster`

Upstream evidence is in `tuxemon/event/actions/dojo_method.py:59-137` and
`tuxemon/monster/monster.py:215-225,671-700`.

- Candidates are history entries that evolve into the selected monster:
  basic forms for stage1, and stage1/basic forms for stage2. The imported
  `evolvesFrom` relation matches that scan for all imported monsters; the
  rule test finds 128 offered relations.
- The transform follows `spawn_base(target, level)` →
  `transfer_properties_from(old)` → evolution-method move handling, shared
  with the existing evolution implementation.
- iid, nickname, level, total experience, tastes, IVs, training points,
  moves, status, and supported snapshot identity carry over. The absolute
  current HP is copied and then clamped to the new maximum; HP deficit is not
  preserved.
- The seemingly odd upstream order is intentional: the new form calculates
  its immediate base stats with newly generated IVs and zero training points,
  then copies the old IV/TP objects. The port and tests pin that exact order
  rather than silently recalculating afterwards.
- The returned form is registered as caught and the localized
  `devolution_ended` line is shown.
- The form picker and the students' filtered party picker are cancellable.
  Their cancel/no-form code reaches the map's own no-choice event, which
  restores the 500 fee; net gold is unchanged.

### Technique re-learning: `dojo_method <var>,technique`

Upstream evidence is in `dojo_method.py:82-102,139-182`.

- Eligible techniques are moveset rows at or below the monster's level that
  it does not currently know. Like upstream code, the port does not filter by
  learning method; the fallback Struggle row can therefore appear.
- The first menu records a known move to forget without mutating the monster.
  The second menu is then calculated as if that move were absent, so it can
  be re-selected. Exactly one candidate is learned directly; otherwise a
  localized learn menu opens. The completed move is appended.
- Mutation happens only after a valid learn choice. Cancelling either
  cancellable technique menu, having no selected monster, or having no
  eligible move clears Xiang's event gate and exits. The 200 deduction and
  the map's “restored” success line therefore cannot run after a no-op.
- This is deliberately safer than upstream, which can remove a move before a
  later menu escape and still let the map charge. The visible result line is
  the localized `tuxemon_new_tech` template followed by the map's success
  line only after mutation.

### Taste change: `change_taste <var>,<cold|warm>,<slug|random>`

Upstream evidence is in `tuxemon/event/actions/change_taste.py:48-121` and
`tuxemon/taste.py:110-129`.

- Random taste choice follows source order and rarity weights while excluding
  the current taste and `tasteless`; an explicit taste must exist and have
  the requested type.
- The chosen cold or warm taste is assigned, base stats are recalculated with
  the monster's IVs and training points, and `taste_change_report` names the
  monster, old taste, and new taste in the active language. The snapshot
  invariant clamps current HP if the new maximum is lower; upstream leaves
  that value alone.
- Zhu's party and cold/warm pickers are authored as non-cancellable. With an
  empty party, the importer writes the no-options result, clears the positive
  purchase gate, and exits before both the taste picker and the 50 deduction.
- The selected monster variable is consumed after one report. Upstream checks
  all event guards before running actions, so this map can otherwise reroll
  twice for one payment and even return to the original taste. The port makes
  one payment produce exactly one change.

## Interface and visual verification

All selectors are the standard RPG Kit choice UI, so controller, keyboard,
and the web on-screen pad share the established controls. The first party
prompt is localized (“Choose a monster” / “选择一只精灵”). Party rows use a
nickname when present, otherwise the active catalog's species name; form,
technique, and taste labels are localized too.

`tests/dojo-visual.test.ts` runs eight production-screen tests and captures 16
actual frames: English and Chinese × forget menu, learned result, devolution
menu, and taste result × 480×272 and 960×544. It checks the committed PNG and
RGBA hashes, complete render-tree strings, absence of `???`, CJK charset
coverage, selected-row/menu pixels, the last move row, the final word/glyph
of each result line, and an empty second text row to prove the result did not
wrap or clip.

The 480×272 captures were opened enlarged 3×. The 960×544 captures were
opened and inspected independently as a larger logical viewport, not treated
as a mechanically scaled 480×272 frame. English and Chinese forget menus and
taste results were legible, complete, and correctly placed at both sizes.
The Chinese subset contains 2,482 characters; the PSP build reports the same
count at all six strikes.

## Functional tests and mutation checks

- `tests/dojo-core.test.ts`: six rule tests against the pinned source data,
  including candidate sets, rarity weighting, stats, non-zero training
  points, poison, injured absolute HP, and the upstream pre-transfer stat
  order.
- `tests/dojo-real-map.test.ts`: 16 tests on imported `spyder_dojo1`. They
  cover all five successes, English/Chinese labels and reports, nicknames,
  each cancellable menu, every NPC's insufficient-funds path, Zhu's empty
  party, Xiang's absent/stale and no-learnable targets, the students'
  no-choice/no-form behavior, caught-form registration, and retryability.
- Persistence is asserted precisely where exercised: the cold-taste success,
  technique re-learn success, and stage1 devolution success each export a
  real save code, import it into a fresh session, and restore the changed
  monster. Warm taste and stage2 devolution are asserted directly but do not
  claim their own reload round trip.
- The merged targeted Dojo/import/save suite passed 117 / 117.

Three mutations ran in isolated copies, never in the reviewed worktree:

| Mutation | Discriminating result |
| --- | --- |
| Remove Zhu's empty-party abort | 15 pass / 1 fail |
| Add 7 to transferred HP training points | 20 pass / 2 fail |
| Remove Student1's insufficient-funds event | 15 pass / 1 fail |

These mutants distinguish the three continuation risks: a no-op purchase,
incorrect transferred stats, and the previously untested “charge/success”
path for the stage2 student.

## Saves, identity, and mainline

The feature adds extension calls and generated content but no save-schema
field. The generated project identity is manifest
`99f7b5e0bb0e543eeaa4ff1609e64ca52d378e6ec1cc1aacbcd27c35735cebce`
with schema
`138048a55ff7d728806120306745c007401d62eec7e5ed1a5da39720429da022`.

Six unedited predecessor browser slots are tested:
`main-4019a9b8`, `main-0fc1580c`, `main-a19bc37b`, `main-78493afa`,
`main-97dadd0b`, and `main-bbeef6b4`. Each loads at its recorded map and
position, then re-saves and reloads using only the current identity. Corrupted
manifest/schema combinations are rejected. The still-current tape continues
from `main-78493afa`, `main-97dadd0b`, and `main-bbeef6b4`; the other fixtures
remain exact load/resave witnesses for superseded tapes.

Mainline replay hashes remain:

| Replay | Terminal hash |
| --- | --- |
| gb6 | `f5b2c7ba46c2…` |
| j1 | `eb88bb0e69b3…` |
| j2 | `875333206c23…` |
| j3 | `e35a750132fe…` |
| j4 / chapters | `f8361bb0321d…` |
| failure paths | `b24ac763…`, `c785e53d…` |

The mainline terminal state has no field change because it never enters a
paid Dojo result path.

## Import reproducibility and gates

Two complete imports from Tuxemon `9e6258ff` produced the same working-tree
diff hash, `d16ed37b…`. Final generated hashes include:

| File | SHA-256 |
| --- | --- |
| `data/g6-assets-report.json` | `2e277efbc776841335978d2dbd669e6d3b754be9f7408e027cccabcda32c0c02` |
| `dist/import-report.json` | `864fd4ea1c90199e6bea6e1806258e5deec3907b1da3c5fdaf378c8eded1b78e` |
| `pak.json` | `d0d2a505866c66d71d6fe922a5ae3424d06a86660f6338f6553ea75425af68e5` |
| English coverage | `2f474829e3e3c4e4ef147192da28b6bee8498af311a4d42c9c5ac0b7de139684` |
| Chinese coverage | `f0cf1308e141f1e474c10222edc7fded7d7a685833a972ffc55bb4aff4a7905f` |

Final gates:

| Gate | Result |
| --- | --- |
| `bun run import` twice | byte-stable generated diff |
| `bunx tsc --noEmit` | exit 0 |
| `bun run build:wasm` | exit 0; wasm 360,011 bytes |
| `bun run build` | exit 0 |
| `bun run test` | 1,219 pass / 0 fail, 139 files, 387.48 s |
| final focused Dojo/save/visual check | 39 pass / 0 fail, 4 files |
| `verify:gb6:mainline`, J1–J4 | all pass with the hashes above |
| `verify:gb6:failures` | both failure paths pass |
| `verify:chapters` | 20 chapters / 206,830 frames, byte-identical |
| `verify:save` | all 5 resume points pass |
| `verify:bootworld:replay` | all 233 checkpoints pass |
| zh tape, en demo, golden sync | all pass |
| web build and `verify:web:zh` | pass; 13 / 13 zh web checks |
| English PSP build | pass |
| Chinese PSP build | pass; 74,090,688 B external, 1,276,208 B embedded; 1,137,154 B font archive; 2,482 CJK chars × 6 strikes; `EBOOT.PBP` 6,431,644 B |

The Chinese PSP build emitted only the two existing PocketJS Rust warnings.
`bun.lock` is unchanged.

## QuickJS performance

Both comparisons used the same current benchmark harness in each build,
fresh QuickJS processes, CPU 30 affinity, and an interleaved base/final order.
The comparison base is the pre-Dojo game revision `97dadd0b`. No subagent or
other command from this task ran during the measured windows.

### Cold startup

The old shared journey path from the common specification no longer exists,
so a one-frame startup journey was regenerated. Every one of the 20 runs
ended at canonical state
`0923ec51dcba20bd11ee948e54fe2085e811e3db867400161119bff8e1873bfc`.
Startup-to-first-paint, milliseconds:

| Build | Viewport | Five samples | Median | Delta |
| --- | --- | --- | ---: | ---: |
| base | 480×272 | 227.934, 227.863, 226.667, 231.841, 233.273 | 227.934 | — |
| final | 480×272 | 228.912, 229.555, 228.444, 228.617, 224.585 | 228.617 | +0.30% |
| base | 960×544 | 226.940, 229.265, 227.315, 237.574, 224.204 | 227.315 | — |
| final | 960×544 | 228.937, 228.203, 228.121, 228.309, 219.351 | 228.203 | +0.39% |

The host's global load average was about 11–14, so the conclusion uses paired
interleaved medians rather than absolute wall time. CPU 30 averaged 82.49%
idle before and 91.64% after. Both deltas are below the 3% regression limit.

### Real Dojo scene

A resumable snapshot on imported `spyder_dojo1` at frame 60 drove 6,600 idle
frames per fresh process, with framebuffer sampling every ten frames. There
were five interleaved processes per build at each viewport (132,000 measured
frames total). `IDLEGC_CPU cpu_work_mean`, which uses the QuickJS host's
thread CPU clock:

| Build | Viewport | Five samples (ms/frame) | Median | Delta |
| --- | --- | --- | ---: | ---: |
| base | 480×272 | 0.632, 0.642, 0.650, 0.652, 0.665 | 0.650 | — |
| final | 480×272 | 0.621, 0.627, 0.628, 0.634, 0.641 | 0.628 | −3.38% |
| base | 960×544 | 0.644, 0.647, 0.651, 0.652, 0.653 | 0.651 | — |
| final | 960×544 | 0.616, 0.618, 0.619, 0.626, 0.630 | 0.619 | −4.92% |

All ten base outputs were byte-identical to one another, and all ten final
outputs were byte-identical to one another, across both viewports. Their
cross-build states intentionally differ because the final bundle contains the
new Dojo extension content. No run exceeded 25 ms of CPU work; medians improve
rather than regress. CPU 30 averaged 87.84% idle before and 94.31% after, while
global load fell from roughly 9–12 to 8–11 during the short window.

## Known limitations and deliberate differences

- After Zhu's first taste purchase, choosing “yes” again on the same map
  session currently does nothing and charges nothing. Upstream samples all
  event guards before actions; the reducer evaluates the blocking reset first.
  Matching repeat purchases needs selection-time guard snapshots in the RPG
  Kit and remains marked Partial in `docs/status.md`.
- A monster with two qualifying devolution forms lists the imported
  `evolvesFrom` order, not a separately persisted runtime history order.
- Technique-menu cancellation, one taste reroll per payment, and taste HP
  clamping are intentional safety/invariant deviations documented above.

subagent 使用：3 / Pauli audited tests and isolated mutations; Confucius checked upstream action, transfer, HP, IV/TP, and taste semantics; Ptolemy audited both viewport captures and the status/importer documentation / 是，三路只读核对与隔离变异并行完成，主代理复核后约节省 30–40 分钟
PASS
