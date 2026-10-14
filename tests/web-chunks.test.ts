import { describe, expect, test } from "bun:test";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import {
  pack,
  unpack,
} from "../vendor/pocket-rpgkit/vendor/pocketjs/framework/compiler/pak.ts";
import {
  buildWebPakChunks,
  WEB_PAK_MANIFEST,
  WEB_PAK_REPORT,
  type WebPakManifest,
} from "../tools/web-chunks.ts";

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);

describe("Web pak partition", () => {
  test("is deterministic, complete, content-addressed and wires map music dependencies", () => {
    const temp = mkdtempSync(join(process.cwd(), ".web-chunks-test-"));
    try {
      const pakPath = join(temp, "pocket-tuxemon.pak");
      const shellPath = join(temp, "project-shell.json");
      const outA = join(temp, "a");
      const outB = join(temp, "b");
      writeFileSync(pakPath, pack([
        { key: "ui:styles", dtype: 0, data: bytes("styles") },
        { key: "ui:tile.battle/animations/hit.page-0", dtype: 0, data: bytes("battle") },
        { key: "maps/spyder_bedroom.rkm", dtype: 0, data: bytes('{"id":"spyder_bedroom","music":"music_home"}') },
        { key: "maps-zh/spyder_bedroom.rkm", dtype: 0, data: bytes('{"id":"spyder_bedroom"}') },
        { key: "ui:tile.tuxemon-spyder_bedroom-ground-0", dtype: 0, data: bytes("bedroom") },
        { key: "maps/spyder_downstairs.rkm", dtype: 0, data: bytes('{"id":"spyder_downstairs","music":"music_town"}') },
        { key: "maps-zh/spyder_downstairs.rkm", dtype: 0, data: bytes('{"id":"spyder_downstairs"}') },
        { key: "ui:tile.tuxemon-spyder_downstairs-ground-0", dtype: 0, data: bytes("downstairs") },
        { key: "maps/spyder_routec.rkm", dtype: 0, data: bytes('{"id":"spyder_routec"}') },
        { key: "maps-zh/spyder_routec.rkm", dtype: 0, data: bytes('{"id":"spyder_routec"}') },
        { key: "ui:tile.tuxemon-spyder_routec-ground-0", dtype: 0, data: bytes("routec") },
        { key: "audio:qoa.music/music_home.qoa", dtype: 0, data: bytes("home") },
        { key: "audio:qoa.music/music_battle_loop.qoa", dtype: 0, data: bytes("battle music") },
        { key: "audio:qoa.music/music_town.qoa", dtype: 0, data: bytes("town") },
      ]));
      writeFileSync(shellPath, JSON.stringify({
        tileSize: 16,
        audio: {
          music_home: "audio:qoa.music/music_home.qoa",
          music_battle_loop: "audio:qoa.music/music_battle_loop.qoa",
          music_town: "audio:qoa.music/music_town.qoa",
        },
        worldLayout: {
          components: [{
            placements: [
              { mapId: "spyder_downstairs", originTileX: 0, originTileY: 0, width: 9, height: 7 },
              { mapId: "spyder_routec", originTileX: 9, originTileY: 0, width: 40, height: 20 },
            ],
          }],
        },
      }));

      const first = buildWebPakChunks({ pakPath, projectShellPath: shellPath, outDir: outA });
      const second = buildWebPakChunks({ pakPath, projectShellPath: shellPath, outDir: outB });
      expect(readFileSync(join(outA, WEB_PAK_MANIFEST))).toEqual(readFileSync(join(outB, WEB_PAK_MANIFEST)));
      expect(readFileSync(join(outA, WEB_PAK_REPORT))).toEqual(readFileSync(join(outB, WEB_PAK_REPORT)));
      expect(first.startupBytes).toBeLessThan(10_000_000);
      expect(first.sourceBytes).toBe(readFileSync(pakPath).byteLength);

      const manifest = JSON.parse(readFileSync(first.manifestPath, "utf8")) as WebPakManifest;
      expect(manifest.format).toBe("pocket-pak-chunks/v1");
      expect(manifest.chunks).toHaveLength(6);
      for (const asset of [manifest.startup, ...manifest.chunks]) {
        expect(asset.file).toContain(asset.sha256);
        expect(readFileSync(join(outA, asset.file)).byteLength).toBe(asset.bytes);
      }
      const map = manifest.chunks.find((chunk) => chunk.id === "map:spyder_downstairs")!;
      const visual = manifest.chunks.find((chunk) => chunk.id === "visual:spyder_downstairs")!;
      const audio = manifest.chunks.find((chunk) => chunk.id === "audio:music/music_town.qoa")!;
      const battleAudio = manifest.chunks.find((chunk) => chunk.id === "audio:music/music_battle_loop.qoa")!;
      expect(map.entries).toEqual([
        "maps-zh/spyder_downstairs.rkm",
        "maps/spyder_downstairs.rkm",
      ]);
      expect(map.requires).toEqual([
        audio.id,
        "visual:spyder_downstairs",
        "visual:spyder_routec",
      ]);
      expect(visual.entries).toEqual(["ui:tile.tuxemon-spyder_downstairs-ground-0"]);
      expect(visual.requires).toEqual([]);
      expect(audio.entries).toEqual(["audio:qoa.music/music_town.qoa"]);
      expect(battleAudio.entries).toEqual(["audio:qoa.music/music_battle_loop.qoa"]);

      const startup = unpack(gunzipSync(readFileSync(join(outA, manifest.startup.file))));
      const startupKeys = startup.map((entry) => entry.key);
      expect(startupKeys).toContain("pocket:external-index");
      expect(startupKeys).toContain("maps/spyder_bedroom.rkm");
      expect(startupKeys).toContain("audio:qoa.music/music_home.qoa");
      expect(startupKeys).toContain("ui:tile.battle/animations/hit.page-0");
      expect(startupKeys).not.toContain("maps/spyder_downstairs.rkm");
      expect(startupKeys).not.toContain("audio:qoa.music/music_battle_loop.qoa");
      expect(startupKeys).not.toContain("audio:qoa.music/music_town.qoa");

      const report = JSON.parse(readFileSync(first.reportPath, "utf8")) as {
        source: { bytes: number; categories: Record<string, { bytes: number }> };
      };
      expect(Object.values(report.source.categories).reduce((sum, category) => sum + category.bytes, 0))
        .toBe(report.source.bytes);
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });
});
