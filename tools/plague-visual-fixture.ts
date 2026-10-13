// Production-bundle fixture for the campaign-reachable Spyder Bite plague
// override. The serialized battle comes from the canonical imported database
// and the shipped BattleRules; only the presentation cursor is positioned at
// the early sneeze and late infection narration beats.

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
} from "../battle/game.ts";
import {
  TUXEMON_BATTLE_DB_ZH,
  TUXEMON_VARIABLE_ENUMS_ZH,
} from "../battle/game-zh.ts";
import {
  BATTLE_EVENT_TICKS,
  createTuxemonBattleRules,
  tuxemonRuntimeBattleState,
  type RuntimeBattleState,
} from "../battle/runtime.ts";
import { spawnMonster } from "../battle/spawn.ts";
import { FIXED_TIME_HOST_GLOBALS } from "../battle/time-weather.ts";
import type { BattleDb } from "../importer/battle-schema.ts";
import type { JsonValue } from "../vendor/pocket-rpgkit/src/engine/types.ts";
import {
  bootWorld,
  type SimWorld,
} from "../vendor/pocket-rpgkit/vendor/pocketjs/hosts/sim/sim.ts";

const ROOT = resolve(import.meta.dir, "..");
const BUNDLE = join(ROOT, "dist/main");
// Runtime start consumes encounter/spawn RNG before the reducer pre-check;
// seed 1 deterministically reaches the successful imported plague branch.
const PLAGUE_SEED = 1;

export const PLAGUE_VISUAL_VIEWPORTS = [
  { width: 480, height: 272 },
  { width: 960, height: 544 },
] as const;
export const PLAGUE_VISUAL_LANGS = ["en_US", "zh_CN"] as const;
export const PLAGUE_VISUAL_CASES = ["sneeze", "infected"] as const;
export type PlagueVisualLang = typeof PLAGUE_VISUAL_LANGS[number];
export type PlagueVisualCase = typeof PLAGUE_VISUAL_CASES[number];

export function plagueGoldenFile(
  lang: PlagueVisualLang,
  visualCase: PlagueVisualCase,
  viewport: { width: number; height: number },
): string {
  const suffix = lang === "zh_CN" ? ".zh" : "";
  return `plague-${visualCase}${suffix}.${viewport.width}x${viewport.height}.png`;
}

function dbFor(lang: PlagueVisualLang): BattleDb {
  return lang === "zh_CN" ? TUXEMON_BATTLE_DB_ZH : TUXEMON_BATTLE_DB;
}

function plagueExtension(db: BattleDb): JsonValue {
  const rulesDb = battleDbToTuxemonBattleDb(db);
  const player = spawnMonster(
    db,
    rulesDb,
    { rng: 0x1919, rngDraws: 0 },
    "rockitten",
    5,
    { iid: "plague-visual-player" },
  );
  // The ordinary move is what the player selects. The infected pre-check
  // substitutes the imported, same-named Spyder Bite technique.
  player.moves = ["ram"];
  return packTuxemonExtensionState({
    ...initialTuxemonExtensionState(),
    party: [player],
    environment: "grass",
    nextMonsterId: 2,
    plagueByIid: {
      "plague-visual-player": { spyderbite: "infected" },
    },
  });
}

export interface PlagueVisualStates {
  seed: number;
  eventIndex: number;
  sneeze: RuntimeBattleState;
  infected: RuntimeBattleState;
}

export function plagueVisualStates(lang: PlagueVisualLang): PlagueVisualStates {
  const db = dbFor(lang);
  const rules = createTuxemonBattleRules(
    db,
    lang === "zh_CN" ? TUXEMON_VARIABLE_ENUMS_ZH : TUXEMON_VARIABLE_ENUMS,
  );
  const ext = plagueExtension(db);
  const started = rules.start(ext, {
    kind: "wild",
    species: "nut",
    level: 5,
    environment: "grass",
  }, PLAGUE_SEED, {
    ext,
    switches: {},
    variables: {},
    items: {},
    gold: 0,
    playerName: "Plague Tester",
  });
  if (!started) throw new Error("plague visual fixture: battle did not start");

  let state = started.state;
  // Finish both send-out beats, open Fight, then select the only ordinary
  // technique. This is the same BattleRules boundary driven by GameView.
  let runtime = tuxemonRuntimeBattleState(state);
  for (let guard = 0; guard < 100 && runtime.eventCursor < runtime.battle.events.length; guard++) {
    state = rules.step(
      state,
      { buttons: 0, confirmEdge: true },
      BATTLE_EVENT_TICKS,
    );
    runtime = tuxemonRuntimeBattleState(state);
  }
  if (runtime.eventCursor < runtime.battle.events.length || runtime.menuMode !== "root") {
    throw new Error(
      "plague visual fixture: initial presentation did not reach the root menu "
        + `(cursor=${runtime.eventCursor}/${runtime.battle.events.length}, tick=${runtime.eventTicks}, menu=${runtime.menuMode})`,
    );
  }
  state = rules.step(state, { buttons: 0, confirmEdge: true }, 0);
  runtime = tuxemonRuntimeBattleState(state);
  if (runtime.menuMode !== "technique" || runtime.menu[0]?.slug !== "ram") {
    throw new Error("plague visual fixture: Fight did not expose Ram");
  }
  state = rules.step(state, { buttons: 0, confirmEdge: true }, 0);
  runtime = tuxemonRuntimeBattleState(state);

  const eventIndex = runtime.battle.events.findIndex((event) => {
    const plague = event.plague as { slug?: unknown; phase?: unknown } | undefined;
    return event.type === "technique"
      && event.technique === "spyderbite"
      && plague?.slug === "spyderbite"
      && plague.phase === "infected";
  });
  if (eventIndex < 0) {
    throw new Error(`plague visual fixture: seed ${PLAGUE_SEED} did not infect through Spyder Bite`);
  }
  const sneeze = structuredClone(runtime);
  sneeze.eventCursor = eventIndex;
  sneeze.eventTicks = 0;
  const infected = structuredClone(sneeze);
  infected.eventTicks = 34;
  return { seed: PLAGUE_SEED, eventIndex, sneeze, infected };
}

function pump(world: SimWorld, frames: number): void {
  for (let frame = 0; frame < frames; frame++) {
    world.frame(0, 0x8080);
    world.tick();
  }
}

export interface PlagueVisualCapture {
  width: number;
  height: number;
  lang: PlagueVisualLang;
  seed: number;
  eventIndex: number;
  cases: Record<PlagueVisualCase, {
    rgba: Uint8Array;
    tree: unknown;
    state: RuntimeBattleState;
  }>;
}

export async function capturePlague(
  lang: PlagueVisualLang,
  viewport: { width: number; height: number },
): Promise<PlagueVisualCapture> {
  if (!existsSync(BUNDLE + ".js") || !existsSync(BUNDLE + ".pak")) {
    throw new Error("plague visual fixture: run `bun run import && bun run build` first");
  }
  const states = plagueVisualStates(lang);
  const cases = {} as PlagueVisualCapture["cases"];
  for (const visualCase of PLAGUE_VISUAL_CASES) {
    // A battle renderer is deliberately kept alive across ordinary fights.
    // Each independent golden starts a fresh production host so positioning
    // the cursor cannot inherit memoized presentation fields from another
    // synthetic checkpoint.
    const world = await bootWorld(BUNDLE, 60, {
      ...FIXED_TIME_HOST_GLOBALS,
      __pocketTuxemonLang: lang,
    }, undefined, viewport);
    pump(world, 2);
    const session = globalThis.__rpgSessionState;
    if (!session) throw new Error("plague visual fixture: production session probe is unavailable");
    const fiber = session.interp.main?.key ?? "plague-visual-fixture";
    session.scene = {
      kind: "battle",
      fiber,
      state: structuredClone(states[visualCase]) as unknown as JsonValue,
      pausedTicks: 0,
    };
    pump(world, 1);
    const scene = session.scene;
    if (scene?.kind !== "battle") {
      throw new Error(`plague visual fixture: ${visualCase} scene closed before capture`);
    }
    cases[visualCase] = {
      rgba: world.render().slice(),
      tree: structuredClone(world.getTree()),
      state: structuredClone(tuxemonRuntimeBattleState(scene.state)),
    };
  }

  return {
    ...viewport,
    lang,
    seed: states.seed,
    eventIndex: states.eventIndex,
    cases,
  };
}
