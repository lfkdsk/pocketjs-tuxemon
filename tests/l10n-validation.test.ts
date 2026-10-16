import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  createTextCatalog,
  fuzzyMsgids,
  placeholdersMatch,
  UPSTREAM_LATIN_LANGS,
} from "../importer/l10n.ts";

const ROOT = resolve(import.meta.dir, "..");

describe("locale translation validation", () => {
  test("fuzzy parser handles single-line and multiline msgids", () => {
    const parsed = fuzzyMsgids(`# translator\n#, python-format, fuzzy\nmsgid "single"\nmsgstr "x"\n\n` +
      `#, fuzzy\nmsgid ""\n"multi "\n"line"\nmsgstr "x"\n`);
    expect([...parsed].sort()).toEqual(["multi line", "single"]);
  });

  test("placeholder multiplicity and authored newline shape must match English", () => {
    expect(placeholdersMatch("{name} has {count}\\nReady", "{count}: {name}\\nPrêt")).toBeTrue();
    expect(placeholdersMatch("{name} has {count}", "{name} prêt")).toBeFalse();
    expect(placeholdersMatch("{name}\\nReady", "{name} Ready")).toBeFalse();
  });

  test("real rejected translations resolve to English and stay observable", () => {
    for (const lang of UPSTREAM_LATIN_LANGS) {
      const report = JSON.parse(readFileSync(
        resolve(ROOT, `dist/l10n-report.${lang}.json`),
        "utf8",
      )) as { invalidKeys: string[]; fallbackKeys: string[] };
      for (const key of report.invalidKeys) expect(report.fallbackKeys).toContain(key);
      const catalog = createTextCatalog(lang);
      if (lang !== "de_DE") {
        const resolved = catalog.get("player_wallet");
        expect(resolved).toBe("${{name}}'s wallet: ${{money_formatted}}");
        expect(catalog.invalidKeys).toContain("player_wallet");
        expect(catalog.fallbackKeys).toContain("player_wallet");
      }
    }
  });
});
