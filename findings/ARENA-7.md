# ARENA-7: public expedition journals and visual replay

## Result

Pocket Tuxemon now emits a strict, seedless, versioned public journal for
every accepted expedition action and provides an isolated bilingual Web page
which turns that journal into a visual route, event, battle and team replay.
The journal reconstructs every full public observation exactly, while the
ordinary game does not import or load the replay page or its assets.

The public format is `pocket-tuxemon/expedition-journal/v1`. Its interpretation
is pinned: a future incompatible rules or observation change must introduce a
new format version rather than silently changing version 1.

## Journal contract

`battle/expedition-journal.ts` exposes three immutable pure functions:

- `startExpeditionJournal(rulesPublic, initialObservation)` creates the first
  record from the public cycle, step budget, level cap and start area plus the
  initial `observeExpedition` projection;
- `appendExpeditionJournal(journal, action, observationAfter)` appends one
  accepted public action and its resulting observation;
- `validateExpeditionJournal(unknown)` applies the complete exact schema and
  returns the validated journal plus every fully reconstructed observation.

Every entry binds its contiguous step, exact public action and the next public
observation. The action sequence must equal the preceding observation's
`nextAction`, and the resulting observation must advance that sequence by one.
Validation rejects missing and additional keys at every level, unsupported
versions, non-contiguous steps, sequence discontinuities, malformed deltas,
invalid observations and entries after a terminal observation. Recursive
malformed-value fuzzing is bounded and does not throw.

Version 1 stores the initial observation in full, canonical sparse deltas for
ordinary entries, and a full checkpoint every 64 accepted actions. Appending
does not mutate its journal or observations. The validator reconstructs each
frame before validating it, and the 1,000-run randomized test compares every
reconstructed observation byte-for-byte with the corresponding direct
`observeExpedition` result.

The format accepts at most 10,000 actions and at most 67,108,864 UTF-8 bytes,
so even a maximum-budget accepted journal has a hard 64 MiB encoded upper
bound. A representative 10,000-entry fixture occupies 1,893,618 bytes and has
156 full checkpoints. A separate otherwise valid-shape 69,550,289-byte
fixture is rejected specifically with
`$: encoded journal exceeds the 67108864-byte limit`; this ensures the byte
bound is tested independently of the entry bound.

## Privacy and continuation boundary

The journal is a presentation record, not an authoritative save, ownership
proof or authenticity signature. It contains only public rules, accepted
public actions, and fields returned by `observeExpedition`. Exact structural
validation rejects `seed`, RNG state, provenance, conservation ledgers,
future encounters, hidden reserves and every other undeclared field; tests
assert rejection structurally rather than searching serialized text.

Capture and battle transitions now expose bounded public `lastTransition`
receipts. These preserve capture device, shake count and result, and each
resolved battle decision with public actions, events and terminal outcome.
They do not expose the private encounter or battle RNG state. Without these
receipts, a failed capture or intermediate automatic-battle decisions would
disappear between post-action observations.

Publishing a journal cannot determine a persistent continuation's fresh RNG
stream. The continuation regression constructs two authoritative states whose
public journal prefix is identical and which differ only in their fresh
private seed; subsequent exploration produces different encounters. The
previous journal remains identical, demonstrating that future encounters are
derived from the new private seed rather than from journal contents.

## Visual replay

`expedition-replay.tsx` is a separate application entry. It accepts
`?expeditionReplay=<source>` and uses the same bounded source policy as Arena
replay: JSON data URLs and same-origin relative URLs are accepted; an explicit
absolute HTTPS source additionally requires `expeditionReplayExternal=1`.
Credentials, script and non-HTTP schemes, invalid redirects, non-JSON MIME,
oversized input, malformed JSON and invalid journals are rejected. Parsed
values are treated only as data and are not evaluated or inserted as markup.

The page shows all eight Spyder areas and their connections, highlights the
current area, and draws the traversed path. Its event card distinguishes
exploration, encounters, capture device/shakes/result, battle sides and
outcome, per-decision moves and HP changes, shopping, healing, items and move
learning. The party panel renders species art, level, HP, status, inventory,
money and remaining steps. Play/pause, previous/next step, restart, timeline
scrubbing and 1x/2x/4x playback work in English and Simplified Chinese.

Automatic battles expand their public resolved decisions into intermediate
visual frames. The final frame for each journal entry still retains that
entry's exact reconstructed observation, and the terminal-frame test compares
the whole observation rather than selected labels.

The Web build emits `expedition-replay.html`, `expedition-replay.js` and a
dedicated replay pak. Real-Chrome verification loaded a built journal, checked
the source policy and controls, stepped all 16 entries, and matched the exact
terminal money, remaining budget, result, party and observation. It also
exercised both languages, long names, a full party, an empty backpack, defeat
and budget exhaustion without clipping.

The four committed captures were opened at 3x and inspected. Both 480x272 and
960x544 show readable text, route connections, sprite art, event detail and
complete panels. Semantic assertions count 1,208 HP pixels, 261 route pixels,
879 accent pixels and 295 colours. The verifier-pinned SHA-256 prefixes are:

| Capture | SHA-256 prefix |
| --- | --- |
| `expedition.480x272.png` | `1d0123289f2d8a65` |
| `expedition.480x272.3x.png` | `b63ae69372815a7d` |
| `expedition.960x544.png` | `3fb9395cecf2488c` |
| `expedition.960x544.3x.png` | `50be23b3da926bf5` |

## Demo and documentation

`bun run expedition:demo -- --journal-out=<path>` now records every cycle's
journal and writes the selected journal to the requested file while retaining
the existing terminal conservation, team validation and Arena hand-off. CLI
tests verify both embedded cycle journals and byte-identical file output.

The README documents the versioned format, privacy and trust boundary, size
limits, demo output, accepted replay sources, Web URLs and controls. The
feature status table marks public expedition journals and the isolated visual
replay as Done.

## Adversarial coverage and mutations

The journal suite covers exact nested shapes, extra internal fields, action
and observation sequence linkage, terminal rules, immutable appends, checkpoint
boundaries, entry and byte limits, recursive malformed fuzz, 1,000 randomized
reconstructions and seed-independent continuations. The final focused run
reported 10 pass, 0 fail and 6,093 expectations.

Four mutations were made only in an isolated worktree, and each produced the
intended red result before that copy was restored:

| Mutation | Discriminating failure |
| --- | --- |
| allow a top-level `seed` | the exact-extra-field test unexpectedly accepted the journal |
| remove contiguous `entry.step` enforcement | the step-gap test unexpectedly accepted the journal |
| add one to reconstructed delta `money` | the 1,000-run byte-equality reconstruction test failed |
| use the initial observation as the terminal replay frame | the exact-terminal-observation test failed |

The mutation worktree never modified the delivery branch.

## Bundle isolation

The ordinary Web and desktop artifacts are byte-identical between the current
main baseline and this branch:

| Artifact | Baseline | Candidate | SHA-256 |
| --- | ---: | ---: | --- |
| ordinary Web JavaScript | 2,254,636 bytes | 2,254,636 bytes | `8a7bfc5c7b3024d57028818a8abe6d869055656875d00a713cd3f59bfe1fc162` |
| ordinary desktop JavaScript | 2,254,636 bytes | 2,254,636 bytes | `45afbd39edb093b0fcfde25a0e26e309fe9623abbd2bbbb4416928e22eeeb4d9` |
| ordinary desktop pak | 58,611,488 bytes | 58,611,488 bytes | `d22c724383478b0eada700f5d0085116bb5395b2daa7ec2492bc362872fd9c44` |

The on-demand expedition replay JavaScript is 2,264,510 bytes and its pak is
77,730,656 bytes. Neither belongs to the ordinary game entry graph or startup
requests.

## Full gates

Validation used main baseline `3bcba886`. A final fetch found the same remote
baseline and the delivery branch eight commits ahead and zero behind before
this report commit, so no rebase or merge was needed.

- Two clean imports reproduced the committed 5,076-file, 68,793,849-byte
  corpus with aggregate SHA-256
  `620d458f4246ec95dd3916460af648be3ccdbe8de97f424c3755308f873a5c45`.
  The second import left no diff.
- `bunx tsc --noEmit`, the ordinary build and `bun run build:wasm` passed; the
  rebuilt WebAssembly file is 360,011 bytes. Localization passed 11/11 and the
  CJK fallback check covered all 2,643 required characters.
- The five exact CI test partitions passed 54, 12, 22, 729 and 660 tests, with
  zero failures. Their six browser-conditioned bodies were then run explicitly
  under browser conditions: 9 pass, 0 fail and 0 skip, leaving no unexecuted
  test body. The final affected partition reported 729 pass, 0 fail and
  133,391 expectations after the direct byte-limit regression was added.
- Every mainline, journey and verifier command in the workflow passed. J4
  completed 206,935 frames and retained terminal SHA-256
  `faf682412dce51dc620b25f28c7c73049bd96f4bb3ee44a6dbc7394c0bdba665`.
  The checks also covered synchronized goldens, defeat/recovery, input locks,
  all 263 maps, chapter snapshots, both languages, save/resume, preview states
  and built-bundle replay.
- The Web build and all Chrome gates passed. Expedition replay reported
  `WEB EXPEDITION PASS (16 entries, 4 screenshots)`; the existing English,
  Chinese, demo, Arena and audio checks also remained green.
- PSP snapshot generation produced all eight segments. The CI-equivalent
  `bun run build:psp --skip-assets` command exited zero and produced an EBOOT.

The default monolithic test process exceeded the command session's five-minute
ceiling without an observed failure. It was not counted as a pass; instead,
every exact CI partition and every conditional browser body was run separately
to completion as reported above.

## QuickJS cold-start comparison

The strict 250 ms startup check failed on the unmodified main baseline itself
under shared-host load around 27–33: its two retained 480x272 attempts measured
414.032 ms and 406.278 ms. These are real absolute-threshold failures and are
not relabelled as passes.

For a complete paired comparison, the ABBA run raised only the startup abort
to 1,000 ms; the real 50 ms first-frame CPU limit stayed active. Every sample
reached canonical state
`7f5a73f780c13c25e168769241853b9e4b02fd62011704342fc7297b79ad7db8`
and stayed below that frame limit.

| Viewport | Baseline samples (ms) | Candidate samples (ms) | Baseline mean | Candidate mean | Delta |
| --- | --- | --- | ---: | ---: | ---: |
| 480x272 | 412.897, 403.912 | 412.296, 405.680 | 408.405 ms | 408.988 ms | +0.14% |
| 960x544 | 404.201, 401.435 | 409.217, 402.527 | 402.818 ms | 405.872 ms | +0.76% |

Both relative changes are below the 3% regression threshold. More decisively,
the ordinary Web JavaScript, desktop JavaScript and desktop pak are exactly
byte-identical to baseline, so the new on-demand page cannot account for the
baseline's high-load absolute startup failures.

## Repository hygiene

The public diff contains the shared replay-source policy, expedition journal
and public receipts, isolated replay page, tests and goldens, demo and Web
integration, documentation and this report. `bun.lock` and submodule pointers
are unchanged. `git diff --check` is clean. Commits are linear, use
`lfkdsk <lfkdsk@gmail.com>`, have English subjects, contain no co-author or AI
trailers, and add no merge commit. A public-source scan found no machine path,
private host, credential marker, company-only term or work-tracking identifier.

subagent 使用：4 个 / 分别调研远征语义、实现日志、设计回放架构、梳理 Web 与 CI；并行分析节省了时间，主代理完成集成、隔离变异、肉眼验图和全部门禁复跑

PASS
