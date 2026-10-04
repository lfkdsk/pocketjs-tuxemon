import { describe, expect, test } from "bun:test";

import {
  TUXEMON_DAYCARE_SCENE_ID,
  daycareMenuItems,
  daycareTextPages,
  daycareWrapAll,
  type DaycareSceneState,
} from "../battle/daycare-scenes.ts";
import {
  initialTuxemonExtensionState,
  packTuxemonExtensionState,
  tuxemonExtensionState,
  type TuxemonExtensionState,
} from "../battle/extension.ts";
import { battleDbToTuxemonBattleDb } from "../battle/from-battle-db.ts";
import {
  TUXEMON_BATTLE_DB as DB,
  TUXEMON_EXTENSIONS as extensions,
  TUXEMON_SCENES as scenes,
  TUXEMON_SESSION_OPTIONS,
} from "../battle/game.ts";
import { spawnMonster } from "../battle/spawn.ts";
import type { DaycareExtensionState, SpawnedMonsterSnapshot } from "../battle/types.ts";
import { buildProject, G6_IMPORT_OPTIONS } from "../importer/project.ts";
import { BTN_BITS } from "../vendor/pocket-rpgkit/src/engine/camera.ts";
import { AttractController } from "../vendor/pocket-rpgkit/src/engine/attract.ts";
import type { ExtensionReadContext } from "../vendor/pocket-rpgkit/src/engine/extensions.ts";
import { restoreSessionSnapshot } from "../vendor/pocket-rpgkit/src/engine/save-restore.ts";
import { canonicalJson, createSessionSnapshot } from "../vendor/pocket-rpgkit/src/engine/save.ts";
import type { SceneInput, SceneRules } from "../vendor/pocket-rpgkit/src/engine/scene.ts";
import { createSession, startSession, stepSession, type Session, type SessionState } from "../vendor/pocket-rpgkit/src/engine/session.ts";
import type { JsonValue, MapDef, Project } from "../vendor/pocket-rpgkit/src/engine/types.ts";

const RULE_DB = battleDbToTuxemonBattleDb(DB);
const BUILD = buildProject(["spyder_paper_daycare", "cotton_daycare"], G6_IMPORT_OPTIONS);

function objectNodes(value: unknown, out: Record<string, unknown>[] = []): Record<string, unknown>[] {
  if (Array.isArray(value)) for (const child of value) objectNodes(child, out);
  else if (value !== null && typeof value === "object") {
    const object = value as Record<string, unknown>;
    out.push(object);
    for (const child of Object.values(object)) objectNodes(child, out);
  }
  return out;
}

const importedScenes = objectNodes(BUILD.project)
  .filter((node) => node.op === "scene" && node.id === TUXEMON_DAYCARE_SCENE_ID);
const IMPORTED_ARGS = importedScenes[0]!.args as JsonValue;

function monster(
  slug: string,
  iid: string,
  overrides: Partial<SpawnedMonsterSnapshot> = {},
): SpawnedMonsterSnapshot {
  return {
    ...spawnMonster(DB, RULE_DB, { rng: iid.length * 65_537, rngDraws: 0 }, slug, 12, { iid }),
    ...overrides,
  };
}

function daycare(parents: SpawnedMonsterSnapshot[], progressSteps = 0): DaycareExtensionState {
  return {
    parents,
    progressSteps,
    pendingExperience: 0,
    lastTrainingExp: 0,
    lastTrainingCost: 0,
  };
}

function ext(update: (state: TuxemonExtensionState) => void = () => {}): JsonValue {
  const state = initialTuxemonExtensionState();
  update(state);
  return packTuxemonExtensionState(state);
}

function context(value: JsonValue, gold = 0): ExtensionReadContext {
  return { ext: value, switches: {}, variables: {}, items: {}, gold, playerName: "A" };
}

function stepScene(rules: SceneRules, state: JsonValue, ...inputs: Partial<SceneInput>[]): JsonValue {
  let value = state;
  for (const input of inputs) {
    value = rules.step(structuredClone(value), { buttons: 0, ...input }, 1);
  }
  return value;
}

const A = { confirmEdge: true };
const B = { cancelEdge: true };
const DOWN = { downEdge: true };

describe("real daycare import", () => {
  test("both source actions are native scenes with untranslated-full PO labels", () => {
    expect(importedScenes).toHaveLength(2);
    expect(importedScenes.map((scene) => scene.args)).toEqual([IMPORTED_ARGS, IMPORTED_ARGS]);
    expect((IMPORTED_ARGS as { labels: Record<string, string> }).labels).toMatchObject({
      summary: "Daycare Summary",
      modeIncompatible: "Training (Incompatible Pair)",
      expPerStep: "EXP per Step (per monster)",
      noBreeding: "No breeding possible.",
    });
    expect(BUILD.report.coverage.actions.rows.find((row) => row.type === "daycare"))
      .toMatchObject({ total: 2, native: 2, degraded: 0, placeholder: 0, dropped: 0 });
  });

  test("the imported maps need no synthetic per-cell observer events", () => {
    for (const map of BUILD.project.maps) {
      expect(map.events?.some((event) => event.id === "zz_tux_runtime_daycare_step")).toBe(false);
    }
    expect(extensions.playerStep).toEqual({ call: "tux.player_step", args: {} });
  });
});

describe("daycare scene", () => {
  const rules = scenes[TUXEMON_DAYCARE_SCENE_ID]!;
  const male = monster("bamboon", "parent-m", { gender: "male", stage: "stage1" });
  const female = monster("bigfin", "parent-f", { gender: "female", stage: "stage1" });

  test("opening and leaving before a deposit preserves sparse bytes exactly", () => {
    const value = ext();
    const started = rules.start(value, IMPORTED_ARGS, 1, context(value))!;
    expect((started.state as unknown as DaycareSceneState).daycare).toBeUndefined();
    const completion = rules.done(stepScene(rules, started.state, B))!;
    expect(completion.ext).toBe(value);
  });

  test("deposits two parents into fixed slots and commits atomically", () => {
    const value = ext((state) => { state.party = [male, female]; });
    const started = rules.start(value, IMPORTED_ARGS, 2, context(value))!;
    let state = stepScene(rules, started.state, A, A, A, A);
    const draft = state as unknown as DaycareSceneState;
    expect(draft.party).toEqual([]);
    expect(draft.daycare?.parents.map((parent) => parent.iid)).toEqual(["parent-m", "parent-f"]);
    expect(daycareMenuItems(draft)).toEqual(["withdraw", "exit"]);
    state = stepScene(rules, state, DOWN, A);
    const completion = rules.done(state)!;
    const committed = tuxemonExtensionState(completion.ext!, DB);
    expect(committed.party).toEqual([]);
    expect(committed.daycare?.parents.map((parent) => parent.iid)).toEqual(["parent-m", "parent-f"]);
  });

  test("collecting is seed-deterministic, keeps parents, and resets progress", () => {
    const value = ext((state) => {
      state.daycare = daycare([male, female], 10_000);
      state.nextMonsterId = 9;
    });
    const collect = (seed: number) => {
      const started = rules.start(value, IMPORTED_ARGS, seed, context(value))!;
      return rules.done(stepScene(rules, started.state, A))!.ext!;
    };
    expect(collect(0x1234_5678)).toBe(collect(0x1234_5678));
    const committed = tuxemonExtensionState(collect(0x1234_5678), DB);
    expect(committed.daycare?.parents.map((parent) => parent.iid)).toEqual(["parent-m", "parent-f"]);
    expect(committed.daycare?.progressSteps).toBe(0);
    expect(committed.party).toHaveLength(1);
    expect(committed.party[0]).toMatchObject({
      iid: "txmn-000009",
      acquisition: "bred",
      motherIid: "parent-f",
      fatherIid: "parent-m",
    });
    expect(committed.caught).toEqual([committed.party[0]!.slug]);
    expect(committed.nextMonsterId).toBe(10);
  });

  test("withdrawing a ready pair routes the newborn first and returns both parents", () => {
    const value = ext((state) => { state.daycare = daycare([male, female], 10_000); });
    const started = rules.start(value, IMPORTED_ARGS, 99, context(value))!;
    const completion = rules.done(stepScene(rules, started.state, DOWN, A))!;
    const committed = tuxemonExtensionState(completion.ext!, DB);
    expect(committed).not.toHaveProperty("daycare");
    expect(committed.party).toHaveLength(3);
    expect(committed.party.slice(1).map((parent) => parent.iid)).toEqual(["parent-m", "parent-f"]);
  });

  test("long localized labels hard-wrap and paginate without losing characters", () => {
    const long = "DaycareTranslationWithoutAnySafeWhitespaceBoundary".repeat(4);
    const args = structuredClone(IMPORTED_ARGS) as { labels: Record<string, string> };
    args.labels.summary = long;
    const value = ext();
    const started = rules.start(value, args as unknown as JsonValue, 1, context(value))!;
    const draft = started.state as unknown as DaycareSceneState;
    expect(daycareWrapAll(long, 19).join("")).toBe(long);
    expect(daycareTextPages(draft, 19, 3).flat().join("\n").replaceAll("\n", ""))
      .toContain(long);
  });
});

function eventRectContains(event: NonNullable<MapDef["events"]>[number], x: number, y: number): boolean {
  return x >= event.x && x < event.x + (event.w ?? 1) && y >= event.y && y < event.y + (event.h ?? 1);
}

function clearHorizontalStep(map: MapDef): { x: number; y: number } {
  const blocked = new Set((map.passage ?? []).filter(([, passage]) => passage === "block").map(([index]) => index));
  const authored = map.events ?? [];
  for (let y = 1; y < map.height - 1; y++) for (let x = 1; x < map.width - 2; x++) {
    if (blocked.has(y * map.width + x) || blocked.has(y * map.width + x + 1)) continue;
    if (authored.some((event) => eventRectContains(event, x, y) || eventRectContains(event, x + 1, y))) continue;
    return { x, y };
  }
  throw new Error(`no clear horizontal step in ${map.id}`);
}

function landOne(
  session: Session,
  value: SessionState,
  buttons: number,
): SessionState {
  const start = [value.move.tx, value.move.ty] as const;
  let state = stepSession(session, value, { buttons });
  let guard = 0;
  while (state.move.tx === start[0] && state.move.ty === start[1] && guard++ < 60) {
    state = stepSession(session, state, { buttons: 0 });
  }
  expect(Math.abs(state.move.tx - start[0]) + Math.abs(state.move.ty - start[1])).toBe(1);
  expect(state.move.moving).toBe(false);
  return state;
}

function deposited(parent: SpawnedMonsterSnapshot): JsonValue {
  const rules = scenes[TUXEMON_DAYCARE_SCENE_ID]!;
  const value = ext((state) => { state.party = [parent]; });
  const started = rules.start(value, IMPORTED_ARGS, 0xabc, context(value))!;
  const depositedState = stepScene(rules, started.state, A, A, DOWN, A);
  const completion = rules.done(depositedState);
  if (!completion?.ext) throw new Error("daycare deposit fixture did not complete");
  return completion.ext;
}

function walkingProject(map: MapDef, start: { x: number; y: number }, gold: number): Project {
  return {
    ...BUILD.project,
    initialGold: gold,
    start: { map: map.id, ...start, dir: "right" },
  };
}

function walkBackAndForth(
  session: Session,
  value: SessionState,
  steps: number,
): SessionState {
  let state = value;
  for (let index = 0; index < steps; index++) {
    state = landOne(session, state, index % 2 === 0 ? BTN_BITS.RIGHT : BTN_BITS.LEFT);
  }
  return state;
}

/** Four movements begin on 30-reference-tick boundaries, which every
 * supported host rate can represent. The terminal state is sampled at the
 * same 120th reference tick instead of at each host's first post-landing
 * frame. */
function walkBackAndForthAtRate(
  session: Session,
  value: SessionState,
  hz: 60 | 30 | 20,
  steps: number,
): SessionState {
  const ticksPerFrame = 60 / hz;
  let state = value;
  for (let tick = 0; tick < steps * 30; tick += ticksPerFrame) {
    const startsStep = tick % 30 === 0;
    const stepIndex = tick / 30;
    const buttons = startsStep
      ? stepIndex % 2 === 0 ? BTN_BITS.RIGHT : BTN_BITS.LEFT
      : 0;
    state = stepSession(session, state, { buttons });
  }
  return state;
}

describe("real imported per-tile hook", () => {
  test("does not count placement and counts one landed tile at 60/30/20 Hz", () => {
    const map = BUILD.project.maps.find((candidate) => candidate.id === "spyder_paper_daycare")!;
    const start = clearHorizontalStep(map);
    const parent = monster("rockitten", "walker");
    const value = ext((state) => { state.daycare = daycare([parent]); });
    const counts = [60, 30, 20].map((hz) => {
      const project: Project = { ...BUILD.project, start: { map: map.id, ...start, dir: "right" } };
      const session = createSession(project, hz, TUXEMON_SESSION_OPTIONS);
      let state = startSession(project, session, undefined, value);
      for (let frame = 0; frame < 4; frame++) {
        state = stepSession(session, state, { buttons: 0 });
      }
      expect(tuxemonExtensionState(state.ext, DB).daycare?.pendingExperience).toBe(0);
      state = landOne(session, state, BTN_BITS.RIGHT);
      expect(state.move.tx).toBe(start.x + 1);
      return tuxemonExtensionState(state.ext, DB).daycare?.pendingExperience;
    });
    expect(counts).toEqual([0.25, 0.25, 0.25]);
  });

  test("unused sparse saves make the movement command a byte-preserving no-op", () => {
    const value = ext();
    const result = extensions.commands!["tux.player_step"]!({
      ...context(value),
      random: () => 0.5,
    }, {});
    expect(result).toBeUndefined();
    expect(packTuxemonExtensionState(initialTuxemonExtensionState())).toBe(value);
  });

  test("counts a waited forced player route", () => {
    const parent = monster("rockitten", "forced-walker");
    const value = ext((state) => { state.daycare = daycare([parent]); });
    const project: Project = {
      format: "rpgkit-project/v1",
      title: "daycare forced step",
      tileSize: 16,
      start: { map: "route", x: 2, y: 2, dir: "up" },
      sheets: [{ id: "plain", cols: 1, rows: 1, pak: "chunks", defaultPassage: "pass" }],
      items: [],
      maps: [{
        id: "route",
        name: "route",
        width: 6,
        height: 6,
        ground: new Array(36).fill("plain.0"),
        events: [{
          id: "a_route",
          x: 2,
          y: 1,
          pages: [{
            trigger: "action",
            commands: [{
              op: "moveRoute",
              target: "player",
              wait: true,
              route: { steps: ["moveRight"], repeat: false, skippable: true },
            }],
          }],
        }],
      }],
    };
    const session = createSession(project, 60, { extensions });
    let state = startSession(project, session, undefined, value);
    state = stepSession(session, state, { buttons: 0, confirmEdge: true });
    for (let tick = 0; tick < 30; tick++) state = stepSession(session, state, { buttons: 0 });
    expect(state.move.tx).toBe(3);
    expect(tuxemonExtensionState(state.ext, DB).daycare?.pendingExperience).toBe(0.25);
  });

  test("real deposit, four landings and withdrawal settle EXP and one shared fee at every host rate", () => {
    const map = BUILD.project.maps.find((candidate) => candidate.id === "spyder_paper_daycare")!;
    const start = clearHorizontalStep(map);
    const parent = monster("rockitten", "training-parent");
    const startExperience = parent.totalExperience!;
    const depositedExt = deposited(parent);
    const outcomes = ([60, 30, 20] as const).map((hz) => {
      const project = walkingProject(map, start, 5);
      const session = createSession(project, hz, TUXEMON_SESSION_OPTIONS);
      let state = startSession(project, session, undefined, depositedExt);
      state = walkBackAndForthAtRate(session, state, hz, 4);
      const trained = tuxemonExtensionState(state.ext, DB);
      expect(trained.daycare).toMatchObject({
        pendingExperience: 0,
        lastTrainingExp: 1,
        lastTrainingCost: 1,
      });
      expect(trained.daycare!.parents[0]!.totalExperience).toBe(startExperience + 1);
      expect(state.sw.gold).toBe(4);

      const rules = scenes[TUXEMON_DAYCARE_SCENE_ID]!;
      const opened = rules.start(state.ext, IMPORTED_ARGS, 17, context(state.ext, state.sw.gold))!;
      const completion = rules.done(stepScene(rules, opened.state, A))!;
      const withdrawn = tuxemonExtensionState(completion.ext!, DB);
      expect(withdrawn).not.toHaveProperty("daycare");
      expect(withdrawn.party.map((entry) => entry.iid)).toEqual(["training-parent"]);
      expect(withdrawn.party[0]!.totalExperience).toBe(startExperience + 1);
      return canonicalJson({ ext: completion.ext!, gold: state.sw.gold });
    });
    expect(outcomes[1]).toBe(outcomes[0]);
    expect(outcomes[2]).toBe(outcomes[0]);
  });

  test("real walking pauses training without money and retains the full pending EXP", () => {
    const map = BUILD.project.maps.find((candidate) => candidate.id === "spyder_paper_daycare")!;
    const start = clearHorizontalStep(map);
    const parent = monster("rockitten", "unpaid-parent");
    const project = walkingProject(map, start, 0);
    const session = createSession(project, 60, TUXEMON_SESSION_OPTIONS);
    let state = startSession(project, session, undefined, deposited(parent));
    state = walkBackAndForth(session, state, 4);
    const paused = tuxemonExtensionState(state.ext, DB).daycare!;
    expect(paused.pendingExperience).toBe(1);
    expect(paused.lastTrainingExp).toBe(0);
    expect(paused.lastTrainingCost).toBe(0);
    expect(paused.parents[0]!.totalExperience).toBe(parent.totalExperience);
    expect(state.sw.gold).toBe(0);
  });

  test("a save restores the half-EXP boundary and continues byte-identically", () => {
    const map = BUILD.project.maps.find((candidate) => candidate.id === "spyder_paper_daycare")!;
    const start = clearHorizontalStep(map);
    const parent = monster("rockitten", "saved-parent");
    const project = walkingProject(map, start, 5);
    const session = createSession(project, 60, TUXEMON_SESSION_OPTIONS);
    let reference = startSession(project, session, undefined, deposited(parent));
    reference = walkBackAndForth(session, reference, 2);
    expect(tuxemonExtensionState(reference.ext, DB).daycare?.pendingExperience).toBe(0.5);
    let restored = restoreSessionSnapshot(
      session,
      structuredClone(createSessionSnapshot(session, reference, 0)),
    );
    reference = walkBackAndForth(session, reference, 2);
    restored = walkBackAndForth(session, restored, 2);
    expect(canonicalJson(restored)).toBe(canonicalJson(reference));
    expect(tuxemonExtensionState(restored.ext, DB).daycare?.lastTrainingExp).toBe(1);
    expect(restored.sw.gold).toBe(4);
  });

  test("L rewind restores daycare progress at the exact landed-tile boundary", () => {
    const map = BUILD.project.maps.find((candidate) => candidate.id === "spyder_paper_daycare")!;
    const start = clearHorizontalStep(map);
    const parent = monster("rockitten", "rewind-parent");
    const project = walkingProject(map, start, 5);
    const initial = deposited(parent);
    const controllerOptions = {
      ...TUXEMON_SESSION_OPTIONS,
      extensions: { ...extensions, initial },
      hz: 60,
      attractEnabled: false,
      rewindSeconds: 8 / 60,
    } as const;
    const rewound = new AttractController(project, [], controllerOptions);
    const fresh = new AttractController(project, [], controllerOptions);
    rewound.startPlay();
    fresh.startPlay();
    const firstStep = [BTN_BITS.RIGHT, ...new Array(7).fill(0)];
    const secondStep = [BTN_BITS.LEFT, ...new Array(7).fill(0)];
    for (const mask of firstStep) {
      rewound.step(mask);
      fresh.step(mask);
    }
    for (const mask of secondStep) rewound.step(mask);
    expect(tuxemonExtensionState(rewound.state.ext, DB).daycare?.pendingExperience).toBe(0.5);
    rewound.step(0x0100);
    expect(rewound.length).toBe(fresh.length);
    expect(canonicalJson(rewound.state)).toBe(canonicalJson(fresh.state));
    expect(tuxemonExtensionState(rewound.state.ext, DB).daycare?.pendingExperience).toBe(0.25);
  });
});
