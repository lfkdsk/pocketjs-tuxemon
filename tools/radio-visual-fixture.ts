// Production-bundle fixture for the imported Radio event. A real snapshot is
// created beside the Leather House radio, restored through the shipped boot
// overlay, and the actual action page opens the scene before touch probes run.

import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

import { TUXEMON_RADIO_SCENE_ID, type RadioSceneState } from "../battle/radio-scenes.ts";
import { FIXED_TIME_HOST_GLOBALS } from "../battle/time-weather.ts";
import { createAutosaveSessionSnapshot } from "../vendor/pocket-rpgkit/src/engine/save.ts";
import {
  createSession,
  startSession,
  stepSession,
  type SessionInput,
  type SessionState,
} from "../vendor/pocket-rpgkit/src/engine/session.ts";
import {
  __packTouch,
  __packTouchWide,
} from "../vendor/pocket-rpgkit/vendor/pocketjs/framework/src/touch.ts";
import { bootWorld, type SimWorld } from "../vendor/pocket-rpgkit/vendor/pocketjs/hosts/sim/sim.ts";
import { readInlineProject } from "./generated-project.ts";
import { mainlineSessionOptions } from "./mainline-session.ts";

const ROOT = resolve(import.meta.dir, "..");
const BUNDLE = join(ROOT, "dist/main");
const BTN_CONFIRM = 0x2000;

export const RADIO_VISUAL_VIEWPORTS = [
  { width: 480, height: 272 },
  { width: 960, height: 544 },
] as const;
export const RADIO_VISUAL_CASES = ["tuner", "broadcast"] as const;
export type RadioVisualCase = typeof RADIO_VISUAL_CASES[number];

export function radioGoldenFile(
  visualCase: RadioVisualCase,
  viewport: { width: number; height: number },
): string {
  return `radio-${visualCase}.${viewport.width}x${viewport.height}.png`;
}

function headlessInput(mask: number, previous: number): SessionInput {
  return {
    buttons: mask,
    confirmEdge: Boolean((mask & BTN_CONFIRM) && !(previous & BTN_CONFIRM)),
  };
}

function radioBootSnapshot(): string {
  const source = readInlineProject(ROOT);
  const project = {
    ...source,
    start: { map: "spyder_leather_house1", x: 7, y: 7, dir: "up" as const },
  };
  const session = createSession(project, 60, mainlineSessionOptions(project));
  let state = startSession(project, session);
  let previous = 0;
  for (let frame = 0; frame < 60; frame++) {
    state = stepSession(session, state, headlessInput(0, previous));
    previous = 0;
  }
  if (state.sw.variables["v.stage_of_day"] !== "morning") {
    throw new Error("radio visual fixture: map entry did not publish the saved morning clock");
  }
  const snapshot = createAutosaveSessionSnapshot(session, state, 0);
  if (!snapshot) throw new Error("radio visual fixture: could not create the resumable radio snapshot");
  return JSON.stringify(snapshot);
}

function live(): SessionState {
  const state = globalThis.__rpgSessionState;
  if (!state) throw new Error("radio visual fixture: production session probe is unavailable");
  return state;
}

function radio(): RadioSceneState {
  const scene = live().scene;
  if (scene?.kind !== "scene" || scene.id !== TUXEMON_RADIO_SCENE_ID) {
    throw new Error("radio visual fixture: tuner is not active");
  }
  return scene.state as unknown as RadioSceneState;
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

function tap(
  world: SimWorld,
  viewport: { width: number; height: number },
  baseX: number,
  baseY: number,
): void {
  const point = drawnPoint(viewport, baseX, baseY);
  const contact = viewport.width > 512 || viewport.height > 512
    ? __packTouchWide(1, point.x, point.y)
    : __packTouch(1, point.x, point.y);
  world.frame(0, 0x8080, [contact]);
  world.tick();
  world.frame(0, 0x8080, []);
  world.tick();
  pump(world, 2);
}

export interface RadioVisualCapture {
  width: number;
  height: number;
  cases: Record<RadioVisualCase, {
    rgba: Uint8Array;
    tree: unknown;
    state: RadioSceneState;
  }>;
  touch: {
    playWorked: boolean;
    nextWorked: boolean;
    returnWorked: boolean;
  };
}

export async function captureRadio(
  viewport: { width: number; height: number },
): Promise<RadioVisualCapture> {
  if (!existsSync(BUNDLE + ".js") || !existsSync(BUNDLE + ".pak")) {
    throw new Error("radio visual fixture: run `bun run import && bun run build` first");
  }
  const globals = {
    ...FIXED_TIME_HOST_GLOBALS,
    __pocketTuxemonBootSnapshot: radioBootSnapshot(),
  };
  const world = await bootWorld(BUNDLE, 60, globals, undefined, viewport);
  pump(world, 4);
  if (live().mapId !== "spyder_leather_house1" || live().move.tx !== 7 || live().move.ty !== 7) {
    throw new Error("radio visual fixture: boot snapshot did not restore beside the radio");
  }

  for (let attempt = 0; attempt < 10 && live().scene === null; attempt++) press(world, BTN_CONFIRM);
  const initial = radio();
  if (initial.phase !== "tune" || initial.frequency !== 94.7 || initial.signalStrength !== 100) {
    throw new Error("radio visual fixture: imported tuner opened with the wrong dial state");
  }
  pump(world, 2);
  const tuner = {
    rgba: world.render().slice(),
    tree: structuredClone(world.getTree()),
    state: structuredClone(radio()),
  };

  // Tap the actual scaled Play Radio hit region. The scene changes only via
  // GameView's selectIndex bridge, so this detects a painted-but-dead button.
  tap(world, viewport, 282, 226);
  const playWorked = radio().phase === "broadcast" &&
    radio().broadcastDialogue[0]?.includes("Possessuns, Part I") === true;
  const broadcast = {
    rgba: world.render().slice(),
    tree: structuredClone(world.getTree()),
    state: structuredClone(radio()),
  };

  tap(world, viewport, 240, 246);
  const nextWorked = radio().phase === "tune";
  tap(world, viewport, 415, 226);
  const returnWorked = live().scene === null && live().mapId === "spyder_leather_house1" &&
    live().move.tx === 7 && live().move.ty === 7;

  return {
    ...viewport,
    cases: { tuner, broadcast },
    touch: { playWorked, nextWorked, returnWorked },
  };
}
