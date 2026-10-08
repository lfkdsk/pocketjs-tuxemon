import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { decodePng } from "../importer/png.ts";
import { fnv1a } from "../vendor/pocket-rpgkit/vendor/pocketjs/hosts/sim/sim.ts";

interface StoryMark {
  hospitalCure: number;
  hospitalBillie: number;
  nurseSpyder: number;
  spyderPass: number;
  omnichannelReadyWall: number;
  omnichannel1Wall: number;
  beaverbrookWon: boolean;
  kernelQuest: number;
  omnichannelRadioAnnounce: number;
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

interface JourneyTape {
  frames: number;
  combinedFrames?: number;
  masks: number[];
  tapeSha256: string;
  combinedTapeSha256?: string;
}

const ROOT = resolve(import.meta.dir, "..");
const manifest = JSON.parse(readFileSync(join(ROOT, "data/j3-goldens.json"), "utf8")) as {
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
const journey = JSON.parse(
  readFileSync(join(ROOT, "data/j3-omnichannelradioannounce-journey.json"), "utf8"),
) as JourneyTape & {
  combinedFrames: number;
  combinedTapeSha256: string;
  maps: { name: string; frame: number; map: string; position: [number, number] }[];
  story: StoryMark & { omnichannel1CollisionRemoved: number };
};
const project = JSON.parse(readFileSync(join(ROOT, "dist/project.json"), "utf8")) as {
  maps: { id: string; width: number; height: number }[];
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
  const offsetX = Math.max(0, Math.floor((frame.width - map.width * 16) / 2));
  const offsetY = Math.max(0, Math.floor((frame.height - map.height * 16) / 2));
  const expected = new Map<number, [number, number, number, number]>();
  let sourceOpaque = 0;

  // Characters are painter-sorted by their feet. A lower mark replaces any
  // overlapping opaque source pixel from a character above it.
  for (const mark of marks) {
    const sourcePath = join(ROOT, mark.image);
    const sprite = decodePng(new Uint8Array(readFileSync(sourcePath)), sourcePath);
    const x0 = offsetX + mark.pixel[0] - frame.camera[0];
    const y0 = offsetY + mark.pixel[1] - frame.camera[1] + 16 - mark.height;
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

const beforeBroadcast: StoryMark = {
  hospitalCure: 1,
  hospitalBillie: 1,
  nurseSpyder: 1,
  spyderPass: 1,
  omnichannelReadyWall: 1,
  omnichannel1Wall: 1,
  beaverbrookWon: false,
  kernelQuest: 0,
  omnichannelRadioAnnounce: 0,
};

describe("J3 Omnichannel and Radio Tower location goldens", () => {
  test("manifest follows the frozen GB6, J1, and J2 parents plus standalone J3 masks", () => {
    const parentMasks = [...gb6.masks, ...j1.masks, ...j2.masks];
    const combinedMasks = [...parentMasks, ...journey.masks];
    expect(manifest.format).toBe("pocket-tuxemon/j3-goldens/v1");
    for (const tape of [gb6, j1, j2, journey]) {
      expect(tape.frames).toBe(tape.masks.length);
      expect(tape.tapeSha256).toBe(sha256(JSON.stringify(tape.masks)));
    }
    expect(j1.combinedFrames).toBe(gb6.frames + j1.frames);
    expect(j1.combinedTapeSha256).toBe(sha256(JSON.stringify([...gb6.masks, ...j1.masks])));
    expect(j2.combinedFrames).toBe(parentMasks.length);
    expect(j2.combinedTapeSha256).toBe(sha256(JSON.stringify(parentMasks)));
    expect(manifest.baseFrames).toBe(parentMasks.length);
    expect(manifest.segmentTapeSha256).toBe(journey.tapeSha256);
    expect(journey.combinedFrames).toBe(combinedMasks.length);
    expect(manifest.combinedTapeSha256).toBe(journey.combinedTapeSha256);
    expect(manifest.combinedTapeSha256).toBe(sha256(JSON.stringify(combinedMasks)));
    expect(journey.story).toEqual({
      hospitalCure: 1,
      hospitalBillie: 1,
      nurseSpyder: 1,
      spyderPass: 1,
      omnichannelReadyWall: 1,
      omnichannel1Wall: 1,
      omnichannel1CollisionRemoved: 1,
      beaverbrookWon: true,
      kernelQuest: 2,
      omnichannelRadioAnnounce: 1,
    });
    expect(manifest.frames.map(({ name, map, frame, mergedFrame, width, height }) =>
      [name, map, frame, mergedFrame, width, height]
    )).toEqual([
      ["omnichannel-wall", "spyder_omnichannel1", 7_479, 187_596, 480, 272],
      ["radio-tower-entry", "spyder_radiotower", 11_772, 191_889, 480, 272],
      ["radio-broadcast", "spyder_radiotower", 13_101, 193_218, 480, 272],
      ["omnichannel-wall", "spyder_omnichannel1", 7_479, 187_596, 960, 544],
      ["radio-tower-entry", "spyder_radiotower", 11_772, 191_889, 960, 544],
      ["radio-broadcast", "spyder_radiotower", 13_101, 193_218, 960, 544],
    ]);
  });

  test("manifest checkpoint frames remain synchronized with the recorded journey", () => {
    for (const name of ["omnichannel-wall", "radio-tower-entry", "radio-broadcast"] as const) {
      const mark = journey.maps.find((candidate) => candidate.name === name);
      expect(mark, `${name} journey mark`).toBeDefined();
      for (const frame of manifest.frames.filter((candidate) => candidate.name === name)) {
        expect(frame.frame, `${frame.file}: frame`).toBe(mark!.frame);
        expect(frame.mergedFrame, `${frame.file}: merged frame`)
          .toBe(manifest.baseFrames + mark!.frame);
        expect([frame.map, frame.position], `${frame.file}: location`)
          .toEqual([mark!.map, mark!.position]);
      }
    }
  });

  test("PNG bytes, RGBA output, story stages, and player compositing are frozen", () => {
    const expectedStory: Record<string, StoryMark> = {
      "omnichannel-wall": beforeBroadcast,
      "radio-tower-entry": beforeBroadcast,
      "radio-broadcast": {
        ...beforeBroadcast,
        beaverbrookWon: true,
        kernelQuest: 2,
        omnichannelRadioAnnounce: 1,
      },
    };
    for (const frame of manifest.frames) {
      const loaded = load(frame.name, frame.width);
      expect([loaded.image.width, loaded.image.height], frame.file).toEqual([frame.width, frame.height]);
      expect(sha256(loaded.bytes), frame.file).toBe(frame.pngSha256);
      expect(fnv1a(loaded.image.rgba), frame.file).toBe(frame.rgbaFnv1a);
      expect(frame.story, frame.file).toEqual(expectedStory[frame.name]);
      expect(frame.player.tile, frame.file).toEqual(frame.position);
      expect(frame.player.pixel, frame.file)
        .toEqual([frame.player.tile[0] * 16, frame.player.tile[1] * 16]);
      const player = matchingComposite(frame, [frame.player]);
      expect(player.painted, frame.file).toBeGreaterThan(80);
      expect(player.matching, frame.file).toBe(player.painted);
    }
  });

  test("Danita and Beaverbrook are resolved and composited exactly", () => {
    for (const width of [480, 960]) {
      const wall = load("omnichannel-wall", width).entry;
      expect(wall.actor).toMatchObject({
        id: "npc_spyder_omnichannel_danita",
        sprite: "npc.nurse",
        tile: [2, 17],
        pixel: [32, 272],
      });
      const wallComposite = matchingComposite(wall, [wall.actor!, wall.player]);
      expect(wallComposite.painted, wall.file).toBeGreaterThan(160);
      expect(wallComposite.matching, wall.file).toBe(wallComposite.painted);

      const tower = load("radio-tower-entry", width).entry;
      expect(tower.actor).toMatchObject({
        id: "npc_spyder_omnichannel_beaverbrook",
        sprite: "npc.ceo",
        tile: [9, 12],
        pixel: [144, 192],
      });
      const towerComposite = matchingComposite(tower, [tower.actor!, tower.player]);
      expect(towerComposite.painted, tower.file).toBeGreaterThan(160);
      expect(towerComposite.matching, tower.file).toBe(towerComposite.painted);
    }
  });

  test("the open Omnichannel corridor, radio floor, and broadcast studio remain visible", () => {
    for (const width of [480, 960]) {
      const omnichannel = load("omnichannel-wall", width).image.rgba;
      expect(countColour(omnichannel, 164, 213, 213), `${width}: Omnichannel aqua floor`)
        .toBeGreaterThan(13_000);
      expect(countColour(omnichannel, 189, 241, 229), `${width}: Omnichannel mint corridor`)
        .toBeGreaterThan(9_000);
      expect(countColour(omnichannel, 126, 169, 176), `${width}: Omnichannel wall shading`)
        .toBeGreaterThan(8_000);

      const tower = load("radio-tower-entry", width).image.rgba;
      expect(countColour(tower, 219, 206, 170), `${width}: Radio Tower light floor`)
        .toBeGreaterThan(20_000);
      expect(countColour(tower, 195, 182, 162), `${width}: Radio Tower mid floor`)
        .toBeGreaterThan(15_000);
      expect(countColour(tower, 171, 151, 135), `${width}: Radio Tower floor shadow`)
        .toBeGreaterThan(11_000);

      const broadcast = load("radio-broadcast", width).image.rgba;
      expect(countColour(broadcast, 240, 215, 147), `${width}: broadcast desk gold`)
        .toBeGreaterThan(1_200);
      expect(countColour(broadcast, 240, 229, 199), `${width}: broadcast desk highlight`)
        .toBeGreaterThan(1_150);
      expect(countColour(broadcast, 120, 120, 120), `${width}: studio equipment`)
        .toBeGreaterThan(1_300);
    }

    // The two logical viewports expose different camera extents instead of
    // scaling or padding the 480x272 framebuffer.
    const low = load("omnichannel-wall", 480).image.rgba;
    const high = load("omnichannel-wall", 960).image.rgba;
    expect(countColour(high, 211, 246, 238))
      .toBeGreaterThan(countColour(low, 211, 246, 238) * 1.3);
  });
});
