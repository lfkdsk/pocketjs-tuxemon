# G23 — Native QuickJS bytecode releases

## Verdict

Pocket Tuxemon now publishes real target-specific `.pocket` packages for desktop and PSP. Each native package keeps the final JavaScript bundle in source section 3 and adds an ABI-bound QuickJS bytecode envelope in section 6. Desktop and PSP hosts use bytecode only after package integrity, target, host ABI, envelope, and exact QuickJS-engine ABI checks; any absence, malformed envelope, ABI mismatch, or bytecode read failure falls back to source. A bytecode execution exception does not run source a second time. Web remains source-only.

The measured desktop median is 108.916–109.118 ms at the two required viewports, below the 150 ms status threshold and about 51.6–51.8% faster than the same release through source. PPSSPP reaches frame 0 51.14% faster. Source and bytecode PSP captures are pixel-identical, the complete game/journey/save/language gates remain unchanged, both required mutations fail, and unused consumers remain within their 3% budget.

## Delivery and merge order

Merge in dependency order: PocketJS, Pocket RPG Kit, then Pocket Tuxemon.

| Repository | Branch | Verified implementation HEAD | Base | Ahead / behind |
|---|---|---:|---:|---:|
| PocketJS fork | `fleet/4898-bytecode` | `f1bbfb47fd07853df4bb8eb9222f01a5c3973f4d` | `origin/rpgkit-base-sync@91f9b373a9cdcb291a4576900463e2ad8bb85702` | 8 / 0 |
| Pocket RPG Kit | `fleet/4898-bytecode` | `3a98310911c797ad107597e808854163b03033ce` | `origin/main@b6e8b21a2b85d627dd7859d0db7dc83f1d6a648f` | 5 / 0 |
| Pocket Tuxemon | `fleet/task-4898` | `d7a2feda94604569967014c6dae0acf9dd5a66f0` | `origin/main@f9ac723e7ddd0269069de0fc9612eef0627cbda5` | 6 / 0 before this report-only commit |

All three branches were rebased after their final remote-baseline fetch and reported up to date. Final `git rev-list --left-right --count` results were `0 8`, `0 5`, and `0 6`; `git log --merges` was empty in all three ranges. No `bun.lock` differs from its base, and all three worktrees were clean before this report was added.

## Implementation

### PocketJS fork

- Ported the two upstream draft-PR commits onto `rpgkit-base-sync`, then split the integration fixes into reviewable commits.
- Added the `QJBC` v1 envelope: 48-byte header, 32-byte engine digest, non-empty raw QuickJS payload, and package section kind 6. The native package reader still requires NUL-terminated JavaScript section 3.
- The compiler checks out the exact pinned engine source, builds a host-native `qjsc`-based compiler, and emits deterministic raw bytecode tied to the target descriptor.
- Desktop `--pocket` loads the package plan, source, pak, and optional section 6. Loose `--js`/`--pak` behavior is unchanged and mutually exclusive with `--pocket`.
- PSP now has a plan-derived generic runtime mode. It loads lowercase `app.pocket` from beside `EBOOT.PBP`, verifies the package footer, and admits only the exact PSP target/host ABI.
- `pocket-mod` exposes one unsafe trusted-bytecode boundary. `JS_ReadObject` failures are classified as safe source-fallback points; `JS_EvalFunction` failures are terminal because application initialization may already have produced side effects.
- Status and platform documentation record the package trust boundary, fallback behavior, and engine pins.

### Pocket RPG Kit

- Added `packageNativeArtifacts`, which accepts only the already-final JavaScript and pak bytes. It re-resolves the manifest, verifies the supplied plan hash and canonical plan, preserves source, optionally compiles bytecode, and decodes the completed package again before returning it.
- Added an explicit `package-native --bytecode` CLI and an opt-in desktop path. Default desktop/wander behavior remains loose source artifacts.
- macOS packaging and PSP/desktop callers can carry the explicit bytecode choice without changing defaults.
- Added a cumulative PSP ABI guard in the kit so a PocketJS submodule update cannot silently replace the engine used by releases.

### Pocket Tuxemon

- Desktop builds now run all existing build, minify, audio/pak externalization, and data staging steps first; bytecode is compiled from that final JavaScript and paired with that final startup pak. The host launches the resulting `.pocket` with `--pocket`.
- PSP builds run language/journey/capture instrumentation and boot-pak extraction first, then write `dist/psp/app.pocket`. PocketJS builds a generic runtime from the resolved plan instead of embedding a stale app bundle.
- The release helper reopens the written artifact and requires exactly one target variant, source section 3, bytecode section 6, and the expected target engine digest.
- PSP retained-evidence receipts and CI artifacts now include `app.pocket`, so a missing or substituted app package fails verification.
- Web does not call the native package helper and remains ordinary source JavaScript.
- `README.md`, `docs/status.md`, and `docs/verification.md` now describe the released layout and the measured startup numbers. “Startup and frame time” is Done because both desktop medians are below 150 ms.

Wander remains source-only. Bytecode is deliberately opt-in, and enabling it in a consumer without a measured startup win would add a target-specific 6 MB-class section. The component changes themselves were nevertheless measured against both Wander consumers below.

## Engine ABI audit

| Target | Embedded engine | Bytecode version | Engine ABI digest |
|---|---|---:|---|
| PSP | `lfkdsk/quickjs-rs@2af09e8f18b0b810a7f1b0699762c0f08bcc0f85` | 5 | `sha256:58b9adf09c223efd9a84bffb4637312075ebb0ed1729b7d352282a01f7e8b73d` |
| Linux desktop | QuickJS-NG through `rquickjs-sys` | 26 | `sha256:d2b227a22f1067bae594b37464acea6cd1000894e4a52091c1711fdb893567d7` |

The upstream draft described stock Bellard QuickJS `ba5bdd0`; that is the Vita pin, not the PSP engine on this branch. PSP's descriptor, fixture, compiler checkout, generated Rust digest, kit guard, and mutation test all use the actual `lfkdsk/quickjs-rs` revision. The fork's added generational-GC entry points do not change BC v5's reader/writer format, but the fork revision remains part of the digest because bytecode compatibility is an exact-build contract, not merely a format-version contract.

## Release artifact audit

| Artifact | Source-only bytes | Bytecode release bytes | Increase | Source section | Pak section | Raw bytecode |
|---|---:|---:|---:|---:|---:|---:|
| Linux desktop `.pocket` | 39,248,392 | 45,564,952 | 6,316,560 (16.094%) | 1,390,793 incl. NUL | 37,855,968 | 6,316,483 |
| PSP `app.pocket` | 2,570,360 | 9,156,184 | 6,585,824 | 1,393,058 incl. NUL | 1,175,664 | 6,585,759 |

The QJBC envelope adds 48 bytes around each raw payload; remaining package deltas are alignment. Both native artifacts retain their exact final source fallback. Tests also construct and reject bytecode-only, wrong-target, wrong-engine, missing-section, and source-only native-release mutations. Web carries no section 6.

## Startup measurements

### Desktop

Method: CPU 7, ten same-window ABBA/BAAB rounds per viewport, four starts per round, 20 source and 20 bytecode samples per viewport. The one-minute load average stayed between 4.56 and 4.93 during the recorded run. Both variants use the same final JS/pak and release host. The candidate intentionally still reads the retained source section before selecting QJBC, so this measures only skipped compilation and is conservative about possible package-reader optimization.

| Viewport | Path | n | Median | Bootstrap 95% CI | Worst | Paired median delta |
|---|---|---:|---:|---:|---:|---:|
| 480×272 | source | 20 | 224.483 ms | 223.454–228.342 ms | 230.556 ms | — |
| 480×272 | QJBC | 20 | 108.916 ms | 108.431–109.273 ms | 110.894 ms | -51.616% (95% CI -52.132% to -51.267%) |
| 960×544 | source | 20 | 227.493 ms | 225.000–228.967 ms | 230.960 ms | — |
| 960×544 | QJBC | 20 | 109.118 ms | 108.131–110.584 ms | 112.971 ms | -51.810% (95% CI -52.031% to -51.440%) |

The source medians reproduce the earlier 225–230 ms range. Host stage records show source compilation at roughly 136–140 ms and QJBC compilation at zero; the residual ~109 ms is pak read/feed, host initialization, bytecode read/eval, language data, battle registration, mount, and fixed game boot work.

Raw evidence: `/var/tmp/fleet/4898/desktop-startup-abba.ndjson` and `/var/tmp/fleet/4898/desktop-startup-abba.log`.

### PSP / PPSSPP

Method: the same generic PRX, assets, capture segment, and emulator configuration were run as source/QJBC/QJBC/source (A1/B1/B2/A2). The host's `boot_to_frame0_us` clock starts at PSP host boot and ends immediately after the first game frame. The retained JSONL values were deterministic across the two repetitions of each path.

| Path | `eval_us` | `boot_to_frame0_us` |
|---|---:|---:|
| Source | 12,549,450 | 12,847,278 |
| QJBC | 5,985,799 | 6,276,998 |

QJBC improves PSP boot-to-frame-0 by 6,570,280 µs, or 51.141%. Evidence is under `/var/tmp/fleet/4898/psp-abba/{A1,B1,B2,A2}/PocketJS-bench.jsonl`.

All four captured PSP raw frames are pairwise source/QJBC identical:

| Frame | SHA-256 |
|---:|---|
| 0 | `bf1f665787b99fd694f1f8091acf0213bc81c28c32d0aa37ac0e86a3f2c365a6` |
| 1 | `8052a70e18d5f036002ef4ed24f923c53d2515e365e6cc624aa0868d731c76da` |
| 2 | `8052a70e18d5f036002ef4ed24f923c53d2515e365e6cc624aa0868d731c76da` |
| 3 | `144a105ea875f2186bd57b31734f56cac8b1d1ffcf03761b7c5577d821fa3539` |

The 3× bedroom and choice-dialog PNGs were opened and inspected. Map composition, player sprite, dialogue geometry, choice cursor, text, and button legend are visible and correctly aligned; the large black border is the expected fixed 480×272 PSP canvas presentation in the capture conversion.

## Behavior and determinism

- Two isolated imports produced 5,077 files / 68,960,530 bytes with identical SHA-256 `3c5a935486adb7a545c3bb2e8a0ef99cdaa15bd6d395f5bbe4b2cbdf1cd051ff`.
- GB6 remains `748f84174b32011c4419588650a41d6c57c31c79d3f9e772fcc72b25c3bf9b80` after 116,107 frames.
- The full J4 terminal remains `1977c1b0f3bd1bba2c4e5ad82332599c4fc72f0acd84d9437868976fbfb5c736` after 230,322 frames.
- All 16 journey/golden/failure/lock/chapter/English/Chinese/save/preview/bootworld commands passed. Bootworld replay covered 242 checkpoints and 230,322 frames.
- Save-resume passed five points; component compatibility tests passed every retained schema generation. No schema or save format changed in this task.
- English and Chinese journey/demo verification passed. Native bytecode changes neither localization data nor input/presentation paths.
- A pre-existing PPSSPP save E2E issue (`save/slot-1.json was not written to the memstick`) reproduces on QJBC, source-only, and the untouched baseline. It is not attributed to this branch and is not presented as a passing gate; the required reducer/save compatibility gates above pass.

## Regression and consumer guards

### Component QuickJS cumulative guard

Both the single-change and cumulative six-round ABBA guards passed all eight cases with zero failure, zero inconclusive result, and zero error. Single-change point estimates range from -0.390% to +0.827%. Cumulative point estimates range from -5.000% to +0.374%; the largest positive estimate is `battleScene` at +0.374%, below the +3% limit.

Evidence: `/var/tmp/fleet/4898/rpgkit-pr1/guard-single.log` and `guard-cumulative.log`.

### Wander consumers

The authoritative run used CPU 31, six ABBA rounds, one warmup and seven measured starts per slot: 96 cases, 96 warmups, and 672 measured starts.

| Consumer | Viewport | Delta | Verdict |
|---|---|---:|---|
| Wander | 480×272 | +0.320% | pass |
| Wander | 960×544 | +0.314% | pass |
| Wander Online | 480×272 | -1.657% | pass |
| Wander Online | 960×544 | -0.699% | pass |

`KP1_ABBA_GUARD_RESULT failures=0 verdict=pass`; no consumer reaches the +3% limit. Evidence: `/var/tmp/fleet/4898/wander-kp1-abba-final/`.

### Required game QuickJS checks

- `bun run bench:cotton:quickjs`: six process-cold runs passed. At 480×272 the maximum QJBC core CPU time was 16.962 ms; at 960×544 it was 28.802 ms, both below the 45 ms budget.
- `bun run verify:world-cache`: both 67-map/two-pass runs passed. Cross-map maxima were 11.956/17.019 ms and render maxima were 49.406/49.787 ms at 480×272 / 960×544, all below 50 ms. The revisit plateau showed zero growth for nodes, textures, ground, upper, animated, and NPC resources.

## Mutation strength

| Mutation (isolated worktree) | Expected failure | Result |
|---|---|---|
| Revert PSP ABI identity to stock `ba5bdd0dc013518768e76cd9e05cd30ed53dd35b` | ABI descriptor/lock guard turns red | 3 pass / 2 fail / exit 1 |
| Change native release opt-in to `bytecode: false` | Game publication gate detects missing section 6 | 3 pass / 1 fail / exit 1 |

Both mutation worktrees were under the task-owned temporary directory and were removed after the runs. Receipts: `/var/tmp/fleet/4898/mutation-abi.log` and `/var/tmp/fleet/4898/mutation-release-flag.log`.

## Gate inventory

### PocketJS

- Bytecode, package-format, CLI, and PSP-toolchain Bun suites: 34 pass / 0 fail.
- Core package tests: 9 pass / 0 fail; `pocket-mod`: 3 pass / 0 fail; desktop package loader: 9 pass / 0 fail.
- Core and desktop release builds passed. PSP release/generic-runtime build passed with the pinned Clang PSP path.
- Stable compiler fixtures passed for PSP BC v5 and desktop BC v26.

### Pocket RPG Kit

- Clean dependency reinstall from the public registry with `--frozen-lockfile`, TypeScript, examples build, and all four test groups passed.
- Test groups: 1,465 + 1,164 + 1,115 + 874 = 4,618 pass / 0 fail / 0 skip.
- Final bytecode package gate: 7 pass / 0 fail.
- Single and cumulative QuickJS guards passed as detailed above.

### Pocket Tuxemon

- `bun tools/psp-mainline.ts snapshots` ran before the game test and journey jobs.
- `bun run import` twice was byte-stable; TypeScript, build, refreshed wasm, Web build, `verify:web:zh`, desktop native build, and PSP release build passed.
- Local CI test groups passed: importer 55, locks 361, replays 12, rest shards 213 + 249 + 285 + 263 + 292 + 178, all with zero failure. Six browser-conditioned visual assertions appear skipped under Bun's default condition; rerunning their two files with `--conditions=browser` executed nine assertions with 9 pass / 0 fail / 0 skip, so no browser assertion remains unexecuted.
- All 16 long journey commands passed; mainline/failure/chapter/save/language/preview/bootworld identities are recorded above.
- `bench:cotton:quickjs` and `verify:world-cache` passed with their budgets above.
- Focused final gate reruns passed: game package/world-cache/PSP evidence 82 pass / 0 fail, plus browser visual 9 pass / 0 fail / 0 skip.

## Final adversarial review

The final read-through traced package bytes from post-processing through both hosts. The important failure boundaries are intentional:

1. Native packagers verify the manifest/plan and package the final JS/pak rather than rebuilding an earlier manifest stage.
2. Package section 3 is mandatory even when section 6 exists.
3. Envelope failure, ABI drift, or `JS_ReadObject` failure occurs before program execution and may use source fallback.
4. `JS_EvalFunction` failure may follow side effects and therefore cannot safely execute source again.
5. Desktop package metadata drives data identity and viewport; PSP loads only the colocated lowercase `app.pocket` under the generic runtime.
6. Web and default consumers do not enter any bytecode path.

No double-execution path, stale pre-transform bundle, wrong PSP engine pin, or missing publication assertion remained after this review.

subagent 使用：3 个 / PocketJS 字节码移植、组件库打包接线、游戏发布接线与测试 / 并行实现节省了三仓初始开发时间；主代理完成集成、重门禁、性能、变异、文档和最终审查

PASS
