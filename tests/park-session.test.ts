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
import { TUXEMON_SESSION_OPTIONS, TUXEMON_VARIABLE_ENUMS } from "../battle/game.ts";
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
import { AttractController } from "../vendor/pocket-rpgkit/src/engine/attract.ts";
import { BTN_BITS } from "../vendor/pocket-rpgkit/src/engine/camera.ts";
import { canonicalJson, createSessionSnapshot } from "../vendor/pocket-rpgkit/src/engine/save.ts";
import { restoreSessionSnapshot } from "../vendor/pocket-rpgkit/src/engine/save-restore.ts";
import {
  createSession,
  startSession,
  stepSession,
  type Session,
  type SessionState,
} from "../vendor/pocket-rpgkit/src/engine/session.ts";
import type { JsonValue, Project } from "../vendor/pocket-rpgkit/src/engine/types.ts";
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
const BTN_CONFIRM = 0x2000;
const BTN_REWIND = 0x0100;
const REAL_ENCOUNTER_RNG = 459;
const CAPTURED_RESULT_CODE = TUXEMON_VARIABLE_ENUMS.battle_last_result!.indexOf("captured") + 1;
const REAL_PARK_PROJECT = buildProject(["eclipse_park"], G6_IMPORT_OPTIONS).project;

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

  test("summary keeps every capture highlight like the scrolling upstream menu", () => {
    const session = {
      ...emptyParkSession(false),
      successfulCaptures: 6,
      history: ["alpha", "bravo", "charlie", "delta", "echo", "foxtrot"].map(
        (monster, index) => ({ monster, turnsRemaining: 30 - index }),
      ),
    };

    expect(parkSummary(session).highlights.map(({ monster }) => monster)).toEqual([
      "alpha",
      "bravo",
      "charlie",
      "delta",
      "echo",
      "foxtrot",
    ]);
  });

  test("extension start/stop is sparse, saved and strictly validated", () => {
    const extensions = createTuxemonExtensions(TUXEMON_BATTLE_DB);
    const command = extensions.commands!["tux.park_experience"]!;
    const initial = extensions.initial!;
    expect(tuxemonExtensionState(initial, TUXEMON_BATTLE_DB)).not.toHaveProperty("parkSession");

    const started = command(commandContext(initial), { action: "start" })!.ext!;
    expect(tuxemonExtensionState(started, TUXEMON_BATTLE_DB).parkSession).toEqual(emptyParkSession(true));
    const stopped = command(commandContext(started), { action: "stop" })!.ext!;
    expect(tuxemonExtensionState(stopped, TUXEMON_BATTLE_DB).parkSession)
      .toEqual({ ...emptyParkSession(false), summaryPending: true });
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

function realParkExtension(): JsonValue {
  const player = spawnMonster(
    TUXEMON_BATTLE_DB,
    RULE_DB,
    { rng: 0x4150, rngDraws: 0 },
    "nut",
    12,
    { iid: "txmn-real-park-player" },
  );
  return packTuxemonExtensionState({
    ...initialTuxemonExtensionState(),
    party: [player],
    environment: "park",
    parkSession: emptyParkSession(true),
    nextMonsterId: 2,
  });
}

function startRealParkEncounter(hz: 60 | 30 | 20): {
  project: Project;
  session: Session;
  state: SessionState;
} {
  const project = structuredClone(REAL_PARK_PROJECT);
  project.start = { map: "eclipse_park", x: 12, y: 3, dir: "right" };
  const session = createSession(project, hz, TUXEMON_SESSION_OPTIONS);
  let state = startSession(project, session, undefined, realParkExtension());
  state.sw.items.tuxeball_park = 25;
  state.sw.rng = REAL_ENCOUNTER_RNG;

  for (let frame = 0; frame < 120 && state.scene === null; frame++) {
    state = stepSession(session, state, { buttons: BTN_BITS.RIGHT });
  }
  expect(state.scene?.kind, `real Park encounter at ${hz} Hz`).toBe("battle");
  expect([state.move.tx, state.move.ty]).toEqual([13, 3]);

  for (let frame = 0; frame < 1_000; frame++) {
    if (state.scene?.kind !== "battle") break;
    const battle = tuxemonRuntimeBattleState(state.scene.state);
    if (battle.eventCursor >= battle.battle.events.length) break;
    state = stepSession(session, state, { buttons: 0, confirmEdge: true });
  }
  expect(state.scene?.kind).toBe("battle");
  const battle = tuxemonRuntimeBattleState(state.scene!.state);
  expect(battle.eventCursor).toBe(battle.battle.events.length);
  expect(battle.park).toMatchObject({ monster: "pairagrim", turnsRemaining: 30 });
  return { project, session, state };
}

function finishRealParkCapture(hz: 60 | 30 | 20): {
  project: Project;
  session: Session;
  atMenu: SessionState;
  state: SessionState;
} {
  const started = startRealParkEncounter(hz);
  const atMenu = started.state;
  let state = stepSession(started.session, atMenu, { buttons: 0, confirmEdge: true });
  expect(tuxemonRuntimeBattleState(state.scene!.state).battle.result?.battleLastResult).toBe("captured");
  for (let frame = 0; frame < 1_000 && state.scene !== null; frame++) {
    state = stepSession(started.session, state, { buttons: 0, confirmEdge: true });
  }
  expect(state.scene).toBeNull();
  for (let frame = 0; frame < 30 && state.interp.main; frame++) {
    state = stepSession(started.session, state, { buttons: 0 });
  }
  expect(state.interp.error).toBeUndefined();
  expect(state.interp.main).toBeNull();
  return { ...started, atMenu, state };
}

function realCaptureProjection(state: SessionState) {
  const ext = tuxemonExtensionState(state.ext, TUXEMON_BATTLE_DB);
  return {
    map: state.mapId,
    position: [state.move.tx, state.move.ty],
    parkBalls: state.sw.items.tuxeball_park,
    battleResult: state.sw.variables["v.battle_last_result"],
    parkSession: ext.parkSession!,
    caught: ext.caught,
    party: ext.party.map((monster) => monster.slug),
  };
}

describe("real Eclipse Park session flow", () => {
  test("the unchanged 1% player-touch event enters Park mode and captures at every host rate", () => {
    const encounter = REAL_PARK_PROJECT.maps[0]!.events?.find((event) => event.id === "e018_encounters_8_r001");
    expect(encounter).toMatchObject({ x: 13, y: 3, w: 4, h: 3 });
    expect(encounter!.pages[0]!.trigger).toBe("playerTouch");
    expect(encounter!.pages[0]!.commands[0]).toEqual({
      op: "battle",
      setup: { kind: "random", table: "eclipse_park", probability: 1, inside: false },
    });
    expect((encounter!.pages[0]!.commands[0] as { setup: Record<string, unknown> }).setup)
      .not.toHaveProperty("environment");

    const outcomes = ([60, 30, 20] as const).map((hz) => {
      const run = finishRealParkCapture(hz);
      const projection = realCaptureProjection(run.state);
      expect(projection).toMatchObject({
        map: "eclipse_park",
        position: [13, 3],
        parkBalls: 24,
        battleResult: CAPTURED_RESULT_CODE,
        parkSession: {
          active: true,
          sightings: { pairagrim: 1 },
          failedAttempts: 0,
          successfulCaptures: 1,
          history: [{ monster: "pairagrim", turnsRemaining: 30 }],
        },
        caught: ["pairagrim"],
        party: ["nut", "pairagrim"],
      });

      const restored = restoreSessionSnapshot(
        run.session,
        structuredClone(createSessionSnapshot(run.session, run.state, 0)),
      );
      expect(realCaptureProjection(restored)).toEqual(projection);
      return projection;
    });
    expect(outcomes[1]).toEqual(outcomes[0]);
    expect(outcomes[2]).toEqual(outcomes[0]);
  });

  test("a completed real capture rewinds to the Park menu and refolds byte-identically", () => {
    const { project, atMenu } = finishRealParkCapture(60);
    const options = {
      hz: 60,
      attractEnabled: false,
      rewindSeconds: 10,
      keyframeIntervalFrames: 7,
      idleFrames: 60_000,
      ...TUXEMON_SESSION_OPTIONS,
    } as const;
    const keyed = new AttractController(project, [], options);
    const fromZero = new AttractController(project, [], { ...options, keyframeMaxBytes: 0 });
    keyed.loadState(atMenu, 0);
    fromZero.loadState(atMenu, 0);

    const masks: number[] = [];
    for (let frame = 0; frame < 600 && keyed.state.scene !== null; frame++) {
      const mask = frame % 2 === 0 ? BTN_CONFIRM : 0;
      masks.push(mask);
      keyed.step(mask);
      fromZero.step(mask);
    }
    expect(keyed.state.scene).toBeNull();
    expect(canonicalJson(fromZero.state)).toBe(canonicalJson(keyed.state));
    const terminal = canonicalJson(keyed.state);

    keyed.step(BTN_REWIND);
    fromZero.step(BTN_REWIND);
    expect(canonicalJson(keyed.state)).toBe(canonicalJson(atMenu));
    expect(canonicalJson(fromZero.state)).toBe(canonicalJson(atMenu));
    expect(tuxemonExtensionState(keyed.state.ext, TUXEMON_BATTLE_DB).parkSession)
      .toMatchObject({ successfulCaptures: 0, sightings: { pairagrim: 1 } });

    for (const mask of masks) {
      keyed.step(mask);
      fromZero.step(mask);
    }
    expect(canonicalJson(keyed.state)).toBe(terminal);
    expect(canonicalJson(fromZero.state)).toBe(terminal);
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

function parkBattle(seed: number, species = "pairagrim"): { rules: BattleRules; value: JsonValue } {
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
    species,
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
    .toEqual({ [species]: 1 });
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

  test("a positive pre-throw flee check leaves the same encounter untouched", () => {
    const encounter = parkBattle(1);
    const before = tuxemonRuntimeBattleState(encounter.value);
    expect(before.park?.fleeRate).toBe(0.1);
    expect(tuxemonRuntimeBattleState(parkBattle(1, "nut").value).park?.fleeRate).toBe(0.05);

    const after = tuxemonRuntimeBattleState(encounter.rules.step(
      encounter.value,
      { buttons: 0, confirmEdge: true },
      0,
    ));
    expect(after.battle.rngDraws).toBe(before.battle.rngDraws + 1);
    expect(after.battle.phase).toBe("decision");
    expect(after.battle.outcome).toBeNull();
    expect(after.battle.inventory.tuxeball_park).toBe(25);
    expect(after.battle.events).toEqual(before.battle.events);
    expect(after.battle.parties[1]).toEqual(before.battle.parties[1]);
    expect(after.ext.parkSession).toMatchObject({
      sightings: { pairagrim: 1 },
      failedAttempts: 0,
      successfulCaptures: 0,
    });
    expect(after.menu.map(({ slug }) => slug)).toEqual(["park_ball", "park_food", "park_doll", "run"]);
  });

  test("a failed throw is counted and consumed while a voluntary run always exits", () => {
    let failed: { rules: BattleRules; value: JsonValue } | null = null;
    for (let seed = 1; seed <= 2_000 && !failed; seed++) {
      const candidate = parkBattle(seed);
      const thrown = candidate.rules.step(candidate.value, { buttons: 0, confirmEdge: true }, 0);
      const state = tuxemonRuntimeBattleState(thrown);
      if (state.battle.events.some((event) =>
        event.type === "capture" && event.success === false)) {
        failed = { rules: candidate.rules, value: thrown };
      }
    }
    expect(failed).not.toBeNull();
    const failure = tuxemonRuntimeBattleState(failed!.value);
    expect(failure.battle.inventory.tuxeball_park).toBe(24);
    expect(failure.ext.parkSession).toMatchObject({ failedAttempts: 1, successfulCaptures: 0 });
    const player = failure.battle.parties[0][0]!;
    expect(player.currentHp).toBe(player.base.hp);
    const enemyUid = failure.battle.parties[1][0]!.uid;
    expect(failure.battle.events.find((event) =>
      event.type === "technique" && event.user === enemyUid)).toMatchObject({
      technique: "empty",
      damage: 0,
    });

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
    park = { ...park, summaryPending: true, sightings: { pairagrim: 3 }, failedAttempts: 1, successfulCaptures: 1,
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
      expect(JSON.parse(JSON.stringify(state))).toEqual(state);
      expect(tuxemonExtensionState(started.ext, TUXEMON_BATTLE_DB).parkSession)
        .not.toHaveProperty("summaryPending");
      expect(rules.done(started.state)).toBeNull();
      const closed = rules.step(started.state, { buttons: 0, selectIndex: 0 }, 1);
      expect(rules.done(closed)).toEqual({});
    }
  });
});
