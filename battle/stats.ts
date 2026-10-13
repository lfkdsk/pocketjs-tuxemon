import type {
  BattleMonster,
  DbStatModifier,
  MonsterSnapshot,
  StatName,
  Stats,
  TuxemonBattleDb,
} from "./types.ts";
import { STAT_NAMES } from "./types.ts";

const NONLINEAR_STAGE: Record<number, number> = {
  [-6]: 2 / 8,
  [-5]: 2 / 7,
  [-4]: 2 / 6,
  [-3]: 2 / 5,
  [-2]: 2 / 4,
  [-1]: 2 / 3,
  0: 1,
  1: 3 / 2,
  2: 4 / 2,
  3: 5 / 2,
  4: 6 / 2,
  5: 7 / 2,
  6: 8 / 2,
};

/** Python's round(), including ties-to-even for the positive values used here. */
export function pythonRound(value: number): number {
  const floor = Math.floor(value);
  const fraction = value - floor;
  if (fraction > 0.5) return floor + 1;
  if (fraction < 0.5) return floor;
  return floor % 2 === 0 ? floor : floor + 1;
}

export function zeroStats(): Stats {
  return { armour: 0, dodge: 0, hp: 0, melee: 0, ranged: 0, speed: 0 };
}

export function calculateBaseStats(
  db: TuxemonBattleDb,
  slug: string,
  level: number,
  individualValues: Stats,
  tasteCold: string,
  tasteWarm: string,
  trainingPoints: Partial<Stats> = {},
): Stats {
  const monster = db.monster[slug];
  if (!monster) throw new Error(`battle: unknown monster '${slug}'`);
  const shape = db.shape[monster.shape];
  if (!shape) throw new Error(`battle: unknown shape '${monster.shape}'`);
  const result = {} as Stats;
  for (const stat of STAT_NAMES) {
    const tp = Math.trunc((trainingPoints[stat] ?? 0) * level / 100);
    let value = Math.trunc(shape.attributes[stat] * (level + 7) + individualValues[stat] + tp);
    for (const tasteSlug of [tasteCold, tasteWarm]) {
      const taste = db.taste[tasteSlug];
      if (!taste) continue;
      let multiplier = 1;
      for (const modifier of taste.modifiers) {
        if (modifier.values.includes(stat)) multiplier *= modifier.multiplier;
      }
      value = pythonRound(value * multiplier);
    }
    result[stat] = value;
  }
  return result;
}

export function combatStat(monster: BattleMonster, stat: StatName): number {
  const base = monster.base[stat];
  const stage = Math.max(-6, Math.min(6, monster.stages[stat] ?? 0));
  let boost = stage === 0 ? 0 : Math.trunc(base * NONLINEAR_STAGE[stage]!) - base;
  boost += monster.statusBoosts[stat] ?? 0;
  if (boost < 0) boost = Math.max(boost, 1 - base);
  return base + boost;
}

export function combatStats(monster: BattleMonster): Stats {
  const result = {} as Stats;
  for (const stat of STAT_NAMES) result[stat] = combatStat(monster, stat);
  return result;
}

export function applyStatModifier(
  monster: BattleMonster,
  stat: StatName | "current_hp",
  modifier: DbStatModifier,
  randomDeviation: number | null = null,
  statusSource = false,
): void {
  if (stat === "current_hp" && modifier.overridetofull) {
    monster.currentHp = monster.base.hp;
    return;
  }

  const base = stat === "current_hp" ? monster.currentHp : monster.base[stat];
  if (modifier.step !== null) {
    const asked = modifier.step + (randomDeviation ?? 0);
    const limit = Math.trunc(modifier.max_step_limit);
    const step = Math.max(-limit, Math.min(limit, asked));
    if (stat === "current_hp") {
      const multiplier = modifier.scaling_mode === "nonlinear"
        ? NONLINEAR_STAGE[Math.max(-6, Math.min(6, step))]!
        : 1 + step;
      monster.currentHp = Math.max(0, Math.min(monster.base.hp, pythonRound(base * multiplier)));
      return;
    }
    const previous = monster.stages[stat] ?? 0;
    monster.stages[stat] = Math.max(-limit, Math.min(limit, previous + step));
    return;
  }

  const value = modifier.value + (randomDeviation ?? 0);
  let changed: number;
  switch (modifier.operation) {
    case "*":
    case "multiply": changed = pythonRound(base * value); break;
    case "+":
    case "add": changed = pythonRound(base + value); break;
    case "-":
    case "subtract": changed = pythonRound(base - value); break;
    case "/":
    case "divide": changed = pythonRound(base / value); break;
    default: changed = base;
  }
  if (stat === "current_hp") {
    monster.currentHp = Math.max(0, Math.min(monster.base.hp, changed));
    return;
  }
  changed = Math.max(1, changed);
  const boost = Math.trunc(changed - base);
  if (statusSource) monster.statusBoosts[stat] = (monster.statusBoosts[stat] ?? 0) + boost;
}

export function monsterFromSnapshot(
  db: TuxemonBattleDb,
  uid: number,
  snapshot: MonsterSnapshot,
): BattleMonster {
  const species = db.monster[snapshot.slug];
  if (!species) throw new Error(`battle: unknown monster '${snapshot.slug}'`);
  const trainingPoints = zeroStats();
  Object.assign(trainingPoints, snapshot.trainingPoints ?? {});
  const moves = snapshot.moves.map((slug) => {
    const technique = db.technique[slug];
    if (!technique) throw new Error(`battle: unknown technique '${slug}'`);
    return { slug, cooldown: 0, power: technique.power, potency: technique.potency, hit: false };
  });
  return {
    uid,
    ...(snapshot.iid === undefined ? {} : { iid: snapshot.iid }),
    slug: snapshot.slug,
    ...(snapshot.nickname === undefined ? {} : { nickname: snapshot.nickname }),
    ...(snapshot.heldItem === undefined ? {} : { heldItem: snapshot.heldItem }),
    level: snapshot.level,
    stage: snapshot.stage ?? species.stage ?? "basic",
    gender: snapshot.gender ?? "neuter",
    tasteCold: snapshot.tasteCold ?? "tasteless",
    tasteWarm: snapshot.tasteWarm ?? "tasteless",
    height: snapshot.height ?? 0,
    weight: snapshot.weight ?? 0,
    individualValues: { ...(snapshot.individualValues ?? zeroStats()) },
    birthdate: [...(snapshot.birthdate ?? [1, 1])] as [number, number],
    acquisition: snapshot.acquisition ?? "unknown",
    captureDevice: snapshot.captureDevice ?? "tuxeball",
    waitingToEvolve: snapshot.waitingToEvolve ?? false,
    originalTypes: [...(snapshot.types ?? species.types)],
    types: [...(snapshot.types ?? species.types)],
    base: { ...snapshot.base },
    stages: {},
    statusBoosts: {},
    trainingPoints,
    currentHp: snapshot.currentHp ?? snapshot.base.hp,
    totalExperience: snapshot.totalExperience ?? snapshot.level ** 3,
    experienceModifier: snapshot.experienceModifier ?? 1,
    moneyModifier: snapshot.moneyModifier ?? 0,
    bond: snapshot.bond ?? 25,
    moves,
    fallback: "struggle",
    fallbackHit: false,
    status: snapshot.status ? {
      slug: snapshot.status,
      turn: 0,
      stack: 1,
      uses: 0,
      linked: null,
      appliedEffects: [],
    } : null,
    plagues: { ...(snapshot.plagues ?? {}) },
    outOfRange: false,
    isConfused: false,
  };
}

export function learnedMoves(
  db: TuxemonBattleDb,
  slug: string,
  level: number,
  stage?: string,
  maxMoves = 4,
): string[] {
  const monster = db.monster[slug];
  if (!monster) throw new Error(`battle: unknown monster '${slug}'`);
  const currentStage = stage ?? monster.stage;
  // Upstream's eligibility lookup deliberately uses the first schedule row
  // for a technique, even while iterating duplicate rows in the schedule.
  const eligible = monster.moveset.filter((entry) => {
    const first = monster.moveset.find((candidate) => candidate.technique === entry.technique)!;
    return first.learning_method === "level_up"
      && first.level_learned <= level
      && (first.evolution_stage_learned === undefined
        || first.evolution_stage_learned === currentStage);
  }).map((entry) => entry.technique).slice(-maxMoves);
  // MonsterMovesHandler.learn skips a duplicate technique after the final
  // max-moves slice has already happened.
  return eligible.filter((technique, index) => eligible.indexOf(technique) === index);
}
