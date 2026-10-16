import type { BattleAnimationPage } from "../importer/battle-schema.ts";

export type BattleSpriteBounds = readonly [
  x: number,
  y: number,
  width: number,
  height: number,
];

export interface BattleTightClip {
  /** Tight clip position inside the original 128x128 battle slot. */
  x: number;
  y: number;
  width: number;
  height: number;
  /** Image origin relative to the tight clip. */
  imageX: number;
  imageY: number;
}

const clamp = (value: number, low: number, high: number): number =>
  Math.max(low, Math.min(high, value));

/**
 * Preserve the old full-slot composition while clipping transparent monster
 * padding before it reaches PocketJS's scaled raster path. The moving alpha
 * rectangle is intersected with the same slot that used to clip the whole
 * 64x64 source frame, so hit shakes and faint sinking stay pixel-identical.
 */
export function battleMonsterTightClip(
  bounds: BattleSpriteBounds,
  sourceX: number,
  sourceY: number,
  dx: number,
  sinkY: number,
  slotSize = 128,
): BattleTightClip {
  // The current Tuxemon painter moves attacks by translating the whole slot;
  // its inner `dx` remains zero. Preserve the legacy whole-sheet behaviour
  // defensively if a future caller does shift the inner image, since that can
  // expose pixels from the neighbouring source frame at a slot edge.
  if (dx !== 0) {
    return {
      x: 0,
      y: 0,
      width: slotSize,
      height: slotSize,
      imageX: -sourceX * 2 + dx,
      imageY: -sourceY * 2 + sinkY,
    };
  }
  const left = bounds[0] * 2 + dx;
  const top = bounds[1] * 2 + sinkY;
  const right = (bounds[0] + bounds[2]) * 2 + dx;
  const bottom = (bounds[1] + bounds[3]) * 2 + sinkY;
  const x = clamp(left, 0, slotSize);
  const y = clamp(top, 0, slotSize);
  const clippedRight = clamp(right, 0, slotSize);
  const clippedBottom = clamp(bottom, 0, slotSize);
  return {
    x,
    y,
    width: Math.max(0, clippedRight - x),
    height: Math.max(0, clippedBottom - y),
    imageX: -sourceX * 2 + dx - x,
    imageY: -sourceY * 2 + sinkY - y,
  };
}

/**
 * Technique pages are power-of-two atlases, but only one authored frame is
 * visible. Crop the atlas and frame padding while retaining the old centered
 * placement and its intersection with the original battle slot.
 */
export function battleAnimationTightClip(
  page: Pick<BattleAnimationPage, "contentWidth" | "contentHeight" | "frameWidth" | "frameHeight"> | null | undefined,
  sourceX: number,
  sourceY: number,
  slotSize = 128,
): BattleTightClip {
  const contentWidth = (page?.contentWidth ?? 8) * 2;
  const contentHeight = (page?.contentHeight ?? 8) * 2;
  const left = (slotSize - contentWidth) / 2;
  const top = (slotSize - contentHeight) / 2;
  const right = left + contentWidth;
  const bottom = top + contentHeight;
  // A few legacy atlases pack cells smaller than the presentation slot. The
  // old full clip consequently exposes neighbouring frames; retaining the
  // full axis preserves that shipped composition instead of silently fixing
  // it as part of a performance-only change.
  const tightX = page == null || page.frameWidth * 2 >= slotSize;
  const tightY = page == null || page.frameHeight * 2 >= slotSize;
  const x = tightX ? clamp(left, 0, slotSize) : 0;
  const y = tightY ? clamp(top, 0, slotSize) : 0;
  const clippedRight = tightX ? clamp(right, 0, slotSize) : slotSize;
  const clippedBottom = tightY ? clamp(bottom, 0, slotSize) : slotSize;
  return {
    x,
    y,
    width: Math.max(0, clippedRight - x),
    height: Math.max(0, clippedBottom - y),
    imageX: left - sourceX * 2 - x,
    imageY: top - sourceY * 2 - y,
  };
}
