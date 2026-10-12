import { describe, expect, test } from "bun:test";

import battleDb from "../data/battle-db.json";
import { battleDbToTuxemonBattleDb } from "../battle/from-battle-db.ts";
import {
  applyStatus,
  createBattle,
  getMonster,
  makeRules,
  type BattleStart,
  type MonsterSnapshot,
} from "../battle/index.ts";
import { validateBattleDb } from "../importer/battle-schema.ts";
import { combatStats } from "../battle/stats.ts";

// Regular rule tests run through the same GB1 pipeline as the runtime; only
// battle-golden (differential) and battle-db-adapter (field equivalence)
// tests read the oracle JSON directly.
const DB = battleDbToTuxemonBattleDb(validateBattleDb(battleDb));
const BASE = { armour: 10, dodge: 10, hp: 100, melee: 10, ranged: 10, speed: 10 };

// Real, asymmetric base stats for a `nut` L17 / `rockitten` L13 pairing,
// reproduced independently from the pinned Tuxemon oracle. With the shared
// mulberry32 stream seeded to 1899 and `Monster.spawn_base("rockitten", 13)`
// called before `Monster.spawn_base("nut", 17)` (matching this fixture's
// user-then-target construction order), the oracle assigned
// individual_values {armour:0 dodge:2 hp:15 melee:3 ranged:6 speed:11} and
// tastes dry/hearty to rockitten, and {armour:7 dodge:5 hp:13 melee:13
// ranged:2 speed:1} with bland/peppy to nut. Reproduce with:
// reproduce with:
//   TUXEMON_SRC=<tuxemon-checkout> <venv>/bin/python \
//     tools/battle-oracle/probe_scope.py
// which printed target nut L17 AR=199 DE=101 ME=109 RD=194 SD=107 HP=195 and
// attacker rockitten L13 AR=88 DE=146 ME=163 RD=86 SD=151 HP=115. This
// project's own `calculateBaseStats` reproduces the same six values bit for
// bit from those individual_values/tastes (checked ad hoc; not committed as
// a test since it would just restate calculateBaseStats's existing golden
// coverage).
const ROCKITTEN_L13_BASE = { armour: 88, dodge: 146, hp: 115, melee: 163, ranged: 86, speed: 151 };
const NUT_L17_BASE = { armour: 199, dodge: 101, hp: 195, melee: 109, ranged: 194, speed: 107 };

function snapshot(
  slug: string,
  moves: string[],
  types: string[],
  level = 5,
  base = BASE,
): MonsterSnapshot {
  return { slug, level, base, moves, types };
}

function start(player: MonsterSnapshot, enemy: MonsterSnapshot): BattleStart {
  return { seed: 1, player: [player], enemy: [enemy] };
}

describe("main-line technique effects outside the trainer corpus", () => {
  test("status fallback actions omit an absent optional move index", () => {
    const state = createBattle(DB, start(
      snapshot("rockitten", ["struggle"], ["earth"]),
      snapshot("nut", ["beam"], ["metal"]),
    ));
    applyStatus(DB, getMonster(state, 1), "noddingoff", null);

    const action = makeRules(DB).playerAction(state, state.awaiting!.uid, 0);

    expect(action).toMatchObject({ kind: "technique", ref: "empty" });
    expect(Object.hasOwn(action, "moveIndex")).toBe(false);
    expect(JSON.parse(JSON.stringify(action))).toEqual(action);
  });

  test("prop_damage removes a proportion of base HP", () => {
    const state = createBattle(DB, start(
      snapshot("rockitten", ["panjandrum"], ["earth"]),
      snapshot("nut", ["beam"], ["metal"]),
    ));

    makeRules(DB).perform(state, {
      kind: "technique",
      user: 1,
      target: 2,
      ref: "panjandrum",
      moveIndex: 0,
      subPriority: 0,
    });

    expect(getMonster(state, 2).currentHp).toBe(75);
  });

  test("reverse restores both teams to their original elements", () => {
    const state = createBattle(DB, start(
      snapshot("rockitten", ["neutralize"], ["earth"]),
      snapshot("nut", ["beam"], ["metal"]),
    ));
    getMonster(state, 1).types = ["fire"];
    getMonster(state, 2).types = ["water"];

    makeRules(DB).perform(state, {
      kind: "technique",
      user: 1,
      target: 2,
      ref: "neutralize",
      moveIndex: 0,
      subPriority: 0,
    });

    expect(getMonster(state, 1).types).toEqual(["earth"]);
    expect(getMonster(state, 2).types).toEqual(["metal"]);
  });

  test("move_type uses the selected monster's elements for one invocation only", () => {
    const state = createBattle(DB, start(
      snapshot("rockitten", ["external_power"], ["earth"]),
      snapshot("nut", ["beam"], ["fire"]),
    ));

    makeRules(DB).perform(state, {
      kind: "technique",
      user: 1,
      target: 2,
      ref: "external_power",
      moveIndex: 0,
      subPriority: 0,
    });

    expect(getMonster(state, 2).currentHp).toBe(52);
    expect(DB.technique.external_power!.types).toEqual(["normal"]);
  });

  test("life_swap exchanges current HP and respects each recipient's maximum", () => {
    const state = createBattle(DB, start(
      snapshot("rockitten", ["kiss"], ["earth"]),
      snapshot("nut", ["beam"], ["metal"]),
    ));
    getMonster(state, 1).currentHp = 25;
    getMonster(state, 2).currentHp = 80;

    makeRules(DB).perform(state, {
      kind: "technique",
      user: 1,
      target: 2,
      ref: "kiss",
      moveIndex: 0,
      subPriority: 0,
    });

    expect(getMonster(state, 1).currentHp).toBe(80);
    expect(getMonster(state, 2).currentHp).toBe(25);
  });

  test("foresight schedules a delayed copy with its turn-derived power", () => {
    const state = createBattle(DB, start(
      snapshot("rockitten", ["combat_clone"], ["earth"]),
      snapshot("nut", ["beam"], ["metal"]),
    ));

    makeRules(DB).perform(state, {
      kind: "technique",
      user: 1,
      target: 2,
      ref: "combat_clone",
      moveIndex: 0,
      subPriority: 0,
    });

    expect(state.pending).toHaveLength(1);
    expect(state.pending[0]).toMatchObject({
      turn: state.turn + 3,
      action: { kind: "technique", user: 1, target: 2, ref: "combat_clone", techniquePower: 3 },
    });
  });

  type ScopeEvent = {
    type: string;
    success: boolean;
    hit: boolean;
    damage: number;
    scope: { armour: number; dodge: number; melee: number; ranged: number; speed: number } | null;
  };

  function performScope(user: MonsterSnapshot, target: MonsterSnapshot) {
    const state = createBattle(DB, start(user, target));
    makeRules(DB).perform(state, {
      kind: "technique",
      user: 1,
      target: 2,
      ref: "scope",
      moveIndex: 0,
      subPriority: 0,
    });
    return { state, event: state.events.at(-1) as unknown as ScopeEvent };
  }

  test("scope reports the target's base stats, attacker and target distinct, without touching state", () => {
    const { state, event } = performScope(
      snapshot("rockitten", ["scope"], ["earth"], 13, ROCKITTEN_L13_BASE),
      snapshot("nut", ["beam"], ["metal"], 17, NUT_L17_BASE),
    );
    const before = { ...getMonster(state, 2) };

    expect(event.success).toBe(true);
    expect(event.damage).toBe(0);
    // Upstream ScopeEffect never rolls accuracy, so hit keeps its prior
    // (unset) value rather than reflecting the round's hitRoll.
    expect(event.hit).toBe(false);
    // Upstream ScopeEffect (scope.py:40-47) reads target.armour/dodge/melee/
    // ranged/speed directly, which are properties returning `base_stats`
    // (monster.py:350-372, 574-589) with no stage or status modifier
    // applied. Confirmed against the pinned oracle: see the ROCKITTEN_L13_BASE
    // / NUT_L17_BASE comment above for the exact command and output. These
    // five fields must come from the *target* (not the attacker: rockitten's
    // values are all different) and from `target.base` (not
    // `combatStats(target)`, which is identical here since no stage/status is
    // set, but diverges once one is -- see the next test).
    expect(event.scope).toEqual({ armour: 199, dodge: 101, melee: 109, ranged: 194, speed: 107 });
    expect(getMonster(state, 2)).toEqual(before);
  });

  test("scope ignores active stat stages, unlike the battle-current combat stats", () => {
    const state = createBattle(DB, start(
      snapshot("rockitten", ["scope"], ["earth"], 13, ROCKITTEN_L13_BASE),
      snapshot("nut", ["beam"], ["metal"], 17, NUT_L17_BASE),
    ));
    const target = getMonster(state, 2);
    target.stages.armour = 1;
    target.stages.speed = -1;
    // Sanity check: this battle-current readout, from the same helper the
    // rest of the reducer uses for damage/accuracy math, really does move
    // once the stages are set -- 298/…/71, matching the oracle's
    // `target.get_combat_stats()` under the same stages (see the
    // ROCKITTEN_L13_BASE / NUT_L17_BASE probe). If `scope` read this instead
    // of `target.base`, the assertion below would see 298 and 71 rather than
    // the oracle's unmodified 199 and 107.
    expect(combatStats(target)).toEqual({ armour: 298, dodge: 101, hp: 195, melee: 109, ranged: 194, speed: 71 });
    const before = { ...target, stages: { ...target.stages } };

    makeRules(DB).perform(state, {
      kind: "technique",
      user: 1,
      target: 2,
      ref: "scope",
      moveIndex: 0,
      subPriority: 0,
    });

    const event = state.events.at(-1) as unknown as ScopeEvent;
    expect(event.success).toBe(true);
    expect(event.scope).toEqual({ armour: 199, dodge: 101, melee: 109, ranged: 194, speed: 107 });
    expect(getMonster(state, 2)).toEqual(before);
  });
});
