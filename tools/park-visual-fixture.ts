// Production-bundle fixture for Eclipse Park's dedicated encounter menu and
// settlement scene. Reducer states come from the shipped English/Chinese
// databases and mount through the same GameView registries used in play.

import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

import {
  initialTuxemonExtensionState,
  packTuxemonExtensionState,
} from "../battle/extension.ts";
import { battleDbToTuxemonBattleDb } from "../battle/from-battle-db.ts";
import {
  TUXEMON_BATTLE_DB,
  TUXEMON_VARIABLE_ENUMS,
  TUXEMON_SCENES,
} from "../battle/game.ts";
import {
  TUXEMON_BATTLE_DB_ZH,
  TUXEMON_VARIABLE_ENUMS_ZH,
  TUXEMON_SCENES_ZH,
} from "../battle/game-zh.ts";
import { emptyParkSession } from "../battle/park.ts";
import {
  BATTLE_EVENT_TICKS,
  createTuxemonBattleRules,
  tuxemonRuntimeBattleState,
} from "../battle/runtime.ts";
import {
  TUXEMON_PARK_SUMMARY_SCENE_ID,
} from "../battle/scenes.ts";
import { spawnMonster } from "../battle/spawn.ts";
import { FIXED_TIME_HOST_GLOBALS } from "../battle/time-weather.ts";
import type { BattleDb } from "../importer/battle-schema.ts";
import type { JsonValue } from "../vendor/pocket-rpgkit/src/engine/types.ts";
import {
  __packTouch,
  __packTouchWide,
} from "../vendor/pocket-rpgkit/vendor/pocketjs/framework/src/touch.ts";
import { bootWorld, type SimWorld } from "../vendor/pocket-rpgkit/vendor/pocketjs/hosts/sim/sim.ts";

const ROOT = resolve(import.meta.dir, "..");
const BUNDLE = join(ROOT, "dist/main");

export const PARK_VISUAL_VIEWPORTS = [
  { width: 480, height: 272 },
  { width: 960, height: 544 },
] as const;
export const PARK_VISUAL_LANGS = ["en_US", "zh_CN"] as const;
export const PARK_VISUAL_CASES = ["encounter", "summary"] as const;
export type ParkVisualLang = typeof PARK_VISUAL_LANGS[number];
export type ParkVisualCase = typeof PARK_VISUAL_CASES[number];

export function parkGoldenFile(
  lang: ParkVisualLang,
  visualCase: ParkVisualCase,
  viewport: { width: number; height: number },
): string {
  const suffix = lang === "zh_CN" ? ".zh" : "";
  return `park-${visualCase}${suffix}.${viewport.width}x${viewport.height}.png`;
}

function dbFor(lang: ParkVisualLang): BattleDb {
  return lang === "zh_CN" ? TUXEMON_BATTLE_DB_ZH : TUXEMON_BATTLE_DB;
}

function parkExtension(db: BattleDb): JsonValue {
  const rulesDb = battleDbToTuxemonBattleDb(db);
  const player = spawnMonster(
    db,
    rulesDb,
    { rng: 0x4150, rngDraws: 0 },
    "nut",
    12,
    { iid: "park-visual-player" },
  );
  return packTuxemonExtensionState({
    ...initialTuxemonExtensionState(),
    party: [player],
    environment: "park",
    parkSession: emptyParkSession(true),
    nextMonsterId: 2,
  });
}

function encounterState(lang: ParkVisualLang): JsonValue {
  const db = dbFor(lang);
  const rules = createTuxemonBattleRules(
    db,
    lang === "zh_CN" ? TUXEMON_VARIABLE_ENUMS_ZH : TUXEMON_VARIABLE_ENUMS,
  );
  const ext = parkExtension(db);
  const started = rules.start(ext, {
    kind: "wild",
    species: "pairagrim",
    level: 6,
    environment: "park",
  }, 0x4150, {
    ext,
    switches: {},
    variables: {},
    items: { tuxeball_park: 25 },
    gold: 0,
    playerName: "Park Tester",
  });
  if (!started) throw new Error("park visual fixture: Park encounter did not start");
  let state = started.state;
  for (let guard = 0; guard < 1_000; guard++) {
    const current = tuxemonRuntimeBattleState(state);
    if (current.eventCursor >= current.battle.events.length) return state;
    state = rules.step(state, { buttons: 0, confirmEdge: true }, BATTLE_EVENT_TICKS);
  }
  throw new Error("park visual fixture: Park encounter did not reach its menu");
}

function summaryState(lang: ParkVisualLang): JsonValue {
  const session = {
    ...emptyParkSession(false),
    summaryPending: true as const,
    sightings: { pairagrim: 12 },
    failedAttempts: 2,
    successfulCaptures: 3,
    history: [
      { monster: "pairagrim", turnsRemaining: 30 },
      { monster: "pairagrim", turnsRemaining: 28 },
      { monster: "pairagrim", turnsRemaining: 26 },
    ],
  };
  const ext = packTuxemonExtensionState({ ...initialTuxemonExtensionState(), parkSession: session });
  const scenes = lang === "zh_CN" ? TUXEMON_SCENES_ZH : TUXEMON_SCENES;
  const started = scenes[TUXEMON_PARK_SUMMARY_SCENE_ID]!.start(ext, {}, 0x4150, {
    ext,
    switches: {},
    variables: {},
    items: {},
    gold: 0,
    playerName: "Park Tester",
  });
  if (!started) throw new Error("park visual fixture: settlement scene did not start");
  return started.state;
}

function pump(world: SimWorld, frames: number): void {
  for (let frame = 0; frame < frames; frame++) {
    world.frame(0, 0x8080);
    world.tick();
  }
}

function drawnPoint(
  viewport: { width: number; height: number },
  baseX: number,
  baseY: number,
): { x: number; y: number } {
  const scale = Math.min(viewport.width / 480, viewport.height / 272);
  const left = Math.floor((viewport.width - 480 * scale) / 2);
  const top = Math.floor((viewport.height - 272 * scale) / 2);
  return { x: left + baseX * scale, y: top + baseY * scale };
}

function tapSummaryClose(world: SimWorld, viewport: { width: number; height: number }): void {
  const point = drawnPoint(viewport, 240, 246);
  const contact = viewport.width > 512 || viewport.height > 512
    ? __packTouchWide(1, point.x, point.y)
    : __packTouch(1, point.x, point.y);
  world.frame(0, 0x8080, [contact]);
  world.tick();
  world.frame(0, 0x8080, []);
  world.tick();
  pump(world, 2);
}

export interface ParkVisualCapture {
  width: number;
  height: number;
  lang: ParkVisualLang;
  cases: Record<ParkVisualCase, { rgba: Uint8Array; tree: unknown; state: JsonValue }>;
  touchClosed: boolean;
}

export async function capturePark(
  lang: ParkVisualLang,
  viewport: { width: number; height: number },
): Promise<ParkVisualCapture> {
  if (!existsSync(BUNDLE + ".js") || !existsSync(BUNDLE + ".pak")) {
    throw new Error("park visual fixture: run `bun run import && bun run build` first");
  }
  const world = await bootWorld(BUNDLE, 60, {
    ...FIXED_TIME_HOST_GLOBALS,
    __pocketTuxemonLang: lang,
  }, undefined, viewport);
  pump(world, 2);
  const session = globalThis.__rpgSessionState;
  if (!session) throw new Error("park visual fixture: production session probe is unavailable");
  const fiber = session.interp.main?.key ?? "park-visual-fixture";

  const battle = encounterState(lang);
  session.scene = { kind: "battle", fiber, state: battle, pausedTicks: 0 };
  pump(world, 2);
  const encounter = {
    rgba: world.render().slice(),
    tree: structuredClone(world.getTree()),
    state: battle,
  };

  const summary = summaryState(lang);
  globalThis.__rpgSessionState!.scene = {
    kind: "scene",
    id: TUXEMON_PARK_SUMMARY_SCENE_ID,
    fiber,
    state: summary,
    pausedTicks: 0,
  };
  pump(world, 2);
  const settlement = {
    rgba: world.render().slice(),
    tree: structuredClone(world.getTree()),
    state: summary,
  };
  tapSummaryClose(world, viewport);

  return {
    ...viewport,
    lang,
    cases: { encounter, summary: settlement },
    touchClosed: globalThis.__rpgSessionState?.scene === null,
  };
}
