import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";

import battleDbJson from "../data/battle-db.json";
import {
  battleDbToTuxemonBattleDb,
  calculateBaseStats,
  calculateDefeatExperience,
  defeatExperienceAwards,
  evolveMonsterSnapshot,
  evolutionConditionsPass,
  giveExperience,
  createBattle,
  getMonster,
  makeRules,
  monsterFromSnapshot,
  nextRandom,
  spawnMonster,
  type BattleMonster,
  type DbEvolution,
  type MonsterSnapshot,
  type RngState,
  type SpawnedMonsterSnapshot,
  type Stats,
} from "../battle/index.ts";
import { validateBattleDb } from "../importer/battle-schema.ts";

interface GoldenMonster {
  slug: string;
  level: number;
  stage: string;
  gender: string;
  tasteCold: string;
  tasteWarm: string;
  height: number;
  weight: number;
  birthdate: [number, number];
  individualValues: Stats;
  base: Stats;
  currentHp: number;
  moves: string[];
  types: string[];
  totalExperience: number;
  experienceModifier: number;
  moneyModifier: number;
  acquisition: string;
  captureDevice: string;
  bond: number;
  trainingPoints: Stats;
  status: string | null;
  waitingToEvolve: boolean;
}

interface ProgressionCase {
  id: string;
  input: {
    slug: string;
    level: number;
    amount: number;
    experienceModifier?: number;
    owner?: boolean;
    variables?: Record<string, string | number | boolean>;
    gender?: string;
    types?: string[];
    partyTech?: string;
  };
  before: GoldenMonster;
  expected: {
    levelsGained: number;
    learnedMoves: string[];
    forgottenMoves: string[];
    afterChoice: GoldenMonster;
    evolutionTarget: string | null;
    rng: { cursor: number; draws: number };
  };
}

interface RewardCase {
  id: string;
  input: {
    loser: GoldenMonster;
    winnerAcquisition: string;
    winnerExperienceModifier: number;
    participants: number;
  };
  before: GoldenMonster;
  expected: {
    awardedExperience: number;
    levelsGained: number;
    learnedMoves: string[];
    after: GoldenMonster;
    rng: { cursor: number; draws: number };
  };
}

interface EvolutionCase {
  id: string;
  slug: string;
  row: DbEvolution;
  satisfiedContext: { use_item: boolean; map_inside: boolean };
  expected: { satisfied: boolean; unsatisfied: boolean; rng: { cursor: number; draws: number } };
}

interface ProgressionGolden {
  rewards: RewardCase[];
  progression: ProgressionCase[];
  evolutions: EvolutionCase[];
  appliedEvolutions: AppliedEvolutionCase[];
}

interface AppliedEvolutionCase {
  id: string;
  input: { slug: string; target: string; level: number; seed: number };
  before: GoldenMonster;
  expected: {
    after: GoldenMonster;
    afterReload: GoldenMonster;
    sameIdentity: boolean;
    caught: string[];
    rng: { cursor: number; draws: number };
  };
}

const ROOT = join(import.meta.dir, "..");
const SOURCE_DB = validateBattleDb(battleDbJson);
const DB = battleDbToTuxemonBattleDb(SOURCE_DB);
const GOLDEN = JSON.parse(
  gunzipSync(readFileSync(join(ROOT, "tests/goldens/gb3-progression.json.gz"))).toString("utf8"),
) as ProgressionGolden;

function snapshot(source: GoldenMonster): MonsterSnapshot {
  return {
    slug: source.slug,
    level: source.level,
    stage: source.stage,
    gender: source.gender,
    tasteCold: source.tasteCold,
    tasteWarm: source.tasteWarm,
    height: source.height,
    weight: source.weight,
    birthdate: [...source.birthdate],
    individualValues: { ...source.individualValues },
    base: { ...source.base },
    currentHp: source.currentHp,
    moves: [...source.moves],
    types: [...source.types],
    totalExperience: source.totalExperience,
    experienceModifier: source.experienceModifier,
    moneyModifier: source.moneyModifier,
    acquisition: source.acquisition,
    captureDevice: source.captureDevice,
    bond: source.bond,
    trainingPoints: { ...source.trainingPoints },
    status: source.status,
    waitingToEvolve: source.waitingToEvolve,
  };
}

function dump(monster: BattleMonster): GoldenMonster {
  return {
    slug: monster.slug,
    level: monster.level,
    stage: monster.stage,
    gender: monster.gender,
    tasteCold: monster.tasteCold,
    tasteWarm: monster.tasteWarm,
    height: monster.height,
    weight: monster.weight,
    birthdate: [...monster.birthdate],
    individualValues: { ...monster.individualValues },
    base: { ...monster.base },
    currentHp: monster.currentHp,
    moves: monster.moves.map((move) => move.slug),
    types: [...monster.types],
    totalExperience: monster.totalExperience,
    experienceModifier: monster.experienceModifier,
    moneyModifier: monster.moneyModifier,
    acquisition: monster.acquisition,
    captureDevice: monster.captureDevice,
    bond: monster.bond,
    trainingPoints: { ...monster.trainingPoints },
    status: monster.status?.slug ?? null,
    waitingToEvolve: monster.waitingToEvolve,
  };
}

function calculateReloadedBase(monster: SpawnedMonsterSnapshot): Stats {
  return calculateBaseStats(
    DB,
    monster.slug,
    monster.level,
    monster.individualValues,
    monster.tasteCold,
    monster.tasteWarm,
    monster.trainingPoints,
  );
}

function techniqueHolder(slug: string): BattleMonster {
  return { moves: [{ slug }] } as BattleMonster;
}

function rewardMonster(
  iid: string,
  seed: number,
  options: { heldItem?: string; acquisition?: string } = {},
): SpawnedMonsterSnapshot {
  return {
    ...spawnMonster(SOURCE_DB, DB, { rng: seed, rngDraws: 0 }, "nut", 12, { iid }),
    ...options,
  };
}

function rewardBattle(
  player: SpawnedMonsterSnapshot[],
  participantIndexes: number[],
) {
  const enemy = rewardMonster("enemy", 0x9182);
  const state = createBattle(DB, { seed: 3, player, enemy: [enemy] });
  const loser = state.parties[1][0]!;
  state.damageByDefender[String(loser.uid)] = participantIndexes.map((index) => state.parties[0][index]!.uid);
  return { state, loser };
}

function evolutionMonster(entry: EvolutionCase, satisfied: boolean): {
  monster: BattleMonster;
  party: BattleMonster[];
  variables: Record<string, string | number | boolean>;
  inside: boolean;
  useItem: boolean;
} {
  const row = entry.row;
  let level = typeof row.at_level === "number" ? row.at_level : 30;
  let gender = typeof row.gender === "string" ? row.gender : "neuter";
  let types = [typeof row.element === "string" ? row.element : "normal"];
  let inside = Boolean(row.inside);
  let useItem = row.item !== undefined;
  const variables = Object.fromEntries((row.variables ?? []).map(({ key, value }) => [key, value]));
  const monster = monsterFromSnapshot(DB, 1, {
    slug: entry.slug,
    level,
    base: { armour: 1, dodge: 1, hp: 1, melee: 1, ranged: 1, speed: 1 },
    moves: ["struggle"],
    gender,
    types,
  });
  const party = [monster];
  if (row.tech) party.push(techniqueHolder(row.tech));
  if (row.bond) {
    monster.bond = row.bond.value + (row.bond.comparison === "greater_than" ? 1 : 0);
  }
  if (row.stats) {
    const right = row.stats.target_stat ? 100 : row.stats.target_value!;
    if (row.stats.target_stat) monster.base[row.stats.target_stat] = right;
    monster.base[row.stats.stat_type] = row.stats.comparison === "greater_than" ? right + 1 : right;
  }
  for (const [slug, count] of Object.entries(row.party_conditions?.monster_slugs ?? {})) {
    for (let index = 0; index < count; index++) party.push({ slug } as BattleMonster);
  }

  if (!satisfied) {
    if (row.variables) for (const key of Object.keys(variables)) delete variables[key];
    else if (row.tech) party.splice(1);
    else if (row.element) types = ["normal"];
    else if (row.gender) gender = row.gender === "male" ? "female" : "male";
    else if (typeof row.inside === "boolean") inside = !row.inside;
    else if (row.stats) {
      const right = row.stats.target_stat ? monster.base[row.stats.target_stat] : row.stats.target_value!;
      monster.base[row.stats.stat_type] = row.stats.comparison === "equals" ? right + 1 : right;
    }
    else if (row.bond) {
      monster.bond = row.bond.value - (["equals", "greater_or_equal"].includes(row.bond.comparison) ? 1 : 0);
    }
    else if (row.party_conditions) party.splice(1);
    else if (row.item) useItem = false;
    else if (typeof row.at_level === "number") level = Math.max(1, row.at_level - 1);
    else throw new Error(`unhandled evolution condition in ${entry.id}`);
    monster.level = level;
    monster.gender = gender;
    monster.types = types;
  }
  return { monster, party, variables, inside, useItem };
}

describe("GB3 progression reducer differential", () => {
  test("imports held reward methods and preserves Transmitter-over-Feeder party splits", () => {
    expect(SOURCE_DB.items.xp_feeder).toMatchObject({ rewardMethod: "xp_feeder", moneyMultiplier: 1 });
    expect(SOURCE_DB.items.xp_transmitter).toMatchObject({ rewardMethod: "xp_transmitter", moneyMultiplier: 1 });
    expect(DB.item.xp_feeder).toMatchObject({ reward_method: "xp_feeder", money_multiplier: 1 });

    const feeder = rewardBattle([
      rewardMonster("fighter", 11),
      rewardMonster("holder", 12, { heldItem: "xp_feeder" }),
      rewardMonster("bench", 13),
    ], [0]);
    const feederTotal = calculateDefeatExperience(DB, feeder.loser, feeder.state.parties[0][0]!, 1);
    expect([...defeatExperienceAwards(DB, feeder.state, feeder.loser)]).toEqual([
      [feeder.state.parties[0][0]!.uid, feederTotal - Math.floor(feederTotal / 2)],
      [feeder.state.parties[0][1]!.uid, Math.floor(feederTotal / 2)],
    ]);

    const priority = rewardBattle([
      rewardMonster("fighter", 21, { heldItem: "xp_feeder" }),
      rewardMonster("transmitter", 22, { heldItem: "xp_transmitter" }),
      rewardMonster("bench", 23),
    ], [0]);
    const priorityTotal = calculateDefeatExperience(DB, priority.loser, priority.state.parties[0][0]!, 1);
    const transmittedPool = priorityTotal - Math.floor(priorityTotal / 2);
    expect([...defeatExperienceAwards(DB, priority.state, priority.loser)]).toEqual([
      [priority.state.parties[0][0]!.uid, Math.floor(priorityTotal / 2)],
      [priority.state.parties[0][1]!.uid, Math.floor(transmittedPool / 2)],
      [priority.state.parties[0][2]!.uid, Math.floor(transmittedPool / 2)],
    ]);

    const noBench = rewardBattle([
      rewardMonster("solo", 31, { heldItem: "xp_transmitter" }),
    ], [0]);
    const noBenchTotal = calculateDefeatExperience(DB, noBench.loser, noBench.state.parties[0][0]!, 1);
    expect([...defeatExperienceAwards(DB, noBench.state, noBench.loser)])
      .toEqual([[noBench.state.parties[0][0]!.uid, noBenchTotal]]);
  });

  test("pays multiple Feeder holders and uses the best participant multiplier for the bench", () => {
    const holders = rewardBattle([
      rewardMonster("fighter-holder", 41, { heldItem: "xp_feeder" }),
      rewardMonster("bench-holder", 42, { heldItem: "xp_feeder" }),
    ], [0]);
    const holderTotal = calculateDefeatExperience(DB, holders.loser, holders.state.parties[0][0]!, 1);
    const perHolder = Math.floor(holderTotal / 2);
    expect([...defeatExperienceAwards(DB, holders.state, holders.loser)])
      .toEqual(holders.state.parties[0].map((monster) => [monster.uid, perHolder]));

    const best = rewardBattle([
      rewardMonster("normal", 51),
      rewardMonster("traded", 52, { acquisition: "traded" }),
      rewardMonster("bench", 53, { heldItem: "xp_transmitter" }),
    ], [0, 1]);
    const normalTotal = calculateDefeatExperience(DB, best.loser, best.state.parties[0][0]!, 1);
    const tradedTotal = calculateDefeatExperience(DB, best.loser, best.state.parties[0][1]!, 1);
    const awards = defeatExperienceAwards(DB, best.state, best.loser);
    expect(awards.get(best.state.parties[0][0]!.uid)).toBe(Math.floor(Math.floor(normalTotal / 2) / 2));
    expect(awards.get(best.state.parties[0][1]!.uid)).toBe(Math.floor(Math.floor(tradedTotal / 2) / 2));
    expect(awards.get(best.state.parties[0][2]!.uid)).toBe(tradedTotal - Math.floor(tradedTotal / 2));
  });

  test("actual defeat processing writes bench XP while keeping reward messages participant-only", () => {
    const battle = rewardBattle([
      rewardMonster("fighter", 61),
      rewardMonster("holder", 62, { heldItem: "xp_feeder" }),
      rewardMonster("bench", 63),
    ], [0]);
    const expected = defeatExperienceAwards(DB, battle.state, battle.loser);
    const before = battle.state.parties[0].map(({ totalExperience }) => totalExperience);
    battle.loser.currentHp = 0;
    makeRules(DB).checkParty(battle.state);
    expect(battle.state.parties[0].map((monster, index) => monster.totalExperience - before[index]!))
      .toEqual(battle.state.parties[0].map((monster) => expected.get(monster.uid) ?? 0));
    expect(battle.state.rewards.at(-1)!.winners.map(({ uid }) => uid))
      .toEqual([battle.state.parties[0][0]!.uid]);
    expect(battle.state.rewards.at(-1)!.winners[0]!.experience)
      .toBe(expected.get(battle.state.parties[0][0]!.uid)!);
  });

  test("held money multipliers match participant-scaled and conserved upstream formulas", () => {
    const db = {
      ...DB,
      item: {
        ...DB.item,
        xp_feeder: { ...DB.item.xp_feeder, money_multiplier: 2 },
        xp_transmitter: { ...DB.item.xp_transmitter, money_multiplier: 3 },
      },
    };
    const player = [
      rewardMonster("penny-holder", 71, { heldItem: "xp_feeder" }),
      rewardMonster("plain-fighter", 72),
    ];
    const enemy = rewardMonster("multiplied-loser", 73, { heldItem: "xp_transmitter" });

    const prize = (moneyMethod: "participant_scaled" | "conserved"): number => {
      const state = createBattle(db, {
        seed: 4,
        kind: "trainer",
        player,
        enemy: [enemy],
        moneyMethod,
      });
      const loser = state.parties[1][0]!;
      const participants = state.parties[0];
      loser.moneyModifier = 1.9;
      state.damageByDefender[String(loser.uid)] = participants.map(({ uid }) => uid);
      loser.currentHp = 0;
      makeRules(db).checkParty(state);
      return state.rewards.at(-1)!.prize;
    };

    // Upstream truncates the base first: trunc(12 * 1.9) = 22. The legacy
    // strategy pays both living winners and applies both sides' multipliers.
    expect(prize("participant_scaled")).toBe(22 * 2 * 3 + 22 * 1 * 3);
    // Conserved pays once using only the best winner multiplier.
    expect(prize("conserved")).toBe(22 * 2);
  });

  test("matches all reward acquisition multipliers and participant splits", () => {
    for (const entry of GOLDEN.rewards) {
      const player = Array.from({ length: entry.input.participants }, () => snapshot(entry.before));
      const state = createBattle(DB, {
        seed: 1,
        player,
        enemy: [snapshot(entry.input.loser)],
        fieldSize: entry.input.participants === 2 ? 2 : 1,
      });
      const winner = getMonster(state, 1);
      const loser = getMonster(state, entry.input.participants + 1);
      const awarded = calculateDefeatExperience(
        DB,
        loser,
        winner,
        entry.input.participants,
      );
      expect(awarded, entry.id).toBe(entry.expected.awardedExperience);
      state.damageByDefender[String(loser.uid)] = state.parties[0].map(({ uid }) => uid);
      loser.currentHp = 0;
      makeRules(DB).checkParty(state);
      const reward = state.rewards.at(-1)!.winners[0]!;
      expect(reward.experience, entry.id).toBe(entry.expected.awardedExperience);
      expect(reward.levelsGained, entry.id).toBe(entry.expected.levelsGained);
      expect(reward.learnedMoves, entry.id).toEqual(entry.expected.learnedMoves);
      expect(dump(winner), entry.id).toEqual(entry.expected.after);
    }
  });

  test("matches XP boundaries, stat/HP growth, move learning, and the default choice", () => {
    for (const entry of GOLDEN.progression) {
      const monster = monsterFromSnapshot(DB, 1, snapshot(entry.before));
      const party = [monster];
      if (entry.input.partyTech) party.push(techniqueHolder(entry.input.partyTech));
      const result = giveExperience(DB, monster, entry.input.amount, {
        owned: entry.input.owner ?? false,
        party,
        variables: entry.input.variables ?? {},
        inside: false,
      });
      expect(result.levelsGained, entry.id).toBe(entry.expected.levelsGained);
      expect(result.learnedMoves, entry.id).toEqual(entry.expected.learnedMoves);
      expect(result.forgottenMoves, entry.id).toEqual(entry.expected.forgottenMoves);
      expect(result.evolutionTarget, entry.id).toBe(entry.expected.evolutionTarget);
      expect(dump(monster), entry.id).toEqual(entry.expected.afterChoice);
    }
  });

  test("allows a future UI to provide the move slot selected for forgetting", () => {
    const entry = GOLDEN.progression.find(({ id }) => id === "boundary:exact-fifth-move")!;
    const monster = monsterFromSnapshot(DB, 1, snapshot(entry.before));
    const selections: Array<{ moves: readonly string[]; learned: string }> = [];
    const result = giveExperience(DB, monster, entry.input.amount, {
      owned: false, party: [monster], variables: {}, inside: false,
    }, (_current, moves, learned) => {
      selections.push({ moves: [...moves], learned });
      return moves.length - 1;
    });
    expect(selections).toEqual([{
      moves: ["bullet", "static_field", "shuriken", "clamp_on", "muddle"],
      learned: "muddle",
    }]);
    expect(result.forgottenMoves).toEqual(["muddle"]);
    expect(monster.moves.map(({ slug }) => slug)).toEqual([
      "bullet", "static_field", "shuriken", "clamp_on",
    ]);
  });

  test("matches every imported upstream evolution row in satisfied and failed contexts", () => {
    for (const entry of GOLDEN.evolutions) {
      const positive = evolutionMonster(entry, true);
      expect(evolutionConditionsPass(positive.monster, entry.row, {
        owned: true,
        party: positive.party,
        variables: positive.variables,
        inside: positive.inside,
        useItem: positive.useItem,
      }), `${entry.id}:satisfied`).toBe(entry.expected.satisfied);

      const negative = evolutionMonster(entry, false);
      expect(evolutionConditionsPass(negative.monster, entry.row, {
        owned: true,
        party: negative.party,
        variables: negative.variables,
        inside: negative.inside,
        useItem: negative.useItem,
      }), `${entry.id}:unsatisfied`).toBe(entry.expected.unsatisfied);
    }
  });

  test("matches applied evolution snapshots and exact spawn RNG", () => {
    for (const entry of GOLDEN.appliedEvolutions) {
      const source = snapshot(entry.before) as SpawnedMonsterSnapshot;
      source.heldItem = "xp_feeder";
      const rng: RngState = { rng: entry.input.seed, rngDraws: 0 };
      const result = evolveMonsterSnapshot(
        SOURCE_DB,
        DB,
        source,
        [source],
        { variables: {}, inside: false },
        () => nextRandom(rng),
      );
      expect(result?.target, entry.id).toBe(entry.input.target);
      expect(result?.monster.heldItem, `${entry.id}:held-item`).toBe("xp_feeder");
      expect(dump(monsterFromSnapshot(DB, 1, result!.monster)), entry.id)
        .toEqual(entry.expected.after);
      expect({ cursor: rng.rng, draws: rng.rngDraws }, entry.id)
        .toEqual(entry.expected.rng);

      const reloaded = monsterFromSnapshot(DB, 1, {
        ...result!.monster,
        base: calculateReloadedBase(result!.monster),
      });
      expect(dump(reloaded).base, `${entry.id}:reload`)
        .toEqual(entry.expected.afterReload.base);
    }
  });
});
