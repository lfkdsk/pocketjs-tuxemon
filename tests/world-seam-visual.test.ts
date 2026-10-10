import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { decodePng } from "../importer/png.ts";
import { PLAYER } from "../ui/game-assets.ts";
import {
  assertWorldSeamManifest,
  expectedWorldSeamFrameFiles,
  type WorldSeamManifest,
  WORLD_SEAM_CROSSINGS,
  WORLD_SEAM_OUTPUT,
  WORLD_SEAM_PHASES,
  WORLD_SEAM_VIEWPORTS,
  worldSeamContactSheetFile,
} from "../tools/world-seam-capture-plan.ts";
import { walkPose } from "../vendor/pocket-rpgkit/src/engine/movement.ts";
import { fnv1a } from "../vendor/pocket-rpgkit/vendor/pocketjs/hosts/sim/sim.ts";

const SWIMMER = {
  idle: [0, 1, 2, 3].map((facing) => `assets/characters/npc-swimmer-idle-${facing}.png`),
  walkL: [0, 1, 2, 3].map((facing) => `assets/characters/npc-swimmer-walk-l-${facing}.png`),
  walkR: [0, 1, 2, 3].map((facing) => `assets/characters/npc-swimmer-walk-r-${facing}.png`),
};

interface Rect extends Array<number> {
  0: number;
  1: number;
  2: number;
  3: number;
}

interface SeamFrame {
  name: "east-west" | "north-south";
  viewport: { width: number; height: number };
  activeMap: string;
  neighbourMap: string;
  file: string;
  sample: { world: [number, number]; screen: [number, number]; rgba: number[] };
  activeRect: Rect;
  neighbourRect: Rect;
  visibleMaps: string[];
  terrain: { textures: number; resident: number; pooled: number; created: number; pending: number };
  rgbaFnv1a: string;
  pngSha256: string;
}

const ROOT = resolve(import.meta.dir, "..");
const manifest = JSON.parse(readFileSync(join(ROOT, "tests/fixtures/world-seam-goldens.json"), "utf8")) as {
  format: string;
  frames: SeamFrame[];
};

const contains = (rect: Rect, point: readonly number[]): boolean =>
  point[0]! >= rect[0] && point[0]! < rect[0] + rect[2] &&
  point[1]! >= rect[1] && point[1]! < rect[1] + rect[3];

describe("production outdoor seam rendering", () => {
  test("pins both seam orientations at 480x272 and 960x544", () => {
    expect(manifest.format).toBe("pocket-tuxemon/world-seam-goldens/v1");
    expect(manifest.frames.map((frame) => [frame.name, frame.viewport])).toEqual([
      ["east-west", { width: 480, height: 272 }],
      ["north-south", { width: 480, height: 272 }],
      ["east-west", { width: 960, height: 544 }],
      ["north-south", { width: 960, height: 544 }],
    ]);
    for (const frame of manifest.frames) {
      const path = join(ROOT, "tests/goldens", frame.file);
      const bytes = new Uint8Array(readFileSync(path));
      const image = decodePng(bytes, path);
      expect([image.width, image.height], frame.file)
        .toEqual([frame.viewport.width, frame.viewport.height]);
      expect(createHash("sha256").update(bytes).digest("hex"), frame.file).toBe(frame.pngSha256);
      expect(fnv1a(image.rgba), frame.file).toBe(frame.rgbaFnv1a);
    }
  });

  test("each neighbour-side sample is owned by the neighbour and is real terrain", () => {
    const expected = {
      "east-west": [64, 176, 128, 255],
      "north-south": [216, 200, 128, 255],
    } as const;
    for (const frame of manifest.frames) {
      expect(contains(frame.neighbourRect, frame.sample.world), frame.file).toBeTrue();
      expect(contains(frame.activeRect, frame.sample.world), frame.file).toBeFalse();
      expect(frame.visibleMaps, frame.file).toContain(frame.activeMap);
      expect(frame.visibleMaps, frame.file).toContain(frame.neighbourMap);
      expect(frame.sample.rgba, frame.file).toEqual([...expected[frame.name]]);
      expect(frame.sample.rgba, frame.file).not.toEqual([0, 0, 0, 255]);
      expect(frame.terrain.pending, frame.file).toBe(0);
      expect(frame.terrain.textures, frame.file).toBeGreaterThan(0);
      expect(frame.terrain.resident + frame.terrain.pooled, frame.file).toBe(frame.terrain.created);

      const path = join(ROOT, "tests/goldens", frame.file);
      const image = decodePng(new Uint8Array(readFileSync(path)), path);
      const [x, y] = frame.sample.screen;
      const offset = (y * image.width + x) * 4;
      expect([...image.rgba.subarray(offset, offset + 4)], frame.file).toEqual(frame.sample.rgba);
    }
  });
});

describe("real seamless crossing capture", () => {
  test("plans phase 0..7 plus landing for both orientations and viewports", () => {
    expect(WORLD_SEAM_PHASES).toEqual([0, 1, 2, 3, 4, 5, 6, 7, "landing"]);
    expect(WORLD_SEAM_CROSSINGS.map((crossing) => crossing.orientation))
      .toEqual(["horizontal", "vertical"]);
    expect(WORLD_SEAM_VIEWPORTS).toEqual([
      { width: 480, height: 272 },
      { width: 960, height: 544 },
    ]);
    expect(expectedWorldSeamFrameFiles()).toHaveLength(36);
    expect(WORLD_SEAM_VIEWPORTS.map(worldSeamContactSheetFile)).toEqual([
      "world-seam-crossings.480x272.contact-sheet.png",
      "world-seam-crossings.960x544.contact-sheet.png",
    ]);
  });

  test("validates generated crossing frames and contact sheets when present", () => {
    // PNGs are intentionally generated by `bun run goldens:world`, not by the
    // unit test. Until the new capture set is approved, the checked-in v1
    // regression above remains authoritative and this test validates the v2
    // set as soon as docs/screenshots/world-seam/manifest.json exists.
    const output = join(ROOT, WORLD_SEAM_OUTPUT);
    const manifestPath = join(output, "manifest.json");
    if (!existsSync(manifestPath)) return;

    const crossing = JSON.parse(readFileSync(manifestPath, "utf8")) as WorldSeamManifest;
    expect(() => assertWorldSeamManifest(crossing)).not.toThrow();
    for (const frame of crossing.frames) {
      const path = join(output, frame.file);
      const bytes = new Uint8Array(readFileSync(path));
      const image = decodePng(bytes, path);
      expect([image.width, image.height], frame.file)
        .toEqual([frame.viewport.width, frame.viewport.height]);
      expect(createHash("sha256").update(bytes).digest("hex"), frame.file).toBe(frame.pngSha256);
      expect(fnv1a(image.rgba), frame.file).toBe(frame.rgbaFnv1a);
      const [x, y, width, height] = frame.player.screenRect;
      expect(x + width, frame.file).toBeGreaterThan(0);
      expect(y + height, frame.file).toBeGreaterThan(0);
      expect(x, frame.file).toBeLessThan(image.width);
      expect(y, frame.file).toBeLessThan(image.height);
    }
    // The horizontal capture uses the real Surfboard interaction and stays on
    // the same world row while landing on Route C's continuous water cell.
    for (const viewport of WORLD_SEAM_VIEWPORTS) {
      const frames = crossing.frames.filter((frame) =>
        frame.orientation === "horizontal" && frame.viewport.width === viewport.width
      );
      const row = frames[0]!.player.worldPixel[1];
      expect(frames.map((frame) => frame.player.worldPixel[1])).toEqual(frames.map(() => row));
      const landing = frames.find((frame) => frame.capture === "landing")!;
      expect([landing.activeMap, ...landing.player.tile]).toEqual(["spyder_routec", 0, 14]);
      expect(frames.every((frame) =>
        frame.movementCapability === "surf" && frame.swimming === 2 && frame.appearance === "swimmer"
      )).toBeTrue();
    }
    for (const sheet of crossing.contactSheets) {
      const path = join(output, sheet.file);
      const bytes = new Uint8Array(readFileSync(path));
      const image = decodePng(bytes, path);
      expect([image.width, image.height], sheet.file).toEqual([sheet.width, sheet.height]);
      expect(createHash("sha256").update(bytes).digest("hex"), sheet.file).toBe(sheet.pngSha256);
      expect(sheet.rows.map((row) => row.orientation), sheet.file).toEqual(["horizontal", "vertical"]);
      expect(sheet.rows.every((row) => row.files.length === WORLD_SEAM_PHASES.length), sheet.file)
        .toBeTrue();
    }
  });

  test("keeps the reducer-selected player pose unobscured at both seam layers", () => {
    const output = join(ROOT, WORLD_SEAM_OUTPUT);
    const manifestPath = join(output, "manifest.json");
    if (!existsSync(manifestPath)) return;

    const crossing = JSON.parse(readFileSync(manifestPath, "utf8")) as WorldSeamManifest;
    for (const frame of crossing.frames) {
      const pose = walkPose(frame.player.movePhase);
      const spriteFrames = frame.appearance === "swimmer" ? SWIMMER : PLAYER;
      const imageKey = (pose === 1
        ? spriteFrames.walkL
        : pose === 2
          ? spriteFrames.walkR
          : spriteFrames.idle)[frame.player.facing]!;
      const sprite = decodePng(new Uint8Array(readFileSync(join(ROOT, imageKey))), imageKey);
      const targetPath = join(output, frame.file);
      const target = decodePng(new Uint8Array(readFileSync(targetPath)), targetPath);
      const [x0, y0] = frame.player.screenRect;
      let opaque = 0;
      let matching = 0;
      for (let y = 0; y < sprite.height; y++) for (let x = 0; x < sprite.width; x++) {
        const source = (y * sprite.width + x) * 4;
        if (sprite.rgba[source + 3] !== 255) continue;
        opaque++;
        const painted = ((y0 + y) * target.width + x0 + x) * 4;
        if (
          sprite.rgba[source] === target.rgba[painted] &&
          sprite.rgba[source + 1] === target.rgba[painted + 1] &&
          sprite.rgba[source + 2] === target.rgba[painted + 2] &&
          sprite.rgba[source + 3] === target.rgba[painted + 3]
        ) matching++;
      }
      expect(opaque, frame.file).toBeGreaterThan(frame.appearance === "swimmer" ? 100 : 150);
      expect(matching, frame.file).toBe(opaque);
      expect(frame.upper.visibleMaps, frame.file).toContain(frame.sourceMap);
      expect(frame.upper.visibleMaps, frame.file).toContain(frame.targetMap);
    }
  });
});
