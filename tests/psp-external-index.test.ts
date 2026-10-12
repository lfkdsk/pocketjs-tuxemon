// PSP external-pak index tests. The PSP host accepts a sidecar only when the
// embedded index is a byte-for-byte prefix of the sidecar and its declared
// length matches. These tests exercise the index/locate/read logic on
// synthetic paks (no PSP toolchain needed) and prove the old bug — embedding
// the full pak's index over a filtered sidecar — is rejected.

import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pack } from "../vendor/pocket-rpgkit/vendor/pocketjs/framework/compiler/pak.ts";
import {
  checkExternalPak,
  indexMismatch,
  listKeys,
  locateEntry,
  readEntry,
  readEntryVia,
  PAK_MAGIC,
  PAK_HEADER_SIZE,
} from "../tools/psp-external-check.ts";

const entries = [
  { key: "audio/battle.ogg", dtype: 0, data: new Uint8Array([1, 2, 3, 4]) },
  { key: "battle/front.png", dtype: 0, data: new Uint8Array([9, 8, 7]) },
  { key: "game:map:spyder_bedroom", dtype: 0, data: new Uint8Array([10, 20, 30, 40, 50]) },
  { key: "maps-zh/spyder_bedroom.json", dtype: 0, data: new Uint8Array([99]) },
  { key: "ui:font.0", dtype: 0, data: new Uint8Array([5, 6]) },
  { key: "zh_CN/dialog.json", dtype: 0, data: new Uint8Array([77]) },
];

const zhKeys = new Set(["maps-zh/spyder_bedroom.json", "zh_CN/dialog.json"]);
const filterZh = (all: typeof entries) => all.filter((e) => !zhKeys.has(e.key));

const u32 = (b: Uint8Array, off: number) =>
  b[off]! | (b[off + 1]! << 8) | (b[off + 2]! << 16) | (b[off + 3]! * 0x1000000);

function indexOf(pakBytes: Uint8Array): Uint8Array {
  return pakBytes.subarray(0, u32(pakBytes, 20));
}

describe("PSP external pak index", () => {
  test("an index built from the filtered sidecar passes the host rules", () => {
    const sidecar = pack(filterZh(entries));
    const index = indexOf(sidecar);
    expect(indexMismatch(sidecar, index)).toBeNull();
    expect(index.length).toBeGreaterThanOrEqual(PAK_HEADER_SIZE);
    expect(u32(index, 0) >>> 0).toBe(PAK_MAGIC >>> 0);
    expect(u32(index, 24)).toBe(sidecar.length);
  });

  test("entries are locatable and readable through the host's binary search", () => {
    const sidecar = pack(filterZh(entries));
    const located = locateEntry(sidecar, "game:map:spyder_bedroom");
    expect(located).not.toBeNull();
    expect(located![1]).toBe(5);
    expect(readEntry(sidecar, "audio/battle.ogg")).toEqual(new Uint8Array([1, 2, 3, 4]));
    expect(readEntry(sidecar, "battle/front.png")).toEqual(new Uint8Array([9, 8, 7]));
    expect(readEntry(sidecar, "game:map:spyder_bedroom")).toEqual(new Uint8Array([10, 20, 30, 40, 50]));
    expect(locateEntry(sidecar, "maps-zh/spyder_bedroom.json")).toBeNull();
  });

  test("an index built from the FULL pak over a filtered sidecar is rejected", () => {
    // This is the bug the review found: assets.pak is filtered, but the
    // embedded index came from the unfiltered pak.
    const full = pack(entries);
    const sidecar = pack(filterZh(entries));
    const staleIndex = indexOf(full);
    const mismatch = indexMismatch(sidecar, staleIndex);
    expect(mismatch).not.toBeNull();
    // The declared length differs (full pak is longer), and the byte prefix
    // does not match either.
    expect(mismatch!).toMatch(/length|differs/);
  });

  test("a truncated sidecar is rejected", () => {
    const sidecar = pack(filterZh(entries));
    const index = indexOf(sidecar);
    const truncated = sidecar.slice(0, sidecar.length - 10);
    expect(indexMismatch(truncated, index)).not.toBeNull();
  });

  test("an embedded index cut short inside its directory is rejected", () => {
    // Still a byte prefix of the sidecar with the right declared length, but
    // it has lost the tail of the names region: the host's binary search
    // over this index cannot see every entry.
    const sidecar = pack(filterZh(entries));
    const index = indexOf(sidecar);
    for (const cut of [1, 3, index.length - PAK_HEADER_SIZE]) {
      const mismatch = indexMismatch(sidecar, index.subarray(0, index.length - cut));
      expect(mismatch).toMatch(/directory length/);
    }
  });

  test("an index with corrupted magic is rejected", () => {
    const sidecar = pack(filterZh(entries));
    const index = new Uint8Array(indexOf(sidecar));
    index[0] = 0;
    expect(indexMismatch(sidecar, index)).not.toBeNull();
  });
});

// The build self-check must locate a real map, a real audio entry and a real
// battle tile THROUGH THE EMBEDDED DIRECTORY (the host's binary search), not
// by re-unpacking the full sidecar with a loose name predicate.
describe("PSP build self-check (checkExternalPak)", () => {
  const u32 = (b: Uint8Array, off: number) =>
    b[off]! | (b[off + 1]! << 8) | (b[off + 2]! << 16) | (b[off + 3]! * 0x1000000);

  // Realistic key shapes from the actual game pak.
  const sidecarEntries = [
    { key: "maps/spyder_bedroom.rkm", dtype: 0, data: new Uint8Array(15710).fill(1) },
    { key: "audio:qoa.music/music_07_town.qoa", dtype: 0, data: new Uint8Array(440096).fill(2) },
    { key: "ui:tile.battle/gfx/ui/combat/grass_background", dtype: 0, data: new Uint8Array(14840).fill(3) },
    { key: "battle/items/app_map.json", dtype: 0, data: new Uint8Array([4]) },
    { key: "maps-zh/spyder_bedroom.json", dtype: 0, data: new Uint8Array([5]) },
  ];
  const town = sidecarEntries[1]!;
  const townRequirement = {
    key: town.key,
    bytes: town.data.length,
    sha256: createHash("sha256").update(town.data).digest("hex"),
  };

  /** A synthetic PSP output dir: sidecar + boot pak whose embedded index is
   *  the sidecar's header+directory prefix. */
  function buildOutDir(index?: Uint8Array): string {
    const dir = mkdtempSync(join(tmpdir(), "psp-external-check-"));
    const sidecar = pack(sidecarEntries);
    const embedded = index ?? sidecar.subarray(0, u32(sidecar, 20));
    const boot = pack([
      { key: "ui:styles", dtype: 0, data: new Uint8Array([7]) },
      { key: "ui:font.0", dtype: 0, data: new Uint8Array([8]) },
      { key: "pocket:external-index", dtype: 0, data: new Uint8Array(embedded) },
    ]);
    writeFileSync(join(dir, "assets.pak"), sidecar);
    writeFileSync(join(dir, "pocket-tuxemon.pak"), boot);
    return dir;
  }

  test("locates a real map, audio and battle tile through the embedded index", () => {
    const dir = buildOutDir();
    try {
      const summary = checkExternalPak(dir);
      const keys = summary.samples.map((s) => s.key);
      expect(keys).toContain("maps/spyder_bedroom.rkm");
      expect(keys).toContain("audio:qoa.music/music_07_town.qoa");
      expect(keys).toContain("ui:tile.battle/gfx/ui/combat/grass_background");
      // The item JSON whose name merely contains "map" must NOT be picked as
      // the map sample (the old loose predicate picked battle/items/app_map.json).
      expect(keys).not.toContain("battle/items/app_map.json");
      expect(summary.samples.every((s) => s.bytes > 0)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("pins required lifecycle audio by exact key, size and hash", () => {
    const dir = buildOutDir();
    try {
      const summary = checkExternalPak(dir, [townRequirement]);
      expect(summary.samples).toContainEqual({
        kind: "battle-audio",
        key: town.key,
        bytes: town.data.length,
      });
      expect(() => checkExternalPak(dir, [{ ...townRequirement, bytes: town.data.length - 1 }]))
        .toThrow(/has 440096 bytes, expected 440095/);
      expect(() => checkExternalPak(dir, [{ ...townRequirement, sha256: "0".repeat(64) }]))
        .toThrow(/sha256/);
      expect(() => checkExternalPak(dir, [{ ...townRequirement, key: "audio:qoa.music/missing.qoa" }]))
        .toThrow(/embedded index cannot locate/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("entries located via the embedded index read the sidecar payload", () => {
    const dir = buildOutDir();
    try {
      const sidecar = readFileSync(join(dir, "assets.pak"));
      // The embedded index is the sidecar's header+directory prefix.
      const index = sidecar.subarray(0, u32(sidecar, 20));
      const mapPayload = readEntryVia(index, sidecar, "maps/spyder_bedroom.rkm");
      expect(mapPayload.length).toBe(15710);
      expect([...new Set([...mapPayload])]).toEqual([1]);
      const audioPayload = readEntryVia(index, sidecar, "audio:qoa.music/music_07_town.qoa");
      expect(audioPayload.length).toBe(440096);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("an embedded index truncated to its header is rejected", () => {
    // A 32-byte header is a byte prefix of the sidecar with the right
    // declared length, but the host cannot locate a map in a directory that
    // is no longer there; the index must cover the whole directory.
    const sidecar = pack(sidecarEntries);
    const fullIndex = sidecar.subarray(0, u32(sidecar, 20));
    expect(indexMismatch(sidecar, fullIndex.subarray(0, PAK_HEADER_SIZE))).toMatch(/directory length/);
    expect(locateEntry(fullIndex.subarray(0, PAK_HEADER_SIZE), "maps/spyder_bedroom.rkm")).toBeNull();
    const dir = buildOutDir(fullIndex.subarray(0, PAK_HEADER_SIZE));
    try {
      expect(() => checkExternalPak(dir)).toThrow(/directory length/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("listKeys reads the directory the host binary-searches", () => {
    const sidecar = pack(sidecarEntries);
    const index = sidecar.subarray(0, u32(sidecar, 20));
    expect(listKeys(index).sort()).toEqual(sidecarEntries.map((e) => e.key).sort());
  });
});
