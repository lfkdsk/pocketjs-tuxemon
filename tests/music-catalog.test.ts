import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { buildMusicCatalog } from "../tools/music-catalog.ts";
import { TUXEMON_SRC } from "../importer/source.ts";
import { audioTable } from "../importer/audio.ts";

const EXPECTED_CONTENT_SLUGS = [
  "music_07_town",
  "music_10_empire",
  "music_18_nighttide_waltz",
  "music_adventure_begins",
  "music_battle_loop",
  "music_cathedral_theme",
  "music_chibi_ninja",
  "music_city_park",
  "music_come_and_find_me",
  "music_discovery",
  "music_dojo_theme",
  "music_dragons_cave",
  "music_fields_loop",
  "music_gameover",
  "music_home",
  "music_jester_theme",
  "music_mystic_island",
  "music_mystic_island_reverse",
  "music_omnichannel",
  "music_sphalian_theme",
  "music_the_princess",
  "music_the_wild_places",
  "music_town_theme",
  "music_win_battle_boss",
];

const EXPECTED_UNRESOLVED = [
  "Come and Find Me.ogg",
  "legend_bofie/all-the-tea-in-china.mp3",
  "lunar_joyride.mp3",
  "music_come_find_me",
  "music_dizzy_spells",
  "music_valor_heroes",
];

describe("content music catalogue", () => {
  const catalog = buildMusicCatalog(TUXEMON_SRC);
  const manifest = JSON.parse(
    readFileSync(resolve(import.meta.dir, "../assets/audio/manifest.json"), "utf8"),
  ) as { files: Record<string, { slug: string; kind: "music" | "sfx"; pakKey: string }> };

  test("finds all map and environment references", () => {
    expect(catalog.mapActionCount).toBe(200);
    expect(catalog.environmentReferenceCount).toBe(120);
  });

  test("resolves exactly the 24 content-backed music slugs", () => {
    expect(catalog.resolved.map((entry) => entry.slug)).toEqual(EXPECTED_CONTENT_SLUGS);
    expect(catalog.resolved.filter((entry) => entry.kinds.includes("map"))).toHaveLength(21);
    expect(catalog.resolved.filter((entry) => entry.kinds.includes("environment"))).toHaveLength(3);
    expect(new Set(catalog.resolved.map((entry) => entry.source)).size).toBe(24);
  });

  test("keeps the six upstream-invalid arguments unresolved", () => {
    expect(catalog.unresolved.map((entry) => entry.slug)).toEqual(EXPECTED_UNRESOLVED);
    expect(catalog.unresolved.reduce((sum, entry) => sum + entry.count, 0)).toBe(8);
  });

  test("the committed manifest covers every resolved content music slug", () => {
    const shipped = Object.values(manifest.files)
      .filter((entry) => entry.kind === "music")
      .map((entry) => entry.slug)
      .sort();
    expect(shipped).toEqual(EXPECTED_CONTENT_SLUGS);
    for (const entry of catalog.resolved) {
      expect(join("music", `${entry.slug}.qoa`) in manifest.files).toBe(true);
    }
  });

  test("manifest audio is exposed by Project.audio and packed exactly once", () => {
    const expected = Object.fromEntries(
      Object.values(manifest.files).map((entry) => [entry.slug, entry.pakKey]),
    );
    expect(audioTable()).toEqual(expected);

    const pak = JSON.parse(readFileSync(resolve(import.meta.dir, "../pak.json"), "utf8")) as {
      key: string;
      file: string;
    }[];
    const actualPak = pak
      .filter((entry) => entry.key.startsWith("audio:"))
      .map((entry) => [entry.key, entry.file])
      .sort(([a], [b]) => a! < b! ? -1 : a! > b! ? 1 : 0);
    const expectedPak = Object.entries(manifest.files)
      .map(([rel, entry]) => [entry.pakKey, `assets/audio/${rel}`])
      .sort(([a], [b]) => a! < b! ? -1 : a! > b! ? 1 : 0);
    expect(actualPak).toEqual(expectedPak);
  });
});
