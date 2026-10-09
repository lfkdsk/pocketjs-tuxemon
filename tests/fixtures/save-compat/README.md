# Published-save compatibility fixtures

Each fixture is an unedited browser slot produced by the named game checkout,
its recorded RPG Kit submodule, and Tuxemon
`9e6258ff726b786040a267e8bdbbf037b560285e`. They are real full-game saves,
not hand-authored envelopes or toy projects:

- `main-4019a9b8/` preserves the older published content pair.
- `main-0fc1580c/` preserves the previous integration's content pair.
- `main-a19bc37b/` preserves the pre-residual main's content pair.
- `main-bbeef6b4/` is the main before the remaining outdoor seam lanes were
  promoted and carries the current mainline tape hash and continuation digest.

To reproduce a fixture, make a detached checkout of the named game commit with
recursive submodules, run `bun install --frozen-lockfile`, run the importer
with the pinned Tuxemon source, then run:

```sh
TUXEMON_SRC=<tuxemon-checkout> bun tools/generate-save-compat-fixture.ts <output-dir>
```

The tool replays `data/gb6-mainline-journey.json`, writes through
`takeSaveSnapshot` and `saveSlot` at the first recoverable frame at or after
frame 20, decodes it with `loadSlot`, and records the next recoverable frame at
least 240 frames later. `metadata.json` pins source revisions, tape and
envelope hashes, the save point, and the uninterrupted continuation digest.

The compatibility test reads both slot files verbatim through the current
game's slot API. It replays the immediate predecessor with the still-current
mainline tape; the older slot remains a byte-exact load-and-resave witness
because its historical tape was superseded. If a reviewed identity pair
changes, add a new fixture and reviewed pair; do not edit an existing
envelope's identity.
