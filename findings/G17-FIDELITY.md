# G17 fidelity: immediate scripted motion and backdrop stacks

Base game commit: `4520e7f8`  
Pinned RPG Kit commit: `189a6f0dd2c4642fcff6fcecdd02d8e4a5985091`

## Verdict

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

BLOCKED
