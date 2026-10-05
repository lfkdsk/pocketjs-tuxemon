import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createZhDataStore, ZH_DATA_ENTRIES } from "../ui/zh-data.ts";

const ROOT = resolve(import.meta.dir, "..");
const FILES: Record<string, string> = {
  [ZH_DATA_ENTRIES.project]: "dist/project-shell.zh_CN.json",
  [ZH_DATA_ENTRIES.battleShell]: "dist/battle-runtime-shell.zh_CN.json",
  [ZH_DATA_ENTRIES.names]: "data/battle-names.zh_CN.json",
  [ZH_DATA_ENTRIES.mapDescriptions]: "dist/map-descriptions.zh_CN.json",
  [ZH_DATA_ENTRIES.monthNames]: "data/month-names.zh_CN.json",
};

describe("on-demand zh_CN startup data", () => {
  test("reads each raw entry once and reuses the parsed documents", () => {
    const store = createZhDataStore();
    const reads: string[] = [];
    expect(store.current()).toBeNull();

    const first = store.load((entry) => {
      reads.push(entry);
      return new Uint8Array(readFileSync(resolve(ROOT, FILES[entry]!)));
    });
    expect(reads).toEqual(Object.values(ZH_DATA_ENTRIES));
    expect(first?.project.mapIndex.length).toBeGreaterThan(200);
    expect(first?.battleShell.format).toBe("pocket-tuxemon/battle-db/v1");
    expect(Object.keys(first?.names.monsters ?? {}).length).toBeGreaterThan(100);
    expect(Object.keys(first?.mapDescriptions ?? {}).length).toBeGreaterThan(40);
    expect(first?.monthNames).toHaveLength(12);

    const second = store.load(() => { throw new Error("cached load must not read"); });
    expect(second).toBe(first);
    expect(store.current()).toBe(first);
  });

  test("pak.json exposes the same five raw entry keys", () => {
    const manifest = JSON.parse(readFileSync(resolve(ROOT, "pak.json"), "utf8")) as
      Array<{ key: string; file: string }>;
    for (const key of Object.values(ZH_DATA_ENTRIES)) {
      expect(manifest.find((entry) => entry.key === key)?.file).toBe(FILES[key]);
    }
  });
});
