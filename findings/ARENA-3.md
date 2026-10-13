# ARENA-3: deterministic expeditions and verifiable progression

## Result

Pocket Tuxemon now provides a deterministic, server-stepped expedition API
for acquiring and training a team before entering Arena. A run traverses the
connected eight-area Spyder route network, samples the imported encounter
tables, resolves production battles and capture devices, applies real item and
shop rules, and records every acquisition and progression transaction in an
Arena-rebuildable provenance stream.

The authoritative `Expedition` is server-private. Players receive only the
projection from `observeExpedition`, and the next transition must be an exact
member of `legalExpeditionActions` with the advertised sequence. Authenticated
server storage remains the ownership boundary; the internal provenance hash
detects inconsistent records but is deliberately not presented as an
ownership signature.

## Expedition contract and game data

`battle/expedition.ts` exposes the complete pure-function boundary:

- `createExpedition({ seed, rules })` creates a ranked run or a persistent
  continuation from one ended authoritative state;
- `observeExpedition` returns the area, connected destinations, localized
  team and backpack data, money, remaining budget, current encounter, active
  shop and next action sequence;
- `legalExpeditionActions` advertises exact travel, explore, manual/automatic
  battle, capture, flee, item, move-learning, healing, shop and end actions;
- `applyExpeditionAction` accepts one exact advertised value and returns a new
  state without mutating the accepted input;
- `checkExpeditionConservation` performs a total corruption check over an
  exact bounded canonical-JSON state envelope.

The observation never includes the master seed, encounter RNG state or draw
count, future encounter, conservation ledgers, encounter acquisition seed, or
provenance. There is no restore, rewind or replay API. Each accepted action
costs one step and advances its sequence once; old and skipped sequences are
rejected. Before an untrusted action is classified, it is copied through a
small descriptor-only data envelope limited to depth 8, 64 nodes, 16 keys per
object or array, 256 code units per string and 2,048 total string units.
Accessors, hidden fields, symbols, exotic prototypes, cycles and oversized
values are rejected without invoking an accessor.

Exploration uses the imported daytime encounter rows and weights for the
active area. Manual combat advances one Arena decision at a time; automatic
combat submits deterministic default actions until terminal state. Battle
settlement retains production HP and persistent status, uses the complete
damage-contributor divisor, and records each living winner's real experience,
training points, bond gain, level transitions and level-up moves. Capture uses
the shared production capture resolver, including consumable and persistent
devices, refunds, shake count and warm-taste effects. The upstream-broken
`tuxeball_candy` level-writing success effect is intentionally never
advertised.

The generated `pocket-tuxemon/expedition-shops/v1` catalog contains 14 authored
economies, 75 shop rows and 42 distinct goods. Its importer rejects malformed
conditions, prices, stock and duplicate slugs, sorts every result, and is part
of the normal asset generation path. Expeditions use authored buy prices,
finite stock and the local potion price for healing rather than inventing a
parallel economy.

## Provenance and Arena reconstruction

Expedition team records are explicitly classified separately from legacy
Arena records. Their acquisition event binds the generated individual seed,
species, level, area, accepted action step, capture device, result, shakes,
capture-time persistent status and, for newly captured records, the encounter
experience-rate modifier. Every later experience, level, move-learning
and item event has one globally increasing sequence and its accepted action
step. Battle receipts additionally bind the area, opponent species and level,
experience modifier, participant count, opponent acquisition identity and
training points.

`validateTeam` accepts only exact record/event shapes and replays the complete
bounded stream from pinned battle data. It reconstructs generated stats,
experience, level, bond, training points, legal moves and required derived
audit events, then compares every caller-visible claim. Reordering, deleting,
duplicating or editing acquisition, level, move, item or battle data fails.
Cross-team validation also requires one contiguous global sequence, so events
cannot be copied between monsters or assigned twice.

The provenance checksum covers the canonical expedition stream and catches a
stale stream/hash pair. It is an internal consistency mechanism, not a MAC.
The service must authenticate the account, load the full authoritative
expedition from trusted storage, and atomically store only a successful
transition before offering the rebuilt team to Arena.

## Conservation and cycles

Every transition checks base, purchased and consumed item equations; authored
shop and healing receipts; base, earned and spent money; the action prefix and
remaining budget; terminal reason; RNG cursor/draw count; current HP and
persistent status; encounter identity; and provenance root transactions. Wild
expeditions cannot mint money. One action step cannot contain two unrelated
item/capture roots or inconsistent battle rewards, and a consumed item cannot
be reused.

Ranked rules always create the configured fixed initial state and cannot take
a continuation. Persistent rules may continue only an ended persistent state
with no live encounter and a fresh seed. The new run retains the authenticated
team, inventory, money and global sequences, receives a fresh fixed budget and
RNG stream, and may retain or lower—but not raise—the previous level cap.
Voluntary and budget endings also retain current HP/status; a defeated
continuation instead restores the party and clears status. The continued team
is rebuilt under that cap before the new run is accepted.

## Demo and public documentation

`tools/expedition-demo.ts` runs a deterministic random legal policy to an
expedition terminal state, checks conservation and `validateTeam`, selects the
validated expedition team for a normal Arena battle, validates and replays the
battle tape, and prints one JSON recording. `bun run expedition:demo` exposes
the example without adding expedition code to the ordinary game entry. The
README documents the API, action/RNG boundary, cycles, production semantics,
Candy Ball limitation and authenticated-storage requirement. The feature
status table marks server-stepped expeditions Done.

## Adversarial coverage and mutations

The focused contract and adversarial suites cover exact observation keys,
determinism, rejection immutability, stale/out-of-order actions, budget
termination, real capture and battles, persistent continuation, exact record
classes, malformed/cyclic provenance, capture persistence/refunds/status,
independent reward replay, max-level zero-XP rewards, action accessors and
oversized/deep action envelopes. The final focused run reported 30 pass, 0
fail and 439 expectations; the broader expedition, team, CLI and importer run
reported 46 pass, 0 fail and 559 expectations.

The deterministic random corpus runs 1,000 legal expeditions across manual and
automatic battles, catches and all terminal reasons. Every accepted transition
checks conservation, every team rebuilds through `validateTeam`, and every
observation is recursively scanned for private state. Its summary digest is
`12f22dd9410321bc6f97fb7bc4c621d4fe5d7f52580acc7bb18646859f63e3ec`.
A separate 1,000-case malformed/illegal JSON-like action corpus requires no
throw and byte-identical input and returned authoritative states.

Four mutations were made only in isolated copies and each produced the
intended red result:

| Mutation | Discriminating failure |
| --- | --- |
| accept edited expedition provenance with its stale checksum | the changed capture area passed `validateTeam` instead of being rejected |
| expose the seed and next encounter through observation | the exact-key/private-value disclosure test failed |
| decrement an item without recording its consumption | the first item action returned `CORRUPT_STATE` instead of preserving conservation |
| remove budget terminal enforcement | an action remained available or applied after the final step |

The isolated copies were removed after use and never modified the delivery
worktree.

## Full gates

Validation used game baseline `4fcdfb64`, Pocket RPG Kit `afbde1c5` and
PocketJS `862040bd`. A final fetch reported the delivery branch nine commits
ahead and zero behind its baseline before this report commit.

- Two clean imports reproduced the committed 5,076-file, 68,792,835-byte
  corpus with aggregate SHA-256
  `2754867f0f944b6a0aaee0e2c04fa2a958903efe2abc07e5822e74f0a8e814f8`.
  The generated expedition shop catalog independently retained SHA-256
  `a8ba8ef0f1b6cf5fcb5dfff56046803892b9b6cbf1e3cfc0023b41e30be7c3c9`.
- `bun run build`, `bun run build:wasm`, the PSP mainline snapshot generator,
  `bunx tsc --noEmit`, localization checks (11/11) and the complete 2,643-CJK
  fallback coverage check passed.
- The five exact CI test partitions passed 54, 12, 22, 708 and 660 tests:
  1,456 pass, 0 fail and 258,368 expectations in total. Their default runtime
  reported six conditional skips. Every skipped body was then run directly
  under browser conditions: Bag 3/3 (including its two conditional bodies)
  and START 6/6 (including its four conditional bodies). The six feature-mode
  browser tests also passed, leaving zero unexecuted test bodies. A separate
  complete `bun run test` process likewise finished with 1,456 pass, 6
  conditional skips and 0 fail in 473.46 seconds.
- All 16 CI journey commands passed. The frame-zero chain ended at the pinned
  GB6/J1/J2/J3/J4 hashes, with J4 at
  `faf682412dce51dc620b25f28c7c73049bd96f4bb3ee44a6dbc7394c0bdba665`.
  The remaining checks covered 11 synchronized golden checkpoints, both
  defeat/recovery tapes, 343 input locks, all 263 maps with zero permanent
  locks or blocking fibers, 20 chapter snapshots and suffixes, both language
  tapes and demos, five save/resume points, 21 preview states with no mainline
  rejection, and 233 built-bundle replay checkpoints.
- `bun run web` passed, followed by all five Chrome gates: English journey,
  Chinese opening, bilingual demo controls, Arena replay and real audio. The
  browser reported no console errors; Arena reproduced its 12-pair terminal
  hash and all four golden screenshots; the audio gate played three map
  tracks plus battle/victory/restoration with zero underruns. The English
  endpoint, Chinese battle menu, Data Center chapter and 960x544 Arena frame
  were also opened and inspected visually; text, scaling, sprites and map
  composition were intact.
- Both the complete `bun run build:psp` and CI-equivalent
  `bun run build:psp --skip-assets` succeeded. The final release contained a
  5,845,368-byte EBOOT, 67,633,344-byte external asset pak and 5,845,036-byte
  PRX. Their SHA-256 values were respectively `c2d137e3d2446480`,
  `eaecc891bdd3ca52` and `e416a03e854503b0` (prefixes shown).

The first browser-conditioned retry exposed a local dependency-layout problem,
not a source failure: an earlier nested component install made the renderer
resolve a second physical Solid runtime. A clean candidate checkout passed;
removing that duplicate install and rerunning the root frozen install (with an
unchanged lockfile hash) made the delivery worktree pass the same Bag command
3/3. All browser, Web and PSP results above are from that corrected public
workspace dependency layout.

## QuickJS cold-start comparison

The latest main baseline and candidate replayed the same one-frame bedroom
fixture in 40 fresh QuickJS processes, in baseline/candidate/candidate/baseline
order at both 480x272 and 960x544. All 40 runs reached canonical state
`7f5a73f780c13c25e168769241853b9e4b02fd62011704342fc7297b79ad7db8`
and stayed below the 50 ms first-frame CPU gate.

The ordinary 250 ms startup assertion is currently noisy: the first strict
baseline sample itself stopped at 250.416 ms. A complete diagnostic run
therefore relaxed only the startup abort to 1,000 ms while retaining the real
frame limit and every cold-process sample:

| Viewport | Main median | Candidate median | Delta | Main over 250 ms | Candidate over 250 ms |
| --- | ---: | ---: | ---: | ---: | ---: |
| 480x272 | 246.353 ms | 250.030 ms | +1.493% | 3/10 | 5/10 |
| 960x544 | 244.302 ms | 244.193 ms | -0.045% | 1/10 | 2/10 |

The relative startup change is within the required 3% at both raster sizes.
Main used 27,664 QuickJS objects and the candidate 27,665. The ordinary
runtime JavaScript changed from 2,241,658 to 2,242,042 bytes (+384 bytes); the
post-review action-boundary fix remains outside the ordinary game import graph,
and the final build retained the benchmarked candidate bytes. The relative
result does not relabel the retained absolute-limit failures.

## Repository hygiene

The final public diff contains only the expedition implementation, generated
shop catalog, tests, demo, documentation and this report. `bun.lock` is
unchanged. `git diff --check` is clean. Every functional commit uses
`lfkdsk <lfkdsk@gmail.com>`, has an English subject, has no co-author footer,
and the branch contains no merge commit. A public-source scan found no local
filesystem path, private host, credential marker, company-only term or work
tracking identifier. Generated import output remained byte-stable after the
final rebase and the ordinary game terminal states did not change.

subagent 使用：3 个 / 分别复核验收矩阵与 action 边界、做道具守恒变异、做来历校验变异 / 并行静态审查与隔离变异节省了时间

PASS

## Defeat-continuation and capture-rate follow-up

The follow-up was tested at implementation commit `ef908c5f` against current
main `4fcdfb64`. The review's blocking defeated-continuation deadlock is fixed,
and captured monsters now retain the encounter row's experience-rate modifier.

### Defeat recovery

Tuxemon's faint teleport returns the player to the configured faint point and,
when healing is requested, invokes both `set_monster_health` and
`set_monster_status` (`tuxemon/event/actions/teleport_faint.py:60-85`). With no
arguments those operations restore every party member to maximum HP and clear
every status (`set_monster_health.py:47-53`,
`set_monster_status.py:44-59`). That path contains no money or item charge.

The expedition abstraction has areas but no tile-level faint point, so a
defeated persistent continuation now keeps its current area, team, inventory,
money, provenance and global sequence, while restoring every member to full HP
and clearing persistent status. Voluntary and budget continuations still carry
their actual HP and status. This gives the new run a valid non-terminal state
without inventing a location or economic penalty (`battle/expedition.ts:513-566`).

The regression drives a real level-one party through a losing battle, adds a
persistent poison condition at the legal defeated boundary, continues, checks
full recovery and all carried state, then proves both travel and voluntary end
are accepted. It also proves that a wounded voluntary continuation is not
healed (`tests/expedition.test.ts:412-477`). The default CLI now records the
first defeated cycle and deterministically derives a fresh seed for a second
cycle (`tools/expedition-demo.ts:75-104`); its observed result is run 1
`defeated` after 29 actions, followed by an actionable run 2 ending by budget
after 32 actions.

### Captured-monster experience rate

Upstream constructs the wild monster and assigns the selected encounter row's
`exp_req_mod` (`tuxemon/event/actions/random_encounter.py:83-86`). Successful
capture then moves that same monster object into the player's party without
resetting the field (`tuxemon/core/effects/capture.py:76-92`), and subsequent
experience is multiplied by the retained modifier
(`tuxemon/monster/experience.py:150-166`). The imported Spyder encounter used
by the focused test has a 3x modifier.

New caught provenance therefore records the row's exact
`experienceModifier`, validates it against a real species/level/area row, and
reapplies it when reconstructing expedition battles
(`battle/expedition.ts:1100-1129`, `1245-1279`;
`battle/arena-team.ts:206-217`, `560-570`, `780-806`). The focused regression
proves 3x reconstruction, Tea changing experience by 1,500 rather than 500,
the next real battle applying 3x, and a forged 1x row being rejected
(`tests/expedition.test.ts:223-321`). Records written before the additive field
remain valid at their historical 1x rate rather than being silently
reinterpreted from today's encounter table. Ordinary Arena custom teams remain
explicitly 0x, so old replay semantics do not change
(`tests/arena-team.test.ts:74-99`).

### Regression and mutation evidence

The five focused files pass 44 tests with 613 assertions and no failures. The
fixed-seed corpus now consists of 700 ranked runs plus 100 three-run persistent
lineages: 1,000 completed expeditions, exactly 200 continuations, at least one
defeated continuation, conservation and provenance validation after every
step, and digest
`7d26eef5d9fef71152913af225acc5b9c3288c73cca7c4a049886cde184871bf`
(`tests/expedition-random.test.ts:131-218`, `270-282`). The malformed-action
corpus also completes 1,000 cases without throwing or changing authoritative
bytes.

Two mutations were made only in isolated worktrees and then removed:

- Removing defeated recovery produced 3 failures and 10 passes: the focused
  status/recovery assertion, default CLI continuation, and persistent random
  corpus all detected the defect.
- Forcing captured expedition monsters back to 1x produced 3 failures and 39
  passes: the focused rebuild, exact capture snapshot, and random-corpus digest
  all detected the defect.

### Acceptance gates

| Gate | Result |
| --- | --- |
| `bun run build`, `bun run build:wasm`, `bunx tsc --noEmit` | PASS, each exited 0 |
| Two ordinary imports | PASS, no tracked diff after either run |
| Isolated import determinism | PASS, 5,076 files, 68,792,835 bytes, SHA-256 `2754867f0f944b6a0aaee0e2c04fa2a958903efe2abc07e5822e74f0a8e814f8` |
| `check:l10n`, `check:cjk` | PASS, 11/11 catalogs and all 2,643 declared CJK characters covered |
| Five exact CI test shards | PASS, 54 + 12 + 22 + 709 + 660 tests, 0 failures, each command exited 0 |
| Full `bun run test` body | 1,457 pass, 6 browser-conditioned skips, 0 fail, 258,452 assertions across 171 files; the wrapper retained a handle after printing the complete 460.41 s summary |
| Browser-condition supplements | PASS, 9 + 6 tests, 0 fail; all six native conditional bodies executed, leaving zero unexecuted bodies |
| Focused expedition/team/CLI suite | PASS, 44 tests, 613 assertions, 0 fail |
| All 16 CI journey matrix commands | PASS; J4 terminal SHA-256 `faf682412dce51dc620b25f28c7c73049bd96f4bb3ee44a6dbc7394c0bdba665` |
| Web build plus five Chrome gates | PASS, 0 console errors |
| `build:psp --skip-assets` and full `build:psp` | PASS; full package: EBOOT 5,845,400 B, pak 67,633,344 B, PRX 5,845,068 B |

The monolithic test runner's post-summary open handle is not counted as an
exit-code proof; the five CI shards cover the same 171 native test files and
all exited zero, and the browser-conditioned supplements execute every
otherwise skipped body. No maintained journey, golden, or generated import
artifact differs from the reviewed expedition branch.

### QuickJS cold-start comparison

Main and candidate each built their own matching desktop bundle. The harness
source SHA-256 and PocketJS revision were identical, so both measurements used
the same byte-identical compiled QuickJS host. A live one-frame `[0]` fixture
at `spyder_bedroom` reproduced canonical state
`7f5a73f780c13c25e168769241853b9e4b02fd62011704342fc7297b79ad7db8`
on both builds and both viewports. The candidate also passed a direct strict
250 ms preflight at 244.489 ms (480x272) and 241.954 ms (960x544).

The complete comparison used 40 fresh processes pinned to CPU 30 in
main/candidate/candidate/main order, five processes per viewport per slot. CPU
30 was 93.98% idle in the five-second pre-window. To retain every sample, only
the startup abort was raised to 1,000 ms; the real 50 ms frame budget and state
check remained enabled. One main and one candidate 480x272 sample were just
over the ordinary limit (250.246 and 250.168 ms), and are retained rather than
relabeled.

| Viewport | Main startup median | Candidate startup median | Delta | Main first-frame median | Candidate first-frame median | Delta |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 480x272 | 245.488 ms | 244.035 ms | -0.592% | 2.715 ms | 2.642 ms | -2.689% |
| 960x544 | 245.421 ms | 244.685 ms | -0.300% | 2.694 ms | 2.604 ms | -3.359% |

All 40 processes exited zero, reached the same canonical state, and stayed
below the 50 ms production-frame limit. Startup and first-frame CPU therefore
show no regression; the candidate adds one QuickJS object (27,665 versus
27,664). The ordinary app bundle changed from SHA-256 `92147c88...` to
`0ff9071c...`; pak, project shell and map-manifest hashes are identical.

### Final repository state

After refreshing `origin/main`, the tested implementation commit was 12
commits ahead and 0 behind; this report adds one documentation-only commit, so
no rebase is required. `bun.lock` is unchanged, `git diff
--check` is clean, no merge commit is present, and every branch commit has the
required author with an English subject and no co-author footer. The public
diff contains no local path, private host, company-only term, credential marker
or work-tracking identifier.

subagent 使用：3 个 / F1 上游语义、F2 捕获经验兼容、CI 与验收矩阵 / 并行审查节省了时间

PASS
