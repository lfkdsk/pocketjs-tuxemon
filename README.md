# Pocket Tuxemon

[Tuxemon](https://github.com/Tuxemon/Tuxemon)'s world — its maps, events,
characters and dialogue — imported into
[Pocket RPG Kit](https://github.com/lfkdsk/pocketjs-rpgkit) and played on
[PocketJS](https://github.com/pocket-nexus/pocketjs) (desktop, web, PSP).

Work in progress. The importer reads a pinned Tuxemon checkout
(`bun run fetch:tuxemon`, commit `9e6258ff`) and writes
`rpgkit-project/v1` documents and baked art into this repository.

<p align="center">
  <img src="docs/screenshots/paper-town.png" width="480" alt="Paper Town, imported from Tuxemon and running on Pocket RPG Kit">
  <img src="docs/screenshots/route-1.png" width="480" alt="Route 1">
</p>

## Status

The per-system checklist is in [docs/status.md](docs/status.md); the
summary:

- **World (P1, playable):** all 263 Tuxemon maps and their 4,572 events are
  imported automatically — terrain with one-way ledges, animated tiles, tall
  NPC walkers, dialogue, cutscene routes and map transfers. The Spyder
  campaign plays from the bedroom through Paper Town, Cotton Town, City Park,
  the north end of Route 3, Route 4 and Flower City to the Captain's return
  in the Mansion and on through Candy Town, the hospital cure and Omnichannel
  Radio Tower broadcast, then across Routes E and B to the Data Center and
  Kernel's defeat — the complete 206,818-frame Spyder mainline at 60 Hz,
  driven by
  deterministic autoplay tapes — and every imported input lock is executed
  to its unlock. On the 67 placed outdoor maps, the streamed renderer paints
  neighbouring ground, upper layers and animated tiles across authored seams,
  with map, texture-shard and NPC-art caches bounded to the current world
  working set. The project now opts into `seamless-v1`: all 258
  coordinate-preserving outdoor openings plus the coordinate-continuous lane
  of 25 fixed-destination openings cross atomically in eight ticks with no
  fade (283 portal IDs total). The other 50 lanes in those wide openings keep
  their authored funnel landing and fade; 65 wholly legacy outdoor portals,
  plus indoor, faint and story transfers, also keep their legacy transition.
  Neighbouring maps preview statically decidable
  NPCs, and a completed handoff saves a frozen snapshot of the map just left
  so actors behind the player do not jump back to their entry poses.
- **Battles (P2, complete):** the battle database and 590 battle
  textures are imported from Tuxemon's YAML, and `battle/` is a pure
  reducer whose results match Tuxemon's own Python engine on 8,560 recorded
  battles; monsters spawn draw-for-draw like Tuxemon's. The mainline is
  played for real end to end: the autoplay tapes fight 212 player battles
  (111 on the Route 3 mainline — 22 trainer + 89 wild — 16 on the
  Captain-return continuation — 10 trainer + 6 wild — and 56 on the way to
  the hospital cure — 50 trainer + 6 wild — and 14 through Omnichannel and
  the Radio Tower — 13 trainer + 1 wild — and 15 on the Kernel quest —
  12 trainer + 3 wild), and every trainer
  battle enters Battle Processing and ends `won` with its `battle_outcome`
  written back. The frozen 32-minute 60 Hz tape (115,830 frames / 32 min 10 s)
  replays byte-identical at 60, 30 and 20 Hz, and both failure paths are
  verified — the first loss against Billie, and a later loss on Route 3
  with the faint-point teleport, the heal-before-leaving block and the
  nurse recovery. Double battles, capture, items, swapping and levelling
  are live. The battle scene uses the imported Tuxemon backgrounds,
  islands, trainers, monsters, HUD frames, status/party icons and
  technique strips; every slide, hit, HP/XP tween, faint and capture shake
  is driven by the reducer's rewindable reference tick rather than a wall
  clock. The 590 images are indexed single-tile entries, loaded on demand
  through one battle cache and detached/freed on exit.
- **Names and Tuxepedia:** the authored player- and monster-name prompts use
  saved, rewindable game scenes. Player prompts offer Tuxemon's gender-selected
  deterministic random-name pools; the same imported action also supports NPC
  targets, whose runtime names are visible through subsequent character-name
  dialogue tokens. Seen/caught status is persistent and monotonic;
  journal previews and the normal browser render monster details through the
  same indexed, lazily loaded battle-image shards as combat.
- **Performance:** each language uses 260 compact map shards plus 3 canonical
  JSON shards, occupying 5,348,762 B for English and 5,582,139 B for Chinese.
  The three event-heavy
  maps cross a 128 KiB compact-decode cap, trading a small amount of storage
  for bounded first-visit latency on QuickJS. Indexed battle art plus its lazy
  database occupies 3,516,960 B in the pak. The current bilingual Web game pak
  is 90,996,368 B, including English and Chinese content, CJK font atlases, all
  content-resolvable audio, its attribution list and demo data. The desktop
  launcher removes the 24 QOA music payloads (22,481,712 B) from that target's
  startup read: its pak is 55,559,552 B and those files retain their exact
  `audio:qoa.*` keys under the companion `dist/runtime-data` tree. The three
  small WAV effects remain packed for immediate one-shot playback; QOA files
  are copied from `data.fs` one 64 KiB page per frame before playback starts.
  Before compact
  maps and indexed battle art, an earlier English-only Web build was
  66,791,328 B. The all-image battle encoding is
  2,206,076 B on disk and 13,394,688 B if every PSM_T8 texture were decoded,
  but only the active battle working set is resident.

  On the desktop QuickJS host, the current fixed-CPU matrix starts five fresh
  processes per route and viewport. Under one-minute loads of 1.30–4.89, all
  completed GB6, hospital-to-radio J3 and two-pass outdoor-cache production
  frames stayed below the stricter 45 ms line; the worst QuickJS-plus-core CPU
  frame was 42.287 ms. That is 0.199 ms below the previous five-run maximum and
  0.371 ms above its three-run review maximum. Every cache-walk sample had zero
  second-pass native-node or texture growth. Shared-host startup remains
  unreliable: the unchanged 250 ms gate rejected both five-process GB6 groups
  before replay and four of five J3 480×272 starts, so separately labelled
  500 ms startup diagnostics supplied those production-frame distributions
  without being counted as startup passes. A separate post-merge closure ran
  five fresh short-English G6 and Chinese-smoke processes at each viewport with
  the default limits: all 20 passed, with 209.961 ms as the largest startup and
  32.787 ms as the largest production frame. Two same-core/storage-contention
  attempts failed startup at 308.911 and 282.272 ms and remain recorded; they
  do not change the longer GB6/J3 limitation above. A dedicated Cotton Town
  short-window gate now preserves the preceding outdoor-cache allocation
  history while avoiding a full mainline replay. Its latest three-process
  runs at each viewport stayed at or below 15.046 ms (480×272) and 16.045 ms
  (960×544), against a 45 ms limit. Cold/hot medians, exact startup counts,
  load ranges, bundle identities and attribution are in
  [the verification guide](docs/verification.md#the-quickjs-benches).
- **Import coverage:** 89.6% of Tuxemon action uses and 96.5% of condition
  uses map natively to kit commands; 97.7% / 97.2% are executable (native,
  degraded, or a deliberate placeholder). The full per-type breakdown is in
  [reports/G1-coverage.md](reports/G1-coverage.md).
- **Day/night:** a saved, rewindable calendar drives Tuxemon's time conditions
  and its real day/night event pages. Fresh games start from one local-clock
  sample; tests and journey replays pin 09:00. Dawn, day, dusk and night use a
  smoothly changing named tint, while weather has its own deterministic RNG
  and transition deadline.

## Screenshots

The world renders pixel-for-pixel like Tuxemon's own maps. Left: this
runtime; right: an independent render of the same Tuxemon TMX map, used as
the reference in the terrain tests (0 differing pixels).

![Taba Town: runtime and reference](docs/screenshots/taba-town-runtime-vs-reference.png)

Imported dialogue placement is visible at both supported viewport sizes: the
Maple flashback uses 0.8W×0.25H left/right corner windows, and its Chinese long
line continues onto a second page instead of clipping. See the
[480×272 and 960×544 captures](docs/screenshots/dialog-layout/).

The first trainer battle, played for real: Billie's Budaye against Nut,
with sprites, HUD and backgrounds imported from Tuxemon and the rules
running bit-exact with Tuxemon's own engine. The lower band is Pocket RPG
Kit's state-driven command/list UI; the screenshot is a nearest-neighbour
2× capture of its 480×272 logical scene.

<p align="center">
  <img src="docs/screenshots/battle.png" width="480" alt="The first trainer battle">
</p>

The mainline journey, played by the deterministic autoplay tape: Cotton Town
(left) and the north end of Route 3 (right), two frames from the Route 3
mainline.

<p align="center">
  <img src="docs/screenshots/cotton-town.png" width="480" alt="Cotton Town, a frame from the autoplay journey">
  <img src="docs/screenshots/route-3-end.png" width="480" alt="The north end of Route 3, a frame from the autoplay journey">
</p>

Safe outdoor openings now scroll directly into the neighbouring map. The two
contact sheets below show all eight crossing phases plus the landing frame for
a horizontal and vertical seam; each row is also captured at both supported
viewports in [docs/screenshots/world-seam](docs/screenshots/world-seam/).

<p align="center">
  <img src="docs/screenshots/world-seam/world-seam-crossings.480x272.contact-sheet.png" width="480" alt="Horizontal and vertical seamless outdoor crossings at 480 by 272">
  <img src="docs/screenshots/world-seam/world-seam-crossings.960x544.contact-sheet.png" width="480" alt="Horizontal and vertical seamless outdoor crossings at 960 by 544">
</p>

The same Paper Town checkpoint at fixed 09:00 and 21:00 starts. The night
frame is intentionally darker and bluer; the golden test verifies those
properties from the decoded pixels as well as pinning the PNG bytes.

<p align="center">
  <img src="tests/goldens/daylight-day.png" width="480" alt="Paper Town during the day">
  <img src="tests/goldens/daylight-night.png" width="480" alt="Paper Town at night with a blue tint">
</p>

## Play it

- **In a browser:** <https://lfkdsk.github.io/pocketjs-tuxemon/pocket-tuxemon/>
  (deployed from `main` after CI has played the opening browser journey on it).
- **From a CI run:** every push builds the web version. Open the
  latest [CI run](../../actions/workflows/ci.yml), download the `web-site`
  artifact, unzip it and serve the folder, e.g.
  `python3 -m http.server -d web-site 8000`, then open
  <http://localhost:8000/pocket-tuxemon/>.
- **Locally:** `bun run web`, then serve `dist/web` the same way; or
  `bun run desktop` for the desktop host.
- **Browser keys:** arrows walk, `A`/`Z`/`Enter` talks and confirms, `B`/`Esc`
  goes back, `Space` (START) opens the save menu, and `L`/`Q` rewinds three
  seconds.
- **Desktop-host keys:** arrows walk, `X`/`Backspace` talks and confirms,
  `Z`/`Enter` goes back, `A` is SQUARE, `S` is TRIANGLE, `Space` is START,
  and `L`/`Q` rewinds. A host regression test pins this legacy desktop map.

### Saving and loading

Press START (`Space` in the browser and on desktop) to open the save menu. The
world is paused while the menu is open.

- **Save to slot / Load from slot:** three slots. The desktop build writes
  `save/slot-1.json` … `save/slot-3.json` in the app's data folder. The browser
  build keeps them in the page's local storage.
- **Automatic Save:** a read-only slot separate from the three manual slots.
  The six imported story commands write `save/autosave.json` on desktop, an
  app-scoped local-storage key in the browser, and `save/autosave.json` on
  the PSP memory stick; loading resumes immediately after the autosave
  command. A recoverable command tick, including one with a text, choices
  or shop modal, is published immediately; an unrecoverable tick such as an
  active transfer, battle or scene is deferred to the first safe reference
  tick. Focused reducer/host tests cover all six authored boundaries, the
  maintained production tape crosses four of them once, and `verify:psp:save`
  crosses the Paper Town point under PPSSPPHeadless and restarts into it.
  A missing automatic save is omitted; a storage read error stays visible as
  a damaged Automatic Save row and reports a load failure when selected.
- **Save code (export) / Load code (import):** the same save as URL-safe text,
  paged on screen. Every target keeps these two rows as a fallback. Codes are
  compressed, but still a few thousand characters
  (3,740–5,644 at the `verify:save` code points; 3,657 in the documented screenshot),
  so they suit copying between tools more than typing on the on-screen
  keyboard. Additive project-schema upgrades change the encoded text, but the
  runtime accepts compatible older schema identities and rewrites the next
  save under the current identity.

You can save manually only when nothing is in progress. During dialogue, a
battle, a scripted scene, a map change or a step, the menu says why it can't save.
Damaged saves, saves from another build of the game and empty slots show an
error and leave the game as it was. A load picks up exactly where the save was
made; `bun run verify:save` checks this at five points along the GB6 mainline.

Screens: [menu](docs/screenshots/save/save-menu.480x272.png),
[saved](docs/screenshots/save/save-done.480x272.png),
[refused](docs/screenshots/save/save-refused.480x272.png),
[loaded](docs/screenshots/save/save-loaded.480x272.png),
[save code](docs/screenshots/save/save-code-export.480x272.png)
(960×544 versions alongside; `bun run screens:save` re-renders them from the
built game).

CI also plays the 3,500-frame opening journey — bedroom, Paper Town, the
first battle, Route 1 — in headless Chrome against the built site
(`bun tools/verify-web-journey.ts`) and checks every checkpoint's state and
pixels against the goldens.

## Chinese version (中文版)

The game ships with a Simplified Chinese (zh_CN) build alongside English.
Text is resolved from the reviewed corrections in
`l10n/zh_CN/overrides.po`, then the upstream Tuxemon zh_CN community catalog,
the project's machine-translated supplement (`l10n/zh_CN/supplement.po`), two
importer labels, and finally the English source. Every one of the 5,370 English
strings has a Chinese rendering. The complete 2,098-entry upstream review is
recorded in `l10n/zh_CN/upstream-review.jsonl`; corrections retain their review
category, reason and the exact English source snapshot. Punctuation is
normalized to Chinese convention next to CJK text. The Noto Sans CJK subset
covering exactly the characters the Chinese build uses — catalog text, the
runtime resolver tables (map descriptions, battle names) and the game-drawn
strings — is baked into the font atlases at build time.

The Chinese project shell, battle shell, battle-name table, map descriptions
and month names are raw pak entries rather than JavaScript literals. Web and
console builds read them from the pak, while desktop stages the same keys in
`data.fs`; they are decoded, parsed and cached only when a Chinese boot is
selected. An English boot does not read or parse any of those five documents. Chinese map shards use the same
128 KiB compact-decode cap as English, so the three oversized event-heavy maps
are stored as canonical JSON in both languages.

- **Web:** open the player with `?lang=zh`
  (<https://lfkdsk.github.io/pocketjs-tuxemon/pocket-tuxemon/?lang=zh>), or
  press **R** in the game to open the language switcher. The choice is
  remembered in the browser, and the page reloads without the `lang`
  parameter so the stored choice wins on the next boot (priority: URL
  parameter > stored choice > English).
- **Desktop:** `bun run desktop -- --lang zh` (or `--lang en`). The in-game
  **R** switcher writes the choice to the app's data folder and asks for a
  restart.
- **Default:** English. The Chinese project supplies all 85 kit-owned
  interface strings: button hints, shop chrome, save pages and their
  success/failure/loading results, name input and
  its on-screen keyboard actions, demo chrome and errors, the event-error
  screen, and battle HP values. Missing future kit keys fail the importer
  instead of silently falling back to English. Game content — dialogue,
  choices, items, monsters, moves, battle menus, storage and daycare scenes
  — uses the separate Chinese catalog described above.

Saves record the language they were written with. Loading a save from the
other language shows a bilingual "LANGUAGE MISMATCH / 语言不匹配" prompt
(which language the save is in, how to switch) before any content check,
instead of an "another build" error. The demo menu (SELECT), the chapter
buttons and Autoplay work in Chinese too. The Chinese build replays its own
tape and restores its own chapter saves: `bun run record:zh:tape` folds the
English mainline in an English and a Chinese session side by side, keeps the
English masks outside dialog boxes, rewrites only the confirm presses a
Chinese box needs (an extra page, a shorter or longer page; none are needed
today), and saves each chapter from the Chinese session on the same frame as
the English chapter (`data/zh-mainline-journey.json`,
`data/chapters.zh_CN.json`, titles in `l10n/zh_CN/chapter-titles.json`).
Both sessions must hold the same state apart from their words at every
chapter, after every dialog and at the end, so a Chinese chapter never mixes
in English event text. `bun run verify:zh:tape` re-derives both files and
fails as soon as an English tape frame changes; `bun run verify:zh:demo`
boots the built game in Chinese and checks every chapter jump, Autoplay from
three chapters (`--autoplay=all`, `--full` for the whole tape) and the Chinese
chapter thumbnails. Only the bedroom thumbnail shows words, so it alone has a
Chinese copy (`docs/screenshots/chapters-zh_CN/`). If the English tape changes
and the Chinese one is not re-recorded, the import leaves the Chinese build
without chapters (SELECT stays dormant there) rather than ship a tape that
falls out of step. The Chinese
opening has its own short smoke tape (`data/zh-smoke-journey.json`),
replayed in headless Chrome by `bun run verify:web:zh`, which renders the
expected text from the baked font atlas and matches its glyph mask against
the screenshot (dialog lines, battle prompt and command labels), asserts
strict catalog-exact pagination, and runs a mutation suite
(`tools/verify-web-zh-mutants.ts`) proving each assertion catches the
regression it targets.
`bun run check:l10n` validates every catalog layer, correction annotation,
placeholder and escaped newline, and enforces the glossary against the final
merged text (with reasoned, key-specific exceptions). `bun run check:cjk`
verifies glyph subset coverage. `bun test tests/ui-text-zh-visual.test.ts`
boots the production bundle and pins the save menu, Chinese save-success and
save-failure pages, keyboard, demo, shop, button-hint, event-error and
battle-status frames at 480×272 and 960×544, including Chinese glyph-mask
checks. The generator also writes uncommitted nearest-neighbour 3× review
copies under `dist/ui-text-zh-review/`. The demo menu capture lists the Chinese
chapter titles.

Known limitations:
- Dynamic dialog templates resolve at runtime. The importer maps Tuxemon's
  `${{var:X}}` to the kit's `{v:v.X}` variable token and its
  `${{today}}`, `${{map_desc}}`, `${{monster_0_name}}`, `${{monster_0_level}}`
  and `${{money_formatted}}` templates to `{x:}` tokens answered by the
  game's resolver (`battle/text-tokens.ts`): the date comes from the
  deterministic in-session clock, the map description from the importer's
  `dist/map-descriptions(.zh_CN).json` table, the lead monster's name and
  level from the party, and money with Tuxemon's `$`-width-4 format. The
  project declares `system.textVariables` and the `system.textTokens`
  allowlist. The only `???` left are upstream's own 2 literal
  anonymous-speaker lines (`???: ...` in cotton_town), which the Chinese
  build renders with full-width punctuation; `tests/placeholder-parity.test.ts`
  pins both. Imported cathedral flows write `scoop_price`, `party_lost_hp`,
  `cathedral_share_full`, and `cathedral_interest_full` before displaying
  them; if any variable is read before its scenario action runs, the kit's
  unset-variable default is `0`.
- The battle menu is localized: root commands (Fight/Item/Forfeit/…), the
  technique/item/party submenus, monster names, and the battle narration all
  render in Chinese from the generated `data/battle-names.zh_CN.json` table.
  Map names on the welcome sign fall back to their slug when the catalog has
  no entry.
- **PSP ships in English and Chinese.** `bun run build:psp:zh` (see the
  [PSP](#psp) section below) builds the Chinese package: it keeps the zh_CN
  shards and the five Chinese startup documents and emits `font-archive.bin`,
  a 2bpp CJK glyph archive (~1.1 MiB, 2,446 chars × 6 strikes) the PSP reads
  on demand from the memory stick, capped at 256 resident glyphs per slot
  across six slots (~67 KiB). Without the archive installed on the memory
  stick every CJK glyph renders as tofu (the PSP section gives the path).
  Language is a build-time choice on PSP — no localStorage or data.fs to
  persist a switch — so the in-game language switcher stays hidden there.

## Web demo controls

The game has an in-game demo menu (**SELECT**) with three pages. The web
player's **Demo controls** panel below the game covers chapters and autoplay;
map warp is in the in-game menu, or use a `?map=` link (below).

- **Chapters** — twenty buttons from the new-game bedroom to the completed
  Kernel quest. Click one (or pick it in the menu) to restore that save and
  keep playing from there, without reloading the page. The active chapter
  stays highlighted.
- **Map warp** — jump to any of the 263 imported maps. Maps with a safe
  spawn (245 of them) land on a standable, event-free cell; the eighteen
  maps with no such cell are listed but show a visible error if picked.
- **Autoplay** — play the chapter's tape suffix automatically at 1×, 2× or
  4×. Any button takes over live play; **L** rewinds three seconds.

The same actions are available as deep links, so a specific scene can be
bookmarked or shared:

- `?chapter=<id>` — restore a chapter for live play (e.g. `?chapter=kernel-defeated`)
- `?map=<id>&x=<tile>&y=<tile>` — warp to a map (e.g. `?map=spyder_cotton_town&x=16&y=17`)
- `?autoplay=<id>&speed=<1|2|4>` — start a chapter on autoplay (e.g. `?autoplay=starter&speed=2`)

An invalid id (e.g. `?chapter=missing`) is a visible `BAD DEMO LINK` error,
not a crash. Chapter snapshots and the nibble-dictionary tape are packed into
the pak and read on demand, so the JS bundle keeps only a tiny chapter index;
the tape is decoded once, on the first chapter selection, and every chapter
plays a window of it. The committed chapter pack and all twenty thumbnails are
rebaked against the current 206,818-frame recording; every chapter envelope
passes decode, map-aware restore and suffix replay to the production terminal.
`bun tools/verify-web-demo.ts` drives all of the above in headless Chrome,
including a 600-frame autoplay that must reach a state byte-identical to a
reducer-level suffix replay, and checks that each chapter click repaints the
canvas with the new scene.

## Running

```sh
bun run setup           # submodules + dependencies
bun run fetch:tuxemon   # pinned Tuxemon checkout into .tuxemon-src
bun run import          # Tuxemon -> project, maps, art and battle data
bun run verify:audio    # reproduce every audio transcode twice and verify metadata
bun run build           # import + generic bundle into dist/
bun run build:wasm      # the wasm core (needs the Rust wasm32 target)
bun tools/desktop.ts --build-only  # prepare the desktop bundle, runtime-data sidecars and host
bun run desktop         # play on the desktop host
bun run web             # build the web version into dist/web
bun run verify:web:audio # stream three imported tracks in headless Chrome
bunx tsc --noEmit       # typecheck
bun run test            # the test suite (build first for the pixel replays)
bun run verify:g6:determinism   # two imports are byte-identical
bun run verify:gb6:mainline     # replay the Route 3 mainline tape
bun run verify:j1:mainline      # replay the Captain-return tape
bun run verify:j2:mainline      # replay the hospital-cure tape
bun run verify:j3:mainline      # replay through the Radio Tower broadcast
bun run verify:j4:mainline      # replay the complete mainline through Kernel
bun run bench:g6:quickjs        # short two-viewport QuickJS performance gate
bun run bench:gb6:quickjs       # full QuickJS journey, both viewports
bun run bench:gb6:quickjs:cold  # five fresh processes at each viewport
bun run bench:j3:quickjs        # hospital chapter -> radio, both viewports
bun run bench:j4:quickjs        # radio chapter -> Kernel, both viewports
bun run bench:j3:quickjs:cold   # five fresh processes at each viewport
bun run bench:indoor-fast-path  # production-entry indoor single-map probe
bun run bench:cotton:quickjs    # three fresh Cotton Town windows per viewport
bun run verify:world-cache      # visit all 67 outdoor maps twice at both viewports
bun run verify:world-cache:cold # five fresh cache walks at each viewport
bun run build:psp               # release EBOOT plus external asset pak
```

The importer reads the Tuxemon source from the repo-local `.tuxemon-src`
checkout that `bun run fetch:tuxemon` creates. To reuse an existing Tuxemon
checkout instead, set `TUXEMON_SRC` to its path (e.g.
`TUXEMON_SRC=/path/to/Tuxemon bun run import`).

## PSP

The PSP build keeps the complete resource archive beside the executable so
textures and map shards can be read by index instead of occupying the EBOOT.
The current build keeps all 263 maps, audio and battle art in a seekable
`assets.pak`; its small embedded boot pak holds only fonts, sprite atlases,
styles and the external archive index.

Install PocketJS's pinned, checksum-verified PSP SDK, Rust nightly and
`cargo-psp` once, then build the game:

```sh
(cd vendor/pocket-rpgkit/vendor/pocketjs && bun run bootstrap)
bun run build:psp
```

Copy `dist/psp/EBOOT.PBP`, `dist/psp/assets.pak` and the readable
`dist/psp/AUDIO-ATTRIBUTIONS.md` into the same directory on the memory stick.
`dist/psp/pocket-tuxemon.prx` is also emitted for PSPLINK
development. Linux builds use Clang against the pinned PSP sysroot; macOS uses
the pinned PSP GCC wrapper by default. Set `POCKETJS_PSP_C_COMPILER` to
`clang` or `gcc` to choose explicitly.

For the Chinese build, run `bun run build:psp:zh` instead. It additionally
emits `dist/psp/font-archive.bin`, a 2bpp CJK glyph archive the PSP reads on
demand from the memory stick. Copy it to `PSP/COMMON/pocketjs/font-archive.bin`
on the memory stick (the same `ms0:` tree the external `assets.pak` rides);
without it the Chinese build renders tofu for every CJK glyph. The English
build does not need the archive.

### Saving on PSP

START opens the save menu on PSP, with three manual slots and the read-only
Automatic Save row, just like desktop and web. Saves land on the memory stick
at `PSP/COMMON/pocketjs/save/` (`ms0:/PSP/COMMON/pocketjs/save/`):
`slot-1.json` … `slot-3.json` and `autosave.json`. Each new write is wrapped
in a length-and-checksum record, written to `.tmp`, closed, synced and read
back before rename. A valid live generation moves to `.bak`; when `.bak` is
the only valid old generation it stays untouched until the validated temp is
live. Reads validate live and fall back to a valid backup, so failure or power
loss at any write step leaves the old or new complete save readable. Deleting
a slot checks removal of both live and backup copies. A failed operation
(memory stick full or read-only) is reported in the menu instead of being
swallowed. A save is bounded to 1 MiB. The same files work in PPSSPP:
`--memstick=<dir>` maps `ms0:` to `<dir>`, so saves persist across emulator
restarts. `bun run verify:psp:save` drives the menu through a save, a
restart and a load under PPSSPPHeadless and checks the states match
field-by-field, plus the autosave point and the read-only failure path.

For a deterministic device or emulator check, build with
`bun run build:psp --journey` and run the bare `dist/psp/pocket-tuxemon.prx`
under PPSSPP (the journey `EBOOT.PBP` does not complete under PPSSPP — see
[docs/verification.md](docs/verification.md#psp-emulator-verification-manual-not-ci)),
then compare the completed session with a fresh production replay:

```sh
bun run verify:psp:emu          # builds nothing; runs the already-built .prx
```

The complete GB6+J1+J2+J3+J4 mainline (206,818 frames) runs under
PPSSPPHeadless as 28 bounded chapter-to-chapter segments: the no-argument
retained-evidence gate (`bun tools/psp-mainline.ts verify`) reports 28/28
PASS with no exemptions, each segment's receipt bound to its plan entry by
id, chapter, start frame, window length and end frame, with its terminal
state matching the desktop replay byte-for-byte. The PSP host's
generational QuickJS collector (a personal fork of `pocket-nexus/quickjs-rs`,
proposed upstream) bounds the longest single GC pause to 38.0 ms across the
whole mainline (6,878.8 ms total over 867 collections, down from 152.5 ms /
45,359.5 ms / 520 with the stock collector). Six same-moment
desktop/PSP framebuffer captures (bedroom, Paper Town, the first Billie
battle, the Route 1 seam, Cotton Town, the radio-tower segment) are
re-taken at a clean HEAD; five are byte-identical between desktop and PSP
and the battle is the same semantic moment with PSP rasterizer
differences in the background, status icons and text edges.
Emulator timings are not hardware results: the full mainline has not been
run on physical PSP. The only hardware data point is doodlewind's 333 MHz,
firmware 6.61 device run of an earlier build, which reported 43–60
displayed fps with map transitions and texture loads causing stalls.

## Documentation

- [Feature status](docs/status.md) — every Tuxemon system marked done,
  partial or planned, with what works and its limits.
- [Architecture](docs/architecture.md) — repository layout, import data
  flow, the `tux.*` game extensions, and how the kit submodule is upgraded.
- [Importer](docs/importer.md) — how Tuxemon events map to kit commands,
  the four coverage dispositions, and how to add a new mapping.
- [Verification](docs/verification.md) — the verify scripts, the journey
  tapes, golden images, and the multi-Hz / save-restore / rewind checks.
- [CI](docs/ci.md) — the CI jobs, how to reproduce them locally, and how to
  add a new journey or test group.

## License

Tuxemon's code is GPL-3.0-or-later and its art CC BY-SA; this port and
everything it derives from Tuxemon are distributed under the same terms.
Pocket RPG Kit (vendored at `vendor/pocket-rpgkit`) is MIT.

The full GPL-3.0 text is in [`LICENSE`](LICENSE). Tuxemon's per-asset credits
and licenses (for the maps, sprites, tilesets, battle art and dialogue this
repository imports) are copied verbatim from Tuxemon `9e6258ff` into
[`licenses/TUXEMON-ATTRIBUTIONS.md`](licenses/TUXEMON-ATTRIBUTIONS.md), with its
contributor list in
[`licenses/TUXEMON-CONTRIBUTORS.md`](licenses/TUXEMON-CONTRIBUTORS.md).
The imported music and sound effects carry their own upstream licenses
(CC0, CC-BY, CC-BY-SA); the per-file credits are in
[`licenses/AUDIO-ATTRIBUTIONS.md`](licenses/AUDIO-ATTRIBUTIONS.md). That list
is embedded in every pak and copied beside desktop, web and PSP packages.
The weather particle textures are procedurally generated by this project
(no upstream art); their provenance and license are recorded in
[`licenses/WEATHER-TEXTURES.md`](licenses/WEATHER-TEXTURES.md).
