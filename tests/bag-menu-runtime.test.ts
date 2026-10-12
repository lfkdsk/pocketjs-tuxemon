import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createRoot } from "solid-js";
import { BTN } from "@pocketjs/framework/input";

import {
  initialTuxemonExtensionState,
  packTuxemonExtensionState,
  tuxemonExtensionState,
} from "../battle/extension.ts";
import { battleDbToTuxemonBattleDb } from "../battle/from-battle-db.ts";
import { spawnMonster } from "../battle/spawn.ts";
import type { SpawnedMonsterSnapshot } from "../battle/types.ts";
import featureModesJson from "../data/feature-modes.json";
import { validateBattleDb, type BattleDb } from "../importer/battle-schema.ts";
import {
  createBagMenuRuntime,
  type BagMenuCompletion,
  type BagMenuOptions,
  type BagMenuRuntime,
} from "../ui/bag-menu-runtime.ts";
import type { StartMenuData } from "../ui/feature-modes-data.ts";
import type { GameViewSessionHost } from "../vendor/pocket-rpgkit/src/ui/demo-contract.ts";
import { createSwitchState } from "../vendor/pocket-rpgkit/src/engine/interpreter.ts";
import type { SessionState } from "../vendor/pocket-rpgkit/src/engine/session.ts";

const ROOT = join(import.meta.dir, "..");
const DB = validateBattleDb(JSON.parse(readFileSync(join(ROOT, "data/battle-db.json"), "utf8")));
const ZH_DB = validateBattleDb(JSON.parse(readFileSync(join(ROOT, "data/battle-db.zh_CN.json"), "utf8")));
const RULES = battleDbToTuxemonBattleDb(DB);
const DATA = (featureModesJson as { startMenu: StartMenuData }).startMenu;

function monster(overrides: Partial<SpawnedMonsterSnapshot> = {}): SpawnedMonsterSnapshot {
  return {
    ...spawnMonster(DB, RULES, { rng: 0x1133_5577, rngDraws: 0 }, "rockitten", 12, { iid: "party-1" }),
    ...overrides,
  };
}

interface MountedBag {
  runtime: BagMenuRuntime;
  state(): SessionState;
  replacements(): number;
  completions: BagMenuCompletion[];
  dispose(): void;
}

function mount(
  member: SpawnedMonsterSnapshot,
  items: Record<string, number>,
  overrides: Partial<BagMenuOptions> = {},
): MountedBag {
  const ext = initialTuxemonExtensionState();
  ext.party = [member];
  let live = {
    frame: 0,
    sw: createSwitchState({ items, playerName: "Red" }),
    ext: packTuxemonExtensionState(ext),
  } as never as SessionState;
  let replacements = 0;
  let runtime!: BagMenuRuntime;
  let dispose!: () => void;
  const completions: BagMenuCompletion[] = [];
  const host: GameViewSessionHost = {
    project: {} as never,
    session: { content: null } as never,
    getState: () => live,
    heldButtons: () => BTN.DOWN,
    replaceState: (next) => {
      live = next;
      replacements++;
    },
  };
  createRoot((stop) => {
    dispose = stop;
    runtime = createBagMenuRuntime({
      db: DB,
      data: DATA,
      lang: "en_US",
      onComplete: (completion) => completions.push(completion),
      ...overrides,
    }, host);
  });
  return { runtime, state: () => live, replacements: () => replacements, completions, dispose };
}

describe("Bag runtime use flow", () => {
  test("full-HP Potion shows the upstream no-target prompt and consumes nothing", () => {
    const mounted = mount(monster(), { potion: 2 });
    try {
      mounted.runtime.open();
      mounted.runtime.activateIndex(0);

      expect(mounted.runtime.state().screen).toBe("message");
      expect(mounted.runtime.state().message?.text).toBe(
        "Potion cannot be used on any of your Tuxemon right now.",
      );
      expect(mounted.state().sw.items.potion).toBe(2);
      expect(mounted.replacements()).toBe(0);
      expect(mounted.runtime.completion()).toBeNull();

      mounted.runtime.applyAction("confirm");
      expect(mounted.runtime.state().screen).toBe("items");
      expect(mounted.runtime.isOpen()).toBeTrue();
    } finally {
      mounted.dispose();
    }
  });

  test("successful Potion use persists once, decrements quantity, shows DB result, then completes to world", () => {
    const full = monster();
    const mounted = mount({ ...full, currentHp: full.base.hp - 20 }, { potion: 2 });
    try {
      mounted.runtime.open();
      mounted.runtime.activateIndex(0); // item -> Use/Cancel
      expect(mounted.runtime.state().screen).toBe("confirm");
      mounted.runtime.activateIndex(0); // Use -> party
      expect(mounted.runtime.state().screen).toBe("party");
      mounted.runtime.activateIndex(0); // target -> actual use

      expect(mounted.runtime.state().screen).toBe("message");
      expect(mounted.runtime.state().message?.text).toBe(DB.items.potion!.messages.success);
      expect(mounted.state().sw.items.potion).toBe(1);
      expect(tuxemonExtensionState(mounted.state().ext).party[0]!.currentHp).toBe(full.base.hp);
      expect(mounted.replacements()).toBe(1);
      expect(mounted.runtime.completion()).toMatchObject({ kind: "used", result: { consumed: true } });
      expect(mounted.completions).toHaveLength(1);

      mounted.runtime.applyAction("confirm");
      expect(mounted.runtime.isOpen()).toBeFalse();
      expect(mounted.completions).toHaveLength(1);
    } finally {
      mounted.dispose();
    }
  });

  test("a festering Potion attempt consumes once and publishes exactly one used completion", () => {
    const afflicted = monster({ currentHp: 1, status: "festering" });
    const mounted = mount(afflicted, { potion: 2 });
    try {
      mounted.runtime.open();
      mounted.runtime.activateIndex(0); // item -> Use/Cancel
      mounted.runtime.activateIndex(0); // Use -> party
      mounted.runtime.activateIndex(0); // target -> attempted use

      expect(mounted.runtime.state().screen).toBe("message");
      expect(mounted.state().sw.items.potion).toBe(1);
      expect(tuxemonExtensionState(mounted.state().ext).party[0]).toMatchObject({
        currentHp: 1,
        status: "festering",
      });
      expect(mounted.replacements()).toBe(1);
      expect(mounted.runtime.completion()).toMatchObject({
        kind: "used",
        result: { success: false, consumed: true, reason: "festering" },
      });
      expect(mounted.completions).toHaveLength(1);

      mounted.runtime.applyAction("confirm");
      expect(mounted.runtime.isOpen()).toBeFalse();
      expect(mounted.completions).toHaveLength(1);
    } finally {
      mounted.dispose();
    }
  });

  test("combat-only inventory remains visible and reports cannot-use-here without a write", () => {
    const mounted = mount(monster(), { tuxeball: 1 });
    try {
      mounted.runtime.open();
      expect(mounted.runtime.page().items[0]).toMatchObject({
        slug: "tuxeball",
        usable: false,
        reason: "not-usable-in-world",
      });
      mounted.runtime.activateIndex(0);
      expect(mounted.runtime.state().message?.text).toBe("Tuxeball cannot be used here!");
      expect(mounted.state().sw.items.tuxeball).toBe(1);
      expect(mounted.replacements()).toBe(0);
    } finally {
      mounted.dispose();
    }
  });

  test("keyboard/gamepad navigation shares confirmation and cancel paths", () => {
    const wounded = monster({ currentHp: 1 });
    const mounted = mount(wounded, { potion: 1, repellent: 1 });
    try {
      mounted.runtime.open();
      mounted.runtime.step(BTN.DOWN, BTN.DOWN);
      expect(mounted.runtime.state().cursor).toBe(1);
      mounted.runtime.step(BTN.CIRCLE, BTN.CIRCLE);
      expect(mounted.runtime.state().screen).toBe("confirm");
      mounted.runtime.step(BTN.DOWN, BTN.DOWN);
      mounted.runtime.step(BTN.CIRCLE, BTN.CIRCLE);
      expect(mounted.runtime.state().screen).toBe("items");
      expect(mounted.state().sw.items).toEqual({ potion: 1, repellent: 1 });
      mounted.runtime.step(BTN.START, BTN.START);
      expect(mounted.runtime.completion()).toEqual({ kind: "dismissed" });
    } finally {
      mounted.dispose();
    }
  });
});

describe("Bag touch, pagination, TM choice, and localization", () => {
  test("touch selection and horizontal/vertical swipes operate on 11-item pages", () => {
    const items = {
      tuxeball: 1,
      repellent: 1,
      potion: 1,
      flintstone: 1,
      tea: 1,
      raise_hp: 1,
      tm_scope: 1,
      restoration: 1,
      super_potion: 1,
      mega_potion: 1,
      imperial_potion: 1,
      cureall: 1,
    };
    const mounted = mount(monster({ currentHp: 1 }), items);
    try {
      mounted.runtime.open();
      expect(mounted.runtime.page()).toMatchObject({ page: 0, pageSize: 11, pageCount: 2 });
      mounted.runtime.selectIndex(7);
      expect(mounted.runtime.state().cursor).toBe(7);

      mounted.runtime.swipe("left");
      expect(mounted.runtime.page().page).toBe(1);
      expect(mounted.runtime.page().items.map(({ slug }) => slug)).toEqual(["cureall"]);
      mounted.runtime.swipe("down");
      expect(mounted.runtime.page().page).toBe(0);
      mounted.runtime.swipe("up");
      expect(mounted.runtime.page().page).toBe(1);
      mounted.runtime.activateIndex(0);
      expect(mounted.runtime.state().selectedItem).toBe("cureall");
    } finally {
      mounted.dispose();
    }
  });

  test("a full four-move TM target opens the forget picker and commits the chosen move", () => {
    const learner = monster({ moves: ["ram", "boulder", "mudslide", "assault"] });
    const mounted = mount(learner, { tm_scope: 1 });
    try {
      mounted.runtime.open();
      mounted.runtime.activateIndex(0);
      mounted.runtime.activateIndex(0);
      mounted.runtime.activateIndex(0);
      expect(mounted.runtime.state().screen).toBe("moves");
      expect(mounted.runtime.moveRows().map(({ name }) => name)).toEqual(
        learner.moves.map((slug) => DB.techniques[slug]!.name),
      );
      mounted.runtime.activateIndex(1);
      expect(tuxemonExtensionState(mounted.state().ext).party[0]!.moves)
        .toEqual(["ram", "mudslide", "assault", "scope"]);
      expect(mounted.state().sw.items).not.toHaveProperty("tm_scope");
    } finally {
      mounted.dispose();
    }
  });

  test("labels come from StartMenuData and item copy comes from the active localized DB", () => {
    const mounted = mount(monster(), { potion: 1 }, { db: ZH_DB, lang: "zh_CN" });
    try {
      mounted.runtime.open();
      expect(mounted.runtime.labels).toMatchObject({
        title: DATA.root.bag.zh_CN,
        use: DATA.bag.use.zh_CN,
        cancel: DATA.bag.cancel.zh_CN,
      });
      expect(mounted.runtime.page().items[0]).toMatchObject({
        name: ZH_DB.items.potion!.name,
        description: ZH_DB.items.potion!.description,
        category: ZH_DB.items.potion!.categoryName,
      });
    } finally {
      mounted.dispose();
    }
  });
});
