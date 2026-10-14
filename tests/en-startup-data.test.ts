import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  createEnStartupDataStore,
  EN_STARTUP_DATA_ENTRIES,
} from "../ui/en-startup-data.ts";

const ROOT = resolve(import.meta.dir, "..");
const FILES: Record<string, string> = {
  [EN_STARTUP_DATA_ENTRIES.project]: "dist/project-shell.json",
  [EN_STARTUP_DATA_ENTRIES.battleShell]: "dist/battle-runtime-shell.json",
};

describe("raw English startup shells", () => {
  test("reads each shell once and reuses the parsed documents", () => {
    const store = createEnStartupDataStore();
    const reads: string[] = [];
    expect(store.current()).toBeNull();

    const first = store.load((entry) => {
      reads.push(entry);
      return new Uint8Array(readFileSync(resolve(ROOT, FILES[entry]!)));
    });
    expect(reads).toEqual(Object.values(EN_STARTUP_DATA_ENTRIES));
    expect(first.project.mapIndex.length).toBeGreaterThan(200);
    expect(first.battleShell.format).toBe("pocket-tuxemon/battle-db/v1");

    const second = store.load(() => { throw new Error("cached load must not read"); });
    expect(second).toBe(first);
    expect(store.current()).toBe(first);
  });

  test("pak.json exposes both raw English shell keys", () => {
    const manifest = JSON.parse(readFileSync(resolve(ROOT, "pak.json"), "utf8")) as
      Array<{ key: string; file: string }>;
    for (const key of Object.values(EN_STARTUP_DATA_ENTRIES)) {
      expect(manifest.find((entry) => entry.key === key)?.file).toBe(FILES[key]);
    }
  });
});
