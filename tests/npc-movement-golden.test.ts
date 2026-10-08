import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, test } from "bun:test";

import { decodePng } from "../importer/png.ts";
import { walkPose } from "../vendor/pocket-rpgkit/src/engine/movement.ts";
import { fnv1a } from "../vendor/pocket-rpgkit/vendor/pocketjs/hosts/sim/sim.ts";
import { NPC_SRC_INDEX } from "../ui/game-assets.ts";
import { createNpcSrcProvider } from "../ui/npc-src-repository.ts";

interface GoldenFrame {
  name: string;
  map: string;
  width: number;
  height: number;
  file: string;
  rgbaFnv1a: string;
  pngSha256: string;
  camera: [number, number];
  actor: {
    id: string;
    tile: [number, number];
    pixel: [number, number];
    facing: number;
    phase: number;
    moving: boolean;
    stepDir: number;
    sprite: string;
    image: string;
    height: number;
  };
  control: { facingMode: string; routeStopped: boolean };
}

const ROOT = resolve(import.meta.dir, "..");
const manifest = JSON.parse(readFileSync(join(ROOT, "data/npc-movement-goldens.json"), "utf8")) as {
  format: string;
  frames: GoldenFrame[];
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
const npcSrc = createNpcSrcProvider(NPC_SRC_INDEX, {
  read: (entry) => readFileSync(join(ROOT, "dist", entry)),
});

function load(frame: GoldenFrame) {
  const path = join(ROOT, "tests/goldens", frame.file);
  const bytes = new Uint8Array(readFileSync(path));
  return { bytes, image: decodePng(bytes, path) };
}

function matchingActorPixels(frame: GoldenFrame): { opaque: number; matching: number } {
  const target = load(frame).image;
  const sourcePath = join(ROOT, frame.actor.image);
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
  const worldX = frame.actor.pixel[0] + (placement?.originTileX ?? 0) * 16;
  const worldY = frame.actor.pixel[1] + (placement?.originTileY ?? 0) * 16;
  const x0 = offsetX + worldX - frame.camera[0];
  const y0 = offsetY + worldY - frame.camera[1] + 16 - frame.actor.height;
  let opaque = 0;
  let matching = 0;
  for (let y = 0; y < sprite.height; y++) for (let x = 0; x < sprite.width; x++) {
    const source = (y * sprite.width + x) * 4;
    if (sprite.rgba[source + 3] !== 255) continue;
    opaque++;
    const tx = x0 + x;
    const ty = y0 + y;
    expect(tx, `${frame.file}: actor x`).toBeGreaterThanOrEqual(0);
    expect(tx, `${frame.file}: actor x`).toBeLessThan(target.width);
    expect(ty, `${frame.file}: actor y`).toBeGreaterThanOrEqual(0);
    expect(ty, `${frame.file}: actor y`).toBeLessThan(target.height);
    const painted = (ty * target.width + tx) * 4;
    if (
      sprite.rgba[source] === target.rgba[painted] &&
      sprite.rgba[source + 1] === target.rgba[painted + 1] &&
      sprite.rgba[source + 2] === target.rgba[painted + 2] &&
      sprite.rgba[source + 3] === target.rgba[painted + 3]
    ) matching++;
  }
  return { opaque, matching };
}

describe("real imported NPC movement goldens", () => {
  test("the Taba locked-facing step is pinned at both logical resolutions", () => {
    expect(manifest.format).toBe("pocket-tuxemon/npc-movement-goldens/v1");
    expect(manifest.frames.map(({ name, map, width, height }) => [name, map, width, height])).toEqual([
      ["taba-facing-lock", "taba_town", 480, 272],
      ["taba-facing-lock", "taba_town", 960, 544],
    ]);
    for (const frame of manifest.frames) {
      const loaded = load(frame);
      expect([loaded.image.width, loaded.image.height], frame.file).toEqual([frame.width, frame.height]);
      expect(createHash("sha256").update(loaded.bytes).digest("hex"), frame.file).toBe(frame.pngSha256);
      expect(fnv1a(loaded.image.rgba), frame.file).toBe(frame.rgbaFnv1a);
    }
  });

  test("Callie visibly faces left while her imported route moves down", () => {
    for (const frame of manifest.frames) {
      expect(frame.actor).toMatchObject({
        id: "npc_callie_wren",
        tile: [38, 46],
        pixel: [608, 742],
        facing: 1,
        phase: 3,
        moving: true,
        stepDir: 0,
      });
      expect(frame.control).toEqual({ facingMode: "locked", routeStopped: false });
      expect(frame.actor.pixel[0]).toBe(frame.actor.tile[0] * 16);
      expect(frame.actor.pixel[1]).toBe(frame.actor.tile[1] * 16 + 6);

      const art = npcSrc[frame.actor.sprite];
      expect(typeof art, frame.actor.sprite).not.toBe("string");
      if (!art || typeof art === "string") throw new Error(`missing directional art ${frame.actor.sprite}`);
      expect(walkPose(frame.actor.phase)).toBe(1);
      expect(frame.actor.image).toBe(art.walkL[frame.actor.facing]);
      expect(frame.actor.image).not.toBe(art.walkL[frame.actor.stepDir]);
      const pixels = matchingActorPixels(frame);
      expect(pixels.opaque, frame.file).toBeGreaterThan(80);
      expect(pixels.matching, frame.file).toBe(pixels.opaque);
    }
  });
});
