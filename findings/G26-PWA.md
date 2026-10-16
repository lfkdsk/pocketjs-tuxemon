# Offline PWA acceptance

## Result

The Web game is an installable, scoped PWA whose already visited content and
browser saves remain usable after an ordinary Chrome offline reload. A player
can also download or resume a complete package for one language. A transition
to an uncached map is parked behind a bilingual recovery dialog instead of
crashing the game. Page, worker, content manifest and content-addressed chunks
stay on one release during an update. Battle/expedition replays and Link
traffic remain network-only.

The acceptance baseline was `fb2ecdbd23c67f022519c7b03a9623803a87abf1`.
The final tested implementation tip before this report was `374a98e1`.
Pocket RPG Kit remained at `3a98310911c797ad107597e808854163b03033ce`
and PocketJS at `f1bbfb47fd07853df4bb8eb9222f01a5c3973f4d`; the imported
Tuxemon source was pinned at `9e6258ff726b786040a267e8bdbbf037b560285e`.
The browser run used Bun 1.3.14 and Google Chrome 138.0.7204.92.

## Shipped behavior

- `tools/web-pwa.ts` finalizes the game directory after the ordinary Web
  build. Its release identity covers the page, worker template, language
  routing and every shell/install asset.
- The versioned, scope-qualified shell cache precaches verified page, game,
  player, wasm, CSS, worklet, manifest, icons and startup pack bytes. Page and
  manifests are network-first with verified same-release fallback. SHA-256
  named chunks use the long-lived shared content cache.
- Installation is delayed until the first playable map, so service-worker
  setup and the PWA client stay off the startup critical path.
- Offline pack downloads are selected by language, bounded to four concurrent
  requests, validate every cached response, can be paused, and automatically
  resume from already durable chunks after reconnection.
- Failed demand-loading of a map is intercepted in the browser-only PWA seam.
  Background prefetch failures do not open the dialog. Retry keeps the reducer
  frame parked; Return reloads cached gameplay and preserves browser saves.
- Navigation rejects a page carrying a different release marker. Activation
  deletes only stale caches for the same scope. Replay pages and other network
  requests bypass the worker.
- The manifest uses `id`, `start_url` and `scope` `./`,
  `display: standalone`, landscape orientation, matching theme/background
  colors, and 192/512 px `any` plus `maskable` icons.

Release A was
`6c56e250df0c861031c01ce61fdd6693bf4f5df76bc161d6c54088551bdfe865`.
The verifier's synthetic release B was
`bb2d13aa3b0efd904e4e2109fd195d206d9f26012ced893ca4d068c78c7cf877`.
The 13-file verified shell is 10,066,085 B. The finalized Web tree grew from
2,171 files / 279,074,354 B to 2,184 files / 282,531,599 B: +3,457,245 B
(+1.2388%). Complete package sizes are:

| Language | Files | Compressed bytes |
| --- | ---: | ---: |
| English | 547 | 28,980,696 |
| Chinese | 548 | 29,240,823 |
| German | 548 | 29,197,908 |
| French | 548 | 29,209,071 |
| Spanish | 548 | 29,199,799 |
| Italian | 548 | 29,197,321 |
| Portuguese (Brazil) | 548 | 29,196,697 |

## Real Chrome acceptance

`bun run verify:web:pwa` finished with **36/36 checks**, no page exception
and no console error. It used CDP `Network.emulateNetworkConditions` plus an
origin-side network cut so the service worker could not silently reach the
loopback server.

| Stage | Observed result |
| --- | --- |
| Cold online | Entered `spyder_bedroom`; the PWA installed only after the first map and then controlled an A/A page-worker pair. |
| Installability | Chrome parsed the manifest with zero errors and returned zero installability errors. Scope, start URL, standalone display and all four icon-purpose/size combinations matched. |
| Online to offline reload | The maintained opening reached `spyder_bedroom@3,4`, frame 1,239. A normal offline reload replayed the same state; simulation and host clocks then advanced together to frame 1,263. |
| Cache bypass | Replay and ordinary network probes were real online responses, absent from Cache Storage, and both failed while offline. |
| Offline save/load | The real START menu wrote a 4,490 B manual slot at `spyder_bedroom@3,4`, walked to `@5,4`, then Load restored `@3,4`. |
| Missing map | `spyder_downstairs` was absent. Its exact map chunk returned 503, the reducer remained at `spyder_bedroom@7,2`, the bilingual alertdialog named the map, Retry was disabled offline, and no background failure masqueraded as this transition. Return restored cached gameplay and retained the 4,490 B slot. |
| Interrupted download | English was disconnected at 286/547 and resumed to 547 files / 28,980,696 B with 261 new chunk requests. All 286 durable entries were inspected; none was re-requested. |
| Atomic update | With B on the server and A controlling the page, navigation stayed A page / A worker and selected A's 4,246 B `spyder_downstairs` chunk. After explicit activation it converged to B page / B worker, deleted A's shell cache, fetched B's separately named 6,075 B chunk, verified its SHA-256, and retained the save. |

The complete machine-readable record is
`dist/web-pwa-verify/report.json`. The verifier produced these eight images:

- `cold-online.png`
- `offline-save-loaded.png`
- `offline-missing.png`
- `offline-missing.480x272.png`
- `offline-missing.960x544.png`
- `offline-package-ready.png`
- `update-mixed-stays-a.png`
- `update-complete-b.png`

All eight were opened and checked manually. The game stayed rendered rather
than blank during cold, save/load, completed-package and update states. The
missing-content card was centered, legible in English and Chinese, and showed
the disabled Retry and usable Return actions. The 480×272 and 960×544 captures
were additionally opened at 3× nearest-neighbour scale. Their card rectangles
fit inside the exact viewport. Semantic pixel checks found 2,640 and 2,720
near-gold border pixels respectively (top-center color distance 0); the
original 1200×761 capture found 2,732.

## Startup and native-output comparison

The cold-load comparison used Chrome with 4× CPU throttling and the
10 Mbit/s, 40 ms profile in candidate/baseline/baseline/candidate order.
`dist/web-load-g26.json` retains every request.

| Metric | Baseline | Candidate | Delta |
| --- | ---: | ---: | ---: |
| Title median | 10,241.10 ms | 10,235.55 ms | -5.55 ms |
| First-map median | 10,368.55 ms | 10,367.25 ms | -1.30 ms |
| Bytes at first map | 10,255,213 B | 10,257,291 B | +2,078 B (+0.0203%) |

There were 27 requests by first map and zero requests for the PWA client or
service worker. The first-map time therefore did not regress, and PWA setup
remained after the acceptance boundary.

Portable builds were compared independently from the Web tree; their receipt
is `dist/native-artifact-comparison-g26.json`.

- Desktop: all 8,412 files / 167,197,979 B under the release and runtime-data
  roots were identical. `differentFiles` was empty. The fixed-root
  23,579,992 B host hash was
  `f1951e4f8f1d59de82e30fc3c7a79e9e9512ff8c507e2d05b005d16fbffd7c27`
  for both builds.
- PSP: `AUDIO-ATTRIBUTIONS.md`, `app.pocket`, `assets.pak`, game JS,
  game pak and `veil-logo.raw` were identical. Fixed-root EBOOT was
  2,555,968 B with SHA-256
  `611b0a076fd07d7d937a607dd8a3c31998071eaed459bcb53e3c0da89e57e5fc`;
  PRX was 2,555,636 B with SHA-256
  `2409f1bd57a59eb0c599eea9d00285e367a5262a3826fe476f4fa6c650a8f205`.
  `build-receipt.json` was intentionally excluded because it records the
  source commit.
- A complete `bun run build:psp` passed. After emulator testing, a normal
  traceless `bun run build:psp --skip-assets` rebuilt the retained package.

The native comparison was recorded at `d79171ec`; every later source change
is confined to service-worker or verification files and cannot enter desktop
or PSP build inputs.

## Mutation sensitivity

Each mutation ran in its own disposable copy and was deleted afterward. The
delivery worktree was never modified by a mutation.

| Mutation | Deliberate defect | Detection |
| --- | --- | --- |
| Required: mixed releases | The active worker accepted and cached any network page without byte verification or the release marker check. | Exit 1. The atomic fallback timed out with B page `c2be18…` under A worker `d90f6e…`. |
| Required: uncached map crashes | The browser map wrapper rethrew the failed prepare instead of parking it for recovery. | Exit 1. The real transition surfaced `spyder_downstairs…pak.gz returned 503` before the recovery-dialog assertion. |
| Additional: fake resume | The worker re-fetched every verified durable chunk before continuing. | Exit 1 at “resume reuses every chunk”; 293 of 294 cached entries were detected as re-downloaded. |

## Gates

The source was always provided from the pinned checkout. Two imports produced
the same bytes and left no tracked diff. `bun run build`,
`bun run build:wasm`, PSP journey snapshots, determinism/l10n/CJK checks and
`bunx tsc --noEmit` all exited 0.

The test job was reproduced using the exact CI file selection rather than one
large process:

| CI shard | Tests | Fail | Skip |
| --- | ---: | ---: | ---: |
| importer | 55 | 0 | 0 |
| replays | 12 | 0 | 0 |
| locks, battle data and terrain | 361 | 0 | 0 |
| browser UI visuals | 9 | 0 | 0 |
| locale production visuals | 5 | 0 | 0 |
| rest a-d | 395 | 0 | 0 |
| rest e-l | 361 | 0 | 0 |
| rest m-r | 250 | 0 | 0 |
| rest s-t | 365 | 0 | 0 |
| rest u-z | 197 | 0 | 0 |
| **Total** | **2,010** | **0** | **0** |

All 17 journey matrix commands exited 0:
`verify:gb6:mainline`, `verify:j1:mainline`,
`verify:j2:mainline`, `verify:j3:mainline`,
`verify:j4:mainline`, `verify:de:mainline`,
`verify:goldens:sync`, `verify:gb6:failures`,
`verify:g6:locks`, `verify:g6:frozen`, `verify:chapters`,
`verify:zh:tape`, `verify:zh:demo`, `verify:en:demo`,
`verify:save`, `verify:preview:coverage`, and
`verify:bootworld:replay`. The five English mainline terminal hashes were:

- GB6: `748f84174b32011c4419588650a41d6c57c31c79d3f9e772fcc72b25c3bf9b80`
- J1: `c0b36ae2112df49774377c30e728d03a929fba771746bf54cb14e684742a8a87`
- J2: `b40b13672d7fd34db52e7607ebcf600f5740fe54c2b0915c7ff60bdb392b763d`
- J3: `49307027321e7f51ab1a8c81e48ca615cd70d636c289f4170e63fc408b1774bf`
- J4: `1977c1b0f3bd1bba2c4e5ad82332599c4fc72f0acd84d9437868976fbfb5c736`

Both failure tapes, 20 chapter suffixes, five save/resume points, 21 preview
states and all 242 boot-world checkpoints passed. German completed 230,322
frames at the same language-neutral endpoint.

The Web job and local additions were reproduced individually:

| Command | Result |
| --- | --- |
| `TUX_LINK_VERIFY_PORT=49191 bun run verify:web:link` | TUX LINK WEB PASS in both required-capabilities and replay-capable modes, including reconnect epochs, keyboard/touch/gamepad input, pending-choice secrecy, trusted replay URLs, and 480×272 plus 960×544 pixel goldens. The optional port override isolated the verifier from an unrelated process while preserving port 49190 as the default. |
| `bun run web` | PASS; finalized release A above. |
| `bun run verify:web:pwa` | PASS, 36 checks. |
| `bun tools/verify-web-journey.ts` | WEB JOURNEY PASS. |
| `bun tools/verify-web-zh.ts` | PASS. |
| `bun tools/verify-web-demo.ts` | WEB DEMO PASS. |
| `bun run verify:web:arena` | WEB ARENA PASS, 12 pairs and four screenshots. |
| `bun run verify:web:expedition` | WEB EXPEDITION PASS, 16 entries and four screenshots. |
| `bun run verify:web:doubles` | PASS for keyboard and touch. |
| `bun run verify:web:audio` | WEB AUDIO PASS. |
| `bun run verify:web:chunks` | WEB CHUNKS PASS, all 11 assertions; delayed English made 291 unique requests with zero duplicates and warm English made zero requests. |
| `bun run verify:web:lang` | WEB LANG PASS. |

The exact CI PSP save command used pinned PPSSPP
`a2f4ce214f224c6c26b3319409ec50205ff8253d`. It saved
`spyder_downstairs@6,6` at frame 115, loaded a field-for-field identical
state and continued 30 frames, migrated legacy raw JSON, restored the automatic
save and continued, then made a read-only memory stick show **SAVE FAILED**
without a file or crash. It exited 0 with `ALL PHASES PASS`.

Every gate above reported zero failures and zero skips. No GitHub run was
started because this delivery is intentionally local and unpushed; the
commander can run the branch workflow before merging.

## CI and documentation

The workflow now runs `verify:web:pwa` immediately after the deployable Web
build, so a failure makes the Web job and deployment fail. An `if: always()`
step retains `dist/web-pwa-verify` as the `web-pwa` artifact for 14 days,
including the JSON receipt and eight screenshots. README installation/use
instructions, the feature status table and the CI reproduction guide describe
the shipped behavior and its current limitations.

subagent 使用：3 个 / 分别静态审计 CI 与文档、实现边界、Chrome 验证器与变异辨识力；并行找出了 native 隔离、真实 A/B 分块、续传和双分辨率证据缺口，均由主代理复核和修复，节省了串行审计时间。

## Fix 1: changing language during an offline download

### Resolution and policy

The client now records the language of the active offline-package operation
separately from the language selector. Changing the selector does not discard
the active operation's progress, completion, or failure messages. The verified
package already in flight continues to a terminal state; the new selector value
becomes the language for the next explicit download. This avoids throwing away
durable chunks and avoids a service-worker protocol change solely for
cancellation. While the two languages differ, the bilingual status explicitly
names both the active package and the next selection. Completion and failure
always clear the busy state and restore an actionable button.

The same narrow fix also closes the review follow-ups:

- map-prepare recovery now makes at most 64 attempts with exponential delays of
  25, 50, 100, 200, 400, 800, then at most 1,000 ms; `pagehide` cancels the
  timer;
- the unreachable `OFFLINE_CHUNK_MISSING` client branch was removed;
- service-worker tests execute the emitted worker against in-memory Cache
  Storage and network implementations instead of treating source substrings as
  proof of behavior;
- the unrelated CI-guide edit remains absent. README and the feature-status
  table describe only the shipped language-switch policy.

### Unit and service-worker behavior

`tests/web-pwa.test.ts` now has eight tests. The two executable worker tests
cover shell/manifest/content cache routing, online network isolation, offline
fallbacks, atomic release activation, same-scope stale-shell cleanup, preservation
of shared content caches, and `skipWaiting`. The client harness executes the
real `web/pwa-client.js` and verifies that:

1. a German operation remains authoritative after the selector changes to
   Chinese;
2. German progress and completion update the UI and unlock the control;
3. the next click starts Chinese, and an error returns it to the resumable
   state; and
4. recovery polling is bounded, backs off, and is cancelled on `pagehide`.

The fresh CI shard run added four tests relative to the original delivery:

| CI shard | Tests | Fail | Skip |
| --- | ---: | ---: | ---: |
| importer | 55 | 0 | 0 |
| replays | 12 | 0 | 0 |
| locks, battle data and terrain | 361 | 0 | 0 |
| browser UI visuals | 9 | 0 | 0 |
| locale production visuals | 5 | 0 | 0 |
| rest a-d | 395 | 0 | 0 |
| rest e-l | 361 | 0 | 0 |
| rest m-r | 250 | 0 | 0 |
| rest s-t | 365 | 0 | 0 |
| rest u-z | 201 | 0 | 0 |
| **Total** | **2,014** | **0** | **0** |

### Real Chrome C12 and mutation

The real-Chrome verifier now includes the reported race in its normal release
A run. German began through the visible controls, the selector changed to
Chinese while German was active, and German still completed all 548 files and
29,197,908 bytes. Its terminal message unlocked the button without a reload.
The next click then started Chinese, which was paused at 289/548 files. Together
with the existing installability, offline journey, save/load, missing-chunk,
resume, release B, and update tests, the verifier passed **41 checks**, zero
failed and zero skipped.

The final 1200×761 screenshot was opened and inspected rather than accepted by
hash alone. It shows Chinese selected, an enabled **Download or resume / 下载或继续**
button, and **German is ready offline; Chinese is selected / 德语已可离线游玩；当前选择中文**.

Mutation was isolated in a detached worktree. The complete client fix commit
was reverse-applied while the new verifier remained present, then the Web build
and Chrome verifier were rerun. `bun run verify:web:pwa` exited 1 after 7.43 s:

```text
FAIL German package starts through the visible offline controls:
  status="Checking offline content… / 正在检查离线内容…"
Error: verify-web-pwa: German package starts through the visible offline controls
error: script "verify:web:pwa" exited with code 1
```

The isolated worktree was removed after the expected failure.

### Full regression gates

The deterministic import still produced 5,077 files and 69,577,033 bytes with
SHA-256
`bb6a32fdd5c16cdbe860fdeca0012539f0746935688fa74f240742bb43e218c3`.
TypeScript, the production build, Wasm build, all 11 locale catalogs, CJK
checks, and both importer runs passed. The second import had no diff.

All 17 journey-matrix commands passed. The maintained terminal hashes stayed:

- GB6: `748f84174b32011c4419588650a41d6c57c31c79d3f9e772fcc72b25c3bf9b80`
- J1: `c0b36ae2112df49774377c30e728d03a929fba771746bf54cb14e684742a8a87`
- J2: `b40b13672d7fd34db52e7607ebcf600f5740fe54c2b0915c7ff60bdb392b763d`
- J3: `49307027321e7f51ab1a8c81e48ca615cd70d636c289f4170e63fc408b1774bf`
- J4: `1977c1b0f3bd1bba2c4e5ad82332599c4fc72f0acd84d9437868976fbfb5c736`

Both failure tapes, 20 chapter suffixes, five save/resume points, 21 preview
states, the frozen-lock scan, and all 242 boot-world checkpoints passed. The
German mainline completed 230,322 frames at the same language-neutral endpoint.

Every Web command from the workflow was reproduced locally and passed:
`verify:web:link`, the production Web build, `verify:web:pwa`, Web journey,
Chinese production, Web demo, arena, expedition, doubles, audio,
`verify:web:chunks` with all 11 assertions, and `verify:web:lang`. Release A
finished at
`086ddc58d3a4387d747eee7024d87b6e1b3abb9d65c3bf7fdffd7268fd1ae7d1`;
the one-chunk release B finished at
`83a162cd04e9d7fdb3b7cef7e9677b7e25c9bcee5febeb57600f0279cb32484a`.
All fresh gates had zero failures and zero skips.

### Native invariance and PSP save E2E

The Web-only client and verifier changes do not enter desktop or PSP inputs.
The rebuilt desktop release had 8,412 files and 167,197,979 bytes, with an empty
recursive diff against the original delivery's runtime data. Its JavaScript,
pak, `.pocket`, and build-receipt hashes were byte-identical. Because every
QuickJS input is identical, the prior timing result remains applicable without
introducing a noisy remeasurement.

The rebuilt PSP release retained byte-identical game content:

- `app.pocket`: `c07f72a034c416e94bbc0a2c726bfa8f883631e35329fc340724fdeb114097d1`
- `assets.pak`: `bc546df22cef9ae546ec523c18b6b8cffd88de299044d4a8879165812e81260a`
- game JavaScript: `bb68431cd21524dbb8029767eb287269f798418c09e664db4223af26f6d7cac0`
- game pak: `9f2bd7d59bf6b4364a3c652d0d013fc2686593a19f6e6fca84636d8f5ec50d78`

Host binary hashes remain build-path dependent, as documented in the original
review; native sources did not change. A final traceless PSP release was rebuilt
after verification and contains no save-verifier markers.

The exact CI PSP save command was rerun with PPSSPP revision
`a2f4ce214f224c6c26b3319409ec50205ff8253d`. It saved
`spyder_downstairs@[6,6]` at frame 115 (3,935 bytes), loaded a field-identical
state and advanced 30 frames, accepted legacy raw JSON, restored autosave and
advanced another 30 frames, then showed **SAVE FAILED** on a read-only memory
stick without writing a slot or crashing. The receipt ends `ALL PHASES PASS`.

A final pre-delivery fetch showed no commits behind `origin/main`, so no rebase
or merge commit was needed. `bun.lock` is unchanged, and no background verifier,
browser, server, or emulator process remains.

subagent 使用：3 个 / 分别审计客户端竞态、service worker 行为测试、验收与文档覆盖；主代理逐项复核并执行全部门禁，三个只读审计并行完成，节省了串行复审时间。

PASS
