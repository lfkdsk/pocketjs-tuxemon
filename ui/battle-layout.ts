import type { BattleMonster } from "../battle/types.ts";

/** Pocket-sized battle canvas. The top 216 px are Tuxemon's 256x108 scene
 * enlarged 2x and centre-cropped by 16 px on each side; the final 56 px are
 * the native kit message/menu band. A 960x544 viewport scales this whole
 * canvas exactly 2x. */
export const BATTLE_BASE_WIDTH = 480;
export const BATTLE_BASE_HEIGHT = 272;
export const BATTLE_SCENE_HEIGHT = 216;
export const BATTLE_SCENE_CROP_X = 16;
// Leave a 64 px number cell at 480x272. The largest imported early-game
// readout ("109 / 109") is wider than the former 54 px cell and lost its
// final digit against the right edge of the battle canvas.
export const BATTLE_PLAYER_HP_WIDTH = 90;
export const BATTLE_ENEMY_HP_WIDTH = 140;
export const BATTLE_XP_WIDTH = 140;
// Compatibility width used by the GB3/GB4 software-preview helpers. The live
// battle scene passes the asymmetric HUD widths above explicitly.
export const BATTLE_HP_WIDTH = 116;

export interface BattleRect { x: number; y: number; width: number; height: number }

export const BATTLE_RECTS = Object.freeze({
  background: { x: -16, y: 0, width: 512, height: 256 },
  playerIsland: { x: 48, y: 136, width: 192, height: 114 },
  enemyIsland: { x: 264, y: 48, width: 192, height: 114 },
  playerMonster: { x: 80, y: 88, width: 128, height: 128 },
  enemyMonster: { x: 296, y: 0, width: 128, height: 128 },
  playerHud: { x: 274, y: 90, width: 208, height: 74 },
  enemyHud: { x: 20, y: 0, width: 200, height: 58 },
  playerHp: { x: 320, y: 126, width: BATTLE_PLAYER_HP_WIDTH, height: 8 },
  enemyHp: { x: 64, y: 24, width: BATTLE_ENEMY_HP_WIDTH, height: 8 },
  playerXp: { x: 326, y: 152, width: BATTLE_XP_WIDTH, height: 5 },
  playerTray: { x: 274, y: 178, width: 208, height: 12 },
  enemyTray: { x: 20, y: 58, width: 208, height: 12 },
  playerStatus: { x: 304, y: 152, width: 18, height: 18 },
  enemyStatus: { x: 10, y: 26, width: 18, height: 18 },
  message: { x: 0, y: 216, width: 244, height: 56 },
  menu: { x: 244, y: 216, width: 236, height: 56 },
});

/** Party-ball icon geometry. The battle db's party icons are 8x8, drawn at
 *  2x, so each ball occupies a 16 px cell. The first 16 px of a tray row is
 *  the tray's own leading art; balls start after it. Both the scene draw and
 *  the layout tests derive ball rects from partyBallRect() so they can never
 *  disagree. */
export const BATTLE_BALL_SIZE = 16;
export const BATTLE_BALL_X_OFFSET = 16;

export function partyBallRect(side: 0 | 1, slot: number): BattleRect {
  const tray = side === 0 ? BATTLE_RECTS.playerTray : BATTLE_RECTS.enemyTray;
  return {
    x: tray.x + BATTLE_BALL_X_OFFSET + slot * BATTLE_BALL_SIZE,
    y: tray.y,
    width: BATTLE_BALL_SIZE,
    height: BATTLE_BALL_SIZE,
  };
}

/** Spectator (NPC-versus-NPC) chrome lives in the menu band, which is hidden
 *  during spectator battles (the command/list menus are not shown), so the
 *  banner and hints never cover a HUD box, a party ball, an island/monster
 *  clip or the message band:
 *  - banner: the top of the menu band (x 244..480, y 216..242), right of the
 *    narrowed message band;
 *  - hints: just below the banner (x 244..480, y 244..262).
 *  The message band is narrowed to its 244 px design width in spectator mode
 *  so the chrome band stays clear of it.
 *  `tests/battle-spectator-layout.test.ts` asserts these rects are disjoint
 *  from every HUD/ball/island/monster/message rect at both target
 *  resolutions, all computed by this same module. */
export const SPECTATOR_BANNER_RECT = Object.freeze({ x: 244, y: 216, width: 236, height: 26 });
export const SPECTATOR_HINT_RECT = Object.freeze({ x: 244, y: 244, width: 236, height: 18 });

/** Every rect the spectator chrome must not cover, computed by the same
 *  layout the scene draws with. The menu band is excluded: it is hidden
 *  during spectator battles and is where the hint lives. */
export function spectatorProtectedRects(): BattleRect[] {
  return [
    BATTLE_RECTS.enemyHud,
    BATTLE_RECTS.playerHud,
    BATTLE_RECTS.enemyTray,
    BATTLE_RECTS.playerTray,
    partyBallRect(1, 0), partyBallRect(1, 1), partyBallRect(1, 2),
    partyBallRect(1, 3), partyBallRect(1, 4), partyBallRect(1, 5),
    partyBallRect(0, 0), partyBallRect(0, 1), partyBallRect(0, 2),
    partyBallRect(0, 3), partyBallRect(0, 4), partyBallRect(0, 5),
    BATTLE_RECTS.enemyIsland,
    BATTLE_RECTS.playerIsland,
    BATTLE_RECTS.enemyMonster,
    BATTLE_RECTS.playerMonster,
    BATTLE_RECTS.playerXp,
    BATTLE_RECTS.enemyStatus,
    BATTLE_RECTS.playerStatus,
    BATTLE_RECTS.message,
  ];
}

export interface BattleSceneLayout {
  scale: number;
  left: number;
  top: number;
  playerHpWidth: number;
  enemyHpWidth: number;
}

export function hpBarWidth(current: number, maximum: number, width = BATTLE_HP_WIDTH): number {
  if (!(maximum > 0)) return 0;
  return Math.max(0, Math.min(width, Math.round(width * current / maximum)));
}

export function battleSceneLayout(
  width: number,
  height: number,
  player: Pick<BattleMonster, "currentHp" | "base">,
  enemy: Pick<BattleMonster, "currentHp" | "base">,
): BattleSceneLayout {
  return {
    ...battleViewportLayout(width, height),
    playerHpWidth: hpBarWidth(player.currentHp, player.base.hp, BATTLE_PLAYER_HP_WIDTH),
    enemyHpWidth: hpBarWidth(enemy.currentHp, enemy.base.hp, BATTLE_ENEMY_HP_WIDTH),
  };
}

/** Canvas geometry depends on the viewport; combat HP does not move it. */
export function battleViewportLayout(width: number, height: number): Pick<BattleSceneLayout, "scale" | "left" | "top"> {
  const scale = Math.min(width / BATTLE_BASE_WIDTH, height / BATTLE_BASE_HEIGHT);
  return {
    scale,
    left: Math.floor((width - BATTLE_BASE_WIDTH * scale) / 2),
    top: Math.floor((height - BATTLE_BASE_HEIGHT * scale) / 2),
  };
}
