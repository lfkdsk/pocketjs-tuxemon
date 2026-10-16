import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseFontFile } from "../vendor/pocket-rpgkit/tools/lib/cjk-font.ts";
import { bakeAtlases } from "../vendor/pocket-rpgkit/vendor/pocketjs/framework/compiler/bake-font.ts";
import { readFontConfig } from "../vendor/pocket-rpgkit/vendor/pocketjs/framework/compiler/font-config.ts";
import { fontSlotFor } from "../vendor/pocket-rpgkit/vendor/pocketjs/framework/compiler/tailwind.ts";
import { atlasCodepoints, parseAtlas } from "../vendor/pocket-rpgkit/tools/preview/atlas-merge.ts";

const ROOT = resolve(import.meta.dir, "..");
const REQUIRED = "éèêëàâäçñüößãõíóúìòÉÈÊËÀÂÄÇÑÜÖẞÃÕÍÓÚÌÒ";

describe("Latin locale font coverage", () => {
  test("generated raw-payload inventory is wired into fonts.json", () => {
    const config = JSON.parse(readFileSync(resolve(ROOT, "fonts.json"), "utf8")) as {
      characterFiles?: string[];
    };
    expect(config.characterFiles).toContain("fonts/latin-charset.txt");
    const charset = readFileSync(resolve(ROOT, "fonts/latin-charset.txt"), "utf8");
    for (const scalar of REQUIRED) expect(charset).toContain(scalar);
  });

  test("both primary font slots or the licensed fallback map every generated scalar", () => {
    const inventory = JSON.parse(readFileSync(
      resolve(ROOT, "data/locale-characters.json"),
      "utf8",
    )) as { locales: Record<string, string>; union: string };
    expect(Object.keys(inventory.locales).sort()).toEqual([
      "de_DE", "es_ES", "fr_FR", "it_IT", "pt_BR",
    ]);
    const charset = readFileSync(resolve(ROOT, "fonts/latin-charset.txt"), "utf8");
    expect(charset).toBe(inventory.union);
    expect([...charset].filter((scalar) => {
      const point = scalar.codePointAt(0)!;
      return (point >= 0x3400 && point <= 0x9fff) ||
        (point >= 0xf900 && point <= 0xfaff) ||
        (point >= 0xff00 && point <= 0xffef);
    }), "Latin inventory must not include unreachable CJK/fullwidth copy").toEqual([]);
    const fontConfig = readFontConfig(resolve(ROOT, "fonts.json"));
    const fallbacks = fontConfig.fallbackTtfs.map((entry) => parseFontFile(
      typeof entry === "string" ? entry : entry.path,
    ));
    for (const face of ["Inter-Regular.ttf", "Inter-Bold.ttf"]) {
      const font = parseFontFile(resolve(
        ROOT,
        "vendor/pocket-rpgkit/vendor/pocketjs/assets/fonts",
        face,
      ));
      const missing = [...charset].filter((scalar) =>
        font.charToGlyphIndex(scalar) <= 0 &&
        fallbacks.every((fallback) => fallback.charToGlyphIndex(scalar) <= 0)
      );
      expect(missing, `${face} missing: ${missing.join(" ")}`).toEqual([]);
    }
  });

  test("the regular and bold runtime atlases contain every declared scalar", async () => {
    const charset = readFileSync(resolve(ROOT, "fonts/latin-charset.txt"), "utf8");
    const wanted = [...charset].map((scalar) => scalar.codePointAt(0)!);
    const fontConfig = readFontConfig(resolve(ROOT, "fonts.json"));
    const atlases = await bakeAtlases({
      codepoints: wanted,
      slots: [fontSlotFor(12, false), fontSlotFor(12, true)],
      fallbackTtfs: fontConfig.fallbackTtfs,
    });
    for (const atlas of atlases) {
      const mapped = atlasCodepoints(parseAtlas(atlas.bytes));
      const missing = wanted.filter((point) => !mapped.has(point));
      expect(missing, `slot ${atlas.slot} missing ${missing.map((point) => `U+${point.toString(16)}`).join(" ")}`)
        .toEqual([]);
    }
  });
});
