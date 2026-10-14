# G22-WEB-LOAD: staged Web pak loading

## Result

The ordinary Web player no longer downloads the 97,049,200 B monolithic game
pak before it can paint. A production build now publishes one 6,648,028 B
gzip startup pak and 352 SHA-256-named deferred chunks. The title and New Game
through the first playable bedroom request only that startup content file. The
complete cold page transfers 8,993,951 B at both measured network profiles,
90.93% less than the 99,178,647 B legacy page.

Real Chrome testing at 4x CPU throttling reduced title time from 80,969.8 ms to
9,392.2 ms on 10 Mbps/40 ms and from 498,084.1 ms to 47,052.7 ms on
1.6 Mbps/150 ms. The first playable map followed at 9,544.1 ms and 47,195.0
ms respectively. English and Chinese tapes have identical state and frame
hashes with immediate delivery and with 150 ms added to every content chunk;
network waits occur behind a host veil without advancing a simulation frame.

This is a game plus Pocket RPG Kit change. PocketJS itself, the project schema,
save identity and map identity are unchanged.

## What is in the Web pak

The build report accounts for each source entry's directory row, UTF-8 key,
aligned payload and the small global container overhead. The rows therefore
sum exactly to the source pak, rather than estimating from source files:

| Category | Entries | Bytes |
| --- | ---: | ---: |
| Maps, terrain streams and map TILESETs | 1,530 | 34,190,193 |
| CJK and UI fonts | 7 | 20,617,366 |
| BGM (QOA) | 24 | 22,483,297 |
| Character, NPC and general UI art | 2,318 | 8,018,336 |
| Battle art and lazy battle data | 1,570 | 7,314,093 |
| Localization | 823 | 2,164,715 |
| Demo tapes | 4 | 1,348,410 |
| Other project/world data | 5 | 641,613 |
| Sound effects (WAV) | 3 | 271,142 |
| Container alignment | 0 | 35 |
| **Total** | **6,284** | **97,049,200** |

The source SHA-256 is
`7ba132a5faae32ce4e68053f9d5f411953e16438f8c05ea3e28d434a5aeb32ba`.
The 35,381 B catalog preview is a separate Web file, not a pak entry.

The emitted content layout is:

| Partition | Entries | Compressed bytes | Unpacked bytes |
| --- | ---: | ---: | ---: |
| Startup, including the external directory | 5,310 | 6,648,028 | 42,688,752 |
| 262 map chunks | part of 975 | part of 22,933,518 | part of 54,429,584 |
| 67 placed-map visual chunks | part of 975 | part of 22,933,518 | part of 54,429,584 |
| 23 QOA chunks | part of 975 | part of 22,933,518 | part of 54,429,584 |
| **Deferred total** | **975** | **22,933,518** | **54,429,584** |

The startup directory contains all 6,284 original keys; deferred payload rows
are marked external. Existing synchronous `pakGet` callers therefore keep the
same API once the corresponding chunk is resident. The startup pack contains
`spyder_bedroom` and `music_home.qoa`. It also retains the immediate image and
font registry: those assets compress well, and deferring them would require a
larger change to PocketJS asset registration. The build hard-fails above
10,000,000 B.

## Entries actually read at milestones

`tools/measure-web-pak-reads.ts` serves the real finalized bundle with one
in-memory observation inserted into `pakGet`. It uses a new browser profile,
disables only the exhaustive post-paint background queue, and leaves demand
loading plus the production bounded map working set enabled. This separates
actual entry reads from mere startup-directory residency. Payload bytes below
are unique uncompressed entry bytes; content-network bytes are gzip file
bytes. The complete key, size and call lists are retained in
`reports/web-pak-milestones.json`.

| Milestone | Actual unique entries read | Unique payload bytes | New entries / bytes since prior milestone | Resident content bytes |
| --- | ---: | ---: | ---: | ---: |
| Title interactive | 2,141 | 28,784,083 | 2,141 / 28,784,083 | 6,648,028 |
| New Game, first map interactive | 2,142 | 30,369,891 | 1 / 1,585,808 | 6,648,028 |
| First battle menu interactive | 2,215 | 33,767,170 | 73 / 3,397,279 | 10,399,971 |

The title reads each of its 2,141 entries once. Fonts dominate its unpacked
bytes, while the network still carries only the 6,648,028 B startup file. The
bedroom session is prepared behind the title, so New Game adds exactly one
entry: the 1,585,808 B `music_home.qoa` payload already resident in that file.

The maintained opening tape reaches its first interactive battle menu at tape
frame 2,359 (session frame 2,360). The 73 newly read entries include the maps
and visuals traversed to Paper Town, map music, `music_battle_loop.qoa`, Budaye
and Nut data/art, the battle background, player art and techniques. The exact
keys are in the retained measurement rather than inferred from filenames.
Thirteen deferred chunks plus startup were resident at that point. One
additional bounded working-set request was in flight, so 15 content requests
had started (10,432,055 B) while 10,399,971 B had become readable.

This distinction matters: the startup pak's 5,310 directory entries are not a
claim that all 5,310 were read. Likewise, exhaustive background downloads are
not counted as milestone requirements.

## Design and implementation

### Build-time partition

The game build groups both languages of each map with its terrain, animation
and non-placed TILESET payloads. Large outdoor TILESETs get their own visual
chunks. A map chunk declares every placed-map visual that can enter the camera
within one 480x272 viewport, preventing a network-dependent transparent strip.
Static analysis of map JSON adds referenced QOA chunks as dependencies.

Each compressed file is named with the SHA-256 of its exact gzip bytes. The
manifest records compressed and unpacked size, hash, entries and dependency
closure. The source pak is removed from the ordinary page only after every
chunk, manifest and composition report exists. Rebuilding twice emits the
same files and hashes.

### Browser transport

Pocket RPG Kit's optional `pakManifest` path:

1. fetches the manifest and startup pak in parallel with the core and bundle;
2. validates manifest structure, dependency cycles, compressed size, SHA-256,
   decompressed size and exact pak entry membership;
3. serves resident external entries synchronously to PocketJS;
4. promotes demand and working-set requests ahead of a concurrency-two
   background queue;
5. starts exhaustive background work after a 1,000 ms first-paint grace
   period; and
6. stores verified compressed responses in Cache Storage under their
   content-addressed URLs.

A corrupt cached value is deleted and retried from the network once. Cache
quota/private-mode failures degrade to a validated session-local copy rather
than preventing play. Apps without `pakManifest` retain the legacy core -> pak
-> bundle request order and monolithic behavior.

The map repository exposes an optional transport-only `prefetch` hook. The
existing bounded world working set supplies adjacent map keys without putting
network state into the reducer. Projects without that hook allocate no
transport sets and take no new per-frame path.

### Frame-external waits

A missing required map or boot-snapshot map makes the repository return
not-ready, promotes the exact chunk and dependencies, and makes GameView retry
the same input. The Web host clears accumulated wall time and paints a loading
veil while either the loader or game frame barrier is active. It does not call
the guest frame function, advance PocketJS's frame counter or commit reducer
state. Saves remain available through the host storage bridge during the wait.

Audio is non-state-authoritative: an absent deferred QOA commits the current
simulation frame, prepares asynchronously, and retries playback afterward.
Map BGM dependencies are normally resident before the map switch; battle BGM
uses the same retry path. Battle art itself is already in the compressed
startup registry, so it is present before the first encounter.

## Determinism, persistence and cache behavior

`verify:web:chunks` ran the committed English opening journey and Chinese
smoke journey with immediate responses and with a 150 ms delay on every chunk:

| Tape | Immediate state SHA-256 | Delayed state SHA-256 | Frame result |
| --- | --- | --- | --- |
| English | `2ae4650cc8be15cd1f794b9440f79903220bd745f3725af020619490dbd1eba9` | same | equal |
| Chinese | `8e24291aa037c7c39c5bc5de60bff8f94c560607e5bade6f0f8ca0359fc00779` | same | equal |

The delayed runs observed four blocked English tape frames and three blocked
Chinese tape frames. Two synthetic one-second host-clock jumps at each wait
left host frames, session frames and canonical state unchanged. The loading
veil was visible, storage written/read/restored during the wait, all 352
deferred chunks completed in the background, and there were no failed or
duplicate requests.

The delayed English cold run requested 353 unique content files totaling
29,581,546 B (startup plus all deferred chunks). Reloading the same page from
the same profile requested zero content files even though the test server sent
`Cache-Control: no-store`; the verified Cache Storage entries supplied all
352 deferred chunks. Existing save/resume, tape, rewind and mainline terminal
checks stayed unchanged because transport data never enters serialized game
state.

## Cold Chrome measurement

`bench:web:load` used a fresh Chrome profile for every cell, enabled DevTools
network emulation before navigation, disabled the HTTP cache, and applied 4x
CPU throttling. Milestones require two stable interactive frames and use the
production New Game handler. Transfer totals include HTML, host, Wasm, game
JavaScript, manifest and content, not just pak bytes.

| Network | Build | Title interactive | First map interactive | Bytes at both milestones |
| --- | --- | ---: | ---: | ---: |
| 10 Mbps / 40 ms | Chunked | 9,392.2 ms | 9,544.1 ms | 8,993,951 |
| 10 Mbps / 40 ms | Monolithic | 80,969.8 ms | 81,109.6 ms | 99,178,647 |
| 1.6 Mbps / 150 ms | Chunked | 47,052.7 ms | 47,195.0 ms | 8,993,951 |
| 1.6 Mbps / 150 ms | Monolithic | 498,084.1 ms | 498,293.2 ms | 99,178,647 |

The title speedups are 8.621x and 10.586x; first-map speedups are 8.498x and
10.558x. All four cells had zero failed requests and zero console errors. The
title and first-map request snapshots contain exactly one content file, the
6,648,028 B startup chunk.

The 1.6 Mbps legacy cell takes more than eight minutes. It comes from the
complete retained slow-profile run; the final all-cell wrapper was stopped by
its five-minute command limit while repeating that unchanged baseline. The
chunked cells and 10 Mbps legacy cell were freshly repeated after the final
rebase. `reports/web-load-benchmark.json` contains the assembled four-cell
record, and `reports/web-load-benchmark-slow-baseline.json` preserves the
complete slow baseline source.

## Compatibility and native targets

The ordinary player uses the manifest. Battle and expedition replay pages
deliberately keep standalone monolithic paks, and their real Chrome verifiers
passed in English and Chinese. The ordinary page requested no replay assets;
arena playback reached its 12-pair terminal hash and expedition playback
reached all 16 observations. Keyboard and touch double-battle entry, Web audio
and the existing replay/visual goldens also passed.

| Output | Final bytes | Baseline / result |
| --- | ---: | --- |
| Web game JavaScript | 1,390,688 | production chunked page |
| Desktop JavaScript | 1,390,692 | unchanged |
| Desktop startup pak | 37,855,968 | unchanged |
| Desktop sidecar | 2,975 files / 43,643,354 | unchanged |
| PSP JavaScript | 1,390,095 | unchanged |
| PSP external `assets.pak` | 68,148,752 | unchanged |
| PSP embedded pak | 1,175,664 | unchanged |
| PSP PRX | 4,993,848 | 5,027,728 baseline; 33,880 B smaller |
| PSP EBOOT.PBP | 4,994,180 | 5,028,060 baseline; 33,880 B smaller |

Full desktop, PSP and PSP `--skip-assets` builds passed. No native target reads
the Web manifest or creates browser transport state.

## Performance

The component QuickJS ABBA/BAAB guard ran six alternating rounds and twelve
pairs per case. All medians and 95% intervals stayed below the +3% limit:

| Case | Median change | 95% interval |
| --- | ---: | ---: |
| sunstoneIdle | +0.251191% | -0.499019% to +0.404943% |
| sunstoneWalk | +0.327640% | +0.226568% to +0.549876% |
| sunstoneControlWalk | -0.070845% | -0.328225% to +0.468601% |
| streamedRoam | +0.377575% | -0.630992% to +0.770904% |
| battleScene | -0.022756% | -0.324651% to +0.147613% |
| sunstoneIdleImmutable | +0.120026% | -0.082527% to +0.297273% |
| sunstoneControlWalkImmutable | -0.218055% | -0.754873% to +0.318532% |
| battleSceneImmutable | -0.518428% | -0.971007% to -0.093231% |

The game Cotton Town QuickJS gate ran three fresh processes at both viewports.
Worst QuickJS-plus-core frames were 23.043 ms at 480x272 and 29.326 ms at
960x544, below the stricter 45 ms limit.

## Mutation sensitivity

All mutations ran in isolated copies:

| Mutation | Gate and observed failure |
| --- | --- |
| Remove `spyder_bedroom` from the startup set | `bun test tests/web-chunks.test.ts`: 0 pass, 1 fail; expected 5 chunks, received 6 |
| Remove the browser map source's `prefetch` hook | `bun test tests/web-pak-runtime.test.ts`: 2 pass, 1 fail; `source.prefetch is not a function` |
| Remove the game/host frame barrier | `bun run verify:web:chunks`: exit 1; delayed journey ended at `spyder_paper_scoop,4,8` instead of `spyder_route1,14,19` |

The first fault proves a title/first-map requirement cannot silently move to a
delayed chunk. The second proves the bounded working-set connection is
required. The third proves that if a demand miss is allowed to cross the
simulation boundary, the real deterministic tape fails rather than merely
showing a longer wall-clock time.

## Verification

- Two isolated imports produced 5,077 files and 68,960,530 B with SHA-256
  `3c5a935486adb7a545c3bb2e8a0ef99cdaa15bd6d395f5bbe4b2cbdf1cd051ff`.
- Pocket RPG Kit: Wasm build, example build, typecheck and 4,588 tests across
  299 files passed with zero failures.
- Game: Wasm build, normal build, typecheck, localization and CJK coverage
  passed. The five CI test groups passed 55 + 12 + 361 + 747 + 689 tests with
  zero failures. Their six environment-conditional browser assertions were
  then run with browser conditions: 9 passed, zero failed, leaving no required
  assertion unexecuted.
- Every CI journey matrix entry passed: GB6, J1, J2, J3, J4, golden sync,
  defeat/recovery, locks, frozen-map scan, chapters, English/Chinese tapes and
  demos, save/resume, preview coverage and built-game replay. Mainline terminal
  states did not change.
- The Web build, English journey, Chinese opening, demo controls, arena,
  expedition, keyboard/touch doubles, three-track audio lifecycle and chunk
  verifier all passed.
- Full PSP and desktop builds passed. `bench:cotton:quickjs` and the component
  unused-feature QuickJS comparison passed.
- `bun.lock` is unchanged. There are no merge commits.
- Final screenshots for the title, Paper Town dialog and Chinese battle menu
  were opened at original resolution. Map tiles, dialog glyphs, battle art and
  controls were present with no black strips or loading artifacts; semantic
  pixel and golden checks also passed.

## Delivery

- Pocket RPG Kit delivery commit: `dc1eec76` (implementation starts at
  `07c8f221`).
- Game implementation and measurement tip before this report: `1a8e780b`.
- PocketJS: no commit required.
- Required integration order: merge Pocket RPG Kit first, then merge the game
  delivery so its submodule pointer resolves. No schema migration or generated
  import refresh is required.

Subagent usage: 0 / the continuation, evidence consolidation and final gates were performed serially by the primary agent / no parallel time saving.

PASS
