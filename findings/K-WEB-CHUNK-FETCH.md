# Web pak fetch failure containment

## Result

Transient Web pak failures in advisory work no longer become browser errors.
Both fire-and-forget prefetch and exhaustive background warming retain the
loader's failure statistics, release their failed scheduler job, and can be
retried later. A caller which deliberately awaits `prefetch()` still receives
the rejection, so the world working-set does not incorrectly mark a failed map
as prefetched. Blocking `prepare()` continues to reject and the game still
parks a real map transition behind `#offline-missing`.

The offline-package worker also stops at the top of its download loop when
`OFFLINE_PAUSE` aborts the active controller. It therefore does not keep
inspecting already cached chunks or reach final reconciliation after a pause;
the terminal message remains `OFFLINE_PAUSED`.

The final stressed browser acceptance ran ten consecutive times under eight
CPU-saturating workers. All ten runs passed all 41 checks, including the final
assertion that there was no uncaught page exception or console error.

## Delivery identity and order

Both repositories should publish this work under the branch name
`fix/web-chunk-fetch`.

| Repository | Base | Tested implementation tip before this report | Commits |
| --- | --- | --- | --- |
| Pocket RPG Kit | `e72978932c27a0723cdc15ca60016bf55fa69cfc` | `6896c85e0f5dff992b2fdfd056b3dcd85f15e86f` | `34108985 fix(web): contain advisory chunk fetch failures`; `6896c85e fix(web): preserve observable prefetch failures` |
| Pocket Tuxemon | `e29cdef51ec1603dbd13b693cf2a2a05cd33d723` | `940c2f6d7c7d28d31a5927a9761df97eab0f1ed9` | `7d9b0018 fix(web): stop cached offline work when paused`; `940c2f6d chore: update Pocket RPG Kit chunk loader` |

Merge the component branch first, then update the game submodule pointer while
retaining the game-side Service Worker commit. The game pins component commit
`6896c85e`; both component copies pin PocketJS
`8de08a89cc2a7848b5561a2241fe879511d50f79`. PocketJS itself is unchanged.

Both origins were fetched again after acceptance. `origin/main` was still the
recorded base in each repository, so no delivery rebase was necessary. Both
implementation worktrees were clean, `git diff --check` passed, `bun.lock` was
unchanged, and every commit is authored by `lfkdsk <lfkdsk@gmail.com>`.

## Source-map diagnosis

A minified player was rebuilt with its source map. The generated text starts
`async function g0` at line 1, zero-based column 37,786. Source-map lookup maps
that position to `tools/web/pak-chunks.js:209`, the shared `fetchAsset()`
helper; column 37,950 maps to its network await at line 223. The diagnostic
bundle and map have SHA-256 values
`87d8a8385a9fb801b2822a58d28a08533b5c74ba741c5fccbdaf4df334217b`
and `3a32f27c32e079afeb21afee72266cca962b1d76690f87469152d381c5366010`.

`g0` alone cannot distinguish a scheduler because startup, demand, prefetch and
background work all call that helper. The surrounding control flow does:

1. The working-set driver consumes its `prefetch()` promise with both success
   and rejection handlers in `src/engine/world-prefetch.ts:127-136`.
2. A blocking map acquisition awaits `prepare()` and is intentionally routed
   to the game's offline-missing recovery.
3. The player starts exhaustive warming after its first painted frame in
   `tools/web/player.js:1524-1527`. At the base revision,
   `startBackground()` caught a failed scheduled job and called
   `console.error(error)` at `tools/web/pak-chunks.js:390`.

The acceptance verifier classifies both `Runtime.exceptionThrown` and an error
console call as a browser error. Thus the observed `TypeError: Failed to fetch
at g0` came from exhaustive background warming's `console.error`, not from the
handled working-set prefetch or the blocking recovery path. There was also a
real API hazard for any other caller that intentionally ignored the rejecting
prefetch promise, which the same fix now contains.

## Runtime changes

The shared `load()` contract remains strict: a failed fetch is written to
`failures`, then rejected, and the `pending` entry is removed in `finally`.
Successful retry installs the parsed chunk and deletes its stale failure.

`prefetch()` now creates and returns the original rejecting promise, while a
separate non-rethrowing observer marks an ignored rejection handled. Awaiting
callers therefore still learn about failure; fire-and-forget callers do not
create an unhandled rejection. `startBackground()` uses the same non-throwing
observer and emits no console message. The scheduler still removes every
finished job, so the existing bounded cadence provides retries without an
immediate tight loop.

`prepare()` was not softened. It still awaits the scheduled closure, releases
its blocking markers in `finally`, and rejects to the browser recovery seam on
failure.

In the game Service Worker, the loop-top guard now checks both token identity
and `controller.signal.aborted` before selecting or matching the next cached
chunk. The existing post-worker reconciliation guard remains, and the catch
path still emits `OFFLINE_PAUSED` for an abort.

The component and game feature-status tables now describe these exact
behaviors.

## Deterministic regression coverage

The component fixture drives four independently failing chunks:

- ignored prefetch: failure is recorded with no `unhandledRejection`;
- awaited prefetch: the caller receives the rejection;
- background warm: failure is recorded with no `console.error`;
- demand prepare: the rejection still reaches the caller and clears blocking.

The next request for each advisory chunk succeeds, makes it resident, and
clears the failure map. The test observes both `console.error` and Bun's
`unhandledRejection` event until an extra event-loop turn has elapsed.

The game fixture records every Cache Storage `match()`. It injects all remaining
package chunks into cache at the first progress notification and pauses in the
same synchronous callback. Exactly the calls made before pause remain; there
are no network requests, no later cache inspections, no completion, and the
terminal sequence is `OFFLINE_PROGRESS`, `OFFLINE_PAUSED` with progress `1/5`.

## Mutation sensitivity

Every mutation ran in an isolated task-owned copy and was removed afterward;
the delivery worktrees were never mutated.

| Mutation | Detection |
| --- | --- |
| Restore `console.error(error)` in background warming | Component regression test failed because the captured console list contained the fixture background failure. |
| Re-throw from the ignored-prefetch observer | Component regression test failed because `unhandledRejection` captured the fixture ignored-prefetch failure. |
| Remove successful retry's `failures.delete(id)` | Component regression test failed because retry made chunks resident but left stale failure entries instead of `{}`. |
| Remove the Service Worker `controller.signal.aborted` loop guard | Game regression test failed: expected 5 Cache Storage matches at pause, received 13. |

## Component and consumer gates

All component tests and builds used PocketJS
`8de08a89cc2a7848b5561a2241fe879511d50f79`.

| Gate | Result |
| --- | --- |
| `bun test tests/web-pak-chunks.test.ts` | 8 pass, 0 fail, 0 skip; 59 assertions |
| Chunk tests plus QuickJS guard tests | 19 pass, 0 fail, 0 skip; 91 assertions |
| `bunx tsc --noEmit` | Exit 0 |
| `bun run build:wasm` | Exit 0 |
| `bun run build:example` | Exit 0 |
| Component Web build and Web verifier | Exit 0 |
| `bun run test` | 4,625 pass, 0 fail, 0 skip across 304 files; 731,836 assertions |
| Wander frozen install, Wasm/app/Web builds and typecheck | Exit 0; clean checkout afterward |
| Wander full tests | 523 pass, 0 fail, 0 skip; 501,127 assertions |

The fixed-history QuickJS guard used CPU 16, six counterbalanced windows and
12 paired deltas per case. The per-change and cumulative limits were both 3%.

| Workload | Change-base median | Historical cumulative median | Verdict |
| --- | ---: | ---: | --- |
| `sunstoneIdle` | +0.061% | -1.722% | pass / pass |
| `sunstoneWalk` | +0.242% | -1.964% | pass / pass |
| `sunstoneControlWalk` | +0.012% | -1.225% | pass / pass |
| `streamedRoam` | -0.572% | -1.202% | pass / pass |
| `battleScene` | +0.593% | -1.038% | pass / pass |
| `sunstoneIdleImmutable` | -0.037% | -2.144% | pass / pass |
| `sunstoneControlWalkImmutable` | -0.152% | -1.727% | pass / pass |
| `battleSceneImmutable` | +0.005% | -4.545% | pass / pass |

The guard ended `verdict=pass regressions=0 inconclusive=0 errors=0` for both
the direct base `e7297893` and fixed historical baseline `a4dc4e72`.

## Game gates

The source import was pinned at
`9e6258ff726b786040a267e8bdbbf037b560285e`. TypeScript exited 0. Two isolated
imports matched across 5,077 files / 69,622,876 bytes with SHA-256
`6c262abb4bf2e9fa856d40c3990b74f9e25986d117b3e0bf98af7a551788d7e0`.
Localization passed all 11 checks and the CJK subset covered all 2,645 fallback
characters.

The exact ten CI test groups ran in separate Bun processes after import,
application build and Wasm build:

| CI group | Pass | Fail | Skip |
| --- | ---: | ---: | ---: |
| importer | 55 | 0 | 0 |
| replays | 12 | 0 | 0 |
| locks, battle data and terrain | 361 | 0 | 0 |
| browser UI visuals | 9 | 0 | 0 |
| locale production visuals | 5 | 0 | 0 |
| rest a-d | 398 | 0 | 0 |
| rest e-l | 362 | 0 | 0 |
| rest m-r | 255 | 0 | 0 |
| rest s-t | 365 | 0 | 0 |
| rest u-z | 204 | 0 | 0 |
| **Total** | **2,026** | **0** | **0** |

All 17 journey matrix commands passed:
`verify:gb6:mainline`, `verify:j1:mainline`, `verify:j2:mainline`,
`verify:j3:mainline`, `verify:j4:mainline`, `verify:de:mainline`,
`verify:goldens:sync`, `verify:gb6:failures`, `verify:g6:locks`,
`verify:g6:frozen`, `verify:chapters`, `verify:zh:tape`, `verify:zh:demo`,
`verify:en:demo`, `verify:save`, `verify:preview:coverage`, and
`verify:bootworld:replay`. J4 reached its unchanged terminal state after
230,322 frames; German reached the same language-neutral endpoint. Both battle
failure paths, 343 input-lock checks, the 263-map freeze scan, every chapter,
five save/resume points, preview coverage and built-game replay passed.

The Web job and requested additions all passed individually:

- Link verification in both capability modes, using the supported port
  override because another worktree owned the default port;
- the deployable Web build, browser journey, Chinese opening, demo controls,
  Arena, Expedition, imported doubles and three streamed audio tracks;
- `verify:web:chunks`, with equal reducer state, delayed blocking behavior,
  completed background work, zero failures, zero duplicate requests, and zero
  warm-cache chunk requests;
- `verify:web:lang` and `verify:web:pwa`;
- the additional link, chunk and language commands requested by this review.

The PSP job matched the workflow: PocketJS toolchain bootstrap, warm
`build:psp --skip-assets`, `verify:psp:save`, then a normal traceless
`build:psp --skip-assets`. The emulator was pinned to PPSSPP
`a2f4ce214f224c6c26b3319409ec50205ff8253d`. Manual save/load, legacy raw JSON,
autosave restore and visible read-only failure all passed; the verifier ended
`ALL PHASES PASS`. `verify:psp:save`, `verify:web:link`,
`verify:web:chunks`, and `verify:web:lang` therefore all passed in addition to
every CI job command. Every final gate result reported zero functional
failures and zero skips.

Three reruns were environmental rather than product failures. The first
`rest m-r` launch inherited a shell without the required source-checkout
variable and was stopped, then passed with the same environment as every other
group. The first Link launch found its default loopback port owned by another
worktree; the verifier's supported port override passed without touching that
process. The component suite's first interactive launches were terminated by
the command wrapper's fixed five-minute ceiling before a summary, so the same
suite was run through a foreground-polled persistent log and completed
naturally with the 4,625/0 result above.

## Ten-run stressed PWA acceptance

`stress-ng` was not installed, so a task-owned supervisor launched eight
independent `yes` processes with output directed to `/dev/null`. The processes
were runnable on eight logical CPUs for the complete loop. In that same
supervisor lifecycle, `verify:web:pwa` ran serially ten times against the
already built deployable site:

| Run | Result | Checks |
| ---: | --- | ---: |
| 1 | pass | 41 |
| 2 | pass | 41 |
| 3 | pass | 41 |
| 4 | pass | 41 |
| 5 | pass | 41 |
| 6 | pass | 41 |
| 7 | pass | 41 |
| 8 | pass | 41 |
| 9 | pass | 41 |
| 10 | pass | 41 |

The sequence ran from 11:02:49Z through 11:05:03Z and exited 0. Every run
ended with `acceptance run has no uncaught page exception or console error:
[]`. The final machine-readable report has `ok: true`, 41 checks, no failed
check and `browserErrors: []`. All eight load workers and their supervisor were
confirmed stopped afterward.

The final nine browser images were inspected together at native aspect ratio.
Cold/update/save/package states rendered the game rather than a blank frame;
the three missing-content captures were centered and legible at 480×272,
960×544 and the browser viewport, with disabled Retry and usable Return. The
verifier's semantic border and viewport assertions also passed.

## Scope and compatibility

There is no schema, reducer, save-format, imported-content, replay, visual or
PocketJS change. The runtime change is confined to Web advisory scheduling;
the game change is confined to the PWA Service Worker pause boundary and its
test harness. Blocking map recovery and all native packages retain their
existing contracts.

subagent 使用：3 个 / 分别只读核对 source-map 调用链、Service Worker 暂停竞态和完整门禁矩阵；主代理逐项复核、完成实现与全部重门禁，前期并行定位节省了串行审计时间；本轮收尾未再新增子代理。

PASS
