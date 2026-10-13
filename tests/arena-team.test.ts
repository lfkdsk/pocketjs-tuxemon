import { describe, expect, test } from "bun:test";

import {
  DEFAULT_ARENA_TEAM_RULES,
  createArenaBattle,
  defaultAction,
  isOver,
  replay,
  stateHash,
  submit,
  tape,
  validateBattleTape,
  validateTeam,
  type ArenaTeamRecord,
} from "../battle/arena.ts";
import {
  arenaTeamRecordFromProvenance,
  buildValidatedArenaTeam,
  type ArenaProvenanceEvent,
} from "../battle/arena-team.ts";

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
  test("reconstructs expedition XP, derived levels and moves without losing partial experience", () => {
    const provenance: ArenaProvenanceEvent[] = [
      {
        seq: 1,
        type: "acquire",
        seed: ACQUIRE_SEED,
        species: "rockitten",
        level: 1,
        origin: {
          kind: "expedition",
          area: "spyder_route1",
          step: 0,
          capture: { result: "starter" },
        },
      },
      { seq: 2, type: "item", item: "tea", step: 1 },
      { seq: 3, type: "experience", step: 1, amount: 500, source: { kind: "item", item: "tea" } },
      ...Array.from({ length: 6 }, (_, index): ArenaProvenanceEvent => ({
        seq: index + 4,
        type: "level",
        level: index + 2,
        step: 1,
      })),
      { seq: 10, type: "learn", move: "mudslide", step: 1 },
      { seq: 11, type: "learn", move: "assault", step: 1 },
      { seq: 12, type: "item", item: "raise_melee", step: 2 },
    ];
    const record = arenaTeamRecordFromProvenance("rockitten", provenance, { levelCap: 20 });
    expect(record).toMatchObject({
      level: 7,
      experience: 501,
      moves: ["ram", "boulder", "mudslide", "assault"],
    });
    expect(validateTeam([record], { levelCap: 20 })).toEqual({ ok: true, errors: [] });
    const snapshot = buildValidatedArenaTeam([record], { levelCap: 20 })[0]!;
    expect(snapshot.totalExperience).toBe(501);
    expect(snapshot.trainingPoints?.melee).toBe(50);

    const changedXp = clone(record);
    const xp = changedXp.provenance[2];
    if (xp?.type !== "experience") throw new Error("experience fixture missing");
    xp.amount++;
    expect(validateTeam([changedXp], { levelCap: 20 }).ok).toBe(false);

    const missingAudit = clone(record);
    missingAudit.provenance.splice(4, 1);
    expect(validateTeam([missingAudit], { levelCap: 20 }).ok).toBe(false);

    const changedClaim = clone(record);
    changedClaim.experience!++;
    expect(validateTeam([changedClaim], { levelCap: 20 }).ok).toBe(false);
  });

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
      moves: ["ram", "boulder", "mudslide", "acid"],
      provenance: [
        { seq: 10, type: "acquire", seed: ACQUIRE_SEED, species: "rockitten", level: 1 },
        { seq: 11, type: "level", level: 2 },
        { seq: 12, type: "level", level: 3 },
        { seq: 13, type: "level", level: 4 },
        { seq: 14, type: "learn", move: "mudslide" },
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
    expect(trained.moves).toEqual(["ram", "boulder", "mudslide", "acid"]);
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

    const battle = createArenaBattle({
      seed: BATTLE_SEED,
      format: "single",
      sides: [{ kind: "agent", team: [record] }, { kind: "ai", difficulty: "normal" }],
      teamRules: { uniformLevel: 20 },
    });
    expect(battle.core.parties[0][0]!.level).toBe(20);
    expect(tape(battle).config.teamRules).toEqual({ uniformLevel: 20 });
    expect(stateHash(replay(tape(battle)))).toBe(stateHash(battle));
  });

  test("enforces TM target conditions and real four-move replacement rules", () => {
    const restricted = rockitten();
    restricted.moves = ["boulder", "mudslide", "assault", "altitude"];
    restricted.provenance.push({ seq: 2, type: "item", item: "tm_altitude", forget: "ram" });
    expect(validateTeam([restricted]).ok).toBe(false);

    const early: ArenaTeamRecord = {
      species: "rockitten",
      level: 4,
      moves: ["ram", "mudslide"],
      provenance: [
        { seq: 20, type: "acquire", seed: ACQUIRE_SEED, species: "rockitten", level: 1 },
        { seq: 21, type: "level", level: 2 },
        { seq: 22, type: "level", level: 3 },
        { seq: 23, type: "level", level: 4 },
        { seq: 24, type: "learn", move: "mudslide", forget: "boulder" },
      ],
    };
    expect(validateTeam([early]).ok).toBe(false);
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

  test("returns errors for prototype-name slugs and bounded oversized JSON", () => {
    for (const species of ["toString", "__proto__"]) {
      const record = rockitten() as unknown as Record<string, unknown>;
      record.species = species;
      (record.provenance as Array<Record<string, unknown>>)[0]!.species = species;
      let checked: ReturnType<typeof validateTeam> | undefined;
      expect(() => { checked = validateTeam([record]); }).not.toThrow();
      expect(checked?.ok).toBe(false);
    }

    const item = rockitten();
    item.provenance.push({ seq: 2, type: "item", item: "toString" });
    expect(() => validateTeam([item])).not.toThrow();
    expect(validateTeam([item]).ok).toBe(false);

    expect(validateTeam(Array.from({ length: 6 }, () => rockitten())).ok).toBe(false);
    const moves = rockitten() as unknown as Record<string, unknown>;
    moves.moves = Array.from({ length: 100_000 }, () => "ram");
    expect(validateTeam([moves]).ok).toBe(false);
    const provenance = rockitten() as unknown as Record<string, unknown>;
    provenance.provenance = Array.from({ length: 1_025 }, (_, seq) => ({ seq: seq + 1, type: "level", level: 11 }));
    expect(validateTeam([provenance]).ok).toBe(false);
  });

  test("freezes exported defaults and replays a terminal custom-team tape", () => {
    expect(Object.isFrozen(DEFAULT_ARENA_TEAM_RULES)).toBe(true);
    expect(Object.isFrozen(DEFAULT_ARENA_TEAM_RULES.bannedSpecies)).toBe(true);
    expect(Object.isFrozen(DEFAULT_ARENA_TEAM_RULES.bannedMoves)).toBe(true);
    expect(Object.isFrozen(DEFAULT_ARENA_TEAM_RULES.bannedItems)).toBe(true);

    let battle = createArenaBattle({
      seed: BATTLE_SEED,
      format: "single",
      sides: [
        { kind: "agent", team: [rockitten(101)] },
        { kind: "agent", team: [rockitten(202)] },
      ],
    });
    while (!isOver(battle)) {
      const first = submit(battle, 0, defaultAction(battle, 0));
      if (!first.ok) throw new Error(first.error);
      const second = submit(first.battle, 1, defaultAction(first.battle, 1));
      if (!second.ok) throw new Error(second.error);
      battle = second.battle;
    }
    const recording = tape(battle);
    expect(recording.actions.length).toBeGreaterThan(0);
    expect(stateHash(replay(JSON.parse(JSON.stringify(recording))))).toBe(stateHash(battle));

    const tampered = clone(recording);
    const side = tampered.config.sides[0];
    if (side.kind !== "agent" || !("team" in side)) throw new Error("custom team tape missing");
    side.team[0]!.moves[0] = "power_theft";
    expect(validateBattleTape(tampered).ok).toBe(false);
  });
});
