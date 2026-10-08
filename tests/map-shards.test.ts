import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  assertShellManifestFresh,
  createJsonMapRepository,
} from "../vendor/pocket-rpgkit/src/engine/map-repository.ts";
import type { Project, ProjectShell } from "../vendor/pocket-rpgkit/src/engine/types.ts";
import {
  MAX_COMPACT_MAP_ENTRY_BYTES,
  splitGameProjectMaps,
} from "../importer/map-shards.ts";

const ROOT = resolve(import.meta.dir, "..");
const DIST = join(ROOT, "dist");
const inline = JSON.parse(readFileSync(join(DIST, "project.json"), "utf8")) as Project;
const shellBytes = readFileSync(join(DIST, "project-shell.json"));
const shell = JSON.parse(shellBytes.toString("utf8")) as ProjectShell;
const assetReport = JSON.parse(readFileSync(join(ROOT, "data/g6-assets-report.json"), "utf8"));
const pak = JSON.parse(readFileSync(join(ROOT, "pak.json"), "utf8")) as Array<{
  key: string;
  file: string;
}>;

describe("generated per-map repository", () => {
  test("the hybrid shell uses compact entries below the QuickJS decode cap", () => {
    const expected = splitGameProjectMaps(inline);
    expect(shell.mapIndex).toHaveLength(263);
    expect(assetReport.mapRepository.encodings).toEqual({ compact: 260, json: 3 });
    expect(assetReport.mapRepository.entryBytes)
      .toBeLessThan(assetReport.mapRepository.canonicalJsonBytes);
    expect("maps" in shell).toBeFalse();
    expect(shellBytes).toEqual(Buffer.from(expected.shellText));

    const mapRows = pak.filter((entry) => entry.key.startsWith("maps/"));
    expect(mapRows).toHaveLength(263);
    expect(mapRows.filter((entry) => entry.key.endsWith(".rkm"))).toHaveLength(260);
    expect(mapRows.filter((entry) => entry.key.endsWith(".json"))).toHaveLength(3);
    expect(mapRows).toEqual(expected.entries.map((entry) => ({
      key: entry.path,
      file: `dist/${entry.path}`,
    })));

    for (const entry of expected.entries) {
      const actual = readFileSync(join(DIST, entry.path));
      expect(actual, entry.meta.id).toEqual(Buffer.from(entry.bytes));
      expect(actual.some((byte) => byte > 0x7f), entry.meta.id).toBeFalse();
      expect(createHash("sha256").update(actual).digest("hex"), entry.meta.id).toBe(entry.meta.sha256);
      expect(entry.encoding === "compact", entry.meta.id)
        .toBe(entry.bytes.byteLength <= MAX_COMPACT_MAP_ENTRY_BYTES);
      expect(JSON.parse(actual.toString("utf8")).$ === "rpgkit-map/1", entry.meta.id)
        .toBe(entry.encoding === "compact");
    }
  }, 60_000);

  test("the standard byte repository can acquire every generated map", () => {
    const reads: string[] = [];
    const repository = createJsonMapRepository(shell.mapIndex, {
      read(entry) {
        reads.push(entry);
        return new Uint8Array(readFileSync(join(DIST, entry)));
      },
    });
    const inlineById = new Map(inline.maps.map((map) => [map.id, map]));
    for (const meta of shell.mapIndex) {
      const acquired = repository.acquire(meta.id);
      expect(acquired).toMatchObject({
        id: meta.id,
        width: meta.width,
        height: meta.height,
      });
      const expected = inlineById.get(meta.id);
      expect(expected, `${meta.id} inline oracle`).toBeDefined();
      expect(acquired, `${meta.id} decoded parity`).toEqual(expected!);
      repository.releaseExcept([]);
    }
    expect(reads).toEqual(shell.mapIndex.map((entry) => entry.entry));
  });

  test("custom-language paths retain the same large-map decode cap", () => {
    const localized = splitGameProjectMaps(inline, MAX_COMPACT_MAP_ENTRY_BYTES, {
      shellEntry: "project-shell.zh_CN.json",
      mapEntry: (id, extension) => `maps-zh/${id}.${extension}`,
    });
    const routec = localized.entries.find((entry) => entry.meta.id === "spyder_routec")!;
    expect(routec.encoding).toBe("json");
    expect(routec.path).toBe("maps-zh/spyder_routec.json");
    expect(routec.meta.entry).toBe(routec.path);
    expect(localized.shell.mapIndex.find((entry) => entry.id === "spyder_routec")?.entry)
      .toBe(routec.path);
    expect(localized.files[0]?.path).toBe("project-shell.zh_CN.json");
  }, 60_000);

  test("the packaged shell's declared mapManifestHash is fresh", () => {
    // The runtime trusts the declared hash instead of rehashing at startup,
    // so the build pipeline must prove the packaged shell is fresh. The real
    // bytes on disk pass; a hand-edit to any non-hash field (in memory) must
    // be rejected with both digests.
    expect(() => assertShellManifestFresh(shell)).not.toThrow();
    const handEdited = { ...shell, title: `${shell.title} (hand-edited)` };
    expect(() => assertShellManifestFresh(handEdited)).toThrow("shell manifest hash mismatch");
    const undeclared = { ...shell } as Partial<ProjectShell>;
    delete undeclared.mapManifestHash;
    expect(() => assertShellManifestFresh(undeclared as ProjectShell)).toThrow("no mapManifestHash");
  });
});
