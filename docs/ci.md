# CI

CI is a single workflow, `.github/workflows/ci.yml`. Five jobs run in
parallel from the shared prepare action — `import`, `test` (four matrix
legs), `journey` (fourteen matrix legs), `web` and `psp`, twenty-one runners in all —
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
  byte-identical.

### test — the suite in four parallel groups

The suite is split into explicit groups of roughly a minute each, because
bun's own sharding cuts the sorted file list into contiguous runs and would
bunch the slow battle and replay suites together:

| Group | Files |
|---|---|
| `importer` | `tests/importer.test.ts` |
| `replays` | `tests/g7-repository.test.ts`, `tests/g6-golden.test.ts` |
| `locks, battle data and terrain` | `tests/g6-locks.test.ts`, `tests/battle-db-adapter.test.ts`, `tests/battle-golden.test.ts`, `tests/terrain.test.ts` |
| `rest` | every other `tests/*.test.ts` (85 files), selected by an exclusion grep over the seven files above |

New test files land in `rest` automatically — no workflow edit is needed.
If a new file is slow enough to deserve an explicit group, add it to that
group's `files:` list **and** to the exclusion grep in the same change, or
it runs twice.

### journey — the maintained tapes

Fourteen parallel legs, one `bun run verify:*` script each (the table lists
the tape legs):

| Leg | Script | What it proves |
|---|---|---|
| Route 3 battle journey at 60 Hz | `verify:gb6:mainline` | the 110,244-frame mainline tape replays to the frozen terminal state with every map and battle checkpoint intact. |
| Captain-return journey from frame zero at 60 Hz | `verify:j1:mainline` | the J1 continuation, concatenated with the GB6 tape and replayed from frame zero, ends at the Captain's return. |
| Hospital-cure journey from frame zero at 60 Hz | `verify:j2:mainline` | the J2 continuation, concatenated with GB6 and J1 and replayed from frame zero (172,999 frames), ends with the hospital cure. |
| Radio-broadcast journey from frame zero at 60 Hz | `verify:j3:mainline` | the J3 continuation, concatenated with GB6, J1 and J2 and replayed from frame zero (185,929 frames), ends after 13 new trainer wins and the Omnichannel Radio Tower broadcast. |
| Kernel-quest journey from J3 save and frame zero | `verify:j4:mainline` | the J4 continuation replays twice from its J3 production-save boundary, then all five segments replay from frame zero (199,316 frames) through 14 new wins, the seven correct terminal answers, Kernel and Billie's epilogue. |
| Battle defeat and recovery journeys | `verify:gb6:failures` | both committed defeat tapes replay with their visible recovery order. |
| Every imported input lock is executed to its unlock | `verify:g6:locks` | every `lockInput` page releases its lock. |
| No permanent input lock or blocking fiber on any imported map | `verify:g6:frozen` | a corpus-wide stuck/lock scan over all 263 maps; an interpreter-liveness result, not a proof that a wanderer can never spatially block the player. |
| Chapter snapshots and thumbnails | `verify:chapters` | the twenty demo chapters re-bake byte-identical: save envelopes pass the kit's save validator, the 480×272 thumbnails match the committed PNGs, and every envelope restored and resumed at its timeline frame suffix-replays to the full-tape terminal state. |
| Chinese tape matches the English mainline | `verify:zh:tape` | the committed Chinese tape and chapter saves are exactly what transcribing the current English mainline produces; an edited English frame fails before the replay. |
| Chinese chapters and Autoplay in the built game | `verify:zh:demo` | the built game booted in Chinese restores every chapter and Autoplays three chapters to the reducer's Chinese state; the Chinese thumbnails match. |
| Save mid-journey, load, finish the tape | `verify:save` | five saves along GB6 (one run crossing noon) each restore to the live state and finish the tape at the uninterrupted terminal state hash. |

The full 60/30/20 Hz alignment, save/load and rewind checks stay in
`bun run verify:gb6:full`, `bun run verify:j1:full`, `bun run verify:j2:full`,
`bun run verify:j3:full` and `bun run verify:j4:full`
as release gates; they are too slow for every push. See [verification.md](verification.md).

### web — the site and a real browser

`bun run web` builds the static site into `dist/web`, then
`bun tools/verify-web-journey.ts` plays the opening journey (bedroom through
the first battle to Route 1) in headless Chrome against the built site,
comparing checkpoint states and framebuffer hashes against the committed
goldens; `bun tools/verify-web-demo.ts` then exercises chapter selection,
deep links and autoplay through the complete Kernel endpoint, and the same
chapter buttons and 600-frame Autoplay in Chinese (`?lang=zh`). Any console error
fails the run. The site is uploaded as the
`web-site` artifact (14-day retention), and the journey screenshots as
`web-journey`. On pushes to `main` the site is also staged as the Pages
artifact.

### psp — the release package

Prepare with `build: "false"`, install the `llvm-18` package (the runner
image has clang but not `llvm-ar`, `llvm-ranlib` or `llvm-objcopy`) and point
`POCKETJS_LLVM_BIN` at `/usr/lib/llvm-18/bin`, restore PocketJS's
content-addressed PSP toolchain cache, and run the pinned bootstrap. The bootstrap installs and
verifies the PSP SDK checksum, Rust nightly and `cargo-psp` revision declared
by PocketJS. `bun run build:psp --skip-assets` then consumes the import already
produced by prepare and builds the release EBOOT with its seekable external
asset archive. CI retains `EBOOT.PBP`, `assets.pak`, the PSPLINK PRX and the
build receipt as the `psp-release` artifact for 14 days. This job does not
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

# test job (one group per line, or run the whole suite with `bun run test`)
bun test tests/importer.test.ts
bun test tests/g7-repository.test.ts tests/g6-golden.test.ts
bun test tests/g6-locks.test.ts tests/battle-db-adapter.test.ts tests/battle-golden.test.ts tests/terrain.test.ts
bun test $(ls tests/*.test.ts | grep -v -E '(importer|g7-repository|g6-golden|g6-locks|battle-db-adapter|battle-golden|terrain)\.test\.ts$')

# journey job (one leg per line)
bun run verify:gb6:mainline
bun run verify:j1:mainline
bun run verify:j2:mainline
bun run verify:j3:mainline
bun run verify:j4:mainline
bun run verify:gb6:failures
bun run verify:g6:locks
bun run verify:g6:frozen
bun run verify:chapters
bun run verify:save

# web job (needs Chrome or Chromium)
bun run web
bun tools/verify-web-journey.ts
bun tools/verify-web-demo.ts

# psp job (downloads the pinned toolchain on first use)
(cd vendor/pocket-rpgkit/vendor/pocketjs && bun run bootstrap)
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
- **A new slow test file:** new files are picked up by the `rest` group
  automatically. If a file is too slow for `rest` (the groups are meant to
  stay around a minute each), move it to an explicit group's `files:` list
  and add its basename to the `rest` group's exclusion grep in the same
  commit.
