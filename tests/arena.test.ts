import { describe, expect, test } from "bun:test";

import {
  ARENA_DIFFICULTIES,
  ARENA_MAX_TURNS,
  createArenaBattle,
  defaultAction,
  isOver,
  observe,
  replay,
  result,
  stateHash,
  submit,
  tape,
  validateBattleTape,
  type ArenaAction,
  type ArenaBattle,
  type ArenaDifficulty,
} from "../battle/arena.ts";
import { canonicalJson } from "../vendor/pocket-rpgkit/src/engine/save.ts";

const SEED = "0123456789abcdef".repeat(4);

function config(
  sides: ArenaBattle["config"]["sides"] = [{ kind: "agent" }, { kind: "agent" }],
  format: "single" | "double" = "single",
  seed = SEED,
) {
  return { seed, format, sides };
}

function settleAgentPair(
  battle: ArenaBattle,
  first: 0 | 1 = 0,
  actions?: [ArenaAction, ArenaAction],
): ArenaBattle {
  const pair = actions ?? [defaultAction(battle, 0), defaultAction(battle, 1)];
  const a = submit(battle, first, pair[first]);
  if (!a.ok) throw new Error(a.error);
  const second = first === 0 ? 1 : 0;
  const b = submit(a.battle, second, pair[second]);
  if (!b.ok) throw new Error(b.error);
  return b.battle;
}

function playAgentVsAi(seed: string, difficulty: ArenaDifficulty, format: "single" | "double", random: () => number) {
  let battle = createArenaBattle(config([
    { kind: "agent" },
    { kind: "ai", difficulty },
  ], format, seed));
  while (!isOver(battle)) {
    const choices = observe(battle, 0).legalActions;
    const action = choices[Math.floor(random() * choices.length)]!;
    const submitted = submit(battle, 0, action);
    if (!submitted.ok) throw new Error(submitted.error);
    battle = submitted.battle;
  }
  return battle;
}

function collectKeys(value: unknown, keys = new Set<string>()): Set<string> {
  if (Array.isArray(value)) {
    for (const entry of value) collectKeys(entry, keys);
  } else if (value !== null && typeof value === "object") {
    for (const [key, entry] of Object.entries(value)) {
      keys.add(key);
      collectKeys(entry, keys);
    }
  }
  return keys;
}

describe("headless Arena battle API", () => {
  test("requires a 64-hex seed and deterministically applies all five title recipes", () => {
    for (const [index, difficulty] of ARENA_DIFFICULTIES.entries()) {
      const battle = createArenaBattle(config([
        { kind: "agent", difficulty },
        { kind: "ai", difficulty },
      ]));
      expect(battle.core.parties[0]).toHaveLength(index + 1);
      expect(battle.core.parties[1]).toHaveLength(index + 1);
      expect(battle.core.parties[0].every((monster) => monster.level === 10 + index * 5)).toBe(true);
      expect(stateHash(createArenaBattle(config([
        { kind: "agent", difficulty },
        { kind: "ai", difficulty },
      ])))).toBe(stateHash(battle));
    }
    expect(() => createArenaBattle(config(undefined, "single", "0".repeat(63)))).toThrow();
    expect(() => createArenaBattle(config(undefined, "single", "z".repeat(64)))).toThrow();
    expect(stateHash(createArenaBattle(config()))).not.toBe(
      stateHash(createArenaBattle(config(undefined, "single", "f".repeat(64)))),
    );
  });

  test("one submission remains private and only the pair settles in canonical order", () => {
    const initial = createArenaBattle(config());
    const beforeCore = canonicalJson(initial.core);
    const beforeOpponent = canonicalJson(observe(initial, 1));
    const action0 = defaultAction(initial, 0);
    const action1 = defaultAction(initial, 1);

    const first = submit(initial, 0, action0);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.resolved).toBe(false);
    expect(first.battle.turn).toBe(0);
    expect(first.battle.actions).toEqual([]);
    expect(canonicalJson(first.battle.core)).toBe(beforeCore);
    expect(canonicalJson(observe(first.battle, 1))).toBe(beforeOpponent);
    expect(() => tape(first.battle)).toThrow("unpaired submission");

    const duplicate = submit(first.battle, 0, action0);
    expect(duplicate).toEqual({ ok: false, battle: first.battle, error: "ALREADY_SUBMITTED" });

    const second = submit(first.battle, 1, action1);
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.resolved).toBe(true);
    expect(second.battle.turn).toBe(1);
    expect(second.battle.actions).toEqual([[action0, action1]]);

    const reverse = settleAgentPair(createArenaBattle(config()), 1, [action0, action1]);
    expect(stateHash(reverse)).toBe(stateHash(second.battle));
  });

  test("observation structurally hides opponent reserves, RNG, and pending actions at every boundary", () => {
    let battle = createArenaBattle(config([
      { kind: "agent", difficulty: "expert" },
      { kind: "agent", difficulty: "expert" },
    ], "double"));
    const forbidden = ["seed", "rng", "rngDraws", "queue", "pending", "actions", "decisionQueue"];
    for (let window = 0; window < 12 && !isOver(battle); window++) {
      for (const side of [0, 1] as const) {
        const view = observe(battle, side);
        expect(Object.keys(view).sort()).toEqual([
          "actingParty", "deadlineTicks", "format", "legalActions", "opponent",
          "own", "result", "round", "side", "turn", "v",
        ]);
        expect(view.own.party).toHaveLength(5);
        expect(Object.keys(view.opponent)).toEqual(["active"]);
        expect(view.opponent.active.length).toBeLessThanOrEqual(2);
        expect(view.opponent.active.length).toBeLessThan(battle.core.parties[side === 0 ? 1 : 0].length);
        for (const active of view.opponent.active) {
          expect(Object.keys(active).sort()).toEqual([
            "hpPercent", "level", "position", "revealedMoves", "species", "status",
          ]);
        }
        const keys = collectKeys(view);
        for (const key of forbidden) expect(keys.has(key), `${key} leaked`).toBe(false);
      }
      const before = canonicalJson(observe(battle, 0));
      const hidden = defaultAction(battle, 1);
      const one = submit(battle, 1, hidden);
      expect(one.ok).toBe(true);
      if (!one.ok) return;
      expect(canonicalJson(observe(one.battle, 0))).toBe(before);
      const two = submit(one.battle, 0, defaultAction(one.battle, 0));
      expect(two.ok).toBe(true);
      if (!two.ok) return;
      battle = two.battle;
    }
  });

  test("resolved techniques become visible, but never before their reducer round resolves", () => {
    let battle = createArenaBattle(config(undefined, "double"));
    const firstOpponentAction = defaultAction(battle, 1);
    expect(firstOpponentAction.type).toBe("move");
    const first = submit(battle, 1, firstOpponentAction);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(observe(first.battle, 0).opponent.active.flatMap((monster) => monster.revealedMoves)).toEqual([]);
    const second = submit(first.battle, 0, defaultAction(first.battle, 0));
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    battle = second.battle;
    // Normal teams have two active monsters in a double. The first paired
    // slot is queued but remains hidden until the second pair resolves it.
    expect(observe(battle, 0).opponent.active.flatMap((monster) => monster.revealedMoves)).toEqual([]);
    battle = settleAgentPair(battle);
    expect(observe(battle, 0).opponent.active.flatMap((monster) => monster.revealedMoves).length).toBeGreaterThan(0);
  });

  test("malformed and illegal JSON never throws or changes state", () => {
    const battle = createArenaBattle(config());
    const hash = stateHash(battle);
    const malformed: unknown[] = [
      null, true, false, 0, 1, "move", [], ["move"], {},
      { type: "unknown" }, { type: "run", extra: true },
      { type: "move" }, { type: "move", slot: -1 }, { type: "move", slot: 4 },
      { type: "move", slot: 0.5 }, { type: "move", slot: Number.NaN },
      { type: "move", slot: 99, target: 0 }, { type: "move", slot: 0, target: -1 },
      { type: "swap" }, { type: "swap", party: -1 }, { type: "swap", party: 999 },
      { type: "item" }, { type: "item", item: "" }, { type: "item", item: "missing", target: 0 },
    ];
    for (let index = 0; index < 1_000; index++) {
      const value = cloneMalformed(malformed[index % malformed.length]!, index);
      let answer: ReturnType<typeof submit> | undefined;
      expect(() => { answer = submit(battle, 0, value); }).not.toThrow();
      expect(answer?.ok).toBe(false);
      expect(answer && !answer.ok ? answer.battle : null).toBe(battle);
      expect(stateHash(battle)).toBe(hash);
    }
    const legal = new Set(observe(battle, 0).legalActions.map(canonicalJson));
    let fuzzState = 0xa11ce5ed;
    const random = () => {
      fuzzState = (Math.imul(fuzzState, 1_664_525) + 1_013_904_223) >>> 0;
      return fuzzState / 4_294_967_296;
    };
    for (let index = 0; index < 1_000; index++) {
      let value = randomJson(random, 3);
      if (legal.has(canonicalJson(value))) value = { value, fuzz: index };
      let answer: ReturnType<typeof submit> | undefined;
      expect(() => { answer = submit(battle, 0, value); }).not.toThrow();
      expect(answer?.ok, `random JSON sample ${index} was accepted`).toBe(false);
      expect(answer && !answer.ok ? answer.battle : null).toBe(battle);
      expect(stateHash(battle)).toBe(hash);
    }
    expect(submit(battle, 9, { type: "run" })).toEqual({
      ok: false,
      battle,
      error: "INVALID_SIDE",
    });
    expect(submit(battle, 0, { type: "swap", party: 999 })).toEqual({
      ok: false,
      battle,
      error: "ILLEGAL_ACTION",
    });
    const ai = createArenaBattle(config([{ kind: "agent" }, { kind: "ai", difficulty: "normal" }]));
    expect(submit(ai, 1, defaultAction(ai, 1))).toEqual({ ok: false, battle: ai, error: "SIDE_NOT_AGENT" });
  }, 15_000);

  test("accepts a value-equal legal swap and records it only after the pair settles", () => {
    const battle = createArenaBattle(config([
      { kind: "agent", difficulty: "expert" },
      { kind: "agent", difficulty: "expert" },
    ]));
    const swap = observe(battle, 0).legalActions.find((action) => action.type === "swap");
    expect(swap).toBeDefined();
    const first = submit(battle, 0, JSON.parse(JSON.stringify(swap)));
    expect(first.ok).toBe(true);
    if (!first.ok || !swap) return;
    expect(first.resolved).toBe(false);
    const second = submit(first.battle, 1, defaultAction(first.battle, 1));
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.battle.actions[0]?.[0]).toEqual(swap);
  });

  test("the explicit turn cap ends deterministically and rejects post-terminal submissions", () => {
    const initial = createArenaBattle(config());
    const nearLimit = { ...initial, turn: ARENA_MAX_TURNS - 1 };
    const ended = settleAgentPair(nearLimit);
    expect(isOver(ended)).toBe(true);
    expect(result(ended)).toEqual({ winner: null, turns: ARENA_MAX_TURNS, reason: "turn-limit" });
    const rejected = submit(ended, 0, { type: "move", slot: 0 });
    expect(rejected).toEqual({ ok: false, battle: ended, error: "BATTLE_OVER" });
  });

  test("versioned tapes validate strictly and replay canonical terminal bytes", () => {
    let battle = createArenaBattle(config([{ kind: "agent" }, { kind: "ai", difficulty: "hard" }]));
    while (!isOver(battle)) {
      const submitted = submit(battle, 0, defaultAction(battle, 0));
      if (!submitted.ok) throw new Error(submitted.error);
      battle = submitted.battle;
    }
    const recording = tape(battle);
    const wire = JSON.parse(JSON.stringify(recording));
    expect(validateBattleTape(wire)).toEqual({ ok: true, tape: recording });
    const replayed = replay(wire);
    expect(canonicalJson(replayed)).toBe(canonicalJson(battle));
    expect(stateHash(replayed)).toBe(stateHash(battle));
    expect(stateHash(battle)).toMatch(/^[0-9a-f]{64}$/);

    for (const invalid of [
      { ...recording, v: 2 },
      { ...recording, extra: true },
      { ...recording, seed: "0".repeat(63) },
      { ...recording, actions: [[{ type: "move", slot: 0 }]] },
      { ...recording, actions: [[{ type: "move", slot: 7 }, { type: "run" }]] },
    ]) {
      expect(validateBattleTape(invalid).ok).toBe(false);
      expect(() => replay(invalid)).toThrow();
    }

    const changed = cloneTape(recording);
    const firstAi = changed.actions[0]![1];
    changed.actions[0]![1] = firstAi.type === "move"
      ? { type: "move", slot: (firstAi.slot + 1) % 4, ...(firstAi.target === undefined ? {} : { target: firstAi.target }) }
      : { type: "move", slot: 3 };
    expect(() => replay(changed)).toThrow();
  });

  test("replays 1,000/1,000 seeded random-agent battles across every AI recipe", () => {
    let randomState = 0x51f15e;
    const random = () => {
      randomState = (Math.imul(randomState, 1_664_525) + 1_013_904_223) >>> 0;
      return randomState / 4_294_967_296;
    };
    let completed = 0;
    for (const [difficultyIndex, difficulty] of ARENA_DIFFICULTIES.entries()) {
      for (let run = 0; run < 200; run++) {
        const seed = `${difficultyIndex.toString(16)}${run.toString(16).padStart(3, "0")}`.repeat(16);
        const battle = playAgentVsAi(seed, difficulty, run % 10 === 0 ? "double" : "single", random);
        const recording = JSON.parse(JSON.stringify(tape(battle)));
        const replayed = replay(recording);
        expect(isOver(battle), `${difficulty}/${run} did not terminate`).toBe(true);
        expect(canonicalJson(replayed), `${difficulty}/${run} bytes`).toBe(canonicalJson(battle));
        expect(stateHash(replayed), `${difficulty}/${run} hash`).toBe(stateHash(battle));
        completed++;
      }
    }
    expect(completed).toBe(1_000);
  }, 120_000);
});

function cloneMalformed(value: unknown, index: number): unknown {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    return { ...(value as Record<string, unknown>), fuzz: index };
  }
  return value;
}

function randomJson(random: () => number, depth: number): unknown {
  const scalar = (): unknown => {
    switch (Math.floor(random() * 7)) {
      case 0: return null;
      case 1: return random() < 0.5;
      case 2: return Math.floor(random() * 2_000_001) - 1_000_000;
      case 3: return (random() - 0.5) * Number.MAX_SAFE_INTEGER;
      case 4: return ["", "move", "swap", "item", "run", "__proto__", "toString"][Math.floor(random() * 7)]!;
      case 5: return `fuzz-${Math.floor(random() * 1_000_000).toString(36)}`;
      default: return random() < 0.5 ? Number.MAX_SAFE_INTEGER : Number.MIN_SAFE_INTEGER;
    }
  };
  if (depth <= 0 || random() < 0.45) return scalar();
  const length = Math.floor(random() * 5);
  if (random() < 0.4) {
    return Array.from({ length }, () => randomJson(random, depth - 1));
  }
  const keys = ["type", "slot", "target", "party", "item", "extra", "constructor", "__proto__"];
  const entries: Array<[string, unknown]> = [];
  for (let index = 0; index < length; index++) {
    const key = random() < 0.8
      ? keys[Math.floor(random() * keys.length)]!
      : `key-${Math.floor(random() * 1_000).toString(36)}`;
    entries.push([key, randomJson(random, depth - 1)]);
  }
  return JSON.parse(JSON.stringify(Object.fromEntries(entries)));
}

function cloneTape(value: ReturnType<typeof tape>): ReturnType<typeof tape> {
  return JSON.parse(JSON.stringify(value)) as ReturnType<typeof tape>;
}
