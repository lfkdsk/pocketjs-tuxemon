# G21-STARTUP: cold-start decomposition and acceleration

## Result

The startup path is materially smaller and faster, but the requested absolute
target is not met. The final desktop JavaScript is 1,388,507 B, down 879,789 B
(38.7863%) from the 2,268,296 B baseline. The desktop startup pak is
37,855,968 B, down 20,907,728 B (35.5793%) from 58,763,696 B. Four-cell
QuickJS ABBA/BAAB testing improved the paired startup median by 8.96–12.72%,
and Chrome at 4× CPU throttle improved by 3.53%.

The optimized QuickJS startup medians are still 224.654–229.591 ms, not the
requested 150 ms. One retained 960×544 Chinese sample reached 335.092 ms, so
the requested 250 ms worst-case bound under scheduler preemption is also not
met. QuickJS source compilation is now the largest stage at 136.037–139.418 ms
or 60.27–61.81% of the candidate median. The IIFE build has no runtime module
loader, and a dynamic `import()` is bundled back into the same startup source;
removing enough compile work therefore needs a PocketJS chunk loader or
QuickJS bytecode-cache facility. PocketJS changes were explicitly out of scope
for this work, so the final result is BLOCKED rather than PASS.

There are no Pocket RPG Kit, PocketJS, schema, map-identity or save-format
changes. All behavior, journey, web and PSP gates passed. First entry into the
deferred/heavy scenes remained well below the real 50 ms frame limit.

## Implementation

### Shipped bundle

- `tools/runtime-bundle.ts` performs a complete second Bun build after
  PocketJS asset discovery. This allows local identifiers and syntax to be
  minified in addition to comments and whitespace.
- The finalizer is used by the standard, desktop, Web, Web replay and PSP
  builds. It fails if the frame export disappears or the output grows.
- The ordinary desktop bundle changed from 2,268,296 B to 1,388,507 B.
  QuickJS's reported used heap at title boot changed from 10.56 MiB to
  9.89 MiB while the startup object count stayed at 29,729.

### Desktop pak and startup data

The desktop host synchronously reads and feeds the complete startup pak before
it compiles the JavaScript. The launcher now keeps render-critical textures,
fonts and the three small WAV effects in that pak, while preserving lazy
content under the existing `data.fs` namespace:

| Partition | Entries | Payload bytes |
| --- | ---: | ---: |
| Lazy maps, battle data/art, demos, localization and related data | 2,951 | 21,161,642 |
| QOA music | 24 | 22,481,712 |
| Complete desktop sidecar | 2,975 | 43,643,354 |

This changes the startup pak from 58,763,696 B to 37,855,968 B. The sidecar
keys are unchanged, so the existing map, battle, demo and bounded QOA readers
continue to use the same production code.

The English project shell (202,861 B) and battle runtime shell (239,614 B) are
also raw pak/`data.fs` entries now. They are read, parsed once and cached at
boot, matching the existing Chinese startup-data design. A static import of
either shell is forbidden by the real import-graph guard.

### Profiling and regression guards

- `tools/g6-quickjs-bench.rs` reports native-clock host stages, QuickJS
  compile/evaluate stages, per-file startup-data marks, first-map preparation,
  and an optional module-evaluation profile.
- `tools/profile-startup-modules.ts` builds a readable diagnostic bundle and
  inserts marks at all 254 emitted module boundaries without changing the
  shipped bundle.
- `tools/bench-startup-abba.ts` runs fresh-process ABBA/BAAB windows, retains
  over-budget exits and outliers, rejects incomplete windows, and computes
  deterministic 20,000-resample median confidence intervals.
- `tools/bench-web-startup.ts` runs the equivalent fresh-profile Chrome
  comparison with cache disabled and CPU throttling enabled.
- `tests/startup-import-guard.test.ts` walks the real static graph. Its
  in-memory mutation adds an English shell import to the startup path and
  proves the guard rejects it; restoring the graph passes.

## Desktop QuickJS measurement

### Protocol

The accepted record contains ten complete windows per cell. Odd windows are
ABBA and even windows are BAAB, yielding 20 baseline and 20 candidate cold
processes for each language/viewport cell and 160 retained samples overall.
Each sample creates a fresh QuickJS realm with no application prewarm; the OS
page cache is intentionally not dropped. The genuine 250 ms startup and 50 ms
frame limits were left in force, including for samples that failed startup.

The run was pinned with `taskset` to logical CPU 7. Logical CPU 23 is its SMT
sibling and was approximately 97–98% idle in the preflight check. The raw
record includes an uptime of 68 days 4 hours and a starting one-minute load of
4.86. Every sample was admitted below the load limit of 6; the closing samples
were at 5.81. The retained 335.092 ms sample demonstrates that this bounded-load
window was not free of scheduler preemption, so it is not relabelled or
discarded as an outlier.

Confidence intervals are deterministic 20,000-resample bootstrap intervals.
The paired delta is computed per complete four-slot window and summarized
across its ten paired windows.

### Startup result

| Language / viewport | Baseline median (95% CI) | Candidate median (95% CI) | Paired delta (95% CI) | Candidate worst |
| --- | ---: | ---: | ---: | ---: |
| en_US 480×272 | 246.435 ms (244.735–248.608) | 224.654 ms (223.690–225.894) | -8.962% (-9.622 to -8.531) | 231.017 ms |
| en_US 960×544 | 249.644 ms (247.925–251.894) | 225.954 ms (224.562–227.242) | -9.483% (-10.439 to -8.707) | 232.547 ms |
| zh_CN 480×272 | 258.297 ms (256.009–260.045) | 225.719 ms (222.797–227.127) | -12.718% (-13.200 to -11.768) | 232.404 ms |
| zh_CN 960×544 | 259.645 ms (257.121–261.841) | 229.591 ms (228.310–232.303) | -11.527% (-20.473 to -9.786) | 335.092 ms |

The last cell retained a 408.712 ms baseline spike and a 335.092 ms candidate
spike. Nineteen of its twenty candidate samples passed the 250 ms startup
gate; all sixty candidate samples in the other three cells passed. These
results miss both requested acceptance targets:

- all four candidate medians are 74.654–79.591 ms above 150 ms;
- the retained candidate worst is 85.092 ms above 250 ms.

### Stage decomposition

`Runtime` is the portion of host initialization left after subtracting source
read and pak read/feed. `Evaluate` is QuickJS evaluation from the first emitted
module mark through mount, excluding compile and the final host handoff.
`Residual` contains the process/harness envelope after those native marks,
including the first painted frame. Values are medians of the per-sample stage.

Baseline:

| Language / viewport | Runtime | Bundle read | Pak read + feed | QuickJS compile | Evaluate | Residual | Total |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| en_US 480×272 | 1.294 | 1.323 | 66.078 | 140.974 | 32.889 | 3.868 | 246.435 ms |
| en_US 960×544 | 1.301 | 1.329 | 67.128 | 139.950 | 33.591 | 6.334 | 249.644 ms |
| zh_CN 480×272 | 1.270 | 1.331 | 67.064 | 143.174 | 41.704 | 3.744 | 258.297 ms |
| zh_CN 960×544 | 1.297 | 1.335 | 67.101 | 141.731 | 41.545 | 6.626 | 259.645 ms |

Candidate (parentheses are the candidate-total share):

| Language / viewport | Runtime | Bundle read | Pak read + feed | QuickJS compile | Evaluate | Residual | Total |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| en_US 480×272 | 1.281 (0.57%) | 0.771 (0.34%) | 44.500 (19.81%) | 138.848 (61.81%) | 37.406 (16.65%) | 1.836 (0.82%) | 224.654 ms |
| en_US 960×544 | 1.276 (0.56%) | 0.783 (0.35%) | 45.046 (19.94%) | 138.005 (61.08%) | 37.323 (16.52%) | 3.511 (1.55%) | 225.954 ms |
| zh_CN 480×272 | 1.284 (0.57%) | 0.779 (0.35%) | 44.825 (19.86%) | 136.037 (60.27%) | 37.530 (16.63%) | 5.254 (2.33%) | 225.719 ms |
| zh_CN 960×544 | 1.302 (0.57%) | 0.783 (0.34%) | 45.166 (19.67%) | 139.418 (60.72%) | 38.487 (16.76%) | 4.425 (1.93%) | 229.591 ms |

The pak change removes roughly 22 ms from synchronous read/feed. Full
minification halves source-read time, but compile remains statistically close
to baseline despite 38.8% fewer source bytes. AST/module complexity, not raw
text bytes, is the remaining dominant startup cost.

### Imported startup data

One native-clock candidate profile split every localized document into its
`read` and `JSON.parse` phases:

| Data entry | Bytes | Read | Parse |
| --- | ---: | ---: | ---: |
| en_US project shell | 202,861 | 0.358 ms | 3.186 ms |
| en_US battle shell | 239,614 | 0.095 ms | 2.624 ms |
| zh_CN project shell | 207,670 | 0.462 ms | 3.169 ms |
| zh_CN battle shell | 242,778 | 0.332 ms | 2.835 ms |
| zh_CN battle names | 30,893 | 0.134 ms | 0.505 ms |
| zh_CN map descriptions | 2,427 | 0.026 ms | 0.028 ms |
| zh_CN month names | 141 | 0.013 ms | 0.004 ms |

The first map's retained preparation profile totals about 4.53 ms: 3.41 ms
decode, 0.28 ms validation, 0.81 ms world preparation and 0.03 ms passage
preparation. It is already small relative to compile, and preparing less than
the first screen cannot recover the missing 75–80 ms.

The final ABBA first-painted-frame medians are:

| Language / viewport | Baseline | Candidate |
| --- | ---: | ---: |
| en_US 480×272 | 0.661 ms | 0.669 ms |
| en_US 960×544 | 1.075 ms | 1.073 ms |
| zh_CN 480×272 | 0.698 ms | 0.654 ms |
| zh_CN 960×544 | 1.746 ms | 1.739 ms |

### Bundle evaluation, top 20

The readable diagnostic bundle has 254 marked modules. Its source is
2,865,044 B and instrumentation adds 20,782 B. One retained profile measured
36.848 ms across module intervals:

| Rank | Emitted module boundary | Time | Share |
| ---: | --- | ---: | ---: |
| 1 | `main.tsx` | 34.590 ms | 93.87% |
| 2 | `vendor/pocket-rpgkit/src/data/schema.json` | 0.427 ms | 1.16% |
| 3 | `ui/terrain-assets.ts` | 0.177 ms | 0.48% |
| 4 | `vendor/pocket-rpgkit/vendor/pocketjs/contracts/spec/microts.ts` | 0.171 ms | 0.46% |
| 5 | `vendor/pocket-rpgkit/vendor/pocketjs/framework/src/osk-layout.ts` | 0.133 ms | 0.36% |
| 6 | `data/feature-modes-shell.json` | 0.114 ms | 0.31% |
| 7 | `dist/variable-enums.json` | 0.105 ms | 0.28% |
| 8 | `ui/demo-index.ts` | 0.080 ms | 0.22% |
| 9 | `battle/text-variables.ts` | 0.066 ms | 0.18% |
| 10 | `ui/game-assets.ts` | 0.055 ms | 0.15% |
| 11 | `data/battle-names.json` | 0.052 ms | 0.14% |
| 12 | `vendor/pocket-rpgkit/vendor/pocketjs/framework/src/native-tree.ts` | 0.038 ms | 0.10% |
| 13 | `ui/weather-overlay.tsx` | 0.030 ms | 0.08% |
| 14 | `vendor/pocket-rpgkit/src/engine/save-validate.ts` | 0.029 ms | 0.08% |
| 15 | `vendor/pocket-rpgkit/vendor/pocketjs/framework/src/gesture-core.ts` | 0.028 ms | 0.08% |
| 16 | `vendor/pocket-rpgkit/vendor/pocketjs/node_modules/solid-js/dist/solid.js` | 0.026 ms | 0.07% |
| 17 | `battle/weather-visuals.ts` | 0.025 ms | 0.07% |
| 18 | `vendor/pocket-rpgkit/src/engine/world-preview-sandbox.ts` | 0.024 ms | 0.07% |
| 19 | `vendor/pocket-rpgkit/vendor/pocketjs/contracts/spec/spec.ts` | 0.024 ms | 0.07% |
| 20 | `vendor/pocket-rpgkit/src/engine/text-break.ts` | 0.023 ms | 0.06% |

`main.tsx` is the final emitted boundary. Its interval includes the
application's top-level work and mount after all preceding module boundaries;
it does not mean declarations physically written in that source file alone
cost 34.590 ms.

## First-use frame cost

The focused production-bundle gate boots title and phone modes independently,
then enters each real scene at both viewports. It keeps the normal 50 ms
QuickJS-plus-core thread-CPU assertion. Conservative observed sampled-total
maxima across the acceptance run and final focused rerun are:

| Scene entry | 480×272 | 960×544 |
| --- | ---: | ---: |
| Title, difficulty and title minigames | ≤ 1.070 ms | ≤ 1.070 ms |
| Battle | ≤ 19.115 ms | ≤ 19.042 ms |
| NuPhone | ≤ 12.189 ms | ≤ 12.405 ms |
| Map App | ≤ 0.491 ms | ≤ 0.511 ms |

No first-use scene approaches 50 ms, so the startup work removed here was not
shifted into an unacceptable first-open frame.

## Web startup

The Web comparison used five complete ABBA/BAAB windows, a fresh Chrome
profile for every sample, cache disabled, English 480×272, and 4× CPU
throttling. The one-minute load remained 3.88–4.48. Each variant has ten
samples.

| Variant | Median (95% CI) | Worst |
| --- | ---: | ---: |
| Baseline | 1,440.250 ms (1,425.000–1,451.400) | 1,466.600 ms |
| Candidate | 1,379.200 ms (1,366.400–1,410.300) | 1,415.500 ms |

The paired median delta is -3.5268% with a 95% interval of -5.0216% to
-3.2982%.

## Behavior and compatibility gates

`bun tools/psp-mainline.ts snapshots` ran first and regenerated eight ignored
segment snapshots. Two complete imports left no tracked difference. The
determinism verifier compared 5,077 files / 68,960,530 B and produced SHA-256
`3c5a935486adb7a545c3bb2e8a0ef99cdaa15bd6d395f5bbe4b2cbdf1cd051ff`.
`bun run build`, `bun run build:wasm` and `bunx tsc --noEmit` all exited 0.

The local CI test partitions reported:

| Partition | Result |
| --- | ---: |
| Importer | 55 pass, 0 fail |
| Replays | 12 pass, 0 fail |
| Locks, battle data and terrain | 361 pass, 0 fail |
| Rest a–l | 746 pass, 0 fail; 2 browser-conditioned skips |
| Rest m–z | 682 pass, 0 fail; 4 browser-conditioned skips |
| Browser-conditioned visual rerun | 9 pass, 0 fail, 0 skip |

The six normal-Node skips are browser-only tests, not unexecuted acceptance
coverage: their files were rerun with `--conditions=browser` and completed
with zero skips.

All 16 commands in the CI journey matrix exited 0:

1. `verify:gb6:mainline`
2. `verify:j1:mainline`
3. `verify:j2:mainline`
4. `verify:j3:mainline`
5. `verify:j4:mainline`
6. `verify:goldens:sync`
7. `verify:gb6:failures`
8. `verify:g6:locks`
9. `verify:g6:frozen`
10. `verify:chapters`
11. `verify:zh:tape`
12. `verify:zh:demo`
13. `verify:en:demo`
14. `verify:save`
15. `verify:preview:coverage`
16. `verify:bootworld:replay`

The release-strength GB6, J1, J2, J3 and J4 full modes also passed their
60/30/20 Hz, save/load and rewind checks. Their terminal state pins remain:

| Journey | Terminal SHA-256 |
| --- | --- |
| GB6 | `748f84174b32011c4419588650a41d6c57c31c79d3f9e772fcc72b25c3bf9b80` |
| J1 | `c0b36ae2112df49774377c30e728d03a929fba771746bf54cb14e684742a8a87` |
| J2 | `b40b13672d7fd34db52e7607ebcf600f5740fe54c2b0915c7ff60bdb392b763d` |
| J3 | `49307027321e7f51ab1a8c81e48ca615cd70d636c289f4170e63fc408b1774bf` |
| J4 | `1977c1b0f3bd1bba2c4e5ad82332599c4fc72f0acd84d9437868976fbfb5c736` |

The Web build and all seven Chrome gates passed: opening journey, Chinese
opening, demo controls, Arena replay, expedition replay, double battles and
three-track audio. The PSP release build with `--skip-assets` passed. The
PSPLINK-profile verifier was not run because it is a manual hardware/profile
consumer and rejects an invocation without a supplied profile; it is not a
CI command or a substitute for the release-package build.

Localization remained complete: `check:l10n` reported all 11 checks passing,
and `check:cjk` covered all 2,644 fallback characters.

## Remaining blocker and proposed next work

The application-level opportunities measured here are no longer large enough
to bridge the 74.654–79.591 ms gap to 150 ms:

- host/runtime creation is about 1.3 ms;
- bundle read is below 0.8 ms;
- first-map preparation is about 4.5 ms;
- the localized JSON documents together parse in single-digit milliseconds;
- pak read/feed is still about 45 ms, but eliminating it entirely would still
  leave the best median around 180 ms;
- QuickJS compile alone is 136–139 ms.

The next task should add a PocketJS-supported way to keep optional application
code out of the initial QuickJS compilation, or cache a validated compiled
artifact. It must retain the current IIFE fallback, bind cached/chunked code to
the exact app and host ABI hashes, work on desktop/Web/PSP, and add cold-start
and first-use frame guards. This work intentionally does not modify PocketJS.

subagent 使用：3 个 / bundle_graph 调查静态 bundle 与 minify，gates_web 盘点 CI、Web、PSP 门禁，startup_chain 梳理启动链和打点位置 / 并行调查节省了前期归因时间；主代理复核并执行了所有性能测量与重门禁

BLOCKED

## Fix 1: sidecar-aware desktop freshness

### Failure and package invariant

The world-cache validator used to read `mapManifestHash` from the generated
English project shell and search for that value in the desktop JavaScript.
That stopped being a valid freshness test when localized startup documents
moved out of the bundle and into the desktop `data.fs` staging tree. A newly
built package was therefore rejected even though the runtime-visible shell was
current.

The desktop build now writes a versioned receipt after bundle minification and
pak externalization. Before writing it, the builder requires the staged
English and Chinese project shells to be byte-identical to their generated
sources. The receipt then records byte counts and SHA-256 values for the final
JavaScript, startup pak, staged English shell and staged Chinese shell. The
world-cache and Cotton validators recompute that complete receipt before any
host compilation or timing. This binds all four runtime inputs to the same
desktop build and catches both reimport-without-rebuild and an independently
replaced bundle or pak.

The accepted production receipt was:

| Artifact | Bytes | SHA-256 |
| --- | ---: | --- |
| JavaScript | 1,388,507 | `1299ed091c6c7c8c8478cb014d02f7d18690c6f7ad13a6e901b79a15b16dc95b` |
| Startup pak | 37,855,968 | `852f5446799d18db066fd0832d1f82454475ccbcae722f6da1e7ae5709c74c88` |
| English project shell | 202,861 | `506cb28b64d348194aa959f2d0caf63aab506e5b3dd3976a13ffdf2e3e2556a7` |
| Chinese project shell | 207,670 | `468d0dd28ed805b3399d8b01cf516a7b251155c3162c2f2d9f9382c426d9371f` |

`WORLD_CACHE_FRESHNESS_ONLY=1` exercises the real public validator entry
points but exits before compiling the Rust host. This keeps the package-layout
contract in the ordinary test suite without putting performance timing in CI.

### Audit and mutation strength

A full search of `tools/` and `tests/` found no other executable assumption
that a project-shell hash lives in JavaScript. The journey bench still reads
the generated shell to obtain its manifest identity, which is valid, and the
remaining test references inspect source documents deliberately. Two comments
that still described Chinese startup tables as bundled JavaScript were
corrected.

The focused suite has three cases and drives both `verify:world-cache` and
`bench:cotton:quickjs` through disposable new-layout packages:

- a valid sidecar package passes even though its manifest hash is absent from
  JavaScript;
- changing the generated English shell after receipt creation fails both
  validators as stale;
- replacing either the final JavaScript or startup pak fails receipt
  validation.

Two isolated mutations established that the assertions are discriminating.
Restoring the old bundle grep made the suite fail twice, including the fresh
fixture with `desktop bundle is stale relative to project-shell.json`.
Removing the generated-shell versus staged-sidecar equality check let the
genuinely stale fixture exit 0 and made the suite fail once. The unmodified
focused suite passed 3/3, and the related startup suites passed 14/14.

### World-cache and Cotton measurements

The accepted world-cache runs used the production desktop bundle and the same
50 ms thread-CPU limit as the historical record. The maxima below use sampled
total CPU, matching the figures previously quoted in the status document:

| Viewport | Cross-map max | Render max | Native revisit growth | Heap revisit growth | Historical cross / render / heap |
| --- | ---: | ---: | --- | ---: | --- |
| 480×272 | 12.300 ms | 42.733 ms | 0 nodes / 0 textures | +19,774 B | 12.438 / 42.956 ms / +2,331 B |
| 960×544 | 19.355 ms | 44.817 ms | 0 nodes / 0 textures | -615 B | 9.874 / 36.636 ms / +3,779 B |

Both viewports stayed below 50 ms, native resources remained flat and heap
growth stayed inside the 128 KiB allowance. The 480×272 frame maxima improved
slightly. The accepted 960×544 run was slower than the historical record, so
it is reported as such rather than labelled an improvement.

Four earlier world-cache attempts under heavy shared-machine load genuinely
failed at 65.221, 51.758, 58.145 and 52.259 ms. Their worst frame moved among
Candy Town, Route 1 and Route C rather than remaining on one deterministic
path. After one-minute load fell from 26.94 to 9.54 and the selected CPU pair
was about 89% idle, the final 960×544 run passed with the 44.817 ms render
maximum above. These retained failures make the measurement's host-load
sensitivity explicit; they are not discarded from the raw log.

The six fresh-process Cotton samples all passed their 45 ms limit:

| Viewport | Current maxima | Current worst | Historical worst |
| --- | --- | ---: | ---: |
| 480×272 | 16.344 / 17.451 / 28.937 ms | 28.937 ms | 15.046 ms |
| 960×544 | 28.694 / 26.359 / 29.170 ms | 29.170 ms | 16.045 ms |

The current samples are slower than the historical record but retain
15.830 ms or more of budget. The freshness change itself runs before timing;
it does not add work to measured application frames.

The archived cold-journey state pin used by an older verification note is no
longer present and is documented elsewhere as stale for the current mainline.
The supported startup-only path was therefore run against the real production
bundle with its unchanged 250 ms limit:

| Viewport | Fresh-process samples | Median | Worst |
| --- | --- | ---: | ---: |
| 480×272 | 236.334 / 233.326 / 229.897 ms | 233.326 ms | 236.334 ms |
| 960×544 | 238.939 / 235.048 / 237.683 ms | 237.683 ms | 238.939 ms |

All six processes passed. These medians are slower than the earlier optimized
224.654–229.591 ms ABBA medians but stay within the production gate. QuickJS
used heap was 9.42 MiB, malloc was 11.74 MiB and 27,727 objects were live.
The original report's 150 ms desired startup target remains a separate
`Partial` limitation; this narrow validator repair does not claim to solve it.

### Regression and release gates

Two complete imports were byte-identical and left no tracked difference. The
determinism check covered 5,077 files / 68,960,530 B with aggregate SHA-256
`3c5a935486adb7a545c3bb2e8a0ef99cdaa15bd6d395f5bbe4b2cbdf1cd051ff`.
Type checking, the standard build, WebAssembly build and PSP snapshot
generation all passed.

Every command represented by the CI workflow was run locally. The ordinary
test partitions passed 55 importer, 12 replay, 361 lock/battle/terrain, 746
rest-a–l and 685 rest-m–z tests. The six browser-conditioned cases from those
partitions were rerun under the browser condition; the complete conditioned
suite then finished with 1,865 pass, 0 fail and 0 skip. All 16 journey-matrix
commands passed. Full GB6 and J1–J4 replay, save/load, rewind and 20/30/60 Hz
checks retained their terminal hashes:

| Journey | Terminal SHA-256 |
| --- | --- |
| GB6 | `748f84174b32011c4419588650a41d6c57c31c79d3f9e772fcc72b25c3bf9b80` |
| J1 | `c0b36ae2112df49774377c30e728d03a929fba771746bf54cb14e684742a8a87` |
| J2 | `b40b13672d7fd34db52e7607ebcf600f5740fe54c2b0915c7ff60bdb392b763d` |
| J3 | `49307027321e7f51ab1a8c81e48ca615cd70d636c289f4170e63fc408b1774bf` |
| J4 | `1977c1b0f3bd1bba2c4e5ad82332599c4fc72f0acd84d9437868976fbfb5c736` |

The Web build and all seven Chrome gates passed with zero console errors. PSP
bootstrap, the exact CI `build:psp --skip-assets` command and a full PSP build
passed. Localization remained complete: all 11 localization checks passed and
the CJK checker covered all 2,644 fallback characters.

The new-layout receipt restores both public validators, rejects real stale or
mixed packages, is guarded by mutation-sensitive regular tests, and leaves the
mainline terminal state unchanged. This fix is accepted.

subagent 使用：3 个 / assumption_scan 核对过期判据和隐含假设，layout_audit 审计桌面数据布局与旧布局引用，test_design 审查测试辨识力与变异方案 / 三项只读审查并行完成并节省前期核对时间；主代理复核结论并串行执行全部变异、性能与重门禁

PASS
