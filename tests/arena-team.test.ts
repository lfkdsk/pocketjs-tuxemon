import { describe, expect, test } from "bun:test";

import {
  createArenaBattle,
  replay,
  stateHash,
  tape,
  validateTeam,
  type ArenaTeamRecord,
} from "../battle/arena.ts";
import { buildValidatedArenaTeam } from "../battle/arena-team.ts";

const BATTLE_SEED = "0123456789abcdef".repeat(4);
const ACQUIRE_SEED = "fedcba9876543210".repeat(4);

function rockitten(seq = 1): ArenaTeamRecord {
  return {
    species: "rockitten",
    level: 10,
    moves: ["ram", "boulder", "mudslide", "assault"],
    provenance: [{
      seq,
      type: "acquire",
      seed: ACQUIRE_SEED,
      species: "rockitten",
      level: 10,
    }],
  };
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

describe("Arena persistent team validation", () => {
  test("rebuilds a valid team from provenance and round-trips it through the battle tape", () => {
    const team = [rockitten()];
    expect(validateTeam(team)).toEqual({ ok: true, errors: [] });

    const battle = createArenaBattle({
      seed: BATTLE_SEED,
      format: "single",
      sides: [{ kind: "agent", team }, { kind: "ai", difficulty: "normal" }],
    });
    const member = battle.core.parties[0][0]!;
    expect(member).toMatchObject({
      slug: "rockitten",
      level: 10,
      moves: team[0]!.moves.map((slug) => ({ slug, cooldown: 0 })),
    });
    expect(member.base.hp).toBeGreaterThan(0);
    expect(member.trainingPoints).toEqual({ armour: 0, dodge: 0, hp: 0, melee: 0, ranged: 0, speed: 0 });

    const recording = tape(battle);
    expect(recording.config.sides[0]).toEqual({ kind: "agent", team });
    expect(stateHash(replay(recording))).toBe(stateHash(battle));
  });

  test("replays level, legal move, TM, and training-item events before deriving stats", () => {
    const learned: ArenaTeamRecord = {
      species: "rockitten",
      level: 4,
      moves: ["ram", "mudslide", "acid"],
      provenance: [
        { seq: 10, type: "acquire", seed: ACQUIRE_SEED, species: "rockitten", level: 1 },
        { seq: 11, type: "level", level: 2 },
        { seq: 12, type: "level", level: 3 },
        { seq: 13, type: "level", level: 4 },
        { seq: 14, type: "learn", move: "mudslide", forget: "boulder" },
        { seq: 15, type: "item", item: "tm_acid" },
        { seq: 16, type: "item", item: "raise_melee" },
      ],
    };
    expect(validateTeam([learned])).toEqual({ ok: true, errors: [] });
    const trained = buildValidatedArenaTeam([learned])[0]!;
    const untrainedRecord = clone(learned);
    untrainedRecord.provenance.pop();
    const untrained = buildValidatedArenaTeam([untrainedRecord])[0]!;
    expect(trained.trainingPoints!.melee).toBe(50);
    expect(trained.base.melee).toBeGreaterThan(untrained.base.melee);
    expect(trained.moves).toEqual(["ram", "mudslide", "acid"]);
  });

  test("applies match limits and deterministic uniform-level reconstruction", () => {
    const record = rockitten();
    expect(validateTeam([record], { minSize: 2 })).toEqual({
      ok: false,
      errors: ["team size must be 2..5"],
    });
    expect(validateTeam([record], { bannedSpecies: ["rockitten"] }).ok).toBe(false);
    expect(validateTeam([record], { bannedMoves: ["assault"] }).ok).toBe(false);
    const scaled = buildValidatedArenaTeam([record], { uniformLevel: 20 })[0]!;
    expect(scaled.level).toBe(20);
    expect(scaled.moves).toEqual(record.moves);
    expect(scaled.base.hp).toBeGreaterThan(buildValidatedArenaTeam([record])[0]!.base.hp);
  });

  test("rejects claimed stats and every tampered progression surface", () => {
    const valid = rockitten();
    const forged: unknown[] = [];

    forged.push({ ...clone(valid), base: { hp: 999_999 } });

    const level = clone(valid);
    level.level = 99;
    forged.push(level);

    const moves = clone(valid);
    moves.moves[0] = "power_theft";
    forged.push(moves);

    const species = clone(valid);
    const acquisition = species.provenance[0]!;
    if (acquisition.type !== "acquire") throw new Error("fixture acquisition missing");
    species.provenance[0] = { ...acquisition, species: "nut" };
    forged.push(species);

    const sequence = clone(valid);
    sequence.provenance.push({ seq: 1, type: "level", level: 11 });
    sequence.level = 11;
    forged.push(sequence);

    const injectedItem = clone(valid) as unknown as Record<string, unknown>;
    (injectedItem.provenance as unknown[]).push({
      seq: 2,
      type: "item",
      item: "raise_melee",
      amount: 999_999,
    });
    forged.push(injectedItem);

    for (const [index, record] of forged.entries()) {
      const checked = validateTeam([record]);
      expect(checked.ok, `forgery ${index} was accepted`).toBe(false);
      expect(() => createArenaBattle({
        seed: BATTLE_SEED,
        format: "single",
        sides: [
          { kind: "agent", team: [record] } as never,
          { kind: "ai", difficulty: "normal" },
        ],
      })).toThrow();
    }
  });

  test("requires globally unique increasing server sequences", () => {
    const duplicate = [rockitten(7), rockitten(7)];
    const checked = validateTeam(duplicate);
    expect(checked.ok).toBe(false);
    if (!checked.ok) expect(checked.errors.some((error) => error.includes("unique"))).toBe(true);
  });
});
