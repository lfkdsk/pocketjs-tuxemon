import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  advanceDaycareStep,
  daycareBreedingEligible,
  daycareMode,
  daycareReady,
  depositDaycareParent,
  produceDaycareNewborn,
} from "../battle/daycare.ts";
import {
  initialTuxemonExtensionState,
  packTuxemonExtensionState,
  tuxemonExtensionProblem,
} from "../battle/extension.ts";
import { battleDbToTuxemonBattleDb } from "../battle/from-battle-db.ts";
import { spawnMonster } from "../battle/spawn.ts";
import type { DaycareExtensionState, SpawnedMonsterSnapshot } from "../battle/types.ts";
import { validateBattleDb } from "../importer/battle-schema.ts";

const ROOT = join(import.meta.dir, "..");
const SOURCE_DB = validateBattleDb(JSON.parse(readFileSync(join(ROOT, "data/battle-db.json"), "utf8")));
const DB = battleDbToTuxemonBattleDb(SOURCE_DB);

function monster(
  slug: string,
  iid: string,
  overrides: Partial<SpawnedMonsterSnapshot> = {},
): SpawnedMonsterSnapshot {
  return {
    ...spawnMonster(SOURCE_DB, DB, { rng: iid.length * 104_729, rngDraws: 0 }, slug, 12, { iid }),
    ...overrides,
  };
}

function daycare(
  parents: SpawnedMonsterSnapshot[],
  update: Partial<DaycareExtensionState> = {},
): DaycareExtensionState {
  return {
    parents,
    progressSteps: 0,
    pendingExperience: 0,
    lastTrainingExp: 0,
    lastTrainingCost: 0,
    ...update,
  };
}

describe("daycare sparse state and compatibility", () => {
  test("fresh extension bytes remain unchanged until the first deposit", () => {
    const fresh = initialTuxemonExtensionState();
    const before = packTuxemonExtensionState(fresh);
    expect(fresh).not.toHaveProperty("daycare");
    expect(packTuxemonExtensionState(initialTuxemonExtensionState())).toBe(before);

    const parent = monster("rockitten", "parent-1");
    fresh.daycare = depositDaycareParent(undefined, parent);
    expect(packTuxemonExtensionState(fresh)).not.toBe(before);
    expect(tuxemonExtensionProblem(packTuxemonExtensionState(fresh), SOURCE_DB)).toBeNull();
  });

  test("requires an evolved male/female pair and enforces global iid uniqueness", () => {
    const male = monster("bamboon", "parent-m", { gender: "male", stage: "stage1" });
    const female = monster("bigfin", "parent-f", { gender: "female", stage: "standalone" });
    expect(daycareBreedingEligible([male, female])).toBeTrue();
    expect(daycareMode([male, female])).toBe("breeding");
    expect(daycareBreedingEligible([male, { ...female, gender: "male" }])).toBeFalse();
    expect(daycareMode([male, { ...female, gender: "male" }])).toBe("incompatible");
    expect(daycareBreedingEligible([male, { ...female, stage: "basic" }])).toBeFalse();
    expect(daycareMode([male])).toBe("training");
    expect(daycareMode([])).toBe("empty");

    const ext = initialTuxemonExtensionState();
    ext.party = [male];
    ext.daycare = daycare([male]);
    expect(tuxemonExtensionProblem(packTuxemonExtensionState(ext), SOURCE_DB))
      .toBe("duplicate monster iid parent-m");
  });
});

describe("daycare per-step reducer", () => {
  test("settles one EXP after four steps and charges only at settlement", () => {
    const parent = monster("rockitten", "trainer-1", { heldItem: "xp_feeder" });
    const startExperience = parent.totalExperience!;
    let state = daycare([parent]);
    let gold = 10;
    for (let step = 0; step < 3; step++) ({ daycare: state, gold } = advanceDaycareStep(state, gold, DB));
    expect(state.pendingExperience).toBe(0.75);
    expect(state.parents[0]!.totalExperience).toBe(startExperience);
    expect(gold).toBe(10);

    ({ daycare: state, gold } = advanceDaycareStep(state, gold, DB));
    expect(state.pendingExperience).toBe(0);
    expect(state.parents[0]!.totalExperience).toBe(startExperience + 1);
    expect(state.parents[0]!.heldItem).toBe("xp_feeder");
    expect(state.lastTrainingExp).toBe(1);
    expect(state.lastTrainingCost).toBe(1);
    expect(gold).toBe(9);
  });

  test("insufficient funds pause the entire settlement without losing pending EXP", () => {
    const parent = monster("rockitten", "trainer-2");
    const startExperience = parent.totalExperience!;
    let state = daycare([parent], { pendingExperience: 0.75 });
    let result = advanceDaycareStep(state, 0, DB);
    state = result.daycare;
    expect(result.gold).toBe(0);
    expect(state.pendingExperience).toBe(1);
    expect(state.parents[0]!.totalExperience).toBe(startExperience);
    expect(state.lastTrainingExp).toBe(0);

    result = advanceDaycareStep(state, 1, DB);
    expect(result.gold).toBe(0);
    expect(result.daycare.pendingExperience).toBe(0.25);
    expect(result.daycare.parents[0]!.totalExperience).toBe(startExperience + 1);
  });

  test("two incompatible parents each gain EXP but pay one shared bill", () => {
    const first = monster("bamboon", "trainer-m1", { gender: "male", stage: "stage1" });
    const second = monster("bigfin", "trainer-m2", { gender: "male", stage: "stage1" });
    const before = first.totalExperience!;
    const result = advanceDaycareStep(daycare([first, second], { pendingExperience: 0.75 }), 1, DB);
    expect(result.daycare.parents.map((parent) => parent.totalExperience)).toEqual([before + 1, before + 1]);
    expect(result.daycare.lastTrainingExp).toBe(1);
    expect(result.daycare.lastTrainingCost).toBe(1);
    expect(result.gold).toBe(0);
  });

  test("compatible parents breed at the exact 10,000-step boundary without training", () => {
    const male = monster("bamboon", "breeder-m", { gender: "male", stage: "stage1" });
    const female = monster("bigfin", "breeder-f", { gender: "female", stage: "stage1" });
    const before = [male.totalExperience, female.totalExperience];
    let state = daycare([male, female], { progressSteps: 9_999 });
    expect(daycareReady(state)).toBeFalse();
    const result = advanceDaycareStep(state, 0, DB);
    state = result.daycare;
    expect(daycareReady(state)).toBeTrue();
    expect(state.progressSteps).toBe(10_000);
    expect(state.parents.map((parent) => parent.totalExperience)).toEqual(before);
    expect(result.gold).toBe(0);
  });

  test("10,000 steps never make same-gender or basic-stage pairs breeding-ready", () => {
    const male = monster("bamboon", "male", { gender: "male", stage: "stage1" });
    const sameGender = monster("bigfin", "same", { gender: "male", stage: "stage1" });
    const basicFemale = monster("rockitten", "basic", { gender: "female", stage: "basic" });
    for (const parents of [[male, sameGender], [male, basicFemale]]) {
      let state = daycare(parents, { progressSteps: 9_999 });
      for (let step = 0; step < 4; step++) state = advanceDaycareStep(state, 50, DB).daycare;
      expect(daycareReady({ ...state, progressSteps: 10_000 })).toBeFalse();
      expect(state.progressSteps).toBe(9_999);
      expect(state.lastTrainingExp).toBe(1);
    }
  });
});

describe("daycare newborn", () => {
  test("is deterministic and inherits lineage, parentwise-max IVs, and one non-seed move", () => {
    const equalBase = { armour: 80, dodge: 80, hp: 80, melee: 80, ranged: 80, speed: 80 };
    const lowHigh = { armour: 1, dodge: 15, hp: 1, melee: 15, ranged: 1, speed: 15 };
    const highLow = { armour: 15, dodge: 1, hp: 15, melee: 1, ranged: 15, speed: 1 };
    const mother = monster("bamboon", "mother", {
      nickname: "Alpha",
      gender: "female",
      stage: "stage1",
      base: equalBase,
      currentHp: equalBase.hp,
      individualValues: lowHigh,
      moves: ["acid"],
      types: ["wood"],
    });
    const father = monster("bamboon", "father", {
      nickname: "Beta",
      gender: "male",
      stage: "stage1",
      base: equalBase,
      currentHp: equalBase.hp,
      individualValues: highLow,
      moves: ["beam"],
      types: ["wood"],
    });
    const ready = daycare([mother, father], { progressSteps: 10_000 });
    const make = () => produceDaycareNewborn(ready, {
      sourceDb: SOURCE_DB,
      rulesDb: DB,
      iid: "child",
      birthdate: [9, 28],
      nameOf: (slug) => SOURCE_DB.monsters[slug]!.name,
      // Every choice is reproducible. The first tie-break chooses father,
      // making mother the one-move inheritance source.
      random: () => 0.75,
    });
    const first = make();
    expect(make()).toEqual(first);
    expect(first.daycare.progressSteps).toBe(0);
    expect(first.daycare.parents).toEqual([mother, father]);
    expect(first.newborn).toMatchObject({
      iid: "child",
      slug: "budaye",
      level: 12,
      birthdate: [9, 28],
      acquisition: "bred",
      bond: 40,
      motherIid: "mother",
      fatherIid: "father",
      individualValues: { armour: 15, dodge: 15, hp: 15, melee: 15, ranged: 15, speed: 15 },
    });
    expect(first.newborn.moves).toContain("acid");
    expect(first.newborn.currentHp).toBe(first.newborn.base.hp);
  });
});
