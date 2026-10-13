import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import battleDbJson from "../data/battle-db.json";
import {
  initialTuxemonExtensionState,
  packTuxemonExtensionState,
  tuxemonExtensionState,
  type TuxemonExtensionState,
} from "../battle/extension.ts";
import { battleDbToTuxemonBattleDb } from "../battle/from-battle-db.ts";
import {
  createTuxemonBattleRules,
  tuxemonRuntimeBattleState,
  type RuntimeBattleState,
  type VariableEnums,
} from "../battle/runtime.ts";
import { spawnMonster } from "../battle/spawn.ts";
import { createBattle, reduceBattle } from "../battle/tuxemon.ts";
import type { MonsterSnapshot, Stats } from "../battle/types.ts";
import { validateBattleDb } from "../importer/battle-schema.ts";
import type { JsonValue } from "../vendor/pocket-rpgkit/src/engine/types.ts";

const ROOT = join(import.meta.dir, "..");
const DB = validateBattleDb(battleDbJson);
const RULE_DB = battleDbToTuxemonBattleDb(DB);
const BASE: Stats = { armour: 10, dodge: 10, hp: 100, melee: 10, ranged: 10, speed: 10 };
const ENUMS: VariableEnums = {
  battle_last_result: ["draw", "lost", "won", "run", "captured"],
  battle_last_trainer: ["test_trainer"],
  battle_last_winner: ["player", "test_trainer"],
  battle_last_loser: ["player", "test_trainer"],
};

function snapshot(
  iid: string,
  slug: string,
  plagues: MonsterSnapshot["plagues"] = {},
): MonsterSnapshot {
  return { iid, slug, level: 5, base: BASE, moves: ["ram"], plagues };
}

function playerExtension(): TuxemonExtensionState {
  const rng = { rng: 1, rngDraws: 0 };
  const player = spawnMonster(DB, RULE_DB, rng, "rockitten", 5, { iid: "player-1" });
  player.moves = ["ram"];
  return {
    ...initialTuxemonExtensionState(),
    party: [player],
    environment: "grass",
    nextMonsterId: 3,
    plagueByIid: { "player-1": { spyderbite: "infected" } },
    npcParties: {
      test_trainer: [{
        iid: "npc-1",
        slug: "nut",
        level: 5,
        experienceModifier: 1,
        moneyModifier: 0,
      }],
    },
  };
}

function context(ext: TuxemonExtensionState) {
  const value = packTuxemonExtensionState(ext);
  return {
    ext: value,
    switches: {},
    variables: {},
    items: {},
    gold: 0,
    playerName: "Player",
  } as const;
}

function forceCompleted(state: RuntimeBattleState): JsonValue {
  state.battle.phase = "ended";
  state.battle.outcome = "won";
  state.battle.awaiting = null;
  state.battle.result = {
    outcome: "won",
    playerDefeated: false,
    battleLastResult: state.battle.capturedUid === null ? "won" : "captured",
    gold: 0,
    prize: 0,
  };
  state.eventCursor = state.battle.events.length;
  return state as unknown as JsonValue;
}

describe("imported plague battle rules", () => {
  test("imports the real spyderbite profile, technique, and bilingual names", () => {
    expect(DB.plagues.spyderbite).toMatchObject({
      spreadness: 0.125,
      carrierSpreadness: null,
      typeWeights: {},
      shapeWeights: {},
      resistanceModifiers: { types: {}, shapes: {}, statuses: {} },
      messages: {
        spreadSuccess: "combat_state_plague2",
        targetResists: "combat_state_plague3",
        minorEffect: "combat_state_plague1",
        targetInfected: "combat_state_plague4",
      },
    });
    expect(DB.techniques.spyderbite.effects).toEqual([
      { type: "plague", parameters: ["spyderbite"] },
    ]);
    const en = JSON.parse(readFileSync(join(ROOT, "data/battle-names.json"), "utf8"));
    const zh = JSON.parse(readFileSync(join(ROOT, "data/battle-names.zh_CN.json"), "utf8"));
    expect(en.techniques.spyderbite).toBe("Spyder Bite");
    expect(zh.techniques.spyderbite).toBe("斯皮德咬合");
  });

  test("a successful upstream pre-check infects and substitutes the same-named technique", () => {
    const before = createBattle(RULE_DB, {
      seed: 5,
      player: [snapshot("player-1", "rockitten", { spyderbite: "infected" })],
      enemy: [snapshot("npc-1", "nut")],
    });
    const after = reduceBattle(RULE_DB, before, { type: "technique", choice: 0 });
    const decision = after.events.find((event) => event.type === "decision" && event.user === 1);
    const performed = after.events.find((event) => event.type === "technique" && event.user === 1);

    expect(decision?.technique).toBe("spyderbite");
    expect(performed).toMatchObject({
      technique: "spyderbite",
      success: false,
      damage: 0,
      plague: { slug: "spyderbite", phase: "infected" },
    });
    expect(after.parties[1][0]!.plagues).toEqual({ spyderbite: "infected" });
    // Upstream invokes the replacement once to decide whether to substitute,
    // then performs it again. The second call sees `already_has`, hence false.
    expect(before.parties[1][0]!.plagues).toEqual({});
  });

  test("a resisted or inoculated target keeps the originally selected move", () => {
    for (const [seed, targetPlagues] of [
      [1, {}],
      [5, { spyderbite: "inoculated" }],
    ] as const) {
      const before = createBattle(RULE_DB, {
        seed,
        player: [snapshot("player-1", "rockitten", { spyderbite: "infected" })],
        enemy: [snapshot("npc-1", "nut", targetPlagues)],
      });
      const after = reduceBattle(RULE_DB, before, { type: "technique", choice: 0 });
      const decision = after.events.find((event) => event.type === "decision" && event.user === 1);
      expect(decision?.technique).toBe("ram");
      expect(after.parties[1][0]!.plagues).toEqual(targetPlagues);
    }
  });
});

describe("plague state at the Battle Processing boundary", () => {
  test("projects saved infection into combat and packages the replacement presentation", () => {
    const rules = createTuxemonBattleRules(DB, ENUMS);
    const ext = playerExtension();
    const started = rules.start(packTuxemonExtensionState(ext), {
      kind: "trainer",
      opponent: "test_trainer",
      environment: "grass",
    }, 5, context(ext));
    expect(started).not.toBeNull();
    const state = tuxemonRuntimeBattleState(started!.state);
    expect(state.battle.parties[0][0]!.plagues).toEqual({ spyderbite: "infected" });
    expect(state.visuals.techniques.spyderbite).toMatchObject({ range: "special" });
  });

  test("writes newly infected player and NPC monsters back to the existing save table", () => {
    const rules = createTuxemonBattleRules(DB, ENUMS);
    const ext = playerExtension();
    const started = rules.start(packTuxemonExtensionState(ext), {
      kind: "trainer",
      opponent: "test_trainer",
      environment: "grass",
    }, 5, context(ext));
    expect(started).not.toBeNull();
    const state = tuxemonRuntimeBattleState(started!.state);
    state.battle.parties[1][0]!.plagues.spyderbite = "infected";
    const completion = rules.done(forceCompleted(state));
    expect(completion).not.toBeNull();
    const saved = tuxemonExtensionState(completion!.ext, DB);
    expect(saved.plagueByIid).toMatchObject({
      "player-1": { spyderbite: "infected" },
      "npc-1": { spyderbite: "infected" },
    });
  });

  test("assigns an infected captured monster's new iid before saving its plague", () => {
    const rules = createTuxemonBattleRules(DB, ENUMS);
    const ext = playerExtension();
    const started = rules.start(packTuxemonExtensionState(ext), {
      kind: "wild",
      species: "nut",
      level: 5,
      environment: "grass",
    }, 5, context(ext));
    expect(started).not.toBeNull();
    const state = tuxemonRuntimeBattleState(started!.state);
    const captured = state.battle.parties[1][0]!;
    captured.plagues.spyderbite = "infected";
    state.battle.capturedUid = captured.uid;
    const completion = rules.done(forceCompleted(state));
    expect(completion).not.toBeNull();
    const saved = tuxemonExtensionState(completion!.ext, DB);
    const added = saved.party.find((monster) => monster.iid !== "player-1")!;
    expect(added.iid).toBe("txmn-000003");
    expect(saved.plagueByIid[added.iid!]).toEqual({ spyderbite: "infected" });
  });
});
