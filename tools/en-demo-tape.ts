// Transcribing the English mainline tape for the English demo build.
//
// The maintained journeys (GB6 + J1..J4) were recorded against the English
// reducer with NO dialog paginator. The built game (GameView) paginates text
// at the 480 px design width, and exactly two English corner windows take two
// pages there (both in the Nimrod rooms): the recording closes each four
// frames after it opens, but the paged box needs an extra page-turn confirm
// that window cannot hold. Replaying the canonical tape through the paginator
// (the web chapter Autoplay and the in-game SELECT menu) therefore drifts
// from every chapter before Candy Town.
//
// The Chinese transcriber (tools/zh-tape.ts) solves a different problem: it
// keeps the English frame count and rewrites confirms inside each box window.
// That cannot work here: the source window is shorter than the paged box. So
// this transcriber INSERTS frames. When the source closes a box but the paged
// target still has it open, it folds release/confirm masks on the target only
// until the target box closes too, then resumes lockstep. The source session
// does not fold during inserted frames, so every later canonical mask still
// lines up with the same story point. The demo tape is the canonical tape with
// those masks inserted (8 frames today).
//
// Inserted frames advance the target clock (the per-map time/weather parallel
// event ticks every reference tick, modal or not). The clock shift is the
// intended "a real player reads the paged dialog" timing, and it is tiny: the
// whole tape stays inside one game hour and before the first weather
// transition, so no time_is branch, weather or daylight stage can change. The
// neutral comparison therefore sets the timeline aside (the global frame and
// the extension's clock/weather) and compares every story field.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { tuxemonExtensionState } from "../battle/extension.ts";
import { TUXEMON_BATTLE_DB } from "../battle/game.ts";
import { canonicalJson } from "../vendor/pocket-rpgkit/src/engine/save.ts";
import { stepSession, type Session, type SessionState } from "../vendor/pocket-rpgkit/src/engine/session.ts";
import {
  boxClosed,
  neutralDigest,
  neutralSummary,
  sha256,
  tapeInput,
  textModal,
  withoutWords,
  type NeutralSummary,
} from "./zh-tape.ts";

export const EN_DEMO_TAPE_REL = "data/en-demo-journey.json";
export const EN_DEMO_TAPE_FORMAT = "pocket-tuxemon/en-demo-journey/v1";
export const EN_DEMO_CHAPTERS_FORMAT = "pocket-tuxemon/chapters-en-demo/v1";

const CONFIRM = 0x2000;
/** Never insert more than this many frames for one box: a paged box needs at
 *  most a handful (release/complete/release/close per extra page). */
const MAX_INSERT_PER_BOX = 256;

export interface EnDemoInsertion {
  /** Canonical frame whose fold closed the source box (the confirm edge).
   *  The inserted masks are folded immediately after it, before canonical
   *  frame `afterFrame + 1`. */
  afterFrame: number;
  /** The masks folded only by the paged target (release/confirm). */
  masks: number[];
  fiber: string;
  map: string;
}

export interface EnDemoStats {
  /** Text boxes the source closed. */
  textBoxes: number;
  /** Boxes that take more than one page in the built game. */
  pagedBoxes: number;
  /** Boxes that needed inserted frames. */
  insertedBoxes: number;
  insertedFrames: number;
  insertedConfirms: number;
  neutralChecks: number;
}

export interface EnDemoTranscribeOptions {
  source: readonly number[];
  sourceSession: Session;
  sourceStart: SessionState;
  targetSession: Session;
  targetStart: SessionState;
  /** Canonical tape indices at which both states are captured (the state
   *  after folding that many canonical masks) and must be story-equal. */
  captureAt?: readonly number[];
  checkEvery?: number;
}

export interface EnDemoCapture {
  /** Canonical frame captured. */
  frame: number;
  /** The same point in the demo tape. */
  demoFrame: number;
  target: SessionState;
}

export interface EnDemoTranscribeResult {
  /** The canonical masks with the insertions interleaved. */
  masks: number[];
  insertions: EnDemoInsertion[];
  stats: EnDemoStats;
  captures: Map<number, EnDemoCapture>;
  terminal: { source: SessionState; target: SessionState };
}

export class EnDemoTranscribeError extends Error {}

/** Strip the time-weather clock and weather from a parsed extension state. */
function stripExtClock(ext: unknown): unknown {
  if (ext && typeof ext === "object" && !Array.isArray(ext)) {
    const { clock: _clock, weather: _weather, ...rest } = ext as Record<string, unknown>;
    return rest;
  }
  return ext;
}

/** The neutral state without its timeline: the global frame (the demo tape is
 *  longer), the per-map interpreter clock and audio position (inserted frames
 *  advance them), every fiber's relative `since` clock, and the extension's
 *  clock/weather (inserted frames advance them) — including the extension
 *  snapshot a running scene carries. Everything else — map, position,
 *  switches, variables, items, gold, the party and its RNG, fibers and their
 *  program counters — is compared. */
export function neutralStateDemo(state: SessionState): unknown {
  const neutral = withoutWords(state) as Record<string, unknown>;
  delete neutral.frame;
  const interp = neutral.interp as Record<string, unknown>;
  delete interp.frame;
  // The BGM/Audio position is a presentation clock that ticks every fold.
  delete interp.audio;
  const stripFiber = (fiber: unknown): void => {
    if (fiber && typeof fiber === "object") delete (fiber as Record<string, unknown>).since;
  };
  stripFiber(interp.main);
  if (interp.parallels && typeof interp.parallels === "object") {
    for (const fiber of Object.values(interp.parallels as Record<string, unknown>)) stripFiber(fiber);
  }
  delete interp.modal;
  const scene = neutral.scene as { state?: Record<string, unknown> } | null;
  if (scene?.state && typeof scene.state === "object") {
    delete scene.state.title;
    // A running scene (battle/cutscene) snapshots the extension state, clock
    // included; the demo tape reaches it a few frames later.
    if (scene.state.ext !== undefined) scene.state.ext = stripExtClock(scene.state.ext);
  }
  const ext = tuxemonExtensionState(state.ext, TUXEMON_BATTLE_DB) as unknown as Record<string, unknown>;
  neutral.ext = stripExtClock(ext);
  return neutral;
}

/** Story-level equality that tolerates the demo tape's timeline shift. The
 *  fast path is the exact neutral digest (matches everywhere no frames were
 *  inserted); the slow path sets the timeline aside and is taken only at and
 *  after an insertion. */
export function neutralEqualsDemo(a: SessionState, b: SessionState): boolean {
  if (neutralDigest(a) === neutralDigest(b)) return true;
  return canonicalJson(neutralStateDemo(a) as never) === canonicalJson(neutralStateDemo(b) as never);
}

/** The demo-tape index for a canonical frame: canonical frame plus every
 *  insertion that precedes it. */
export function demoFrameFor(canonicalFrame: number, insertions: readonly EnDemoInsertion[]): number {
  let offset = 0;
  for (const insertion of insertions) {
    if (insertion.afterFrame < canonicalFrame) offset += insertion.masks.length;
  }
  return canonicalFrame + offset;
}

/** Build the demo masks by interleaving the recorded insertions. */
export function applyInsertions(source: readonly number[], insertions: readonly EnDemoInsertion[]): number[] {
  const byFrame = new Map<number, number[]>();
  for (const insertion of insertions) {
    if (byFrame.has(insertion.afterFrame)) {
      throw new Error(`en-demo-tape: duplicate insertion after frame ${insertion.afterFrame}`);
    }
    byFrame.set(insertion.afterFrame, insertion.masks);
  }
  const out: number[] = [];
  for (let f = 0; f < source.length; f++) {
    out.push(source[f]!);
    const extra = byFrame.get(f);
    if (extra) out.push(...extra);
  }
  return out;
}

export function transcribeEnDemo(options: EnDemoTranscribeOptions): EnDemoTranscribeResult {
  const { source, sourceSession, targetSession } = options;
  const n = source.length;
  const checkEvery = options.checkEvery ?? 3600;
  const captureAt = new Set(options.captureAt ?? []);
  const captures = new Map<number, EnDemoCapture>();
  const masks: number[] = [];
  const insertions: EnDemoInsertion[] = [];
  const stats: EnDemoStats = {
    textBoxes: 0,
    pagedBoxes: 0,
    insertedBoxes: 0,
    insertedFrames: 0,
    insertedConfirms: 0,
    neutralChecks: 0,
  };

  let src = options.sourceStart;
  let tgt = options.targetStart;
  let srcPrev = 0;
  let tgtPrev = 0;
  let boxFiber: string | null = null;
  let boxPaged = false;
  let boxInserted = false;

  const check = (canonicalFrame: number, why: string): void => {
    stats.neutralChecks++;
    if (!neutralEqualsDemo(src, tgt)) {
      throw new EnDemoTranscribeError(
        `canonical frame ${canonicalFrame} (${why}): story states differ on ${src.mapId}\n  `
        + `src frame ${src.frame}, demo frame ${tgt.frame}`,
      );
    }
  };

  if (captureAt.has(0)) {
    check(0, "capture");
    captures.set(0, { frame: 0, demoFrame: 0, target: tgt });
  }

  for (let f = 0; f < n; f++) {
    const mask = source[f]!;
    const srcBefore = src;
    const tgtBefore = tgt;
    const srcText = textModal(srcBefore);
    const tgtText = textModal(tgtBefore);

    if (srcText && boxFiber === null) {
      boxFiber = srcText.fiber;
      boxPaged = false;
      boxInserted = false;
    }
    if (tgtText?.pageStarts) boxPaged = true;

    // The source folds exactly the canonical mask.
    const srcAfter = stepSession(sourceSession, srcBefore, tapeInput(mask, srcPrev));
    const srcClosedNow = srcText !== null && boxClosed(srcBefore, srcAfter);
    const srcEdge = (mask & CONFIRM) !== 0 && (srcPrev & CONFIRM) === 0;

    // The target folds the same mask. Outside a box the two sessions must see
    // identical modals; inside a box only the confirm bit may differ.
    let tgtAfter = stepSession(targetSession, tgtBefore, tapeInput(mask, tgtPrev));
    let tgtAfterPrev = mask;

    if (srcClosedNow && boxFiber !== null) {
      stats.textBoxes++;
      if (boxPaged) stats.pagedBoxes++;
    }

    // The source closed its box on a confirm edge, but the paged target still
    // has the box open: the confirm turned a page instead of closing. Fold
    // release/confirm masks on the target only until its box closes too.
    if (srcClosedNow && srcEdge && tgtText !== null && !boxClosed(tgtBefore, tgtAfter)) {
      if (tgtText.fiber !== boxFiber) {
        throw new EnDemoTranscribeError(`canonical frame ${f}: text boxes out of step on ${srcBefore.mapId} `
          + `(source ${boxFiber ?? "none"}, target ${tgtText.fiber})`);
      }
      const insertedMasks: number[] = [];
      let t = tgtAfter;
      let tPrev = tgtAfterPrev;
      let guard = 0;
      while (guard < MAX_INSERT_PER_BOX) {
        const held = (tPrev & CONFIRM) !== 0;
        const step = held ? 0 : CONFIRM;
        const before = t;
        const after = stepSession(targetSession, before, tapeInput(step, tPrev));
        insertedMasks.push(step);
        if (!held) stats.insertedConfirms++;
        tPrev = step;
        t = after;
        if (boxClosed(before, after)) break;
        guard++;
      }
      if (guard >= MAX_INSERT_PER_BOX) {
        const tm = textModal(t);
        throw new EnDemoTranscribeError(`canonical frame ${f}: target box ${tgtText.fiber} on ${srcBefore.mapId} `
          + `did not close within ${MAX_INSERT_PER_BOX} inserted frames `
          + `(page ${(tm?.page ?? 0) + 1}/${tm?.pageStarts?.length ?? 1}, complete=${tm?.complete})`);
      }
      insertions.push({ afterFrame: f, masks: insertedMasks, fiber: tgtText.fiber, map: srcBefore.mapId });
      stats.insertedFrames += insertedMasks.length;
      boxInserted = true;
      tgtAfter = t;
      tgtAfterPrev = tPrev;
    } else if (srcClosedNow && srcEdge && tgtText === null) {
      throw new EnDemoTranscribeError(`canonical frame ${f}: source closed ${boxFiber} but the target had no box open`);
    }

    if (srcClosedNow && boxFiber !== null) {
      if (boxInserted) stats.insertedBoxes++;
      boxFiber = null;
      boxPaged = false;
      boxInserted = false;
    }

    masks.push(mask);
    if (insertions.length > 0 && insertions[insertions.length - 1]!.afterFrame === f) {
      masks.push(...insertions[insertions.length - 1]!.masks);
    }

    src = srcAfter;
    srcPrev = mask;
    tgt = tgtAfter;
    tgtPrev = tgtAfterPrev;

    const k = f + 1;
    if (captureAt.has(k)) {
      check(k, "capture");
      captures.set(k, { frame: k, demoFrame: demoFrameFor(k, insertions), target: tgt });
    } else if (k === n) {
      check(k, "terminal");
    } else if (srcClosedNow) {
      check(k, "box closed");
    } else if (k % checkEvery === 0 && textModal(tgt) === null) {
      check(k, "cadence");
    }
  }

  return { masks, insertions, stats, captures, terminal: { source: src, target: tgt } };
}

/** A readable story summary for reports and the chapter check. */
export function demoNeutralSummary(state: SessionState): Omit<NeutralSummary, "frame"> {
  const { frame: _frame, ...rest } = neutralSummary(state);
  return rest;
}

export function enDemoTapeSha256(masks: readonly number[]): string {
  return sha256(JSON.stringify([...masks]));
}

export { sha256 };
