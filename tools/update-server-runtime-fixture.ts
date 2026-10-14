import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  ARENA_MAX_TURNS,
  SERVER_RUNTIME_IDENTITY,
  createArenaBattle,
  defaultAction,
  isOver,
  observe,
  result,
  stateHash,
  submit,
  tape,
  type ArenaAction,
  type ArenaBattle,
  type ArenaConfig,
} from "../battle/server-runtime.ts";
import { canonicalJson } from "../vendor/pocket-rpgkit/src/engine/save.ts";

interface FixtureCase {
  name: string;
  config: ArenaConfig;
  actions: Array<[ArenaAction, ArenaAction]>;
  stateHashes: string[];
  result: ReturnType<typeof result>;
  coverage: { double: boolean; status: boolean; swap: boolean; naturalTurnLimit: boolean };
}

function containsStatusEvent(battle: ArenaBattle): boolean {
  return battle.core.events.some((event) => Object.keys(event).some((key) => key.includes("status")) ||
    Object.values(event).some((value) => typeof value === "string" && value.includes("status")));
}

/** Same contract as stateHash(), using native SHA-256 for offline generation. */
function fixtureStateHash(battle: ArenaBattle): string {
  return createHash("sha256").update(canonicalJson(battle)).digest("hex");
}

function settle(battle: ArenaBattle, pair: [ArenaAction, ArenaAction]): ArenaBattle {
  const first = submit(battle, 0, pair[0]);
  if (!first.ok) throw new Error(first.error);
  const second = submit(first.battle, 1, pair[1]);
  if (!second.ok) throw new Error(second.error);
  if (!second.resolved) throw new Error("fixture action pair did not settle");
  return second.battle;
}

function play(name: string, config: ArenaConfig, swapFirst = false): FixtureCase {
  let battle = createArenaBattle(config);
  const stateHashes = [fixtureStateHash(battle)];
  let didSwap = false;
  while (!isOver(battle)) {
    const first = swapFirst && battle.turn === 0
      ? observe(battle, 0).legalActions.find((action) => action.type === "swap")
      : undefined;
    const pair: [ArenaAction, ArenaAction] = [
      first ?? defaultAction(battle, 0),
      defaultAction(battle, 1),
    ];
    didSwap ||= pair.some((action) => action.type === "swap");
    battle = settle(battle, pair);
    stateHashes.push(fixtureStateHash(battle));
  }
  if (stateHash(battle) !== stateHashes.at(-1)) {
    throw new Error(`${name}: native fixture hash differs from the public stateHash`);
  }
  const recording = tape(battle);
  return {
    name,
    config,
    actions: recording.actions,
    stateHashes,
    result: result(battle),
    coverage: {
      double: config.format === "double",
      status: containsStatusEvent(battle),
      swap: didSwap,
      naturalTurnLimit: result(battle)?.reason === "turn-limit" && battle.turn === ARENA_MAX_TURNS,
    },
  };
}

const SINGLE_SEEDS = [0, 1, 2, 4, 5, 6, 7, 9, 10, 11, 12, 13, 14, 15, 16, 33] as const;
const DOUBLE_SEEDS = Array.from({ length: 16 }, (_, index) => index + 17);
const cases = [...SINGLE_SEEDS.map((seed) => ({ seed, format: "single" as const })),
  ...DOUBLE_SEEDS.map((seed) => ({ seed, format: "double" as const }))]
  .map(({ seed, format }) => play(`seed-${seed.toString().padStart(2, "0")}-${format}`, {
    seed: seed.toString(16).padStart(64, "0"),
    format,
    sides: [{ kind: "agent", difficulty: "normal" }, { kind: "agent", difficulty: "normal" }],
  }, seed === 16));
if (cases.filter((entry) => !entry.coverage.double).length !== 16 ||
    cases.filter((entry) => entry.coverage.double).length !== 16) {
  throw new Error("server fixture must contain exactly 16 single and 16 double cases");
}
if (!cases.some((entry) => entry.coverage.naturalTurnLimit &&
    entry.result?.reason === "turn-limit" && entry.result.turns === ARENA_MAX_TURNS)) {
  throw new Error("server fixture must contain a natural 2,048-window turn-limit match");
}
if (cases.filter((entry) => entry.coverage.naturalTurnLimit).length !== 1) {
  throw new Error("server fixture must contain exactly one natural turn-limit match");
}
if (!cases.some((entry) => entry.coverage.swap) || !cases.some((entry) => entry.coverage.status)) {
  throw new Error("server fixture must retain targeted swap and status coverage");
}

const turnLimitConfig: ArenaConfig = {
  seed: "89abcdef01234567".repeat(4),
  format: "single",
  sides: [{ kind: "agent", difficulty: "normal" }, { kind: "agent", difficulty: "normal" }],
};
const initialLimit = createArenaBattle(turnLimitConfig);
const nearLimit = { ...initialLimit, turn: ARENA_MAX_TURNS - 1 };
const limitPair: [ArenaAction, ArenaAction] = [
  defaultAction(nearLimit, 0),
  defaultAction(nearLimit, 1),
];
const endedLimit = settle(nearLimit, limitPair);

const fixture = {
  format: "pocket-tuxemon/arena-server-determinism/v1",
  identity: SERVER_RUNTIME_IDENTITY,
  cases,
  turnLimitBoundary: {
    config: turnLimitConfig,
    startingTurn: ARENA_MAX_TURNS - 1,
    action: limitPair,
    stateHashes: [fixtureStateHash(nearLimit), fixtureStateHash(endedLimit)],
    result: result(endedLimit),
  },
};

const output = fileURLToPath(new URL("../tests/fixtures/arena-server-determinism.json", import.meta.url));
writeFileSync(output, `${JSON.stringify(fixture, null, 2)}\n`);
console.log(output);
