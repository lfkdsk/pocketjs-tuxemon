// Save language tagging: a save records the language it was written with,
// and a load in the other language is refused with a clear message.

import { describe, expect, test } from "bun:test";
import { snapshotLang } from "../ui/save-game.ts";
import { TUXEMON_EXT_SAVE_FORMAT } from "../battle/extension.ts";
import type { SaveSnapshot } from "../vendor/pocket-rpgkit/src/engine/save.ts";

function snapshotWithExt(ext: unknown): SaveSnapshot {
  return { ext } as unknown as SaveSnapshot;
}

describe("snapshotLang", () => {
  test("reads the language from the encoded extension envelope", () => {
    for (const lang of ["en_US", "zh_CN", "de_DE", "fr_FR", "es_ES", "it_IT", "pt_BR"] as const) {
      expect(snapshotLang(snapshotWithExt({ format: TUXEMON_EXT_SAVE_FORMAT, state: {}, lang }))).toBe(lang);
    }
  });

  test("defaults to en_US for saves written before the language was recorded", () => {
    expect(snapshotLang(snapshotWithExt({ format: TUXEMON_EXT_SAVE_FORMAT, state: {} }))).toBe("en_US");
    expect(snapshotLang(snapshotWithExt(null))).toBe("en_US");
  });

  test("legacy wrapped saves default to en_US", () => {
    expect(snapshotLang(snapshotWithExt({ format: "pocket-tuxemon/save-ext/v1", ext: {}, chars: {} }))).toBe("en_US");
  });

  test("rejects an explicit unsupported language instead of treating it as English", () => {
    expect(() => snapshotLang(snapshotWithExt({
      format: TUXEMON_EXT_SAVE_FORMAT,
      state: {},
      lang: "xx_XX",
    }))).toThrow("save content language is unsupported");
  });
});
