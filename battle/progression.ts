import type { BattleDb } from "../importer/battle-schema.ts";
import { spawnMonsterWithRandom } from "./spawn.ts";
import { calculateBaseStats, monsterFromSnapshot, pythonRound, zeroStats } from "./stats.ts";
import type {
  BattleMonster,
  DbEvolution,
  SpawnedMonsterSnapshot,
  TuxemonBattleDb,
} from "./types.ts";

export interface EvolutionContext {
  /** Upstream only evolves a monster present in its owner's party. */
  owned: boolean;
  party: readonly BattleMonster[];
  variables: Readonly<Record<string, string | number | boolean>>;
  inside: boolean;
  useItem?: boolean;
}

export interface ProgressionResult {
  awardedExperience: number;
  effectiveExperience: number;
  levelsGained: number;
  learnedMoves: string[];
  forgottenMoves: string[];
  evolutionTarget: string | null;
}

/** A future move-learning menu can supply this selector without changing XP rules. */
export type MoveForgetSelector = (
  monster: Readonly<BattleMonster>,
  moves: readonly string[],
  newlyLearned: string,
) => number;

export const forgetFirstMove: MoveForgetSelector = () => 0;

export interface AppliedEvolution {
  target: string;
  monster: SpawnedMonsterSnapshot;
}

function progressionRules(db: TuxemonBattleDb) {
  return db.progression ?? {
    level_range: [1, 100] as [number, number],
    max_moves: 4,
    experience_groups: {
      default: { multiplier: 1, experience_coefficient: 3 },
    },
    acquisition_multipliers: {},
  };
}

function threshold(db: TuxemonBattleDb, level: number): number {
  const rules = progressionRules(db);
  const group = rules.experience_groups.default!;
  const bounded = Math.max(rules.level_range[0], Math.min(rules.level_range[1], level));
  return Math.trunc(group.multiplier * bounded ** group.experience_coefficient);
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

function compare(comparison: string, left: number, right: number): boolean {
  switch (comparison) {
    case "less_than":
    case "<": return left < right;
    case "less_or_equal":
    case "<=": return left <= right;
    case "greater_than":
    case ">": return left > right;
    case "greater_or_equal":
    case ">=": return left >= right;
    case "equals":
    case "equal_to":
    case "==": return left === right;
    case "not_equals":
    case "!=": return left !== right;
    default: throw new Error(`battle progression: unknown comparison '${comparison}'`);
  }
}

function countBy(values: readonly string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return counts;
}

function containsCounts(actual: ReadonlyMap<string, number>, required: Record<string, number>): boolean {
  return Object.entries(required).every(([value, count]) => (actual.get(value) ?? 0) >= count);
}

function partyAlignment(party: readonly BattleMonster[]): string | null {
  const counts = new Map<string, number>();
  let best: string | null = null;
  let bestCount = 0;
  for (const monster of party) for (const type of monster.types) {
    const count = (counts.get(type) ?? 0) + 1;
    counts.set(type, count);
    // Counter.most_common retains first-seen order when counts tie.
    if (count > bestCount) {
      best = type;
      bestCount = count;
    }
  }
  return best;
}

/** The condition order and item gate mirror Evolution.can_evolve. */
export function evolutionConditionsPass(
  monster: Readonly<BattleMonster>,
  evolution: DbEvolution,
  context: EvolutionContext,
): boolean {
  if (!context.owned || evolution.monster_slug === monster.slug) return false;
  const conditions: boolean[] = [];
  if (typeof evolution.at_level === "number") conditions.push(monster.level >= evolution.at_level);
  if (typeof evolution.gender === "string") conditions.push(monster.gender === evolution.gender);
  if (typeof evolution.element === "string") conditions.push(monster.types.includes(evolution.element));
  if (typeof evolution.acquisition === "string") conditions.push(monster.acquisition === evolution.acquisition);
  if (typeof evolution.inside === "boolean") conditions.push(context.inside === evolution.inside);
  if (typeof evolution.tech === "string") {
    conditions.push(context.party.some((member) => member.moves.some((move) => move.slug === evolution.tech)));
  }
  for (const move of stringArray(evolution.moves)) {
    conditions.push(monster.moves.some((known) => known.slug === move));
  }
  if (Array.isArray(evolution.variables)) {
    conditions.push(evolution.variables.every((raw) => {
      const condition = record(raw);
      return typeof condition?.key === "string"
        && context.variables[condition.key] === condition.value;
    }));
  }
  const tastes = record(evolution.tastes);
  if (tastes) {
    for (const [kind, expected] of Object.entries(tastes)) {
      const actual = kind === "cold" ? monster.tasteCold : kind === "warm" ? monster.tasteWarm : undefined;
      conditions.push(actual === expected);
    }
  }
  if (typeof evolution.bond === "object" && evolution.bond !== null) {
    const bond = evolution.bond as Record<string, unknown>;
    const value = Number(bond.value);
    conditions.push(compare(String(bond.comparison ?? "equals"), monster.bond, value));
  }
  if (evolution.stats) {
    const left = monster.base[evolution.stats.stat_type];
    const right = evolution.stats.target_stat === undefined
      ? evolution.stats.target_value
      : monster.base[evolution.stats.target_stat];
    if (right === undefined) throw new Error("battle progression: stats condition has no target");
    conditions.push(compare(evolution.stats.comparison, left, right));
  }
  if (evolution.party_conditions) {
    const required = evolution.party_conditions;
    if (required.alignment !== undefined) conditions.push(partyAlignment(context.party) === required.alignment);
    if (required.monster_slugs) {
      conditions.push(containsCounts(countBy(context.party.map(({ slug }) => slug)), required.monster_slugs));
    }
    if (required.monster_types) {
      conditions.push(containsCounts(countBy(context.party.flatMap(({ types }) => types)), required.monster_types));
    }
    if (required.genders) {
      conditions.push(containsCounts(countBy(context.party.map(({ gender }) => gender)), required.genders));
    }
    if (required.party_size !== undefined) conditions.push(context.party.length >= required.party_size);
    if (required.party_level !== undefined) {
      const average = context.party.length === 0
        ? null
        : pythonRound(context.party.reduce((sum, member) => sum + member.level, 0) / context.party.length);
      conditions.push(average !== null && average >= required.party_level);
    }
    if (required.party_stages) {
      conditions.push(containsCounts(countBy(context.party.map(({ stage }) => stage)), required.party_stages));
    }
  }

  // Ordinary level-up cannot select an item evolution. Upstream's separate
  // item-selection path opts in with use_item=true.
  if (record(evolution.item) && !context.useItem) return false;
  return conditions.every(Boolean);
}

export function eligibleEvolution(
  db: TuxemonBattleDb,
  monster: Readonly<BattleMonster>,
  context: EvolutionContext,
): string | null {
  const species = db.monster[monster.slug];
  if (!species) return null;
  for (const evolution of species.evolutions ?? []) {
    if (evolution.monster_slug === monster.slug) continue;
    if (evolutionConditionsPass(monster, evolution, context)) return evolution.monster_slug;
  }
  return null;
}

function evolvedGender(
  sourceDb: BattleDb,
  target: string,
  previous: string,
  random: () => number,
): string {
  const weights = Object.entries(sourceDb.monsters[target]!.genderWeights);
  if (weights.some(([gender]) => gender === previous)) return previous;
  const total = weights.reduce((sum, [, weight]) => sum + weight, 0);
  const wanted = random() * total;
  let accumulated = 0;
  for (const [gender, weight] of weights) {
    accumulated += weight;
    if (wanted < accumulated) return gender;
  }
  return weights.at(-1)![0];
}

function evolutionMoves(
  db: TuxemonBattleDb,
  target: string,
  level: number,
  stage: string,
  known: readonly string[],
): string[] {
  const result = [...known];
  const schedule = db.monster[target]!.moveset;
  for (const entry of schedule) {
    const first = schedule.find((candidate) => candidate.technique === entry.technique)!;
    if (first.learning_method !== "evolution"
      || first.level_learned > level
      || (first.evolution_stage_learned !== undefined && first.evolution_stage_learned !== stage)
      || result.includes(entry.technique)) continue;
    result.push(entry.technique);
  }
  return result;
}

/**
 * Apply EvolutionState._confirm to one persistent snapshot. The target is
 * freshly spawned first, so target size and the thirteen upstream RNG draws
 * are retained. transfer_properties_from then calculates immediate stats
 * with the target's fresh IVs and zero TPs before copying the old IV/TP data;
 * that counter-intuitive ordering is observable until a save is reloaded.
 */
export function evolveMonsterSnapshot(
  sourceDb: BattleDb,
  db: TuxemonBattleDb,
  source: SpawnedMonsterSnapshot,
  party: readonly SpawnedMonsterSnapshot[],
  context: Omit<EvolutionContext, "owned" | "party">,
  random: () => number,
): AppliedEvolution | null {
  const monster = monsterFromSnapshot(db, 1, source);
  const members = party.map((entry, index) => monsterFromSnapshot(db, index + 1, entry));
  const target = eligibleEvolution(db, monster, {
    ...context,
    owned: true,
    party: members,
    useItem: monster.waitingToEvolve,
  });
  if (target === null) return null;
  return { target, monster: transferToSpecies(sourceDb, db, monster, target, random) };
}

/**
 * Monster.spawn_base(target, level) followed by transfer_properties_from(old)
 * and evolve_monster's evolution-method move learning. Upstream uses this
 * exact chain for both evolution (EvolutionState._confirm) and the Dojo's
 * devolution (dojo_method monster), so both callers share it.
 */
export function transferToSpecies(
  sourceDb: BattleDb,
  db: TuxemonBattleDb,
  monster: BattleMonster,
  target: string,
  random: () => number,
): SpawnedMonsterSnapshot {
  const spawned = spawnMonsterWithRandom(sourceDb, db, random, target, monster.level, {
    ...(monster.iid === undefined ? {} : { iid: monster.iid }),
  });
  const stage = spawned.stage;
  const base = calculateBaseStats(
    db,
    target,
    monster.level,
    spawned.individualValues,
    monster.tasteCold,
    monster.tasteWarm,
    zeroStats(),
  );
  return {
    ...spawned,
    ...(monster.iid === undefined ? {} : { iid: monster.iid }),
    ...(monster.nickname === undefined ? {} : { nickname: monster.nickname }),
    level: monster.level,
    gender: evolvedGender(sourceDb, target, monster.gender, random),
    tasteCold: monster.tasteCold,
    tasteWarm: monster.tasteWarm,
    individualValues: { ...monster.individualValues },
    birthdate: [...monster.birthdate],
    base,
    currentHp: Math.min(monster.currentHp, base.hp),
    moves: evolutionMoves(db, target, monster.level, stage, monster.moves.map(({ slug }) => slug)),
    totalExperience: monster.totalExperience,
    experienceModifier: 1,
    moneyModifier: 0,
    bond: Math.max(monster.bond, sourceDb.rules.bondStageFloors[stage] ?? 0),
    trainingPoints: { ...monster.trainingPoints },
    status: monster.status?.slug ?? null,
    acquisition: "unknown",
    captureDevice: monster.captureDevice,
    waitingToEvolve: false,
  };
}

/** Base reward before MonsterExperience applies the winner's own modifier. */
export function calculateDefeatExperience(
  db: TuxemonBattleDb,
  loser: Pick<BattleMonster, "level" | "totalExperience" | "experienceModifier">,
  winner: Pick<BattleMonster, "level" | "acquisition">,
  participantCount: number,
): number {
  const maximum = progressionRules(db).level_range[1];
  if (winner.level >= maximum) return 0;
  const base = Math.trunc(Math.floor(loser.totalExperience / loser.level) * loser.experienceModifier);
  const multiplier = progressionRules(db).acquisition_multipliers[winner.acquisition] ?? 1;
  return Math.floor(pythonRound(base * multiplier) / Math.max(1, participantCount));
}

function scheduledMoves(
  db: TuxemonBattleDb,
  monster: Readonly<BattleMonster>,
  oldLevel: number,
): string[] {
  const schedule = db.monster[monster.slug]?.moveset ?? [];
  return schedule.filter((entry) => oldLevel < entry.level_learned && entry.level_learned <= monster.level)
    .filter((entry) => {
      // MonsterMovesHandler.is_eligible deliberately resolves the first row
      // for a duplicate technique, not necessarily the row being iterated.
      const first = schedule.find((candidate) => candidate.technique === entry.technique)!;
      return first.learning_method === "level_up"
        && first.level_learned <= monster.level
        && (first.evolution_stage_learned === undefined
          || first.evolution_stage_learned === monster.stage);
    })
    .map((entry) => entry.technique);
}

function addMove(db: TuxemonBattleDb, monster: BattleMonster, slug: string): boolean {
  if (monster.moves.some((move) => move.slug === slug)) return false;
  const technique = db.technique[slug];
  if (!technique) throw new Error(`battle progression: unknown technique '${slug}'`);
  monster.moves.push({
    slug,
    cooldown: 0,
    power: technique.power,
    potency: technique.potency,
    hit: false,
  });
  return true;
}

/**
 * Apply Monster.give_experience and the scripted over-four-move choice.
 * The default selects slot zero, matching an explicit first menu choice;
 * callers may inject the future UI's selected index.
 */
export function giveExperience(
  db: TuxemonBattleDb,
  monster: BattleMonster,
  amount: number,
  context: EvolutionContext,
  chooseMoveToForget: MoveForgetSelector = forgetFirstMove,
): ProgressionResult {
  const result: ProgressionResult = {
    awardedExperience: amount,
    effectiveExperience: 0,
    levelsGained: 0,
    learnedMoves: [],
    forgottenMoves: [],
    evolutionTarget: null,
  };
  if (amount <= 0) return result;

  const rules = progressionRules(db);
  const effective = Math.trunc(amount * monster.experienceModifier);
  result.effectiveExperience = effective;
  monster.totalExperience += effective;
  const oldLevel = monster.level;
  while (monster.level < rules.level_range[1]
    && monster.totalExperience >= threshold(db, monster.level + 1)) {
    monster.level++;
    result.levelsGained++;
  }
  if (result.levelsGained === 0) return result;

  const oldMaxHp = monster.base.hp;
  monster.base = calculateBaseStats(
    db,
    monster.slug,
    monster.level,
    monster.individualValues,
    monster.tasteCold,
    monster.tasteWarm,
    monster.trainingPoints,
  );
  monster.currentHp += monster.base.hp - oldMaxHp;

  for (const slug of scheduledMoves(db, monster, oldLevel)) {
    if (addMove(db, monster, slug)) result.learnedMoves.push(slug);
  }
  while (monster.moves.length > rules.max_moves) {
    const slugs = monster.moves.map((move) => move.slug);
    const newest = result.learnedMoves.at(-1) ?? slugs.at(-1)!;
    const selected = chooseMoveToForget(monster, slugs, newest);
    const index = Number.isInteger(selected)
      ? Math.max(0, Math.min(monster.moves.length - 1, selected))
      : 0;
    result.forgottenMoves.push(monster.moves[index]!.slug);
    monster.moves.splice(index, 1);
  }

  result.evolutionTarget = eligibleEvolution(db, monster, { ...context, useItem: false });
  monster.waitingToEvolve = result.evolutionTarget !== null;
  return result;
}
