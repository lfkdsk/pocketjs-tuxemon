// Capture real production horizontal and vertical seamless handoffs. The
// diagnostic entry hook chooses a deterministic source tile; ordinary game
// input (including the real Surfboard prompt for the water case) then triggers
// the authored edge event and reducer-owned phase 0..7 handoff. No session
// state is synthesized.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { FIXED_TIME_HOST_GLOBALS } from "../battle/time-weather.ts";
import type { PocketTuxemonWorldDiagnostics } from "../ui/world-diagnostics.ts";
import { bootWorld, fnv1a } from "../vendor/pocket-rpgkit/vendor/pocketjs/hosts/sim/sim.ts";
import { encodePNG } from "../vendor/pocket-rpgkit/vendor/pocketjs/tests/png.ts";
import type { SessionState } from "../vendor/pocket-rpgkit/src/engine/session.ts";
import type {
  CameraState,
  WorldComponent,
  WorldPlacement,
} from "../vendor/pocket-rpgkit/src/engine/types.ts";
import type { WorldStreamedTerrainStats } from "../vendor/pocket-rpgkit/src/ui/WorldStreamedTerrain.tsx";
import {
  captureGoldenCheckpoints,
  loadGoldenSyncPlan,
  restoreGoldenCheckpoint,
} from "./golden-sync.ts";
import {
  assertWorldSeamManifest,
  type WorldSeamBandStats,
  type WorldSeamCaptureFrame,
  type WorldSeamContactSheet,
  type WorldSeamCrossingPlan,
  type WorldSeamManifest,
  type WorldSeamPhase,
  WORLD_SEAM_CROSSINGS,
  WORLD_SEAM_FORMAT,
  WORLD_SEAM_OUTPUT,
  WORLD_SEAM_PHASES,
  WORLD_SEAM_VIEWPORTS,
  worldSeamContactSheetFile,
  worldSeamFrameFile,
} from "./world-seam-capture-plan.ts";

const ROOT = resolve(import.meta.dir, "..");
const BUNDLE = join(ROOT, "dist/main");
const PROJECT = join(ROOT, "dist/project-shell.json");
const OUTPUT = join(ROOT, WORLD_SEAM_OUTPUT);
const TILE = 16;
const PLAYER_HEIGHT = 32;

interface ProjectShell {
  worldTraversal?: string;
  worldLayout?: { components: WorldComponent[] };
}

interface PendingImage {
  file: string;
  rgba: Uint8Array;
  width: number;
  height: number;
  png: Uint8Array;
}

type SimWorld = Awaited<ReturnType<typeof bootWorld>>;

if (!existsSync(BUNDLE + ".js") || !existsSync(BUNDLE + ".pak")) {
  throw new Error("world seam goldens: missing dist/main.{js,pak}; run `bun run build`");
}

const project = JSON.parse(readFileSync(PROJECT, "utf8")) as ProjectShell;
if (project.worldTraversal !== "seamless-v1" || !project.worldLayout) {
  throw new Error("world seam goldens: dist/project-shell.json is not a seamless-v1 project");
}
// Use the maintained mainline state immediately after collecting the
// Surfboard. The production bundle restores the real reducer snapshot, then
// the diagnostic entry hook changes only the map/start tile while preserving
// its inventory and story banks.
const goldenPlan = loadGoldenSyncPlan(ROOT);
const surfboardCheckpoint = goldenPlan.mainline.find((checkpoint) =>
  checkpoint.suite === "j4" && checkpoint.name === "surfboard-collected"
);
if (!surfboardCheckpoint) throw new Error("world seam goldens: missing Surfboard checkpoint");
const [surfboardCapture] = captureGoldenCheckpoints(
  goldenPlan.mainlineMasks,
  [surfboardCheckpoint],
  goldenPlan.worldTraversal,
  ROOT,
);
if (!surfboardCapture) throw new Error("world seam goldens: failed to capture Surfboard checkpoint");
/** Let entry autoruns create their NPCs and release controls before the real
 * directional approach. Stream readiness alone can arrive first. */
const ENTRY_SETTLE_FRAMES = 120;

function binding(mapId: string): { component: WorldComponent; placement: WorldPlacement } {
  for (const component of project.worldLayout!.components) {
    const placement = component.placements.find((candidate) => candidate.mapId === mapId);
    if (placement) return { component, placement };
  }
  throw new Error(`world seam goldens: missing world placement ${mapId}`);
}

function assertCaptureOpening(plan: WorldSeamCrossingPlan): void {
  const source = binding(plan.sourceMap);
  const target = binding(plan.targetMap);
  if (source.component.componentId !== target.component.componentId) {
    throw new Error(`world seam goldens: ${plan.orientation} maps are in different components`);
  }
  const opening = source.component.openings.find((candidate) => {
    const tangent = candidate.axis === "x" ? plan.start[0] : plan.start[1];
    return candidate.compatibility === "coordinate-preserving" &&
      candidate.source.mapId === plan.sourceMap &&
      candidate.target.mapId === plan.targetMap &&
      candidate.source.side === plan.sourceSide &&
      tangent >= candidate.source.span.start && tangent < candidate.source.span.end;
  });
  if (!opening) throw new Error(`world seam goldens: ${plan.orientation} capture has no seamless opening`);
  if (opening.movementCapability !== plan.movementCapability) {
    throw new Error(
      `world seam goldens: ${plan.orientation} opening capability is ` +
        `${opening.movementCapability ?? "none"}, expected ${plan.movementCapability ?? "none"}`,
    );
  }
}
for (const plan of WORLD_SEAM_CROSSINGS) assertCaptureOpening(plan);

function step(world: SimWorld, buttons = 0): void {
  world.frame(buttons, 0x8080);
  world.tick();
}

function stateAndCamera(label: string): { state: SessionState; camera: CameraState } {
  const state = globalThis.__rpgSessionState as SessionState | undefined;
  const camera = globalThis.__rpgGameCamera as CameraState | undefined;
  if (!state || !camera) throw new Error(`world seam goldens: missing state/camera during ${label}`);
  return { state, camera };
}

const CONFIRM = 0x2000;

/** Exercise the imported Choice Surf page. The player is on shore facing the
 * edge water cell; Yes sets v.swimming, applies the swimmer appearance and
 * performs the ordinary forced step whose playerTouch portal starts phase 0. */
function startSurfHandoff(world: SimWorld, plan: WorldSeamCrossingPlan): void {
  step(world, plan.button);
  step(world);
  step(world, CONFIRM);
  step(world);
  for (let guard = 0; guard < 480; guard++) {
    const state = stateAndCamera("Surf setup").state;
    if (state.handoff) {
      if (state.handoff.phase !== 0 || state.sw.variables["v.swimming"] !== 2 ||
          state.sw.playerAppearance?.sprite !== "swimmer") {
        throw new Error("world seam goldens: Surf interaction reached an invalid handoff state");
      }
      return;
    }
    const modal = state.interp.modal;
    if (modal?.kind === "choices" || (modal?.kind === "text" && modal.complete)) {
      step(world, CONFIRM);
      if (stateAndCamera("Surf confirmation").state.handoff) return;
      step(world);
    } else if (state.sw.variables["v.swimming"] === 2 &&
        state.sw.playerAppearance?.sprite === "swimmer" && state.playerRoute === null) {
      // The imported Surf action has stepped from shore onto the inner water
      // cell. Ordinary held input now enters the edge portal cell.
      step(world, plan.button);
    } else {
      step(world);
    }
    const next = stateAndCamera("Surf setup advance").state;
    if (next.fade || next.scene || next.mapId !== plan.sourceMap) {
      throw new Error("world seam goldens: Surf setup left the source before seamless phase 0");
    }
  }
  const stuck = stateAndCamera("Surf setup timeout").state;
  throw new Error(
    `world seam goldens: Surf interaction did not start a handoff ` +
      `(${stuck.mapId}@${stuck.move.tx},${stuck.move.ty} facing=${stuck.move.facing} ` +
      `modal=${stuck.interp.modal?.kind ?? "none"} surfboard=${stuck.sw.items.surfboard ?? 0} ` +
      `swimming=${String(stuck.sw.variables["v.swimming"])} ` +
      `appearance=${stuck.sw.playerAppearance?.sprite ?? "none"})`,
  );
}

function bandStats(
  label: string,
  stats: WorldStreamedTerrainStats | undefined,
  plan: WorldSeamCrossingPlan,
): WorldSeamBandStats {
  if (!stats) throw new Error(`world seam goldens: ${plan.orientation} has no ${label} stream stats`);
  if (!stats.visibleMaps.includes(plan.sourceMap) || !stats.visibleMaps.includes(plan.targetMap)) {
    throw new Error(`world seam goldens: ${plan.orientation} ${label} does not expose both maps`);
  }
  if (stats.pending !== 0) {
    throw new Error(`world seam goldens: ${plan.orientation} ${label} has ${stats.pending} pending chunks`);
  }
  return {
    visibleMaps: [...stats.visibleMaps],
    textures: stats.textures,
    resident: stats.resident,
    pooled: stats.pooled,
    created: stats.created,
    pending: stats.pending,
  };
}

function nonBlackPixels(rgba: Uint8Array): number {
  let count = 0;
  for (let offset = 0; offset < rgba.length; offset += 4) {
    if (rgba[offset + 3]! !== 0 && rgba[offset]! + rgba[offset + 1]! + rgba[offset + 2]! !== 0) count++;
  }
  return count;
}

function capture(
  world: SimWorld,
  diagnostics: PocketTuxemonWorldDiagnostics,
  plan: WorldSeamCrossingPlan,
  viewport: { width: number; height: number },
  capturePhase: WorldSeamPhase,
): { frame: WorldSeamCaptureFrame; image: PendingImage } {
  const { state, camera } = stateAndCamera(`${plan.orientation} ${capturePhase}`);
  const handoff = state.handoff;
  if (capturePhase === "landing") {
    if (handoff !== undefined || state.mapId !== plan.targetMap) {
      throw new Error(`world seam goldens: ${plan.orientation} did not land on ${plan.targetMap}`);
    }
  } else if (
    handoff?.phase !== capturePhase ||
    handoff.sourceMapId !== plan.sourceMap ||
    handoff.targetMapId !== plan.targetMap ||
    state.mapId !== plan.sourceMap
  ) {
    throw new Error(
      `world seam goldens: ${plan.orientation} expected phase ${capturePhase}, got ` +
        `${state.mapId} phase=${handoff?.phase ?? "none"}`,
    );
  }
  if (state.fade !== null || state.scene !== null) {
    throw new Error(
      `world seam goldens: ${plan.orientation} ${capturePhase} is obscured ` +
        `(fade=${state.fade?.phase ?? "none"}, scene=${state.scene?.kind ?? "none"})`,
    );
  }
  if (state.move.facing !== plan.facing) {
    throw new Error(`world seam goldens: ${plan.orientation} player faces away from the crossing`);
  }

  const active = binding(state.mapId);
  const componentWidth = (active.component.bounds.maxTileX - active.component.bounds.minTileX) * TILE;
  const componentHeight = (active.component.bounds.maxTileY - active.component.bounds.minTileY) * TILE;
  const frameX = componentWidth < viewport.width ? Math.floor((viewport.width - componentWidth) / 2) : 0;
  const frameY = componentHeight < viewport.height ? Math.floor((viewport.height - componentHeight) / 2) : 0;
  const worldX = active.placement.originTileX * TILE + state.move.px;
  const worldY = active.placement.originTileY * TILE + state.move.py;
  const screenX = Math.floor(frameX + worldX - camera.x);
  const screenY = Math.floor(frameY + worldY - camera.y - (PLAYER_HEIGHT - TILE));
  if (screenX + TILE <= 0 || screenX >= viewport.width || screenY + PLAYER_HEIGHT <= 0 || screenY >= viewport.height) {
    throw new Error(`world seam goldens: ${plan.orientation} player is outside the capture`);
  }

  const rgba = world.render().slice();
  const visiblePixels = nonBlackPixels(rgba);
  if (visiblePixels === 0) throw new Error(`world seam goldens: ${plan.orientation} ${capturePhase} is black`);
  const file = worldSeamFrameFile(plan.orientation, viewport, capturePhase);
  const png = encodePNG(rgba, viewport.width, viewport.height);
  const ground = bandStats("ground", diagnostics.stream?.ground, plan);
  const upper = bandStats("upper", diagnostics.stream?.upper, plan);
  return {
    frame: {
      orientation: plan.orientation,
      viewport: { ...viewport },
      capture: capturePhase,
      phase: capturePhase === "landing" ? null : capturePhase,
      sourceMap: plan.sourceMap,
      targetMap: plan.targetMap,
      activeMap: state.mapId,
      movementCapability: plan.movementCapability ?? null,
      swimming: typeof state.sw.variables["v.swimming"] === "number"
        ? state.sw.variables["v.swimming"]
        : null,
      appearance: state.sw.playerAppearance?.sprite ?? null,
      file,
      camera: [camera.x, camera.y],
      player: {
        tile: [state.move.tx, state.move.ty],
        localPixel: [state.move.px, state.move.py],
        worldPixel: [worldX, worldY],
        screenRect: [screenX, screenY, TILE, PLAYER_HEIGHT],
        facing: state.move.facing,
        movePhase: state.move.phase,
      },
      fade: null,
      scene: null,
      ground,
      upper,
      nonBlackPixels: visiblePixels,
      rgbaFnv1a: fnv1a(rgba),
      pngSha256: createHash("sha256").update(png).digest("hex"),
    },
    image: { file, rgba, width: viewport.width, height: viewport.height, png },
  };
}

function streamsReady(diagnostics: PocketTuxemonWorldDiagnostics, plan: WorldSeamCrossingPlan): boolean {
  return ([diagnostics.stream?.ground, diagnostics.stream?.upper] as const).every((stats) =>
    stats !== undefined &&
    stats.pending === 0 &&
    stats.visibleMaps?.includes(plan.sourceMap) &&
    stats.visibleMaps.includes(plan.targetMap)
  );
}

function makeContactSheet(rows: PendingImage[][]): Uint8Array {
  const source = rows[0]?.[0];
  if (!source || rows.some((row) => row.length !== WORLD_SEAM_PHASES.length)) {
    throw new Error("world seam goldens: contact sheet rows are incomplete");
  }
  const width = source.width * WORLD_SEAM_PHASES.length;
  const height = source.height * rows.length;
  const output = new Uint8Array(width * height * 4);
  for (let row = 0; row < rows.length; row++) {
    for (let column = 0; column < rows[row]!.length; column++) {
      const image = rows[row]![column]!;
      for (let y = 0; y < image.height; y++) {
        const sourceOffset = y * image.width * 4;
        const targetOffset = ((row * image.height + y) * width + column * image.width) * 4;
        output.set(image.rgba.subarray(sourceOffset, sourceOffset + image.width * 4), targetOffset);
      }
    }
  }
  return output;
}

const frames: WorldSeamCaptureFrame[] = [];
const images: PendingImage[] = [];
const contactSheets: WorldSeamContactSheet[] = [];

for (const viewport of WORLD_SEAM_VIEWPORTS) {
  const diagnostics: PocketTuxemonWorldDiagnostics = {};
  const world = await bootWorld(
    BUNDLE,
    60,
    { ...FIXED_TIME_HOST_GLOBALS, __pocketTuxemonWorldDiagnostics: diagnostics },
    undefined,
    viewport,
  );
  const warmState = await restoreGoldenCheckpoint(world, diagnostics, surfboardCapture, 1);
  if ((warmState.sw.items.surfboard ?? 0) < 1) {
    throw new Error("world seam goldens: maintained checkpoint has no Surfboard");
  }

  let requestSequence = 0;
  const viewportRows: PendingImage[][] = [];
  for (const plan of WORLD_SEAM_CROSSINGS) {
    diagnostics.request = {
      seq: ++requestSequence,
      mapId: plan.sourceMap,
      x: plan.start[0],
      y: plan.start[1],
    };
    for (let guard = 0; diagnostics.acknowledged !== requestSequence && guard < 60; guard++) step(world);
    if (diagnostics.acknowledged !== requestSequence) {
      throw new Error(`world seam goldens: diagnostic entry to ${plan.sourceMap} was not acknowledged`);
    }
    const entered = stateAndCamera(`${plan.orientation} entry`).state;
    if (entered.mapId !== plan.sourceMap || entered.move.tx !== plan.start[0] || entered.move.ty !== plan.start[1]) {
      throw new Error(`world seam goldens: diagnostic entry missed ${plan.sourceMap}@${plan.start.join(",")}`);
    }

    let ready = false;
    for (let guard = 0; guard < 240; guard++) {
      step(world);
      world.render();
      const state = stateAndCamera(`${plan.orientation} stream warm-up`).state;
      if (state.fade || state.scene || state.handoff) {
        throw new Error(`world seam goldens: ${plan.orientation} source did not remain idle during warm-up`);
      }
      if (streamsReady(diagnostics, plan)) {
        ready = true;
        break;
      }
    }
    if (!ready) throw new Error(`world seam goldens: ${plan.orientation} streams did not settle`);
    for (let frame = 0; frame < ENTRY_SETTLE_FRAMES; frame++) {
      step(world);
      world.render();
      const state = stateAndCamera(`${plan.orientation} entry settle`).state;
      if (state.fade || state.scene || state.handoff || state.mapId !== plan.sourceMap) {
        throw new Error(`world seam goldens: ${plan.orientation} source did not remain idle during entry settle`);
      }
    }

    let started = false;
    if (plan.movementCapability === "surf") {
      startSurfHandoff(world, plan);
      started = true;
    } else {
      for (let guard = 0; guard < 240; guard++) {
        step(world, plan.button);
        const state = stateAndCamera(`${plan.orientation} approach`).state;
        if (state.handoff) {
          if (state.handoff.phase !== 0) {
            throw new Error(`world seam goldens: ${plan.orientation} first observed phase ${state.handoff.phase}`);
          }
          started = true;
          break;
        }
        if (state.fade || state.mapId !== plan.sourceMap) {
          throw new Error(`world seam goldens: ${plan.orientation} used a legacy transfer instead of a handoff`);
        }
      }
    }
    if (!started) {
      const state = stateAndCamera(`${plan.orientation} stuck`).state;
      const dx = plan.facing === 1 ? -1 : plan.facing === 3 ? 1 : 0;
      const dy = plan.facing === 2 ? -1 : plan.facing === 0 ? 1 : 0;
      const blockers = Object.entries(state.chars.chars)
        .filter(([, actor]) => actor.tx === state.move.tx + dx && actor.ty === state.move.ty + dy)
        .map(([eventId, actor]) => `${eventId}[visible=${actor.visible},blocks=${actor.blocks},page=${actor.pageIndex}]`)
        .join(",");
      throw new Error(
        `world seam goldens: ${plan.orientation} handoff did not start ` +
        `(player ${state.move.tx},${state.move.ty}, moving=${state.move.moving}, ` +
        `inputLocked=${state.interp.inputLocked}, main=${state.interp.main !== null}, ` +
        `actorsAhead=${blockers || "none"})`,
      );
    }

    const row: PendingImage[] = [];
    for (const capturePhase of WORLD_SEAM_PHASES) {
      if (capturePhase !== 0) step(world);
      const captured = capture(world, diagnostics, plan, viewport, capturePhase);
      frames.push(captured.frame);
      images.push(captured.image);
      row.push(captured.image);
    }
    viewportRows.push(row);
  }

  const sheetRgba = makeContactSheet(viewportRows);
  const sheetWidth = viewport.width * WORLD_SEAM_PHASES.length;
  const sheetHeight = viewport.height * WORLD_SEAM_CROSSINGS.length;
  const sheetFile = worldSeamContactSheetFile(viewport);
  const sheetPng = encodePNG(sheetRgba, sheetWidth, sheetHeight);
  images.push({ file: sheetFile, rgba: sheetRgba, width: sheetWidth, height: sheetHeight, png: sheetPng });
  contactSheets.push({
    viewport: { ...viewport },
    file: sheetFile,
    width: sheetWidth,
    height: sheetHeight,
    columns: WORLD_SEAM_PHASES.length,
    rows: WORLD_SEAM_CROSSINGS.map((plan, index) => ({
      orientation: plan.orientation,
      files: viewportRows[index]!.map((image) => image.file),
    })),
    pngSha256: createHash("sha256").update(sheetPng).digest("hex"),
  });
}

const manifest: WorldSeamManifest = {
  format: WORLD_SEAM_FORMAT,
  phases: [...WORLD_SEAM_PHASES],
  frames,
  contactSheets,
};
assertWorldSeamManifest(manifest);

mkdirSync(OUTPUT, { recursive: true });
for (const image of images) writeFileSync(join(OUTPUT, image.file), image.png);
writeFileSync(join(OUTPUT, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
console.log(
  `world seam goldens: wrote ${frames.length} crossing frames and ${contactSheets.length} contact sheets to ${OUTPUT}`,
);
