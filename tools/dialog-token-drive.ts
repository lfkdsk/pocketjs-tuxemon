// Shared driver for the dialog-token screenshots and their production-path
// tests. Each shot boots the PRODUCTION bundle (dist/main — the same JS the
// desktop/web/PSP hosts run, which executes main.tsx's GameView mount with
// its textTokens prop), plants a save next to the REAL imported event, loads
// that save through the REAL save menu, then triggers the event with REAL
// button input. The kit expands the dialog's tokens through GameView's
// textTokens wiring and expandTextTokens exactly as in the live game — the
// driver never injects expanded text. The expanded text is read back from
// the live session state and the frame is captured for the visual checks.
//
// Positioning uses the save/load feature on purpose: several template events
// live on maps the mainline transfer graph does not reach from the bedroom,
// and a loaded save is the production way to start there. The save is built
// from a headless session of the same generated project (start overridden to
// the event's doorstep, optional party/clock seeded through the same
// spawnMonster/clock helpers the runtime uses), so every dialog still opens
// from its real event through the real pipeline.

import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { bootWorld } from "../vendor/pocket-rpgkit/vendor/pocketjs/hosts/sim/sim.ts";
import { createSession, startSession, type SessionState } from "../vendor/pocket-rpgkit/src/engine/session.ts";
import { createSessionSnapshot } from "../vendor/pocket-rpgkit/src/engine/save.ts";
import { browserSaveStore, saveSlot } from "../ui/save-game.ts";
import { BTN_BITS } from "../vendor/pocket-rpgkit/src/engine/camera.ts";
import { FIXED_TIME_HOST_GLOBALS, epochDayFromCivil } from "../battle/time-weather.ts";
import { tuxemonExtensionState, packTuxemonExtensionState, type GameLang } from "../battle/extension.ts";
import { spawnMonster } from "../battle/spawn.ts";
import { battleDbToTuxemonBattleDb } from "../battle/from-battle-db.ts";
import {
  createTuxemonSessionOptions,
  TUXEMON_EXTENSIONS,
  TUXEMON_BATTLE_RULES,
  TUXEMON_SCENES,
  TUXEMON_TEXT_TOKENS,
  TUXEMON_BATTLE_DB,
} from "../battle/game.ts";
import {
  TUXEMON_EXTENSIONS_ZH,
  TUXEMON_BATTLE_RULES_ZH,
  TUXEMON_SCENES_ZH,
  TUXEMON_TEXT_TOKENS_ZH,
  TUXEMON_BATTLE_DB_ZH,
} from "../battle/game-zh.ts";
import { readShardedProject } from "./generated-project.ts";

export const ROOT = resolve(import.meta.dir, "..");
export const BUNDLE = join(ROOT, "dist/main");

const BTN_START = 0x0008;
const BTN_DOWN = 0x0040;
const BTN_CIRCLE = 0x2000; // confirm
const DIR_FACE = { up: "up", down: "down", left: "left", right: "right" } as const;
export type FaceDir = keyof typeof DIR_FACE;
const WALK_BIT: Record<FaceDir, number> = {
  up: BTN_BITS.UP,
  down: BTN_BITS.DOWN,
  left: BTN_BITS.LEFT,
  right: BTN_BITS.RIGHT,
};

/** A real imported dialog to open through the production bundle. */
export interface DialogShot {
  slug: string;
  lang: GameLang;
  /** Map that carries the event. */
  mapId: string;
  /** The real imported event id (for the manifest and diagnostics). */
  eventId: string;
  /** action: press confirm while facing the event. touch: walk onto it. */
  trigger: "action" | "touch";
  /** Where the loaded save puts the player: one tile off the event, facing
   *  it (action) or the direction to walk to step onto it (touch). */
  stand: { x: number; y: number; dir: FaceDir };
  /** Seed the lead party monster (the monster_0_* shots). The monster is
   *  spawned with the runtime's own spawnMonster, exactly like tux.add_monster. */
  seedParty?: { slug: string; level: number; nickname?: string };
  /** Pin the in-session clock to this date (the today shot's 4-27 gate). */
  seedDate?: { year: number; month: number; day: number };
  /** Substring of the EXPANDED dialog text that proves the token resolved. */
  expect: string;
  /** Step through a cutscene/dialog sequence, advancing complete modals
   *  with confirm, until `expect` appears (the today cutscene, the wallet
   *  gallery sequence). Without it the first modal is the target. */
  fastForward?: boolean;
  budget?: number;
}

export interface DriveResult {
  text: string;
  rgba: Uint8Array;
  width: number;
  height: number;
}

function memoryStorage() {
  const map = new Map<string, string>();
  return {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => void map.set(key, value),
    removeItem: (key: string) => void map.delete(key),
  };
}

/** Build a headless seamless session of the real generated project, started
 *  on the shot's doorstep, with the shot's party/clock seeded into ext. */
function fixtureSession(shot: DialogShot) {
  const zh = shot.lang === "zh_CN";
  const sharded = readShardedProject(ROOT, shot.lang);
  const project = {
    ...sharded.project,
    start: { map: shot.mapId, x: shot.stand.x, y: shot.stand.y, dir: shot.stand.dir },
  };
  const session = createSession(project, 60, createTuxemonSessionOptions(project, "seamless-v1", {
    maps: sharded.repository,
    extensions: zh ? TUXEMON_EXTENSIONS_ZH : TUXEMON_EXTENSIONS,
    battle: zh ? TUXEMON_BATTLE_RULES_ZH : TUXEMON_BATTLE_RULES,
    scenes: zh ? TUXEMON_SCENES_ZH : TUXEMON_SCENES,
    textTokens: zh ? TUXEMON_TEXT_TOKENS_ZH : TUXEMON_TEXT_TOKENS,
  }));
  let state = startSession(project, session);
  const ext = tuxemonExtensionState(state.ext);
  if (shot.seedParty) {
    const db = zh ? TUXEMON_BATTLE_DB_ZH : TUXEMON_BATTLE_DB;
    const monster = spawnMonster(
      db,
      battleDbToTuxemonBattleDb(db),
      { rng: 7, rngDraws: 0 },
      shot.seedParty.slug,
      shot.seedParty.level,
      { iid: "txmn-shot" },
    );
    if (shot.seedParty.nickname !== undefined) monster.nickname = shot.seedParty.nickname;
    ext.party.push(monster);
  }
  if (shot.seedDate) {
    ext.clock.epochDay = epochDayFromCivil(shot.seedDate.year, shot.seedDate.month, shot.seedDate.day);
  }
  state.ext = packTuxemonExtensionState(ext);
  return { session, state };
}

type World = Awaited<ReturnType<typeof bootWorld>>;

function makeStepper(world: World) {
  return (mask: number) => {
    world.frame(mask, 0x8080);
    for (let t = 0; t < world.ticksPerFrame; t++) world.tick();
  };
}

/** One press: a frame with the button down, then a release frame. */
function makePress(step: (mask: number) => void) {
  return (mask: number) => { step(mask); step(0); };
}

function live(): SessionState {
  return (globalThis as { __rpgSessionState?: SessionState }).__rpgSessionState!;
}

/** The production bundle must be built (CI builds it before tests; locally
 *  run `bun run build`). */
export function bundleIsBuilt(): boolean {
  return existsSync(BUNDLE + ".js");
}

/**
 * Boot the production bundle, load the shot's save through the real save
 * menu, trigger the real event with real input, and return the expanded
 * dialog text plus the captured frame. Throws if the dialog never shows
 * `expect` — a broken textTokens wiring makes the token render literally or
 * as "???", so the assertion fails on the real production path.
 */
export async function driveDialog(
  shot: DialogShot,
  viewport: { width: number; height: number },
): Promise<DriveResult> {
  // 1. Plant a save at the event's doorstep.
  const { session, state } = fixtureSession(shot);
  const snapshot = createSessionSnapshot(session, state, 0);
  const storage = memoryStorage();
  saveSlot({ channel: "browser", store: browserSaveStore(storage) }, 1, snapshot, session.content);

  // 2. Boot the production bundle (main.tsx mounts GameView with textTokens).
  const world = await bootWorld(
    BUNDLE,
    60,
    { ...FIXED_TIME_HOST_GLOBALS, __pocketTuxemonLang: shot.lang, localStorage: storage },
    undefined,
    viewport,
  );
  const step = makeStepper(world);
  const press = makePress(step);

  // 3. Let boot-time autoruns (the bedroom intro question) surface, then
  //    dismiss them so the save menu can open.
  for (let i = 0; i < 60; i++) step(0);
  for (let i = 0; i < 120; i++) {
    if (live().interp.modal) press(BTN_CIRCLE);
    else break;
  }

  // 4. Load slot 1 through the real save menu: START -> DOWN (Load) -> CIRCLE.
  press(BTN_START);
  press(BTN_DOWN);
  press(BTN_CIRCLE);
  press(BTN_CIRCLE);
  for (let i = 0; i < 180; i++) {
    step(0);
    if (live().mapId === shot.mapId) break;
  }
  if (live().mapId !== shot.mapId) {
    throw new Error(`dialog-drive: save load did not reach ${shot.mapId} (got ${live().mapId})`);
  }

  // 5. Trigger the real event.
  if (shot.trigger === "touch") {
    step(WALK_BIT[shot.stand.dir]); // walk onto the event tile
    for (let i = 0; i < 30; i++) step(0);
  } else {
    press(BTN_CIRCLE); // action: confirm while facing the event
  }

  // 6. Find the target dialog, fast-forwarding a sequence/cutscene by
  //    pulsing confirm every other frame (a fresh edge each pulse, exactly
  //    like the headless walkAndAdvance harness's confirmEdge).
  const budget = shot.budget ?? (shot.fastForward ? 2400 : 240);
  for (let f = 0; f < budget; f++) {
    const modal = live().interp.modal;
    if (modal?.kind === "text" && modal.lines.join(" ").includes(shot.expect)) {
      // Let the typewriter finish revealing before capturing.
      for (let i = 0; i < 240 && !modal.complete; i++) step(0);
      return { text: modal.lines.join(" "), rgba: world.render().slice(), width: viewport.width, height: viewport.height };
    }
    step(shot.fastForward && f % 2 === 0 ? BTN_CIRCLE : 0);
  }
  throw new Error(
    `dialog-drive: ${shot.slug} never showed "${shot.expect}"`
      + ` (last modal: ${JSON.stringify(live().interp.modal)})`,
  );
}
