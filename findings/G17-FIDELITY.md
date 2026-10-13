# G17 fidelity: immediate scripted motion and backdrop stacks

Base game commit: `4520e7f8`  
Initial RPG Kit commit: `189a6f0dd2c4642fcff6fcecdd02d8e4a5985091`
Final RPG Kit commit: `afbde1c529f3f96ac4551f5f2a19da101f2d3a6c`

The initial BLOCKED verdict below is retained as the diagnosis that motivated
the component fix. The continuation results at the end supersede it and carry
the final verdict.

## Initial verdict (superseded)

The game-side integration is implemented, imported globally, documented, and
recorded, but the branch cannot honestly pass its cold suite. A real imported
NPC route exposes a component-library gap at the intersection of the two
capabilities this work joins: an event-targeted `moveRoute` with
`start:"immediate"` consumes its first movement command with the base pixel
speed even when a preceding `routeSpeed.tilesPerSecond` has already been
latched onto that route. The saved state says 9 tiles/s while the first pixel
is only the ordinary 7.5 tiles/s displacement.

Accepting that pixel in the game test, delaying the route, or dropping the
exact rate would all turn a real upstream behavior into an undocumented
degradation. The task explicitly forbids repairing a component gap in this
worktree, so testing stopped at this independently reproducible blocker. The
component submodule is unchanged.

## Delivered game-side integration

### Immediate facing and movement

The importer now emits synchronous `face` for cardinal `char_face`, and
`start:"immediate"` on character-relative turns, generated talk-facing turns,
and ordinary player/self/arbitrary-NPC `char_move` routes. Spawn, placement,
and transfer-adjacent directions remain folded into their native commands.
The existing Route 3 direction repair, invalid/missing-character handling,
zero-area elimination, and four Surf geometry absorptions remain explicit.

The generated coverage is:

| Source action | Native | Degraded | Dropped |
| --- | ---: | ---: | ---: |
| `char_face` | 2,007 | 5 | 15 |
| `char_move` | 73 | 4 | 0 |

The full report now records 13,369 Native, 35 Degraded, and 213 Dropped action
uses; conditions remain 8,452 Native, 21 Degraded, and 190 Dropped. The
lowerings and the retained exceptions are documented in `docs/importer.md`,
`docs/status.md`, `reports/G1-coverage.md`, and `findings/G11-EVENTS.md`.

### Saved LIFO backdrop stack

All 26 authored `change_bg*` uses are lowered to the component backdrop
commands:

- six closes pop with `variant:null`;
- four character portraits and seven monster portraits use
  `whenModalOpen:"push"`;
- ordinary opens use `push` only for statically proven serialized source
  transitions and retain `ignore` for an unknown future concurrent modal;
- the active image plus hidden predecessors survive transfer, save/load, and
  rewind;
- total depth is capped at eight; a ninth covered push errors atomically.

The start map imports its own YAML and the identically named scenario YAML,
which produces two copies of six blocking start-screen transitions. Allowing
both copies to push made them compete for the one modal slot. The importer now
retains the first copy's IDs/programs for save ancestry but guards that shadow
copy behind an intentionally unset compatibility switch; the later scenario
copy is the sole live modal owner. Focused identity and importer suites passed
6/6 and 54/54 after this correction.

The persistence fixture drives three real imported portrait pushes, transfers
maps, round-trips a save, pops twice, and refolds across rewind. It asserts the
nearest predecessor after each pop and prunes the empty stack. A predecessor
main-slot fixture from the base build loads and continues, while new saves are
stamped with the current manifest/schema identity.

## Recording and save migration

The English GB6/J1/J2/J3/J4 chain, both failure tapes, the short G6 tape,
English demo, Chinese mainline transcription, chapter snapshots, and PSP
segments were regenerated with project tools rather than edited by hand.

| Recording | New end frame | Terminal state SHA-256 |
| --- | ---: | --- |
| G6 short route | 3,629 | `2ae4650cc8be15cd1f794b9440f79903220bd745f3725af020619490dbd1eba9` |
| GB6 | 115,955 | `d798436d562b725318008097901a65adfec8816db3a7582cca0c583d0f430290` |
| J1 cumulative | 128,831 | `1f6030dd501960edf7b217578e721e15392b7d474f4dbe623e7773b641164ad7` |
| J2 cumulative | 180,238 | `368b5bf99a8c9ee16fc171d57253b4423c6588a3972d12fbfee5d78dab68a485` |
| J3 cumulative | 193,340 | `f09b9a1ed07449addbe411d973e1494bb3537a0b34d58b3f4f01979965edbc17` |
| J4/full mainline | 206,935 | `faf682412dce51dc620b25f28c7c73049bd96f4bb3ee44a6dbc7394c0bdba665` |
| First loss | 3,394 | `873c0e9d21dfaf0a730f11ce49f205c258940a0fef723eadcc0aa476c9690072` |
| Later loss | 68,197 | `7155591fac608f95322615ac5b902e7565966e53d9ea297a5f3d964356f475e2` |

The decoded old/new full-mainline terminal summaries differ only in timeline
identity: frame 206,822 became 206,935 and the language-neutral state hash
changed with it. Both end on `spyder_datacenter` at `(7,4)`, facing right, with
67,773 gold, the same 16 item quantities, the same six party members and
levels, and story hash
`076586407513305744e782c68db73004805e1055779abfb44a91bf0ee8d2e1f1`.
Thus the migrated mainline changed input timing and facing observation, not
story progress, party, inventory, or economy.

PSP playback now uses 28 continuous segments and ends at frame 206,935. The
J3 boundary is 193,340, the radio suffix starts at 193,317, and the following
kernel briefing begins at 195,188.

## Visual evidence

The real imported Dollfin portrait scene is rendered at 480x272 and 960x544.
The test checks the authored cyan stripe, Dollfin body color, dialog interior,
and complete PNG bytes. Five portrait pairs were regenerated and inspected at
3x; the portraits remain centered on their striped full-screen backgrounds and
the opaque dialog remains above them. Day/night goldens were also refreshed
after the recording timeline changed.

| Frame | 480x272 SHA-256 | 960x544 SHA-256 |
| --- | --- | --- |
| Budaye | `fc63dc9de070ca7471aba4e2e429e59c622a48dc1328ef81fb05ca8a01837894` | `d10701e7d5a9437598111b563cd363e08489532e82fbac071d5a2b18caea591c` |
| Dollfin | `590b6a7e3228051f842d673d9aadac0f9d5c7c9bfdc8cac5232608ad770e6b5a` | `d195a58364b3ac7ddbe4bdf80cbe16259dd2710673ea15c5745a51fab3d793cd` |
| Grintot | `807d80753e01d224d793cc89363bfd74e7719f90fce90bbc16baa804e325acb7` | `161763806d7e7c30a144459152c4e1dbe504a28e620fafff8f91d1e3951730f8` |
| Ignibus | `cf32230e665c50ae8e85170f18959362af753d18ef647702abb191864830657f` | `7235b07a79a3b95ceebef2970f3cbe7a00891213c9ecdbcee7ad600d8eb0c023` |
| Memnomnom | `d4db9fac5648bac7bcb3cbc30d0209a5039b495d6b4d5ce2ba800a2a4a312f08` | `c21d8de432d1a1a9981ecaf2cad5ed38c842a0b9bc61f9d71f6ae9d24ba6520b` |

Daylight hashes are
`daf8c1b8b3de3b73609c42b993bb42e13862c3c3db63a2342e1582e67a898480`
and
`a33090b86cca8d1672374696c3c8cce123c757c5c4ea0de983bf79474bba2a4e`.

## Mutation strength

Each deliberate regression ran in its own disposable worktree, never in this
implementation checkout:

| Mutation | Focused result |
| --- | --- |
| restore delayed `char_face` application | red: the same-tick facing/route contract fails |
| expose the oldest rather than nearest backdrop predecessor | red: the expected LIFO frame is wrong |
| discard a covered backdrop replacement | red: the later exposed image is missing |
| omit `backdropStack` from the saved screen clone | red: save/restore loses hidden frames |

All mutation worktrees were removed after the runs.

## QuickJS performance

The interleaved order was base B1, candidate C1, candidate C2, base B2. The
candidate two-run means stayed inside the 3% limit: worst walking regression
was +2.16%, worst map-switch regression was +0.89%, and the all-frame metric
did not regress. The strict candidate run (without a startup override) produced:

| Viewport | Startup | Max production CPU | Terminal hash |
| --- | ---: | ---: | --- |
| 480x272 | 241.021 ms | 25.677 ms | `2ae4650cc8be15cd1f794b9440f79903220bd745f3725af020619490dbd1eba9` |
| 960x544 | 231.654 ms | 27.192 ms | `2ae4650cc8be15cd1f794b9440f79903220bd745f3725af020619490dbd1eba9` |

One earlier base attempt narrowly missed the strict 250 ms startup budget at
250.950 ms. A 400 ms override was used only to diagnose environmental jitter,
not as acceptance evidence.

## Cold-gate status before the blocker

| Gate | Result |
| --- | --- |
| two global imports | byte-identical tracked output |
| `bun run build` | pass; `main.pak` 81,094,560 B, raw JS 3,336,227 B, finalized runtime 2,239,314 B |
| `bun run build:wasm` | pass; 360,011 B |
| `bunx tsc --noEmit` | pass |
| import determinism | pass; 5,076 files, 68,792,835 B, SHA-256 `2754867f0f944b6a0aaee0e2c04fa2a958903efe2abc07e5822e74f0a8e814f8` |
| localization | 11/11 checks pass; 2,643 CJK fallback characters covered |
| replay group | 12 pass, 0 fail |
| locks/battle/terrain group | 22 pass, 0 fail |
| rest a-l | 642 pass, 0 fail, 2 browser-conditioned skips |
| rest m-z | 656 pass, 4 fail, 4 browser-conditioned skips |
| migrated golden/PSP focus | 62 pass, 0 fail |

The four `m-z` failures are the exact-rate component blocker below plus three
Chinese UI visual tests that still replay the separate old 3,189-frame smoke
tape. The official smoke/UI regeneration, explicit browser-condition runs,
the remaining journey matrix, Web, and PSP cold builds were deliberately not
repinned after discovering the component defect. Claiming 0-fail/0-skip before
that dependency is corrected would conceal the bug.

## Blocking component defect

Reproduction:

```text
$ TUXEMON_SRC=<pinned source> bun test tests/npc-movement-real-map.test.ts
...
error: npc_christie 9 tiles/s phase 1 x
Expected: 162.4
Received: 162
...
7 pass
1 fail
581 expect() calls
```

The real source event sets Christie to 9 tiles/s, then starts a move. The
importer correctly emits exact `routeSpeed.tilesPerSecond` followed by an
immediate forced route. At route installation, the component consumes that
pending speed into the character route. Its normal character fold derives a
route-speed configuration before interpolation, but the immediate event-route
tail calls `startForcedRouteInPlace` with the base session configuration. The
route therefore records `stepTilesPerSecond:9` and `phase:1` while placing the
first pixel at `160 + 2`, not `160 + 16*9/60`.

Upstream `char_speed.start()` changes the live moverate before
`char_move.start()` calls `set_path_and_start`; that call immediately selects
the first waypoint, whose velocity is derived from the current moverate. The
7.5-tps first pixel is therefore not an upstream-compatible option.

The component fix should add a focused event-target test combining pending
exact route speed with `start:"immediate"`, and pass a configuration derived
from the freshly installed route's speed/tiles-per-second into the immediate
event-route step. Player-target behavior should be covered in the same review.
After the component is fixed and the game submodule is bumped, resume from the
real NPC test, regenerate the separate Chinese smoke tape/UI frames, and run
the uncompleted browser, journey, Web, and PSP gates.

Subagent 使用：3 / 分别核对上游与导入语义、存档和录带迁移、画面与 CI 契约；只读并行核对提前暴露了重复背景所有权和派生契约，节省了时间

## Continuation: component fix and final acceptance

### Dependency upgrade and blocker closure

The RPG Kit pin is now `afbde1c529f3f96ac4551f5f2a19da101f2d3a6c`,
the four-commit K-TUX-2 stack. Its immediate event-route tail derives the
first-step configuration from the newly installed route speed instead of the
base session speed. The focused component suite passed 12/12 tests with 71
assertions. The original real imported Christie reproduction then passed all
8 tests: the first pixel is now the authored 9 tiles/s displacement, so no
game-side tolerance or degradation was added.

Two complete imports were byte-identical and left no tracked diff. The
determinism inventory is 5,076 files, 68,792,835 bytes, SHA-256
`2754867f0f944b6a0aaee0e2c04fa2a958903efe2abc07e5822e74f0a8e814f8`.
The root repository, RPG Kit submodule, and nested PocketJS submodule remained
clean after import, bootstrap, desktop/Web builds, and both PSP builds; no
`bun.lock` changed.

### Chinese smoke tape and Web-density checkpoint

The Chinese smoke tape was re-recorded with the project tool after the
fidelity tape's 129-frame insertion. It now has 3,318 frames rather than
3,189, and its file SHA-256 is
`a36b64771aa4ab172050d378681d7516f0fbd0c9460018086e41125646ade44a`.
Regenerating the Chinese UI manifest and all 18 PNGs produced byte-identical
files. The focused visual suite passed 3/3 tests and 162 assertions; the Web
Chinese run passed all 13 checks, captured 22 screenshots, and reported zero
console errors.

The Paper Town density dialog moved from frame 1,612 to 1,741, exactly the
same +129 offset. A reducer scan found the complete dialog at frames
1,739-1,741; frame 1,741 was selected rather than blessing the blank old
checkpoint. The regenerated 2x PNG has raw SHA-256
`b448c3bc380357286e897536a0e057b4345f0454a1f72af3b77cf0d75d792577`.
The Web verifier ends that checkpoint at `spyder_paper_town@(24,13)`, reports
zero map mismatches and 3,591 native text-density mismatches as expected, and
computes physical-RGBA SHA-256
`f6b59d25f60a9ef21e0efc7b989c9933ee133238156519b118d3a54edc5f96c8`.

Both Chinese battle-status viewports and the English Paper Town density frame
were opened at 3x. The 480x272 and 960x544 Chinese frames are populated,
legible, and unclipped; the English dialog is present, readable, and aligned
over the expected map rather than being a blank self-consistent golden.

### Exact terminal-state comparison

The previous summary's phrase "only timeline identity" was too broad. A new
recursive decode found exactly six differing leaves between the old and new
full-mainline terminal states:

| Leaf | Old | New |
| --- | ---: | ---: |
| `frame` | 206,822 | 206,935 |
| `ext.clock.refTick` | 104,785 | 104,898 |
| `ext.clock.subMinuteTicks` | 385 | 498 |
| `interp.moveControls.player.routeStopped` | `false` | `true` |
| `interp.sw.steps` | 8,073 | 8,071 |
| `sw.steps` | 8,073 | 8,071 |

The old state SHA-256 is
`59645ed2633892775f935cd88d1a00003ff93886896ee939973ba23a9fc0ee2e`;
the new state SHA-256 is
`faf682412dce51dc620b25f28c7c73049bd96f4bb3ee44a6dbc7394c0bdba665`.
Every other leaf matches. Both states end at `spyder_datacenter@(7,4)`, facing
right, with 67,773 gold, the same 16 item quantities, the same six party
members and levels, and story SHA-256
`076586407513305744e782c68db73004805e1055779abfb44a91bf0ee8d2e1f1`.
The differences are therefore the intended timing/movement observation, not
a story, party, inventory, or economy change.

### Cold gates and local CI reproduction

All commands used `TUXEMON_SRC=/var/tmp/tuxemon-src`. The exact local CI job
commands and the additional common gates completed as follows:

| Gate | Result |
| --- | --- |
| `bun run import` twice | pass; identical 5,076-file tree and no diff |
| `bun run build` | pass; desktop pak 81,094,560 B |
| `bun run build:wasm` | pass |
| `bunx tsc --noEmit` | pass, exit 0 |
| determinism / l10n / CJK | pass; 11/11 localization checks and all 2,643 CJK characters covered |
| CI importer shard | 54 pass, 0 fail |
| CI repository/golden shard | 12 pass, 0 fail |
| CI locks/battle/terrain shard | 22 pass, 0 fail |
| CI rest a-l shard | 642 pass, 0 fail; two browser-conditioned cases intentionally skipped in the native realm |
| CI rest m-z shard | 660 pass, 0 fail; four browser-conditioned cases intentionally skipped in the native realm |
| explicit `--conditions=browser` supplement | 9 pass, 0 fail, 0 skip; all six native-realm skips executed |
| journey matrix | all 16 rows pass: GB6, J1-J4, golden sync, both losses, locks, frozen maps, chapters, zh tape/demo, en demo, save, preview coverage, bootworld replay |
| Web CI job | build, English journey, Chinese opening, demo controls, and three-track audio all pass |
| PSP CI job | bootstrap and exact `build:psp --skip-assets` command pass |
| full `bun run build:psp` | pass; 76,080,832 B pak, 2,239,482 B finalized runtime, EBOOT produced |

The five native test shards naturally report six conditional skips because
they are not running in a browser realm. The explicit browser-conditioned run
executes those cases successfully, so the combined gate has zero failures and
zero unexecuted tests rather than hiding the six behind a skip count.

The final journey pins are GB6 115,955, J1 128,831, J2 180,238, J3 193,340,
and J4 206,935. The first-loss path ends at frame 3,394 with SHA-256
`873c0e9d21dfaf0a730f11ce49f205c258940a0fef723eadcc0aa476c9690072`;
the later-loss path ends at frame 68,197 with SHA-256
`7155591fac608f95322615ac5b902e7565966e53d9ea297a5f3d964356f475e2`.

### QuickJS performance rerun

The shipping release QuickJS host was pinned to one CPU with no subagent work
running. An initial CPU-9 window was rejected after `mpstat` showed that CPU
81.61% busy and one candidate leg had 99 frames above 25 ms while its repeat
had only two. The accepted CPU-12 window used B3 -> C3 -> C4 -> B4, full
framebuffer sampling on every frame, and a 5-second startup override only to
retain all interleaved diagnostic samples. The two-run means are:

| Viewport / metric | Base mean | Candidate mean | Delta |
| --- | ---: | ---: | ---: |
| 480x272 walking | 2.696 ms | 2.741 ms | +1.69% |
| 480x272 map switch | 1.238 ms | 1.232 ms | -0.57% |
| 480x272 all frames | 1.554 ms | 1.558 ms | +0.26% |
| 960x544 walking | 2.680 ms | 2.691 ms | +0.39% |
| 960x544 map switch | 1.259 ms | 1.249 ms | -0.79% |
| 960x544 all frames | 1.591 ms | 1.570 ms | -1.35% |

The worst regression is +1.69%, below the 3% limit. Every accepted
interleaved leg completed with the correct terminal hash; base is
`85b0f9da13877c70255b929a1a68edf7c26cb2e1c24e40847e63822d4537fc44`
and candidate is
`2ae4650cc8be15cd1f794b9440f79903220bd745f3725af020619490dbd1eba9`.
No measured production frame exceeded the 50 ms gate.

A separate candidate run without a startup override passed the strict 250 ms
gate at both viewports:

| Viewport | Startup to first paint | Max sampled production frame |
| --- | ---: | ---: |
| 480x272 | 243.033 ms | 26.492 ms |
| 960x544 | 248.251 ms | 34.956 ms |

The common specification's one-frame fixture path no longer exists and its
literal expected hash `a5e82c...` is stale. The equivalent one-frame fixture
produces `7f5a73f780c13c25e168769241853b9e4b02fd62011704342fc7297b79ad7db8`
on both current main and this branch at both viewports. Strict passing samples
were 246.585 ms / 238.353 ms for the candidate and 248.582 ms / 241.197 ms
for main. This is a stale external pin, not a branch state divergence.

Subagent 使用：4 / 分别核对组件修复与上游语义、生成产物和导入确定性、终端状态与录带、CI 与画面门禁；四路只读核对并行完成，提前锁定剩余三项且节省了时间

PASS
