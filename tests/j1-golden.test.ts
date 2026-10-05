import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { decodePng } from "../importer/png.ts";
import { fnv1a } from "../vendor/pocket-rpgkit/vendor/pocketjs/hosts/sim/sim.ts";

interface StoryMark {
  enforcersResponseDone: number;
  route4Billie: number;
  routeABillie: number;
  foundCaptain: number;
  captainReturns: number;
}

interface PaintMark {
  tile: [number, number];
  pixel: [number, number];
  facing: number;
  phase: number;
  image: string;
  height: number;
}

interface GoldenFrame {
  name: string;
  frame: number;
  mergedFrame: number;
  map: string;
  position: [number, number];
  width: number;
  height: number;
  file: string;
  rgbaFnv1a: string;
  pngSha256: string;
  camera: [number, number];
  story: StoryMark;
  player: PaintMark;
  actor?: PaintMark & { id: string; sprite: string };
}

const ROOT = resolve(import.meta.dir, "..");
const manifest = JSON.parse(readFileSync(join(ROOT, "data/j1-goldens.json"), "utf8")) as {
  format: string;
  baseFrames: number;
  segmentTapeSha256: string;
  combinedTapeSha256: string;
  frames: GoldenFrame[];
};
const base = JSON.parse(readFileSync(join(ROOT, "data/gb6-mainline-journey.json"), "utf8")) as {
  frames: number;
  masks: number[];
};
const journey = JSON.parse(readFileSync(join(ROOT, "data/j1-captainreturns-journey.json"), "utf8")) as {
  tapeSha256: string;
  combinedTapeSha256: string;
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

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function load(name: string, width: number) {
  const entry = manifest.frames.find((frame) => frame.name === name && frame.width === width)!;
  const path = join(ROOT, "tests/goldens", entry.file);
  const bytes = new Uint8Array(readFileSync(path));
  return { entry, bytes, image: decodePng(bytes, path) };
}

function countColour(rgba: Uint8Array, red: number, green: number, blue: number): number {
  let total = 0;
  for (let index = 0; index < rgba.length; index += 4) {
    if (rgba[index] === red && rgba[index + 1] === green && rgba[index + 2] === blue) total++;
  }
  return total;
}

function matchingComposite(frame: GoldenFrame, marks: readonly PaintMark[]) {
  const target = load(frame.name, frame.width).image;
  const map = project.maps.find((candidate) => candidate.id === frame.map)!;
  const component = project.worldLayout?.components.find((candidate) =>
    candidate.placements.some((placement) => placement.mapId === frame.map)
  );
  const placement = component?.placements.find((candidate) => candidate.mapId === frame.map);
  const componentW = component ? (component.bounds.maxTileX - component.bounds.minTileX) * 16 : map.width * 16;
  const componentH = component ? (component.bounds.maxTileY - component.bounds.minTileY) * 16 : map.height * 16;
  const offsetX = Math.max(0, Math.floor((frame.width - componentW) / 2));
  const offsetY = Math.max(0, Math.floor((frame.height - componentH) / 2));
  const expected = new Map<number, [number, number, number, number]>();
  let sourceOpaque = 0;

  // Character sprites are depth-sorted by their feet. Callers supply that
  // order, so a lower actor replaces overlapping pixels from an upper actor.
  for (const mark of marks) {
    const sourcePath = join(ROOT, mark.image);
    const sprite = decodePng(new Uint8Array(readFileSync(sourcePath)), sourcePath);
    const worldX = mark.pixel[0] + (placement?.originTileX ?? 0) * 16;
    const worldY = mark.pixel[1] + (placement?.originTileY ?? 0) * 16;
    const x0 = offsetX + worldX - frame.camera[0];
    const y0 = offsetY + worldY - frame.camera[1] + 16 - mark.height;
    for (let y = 0; y < sprite.height; y++) for (let x = 0; x < sprite.width; x++) {
      const from = (y * sprite.width + x) * 4;
      if (sprite.rgba[from + 3] !== 255) continue;
      sourceOpaque++;
      const tx = x0 + x;
      const ty = y0 + y;
      expect(tx, `${frame.file}: sprite x`).toBeGreaterThanOrEqual(0);
      expect(tx, `${frame.file}: sprite x`).toBeLessThan(target.width);
      expect(ty, `${frame.file}: sprite y`).toBeGreaterThanOrEqual(0);
      expect(ty, `${frame.file}: sprite y`).toBeLessThan(target.height);
      expected.set(ty * target.width + tx, [
        sprite.rgba[from]!,
        sprite.rgba[from + 1]!,
        sprite.rgba[from + 2]!,
        sprite.rgba[from + 3]!,
      ]);
    }
  }

  let matching = 0;
  for (const [pixel, colour] of expected) {
    const targetIndex = pixel * 4;
    if (
      target.rgba[targetIndex] === colour[0] &&
      target.rgba[targetIndex + 1] === colour[1] &&
      target.rgba[targetIndex + 2] === colour[2] &&
      target.rgba[targetIndex + 3] === colour[3]
    ) matching++;
  }
  return { sourceOpaque, painted: expected.size, matching };
}

describe("J1 captain-return location goldens", () => {
  test("manifest is tied to the frozen GB6 parent and standalone J1 masks", () => {
    expect(manifest.format).toBe("pocket-tuxemon/j1-goldens/v1");
    expect(manifest.baseFrames).toBe(base.frames);
    expect(manifest.segmentTapeSha256).toBe(journey.tapeSha256);
    expect(manifest.segmentTapeSha256).toBe(sha256(JSON.stringify(journey.masks)));
    expect(manifest.combinedTapeSha256).toBe(journey.combinedTapeSha256);
    expect(manifest.combinedTapeSha256)
      .toBe(sha256(JSON.stringify([...base.masks, ...journey.masks])));
    expect(manifest.frames.map(({ name, map, frame, mergedFrame, width, height }) =>
      [name, map, frame, mergedFrame, width, height]
    )).toEqual([
      ["wayfarer-guestbook", "spyder_wayfarer_inn1", 519, 110_763, 480, 272],
      ["route-4-billie", "spyder_route4", 4_717, 114_961, 480, 272],
      ["captain-found", "spyder_mansion_basement", 10_355, 120_599, 480, 272],
      ["wayfarer-guestbook", "spyder_wayfarer_inn1", 519, 110_763, 960, 544],
      ["route-4-billie", "spyder_route4", 4_717, 114_961, 960, 544],
      ["captain-found", "spyder_mansion_basement", 10_355, 120_599, 960, 544],
    ]);
  });

  test("PNG bytes, RGBA output, story state, and player compositing are frozen", () => {
    const expectedStory: Record<string, StoryMark> = {
      "wayfarer-guestbook": {
        enforcersResponseDone: 1,
        route4Billie: 0,
        routeABillie: 0,
        foundCaptain: 0,
        captainReturns: 0,
      },
      "route-4-billie": {
        enforcersResponseDone: 1,
        route4Billie: 1,
        routeABillie: 0,
        foundCaptain: 0,
        captainReturns: 0,
      },
      "captain-found": {
        enforcersResponseDone: 1,
        route4Billie: 1,
        routeABillie: 1,
        foundCaptain: 1,
        captainReturns: 0,
      },
    };
    for (const frame of manifest.frames) {
      const loaded = load(frame.name, frame.width);
      expect([loaded.image.width, loaded.image.height], frame.file).toEqual([frame.width, frame.height]);
      expect(sha256(loaded.bytes), frame.file).toBe(frame.pngSha256);
      expect(fnv1a(loaded.image.rgba), frame.file).toBe(frame.rgbaFnv1a);
      expect(frame.mergedFrame, frame.file).toBe(manifest.baseFrames + frame.frame);
      expect(frame.story, frame.file).toEqual(expectedStory[frame.name]);
      expect(frame.player.tile, frame.file).toEqual(frame.position);
      expect(frame.player.pixel, frame.file)
        .toEqual([frame.player.tile[0] * 16, frame.player.tile[1] * 16]);
      const player = matchingComposite(frame, [frame.player]);
      expect(player.painted, frame.file).toBeGreaterThan(80);
      expect(player.matching, frame.file).toBe(player.painted);
    }
  });

  test("Captain Flick and the player are depth-composited exactly at the rescue tile", () => {
    for (const width of [480, 960]) {
      const frame = load("captain-found", width).entry;
      expect(frame.actor).toMatchObject({
        id: "npc_spyder_basement_flick",
        sprite: "npc.riverboatcaptain",
        tile: [3, 4],
        pixel: [48, 64],
      });
      const composite = matchingComposite(frame, [frame.actor!, frame.player]);
      expect(composite.sourceOpaque, frame.file).toBeGreaterThan(composite.painted);
      expect(composite.painted, frame.file).toBeGreaterThan(160);
      expect(composite.matching, frame.file).toBe(composite.painted);
    }
  });

  test("Wayfarer woodwork, Route 4 vegetation, and Mansion masonry remain visible", () => {
    for (const width of [480, 960]) {
      const wayfarer = load("wayfarer-guestbook", width).image.rgba;
      expect(countColour(wayfarer, 63, 46, 64), `${width}: inn dark boards`).toBeGreaterThan(14_000);
      expect(countColour(wayfarer, 129, 94, 69), `${width}: inn wood floor`).toBeGreaterThan(3_400);
      expect(countColour(wayfarer, 242, 201, 159), `${width}: inn counters`).toBeGreaterThan(3_200);

      const route4 = load("route-4-billie", width).image.rgba;
      expect(countColour(route4, 64, 176, 128), `${width}: route grass`).toBeGreaterThan(58_000);
      expect(countColour(route4, 40, 104, 32), `${width}: route trees`).toBeGreaterThan(6_500);
      expect(countColour(route4, 56, 80, 0), `${width}: route crop rows`)
        .toBeGreaterThan(width === 480 ? 1_700 : 2_000);

      const basement = load("captain-found", width).image.rgba;
      expect(countColour(basement, 63, 46, 64), `${width}: cellar walls`).toBeGreaterThan(23_000);
      expect(countColour(basement, 113, 117, 130), `${width}: cellar floor`).toBeGreaterThan(18_000);
      expect(countColour(basement, 140, 134, 142), `${width}: cellar masonry`).toBeGreaterThan(14_000);
    }

    // The larger framebuffer must expose more map, not merely append black
    // pixels to a stale 480x272 camera/layout.
    const routeLow = load("route-4-billie", 480).image.rgba;
    const routeHigh = load("route-4-billie", 960).image.rgba;
    expect(countColour(routeHigh, 64, 176, 128))
      .toBeGreaterThan(countColour(routeLow, 64, 176, 128) * 1.8);
    const cellarLow = load("captain-found", 480).image.rgba;
    const cellarHigh = load("captain-found", 960).image.rgba;
    expect(countColour(cellarHigh, 113, 117, 130))
      .toBeGreaterThan(countColour(cellarLow, 113, 117, 130) * 1.2);
  });
});
