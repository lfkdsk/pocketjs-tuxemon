# Remaining seams, per-character journals and storage

## Outcome

The existing outdoor seam mechanism is complete for every topology it can
prove. The final 56 legacy outdoor portals were reviewed one by one and all
retain their authored fade: none can be promoted without inventing geometry,
movement intent, or story behavior. The generic monster state now also covers
per-character Tuxepedia counters, NPC-owned monster boxes, bags and Lockers,
exact live-NPC lookup, and removal from every player-owned monster container.

## Outdoor seam audit

`tools/audit-outdoor-seams.ts` now emits a stable decision for every wholly
legacy portal and fails closed if a future family has no specific assessment.
The final census is:

| Classification | Portals | Decision |
| --- | ---: | --- |
| Portal-only | 5 | Keep fade |
| Cross-layout gap | 19 | Keep fade |
| Rejected physical contact | 4 | Keep fade |
| Story or non-seam | 28 | Keep fade |

Fourteen former gap rows are interior `rivergoto:*` destination dispatchers.
Together with six already-known river destinations, all 20 clear
`rivergoto:nothing` and move from an interior captain choice; they are story
travel, not walkable map edges. The remaining gap families require a rotated
corner, a large overlap/crop, or an overlap-free placement that cannot exist.
The five portal-only and four rejected contacts likewise retain concrete lane
and collision reasons in `reports/outdoor-seam-audit.json`.

There are therefore zero newly promoted seams. The requested 60/30/20 Hz walk
and two-resolution screenshots for each new seam have an empty subject set;
no golden or mainline transition changed. Existing promoted seams remain under
their multi-rate and visual gates.

## Tuxepedia and journal

Pinned upstream behavior:

- every NPC owns and saves its own Tuxepedia manager
  (`tuxemon/entity/npc.py:105-109,269-290,312-330`);
- entries store status, appearance count and caught count, increment on repeat
  registration, and never downgrade caught to seen
  (`tuxemon/tuxepedia/manager.py:24-53,154-179`);
- named actions resolve only an on-map character and stop when it is absent
  (`tuxemon/event/actions/set_tuxepedia.py:40-45`,
  `tuxemon/base_client.py:441-445`);
- `open_journal` always previews the player's entry with `reveal=True` and its
  action source disables cycling (`tuxemon/event/actions/open_journal.py:53-67`,
  `tuxemon/states/journal_info.py:354-385`).

The extension keeps the historical player `seen`/`caught` arrays for old-save
compatibility and adds sparse counter records only after a repeated or changed
registration. NPC journals are independent sparse records. Off-map NPC state
remains saved but cannot be read or changed until the character is placed.

One pinned-upstream inconsistency is explicit: `SeenStatus.unseen` is accepted
by `set_tuxepedia` but that action has no unseen branch and therefore does
nothing (`tuxemon/event/actions/set_tuxepedia.py:47-59`). Upstream removal is a
separate player-only `clear_tuxepedia` action
(`tuxemon/event/actions/clear_tuxepedia.py:32-40`). The project-level generic
contract requested here assigns `set_tuxepedia ...,unseen` the missing
per-owner removal operation; tests pin this deliberate extension.

## PC and kennel boxes

Upstream constructs independent monster/item-box tables, party and bag
handlers for every NPC (`tuxemon/entity/npc.py:121-127`) and saves all four
stores with that NPC (`tuxemon/entity/npc.py:269-292,322-331`). `access_pc`
resolves a live target and passes it through the complete PC UI
(`tuxemon/event/actions/access_pc.py:57-86`,
`tuxemon/states/pc.py:44-73`, `tuxemon/states/pc_kennel.py:47-64,186-205`).
That UI creates both the default Kennel and Locker for its target
(`tuxemon/states/pc.py:58-64`); hidden monster boxes do not appear as storage
targets (`tuxemon/states/pc_kennel.py:252-262,392-439`). Named `add_item`
resolves the live owner and writes its independent bag
(`tuxemon/event/actions/add_item.py:40-77`).

The saved extension now mirrors that ownership with staged NPC monsters and
per-owner ordered monster boxes, bag and item Locker. Opening a named NPC's PC
creates that owner's default Kennel; monster pickup/deposit/move/release and
item quantity moves commit to the named owner. The one real trainer-targeted
`add_item` lowering seeds the same bag (trainer battle item AI remains a
separate degraded behavior). Missing/off-map PC and kennel targets stop before
creating state, while the upstream-raising `add_item` form reports not found;
`kennel` and `has_kennel` query the same live owner. All new fields are
optional, and old active PC scenes default to their historical player owner,
so older extension saves and serialized PC scene states decode unchanged.

## Removing monsters and live NPC lookup

Upstream `get_party_monster` enumerates only the selected live character party
and raises when a named NPC cannot be found
(`tuxemon/event/actions/get_party_monsters.py:27-38`). Its IID resolver scans
only on-map NPC parties (`tuxemon/npc_manager.py:171-180`); off-map repositories
are separate (`tuxemon/npc_manager.py:76-117`).

The generic port now raises the same not-found error for absent named party
queries and excludes saved off-map NPC parties from IID removal. Per the
project requirement, removal additionally searches the player's party, main
Kennel and named boxes before live NPC parties. This player-box search is an
intentional extension beyond the pinned upstream resolver, which does not scan
boxes. A successful deletion also removes the IID-keyed plague metadata that
upstream stores on the deleted monster object. Missing IID variables and
unknown IIDs remain no-ops.

## Validation

### Import, build and tests

- Two isolated `bun run import` passes produced the same 5,076 files,
  68,793,849 bytes and
  `620d458f4246ec95dd3916460af648be3ccdbe8de97f424c3755308f873a5c45`
  aggregate SHA-256. The committed generated tree was unchanged after the
  second pass.
- Regenerated coverage reports record 13,375 Native, 30 Degraded and 212
  Dropped action uses, plus 8,452 Native, 21 Degraded and 190 Dropped
  condition uses. All authored PC, kennel, journal-status and monster-removal
  operations covered here are now native except the deliberately read-only
  `open_journal` presentation lowering.
- `bunx tsc --noEmit`, `bun run build`, `bun run build:wasm`,
  `bun run check:l10n` and `bun run check:cjk` all exited zero.
- The five CI test groups passed: importer 54/0; repository and golden replays
  12/0; locks, battle data and terrain 22/0; rest a-l 676/0; rest m-z 660/0.
  Bun marks six browser-conditioned cases skipped in a non-browser process;
  the complete affected browser set was also run under its required browser
  conditions and passed 9/0/0, so no test remains unexecuted. An additional
  monolithic run ended with 1,424 pass, 0 fail and the same six conditional
  skips.
- Focused real-import/runtime tests cover the full 56-row seam census,
  repeated and removed player/NPC journal entries, independent NPC party,
  box, bag and Locker storage, old sparse saves, saved off-map NPCs, missing
  NPCs, capacity, player named-box removal and IID plague cleanup.

Four mutations were made and run only in isolated copies. Each produced the
expected failure: changing a seam-family decision broke the audit fingerprint;
discarding a repeated journal increment broke the counter assertion; forcing
an NPC PC back to the player broke owner isolation; and omitting named player
boxes from removal left the target IID behind.

### Journeys, saves and packaging

The stateful and 60/30/20 Hz variants of GB6 and J1-J4 all passed without a
tape or checkpoint update. Their terminal hashes are:

| Journey | Terminal state SHA-256 |
| --- | --- |
| GB6 | `d798436d562b725318008097901a65adfec8816db3a7582cca0c583d0f430290` |
| J1 | `1f6030dd501960edf7b217578e721e15392b7d474f4dbe623e7773b641164ad7` |
| J2 | `368b5bf99a8c9ee16fc171d57253b4423c6588a3972d12fbfee5d78dab68a485` |
| J3 | `f09b9a1ed07449addbe411d973e1494bb3537a0b34d58b3f4f01979965edbc17` |
| J4 | `faf682412dce51dc620b25f28c7c73049bd96f4bb3ee44a6dbc7394c0bdba665` |

The remaining journey jobs also passed: golden synchronization, both defeat
paths, 343 input-lock lifecycles, all 263 maps in the freeze scan, 20 chapter
snapshots, Chinese tape equivalence, Chinese and English demo playback, five
save/resume points, preview coverage and the built-bundle replay at all 233
checkpoints. The old-save runtime fixture loaded, opened the historical player
PC, performed new generic operations and serialized again without migration.

`bun run web` and every Chrome CI command passed. The Chinese run checked all
13 checkpoints and 22 screenshots; the journey, demo, Arena and audio runs
reported zero console errors. PSP snapshots were refreshed before the full
`bun run build:psp`, which produced the release package successfully.

The existing seam crossing contact sheets at 480x272 and 960x544, plus the
journal and PC goldens, were opened and inspected at native pixels. Connected
tiles and player positions remain continuous, and the journal/PC text,
selection and counts are legible without clipping. No new seam image exists
because the promotion set is empty.

### QuickJS performance

Both comparisons used the same pinned PocketJS revision and byte-identical
benchmark harness. Each viewport was measured independently on one pinned CPU
in main -> branch -> branch -> main order. Cold start used five fresh QuickJS
processes at each position (ten samples per variant); world-cache used three
fresh stress processes at each position (six samples per variant). The CPU
and its sibling were 93-98% idle immediately before each retained sequence
and before every resumed group. The
cold collection-only assertion was raised so an outlier could not truncate an
interleaved set, but every retained branch sample independently stayed under
the production 250 ms startup ceiling.

| Cold metric (mean) | Viewport | main | branch | Delta |
| --- | --- | ---: | ---: | ---: |
| Boot | 480x272 | 236.298 ms | 241.138 ms | +2.05% |
| Startup to first paint | 480x272 | 239.103 ms | 243.982 ms | +2.04% |
| First-frame core CPU | 480x272 | 2.522 ms | 2.553 ms | +1.21% |
| Boot | 960x544 | 236.267 ms | 241.289 ms | +2.13% |
| Startup to first paint | 960x544 | 239.036 ms | 244.062 ms | +2.10% |
| First-frame core CPU | 960x544 | 2.483 ms | 2.491 ms | +0.30% |

The largest retained branch startup was 247.224 ms at 480x272 and 249.752 ms
at 960x544. QuickJS used/malloc moved from 10.04/12.22 MiB to 10.07/12.25
MiB, with eight additional startup objects. All 40 cold samples produced the
same canonical state hash,
`7f5a73f780c13c25e168769241853b9e4b02fd62011704342fc7297b79ad7db8`.

| World-cache QuickJS CPU | Viewport | main | branch | Delta |
| --- | --- | ---: | ---: | ---: |
| Cross-map mean | 480x272 | 2.600 ms | 2.628 ms | +1.08% |
| Cross-map p95 | 480x272 | 8.493 ms | 8.539 ms | +0.54% |
| Render mean | 480x272 | 2.540 ms | 2.562 ms | +0.86% |
| Render p95 | 480x272 | 12.348 ms | 12.516 ms | +1.36% |
| Direct-control mean | 480x272 | 7.880 ms | 7.942 ms | +0.80% |
| Direct-control p95 | 480x272 | 18.791 ms | 19.048 ms | +1.37% |
| Cross-map mean | 960x544 | 3.018 ms | 3.040 ms | +0.74% |
| Cross-map p95 | 960x544 | 9.707 ms | 9.790 ms | +0.86% |
| Render mean | 960x544 | 3.082 ms | 3.091 ms | +0.30% |
| Render p95 | 960x544 | 13.959 ms | 13.975 ms | +0.12% |
| Direct-control mean | 960x544 | 9.259 ms | 9.264 ms | +0.05% |
| Direct-control p95 | 960x544 | 22.896 ms | 22.924 ms | +0.12% |

Every stress run visited 134 unique maps through 230 route entries and 192
prefetched crossings. Revisit growth was zero nodes and zero textures in every
category. Branch heap growth stabilized at 19,774 bytes for 480x272 and 1,531
bytes for 960x544, both within the 131,072-byte allowance. The largest sampled
branch frame was 46.484 ms at 480x272 and 46.153 ms at 960x544, below both the
50 ms budget and the corresponding main maxima.

Subagent use: 3; one audited pinned upstream semantics, one implemented and tested the seam audit, and one added focused runtime/save tests; the parallel read-only work shortened the investigation and test-authoring phases.

PASS
