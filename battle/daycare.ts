import type { BattleDb } from "../importer/battle-schema.ts";
import { giveExperience } from "./progression.ts";
import { spawnMonsterWithRandom } from "./spawn.ts";
import { calculateBaseStats, monsterFromSnapshot } from "./stats.ts";
import type {
  BattleMonster,
  DaycareExtensionState,
  SpawnedMonsterSnapshot,
  TuxemonBattleDb,
} from "./types.ts";

export const DAYCARE_CAPACITY = 2;
export const DAYCARE_EXP_PER_STEP = 0.25;
export const DAYCARE_COST_PER_EXP = 1;
export const DAYCARE_HALFWAY_STEPS = 5_000;
export const DAYCARE_REQUIRED_STEPS = 10_000;

const STAGE_RANK: Readonly<Record<string, number>> = {
  basic: 1,
  standalone: 2,
  stage1: 3,
  stage2: 4,
};

export type DaycareMode = "empty" | "training" | "incompatible" | "breeding";

export function daycareBreedingEligible(
  parents: readonly SpawnedMonsterSnapshot[],
): boolean {
  if (parents.length !== DAYCARE_CAPACITY) return false;
  const [left, right] = parents as readonly [SpawnedMonsterSnapshot, SpawnedMonsterSnapshot];
  const genders = new Set([left.gender, right.gender]);
  return genders.has("male") && genders.has("female")
    && (STAGE_RANK[left.stage] ?? 0) > 1
    && (STAGE_RANK[right.stage] ?? 0) > 1;
}

export function daycareMode(parents: readonly SpawnedMonsterSnapshot[]): DaycareMode {
  if (parents.length === 0) return "empty";
  if (parents.length === 1) return "training";
  return daycareBreedingEligible(parents) ? "breeding" : "incompatible";
}

export function daycareReady(daycare: Readonly<DaycareExtensionState>): boolean {
  return daycareBreedingEligible(daycare.parents)
    && daycare.progressSteps >= DAYCARE_REQUIRED_STEPS;
}

/** Add one parent with the same counter resets as upstream add_parent(). */
export function depositDaycareParent(
  daycare: Readonly<DaycareExtensionState> | undefined,
  parent: SpawnedMonsterSnapshot,
): DaycareExtensionState {
  if (daycare && daycare.parents.length >= DAYCARE_CAPACITY) {
    throw new Error("daycare is full");
  }
  return {
    parents: [...(daycare?.parents ?? []), parent],
    progressSteps: daycare?.progressSteps ?? 0,
    pendingExperience: 0,
    lastTrainingExp: 0,
    lastTrainingCost: 0,
  };
}

function boundedInteger(value: number, label: string): number {
  const integer = Math.trunc(value);
  if (!Number.isSafeInteger(integer)) throw new Error(`daycare ${label} exceeds safe integer range`);
  return integer;
}

/** Convert progression's mutable battle monster back to its persistent form. */
function progressedSnapshot(
  source: Readonly<SpawnedMonsterSnapshot>,
  monster: Readonly<BattleMonster>,
): SpawnedMonsterSnapshot {
  return {
    ...source,
    slug: monster.slug,
    ...(monster.nickname === undefined ? {} : { nickname: monster.nickname }),
    level: boundedInteger(monster.level, "level"),
    stage: monster.stage,
    gender: monster.gender,
    tasteCold: monster.tasteCold,
    tasteWarm: monster.tasteWarm,
    height: monster.height,
    weight: monster.weight,
    individualValues: { ...monster.individualValues },
    birthdate: [...monster.birthdate],
    base: { ...monster.base },
    currentHp: Math.max(0, Math.min(monster.base.hp, boundedInteger(monster.currentHp, "HP"))),
    moves: monster.moves.map((move) => move.slug),
    types: [...monster.originalTypes],
    totalExperience: Math.max(0, boundedInteger(monster.totalExperience, "experience")),
    experienceModifier: monster.experienceModifier,
    moneyModifier: monster.moneyModifier,
    bond: Math.max(0, Math.min(100, boundedInteger(monster.bond, "bond"))),
    trainingPoints: { ...monster.trainingPoints },
    status: monster.status?.slug ?? null,
    acquisition: monster.acquisition,
    captureDevice: monster.captureDevice,
    waitingToEvolve: monster.waitingToEvolve,
  };
}

export interface DaycareStepResult {
  daycare: DaycareExtensionState;
  gold: number;
}

/**
 * Apply one completed map-tile step. Compatible parents breed and do not
 * train. Otherwise every four steps settle one EXP per stored parent while
 * charging one shared money unit. If the whole bill cannot be paid, the
 * integer EXP remains pending and is retried together on a later step.
 */
export function advanceDaycareStep(
  current: Readonly<DaycareExtensionState>,
  gold: number,
  db: TuxemonBattleDb,
): DaycareStepResult {
  if (!Number.isSafeInteger(gold) || gold < 0) throw new Error("daycare gold must be a non-negative integer");
  if (daycareBreedingEligible(current.parents)) {
    const progressSteps = boundedInteger(current.progressSteps + 1, "step count");
    return { daycare: { ...current, progressSteps }, gold };
  }

  const pendingExperience = current.pendingExperience + DAYCARE_EXP_PER_STEP;
  const gainedExperience = Math.trunc(pendingExperience);
  if (gainedExperience === 0) {
    return { daycare: { ...current, pendingExperience }, gold };
  }
  const cost = Math.trunc(gainedExperience * DAYCARE_COST_PER_EXP);
  if (cost > gold) {
    return { daycare: { ...current, pendingExperience }, gold };
  }

  const parents = current.parents.map((snapshot, index) => {
    const monster = monsterFromSnapshot(db, index + 1, snapshot);
    // Daycare parents remain owned but are outside the owner's active party,
    // so upstream does not flag an evolution while training them.
    giveExperience(db, monster, gainedExperience, {
      owned: false,
      party: [],
      variables: {},
      inside: false,
    });
    return progressedSnapshot(snapshot, monster);
  });
  return {
    daycare: {
      ...current,
      parents,
      pendingExperience: pendingExperience - gainedExperience,
      lastTrainingExp: boundedInteger(current.lastTrainingExp + gainedExperience, "training EXP"),
      lastTrainingCost: boundedInteger(current.lastTrainingCost + cost, "training cost"),
    },
    gold: gold - cost,
  };
}

type RandomSource = () => number;

function randomChoice<T>(values: readonly T[], random: RandomSource): T {
  if (values.length === 0) throw new Error("daycare cannot choose from an empty list");
  return values[Math.min(values.length - 1, Math.floor(random() * values.length))]!;
}

function typesOf(sourceDb: BattleDb, monster: Readonly<SpawnedMonsterSnapshot>): readonly string[] {
  return monster.types ?? sourceDb.monsters[monster.slug]?.types ?? [];
}

function affinity(sourceDb: BattleDb, attack: readonly string[], defend: readonly string[]): number {
  let result = 1;
  for (const attackType of attack) for (const defendType of defend) {
    result *= sourceDb.elements[attackType]?.multipliers[defendType] ?? 1;
  }
  return result;
}

function resistance(sourceDb: BattleDb, defend: readonly string[], attack: string | undefined): number {
  if (attack === undefined) return 1;
  let result = 1;
  for (const defendType of defend) result *= sourceDb.elements[defendType]?.multipliers[attack] ?? 1;
  return result;
}

/** Upstream seed priority: stage, base-stat sum, HP ratio, affinity,
 * resistance, then one deterministic random tie-break. */
export function determineDaycareSeed(
  sourceDb: BattleDb,
  mother: Readonly<SpawnedMonsterSnapshot>,
  father: Readonly<SpawnedMonsterSnapshot>,
  random: RandomSource,
): Readonly<SpawnedMonsterSnapshot> {
  const rank = (monster: Readonly<SpawnedMonsterSnapshot>) => STAGE_RANK[monster.stage] ?? 0;
  const baseSum = (monster: Readonly<SpawnedMonsterSnapshot>) =>
    Object.values(monster.base).reduce((sum, value) => sum + value, 0);
  const hpRatio = (monster: Readonly<SpawnedMonsterSnapshot>) =>
    Math.min((monster.currentHp ?? monster.base.hp) / Math.max(1, monster.base.hp), 1);
  for (const compare of [rank, baseSum, hpRatio]) {
    const motherValue = compare(mother);
    const fatherValue = compare(father);
    if (motherValue > fatherValue) return mother;
    if (fatherValue > motherValue) return father;
  }
  const motherTypes = typesOf(sourceDb, mother);
  const fatherTypes = typesOf(sourceDb, father);
  const motherAffinity = affinity(sourceDb, motherTypes, fatherTypes);
  const fatherAffinity = affinity(sourceDb, fatherTypes, motherTypes);
  if (motherAffinity > fatherAffinity) return mother;
  if (fatherAffinity > motherAffinity) return father;
  const motherResistance = resistance(sourceDb, motherTypes, fatherTypes[0]);
  const fatherResistance = resistance(sourceDb, fatherTypes, motherTypes[0]);
  if (motherResistance < fatherResistance) return mother;
  if (fatherResistance < motherResistance) return father;
  return randomChoice([mother, father], random);
}

function basicAncestors(sourceDb: BattleDb, slug: string): string[] {
  const found: string[] = [];
  const visited = new Set<string>();
  const visit = (current: string): void => {
    if (visited.has(current)) return;
    visited.add(current);
    for (const [candidate, monster] of Object.entries(sourceDb.monsters)) {
      if (!monster.evolutions.some((raw) => raw.monster_slug === current)) continue;
      if (monster.stage === "basic") found.push(candidate);
      else visit(candidate);
    }
  };
  visit(slug);
  return [...new Set(found)];
}

/** Exact hybrid-name port of Daycare._determine_name. */
export function daycareHybridName(first: string, second: string): string {
  const vowel = /[aeiouy]/;
  let result: string;
  if (!vowel.test(first) || !vowel.test(second)) {
    result = first.slice(0, Math.floor(first.length / 2))
      + second.slice(Math.floor(second.length / 2));
  } else {
    const nearestVowel = (word: string): number => {
      const middle = Math.floor(word.length / 2);
      let best = 0;
      let distance = Number.POSITIVE_INFINITY;
      for (let index = 0; index < word.length; index++) {
        if (!vowel.test(word[index]!)) continue;
        const candidate = Math.abs(index - middle);
        if (candidate < distance) {
          best = index;
          distance = candidate;
        }
      }
      return best;
    };
    const firstVowel = nearestVowel(first);
    const secondVowel = nearestVowel(second);
    result = first.slice(0, firstVowel + 1) + second.slice(secondVowel);
  }
  result = [...result].filter((character, index, all) => index === 0 || character !== all[index - 1]).join("");
  if (result.length === 0) result = first.slice(0, 2) + second.slice(-2);
  return result.charAt(0).toUpperCase() + result.slice(1);
}

export function weightedTaste(
  sourceDb: BattleDb,
  type: "warm" | "cold",
  excluded: ReadonlySet<string>,
  random: RandomSource,
): string | null {
  const choices = sourceDb.tasteOrder
    .filter((slug) => sourceDb.tastes[slug]?.type === type && !excluded.has(slug))
    .map((slug) => [slug, sourceDb.tastes[slug]!.rarity] as const);
  const total = choices.reduce((sum, [, weight]) => sum + weight, 0);
  if (!(total > 0)) return null;
  const wanted = random() * total;
  let accumulated = 0;
  for (const [slug, weight] of choices) {
    accumulated += weight;
    if (wanted < accumulated) return slug;
  }
  return choices.at(-1)![0];
}

function mutateTaste(
  sourceDb: BattleDb,
  slug: string,
  type: "warm" | "cold",
  random: RandomSource,
): string {
  const rarity = Math.max(0, Math.min(1, sourceDb.tastes[slug]?.rarity ?? 1));
  if (random() >= 0.3 * rarity) return slug;
  return weightedTaste(sourceDb, type, new Set([slug, "tasteless"]), random) ?? slug;
}

export interface ProduceDaycareNewbornOptions {
  sourceDb: BattleDb;
  rulesDb: TuxemonBattleDb;
  iid: string;
  birthdate: readonly [number, number];
  nameOf(slug: string): string;
  random: RandomSource;
}

export interface ProducedDaycareNewborn {
  daycare: DaycareExtensionState;
  newborn: SpawnedMonsterSnapshot;
}

/** Produce and inherit one newborn, retaining both parents in daycare and
 * resetting only the breeding progress for the next cycle. */
export function produceDaycareNewborn(
  current: Readonly<DaycareExtensionState>,
  options: Readonly<ProduceDaycareNewbornOptions>,
): ProducedDaycareNewborn {
  if (!daycareReady(current)) throw new Error("daycare breeding is not complete");
  const mother = current.parents.find((parent) => parent.gender === "female")!;
  const father = current.parents.find((parent) => parent.gender === "male")!;
  const seed = determineDaycareSeed(options.sourceDb, mother, father, options.random);
  const other = seed.iid === mother.iid ? father : mother;
  const ancestors = basicAncestors(options.sourceDb, seed.slug);
  const slug = ancestors.length > 0 ? randomChoice(ancestors, options.random) : seed.slug;
  const level = Math.floor((mother.level + father.level) / 2);
  const spawned = spawnMonsterWithRandom(
    options.sourceDb,
    options.rulesDb,
    options.random,
    slug,
    level,
    { iid: options.iid },
  );
  const individualValues = { ...spawned.individualValues };
  for (const stat of Object.keys(individualValues) as Array<keyof typeof individualValues>) {
    individualValues[stat] = Math.max(mother.individualValues[stat], father.individualValues[stat]);
  }
  let tasteWarm = randomChoice([mother.tasteWarm, father.tasteWarm], options.random);
  let tasteCold = randomChoice([mother.tasteCold, father.tasteCold], options.random);
  tasteWarm = mutateTaste(options.sourceDb, tasteWarm, "warm", options.random);
  tasteCold = mutateTaste(options.sourceDb, tasteCold, "cold", options.random);
  const moves = [...spawned.moves];
  if (other.moves.length > 0) {
    const inherited = randomChoice(other.moves, options.random);
    if (!moves.includes(inherited)) moves.push(inherited);
  }
  const base = calculateBaseStats(
    options.rulesDb,
    slug,
    level,
    individualValues,
    tasteCold,
    tasteWarm,
    spawned.trainingPoints,
  );
  const newborn: SpawnedMonsterSnapshot = {
    ...spawned,
    nickname: daycareHybridName(
      seed.nickname ?? options.nameOf(seed.slug),
      other.nickname ?? options.nameOf(other.slug),
    ),
    birthdate: [...options.birthdate],
    acquisition: "bred",
    bond: 40,
    individualValues,
    tasteWarm,
    tasteCold,
    moves,
    base,
    currentHp: base.hp,
    motherIid: mother.iid,
    fatherIid: father.iid,
  };
  return {
    daycare: { ...current, progressSteps: 0 },
    newborn,
  };
}
