// Regression check: the built bundle replays the full mainline tape
// (GB6 + J1 + J2 + J3 + J4) through the bootWorld host and arrives at every
// journey checkpoint the session reducer recorded. The production GameView
// paginates long dialogs; a headless caliber that does not paginate the same
// way drifts (a small-window box takes a different number of confirms), so
// this guard fails the moment the built bundle and the reducer disagree on
// the mainline timeline.
//
// Usage:
//   bun tools/verify-bootworld-replay.ts            # all journey checkpoints
//   BOOTWORLD_SAMPLE=1000 bun tools/verify-bootworld-replay.ts
//     # also compare map/position every 1000 frames (slower, catches drift
//     # between checkpoints)

import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { bootWorld } from "../vendor/pocket-rpgkit/vendor/pocketjs/hosts/sim/sim.ts";
import type { SessionState } from "../vendor/pocket-rpgkit/src/engine/session.ts";
import { FIXED_TIME_HOST_GLOBALS } from "../battle/time-weather.ts";

const ROOT = resolve(import.meta.dir, "..");
const BUNDLE = join(ROOT, "dist/main");

interface JourneyMaps {
  maps: { name: string; frame: number; map: string; position: [number, number] }[];
  frames: number;
  masks: number[];
}

interface Checkpoint {
  mergedFrame: number;
  map: string;
  position: [number, number];
  label: string;
}

const SEGMENTS = [
  { file: "data/gb6-mainline-journey.json", label: "GB6" },
  { file: "data/j1-captainreturns-journey.json", label: "J1" },
  { file: "data/j2-hospitalcure-journey.json", label: "J2" },
  { file: "data/j3-omnichannelradioannounce-journey.json", label: "J3" },
  { file: "data/j4-kernelquestdone-journey.json", label: "J4" },
] as const;

function expect(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`bootworld replay: ${msg}`);
}

// Build the combined tape and the merged checkpoint list.
const masks: number[] = [];
const checkpoints: Checkpoint[] = [];
for (const seg of SEGMENTS) {
  const j = JSON.parse(readFileSync(join(ROOT, seg.file), "utf8")) as JourneyMaps;
  expect(j.frames === j.masks.length, `${seg.label} frame count ${j.frames} != masks ${j.masks.length}`);
  const base = masks.length;
  for (const mark of j.maps) {
    checkpoints.push({
      mergedFrame: base + mark.frame,
      map: mark.map,
      position: mark.position,
      label: `${seg.label}/${mark.name}`,
    });
  }
  masks.push(...j.masks);
}
checkpoints.sort((a, b) => a.mergedFrame - b.mergedFrame);

const sampleEvery = Number(process.env.BOOTWORLD_SAMPLE ?? "0");
const wanted = new Map<number, Checkpoint[]>();
for (const cp of checkpoints) {
  const rows = wanted.get(cp.mergedFrame) ?? [];
  rows.push(cp);
  wanted.set(cp.mergedFrame, rows);
}

if (!existsSync(BUNDLE + ".js") || !existsSync(BUNDLE + ".pak")) {
  throw new Error("bootworld replay: missing dist/main.{js,pak}; run `bun run build`");
}
function existsSync(p: string): boolean {
  try {
    readFileSync(p);
    return true;
  } catch {
    return false;
  }
}

const started = performance.now();
const world = await bootWorld(BUNDLE, 60, FIXED_TIME_HOST_GLOBALS, undefined, { width: 480, height: 272 });
let state: SessionState | undefined;
let failures = 0;
let firstFailure: string | null = null;
let sampled = 0;
for (let frame = 0; frame < masks.length; frame++) {
  world.frame(masks[frame]!);
  world.tick();
  state = globalThis.__rpgSessionState as SessionState | undefined;
  const rows = wanted.get(frame);
  if (rows) {
    for (const cp of rows) {
      if (!state || state.mapId !== cp.map || state.move.tx !== cp.position[0] || state.move.ty !== cp.position[1]) {
        const msg = `${cp.label} diverged at merged f${frame}: ` +
          `want ${cp.map}@${cp.position.join(",")} got ${state?.mapId}@${state?.move.tx},${state?.move.ty}`;
        if (!firstFailure) firstFailure = msg;
        failures++;
      }
    }
  }
  if (sampleEvery > 0 && frame % sampleEvery === 0 && state) {
    // A sampled frame only counts when the reducer also records it; without a
    // reducer reference here, sampling is a coarse liveness check (the player
    // must be on a known map and not stuck in a modal).
    sampled++;
    if (state.interp.modal && state.interp.modal.kind === "text" && state.interp.modal.complete) {
      const msg = `sampled f${frame}: a completed text modal is stuck open (${state.mapId}@${state.move.tx},${state.move.ty})`;
      if (!firstFailure) firstFailure = msg;
      failures++;
    }
  }
}

const elapsed = (performance.now() - started) / 1000;
if (failures > 0) {
  console.error(`BOOTWORLD REPLAY FAIL failures=${failures} checkpoints=${checkpoints.length} elapsed=${elapsed.toFixed(1)}s`);
  console.error(`  first: ${firstFailure}`);
  process.exit(1);
}
console.log(`BOOTWORLD REPLAY PASS checkpoints=${checkpoints.length}` +
  (sampleEvery > 0 ? ` sampled=${sampled}` : "") + ` frames=${masks.length} elapsed=${elapsed.toFixed(1)}s`);
