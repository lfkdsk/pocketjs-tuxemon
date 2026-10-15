# G24 — PSP memory-stick save E2E

## Verdict

The PSP save bridge was healthy. The failing verifier had drifted when the
START screen became a world menu: its tape confirmed the first row instead of
moving to **Save**, so no save command ever ran. The first bad game commit is
`b22534ed48c0b652258b25594bf2d18365bb9f28` (`feat(menu): integrate start
title and bag flows`), whose direct parent
`4d900bec3927fec30ad0545ec516b07724e19a7f` still passes the old verifier.

The verifier now drives the current menu, projects logical save names through
the real PSP app root, decodes both checksummed `PJSAVE1` records and legacy
raw JSON, and proves save, restart/load, legacy load, authored autosave, and a
visible write-failure path under pinned PPSSPPHeadless. English and Chinese,
source fallback and QJBC all complete a real save/restart/load/continue
roundtrip. The canonical five-phase E2E is a required PSP CI step. All local CI
commands, normal PSP packages, deterministic import, tests, and journeys pass
with zero failures and zero skips.

No PocketJS or Pocket RPG Kit source change was needed. Before this report-only
commit, the branch was four implementation commits ahead of
`origin/main@6e2d454b8c32dd0a0f26f5f0bea3f39cb380d1f5` and zero behind; it contains
no merge commit and does not change `bun.lock`.

## Diagnosis and bisect

The original failure reproduced on the task baseline:

```text
error: save/slot-1.json was not written to the memstick
```

An isolated first-parent boundary run gave:

| Revision | Menu behavior | Real PPSSPP result |
|---|---|---|
| `4d900bec3927fec30ad0545ec516b07724e19a7f` | START opened the old save screen | saved `spyder_paper_town@[11,9]`, frame 49, 13,712-byte decoded JSON; `ALL PHASES PASS` |
| `b22534ed48c0b652258b25594bf2d18365bb9f28` | START opened the integrated world menu | no slot file; verifier exited nonzero |

`git show` identifies the bad revision's only parent as the passing revision.
The old tape's first confirm selected the newly inserted leading row instead of
Save. The corrected button paths are:

- manual save: START, DOWN, CIRCLE, CIRCLE, CIRCLE;
- manual load: START, DOWN, DOWN, CIRCLE, CIRCLE.

This is verifier integration drift, not a storage regression. As a second
check, the PSP bridge files at pre-sync `862040bd` and current
`f1bbfb47fd07853df4bb8eb9222f01a5c3973f4d` are byte-identical:

| File | SHA-256 at both revisions |
|---|---|
| `hosts/psp/src/save.rs` | `2e17270c930bc6e3ac24f7bbe598dc46a9ef4fb9de564e29facf27e48c87b816` |
| `hosts/psp/src/save_core.rs` | `b185d8dbeff7dd842cf2458f50233b635e153e42e465de1e47010b05eaf77718` |
| `hosts/psp/src/ffi.rs` | `817a258996ff391da551de434bb9b7b4ad2a51d96d5702c3f50e5b526f84b08d` |

The sync-era commits named “resolve save paths,” “create the full save
directory chain,” and “make save replacement crash-safe” therefore did not
move the current branch onto a different bridge implementation.

Raw logs: `/var/tmp/fleet/4964/bisect-good-save.log` and
`/var/tmp/fleet/4964/bisect-bad-save.log`.

## Implementation

### End-to-end verifier

`tools/lib/psp-save-verify.ts` now owns five explicit phases:

1. `save`: boot, navigate the current menu, write slot 1, decode it, and retain
   the exact saved state;
2. `load`: restart the emulator, select slot 1, compare the loaded state
   field-by-field, require a complete marked/terminal profile, then run 30 more
   session frames;
3. `legacy`: replace the live framed record with the same complete raw JSON,
   restart, load, compare, and continue;
4. `autosave`: start from the last save-safe opening checkpoint, replay the
   authored suffix on PSP, require PSP itself to write `autosave.json`, restart
   through the Automatic Save row, compare, and continue;
5. `failure`: make the save directory read-only and require the localized
   failure menu, no slot file, and no crash.

Logical `save/slot-1.json` and `save/autosave.json` names are projected to
`<memstick>/PSP/COMMON/pocketjs/save/`. The observed manual slot was 3,951
physical bytes: a 16-byte `PJSAVE1` length/checksum header followed by a 3,935
byte JSON payload. It was read back after a fresh PPSSPP process, not from the
in-memory reducer state.

The CLI accepts the orthogonal selectors
`--lang=en|zh`, `--execution=bytecode|source`, and
`--phase=save|load|legacy|autosave|failure|all`. Source mode removes only the
PSP QJBC section and asserts the host trace says `source fallback (bytecode
absent)`; bytecode mode asserts `run: bytecode`. Chinese runs install the built
font archive into the emulated app root. A PPSSPP `TIMEOUT` marker is always an
error, even if the process status is otherwise acceptable. The default
emulator timeout is 420 seconds.

Custom verifier tapes now use the production host's bounded capture/bench exit
path. Booting from a seeded autosave checkpoint consumes one neutral host frame
before the authored suffix is delivered, so capture length and input alignment
remain exact.

### Autosave checkpoint

Replaying the whole traced 3,629-frame opening under PPSSPP repeatedly stalled
at emulator frame 3,050; raising the timeout did not change that boundary. The
final design derives, with the same production reducer and opening tape, the
last save-safe checkpoint before the authored autosave:

- authored autosave tape frame: 3,590;
- seeded safe checkpoint: 3,582;
- input replayed inside PSP: 8 authored frames.

The memstick is cleared before the run, and the seeded snapshot contains no
host save file. Consequently `autosave.json` can only be created by the real
PSP guest command during those eight frames. It decoded to 18,501 JSON bytes
at `spyder_paper_town@[14,1]`, interpreter frame 2,074. Restart/load reproduced
every field and continued for 30 session frames.

### Unit coverage and docs

`tests/verify-psp-save.test.ts` has 35 passing assertions covering phase
dispatch, current navigation, PSP path projection, framed and raw decoding,
checksum/truncation rejection, source-only packaging, complete terminal logs,
continuation, autosave boot suffixes, localized failure, and injected
inconsistencies. The focused command ended `35 pass / 0 fail`.

README and status/verification/CI docs now describe START → world menu →
Save/Load, the physical PSP path, raw-JSON compatibility, autosave semantics,
the source/QJBC bilingual E2E matrix, and the pinned local/CI command.

## Real PPSSPP results

PPSSPPHeadless is pinned to
`a2f4ce214f224c6c26b3319409ec50205ff8253d` (`a2f4ce2`). Every matrix cell
used a fresh memstick and separate emulator processes for save and load:

| Language | Execution trace | Saved state | Decoded JSON | Restart/load |
|---|---|---|---:|---|
| English | `run: bytecode` | `spyder_downstairs@[6,6]`, frame 115 | 3,935 bytes | exact + 30 frames |
| English | `run: source fallback (bytecode absent)` | `spyder_downstairs@[6,6]`, frame 115 | 3,935 bytes | exact + 30 frames |
| Chinese | `run: bytecode` | `spyder_downstairs@[7,6]`, frame 150 | 4,582 bytes | exact + 30 frames |
| Chinese | `run: source fallback (bytecode absent)` | `spyder_downstairs@[7,6]`, frame 150 | 4,582 bytes | exact + 30 frames |

All four logs end in `ALL PHASES PASS`:

- `/var/tmp/fleet/4964/matrix-en-bytecode.log`;
- `/var/tmp/fleet/4964/matrix-en-source.log`;
- `/var/tmp/fleet/4964/matrix-zh-bytecode.log`;
- `/var/tmp/fleet/4964/matrix-zh-source.log`.

The canonical bytecode run additionally passed legacy raw JSON, autosave, and
read-only failure. The failure run rendered `SAVE FAILED`, wrote no slot, and
did not crash. Its five-phase log ends `ALL PHASES PASS` at
`/var/tmp/fleet/4964/ci-psp.log`. A focused Chinese unit path separately pins
the localized `保存失败` title.

Compatibility conclusion: there was no PSP path migration. New and old saves
use the same `PSP/COMMON/pocketjs/save/` directory; new records use `PJSAVE1`,
and complete pre-envelope raw JSON remains directly readable without a copy or
rewrite migration.

## Mutation strength

Both mutations ran in isolated temporary worktrees against real PPSSPP and
were removed afterward:

| Mutation | Required observation | Result |
|---|---|---|
| remove the DOWN that selects Save | no guest save command reaches the bridge | exit 1, `save/slot-1.json was not written to the memstick` |
| project the verifier one directory too high (`PSP/COMMON`) | verifier must not accept a file outside the asserted app root | exit 1 while the actual file remained under `PSP/COMMON/pocketjs/save/slot-1.json` |

Evidence: `/var/tmp/fleet/4964/mutation-menu.log` and
`/var/tmp/fleet/4964/mutation-path.log`.

## CI gate

The existing PSP job now:

- pins and caches PPSSPPHeadless at the full revision above;
- installs/builds its headless host when the cache is cold;
- runs canonical `bun run verify:psp:save` with the real PSP SDK/runtime before
  publication;
- rebuilds the normal traceless PSP release after the instrumented verifier
  packages, preventing test artifacts from being uploaded;
- retains the existing release artifact set.

The job timeout is 75 minutes. PPSSPP setup and execution are deterministic and
non-optional, so this is a regular hosted CI gate rather than a documented
local-only check.

The prior default test command silently skipped six Solid browser-export
assertions. `bun run test` and the CI matrix now run the two visual files under
`--conditions=browser` and exclude them from the server-export shards. This is
why the final acceptance result is genuinely zero skip rather than merely zero
fail.

## Complete acceptance inventory

`bun tools/psp-mainline.ts snapshots` generated all eight required snapshots
before the test/journey gates.

| Gate | Result |
|---|---|
| `bunx tsc --noEmit` | exit 0 |
| focused PSP verifier tests | 35 pass, 0 fail |
| complete `bun run test` | 1,920 default + 9 browser = 1,929 pass, 0 fail, 0 skip |
| CI test matrix | 55 importer + 12 replays + 361 locks/battle/terrain + 9 browser + 746 + 746 rest; 0 fail, 0 skip |
| deterministic import | 2 isolated roots, 5,077 files, 68,960,530 bytes, SHA-256 `3c5a935486adb7a545c3bb2e8a0ef99cdaa15bd6d395f5bbe4b2cbdf1cd051ff` |
| translation/CJK | 11/11 localization checks; 2,644 fallback characters covered |
| CI journey matrix | all 16 commands passed |
| web job | build, journey, Chinese, demo, Arena, Expedition, double-input, and audio all passed |
| PSP job | toolchain bootstrap, pinned PPSSPP, five-phase E2E, traceless `--skip-assets` release, and full release all passed |

The four batch status files are all `0`:

```text
ci-test-matrix.status=0
ci-journey.status=0
ci-web.status=0
ci-psp.status=0
```

The maintained story terminals are unchanged:

- GB6: `748f84174b32011c4419588650a41d6c57c31c79d3f9e772fcc72b25c3bf9b80`;
- J4 after 230,322 frames:
  `1977c1b0f3bd1bba2c4e5ad82332599c4fc72f0acd84d9437868976fbfb5c736`;
- bootworld: 242 checkpoints across 230,322 frames.

The browser save-loaded frame and a 3× Chinese battle-menu frame were opened
at original resolution. The loaded world, success banner, Chinese glyphs,
cursor, health bars, and panel geometry are visible and correctly aligned; no
clipping, tofu, stale overlay, or scale artifact was observed.

Raw gate logs are retained under `/var/tmp/fleet/4964/`, notably
`full-test-noskip.log`, `ci-test-matrix.log`, `ci-journey.log`, `ci-web.log`,
`ci-psp.log`, and `determinism.log`. Generated PPSSPP packages and temporary
memsticks were deleted after evidence collection. A final exact process scan
found no PPSSPP or browser process owned by this task; unrelated browser
processes from another worktree were left untouched.

## Implementation commits

1. `213181ad` — `fix(psp): follow the current start menu in save verification`
2. `a6285295` — `test(psp): strengthen save roundtrip verification`
3. `c7e44cd7` — `test(psp): gate memory stick save roundtrips`
4. `1a15b528` — `test(ci): run browser visuals without skips`

All commits are authored by `lfkdsk <lfkdsk@gmail.com>` and contain no
co-author trailer.

subagent 使用：3 个 / Mencius 追查 PocketJS 路径历史，Hypatia 审计旧存档兼容性，Singer 核对 verifier 与 CI；只读并行调查缩短了定位时间，主代理复核全部结论并独立完成实现、PPSSPP 实跑、变异和门禁
PASS
