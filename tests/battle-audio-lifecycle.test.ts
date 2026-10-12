import { expect, test } from "bun:test";
import battleDbJson from "../data/battle-db.json";
import variableEnumsJson from "../dist/variable-enums.json";

import { battleDbToTuxemonBattleDb } from "../battle/from-battle-db.ts";
import { createTuxemonExtensions } from "../battle/extension.ts";
import { battleAutoplayInput } from "../battle/autoplay.ts";
import {
  createTuxemonBattleRules,
  tuxemonRuntimeBattleState,
  type VariableEnums,
} from "../battle/runtime.ts";
import { validateBattleDb } from "../importer/battle-schema.ts";
import { buildProject, G6_IMPORT_OPTIONS } from "../importer/project.ts";
import {
  restoreSave,
  saveBlockReason,
  SaveRefused,
  takeSaveSnapshot,
} from "../ui/save-game.ts";
import { canonicalJson } from "../vendor/pocket-rpgkit/src/engine/save.ts";
import {
  createSession,
  startSession,
  stepSession,
  type Session,
  type SessionState,
} from "../vendor/pocket-rpgkit/src/engine/session.ts";
import type { Command, Project, TileId } from "../vendor/pocket-rpgkit/src/engine/types.ts";

const DB = validateBattleDb(battleDbJson);
const RULE_DB = battleDbToTuxemonBattleDb(DB);
const ENUMS = variableEnumsJson as VariableEnums;
const NONE = { buttons: 0 };
const CONFIRM = { buttons: 0, confirmEdge: true };

function objectNodes(value: unknown, out: Record<string, unknown>[] = []): Record<string, unknown>[] {
  if (Array.isArray(value)) {
    for (const child of value) objectNodes(child, out);
  } else if (value !== null && typeof value === "object") {
    const object = value as Record<string, unknown>;
    out.push(object);
    for (const child of Object.values(object)) objectNodes(child, out);
  }
  return out;
}

/** A tiny runner around one real imported play_music and one real imported
 * trainer battle. It retains the production audio table and battle DB while
 * avoiding a journey-sized input tape in this focused lifecycle test. */
function importedAudioBattleHarness(): Project {
  const imported = buildProject(["cotton_town", "spyder_route1"], G6_IMPORT_OPTIONS).project;
  const playMusic = objectNodes(imported).find((node) =>
    node.op === "playBgm" && node.id === "music_town_theme"
  ) as Command | undefined;
  const battle = objectNodes(imported).find((node) => {
    const setup = node.setup as { kind?: unknown; party?: unknown[] } | undefined;
    return node.op === "battle" && setup?.kind === "trainer" && (setup.party?.length ?? 0) > 0;
  }) as Command | undefined;
  if (!playMusic || !battle) throw new Error("missing imported audio battle fixtures");

  const tile = "tux.0" as TileId;
  return {
    ...imported,
    title: "Imported battle audio lifecycle",
    start: { map: "battle_audio", x: 1, y: 2, dir: "up" },
    maps: [{
      id: "battle_audio",
      name: "Imported battle audio lifecycle",
      width: 3,
      height: 3,
      sheets: ["tux"],
      ground: new Array(9).fill(tile),
      events: [{
        id: "flow",
        x: 1,
        y: 1,
        pages: [
          {
            trigger: "autorun",
            commands: [
              structuredClone(playMusic),
              { op: "ext", call: "tux.add_monster", args: { species: "nut", level: 50 } },
              { op: "ext", call: "tux.set_environment", args: { environment: "grass" } },
              { op: "switch", id: "flow.ready", value: true },
            ],
          },
          {
            trigger: "action",
            condition: { switch: "flow.ready" },
            commands: [
              structuredClone(battle),
              { op: "switch", id: "flow.done", value: true },
            ],
          },
          { trigger: "action", condition: { switch: "flow.done" }, commands: [] },
        ],
      }],
    }],
  };
}

function createHarnessSession(project: Project): Session {
  return createSession(project, 60, {
    extensions: createTuxemonExtensions(DB),
    battle: createTuxemonBattleRules(DB, ENUMS),
  });
}

function reachSafeMapMusic(project: Project, session: Session): SessionState {
  let state = startSession(project, session);
  for (let guard = 0; guard < 20 && (
    saveBlockReason(state) !== null || state.sw.switches["flow.ready"] !== true
  ); guard++) {
    state = stepSession(session, state, NONE);
  }
  expect(state.sw.switches["flow.ready"]).toBeTrue();
  expect(saveBlockReason(state)).toBeNull();
  expect(state.interp.audio?.bgm).toMatchObject({
    id: "music_town_theme", volume: 100, pitch: 100,
  });
  return state;
}

function startHarnessBattle(session: Session, state: SessionState): SessionState {
  const started = stepSession(session, state, CONFIRM);
  expect(started.scene?.kind).toBe("battle");
  return started;
}

function finishHarnessBattle(session: Session, initial: SessionState): {
  state: SessionState;
  ids: string[];
} {
  let state = initial;
  const ids: string[] = [];
  let last = "";
  for (let guard = 0; guard < 10_000 && state.scene !== null; guard++) {
    if (state.scene.kind !== "battle") throw new Error("unexpected non-battle scene");
    const id = state.interp.audio?.bgm?.id ?? "";
    if (id !== last) ids.push(id);
    last = id;
    const runtime = tuxemonRuntimeBattleState(state.scene.state);
    state = stepSession(session, state, battleAutoplayInput(RULE_DB, runtime));
  }
  return { state, ids };
}

test("real imported trainer battle plays combat/victory music then restores the map mix", () => {
  const project = importedAudioBattleHarness();
  const session = createHarnessSession(project);
  const mapState = reachSafeMapMusic(project, session);
  const mapPosition = mapState.interp.audio?.bgm?.positionTicks;
  let state = startHarnessBattle(session, mapState);
  expect(state.scene?.kind).toBe("battle");
  if (state.scene?.kind !== "battle") throw new Error("battle did not start");

  const suspended = structuredClone(state.scene.returnAudio);
  if (!suspended) throw new Error("battle did not suspend map audio");
  expect(suspended?.bgm).toMatchObject({ id: "music_town_theme", volume: 100, pitch: 100 });
  expect(suspended.bgm?.positionTicks).toBe((mapPosition ?? -1) + 1);
  expect(state.interp.audio?.bgm).toEqual({
    id: "music_battle_loop", volume: 100, pitch: 100, positionTicks: 0,
  });

  const played = finishHarnessBattle(session, state);
  state = played.state;
  expect(state.scene).toBeNull();
  expect(played.ids).toContain("music_win_battle_boss");
  expect(state.interp.audio).toEqual(suspended);
  state = stepSession(session, state, NONE);
  expect(state.sw.switches["flow.done"]).toBeTrue();
});

test("safe save resumes the same music lifecycle and active battle saves are refused", () => {
  const project = importedAudioBattleHarness();
  const session = createHarnessSession(project);
  const safe = reachSafeMapMusic(project, session);
  const snapshot = takeSaveSnapshot(session, safe, 0);
  expect(snapshot.interp.audio?.bgm).toMatchObject({ id: "music_town_theme" });

  const active = startHarnessBattle(session, safe);
  if (active.scene?.kind !== "battle") throw new Error("battle did not start");
  expect(saveBlockReason(active)).toMatch(/battle/i);
  expect(() => takeSaveSnapshot(session, active, 0)).toThrow(SaveRefused);
  const baseline = finishHarnessBattle(session, active);
  expect(baseline.ids).toEqual(["music_battle_loop", "music_win_battle_boss"]);

  const restored = restoreSave(session, snapshot);
  expect(restored.interp.audio).toEqual(safe.interp.audio);
  const replay = finishHarnessBattle(session, startHarnessBattle(session, restored));
  expect(replay.ids).toEqual(baseline.ids);
  expect(canonicalJson(replay.state)).toBe(canonicalJson(baseline.state));
  expect(replay.state.interp.audio).toEqual(active.scene.returnAudio ?? undefined);
});
