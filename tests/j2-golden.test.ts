import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { DAYLIGHT_TINT_PROFILES } from "../battle/daylight.ts";
import { decodePng } from "../importer/png.ts";
import { fnv1a } from "../vendor/pocket-rpgkit/vendor/pocketjs/hosts/sim/sim.ts";

interface StoryMark {
  captainReturns: number;
  dojoMagician: number;
  dojoThriMonster: number;
  nimrodTruWon: boolean;
  seenTimber: number;
  scoopLandrace: number;
  seenCandy: number;
  lootenWon: boolean;
  aardant: number;
  passcodeColorReset: number;
  passcodeNumberReset: number;
  screenDown: number;
  hospitalCure: number;
  hospitalBillie: number;
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
const manifest = JSON.parse(readFileSync(join(ROOT, "data/j2-goldens.json"), "utf8")) as {
  format: string;
  baseFrames: number;
  segmentTapeSha256: string;
  combinedTapeSha256: string;
  frames: GoldenFrame[];
};
const gb6 = JSON.parse(readFileSync(join(ROOT, "data/gb6-mainline-journey.json"), "utf8")) as {
  frames: number;
  masks: number[];
  tapeSha256: string;
};
const j1 = JSON.parse(readFileSync(join(ROOT, "data/j1-captainreturns-journey.json"), "utf8")) as {
  frames: number;
  combinedFrames: number;
  masks: number[];
  tapeSha256: string;
  combinedTapeSha256: string;
};
const journey = JSON.parse(readFileSync(join(ROOT, "data/j2-hospitalcure-journey.json"), "utf8")) as {
  frames: number;
  combinedFrames: number;
  masks: number[];
  tapeSha256: string;
  combinedTapeSha256: string;
  maps: { name: string; frame: number; map: string; position: [number, number] }[];
  story: {
    captainReturns: number;
    dojoMagician: number;
    dojoThriMonster: number;
    nimrodTruWon: boolean;
    seenTimber: number;
    scoopLandrace: number;
    seenCandy: number;
    lootenWon: boolean;
    aardant: number;
    passwordColor: string;
    passwordNumber: string;
    passcodeColorReset: number;
    passcodeNumberReset: number;
    screenDown: number;
    hospitalCure: number;
  };
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

// The goldens start the clock at the fixed 09:00 (FIXED_TIME_HOST_GLOBALS),
// so the merged J2 tape reaches these checkpoints during the morning stage,
// whose daylight profile is transparent. ScreenEffectsLayer paints the tint
// after the map, actors, and imported overlays; the integer blend below is
// kept identical to PocketJS's RGBA rasterizer so a different stage would
// still identify the actual source art.
const J2_DAYLIGHT_TINT = DAYLIGHT_TINT_PROFILES.find((profile) => profile.stage === "morning")!.color;

function daylightColour(red: number, green: number, blue: number): [number, number, number] {
  const { r, g, b, a } = J2_DAYLIGHT_TINT;
  const keep = 255 - a;
  const mix = (source: number, tint: number): number =>
    Math.floor((tint * a + source * keep + 127) / 255);
  return [mix(red, r), mix(green, g), mix(blue, b)];
}

function countDaylightColour(rgba: Uint8Array, red: number, green: number, blue: number): number {
  return countColour(rgba, ...daylightColour(red, green, blue));
}

function matchingComposite(frame: GoldenFrame, marks: readonly PaintMark[]) {
  const target = load(frame.name, frame.width).image;
  const map = project.maps.find((candidate) => candidate.id === frame.map)!;
  const offsetX = Math.max(0, Math.floor((frame.width - map.width * 16) / 2));
  const offsetY = Math.max(0, Math.floor((frame.height - map.height * 16) / 2));
  const expected = new Map<number, [number, number, number, number]>();
  let sourceOpaque = 0;

  // Characters are painter-sorted by their feet. A lower mark replaces
  // overlapping pixels from a mark above it.
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
        ...daylightColour(sprite.rgba[from]!, sprite.rgba[from + 1]!, sprite.rgba[from + 2]!),
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

const completedPreHospital: Omit<StoryMark, "screenDown" | "hospitalCure"> = {
  captainReturns: 1,
  dojoMagician: 1,
  dojoThriMonster: 1,
  nimrodTruWon: true,
  seenTimber: 1,
  scoopLandrace: 1,
  seenCandy: 1,
  lootenWon: true,
  aardant: 1,
  passcodeColorReset: 0,
  passcodeNumberReset: 0,
  hospitalBillie: 0,
};

describe("J2 Greenwash and hospital location goldens", () => {
  test("manifest is tied to the frozen GB6 and J1 parents plus standalone J2 masks", () => {
    const baseMasks = [...gb6.masks, ...j1.masks];
    expect(manifest.format).toBe("pocket-tuxemon/j2-goldens/v1");
    expect(gb6.frames).toBe(gb6.masks.length);
    expect(gb6.tapeSha256).toBe(sha256(JSON.stringify(gb6.masks)));
    expect(j1.frames).toBe(j1.masks.length);
    expect(j1.tapeSha256).toBe(sha256(JSON.stringify(j1.masks)));
    expect(j1.combinedFrames).toBe(baseMasks.length);
    expect(j1.combinedTapeSha256).toBe(sha256(JSON.stringify(baseMasks)));
    expect(manifest.baseFrames).toBe(baseMasks.length);
    expect(journey.frames).toBe(journey.masks.length);
    expect(manifest.segmentTapeSha256).toBe(journey.tapeSha256);
    expect(manifest.segmentTapeSha256).toBe(sha256(JSON.stringify(journey.masks)));
    expect(journey.combinedFrames).toBe(baseMasks.length + journey.masks.length);
    expect(manifest.combinedTapeSha256).toBe(journey.combinedTapeSha256);
    expect(manifest.combinedTapeSha256)
      .toBe(sha256(JSON.stringify([...baseMasks, ...journey.masks])));
    expect(journey.story).toEqual({
      captainReturns: 1,
      dojoMagician: 1,
      dojoThriMonster: 1,
      nimrodTruWon: true,
      seenTimber: 1,
      scoopLandrace: 1,
      seenCandy: 1,
      lootenWon: true,
      aardant: 1,
      passwordColor: "Blue",
      passwordNumber: "10",
      passcodeColorReset: 0,
      passcodeNumberReset: 0,
      screenDown: 1,
      hospitalCure: 1,
    });
    expect(manifest.frames.map(({ name, map, frame, mergedFrame, width, height }) =>
      [name, map, frame, mergedFrame, width, height]
    )).toEqual([
      ["aardant-acquired", "spyder_greenwash", 49_793, 171_561, 480, 272],
      ["hospital-password", "spyder_candy_hospital2", 50_432, 172_200, 480, 272],
      ["hospital-cure", "spyder_candy_hospital3", 51_230, 172_998, 480, 272],
      ["aardant-acquired", "spyder_greenwash", 49_793, 171_561, 960, 544],
      ["hospital-password", "spyder_candy_hospital2", 50_432, 172_200, 960, 544],
      ["hospital-cure", "spyder_candy_hospital3", 51_230, 172_998, 960, 544],
    ]);
  });

  test("manifest checkpoint frames match the journey marks", () => {
    // The golden manifest must track the re-recorded tape: every checkpoint
    // frame equals the journey mark's frame, and the merged frame equals
    // baseFrames + frame. This catches a tape re-record that forgot to move
    // the goldens (the B5 regression where the manifest stayed eight frames
    // early).
    const baseFrames = gb6.frames + j1.frames;
    for (const name of ["aardant-acquired", "hospital-password", "hospital-cure"] as const) {
      const mark = journey.maps.find((candidate) => candidate.name === name);
      expect(mark, `${name} journey mark`).toBeDefined();
      for (const frame of manifest.frames.filter((candidate) => candidate.name === name)) {
        expect(frame.frame, `${name} ${frame.width} frame`).toBe(mark!.frame);
        expect(frame.mergedFrame, `${name} ${frame.width} mergedFrame`).toBe(baseFrames + mark!.frame);
      }
    }
  });

  test("PNG bytes, RGBA output, story stages, and player compositing are frozen", () => {
    const expectedStory: Record<string, StoryMark> = {
      "aardant-acquired": { ...completedPreHospital, screenDown: 0, hospitalCure: 0 },
      "hospital-password": { ...completedPreHospital, screenDown: 0, hospitalCure: 0 },
      "hospital-cure": { ...completedPreHospital, screenDown: 1, hospitalCure: 1 },
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
      if (frame.name === "hospital-password") {
        // The upstream Hospital 2 autorun installs the opaque torchlight
        // overlay below the daylight grade. Only the portion of the player
        // inside its aperture remains the daylight-graded source sprite.
        expect(player.matching, frame.file).toBeGreaterThan(50);
        expect(player.matching, frame.file).toBeLessThan(player.painted);
      } else {
        expect(player.matching, frame.file).toBe(player.painted);
      }
    }
  });

  test("Looten and the player are depth-composited exactly after the Aardant reward", () => {
    for (const width of [480, 960]) {
      const frame = load("aardant-acquired", width).entry;
      expect(frame.actor).toMatchObject({
        id: "npc_spyder_greenwash_looten",
        sprite: "npc.goth",
        tile: [7, 30],
        pixel: [112, 480],
      });
      const composite = matchingComposite(frame, [frame.actor!, frame.player]);
      expect(composite.sourceOpaque, frame.file).toBeGreaterThan(composite.painted);
      expect(composite.painted, frame.file).toBeGreaterThan(160);
      expect(composite.matching, frame.file).toBe(composite.painted);
    }
  });

  test("Greenwash woodwork and both Candy Hospital laboratories remain visibly distinct", () => {
    for (const width of [480, 960]) {
      const greenwash = load("aardant-acquired", width).image.rgba;
      expect(countDaylightColour(greenwash, 208, 185, 156), `${width}: Greenwash plank floor`)
        .toBeGreaterThan(10_000);
      expect(countDaylightColour(greenwash, 174, 147, 122), `${width}: Greenwash plank shading`)
        .toBeGreaterThan(8_000);
      expect(countDaylightColour(greenwash, 118, 107, 163), `${width}: Greenwash machinery`)
        .toBeGreaterThan(4_000);

      const hospital2 = load("hospital-password", width).image.rgba;
      expect(countDaylightColour(hospital2, 0, 0, 0), `${width}: Hospital 2 torchlight darkness`)
        .toBeGreaterThan(width * (width === 480 ? 272 : 544) * 0.9);
      expect(countDaylightColour(hospital2, 204, 230, 236), `${width}: Hospital 2 pale floor`)
        .toBeGreaterThan(1_200);
      expect(countDaylightColour(hospital2, 226, 242, 243), `${width}: Hospital 2 laboratory highlights`)
        .toBeGreaterThan(300);

      const hospital3 = load("hospital-cure", width).image.rgba;
      expect(countDaylightColour(hospital3, 204, 230, 236), `${width}: Hospital 3 pale floor`)
        .toBeGreaterThan(18_000);
      expect(countDaylightColour(hospital3, 202, 136, 84), `${width}: Hospital 3 specimen cabinets`)
        .toBeGreaterThan(400);
      expect(countDaylightColour(hospital3, 50, 103, 90), `${width}: cure console display`)
        .toBeGreaterThan(75);
    }

    // Each larger framebuffer exposes additional real map pixels instead of
    // padding a stale 480x272 render with black.
    const greenwashLow = load("aardant-acquired", 480).image.rgba;
    const greenwashHigh = load("aardant-acquired", 960).image.rgba;
    expect(countDaylightColour(greenwashHigh, 208, 185, 156))
      .toBeGreaterThan(countDaylightColour(greenwashLow, 208, 185, 156) * 1.8);
    const hospital2Low = load("hospital-password", 480).image.rgba;
    const hospital2High = load("hospital-password", 960).image.rgba;
    expect(countDaylightColour(hospital2High, 226, 242, 243))
      .toBeGreaterThan(countDaylightColour(hospital2Low, 226, 242, 243) * 1.4);
    const hospital3Low = load("hospital-cure", 480).image.rgba;
    const hospital3High = load("hospital-cure", 960).image.rgba;
    expect(countDaylightColour(hospital3High, 204, 230, 236))
      .toBeGreaterThan(countDaylightColour(hospital3Low, 204, 230, 236) * 1.15);
  });
});
