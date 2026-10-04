// Production-bundle visual fixture for GI-1a importer effects.
//
// The frozen G6 tape reaches an idle Spyder bedroom. From that state this
// fixture:
//   1. applies and captures the exact lowered set_template result,
//   2. mounts the exact lowered grass map-animation result at the player,
//   3. walks to the real bedroom bed event and captures its imported fade.
//
// (1) and (2) inject reducer state. Importer tests prove command lowering;
// these injections deliberately isolate the production GameView + pak path
// without changing the maintained tape or replaying the 110k-frame route
// that naturally reaches the corresponding events. (3) executes normally.

import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { BTN } from "../vendor/pocket-rpgkit/vendor/pocketjs/contracts/spec/spec.ts";
import {
  bootWorld,
  type SimWorld,
} from "../vendor/pocket-rpgkit/vendor/pocketjs/hosts/sim/sim.ts";
import type { MapAnimInstance } from "../vendor/pocket-rpgkit/src/engine/interpreter.ts";
import type { SessionState } from "../vendor/pocket-rpgkit/src/engine/session.ts";
import type { CameraState } from "../vendor/pocket-rpgkit/src/engine/types.ts";
import { FIXED_TIME_HOST_GLOBALS } from "../battle/time-weather.ts";

export const GI1A_VISUAL_WIDTH = 480;
export const GI1A_VISUAL_HEIGHT = 272;
export const GI1A_VISUAL_FILES = {
  appearance: "gi1a-appearance.png",
  mapAnimation: "gi1a-map-animation.png",
  screenFade: "gi1a-screen-fade.png",
} as const;

const ROOT = resolve(import.meta.dir, "..");
const BUNDLE = join(ROOT, "dist/main");
const JOURNEY_PATH = join(ROOT, "data/g6-journey.json");
const PROJECT_PATH = join(ROOT, "dist/project.json");

interface Journey {
  masks: number[];
  checkpoints: { name: string; frame: number; map: string; position: [number, number] }[];
}

interface RawCommand {
  op: string;
  [key: string]: unknown;
}

interface RawPage {
  condition?: unknown;
  commands: RawCommand[];
}

interface RawEvent {
  id: string;
  pages: RawPage[];
}

interface RawMap {
  id: string;
  width: number;
  height: number;
  events?: RawEvent[];
}

interface RawProject {
  maps: RawMap[];
}

export interface Gi1aVisualCapture {
  appearance: Uint8Array;
  mapAnimation: Uint8Array;
  mapAnimationBase: Uint8Array;
  screenFade: Uint8Array;
  screenFadeBase: Uint8Array;
  appearanceState: {
    map: string;
    player: [number, number];
    pixel: [number, number];
    camera: [number, number];
    sprite: string | null | undefined;
  };
  mapAnimationState: MapAnimInstance;
  fadeState: {
    total: number;
    left: number;
    toAlpha: number;
    fiber: string | null;
  };
  sources: {
    appearance: RawCommand;
    mapAnimation: RawCommand;
    screenFade: RawCommand;
  };
}

function probes(): { state: SessionState; camera: CameraState } {
  const state = globalThis.__rpgSessionState;
  const camera = globalThis.__rpgGameCamera;
  if (!state || !camera) throw new Error("GI1a visuals: production GameView probes are unavailable");
  return { state, camera };
}

function pump(world: SimWorld, frames: number, buttons = 0): void {
  for (let frame = 0; frame < frames; frame++) {
    world.frame(buttons, 0x8080);
    world.tick();
  }
}

function mapOf(project: RawProject, id: string): RawMap {
  const map = project.maps.find((candidate) => candidate.id === id);
  if (!map) throw new Error(`GI1a visuals: missing imported map ${id}`);
  return map;
}

function eventOf(map: RawMap, id: string): RawEvent {
  const event = map.events?.find((candidate) => candidate.id === id);
  if (!event) throw new Error(`GI1a visuals: missing imported event ${map.id}/${id}`);
  return event;
}

function commandOf(event: RawEvent, op: string): RawCommand {
  for (const page of event.pages) {
    const command = page.commands.find((candidate) => candidate.op === op);
    if (command) return command;
  }
  throw new Error(`GI1a visuals: ${event.id} has no ${op} command`);
}

function appearanceCommand(project: RawProject): RawCommand {
  const event = eventOf(mapOf(project, "start_tuxemon"), "e008_white_male");
  const command = commandOf(event, "appearance");
  if (command.target !== "player" || command.sprite !== "adventurer" || command.saveDefault !== true) {
    throw new Error("GI1a visuals: selected appearance command changed");
  }
  return command;
}

function mapAnimationCommand(project: RawProject): RawCommand {
  const map = mapOf(project, "spyder_route1");
  const command = map.events?.flatMap((event) => event.pages)
    .flatMap((page) => page.commands)
    .find((candidate) => candidate.op === "mapAnim");
  if (!command) throw new Error(`GI1a visuals: ${map.id} has no mapAnim command`);
  if (
    command.anim !== "tux_grass_100000us" || command.target !== "player" ||
    command.follow !== false || command.layer !== "above" || command.loop !== false
  ) {
    throw new Error("GI1a visuals: selected map-animation command changed");
  }
  return command;
}

function screenFadeCommand(project: RawProject): RawCommand {
  const event = eventOf(mapOf(project, "spyder_bedroom"), "e005_resting_in_bed_r003");
  const command = commandOf(event, "screenFade");
  if (command.direction !== "out" || command.duration !== 1 || command.wait !== true) {
    throw new Error("GI1a visuals: selected screen-fade command changed");
  }
  return command;
}

function moveTo(
  world: SimWorld,
  button: number,
  target: [number, number],
  label: string,
): void {
  for (let frame = 0; frame < 80; frame++) {
    pump(world, 1, button);
    const move = probes().state.move;
    if (move.tx === target[0] && move.ty === target[1] && !move.moving) {
      pump(world, 1);
      return;
    }
  }
  const move = probes().state.move;
  throw new Error(
    `GI1a visuals: could not ${label}; stopped at ${move.tx},${move.ty} phase=${move.phase}`,
  );
}

/** Capture all three effects through the built production app and pak. */
export async function captureGi1aVisuals(): Promise<Gi1aVisualCapture> {
  const journey = JSON.parse(readFileSync(JOURNEY_PATH, "utf8")) as Journey;
  const project = JSON.parse(readFileSync(PROJECT_PATH, "utf8")) as RawProject;
  const appearance = appearanceCommand(project);
  const mapAnimation = mapAnimationCommand(project);
  const screenFade = screenFadeCommand(project);
  const bedroom = journey.checkpoints.find((checkpoint) => checkpoint.name === "bedroom");
  if (!bedroom) throw new Error("GI1a visuals: G6 tape has no bedroom checkpoint");

  const world = await bootWorld(BUNDLE, 60, FIXED_TIME_HOST_GLOBALS, undefined, {
    width: GI1A_VISUAL_WIDTH,
    height: GI1A_VISUAL_HEIGHT,
  });
  for (let frame = 0; frame <= bedroom.frame; frame++) pump(world, 1, journey.masks[frame]!);

  let live = probes();
  if (
    live.state.mapId !== bedroom.map || live.state.move.tx !== bedroom.position[0] ||
    live.state.move.ty !== bedroom.position[1]
  ) {
    throw new Error(
      `GI1a visuals: bedroom checkpoint diverged: ` +
        `${live.state.mapId}@${live.state.move.tx},${live.state.move.ty}`,
    );
  }
  // set_template(..., permanent=true) lowers to saveDefault, whose reducer
  // result stores the new reset baseline and clears a temporary override.
  live.state.sw.playerAppearance = {
    ...(live.state.sw.playerAppearance ?? {}),
    defaultSprite: String(appearance.sprite),
  };
  pump(world, 1);
  live = probes();
  const sprite = live.state.sw.playerAppearance?.sprite ??
    live.state.sw.playerAppearance?.defaultSprite;
  if (sprite !== "adventurer") {
    throw new Error(`GI1a visuals: imported appearance is ${String(sprite)}, expected adventurer`);
  }
  const appearanceFrame = world.render().slice();
  const appearanceState = {
    map: live.state.mapId,
    player: [live.state.move.tx, live.state.move.ty] as [number, number],
    pixel: [live.state.move.px, live.state.move.py] as [number, number],
    camera: [live.camera.x, live.camera.y] as [number, number],
    sprite,
  };

  // Inject the exact reducer result of the selected follow:false mapAnim.
  // The global is a read-only probe in normal gameplay; this one capture
  // harness mutates it before the next pure fold so GameView sees the same
  // serialisable state that executing the imported command would create.
  const instance: MapAnimInstance = {
    id: String(mapAnimation.id),
    anim: String(mapAnimation.anim),
    start: live.state.interp.frame,
    x: live.state.move.tx,
    y: live.state.move.ty,
    target: null,
    layer: "above",
    loop: false,
  };
  live.state.interp.anims = [instance];
  pump(world, 1);
  live = probes();
  const mounted = live.state.interp.anims?.find((candidate) => candidate.id === instance.id);
  if (!mounted) throw new Error("GI1a visuals: map animation was not mounted by production GameView");
  const mapAnimationFrame = world.render().slice();
  delete live.state.interp.anims;
  pump(world, 1);

  // Walk from the maintained bedroom checkpoint to the left side of the
  // two-cell bed. The blocked LEFT press sets facing without entering it;
  // CIRCLE then starts the real imported action page.
  moveTo(world, BTN.LEFT, [1, 4], "walk left toward the bed");
  moveTo(world, BTN.UP, [1, 3], "walk up beside the bed");
  pump(world, 1, BTN.LEFT);
  pump(world, 1);
  live = probes();
  if (live.state.move.tx !== 1 || live.state.move.ty !== 3 || live.state.move.facing !== 1) {
    throw new Error("GI1a visuals: player did not face the bedroom bed");
  }
  const screenFadeBase = world.render().slice();
  pump(world, 1, BTN.CIRCLE);
  pump(world, 1);

  for (let frame = 0; frame < 90; frame++) {
    const fade = probes().state.interp.screen?.fade;
    if (fade && fade.left <= Math.ceil(fade.total / 2)) break;
    pump(world, 1);
  }
  live = probes();
  const fade = live.state.interp.screen?.fade;
  if (!fade || fade.to.a !== 255 || fade.left > Math.ceil(fade.total / 2)) {
    throw new Error("GI1a visuals: imported bed fade did not reach its midpoint");
  }
  const fiber = live.state.interp.main?.key ?? null;
  if (!fiber?.endsWith("/e005_resting_in_bed_r003")) {
    throw new Error(`GI1a visuals: fade belongs to unexpected fiber ${String(fiber)}`);
  }

  return {
    appearance: appearanceFrame,
    mapAnimation: mapAnimationFrame,
    mapAnimationBase: appearanceFrame,
    screenFade: world.render().slice(),
    screenFadeBase,
    appearanceState,
    mapAnimationState: { ...mounted },
    fadeState: { total: fade.total, left: fade.left, toAlpha: fade.to.a, fiber },
    sources: { appearance, mapAnimation, screenFade },
  };
}
