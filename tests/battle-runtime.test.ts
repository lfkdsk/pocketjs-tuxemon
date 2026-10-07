import { describe, expect, test } from "bun:test";
import battleDbJson from "../data/battle-db.json";

import { nextRandom, type RngState } from "../battle/core.ts";
import {
  createTuxemonExtensions,
  initialTuxemonExtensionState,
  PARTY_LIMIT,
  tuxemonExtensionState,
  type TuxemonExtensionState,
} from "../battle/extension.ts";
import { battleDbToTuxemonBattleDb } from "../battle/from-battle-db.ts";
import {
  BATTLE_EVENT_TICKS,
  createTuxemonBattleRules,
  tuxemonRuntimeBattleState,
  type RuntimeBattleState,
  type VariableEnums,
} from "../battle/runtime.ts";
import { spawnMonster } from "../battle/spawn.ts";
import { createBattle, getSide, reduceBattle } from "../battle/tuxemon.ts";
import type { SpawnedMonsterSnapshot, Stats } from "../battle/types.ts";
import { validateBattleDb } from "../importer/battle-schema.ts";
import type { BattleCompletion, BattleRules } from "../vendor/pocket-rpgkit/src/engine/battle.ts";
import type { JsonValue } from "../vendor/pocket-rpgkit/src/engine/types.ts";

const DB = validateBattleDb(battleDbJson);
const RULE_DB = battleDbToTuxemonBattleDb(DB);
const OPPONENT = "test_trainer";
const ENUMS: VariableEnums = {
  battle_last_result: ["draw", "lost", "won", "run", "captured"],
  battle_last_trainer: [OPPONENT],
  battle_last_winner: ["player", OPPONENT],
  battle_last_loser: ["player", OPPONENT],
};

function monster(
  slug: string,
  level: number,
  iid: string,
  seed = 1,
  options: { experienceModifier?: number; moneyModifier?: number } = {},
): SpawnedMonsterSnapshot {
  return spawnMonster(DB, RULE_DB, { rng: seed >>> 0, rngDraws: 0 }, slug, level, {
    iid,
    ...options,
  });
}

// A spawned snapshot with its combat stats, HP and moveset overridden —
// monsterFromSnapshot reads those fields verbatim, so this pins a matchup
// (who outspeeds, who KOs whom) without touching the database.
function crafted(
  slug: string,
  level: number,
  iid: string,
  seed: number,
  overrides: {
    base?: Partial<Stats>;
    currentHp?: number;
    moves?: string[];
    moneyModifier?: number;
  } = {},
): SpawnedMonsterSnapshot {
  const snapshot = monster(slug, level, iid, seed);
  const base = { ...snapshot.base, ...overrides.base };
  return {
    ...snapshot,
    base,
    currentHp: overrides.currentHp ?? base.hp,
    ...(overrides.moves ? { moves: overrides.moves } : {}),
    ...(overrides.moneyModifier !== undefined ? { moneyModifier: overrides.moneyModifier } : {}),
  };
}

function extensionWith(player: SpawnedMonsterSnapshot): TuxemonExtensionState {
  return { ...initialTuxemonExtensionState(), party: [player], environment: "grass", nextMonsterId: 2 };
}

function revealCurrentMenu(rules: BattleRules, value: JsonValue): JsonValue {
  for (let guard = 0; guard < 1_000; guard++) {
    const state = tuxemonRuntimeBattleState(value);
    if (state.eventCursor >= state.battle.events.length) return value;
    value = rules.step(value, { buttons: 0, confirmEdge: true }, BATTLE_EVENT_TICKS);
  }
  throw new Error("battle presentation did not reach its menu");
}

function json(value: unknown): JsonValue {
  return value as JsonValue;
}

function startBattle(
  rules: BattleRules,
  ext: TuxemonExtensionState,
  setup: JsonValue,
  seed: number,
  items: Readonly<Record<string, number>> = {},
  gold = 0,
): ReturnType<BattleRules["start"]> {
  const extValue = json(ext);
  return rules.start(extValue, setup, seed, {
    ext: extValue,
    switches: {},
    variables: {},
    items,
    gold,
    playerName: "Player",
  });
}

function finish(
  rules: BattleRules,
  started: NonNullable<ReturnType<BattleRules["start"]>>,
  ticks = 15,
): { state: RuntimeBattleState; completion: BattleCompletion } {
  let value = started.state;
  for (let guard = 0; guard < 10_000; guard++) {
    let state = tuxemonRuntimeBattleState(value);
    if (state.eventCursor < state.battle.events.length) {
      value = rules.step(value, { buttons: 0 }, ticks);
    } else if (state.battle.awaiting) {
      value = rules.step(value, { buttons: 0, confirmEdge: true }, ticks);
    } else {
      const completion = rules.done(value);
      if (completion) return { state, completion };
      value = rules.step(value, { buttons: 0 }, ticks);
    }
    state = tuxemonRuntimeBattleState(value);
    const completion = rules.done(value);
    if (completion) return { state, completion };
  }
  throw new Error("runtime battle did not finish");
}

// Drives a runtime battle to completion, choosing a technique from the
// technique submenu each turn (finish() only ever confirms the default).
// `pick` selects the technique slug for the current turn.
function finishWithTechnique(
  rules: BattleRules,
  started: NonNullable<ReturnType<BattleRules["start"]>>,
  pick: (state: RuntimeBattleState) => string,
  ticks = 15,
): { state: RuntimeBattleState; completion: BattleCompletion } {
  let value = started.state;
  for (let guard = 0; guard < 10_000; guard++) {
    const state = tuxemonRuntimeBattleState(value);
    if (state.eventCursor < state.battle.events.length) {
      value = rules.step(value, { buttons: 0 }, ticks);
    } else if (state.battle.awaiting) {
      if (state.menuMode === "technique") {
        const slug = pick(state);
        const index = state.menu.findIndex((entry) => entry.slug === slug && entry.available);
        if (index < 0) throw new Error(`battle test: technique '${slug}' is not on the menu`);
        state.menuIndex = index;
      }
      value = rules.step(value, { buttons: 0, confirmEdge: true }, ticks);
    } else {
      const completion = rules.done(value);
      if (completion) return { state, completion };
      value = rules.step(value, { buttons: 0 }, ticks);
    }
    const completion = rules.done(value);
    if (completion) return { state: tuxemonRuntimeBattleState(value), completion };
  }
  throw new Error("runtime battle did not finish");
}

describe("Tuxemon BattleRules adapter", () => {
  test("reuses an immutable provider and its lazy rule caches across battles", () => {
    let loads = 0;
    const rules = createTuxemonBattleRules({
      load() {
        loads++;
        return DB;
      },
    }, ENUMS);
    const ext = extensionWith(monster("nut", 20, "txmn-player", 30));
    const setup = json({
      kind: "wild",
      species: "budaye",
      level: 5,
      environment: "grass",
    });

    expect(startBattle(rules, ext, setup, 31)).not.toBeNull();
    expect(startBattle(rules, ext, setup, 32)).not.toBeNull();
    expect(loads).toBe(1);
  });

  test("keeps the upstream trainer and wild root-menu profiles with explicit availability", () => {
    const rules = createTuxemonBattleRules(DB, ENUMS);
    const active = monster("nut", 20, "txmn-player-a", 31);
    active.currentHp = active.currentHp! - 1;
    const trainerExt = extensionWith(active);
    trainerExt.party.push(monster("rockitten", 20, "txmn-player-b", 32));

    const trainer = tuxemonRuntimeBattleState(revealCurrentMenu(rules, startBattle(rules, trainerExt, json({
      kind: "trainer",
      opponent: OPPONENT,
      party: [{ species: "budaye", level: 5 }],
      environment: "grass",
    }), 616, { potion: 1 })!.state));
    expect(trainer.menu.map(({ kind, slug, available }) => ({ kind, slug, available }))).toEqual([
      { kind: "fight", slug: "fight", available: true },
      { kind: "replacement", slug: "swap", available: true },
      { kind: "item", slug: "item", available: true },
      { kind: "forfeit", slug: "forfeit", available: false },
    ]);

    const wild = tuxemonRuntimeBattleState(revealCurrentMenu(rules, startBattle(
      rules,
      extensionWith(monster("nut", 20, "txmn-player", 33)),
      json({ kind: "wild", species: "budaye", level: 5, environment: "grass" }),
      717,
    )!.state));
    expect(wild.menu.map(({ kind, slug, available }) => ({ kind, slug, available }))).toEqual([
      { kind: "fight", slug: "fight", available: true },
      { kind: "replacement", slug: "swap", available: false },
      { kind: "item", slug: "item", available: false },
      { kind: "capture", slug: "capture", available: false },
      { kind: "run", slug: "run", available: true },
    ]);

    let value = rules.step(json(wild), { buttons: 0, downEdge: true }, 0);
    expect(tuxemonRuntimeBattleState(value).menuIndex).toBe(4);
    value = rules.step(value, { buttons: 0, downEdge: true }, 0);
    expect(tuxemonRuntimeBattleState(value).menuIndex).toBe(0);
    value = rules.step(value, { buttons: 0, upEdge: true }, 0);
    expect(tuxemonRuntimeBattleState(value).menuIndex).toBe(4);
  });

  test("ignores confirm on a disabled root-menu entry reached by deserialized state", () => {
    const rules = createTuxemonBattleRules(DB, ENUMS);
    const active = monster("nut", 20, "txmn-player-a", 31);
    active.currentHp = active.currentHp! - 1;
    const trainerExt = extensionWith(active);
    trainerExt.party.push(monster("rockitten", 20, "txmn-player-b", 32));

    // The in-game cursor can never rest on a disabled entry, but a stale or
    // tampered serialized state can still point its menuIndex at one.
    const trainer = tuxemonRuntimeBattleState(revealCurrentMenu(rules, startBattle(rules, trainerExt, json({
      kind: "trainer",
      opponent: OPPONENT,
      party: [{ species: "budaye", level: 5 }],
      environment: "grass",
    }), 616, { potion: 1 })!.state));
    expect(trainer.menu[3]).toEqual({ kind: "forfeit", slug: "forfeit", cooldown: 0, available: false });
    trainer.menuIndex = 3;
    const staleTrainer = json(trainer);
    expect(rules.step(staleTrainer, { buttons: 0, confirmEdge: true }, 0)).toEqual(staleTrainer);

    const wild = tuxemonRuntimeBattleState(revealCurrentMenu(rules, startBattle(
      rules,
      extensionWith(monster("nut", 20, "txmn-player", 33)),
      json({ kind: "wild", species: "budaye", level: 5, environment: "grass" }),
      717,
    )!.state));
    expect(wild.menu[1]).toEqual({ kind: "replacement", slug: "swap", cooldown: 0, available: false });
    wild.menuIndex = 1;
    const staleWild = json(wild);
    expect(rules.step(staleWild, { buttons: 0, confirmEdge: true }, 0)).toEqual(staleWild);
  });

  test("wins a trainer battle, keeps its staged party, and writes persistent rewards", () => {
    const ext = extensionWith(monster("nut", 50, "txmn-player", 91));
    ext.npcParties[OPPONENT] = [{
      iid: "txmn-enemy",
      slug: "budaye",
      level: 2,
      experienceModifier: 5,
      moneyModifier: 10,
    }];
    const rules = createTuxemonBattleRules(DB, ENUMS);
    const started = startBattle(rules, ext, json({
      kind: "trainer",
      opponent: OPPONENT,
      environment: "grass",
    }), 101, {}, 100);
    expect(started).not.toBeNull();
    // Upstream keeps the NPC's party after the battle so get_party_monster /
    // remove_monster can still address it; the staged monsters persist.
    expect(tuxemonExtensionState(started!.ext, DB).npcParties[OPPONENT]).toEqual([{
      iid: "txmn-enemy",
      slug: "budaye",
      level: 2,
      experienceModifier: 5,
      moneyModifier: 10,
    }]);

    const presentation = tuxemonRuntimeBattleState(started!.state).visuals;
    expect(presentation.environment).toEqual(DB.environments.grass);
    expect(presentation.ui).toEqual({ hpBar: DB.ui.hpBar, expBar: DB.ui.expBar });
    expect(presentation.trainers.player).toEqual(DB.ui.trainerSheets.adventurer);
    expect(presentation.trainers.opponent).toBeNull();
    expect(presentation.monsters.nut).toEqual(DB.monsters.nut.art);
    expect(presentation.statusIcons.burn).toEqual(DB.statuses.burn.icon);
    for (const fighter of tuxemonRuntimeBattleState(started!.state).battle.parties.flat()) {
      for (const technique of [fighter.fallback, ...fighter.moves.map((move) => move.slug)]) {
        expect(presentation.techniques[technique], technique).toBeDefined();
      }
    }

    const before = ext.party[0]!;
    const { state, completion } = finish(rules, started!);
    const persisted = tuxemonExtensionState(completion.ext, DB);
    const after = persisted.party[0]!;
    const finishedMonster = state.battle.parties[0][0]!;
    expect(completion.result).toBe("win");
    expect(finishedMonster.iid).toBe("txmn-player");
    expect(after.currentHp).toBe(finishedMonster.currentHp);
    expect(after.totalExperience!).toBeGreaterThan(before.totalExperience!);
    expect(after.trainingPoints).toEqual(finishedMonster.trainingPoints);
    expect(after.bond).toBe(finishedMonster.bond);
    expect(after.level).toBe(finishedMonster.level);
    expect(after.base).toEqual(finishedMonster.base);
    expect(after.stage).toBe(finishedMonster.stage);
    expect(after.acquisition).toBe(finishedMonster.acquisition);
    expect(after.captureDevice).toBe(finishedMonster.captureDevice);
    expect(after.waitingToEvolve).toBe(finishedMonster.waitingToEvolve);
    expect(state.presentationRewards).toEqual([
      expect.objectContaining({
        eventIndex: expect.any(Number),
        loser: expect.any(Number),
        winners: [expect.objectContaining({
          uid: finishedMonster.uid,
          before: expect.objectContaining({
            level: before.level,
            totalExperience: before.totalExperience,
            maxHp: before.base.hp,
          }),
          after: expect.objectContaining({
            level: finishedMonster.level,
            totalExperience: finishedMonster.totalExperience,
            maxHp: finishedMonster.base.hp,
          }),
        })],
      }),
    ]);
    expect(persisted.history).toEqual([
      { fighter: "player", opponent: OPPONENT, outcome: "won" },
      { fighter: OPPONENT, opponent: "player", outcome: "lost" },
    ]);
    expect(persisted).not.toHaveProperty("money");
    expect(persisted).not.toHaveProperty("inventory");
    expect(completion.items).toEqual({});
    expect(completion.gold).toBe(120);
    expect(completion.writes).toEqual({
      "v.battle_last_result": 3,
      "v.battle_last_trainer": 1,
      [`boc.${OPPONENT}.won`]: 1,
      "v.battle_last_winner": 1,
      "v.battle_last_loser": 2,
    });
    expect(completion.switches).toEqual({
      [`bo.${OPPONENT}.won`]: true,
      [`defeated.${OPPONENT}`]: true,
    });
  });

  test("trainer-battle winnings pay down shareRate bills before reaching the wallet", () => {
    const ext = extensionWith(monster("nut", 50, "txmn-player", 91));
    ext.npcParties[OPPONENT] = [{
      iid: "txmn-enemy",
      slug: "budaye",
      level: 2,
      experienceModifier: 5,
      moneyModifier: 10,
    }];
    ext.bills.player = {
      bill_a: { amount: 500, shareRate: 0.5 },
      bill_b: { amount: 500, shareRate: 0.5 },
    };
    const rules = createTuxemonBattleRules(DB, ENUMS);
    const started = startBattle(rules, ext, json({
      kind: "trainer",
      opponent: OPPONENT,
      environment: "grass",
    }), 101, {}, 100);
    const { completion } = finish(rules, started!);
    // Prize = trunc(level 2 * moneyModifier 10) = 20. Bill A takes
    // trunc(20 * 0.5) = 10 (490 left); bill B cascades on the remainder:
    // trunc(10 * 0.5) = 5 (495 left). The wallet gets the remainder.
    const persisted = tuxemonExtensionState(completion.ext, DB);
    expect(persisted.bills.player!.bill_a!.amount).toBe(490);
    expect(persisted.bills.player!.bill_b!.amount).toBe(495);
    expect(completion.gold).toBe(105);
  });

  test("a battle share that exceeds the bill deletes it without refunding the excess", () => {
    const ext = extensionWith(monster("nut", 50, "txmn-player", 91));
    ext.npcParties[OPPONENT] = [{
      iid: "txmn-enemy",
      slug: "budaye",
      level: 2,
      experienceModifier: 5,
      moneyModifier: 10,
    }];
    ext.bills.player = { small: { amount: 5, shareRate: 0.5 } };
    const rules = createTuxemonBattleRules(DB, ENUMS);
    const started = startBattle(rules, ext, json({
      kind: "trainer",
      opponent: OPPONENT,
      environment: "grass",
    }), 101, {}, 100);
    const { completion } = finish(rules, started!);
    // deduction = trunc(20 * 0.5) = 10 > 5: the bill is deleted and the
    // extra 5 is not refunded (upstream MoneyManager.apply_all_battle_shares).
    const persisted = tuxemonExtensionState(completion.ext, DB);
    expect(persisted.bills.player!.small).toBeUndefined();
    expect(completion.gold).toBe(110);
  });

  // The five money-shape cases below pin the two upstream revenue streams
  // against each other. Upstream keeps them apart: the money technique calls
  // modify_money directly (core/effects/money.py:68-72), so its gold lands in
  // the wallet mid-battle for every outcome; _handle_win applies bill shares
  // to the prize alone and only for a player trainer win
  // (tuxemon/combat/utils.py:222-224). completionFor mirrors that split:
  // moveGold goes straight to the wallet, the prize is shared first, and
  // wild battles, losses and draws carry no prize so their bills are untouched.
  test("a wild battle's move gold reaches the wallet without touching bills", () => {
    const ext = extensionWith(crafted("nut", 50, "txmn-player", 2, {
      moves: ["gold_digger", "bubble_trap"],
    }));
    ext.bills.player = { bill_x: { amount: 500, shareRate: 0.5 } };
    const rules = createTuxemonBattleRules(DB, ENUMS);
    const started = startBattle(rules, ext, json({
      kind: "wild",
      species: "budaye",
      level: 2,
      environment: "grass",
    }), 2, {}, 100);
    // gold_digger (money effect) deals no damage; one hit banks its
    // calculated damage as move gold, then bubble_trap wins the battle.
    const { state, completion } = finishWithTechnique(rules, started!, (s) =>
      s.battle.turn <= 1 ? "gold_digger" : "bubble_trap");
    expect(state.battle.result?.outcome).toBe("won");
    expect(state.battle.techniqueGold).toBe(211);
    expect(state.battle.result?.prize).toBe(0);
    // wallet = startingGold + moveGold; a wild battle has no prize to share.
    expect(completion.gold).toBe(311);
    const persisted = tuxemonExtensionState(completion.ext, DB);
    expect(persisted.bills.player!.bill_x!.amount).toBe(500);
  });

  test("a trainer loss banks move gold without a prize or a bill share", () => {
    // The player outspeeds and lands one gold_digger (5 move gold), then the
    // enemy's stick KOs the 1-HP player. A loss pays no prize and shares
    // nothing, so the wallet keeps the move gold and the bill is untouched.
    const ext = extensionWith(crafted("nut", 50, "txmn-player", 1, {
      base: { hp: 1, speed: 999, melee: 6, armour: 10 },
      currentHp: 1,
      moves: ["gold_digger"],
    }));
    ext.npcParties[OPPONENT] = [{
      iid: "txmn-enemy",
      slug: "budaye",
      level: 2,
      experienceModifier: 1,
      moneyModifier: 10,
    }];
    ext.bills.player = { bill_x: { amount: 500, shareRate: 0.5 } };
    const rules = createTuxemonBattleRules(DB, ENUMS);
    const started = startBattle(rules, ext, json({
      kind: "trainer",
      opponent: OPPONENT,
      environment: "grass",
    }), 1, {}, 100);
    const { state, completion } = finishWithTechnique(rules, started!, () => "gold_digger");
    expect(state.battle.result?.outcome).toBe("lost");
    expect(state.battle.techniqueGold).toBe(5);
    expect(state.battle.result?.prize).toBe(0);
    expect(completion.gold).toBe(105);
    const persisted = tuxemonExtensionState(completion.ext, DB);
    expect(persisted.bills.player!.bill_x!.amount).toBe(500);
  });

  test("a trainer draw banks move gold without a prize or a bill share", () => {
    // The player lands one gold_digger (5 move gold), then on turn 2 uses
    // undertaker (sacrifice): it KOs the enemy and the user at once, so both
    // sides faint in the same action and the core calls it a draw. A draw is
    // player-defeating, pays no prize and shares nothing.
    const ext = extensionWith(crafted("nut", 50, "txmn-player", 1, {
      base: { hp: 100, speed: 999, melee: 6, armour: 999, dodge: 999 },
      moves: ["gold_digger", "undertaker"],
    }));
    ext.npcParties[OPPONENT] = [{
      iid: "txmn-enemy",
      slug: "budaye",
      level: 2,
      experienceModifier: 1,
      moneyModifier: 10,
    }];
    ext.bills.player = { bill_x: { amount: 500, shareRate: 0.5 } };
    const rules = createTuxemonBattleRules(DB, ENUMS);
    const started = startBattle(rules, ext, json({
      kind: "trainer",
      opponent: OPPONENT,
      environment: "grass",
    }), 1, {}, 100);
    const { state, completion } = finishWithTechnique(rules, started!, (s) =>
      s.battle.turn <= 1 ? "gold_digger" : "undertaker");
    expect(state.battle.result?.outcome).toBe("draw");
    expect(state.battle.techniqueGold).toBe(5);
    expect(state.battle.result?.prize).toBe(0);
    expect(completion.gold).toBe(105);
    const persisted = tuxemonExtensionState(completion.ext, DB);
    expect(persisted.bills.player!.bill_x!.amount).toBe(500);
  });

  test("a trainer win with a zero prize banks the move gold in full", () => {
    // moneyModifier 0 makes the prize 0, so the only revenue is the move
    // gold. With no prize there is nothing to share; the wallet gets all of it.
    const ext = extensionWith(crafted("nut", 50, "txmn-player", 2, {
      moves: ["gold_digger", "bubble_trap"],
    }));
    ext.npcParties[OPPONENT] = [{
      iid: "txmn-enemy",
      slug: "budaye",
      level: 2,
      experienceModifier: 1,
      moneyModifier: 0,
    }];
    const rules = createTuxemonBattleRules(DB, ENUMS);
    const started = startBattle(rules, ext, json({
      kind: "trainer",
      opponent: OPPONENT,
      environment: "grass",
    }), 2, {}, 100);
    const { state, completion } = finishWithTechnique(rules, started!, (s) =>
      s.battle.turn <= 1 ? "gold_digger" : "bubble_trap");
    expect(state.battle.result?.outcome).toBe("won");
    expect(state.battle.techniqueGold).toBe(211);
    expect(state.battle.result?.prize).toBe(0);
    expect(completion.gold).toBe(311);
  });

  test("a trainer win shares only the prize with bills, never the move gold", () => {
    // The player lands one gold_digger (211 move gold) and wins a 20 prize
    // (trunc(level 2 * moneyModifier 10)). Upstream shares the prize alone:
    // bill_a takes trunc(20 * 0.5) = 10 (490 left), bill_b cascades on the
    // remainder for trunc(10 * 0.5) = 5 (495 left). The wallet gets the move
    // gold plus the 5 the bills did not take: 100 + 211 + 5 = 316.
    const ext = extensionWith(crafted("nut", 50, "txmn-player", 2, {
      moves: ["gold_digger", "bubble_trap"],
    }));
    ext.npcParties[OPPONENT] = [{
      iid: "txmn-enemy",
      slug: "budaye",
      level: 2,
      experienceModifier: 1,
      moneyModifier: 10,
    }];
    ext.bills.player = {
      bill_a: { amount: 500, shareRate: 0.5 },
      bill_b: { amount: 500, shareRate: 0.5 },
    };
    const rules = createTuxemonBattleRules(DB, ENUMS);
    const started = startBattle(rules, ext, json({
      kind: "trainer",
      opponent: OPPONENT,
      environment: "grass",
    }), 2, {}, 100);
    const { state, completion } = finishWithTechnique(rules, started!, (s) =>
      s.battle.turn <= 1 ? "gold_digger" : "bubble_trap");
    expect(state.battle.result?.outcome).toBe("won");
    expect(state.battle.techniqueGold).toBe(211);
    expect(state.battle.result?.prize).toBe(20);
    const persisted = tuxemonExtensionState(completion.ext, DB);
    expect(persisted.bills.player!.bill_a!.amount).toBe(490);
    expect(persisted.bills.player!.bill_b!.amount).toBe(495);
    expect(completion.gold).toBe(316);
  });

  test("the Nimrod Zircon Back flow: a folded trainer party persists so get_party_monster writes its iid and remove_monster deletes it", () => {
    // Real Talk Argon setup from the imported spyder_nimrod_middle map:
    // add_monster chrome_robo,30 folded into the battle setup.party.
    const ext = extensionWith(monster("nut", 50, "txmn-player", 91));
    const rules = createTuxemonBattleRules(DB, ENUMS);
    const started = startBattle(rules, ext, json({
      kind: "trainer",
      opponent: "spyder_nimrod_argon",
      party: [{ species: "chrome_robo", level: 30, experienceModifier: 5, moneyModifier: 10 }],
      environment: "grass",
    }), 101, {}, 100);
    expect(started).not.toBeNull();
    const afterBattle = tuxemonExtensionState(started!.ext, DB);
    // The folded chrome_robo persists in argon's NPC party with a real iid,
    // matching upstream where the NPC keeps its monsters after the battle.
    expect(afterBattle.npcParties.spyder_nimrod_argon).toEqual([{
      iid: expect.any(String),
      slug: "chrome_robo",
      level: 30,
      experienceModifier: 5,
      moneyModifier: 10,
    }]);
    const iid = afterBattle.npcParties.spyder_nimrod_argon![0]!.iid;

    // Zircon Back: get_party_monsters writes the iid, remove_monster deletes it.
    const extensions = createTuxemonExtensions(DB);
    const commandContext = (extValue: JsonValue, variables: Record<string, string | number> = {}) => ({
      ext: extValue,
      variables,
      switches: {},
      items: {},
      gold: 0,
      playerName: "Player",
      random: () => 0,
    });
    const getParty = extensions.commands!["tux.get_party_monsters"]!;
    const written = getParty(commandContext(started!.ext), { character: "spyder_nimrod_argon" });
    expect(written?.writes).toEqual({ "v.iid_slot_0": iid });

    const remove = extensions.commands!["tux.remove_monster"]!;
    const removed = remove(commandContext(started!.ext, { "v.iid_slot_0": iid }), { variable: "v.iid_slot_0" });
    expect(removed).not.toBeUndefined();
    const afterRemoval = tuxemonExtensionState(removed!.ext!, DB);
    expect(afterRemoval.npcParties.spyder_nimrod_argon).toEqual([]);
  });

  test("a trainer's party lasts for the NPC's lifetime and is cleared with it", () => {
    // Within one NPC lifetime upstream add_monster appends to the NPC's
    // party (capped at PARTY_LIMIT). The importer clears the party when the
    // NPC is created afresh on a later map visit, or removed, so the next
    // battle uses only that visit's monsters.
    const ext = extensionWith(monster("nut", 50, "txmn-player", 91));
    const rules = createTuxemonBattleRules(DB, ENUMS);
    const party = (species: string) => ({ species, level: 25, experienceModifier: 5, moneyModifier: 10 });
    const setup = json({
      kind: "trainer", opponent: OPPONENT,
      party: [party("nut"), party("budaye"), party("nut"), party("budaye")],
    });
    const first = startBattle(rules, ext, setup, 101, {}, 100);
    expect(first).not.toBeNull();
    const afterFirst = tuxemonExtensionState(first!.ext, DB);
    expect(afterFirst.npcParties[OPPONENT]).toHaveLength(4);

    const sameVisit = startBattle(rules, afterFirst, setup, 102, {}, 100);
    expect(tuxemonExtensionState(sameVisit!.ext, DB).npcParties[OPPONENT]).toHaveLength(PARTY_LIMIT);

    const clear = createTuxemonExtensions(DB).commands!["tux.clear_npc_party"]!;
    const cleared = clear({
      ext: json(afterFirst),
      variables: {},
      switches: {},
      items: {},
      gold: 0,
      playerName: "Player",
      random: () => 0,
    }, { character: OPPONENT });
    const afterClear = tuxemonExtensionState(cleared!.ext!, DB);
    expect(afterClear.npcParties[OPPONENT]).toBeUndefined();
    const nextVisit = startBattle(rules, afterClear, setup, 103, {}, 100);
    expect(tuxemonRuntimeBattleState(nextVisit!.state).battle.parties[1]).toHaveLength(4);
    expect(tuxemonExtensionState(nextVisit!.ext, DB).npcParties[OPPONENT]).toHaveLength(4);
  });

  test("persists battle inventory, escape attempts, and a captured wild monster", () => {
    const ext = extensionWith(monster("nut", 20, "txmn-player", 71));
    const items = { tuxeball_ancient: 2, potion: 4 };
    ext.runAttempts = 3;
    const rules = createTuxemonBattleRules(DB, ENUMS);
    const started = startBattle(rules, ext, json({
      kind: "wild",
      species: "budaye",
      level: 5,
      environment: "grass",
    }), 717, items, 45)!;
    let value = revealCurrentMenu(rules, started.state);
    let runtime = tuxemonRuntimeBattleState(value);
    expect(runtime.visuals.items.tuxeball_ancient?.captureSprite)
      .toEqual(DB.items.tuxeball_ancient.captureSprite);
    expect(runtime.battle.inventory).toEqual(items);
    expect(runtime.battle.runAttempts).toBe(3);
    expect(runtime.menu.map(({ kind, available }) => [kind, available])).toEqual([
      ["fight", true],
      ["replacement", false],
      ["item", false],
      ["capture", true],
      ["run", true],
    ]);
    value = rules.step(value, { buttons: 0, downEdge: true }, 0);
    value = rules.step(value, { buttons: 0, confirmEdge: true }, 0);
    value = rules.step(value, { buttons: 0, confirmEdge: true }, 0);
    runtime = tuxemonRuntimeBattleState(value);
    expect(runtime.battle.result?.battleLastResult).toBe("captured");
    runtime.eventCursor = runtime.battle.events.length;
    const completion = rules.done(json(runtime))!;
    const persisted = tuxemonExtensionState(completion.ext, DB);
    expect(completion.result).toBe("escape");
    expect(completion.writes).toEqual({ "v.battle_last_result": 5 });
    expect(completion.items).toEqual({ tuxeball_ancient: 1, potion: 4 });
    expect(completion.gold).toBe(45);
    expect(persisted.runAttempts).toBe(3);
    expect(persisted.party).toHaveLength(2);
    expect(persisted.party[1]).toMatchObject({
      iid: "txmn-000002",
      slug: "budaye",
      acquisition: "captured",
      captureDevice: "tuxeball_ancient",
      waitingToEvolve: false,
    });
    expect(persisted.caught).toContain("budaye");
    expect(persisted.nextMonsterId).toBe(3);
  });

  test("sends a capture to the kennel when the active party is full", () => {
    const ext = extensionWith(monster("nut", 20, "txmn-player", 72));
    for (let index = 0; index < 5; index++) {
      ext.party.push(monster("rockitten", 10, `txmn-reserve-${index}`, 80 + index));
    }
    const rules = createTuxemonBattleRules(DB, ENUMS);
    const started = startBattle(rules, ext, json({
      kind: "wild",
      species: "budaye",
      level: 5,
      environment: "grass",
    }), 727, { tuxeball_ancient: 1 })!;
    const runtime = tuxemonRuntimeBattleState(revealCurrentMenu(rules, started.state));
    const target = runtime.battle.field.find((uid) => getSide(runtime.battle, uid) === 1)!;
    runtime.battle = reduceBattle(RULE_DB, runtime.battle, {
      type: "capture",
      item: "tuxeball_ancient",
      target,
    });
    runtime.eventCursor = runtime.battle.events.length;
    const persisted = tuxemonExtensionState(rules.done(json(runtime))!.ext, DB);
    expect(persisted.party).toHaveLength(PARTY_LIMIT);
    expect(persisted.kennel).toHaveLength(1);
    expect(persisted.kennel[0]).toMatchObject({ slug: "budaye", acquisition: "captured" });
  });

  test("writes all evolved monster fields and a successful run back to extension state", () => {
    const ext = extensionWith(monster("nut", 5, "txmn-player", 81));
    ext.runAttempts = 7;
    const rules = createTuxemonBattleRules(DB, ENUMS);
    const started = startBattle(rules, ext, json({
      kind: "wild",
      species: "budaye",
      level: 5,
      environment: "grass",
    }), 818, { potion: 2 })!;
    let value = revealCurrentMenu(rules, started.state);
    value = rules.step(value, { buttons: 0, downEdge: true }, 0);
    value = rules.step(value, { buttons: 0, confirmEdge: true }, 0);
    const runtime = tuxemonRuntimeBattleState(value);
    expect(runtime.battle.result?.battleLastResult).toBe("run");
    const evolved = runtime.battle.parties[0][0]!;
    evolved.slug = "bolt";
    evolved.level = 18;
    evolved.stage = "stage1";
    evolved.base = { hp: 71, armour: 72, dodge: 73, melee: 74, ranged: 75, speed: 76 };
    evolved.currentHp = 70;
    evolved.acquisition = "gift";
    evolved.captureDevice = "tuxeball_grand";
    evolved.waitingToEvolve = true;
    runtime.battle.inventory = { potion: 1 };
    runtime.eventCursor = runtime.battle.events.length;
    const completion = rules.done(json(runtime))!;
    const persisted = tuxemonExtensionState(completion.ext, DB);
    expect(completion.writes).toEqual({ "v.battle_last_result": 4 });
    expect(completion.items).toEqual({ potion: 1 });
    expect(persisted.runAttempts).toBe(0);
    expect(persisted.party[0]).toMatchObject({
      slug: "bolt",
      level: 18,
      stage: "stage1",
      base: evolved.base,
      currentHp: 70,
      acquisition: "gift",
      captureDevice: "tuxeball_grand",
      waitingToEvolve: true,
    });
  });

  test("records a real player defeat without healing or teleporting", () => {
    const ext = extensionWith(monster("budaye", 2, "txmn-player", 17));
    const rules = createTuxemonBattleRules(DB, ENUMS);
    const started = startBattle(rules, ext, json({
      kind: "trainer",
      opponent: OPPONENT,
      party: [{ species: "nut", level: 50, experienceModifier: 5, moneyModifier: 10 }],
    }), 202)!;
    const { completion } = finish(rules, started);
    const persisted = tuxemonExtensionState(completion.ext, DB);
    expect(completion.result).toBe("lose");
    expect(persisted.party[0]).toMatchObject({ currentHp: 0, status: "faint" });
    expect(persisted.history).toEqual([
      { fighter: "player", opponent: OPPONENT, outcome: "lost" },
      { fighter: OPPONENT, opponent: "player", outcome: "won" },
    ]);
    expect(completion.writes).toMatchObject({
      "v.battle_last_result": 2,
      "v.battle_last_winner": 2,
      "v.battle_last_loser": 1,
    });
    expect(completion.switches).toEqual({
      [`bo.${OPPONENT}.lost`]: true,
      "defeated.player": true,
    });
    expect(completion.transfer).toBeUndefined();
  });

  test("declines empty, all-fainted, and move-less player parties", () => {
    const rules = createTuxemonBattleRules(DB, ENUMS);
    const setup = json({
      kind: "trainer",
      opponent: OPPONENT,
      party: [{ species: "budaye", level: 5 }],
    });
    expect(startBattle(rules, initialTuxemonExtensionState(), setup, 1)).toBeNull();

    const noEnvironment = extensionWith(monster("nut", 5, "txmn-player-env"));
    noEnvironment.environment = null;
    expect(startBattle(rules, noEnvironment, setup, 1)).toBeNull();

    const fainted = monster("nut", 5, "txmn-player");
    fainted.currentHp = 0;
    expect(startBattle(rules, extensionWith(fainted), setup, 1)).toBeNull();

    const moveLess = monster("nut", 5, "txmn-player");
    moveLess.moves = [];
    expect(startBattle(rules, extensionWith(moveLess), setup, 1)).toBeNull();
  });

  test("random encounter miss is null; hit preserves probability, row, level, and spawn draw order", () => {
    const rules = createTuxemonBattleRules(DB, ENUMS);
    const ext = extensionWith(monster("nut", 20, "txmn-player"));
    // Pin the clock to noon so the live-clock daytime filter is "true" and the
    // battle hour is 12, matching the row selection below.
    ext.clock = { ...ext.clock, minuteOfDay: 12 * 60 };
    expect(startBattle(rules, ext, json({
      kind: "random",
      table: "spyder_route1",
      probability: 0,
    }), 303)).toBeNull();

    const seed = 404;
    const started = startBattle(rules, ext, json({
      kind: "random",
      table: "spyder_route1",
      probability: 100,
    }), seed)!;
    const actual = tuxemonRuntimeBattleState(started.state);

    const rng: RngState = { rng: seed, rngDraws: 0 };
    nextRandom(rng); // uniform(0,100) encounter roll
    // The runtime resolves daytime from the saved clock (noon -> "true"), so
    // only daytime:"true" rows are eligible, matching upstream's row filter.
    const rows = DB.encounters.spyder_route1!.monsters.filter((row) =>
      row.variables.every(({ key, value }) => key === "daytime" ? value === "true" : true));
    const total = rows.reduce((sum, row) => sum + row.weight, 0);
    const target = nextRandom(rng) * total;
    let sum = 0;
    const row = rows.find((candidate) => (sum += candidate.weight) > target)!;
    const chosenLevel = row.level[0] + Math.floor(nextRandom(rng) * (row.level[1] - row.level[0] + 1));
    const enemy = spawnMonster(DB, RULE_DB, rng, row.monster, chosenLevel, {
      experienceModifier: row.experienceModifier,
      moneyModifier: 0,
    });
    expect(rng.rngDraws).toBe(16);
    const expected = createBattle(RULE_DB, {
      seed: rng.rng,
      kind: "wild",
      opponent: `wild:${row.monster}`,
      player: ext.party,
      enemy: [enemy],
      inside: false,
      hour: 12,
      weather: ext.weather.slug,
      fieldSize: 1,
      moneyMethod: "conserved",
    });
    expect(actual.battle).toEqual(expected);
  });

  test("starts legal doubles and exposes every move/target pair in stable order", () => {
    const ext = extensionWith(monster("nut", 25, "txmn-player-a", 11));
    ext.party.push(monster("rockitten", 25, "txmn-player-b", 12));
    ext.nextMonsterId = 3;
    const rules = createTuxemonBattleRules(DB, ENUMS);
    const setup = json({
      kind: "trainer",
      opponent: OPPONENT,
      fieldSize: 2,
      environment: "grass",
      party: [
        { species: "memnomnom", level: 25 },
        { species: "memnomnom", level: 25 },
      ],
    });
    const started = startBattle(rules, ext, setup, 515)!;
    let value = revealCurrentMenu(rules, started.state);
    let state = tuxemonRuntimeBattleState(value);
    expect(state.battle.fieldSize).toBe(2);
    expect(state.battle.field.map((uid) => getSide(state.battle, uid))).toEqual([1, 1, 0, 0]);
    expect(state.menuMode).toBe("root");
    expect(state.menu[0]?.kind).toBe("fight");
    value = rules.step(value, { buttons: 0, confirmEdge: true }, 0);
    state = tuxemonRuntimeBattleState(value);
    expect(state.menuMode).toBe("technique");
    expect(new Set(state.menu.map(({ target }) => target))).toEqual(new Set(state.battle.field.slice(0, 2)));
    expect(state.menu.every(({ targetSlug, targetSlot }) => targetSlug === "memnomnom" && (targetSlot === 1 || targetSlot === 2))).toBeTrue();

    const secondTargetIndex = state.menu.findIndex(({ targetSlot }) => targetSlot === 2);
    expect(secondTargetIndex).toBeGreaterThanOrEqual(0);
    for (let index = 0; index < secondTargetIndex; index++) {
      value = rules.step(value, { buttons: 0, downEdge: true }, 0);
    }
    value = rules.step(value, { buttons: 0, confirmEdge: true }, 0);
    state = tuxemonRuntimeBattleState(value);
    const decision = [...state.battle.events].reverse().find((event) =>
      event.type === "decision" && event.side === 0
    );
    expect(decision?.target).toBe(state.battle.field[1]);
  });

  test("exposes item, capture, run, and swap choices with cancelable target menus", () => {
    const active = monster("nut", 20, "txmn-player-a", 31);
    active.currentHp = active.currentHp! - 1;
    const ext = extensionWith(active);
    ext.party.push(monster("rockitten", 20, "txmn-player-b", 32));
    ext.runAttempts = 9;
    const rules = createTuxemonBattleRules(DB, ENUMS);
    let value = revealCurrentMenu(rules, startBattle(rules, ext, json({
      kind: "wild",
      species: "budaye",
      level: 5,
      environment: "grass",
    }), 919, { potion: 2, tuxeball_ancient: 1 })!.state);
    let state = tuxemonRuntimeBattleState(value);
    expect(state.menu.map(({ kind, available }) => [kind, available])).toEqual([
      ["fight", true],
      ["replacement", true],
      ["item", true],
      ["capture", true],
      ["run", true],
    ]);

    value = rules.step(value, { buttons: 0, downEdge: true }, 0);
    value = rules.step(value, { buttons: 0, downEdge: true }, 0);
    value = rules.step(value, { buttons: 0, confirmEdge: true }, 0);
    state = tuxemonRuntimeBattleState(value);
    expect(state.menuMode).toBe("item");
    expect(state.menu).toContainEqual(expect.objectContaining({
      kind: "item",
      slug: "potion",
      quantity: 2,
      target: state.battle.parties[0][0]!.uid,
    }));

    value = rules.step(value, { buttons: 0, cancelEdge: true }, 0);
    state = tuxemonRuntimeBattleState(value);
    expect(state.menuMode).toBe("root");
    value = rules.step(value, { buttons: 0, downEdge: true }, 0);
    value = rules.step(value, { buttons: 0, downEdge: true }, 0);
    value = rules.step(value, { buttons: 0, downEdge: true }, 0);
    value = rules.step(value, { buttons: 0, confirmEdge: true }, 0);
    state = tuxemonRuntimeBattleState(value);
    expect(state.menuMode).toBe("capture");
    expect(state.menu).toContainEqual(expect.objectContaining({
      kind: "capture",
      slug: "tuxeball_ancient",
      quantity: 1,
      target: state.battle.parties[1][0]!.uid,
    }));

    value = rules.step(value, { buttons: 0, cancelEdge: true }, 0);
    value = rules.step(value, { buttons: 0, downEdge: true }, 0);
    value = rules.step(value, { buttons: 0, confirmEdge: true }, 0);
    state = tuxemonRuntimeBattleState(value);
    expect(state.menuMode).toBe("swap");
    expect(state.menu).toEqual([expect.objectContaining({
      kind: "replacement",
      slug: "rockitten",
      target: state.battle.parties[0][1]!.uid,
    })]);

    value = rules.step(value, { buttons: 0, cancelEdge: true }, 0);
    value = rules.step(value, { buttons: 0, downEdge: true }, 0);
    value = rules.step(value, { buttons: 0, downEdge: true }, 0);
    value = rules.step(value, { buttons: 0, confirmEdge: true }, 0);
    value = rules.step(value, { buttons: 0, confirmEdge: true }, 0);
    state = tuxemonRuntimeBattleState(value);
    expect(state.battle.events).toContainEqual(expect.objectContaining({
      type: "item",
      item: "potion",
      target: state.battle.parties[0][0]!.uid,
    }));
    expect(state.battle.inventory.potion).toBe(1);
  });

  test("declines a double battle when both parties have fewer than three monsters", () => {
    const ext = extensionWith(monster("nut", 25, "txmn-player", 21));
    const rules = createTuxemonBattleRules(DB, ENUMS);
    expect(startBattle(rules, ext, json({
      kind: "trainer",
      opponent: OPPONENT,
      fieldSize: 2,
      environment: "grass",
      party: [{ species: "memnomnom", level: 25 }],
    }), 616)).toBeNull();
  });

  test("presentation uses reference ticks and delays completion until the terminal event is shown", () => {
    const rules = createTuxemonBattleRules(DB, ENUMS);
    const ext = extensionWith(monster("nut", 50, "txmn-player", 91));
    const setup = json({
      kind: "trainer",
      opponent: OPPONENT,
      party: [{ species: "budaye", level: 2, experienceModifier: 5, moneyModifier: 10 }],
    });
    const starts = [60, 30, 20, 4].map(() => startBattle(rules, ext, setup, 808)!.state);
    const rates = [1, 2, 3, 15];
    const advanced = starts.map((start, index) => {
      let value = start;
      for (let elapsed = 0; elapsed < 30; elapsed += rates[index]!) {
        value = rules.step(value, { buttons: 0 }, rates[index]!);
      }
      return value;
    });
    expect(advanced.slice(1)).toEqual([advanced[0], advanced[0], advanced[0]]);

    const outcomes = [1, 2, 3, 15].map((ticks) => finish(
      rules,
      startBattle(rules, ext, setup, 909)!,
      ticks,
    ));
    const normalized = outcomes.map(({ state, completion }) => ({
      battle: state.battle,
      completion,
    }));
    expect(normalized.slice(1)).toEqual([normalized[0], normalized[0], normalized[0]]);
    const terminal = outcomes[0]!;
    const hidden = {
      ...terminal.state,
      eventCursor: terminal.state.battle.events.length - 1,
      eventTicks: 0,
    };
    expect(rules.done(json(hidden))).toBeNull();
  });
});

test("presentation, menus and decisions preserve every published battle snapshot", () => {
  const rules = createTuxemonBattleRules(DB, ENUMS);
  const started = startBattle(rules, extensionWith(monster("nut", 20, "txmn-player", 33)),
    json({ kind: "wild", species: "budaye", level: 5, environment: "grass" }), 717)!;
  const frozen = new WeakSet<object>();
  function freeze(value: unknown): void {
    if (!value || typeof value !== "object" || frozen.has(value)) return;
    frozen.add(value); for (const child of Object.values(value)) freeze(child); Object.freeze(value);
  }
  let value = started.state;
  const originalVisuals = tuxemonRuntimeBattleState(value).visuals;
  for (let tick = 0; tick < 300; tick++) {
    freeze(value);
    const before = JSON.stringify(value);
    const next = rules.step(value, { buttons: 0, confirmEdge: tick % 2 === 0 }, 1);
    expect(JSON.stringify(value)).toBe(before);
    expect(tuxemonRuntimeBattleState(next).visuals).toBe(originalVisuals);
    value = next;
    if (rules.done(value)) break;
  }
});
