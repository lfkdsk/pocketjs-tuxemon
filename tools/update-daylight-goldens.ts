// Capture the same clear Paper Town frame with fixed day and night starts.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { FIXED_INITIAL_CIVIL_TIME, type CivilDateTime } from "../battle/time-weather.ts";
import { encodePNG } from "../vendor/pocket-rpgkit/vendor/pocketjs/tests/png.ts";
import { bootWorld, fnv1a } from "../vendor/pocket-rpgkit/vendor/pocketjs/hosts/sim/sim.ts";
import { isSessionWorldIdle, type SessionState } from "../vendor/pocket-rpgkit/src/engine/session.ts";
import type { CameraState } from "../vendor/pocket-rpgkit/src/engine/types.ts";
import { loadGoldenSyncPlan } from "./golden-sync.ts";

const ROOT = resolve(import.meta.dir, "..");
const BUNDLE = join(ROOT, "dist/main");
const OUT = join(ROOT, "tests/goldens");
const MANIFEST = join(ROOT, "data/daylight-goldens.json");
const WIDTH = 480;
const HEIGHT = 272;

if (!existsSync(BUNDLE + ".js") || !existsSync(BUNDLE + ".pak")) {
  throw new Error("daylight goldens: missing dist/main.{js,pak}; run `bun run build`");
}

const plan = loadGoldenSyncPlan(ROOT);
const checkpoint = plan.daylight[0]!;

async function capture(civil: CivilDateTime): Promise<{
  rgba: Uint8Array;
  camera: readonly [number, number];
  player: { tile: readonly [number, number]; pixel: readonly [number, number]; facing: number; phase: number };
}> {
  const world = await bootWorld(
    BUNDLE,
    60,
    { __pocketTuxemonInitialCivilTime: civil },
    undefined,
    { width: WIDTH, height: HEIGHT },
  );
  for (let frame = 0; frame <= checkpoint.maskFrame; frame++) {
    world.frame(plan.daylightMasks[frame]!);
    world.tick();
  }
  const state = globalThis.__rpgSessionState as SessionState | undefined;
  if (!state || state.mapId !== checkpoint.map || state.move.tx !== checkpoint.position[0]
    || state.move.ty !== checkpoint.position[1]) {
    throw new Error(
      `daylight goldens: diverged at f${checkpoint.maskFrame}: `
      + `${state?.mapId}@${state?.move.tx},${state?.move.ty}`,
    );
  }
  if (state.frame !== checkpoint.maskFrame + 1) {
    throw new Error(`daylight goldens: reducer frame ${state.frame} != ${checkpoint.maskFrame + 1}`);
  }
  if (!isSessionWorldIdle(state)) {
    throw new Error(`daylight goldens: ${checkpoint.name} is not a world-idle frame`);
  }
  const camera = globalThis.__rpgGameCamera as CameraState | undefined;
  if (!camera) throw new Error(`daylight goldens: missing camera at ${checkpoint.name}`);
  return {
    rgba: world.render().slice(),
    camera: [camera.x, camera.y],
    player: {
      tile: [state.move.tx, state.move.ty],
      pixel: [state.move.px, state.move.py],
      facing: state.move.facing,
      phase: state.move.phase,
    },
  };
}

function channelMeans(rgba: Uint8Array): { luminance: number; blueBias: number } {
  let luminance = 0;
  let blueBias = 0;
  const pixels = rgba.length / 4;
  for (let index = 0; index < rgba.length; index += 4) {
    const r = rgba[index]!;
    const g = rgba[index + 1]!;
    const b = rgba[index + 2]!;
    luminance += 0.2126 * r + 0.7152 * g + 0.0722 * b;
    blueBias += b - (r + g) / 2;
  }
  return {
    luminance: Math.round(luminance / pixels * 1_000) / 1_000,
    blueBias: Math.round(blueBias / pixels * 1_000) / 1_000,
  };
}

const nightCivil: CivilDateTime = { ...FIXED_INITIAL_CIVIL_TIME, hour: 21 };
const dayCapture = await capture({ ...FIXED_INITIAL_CIVIL_TIME });
const nightCapture = await capture(nightCivil);
const day = dayCapture.rgba;
const night = nightCapture.rgba;
if (JSON.stringify(dayCapture.camera) !== JSON.stringify(nightCapture.camera)
  || JSON.stringify(dayCapture.player) !== JSON.stringify(nightCapture.player)) {
  throw new Error("daylight goldens: day/night captures did not preserve the same viewpoint");
}
mkdirSync(OUT, { recursive: true });

const frames = [
  { name: "day", civil: FIXED_INITIAL_CIVIL_TIME, rgba: day },
  { name: "night", civil: nightCivil, rgba: night },
] as const;
const images = frames.map(({ name, civil, rgba }) => {
  const file = `daylight-${name}.png`;
  const png = encodePNG(rgba, WIDTH, HEIGHT);
  writeFileSync(join(OUT, file), png);
  return {
    name,
    civil,
    file,
    rgbaFnv1a: fnv1a(rgba),
    pngSha256: createHash("sha256").update(png).digest("hex"),
    ...channelMeans(rgba),
  };
});

let darkerPixels = 0;
let bluerPixels = 0;
for (let index = 0; index < day.length; index += 4) {
  const dayLuma = 0.2126 * day[index]! + 0.7152 * day[index + 1]! + 0.0722 * day[index + 2]!;
  const nightLuma = 0.2126 * night[index]! + 0.7152 * night[index + 1]! + 0.0722 * night[index + 2]!;
  if (nightLuma < dayLuma) darkerPixels++;
  const dayBias = day[index + 2]! - (day[index]! + day[index + 1]!) / 2;
  const nightBias = night[index + 2]! - (night[index]! + night[index + 1]!) / 2;
  if (nightBias > dayBias) bluerPixels++;
}

const manifest = {
  format: "pocket-tuxemon/daylight-goldens/v1",
  worldTraversal: plan.worldTraversal,
  journeySha256: plan.daylightJourneySha256,
  width: WIDTH,
  height: HEIGHT,
  checkpoint: {
    name: checkpoint.name,
    frame: checkpoint.localFrame,
    timelineFrame: checkpoint.maskFrame + 1,
    map: checkpoint.map,
    position: checkpoint.position,
  },
  camera: dayCapture.camera,
  player: dayCapture.player,
  images,
  comparison: { darkerPixels, bluerPixels, pixels: WIDTH * HEIGHT },
};
writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2) + "\n");
console.log(JSON.stringify(manifest, null, 2));
