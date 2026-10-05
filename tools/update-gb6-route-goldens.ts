// Capture four GB6 mainline route checkpoints at both supported logical
// resolutions. Checkpoint frames are derived from the current journey and
// captured by its pure reducer; the built game restores each validated state
// only to paint it.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { bootWorld, fnv1a } from "../vendor/pocket-rpgkit/vendor/pocketjs/hosts/sim/sim.ts";
import { FIXED_TIME_HOST_GLOBALS } from "../battle/time-weather.ts";
import { encodePNG } from "../vendor/pocket-rpgkit/vendor/pocketjs/tests/png.ts";
import type { CameraState } from "../vendor/pocket-rpgkit/src/engine/types.ts";
import type { PocketTuxemonWorldDiagnostics } from "../ui/world-diagnostics.ts";
import {
  captureGoldenCheckpoints,
  loadGoldenSyncPlan,
  restoreGoldenCheckpoint,
} from "./golden-sync.ts";

const ROOT = resolve(import.meta.dir, "..");
const BUNDLE = join(ROOT, "dist/main");
const OUT = join(ROOT, "tests/goldens");

if (!existsSync(BUNDLE + ".js") || !existsSync(BUNDLE + ".pak")) {
  throw new Error("GB6 route goldens: missing dist/main.{js,pak}; run `bun run build`");
}

const plan = loadGoldenSyncPlan(ROOT);
const checkpoints = plan.mainline.filter((checkpoint) => checkpoint.suite === "gb6-route");
const captures = captureGoldenCheckpoints(plan.mainlineMasks, checkpoints, plan.worldTraversal, ROOT);
const viewports = [
  { width: 480, height: 272 },
  { width: 960, height: 544 },
] as const;

mkdirSync(OUT, { recursive: true });
const frames: Record<string, unknown>[] = [];
for (const viewport of viewports) {
  const diagnostics: PocketTuxemonWorldDiagnostics = {};
  const world = await bootWorld(BUNDLE, 60, {
    ...FIXED_TIME_HOST_GLOBALS,
    __pocketTuxemonWorldDiagnostics: diagnostics,
  }, undefined, viewport);
  for (let index = 0; index < captures.length; index++) {
    const capture = captures[index]!;
    const checkpoint = capture.checkpoint;
    const state = await restoreGoldenCheckpoint(world, diagnostics, capture, index + 1);
    const camera = globalThis.__rpgGameCamera as CameraState | undefined;
    if (!camera) throw new Error(`GB6 route goldens: missing camera at f${checkpoint.maskFrame}`);

    const rgba = world.render().slice();
    const file = `gb6-mainline-${checkpoint.name}.${viewport.width}x${viewport.height}.png`;
    const png = encodePNG(rgba, viewport.width, viewport.height);
    writeFileSync(join(OUT, file), png);
    frames.push({
      name: checkpoint.name,
      frame: checkpoint.localFrame,
      timelineFrame: capture.timelineFrame,
      map: checkpoint.map,
      position: checkpoint.position,
      ...viewport,
      file,
      rgbaFnv1a: fnv1a(rgba),
      pngSha256: createHash("sha256").update(png).digest("hex"),
      camera: [camera.x, camera.y],
      player: {
        tile: [state.move.tx, state.move.ty],
        pixel: [state.move.px, state.move.py],
        facing: state.move.facing,
        phase: state.move.phase,
      },
    });
    console.log(
      `${checkpoint.name} ${viewport.width}x${viewport.height}: ` +
        `mask f${checkpoint.maskFrame} reducer f${capture.timelineFrame} ` +
        `${state.mapId}@${state.move.tx},${state.move.ty} ` +
        `rgba=${fnv1a(rgba)} -> ${file}`,
    );
  }
}

if (frames.length !== checkpoints.length * viewports.length) {
  throw new Error(`GB6 route goldens: captured ${frames.length}/${checkpoints.length * viewports.length}`);
}
writeFileSync(
  join(ROOT, "data/gb6-route-goldens.json"),
  JSON.stringify({
    format: "pocket-tuxemon/gb6-route-goldens/v1",
    worldTraversal: plan.worldTraversal,
    tapeSha256: plan.gb6TapeSha256,
    frames,
  }, null, 2) + "\n",
);
