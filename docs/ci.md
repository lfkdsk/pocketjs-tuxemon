# CI

CI is a single workflow, `.github/workflows/ci.yml`. Five jobs run in
parallel from the shared prepare action — `import`, `test` (ten matrix
legs), `journey` (seventeen matrix legs), `web` and `psp`, thirty runners in all —
and `deploy` publishes Pages once all but `psp` pass. The slowest journey leg
(`verify:chapters`, which re-bakes and suffix-replays every chapter) sets
the wall-clock. It runs on pushes to `main`, on pull requests, and on
manual dispatch.

## The prepare action

`.github/actions/prepare/action.yml` is the common setup every job uses:

1. install Bun and the Rust wasm target;
2. restore the wasm-core build cache and the pinned Tuxemon source cache;
3. fetch the pinned Tuxemon checkout (`.tuxemon-src/`) and point
   `TUXEMON_SRC` at it;
4. `bun install --frozen-lockfile`;
5. `bun run import`;
6. unless called with `build: "false"`, `bun run build` and
   `bun run build:wasm`.

The wasm core is a build artifact, not a checked-in file, which is why the
Rust toolchain and the build step are part of prepare.

## Jobs

### import — Import, typecheck and determinism

Prepare with `build: "false"`, then:

- `git status --porcelain` must be empty after the import: the committed
  project, maps, art and battle data are exactly what the importer produces
  from the pinned Tuxemon commit;
- `bunx tsc --noEmit`;
- `bun run verify:g6:determinism` — two imports into isolated roots must be
  byte-identical;
- `bun run check:l10n` and `bun run check:cjk` — the Chinese supplement is
  well formed and the baked subset covers every imported character.

### test — the suite in ten parallel groups

The suite is split into explicit groups of roughly a minute each, because
bun's own sharding cuts the sorted file list into contiguous runs and would
bunch the slow battle and replay suites together:

| Group | Files |
|---|---|
| `importer` | `tests/importer.test.ts` |
| `replays` | `tests/g7-repository.test.ts`, `tests/g6-golden.test.ts` |
| `locks, battle data and terrain` | `tests/g6-locks.test.ts`, `tests/battle-db-adapter.test.ts`, `tests/battle-golden.test.ts`, `tests/terrain.test.ts` |
| `browser UI visuals` | `tests/bag-menu-visual.test.ts`, `tests/start-menu-visual.test.ts` under the browser export condition |
| `locale production visuals` | `tests/locale-visual.test.ts` (50 exact production-render goldens in a bounded process) |
| `rest (a-d)` | every other test whose basename starts with `a` through `d` (52 files) |
| `rest (e-l)` | every other test whose basename starts with `e` through `l` (50 files) |
| `rest (m-r)` | every other test whose basename starts with `m` through `r` (30 files) |
| `rest (s-t)` | every other test whose basename starts with `s` through `t` (39 files) |
| `rest (u-z)` | every other test whose basename starts with `u` through `z` (20 files) |

The former single `rest` process reached 11.5 GiB resident memory on
a 16 GiB runner. Continued production-render growth later pushed both old
alphabetic halves beyond a 14 GiB test budget, so they now use five bounded
ranges. The locale visual suite itself performs 50 production bundle/Wasm
boots and peaks at 8.4 GiB, so it has a dedicated process instead of sharing
one of those ranges. New test files land in one range
automatically — no workflow edit is needed.
If a new file is slow enough to deserve an explicit group, add it to that
group's `files:` list **and** to the exclusion grep in the same change, or
it runs twice.

Bun normally shares one realm across the files in a process. Tests that eval a
generated bundle must therefore restore every global property descriptor they
touch, including properties that were initially absent. Deterministic visual
fixtures also pass explicit fresh-game chapter globals and an explicit language
to every simulated boot. This keeps their goldens independent of file order;
`--isolate` is not required for correctness.

### journey — the maintained tapes

Seventeen parallel legs, one `bun run verify:*` script each (the table lists
the tape legs):

| Leg | Script | What it proves |
|---|---|---|
| Route 3 battle journey at 60 Hz | `verify:gb6:mainline` | the 116,107-frame mainline tape replays to the frozen terminal state with every map and battle checkpoint intact. |
| Captain-return journey from frame zero at 60 Hz | `verify:j1:mainline` | the J1 continuation, concatenated with the GB6 tape and replayed from frame zero, ends at the Captain's return. |
| Hospital-cure journey from frame zero at 60 Hz | `verify:j2:mainline` | the J2 continuation, concatenated with GB6 and J1 and replayed from frame zero (193,755 frames), ends with the hospital cure. |
| Radio-broadcast journey from frame zero at 60 Hz | `verify:j3:mainline` | the J3 continuation, concatenated with GB6, J1 and J2 and replayed from frame zero (211,745 frames), ends after 13 trainer wins, two wild wins and the Omnichannel Radio Tower broadcast. |
| Kernel-quest journey from J3 save and frame zero | `verify:j4:mainline` | the J4 continuation replays twice from its J3 production-save boundary, then all five segments replay from frame zero (230,322 frames) through 17 new wins, the seven correct terminal answers, Kernel and Billie's epilogue. |
| German complete journey matches English state | `verify:de:mainline` | the German dialog edges are transcribed in memory, then the complete 230,322-frame journey must match the English language-neutral reducer state at every campaign boundary and the endpoint. |
| Golden screenshot checkpoints match their tapes | `verify:goldens:sync` | every maintained screenshot checkpoint still names the exact reducer map, tile and frame from its authoritative tape. |
| Battle defeat and recovery journeys | `verify:gb6:failures` | both committed defeat tapes replay with their visible recovery order. |
| Every imported input lock is executed to its unlock | `verify:g6:locks` | every `lockInput` page releases its lock. |
| No permanent input lock or blocking fiber on any imported map | `verify:g6:frozen` | a corpus-wide stuck/lock scan over all 263 maps; an interpreter-liveness result, not a proof that a wanderer can never spatially block the player. |
| Chapter snapshots and thumbnails | `verify:chapters` | the twenty demo chapters re-bake byte-identical: save envelopes pass the kit's save validator, the 480×272 thumbnails match the committed PNGs, and every envelope restored and resumed at its timeline frame suffix-replays to the full-tape terminal state. |
| Chinese tape matches the English mainline | `verify:zh:tape` | the committed Chinese tape and chapter saves are exactly what transcribing the current English mainline produces; an edited English frame fails before the replay. |
| Chinese chapters and Autoplay in the built game | `verify:zh:demo` | the built game booted in Chinese restores every chapter and Autoplays three chapters to the reducer's Chinese state; the Chinese thumbnails match. |
| English demo tape matches the paginated mainline | `verify:en:demo` | the committed input-only demo follows the current production paginator and reaches the next node from every chapter save. |
| Save mid-journey, load, finish the tape | `verify:save` | five saves along GB6 (one run crossing noon) each restore to the live state and finish the tape at the uninterrupted terminal state hash. |
| Neighbour preview coverage at every chapter | `verify:preview:coverage` | sandboxed neighbour entry never rejects a mainline event or writes the live state. |
| Built game replays every checkpoint | `verify:bootworld:replay` | the production bundle, rather than a reducer-only harness, reaches every maintained mainline checkpoint. |

The full 60/30/20 Hz alignment, save/load and rewind checks stay in
`bun run verify:gb6:full`, `bun run verify:j1:full`, `bun run verify:j2:full`,
`bun run verify:j3:full` and `bun run verify:j4:full`
as release gates; they are too slow for every push. See [verification.md](verification.md).

### web — the site and a real browser

`bun run verify:web:link` first builds a loopback-only Link site and drives
two isolated browser profiles through both the required-capabilities-only and
optional-replay capability modes. It pins both viewports, both languages,
keyboard, touch, gamepad, reconnect, pending secrecy and the exact trusted
replay prefix. `bun run web` then replaces that development build with the
deployable, unconfigured static site in `dist/web`; this ordering prevents the
loopback service URL from reaching either uploaded artifact. Next, `bun run
verify:web:pwa` drives real Chrome through cold installation, a controlled
offline reload, save/load, a missing-map recovery dialog, interrupted and
resumed language-pack download, and an atomic two-release update. It also
checks the manifest's installability data, release/cache identity, semantic
dialog pixels and browser errors. Then,
`bun tools/verify-web-journey.ts` plays the opening journey (bedroom through
the first battle to Route 1) in headless Chrome against the built site,
comparing checkpoint states and framebuffer hashes against the committed
goldens; `bun tools/verify-web-zh.ts` plays the Chinese opening,
`bun tools/verify-web-demo.ts` exercises chapter selection, deep links and
autoplay through the complete Kernel endpoint, `bun run verify:web:arena`
loads same-origin and inline battle tapes, exercises bilingual replay controls,
checks both supported raster sizes and proves the normal page never requests
the lazy replay assets, and `bun run verify:web:audio` plays three imported
tracks. Any console error fails the run. The site is uploaded as the
`web-site` artifact (14-day retention), and the journey screenshots as
`web-journey`. The PWA verifier's JSON receipt and eight screenshots are retained
as `web-pwa` even when a later Web step fails. On pushes to `main` the site is
also staged as the Pages artifact.

### psp — the release package

Prepare with `build: "false"`, install the `llvm-18` package (the runner
image has clang but not `llvm-ar`, `llvm-ranlib` or `llvm-objcopy`) and point
`POCKETJS_LLVM_BIN` at `/usr/lib/llvm-18/bin`, restore PocketJS's
content-addressed PSP toolchain cache, and run the pinned bootstrap. The bootstrap installs and
verifies the PSP SDK checksum, Rust nightly and `cargo-psp` revision declared
by PocketJS. A second cache holds PPSSPPHeadless plus its assets at the exact
revision named in the workflow; a cache miss builds that revision from source
with the headless-only CMake configuration. `bun run verify:psp:save` then
drives the production START/Save/Load menus against an isolated memory stick,
checking a manual restart round-trip, continued play, the pre-envelope raw JSON
format, autosave restart and a visible read-only failure. The verifier creates
instrumented packages, so `bun run build:psp --skip-assets` runs afterwards to
restore the normal traceless release with bytecode-bearing `app.pocket` and its
seekable external asset archive. CI retains `EBOOT.PBP`,
`app.pocket`, `assets.pak`, the PSPLINK PRX and the build receipt as the
`psp-release` artifact for 14 days. This job does not
gate the Pages deploy.

### deploy — GitHub Pages

Runs only on pushes to `main`, after `import`, `test`, `journey` and `web`
(every matrix leg) have passed, and deploys the staged Pages artifact.

## Caches

The prepare action defines two caches:

- the wasm-core build, keyed on the wasm `Cargo.lock`, the engine `Cargo.toml`
  files and the wasm/core sources;
- the pinned Tuxemon source, keyed on `tools/fetch-tuxemon.sh` (the pinned
  commit lives in that script).

There is no dependency cache: `bun install --frozen-lockfile` is fast enough
that the lockfile is the cache key.

The `psp` job separately caches `~/.cache/pocket-nexus`, keyed by PocketJS's
PSP toolchain manifest. The cache contains the checksum-verified SDK and pinned
`cargo-psp` tools; the bootstrap remains the authority and validates a restored
cache before building.

## Reproducing a job locally

Common setup (Bun, the Rust wasm target, and the Tuxemon checkout):

```sh
git submodule update --init --recursive
bun install --frozen-lockfile
sh tools/fetch-tuxemon.sh .tuxemon-src   # or point TUXEMON_SRC at an existing checkout
export TUXEMON_SRC=.tuxemon-src
bun run import
```

Then, per job:

```sh
# import job
git status --porcelain                     # must be empty
bunx tsc --noEmit
bun run verify:g6:determinism
bun run check:l10n
bun run check:cjk

# test job (one group per line). Do not run the whole suite with
# `bun run test` in one process: a single Bun realm grows past the 14 GiB
# runner budget.
bun test tests/importer.test.ts
bun test tests/g7-repository.test.ts tests/g6-golden.test.ts
bun test tests/g6-locks.test.ts tests/battle-db-adapter.test.ts tests/battle-golden.test.ts tests/terrain.test.ts
bun test --conditions=browser tests/bag-menu-visual.test.ts tests/start-menu-visual.test.ts
bun test tests/locale-visual.test.ts
rest=$(ls tests/*.test.ts | grep -v -E '(importer|g7-repository|g6-golden|g6-locks|battle-db-adapter|battle-golden|terrain|bag-menu-visual|start-menu-visual|locale-visual)\.test\.ts$')
for range in a-d e-l m-r s-t u-z; do
  bun test $(printf '%s\n' $rest | grep -E "^tests/[$range]")
done

# journey job (one leg per line)
bun run verify:gb6:mainline
bun run verify:j1:mainline
bun run verify:j2:mainline
bun run verify:j3:mainline
bun run verify:j4:mainline
bun run verify:de:mainline
bun run verify:goldens:sync
bun run verify:gb6:failures
bun run verify:g6:locks
bun run verify:g6:frozen
bun run verify:chapters
bun run verify:zh:tape
bun run verify:zh:demo
bun run verify:en:demo
bun run verify:save
bun run verify:preview:coverage
bun run verify:bootworld:replay

# web job (needs Chrome or Chromium)
bun run verify:web:link # builds and verifies a loopback-only Link site
bun run web
bun run verify:web:pwa
bun tools/verify-web-journey.ts
bun tools/verify-web-zh.ts
bun tools/verify-web-demo.ts
bun run verify:web:arena
bun run verify:web:expedition
bun run verify:web:doubles
bun run verify:web:audio

# psp job (downloads the pinned toolchain and builds pinned PPSSPP on first use)
(cd vendor/pocket-rpgkit/vendor/pocketjs && bun run bootstrap)
PPSSPP_HEADLESS=/path/to/pinned/PPSSPPHeadless bun run verify:psp:save
# The E2E leaves an instrumented package behind; rebuild the release last.
bun run build:psp --skip-assets
```

The deploy job is a single GitHub Actions call and has no local equivalent.

## Adding a new long check

- **A new maintained journey:** add an entry to the journey matrix in
  `.github/workflows/ci.yml`:

  ```yaml
  - name: <human-readable name>
    run: bun run verify:<script>
  ```

  The script must exist in `package.json` and be self-contained. Nothing else
  in the workflow needs to change.
- **A new slow test file:** new files are picked up by one of the five `rest`
  ranges (`a-d`, `e-l`, `m-r`, `s-t`, `u-z`) automatically. If a file is too
  slow or too memory-hungry for its range (the groups are meant to stay around
  a minute each and well under the 14 GiB runner budget), move it to an
  explicit group's `files:` list and add its basename to the `rest` exclusion
  grep in the same commit.
