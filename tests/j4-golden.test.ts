import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { decodePng } from "../importer/png.ts";
import { fnv1a } from "../vendor/pocket-rpgkit/vendor/pocketjs/hosts/sim/sim.ts";

interface StoryMark {
  kernelQuest: number;
  omnichannelRadioAnnounce: number;
  bumpIntoMom: number;
  kernelQuestBegin: number;
  timberMom: number;
  routeBBillie: number;
  dataScreen1: number;
  dataScreen2: number;
  dataScreen3: number;
  dataScreen4: number;
  dataScreen5: number;
  dataScreen6: number;
  dataScreen7: number;
  dataCenterBillie: number;
  spyderPass: number;
  surfboard: number;
  swimming: number;
  goldPass: number;
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
  timelineFrame: number;
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
}

interface JourneyTape {
  worldTraversal: string;
  frames: number;
  combinedFrames?: number;
  masks: number[];
  tapeSha256: string;
  combinedTapeSha256?: string;
}

const ROOT = resolve(import.meta.dir, "..");
const manifest = JSON.parse(readFileSync(join(ROOT, "data/j4-goldens.json"), "utf8")) as {
  format: string;
  baseFrames: number;
  segmentTapeSha256: string;
  combinedTapeSha256: string;
  frames: GoldenFrame[];
};
const gb6 = JSON.parse(
  readFileSync(join(ROOT, "data/gb6-mainline-journey.json"), "utf8"),
) as JourneyTape;
const j1 = JSON.parse(
  readFileSync(join(ROOT, "data/j1-captainreturns-journey.json"), "utf8"),
) as JourneyTape;
const j2 = JSON.parse(
  readFileSync(join(ROOT, "data/j2-hospitalcure-journey.json"), "utf8"),
) as JourneyTape;
const j3 = JSON.parse(
  readFileSync(join(ROOT, "data/j3-omnichannelradioannounce-journey.json"), "utf8"),
) as JourneyTape;
const journey = JSON.parse(
  readFileSync(join(ROOT, "data/j4-kernelquestdone-journey.json"), "utf8"),
) as JourneyTape & {
  combinedFrames: number;
  combinedTapeSha256: string;
  steps: (StoryMark & {
    name: string;
    frame: number;
    map: string;
    position: [number, number];
    battleCount: number;
  })[];
  story: StoryMark & { beaverbrookWon: boolean; kernelWon: boolean };
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

function matchingComposite(frame: GoldenFrame, mark: PaintMark) {
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
  const sourcePath = join(ROOT, mark.image);
  const sprite = decodePng(new Uint8Array(readFileSync(sourcePath)), sourcePath);
  const worldX = mark.pixel[0] + (placement?.originTileX ?? 0) * 16;
  const worldY = mark.pixel[1] + (placement?.originTileY ?? 0) * 16;
  const x0 = offsetX + worldX - frame.camera[0];
  const y0 = offsetY + worldY - frame.camera[1] + 16 - mark.height;
  let painted = 0;
  let matching = 0;
  for (let y = 0; y < sprite.height; y++) for (let x = 0; x < sprite.width; x++) {
    const from = (y * sprite.width + x) * 4;
    if (sprite.rgba[from + 3] !== 255) continue;
    const tx = x0 + x;
    const ty = y0 + y;
    expect(tx, `${frame.file}: sprite x`).toBeGreaterThanOrEqual(0);
    expect(tx, `${frame.file}: sprite x`).toBeLessThan(target.width);
    expect(ty, `${frame.file}: sprite y`).toBeGreaterThanOrEqual(0);
    expect(ty, `${frame.file}: sprite y`).toBeLessThan(target.height);
    painted++;
    const at = (ty * target.width + tx) * 4;
    if (
      Math.abs(target.rgba[at]! - sprite.rgba[from]!) <= 12 &&
      Math.abs(target.rgba[at + 1]! - sprite.rgba[from + 1]!) <= 12 &&
      Math.abs(target.rgba[at + 2]! - sprite.rgba[from + 2]!) <= 12 &&
      target.rgba[at + 3] === sprite.rgba[from + 3]
    ) matching++;
  }
  return { painted, matching };
}

const questReady: StoryMark = {
  kernelQuest: 2,
  omnichannelRadioAnnounce: 1,
  bumpIntoMom: 1,
  kernelQuestBegin: 1,
  timberMom: 1,
  routeBBillie: 0,
  dataScreen1: 0,
  dataScreen2: 0,
  dataScreen3: 0,
  dataScreen4: 0,
  dataScreen5: 0,
  dataScreen6: 0,
  dataScreen7: 0,
  dataCenterBillie: 0,
  spyderPass: 1,
  surfboard: 1,
  swimming: 0,
  goldPass: 0,
};
const screensOpen: StoryMark = {
  ...questReady,
  routeBBillie: 1,
  dataScreen1: 1,
  dataScreen2: 1,
  dataScreen3: 1,
  dataScreen4: 1,
  dataScreen5: 1,
  dataScreen6: 1,
  dataScreen7: 1,
  swimming: 1,
};

describe("J4 Surfboard and Data Center location goldens", () => {
  test("manifest follows the frozen four-part parent plus standalone J4 masks", () => {
    const parentMasks = [...gb6.masks, ...j1.masks, ...j2.masks, ...j3.masks];
    const combinedMasks = [...parentMasks, ...journey.masks];
    expect(manifest.format).toBe("pocket-tuxemon/j4-goldens/v1");
    for (const tape of [gb6, j1, j2, j3, journey]) {
      expect(tape.worldTraversal).toBe("seamless-v1");
      expect(tape.frames).toBe(tape.masks.length);
      expect(tape.tapeSha256).toBe(sha256(JSON.stringify(tape.masks)));
    }
    expect(manifest.baseFrames).toBe(parentMasks.length);
    expect(manifest.baseFrames).toBe(185_921);
    expect(manifest.segmentTapeSha256).toBe(journey.tapeSha256);
    expect(journey.combinedFrames).toBe(combinedMasks.length);
    expect(manifest.combinedTapeSha256).toBe(journey.combinedTapeSha256);
    expect(manifest.combinedTapeSha256).toBe(sha256(JSON.stringify(combinedMasks)));
    expect(manifest.frames.map(({ name, map, frame, mergedFrame, width, height }) =>
      [name, map, frame, mergedFrame, width, height]
    )).toEqual([
      ["surfboard-collected", "spyder_candy_town", 3_239, 189_160, 480, 272],
      ["datacenter-upper-screens", "spyder_datacenter", 12_464, 198_385, 480, 272],
      ["kernel-defeated", "spyder_datacenter", 13_386, 199_307, 480, 272],
      ["surfboard-collected", "spyder_candy_town", 3_239, 189_160, 960, 544],
      ["datacenter-upper-screens", "spyder_datacenter", 12_464, 198_385, 960, 544],
      ["kernel-defeated", "spyder_datacenter", 13_386, 199_307, 960, 544],
    ]);
  });

  test("manifest checkpoints and story state remain synchronized with J4", () => {
    const expectedStory: Record<string, StoryMark> = {
      "surfboard-collected": questReady,
      "datacenter-upper-screens": screensOpen,
      "kernel-defeated": { ...screensOpen, kernelQuest: 1, dataCenterBillie: 1 },
    };
    for (const frame of manifest.frames) {
      const mark = journey.steps.find((candidate) => candidate.name === frame.name);
      expect(mark, `${frame.name} journey mark`).toBeDefined();
      expect([frame.frame, frame.mergedFrame], frame.file)
        .toEqual([mark!.frame, manifest.baseFrames + mark!.frame]);
      expect(frame.timelineFrame, frame.file).toBe(frame.mergedFrame + 1);
      expect([frame.map, frame.position], frame.file).toEqual([mark!.map, mark!.position]);
      expect(frame.story, frame.file).toEqual(expectedStory[frame.name]);
    }
    expect(journey.story).toEqual({
      ...screensOpen,
      kernelQuest: 1,
      dataCenterBillie: 1,
      beaverbrookWon: true,
      kernelWon: true,
    });
  });

  test("PNG bytes, RGBA output, and player compositing are frozen", () => {
    for (const frame of manifest.frames) {
      const loaded = load(frame.name, frame.width);
      expect([loaded.image.width, loaded.image.height], frame.file).toEqual([frame.width, frame.height]);
      expect(sha256(loaded.bytes), frame.file).toBe(frame.pngSha256);
      expect(fnv1a(loaded.image.rgba), frame.file).toBe(frame.rgbaFnv1a);
      expect(frame.player.tile, frame.file).toEqual(frame.position);
      expect(frame.player.pixel, frame.file)
        .toEqual([frame.player.tile[0] * 16, frame.player.tile[1] * 16]);
      const player = matchingComposite(frame, frame.player);
      expect(player.painted, frame.file).toBeGreaterThan(80);
      expect(player.matching, frame.file).toBeGreaterThanOrEqual(player.painted - 30);
    }
  });

  test("Candy Town water and the Data Center server grid remain visible", () => {
    for (const width of [480, 960]) {
      const town = load("surfboard-collected", width).image.rgba;
      expect(countColour(town, 64, 176, 128), `${width}: Candy Town grass`)
        .toBeGreaterThan(40_000);
      expect(countColour(town, 61, 106, 179), `${width}: Candy Town water`)
        .toBeGreaterThan(25_000);
      expect(countColour(town, 216, 200, 128), `${width}: Candy Town paths`)
        .toBeGreaterThan(7_000);

      for (const name of ["datacenter-upper-screens", "kernel-defeated"]) {
        const center = load(name, width).image.rgba;
        expect(countColour(center, 55, 58, 61), `${width}: Data Center walls`)
          .toBeGreaterThan(18_000);
        expect(countColour(center, 67, 67, 93), `${width}: Data Center floor`)
          .toBeGreaterThan(16_000);
        expect(countColour(center, 153, 163, 198), `${width}: Data Center cabinets`)
          .toBeGreaterThan(5_700);
        expect(countColour(center, 164, 183, 206), `${width}: Data Center highlights`)
          .toBeGreaterThan(3_600);
      }
    }

    // The larger logical viewport reveals much more of the outdoor map; it
    // is not an upscaled or padded copy of the 480x272 framebuffer.
    const low = load("surfboard-collected", 480).image.rgba;
    const high = load("surfboard-collected", 960).image.rgba;
    expect(countColour(high, 61, 106, 179))
      .toBeGreaterThan(countColour(low, 61, 106, 179) * 4);
  });
});
