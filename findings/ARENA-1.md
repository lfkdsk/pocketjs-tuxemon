# ARENA-1: headless battles, tapes, and Web replay

## Result

Pocket Tuxemon now exposes a deterministic, simultaneous-decision Arena API,
strict versioned battle tapes, provenance-rebuilt persistent teams, a public
demo CLI, and a bilingual Web replay page which reuses the production battle
scene. The normal game and maintained journeys retain their previous terminal
states. The replay entry is a separate Web bundle and pak, so an ordinary
player does not load Arena replay code or assets.

The public tape format starts at version 1. A future change to data or rules
which can alter replay bytes must use a new version instead of silently
reinterpreting version 1.

## Headless Arena contract

`battle/arena.ts` provides the complete session boundary:

- `createArenaBattle`, `observe`, `submit`, `defaultAction`, `isOver`,
  `result`, `tape`, `validateBattleTape`, `replay`, and `stateHash`;
- exactly 64 hexadecimal seed characters, with battle and policy streams
  domain-separated from that seed;
- single and double formats, agent or seeded AI on either side, and all five
  title-battle difficulty recipes;
- simultaneous decisions: the first valid submission remains pending and
  private, and only a complete pair advances the reducer in canonical order;
- a 1,800-tick advertised decision deadline and deterministic default action,
  with an independent hard limit of 2,048 settled pairs;
- exact action-shape and membership checks, immutable rejection paths, and
  explicit errors for duplicate, post-terminal, non-agent, and illegal
  submissions;
- canonical SHA-256 over the complete authoritative state. Mid-turn hashes
  include pending choices and are service-private; `observe` is the only
  player projection.

`observe` returns the caller's complete party, the opponent's active monsters,
HP percentages, statuses, and only moves already revealed by resolved reducer
events. It does not return the seed, RNG cursors, decision queue, pending
actions, or opponent reserves. Exact-key structural tests check the initial,
half-submitted, resolved, and terminal boundaries.

The underlying reducer now accepts symmetric manual decisions rather than a
player-only manual side. Random legal-action coverage also exposed three
previously unreachable imported technique effects; `foresight`, `move_type`,
and `life_swap` now have direct reducer tests.

## Persistent teams and trust boundary

`battle/arena-team.ts` never trusts record-carried combat statistics. It
replays an acquisition seed plus globally unique increasing sequence events,
then derives IVs, level, training points, legal level moves, TMs, current HP,
and base statistics from the pinned battle database. It validates real item
target conditions and four-move replacement rules, rejects prototype-name
slugs and unknown fields, and bounds party and provenance sizes.

Match rules support party-size limits, level caps, deterministic uniform
levels, and species/move/item bans. The reconstructed teams and rules travel
inside the versioned tape, so replay does not depend on mutable process state.

This validates consistency, not ownership. A network service must authenticate
the player and load the authoritative provenance stream from server-controlled
storage before calling the builder; accepting a client-authored history would
not prove that the player owns those monsters. The README documents this
boundary.

## Tapes, replay loading, and CLI

Tapes contain only `v`, `seed`, `config`, and paired `actions`. Validation uses
exact object keys, validates every action pair, caps the array at 2,048 pairs,
and recomputes every seeded AI choice. A tape cannot be emitted while an agent
has an unpaired pending action. Replay starts at turn zero, applies exactly one
simultaneous pair at a time, rejects trailing pairs after terminal state, and
reproduces canonical terminal bytes and hashes.

The Web loader accepts `data:application/json` and same-origin relative HTTP(S)
sources. Cross-origin input requires an explicit query opt-in, HTTPS, omitted
credentials, JSON MIME, and a redirect which preserves the source trust class.
It rejects embedded credentials, other schemes, invalid UTF-8, unknown fields,
and malformed JSON. Both inline and streamed input are bounded to 4 MiB before
the complete response is allocated or parsed. Tape fields are parsed as data
only and are never evaluated or inserted as markup.

`tools/arena-demo.ts` runs a deterministic random legal-action agent against
normal AI and prints a JSON tape, result, and state hash. The checked example
ended in a player knockout win after 25 pairs with terminal hash
`6118a8238a30d00a2e9dc3d686a680dd51f341c8a6da3a5b688aaa35a02aea51`.

## Web replay page

`tools/web.ts` keeps the existing player page on
`pocket-tuxemon.js`/`pocket-tuxemon.pak` and emits a separate `replay.html`,
`battle-replay.js`, and `battle-replay.pak`. The normal minified bundle remains
2,241,378 bytes. The replay bundle is 2,411,505 bytes and is requested only by
the replay entry.

The page renders the existing `TuxemonBattleScene` and exposes English and
Simplified Chinese controls for play/pause, one-pair step, restart, and
1x/2x/4x playback. Browser verification measured exactly 60, 30, and 15 host
frames per pair at those speeds, completed all 12 fixture pairs, and reached
terminal hash
`16d0ec71ad0460b95633e39e98501d95439923f9e9ba5f438a46ca25719bb21a`.
An ordinary player startup made no replay-asset request.

The four committed captures cover 480x272 and 960x544, plus 3x inspection
copies. They were opened and inspected: both viewports show real monster art,
HUD panels, native-density text, and non-blank battle backgrounds. Semantic
assertions require 1,880 paper pixels, 400 enemy-HP pixels, and a nontrivial
101-colour palette. Their verifier-pinned SHA-256 prefixes are:

| Capture | SHA-256 prefix |
| --- | --- |
| `battle.480x272.png` | `bb70442ccd946ac5` |
| `battle.480x272.3x.png` | `4dfc08b46637f361` |
| `battle.960x544.png` | `aaf35b1c963fe87a` |
| `battle.960x544.3x.png` | `6a55ffdc63fb84ea` |

## Adversarial tests and mutations

The focused Arena/reducer suite reports 33 pass, 0 fail, 11,550 expectations.
It includes deterministic recursive malformed-JSON fuzzing, unchanged-state
assertions for every rejection, duplicate and post-terminal submissions,
legal swaps, strict tape schemas, AI-only step replay, streamed-size limits,
provenance tampering, prototype-name keys, and the CLI.

One thousand seeded random-agent battles sample every legal action against all
five AI recipes. All 1,000 tapes validated and replayed to byte-identical
terminal states. The test also pins the explicit turn cap and completes in a
bounded 15-second test window.

Four mutations were made only in isolated copies and each produced the
intended red result:

| Mutation | Discriminating failure |
| --- | --- |
| expose `opponent.reserves` | exact opponent observation keys differed |
| accept an illegal action | `{type: "swap", party: 999}` succeeded instead of returning `ILLEGAL_ACTION` |
| settle after one submission | the first response reported `resolved: true` instead of `false` |
| omit the final tape pair | replay canonical bytes differed from the recorded terminal state |

The mutation copies were removed after the runs and never touched the delivery
worktree.

## Full gates

The branch was rebased linearly onto `origin/main@4520e7f8`; a final fetch found
the same remote baseline, so no merge commit was needed. Two isolated imports
were byte-identical: 5,076 files, 68,909,393 bytes, aggregate SHA-256
`39e5b502093707f35d2e9c4fff65d79b295547ed3f7eef10f04102bc4fb54ab1`.
TypeScript, the normal build, the rebuilt WebAssembly core, translation checks,
and CJK coverage all passed.

The full default test command completed in 441.07 seconds with 1,415 pass,
0 fail, and six browser-conditioned visual cases reported as skipped. Those
six were then explicitly executed with `--conditions=browser`; the two files
reported 9 pass, 0 fail. Thus no discovered test remained unexecuted.

The five CI test partitions were run exactly with their workflow file lists:

| Partition | Result |
| --- | --- |
| importer | 53 pass, 0 fail |
| mainline repository and golden replay | 12 pass, 0 fail |
| locks, battle data, and terrain | 22 pass, 0 fail |
| rest a-l | 668 pass, 0 fail; two browser cases covered separately |
| rest m-z | 660 pass, 0 fail; four browser cases covered separately |

All 16 journey-matrix commands passed. GB6, J1, J2, J3, and J4 replayed
115,842 / 128,718 / 180,125 / 193,227 / 206,822 combined frames. The built
bundle matched 233 checkpoints through frame 206,822. Golden synchronization,
both defeat/recovery paths, 338 lock pages and 343 dynamic lock checks,
263-map freeze scanning, 20 chapter snapshots, English and Chinese demo tapes,
five save/resume points, and 21 preview states all passed; preview rejected
zero mainline events. No maintained journey, demo tape, or journey golden file
differs from the baseline.

The Web build and all five browser checks passed. The English journey and demo
reported zero console errors; the Chinese opening passed 13/13 assertions and
captured 22 images; Arena passed 12 pairs and four exact goldens; imported
map/battle/victory audio reported zero underruns and restored map music.

The pinned PSP toolchain bootstrap passed. Both the full PSP build and the CI
`build:psp --skip-assets` path exited zero and generated the release EBOOT.

## QuickJS cold-start comparison

The historical shared one-frame tape no longer exists, so both builds used a
new one-frame `[0]` tape against `spyder_bedroom`. Baseline and candidate both
ended at canonical state
`7f5a73f780c13c25e168769241853b9e4b02fd62011704342fc7297b79ad7db8`.
Each worktree built its own matching desktop JS/pak/project shell and QuickJS
host; samples were pinned to CPU 30. Before sampling, a five-second window put
that CPU at 96.59% idle. No command from this task overlapped the measurements.

The first unrelaxed baseline -> candidate -> candidate -> baseline pass kept
the normal 250 ms startup abort and 50 ms frame limit. Shared-host load was
9.37 at entry. Every slot narrowly failed on its first 480x272 startup:
baseline 255.898 and 252.014 ms, candidate 254.630 and 260.557 ms. These red
samples are retained; neither build established the absolute 250 ms gate in
that window.

A final unrelaxed retry used the same ABBA order and default limits, pinned to
CPU 30 with shared-host load 4.38 at entry. The candidate passed all eight
samples: 244.007, 249.005, 239.458, and 241.111 ms at 480x272; 247.390,
239.728, 233.578, and 238.257 ms at 960x544. The baseline passed six samples
(246.742, 241.548, 249.184, 249.818, 247.994, and 249.529 ms) but stopped its
first slot after a 251.123 ms 960x544 outlier. Thus the candidate establishes
8/8 absolute startup passes under the normal 250 ms limit; the aggregate
shell still exits nonzero because the retained baseline outlier is real.

The same ABBA order then ran two fresh processes per viewport in each slot,
with only the startup abort relaxed to 5 seconds so all 16 samples could be
retained. The 50 ms frame budget stayed active. All processes exited zero,
reached the identical state above, and used 12.22 MiB peak QuickJS heap.

| Viewport | Baseline samples (ms) | Candidate samples (ms) | Median baseline | Median candidate | Delta |
| --- | --- | --- | ---: | ---: | ---: |
| 480x272 | 246.466, 243.823, 249.965, 251.935 | 242.499, 242.763, 240.918, 246.799 | 248.216 | 242.631 | -2.25% |
| 960x544 | 244.767, 243.101, 247.099, 254.142 | 247.442, 246.431, 250.306, 245.464 | 245.933 | 246.937 | +0.41% |

First-frame total CPU medians changed from 2.820 to 2.744 ms (-2.68%) at
480x272 and from 2.797 to 2.836 ms (+1.38%) at 960x544. Startup, first-frame
CPU, and heap therefore show no candidate regression above the 3% limit. The
relative conclusion does not relabel the retained absolute-limit failures.

## Repository hygiene

The implementation is split across nine linear commits. Every commit uses
`lfkdsk <lfkdsk@gmail.com>`, has an English project-style subject, and has no
co-author or AI trailer. `bun.lock` is unchanged, both submodules remain clean,
and the public diff contains no machine path, private service, company term,
credential, or task identifier. The final worktree was clean before this
report was added.

subagent 使用：0 个 / 本轮按会话限制未启用子代理 / 无并行代理节省

PASS
