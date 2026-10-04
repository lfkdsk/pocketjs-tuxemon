// Every shipped audio file must be attributed correctly.
//
// Each of the 27 committed blobs is checked, file by file, against:
//   1. the Tuxemon sound/music DB (slug -> source file),
//   2. the summary table in licenses/AUDIO-ATTRIBUTIONS.md,
//   3. the verbatim upstream credits in licenses/TUXEMON-ATTRIBUTIONS.md.
// The VERIFIED table below pins the result so a mislabeled row (like the
// original coinecho=CC0/Click or sound_confirm=broumbroum errors) fails
// the gate instead of silently shipping wrong credits.

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { TUXEMON_SRC } from "../importer/source.ts";

const ROOT = resolve(import.meta.dir, "..");

interface Verified {
  file: string;
  work: string;
  artist: string;
  license: string;
  /** Substring that must appear in licenses/TUXEMON-ATTRIBUTIONS.md. */
  upstream: string;
}

const VERIFIED: Verified[] = [
  { file: "music/music_07_town.qoa", work: "07 - Town", artist: "AVGVSTA", license: "CC BY 3.0", upstream: "Generic 8-bit JRPG Soundtrack" },
  { file: "music/music_10_empire.qoa", work: "10 - The Empire", artist: "AVGVSTA", license: "CC BY 3.0", upstream: "Generic 8-bit JRPG Soundtrack" },
  { file: "music/music_18_nighttide_waltz.qoa", work: "18 - Nighttide Waltz", artist: "AVGVSTA", license: "CC BY 3.0", upstream: "Generic 8-bit JRPG Soundtrack" },
  { file: "music/music_adventure_begins.qoa", work: "The Adventure Begins 8-bit Remix", artist: "bart", license: "CC BY 3.0", upstream: "The Adventure Begins 8-bit Remix" },
  { file: "music/music_battle_loop.qoa", work: "JRPG_battle_loop", artist: "Yubatake", license: "CC BY 3.0", upstream: "JRPG Collection" },
  { file: "music/music_cathedral_theme.qoa", work: "JRPG_royalCourt_loop", artist: "Yubatake", license: "CC BY 3.0", upstream: "JRPG Collection" },
  { file: "music/music_chibi_ninja.qoa", work: "Chibi Ninja", artist: "Eric Skiff", license: "CC-BY-SA 4.0", upstream: "Chibi Ninja" },
  { file: "music/music_city_park.qoa", work: "back34", artist: "Tom Peter", license: "CC-BY-SA 3.0", upstream: "back34" },
  { file: "music/music_come_and_find_me.qoa", work: "Come and Find Me", artist: "Eric Skiff", license: "CC-BY-SA 4.0", upstream: "Come and Find Me" },
  { file: "music/music_discovery.qoa", work: "JRPG_discovery", artist: "Yubatake", license: "CC BY 3.0", upstream: "JRPG Collection" },
  { file: "music/music_dojo_theme.qoa", work: "Taking Poison", artist: "Trevor Lentz", license: "CC-BY-SA 3.0", upstream: "Taking Poison" },
  { file: "music/music_dragons_cave.qoa", work: "Stand With Us", artist: "Trevor Lentz", license: "CC-BY-SA 3.0", upstream: "Stand With Us" },
  { file: "music/music_fields_loop.qoa", work: "JRPG_fields_loop", artist: "Yubatake", license: "CC BY 3.0", upstream: "JRPG Collection" },
  { file: "music/music_gameover.qoa", work: "JRPG_gameOver", artist: "Yubatake", license: "CC BY 3.0", upstream: "JRPG Collection" },
  { file: "music/music_home.qoa", work: "All of Us", artist: "Eric Skiff", license: "CC-BY-SA 4.0", upstream: "All of Us" },
  { file: "music/music_jester_theme.qoa", work: "Jester Theme", artist: "Hydrogene", license: "CC0", upstream: "Jester Theme" },
  { file: "music/music_mystic_island.qoa", work: "JRPG_mysticIsle", artist: "Yubatake", license: "CC BY 3.0", upstream: "JRPG Collection" },
  { file: "music/music_mystic_island_reverse.qoa", work: "JRPG_mysticIsle_reverse", artist: "Yubatake", license: "CC BY 3.0", upstream: "JRPG Collection" },
  { file: "music/music_omnichannel.qoa", work: "JRPG_docks_loop", artist: "Yubatake", license: "CC BY 3.0", upstream: "JRPG Collection" },
  { file: "music/music_sphalian_theme.qoa", work: "Digital Native", artist: "Eric Skiff", license: "CC-BY-SA 4.0", upstream: "Digital Native" },
  { file: "music/music_the_princess.qoa", work: "JRPG_princess", artist: "Yubatake", license: "CC BY 3.0", upstream: "JRPG Collection" },
  { file: "music/music_the_wild_places.qoa", work: "Peasant Kingdom", artist: "Spring", license: "CC BY 3.0", upstream: "Peasant Kingdom" },
  { file: "music/music_town_theme.qoa", work: "JRPG_town_loop", artist: "Yubatake", license: "CC BY 3.0", upstream: "JRPG Collection" },
  { file: "music/music_win_battle_boss.qoa", work: "JRPG_winBattleBoss", artist: "Yubatake", license: "CC BY 3.0", upstream: "JRPG Collection" },
  { file: "sounds/japanese_temple_bell_small.wav", work: "Japanese Temple Bell Small", artist: "Mike Koenig", license: "CC BY 3.0", upstream: "Japanese Temple Bell Small" },
  { file: "sounds/sound_confirm.wav", work: "confirm.ogg", artist: "Kelvin Shadewing", license: "CC BY 3.0", upstream: "Kelvin Shadewing's Soundpacks" },
  { file: "sounds/coinecho.wav", work: "picked-coin-echo-2", artist: "NenadSimic", license: "CC BY 3.0", upstream: "picked-coin-echo-2" },
];

interface ManifestFile {
  slug: string;
  kind: "music" | "sfx";
  source: string;
}

function readManifest(): Record<string, ManifestFile> {
  const raw = JSON.parse(
    readFileSync(join(ROOT, "assets/audio/manifest.json"), "utf8"),
  ) as { files: Record<string, ManifestFile> };
  return raw.files;
}

/** Map slug -> source file from a Tuxemon DB directory's yamls. */
function loadSlugIndex(dbDir: string): Map<string, string> {
  const index = new Map<string, string>();
  if (!existsSync(dbDir)) return index;
  for (const name of readdirSync(dbDir).sort()) {
    if (!name.endsWith(".yaml")) continue;
    const text = readFileSync(join(dbDir, name), "utf8");
    for (const m of text.matchAll(/^- file: (.+)\n  slug: (\S+)/gm)) {
      if (!index.has(m[2]!)) index.set(m[2]!, m[1]!.trim());
    }
  }
  return index;
}

/** Parse the attribution markdown tables into file -> row text. */
function readAttributionRows(): Record<string, string> {
  const text = readFileSync(join(ROOT, "licenses/AUDIO-ATTRIBUTIONS.md"), "utf8");
  const rows: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const m = line.match(/^\|\s*`([^`]+)`\s*\|(.+)\|\s*$/);
    if (!m) continue;
    rows[m[1]!] = m[2]!;
  }
  return rows;
}

describe("audio attribution (B1)", () => {
  test("the readable attribution list travels in every pak", () => {
    const pak = JSON.parse(readFileSync(join(ROOT, "pak.json"), "utf8")) as Array<{
      key: string;
      file: string;
    }>;
    expect(pak.filter((entry) => entry.key.startsWith("attribution:"))).toEqual([{
      key: "attribution:audio/AUDIO-ATTRIBUTIONS.md",
      file: "licenses/AUDIO-ATTRIBUTIONS.md",
    }]);
  });

  test("the manifest ships exactly the 27 verified files", () => {
    const files = Object.keys(readManifest()).sort();
    expect(files).toEqual(VERIFIED.map((v) => v.file).sort());
  });

  test("every shipped file has a correct attribution row", () => {
    const rows = readAttributionRows();
    for (const v of VERIFIED) {
      const row = rows[v.file.split("/").pop()!];
      expect(row, `missing attribution row for ${v.file}`).toBeDefined();
      expect(row, `work wrong for ${v.file}`).toContain(v.work);
      expect(row, `artist wrong for ${v.file}`).toContain(v.artist);
      expect(row, `license wrong for ${v.file}`).toContain(v.license);
    }
  });

  test("every work is credited in the upstream attribution file", () => {
    const upstream = readFileSync(
      join(ROOT, "licenses/TUXEMON-ATTRIBUTIONS.md"),
      "utf8",
    );
    for (const v of VERIFIED) {
      expect(upstream, `upstream credit missing for ${v.file}`).toContain(v.upstream);
    }
  });

  test("manifest sources match the Tuxemon DB slug mappings", () => {
    const manifest = readManifest();
    const musicDb = loadSlugIndex(join(TUXEMON_SRC, "mods/tuxemon/db/music"));
    const soundsDb = loadSlugIndex(join(TUXEMON_SRC, "mods/tuxemon/db/sounds"));
    // The DB cross-check needs the pinned source checkout; the attribution
    // checks above do not, so skip gracefully when it is absent.
    if (musicDb.size === 0 && soundsDb.size === 0) return;
    for (const [rel, entry] of Object.entries(manifest)) {
      const db = entry.kind === "music" ? musicDb : soundsDb;
      expect(db.get(entry.slug), `DB mapping for ${entry.slug}`).toBe(entry.source);
    }
  });
});
