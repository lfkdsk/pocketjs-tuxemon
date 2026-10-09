// Production-bundle fixture for the Spyder Dojo services. A real snapshot is
// created beside a Dojo NPC (party, money and the "already introduced" flag),
// restored through the shipped boot overlay in English or Chinese, and the
// imported talk events are driven with the controller until the selection
// menu or the result box is on screen.

import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import {
  initialTuxemonExtensionState,
  packTuxemonExtensionState,
} from "../battle/extension.ts";
import { TUXEMON_BATTLE_DB, TUXEMON_VARIABLE_ENUMS } from "../battle/game.ts";
import { TUXEMON_SESSION_OPTIONS_ZH } from "../battle/game-zh.ts";
import { battleDbToTuxemonBattleDb } from "../battle/from-battle-db.ts";
import { spawnMonster } from "../battle/spawn.ts";
import { FIXED_TIME_HOST_GLOBALS } from "../battle/time-weather.ts";
import type { ChoiceModal } from "../vendor/pocket-rpgkit/src/engine/interpreter.ts";
import { createSwitchState } from "../vendor/pocket-rpgkit/src/engine/interpreter.ts";
import { createAutosaveSessionSnapshot } from "../vendor/pocket-rpgkit/src/engine/save.ts";
import {
  createSession,
  startSession,
  stepSession,
  type SessionState,
} from "../vendor/pocket-rpgkit/src/engine/session.ts";
import type { Project } from "../vendor/pocket-rpgkit/src/engine/types.ts";
import { bootWorld, type SimWorld } from "../vendor/pocket-rpgkit/vendor/pocketjs/hosts/sim/sim.ts";
import { mainlineSessionOptions } from "./mainline-session.ts";

const ROOT = resolve(import.meta.dir, "..");
const BUNDLE = join(ROOT, "dist/main");
const BTN_CONFIRM = 0x2000;
const BTN_DOWN = 0x0040;

export const DOJO_VISUAL_VIEWPORTS = [
  { width: 480, height: 272 },
  { width: 960, height: 544 },
] as const;
export const DOJO_VISUAL_LANGS = ["en_US", "zh_CN"] as const;
export type DojoLang = typeof DOJO_VISUAL_LANGS[number];
/** forget: Xiang's forget menu; learned: Xiang's result box; devolve: a
 *  student's form menu; taste: Zhu's taste report. */
export const DOJO_VISUAL_CASES = ["forget", "learned", "devolve", "taste"] as const;
export type DojoVisualCase = typeof DOJO_VISUAL_CASES[number];

export function dojoGoldenFile(
  lang: DojoLang,
  visualCase: DojoVisualCase,
  viewport: { width: number; height: number },
): string {
  const suffix = lang === "zh_CN" ? ".zh" : "";
  return `dojo-${visualCase}${suffix}.${viewport.width}x${viewport.height}.png`;
}

function code(name: string, value: string): number {
  return (TUXEMON_VARIABLE_ENUMS[name] as readonly string[]).indexOf(value) + 1;
}

const NPC: Record<DojoVisualCase, { x: number; y: number; flag?: string }> = {
  forget: { x: 21, y: 3, flag: "xiangfirsttime" },
  learned: { x: 21, y: 3, flag: "xiangfirsttime" },
  devolve: { x: 4, y: 6 },
  taste: { x: 16, y: 3, flag: "zhufirsttime" },
};

function bootSnapshot(lang: DojoLang, visualCase: DojoVisualCase): string {
  const file = lang === "zh_CN" ? "dist/project.zh_CN.json" : "dist/project.json";
  const project = JSON.parse(readFileSync(join(ROOT, file), "utf8")) as Project;
  const npc = NPC[visualCase];
  project.start = { map: "spyder_dojo1", x: npc.x, y: npc.y, dir: "up" } as Project["start"];
  const options = mainlineSessionOptions(project, undefined, lang === "zh_CN" ? TUXEMON_SESSION_OPTIONS_ZH : {});
  const session = createSession(project, 60, options);
  const rules = battleDbToTuxemonBattleDb(TUXEMON_BATTLE_DB);
  const party = visualCase === "devolve"
    ? [spawnMonster(TUXEMON_BATTLE_DB, rules, { rng: 11, rngDraws: 0 }, "aardart", 20, { iid: "dojo-visual" })]
    : visualCase === "taste"
      ? [spawnMonster(TUXEMON_BATTLE_DB, rules, { rng: 5, rngDraws: 0 }, "aardart", 20, { iid: "dojo-visual" })]
      : [spawnMonster(TUXEMON_BATTLE_DB, rules, { rng: 11, rngDraws: 0 }, "rockitten", 20, { iid: "dojo-visual" })];
  const variables = npc.flag ? { [`v.${npc.flag}`]: code(npc.flag, "yes") } : {};
  const ext = packTuxemonExtensionState({ ...initialTuxemonExtensionState(), party });
  let state = startSession(project, session, createSwitchState({ variables }), ext);
  state.sw.gold = 1000;
  for (let frame = 0; frame < 60; frame++) state = stepSession(session, state, { buttons: 0 });
  const snapshot = createAutosaveSessionSnapshot(session, state, 0);
  if (!snapshot) throw new Error("dojo visual fixture: could not create the resumable Dojo snapshot");
  return JSON.stringify(snapshot);
}

function live(): SessionState {
  const state = globalThis.__rpgSessionState;
  if (!state) throw new Error("dojo visual fixture: production session probe is unavailable");
  return state;
}

function pump(world: SimWorld, frames: number): void {
  for (let frame = 0; frame < frames; frame++) {
    world.frame(0, 0x8080);
    world.tick();
  }
}

function press(world: SimWorld, mask: number): void {
  world.frame(mask, 0x8080);
  world.tick();
  world.frame(0, 0x8080);
  world.tick();
}

/** Confirm through boxes; at the n-th choice box press down `downs[n]` times
 *  and confirm. Stop when `until` holds. */
function drive(world: SimWorld, downs: number[], until: (state: SessionState) => boolean): void {
  let choice = 0;
  for (let frame = 0; frame < 2000; frame++) {
    const state = live();
    if (until(state)) {
      // Let the typewriter finish and the box settle.
      for (let wait = 0; wait < 600; wait++) {
        const modal = live().interp.modal;
        if (modal?.kind !== "text" || modal.complete) break;
        pump(world, 1);
      }
      pump(world, 10);
      return;
    }
    const modal = state.interp.modal;
    if (modal?.kind === "choices") {
      const wanted = downs[choice++] ?? 0;
      for (let step = 0; step < wanted; step++) press(world, BTN_DOWN);
      press(world, BTN_CONFIRM);
    } else if (modal?.kind === "text" && !modal.complete) {
      pump(world, 1);
    } else {
      press(world, BTN_CONFIRM);
    }
  }
  throw new Error("dojo visual fixture: the wanted screen never opened");
}

const isChoice = (prompt: (modal: ChoiceModal) => boolean) => (state: SessionState) =>
  state.interp.modal?.kind === "choices" && prompt(state.interp.modal);
const isText = (match: (text: string) => boolean) => (state: SessionState) =>
  state.interp.modal?.kind === "text" && match(state.interp.modal.lines.join(" "));

export interface DojoVisualCapture {
  width: number;
  height: number;
  rgba: Uint8Array;
  tree: unknown;
  modal: unknown;
}

export async function captureDojo(
  lang: DojoLang,
  visualCase: DojoVisualCase,
  viewport: { width: number; height: number },
): Promise<DojoVisualCapture> {
  if (!existsSync(BUNDLE + ".js") || !existsSync(BUNDLE + ".pak")) {
    throw new Error("dojo visual fixture: run `bun run import && bun run build` first");
  }
  const g = globalThis as Record<string, unknown>;
  const previousLang = g.__pocketTuxemonLang;
  try {
    const world = await bootWorld(BUNDLE, 60, {
      ...FIXED_TIME_HOST_GLOBALS,
      __pocketTuxemonLang: lang,
      __pocketTuxemonBootSnapshot: bootSnapshot(lang, visualCase),
    }, undefined, viewport);
    pump(world, 4);
    if (live().mapId !== "spyder_dojo1") throw new Error("dojo visual fixture: boot snapshot did not restore in the Dojo");
    const forgetPrompt = lang === "zh_CN" ? "要遗忘哪个招式？" : "Forget which technique?";
    const formPrompt = lang === "zh_CN" ? "要退回到哪种形态？" : "Return to which form?";
    switch (visualCase) {
      case "forget":
        drive(world, [0, 0], isChoice((modal) => modal.prompt === forgetPrompt));
        break;
      case "learned":
        // Yes, the monster, forget Thunderball (row 3), learn Ram (row 1).
        drive(world, [0, 0, 3, 1], isText((text) => text.includes(lang === "zh_CN" ? "学会了招式" : "learned technique")));
        break;
      case "devolve":
        drive(world, [0, 0], isChoice((modal) => modal.prompt === formPrompt));
        break;
      case "taste":
        drive(world, [0, 0, 0], isText((text) => text.includes(lang === "zh_CN" ? "冷味从" : "Cold Taste changed")));
        break;
    }
    return {
      ...viewport,
      rgba: world.render().slice(),
      tree: structuredClone(world.getTree()),
      modal: structuredClone(live().interp.modal),
    };
  } finally {
    if (previousLang === undefined) delete g.__pocketTuxemonLang;
    else g.__pocketTuxemonLang = previousLang;
  }
}
