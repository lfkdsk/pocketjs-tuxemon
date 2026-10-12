import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { initialTuxemonExtensionState, type TuxemonExtensionState } from "../battle/extension.ts";
import { battleDbToTuxemonBattleDb } from "../battle/from-battle-db.ts";
import { spawnMonster } from "../battle/spawn.ts";
import { calculateBaseStats } from "../battle/stats.ts";
import {
  listWorldItems,
  useWorldItem,
  worldItemTargetEligibility,
} from "../battle/world-items.ts";
import type { SpawnedMonsterSnapshot } from "../battle/types.ts";
import { validateBattleDb } from "../importer/battle-schema.ts";
import { createSwitchState } from "../vendor/pocket-rpgkit/src/engine/interpreter.ts";

const ROOT = join(import.meta.dir, "..");
const SOURCE_DB = validateBattleDb(JSON.parse(readFileSync(join(ROOT, "data/battle-db.json"), "utf8")));
const RULES_DB = battleDbToTuxemonBattleDb(SOURCE_DB);

function monster(
  slug = "rockitten",
  overrides: Partial<SpawnedMonsterSnapshot> = {},
): SpawnedMonsterSnapshot {
  return {
    ...spawnMonster(SOURCE_DB, RULES_DB, { rng: 0x1020_3040, rngDraws: 0 }, slug, 12, { iid: `${slug}-1` }),
    ...overrides,
  };
}

function extension(member: SpawnedMonsterSnapshot): TuxemonExtensionState {
  return { ...initialTuxemonExtensionState(), party: [member] };
}

describe("world item restorative semantics", () => {
  test("rejects a full-HP potion target without consuming it", () => {
    const member = monster();
    const ext = extension(member);
    const sw = createSwitchState({ items: { potion: 2 } });

    expect(worldItemTargetEligibility(SOURCE_DB, ext, sw, "potion", 0)).toMatchObject({
      eligible: false,
      reason: "target-ineligible",
    });
    const result = useWorldItem(SOURCE_DB, ext, sw, { item: "potion", target: 0 });

    expect(result).toMatchObject({ success: false, consumed: false, reason: "target-ineligible" });
    expect(result.switches.items.potion).toBe(2);
    expect(result.extension.party[0]).toBe(member);
  });

  test("heals up to max HP and decrements one potion", () => {
    const member = monster("rockitten");
    const wounded = { ...member, currentHp: member.base.hp - 10 };
    const result = useWorldItem(
      SOURCE_DB,
      extension(wounded),
      createSwitchState({ items: { potion: 2 } }),
      { item: "potion", target: 0 },
    );

    expect(result).toMatchObject({ success: true, consumed: true, reason: null });
    expect(result.extension.party[0]!.currentHp).toBe(member.base.hp);
    expect(result.switches.items.potion).toBe(1);
  });

  test("festering blocks an ordinary potion after selection, so the failed attempt is consumed", () => {
    const member = monster("rockitten");
    const afflicted = { ...member, currentHp: member.base.hp - 10, status: "festering" };
    const result = useWorldItem(
      SOURCE_DB,
      extension(afflicted),
      createSwitchState({ items: { potion: 1 } }),
      { item: "potion", target: 0 },
    );

    expect(result).toMatchObject({ success: false, consumed: true, reason: "festering" });
    expect(result.extension.party[0]).toMatchObject({ currentHp: afflicted.currentHp, status: "festering" });
    expect(result.switches.items).not.toHaveProperty("potion");
  });

  test("cureall runs heal before restore: festering blocks HP but the aggregate succeeds and clears status", () => {
    const member = monster("rockitten");
    const afflicted = { ...member, currentHp: Math.trunc(member.base.hp / 2), status: "festering" };
    const result = useWorldItem(
      SOURCE_DB,
      extension(afflicted),
      createSwitchState({ items: { cureall: 1 } }),
      { item: "cureall", target: 0 },
    );

    expect(result).toMatchObject({ success: true, consumed: true, reason: null });
    expect(result.effects).toEqual([
      { type: "heal", success: false, reason: "festering" },
      { type: "restore", success: true, reason: null },
    ]);
    expect(result.extension.party[0]).toMatchObject({ currentHp: afflicted.currentHp, status: null });
  });
});

describe("world bag listing", () => {
  test("filters only visibility, slices acquisition order, then sorts each page", () => {
    const member = monster();
    const sw = createSwitchState({
      items: {
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
        app_map: 1,
      },
    });

    const first = listWorldItems(SOURCE_DB, extension(member), sw);
    expect(first).toMatchObject({ page: 0, pageSize: 11, pageCount: 2, totalItems: 12 });
    expect(first.items.map(({ slug }) => slug)).toEqual([
      "imperial_potion",
      "mega_potion",
      "potion",
      "restoration",
      "super_potion",
      "tea",
      "flintstone",
      "raise_hp",
      "repellent",
      "tm_scope",
      "tuxeball",
    ]);
    expect(first.items.find(({ slug }) => slug === "tuxeball")).toMatchObject({
      usable: false,
      reason: "not-usable-in-world",
    });
    expect(first.items.some(({ slug }) => slug === "app_map")).toBeFalse();
    expect(listWorldItems(SOURCE_DB, extension(member), sw, { page: 1 }).items.map(({ slug }) => slug))
      .toEqual(["cureall"]);
  });
});

describe("real-data progression items", () => {
  test("tea delegates level, EXP, stat, and move progression to giveExperience", () => {
    const member = monster("rockitten", {
      level: 5,
      totalExperience: 5 ** 3,
      moves: ["ram", "boulder", "mudslide"],
    });
    const result = useWorldItem(
      SOURCE_DB,
      extension(member),
      createSwitchState({ items: { tea: 1 } }),
      { item: "tea", target: 0 },
    );

    expect(result).toMatchObject({ success: true, consumed: true });
    expect(result.progression).toMatchObject({ awardedExperience: 500, effectiveExperience: 500 });
    expect(result.extension.party[0]!.totalExperience).toBe(625);
    expect(result.extension.party[0]!.level).toBeGreaterThan(5);
  });

  test("an item-specific evolution transfers the snapshot, registers it caught, and advances saved RNG", () => {
    const member = monster("doctsky");
    const sw = createSwitchState({ items: { ox_stick: 1 }, rng: 0x1234_5678 });
    const result = useWorldItem(SOURCE_DB, extension(member), sw, { item: "ox_stick", target: 0 });

    expect(result).toMatchObject({ success: true, consumed: true });
    expect(result.extension.party[0]).toMatchObject({ slug: "askylpaws", iid: member.iid });
    expect(result.extension.caught).toContain("askylpaws");
    expect(result.switches.rng).not.toBe(sw.rng);
  });

  test("TP grants clamp against both imported caps and recalculate base stats", () => {
    const spawned = monster("rockitten", {
      trainingPoints: { armour: 150, dodge: 0, hp: 140, melee: 0, ranged: 0, speed: 0 },
    });
    const before = {
      ...spawned,
      base: calculateBaseStats(
        RULES_DB,
        spawned.slug,
        spawned.level,
        spawned.individualValues,
        spawned.tasteCold,
        spawned.tasteWarm,
        spawned.trainingPoints,
      ),
      currentHp: 5,
    };
    const result = useWorldItem(
      SOURCE_DB,
      extension(before),
      createSwitchState({ items: { raise_hp: 1 } }),
      { item: "raise_hp", target: 0 },
    );
    const updated = result.extension.party[0]!;

    expect(result).toMatchObject({ success: true, consumed: true });
    expect(updated.trainingPoints).toEqual({ armour: 150, dodge: 0, hp: 150, melee: 0, ranged: 0, speed: 0 });
    expect(Object.values(updated.trainingPoints!).reduce((sum, value) => sum + value, 0)).toBe(300);
    expect(updated.base).toEqual(calculateBaseStats(
      RULES_DB,
      updated.slug,
      updated.level,
      updated.individualValues,
      updated.tasteCold,
      updated.tasteWarm,
      updated.trainingPoints,
    ));
    expect(updated.currentHp).toBe(5);
  });

  test("TM target checks honor base tags and has_tech, with a deferred full-moves choice", () => {
    const learner = monster("anoleaf", { moves: ["ram", "boulder", "mudslide", "assault"] });
    const ext = extension(learner);
    const sw = createSwitchState({ items: { tm_leaf_barrage: 1 } });

    expect(worldItemTargetEligibility(SOURCE_DB, ext, sw, "tm_leaf_barrage", 0).eligible).toBeTrue();
    expect(worldItemTargetEligibility(
      SOURCE_DB,
      extension(monster("rockitten", { moves: ["ram"] })),
      sw,
      "tm_leaf_barrage",
      0,
    )).toMatchObject({ eligible: false, reason: "target-ineligible" });

    const pending = useWorldItem(SOURCE_DB, ext, sw, { item: "tm_leaf_barrage", target: 0 });
    expect(pending).toMatchObject({ success: false, consumed: false, reason: "move-choice-required" });
    expect(pending.moveChoice).toEqual({
      targetIndex: 0,
      technique: "leaf_barrage",
      knownMoves: learner.moves,
    });
    expect(pending.switches.items.tm_leaf_barrage).toBe(1);

    const learned = useWorldItem(SOURCE_DB, ext, sw, {
      item: "tm_leaf_barrage",
      target: 0,
      forgetMove: "boulder",
    });
    expect(learned).toMatchObject({ success: true, consumed: true });
    expect(learned.extension.party[0]!.moves).toEqual(["ram", "mudslide", "assault", "leaf_barrage"]);
    expect(worldItemTargetEligibility(
      SOURCE_DB,
      learned.extension,
      createSwitchState({ items: { tm_leaf_barrage: 1 } }),
      "tm_leaf_barrage",
      0,
    )).toMatchObject({ eligible: false, reason: "target-ineligible" });
  });
});

describe("world-owned item effects", () => {
  test("repellent installs one tracker and succeeds without replacing an active tracker", () => {
    const ext = extension(monster());
    const first = useWorldItem(
      SOURCE_DB,
      ext,
      createSwitchState({ items: { repellent: 2 } }),
      { item: "repellent" },
    );
    expect(first).toMatchObject({ success: true, consumed: true });
    expect(first.extension.stepTrackers?.player?.repellent).toEqual({
      countdown: 100,
      initialCountdown: 100,
      milestones: [],
      status: {},
    });

    const existing = first.extension.stepTrackers;
    const second = useWorldItem(SOURCE_DB, first.extension, first.switches, { item: "repellent" });
    expect(second).toMatchObject({ success: true, consumed: true });
    expect(second.extension.stepTrackers).toBe(existing);
    expect(second.switches.items).not.toHaveProperty("repellent");
  });

  test("field tools require context and return typed directives without changing map state", () => {
    const ext = extension(monster());
    const rodSwitches = createSwitchState({ items: { fishing_rod: 1 } });
    const wrongTile = useWorldItem(SOURCE_DB, ext, rodSwitches, { item: "fishing_rod" });
    expect(wrongTile).toMatchObject({ success: false, consumed: false, reason: "wrong-location" });

    const fishingConfig = {
      trigger: 1,
      levelBounds: [5, 15] as const,
      expReqMod: 2,
      stages: ["basic"],
      stageWeights: {},
      shapes: ["polliwog", "piscine"],
      shapeWeights: { polliwog: 0.7, piscine: 0.3 },
      types: [],
      typeWeights: {},
      tags: [],
      tagWeights: {},
      environment: { default: "ocean", night: "night_ocean" },
      failure: "The water ripples, but nothing bites.",
    };
    const fishing = useWorldItem(SOURCE_DB, ext, rodSwitches, {
      item: "fishing_rod",
      context: { facingTile: ["water", "surfable"], fishing: { fishing_rod: fishingConfig } },
    });
    expect(fishing).toMatchObject({ success: true, consumed: false });
    expect(fishing.directives).toHaveLength(1);
    expect(fishing.directives[0]).toMatchObject({
      type: "fishing",
      facingTile: "water",
      experienceModifier: 2,
      environment: "ocean",
    });
    if (fishing.directives[0]?.type !== "fishing") throw new Error("expected fishing directive");
    expect(fishing.directives[0].level).toBeWithin(5, 16);
    expect(["polliwog", "piscine"]).toContain(SOURCE_DB.monsters[fishing.directives[0].species]!.shape);
    expect(fishing.switches.rng).not.toBe(rodSwitches.rng);

    const noBite = useWorldItem(SOURCE_DB, ext, rodSwitches, {
      item: "fishing_rod",
      context: {
        facingTile: "surfable",
        fishing: { fishing_rod: { ...fishingConfig, trigger: 0 } },
      },
    });
    expect(noBite).toMatchObject({ success: false, consumed: false, reason: "no-catch" });
    expect(noBite.message).toBe("The water ripples, but nothing bites.");
    expect(noBite.directives).toEqual([]);
    expect(noBite.switches.rng).not.toBe(rodSwitches.rng);

    const hammer = useWorldItem(
      SOURCE_DB,
      ext,
      createSwitchState({ items: { sledgehammer: 1 } }),
      { item: "sledgehammer", context: { facingSprite: "boulder" } },
    );
    expect(hammer.directives).toEqual([{ type: "remove-facing-entity", facingSprite: "boulder" }]);
  });

  test("escape key resolves the selected persisted faint point before emitting teleport", () => {
    const ext = extension(monster());
    const sw = createSwitchState({ items: { escape_key: 1 } });
    const missing = useWorldItem(SOURCE_DB, ext, sw, { item: "escape_key" });
    expect(missing).toMatchObject({ success: false, consumed: false, reason: "no-faint-point" });

    const withPoint = { ...ext, faintPoints: { healer: { map: "clinic", x: 3, y: 7 } } };
    const escaped = useWorldItem(SOURCE_DB, withPoint, sw, {
      item: "escape_key",
      context: { faintPointCharacter: "healer" },
    });
    expect(escaped).toMatchObject({ success: true, consumed: true });
    expect(escaped.directives).toEqual([
      { type: "teleport", character: "healer", map: "clinic", x: 3, y: 7 },
    ]);
  });
});
