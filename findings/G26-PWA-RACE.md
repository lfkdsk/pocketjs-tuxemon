# Offline package resume accounting race

## Result

The offline-package resume race is fixed. A chunk that appears in Cache
Storage after the initial scan but before its download-loop turn is now
verified and added to progress exactly once. The worker reconstructs the
verified URL set from Cache Storage before completion and sends
`OFFLINE_ERROR`, not `OFFLINE_COMPLETE`, if any required chunk is missing or
invalid.

The reported CI interleaving is a sufficient and strongly matching root cause:
the old implementation scanned a numeric total, later verified an intervening
cache hit and immediately continued without incrementing that total, then sent
completion unconditionally. Up to three sibling writes can outlive the first
failure of a four-worker `Promise.all`, which matches the observed `544/547`.
The historical CI run has no event-level cache trace, so this establishes the
bug and its deterministic reproduction rather than a forensic proof that no
other timing contributed.

## Implementation

- Download startup scans validate cached responses before inserting their
  canonical URLs into an internal `Set`. Duplicate package URLs are rejected.
- Both a verified cache hit and a newly fetched, stored, and re-read response
  go through the same idempotent mark operation. `completed` and `bytes` change
  only on the first insertion of a URL.
- If an initially counted URL disappears or becomes invalid before its loop
  turn, it is removed from the set before replacement.
- After all download workers settle successfully, the worker re-reads and verifies
  every required chunk into a fresh set. Completion requires no missing or
  invalid chunks and `completed === total`; otherwise the error includes the
  missing filenames and the reconciled progress.
- Newly marked chunks cannot emit progress after their operation is superseded
  or aborted, and a final token check prevents late completion.
  `OFFLINE_STATUS` retains its prior advisory presence snapshot instead of
  paying the download-only validation cost.

The public `OFFLINE_PROGRESS`, `OFFLINE_COMPLETE`, `OFFLINE_PAUSED`,
`OFFLINE_ERROR`, and `OFFLINE_STATUS` fields are unchanged. The browser
verifier's strict `completed === total` assertion was not relaxed.

## Deterministic regression tests

`tests/web-pwa.test.ts` executes the generated worker with in-memory Cache
Storage and network implementations. Two new tests control the race at the
worker's synchronous message boundary:

1. The first test writes a valid English locale chunk immediately after the
   initial `1/5` progress notification. The loop must reuse it without a
   network request and still publish a final `5/5` progress and completion.
2. The second test evicts a previously verified chunk after the last progress
   notification but before completion. The worker must finish at `4/5` with
   `OFFLINE_ERROR` and no completion message.

Before the fix, the focused file produced 8 passes and the two new failures:
the first stopped at `completed: 4, total: 5`, and the second observed an
`OFFLINE_COMPLETE` despite the missing cache entry. After the fix it reports
10 passes, 0 failures, and 123 assertions.

## Mutation sensitivity

Each mutation ran in its own disposable worktree and was removed afterward.
The delivery worktree was never mutated.

| Mutation | Targeted command | Result |
| --- | --- | --- |
| Remove the mark operation for a verified late cache hit | `bun test tests/web-pwa.test.ts -t "counts a chunk cached after the initial scan exactly once"` | Exit 1: last progress remained `4/5`; 0 pass, 1 fail |
| Remove the incomplete-package guard before completion | `bun test tests/web-pwa.test.ts -t "reports an error instead of completion when a verified chunk disappears"` | Exit 1: the test observed `OFFLINE_COMPLETE`; 0 pass, 1 fail |

## Directed gates

Only the checks requested for this Web race were run; the full game suite and
all performance benchmarks were deliberately left to integration.

| Check | Result |
| --- | --- |
| `bun test tests/web-pwa.test.ts` | 10 pass, 0 fail, 123 assertions |
| `bunx tsc --noEmit` after generated assets were built | Exit 0, no diagnostics |
| `bun run build` | Exit 0; runtime bundle 2,954,655 -> 1,441,969 bytes |
| `bun run build:wasm` | Exit 0; Web Wasm 430,518 bytes |
| `bun run web` | Exit 0; release `ad0c86fe266d9d53e557fac4944f2f66220d29023cd4448dbae8356f14b518bc` |
| `bun run verify:web:pwa` five consecutive times | 5/5 passed; 41 checks per run; each English resume completed 547/547 files and 28,980,696/28,980,696 bytes |
| `bun run verify:web:chunks` | 11 assertions passed; `WEB CHUNKS PASS` |
| `bun run verify:web:lang` | `WEB LANG PASS` |

The initial type-check attempt in the fresh worktree preceded asset generation
and therefore reported only missing generated JSON modules. The prescribed
build generated those modules; the repeated final type check passed cleanly.
`bun.lock` stayed unchanged. The final process scan found no Chrome, verifier,
or static-server process started by this worktree.

subagent 使用：2 个 / 分别只读审查确定性测试时序与 service-worker 并发边界；主代理复核并完成实现、变异和全部定向门禁，并行审查节省了串行分析时间。

PASS
