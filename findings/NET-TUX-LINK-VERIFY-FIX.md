# NET-TUX-LINK-VERIFY-FIX: restore the Web Link verifier

## Verdict

`verify:web:link` is live again, owns the configured Web build it verifies,
and is part of the Web CI job. The verifier now exercises both frozen Wire-v1
capability modes: required capabilities without replay, and required plus the
optional replay capability. The client gate was not relaxed.

The complete repository, CI-command, browser, mutation, journey, PSP-save and
portable-output gates pass with zero failures and zero skipped assertions.

## Root cause

The suspected protocol-version mismatch was not the failure. In the frozen
client protocol the public-presentation bit remains required (`1`), while the
replay-URL bit is optional; the supported mask is `3`. The old mock advertised
the required bit correctly.

The actual problem was build ownership. `verify:web:link` used whatever was
already in `dist/web`, while an ordinary `bun run web` intentionally embeds no
Link service or OAuth metadata. The client therefore correctly reported
`available: false`, and the verifier waited forever for an English capability
that the built site could never probe. Supplying the correct loopback service
and page-auth metadata let the old verifier reach the terminal page, where it
then hit its second independent defect: a blanket JSON-substring assertion
rejected the newly legitimate `replayUrl` state field even when its semantic
value was `null`.

The repaired command invokes `tools/verify-tux-link-web.ts --build`. That build
uses only the verifier's loopback URL and non-secret example OAuth metadata.
The CI step runs before the ordinary deployable build, which immediately
replaces it with a site that prints `Tux Link: disabled (no service URL)` and
`Tux Link page auth: disabled (no OAuth metadata)`. No development endpoint can
therefore enter the retained Web or Pages artifact.

## Implementation

- The verifier imports `TUX_WIRE_VERSION`, `TUX_ARENA_VERSION`,
  `TUX_REQUIRED_CAPS` and `TUX_SUPPORTED_CAPS` from the frozen client protocol
  instead of duplicating fixture constants.
- Fixture construction rejects an omitted required client bit with a readable
  error before Chrome starts. The required-only service advertises exactly the
  required mask; the replay service advertises the supported mask.
- The first two-browser match preserves the existing reconnect, pending
  secrecy, public identity, duplicate-submit, English/Chinese, desktop/phone,
  keyboard/touch/gamepad and terminal coverage. Its semantic assertion is now
  `replayUrl === null` on both clients, together with
  `replayAvailable === false`.
- A second match negotiates replay support in the capability document and
  welcome frame. Both terminal clients must expose the exact fixture URL and
  it must start with the configured trusted replay prefix. The verifier does
  not accept merely any non-null URL.
- The browser-only verification hook exposes `replayUrl`, so the verifier
  observes the same post-validation state used by the rendered result page.
- Six framebuffer goldens are compared byte-for-byte, and semantic color
  regions prevent a blank or structurally wrong image from passing on hash
  updates.
- `verify:web:link` is the first executable step in the CI Web job. README,
  CI, verification and feature-status documentation describe the gate and its
  ordering.

No component-repository or PocketJS change was needed.

## Browser receipt and visual review

The post-rebase real-Chrome receipt was:

| Mode | Capability probes | Creates | Sockets | Epochs | Submits |
| --- | ---: | ---: | ---: | --- | --- |
| Required-only | 2 | 1 | 3 | `[2, 1]` | `[1, 1, 1, 1]` |
| Replay-capable | 2 | 1 | 2 | `[1, 1]` | `[1, 1, 1, 1]` |

The required-only terminal URLs were `[null, null]`. The negotiated value on
both clients was exactly:

```text
http://127.0.0.1:49190/tux/v1/replays/match_0000000000000001?expires=4102444800&signature=opaque
```

The trusted prefix was
`http://127.0.0.1:49190/tux/v1/replays/`. The keyboard confirm mask was 8192;
touch and gamepad each produced down/confirm masks 64/8192 through their real
browser input paths. The pending opponent received no extra server frame
(`1->1`), and all four decisions were submitted exactly once per side and turn.

The four pre-existing decision and required-only result goldens remained
byte-identical. Two replay-result goldens were added:

| Frame | SHA-256 |
| --- | --- |
| English desktop, 960x544 | `499175df02112a4e1147e4ed526e7e039e554fb33a8586be605c10a71e5733ec` |
| Chinese phone, 480x272 | `16596fe0923c29c420273344c16c2aae4f8c3760bd12744e6450cc9e0e1af912` |

Both new PNGs were opened at 3x. The desktop result has a centered, readable
replay action with intact focus border and no overlap or cropping. The phone
result preserves the same hierarchy at 480x272; the Chinese replay copy fits
inside the button and result panel without clipping. The replay terminal has
137 sampled colors; its button, gold border, panel and backdrop are distinct.
The ordinary decision frame has 105 sampled colors and distinct selected,
unselected, panel and backdrop regions.

## Mutation strength

Both mutations ran only in isolated temporary worktrees and were removed
afterward.

| Mutation | Expected red result |
| --- | --- |
| Mock omits the required capability bit | Nonzero exit with `verify-tux-link-web: mock capability bits 0 omit required client bits 1` |
| Client exposes a replay URL without negotiating replay | Nonzero exit with `verify-tux-link-web: unnegotiated replay became available` |

The first proves that a stale or underspecified fixture cannot silently make
the client available. The second proves that the semantic null assertion—not
the obsolete substring test—detects an invented replay link.

## Repository and CI gates

The complete matrix below ran against the delivery changes, after which the
branch was rebased onto `origin/main` at `97edf718`. Typecheck, Link, ordinary
Web, Web chunks, desktop and PSP builds were rerun on that exact rebased tree.
A final fetch found the base revision still current. The delivery history is
linear, has no merge commit, uses `lfkdsk <lfkdsk@gmail.com>`, and leaves
`bun.lock` and both submodule pointers unchanged.

Preparation and static/data gates:

- PSP mainline snapshots: generated successfully.
- `bun run build` and `bun run build:wasm`: exit 0.
- `bun run import` twice: 5,077 files, 68,960,530 bytes, identical SHA-256
  `3c5a935486adb7a545c3bb2e8a0ef99cdaa15bd6d395f5bbe4b2cbdf1cd051ff`.
- `bun run verify:g6:determinism`: the two isolated imports were identical.
- `bunx tsc --noEmit`, `bun run check:l10n`, `bun run check:cjk` and
  `git diff --check`: exit 0.
- Full tests: 1,977 default-condition tests plus 9 browser-condition visual
  tests, 1,986 pass, 0 fail, 0 skip.
- The exact six CI test legs also passed independently: 55 + 12 + 361 + 9 +
  747 + 802 = 1,986 tests, 0 fail, 0 skip.

All 16 CI journey commands passed: GB6/J1/J2/J3/J4 mainline, golden sync,
defeat/recovery, lock execution, freeze scan, chapters, Chinese tape, Chinese
demo, English demo, save/resume, preview coverage and built-world replay. The
J4 terminal state stayed at
`1977c1b0f3bd1bba2c4e5ad82332599c4fc72f0acd84d9437868976fbfb5c736`.

The complete Web job passed in workflow order: Link verification, ordinary
build, opening journey, Chinese opening, demo controls, Arena replay,
expedition replay, keyboard/touch double battles and streamed audio. The extra
`verify:web:chunks` gate passed all 11 assertions and printed
`WEB CHUNKS PASS`. A fresh post-rebase `verify:web:link` passed both matches,
all six golden comparisons and the semantic pixel assertions.

The PSP job path also passed: toolchain bootstrap, warm
`build:psp --skip-assets`, real PPSSPP memory-stick save verification, release
`build:psp --skip-assets`, and a full `build:psp`. The save verifier completed
physical save/load field comparison, legacy raw-JSON migration, autosave
restart/continue, and the read-only-memory-stick negative case; it exited 0
with `ALL PHASES PASS`.

This change affects a Web-only verifier and browser-only UI hook, so no
QuickJS hot path exists to benchmark. The byte-identical portable outputs
below provide the stronger no-change check for desktop and PSP.

## Portable output preservation

Desktop base/current application outputs compared byte-for-byte. Their unique
hashes were:

| Artifact | SHA-256 |
| --- | --- |
| desktop JavaScript | `d886e2edf9249de0f39ecc2abdf22d7a0bbabbc818fceebff2413d5249f86ddb` |
| desktop pak | `852f5446799d18db066fd0832d1f82454475ccbcae722f6da1e7ae5709c74c88` |
| desktop native package | `6ed4edb773c27f0c7f5bab073463bb3fd2ffc7efe7454de4d119d8d6fd4d45c2` |
| audio attributions | `95476b249ba871d77dd16a69a717539ae0a59494d6cdc5bd1b1cf197fd1f49b7` |

PSP was rebuilt base then current in the same fixed worktree path, with the
generic host target cleaned between revisions. This removes absolute C build
path noise and made all eight retained application/host outputs byte-identical:

| Artifact | SHA-256 |
| --- | --- |
| `EBOOT.PBP` | `dad9e07c446389e2adb53ec5a1ddcfbc8d053cb7f0968d37c009684c1f05e730` |
| `pocket-tuxemon.prx` | `34015a9a2e88dbc8dac33333913b52306ce51c7b3a7ba56e3f3d484f740ca9b1` |
| `app.pocket` | `548b4caa170d9d369e45cab5ace3b196a5e7a4e638d307098caa9f45e488968f` |
| `assets.pak` | `a593e31889354a1ad63fd3c541401b3e1f3328bd0936c134e1cf72d30925b9ed` |
| `pocket-tuxemon.js` | `306d9cf68cdba6ab2452eeb3406f80c4405555d05d66d14d66c3d84a56f9f90b` |
| `pocket-tuxemon.pak` | `600ffede6c36076596d25e71f02a64fed6d8ad2615ed68d3ed9896a7dee4b17d` |
| `veil-logo.raw` | `5219ec9b8504bcc9c536e9c95d4ced3f7034bf2c913301fdb53227d609774280` |
| `AUDIO-ATTRIBUTIONS.md` | `95476b249ba871d77dd16a69a717539ae0a59494d6cdc5bd1b1cf197fd1f49b7` |

The first cross-worktree host comparison differed only because QuickJS C
objects embed their absolute Cargo `target/.../out` source path; the six game
payload/data files already matched there. Repeating the clean builds at one
path proved that neither the host nor the game artifact changed.

No task-started Chrome, verifier, PPSSPP or other background process remains.

subagent 使用：4 个 / protocol、verifier assertions、CI gates、docs/status 的只读并行审查 / 省下了交叉核对时间

PASS
