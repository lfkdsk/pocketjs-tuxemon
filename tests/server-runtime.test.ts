import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import battleDbJson from "../data/battle-db.json";
import battleDbZhJson from "../data/battle-db.zh_CN.json";
import featureModesJson from "../data/feature-modes.json";
import fixtureJson from "./fixtures/arena-server-determinism.json";
import * as shared from "../battle/server-runtime.ts";
import * as artifact from "../server-runtime/index.mjs";
import { canonicalJson, utf8Encode } from "../vendor/pocket-rpgkit/src/engine/save.ts";
import { sha256Bytes } from "../vendor/pocket-rpgkit/src/engine/map-repository.ts";
import {
  assertServerRuntimeBoundary,
  bundleServerRuntime,
} from "../tools/build-server-runtime.ts";
import { SERVER_RUNTIME_DECLARATION } from "../tools/server-runtime-declaration.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const ARTIFACT = join(ROOT, "server-runtime/index.mjs");
const DECLARATION = join(ROOT, "server-runtime/index.d.mts");
const SERVER_ENTRY = join(ROOT, "battle/server-runtime.ts");
const UI_MUTATION = join(ROOT, "ui/battle-scene-locale.ts");

const VALUE_EXPORTS = [
  "ARENA_DEADLINE_TICKS",
  "ARENA_DIFFICULTIES",
  "ARENA_MAX_TURNS",
  "ARENA_VERSION",
  "ArenaTapeError",
  "DEFAULT_ARENA_TEAM_RULES",
  "SERVER_DATA_DIGEST",
  "SERVER_DATA_REVISION",
  "SERVER_ENGINE_REVISION",
  "SERVER_RUNTIME_IDENTITY",
  "createArenaBattle",
  "createArenaReplayStart",
  "defaultAction",
  "isOver",
  "observe",
  "replay",
  "replayArenaPair",
  "result",
  "stateHash",
  "submit",
  "tape",
  "validateBattleTape",
  "validateTeam",
  "validateTeamRules",
] as const;

type Runtime = typeof shared;
const artifactRuntime: Runtime = artifact;
type FixtureCase = {
  name: string;
  config: shared.ArenaConfig;
  actions: Array<[shared.ArenaAction, shared.ArenaAction]>;
  stateHashes: string[];
  result: shared.ArenaResult;
  coverage: { double: boolean; status: boolean; swap: boolean; naturalTurnLimit: boolean };
};
type DeterminismFixture = {
  format: string;
  identity: typeof shared.SERVER_RUNTIME_IDENTITY;
  cases: FixtureCase[];
  turnLimitBoundary: {
    config: shared.ArenaConfig;
    startingTurn: number;
    action: [shared.ArenaAction, shared.ArenaAction];
    stateHashes: [string, string];
    result: shared.ArenaResult;
  };
};
const fixture = fixtureJson as unknown as DeterminismFixture;

function settle(runtime: Runtime, battle: shared.ArenaBattle, pair: [shared.ArenaAction, shared.ArenaAction]) {
  const first = runtime.submit(battle, 0, pair[0]);
  if (!first.ok) throw new Error(first.error);
  const second = runtime.submit(first.battle, 1, pair[1]);
  if (!second.ok) throw new Error(second.error);
  expect(second.resolved).toBe(true);
  return second.battle;
}

function fixtureStateHash(battle: shared.ArenaBattle): string {
  return createHash("sha256").update(canonicalJson(battle)).digest("hex");
}

describe("committed Arena server artifact", () => {
  test("has one explicit value surface and a content-bound data identity", () => {
    expect(Object.keys(shared).sort()).toEqual([...VALUE_EXPORTS].sort());
    expect(Object.keys(artifactRuntime).sort()).toEqual([...VALUE_EXPORTS].sort());
    expect(artifact.SERVER_RUNTIME_IDENTITY).toEqual(shared.SERVER_RUNTIME_IDENTITY);
    expect(battleDbJson.sourceRevision).toBe(shared.SERVER_DATA_REVISION);
    expect(battleDbZhJson.sourceRevision).toBe(battleDbJson.sourceRevision);
    const payload = {
      battleDb: battleDbJson,
      battleDbZh_CN: battleDbZhJson,
      titleBattle: featureModesJson.titleBattle,
    };
    expect(sha256Bytes(utf8Encode(
      `pocket-tuxemon/arena-server-data/v1\n${canonicalJson(payload)}`,
    ))).toBe(shared.SERVER_DATA_DIGEST);
  });

  test("rebuilds byte-identically with a zero-UI, zero-asset, host-neutral emitted graph", async () => {
    const built = await bundleServerRuntime();
    expect(() => assertServerRuntimeBoundary(built)).not.toThrow();
    expect(built.aliasCount).toBe(1);
    expect(built.inputs).toContain("battle/server-battle-names.ts");
    expect(built.inputs).not.toContain("battle/battle-names.ts");
    expect(built.violations).toEqual([]);
    expect(built.bytes).toEqual(new Uint8Array(readFileSync(ARTIFACT)));
    expect(built.declarationBytes).toEqual(new Uint8Array(readFileSync(DECLARATION)));
    expect(new TextDecoder().decode(built.declarationBytes)).toBe(SERVER_RUNTIME_DECLARATION);
    for (const [source, error] of [
      ['import type { ArenaBattle } from "../battle/arena.ts";\n', "contains an import"],
      ['export * from "../battle/server-runtime.ts";\n', "contains an export-from"],
      ['/// <reference path="../battle/arena.ts" />\n', "contains a triple-slash reference"],
    ] as const) {
      expect(() => assertServerRuntimeBoundary({
        ...built,
        declarationBytes: new TextEncoder().encode(source),
      })).toThrow(error);
    }
  });

  test("ships self-contained typings with no source-graph dependency syntax", () => {
    const declaration = readFileSync(DECLARATION, "utf8");
    expect(declaration).not.toMatch(/\bimport\b/);
    expect(declaration).not.toMatch(
      /\bexport\s+(?:type\s+)?(?:\*\s*(?:as\s+[A-Za-z_$][\w$]*\s*)?|\{[^}]*\})\s+from\s*["']/m,
    );
    expect(declaration).not.toMatch(/\/\/\/\s*<reference\b/i);
  });

  test("makes a deliberately introduced runtime UI edge visible and rejects it", async () => {
    const temporaryRoot = process.env.TEST_TMPDIR ?? join(ROOT, ".test-tmp");
    mkdirSync(temporaryRoot, { recursive: true });
    const directory = mkdtempSync(join(temporaryRoot, "server-runtime-mutation-"));
    try {
      const entry = join(directory, "ui-mutation.ts");
      writeFileSync(entry,
        `import ${JSON.stringify(UI_MUTATION)};\nexport * from ${JSON.stringify(SERVER_ENTRY)};\n`);
      const built = await bundleServerRuntime(entry);
      expect(built.inputs).toContain("ui/battle-scene-locale.ts");
      expect(built.violations).toContainEqual({
        code: "UI_INPUT",
        path: "ui/battle-scene-locale.ts",
      });
      expect(() => assertServerRuntimeBoundary(built)).toThrow("server runtime boundary violation");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe("Arena server deterministic fixtures", () => {
  test("pin identity and cover single, double, status, swap, and turn-limit boundaries", () => {
    expect(fixture.format).toBe("pocket-tuxemon/arena-server-determinism/v1");
    expect(fixture.identity).toEqual(shared.SERVER_RUNTIME_IDENTITY);
    expect(fixture.cases).toHaveLength(32);
    expect(fixture.cases.filter((entry) => !entry.coverage.double)).toHaveLength(16);
    expect(fixture.cases.filter((entry) => entry.coverage.double)).toHaveLength(16);
    expect(fixture.cases.some((entry) => entry.coverage.status)).toBe(true);
    expect(fixture.cases.some((entry) => entry.coverage.swap)).toBe(true);
    expect(fixture.cases.some((entry) => entry.coverage.naturalTurnLimit &&
      entry.result.reason === "turn-limit" && entry.result.turns === shared.ARENA_MAX_TURNS)).toBe(true);
    expect(fixture.turnLimitBoundary).toMatchObject({
      startingTurn: shared.ARENA_MAX_TURNS - 1,
      result: { winner: null, turns: shared.ARENA_MAX_TURNS, reason: "turn-limit" },
    });
  });

  for (const entry of fixture.cases) {
    test(`${entry.name} matches shared state, artifact state, tape, observation, and replay per window`, () => {
      let expectedIndex = 0;
      let sharedBattle = shared.createArenaBattle(entry.config);
      let artifactBattle = artifact.createArenaBattle(entry.config);
      expect(fixtureStateHash(sharedBattle)).toBe(entry.stateHashes[expectedIndex]);
      expect(fixtureStateHash(artifactBattle)).toBe(entry.stateHashes[expectedIndex]);
      for (const pair of entry.actions) {
        expect(artifact.observe(artifactBattle, 0)).toEqual(shared.observe(sharedBattle, 0));
        expect(artifact.observe(artifactBattle, 1)).toEqual(shared.observe(sharedBattle, 1));
        expect(artifact.defaultAction(artifactBattle, 0)).toEqual(shared.defaultAction(sharedBattle, 0));
        expect(artifact.defaultAction(artifactBattle, 1)).toEqual(shared.defaultAction(sharedBattle, 1));
        sharedBattle = settle(shared, sharedBattle, pair);
        artifactBattle = settle(artifact, artifactBattle, pair);
        expectedIndex++;
        expect(fixtureStateHash(sharedBattle)).toBe(entry.stateHashes[expectedIndex]);
        expect(fixtureStateHash(artifactBattle)).toBe(entry.stateHashes[expectedIndex]);
      }
      expect(shared.result(sharedBattle)).toEqual(entry.result);
      expect(artifact.result(artifactBattle)).toEqual(entry.result);
      expect(artifact.tape(artifactBattle)).toEqual(shared.tape(sharedBattle));
      expect(shared.stateHash(shared.replay(shared.tape(sharedBattle)))).toBe(entry.stateHashes.at(-1)!);
      expect(artifact.stateHash(artifact.replay(artifact.tape(artifactBattle)))).toBe(entry.stateHashes.at(-1)!);
    }, entry.coverage.naturalTurnLimit ? 600_000 : 30_000);
  }

  test("the synthetic 2047 boundary settles through the real reducer to the hard cap", () => {
    const entry = fixture.turnLimitBoundary;
    const sharedNear = { ...shared.createArenaBattle(entry.config), turn: entry.startingTurn };
    const artifactNear = { ...artifact.createArenaBattle(entry.config), turn: entry.startingTurn };
    expect(shared.stateHash(sharedNear)).toBe(entry.stateHashes[0]);
    expect(artifact.stateHash(artifactNear)).toBe(entry.stateHashes[0]);
    const sharedEnded = settle(shared, sharedNear, entry.action);
    const artifactEnded = settle(artifact, artifactNear, entry.action);
    expect(shared.stateHash(sharedEnded)).toBe(entry.stateHashes[1]);
    expect(artifact.stateHash(artifactEnded)).toBe(entry.stateHashes[1]);
    expect(shared.result(sharedEnded)).toEqual(entry.result);
    expect(artifact.result(artifactEnded)).toEqual(entry.result);
  });
});
