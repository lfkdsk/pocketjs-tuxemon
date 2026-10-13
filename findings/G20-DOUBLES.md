# G20-DOUBLES: component upgrade and double-battle target weighting

## Result

Pocket RPG Kit is upgraded from
`310934f9b9b3efbb09d108f1de29432335609b31` to
`be938da56905c96410ed9db4cf0345eca10cfc99`. The new pin contains the
K-PERF-4 immutable-battle allocation reduction, the paired cumulative QuickJS
drift guard, and the K-DOCS-1 documentation corrections. PocketJS remains at
`862040bd77edc49b1f815beff63952b6616a14c6`.

The port now imports and validates every field in upstream
`mods/ai_opponent.yaml`, but applies the profile only where upstream leaves it
observable: selecting the fallback target in trainer double battles when no
ordinary `(move, target)` pair is legal. Ordinary legal actions, wild battles,
single battles, Arena and Expedition retain their previous seeded behavior.
All eight authored `start_double_battle` events remain native.

Two real map events are exercised end to end: Tryphaena's Route 5 action event
and Ray/Tru's Dragon's Cave player-touch sequence. Production captures cover
both events in English and Chinese at 480x272 and 960x544. The browser verifier
also triggers Route 5 with a real keyboard event and Dragon's Cave with the
touchscreen virtual controls.

The slow G6 lock test still performs the same complete dynamic sweep once, but
its 338 pages are now exposed as separate assertion tests. No individual Bun
test owns the roughly 30-second scan, so runner scheduling or load can no longer
make one assertion exceed the 60-second per-test deadline.

## Component upgrade and compatibility

The component range consists of 14 commits. Its code changes retain tracked
state metadata on immutable fast paths, reduce battle-frame allocations, and
stabilize the paired QuickJS analysis window; the remaining commits update
tests and public documentation. The game needed no compatibility shim and no
PocketJS change.

This upgrade is schema-neutral. `MAP_SCHEMA_HASH` remains
`a59ec3e0a1ee74fe08fb75dff938e56b01b8b6b66ccfd102cb9dbb2866d23444`,
the compatible-hash chain is preserved, and no map schema file changed across
the component range. The battle target profile is game-owned imported data, not
a save-envelope field. Five real mid-journey saves decoded, resumed and reached
their uninterrupted reference terminals.

## Proven upstream semantics

The conclusion comes from both source control flow and an executable harness
that imports the checked-out upstream Python modules directly.

- `tuxemon/ai/opponent_evaluator.py:41-45` returns a constant score outside a
  trainer double. Lines 49-61 load the owner/default profile and calculate the
  score; lines 63-67 select the first maximum in stable opponent order.
- `tuxemon/ai/opponent_evaluator.py:70-105` is the complete formula: HP ratio,
  armour, dodge, melee, ranged, speed, configured status effects, and a signed
  level difference once the absolute threshold is met.
- `tuxemon/ai/decision_strategy.py:70-78` ignores the evaluator-selected target
  whenever there are ordinary legal actions and no technique profile: it draws
  from the complete `(technique, opponent)` list.
- `tuxemon/ai/decision_strategy.py:80-107` likewise scores complete action
  pairs when a technique profile exists. A target tie is resolved by pair
  order, not by `OpponentEvaluator`.
- Only `tuxemon/ai/decision_strategy.py:183-193` retains the evaluated target:
  an empty legal-action list enters `get_fallback_action`, which returns the
  fallback technique paired with the previously selected target.
- Wild AI calls the same shape at lines 196-215, but its evaluator is constant
  by the trainer-double guard. No weighted wild behavior exists to port.

The executable harness used the shipped default profile and two deliberately
different targets. Its relevant output was:

```text
OPPONENT_SCORE weaker_first total=5.2
OPPONENT_SCORE weighted_best_second total=103.9
EVALUATOR_BEST weighted_best_second
NORMAL_NO_TECH_CONFIG seed=2 chosen=('light', 'weaker_first')
NORMAL_NO_TECH_CONFIG seed=5 chosen=('heavy', 'weaker_first')
NORMAL_WITH_TECH_CONFIG chosen=('heavy', 'weaker_first')
NO_VALID_ACTIONS_FALLBACK chosen=('fallback', 'weighted_best_second')
```

Thus the score is computed on every trainer-double decision, but an ordinary
random or technique-scored action overwrites the target. Only a fallback turn
preserves the weighted maximum. Implementing weights on every ordinary move
would create a player-visible behavior that upstream does not have.

## Imported policy and runtime behavior

The importer reads the root `rules` table, sorts owner and status keys, maps all
nine numeric fields plus the status-effect map, and supplies upstream's
zero/empty defaults for omitted dataclass fields. Database validation requires
a `default` profile, finite weights, a non-negative level threshold, and finite
status scores. Both full and runtime battle databases carry the same table in
English and Chinese builds.

At runtime, AI action selection first constructs the ordinary legal pair list.
If that list is non-empty, the existing seeded random choice is unchanged. If
it is empty, only a trainer double scores the live opposing field, using current
HP over base HP and the imported base stats/status/level terms. A strict
`score > bestScore` update preserves upstream's first-maximum tie behavior.
The selected target is then paired with the existing fallback move.

Focused tests pin the complete imported default profile and cover three
behavioral boundaries:

- a trainer-double fallback selects the higher-scored second target;
- a wild double with identical data keeps the existing first-target fallback;
- an ordinary legal pair keeps the existing seeded action even when it points
  at the lower-scored first target.

## All eight authored double battles

The player side in every row is the current saved party, with its first two
eligible monsters active. The table lists the opponent party authored by the
event. “Action” means the named NPC interaction; “touch” means the player
enters the event rectangle.

| Map / object | Trigger and guard | Opponent | Authored opponent party |
| --- | --- | --- | --- |
| Route 5 / 58 | Action on Cleo; Cleo not already defeated | `spyder_route5_cleo` | Memnomnom Lv25, Memnomnom Lv25 |
| Route 5 / 60 | Action on Marc; Tryphaena not already defeated | `spyder_route5_tryphaena` | Miaownolith Lv29, Criniotherme Lv27 |
| Route 5 / 63 | Touch `(20..21,6)`; Cleo not defeated, player present and conscious | `spyder_route5_cleo` | Memnomnom Lv25, Memnomnom Lv25 |
| Route 5 / 64 | Touch `(17..18,6)`; Tryphaena not defeated, player present and conscious | `spyder_route5_tryphaena` | Miaownolith Lv29, Criniotherme Lv27 |
| Route 5 / 76 | Action on Patra; Cleo not already defeated | `spyder_route5_cleo` | Memnomnom Lv25, Memnomnom Lv25 |
| Route 5 / 77 | Action on Tryphaena; Tryphaena not already defeated | `spyder_route5_tryphaena` | Miaownolith Lv24, Criniotherme Lv22 |
| Dragon's Cave / 98 | Touch `(16,5..6)`; Ray not defeated, player present and conscious | `spyder_dragonscave_ray` | Ghosteeth, Embazook, Arthrobolt, Hydrone; all Lv45 |
| Dragon's Cave / 100 | Touch `(11,3..5)` after `dragonscavebenden2=yes`; Lucille not defeated, player present and conscious | `spyder_dragonscave_lucille` | Coleorus Lv45, Djinnbo Lv45 |

The real-map reducer tests start Route 5 object 77 from `(19,5)` facing left
and advance its imported dialogue into a 2-v-2 field. They walk into Dragon's
Cave object 98 from `(15,5)`, execute the locked Ray/Tru approach and two
dialogue beats, then verify the four-member opponent party and its first two
active slots.

## Visual and input review

Eight committed PNGs cover Route 5 and Dragon's Cave in both languages and
both required resolutions. They are generated from a production session
restored on the real map, then the actual imported event is triggered; no
fixture calls the battle reducer directly. The tests require exact PNG/RGBA
hashes, `fieldSize=2`, complete party provenance, two active slots per side,
localized HUD names/prompts/commands, visible HP fills, nontrivial palettes,
and exact 2x composition at the larger viewport.

All eight images were opened at 3x. Both monsters are visible on each side,
the English and Chinese HUD strings are legible, no name, level, prompt or
command is clipped, and the 960x544 captures are the intended nearest-neighbor
2x presentation rather than a stale 480x272 frame.

The built Web game adds two independent input proofs:

- CDP dispatches a genuine `KeyboardEvent` for Enter. The host records one
  input source with held mask `8192`; after two confirms, Route 5 object 77
  opens Tryphaena's double with Nut/Rockitten against
  Miaownolith/Criniotherme.
- CDP dispatches genuine touch events to virtual RIGHT and CIRCLE. The host
  records one input source with held mask `32`; the Chinese Dragon's Cave
  sequence advances through four confirms and opens Ray's double with the
  authored four-monster party.

The shared browser job also passed the full English journey, Chinese opening,
chapter/autoplay demo, Arena replay, Expedition replay, and imported audio
lifecycle with zero console errors.

## G6 lock-test stability

The implementation materializes the project and runs `verifyProjectLocks`
once at module load. One overview test retains every corpus count and failure
assertion. Each report row then registers its own micro-test, followed by the
existing named cross-event checks. No assertion was removed and the timeout
was not increased.

The before/after measurement was sequential on the same machine and Bun
version:

| Revision | Test shape | Slowest individual test | Whole file |
| --- | --- | ---: | ---: |
| baseline `8abd63ba` | one monolithic test | 30,504.53 ms | 30.60 s |
| delivery branch | 1 overview + 338 pages + 1 cross-event test | 1.02 ms | 30.05 s |

The whole-file work remains essentially the same because the corpus is still
scanned once. The scheduling unit is now far below the 60-second limit even if
machine load doubles the module-load phase. The report remains 338 pages, 343
lock checks, 336 unlocks, two transfers, zero unresolved pages and zero errors.

## Mutation strength

All mutations ran in isolated copies; the delivery worktree was never edited.

| Mutation | Discriminating red result |
| --- | --- |
| Ignore the imported opponent profile in trainer-double fallback | focused runtime test expected target UIDs `[2,2]`, received `[1,1]` |
| Reverse the profile comparison so the lowest score wins | focused runtime test expected target UIDs `[2,2]`, received `[1,1]` |
| Remove one imported page's release command | dynamic report contained one unresolved page; both that page's micro-test and the overview test failed |

The first two mutants independently prove that the table is consumed and that
its direction matters. The third proves that splitting the test did not weaken
the original whole-corpus invariant.

## QuickJS ABBA performance

The real production game ran in baseline-candidate-candidate-baseline order at
both logical resolutions. Baseline is `8abd63ba` with component `310934f9`;
candidate is this branch with component `be938da`. Both sides used identical
benchmark source (`e4887991…`) and PocketJS `862040bd`; every cold process
reached canonical state
`7f5a73f780c13c25e168769241853b9e4b02fd62011704342fc7297b79ad7db8`.

Cold results use five fresh processes per viewport per ABBA slot and report the
average of the two slot medians for startup-to-first-frame. Feature results are
the average of the two A/B legs. Positive is slower; the drift limit is +3%.

| Case | Baseline | Candidate | Delta |
| --- | ---: | ---: | ---: |
| cold startup 480x272 | 253.322 ms | 257.786 ms | +1.76% |
| cold startup 960x544 | 255.621 ms | 255.049 ms | -0.22% |
| battle entry mean 480x272 | 7.7705 ms | 7.8355 ms | +0.84% |
| battle entry mean 960x544 | 7.8000 ms | 7.8460 ms | +0.59% |
| battle steady mean 480x272 | 0.2720 ms | 0.2695 ms | -0.92% |
| battle steady mean 960x544 | 0.2775 ms | 0.2750 ms | -0.90% |

Entry p95 changed by -0.51% / +0.19% at 480x272 / 960x544; steady p95
improved by -1.52% / -10.51%. Every comparative metric is inside the +3%
limit.

The machine was noisy enough that baseline itself exceeded the ordinary
250 ms startup assertion (one recorded baseline was 259.292 ms; the feature
baseline also reached 260.434 ms). Comparative collection therefore used
`G6_STARTUP_MS=1000` symmetrically as an admission ceiling only. It did not
change timing, the 50 ms frame budget, state hashes, or any repository file.

## Determinism, saves and maintained journeys

Two complete imports left no tracked diff. The isolated-root determinism gate
produced 5,077 files / 68,960,334 bytes on both runs with SHA-256
`b1d96ae1e0f435c57792edb426dd6a8778e613eee44135c79b13f999f90b0394`.
The lockfile remained byte-identical at
`8ccfa9937302846daca5f829c3ef706f1cfa7d3e521c2fad9076842f6ab306e2`.

No maintained tape or terminal state changed. The fallback-only branch is not
entered by an authored maintained battle, as predicted by the upstream proof.

| Segment | Frames | Terminal SHA-256 |
| --- | ---: | --- |
| GB6 | 116,107 | `748f84174b32011c4419588650a41d6c57c31c79d3f9e772fcc72b25c3bf9b80` |
| J1 combined | 128,961 | `c0b36ae2112df49774377c30e728d03a929fba771746bf54cb14e684742a8a87` |
| J2 combined | 193,755 | `b40b13672d7fd34db52e7607ebcf600f5740fe54c2b0915c7ff60bdb392b763d` |
| J3 combined | 211,745 | `49307027321e7f51ab1a8c81e48ca615cd70d636c289f4170e63fc408b1774bf` |
| J4 combined | 230,322 | `1977c1b0f3bd1bba2c4e5ad82332599c4fc72f0acd84d9437868976fbfb5c736` |

Beyond the CI mainline checks, GB6 and J1-J4 each passed standalone/segment,
stateful save/rewind, and 60/30/20 Hz alignment. `verify:save` created and
resumed five production saves spanning battles, map changes and a daylight
transition. All suffixes reached the uninterrupted terminal hashes.

Arena and Expedition share the battle core but never enter the imported
double-trainer targeting branch. Their ten focused test files passed 78/78
tests, including 1,000 seeded Arena battles, 1,000 randomized valid expedition
journals, 1,000 randomized expedition state machines, strict replay schemas,
malformed-input fuzz, provenance, shops and CLI replay. Both production Web
replayers and all eight existing Arena/Expedition goldens also passed.

## Gates

- PSP snapshots were refreshed first; eight segment snapshots were generated.
- TypeScript, production build and the rebuilt PocketJS WASM passed.
- Import/typecheck/determinism/l10n/CJK passed; translation checks were 11/11.
- CI test groups passed 55 + 12 + 361 + 740 + 673 tests, zero failures. The
  default environment reported six intentional browser-condition skips; the
  two affected files were rerun with `--conditions=browser` and passed 9/9, so
  no test remained unexecuted.
- Every current journey-matrix command passed, including defeat/recovery,
  dynamic locks, frozen-map scan, 20 chapters, bilingual demo tapes, save
  resume, preview coverage and the 230,322-frame built-bundle replay.
- The Web site built, then all seven browser verifiers passed with zero console
  errors.
- The pinned PSP toolchain bootstrap passed and `build:psp --skip-assets`
  produced the release EBOOT and 76,231,312-byte game pak. Cargo emitted only
  the two pre-existing PSP host warnings.
- Final `origin/main` remained `8abd63ba`; this branch contains that commit and
  has no merge commit. The worktree, nested submodules and lockfile are clean.

Documentation now marks `ai_opponent.yaml` Done and describes its exact
fallback-only observable boundary. English and Chinese coverage reports both
record all eight `start_double_battle` uses as native and explain why ordinary
actions remain unchanged.

subagent 使用：4 / 上游 AI 语义、8 场事件清单、组件差异、G6 慢测与拆分审查 / 是；四条只读调查并行完成，主代理复核结论并串行跑完全部门禁。

PASS
