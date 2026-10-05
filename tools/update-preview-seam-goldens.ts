// Capture the neighbour character preview across mainline seams (plan and
// checks: tools/preview-seam-plan.ts). Production bundle on the sim host:
// warm through the G6 tape to Route 1, place the player one step inside each
// source map with the diagnostic entry hook (durable state kept), let the
// streams and the sandboxed preview settle, then cross with ordinary input.
// Writes one contact sheet per viewport and a manifest to
// docs/screenshots/preview-seam/.
//
// Usage: bun tools/update-preview-seam-goldens.ts   (after `bun run build`)

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { createTuxemonSessionOptions } from "../battle/game.ts";
import { FIXED_TIME_HOST_GLOBALS } from "../battle/time-weather.ts";
import type { PocketTuxemonWorldDiagnostics } from "../ui/world-diagnostics.ts";
import { bootWorld, fnv1a } from "../vendor/pocket-rpgkit/vendor/pocketjs/hosts/sim/sim.ts";
import { encodePNG } from "../vendor/pocket-rpgkit/vendor/pocketjs/tests/png.ts";
import { createSession, type SessionState } from "../vendor/pocket-rpgkit/src/engine/session.ts";
import type { CameraState, WorldComponent, WorldPlacement } from "../vendor/pocket-rpgkit/src/engine/types.ts";
import { sandboxActors } from "../vendor/pocket-rpgkit/src/engine/world-preview-sandbox.ts";
import type { Facing } from "../vendor/pocket-rpgkit/src/engine/types.ts";
import type { WalkPose } from "../vendor/pocket-rpgkit/src/engine/movement.ts";
import type { NpcArt } from "../vendor/pocket-rpgkit/src/ui/game-assets.ts";
import { decodePng } from "../importer/png.ts";
import { readInlineProject } from "./generated-project.ts";
import {
  assertPreviewSeamMatrix,
  checkPreviewSeamRun,
  PREVIEW_SEAM_CAPTURES,
  PREVIEW_SEAM_CROSSINGS,
  PREVIEW_SEAM_FORMAT,
  PREVIEW_SEAM_LATER_FRAMES,
  PREVIEW_SEAM_OUTPUT,
  PREVIEW_SEAM_VIEWPORTS,
  previewSeamSheetFile,
  type PreviewSeamActor,
  type PreviewSeamCapture,
  type PreviewSeamCheck,
  type PreviewSeamCrossing,
  type PreviewSeamFigure,
  type PreviewSeamFrame,
  type PreviewSeamGhost,
  type PreviewSeamLeftActor,
  type PreviewSeamManifest,
  type PreviewSeamRun,
  type PreviewSeamSheet,
  type Pixels,
  type Rect,
  type SpriteArt,
} from "./preview-seam-plan.ts";

const ROOT = resolve(import.meta.dir, "..");
const BUNDLE = resolve(ROOT, process.env.PREVIEW_SEAM_BUNDLE ?? "dist/main");
const OUTPUT = resolve(ROOT, process.env.PREVIEW_SEAM_OUTPUT ?? PREVIEW_SEAM_OUTPUT);
const JOURNEY = join(ROOT, "data/g6-journey.json");
const TILE = 16;
/** Idle frames after the streams settle, for the sandbox to finish every
 * visible neighbour (a few units per map, one unit per frame). */
const PREVIEW_SETTLE_FRAMES = 120;

if (!existsSync(`${BUNDLE}.js`) || !existsSync(`${BUNDLE}.pak`)) {
  throw new Error("preview seam goldens: missing dist/main.{js,pak}; run `bun run build`");
}

const project = readInlineProject(ROOT);
const session = createSession(project, 60, createTuxemonSessionOptions(project, "seamless-v1", { immutableState: true }));
const layout = project.worldLayout;
if (project.worldTraversal !== "seamless-v1" || !layout) throw new Error("preview seam goldens: not a seamless-v1 project");
const journey = JSON.parse(readFileSync(JOURNEY, "utf8")) as {
  hz: number;
  masks: number[];
  checkpoints: { name: string; frame: number; map: string }[];
};
const warmup = journey.checkpoints.find((checkpoint) => checkpoint.name === "route-1");
if (!warmup) throw new Error("preview seam goldens: missing route-1 warm-up checkpoint");

function binding(mapId: string): { component: WorldComponent; placement: WorldPlacement } {
  for (const component of layout!.components) {
    const placement = component.placements.find((candidate) => candidate.mapId === mapId);
    if (placement) return { component, placement };
  }
  throw new Error(`preview seam goldens: ${mapId} is not placed`);
}

for (const crossing of PREVIEW_SEAM_CROSSINGS) {
  const source = binding(crossing.sourceMap);
  const target = binding(crossing.targetMap);
  if (source.component.componentId !== target.component.componentId) {
    throw new Error(`preview seam goldens: ${crossing.id} maps are in different components`);
  }
  const opening = source.component.openings.find((candidate) =>
    candidate.compatibility === "coordinate-preserving"
    && candidate.source.mapId === crossing.sourceMap
    && candidate.target.mapId === crossing.targetMap
    && candidate.source.side === crossing.sourceSide
    && (candidate.axis === "x" ? crossing.start[0] : crossing.start[1]) >= candidate.source.span.start
    && (candidate.axis === "x" ? crossing.start[0] : crossing.start[1]) < candidate.source.span.end
  );
  if (!opening) throw new Error(`preview seam goldens: ${crossing.id} start is not on a seamless opening`);
}

type SimWorld = Awaited<ReturnType<typeof bootWorld>>;

function step(world: SimWorld, buttons = 0): void {
  world.frame(buttons, 0x8080);
  world.tick();
}

function live(label: string): { state: SessionState; camera: CameraState } {
  const state = globalThis.__rpgSessionState as SessionState | undefined;
  const camera = globalThis.__rpgGameCamera as CameraState | undefined;
  if (!state || !camera) throw new Error(`preview seam goldens: no state/camera during ${label}`);
  return { state, camera };
}

function streamsReady(diagnostics: PocketTuxemonWorldDiagnostics, crossing: PreviewSeamCrossing): boolean {
  return [diagnostics.stream?.ground, diagnostics.stream?.upper].every((stats) =>
    stats !== undefined && stats.pending === 0
    && stats.visibleMaps.includes(crossing.sourceMap) && stats.visibleMaps.includes(crossing.targetMap)
  );
}

interface Captured {
  frame: PreviewSeamFrame;
  rgba: Uint8Array;
  state: SessionState;
}

function captureFrame(world: SimWorld, viewport: { width: number; height: number }, capture: PreviewSeamCapture): Captured {
  const { state, camera } = live(capture);
  if (state.fade !== null || state.scene !== null) throw new Error(`preview seam goldens: ${capture} is covered`);
  const active = binding(state.mapId);
  const bounds = active.component.bounds;
  const componentWidth = (bounds.maxTileX - bounds.minTileX) * TILE;
  const componentHeight = (bounds.maxTileY - bounds.minTileY) * TILE;
  const offsetX = componentWidth < viewport.width ? Math.floor((viewport.width - componentWidth) / 2) : 0;
  const offsetY = componentHeight < viewport.height ? Math.floor((viewport.height - componentHeight) / 2) : 0;
  const worldX = active.placement.originTileX * TILE + state.move.px;
  const worldY = active.placement.originTileY * TILE + state.move.py;
  const rgba = world.render().slice();
  return {
    frame: {
      capture,
      figures: [],
      activeMap: state.mapId,
      camera: [camera.x, camera.y],
      offset: [offsetX, offsetY],
      player: [Math.floor(offsetX + worldX - camera.x), Math.floor(offsetY + worldY - camera.y - TILE), TILE, 2 * TILE],
      rgbaFnv1a: fnv1a(rgba),
    },
    rgba,
    state,
  };
}

function spriteRect(frame: PreviewSeamFrame, world: readonly [number, number]): Rect {
  return [
    Math.floor(frame.offset[0] + world[0] - frame.camera[0]),
    Math.floor(frame.offset[1] + world[1] - frame.camera[1] - TILE),
    TILE,
    2 * TILE,
  ];
}

function worldOf(mapId: string, px: number, py: number): [number, number] {
  const { placement } = binding(mapId);
  return [placement.originTileX * TILE + px, placement.originTileY * TILE + py];
}

function rectsFor(frames: readonly PreviewSeamFrame[], world: readonly [number, number], captures: readonly PreviewSeamCapture[]) {
  const rects: Partial<Record<PreviewSeamCapture, Rect>> = {};
  for (const frame of frames) if (captures.includes(frame.capture)) rects[frame.capture] = spriteRect(frame, world);
  return rects;
}

/** The character art the renderer paints, read from the import's
 * per-sprite NPC art table with the rules of the kit's src/ui/npc-art.ts
 * (spritePaints, npcArtKey, npcArtHeight; that module is not importable
 * outside the JSX build). */
const npcArtCache = new Map<string, NpcArt | "">();
function artOf(sprite: string, pose: WalkPose, facing: Facing): { path: string; height: number } | null {
  let entry = npcArtCache.get(sprite);
  if (entry === undefined) {
    const def = project.sprites?.[sprite];
    const file = join(ROOT, "dist/npc-src", `${sprite}.json`);
    const paints = !!def && (def.kind === "walker" || !!def.src);
    entry = paints && existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) as NpcArt : "";
    npcArtCache.set(sprite, entry);
  }
  if (entry === "") return null;
  const path = typeof entry === "string" ? entry
    : pose === 1 ? entry.walkL[facing]! : pose === 2 ? entry.walkR[facing]! : entry.idle[facing]!;
  if (!path.startsWith("assets/")) throw new Error(`preview seam goldens: ${sprite} paints ${path}, not a PNG`);
  return { path, height: typeof entry === "string" ? 16 : entry.h };
}

const artImages = new Map<string, SpriteArt>();
function readArt(path: string): SpriteArt {
  let image = artImages.get(path);
  if (!image) artImages.set(path, image = decodePng(new Uint8Array(readFileSync(join(ROOT, path)))));
  return image;
}

interface Placed {
  eventId: string;
  px: number;
  py: number;
  facing: Facing;
  pose: WalkPose;
  sprite: string;
  opacity: number;
}

function figuresOf(frame: PreviewSeamFrame, kind: PreviewSeamFigure["kind"], mapId: string, actors: readonly Placed[]): PreviewSeamFigure[] {
  const out: PreviewSeamFigure[] = [];
  for (const actor of actors) {
    const art = artOf(actor.sprite, actor.pose, actor.facing);
    if (!art) continue;
    const [x, y, width] = spriteRect(frame, worldOf(mapId, actor.px, actor.py));
    out.push({ eventId: actor.eventId, kind, art: art.path, rect: [x, y + 2 * TILE - art.height, width, art.height], opacity: actor.opacity });
  }
  return out;
}

const runs: PreviewSeamRun[] = [];
const checks: PreviewSeamCheck[] = [];
const sheets: PreviewSeamSheet[] = [];
const sheetImages: { file: string; png: Uint8Array }[] = [];

for (const viewport of PREVIEW_SEAM_VIEWPORTS) {
  const diagnostics: PocketTuxemonWorldDiagnostics = {};
  const world = await bootWorld(
    BUNDLE,
    60,
    { ...FIXED_TIME_HOST_GLOBALS, __pocketTuxemonWorldDiagnostics: diagnostics },
    undefined,
    viewport,
  );
  for (let frame = 0; frame <= warmup.frame; frame++) step(world, journey.masks[frame] ?? 0);
  if (live("warm-up").state.mapId !== warmup.map) throw new Error("preview seam goldens: warm-up missed Route 1");

  const sheetWidth = viewport.width * PREVIEW_SEAM_CAPTURES.length;
  const sheetHeight = viewport.height * PREVIEW_SEAM_CROSSINGS.length;
  const sheet = new Uint8Array(sheetWidth * sheetHeight * 4);
  let sequence = 0;
  for (const [crossingIndex, crossing] of PREVIEW_SEAM_CROSSINGS.entries()) {
    diagnostics.request = { seq: ++sequence, mapId: crossing.sourceMap, x: crossing.start[0], y: crossing.start[1] };
    for (let guard = 0; diagnostics.acknowledged !== sequence && guard < 60; guard++) step(world);
    const entered = live(`${crossing.id} entry`).state;
    if (entered.mapId !== crossing.sourceMap || entered.move.tx !== crossing.start[0] || entered.move.ty !== crossing.start[1]) {
      throw new Error(`preview seam goldens: entry to ${crossing.sourceMap}@${crossing.start.join(",")} missed`);
    }
    let ready = false;
    for (let guard = 0; guard < 240 && !ready; guard++) {
      step(world);
      world.render();
      ready = streamsReady(diagnostics, crossing);
    }
    if (!ready) throw new Error(`preview seam goldens: ${crossing.id} streams did not settle`);
    for (let frame = 0; frame < PREVIEW_SETTLE_FRAMES; frame++) {
      step(world);
      world.render();
      const { state } = live(`${crossing.id} settle`);
      if (state.handoff || state.fade || state.scene || state.mapId !== crossing.sourceMap) {
        throw new Error(`preview seam goldens: ${crossing.id} source did not stay idle`);
      }
    }

    const captured: Captured[] = [];
    let phase7: SessionState | undefined;
    for (let guard = 0; guard < 240; guard++) {
      step(world, crossing.button);
      const { state } = live(`${crossing.id} approach`);
      if (state.handoff) {
        if (state.handoff.phase !== 0) throw new Error(`preview seam goldens: ${crossing.id} first phase ${state.handoff.phase}`);
        captured.push(captureFrame(world, viewport, "before"));
        break;
      }
      if (state.fade || state.mapId !== crossing.sourceMap) throw new Error(`preview seam goldens: ${crossing.id} did not hand off seamlessly`);
    }
    if (!captured.length) {
      const { state } = live(`${crossing.id} approach`);
      throw new Error(`preview seam goldens: ${crossing.id} handoff did not start (player ${state.move.tx},${state.move.ty})`);
    }
    for (let guard = 0; guard < 30; guard++) {
      const { state } = live(`${crossing.id} handoff`);
      if (state.handoff?.phase === 7) phase7 = state;
      step(world, crossing.button);
      if (live(`${crossing.id} handoff`).state.mapId === crossing.targetMap) break;
      world.render();
    }
    if (live("commit").state.mapId !== crossing.targetMap || !phase7) throw new Error(`preview seam goldens: ${crossing.id} did not commit`);
    captured.push(captureFrame(world, viewport, "commit"));
    step(world);
    captured.push(captureFrame(world, viewport, "after"));
    for (let frame = 0; frame < PREVIEW_SEAM_LATER_FRAMES; frame++) {
      step(world);
      world.render();
    }
    captured.push(captureFrame(world, viewport, "later"));

    const frames = captured.map((entry) => entry.frame);
    const commit = captured[1]!.state;
    const after = captured[2]!.state;
    if (!commit.leftMap || commit.leftMap.mapId !== crossing.sourceMap) {
      throw new Error(`preview seam goldens: ${crossing.id} commit froze no left map`);
    }
    // What the session state puts on screen in each frame. The far side's
    // characters are expected where the first target tick puts them from
    // the preview on; the map left behind shows its frozen snapshot.
    const afterActors = sandboxActors(session, after);
    const [beforeFrame, commitFrame, afterFrame, laterFrame] = frames as [PreviewSeamFrame, PreviewSeamFrame, PreviewSeamFrame, PreviewSeamFrame];
    beforeFrame.figures = [
      ...figuresOf(beforeFrame, "source", crossing.sourceMap, sandboxActors(session, captured[0]!.state)),
      ...figuresOf(beforeFrame, "target", crossing.targetMap, afterActors),
    ];
    for (const [frame, state, targetActors] of [
      [commitFrame, commit, afterActors],
      [afterFrame, after, afterActors],
      [laterFrame, captured[3]!.state, sandboxActors(session, captured[3]!.state)],
    ] as const) {
      frame.figures = [
        ...figuresOf(frame, "target", crossing.targetMap, targetActors),
        ...(state.leftMap ? figuresOf(frame, "left", state.leftMap.mapId, state.leftMap.actors) : []),
      ];
    }
    const target: PreviewSeamActor[] = afterActors.map((actor) => {
      const world = worldOf(crossing.targetMap, actor.px, actor.py);
      return { eventId: actor.eventId, world, rects: rectsFor(frames, world, ["before", "commit", "after"]) };
    });
    const targetMap = session.maps.get(crossing.targetMap)!;
    const ghosts: PreviewSeamGhost[] = [];
    for (const actor of sandboxActors(session, after)) {
      const event = targetMap.events?.find((candidate) => candidate.id === actor.eventId);
      if (!event || (event.x === actor.tx && event.y === actor.ty)) continue;
      const authoredWorld = worldOf(crossing.targetMap, event.x * TILE, event.y * TILE);
      ghosts.push({ eventId: actor.eventId, authoredWorld, rects: rectsFor(frames, authoredWorld, ["commit", "after"]) });
    }
    const livePhase7 = new Map(sandboxActors(session, phase7).map((actor) => [actor.eventId, actor]));
    const left: PreviewSeamLeftActor[] = commit.leftMap.actors.map((actor) => {
      const world = worldOf(crossing.sourceMap, actor.px, actor.py);
      const before = livePhase7.get(actor.eventId);
      return {
        eventId: actor.eventId,
        world,
        rects: rectsFor(frames, world, ["commit", "after", "later"]),
        freezeShift: before ? Math.max(Math.abs(before.px - actor.px), Math.abs(before.py - actor.py)) : null,
      };
    });
    const run: PreviewSeamRun = { crossing: crossing.id, viewport: { ...viewport }, frames, target, ghosts, left, ratios: {}, figures: {} as PreviewSeamRun["figures"] };
    const pixels = (capture: PreviewSeamCapture): Pixels => ({
      width: viewport.width,
      height: viewport.height,
      rgba: captured[PREVIEW_SEAM_CAPTURES.indexOf(capture)]!.rgba,
      x0: 0,
      y0: 0,
      frameWidth: viewport.width,
      frameHeight: viewport.height,
    });
    const check = checkPreviewSeamRun(run, pixels, readArt);
    run.ratios = check.ratios;
    run.figures = check.figures;
    runs.push(run);
    checks.push(check);
    console.log(
      `${viewport.width}x${viewport.height} ${crossing.id}: far side ${check.targetChecked}, behind ${check.leftChecked},`
      + ` ghosts ${check.ghostChecked}, in place ${PREVIEW_SEAM_CAPTURES.map((capture) => check.figures[capture].present.length).join("/")}`
      + `${check.failures.length ? ` FAIL ${check.failures.join("; ")}` : ""}`,
    );
    for (const [column, entry] of captured.entries()) {
      for (let y = 0; y < viewport.height; y++) {
        const from = y * viewport.width * 4;
        sheet.set(
          entry.rgba.subarray(from, from + viewport.width * 4),
          ((crossingIndex * viewport.height + y) * sheetWidth + column * viewport.width) * 4,
        );
      }
    }
  }
  const file = previewSeamSheetFile(viewport);
  const png = encodePNG(sheet, sheetWidth, sheetHeight);
  sheetImages.push({ file, png });
  sheets.push({
    viewport: { ...viewport },
    file,
    width: sheetWidth,
    height: sheetHeight,
    pngSha256: createHash("sha256").update(png).digest("hex"),
  });
}

const manifest: PreviewSeamManifest = { format: PREVIEW_SEAM_FORMAT, captures: [...PREVIEW_SEAM_CAPTURES], runs, sheets };
mkdirSync(OUTPUT, { recursive: true });
for (const image of sheetImages) writeFileSync(join(OUTPUT, image.file), image.png);
writeFileSync(join(OUTPUT, "manifest.json"), JSON.stringify(manifest, null, 1) + "\n");
assertPreviewSeamMatrix(manifest, checks);
console.log(`preview seam goldens: ${runs.length} runs, ${sheets.length} contact sheets in ${OUTPUT}`);
