import { describe, expect, test } from "bun:test";

import {
  initialTuxemonExtensionState,
  LOCKER_ITEM_CAP,
  LOCKER_LIMIT,
  packTuxemonExtensionState,
  tuxemonExtensionProblem,
  tuxemonExtensionState,
} from "../battle/extension.ts";
import {
  pcBagRows,
  pcLockerRows,
  pcMenuItems,
  pcTakeMax,
  TUXEMON_PC_SCENE_ID,
  type PcSceneState,
} from "../battle/storage-scenes.ts";
import { TUXEMON_SCENES as scenes } from "../battle/game.ts";
import type { ExtensionReadContext } from "../vendor/pocket-rpgkit/src/engine/extensions.ts";
import type { SceneInput, SceneRules } from "../vendor/pocket-rpgkit/src/engine/scene.ts";
import type { JsonValue } from "../vendor/pocket-rpgkit/src/engine/types.ts";

function lockerProblem(locker: Record<string, number> | undefined): string | null {
  const state = initialTuxemonExtensionState();
  if (locker !== undefined) state.itemLocker = locker;
  return tuxemonExtensionProblem(packTuxemonExtensionState(state));
}

const rules: SceneRules = scenes[TUXEMON_PC_SCENE_ID]!;

const CATALOG = [
  { id: "potion", name: "Potion" },
  { id: "tuxeball", name: "Tuxeball" },
  { id: "super_potion", name: "Super Potion" },
  { id: "nu_phone", name: "Nu Phone" },
  { id: "app_map", name: "Map App" },
] as const;

function pcContext(
  value: JsonValue,
  items: Record<string, number>,
  notStorable: string[] = ["nu_phone", "app_map"],
): ExtensionReadContext {
  return {
    ext: value,
    switches: {},
    variables: {},
    items,
    gold: 0,
    playerName: "A",
    itemCatalog: CATALOG as unknown as ExtensionReadContext["itemCatalog"],
  };
}

function open(
  locker: Record<string, number>,
  items: Record<string, number>,
  notStorable: string[] = ["nu_phone", "app_map"],
): { state: JsonValue; view: PcSceneState } {
  const state = initialTuxemonExtensionState();
  state.itemLocker = Object.keys(locker).length ? locker : undefined;
  const value = packTuxemonExtensionState(state);
  const started = rules.start(value, { boxNames: { Kennel: "Shelter" }, notStorable }, 1, pcContext(value, items, notStorable));
  if (!started) throw new Error("PC did not open");
  return { state: started.state, view: started.state as unknown as PcSceneState };
}

function step(state: JsonValue, ...inputs: Partial<SceneInput>[]): JsonValue {
  let value = state;
  for (const input of inputs) value = rules.step(structuredClone(value), { buttons: 0, ...input }, 1);
  return value;
}

const A = { confirmEdge: true };
const B = { cancelEdge: true };
const UP = { upEdge: true };
const DOWN = { downEdge: true };
const LEFT = { leftEdge: true };
const RIGHT = { rightEdge: true };

const view = (state: JsonValue) => state as unknown as PcSceneState;

/** Back out to the PC menu, then select Log Off (the last menu entry). */
function logOff(state: JsonValue, backs: number): JsonValue {
  const inputs: Partial<SceneInput>[] = [];
  for (let i = 0; i < backs; i++) inputs.push(B);
  inputs.push(UP, A); // wrap to the last entry (Log Off) and confirm
  return step(state, ...inputs);
}

describe("G-PC-LOCKER extension state", () => {
  test("a sparse locker is absent on a fresh save and round-trips", () => {
    const fresh = initialTuxemonExtensionState();
    expect(fresh.itemLocker).toBeUndefined();
    expect(tuxemonExtensionProblem(packTuxemonExtensionState(fresh))).toBeNull();

    const state = initialTuxemonExtensionState();
    state.itemLocker = { potion: 3, tuxeball: 12 };
    const packed = packTuxemonExtensionState(state);
    expect(tuxemonExtensionProblem(packed)).toBeNull();
    // The locker rides the same saved wire as the rest of the extension.
    expect(String(packed)).toContain('"itemLocker":{"potion":3,"tuxeball":12}');
  });

  test("the locker is bounded: at most 30 types, each 1..99", () => {
    expect(LOCKER_LIMIT).toBe(30);
    expect(LOCKER_ITEM_CAP).toBe(99);
    const full: Record<string, number> = {};
    for (let index = 0; index < LOCKER_LIMIT; index++) full[`item_${index}`] = 1;
    expect(lockerProblem(full)).toBeNull();
    const over = { ...full, one_more: 1 };
    expect(lockerProblem(over)).toContain("at most 30");

    expect(lockerProblem({ potion: 0 })).toContain("between 1 and 99");
    expect(lockerProblem({ potion: -1 })).toContain("between 1 and 99");
    expect(lockerProblem({ potion: LOCKER_ITEM_CAP + 1 })).toContain("between 1 and 99");
    expect(lockerProblem({ potion: 1.5 })).toContain("between 1 and 99");
    expect(lockerProblem({ "": 1 })).toContain("between 1 and 99");
  });
});

describe("G-PC-LOCKER PC menu entries", () => {
  test("item entries follow the upstream visibility rules", () => {
    // No locker items, one bag type: only Log Off.
    expect(pcMenuItems(open({}, { potion: 1 }).view)).toEqual(["logOff"]);
    // Locker stocked: Pick Up Item appears.
    expect(pcMenuItems(open({ potion: 2 }, { potion: 1 }).view)).toEqual(["itemPickUp", "logOff"]);
    // Bag with two types: Drop Off Item appears.
    expect(pcMenuItems(open({}, { potion: 1, tuxeball: 5 }).view)).toEqual(["itemDropOff", "logOff"]);
    // Both: upstream order item storage, item dropoff, log off.
    expect(pcMenuItems(open({ potion: 2 }, { potion: 1, tuxeball: 5 }).view))
      .toEqual(["itemPickUp", "itemDropOff", "logOff"]);
  });

  test("the drop-off list hides invisible items and sorts by slug", () => {
    const { view: v } = open({ tuxeball: 1 }, { tuxeball: 3, nu_phone: 1, potion: 2, app_map: 1 });
    expect(pcBagRows(v)).toEqual(["potion", "tuxeball"]);
    expect(pcLockerRows(v)).toEqual(["tuxeball"]);
  });
});

describe("G-PC-LOCKER deposit", () => {
  test("deposits a chosen quantity and commits bag + locker", () => {
    // menu = [itemDropOff, logOff]
    const opened = open({}, { potion: 5, tuxeball: 3 });
    let state = step(opened.state, A, A, A); // -> itemBoxes -> itemBag -> itemQuantity
    expect(view(state).phase).toBe("itemQuantity");
    expect(view(state).quantityMax).toBe(5);
    expect(view(state).quantity).toBe(1);
    state = step(state, RIGHT, RIGHT, A); // qty 3 -> deposit -> itemBoxes
    expect(view(state).phase).toBe("itemBoxes");
    expect(view(state).message).toContain("3 Potion");
    state = logOff(state, 1); // itemBoxes -> menu -> Log Off
    const completion = rules.done(state)!;
    expect(completion.items).toEqual({ potion: 2, tuxeball: 3 });
    expect(tuxemonExtensionState(completion.ext!).itemLocker).toEqual({ potion: 3 });
  });

  test("depositing the whole stack removes it from the bag", () => {
    const opened = open({}, { potion: 2, tuxeball: 1 });
    let state = step(opened.state, A, A, A); // -> itemQuantity (max 2)
    state = step(state, RIGHT, A); // qty 2 -> deposit -> itemBoxes
    state = logOff(state, 1);
    const completion = rules.done(state)!;
    expect(completion.items).toEqual({ tuxeball: 1 });
    expect(tuxemonExtensionState(completion.ext!).itemLocker).toEqual({ potion: 2 });
  });

  test("merges into an existing locker stack up to the 99 cap", () => {
    // Two bag types so the upstream >1 rule shows Drop Off Item.
    const opened = open({ potion: 98 }, { potion: 5, tuxeball: 1 });
    let state = step(opened.state, DOWN, A, A, A); // itemDropOff -> itemBoxes -> itemBag -> itemQuantity
    expect(view(state).quantityMax).toBe(1); // 98 + 1 <= 99
    state = step(state, A); // deposit 1 -> itemBoxes
    state = logOff(state, 1);
    expect(tuxemonExtensionState(rules.done(state)!.ext!).itemLocker).toEqual({ potion: 99 });
  });

  test("a full locker (30 types) refuses a new kind", () => {
    const locker: Record<string, number> = {};
    for (let i = 0; i < LOCKER_LIMIT; i++) locker[`item_${i}`] = 1;
    const opened = open(locker, { potion: 1, tuxeball: 1 });
    const state = step(opened.state, DOWN, A, A, A); // itemDropOff -> itemBoxes -> itemBag -> confirm
    expect(view(state).phase).toBe("itemBag");
    expect(view(state).message).toContain("locker is full");
    // Log off: the bag was never touched.
    const done = rules.done(logOff(state, 2))!; // itemBag -> itemBoxes -> menu -> Log Off
    expect(done.items).toBeUndefined();
    expect(tuxemonExtensionState(done.ext!).itemLocker).toEqual(locker);
  });

  test("cancel at any step leaves bag and locker untouched", () => {
    const opened = open({ potion: 2 }, { potion: 3, tuxeball: 1 });
    let state = step(opened.state, DOWN, A, A, A); // -> itemQuantity
    expect(view(state).phase).toBe("itemQuantity");
    state = step(state, B, B, B); // itemBag -> itemBoxes -> menu
    expect(view(state).phase).toBe("menu");
    state = logOff(state, 0); // menu -> Log Off
    const completion = rules.done(state)!;
    expect(completion.items).toBeUndefined();
    expect(tuxemonExtensionState(completion.ext!).itemLocker).toEqual({ potion: 2 });
  });
});

describe("G-PC-LOCKER withdraw and disband", () => {
  test("takes a chosen quantity into the bag", () => {
    const opened = open({ potion: 5, tuxeball: 2 }, { tuxeball: 1 });
    let state = step(opened.state, A, A, A, A); // -> itemBoxes -> itemLocker -> itemOptions -> itemQuantity
    expect(view(state).phase).toBe("itemQuantity");
    expect(view(state).quantityMax).toBe(5);
    state = step(state, RIGHT, RIGHT, RIGHT, A); // qty 4 -> take -> itemLocker
    expect(view(state).message).toContain("4 Potion");
    state = logOff(state, 2); // itemLocker -> itemBoxes -> menu -> Log Off
    const completion = rules.done(state)!;
    expect(completion.items).toEqual({ potion: 4, tuxeball: 1 });
    expect(tuxemonExtensionState(completion.ext!).itemLocker).toEqual({ potion: 1, tuxeball: 2 });
  });

  test("taking the last stack removes it from the locker", () => {
    const opened = open({ potion: 1 }, { tuxeball: 1 });
    let state = step(opened.state, A, A, A, A, A); // -> take qty 1 -> itemBoxes (empty)
    expect(view(state).phase).toBe("itemBoxes");
    state = logOff(state, 1); // itemBoxes -> menu -> Log Off
    const completion = rules.done(state)!;
    expect(completion.items).toEqual({ potion: 1, tuxeball: 1 });
    // Empty locker stays sparse.
    expect(tuxemonExtensionState(completion.ext!).itemLocker).toBeUndefined();
  });

  test("disbands a chosen quantity without touching the bag", () => {
    const opened = open({ potion: 5 }, { tuxeball: 1 });
    let state = step(opened.state, A, A, A, DOWN, A, RIGHT, A); // -> Disband qty 2 -> itemLocker
    expect(view(state).message).toContain("2 Potion");
    state = logOff(state, 2);
    const completion = rules.done(state)!;
    expect(completion.items).toBeUndefined();
    expect(tuxemonExtensionState(completion.ext!).itemLocker).toEqual({ potion: 3 });
  });

  test("refuses to take when the bag cannot hold the stack", () => {
    // Bag already at the 99 per-item cap for potion: take max is 0.
    const opened = open({ potion: 5 }, { potion: LOCKER_ITEM_CAP });
    let state = step(opened.state, A, A, A, A); // -> itemOptions -> Take
    expect(view(state).phase).toBe("itemLocker");
    expect(view(state).message).toContain("bag is full");
    // A new kind when the bag is at 99 kinds is also refused.
    const many: Record<string, number> = {};
    for (let i = 0; i < LOCKER_ITEM_CAP; i++) many[`kind_${i}`] = 1;
    const opened2 = open({ potion: 1 }, many);
    state = step(opened2.state, A, A, A, A);
    expect(view(state).message).toContain("bag is full");
    expect(pcTakeMax(view(state), "potion")).toBe(0);
  });

  test("empty locker offers no take entry; drop-off still opens the bag", () => {
    const opened = open({}, { potion: 1, tuxeball: 1 });
    expect(pcMenuItems(view(opened.state))).toEqual(["itemDropOff", "logOff"]);
    const state = step(opened.state, A, A); // itemDropOff -> itemBoxes -> itemBag
    expect(view(state).phase).toBe("itemBag");
    expect(pcBagRows(view(state))).toEqual(["potion", "tuxeball"]);
  });
});

describe("G-PC-LOCKER quantity picker", () => {
  test("left/right step by 1, up/down by 10, clamped to 1..max", () => {
    const opened = open({ potion: 25 }, {});
    let state = step(opened.state, A, A, A, A); // -> itemQuantity (take, max 25)
    expect(view(state).phase).toBe("itemQuantity");
    expect(view(state).quantity).toBe(1);
    state = step(state, UP);
    expect(view(state).quantity).toBe(11);
    state = step(state, UP, UP);
    expect(view(state).quantity).toBe(25); // clamped to max
    state = step(state, DOWN);
    expect(view(state).quantity).toBe(15);
    state = step(state, LEFT, LEFT, LEFT, LEFT, LEFT);
    expect(view(state).quantity).toBe(10);
    state = step(state, DOWN);
    expect(view(state).quantity).toBe(1); // clamped to min
  });

  test("the picker is bounded by both the stack and the bag cap", () => {
    const opened = open({ potion: 50 }, { potion: 90 });
    const state = step(opened.state, A, A, A, A);
    // bag 90 + take <= 99, so max is 9 even though the stack is 50.
    expect(view(state).quantityMax).toBe(9);
    expect(pcTakeMax(view(state), "potion")).toBe(9);
  });
});

// ---------------------------------------------------------------------------
// End-to-end: the imported Timber Cafe computer.

import { buildProject, G6_IMPORT_OPTIONS } from "../importer/project.ts";
import { BTN_BITS } from "../vendor/pocket-rpgkit/src/engine/camera.ts";
import { restoreSessionSnapshot } from "../vendor/pocket-rpgkit/src/engine/save-restore.ts";
import { canonicalJson, createSessionSnapshot } from "../vendor/pocket-rpgkit/src/engine/save.ts";
import {
  createSession,
  startSession,
  stepSession,
  type Session,
  type SessionInput,
  type SessionState,
} from "../vendor/pocket-rpgkit/src/engine/session.ts";
import { TUXEMON_SESSION_OPTIONS } from "../battle/game.ts";
import { spawnMonster } from "../battle/spawn.ts";
import { battleDbToTuxemonBattleDb } from "../battle/from-battle-db.ts";
import { TUXEMON_BATTLE_DB as E2E_DB } from "../battle/game.ts";
import type { SpawnedMonsterSnapshot } from "../battle/types.ts";

const E2E_RULE_DB = battleDbToTuxemonBattleDb(E2E_DB);
const BTN_CONFIRM = 0x2000;
const BTN_CANCEL = 0x4000;

const E2E_BUILD = buildProject(
  ["spyder_timber_cafe", "spyder_flower_petshop", "spyder_candy_house2", "spyder_candy_cafe"],
  G6_IMPORT_OPTIONS,
);

class E2EDriver {
  private previous = 0;
  readonly session: Session;
  state: SessionState;

  constructor(start: { map: string; x: number; y: number; dir: "up" | "down" | "left" | "right" }, value: JsonValue, items: Record<string, number>) {
    const project = { ...E2E_BUILD.project, start, initialGold: 0 };
    this.session = createSession(project, 60, TUXEMON_SESSION_OPTIONS);
    this.state = startSession(project, this.session, undefined, value);
    this.state.sw.items = { ...items };
  }

  static input(mask: number, previous: number): SessionInput {
    const edge = (bit: number) => Boolean((mask & bit) && !(previous & bit));
    return {
      buttons: mask,
      confirmEdge: edge(BTN_CONFIRM),
      cancelEdge: edge(BTN_CANCEL),
      upEdge: edge(BTN_BITS.UP),
      downEdge: edge(BTN_BITS.DOWN),
      leftEdge: edge(BTN_BITS.LEFT),
      rightEdge: edge(BTN_BITS.RIGHT),
    };
  }

  tick(mask = 0): void {
    this.state = stepSession(this.session, this.state, E2EDriver.input(mask, this.previous));
    this.previous = mask;
  }

  press(mask: number): void {
    this.tick(mask);
    this.tick(0);
  }

  idle(frames: number): void {
    for (let frame = 0; frame < frames; frame++) this.tick(0);
  }

  sceneId(): string | null {
    return this.state.scene?.kind === "scene" ? this.state.scene.id : null;
  }

  until(predicate: () => boolean, mask: number, limit = 600): void {
    for (let frame = 0; frame < limit && !predicate(); frame++) this.press(mask);
    expect(predicate()).toBe(true);
  }
}

function e2eExt(): JsonValue {
  const state = initialTuxemonExtensionState();
  const monster = (slug: string, iid: string): SpawnedMonsterSnapshot =>
    spawnMonster(E2E_DB, E2E_RULE_DB, { rng: iid.length * 7919, rngDraws: 0 }, slug, 12, { iid });
  state.party = [monster("nut", "p-nut")];
  return packTuxemonExtensionState(state);
}

describe("G-PC-LOCKER imported Timber Cafe PC", () => {
  test("deposits and withdraws items through the real computer, then round-trips the save", () => {
    const driver = new E2EDriver({ map: "spyder_timber_cafe", x: 10, y: 4, dir: "up" }, e2eExt(), { potion: 5, tuxeball: 3 });
    driver.idle(30);
    driver.until(() => driver.sceneId() === TUXEMON_PC_SCENE_ID, BTN_CONFIRM, 20);

    // menu = [itemDropOff, logOff]; deposit 3 potions.
    for (const mask of [BTN_CONFIRM, BTN_CONFIRM, BTN_CONFIRM, BTN_BITS.RIGHT, BTN_BITS.RIGHT, BTN_CONFIRM]) {
      driver.press(mask);
    }
    // Back to the menu and Log Off.
    driver.press(BTN_CANCEL);
    driver.press(BTN_BITS.UP);
    driver.press(BTN_CONFIRM);
    expect(driver.sceneId()).toBeNull();
    expect(driver.state.sw.items).toEqual({ potion: 2, tuxeball: 3 });
    expect(tuxemonExtensionState(driver.state.ext).itemLocker).toEqual({ potion: 3 });

    // Reopen and withdraw 1 potion.
    driver.idle(4);
    driver.until(() => driver.sceneId() === TUXEMON_PC_SCENE_ID, BTN_CONFIRM, 20);
    // menu = [itemPickUp, itemDropOff, logOff]; Pick Up Item -> Locker -> list -> Take -> qty 1.
    for (const mask of [BTN_CONFIRM, BTN_CONFIRM, BTN_CONFIRM, BTN_CONFIRM, BTN_CONFIRM]) {
      driver.press(mask);
    }
    driver.press(BTN_CANCEL); // itemLocker -> itemBoxes
    driver.press(BTN_CANCEL); // itemBoxes -> menu
    driver.press(BTN_BITS.UP); // wrap to Log Off
    driver.press(BTN_CONFIRM);
    expect(driver.sceneId()).toBeNull();
    expect(driver.state.sw.items).toEqual({ potion: 3, tuxeball: 3 });
    expect(tuxemonExtensionState(driver.state.ext).itemLocker).toEqual({ potion: 2 });

    // Save/load round-trip preserves the locker and bag.
    driver.idle(4);
    const snapshot = createSessionSnapshot(driver.session, driver.state, 0);
    const restored = restoreSessionSnapshot(driver.session, structuredClone(snapshot));
    expect(restored.sw.items).toEqual({ potion: 3, tuxeball: 3 });
    expect(tuxemonExtensionState(restored.ext).itemLocker).toEqual({ potion: 2 });
  });

  test("rewind replays a mid-locker deposit exactly", () => {
    const driver = new E2EDriver({ map: "spyder_timber_cafe", x: 10, y: 4, dir: "up" }, e2eExt(), { potion: 4, tuxeball: 1 });
    driver.idle(30);
    driver.until(() => driver.sceneId() === TUXEMON_PC_SCENE_ID, BTN_CONFIRM, 20);
    // Open the deposit quantity picker, then rewind to the menu.
    driver.press(BTN_CONFIRM); // itemDropOff -> itemBoxes
    driver.press(BTN_CONFIRM); // itemBoxes -> itemBag
    driver.press(BTN_CONFIRM); // itemBag -> itemQuantity
    const rewindPoint = driver.state;
    expect((driver.state.scene?.state as unknown as PcSceneState).phase).toBe("itemQuantity");
    // Deposit 2 and log off.
    driver.press(BTN_BITS.RIGHT);
    driver.press(BTN_CONFIRM);
    driver.press(BTN_CANCEL); // itemBoxes -> menu
    driver.press(BTN_BITS.UP);
    driver.press(BTN_CONFIRM);
    expect(driver.state.sw.items).toEqual({ potion: 2, tuxeball: 1 });
    // Replay from the picker: same inputs, same terminal state.
    const replay = new E2EDriver({ map: "spyder_timber_cafe", x: 10, y: 4, dir: "up" }, e2eExt(), { potion: 4, tuxeball: 1 });
    replay.state = rewindPoint;
    for (const mask of [BTN_BITS.RIGHT, BTN_CONFIRM, BTN_CANCEL, BTN_BITS.UP, BTN_CONFIRM]) {
      replay.press(mask);
    }
    expect(canonicalJson(replay.state)).toBe(canonicalJson(driver.state));
  });
});
