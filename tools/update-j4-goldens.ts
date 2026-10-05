// Capture three clear-map J4 checkpoints at both supported logical
// resolutions. The pure mainline reducer selects and serializes each exact
// tape state; the production bundle restores it only to paint the image.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { bootWorld, fnv1a } from "../vendor/pocket-rpgkit/vendor/pocketjs/hosts/sim/sim.ts";
import { encodePNG } from "../vendor/pocket-rpgkit/vendor/pocketjs/tests/png.ts";
import { walkPose } from "../vendor/pocket-rpgkit/src/engine/movement.ts";
import type { SessionState } from "../vendor/pocket-rpgkit/src/engine/session.ts";
import type { CameraState } from "../vendor/pocket-rpgkit/src/engine/types.ts";
import { FIXED_TIME_HOST_GLOBALS } from "../battle/time-weather.ts";
import { PLAYER } from "../ui/game-assets.ts";
import type { PocketTuxemonWorldDiagnostics } from "../ui/world-diagnostics.ts";
import type { Gb6JourneyResult } from "./gb6-journey.ts";
import {
  captureGoldenCheckpoints,
  loadGoldenSyncPlan,
  restoreGoldenCheckpoint,
} from "./golden-sync.ts";
import type { J1JourneyResult } from "./j1-journey.ts";
import type { J2JourneyResult } from "./j2-journey.ts";
import type { J3JourneyResult } from "./j3-journey.ts";
import type { J4JourneyResult, J4StoryState } from "./j4-journey.ts";

const ROOT = resolve(import.meta.dir, "..");
const BUNDLE = join(ROOT, "dist/main");
const OUT = join(ROOT, "tests/goldens");
const MANIFEST = join(ROOT, "data/j4-goldens.json");
const VIEWPORTS = [{ width: 480, height: 272 }, { width: 960, height: 544 }] as const;
const VIEWPORT_FILTER = process.env.J4_GOLDEN_VIEWPORT;
const selectedViewports = VIEWPORT_FILTER
  ? VIEWPORTS.filter(({ width, height }) => String(width) + "x" + String(height) === VIEWPORT_FILTER)
  : VIEWPORTS;
const NAMES = ["surfboard-collected", "datacenter-upper-screens", "kernel-defeated"] as const;

if (!existsSync(BUNDLE + ".js") || !existsSync(BUNDLE + ".pak")) {
  throw new Error("J4 goldens: missing dist/main.{js,pak}; run bun run build");
}
if (selectedViewports.length === 0) {
  throw new Error("J4 goldens: unsupported J4_GOLDEN_VIEWPORT=" + VIEWPORT_FILTER);
}

const gb6 = JSON.parse(readFileSync(join(ROOT, "data/gb6-mainline-journey.json"), "utf8")) as Gb6JourneyResult;
const j1 = JSON.parse(readFileSync(join(ROOT, "data/j1-captainreturns-journey.json"), "utf8")) as J1JourneyResult;
const j2 = JSON.parse(readFileSync(join(ROOT, "data/j2-hospitalcure-journey.json"), "utf8")) as J2JourneyResult;
const j3 = JSON.parse(
  readFileSync(join(ROOT, "data/j3-omnichannelradioannounce-journey.json"), "utf8"),
) as J3JourneyResult;
const journey = JSON.parse(
  readFileSync(join(ROOT, "data/j4-kernelquestdone-journey.json"), "utf8"),
) as J4JourneyResult;
const baseFrames = gb6.frames + j1.frames + j2.frames + j3.frames;
const plan = loadGoldenSyncPlan(ROOT);
const checkpoints = plan.mainline.filter((checkpoint) => checkpoint.suite === "j4");
const captures = captureGoldenCheckpoints(plan.mainlineMasks, checkpoints, plan.worldTraversal, ROOT);
if (captures.length !== NAMES.length || captures.some((capture, index) => capture.checkpoint.name !== NAMES[index])) {
  throw new Error("J4 goldens: shared checkpoint plan changed");
}
const imageKey = (phase: number, facing: number, frames: typeof PLAYER): string => {
  const pose = walkPose(phase);
  return pose === 1 ? frames.walkL[facing]!
    : pose === 2 ? frames.walkR[facing]!
      : frames.idle[facing]!;
};
const numeric = (state: SessionState, id: string): number => {
  const value = state.sw.variables[id];
  if (value === undefined) return 0;
  if (typeof value !== "number") throw new Error("J4 goldens: " + id + " is not numeric");
  return value;
};
const storyState = (state: SessionState): J4StoryState => ({
  kernelQuest: numeric(state, "v.kernelquest"),
  omnichannelRadioAnnounce: numeric(state, "v.omnichannelradioannounce"),
  bumpIntoMom: numeric(state, "v.bumpintomom"),
  kernelQuestBegin: numeric(state, "v.kernelquestbegin"),
  timberMom: numeric(state, "v.timbermom"),
  routeBBillie: numeric(state, "v.routebbillie"),
  dataScreen1: numeric(state, "v.datascreen1"),
  dataScreen2: numeric(state, "v.datascreen2"),
  dataScreen3: numeric(state, "v.datascreen3"),
  dataScreen4: numeric(state, "v.datascreen4"),
  dataScreen5: numeric(state, "v.datascreen5"),
  dataScreen6: numeric(state, "v.datascreen6"),
  dataScreen7: numeric(state, "v.datascreen7"),
  dataCenterBillie: numeric(state, "v.datacenterbillie"),
  spyderPass: state.sw.items.spyder_pass ?? 0,
  surfboard: state.sw.items.surfboard ?? 0,
  swimming: numeric(state, "v.swimming"),
  goldPass: state.sw.items.gold_pass ?? 0,
});

mkdirSync(OUT, { recursive: true });
const frames: Record<string, unknown>[] = [];
for (const viewport of selectedViewports) {
  const diagnostics: PocketTuxemonWorldDiagnostics = {};
  const world = await bootWorld(BUNDLE, 60, {
    ...FIXED_TIME_HOST_GLOBALS,
    __pocketTuxemonWorldDiagnostics: diagnostics,
  }, undefined, viewport);
  for (let index = 0; index < captures.length; index++) {
    const capture = captures[index]!;
    const checkpoint = capture.checkpoint;
    const state = await restoreGoldenCheckpoint(world, diagnostics, capture, index + 1);

    const rgba = world.render().slice();
    const camera = globalThis.__rpgGameCamera as CameraState | undefined;
    if (!camera) throw new Error("J4 goldens: missing camera at " + checkpoint.name);
    const file = "j4-" + checkpoint.name + "." + viewport.width + "x" + viewport.height + ".png";
    const png = encodePNG(rgba, viewport.width, viewport.height);
    writeFileSync(join(OUT, file), png);
    frames.push({
      name: checkpoint.name,
      frame: checkpoint.localFrame,
      mergedFrame: checkpoint.maskFrame,
      timelineFrame: capture.timelineFrame,
      map: checkpoint.map,
      position: checkpoint.position,
      ...viewport,
      file,
      rgbaFnv1a: fnv1a(rgba),
      pngSha256: createHash("sha256").update(png).digest("hex"),
      camera: [camera.x, camera.y],
      story: storyState(state),
      player: {
        tile: [state.move.tx, state.move.ty],
        pixel: [state.move.px, state.move.py],
        facing: state.move.facing,
        phase: state.move.phase,
        image: imageKey(state.move.phase, state.move.facing, PLAYER),
        height: 32,
      },
    });
    console.log(checkpoint.name + " " + viewport.width + "x" + viewport.height +
      ": mask frame " + checkpoint.maskFrame + " reducer frame " + capture.timelineFrame +
      " rgba=" + fnv1a(rgba) + " -> " + file);
  }
}

if (frames.length !== checkpoints.length * selectedViewports.length) {
  throw new Error("J4 goldens: captured " + frames.length + "/" +
    checkpoints.length * selectedViewports.length);
}
let preserved: Record<string, unknown>[] = [];
if (VIEWPORT_FILTER && existsSync(MANIFEST)) {
  const previous = JSON.parse(readFileSync(MANIFEST, "utf8")) as {
    format?: string;
    baseFrames?: number;
    segmentTapeSha256?: string;
    combinedTapeSha256?: string;
    frames?: Record<string, unknown>[];
  };
  if (previous.format !== "pocket-tuxemon/j4-goldens/v1" ||
    previous.baseFrames !== baseFrames ||
    previous.segmentTapeSha256 !== journey.tapeSha256 ||
    previous.combinedTapeSha256 !== journey.combinedTapeSha256 ||
    !Array.isArray(previous.frames)) {
    throw new Error("J4 goldens: existing partial manifest belongs to a different tape");
  }
  preserved = previous.frames.filter((frame) =>
    String(frame.width) + "x" + String(frame.height) !== VIEWPORT_FILTER);
}
const viewportOrder = new Map(VIEWPORTS.map(({ width, height }, index) =>
  [String(width) + "x" + String(height), index]));
const nameOrder = new Map(NAMES.map((name, index) => [name, index]));
const mergedFrames = [...preserved, ...frames].sort((a, b) =>
  (viewportOrder.get(String(a.width) + "x" + String(a.height)) ?? 99) -
    (viewportOrder.get(String(b.width) + "x" + String(b.height)) ?? 99) ||
  (nameOrder.get(String(a.name) as typeof NAMES[number]) ?? 99) -
    (nameOrder.get(String(b.name) as typeof NAMES[number]) ?? 99));
writeFileSync(MANIFEST, JSON.stringify({
  format: "pocket-tuxemon/j4-goldens/v1",
  baseFrames,
  segmentTapeSha256: journey.tapeSha256,
  combinedTapeSha256: journey.combinedTapeSha256,
  frames: mergedFrames,
}, null, 2) + "\n");
