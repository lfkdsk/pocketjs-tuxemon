import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  createTuxemonExtensions,
  initialTuxemonExtensionState,
  packTuxemonExtensionState,
  tuxemonExtensionProblem,
  tuxemonExtensionState,
} from "../battle/extension.ts";
import { battleDbToTuxemonBattleDb } from "../battle/from-battle-db.ts";
import {
  BATTLE_EVENT_TICKS,
  createTuxemonBattleRules,
  tuxemonRuntimeBattleState,
  type RuntimeBattleState,
  type VariableEnums,
} from "../battle/runtime.ts";
import {
  createTuxemonScenes,
  TUXEMON_PARK_SUMMARY_SCENE_ID,
  type ParkSummarySceneState,
} from "../battle/scenes.ts";
import { spawnMonster } from "../battle/spawn.ts";
import {
  activateParkSession,
  emptyParkSession,
  parkSummary,
  recordParkCapture,
  recordParkSighting,
} from "../battle/park.ts";
import { availableMapIds, buildProject, G6_IMPORT_OPTIONS } from "../importer/project.ts";
import { validateBattleDb } from "../importer/battle-schema.ts";
import type { JsonValue } from "../vendor/pocket-rpgkit/src/engine/types.ts";
import type { BattleRules } from "../vendor/pocket-rpgkit/src/engine/battle.ts";

const PARK_MAPS = ["eclipse_park_entrance", "eclipse_park", "eclipse_park_south", "eclipse_park_cave"];
const TUXEMON_BATTLE_DB = validateBattleDb(JSON.parse(readFileSync(
  join(import.meta.dir, "../data/battle-db.json"),
  "utf8",
)));
const RULE_DB = battleDbToTuxemonBattleDb(TUXEMON_BATTLE_DB);
const ENUMS: VariableEnums = {
  battle_last_result: ["draw", "lost", "won", "run", "captured"],
  battle_last_trainer: [],
  battle_last_winner: [],
  battle_last_loser: [],
};

function nodes(value: unknown, out: Record<string, unknown>[] = []): Record<string, unknown>[] {
  if (Array.isArray(value)) for (const child of value) nodes(child, out);
  else if (value !== null && typeof value === "object") {
    const object = value as Record<string, unknown>;
    out.push(object);
    for (const child of Object.values(object)) nodes(child, out);
  }
  return out;
}

function commandContext(ext: JsonValue) {
  return {
    ext,
    switches: {},
    variables: {},
    items: {},
    gold: 0,
    playerName: "Park Tester",
    random: () => { throw new Error("park activation must not consume RNG"); },
  };
}

describe("Eclipse Park session state", () => {
  test("activation preserves upstream client-lifetime statistics and summary ranking", () => {
    let session = activateParkSession(undefined);
    session = recordParkSighting(session, "pairagrim");
    session = recordParkSighting(session, "pairagrim");
    session = recordParkSighting(session, "rockitten");
    session = recordParkCapture(session, "pairagrim", false);
    session = recordParkCapture(session, "pairagrim", true);
    session = { ...session, active: false };

    expect(activateParkSession(session)).toEqual({ ...session, active: true });
    expect(parkSummary(session)).toEqual({
      uniqueSeen: 2,
      attempts: 2,
      failedAttempts: 1,
      successfulCaptures: 1,
      successRate: 0.5,
      sightings: [
        { monster: "pairagrim", count: 2 },
        { monster: "rockitten", count: 1 },
      ],
      highlights: [{ monster: "pairagrim", averageTurnsRemaining: 30 }],
    });
  });

  test("extension start/stop is sparse, saved and strictly validated", () => {
    const extensions = createTuxemonExtensions(TUXEMON_BATTLE_DB);
    const command = extensions.commands!["tux.park_experience"]!;
    const initial = extensions.initial!;
    expect(tuxemonExtensionState(initial, TUXEMON_BATTLE_DB)).not.toHaveProperty("parkSession");

    const started = command(commandContext(initial), { action: "start" })!.ext!;
    expect(tuxemonExtensionState(started, TUXEMON_BATTLE_DB).parkSession).toEqual(emptyParkSession(true));
    const stopped = command(commandContext(started), { action: "stop" })!.ext!;
    expect(tuxemonExtensionState(stopped, TUXEMON_BATTLE_DB).parkSession).toEqual(emptyParkSession(false));
    expect(tuxemonExtensionProblem(stopped, TUXEMON_BATTLE_DB)).toBeNull();
    expect(() => command(commandContext(stopped), { action: "pause" })).toThrow(/start.*stop/);

    const malformed = packTuxemonExtensionState({
      ...initialTuxemonExtensionState(),
      parkSession: { ...emptyParkSession(), failedAttempts: -1 },
    });
    expect(tuxemonExtensionProblem(malformed, TUXEMON_BATTLE_DB)).toMatch(/failedAttempts/);
  });
});

describe("real Eclipse Park import", () => {
  test("all eight authored actions lower to saved session commands and blocking summaries", () => {
    const built = buildProject(PARK_MAPS, G6_IMPORT_OPTIONS);
    const all = nodes(built.project);
    const actions = all.filter((node) => node.op === "ext" && node.call === "tux.park_experience");
    expect(actions.map((node) => node.args)).toEqual([
      { action: "start" },
      { action: "stop" },
      { action: "stop" },
      { action: "stop" },
      { action: "stop" },
      { action: "stop" },
      { action: "stop" },
      { action: "stop" },
    ]);
    expect(all.filter((node) => node.op === "scene" && node.id === "tux.parkSummary")).toHaveLength(7);
    const row = built.report.coverage.actions.rows.find((entry) => entry.type === "park_experience");
    expect(row).toMatchObject({ total: 8, native: 8, degraded: 0, placeholder: 0, dropped: 0 });
  });

  test("the whole corpus keeps park_experience Native", () => {
    const full = buildProject(availableMapIds(), G6_IMPORT_OPTIONS);
    expect(full.report.coverage.actions.rows.find((entry) => entry.type === "park_experience"))
      .toMatchObject({ total: 8, native: 8, degraded: 0, placeholder: 0, dropped: 0 });
  });
});

function revealMenu(rules: BattleRules, value: JsonValue): JsonValue {
  for (let guard = 0; guard < 1_000; guard++) {
    const state = tuxemonRuntimeBattleState(value);
    if (state.eventCursor >= state.battle.events.length) return value;
    value = rules.step(value, { buttons: 0, confirmEdge: true }, BATTLE_EVENT_TICKS);
  }
  throw new Error("Park battle presentation did not reach its menu");
}

function parkBattle(seed: number): { rules: BattleRules; value: JsonValue } {
  const rules = createTuxemonBattleRules(TUXEMON_BATTLE_DB, ENUMS);
  const player = spawnMonster(
    TUXEMON_BATTLE_DB,
    RULE_DB,
    { rng: 0x4150, rngDraws: 0 },
    "nut",
    12,
    { iid: "txmn-park-player" },
  );
  const ext = {
    ...initialTuxemonExtensionState(),
    party: [player],
    environment: "park",
    parkSession: emptyParkSession(true),
    nextMonsterId: 2,
  };
  const extValue = packTuxemonExtensionState(ext);
  const started = rules.start(extValue, {
    kind: "wild",
    species: "pairagrim",
    level: 5,
    environment: "park",
  }, seed, {
    ext: extValue,
    switches: {},
    variables: {},
    items: { tuxeball_park: 25 },
    gold: 0,
    playerName: "Park Tester",
  });
  if (!started) throw new Error("Park battle did not start");
  expect(tuxemonExtensionState(started.ext, TUXEMON_BATTLE_DB).parkSession?.sightings)
    .toEqual({ pairagrim: 1 });
  return { rules, value: revealMenu(rules, started.state) };
}

function finishPresentation(
  rules: BattleRules,
  initial: JsonValue,
): { state: RuntimeBattleState; completion: NonNullable<ReturnType<BattleRules["done"]>> } {
  let value = initial;
  for (let guard = 0; guard < 1_000; guard++) {
    const completion = rules.done(value);
    if (completion) return { state: tuxemonRuntimeBattleState(value), completion };
    value = rules.step(value, { buttons: 0, confirmEdge: true }, BATTLE_EVENT_TICKS);
  }
  throw new Error("Park battle did not finish its presentation");
}

describe("dedicated Eclipse Park encounter", () => {
  test("the scoped battle database contains exactly the Park-facing dependencies", () => {
    expect(TUXEMON_BATTLE_DB.encounters.eclipse_park?.monsters.map((row) => row.monster)).toEqual(["pairagrim"]);
    expect(TUXEMON_BATTLE_DB.environments).toHaveProperty("park");
    expect(TUXEMON_BATTLE_DB.environments).toHaveProperty("night_park");
    expect(TUXEMON_BATTLE_DB.items.tuxeball_park).toMatchObject({
      usableIn: ["MainParkMenuState"],
      category: "capture",
      consumable: true,
      effects: [{ type: "park", parameters: ["capture"] }],
    });
  });

  test("shows Ball/Food/Doll/Run, consumes a Park Ball and completes a real capture", () => {
    let captured: ReturnType<typeof parkBattle> | null = null;
    let afterThrow: JsonValue | null = null;
    for (let seed = 1; seed <= 2_000 && !captured; seed++) {
      const candidate = parkBattle(seed);
      const menu = tuxemonRuntimeBattleState(candidate.value);
      expect(menu.menu.map(({ slug, available }) => ({ slug, available }))).toEqual([
        { slug: "park_ball", available: true },
        { slug: "park_food", available: false },
        { slug: "park_doll", available: false },
        { slug: "run", available: true },
      ]);
      const thrown = candidate.rules.step(candidate.value, { buttons: 0, confirmEdge: true }, 0);
      if (tuxemonRuntimeBattleState(thrown).battle.result?.battleLastResult === "captured") {
        captured = candidate;
        afterThrow = thrown;
      }
    }
    expect(captured).not.toBeNull();
    const finished = finishPresentation(captured!.rules, afterThrow!);
    const persisted = tuxemonExtensionState(finished.completion.ext, TUXEMON_BATTLE_DB);
    expect(finished.completion.result).toBe("escape");
    expect(finished.completion.writes?.["v.battle_last_result"]).toBe(5);
    expect(finished.completion.items?.tuxeball_park).toBe(24);
    expect(persisted.parkSession).toMatchObject({
      active: true,
      sightings: { pairagrim: 1 },
      failedAttempts: 0,
      successfulCaptures: 1,
      history: [{ monster: "pairagrim", turnsRemaining: 30 }],
    });
    expect(persisted.caught).toContain("pairagrim");
    expect(persisted.party.some((monster) => monster.slug === "pairagrim")).toBeTrue();
  });

  test("a failed throw is counted and consumed while a voluntary run always exits", () => {
    let failed: { rules: BattleRules; value: JsonValue } | null = null;
    for (let seed = 1; seed <= 2_000 && !failed; seed++) {
      const candidate = parkBattle(seed);
      const thrown = candidate.rules.step(candidate.value, { buttons: 0, confirmEdge: true }, 0);
      const state = tuxemonRuntimeBattleState(thrown);
      if (!state.park?.monsterFled && state.battle.events.some((event) =>
        event.type === "capture" && event.success === false)) {
        failed = { rules: candidate.rules, value: thrown };
      }
    }
    expect(failed).not.toBeNull();
    const failure = tuxemonRuntimeBattleState(failed!.value);
    expect(failure.battle.inventory.tuxeball_park).toBe(24);
    expect(failure.ext.parkSession).toMatchObject({ failedAttempts: 1, successfulCaptures: 0 });

    const voluntary = parkBattle(901);
    let state = tuxemonRuntimeBattleState(voluntary.value);
    state.menuIndex = 3;
    const ran = voluntary.rules.step(state as unknown as JsonValue, { buttons: 0, confirmEdge: true }, 0);
    const finished = finishPresentation(voluntary.rules, ran);
    expect(finished.completion.result).toBe("escape");
    expect(finished.completion.items?.tuxeball_park).toBe(25);
    expect(tuxemonExtensionState(finished.completion.ext, TUXEMON_BATTLE_DB).parkSession)
      .toMatchObject({ failedAttempts: 0, successfulCaptures: 0 });
  });
});

describe("Park summary scene", () => {
  test("blocks until close and exposes complete English and Chinese summaries", () => {
    let park = emptyParkSession(false);
    park = { ...park, sightings: { pairagrim: 3 }, failedAttempts: 1, successfulCaptures: 1,
      history: [{ monster: "pairagrim", turnsRemaining: 30 }] };
    const ext = packTuxemonExtensionState({ ...initialTuxemonExtensionState(), parkSession: park });
    for (const lang of ["en_US", "zh_CN"] as const) {
      const rules = createTuxemonScenes(TUXEMON_BATTLE_DB, undefined, lang).rules[TUXEMON_PARK_SUMMARY_SCENE_ID]!;
      const started = rules.start(ext, {}, 0, commandContext(ext))!;
      const state = started.state as unknown as ParkSummarySceneState;
      expect(state).toMatchObject({
        kind: "parkSummary",
        phase: "summary",
        uniqueSeen: 1,
        attempts: 2,
        successfulCaptures: 1,
        failedAttempts: 1,
        successRate: 0.5,
        sightings: [{ monster: "pairagrim", count: 3 }],
      });
      expect(state.labels.title).toBe(lang === "zh_CN" ? "Eclipse 公园结算" : "Eclipse Park Results");
      expect(rules.done(started.state)).toBeNull();
      const closed = rules.step(started.state, { buttons: 0, selectIndex: 0 }, 1);
      expect(rules.done(closed)).toEqual({});
    }
  });
});
