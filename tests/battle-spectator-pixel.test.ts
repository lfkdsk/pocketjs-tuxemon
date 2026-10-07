import { describe, expect, test } from "bun:test";

import { BATTLES, captureBattle } from "../tools/spectator-battle-fixture.ts";
import {
  BATTLE_BALL_SIZE,
  SPECTATOR_BANNER_RECT,
  SPECTATOR_HINT_RECT,
  partyBallRect,
} from "../ui/battle-layout.ts";

// Semantic pixel assertions for the spectator battle chrome. The fixture
// boots the real game bundle and captures a real spectator battle frame;
// these checks prove the title banner no longer covers the upper enemy HUD
// box's name/level/HP row (the r1 blocking item), that the banner now sits
// in the free band above the message band, and that every party ball is
// fully visible (the r2 blocking item: the old geometry test protected the
// 12 px tray rect while the balls are drawn at 16 px and the chrome
// overlapped their lower edge).
//
// Mutations:
//  - moving the banner back to a position that overlaps the player balls
//    makes the per-ball bottom-row dark assertion go red;
//  - changing BATTLE_BALL_SIZE back to 12 makes the layout test's
//    ball-height assertion go red.

const VIEWPORT = { width: 480, height: 272 };

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

// The enemy HUD frame's paper background (light cream).
const paper = (r: number, g: number, b: number) => r > 180 && g > 170 && b > 140;
// The enemy name ink (UI_THEME.ink #102b3a), tight enough to reject the
// banner-blended dark (which lands near rgb(8,25,35)).
const ink = (r: number, g: number, b: number) => r >= 12 && r <= 30 && g >= 38 && g <= 60 && b >= 52 && b <= 80;
// The banner/hint dark backing (#06141dcc over the scene): the 0.8 alpha
// keeps the blended result dark and low-red even over bright grass.
const chromeDark = (r: number, g: number, b: number) => r < 40 && g < 70 && b < 60;
// The alive party ball's bright blue fill.
const ballBright = (r: number, g: number, b: number) => r > 70 && g > 90 && b > 110;

describe("spectator battle chrome pixels (real game boot)", () => {
  test("the enemy HUD name row is visible, not covered by the banner", async () => {
    const spec = BATTLES.find((b) => b.id === "taba-cam-zeke")!;
    const capture = await captureBattle(spec, VIEWPORT);
    const opening = capture.frames.find((f) => f.name === "opening")!;
    const { rgba, width } = opening;

    // The enemy name Text sits at insetL:30, insetT:6, width:180, height:14
    // inside the enemy HUD box (x20..220, y0..58). Sample the name row.
    const nameX0 = 32, nameY0 = 7, nameX1 = 208, nameY1 = 19;
    const paperPixels = count(rgba, width, nameX0, nameY0, nameX1, nameY1, paper);
    const inkPixels = count(rgba, width, nameX0, nameY0, nameX1, nameY1, ink);
    // The HUD paper must show through (the old insetT:0 banner darkened the
    // whole row to ~rgb(54,64,66), leaving no paper pixels).
    expect(paperPixels).toBeGreaterThan(500);
    // The name/level text itself must be drawn in ink on that paper.
    expect(inkPixels).toBeGreaterThan(30);

    // The banner now lives in the free band above the message band
    // (SPECTATOR_BANNER_RECT), not at the top of the canvas.
    const bannerPixels = count(
      rgba, width,
      SPECTATOR_BANNER_RECT.x + 2, SPECTATOR_BANNER_RECT.y + 2,
      SPECTATOR_BANNER_RECT.x + SPECTATOR_BANNER_RECT.width - 2,
      SPECTATOR_BANNER_RECT.y + SPECTATOR_BANNER_RECT.height - 2,
      chromeDark,
    );
    expect(bannerPixels).toBeGreaterThan(800);

    // The top strip where the old banner sat must not be a dark banner:
    // the gap between the enemy HUD and the enemy monster shows scene.
    const topStrip = count(rgba, width, 224, 2, 292, 22, chromeDark);
    expect(topStrip).toBeLessThan(200);
  }, 120_000);

  test("the zh banner does not cover the enemy HUD name row either", async () => {
    const spec = BATTLES.find((b) => b.id === "taba-cam-zeke")!;
    const capture = await captureBattle(spec, VIEWPORT, "zh_CN");
    const opening = capture.frames.find((f) => f.name === "opening")!;
    const { rgba, width } = opening;
    const paperPixels = count(rgba, width, 32, 7, 208, 19, paper);
    expect(paperPixels).toBeGreaterThan(500);
  }, 120_000);

  test("every party ball is fully visible, not covered by the banner or hint", async () => {
    const spec = BATTLES.find((b) => b.id === "leather-gym-chad-brad")!;
    const capture = await captureBattle(spec, VIEWPORT);
    const opening = capture.frames.find((f) => f.name === "opening")!;
    const { rgba, width } = opening;

    for (const side of [0, 1] as const) {
      for (let slot = 0; slot < 6; slot++) {
        const ball = partyBallRect(side, slot);
        // The bottom four rows of the ball cell are the edge the chrome
        // would cover first if it drifted up. A visible ball has at most a
        // few dark outline pixels there (< 25); a chrome-covered edge is
        // ~93% dark (>= 55 of 64).
        const bottomDark = count(
          rgba, width,
          ball.x, ball.y + BATTLE_BALL_SIZE - 4,
          ball.x + BATTLE_BALL_SIZE, ball.y + BATTLE_BALL_SIZE,
          chromeDark,
        );
        expect(bottomDark).toBeLessThan(25);

        // An alive ball must show its bright fill. The leather-gym fight
        // has one monster per side, so ball 0 is alive on both sides; the
        // rest are empty. A covered alive ball drops to 0 bright pixels.
        const bright = count(
          rgba, width,
          ball.x, ball.y,
          ball.x + BATTLE_BALL_SIZE, ball.y + BATTLE_BALL_SIZE,
          ballBright,
        );
        if (slot === 0) {
          expect(bright).toBeGreaterThan(50);
        }
      }
    }

    // The hint sits in the menu band, far below the enemy balls; assert its
    // dark backing is present there (not up in the scene).
    const hintPixels = count(
      rgba, width,
      SPECTATOR_HINT_RECT.x + 2, SPECTATOR_HINT_RECT.y + 2,
      SPECTATOR_HINT_RECT.x + SPECTATOR_HINT_RECT.width - 2,
      SPECTATOR_HINT_RECT.y + SPECTATOR_HINT_RECT.height - 2,
      chromeDark,
    );
    expect(hintPixels).toBeGreaterThan(400);
  }, 120_000);
});
