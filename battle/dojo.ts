// Spyder Dojo services: the monks' `dojo_method` (re-learn a technique or
// devolve) and `change_taste`. Pure snapshot transforms; the event wiring
// lives in battle/extension.ts and the importer's lowering.
//
// Upstream references (pinned source):
//   tuxemon/event/actions/dojo_method.py   learnable moves, devolution menu
//   tuxemon/event/actions/change_taste.py  random/explicit taste change
//   tuxemon/monster/monster.py             spawn_base, transfer_properties_from
//   tuxemon/taste.py                       get_random_taste_excluding

import type { BattleDb } from "../importer/battle-schema.ts";
import { weightedTaste } from "./daycare.ts";
import { transferToSpecies } from "./progression.ts";
import { calculateBaseStats, monsterFromSnapshot } from "./stats.ts";
import type { SpawnedMonsterSnapshot, TuxemonBattleDb } from "./types.ts";

export type TasteType = "cold" | "warm";

/** dojo_method technique: every moveset row the monster does not know whose
 *  level_learned is at or below its level, in moveset order. Upstream does
 *  not filter by learning method or evolution stage, so the fallback move
 *  (normally Struggle) is offered too. Duplicate rows collapse to the first
 *  (upstream would list the same technique twice), and techniques the port's
 *  battle database does not carry are skipped. */
export function dojoLearnableMoves(
  db: BattleDb,
  monster: Pick<SpawnedMonsterSnapshot, "slug" | "level" | "moves">,
  forgotten?: string,
): string[] {
  const species = db.monsters[monster.slug];
  if (!species) return [];
  const known = new Set(monster.moves);
  if (forgotten !== undefined) known.delete(forgotten);
  const result: string[] = [];
  for (const row of species.moveset) {
    if (row.level > monster.level || known.has(row.technique)) continue;
    if (!db.techniques[row.technique] || result.includes(row.technique)) continue;
    result.push(row.technique);
  }
  return result;
}

/** dojo_method monster: the history entries that evolve into this monster,
 *  limited to basic for a stage1 monster and to stage1/basic for a stage2
 *  one. The importer's `evolvesFrom` is the history's own evolves_from list;
 *  on the pinned data it selects exactly the same parents as upstream's
 *  `slug in history.evolves_into` scan. Forms the port does not import are
 *  skipped. */
export function dojoDevolutionTargets(
  db: BattleDb,
  monster: Pick<SpawnedMonsterSnapshot, "slug" | "stage">,
): string[] {
  const species = db.monsters[monster.slug];
  if (!species) return [];
  const allowed = monster.stage === "stage1"
    ? ["basic"]
    : monster.stage === "stage2"
      ? ["stage1", "basic"]
      : [];
  return species.evolvesFrom.filter((parent) => {
    const stage = db.monsters[parent]?.stage;
    return stage !== undefined && allowed.includes(stage);
  });
}

/** devolve(): Monster.spawn_base(target, level), transfer_properties_from(old)
 *  and evolve_monster (evolution-method moves), the same chain evolution
 *  uses. Nickname, level, experience, tastes, IVs, TPs, status and known
 *  moves carry over. Current HP is copied as an absolute value and clamped
 *  to the new maximum. */
export function devolveMonsterSnapshot(
  sourceDb: BattleDb,
  rulesDb: TuxemonBattleDb,
  monster: SpawnedMonsterSnapshot,
  target: string,
  random: () => number,
): SpawnedMonsterSnapshot {
  return transferToSpecies(sourceDb, rulesDb, monsterFromSnapshot(rulesDb, 1, monster), target, random);
}

/** get_tech + set_var: forget one known technique, then learn one learnable
 *  technique (appended last; the moveset may exceed max_moves exactly as
 *  upstream's ignore_eligibility learn does). */
export function relearnMonsterSnapshot(
  monster: SpawnedMonsterSnapshot,
  forget: string,
  learn: string,
): SpawnedMonsterSnapshot {
  const index = monster.moves.indexOf(forget);
  const moves = index < 0 ? [...monster.moves] : monster.moves.filter((_, i) => i !== index);
  if (!moves.includes(learn)) moves.push(learn);
  return { ...monster, moves };
}

/** The new taste change_taste would assign, or null when upstream stops
 *  without a change. `wanted` is a taste slug or "random" (rarity-weighted,
 *  excluding the current taste and "tasteless"). */
export function chooseTaste(
  db: BattleDb,
  monster: Pick<SpawnedMonsterSnapshot, "tasteCold" | "tasteWarm">,
  type: TasteType,
  wanted: string,
  random: () => number,
): string | null {
  if (wanted === "tasteless") return null;
  if (wanted === "random") {
    const old = type === "cold" ? monster.tasteCold : monster.tasteWarm;
    return weightedTaste(db, type, new Set([old, "tasteless"]), random);
  }
  return db.tastes[wanted]?.type === type ? wanted : null;
}

/** Whether chooseTaste can return a taste, without drawing randomness. */
export function tasteChangeAvailable(
  db: BattleDb,
  monster: Pick<SpawnedMonsterSnapshot, "tasteCold" | "tasteWarm">,
  type: TasteType,
  wanted: string,
): boolean {
  if (wanted === "tasteless") return false;
  if (wanted !== "random") return db.tastes[wanted]?.type === type;
  const old = type === "cold" ? monster.tasteCold : monster.tasteWarm;
  return db.tasteOrder.some((slug) => {
    const taste = db.tastes[slug];
    return taste?.type === type && slug !== old && slug !== "tasteless" && taste.rarity > 0;
  });
}

/** setattr(taste) + Monster.set_stats(). Stats are recalculated with the
 *  monster's own IVs and TPs. Upstream leaves current HP alone; the port's
 *  snapshot invariant keeps it within max HP, so a lower max clamps it. */
export function applyTasteSnapshot(
  rulesDb: TuxemonBattleDb,
  monster: SpawnedMonsterSnapshot,
  type: TasteType,
  taste: string,
): SpawnedMonsterSnapshot {
  const tasteCold = type === "cold" ? taste : monster.tasteCold;
  const tasteWarm = type === "warm" ? taste : monster.tasteWarm;
  const base = calculateBaseStats(
    rulesDb,
    monster.slug,
    monster.level,
    monster.individualValues,
    tasteCold,
    tasteWarm,
    monster.trainingPoints,
  );
  const currentHp = Math.min(monster.currentHp ?? base.hp, base.hp);
  return { ...monster, tasteCold, tasteWarm, base, currentHp };
}
