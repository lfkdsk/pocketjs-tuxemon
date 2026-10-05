# Architecture

This repository is a game, not an engine: it imports Tuxemon's world into
[rpgkit-project/v1](https://github.com/lfkdsk/pocketjs-rpgkit) documents and
runs them on the vendored Pocket RPG Kit runtime. Everything game-specific
lives here; everything reusable lives in the kit.

## Repository layout

| Path | Role |
|---|---|
| `gen-assets.ts` | Import entry point. `bun run import` runs this. |
| `importer/` | Tuxemon → rpgkit-project/v1 converters (see below). |
| `battle/` | The Tuxemon battle system: pure reducer, extension handlers, scene. |
| `ui/` | UI stage modules and generated asset tables. |
| `data/` | Generated JSON: terrain, battle database, journey tapes, golden manifests. All generated, all committed. |
| `assets/` | Generated art, committed: streamed terrain chunks (`stream/`), character walkers (`characters/`), animated-tile atlases (`anim/`), battle PNGs retained as preview/golden sources (`battle/`), and transcoded audio (`audio/`). |
| `tools/` | Verifies, benches, journey recorders, golden updaters, renderers. See [verification.md](verification.md). |
| `tests/` | The test suite (52 files) plus `tests/goldens/` (PNG keyframes and gzipped trace fixtures). |
| `main.tsx` | Game entry: mounts the kit's `GameView` with the project shell, map repository, extensions, battle rules and scene. |
| `pocket.json` | PocketJS app manifest (viewport 480x272, entry `main.tsx`, engine capabilities). |
| `web.json` | Web-site card metadata (title, intro, controls, preview). |
| `pak.json`, `images.json`, `sprites.json` | Generated manifests consumed by PocketJS's pak builder. |
| `reports/G1-coverage.md` | The committed import coverage report. See [importer.md](importer.md). |
| `vendor/pocket-rpgkit` | The kit submodule (with nested `vendor/pocketjs`). |
| `dist/` | Build output, gitignored: project shell, compact map shards (`maps/*.rkm`), indexed battle images (`battle-art/*.pkts`), battle/data shards, the JS bundle and the web site. |
| `findings/` | Research and milestone notes. Process documentation, not user docs. |

`bunfig.toml` pins the test root to `tests/` so `bun test` never walks into
the vendored suites.

### `importer/`

- `source.ts` — reads Tuxemon TMX maps and scenario YAML, mirroring Tuxemon's
  own event loader. `TUXEMON_SRC` defaults to the repo-local `.tuxemon-src`.
- `xml.ts` — minimal deterministic XML reader for TMX/TSX.
- `terrain.ts` — composites tile layers into CLUT8+RLE streamed chunks,
  collision and animation metadata.
- `project.ts` — the core event converter: Tuxemon actions/conditions to kit
  commands, plus the coverage recorder.
- `shapes.ts` — classifies an event's guard shape to pick the kit trigger.
- `characters.ts` — cooks Tuxemon's walkers into per-character sprite frames.
- `animated.ts`, `npc-src.ts` — split generated placements into lazy shards.
- `battle.ts` — imports the battle database, retains preview PNGs, and emits
  one CLUT8+PackBits TILESET entry per runtime battle image.
- `world.ts`, `world-schema.ts` — the diagnostic-rich outdoor-world topology index.
- `world-layout.ts` — the validated, compact runtime projection of that index.
- `time-weather.ts` — the game clock and weather state: versioned codec, the
  imported weather tables, and the argument shapes for the time/weather
  extension calls.
- `coverage.ts` — the coverage report builder.
- `index.ts` — library entry and report renderer.
- `png.ts` — build-time decoder for Tuxemon's palette PNGs.
- `battle-schema.ts` — runtime types for the generated battle database.

### `battle/`

- `core.ts` — deterministic, clock-free turn runner (JSON state in, JSON
  events out).
- `tuxemon.ts`, `stats.ts`, `progression.ts`, `spawn.ts` — damage, stats,
  XP/evolution, monster spawning.
- `runtime.ts` — adapts the reducer to the kit's `BattleRules` interface.
- `extension.ts` — registers the `tux.*` extension commands and conditions
  (see below).
- `presentation.ts` — projects battle state onto the scene; every pose is
  derived from the serialized event cursor and a 60 Hz reference tick.
- `production.ts` — lazy registration used by `main.tsx` (battle data loaded
  from shards). `game.ts` is the eager registration used by tools and tests.
- `autoplay.ts` — the deterministic autoplay policy used by journey tapes.
- `battle-repository.ts`, `from-battle-db.ts` — lazy shard provider and the
  importer-to-reducer adapter.

## Data flow

```
Tuxemon source (pinned checkout)
   |
   |  bun run import  (gen-assets.ts)
   v
terrain chunks + project conversion + characters + battle data + sharding
   |
   +--> committed: data/*.json, assets/**, ui/*-assets.ts,
   |                pak.json, images.json, sprites.json, reports/G1-coverage.md
   +--> gitignored: dist/project-shell.json, dist/maps/*.{rkm,json},
                    dist/battle-art/*.pkts, dist/battle/*,
                    dist/animated/*, dist/npc-src/*, dist/import-report.json
   |
   |  bun run build     (tools/build.ts: import, then bundle main.tsx)
   |  bun run web       (import, then the kit's static-site builder)
   v
dist/ bundle + pak, loaded by the desktop host or the web player
```

The import runs in this order: terrain, project conversion (all 263 maps,
events, NPCs, dialogue, shops, world index), terrain merge into the project,
character cook, battle data and art, NPC-src sharding, animated atlases, map
sharding, manifests, dist reports, and finally the coverage report and the
asset report. The game keeps `rpgkit-map/1` entries up to 128 KiB and uses
canonical JSON above that QuickJS decode-latency cap (currently 260 compact
and 3 canonical entries). Battle
images are normalized to the existing RGBA4444 display precision, then stored
as deterministic single-tile CLUT8+PackBits entries; the PNG copies are not
registered as eager runtime images. Two full imports into isolated roots must
be byte-identical (`bun run verify:g6:determinism`).

`bun run build` re-runs the import and then bundles the game with PocketJS's
builder for the desktop target. `bun run desktop` additionally prepares the
game-owned portable desktop layout: the target bundle lives in
`dist/linux-app` or `dist/macos-app`, and lazy files live under the matching
app id in `dist/runtime-data`. The launcher passes that tree to the host with
`--data-root`, on both Linux and macOS. `bun run web` re-runs the import and
builds the static site into `dist/web`. Building any target needs `TUXEMON_SRC`
available (or a repo-local `.tuxemon-src`).

At runtime, `main.tsx` loads the project shell and a lazy map repository
(desktop reads entries through the data-fs channel; web and consoles read
them from the pak). The repository recognizes the compact envelope and
reconstructs the ordinary `MapDef` before the engine sees it. Battle scene
images use one shared reference-counted cache: the first visible borrower
loads its `ui:tile.*#0` entry, multiple widgets share the handle, and leaving
the battle detaches every node before freeing its working set. Battle data,
NPC sprites and animated tiles remain separately sharded, so only entries the
session touches are read.

The QuickJS benchmark harnesses compile copied desktop-host crates with
`--no-default-features`, so performance gates do not require ALSA headers.
The interactive desktop launcher uses the kit's feature detector: it enables
the audio host when ALSA development metadata is available and otherwise
builds a silent desktop host.

## Audio pipeline

Music and sound effects are committed as transcoded blobs, not generated at
build time, so the import is byte-stable across ffmpeg versions:

1. `tools/music-catalog.ts` scans every map `play_music` action and every
   environment's battle/victory/defeat fields, then resolves exact slugs
   through Tuxemon's music database. `tools/fetch-tuxemon.sh` sparse-checks
   the resulting 24 music sources and the three used SFX from the pinned
   checkout.
2. `bun run transcode:audio` (`tools/transcode-audio.ts`) decodes each
   ogg/mp3 to s16 22.05 kHz mono and encodes music as QOA and SFX as WAV,
   writing `assets/audio/` with a manifest recording the ffmpeg version,
   frame count, duration, whole-track loop bounds and per-file SHA-256.
   `bun run verify:audio` performs two clean transcodes, requires byte-identical
   output, and independently parses every committed container and manifest row.
3. `gen-assets.ts` reads the manifest and registers each blob as a raw pak
   entry (`audio:qoa.*` / `audio:wav.*`); the importer's `Project.audio` table
   maps sanitized slugs to those keys. Web and PSP keep the payloads in their
   pak. The desktop launcher writes the 24 QOA keys under `data.fs` and repacks
   its startup pak without them, so the native host does not synchronously read
   22,481,712 B of music before compiling the bundle. Its staged reader copies
   at most one 64 KiB `data.fs` page on a frame where a requested file is still
   incomplete and neither map-entry settling nor world prefetch owns the
   frame; two settled confirmation frames after prefetch also stay clear. It
   owns at most one in-flight or
   ready file, rejects declarations above 4 MiB (about twice the largest
   shipped QOA), hands the completed buffer to the decoder once, and releases
   its staging reference immediately. The audio driver is replaced once when
   that requested file becomes ready, never once per frame. A paged-read error
   retries through the host's whole-file path; if both paths fail, the game
   records and logs the combined diagnostic instead of silently disabling all
   later music. The three small WAV effects remain in the pak for immediate
   one-shot cues.
   The per-file audio credits
   stay in every pak under `attribution:audio/AUDIO-ATTRIBUTIONS.md` and are
   also copied beside desktop, web and PSP package outputs for direct reading.
4. The importer maps `play_music` → `playBgm`, `fadeout_music` →
   `fadeoutBgm`/`stopBgm`, `pause_music`/`unpause_music` → `pauseBgm`/
   `resumeBgm`, `play_sound` → `playSe`, and `music_playing` → `bgmPlaying`.
   Because the kit keeps `bgmPlaying` true until a fade completes while
   upstream clears `current_song` the moment `fadeout_music` starts,
   `fadeout_music` also sets a `sys.music_fading` switch (cleared by
   `play_music`) and the positive `music_playing` form excludes the fading
   window, so a guarded parallel page cannot re-trigger the fade every frame.
   The six authored map arguments that are not DB slugs still emit the command
   so the reducer tracks the state, but stay silent, matching upstream lookup.

`main.tsx` opts `GameView` in to the kit's `createAudioEffects`, which
bridges reducer audio intent to each host's PCM module. The web player feeds an
AudioWorklet; desktop uses CPAL when available and otherwise keeps time through
a silent sink; PSP has its own fixed-capacity mixer. Desktop sidecar loading is
incremental, while the QOA decoder itself streams a
bounded number of frames into those hosts. `bun run verify:web:audio` drives
three newly added map tracks in Chrome and checks decoded non-zero PCM, accepted
host frames, a running real-time context, the AudioWorklet and underruns.

The three environment battle/victory/defeat tracks are in the catalogue and
pak, but the current game battle adapter imports only environment graphics.
Selecting those tracks at battle start and at each outcome remains separate
battle-lifecycle work.

## Game extensions: the `tux.*` namespace

The kit's event vocabulary covers the RPG-Maker-style commands (35 ops and 10
condition kinds at the current pin, plus the `ext`/`extChoice` escape hatches
and the `battle` op). Tuxemon-specific behavior that has no kit equivalent
lives in this repository as namespaced extension calls, all registered in one
place: `createTuxemonExtensions` in `battle/extension.ts`. The kit enforces
dotted, namespaced call names and dispatches `ext` conditions and commands to
the registered handlers.

| Call | Kind | What it does |
|---|---|---|
| `tux.add_monster` | command | Adds a monster (slug or enum-variable reference) to the player party or an NPC party, with kennel overflow handling. |
| `tux.set_monster_health` | command | Sets a player monster's HP (full, fraction or points); zero faints it. |
| `tux.set_monster_status` | command | Sets or clears a named imported status condition. |
| `tux.evolution` | command | Evolves the party monster flagged as waiting to evolve. |
| `tux.cancel_evolution` | command | Clears the pending-evolution flag. |
| `tux.set_environment` | command | Sets the active battle backdrop. |
| `tux.tick_time_weather` | command | Advances the saved clock by one active 60 Hz reference tick, applies due weather transitions, and publishes daylight-stage changes. |
| `tux.update_time` | command | Writes Tuxemon's eight derived calendar variables from the saved clock. |
| `tux.set_faint_point` | command | Stores a character's recovery destination. |
| `tux.prepare_faint_transfer` | command | Heals the party if standing on the healing faint point, and writes the faint-teleport target. |
| `tux.check_evolution` | condition | A party monster is waiting to evolve. |
| `tux.environment_is` | condition | The active environment equals the argument. |
| `tux.time_is` | condition | Compares the saved calendar by number, string or month/day tuple, including daytime, stage, weekday, season and leap year. |
| `tux.has_faint_point` | condition | The character has a stored faint point. |
| `tux.faint_point_is_map` | condition | The faint point is on the given map. |
| `tux.party_size` | condition | Compares party size with an operator and value. |
| `tux.has_monster` | condition | The party contains a species. |
| `tux.create_kennel` | command | Creates a saved player box (hidden flag, capacity); an existing box is left as is. |
| `tux.set_kennel_visible` | command | Shows or hides a named player box. |
| `tux.kennel` | condition | A player box exists, is visible, or is hidden. |
| `tux.has_kennel` | condition | Compares one box's monster count; a missing box fails both `is` and `not`. |
| `tux.char_defeated` | condition | Every party monster is at 0 HP. |
| `tux.battle_outcome` | condition | Battle history contains a fighter/opponent/outcome triple. |
| `tux.battle_outcome_count` | condition | At least N matching battle-history entries. |

Every condition also accepts `negate: true`. The importer emits these calls
when converting the corresponding Tuxemon actions and conditions; see
[importer.md](importer.md). Extension state has a packed-string runtime
representation and a versioned save codec, so the clock, weather
cursor/deadline, parties and battle history all survive saves and rewinds.
The production effect shell samples local wall time once when creating a fresh
game; reducers and renderers never read it.

## The component repo boundary

`vendor/pocket-rpgkit` is a separate, reusable repository: the pure-TS engine
(event interpreter, sessions, tile movement, saves, battle scene plumbing),
the Solid UI (`GameView`, dialogs, the streamed chunk layer), the build-time
asset pipelines, the web site builder, and the `rpgkit-project/v1` schema.
This repository consumes it as a git submodule and contributes nothing back
into it by accident: game logic, content and art all live here. Its nested
`vendor/pocketjs` submodule provides the host runtimes (desktop, web, PSP),
the pak builder and the wasm core; the desktop launcher in `tools/desktop.ts`
drives PocketJS's builder directly.

### Upgrading the kit pointer

1. In the kit repository, land the change on its main branch.
2. Here, `git -C vendor/pocket-rpgkit fetch && git -C vendor/pocket-rpgkit checkout <new-commit>`, then commit the gitlink.
3. Re-run the full gate, because the engine interprets every imported event:
   - `bun run import` leaves `git status --porcelain` empty (the committed
     output is exactly what the importer produces);
   - `bunx tsc --noEmit`;
   - `bun run verify:g6:determinism`;
   - `bun run test`;
   - the maintained journeys: `bun run verify:gb6:mainline`,
     `bun run verify:j1:mainline`, `bun run verify:j2:mainline`,
     `bun run verify:j3:mainline`, `bun run verify:j4:mainline`,
     `bun run verify:gb6:failures`,
     `bun run verify:g6:locks`, `bun run verify:g6:frozen`;
   - `bun run web` plus `bun tools/verify-web-journey.ts` in headless Chrome;
   - the QuickJS benches (`bun run bench:g6:quickjs`,
     `bun run bench:gb6:quickjs`, `bun run bench:j3:quickjs`,
     `bun run bench:j4:quickjs`): the terminal
     state hashes must match the pinned tapes and frame budgets must hold.
4. If the import output changed, commit the regenerated files in the same
   change as the pointer bump.
