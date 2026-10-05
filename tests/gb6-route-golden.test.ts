import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { decodePng } from "../importer/png.ts";
import { fnv1a } from "../vendor/pocket-rpgkit/vendor/pocketjs/hosts/sim/sim.ts";
import { walkPose } from "../vendor/pocket-rpgkit/src/engine/movement.ts";
import { PLAYER } from "../ui/game-assets.ts";

interface GoldenFrame {
  name: string;
  frame: number;
  timelineFrame: number;
  map: string;
  position: [number, number];
  width: number;
  height: number;
  file: string;
  rgbaFnv1a: string;
  pngSha256: string;
  camera: [number, number];
  player: {
    tile: [number, number];
    pixel: [number, number];
    facing: number;
    phase: number;
  };
}

const ROOT = resolve(import.meta.dir, "..");
const manifest = JSON.parse(readFileSync(join(ROOT, "data/gb6-route-goldens.json"), "utf8")) as {
  format: string;
  worldTraversal: string;
  tapeSha256: string;
  frames: GoldenFrame[];
};
const journey = JSON.parse(readFileSync(join(ROOT, "data/gb6-mainline-journey.json"), "utf8")) as {
  worldTraversal: string;
  tapeSha256: string;
  masks: number[];
};
const project = JSON.parse(readFileSync(join(ROOT, "dist/project.json"), "utf8")) as {
  maps: { id: string; width: number; height: number }[];
  worldLayout?: {
    components: Array<{
      bounds: { minTileX: number; minTileY: number; maxTileX: number; maxTileY: number };
      placements: Array<{ mapId: string; originTileX: number; originTileY: number }>;
    }>;
  };
};

function load(name: string, width: number) {
  const entry = manifest.frames.find((frame) => frame.name === name && frame.width === width)!;
  const path = join(ROOT, "tests/goldens", entry.file);
  const bytes = new Uint8Array(readFileSync(path));
  return { entry, bytes, image: decodePng(bytes, path) };
}

function count(
  rgba: Uint8Array,
  width: number,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  predicate: (r: number, g: number, b: number) => boolean,
): number {
  let total = 0;
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
    const i = (y * width + x) * 4;
    if (predicate(rgba[i]!, rgba[i + 1]!, rgba[i + 2]!)) total++;
  }
  return total;
}

const green = (r: number, g: number, b: number) => g > r * 1.25 && g > b * 1.15 && g > 75;
const blue = (r: number, g: number, b: number) => b > r * 1.25 && b > g * 1.05 && b > 100;
const tan = (r: number, g: number, b: number) => r > 130 && g > 105 && g < r * 1.15 && b < g * 0.9;
const red = (r: number, g: number, b: number) => r > 140 && r > g * 1.3 && r > b * 1.25;
const gray = (r: number, g: number, b: number) =>
  Math.max(r, g, b) - Math.min(r, g, b) < 18 && r > 80 && r < 220;
const pink = (r: number, g: number, b: number) => r > 140 && b > 80 && r > g * 1.2;

function playerImage(frame: GoldenFrame): string {
  const pose = walkPose(frame.player.phase);
  return pose === 1
    ? PLAYER.walkL[frame.player.facing]!
    : pose === 2 ? PLAYER.walkR[frame.player.facing]! : PLAYER.idle[frame.player.facing]!;
}

function matchingPlayerPixels(frame: GoldenFrame): { opaque: number; matching: number } {
  const target = load(frame.name, frame.width).image;
  const sourcePath = join(ROOT, playerImage(frame));
  const sprite = decodePng(new Uint8Array(readFileSync(sourcePath)), sourcePath);
  const map = project.maps.find((candidate) => candidate.id === frame.map)!;
  const component = project.worldLayout?.components.find((candidate) =>
    candidate.placements.some((placement) => placement.mapId === frame.map)
  );
  const placement = component?.placements.find((candidate) => candidate.mapId === frame.map);
  const componentW = component ? (component.bounds.maxTileX - component.bounds.minTileX) * 16 : map.width * 16;
  const componentH = component ? (component.bounds.maxTileY - component.bounds.minTileY) * 16 : map.height * 16;
  const offsetX = Math.max(0, Math.floor((frame.width - componentW) / 2));
  const offsetY = Math.max(0, Math.floor((frame.height - componentH) / 2));
  const worldX = frame.player.pixel[0] + (placement?.originTileX ?? 0) * 16;
  const worldY = frame.player.pixel[1] + (placement?.originTileY ?? 0) * 16;
  const x0 = offsetX + worldX - frame.camera[0];
  const y0 = offsetY + worldY - frame.camera[1] - 16;
  let opaque = 0;
  let matching = 0;
  for (let y = 0; y < sprite.height; y++) for (let x = 0; x < sprite.width; x++) {
    const from = (y * sprite.width + x) * 4;
    if (sprite.rgba[from + 3] !== 255) continue;
    opaque++;
    const to = ((y0 + y) * target.width + x0 + x) * 4;
    // Accept a per-channel tolerance: the kit bump shifted world rendering
    // by up to ~12 levels (e.g. pure-black outlines render as 12,10,6),
    // and the check is about sprite identity and position, not bit-exact
    // blending.
    if (
      Math.abs(sprite.rgba[from]! - target.rgba[to]!) <= 12 &&
      Math.abs(sprite.rgba[from + 1]! - target.rgba[to + 1]!) <= 12 &&
      Math.abs(sprite.rgba[from + 2]! - target.rgba[to + 2]!) <= 12 &&
      sprite.rgba[from + 3] === target.rgba[to + 3]
    ) matching++;
  }
  return { opaque, matching };
}

describe("GB6 Route 3 mainline map goldens", () => {
  test("manifest pins four clear-map checkpoints at both resolutions", () => {
    expect(manifest.format).toBe("pocket-tuxemon/gb6-route-goldens/v1");
    expect(manifest.worldTraversal).toBe(journey.worldTraversal);
    expect(manifest.tapeSha256).toBe(journey.tapeSha256);
    expect(manifest.tapeSha256).toBe(createHash("sha256").update(JSON.stringify(journey.masks)).digest("hex"));
    expect(manifest.frames.map(({ name, map, frame, width, height }) =>
      [name, map, frame, width, height]
    )).toEqual([
      ["cotton-town", "spyder_cotton_town", 5_406, 480, 272],
      ["route-2", "spyder_route2", 10_550, 480, 272],
      ["city-park", "spyder_citypark", 44_975, 480, 272],
      ["route-3-end", "spyder_route3", 110_243, 480, 272],
      ["cotton-town", "spyder_cotton_town", 5_406, 960, 544],
      ["route-2", "spyder_route2", 10_550, 960, 544],
      ["city-park", "spyder_citypark", 44_975, 960, 544],
      ["route-3-end", "spyder_route3", 110_243, 960, 544],
    ]);
    for (const frame of manifest.frames) {
      expect(frame.timelineFrame, frame.file).toBe(frame.frame + 1);
      const loaded = load(frame.name, frame.width);
      expect([loaded.image.width, loaded.image.height], frame.file).toEqual([frame.width, frame.height]);
      expect(createHash("sha256").update(loaded.bytes).digest("hex"), frame.file).toBe(frame.pngSha256);
      expect(fnv1a(loaded.image.rgba), frame.file).toBe(frame.rgbaFnv1a);
      expect(frame.player.tile, frame.file).toEqual(frame.position);
      const player = matchingPlayerPixels(frame);
      expect(player.opaque, frame.file).toBeGreaterThan(80);
      // A handful of sprite pixels can land behind foreground scene objects
      // (depth compositing), so require a near-exact match rather than a
      // perfect one.
      expect(player.matching, frame.file).toBeGreaterThanOrEqual(player.opaque - 30);
    }
  });

  test("each map keeps its distinct terrain and landmark palette", () => {
    for (const width of [480, 960]) {
      const cotton = load("cotton-town", width).image;
      const route2 = load("route-2", width).image;
      const park = load("city-park", width).image;
      const route3 = load("route-3-end", width).image;

      // Cotton Town: broad grass/road network, red roofs, fountain and blue mart.
      expect(count(cotton.rgba, width, 0, 0, cotton.width, cotton.height, green)).toBeGreaterThan(60_000);
      expect(count(cotton.rgba, width, 0, 0, cotton.width, cotton.height, tan))
        .toBeGreaterThan(width === 480 ? 12_000 : 25_000);
      expect(count(cotton.rgba, width, 0, 0, cotton.width, cotton.height, red))
        .toBeGreaterThan(width === 480 ? 2_400 : 6_000);
      expect(count(cotton.rgba, width, 0, 0, cotton.width, cotton.height, blue))
        .toBeGreaterThan(width === 480 ? 3_200 : 4_000);

      // Route 2: dense grass/forest, brown ledges and gray route monuments.
      expect(count(route2.rgba, width, 0, 0, route2.width, route2.height, green))
        .toBeGreaterThan(width === 480 ? 80_000 : 100_000);
      expect(count(route2.rgba, width, 0, 0, route2.width, route2.height, red)).toBeGreaterThan(4_000);
      expect(count(route2.rgba, width, 0, 0, route2.width, route2.height, gray)).toBeGreaterThan(1_400);

      // City Park: tree canopy, flower beds, blue fence/water and pink blossoms.
      expect(count(park.rgba, width, 0, 0, park.width, park.height, green)).toBeGreaterThan(100_000);
      expect(count(park.rgba, width, 0, 0, park.width, park.height, blue))
        .toBeGreaterThan(width === 480 ? 300 : 2_500);
      expect(count(park.rgba, width, 0, 0, park.width, park.height, pink)).toBeGreaterThan(2_400);

      // Route 3 endpoint: sand quarry, tree border, benches/pillars and crystals.
      expect(count(route3.rgba, width, 0, 0, route3.width, route3.height, tan))
        .toBeGreaterThan(width === 480 ? 18_000 : 49_000);
      expect(count(route3.rgba, width, 0, 0, route3.width, route3.height, green)).toBeGreaterThan(45_000);
      expect(count(route3.rgba, width, 0, 0, route3.width, route3.height, gray))
        .toBeGreaterThan(width === 480 ? 1_000 : 1_200);
      expect(count(route3.rgba, width, 0, 0, route3.width, route3.height, blue))
        .toBeGreaterThan(width === 480 ? 380 : 400);
    }
  });
});
