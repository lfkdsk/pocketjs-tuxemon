// Capture the same real-game state through the legacy and connected-world
// renderers. The caller chooses an output directory so this diagnostic tool
// never reads or writes the repository's review artifacts on its own.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { FIXED_TIME_HOST_GLOBALS } from "../battle/time-weather.ts";
import type { PocketTuxemonWorldDiagnostics } from "../ui/world-diagnostics.ts";
import { bootWorld, fnv1a, type SimWorld } from "../vendor/pocket-rpgkit/vendor/pocketjs/hosts/sim/sim.ts";
import { encodePNG } from "../vendor/pocket-rpgkit/vendor/pocketjs/tests/png.ts";
import type { SessionState } from "../vendor/pocket-rpgkit/src/engine/session.ts";
import type { CameraState, WorldComponent, WorldPlacement } from "../vendor/pocket-rpgkit/src/engine/types.ts";
import {
  captureGoldenCheckpoints,
  loadGoldenSyncPlan,
  restoreGoldenCheckpoint,
  type CapturedGoldenCheckpoint,
} from "./golden-sync.ts";

const ROOT = resolve(import.meta.dir, "..");
const BUNDLE = join(ROOT, "dist/main");
const outArg = process.argv.find((arg) => arg.startsWith("--out="))?.slice("--out=".length);
if (!outArg) throw new Error("capture canopy parity: pass --out=<directory>");
const OUT = resolve(outArg);
const caseArg = process.argv.find((arg) => arg.startsWith("--case="))?.slice("--case=".length);
const TILE = 16;
const PLAYER_HEIGHT = 32;
const SETTLE_FRAMES = 180;

const CASES = [
  { id: "town", mapId: "taba_town", x: 14, y: 4 },
  { id: "route", mapId: "rubberduck_route_01", x: 27, y: 11 },
  { id: "seam", mapId: "spyder_flower_city", x: 38, y: 4 },
] as const;
const VIEWPORTS = [
  { width: 480, height: 272 },
  { width: 960, height: 544 },
] as const;
const MODES = ["legacy", "seamless"] as const;
const selectedCases = caseArg ? CASES.filter((testCase) => testCase.id === caseArg) : [...CASES];
if (selectedCases.length === 0) throw new Error(`capture canopy parity: unknown case ${JSON.stringify(caseArg)}`);

interface ProjectShell {
  mapIndex: readonly { id: string; width: number; height: number }[];
  worldLayout?: { components: readonly WorldComponent[] };
}

interface Capture {
  rgba: Uint8Array;
  crop: { rgba: Uint8Array; width: number; height: number };
  stateHash: string;
  camera: readonly [number, number];
  playerRect: readonly [number, number, number, number];
  file: string;
  cropFile: string;
  rgbaFnv1a: string;
}

function writeComparisonSheet(key: string, legacy: Capture, seamless: Capture): string {
  if (legacy.crop.width !== seamless.crop.width || legacy.crop.height !== seamless.crop.height) {
    throw new Error("capture canopy parity: comparison crops have different dimensions");
  }
  const width = legacy.crop.width * 3;
  const height = legacy.crop.height;
  const rgba = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < legacy.crop.width; x++) {
      const source = (y * legacy.crop.width + x) * 4;
      const legacyTarget = (y * width + x) * 4;
      const seamlessTarget = (y * width + legacy.crop.width + x) * 4;
      const diffTarget = (y * width + legacy.crop.width * 2 + x) * 4;
      rgba.set(legacy.crop.rgba.subarray(source, source + 4), legacyTarget);
      rgba.set(seamless.crop.rgba.subarray(source, source + 4), seamlessTarget);
      const differs = legacy.crop.rgba.subarray(source, source + 4)
        .some((value, channel) => value !== seamless.crop.rgba[source + channel]);
      rgba.set(differs ? [255, 0, 255, 255] : [0, 0, 0, 255], diffTarget);
    }
  }
  const file = `${key}.comparison-3x.png`;
  writeFileSync(join(OUT, file), encodePNG(rgba, width, height));
  return file;
}

let seamCheckpoint: CapturedGoldenCheckpoint | undefined;
if (selectedCases.some((testCase) => testCase.id === "seam")) {
  const plan = loadGoldenSyncPlan(ROOT);
  const checkpoint = plan.mainline.find((candidate) =>
    candidate.suite === "j4" && candidate.name === "surfboard-collected"
  );
  if (!checkpoint) throw new Error("capture canopy parity: missing J4 Surfboard checkpoint");
  [seamCheckpoint] = captureGoldenCheckpoints(
    plan.mainlineMasks,
    [checkpoint],
    plan.worldTraversal,
    ROOT,
  );
  if (!seamCheckpoint) throw new Error("capture canopy parity: failed to capture J4 Surfboard checkpoint");
}

if (!existsSync(BUNDLE + ".js") || !existsSync(BUNDLE + ".pak")) {
  throw new Error("capture canopy parity: missing dist/main.{js,pak}; run `bun run build`");
}
const project = JSON.parse(await Bun.file(join(ROOT, "dist/project-shell.json")).text()) as ProjectShell;

function binding(mapId: string): { component: WorldComponent; placement: WorldPlacement } | undefined {
  for (const component of project.worldLayout?.components ?? []) {
    const placement = component.placements.find((candidate) => candidate.mapId === mapId);
    if (placement) return { component, placement };
  }
  return undefined;
}

function step(world: SimWorld, frames = 1): void {
  for (let frame = 0; frame < frames; frame++) {
    world.frame(0, 0x8080);
    world.tick();
    world.render();
  }
}

function live(label: string): { state: SessionState; camera: CameraState } {
  const state = globalThis.__rpgSessionState as SessionState | undefined;
  const camera = globalThis.__rpgGameCamera as CameraState | undefined;
  if (!state || !camera) throw new Error(`capture canopy parity: missing state/camera during ${label}`);
  return { state, camera };
}

async function waitFor(world: SimWorld, label: string, done: () => boolean, limit = 3_000): Promise<void> {
  for (let frame = 0; frame < limit; frame++) {
    if (done()) return;
    step(world);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
  const state = globalThis.__rpgSessionState as SessionState | undefined;
  throw new Error(
    `capture canopy parity: timed out waiting for ${label}; ` +
    `last=${state?.mapId ?? "none"}@${state?.move.tx ?? "?"},${state?.move.ty ?? "?"} ` +
    `moving=${state?.move.moving ?? "?"} fade=${state?.fade?.phase ?? "none"} ` +
    `scene=${state?.scene?.kind ?? "none"}`,
  );
}

function crop3x(
  rgba: Uint8Array,
  width: number,
  height: number,
  rect: readonly [number, number, number, number],
): { rgba: Uint8Array; width: number; height: number } {
  const pad = 16;
  const x0 = Math.max(0, Math.floor(rect[0]) - pad);
  const y0 = Math.max(0, Math.floor(rect[1]) - pad);
  const x1 = Math.min(width, Math.ceil(rect[0] + rect[2]) + pad);
  const y1 = Math.min(height, Math.ceil(rect[1] + rect[3]) + pad);
  const outWidth = (x1 - x0) * 3;
  const outHeight = (y1 - y0) * 3;
  const out = new Uint8Array(outWidth * outHeight * 4);
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const source = (y * width + x) * 4;
      for (let yy = 0; yy < 3; yy++) {
        for (let xx = 0; xx < 3; xx++) {
          out.set(rgba.subarray(source, source + 4), (((y - y0) * 3 + yy) * outWidth + (x - x0) * 3 + xx) * 4);
        }
      }
    }
  }
  return { rgba: out, width: outWidth, height: outHeight };
}

async function capture(
  mode: typeof MODES[number],
  testCase: typeof CASES[number],
  viewport: typeof VIEWPORTS[number],
): Promise<Capture> {
  const diagnostics: PocketTuxemonWorldDiagnostics = { renderer: mode };
  const world = await bootWorld(
    BUNDLE,
    60,
    { ...FIXED_TIME_HOST_GLOBALS, __pocketTuxemonWorldDiagnostics: diagnostics },
    undefined,
    viewport,
  );
  await waitFor(world, `${mode} boot`, () => !!globalThis.__rpgkitDemo && !!globalThis.__rpgSessionState);
  if (testCase.id === "seam") {
    if (!seamCheckpoint) throw new Error("capture canopy parity: seam checkpoint was not prepared");
    await restoreGoldenCheckpoint(world, diagnostics, seamCheckpoint, 1);
  }
  diagnostics.request = { seq: 1, mapId: testCase.mapId, x: testCase.x, y: testCase.y };
  await waitFor(world, `${mode} ${testCase.id} entry`, () => {
    const state = globalThis.__rpgSessionState as SessionState | undefined;
    return diagnostics.acknowledged === 1 && state?.mapId === testCase.mapId &&
      state.move.tx === testCase.x && state.move.ty === testCase.y;
  });
  step(world, SETTLE_FRAMES);
  const { state, camera } = live(`${mode} ${testCase.id}`);
  if (state.mapId !== testCase.mapId || state.move.tx !== testCase.x || state.move.ty !== testCase.y ||
      state.move.moving || state.fade !== null || state.scene !== null) {
    throw new Error(
      `capture canopy parity: unstable ${mode} ${testCase.id}: ` +
      `${state.mapId}@${state.move.tx},${state.move.ty} moving=${state.move.moving} ` +
      `fade=${state.fade?.phase ?? "none"} scene=${state.scene?.kind ?? "none"}`,
    );
  }
  const placed = mode === "seamless" ? binding(testCase.mapId) : undefined;
  const originX = (placed?.placement.originTileX ?? 0) * TILE;
  const originY = (placed?.placement.originTileY ?? 0) * TILE;
  const componentWidth = placed
    ? (placed.component.bounds.maxTileX - placed.component.bounds.minTileX) * TILE
    : project.mapIndex.find((map) => map.id === testCase.mapId)!.width * TILE;
  const componentHeight = placed
    ? (placed.component.bounds.maxTileY - placed.component.bounds.minTileY) * TILE
    : project.mapIndex.find((map) => map.id === testCase.mapId)!.height * TILE;
  const frameX = componentWidth < viewport.width ? Math.floor((viewport.width - componentWidth) / 2) : 0;
  const frameY = componentHeight < viewport.height ? Math.floor((viewport.height - componentHeight) / 2) : 0;
  const playerRect = [
    frameX + originX + state.move.px - camera.x,
    frameY + originY + state.move.py - camera.y - (PLAYER_HEIGHT - TILE),
    TILE,
    PLAYER_HEIGHT,
  ] as const;
  const rgba = world.render().slice();
  const base = `${testCase.id}.${mode}.${viewport.width}x${viewport.height}`;
  const file = `${base}.png`;
  const cropFile = `${base}.crop-3x.png`;
  const crop = crop3x(rgba, viewport.width, viewport.height, playerRect);
  writeFileSync(join(OUT, file), encodePNG(rgba, viewport.width, viewport.height));
  writeFileSync(join(OUT, cropFile), encodePNG(crop.rgba, crop.width, crop.height));
  return {
    rgba,
    crop,
    stateHash: createHash("sha256").update(JSON.stringify(state)).digest("hex"),
    camera: [camera.x, camera.y],
    playerRect,
    file,
    cropFile,
    rgbaFnv1a: fnv1a(rgba),
  };
}

function comparison(
  legacy: Capture,
  seamless: Capture,
  width: number,
): {
  alignment: "full-frame" | "player-centered";
  differentPixels: number;
  outsidePlayer: number;
  bounds: readonly [number, number, number, number] | null;
} {
  if (legacy.rgba.length !== seamless.rgba.length) throw new Error("capture canopy parity: frame size mismatch");
  if (legacy.stateHash !== seamless.stateHash) throw new Error("capture canopy parity: renderer changed reducer state");
  const sameScreenRect = legacy.playerRect.every((value, index) => value === seamless.playerRect[index]);
  const alignment = sameScreenRect ? "full-frame" : "player-centered";
  const height = legacy.rgba.length / width / 4;
  const pad = 16;
  const compareWidth = sameScreenRect ? width : legacy.playerRect[2] + pad * 2;
  const compareHeight = sameScreenRect ? height : legacy.playerRect[3] + pad * 2;
  const origins = sameScreenRect
    ? [[0, 0], [0, 0]] as const
    : [
        [legacy.playerRect[0] - pad, legacy.playerRect[1] - pad],
        [seamless.playerRect[0] - pad, seamless.playerRect[1] - pad],
      ] as const;
  for (const [x, y] of origins) {
    if (x < 0 || y < 0 || x + compareWidth > width || y + compareHeight > height) {
      throw new Error("capture canopy parity: player comparison crop leaves the viewport");
    }
  }
  let differentPixels = 0;
  let outsidePlayer = 0;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const [rx, ry, rw, rh] = sameScreenRect
    ? seamless.playerRect
    : [pad, pad, seamless.playerRect[2], seamless.playerRect[3]] as const;
  for (let y = 0; y < compareHeight; y++) {
    for (let x = 0; x < compareWidth; x++) {
      const legacyOffset = (((origins[0][1] + y) * width) + origins[0][0] + x) * 4;
      const seamlessOffset = (((origins[1][1] + y) * width) + origins[1][0] + x) * 4;
      let different = false;
      for (let channel = 0; channel < 4; channel++) {
        if (legacy.rgba[legacyOffset + channel] !== seamless.rgba[seamlessOffset + channel]) different = true;
      }
      if (!different) continue;
      differentPixels++;
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
      if (x < rx || x >= rx + rw || y < ry || y >= ry + rh) outsidePlayer++;
    }
  }
  return {
    alignment,
    differentPixels,
    outsidePlayer,
    bounds: differentPixels === 0 ? null : [minX, minY, maxX - minX + 1, maxY - minY + 1],
  };
}

mkdirSync(OUT, { recursive: true });
const captures: Record<string, Omit<Capture, "rgba" | "crop">> = {};
const comparisons: Record<string, ReturnType<typeof comparison> & { file: string }> = {};
for (const viewport of VIEWPORTS) {
  for (const testCase of selectedCases) {
    const pair = {} as Record<typeof MODES[number], Capture>;
    for (const mode of MODES) pair[mode] = await capture(mode, testCase, viewport);
    const key = `${testCase.id}.${viewport.width}x${viewport.height}`;
    for (const mode of MODES) {
      const { rgba: _, crop: __, ...metadata } = pair[mode];
      captures[`${key}.${mode}`] = metadata;
    }
    comparisons[key] = {
      ...comparison(pair.legacy, pair.seamless, viewport.width),
      file: writeComparisonSheet(key, pair.legacy, pair.seamless),
    };
    console.log(`${key}: ${JSON.stringify(comparisons[key])}`);
  }
}
writeFileSync(join(OUT, "manifest.json"), JSON.stringify({
  format: "pocket-tuxemon/canopy-parity/v1",
  cases: CASES,
  viewports: VIEWPORTS,
  settleFrames: SETTLE_FRAMES,
  captures,
  comparisons,
}, null, 2) + "\n");
