import { describe, expect, test } from "bun:test";

import { TUXEMON_SCENES } from "../battle/game.ts";
import { TUXEMON_SCENES_ZH } from "../battle/game-zh.ts";
import { PC_LABELS_ZH } from "../battle/scene-labels-zh.ts";
import {
  format,
  TUXEMON_PC_SCENE_ID,
  type PcLabels,
  type PcSceneState,
} from "../battle/storage-scenes.ts";
import {
  initialTuxemonExtensionState,
  packTuxemonExtensionState,
} from "../battle/extension.ts";
import type { ExtensionReadContext } from "../vendor/pocket-rpgkit/src/engine/extensions.ts";
import type { SceneRules } from "../vendor/pocket-rpgkit/src/engine/scene.ts";
import type { JsonValue } from "../vendor/pocket-rpgkit/src/engine/types.ts";

const ZH_ITEMS = [
  { id: "potion", name: "治疗药水" },
  { id: "tuxeball", name: "精灵球" },
  { id: "antidote", name: "解毒剂" },
] as const;

function openZh(): PcSceneState {
  const rules: SceneRules = TUXEMON_SCENES_ZH[TUXEMON_PC_SCENE_ID]!;
  const state = initialTuxemonExtensionState();
  state.itemLocker = { potion: 3, tuxeball: 12, antidote: 2 };
  const value = packTuxemonExtensionState(state);
  const context: ExtensionReadContext = {
    ext: value,
    switches: {},
    variables: {},
    items: { potion: 5 },
    gold: 0,
    playerName: "A",
    itemCatalog: ZH_ITEMS as unknown as ExtensionReadContext["itemCatalog"],
  };
  const started = rules.start(value, { boxNames: { Kennel: "收容所" } }, 1, context);
  if (!started) throw new Error("zh PC did not open");
  return started.state as unknown as PcSceneState;
}

function openEn(): PcSceneState {
  const rules: SceneRules = TUXEMON_SCENES[TUXEMON_PC_SCENE_ID]!;
  const state = initialTuxemonExtensionState();
  const value = packTuxemonExtensionState(state);
  const context: ExtensionReadContext = {
    ext: value,
    switches: {},
    variables: {},
    items: {},
    gold: 0,
    playerName: "A",
    itemCatalog: ZH_ITEMS as unknown as ExtensionReadContext["itemCatalog"],
  };
  const started = rules.start(value, { boxNames: { Kennel: "Shelter" } }, 1, context);
  if (!started) throw new Error("en PC did not open");
  return started.state as unknown as PcSceneState;
}

/** Placeholders ({name}, {kinds}, …) are substituted at runtime, so they are
 *  not English leakage. Strip them before scanning for Latin letters. */
function withoutPlaceholders(text: string): string {
  return text.replace(/\{[^{}]*\}/g, "");
}

describe("G-PC-LOCKER zh_CN PC labels", () => {
  test("every zh_CN default is free of Latin-letter UI chrome", () => {
    for (const [key, value] of Object.entries(PC_LABELS_ZH) as [keyof PcLabels, string][]) {
      const stripped = withoutPlaceholders(value);
      expect(stripped, key).not.toMatch(/[A-Za-z]/);
    }
  });

  test("zh_CN hints use the game's key naming (行动键/取消键/方向键)", () => {
    expect(PC_LABELS_ZH.hintMenu).toContain("行动键");
    expect(PC_LABELS_ZH.hintMenu).toContain("上键");
    expect(PC_LABELS_ZH.hintOptions).toContain("取消键");
    expect(PC_LABELS_ZH.hintOptions).toContain("左键/右键");
    expect(PC_LABELS_ZH.hintQuantity).toContain("行动键");
    expect(PC_LABELS_ZH.hintQuantity).toContain("取消键");
    expect(PC_LABELS_ZH.quantityHint).toContain("行动键");
    expect(PC_LABELS_ZH.quantityHint).toContain("取消键");
  });

  test("the zh_CN reducer resolves Chinese hints and titles", () => {
    const state = openZh();
    expect(state.labels.hintMenu).toContain("行动键");
    expect(state.labels.hintMenu).not.toMatch(/[A-Za-z]/);
    expect(state.labels.lockerTitle).toContain("储物柜");
    expect(state.labels.bagTitle).toContain("背包");
    expect(state.labels.partyTitle).toContain("队伍");
  });

  test("en_US defaults keep the shipped strings (no golden drift)", () => {
    const state = openEn();
    expect(state.labels.hintMenu).toBe("Up/Down: choose  A: select");
    expect(state.labels.hintOptions).toBe("A: options  B: back  Left/Right: page");
    expect(state.labels.hintQuantity).toBe("Left/Right: +/-1  Up/Down: +/-10  A: ok  B: back");
    expect(state.labels.quantityHint).toBe("< > 1   ^ v 10   A ok   B back");
    expect(state.labels.hintItemBoxes).toBe("A: open the locker  B: back");
    expect(state.labels.hintItemBag).toBe("A: store  B: back  Left/Right: page");
    expect(state.labels.hintSelect).toBe("A: select  B: back");
    expect(state.labels.hintBoxesPickUp).toBe("Choose a box to open.  B: back");
    expect(state.labels.hintBoxesDropOff).toBe("Choose a box to store it in.  B: back");
    expect(state.labels.hintParty).toBe("Choose a Tuxemon to drop off.  B: back");
  });

  test("title templates substitute counts in both languages", () => {
    expect(format(PC_LABELS_ZH.lockerTitle, { kinds: "5", max: "30", items: "19" }))
      .toBe("储物柜 5/30 19 件");
    expect(format(PC_LABELS_ZH.bagTitle, { kinds: "4" })).toBe("背包 4 种");
    expect(format(PC_LABELS_ZH.partyTitle, { party: "2", max: "6" })).toBe("队伍 2/6");
    // The en templates render exactly the strings the review saw in production.
    const en = openEn().labels;
    expect(format(en.lockerTitle, { kinds: "5", max: "30", items: "19" }))
      .toBe("LOCKER 5/30 19 ITEMS");
    expect(format(en.bagTitle, { kinds: "4" })).toBe("BAG 4 KINDS");
    expect(format(en.partyTitle, { party: "2", max: "6" })).toBe("PARTY 2/6");
  });

  test("zh_CN locker title renders with real counts through the reducer", () => {
    const state = openZh();
    // 3 item kinds stored (potion, tuxeball, antidote), 17 items total.
    expect(format(state.labels.lockerTitle, {
      kinds: "3",
      max: "30",
      items: "17",
    })).toBe("储物柜 3/30 17 件");
  });
});
