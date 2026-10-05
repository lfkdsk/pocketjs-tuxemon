// Shared authority for screenshot checkpoints.
//
// The maintained journey files were recorded against the pure reducer. The
// production GameView additionally paginates dialogue, so replaying those
// button masks as live UI input can consume a confirm on a page turn and
// silently drift. Golden tools instead replay the reducer once here, validate
// every checkpoint, serialize it through the save contract, and ask the built
// GameView to restore that exact state for painting.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { createTuxemonSessionOptions } from "../battle/game.ts";
import {
  canSave,
  createSessionSnapshot,
  encodeEnvelope,
} from "../vendor/pocket-rpgkit/src/engine/save.ts";
import {
  createSession,
  isSessionWorldIdle,
  startSession,
  stepSession,
  type SessionInput,
  type SessionState,
} from "../vendor/pocket-rpgkit/src/engine/session.ts";
import type { WorldTraversalMode } from "../vendor/pocket-rpgkit/src/engine/types.ts";
import type { SimWorld } from "../vendor/pocket-rpgkit/vendor/pocketjs/hosts/sim/sim.ts";
import type { PocketTuxemonWorldDiagnostics } from "../ui/world-diagnostics.ts";
import { journeyWorldTraversal, type Gb6JourneyResult, type Gb6MapCheckpoint } from "./gb6-journey.ts";
import type { J1JourneyResult } from "./j1-journey.ts";
import type { J2JourneyResult } from "./j2-journey.ts";
import type { J3JourneyResult } from "./j3-journey.ts";
import type { J4JourneyResult } from "./j4-journey.ts";
import { readInlineProject } from "./generated-project.ts";

export const GOLDEN_ROOT = resolve(import.meta.dir, "..");

export type GoldenSuite = "gb6-route" | "j1" | "j4" | "daylight";

export interface GoldenCheckpoint {
  suite: GoldenSuite;
  name: string;
  /** Zero-based mask index. State at this checkpoint is after this mask. */
  maskFrame: number;
  /** Segment-local frame retained in the J1/J4 manifests. */
  localFrame: number;
  map: string;
  position: readonly [number, number];
}

export interface CapturedGoldenCheckpoint {
  checkpoint: GoldenCheckpoint;
  /** Global reducer frame after folding `maskFrame` (always maskFrame + 1). */
  timelineFrame: number;
  held: number;
  snapshot: string;
}

interface G6Journey {
  format: "pocket-tuxemon/g6-journey/v1";
  worldTraversal?: unknown;
  hz: number;
  frames: number;
  masks: number[];
  checkpoints: Gb6MapCheckpoint[];
  sha256: string;
}

export interface GoldenSyncPlan {
  worldTraversal: WorldTraversalMode;
  mainlineMasks: number[];
  gb6TapeSha256: string;
  mainlineTapeSha256: string;
  mainline: GoldenCheckpoint[];
  daylightMasks: number[];
  daylightJourneySha256: string;
  daylight: GoldenCheckpoint[];
}

function expect(label: string, condition: unknown): asserts condition {
  if (!condition) throw new Error(`golden sync: ${label}`);
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function read<T>(root: string, file: string): T {
  return JSON.parse(readFileSync(join(root, file), "utf8")) as T;
}

function validateSegment(
  label: string,
  segment: { hz: number; frames: number; masks: number[]; tapeSha256: string },
): void {
  expect(`${label} is not 60 Hz`, segment.hz === 60);
  expect(`${label} frame count ${segment.frames} != masks ${segment.masks.length}`,
    segment.frames === segment.masks.length);
  expect(`${label} tape hash changed`, sha256(JSON.stringify(segment.masks)) === segment.tapeSha256);
}

function findMark(
  label: string,
  rows: readonly Gb6MapCheckpoint[],
  predicate: (row: Gb6MapCheckpoint) => boolean,
): Gb6MapCheckpoint {
  const row = rows.find(predicate);
  expect(`missing ${label} checkpoint`, row !== undefined);
  return row;
}

/** Select the last zero-input frame after a map-entry mark and before the
 * tape resumes player input. This replaces the four stale route literals. */
function settledRouteCheckpoint(
  journey: Gb6JourneyResult,
  name: string,
  markName: string,
): GoldenCheckpoint {
  const mark = findMark(name, journey.maps, (candidate) => candidate.name === markName);
  const nextInput = journey.masks.findIndex((mask, frame) => frame > mark.frame && mask !== 0);
  expect(`${name} has no input after map-entry f${mark.frame}`, nextInput > mark.frame);
  return {
    suite: "gb6-route",
    name,
    maskFrame: nextInput - 1,
    localFrame: nextInput - 1,
    map: mark.map,
    position: mark.position,
  };
}

export function loadGoldenSyncPlan(root: string = GOLDEN_ROOT): GoldenSyncPlan {
  const gb6 = read<Gb6JourneyResult>(root, "data/gb6-mainline-journey.json");
  const j1 = read<J1JourneyResult>(root, "data/j1-captainreturns-journey.json");
  const j2 = read<J2JourneyResult>(root, "data/j2-hospitalcure-journey.json");
  const j3 = read<J3JourneyResult>(root, "data/j3-omnichannelradioannounce-journey.json");
  const j4 = read<J4JourneyResult>(root, "data/j4-kernelquestdone-journey.json");
  const g6 = read<G6Journey>(root, "data/g6-journey.json");

  validateSegment("GB6", gb6);
  validateSegment("J1", j1);
  validateSegment("J2", j2);
  validateSegment("J3", j3);
  validateSegment("J4", j4);
  expect("wrong GB6 format", gb6.format === "pocket-tuxemon/gb6-mainline/v1");
  expect("wrong J1 format", j1.format === "pocket-tuxemon/j1-captainreturns/v1");
  expect("wrong J2 format", j2.format === "pocket-tuxemon/j2-hospitalcure/v1");
  expect("wrong J3 format", j3.format === "pocket-tuxemon/j3-omnichannelradioannounce/v1");
  expect("wrong J4 format", j4.format === "pocket-tuxemon/j4-kernelquestdone/v1");

  const worldTraversal = journeyWorldTraversal(gb6, "GB6 golden tape");
  for (const [label, segment] of [["J1", j1], ["J2", j2], ["J3", j3], ["J4", j4]] as const) {
    expect(`${label} traversal differs from GB6`,
      journeyWorldTraversal(segment, `${label} golden tape`) === worldTraversal);
  }
  const throughJ1 = [...gb6.masks, ...j1.masks];
  const throughJ2 = [...throughJ1, ...j2.masks];
  const throughJ3 = [...throughJ2, ...j3.masks];
  const mainlineMasks = [...throughJ3, ...j4.masks];
  expect("J1 ancestry frame count changed", j1.combinedFrames === throughJ1.length);
  expect("J1 ancestry hash changed", j1.combinedTapeSha256 === sha256(JSON.stringify(throughJ1)));
  expect("J2 parent identity changed",
    j2.base.frames === throughJ1.length && j2.base.tapeSha256 === j1.combinedTapeSha256);
  expect("J2 ancestry frame count changed", j2.combinedFrames === throughJ2.length);
  expect("J2 ancestry hash changed", j2.combinedTapeSha256 === sha256(JSON.stringify(throughJ2)));
  expect("J3 parent identity changed",
    j3.base.frames === throughJ2.length && j3.base.tapeSha256 === j2.combinedTapeSha256);
  expect("J3 ancestry frame count changed", j3.combinedFrames === throughJ3.length);
  expect("J3 ancestry hash changed", j3.combinedTapeSha256 === sha256(JSON.stringify(throughJ3)));
  expect("J4 parent identity changed",
    j4.base.frames === throughJ3.length && j4.base.tapeSha256 === j3.combinedTapeSha256);
  expect("J4 combined frame count changed", j4.combinedFrames === mainlineMasks.length);
  expect("J4 combined hash changed", j4.combinedTapeSha256 === sha256(JSON.stringify(mainlineMasks)));

  const routeEnd = findMark("route-3-end", gb6.maps, (candidate) => candidate.name === "route-3-end");
  const mainline: GoldenCheckpoint[] = [
    settledRouteCheckpoint(gb6, "cotton-town", "cotton_town"),
    settledRouteCheckpoint(gb6, "route-2", "route2"),
    settledRouteCheckpoint(gb6, "city-park", "citypark"),
    {
      suite: "gb6-route",
      name: routeEnd.name,
      maskFrame: routeEnd.frame,
      localFrame: routeEnd.frame,
      map: routeEnd.map,
      position: routeEnd.position,
    },
  ];
  for (const name of ["wayfarer-guestbook", "route-4-billie", "captain-found"] as const) {
    const mark = findMark(name, j1.maps, (candidate) => candidate.name === name);
    mainline.push({
      suite: "j1",
      name,
      maskFrame: gb6.frames + mark.frame,
      localFrame: mark.frame,
      map: mark.map,
      position: mark.position,
    });
  }
  const j4BaseFrames = throughJ3.length;
  for (const name of ["surfboard-collected", "datacenter-upper-screens", "kernel-defeated"] as const) {
    const mark = j4.steps.find((candidate) => candidate.name === name);
    expect(`missing ${name} checkpoint`, mark !== undefined);
    mainline.push({
      suite: "j4",
      name,
      maskFrame: j4BaseFrames + mark.frame,
      localFrame: mark.frame,
      map: mark.map,
      position: mark.position,
    });
  }

  expect("wrong G6 format", g6.format === "pocket-tuxemon/g6-journey/v1");
  expect("G6 is not 60 Hz", g6.hz === 60);
  expect("G6 frame count differs from masks", g6.frames === g6.masks.length);
  const { sha256: recordedG6Sha256, ...g6Body } = g6;
  expect("G6 journey self-hash changed", sha256(JSON.stringify(g6Body)) === recordedG6Sha256);
  expect("G6 traversal differs from GB6",
    journeyWorldTraversal(g6, "G6 daylight tape") === worldTraversal);
  const paperTown = findMark("paper-town", g6.checkpoints, (candidate) => candidate.name === "paper-town");
  return {
    worldTraversal,
    mainlineMasks,
    gb6TapeSha256: gb6.tapeSha256,
    mainlineTapeSha256: j4.combinedTapeSha256,
    mainline,
    daylightMasks: g6.masks,
    daylightJourneySha256: recordedG6Sha256,
    daylight: [{
      suite: "daylight",
      name: paperTown.name,
      maskFrame: paperTown.frame,
      localFrame: paperTown.frame,
      map: paperTown.map,
      position: paperTown.position,
    }],
  };
}

function input(mask: number, previous: number): SessionInput {
  const pressed = mask & ~previous;
  return {
    buttons: mask,
    confirmEdge: Boolean(pressed & 0x2000),
    cancelEdge: Boolean(pressed & 0x4000),
    upEdge: Boolean(pressed & 0x0010),
    downEdge: Boolean(pressed & 0x0040),
    leftEdge: Boolean(pressed & 0x0080),
    rightEdge: Boolean(pressed & 0x0020),
  };
}

export function captureGoldenCheckpoints(
  masks: readonly number[],
  checkpoints: readonly GoldenCheckpoint[],
  worldTraversal: WorldTraversalMode,
  root: string = GOLDEN_ROOT,
): CapturedGoldenCheckpoint[] {
  expect("checkpoint list is empty", checkpoints.length > 0);
  const wanted = new Map<number, GoldenCheckpoint[]>();
  for (const checkpoint of checkpoints) {
    expect(`${checkpoint.suite}/${checkpoint.name} frame is outside the tape`,
      Number.isInteger(checkpoint.maskFrame) && checkpoint.maskFrame >= 0 && checkpoint.maskFrame < masks.length);
    const rows = wanted.get(checkpoint.maskFrame) ?? [];
    rows.push(checkpoint);
    wanted.set(checkpoint.maskFrame, rows);
  }
  const project = readInlineProject(root);
  expect(`project traversal differs from tape (${project.worldTraversal} != ${worldTraversal})`,
    project.worldTraversal === worldTraversal);
  const session = createSession(project, 60, createTuxemonSessionOptions(project, worldTraversal));
  let state = startSession(project, session);
  let previous = 0;
  const captures: CapturedGoldenCheckpoint[] = [];
  const lastFrame = Math.max(...wanted.keys());
  for (let frame = 0; frame <= lastFrame; frame++) {
    const mask = masks[frame]!;
    state = stepSession(session, state, input(mask, previous));
    previous = mask;
    for (const checkpoint of wanted.get(frame) ?? []) {
      expect(`${checkpoint.suite}/${checkpoint.name} f${frame} diverged: `
        + `${state.mapId}@${state.move.tx},${state.move.ty} != `
        + `${checkpoint.map}@${checkpoint.position.join(",")}`,
      state.mapId === checkpoint.map
        && state.move.tx === checkpoint.position[0]
        && state.move.ty === checkpoint.position[1]);
      expect(`${checkpoint.suite}/${checkpoint.name} f${frame} reducer frame ${state.frame} != ${frame + 1}`,
        state.frame === frame + 1);
      expect(`${checkpoint.suite}/${checkpoint.name} f${frame} is not world-idle`, isSessionWorldIdle(state));
      expect(`${checkpoint.suite}/${checkpoint.name} f${frame} is not saveable`,
        canSave(state.move, state.interp, state.scene, state.handoff));
      captures.push({
        checkpoint,
        timelineFrame: state.frame,
        held: mask >>> 0,
        snapshot: encodeEnvelope(createSessionSnapshot(session, state, mask)),
      });
    }
  }
  expect(`captured ${captures.length}/${checkpoints.length} checkpoints`, captures.length === checkpoints.length);
  return captures.sort((a, b) => checkpoints.indexOf(a.checkpoint) - checkpoints.indexOf(b.checkpoint));
}

export async function restoreGoldenCheckpoint(
  world: SimWorld,
  diagnostics: PocketTuxemonWorldDiagnostics,
  capture: CapturedGoldenCheckpoint,
  seq: number,
): Promise<SessionState> {
  const expected = capture.checkpoint;
  diagnostics.restoreRequest = {
    seq,
    snapshot: capture.snapshot,
    timelineFrame: capture.timelineFrame,
  };
  for (let attempt = 0; attempt < 128; attempt++) {
    world.frame(0);
    world.tick();
    if (diagnostics.restoreAcknowledged === seq) {
      const state = globalThis.__rpgSessionState as SessionState | undefined;
      expect(`${expected.suite}/${expected.name} restore has no live state`, state !== undefined);
      expect(`${expected.suite}/${expected.name} restored reducer frame ${state.frame} != ${capture.timelineFrame}`,
        state.frame === capture.timelineFrame);
      expect(`${expected.suite}/${expected.name} restored at ${state.mapId}@${state.move.tx},${state.move.ty}`,
        state.mapId === expected.map
          && state.move.tx === expected.position[0]
          && state.move.ty === expected.position[1]);
      expect(`${expected.suite}/${expected.name} restored state is not world-idle`, isSessionWorldIdle(state));
      return state;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
  throw new Error(`golden sync: ${expected.suite}/${expected.name} restore was not acknowledged`);
}

export function verifyGoldenSync(root: string = GOLDEN_ROOT): CapturedGoldenCheckpoint[] {
  const plan = loadGoldenSyncPlan(root);
  return [
    ...captureGoldenCheckpoints(plan.mainlineMasks, plan.mainline, plan.worldTraversal, root),
    ...captureGoldenCheckpoints(plan.daylightMasks, plan.daylight, plan.worldTraversal, root),
  ];
}
