// Production-bundle fixture for two imported Spyder double battles. Each
// capture boots a real save immediately beside the authored map event, drives
// that event through the shipped session reducer, and stops on the first
// battle command menu. No battle scene is injected by the fixture.

import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import {
  initialTuxemonExtensionState,
  packTuxemonExtensionState,
} from "../battle/extension.ts";
import { battleDbToTuxemonBattleDb } from "../battle/from-battle-db.ts";
import {
  TUXEMON_BATTLE_DB,
  TUXEMON_SESSION_OPTIONS,
} from "../battle/game.ts";
import {
  TUXEMON_BATTLE_DB_ZH,
  TUXEMON_SESSION_OPTIONS_ZH,
} from "../battle/game-zh.ts";
import { tuxemonRuntimeBattleState, type RuntimeBattleState } from "../battle/runtime.ts";
import { spawnMonster } from "../battle/spawn.ts";
import { FIXED_TIME_HOST_GLOBALS } from "../battle/time-weather.ts";
import type { BattleDb } from "../importer/battle-schema.ts";
import { createAutosaveSessionSnapshot } from "../vendor/pocket-rpgkit/src/engine/save.ts";
import {
  createSession,
  startSession,
  type SessionState,
} from "../vendor/pocket-rpgkit/src/engine/session.ts";
import type { Project } from "../vendor/pocket-rpgkit/src/engine/types.ts";
import {
  bootWorld,
  type SimWorld,
} from "../vendor/pocket-rpgkit/vendor/pocketjs/hosts/sim/sim.ts";
import { mainlineSessionOptions } from "./mainline-session.ts";

const ROOT = resolve(import.meta.dir, "..");
const BUNDLE = join(ROOT, "dist/main");
const BTN_RIGHT = 0x0020;
const BTN_CONFIRM = 0x2000;

export const DOUBLE_BATTLE_VIEWPORTS = [
  { width: 480, height: 272 },
  { width: 960, height: 544 },
] as const;
export const DOUBLE_BATTLE_LANGS = ["en_US", "zh_CN"] as const;
export const DOUBLE_BATTLE_CASES = ["route5", "dragonscave"] as const;
export type DoubleBattleLang = typeof DOUBLE_BATTLE_LANGS[number];
export type DoubleBattleCase = typeof DOUBLE_BATTLE_CASES[number];

const SETUP: Record<DoubleBattleCase, {
  map: string;
  x: number;
  y: number;
  dir: Project["start"]["dir"];
  opponent: string;
}> = {
  route5: {
    map: "spyder_route5",
    x: 19,
    y: 5,
    dir: "left",
    opponent: "spyder_route5_tryphaena",
  },
  dragonscave: {
    map: "spyder_dragonscave",
    x: 15,
    y: 5,
    dir: "right",
    opponent: "spyder_dragonscave_ray",
  },
};

export function doubleBattleGoldenFile(
  lang: DoubleBattleLang,
  visualCase: DoubleBattleCase,
  viewport: { width: number; height: number },
): string {
  const suffix = lang === "zh_CN" ? ".zh" : "";
  return `double-${visualCase}${suffix}.${viewport.width}x${viewport.height}.png`;
}

function dbFor(lang: DoubleBattleLang): BattleDb {
  return lang === "zh_CN" ? TUXEMON_BATTLE_DB_ZH : TUXEMON_BATTLE_DB;
}

const snapshots = new Map<string, string>();
export function doubleBattleBootSnapshot(
  lang: DoubleBattleLang,
  visualCase: DoubleBattleCase,
): string {
  const key = `${lang}:${visualCase}`;
  const cached = snapshots.get(key);
  if (cached) return cached;

  const projectFile = lang === "zh_CN" ? "dist/project.zh_CN.json" : "dist/project.json";
  const project = JSON.parse(readFileSync(join(ROOT, projectFile), "utf8")) as Project;
  const setup = SETUP[visualCase];
  project.start = { map: setup.map, x: setup.x, y: setup.y, dir: setup.dir };
  const overrides = lang === "zh_CN" ? TUXEMON_SESSION_OPTIONS_ZH : TUXEMON_SESSION_OPTIONS;
  const session = createSession(project, 60, mainlineSessionOptions(project, undefined, overrides));
  const db = dbFor(lang);
  const rulesDb = battleDbToTuxemonBattleDb(db);
  const party = [
    spawnMonster(db, rulesDb, { rng: 0x4549, rngDraws: 0 }, "nut", 50, {
      iid: `double-visual-${visualCase}-a`,
    }),
    spawnMonster(db, rulesDb, { rng: 0x454a, rngDraws: 0 }, "rockitten", 50, {
      iid: `double-visual-${visualCase}-b`,
    }),
  ];
  const ext = packTuxemonExtensionState({
    ...initialTuxemonExtensionState(),
    party,
    environment: "grass",
    nextMonsterId: 3,
  });
  const state = startSession(project, session, undefined, ext);
  const snapshot = createAutosaveSessionSnapshot(session, state, 0);
  if (!snapshot) throw new Error(`double battle fixture: could not save ${key}`);
  const encoded = JSON.stringify(snapshot);
  snapshots.set(key, encoded);
  return encoded;
}

function live(): SessionState {
  const state = globalThis.__rpgSessionState;
  if (!state) throw new Error("double battle fixture: production session probe is unavailable");
  return state;
}

function frame(world: SimWorld, buttons = 0): void {
  world.frame(buttons, 0x8080);
  world.tick();
}

function pump(world: SimWorld, frames: number): void {
  for (let i = 0; i < frames; i++) frame(world);
}

function press(world: SimWorld, buttons: number): void {
  frame(world, buttons);
  frame(world);
}

function triggerMapEvent(world: SimWorld, visualCase: DoubleBattleCase): void {
  // Give the imported parallel spawn guards time to place the trainers.
  pump(world, 20);
  if (visualCase === "route5") {
    // Object 77 is Tryphaena's action page immediately left of the player.
    press(world, BTN_CONFIRM);
  } else {
    // Object 98 is a player-touch strip one tile to the right. Hold a
    // controller direction until its lockInput page takes ownership.
    for (let i = 0; i < 90; i++) {
      if (live().interp.inputLocked || live().interp.modal) break;
      frame(world, BTN_RIGHT);
    }
    frame(world);
  }

  for (let guard = 0; guard < 4_000; guard++) {
    if (live().scene?.kind === "battle") return;
    if (live().interp.modal?.kind === "text") press(world, BTN_CONFIRM);
    else frame(world);
  }
  throw new Error(`double battle fixture: ${visualCase} map event did not start a battle`);
}

function reachRootMenu(world: SimWorld): RuntimeBattleState {
  for (let guard = 0; guard < 2_000; guard++) {
    const scene = live().scene;
    if (scene?.kind !== "battle") throw new Error("double battle fixture: battle scene closed early");
    const state = tuxemonRuntimeBattleState(scene.state);
    if (state.eventCursor === state.battle.events.length && state.battle.awaiting !== null
      && state.menuMode === "root") {
      // One paint after the reducer boundary resolves all lazy battle art.
      pump(world, 2);
      return tuxemonRuntimeBattleState(live().scene!.state);
    }
    press(world, BTN_CONFIRM);
  }
  throw new Error("double battle fixture: initial presentation never reached the root menu");
}

export interface DoubleBattleCapture {
  width: number;
  height: number;
  lang: DoubleBattleLang;
  case: DoubleBattleCase;
  rgba: Uint8Array;
  tree: unknown;
  state: RuntimeBattleState;
  map: string;
  player: { x: number; y: number };
}

export async function captureDoubleBattle(
  lang: DoubleBattleLang,
  visualCase: DoubleBattleCase,
  viewport: { width: number; height: number },
): Promise<DoubleBattleCapture> {
  if (!existsSync(BUNDLE + ".js") || !existsSync(BUNDLE + ".pak")) {
    throw new Error("double battle fixture: run `bun run import && bun run build` first");
  }
  const globals = globalThis as Record<string, unknown>;
  const previousLang = globals.__pocketTuxemonLang;
  const previousSnapshot = globals.__pocketTuxemonBootSnapshot;
  try {
    const world = await bootWorld(BUNDLE, 60, {
      ...FIXED_TIME_HOST_GLOBALS,
      __pocketTuxemonLang: lang,
      __pocketTuxemonBootSnapshot: doubleBattleBootSnapshot(lang, visualCase),
    }, undefined, viewport);
    pump(world, 4);
    const setup = SETUP[visualCase];
    if (live().mapId !== setup.map) {
      throw new Error(`double battle fixture: ${visualCase} restored on ${live().mapId}`);
    }
    triggerMapEvent(world, visualCase);
    const state = reachRootMenu(world);
    if (state.battle.opponent !== setup.opponent || state.battle.fieldSize !== 2) {
      throw new Error(
        `double battle fixture: ${visualCase} opened ${state.battle.opponent} fieldSize=${state.battle.fieldSize}`,
      );
    }
    return {
      ...viewport,
      lang,
      case: visualCase,
      rgba: world.render().slice(),
      tree: structuredClone(world.getTree()),
      state: structuredClone(state),
      map: live().mapId,
      player: { x: live().move.tx, y: live().move.ty },
    };
  } finally {
    if (previousLang === undefined) delete globals.__pocketTuxemonLang;
    else globals.__pocketTuxemonLang = previousLang;
    if (previousSnapshot === undefined) delete globals.__pocketTuxemonBootSnapshot;
    else globals.__pocketTuxemonBootSnapshot = previousSnapshot;
  }
}
