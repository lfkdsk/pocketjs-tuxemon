import { afterEach, expect, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { pack, unpack } from "../vendor/pocket-rpgkit/vendor/pocketjs/framework/compiler/pak.ts";
import {
  externalizeDesktopPak,
  partitionDesktopPakEntries,
} from "../tools/desktop-audio.ts";

const scratch: string[] = [];
afterEach(() => {
  for (const path of scratch.splice(0)) rmSync(path, { recursive: true, force: true });
});

test("desktop pak partition keeps render assets and extracts lazy data and audio", () => {
  const partition = partitionDesktopPakEntries([
    { key: "ui:styles", dtype: 0, data: new Uint8Array([1]) },
    { key: "ui:tile.route-ground", dtype: 0, data: new Uint8Array([8, 9]) },
    { key: "maps/route.json", dtype: 0, data: new Uint8Array([10, 11, 12]) },
    { key: "maps-de_DE/route.json", dtype: 0, data: new Uint8Array([14, 15]) },
    { key: "battle-fr_FR/monster.json", dtype: 0, data: new Uint8Array([16]) },
    { key: "l10n/zh_CN/project-shell.json", dtype: 0, data: new Uint8Array([13]) },
    { key: "audio:qoa.music/town.qoa", dtype: 0, data: new Uint8Array([2, 3]) },
    { key: "audio:wav.sounds/confirm.wav", dtype: 0, data: new Uint8Array([4, 5, 6]) },
    { key: "attribution:audio/AUDIO-ATTRIBUTIONS.md", dtype: 0, data: new Uint8Array([7]) },
  ]);

  expect(partition.startup.map((entry) => entry.key)).toEqual([
    "ui:styles",
    "ui:tile.route-ground",
    "audio:wav.sounds/confirm.wav",
    "attribution:audio/AUDIO-ATTRIBUTIONS.md",
  ]);
  expect(partition.audio.map((entry) => entry.key)).toEqual([
    "audio:qoa.music/town.qoa",
  ]);
  expect(partition.audioBytes).toBe(2);
  expect(partition.dataBytes).toBe(7);
  expect(partition.sidecar.map((entry) => entry.key)).toEqual([
    "maps/route.json",
    "maps-de_DE/route.json",
    "battle-fr_FR/monster.json",
    "l10n/zh_CN/project-shell.json",
    "audio:qoa.music/town.qoa",
  ]);
});

test("desktop externalization writes exact data.fs keys and removes stale managed roots", () => {
  const scratchRoot = join(process.cwd(), ".pocket", "test-tmp");
  mkdirSync(scratchRoot, { recursive: true });
  const root = mkdtempSync(join(scratchRoot, "desktop-audio-"));
  scratch.push(root);
  const pakPath = join(root, "game.pak");
  const data = join(root, "data");
  mkdirSync(join(data, "audio:qoa.music"), { recursive: true });
  mkdirSync(join(data, "maps"), { recursive: true });
  writeFileSync(join(data, "audio:qoa.music", "stale.qoa"), new Uint8Array([9]));
  writeFileSync(join(data, "maps", "stale.json"), new Uint8Array([9]));
  writeFileSync(pakPath, pack([
    { key: "ui:styles", dtype: 0, data: new Uint8Array([1]) },
    { key: "maps/route.json", dtype: 0, data: new Uint8Array([7, 8]) },
    { key: "audio:qoa.music/town.qoa", dtype: 0, data: new Uint8Array([2, 3]) },
    { key: "audio:wav.sounds/confirm.wav", dtype: 0, data: new Uint8Array([4, 5, 6]) },
  ]));

  const result = externalizeDesktopPak(pakPath, data);

  expect(result.entries).toBe(2);
  expect(result.dataEntries).toBe(1);
  expect(result.audioEntries).toBe(1);
  expect(result.dataBytes).toBe(2);
  expect(result.audioBytes).toBe(2);
  expect(unpack(readFileSync(pakPath)).map((entry) => entry.key)).toEqual([
    "audio:wav.sounds/confirm.wav",
    "ui:styles",
  ]);
  expect([...readFileSync(join(data, "audio:qoa.music", "town.qoa"))]).toEqual([2, 3]);
  expect([...readFileSync(join(data, "maps", "route.json"))]).toEqual([7, 8]);
  expect(existsSync(join(data, "audio:wav.sounds", "confirm.wav"))).toBe(false);
  expect(existsSync(join(data, "audio:qoa.music", "stale.qoa"))).toBe(false);
  expect(existsSync(join(data, "maps", "stale.json"))).toBe(false);
});
