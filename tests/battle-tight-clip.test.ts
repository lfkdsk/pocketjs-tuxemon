import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, test } from "bun:test";

import type { BattleDb, BattleImageRef } from "../importer/battle-schema.ts";
import { decodePng } from "../importer/png.ts";
import { battlePreviewSourcePath } from "../tools/render-battle-preview.ts";
import { BATTLE_MONSTER_BOUNDS } from "../ui/battle-assets.ts";
import {
  battleAnimationTightClip,
  battleMonsterTightClip,
  type BattleSpriteBounds,
  type BattleTightClip,
} from "../ui/battle-tight-clip.ts";

const ROOT = resolve(import.meta.dir, "..");
const DB = JSON.parse(readFileSync(join(ROOT, "data/battle-runtime-db.json"), "utf8")) as BattleDb;
const SLOT = 128;

function displayedByte(value: number): number {
  return (value >> 4) * 17;
}

function visibleBounds(
  rgba: Uint8Array,
  imageWidth: number,
  source: readonly [number, number, number, number],
): BattleSpriteBounds {
  const [sourceX, sourceY, width, height] = source;
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const alpha = rgba[((sourceY + y) * imageWidth + sourceX + x) * 4 + 3]!;
    if (displayedByte(alpha) === 0) continue;
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  }
  return maxX < minX || maxY < minY
    ? [0, 0, 0, 0]
    : [minX, minY, maxX - minX + 1, maxY - minY + 1];
}

function renderScaledImage(
  image: { width: number; height: number; rgba: Uint8Array },
  originX: number,
  originY: number,
  clip: Pick<BattleTightClip, "x" | "y" | "width" | "height"> = {
    x: 0,
    y: 0,
    width: SLOT,
    height: SLOT,
  },
): Uint8Array {
  const out = new Uint8Array(SLOT * SLOT * 4);
  const x0 = Math.max(0, clip.x);
  const y0 = Math.max(0, clip.y);
  const x1 = Math.min(SLOT, clip.x + clip.width);
  const y1 = Math.min(SLOT, clip.y + clip.height);
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
    const sourceX = Math.floor((x - originX) / 2);
    const sourceY = Math.floor((y - originY) / 2);
    if (sourceX < 0 || sourceY < 0 || sourceX >= image.width || sourceY >= image.height) continue;
    const sourceOffset = (sourceY * image.width + sourceX) * 4;
    const targetOffset = (y * SLOT + x) * 4;
    const alpha = displayedByte(image.rgba[sourceOffset + 3]!);
    if (alpha === 0) continue;
    out[targetOffset] = displayedByte(image.rgba[sourceOffset]!);
    out[targetOffset + 1] = displayedByte(image.rgba[sourceOffset + 1]!);
    out[targetOffset + 2] = displayedByte(image.rgba[sourceOffset + 2]!);
    out[targetOffset + 3] = alpha;
  }
  return out;
}

function image(ref: BattleImageRef) {
  const path = battlePreviewSourcePath(ROOT, ref);
  return decodePng(new Uint8Array(readFileSync(path)), path);
}

describe("battle transparent-padding clips", () => {
  test("generated RGBA4444-visible bounds cover every imported monster frame and cut average area by 45%", () => {
    expect(Object.keys(BATTLE_MONSTER_BOUNDS)).toEqual(Object.keys(DB.monsters));
    let tightArea = 0;
    let fullArea = 0;
    for (const [slug, monster] of Object.entries(DB.monsters)) {
      const sheet = image(monster.art.sheet);
      for (const side of ["front", "back"] as const) {
        const expected = visibleBounds(sheet.rgba, sheet.width, monster.art[side]);
        expect(BATTLE_MONSTER_BOUNDS[slug]?.[side], `${slug} ${side}`).toEqual(expected);
        tightArea += expected[2] * 2 * expected[3] * 2;
        fullArea += SLOT * SLOT;
      }
    }
    expect(BATTLE_MONSTER_BOUNDS.rockitten).toEqual({
      front: [16, 19, 31, 25],
      back: [9, 28, 49, 36],
    });
    expect(tightArea / fullArea).toBeLessThan(0.55);
  });

  test("monster clips remain framebuffer-identical through rest, faint sinking, and defensive horizontal fallback", () => {
    const poses = [
      { dx: 0, sinkY: 0 },
      { dx: 0, sinkY: 7 },
      { dx: 0, sinkY: 14 },
      { dx: -7, sinkY: 0 },
      { dx: 7, sinkY: 0 },
    ] as const;
    for (const slug of ["rockitten", "nut", "lambert", "tweesher", "agnite"] as const) {
      const monster = DB.monsters[slug]!;
      const sheet = image(monster.art.sheet);
      for (const side of ["front", "back"] as const) for (const pose of poses) {
        const source = monster.art[side];
        const clip = battleMonsterTightClip(
          BATTLE_MONSTER_BOUNDS[slug]![side], source[0], source[1], pose.dx, pose.sinkY,
        );
        const oldFrame = renderScaledImage(sheet, -source[0] * 2 + pose.dx, -source[1] * 2 + pose.sinkY);
        const newFrame = renderScaledImage(sheet, clip.x + clip.imageX, clip.y + clip.imageY, clip);
        expect(newFrame, `${slug} ${side} dx=${pose.dx} sink=${pose.sinkY}`).toEqual(oldFrame);
      }
    }
  });

  test("real technique atlases crop safe padding while preserving legacy neighbour-frame exposure", () => {
    const check = (slug: "entomb" | "sunburst", expectedArea: number) => {
      const animation = DB.techniques[slug]!.animation!;
      expect(animation.pages.length).toBeGreaterThan(0);
      for (const page of animation.pages) {
        const atlas = image(page);
        for (let local = 0; local < page.frames; local++) {
          const sourceX = (local % page.columns) * page.frameWidth;
          const sourceY = Math.floor(local / page.columns) * page.frameHeight;
          const clip = battleAnimationTightClip(page, sourceX, sourceY);
          const left = (SLOT - page.contentWidth * 2) / 2;
          const top = (SLOT - page.contentHeight * 2) / 2;
          const oldFrame = renderScaledImage(atlas, left - sourceX * 2, top - sourceY * 2);
          const newFrame = renderScaledImage(atlas, clip.x + clip.imageX, clip.y + clip.imageY, clip);
          expect(newFrame, `${slug} frame ${page.firstFrame + local}`).toEqual(oldFrame);
          expect(clip.width * clip.height).toBe(expectedArea);
        }
      }
    };
    // 54px of visible content in a 64px cell: horizontal padding is safe.
    check("entomb", 108 * SLOT);
    // 32px cells are smaller than the old slot on both axes, which exposes
    // neighbours. A performance-only change must keep that full composition.
    check("sunburst", SLOT * SLOT);
  });
});
