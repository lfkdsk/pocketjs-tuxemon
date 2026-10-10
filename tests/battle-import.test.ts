import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { battleArtifactPaths, runtimeBattleDb, writeBattleArtifacts } from "../importer/battle.ts";
import {
  collectBattleArtRefs,
  validateBattleDb,
  type BattleDb,
  type BattleRuntimeStatusIndexEntry,
} from "../importer/battle-schema.ts";
import { decodePng } from "../importer/png.ts";
import { BATTLE_PREVIEW_HEIGHT, BATTLE_PREVIEW_WIDTH, renderBattlePreview } from "../tools/render-battle-preview.ts";
import {
  TILESET_DIR_ENTRY_SIZE,
  TILESET_FLAG_RLE,
  TILESET_HEADER_SIZE,
  TILESET_MAGIC,
  TILESET_VERSION,
  packbitsDecode,
} from "../vendor/pocket-rpgkit/vendor/pocketjs/contracts/spec/spec.ts";

const ROOT = resolve(import.meta.dir, "..");
const db = JSON.parse(readFileSync(join(ROOT, "data/battle-db.json"), "utf8")) as unknown;
const runtimeDb = JSON.parse(readFileSync(join(ROOT, "data/battle-runtime-db.json"), "utf8")) as unknown;
const runtimeShell = JSON.parse(readFileSync(join(ROOT, "dist/battle-runtime-shell.json"), "utf8")) as {
  monstersIndex: Array<{ id: string; entry: string; txmnId: number; name: string }>;
  statusesIndex: BattleRuntimeStatusIndexEntry[];
};
const report = JSON.parse(readFileSync(join(ROOT, "data/battle-assets-report.json"), "utf8"));
const images = JSON.parse(readFileSync(join(ROOT, "images.json"), "utf8")) as Record<string, { psm: number }>;
const pakManifest = JSON.parse(readFileSync(join(ROOT, "pak.json"), "utf8")) as Array<{ key: string; file: string }>;
const battlePakEntries = pakManifest.filter((entry) => entry.key.startsWith("ui:tile.battle/"));
const battleKeys = new Set(battlePakEntries.map((entry) => entry.key));
const validated = validateBattleDb(db, battleKeys);

function decodeSingleTile(bytes: Uint8Array): { width: number; height: number; rgba: Uint8Array } {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  expect(dv.getUint32(0, true)).toBe(TILESET_MAGIC);
  expect(dv.getUint16(4, true)).toBe(TILESET_VERSION);
  expect(dv.getUint16(6, true)).toBe(TILESET_FLAG_RLE);
  const width = dv.getUint16(8, true);
  const height = dv.getUint16(10, true);
  expect(dv.getUint16(12, true)).toBe(1);
  expect(dv.getUint16(14, true)).toBe(1);
  const paletteOffset = dv.getUint32(16, true);
  const directoryOffset = dv.getUint32(20, true);
  const dataOffset = dv.getUint32(24, true);
  expect(paletteOffset).toBe(TILESET_HEADER_SIZE);
  expect(directoryOffset).toBe(TILESET_HEADER_SIZE + 1024);
  expect(dataOffset).toBe(TILESET_HEADER_SIZE + 1024 + TILESET_DIR_ENTRY_SIZE);
  const streamOffset = dv.getUint32(directoryOffset, true);
  const streamLength = dv.getUint32(directoryOffset + 4, true);
  const indices = packbitsDecode(
    bytes.subarray(dataOffset + streamOffset, dataOffset + streamOffset + streamLength),
    width * height,
  );
  if (!indices) throw new Error("battle TILESET has an invalid PackBits stream");
  const rgba = new Uint8Array(width * height * 4);
  for (let pixel = 0; pixel < indices.length; pixel++) {
    const colour = dv.getUint32(paletteOffset + indices[pixel]! * 4, true);
    rgba[pixel * 4] = colour & 0xff;
    rgba[pixel * 4 + 1] = (colour >>> 8) & 0xff;
    rgba[pixel * 4 + 2] = (colour >>> 16) & 0xff;
    rgba[pixel * 4 + 3] = colour >>> 24;
  }
  return { width, height, rgba };
}

function legacyDisplayedRgba(rgba: Uint8Array): Uint8Array {
  const displayed = rgba.slice();
  for (let offset = 0; offset < displayed.length; offset += 4) {
    for (let channel = 0; channel < 4; channel++) {
      displayed[offset + channel] = (displayed[offset + channel]! >> 4) * 17;
    }
    if (displayed[offset + 3] === 0) displayed.fill(0, offset, offset + 4);
  }
  return displayed;
}

describe("GB1 battle database", () => {
  test("derives a byte-stable reducer-only production projection", () => {
    expect(runtimeDb).toEqual(runtimeBattleDb(validated));
    expect(report.runtimeDbBytes).toBe(readFileSync(join(ROOT, "data/battle-runtime-db.json")).byteLength);
  });

  test("matches the generated Spyder and Eclipse Park runtime slice", () => {
    expect(report.scope).toBe("spyder");
    expect(report.sourceRevision).toBe("9e6258ff726b786040a267e8bdbbf037b560285e");
    expect(report.counts).toEqual({
      monsters: 269,
      techniques: 245,
      items: 114,
      elements: 13,
      tastes: 12,
      statuses: 35,
      encounters: 22,
      npcs: 205,
      environments: 10,
      trainerParties: 213,
      trainerMonsterSlots: 611,
      battleSlots: 283,
      randomEncounterUses: 286,
      wildEncounterUses: 17,
    });
    expect(report.art.categories["monster-sheets"].sourceFiles).toBe(269);
    expect(report.art.categories["technique-animations"].sourceFiles).toBe(130);
    expect(report.art.categories["capture-devices"].sourceFiles).toBe(28);
    expect(report.art.categories.backgrounds.sourceFiles).toBe(10);
    expect(report.art.categories.islands.sourceFiles).toBe(6);
    expect(report.art.categories["trainer-sheets"].sourceFiles).toBe(61);
    expect(report.art.sourceBytes).toBe(1_953_249);
  });

  test("retains the stat, move, capture, status, and encounter rule inputs", () => {
    expect(validated.rules).toMatchObject({
      levelRange: [0, 100],
      trainingPoints: { maxPerStat: 150, maxTotal: 300, defaultGain: 1 },
      statCoefficient: 7,
      ivRange: [0, 15],
      sizeVariation: { height: [-0.1, 0.1], weight: [-0.1, 0.1] },
      maxMoves: 4,
      bondStageFloors: { basic: 0, standalone: 0, stage1: 20, stage2: 40 },
      catchRateRange: [0, 100],
      catchResistanceRange: [0, 2],
      experience: {
        acquisitionMultipliers: { captured: 1, traded: 1.5, gifted: 1.2 },
        groups: { default: { multiplier: 1, experienceCoefficient: 3 } },
      },
      actionOrder: {
        sortOrder: ["potion", "utility", "quest", "meta", "damage"],
        speedTiers: { extremely_slow: -3, normal: 0, extremely_fast: 3 },
        speedFactor: 0.25,
        dodgeModifier: 0.01,
        baseSpeedBonus: 1,
        minSpeedModifier: 1,
      },
      damage: {
        affinityMultiplierRange: [0.25, 4],
        rangeMap: {
          melee: { user: { stat: "melee", weight: 1 }, target: { stat: "armour", weight: 1 } },
          reliable: { user: { stat: "level", weight: 1 }, target: { stat: "resist", weight: 1 } },
        },
      },
    });
    expect(validated.shapes.hunter).toEqual({ armour: 4, dodge: 8, hp: 5, melee: 8, ranged: 4, speed: 7 });
    expect(validated.monsters.rockitten).toMatchObject({
      name: "Rockitten",
      description: "It uses its tiny rock ears for snuggling.",
      txmnId: 1,
      shape: "hunter",
      stage: "basic",
      types: ["earth"],
      catchRate: 100,
      catchResistance: [0.95, 1.25],
    });
    expect(validated.monsters.rockitten.moveset.map((move) => move.technique)).toContain("mudslide");
    expect(validated.monsters.nut.evolutions).toContainEqual(expect.objectContaining({ monster_slug: "bolt" }));
    expect(validated.monsters.bolt.evolutions).toContainEqual(expect.objectContaining({ monster_slug: "arthrobolt" }));
    expect(validated.monsters.nut.moveset.map((move) => move.technique)).toContain("thunderclap");
    expect(runtimeShell.monstersIndex.find((entry) => entry.id === "rockitten")).toEqual({
      id: "rockitten",
      entry: "battle/monsters/rockitten.json",
      txmnId: 1,
      name: "Rockitten",
    });
    expect(runtimeShell.statusesIndex.find((entry) => entry.id === "burn")).toEqual({
      id: "burn",
      entry: "battle/statuses/burn.json",
      icon: (runtimeDb as BattleDb).statuses.burn.icon,
    });
    expect((runtimeDb as BattleDb).monsters.rockitten).toMatchObject({
      name: "Rockitten",
      description: validated.monsters.rockitten.description,
      txmnId: 1,
    });
    for (const [slug, monster] of Object.entries(validated.monsters)) {
      for (const evolution of monster.evolutions) {
        expect(validated.monsters[String(evolution.monster_slug)], `${slug} evolution target`).toBeDefined();
      }
    }
    expect(validated.techniques.ram).toMatchObject({
      accuracy: 1,
      power: 1.5,
      range: "melee",
      recharge: 1,
      effects: [{ type: "damage" }],
    });
    expect(validated.statuses.grabbed).toMatchObject({ bond: true, category: "negative" });
    expect(validated.rules.capture).toMatchObject({ total_shakes: 4, shake_constant: 524325, shake_divisor: 65536 });
    expect(validated.rules.captureDevices).toMatchObject({
      statusModifier: 1,
      deviceModifier: 1,
      items: { tuxeball: { specific_capdev_modifier: 1, negative_modifier: 1.2 } },
    });
    expect(validated.elements.fire.multipliers).toMatchObject({ earth: 0.5, metal: 2, water: 0.5, wood: 2 });
    expect(validated.encounters.spyder_route1.monsters.map((row) => row.weight)).toEqual([3.5, 3.5, 3.5, 3.5, 3.5, 3.5]);
  });

  test("resolves variable trainer species and every spawn move", () => {
    const firstFight = validated.trainerParties.find((party) =>
      party.opponent === "spyder_billie" && party.party.length === 1 && party.party[0]?.level === 5
    );
    expect(firstFight?.party[0]).toMatchObject({
      speciesVariable: "billie_choice",
      level: 5,
      experienceModifier: 5,
      moneyModifier: 10,
    });
    expect(firstFight?.party[0]?.species).toHaveLength(10);
    expect(firstFight?.party[0]?.species).toEqual(expect.arrayContaining(["budaye", "dollfin", "grintot", "ignibus", "memnomnom"]));
    // validateBattleDb above computes every trainer's four at-spawn moves and
    // rejects a missing technique. Keep one concrete first-fight assertion too.
    expect(validated.monsters.budaye.moveset.filter((move) => move.level <= 5).map((move) => move.technique))
      .toEqual(["struggle", "stick", "clamp_on"]);
  });

  test("puts every battle art reference in a lazy CLUT8 pak entry", () => {
    const files = battleArtifactPaths(ROOT);
    const refs = collectBattleArtRefs(validated);
    expect(new Set(refs.map((ref) => ref.key.slice(0, -2)))).toEqual(battleKeys);
    expect(pakManifest).toContainEqual({ key: "game:battle-db", file: "data/battle-db.json" });
    expect(report.art.files).toBe(files.length);
    expect(battlePakEntries).toHaveLength(files.length);
    expect(Object.keys(images).filter((relative) => relative.startsWith("assets/battle/"))).toEqual([]);
    expect(report.art.encodedBytes).toBe(
      battlePakEntries.reduce((sum, entry) => sum + readFileSync(join(ROOT, entry.file)).byteLength, 0),
    );
    expect(report.art.quantization).toMatchObject({
      quantizedFiles: 0,
      quantizedColours: 0,
      remappedPixels: 0,
      totalSquaredError: 0,
      maxSquaredError: 0,
      meanSquaredError: 0,
    });
    for (const entry of battlePakEntries) {
      const name = entry.key.slice("ui:tile.".length);
      expect(name.startsWith("battle/")).toBeTrue();
      expect(entry.file).toBe(`dist/battle-art/${name.slice("battle/".length)}.pkts`);
      const relative = `assets/${name}.png`;
      expect(files).toContain(relative);
      expect(images[relative], relative).toBeUndefined();
      const image = decodePng(new Uint8Array(readFileSync(join(ROOT, relative))), relative);
      const decoded = decodeSingleTile(new Uint8Array(readFileSync(join(ROOT, entry.file))));
      expect([decoded.width, decoded.height], relative).toEqual([image.width, image.height]);
      expect(decoded.rgba, `${relative} framebuffer parity`).toEqual(legacyDisplayedRgba(image.rgba));
      expect(image.width & (image.width - 1), relative).toBe(0);
      expect(image.height & (image.height - 1), relative).toBe(0);
      expect(image.width, relative).toBeLessThanOrEqual(512);
      expect(image.height, relative).toBeLessThanOrEqual(512);
    }
  }, 60_000);

  test("renders a byte-stable battle acceptance sheet with semantic pixels", () => {
    const generated = renderBattlePreview(ROOT);
    const committed = new Uint8Array(readFileSync(join(ROOT, "tests/goldens/GB1-preview.png")));
    expect(generated).toEqual(committed);
    const preview = decodePng(generated, "GB1-preview.png");
    expect([preview.width, preview.height]).toEqual([BATTLE_PREVIEW_WIDTH, BATTLE_PREVIEW_HEIGHT]);

    // Uncovered grass at source (8,100) is copied exactly into the 2x scene.
    const grass = decodePng(new Uint8Array(readFileSync(join(ROOT, "assets/battle/gfx/ui/combat/grass_background.png"))), "grass");
    expect([...preview.rgba.slice((200 * preview.width + 16) * 4, (200 * preview.width + 16) * 4 + 4)])
      .toEqual([...grass.rgba.slice((100 * grass.width + 8) * 4, (100 * grass.width + 8) * 4 + 4)]);

    // Every fully opaque Rockitten back-sprite pixel lands as a 2x2 block at
    // the documented player slot; this detects wrong front/back crops or origin.
    const rockitten = decodePng(new Uint8Array(readFileSync(join(ROOT, "assets/battle/gfx/sprites/battle/rockitten-sheet.png"))), "rockitten");
    let opaque = 0;
    for (let y = 0; y < 64; y++) for (let x = 64; x < 128; x++) {
      const sourceOffset = (y * rockitten.width + x) * 4;
      if (rockitten.rgba[sourceOffset + 3] !== 255) continue;
      opaque++;
      const previewOffset = ((88 + y * 2) * preview.width + 96 + (x - 64) * 2) * 4;
      expect([...preview.rgba.slice(previewOffset, previewOffset + 4)]).toEqual([...rockitten.rgba.slice(sourceOffset, sourceOffset + 4)]);
    }
    expect(opaque).toBeGreaterThan(500);

    // The four 64x64 Ram frames occupy the right-hand animation strip.
    const animation = decodePng(new Uint8Array(readFileSync(join(ROOT, "assets/battle/animations/technique/pound.page-0.png"))), "pound");
    let animationOpaque = 0;
    for (let y = 0; y < 64; y++) for (let x = 0; x < 256; x++) {
      const sourceOffset = (y * animation.width + x) * 4;
      if (animation.rgba[sourceOffset + 3] !== 255) continue;
      animationOpaque++;
      const previewOffset = ((128 + y) * preview.width + 512 + x) * 4;
      expect([...preview.rgba.slice(previewOffset, previewOffset + 4)]).toEqual([...animation.rgba.slice(sourceOffset, sourceOffset + 4)]);
    }
    expect(animationOpaque).toBeGreaterThan(800);
  });
});

const scratchParent = join(tmpdir(), "pocket-tuxemon-gb1-full-test");
mkdirSync(scratchParent, { recursive: true });
const fullRoot = mkdtempSync(join(scratchParent, "gb1-full-test-"));
afterAll(() => rmSync(fullRoot, { recursive: true, force: true }));

describe("GB1 full database switch", () => {
  test("imports and validates the complete battle database", () => {
    const full = writeBattleArtifacts({ outputRoot: fullRoot, scope: "full" });
    expect(full.report.counts).toMatchObject({
      monsters: 411,
      techniques: 274,
      items: 224,
      elements: 13,
      tastes: 12,
      statuses: 35,
      encounters: 35,
      npcs: 1_139,
      environments: 40,
    });
    expect(full.report.art.categories["monster-sheets"].sourceFiles).toBe(411);
    expect(full.report.art.categories["technique-animations"].sourceFiles).toBe(141);
    expect(full.report.art.categories["trainer-sheets"].sourceFiles).toBe(76);
    expect(full.report.art.categories.backgrounds.sourceFiles).toBe(37);
    expect(full.report.art.categories.islands.sourceFiles).toBe(14);
    expect(full.report.art.maxWidth).toBeLessThanOrEqual(512);
    expect(full.report.art.maxHeight).toBeLessThanOrEqual(512);
    expect(existsSync(join(fullRoot, "data/battle-db.json"))).toBeTrue();
    expect(existsSync(join(fullRoot, "data/battle-runtime-db.json"))).toBeTrue();
  }, 60_000);
});
