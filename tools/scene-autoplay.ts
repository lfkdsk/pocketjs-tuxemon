import { BTN_BITS } from "../vendor/pocket-rpgkit/src/engine/camera.ts";
import type { JsonValue } from "../vendor/pocket-rpgkit/src/engine/types.ts";
import { NAME_INPUT_SCENE_ID } from "../vendor/pocket-rpgkit/src/engine/name-input.ts";
import {
  TUXEMON_JOURNAL_SCENE_ID,
  TUXEMON_MONSTER_PICKER_SCENE_ID,
} from "../battle/scenes.ts";
import {
  pcMenuItems,
  TUXEMON_MONSTER_SHOP_SCENE_ID,
  TUXEMON_PC_SCENE_ID,
  TUXEMON_TRADE_SCENE_ID,
  type PcSceneState,
} from "../battle/storage-scenes.ts";
import { TUXEMON_DAYCARE_SCENE_ID } from "../battle/daycare-scenes.ts";

const BTN_CONFIRM = 0x2000;
const BTN_CANCEL = 0x4000;

interface ActiveGameScene {
  kind: "scene";
  id: string;
  state: JsonValue;
}

interface NameInputProjection {
  buffer: string;
  cursor: number;
  charset: string[];
  random: boolean;
}

/** Deterministic policy used only by generated acceptance journeys. It names
 * a character from the deterministic RANDOM pool when one exists (and "A"
 * otherwise), chooses the current party row, closes read-only journal pages,
 * logs off PCs and leaves monster shops without buying, and confirms through
 * trade transitions; production input remains entirely user-driven. */
export function utilitySceneAutoplayMask(scene: Readonly<ActiveGameScene>): number {
  if (scene.id === NAME_INPUT_SCENE_ID) {
    const state = scene.state as unknown as NameInputProjection;
    if (state.buffer.length === 0) {
      if (!state.random) return BTN_CONFIRM;
      const random = state.charset.length + 3;
      return state.cursor === random ? BTN_CONFIRM : BTN_BITS.LEFT;
    }
    const ok = state.charset.length + 1;
    return state.cursor === ok ? BTN_CONFIRM : BTN_BITS.LEFT;
  }
  if (scene.id === TUXEMON_MONSTER_PICKER_SCENE_ID) return BTN_CONFIRM;
  if (scene.id === TUXEMON_JOURNAL_SCENE_ID) return BTN_CANCEL;
  if (scene.id === TUXEMON_PC_SCENE_ID) {
    const state = scene.state as unknown as PcSceneState;
    if (state.phase !== "menu") return BTN_CANCEL;
    return state.menuCursor === pcMenuItems(state).length - 1 ? BTN_CONFIRM : BTN_BITS.UP;
  }
  if (scene.id === TUXEMON_MONSTER_SHOP_SCENE_ID) return BTN_CANCEL;
  if (scene.id === TUXEMON_DAYCARE_SCENE_ID) return BTN_CANCEL;
  if (scene.id === TUXEMON_TRADE_SCENE_ID) return BTN_CONFIRM;
  throw new Error(`journey: no autoplay policy for scene ${JSON.stringify(scene.id)}`);
}
