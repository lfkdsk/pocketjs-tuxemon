import { describe, expect, test } from "bun:test";

import {
  initialTuxemonExtensionState,
  KENNEL_LIMIT,
  packTuxemonExtensionState,
  tuxemonExtensionProblem,
  tuxemonExtensionState,
  type TuxemonExtensionState,
} from "../battle/extension.ts";
import { battleDbToTuxemonBattleDb } from "../battle/from-battle-db.ts";
import {
  TUXEMON_BATTLE_DB as DB,
  TUXEMON_EXTENSIONS as extensions,
  TUXEMON_SCENES as scenes,
  TUXEMON_SESSION_OPTIONS,
} from "../battle/game.ts";
import { spawnMonster } from "../battle/spawn.ts";
import {
  pcBoxView,
  pcMenuItems,
  pcOptions,
  pcVisibleBoxes,
  TRADE_ANIMATION_TICKS,
  TUXEMON_MONSTER_SHOP_SCENE_ID,
  TUXEMON_PC_SCENE_ID,
  TUXEMON_TRADE_SCENE_ID,
  type MonsterShopSceneState,
  type PcSceneState,
  type TradeSceneState,
} from "../battle/storage-scenes.ts";
import type { SpawnedMonsterSnapshot } from "../battle/types.ts";
import { buildProject, G6_IMPORT_OPTIONS } from "../importer/project.ts";
import { BTN_BITS } from "../vendor/pocket-rpgkit/src/engine/camera.ts";
import type { ExtensionCommandContext } from "../vendor/pocket-rpgkit/src/engine/extensions.ts";
import { restoreSessionSnapshot } from "../vendor/pocket-rpgkit/src/engine/save-restore.ts";
import { canonicalJson, createSessionSnapshot } from "../vendor/pocket-rpgkit/src/engine/save.ts";
import type { SceneInput, SceneRules } from "../vendor/pocket-rpgkit/src/engine/scene.ts";
import {
  createSession,
  startSession,
  stepSession,
  type Session,
  type SessionInput,
  type SessionState,
} from "../vendor/pocket-rpgkit/src/engine/session.ts";
import type { JsonValue, Project } from "../vendor/pocket-rpgkit/src/engine/types.ts";

const RULE_DB = battleDbToTuxemonBattleDb(DB);
const BTN_CONFIRM = 0x2000;
const BTN_CANCEL = 0x4000;

function monster(slug: string, iid: string, level = 12, hp?: number): SpawnedMonsterSnapshot {
  const spawned = spawnMonster(DB, RULE_DB, { rng: iid.length * 7919, rngDraws: 0 }, slug, level, { iid });
  return hp === undefined ? spawned : { ...spawned, currentHp: hp };
}

function ext(update: (state: TuxemonExtensionState) => void = () => {}): JsonValue {
  const state = initialTuxemonExtensionState();
  update(state);
  return packTuxemonExtensionState(state);
}

function context(value: JsonValue, variables: Record<string, number | string> = {}, gold = 0): ExtensionCommandContext {
  return {
    ext: value,
    switches: {},
    variables,
    items: {},
    gold,
    playerName: "A",
    random: () => 0.5,
  };
}

const command = (name: string) => extensions.commands![name]!;
const condition = (name: string) => extensions.conditions![name]!;

function stepScene(rules: SceneRules, state: JsonValue, ...inputs: Partial<SceneInput>[]): JsonValue {
  let value = state;
  for (const input of inputs) value = rules.step(structuredClone(value), { buttons: 0, ...input }, 1);
  return value;
}

const A = { confirmEdge: true };
const B = { cancelEdge: true };
const UP = { upEdge: true };
const DOWN = { downEdge: true };

describe("GI-2b kennel boxes", () => {
  test("create_kennel/set_kennel_visible drive the kennel and has_kennel conditions", () => {
    let value = ext();
    const kennel = (kennelId: string, option: string, negate = false) =>
      condition("tux.kennel")(context(value), { character: "player", kennel: kennelId, option, negate });
    const hasKennel = (kennelId: string, operator: string, count: number, negate = false) =>
      condition("tux.has_kennel")(context(value), {
        character: "player", kennel: kennelId, operator, value: count, negate,
      });

    // spyder.yaml: `not kennel player,quarantine,exist` -> create hidden.
    expect(kennel("quarantine", "exist", true)).toBe(true);
    value = command("tux.create_kennel")(context(value), {
      character: "player", kennel: "quarantine", hidden: true,
    })!.ext!;
    expect(kennel("quarantine", "exist", true)).toBe(false);
    expect(kennel("quarantine", "hidden")).toBe(true);
    expect(kennel("quarantine", "visible")).toBe(false);
    // Creating an existing box is a no-op, as upstream.
    expect(command("tux.create_kennel")(context(value), {
      character: "player", kennel: "quarantine", hidden: false,
    })).toBeUndefined();

    value = command("tux.set_kennel_visible")(context(value), {
      character: "player", kennel: "quarantine", visible: true,
    })!.ext!;
    expect(kennel("quarantine", "visible")).toBe(true);
    expect(tuxemonExtensionState(value).boxes).toEqual({
      quarantine: { hidden: false, capacity: KENNEL_LIMIT, monsters: [] },
    });

    // has_kennel on a missing box fails both forms (upstream ValueError).
    expect(hasKennel("Kennel", "less_than", 1)).toBe(false);
    expect(hasKennel("Kennel", "less_than", 1, true)).toBe(false);
    expect(kennel("Kennel", "exist")).toBe(false);
    // A missing character or NPC box tests false; `not` makes it true.
    expect(condition("tux.kennel")(context(value), {
      character: "npc_maple", kennel: "quarantine", option: "exist", negate: true,
    })).toBe(true);

    value = command("tux.create_kennel")(context(value), { character: "player", kennel: "Kennel" })!.ext!;
    expect(kennel("Kennel", "visible")).toBe(true);
    expect(hasKennel("Kennel", "less_than", 1)).toBe(true);
    expect(hasKennel("Kennel", "greater_or_equal", 1)).toBe(false);
  });

  test("party overflow creates the Kennel box and the validator guards every box", () => {
    let value = ext((state) => {
      state.party = ["nut", "rockitten", "budaye", "cateye", "bigfin", "aardorn"]
        .map((slug, index) => monster(slug, `p-${index}`));
    });
    value = command("tux.add_monster")(context(value), { species: "eyenemy", level: 5 })!.ext!;
    const state = tuxemonExtensionState(value);
    expect(state.kennel.map((entry) => entry.slug)).toEqual(["eyenemy"]);
    expect(state.kennelBox).toBe(true);
    expect(condition("tux.has_kennel")(context(value), {
      character: "player", kennel: "Kennel", operator: "greater_or_equal", value: 1, negate: false,
    })).toBe(true);

    const duplicate = initialTuxemonExtensionState();
    duplicate.party = [monster("nut", "dup")];
    duplicate.boxes = { quarantine: { hidden: true, capacity: 30, monsters: [monster("rockitten", "dup")] } };
    expect(tuxemonExtensionProblem(packTuxemonExtensionState(duplicate))).toBe("duplicate monster iid dup");
    const overfull = initialTuxemonExtensionState();
    overfull.boxes = { small: { hidden: false, capacity: 1, monsters: [monster("nut", "a"), monster("nut", "b")] } };
    expect(tuxemonExtensionProblem(packTuxemonExtensionState(overfull))).toBe("boxes.small is invalid");
  });
});

describe("GI-2b PC storage scene", () => {
  const rules = scenes[TUXEMON_PC_SCENE_ID]!;
  const start = (value: JsonValue) => {
    const started = rules.start(value, { boxNames: { Kennel: "Shelter", quarantine: "Quarantine" } }, 1, context(value));
    expect(started).not.toBeNull();
    return started!;
  };
  const view = (value: JsonValue) => value as unknown as PcSceneState;

  test("opening creates the Kennel; drop off appends and protects the last conscious monster", () => {
    const value = ext((state) => {
      state.party = [monster("nut", "p-nut", 12, 0), monster("rockitten", "p-rock")];
      state.boxes = { quarantine: { hidden: true, capacity: 30, monsters: [monster("bigfin", "q-fin")] } };
    });
    const started = start(value);
    expect(tuxemonExtensionState(started.ext).kennelBox).toBe(true);
    let state = started.state;
    expect(pcMenuItems(view(state))).toEqual(["dropOff", "multiplayer", "logOff"]);
    // Hidden boxes are never listed.
    expect(pcVisibleBoxes(view(state)).map((box) => box.id)).toEqual(["Kennel"]);

    // The fainted Nut can be stored; Rockitten is the last conscious monster.
    state = stepScene(rules, state, DOWN, UP, A);
    expect(view(state).phase).toBe("party");
    state = stepScene(rules, state, DOWN, A);
    expect(view(state).phase).toBe("party");
    expect(view(state).message).toContain("last Tuxemon");
    // Cancel at the PC menu does not leave: only Log Off does.
    state = stepScene(rules, state, B, B);
    expect(view(state).phase).toBe("menu");
    expect(rules.done(state)).toBeNull();

    state = stepScene(rules, state, A, A, A);
    expect(view(state).party).toEqual(["p-rock"]);
    expect(view(state).boxes[0]!.monsters).toEqual(["p-nut"]);
    expect(pcMenuItems(view(state))).toEqual(["pickUp", "multiplayer", "logOff"]);
    state = stepScene(rules, state, UP, A);
    const completion = rules.done(state)!;
    const committed = tuxemonExtensionState(completion.ext!, DB);
    expect(committed.party.map((entry) => entry.iid)).toEqual(["p-rock"]);
    expect(committed.kennel).toEqual([tuxemonExtensionState(value).party[0]!]);
    expect(committed.boxes?.quarantine?.monsters.map((entry) => entry.iid)).toEqual(["q-fin"]);
  });

  test("pick up, move and release follow the upstream option rules", () => {
    const value = ext((state) => {
      state.party = [monster("nut", "p-nut")];
      state.kennel = [monster("rockitten", "k-rock"), monster("aardorn", "k-aard"), monster("budaye", "k-bud")];
      state.kennelBox = true;
      state.boxes = { quarantine: { hidden: false, capacity: 30, monsters: [] } };
    });
    let state = start(value).state;
    state = stepScene(rules, state, A);
    expect(view(state).phase).toBe("boxes");
    // Kennel first, then named boxes in creation order.
    expect(pcVisibleBoxes(view(state)).map((box) => box.label)).toEqual(["Shelter", "Quarantine"]);
    state = stepScene(rules, state, A);
    // Display order is by slug; storage order is unchanged.
    const kennel = view(state).boxes[0]!;
    expect(pcBoxView(view(state), kennel)).toEqual(["k-aard", "k-bud", "k-rock"]);
    state = stepScene(rules, state, A);
    expect(pcOptions(view(state))).toEqual(["pick", "move", "release", "cancel"]);

    // Pick Aardorn: appended to the party end.
    state = stepScene(rules, state, A);
    expect(view(state).party).toEqual(["p-nut", "k-aard"]);
    expect(view(state).message).toBe("You added Aardorn into your party!");
    // Move Budaye: one candidate box, so it moves directly.
    state = stepScene(rules, state, A, DOWN, A);
    expect(view(state).boxes[1]!.monsters).toEqual(["k-bud"]);
    // Release Rockitten: the confirmation defaults to No.
    state = stepScene(rules, state, A, DOWN, DOWN, A);
    expect(view(state).phase).toBe("confirmRelease");
    state = stepScene(rules, state, A);
    expect(view(state).phase).toBe("options");
    state = stepScene(rules, state, A, UP, A);
    expect(view(state).message).toBe("Rockitten has been released.");
    // The emptied box returns to the box list.
    expect(view(state).phase).toBe("boxes");

    state = stepScene(rules, state, B, DOWN, DOWN, DOWN, A);
    const committed = tuxemonExtensionState(rules.done(state)!.ext!, DB);
    expect(committed.party.map((entry) => entry.iid)).toEqual(["p-nut", "k-aard"]);
    expect(committed.kennel).toEqual([]);
    expect(committed.boxes?.quarantine?.monsters.map((entry) => entry.iid)).toEqual(["k-bud"]);
    expect(tuxemonExtensionProblem(packTuxemonExtensionState(committed), DB)).toBeNull();
  });
});

describe("GI-2b scripted trade scene", () => {
  const rules = scenes[TUXEMON_TRADE_SCENE_ID]!;
  const value = ext((state) => {
    state.party = [monster("cateye", "p-cat", 14), monster("nut", "p-nut", 9)];
    state.kennel = [monster("cateye", "k-cat", 3)];
    state.kennelBox = true;
    state.nextMonsterId = 40;
  });

  test("replaces the sent monster in place at its level and registers the catch", () => {
    const started = rules.start(value, { variable: "v.cateye", species: "zunna" }, 1234, context(value, { "v.cateye": "p-cat" }))!;
    const state = tuxemonExtensionState(started.ext, DB);
    const received = state.party[0]!;
    expect(state.party.map((entry) => entry.slug)).toEqual(["zunna", "nut"]);
    expect(received).toMatchObject({ iid: "txmn-000014", level: 14, bond: 10, currentHp: received.base.hp });
    expect(received.nickname).toBeUndefined();
    expect(state.caught).toContain("zunna");
    expect(state.nextMonsterId).toBe(41);
    expect(state.kennel.map((entry) => entry.iid)).toEqual(["k-cat"]);
    expect((started.state as unknown as TradeSceneState).message).toBe("You traded Cateye and received Zunna!");

    // Same seed, same monster: the received stats are reproducible.
    const again = rules.start(value, { variable: "v.cateye", species: "zunna" }, 1234, context(value, { "v.cateye": "p-cat" }))!;
    expect(again.ext).toBe(started.ext);
  });

  test("no-ops without a party-owned monster and runs the transition at any rate", () => {
    const trade = (variables: Record<string, number | string>) =>
      rules.start(value, { variable: "v.cateye", species: "zunna" }, 1, context(value, variables));
    expect(trade({})).toBeNull();
    expect(trade({ "v.cateye": 1 })).toBeNull(); // no_choice enum code
    expect(trade({ "v.cateye": "k-cat" })).toBeNull(); // kennel monsters have no trade owner

    const started = trade({ "v.cateye": "p-cat" })!;
    for (const ticks of [1, 2, 3]) {
      let state = started.state;
      let frames = 0;
      while ((state as unknown as TradeSceneState).phase === "animate") {
        state = rules.step(structuredClone(state), { buttons: 0 }, ticks);
        frames++;
      }
      expect(frames).toBe(TRADE_ANIMATION_TICKS / ticks);
      expect(rules.done(state)).toBeNull();
      state = rules.step(state, { buttons: 0, confirmEdge: true }, ticks);
      expect(rules.done(state)).toEqual({});
    }
    const skipped = stepScene(rules, started.state, A);
    expect((skipped as unknown as TradeSceneState).phase).toBe("message");
  });
});

describe("GI-2b monster shop scene", () => {
  const rules = scenes[TUXEMON_MONSTER_SHOP_SCENE_ID]!;
  const args = {
    economy: "spyder_flower_petshop",
    entries: ["squink", "potturmeist", "fuzzlet"].map((slug) => ({ slug, price: 500, level: 10, stock: 1 })),
  };

  test("buys at the economy level, charges gold and saves the stock", () => {
    const value = ext((state) => {
      state.party = ["nut", "rockitten", "budaye", "cateye", "bigfin"].map((slug, index) => monster(slug, `p-${index}`));
      state.nextMonsterId = 7;
    });
    const started = rules.start(value, args, 99, context(value, {}, 1_200))!;
    let state = started.state;
    const view = () => state as unknown as MonsterShopSceneState;
    expect(view().rows.map((row) => row.label)).toEqual(["Fuzzlet", "Potturmeist", "Squink"]);
    // Buy Fuzzlet (party slot 6), then Potturmeist (Kennel).
    state = stepScene(rules, state, A, A);
    expect(view().message).toBe("You bought Fuzzlet!");
    state = stepScene(rules, state, A, A);
    expect(view().gold).toBe(200);
    state = stepScene(rules, state, A);
    expect(view().message).toBe("You can't afford that yet");
    state = stepScene(rules, state, B);
    const completion = rules.done(state)!;
    expect(completion.gold).toBe(200);
    const committed = tuxemonExtensionState(completion.ext!, DB);
    expect(committed.party.at(-1)).toMatchObject({ slug: "fuzzlet", level: 10, bond: 20, iid: "txmn-000007" });
    expect(committed.kennel.map((entry) => entry.slug)).toEqual(["potturmeist"]);
    expect(committed.kennelBox).toBe(true);
    expect(committed.shopSold).toEqual({
      "spyder_flower_petshop:fuzzlet": 1,
      "spyder_flower_petshop:potturmeist": 1,
    });
    // Upstream buying does not touch the Tuxepedia.
    expect(committed.caught).toEqual([]);

    const reopened = rules.start(completion.ext!, args, 5, context(completion.ext!, {}, 5_000))!;
    expect((reopened.state as unknown as MonsterShopSceneState).rows.map((row) => row.slug)).toEqual(["squink"]);
  });

  test("leaving without a purchase changes nothing", () => {
    const value = ext();
    const started = rules.start(value, args, 1, context(value, {}, 9_000))!;
    expect(rules.done(stepScene(rules, started.state, B))).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// Real imported events through a kit session.

const BUILD = buildProject(
  ["spyder_timber_cafe", "spyder_flower_petshop", "spyder_candy_house2", "spyder_candy_cafe"],
  G6_IMPORT_OPTIONS,
);

class Driver {
  private previous = 0;
  readonly session: Session;
  state: SessionState;

  constructor(start: Project["start"], value: JsonValue, gold = 0, hz = 60) {
    const project: Project = { ...BUILD.project, start, initialGold: gold };
    this.session = createSession(project, hz, TUXEMON_SESSION_OPTIONS);
    this.state = startSession(project, this.session, undefined, value);
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
    this.state = stepSession(this.session, this.state, Driver.input(mask, this.previous));
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

describe("GI-2b imported events", () => {
  test("the Timber Cafe computer stores a monster, refuses mid-scene saves and round-trips", () => {
    const value = ext((state) => {
      state.party = [monster("nut", "p-nut"), monster("rockitten", "p-rock")];
    });
    const driver = new Driver({ map: "spyder_timber_cafe", x: 10, y: 4, dir: "up" }, value);
    driver.idle(30);
    driver.until(() => driver.sceneId() === TUXEMON_PC_SCENE_ID, BTN_CONFIRM, 20);
    expect(() => createSessionSnapshot(driver.session, driver.state, 0)).toThrow("only valid");

    // Drop off Rockitten into the Shelter, then log off.
    const rewindPoint = driver.state;
    for (const mask of [BTN_CONFIRM, BTN_BITS.DOWN, BTN_CONFIRM, BTN_CONFIRM, BTN_BITS.UP, BTN_CONFIRM]) {
      driver.press(mask);
    }
    expect(driver.sceneId()).toBeNull();
    const committed = tuxemonExtensionState(driver.state.ext, DB);
    expect(committed.party.map((entry) => entry.iid)).toEqual(["p-nut"]);
    expect(committed.kennel.map((entry) => entry.iid)).toEqual(["p-rock"]);
    // spyder.yaml created the hidden quarantine box on map entry.
    expect(committed.boxes).toEqual({ quarantine: { hidden: true, capacity: 30, monsters: [] } });

    // Rewind: replaying the same inputs from the mid-scene state is exact.
    const replay = new Driver({ map: "spyder_timber_cafe", x: 10, y: 4, dir: "up" }, value);
    replay.state = rewindPoint;
    for (const mask of [BTN_CONFIRM, BTN_BITS.DOWN, BTN_CONFIRM, BTN_CONFIRM, BTN_BITS.UP, BTN_CONFIRM]) {
      replay.press(mask);
    }
    expect(canonicalJson(replay.state)).toBe(canonicalJson(driver.state));

    driver.idle(4);
    const snapshot = createSessionSnapshot(driver.session, driver.state, 0);
    const restored = restoreSessionSnapshot(driver.session, structuredClone(snapshot));
    expect(tuxemonExtensionState(restored.ext, DB)).toEqual(tuxemonExtensionState(driver.state.ext, DB));
    expect(tuxemonExtensionState(restored.ext, DB).kennel).toEqual(committed.kennel);
  });

  test("the Flower pet shop sells its imported stock once at every frame rate", () => {
    const value = ext((state) => {
      state.party = [monster("nut", "p-nut")];
    });
    const outcomes: string[] = [];
    for (const hz of [60, 30, 20]) {
      const driver = new Driver({ map: "spyder_flower_petshop", x: 7, y: 5, dir: "up" }, value, 1_000, hz);
      driver.idle(10);
      driver.until(() => driver.sceneId() === TUXEMON_MONSTER_SHOP_SCENE_ID, BTN_CONFIRM, 60);
      // Fuzzlet is first by name; buy it and leave.
      driver.press(BTN_CONFIRM);
      driver.press(BTN_CONFIRM);
      driver.press(BTN_CANCEL);
      expect(driver.sceneId()).toBeNull();
      expect(driver.state.sw.gold).toBe(500);
      const state = tuxemonExtensionState(driver.state.ext, DB);
      expect(state.party.map((entry) => `${entry.slug}@${entry.level}`)).toEqual(["nut@12", "fuzzlet@10"]);
      expect(state.shopSold).toEqual({ "spyder_flower_petshop:fuzzlet": 1 });
      outcomes.push(canonicalJson(state.party[1] as unknown as JsonValue));
    }
    expect(new Set(outcomes).size).toBe(1);
  });

  test("Professor Indiana's Cateye trade runs through the slug-filtered picker", () => {
    const value = ext((state) => {
      state.party = [monster("nut", "p-nut"), monster("cateye", "p-cat", 17)];
    });
    const driver = new Driver({ map: "spyder_candy_house2", x: 4, y: 3, dir: "up" }, value);
    driver.state.sw.variables["v.prof_willtrade"] = 2;
    driver.until(() => driver.sceneId() === TUXEMON_TRADE_SCENE_ID, BTN_CONFIRM, 120);
    driver.until(() => driver.sceneId() === null, BTN_CONFIRM, 20);
    const state = tuxemonExtensionState(driver.state.ext, DB);
    expect(state.party.map((entry) => `${entry.slug}@${entry.level}`)).toEqual(["nut@12", "zunna@17"]);
    expect(state.caught).toContain("zunna");
    expect(driver.state.sw.variables["v.prof_candy_hastraded"]).toBe(1);
    // The event cannot repeat once hastraded is set.
    driver.idle(120);
    expect(tuxemonExtensionState(driver.state.ext, DB).party[1]!.slug).toBe("zunna");
  });

  test("the Candy Cafe barmaid reads the Kennel box after the confiscation", () => {
    const run = (update: (state: TuxemonExtensionState) => void) => {
      const driver = new Driver({ map: "spyder_candy_cafe", x: 8, y: 8, dir: "up" }, ext(update));
      driver.state.sw.variables["v.confiscation_done"] = 1;
      for (let frame = 0; frame < 600 && driver.state.sw.variables["v.cafe_done"] !== 1; frame++) {
        driver.press(BTN_CONFIRM);
      }
      return driver;
    };
    // No Kennel box yet: upstream's has_kennel raises, so neither page runs.
    const none = run((state) => { state.party = [monster("nut", "p-nut")]; });
    expect(none.state.sw.variables["v.cafe_done"]).toBeUndefined();
    // An empty Kennel: the barmaid hands over her Nudiflot.
    const empty = run((state) => { state.kennelBox = true; });
    expect(empty.state.sw.variables["v.cafe_done"]).toBe(1);
    expect(tuxemonExtensionState(empty.state.ext, DB).party.map((entry) => entry.slug)).toEqual(["nudiflot_male"]);
    // A stocked Kennel: she points at the PC and gives nothing.
    const stocked = run((state) => { state.kennel = [monster("nut", "k-nut")]; });
    expect(stocked.state.sw.variables["v.cafe_done"]).toBe(1);
    expect(tuxemonExtensionState(stocked.state.ext, DB).party).toEqual([]);
  });
});
