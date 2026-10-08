// Capture the real Taba Town locked-facing route at both supported logical
// resolutions. The production bundle runs the imported e033_listentime3
// cutscene; this tool only selects its deterministic mid-step frame.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { FIXED_TIME_HOST_GLOBALS } from "../battle/time-weather.ts";
import { bootWorld, fnv1a } from "../vendor/pocket-rpgkit/vendor/pocketjs/hosts/sim/sim.ts";
import { encodePNG } from "../vendor/pocket-rpgkit/vendor/pocketjs/tests/png.ts";
import { walkPose } from "../vendor/pocket-rpgkit/src/engine/movement.ts";
import type { SessionState } from "../vendor/pocket-rpgkit/src/engine/session.ts";
import type { CameraState, Project } from "../vendor/pocket-rpgkit/src/engine/types.ts";
import { NPC_SRC_INDEX, PLAYER } from "../ui/game-assets.ts";
import { createNpcSrcProvider } from "../ui/npc-src-repository.ts";

const ROOT = resolve(import.meta.dir, "..");
const BUNDLE = join(ROOT, "dist/main");
const OUT = join(ROOT, "tests/goldens");
const BTN_CONFIRM = 0x2000;
const ACTOR_ID = "npc_callie_wren";
const VIEWPORTS = [{ width: 480, height: 272 }, { width: 960, height: 544 }] as const;

if (!existsSync(BUNDLE + ".js") || !existsSync(BUNDLE + ".pak")) {
  throw new Error("NPC movement goldens: missing dist/main.{js,pak}; run `bun run build`");
}

const project = JSON.parse(readFileSync(join(ROOT, "dist/project.json"), "utf8")) as Project;
const npcSrc = createNpcSrcProvider(NPC_SRC_INDEX, {
  read: (entry) => readFileSync(join(ROOT, "dist", entry)),
});
const imageKey = (phase: number, facing: number, frames: typeof PLAYER): string => {
  const pose = walkPose(phase);
  return pose === 1 ? frames.walkL[facing]!
    : pose === 2 ? frames.walkR[facing]!
      : frames.idle[facing]!;
};

type World = Awaited<ReturnType<typeof bootWorld>>;

function live(): SessionState {
  const state = globalThis.__rpgSessionState as SessionState | undefined;
  if (!state) throw new Error("NPC movement goldens: GameView did not publish SessionState");
  return state;
}

function pump(world: World, frames: number, buttons = 0): void {
  for (let frame = 0; frame < frames; frame++) {
    world.frame(buttons, 0x8080);
    world.tick();
  }
}

function waitFor(world: World, label: string, done: () => boolean, limit = 3_000): void {
  for (let frame = 0; frame < limit; frame++) {
    if (done()) return;
    pump(world, 1);
  }
  throw new Error(`NPC movement goldens: timed out waiting for ${label}`);
}

mkdirSync(OUT, { recursive: true });
const frames: Record<string, unknown>[] = [];
let expectedMotion = "";

for (const viewport of VIEWPORTS) {
  const world = await bootWorld(BUNDLE, 60, FIXED_TIME_HOST_GLOBALS, undefined, viewport);
  waitFor(world, "boot", () => !!globalThis.__rpgkitDemo && !!globalThis.__rpgSessionState);
  pump(world, 30);

  globalThis.__rpgkitDemo!.warp("taba_town", 36, 47);
  waitFor(world, "Taba Town warp", () => live().mapId === "taba_town");
  const origin = live();
  origin.interp.sw = {
    ...origin.interp.sw,
    variables: {
      ...origin.interp.sw.variables,
      "local.npc.allie": 1,
      "local.npc.callie_wren": 1,
      "v.goodbyeoldknight": 8,
    },
  };
  origin.sw = origin.interp.sw;

  let previousButtons = 0;
  let captured: SessionState | undefined;
  for (let guard = 0; guard < 3_000; guard++) {
    const before = live();
    const modal = before.interp.modal;
    const buttons = modal?.kind === "text" && modal.complete && previousButtons === 0
      ? BTN_CONFIRM
      : 0;
    pump(world, 1, buttons);
    previousButtons = buttons;
    const state = live();
    const actor = state.chars.chars[ACTOR_ID];
    const control = state.interp.moveControls?.events[ACTOR_ID];
    if (
      !state.interp.modal && actor?.moving && actor.stepDir === 0 && actor.facing === 1 &&
      actor.phase === 3 && control?.facingMode === "locked"
    ) {
      captured = state;
      break;
    }
  }
  if (!captured) throw new Error("NPC movement goldens: locked-facing down-step was not reached");

  const actor = captured.chars.chars[ACTOR_ID]!;
  const control = captured.interp.moveControls!.events[ACTOR_ID]!;
  const event = project.maps.find((map) => map.id === captured!.mapId)?.events
    ?.find((candidate) => candidate.id === ACTOR_ID);
  const sprite = event?.pages[actor.pageIndex]?.sprite;
  const art = sprite ? npcSrc[sprite] : undefined;
  if (!event || !sprite || !art || typeof art === "string") {
    throw new Error(`NPC movement goldens: ${ACTOR_ID} has no directional sprite art`);
  }
  const camera = globalThis.__rpgGameCamera as CameraState | undefined;
  if (!camera) throw new Error("NPC movement goldens: missing camera");

  const motion = {
    tile: [actor.tx, actor.ty],
    pixel: [actor.px, actor.py],
    facing: actor.facing,
    phase: actor.phase,
    moving: actor.moving,
    stepDir: actor.stepDir,
  };
  const motionKey = JSON.stringify(motion);
  if (expectedMotion && motionKey !== expectedMotion) {
    throw new Error(`NPC movement goldens: viewport changed reducer state: ${motionKey} != ${expectedMotion}`);
  }
  expectedMotion = motionKey;

  const rgba = world.render().slice();
  const file = `npc-movement-facing-lock.${viewport.width}x${viewport.height}.png`;
  const png = encodePNG(rgba, viewport.width, viewport.height);
  writeFileSync(join(OUT, file), png);
  frames.push({
    name: "taba-facing-lock",
    map: captured.mapId,
    ...viewport,
    file,
    rgbaFnv1a: fnv1a(rgba),
    pngSha256: createHash("sha256").update(png).digest("hex"),
    camera: [camera.x, camera.y],
    actor: {
      id: ACTOR_ID,
      ...motion,
      sprite,
      image: imageKey(actor.phase, actor.facing, art),
      height: art.h,
    },
    control: {
      facingMode: control.facingMode,
      routeStopped: control.routeStopped,
    },
  });
  console.log(`${viewport.width}x${viewport.height}: ${captured.mapId} ${ACTOR_ID} ` +
    `tile=${actor.tx},${actor.ty} pixel=${actor.px},${actor.py} face=${actor.facing} ` +
    `step=${actor.stepDir} rgba=${fnv1a(rgba)} -> ${file}`);
}

writeFileSync(join(ROOT, "data/npc-movement-goldens.json"), JSON.stringify({
  format: "pocket-tuxemon/npc-movement-goldens/v1",
  frames,
}, null, 2) + "\n");
