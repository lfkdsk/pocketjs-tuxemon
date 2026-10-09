import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  applyTasteSnapshot,
  chooseTaste,
  devolveMonsterSnapshot,
  dojoDevolutionTargets,
  dojoLearnableMoves,
  relearnMonsterSnapshot,
  tasteChangeAvailable,
} from "../battle/dojo.ts";
import { battleDbToTuxemonBattleDb } from "../battle/from-battle-db.ts";
import { TUXEMON_BATTLE_DB } from "../battle/game.ts";
import { spawnMonster, spawnMonsterWithRandom } from "../battle/spawn.ts";
import { calculateBaseStats, zeroStats } from "../battle/stats.ts";
import { TUXEMON_SRC } from "../importer/source.ts";

const DB = TUXEMON_BATTLE_DB;
const RULES = battleDbToTuxemonBattleDb(DB);

interface SourceMonster {
  stage: string;
  moveset: Array<{ technique: string; level_learned: number }>;
  history?: Array<{ slug: string; stage: string; evolves_into?: string[] }>;
}

function sourceMonster(slug: string): SourceMonster {
  const path = join(TUXEMON_SRC, "mods/tuxemon/db/monster", `${slug}.yaml`);
  return Bun.YAML.parse(readFileSync(path, "utf8")) as SourceMonster;
}

describe("Dojo rules against the pinned upstream data", () => {
  test("devolution forms match dojo_method's history scan for every imported monster", () => {
    // tuxemon/event/actions/dojo_method.py: history entries that evolve into
    // the monster, basic for stage1 and stage1/basic for stage2.
    let offered = 0;
    for (const slug of Object.keys(DB.monsters).sort()) {
      const source = sourceMonster(slug);
      const wanted = (source.history ?? []).filter((entry) =>
        (entry.evolves_into ?? []).includes(slug)
        && ((source.stage === "stage1" && entry.stage === "basic")
          || (source.stage === "stage2" && ["stage1", "basic"].includes(entry.stage)))
        && entry.slug in DB.monsters).map((entry) => entry.slug).sort();
      const actual = dojoDevolutionTargets(DB, { slug, stage: DB.monsters[slug]!.stage });
      expect([...actual].sort()).toEqual(wanted);
      offered += actual.length;
    }
    expect(offered).toBe(128);
  });

  test("learnable moves are the unknown moveset rows at or below the level", () => {
    for (const slug of ["rockitten", "aardart", "budaye"]) {
      const source = sourceMonster(slug);
      for (const level of [1, 7, 20, 60]) {
        const monster = spawnMonster(DB, RULES, { rng: level, rngDraws: 0 }, slug, level, { iid: slug });
        const wanted = [...new Set(source.moveset
          .filter((row) => row.level_learned <= level && !monster.moves.includes(row.technique))
          .map((row) => row.technique))];
        expect(dojoLearnableMoves(DB, monster)).toEqual(wanted);
      }
    }
  });

  test("forgetting re-offers the forgotten move and learning appends", () => {
    const monster = spawnMonster(DB, RULES, { rng: 3, rngDraws: 0 }, "rockitten", 20, { iid: "r" });
    expect(dojoLearnableMoves(DB, monster, "assault")).toContain("assault");
    const updated = relearnMonsterSnapshot(monster, "assault", "ram");
    expect(updated.moves).toEqual(monster.moves.filter((move) => move !== "assault").concat("ram"));
  });

  test("random taste choice is rarity-weighted over the other tastes of that type", () => {
    const monster = spawnMonster(DB, RULES, { rng: 9, rngDraws: 0 }, "aardart", 10, { iid: "a" });
    const pool = DB.tasteOrder.filter((slug) => DB.tastes[slug]!.type === "cold"
      && slug !== monster.tasteCold && slug !== "tasteless");
    const total = pool.reduce((sum, slug) => sum + DB.tastes[slug]!.rarity, 0);
    // random.choices: bisect the cumulative weights at random() * total.
    let cumulative = 0;
    for (const slug of pool) {
      const before = cumulative;
      cumulative += DB.tastes[slug]!.rarity;
      const draw = (before + cumulative) / 2 / total;
      expect(chooseTaste(DB, monster, "cold", "random", () => draw)).toBe(slug);
    }
    expect(chooseTaste(DB, monster, "warm", pool[0]!, () => 0)).toBeNull();
    expect(chooseTaste(DB, monster, "cold", "tasteless", () => 0)).toBeNull();
    expect(tasteChangeAvailable(DB, monster, "cold", "random")).toBeTrue();
  });

  test("a taste change recalculates stats and keeps HP within the new maximum", () => {
    const monster = spawnMonster(DB, RULES, { rng: 4, rngDraws: 0 }, "aardart", 30, { iid: "a" });
    const cold = DB.tasteOrder.find((slug) => DB.tastes[slug]!.type === "cold" && DB.tastes[slug]!.stat === "hp"
      && DB.tastes[slug]!.multiplier < 1)!;
    const changed = applyTasteSnapshot(RULES, monster, "cold", cold);
    expect(changed.base).toEqual(calculateBaseStats(
      RULES, monster.slug, monster.level, monster.individualValues, cold, monster.tasteWarm, monster.trainingPoints,
    ));
    expect(changed.currentHp).toBe(Math.min(monster.currentHp!, changed.base.hp));
  });

  test("devolution keeps persistent state while matching upstream's pre-transfer stat order", () => {
    const spawned = spawnMonster(DB, RULES, { rng: 5, rngDraws: 0 }, "aardart", 25, { iid: "keep" });
    const trainingPoints = { ...spawned.trainingPoints!, hp: 47, melee: 31, speed: 19 };
    const trainedBase = calculateBaseStats(
      RULES,
      spawned.slug,
      spawned.level,
      spawned.individualValues,
      spawned.tasteCold,
      spawned.tasteWarm,
      trainingPoints,
    );
    const monster = {
      ...spawned,
      nickname: "Ant",
      trainingPoints,
      base: trainedBase,
      currentHp: trainedBase.hp - 9,
      status: "poison",
    };

    // transfer_properties_from calls set_stats before copying the old IVs
    // and training points. Reproduce the target's fresh RNG draws so this
    // counter-intuitive immediate base value is pinned to the upstream order.
    let expectedDraws = 0;
    const freshTarget = spawnMonsterWithRandom(
      DB,
      RULES,
      () => (expectedDraws++ % 7) / 7,
      "aardorn",
      monster.level,
      { iid: monster.iid },
    );
    const expectedBase = calculateBaseStats(
      RULES,
      "aardorn",
      monster.level,
      freshTarget.individualValues,
      monster.tasteCold,
      monster.tasteWarm,
      zeroStats(),
    );

    let draws = 0;
    const devolved = devolveMonsterSnapshot(DB, RULES, monster, "aardorn", () => (draws++ % 7) / 7);
    expect(devolved).toMatchObject({
      iid: "keep",
      nickname: "Ant",
      slug: "aardorn",
      stage: "basic",
      level: 25,
      totalExperience: monster.totalExperience,
      tasteCold: monster.tasteCold,
      tasteWarm: monster.tasteWarm,
      individualValues: monster.individualValues,
      trainingPoints,
      status: "poison",
      moves: monster.moves,
      waitingToEvolve: false,
    });
    expect(devolved.base).toEqual(expectedBase);
    expect(devolved.base).not.toEqual(calculateBaseStats(
      RULES,
      "aardorn",
      monster.level,
      monster.individualValues,
      monster.tasteCold,
      monster.tasteWarm,
      trainingPoints,
    ));
    expect(devolved.currentHp).toBe(Math.min(monster.currentHp, expectedBase.hp));
    // Monster.spawn_base draws thirteen values before the transfer.
    expect(draws).toBeGreaterThanOrEqual(13);
  });
});
