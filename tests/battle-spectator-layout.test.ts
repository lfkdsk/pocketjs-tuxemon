import { describe, expect, test } from "bun:test";

import {
  BATTLE_BASE_HEIGHT,
  BATTLE_BASE_WIDTH,
  SPECTATOR_BANNER_RECT,
  SPECTATOR_HINT_RECT,
  battleViewportLayout,
  partyBallRect,
  spectatorProtectedRects,
} from "../ui/battle-layout.ts";

interface Rect { x: number; y: number; width: number; height: number }

const intersects = (a: Rect, b: Rect): boolean =>
  a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

// Every rect the spectator chrome must not cover. This list is computed by
// the same layout module the scene draws with (spectatorProtectedRects), so
// the test and the renderer can never disagree about the ball/tray extents.
// The menu band is intentionally absent: it is hidden during spectator
// battles and is where the hint rect lives.
const PROTECTED: Rect[] = spectatorProtectedRects();

describe("spectator battle chrome geometry", () => {
  test("banner and hint rects stay inside the battle canvas", () => {
    for (const rect of [SPECTATOR_BANNER_RECT, SPECTATOR_HINT_RECT]) {
      expect(rect.x).toBeGreaterThanOrEqual(0);
      expect(rect.y).toBeGreaterThanOrEqual(0);
      expect(rect.x + rect.width).toBeLessThanOrEqual(BATTLE_BASE_WIDTH);
      expect(rect.y + rect.height).toBeLessThanOrEqual(BATTLE_BASE_HEIGHT);
    }
  });

  test("banner does not intersect any protected rect", () => {
    const hits = PROTECTED.filter((rect) => intersects(SPECTATOR_BANNER_RECT, rect));
    expect(hits).toEqual([]);
  });

  test("hint does not intersect any protected rect", () => {
    const hits = PROTECTED.filter((rect) => intersects(SPECTATOR_HINT_RECT, rect));
    expect(hits).toEqual([]);
  });

  test("banner and hint do not intersect each other", () => {
    expect(intersects(SPECTATOR_BANNER_RECT, SPECTATOR_HINT_RECT)).toBe(false);
  });

  test("the free bands hold at both target resolutions", () => {
    // The 960x544 viewport scales the 480x272 canvas by exactly 2x, so the
    // canvas-space non-intersection above carries over; assert the scale and
    // the letterbox offsets that place the canvas.
    const small = battleViewportLayout(480, 272);
    const large = battleViewportLayout(960, 544);
    expect(small).toEqual({ scale: 1, left: 0, top: 0 });
    expect(large).toEqual({ scale: 2, left: 0, top: 0 });
  });

  test("banner band is tall enough for two wrapped text-xs lines", () => {
    // text-xs lineHeight 13: two lines need 26 px, which is the band height.
    expect(SPECTATOR_BANNER_RECT.height).toBeGreaterThanOrEqual(26);
  });

  test("party ball rects are the drawn 16 px cells", () => {
    // The party icons are 8x8 drawn at 2x = 16 px. The r2 review caught the
    // old test protecting the 12 px tray rect while the balls actually
    // occupy 16 px; the non-intersection tests above now use these 16 px
    // ball rects, and this assertion pins the size so a regression to 12 px
    // goes red.
    for (let slot = 0; slot < 6; slot++) {
      for (const side of [0, 1] as const) {
        const ball = partyBallRect(side, slot);
        expect(ball.width).toBe(16);
        expect(ball.height).toBe(16);
      }
    }
  });
});
