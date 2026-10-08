// Shared helpers for PSP mainline segment builds and their verification.
//
// A segment is a chapter save envelope plus a suffix of the concatenated
// GB6+J1+J2+J3+J4 mainline tape. The PSP build bakes both into the journey
// wrapper (tools/psp.ts); the desktop replay here computes the terminal-state
// pin the PSP run must reach, and the verifier (tools/verify-psp-journey.ts)
// re-derives the pin from the build receipt before comparing.
//
// Committed chapters come from data/chapters.json. Intermediate envelopes
// (for splitting long chapter windows) are generated on demand by
// generateEnvelope() into .psp-segments/ — deterministic, never committed.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { createTuxemonSessionOptions } from "../battle/game.ts";
import {
  canSave,
  canonicalJson,
  createSessionSnapshot,
  decodeEnvelopeText,
  encodeEnvelope,
} from "../vendor/pocket-rpgkit/src/engine/save.ts";
import { restoreSessionSnapshot } from "../vendor/pocket-rpgkit/src/engine/save-restore.ts";
import {
  createSession,
  startSession,
  stepSession,
  type SessionInput,
  type SessionState,
} from "../vendor/pocket-rpgkit/src/engine/session.ts";
import type { WorldTraversalMode } from "../vendor/pocket-rpgkit/src/engine/types.ts";
import { readInlineProject } from "./generated-project.ts";
import { mainlineSessionOptions } from "./mainline-session.ts";

export const ROOT = resolve(import.meta.dir, "..");
export const CHAPTERS_PATH = join(ROOT, "data/chapters.json");
export const GENERATED_SEGMENT_DIR = join(ROOT, ".psp-segments");

const TAPE_FILES = [
  "data/gb6-mainline-journey.json",
  "data/j1-captainreturns-journey.json",
  "data/j2-hospitalcure-journey.json",
  "data/j3-omnichannelradioannounce-journey.json",
  "data/j4-kernelquestdone-journey.json",
] as const;

export interface SegmentEnvelope {
  id: string;
  /** First mask index of the suffix on the concatenated tape. */
  frame: number;
  /** Global reducer frame at the checkpoint. */
  timelineFrame: number;
  held: number;
  map: string;
  position: [number, number];
  /** rpgkit-save/v1 envelope string. */
  snapshot: string;
}

export interface SegmentSpec {
  chapter: string;
  generated: boolean;
  startFrame: number;
  endFrame: number;
  envelope: SegmentEnvelope;
  suffix: number[];
  /** Replay with the production dialog paginator (the PSP/GameView and
   *  canonical mainline path). Defaults to true; false is retained only for
   *  callers that deliberately exercise the legacy unpaginated path. */
  paginate?: boolean;
}

export interface SegmentPin {
  terminalSha256: string;
  endMap: string;
  endPosition: [number, number];
  endFrame: number;
}

/** The journeySegment block of a PSP build receipt (tools/psp.ts). */
export interface SegmentReceipt {
  chapter: string;
  generated: boolean;
  /** Exclusive suffix bound on the concatenated tape. */
  startFrame: number;
  endFrame: number;
  /** Suffix length (endFrame - startFrame). */
  frames: number;
  snapshotSha256: string;
  tapeSha256: string;
  terminalSha256: string;
  endMap: string;
  endPosition: [number, number];
  /** Global reducer frame at the terminal (timelineFrame + frames). */
  terminalFrame: number;
  envelope: SegmentEnvelope;
}

export interface ProfileEntry {
  kind?: unknown;
  buildId?: unknown;
  segment?: unknown;
  frame?: unknown;
  state?: unknown;
  passed?: unknown;
}

interface TapeMeta {
  file: string;
  frames: number;
  tapeSha256: string;
}

interface ChaptersFile {
  worldTraversal: WorldTraversalMode;
  tape: {
    gb6: TapeMeta;
    j1: TapeMeta;
    j2: TapeMeta;
    j3: TapeMeta;
    j4?: TapeMeta;
    frames: number;
    sha256: string;
  };
  chapters: {
    id: string;
    frame: number;
    timelineFrame: number;
    held: number;
    map: string;
    position: [number, number];
    snapshot: string;
  }[];
}

export function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/** Check a build artifact's sha256 against the receipt's artifacts block.
 *  The PRX a profile came from must hash to the receipt's artifact hash, or
 *  the profile cannot be tied to the verified build. */
export function checkBuildArtifact(
  artifacts: Record<string, { sha256?: unknown }> | undefined,
  name: string,
  actualSha256: string,
): void {
  const expected = artifacts?.[name]?.sha256;
  if (typeof expected !== "string" || expected !== actualSha256) {
    throw new Error(`Build artifact ${name} does not match the receipt`);
  }
}

export function mainlineInput(mask: number, previous: number): SessionInput {
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

export function loadChapters(root: string = ROOT): ChaptersFile {
  return JSON.parse(readFileSync(join(root, "data/chapters.json"), "utf8")) as ChaptersFile;
}

/** Load and validate the concatenated GB6+J1+J2+J3+J4 mainline tape against
 *  the committed chapters.json tape metadata. */
export function loadMainlineTape(root: string = ROOT): {
  combined: number[];
  worldTraversal: WorldTraversalMode;
} {
  const chapters = loadChapters(root);
  const j4 = chapters.tape.j4;
  if (!j4) throw new Error("chapters.json is missing the j4 tape metadata");
  const perTape = [chapters.tape.gb6, chapters.tape.j1, chapters.tape.j2, chapters.tape.j3, j4];
  const combined: number[] = [];
  for (const [i, file] of TAPE_FILES.entries()) {
    const meta = perTape[i]!;
    if (meta.file !== file) {
      throw new Error(`chapters.json tape[${i}] file is ${meta.file}, expected ${file}`);
    }
    const doc = JSON.parse(readFileSync(join(root, file), "utf8")) as {
      masks: number[];
      frames?: number;
    };
    if (typeof doc.frames === "number" && doc.frames !== doc.masks.length) {
      throw new Error(`${file}: frames ${doc.frames} != masks ${doc.masks.length}`);
    }
    if (doc.masks.length !== meta.frames) {
      throw new Error(`${file}: ${doc.masks.length} masks != chapters.json ${meta.frames}`);
    }
    if (sha256(JSON.stringify(doc.masks)) !== meta.tapeSha256) {
      throw new Error(`${file}: tape hash changed; data/chapters.json is stale`);
    }
    combined.push(...doc.masks);
  }
  // The PSP mainline is the full GB6+J1+J2+J3+J4 mainline; chapters.json may
  // carry later journeys beyond it, so validate the length from the per-tape
  // metadata (and the aggregate frames, which now cover the same span).
  const prefixFrames = perTape.reduce((sum, t) => sum + t.frames, 0);
  if (combined.length !== prefixFrames) {
    throw new Error(`combined ${combined.length} != chapters.json prefix ${prefixFrames}`);
  }
  if (chapters.tape.frames !== combined.length) {
    throw new Error(`chapters.json aggregate frames ${chapters.tape.frames} != combined ${combined.length}`);
  }
  return { combined, worldTraversal: chapters.worldTraversal };
}

/** Slice a suffix off the concatenated tape. Kept as its own function so the
 *  slice bounds are test-covered (a +1 on the start silently drops the first
 *  input frame). */
export function sliceSuffix(
  combined: readonly number[],
  startFrame: number,
  endFrame: number,
): number[] {
  if (startFrame < 0 || endFrame > combined.length || startFrame >= endFrame) {
    throw new Error(`bad suffix slice [${startFrame}, ${endFrame}) of ${combined.length}`);
  }
  return combined.slice(startFrame, endFrame);
}

/** Resolve a segment reference: a committed chapter id, or a generated
 *  envelope in .psp-segments/<ref>.json. The end defaults to the next
 *  committed chapter after the start (or the tape end). */
export function resolveSegment(
  root: string,
  chapterRef: string,
  endFrameOpt?: number,
): SegmentSpec {
  const { combined } = loadMainlineTape(root);
  const chapters = loadChapters(root);
  const committed = chapters.chapters.find((c) => c.id === chapterRef);
  let envelope: SegmentEnvelope;
  let generated: boolean;
  if (committed) {
    envelope = {
      id: committed.id,
      frame: committed.frame,
      timelineFrame: committed.timelineFrame,
      held: committed.held,
      map: committed.map,
      position: committed.position,
      snapshot: committed.snapshot,
    };
    generated = false;
  } else {
    const path = join(GENERATED_SEGMENT_DIR, `${chapterRef}.json`);
    if (!existsSync(path)) {
      throw new Error(
        `Unknown journey segment chapter: ${chapterRef} ` +
          `(not in data/chapters.json and no .psp-segments/${chapterRef}.json)`,
      );
    }
    envelope = JSON.parse(readFileSync(path, "utf8")) as SegmentEnvelope;
    generated = true;
  }
  let endFrame = endFrameOpt;
  if (endFrame === undefined) {
    const next = chapters.chapters.find((c) => c.frame > envelope.frame);
    // The PSP mainline is the full GB6+J1+J2+J3+J4 mainline; chapters beyond
    // it must not extend the suffix past the combined tape.
    endFrame = next ? Math.min(next.frame, combined.length) : combined.length;
  }
  if (endFrame <= envelope.frame) {
    throw new Error(`segment ${chapterRef}: end ${endFrame} <= start ${envelope.frame}`);
  }
  const suffix = sliceSuffix(combined, envelope.frame, endFrame);
  // The PSP runs the GameView dialog paginator, so the receipt and its
  // verifier replay the suffix with the same pagination; the continuous
  // mainline verifiers (no paginator) are a separate path.
  return { chapter: chapterRef, generated, startFrame: envelope.frame, endFrame, envelope, suffix, paginate: true };
}

/** Desktop replay of a segment suffix from its restored envelope. This is the
 *  same reducer path tools/bake-chapters.ts verifyChapterSuffixes() uses
 *  (proven to reach the J3 terminal pin), so its terminal state is what a PSP
 *  segment run must match byte-for-byte. */
export function replaySuffixState(root: string, spec: SegmentSpec): SessionState {
  const project = readInlineProject(root);
  const { worldTraversal } = loadMainlineTape(root);
  const session = createSession(
    project,
    60,
    spec.paginate === false
      ? createTuxemonSessionOptions(project, worldTraversal)
      : mainlineSessionOptions(project, worldTraversal),
  );
  const decoded = decodeEnvelopeText(spec.envelope.snapshot);
  let state = restoreSessionSnapshot(session, decoded);
  // The envelope carries the per-map interpreter clock, not the global
  // reducer frame; the chapter contract supplies it (the PSP boot overlay
  // does the same correction).
  state = { ...state, frame: spec.envelope.timelineFrame };
  let previous = decoded.held >>> 0;
  for (const mask of spec.suffix) {
    state = stepSession(session, state, mainlineInput(mask, previous));
    previous = mask;
  }
  return state;
}

/** Terminal pin for a segment: the canonical-JSON sha256 of the desktop
 *  suffix replay's terminal state, plus its map/position/frame. */
export function replaySuffixTerminal(root: string, spec: SegmentSpec): SegmentPin {
  const state = replaySuffixState(root, spec);
  return {
    terminalSha256: sha256(canonicalJson(state)),
    endMap: state.mapId,
    endPosition: [state.move.tx, state.move.ty],
    endFrame: state.frame,
  };
}

/** Verify a PSP segment run against its build receipt. The receipt carries
 *  the envelope and the desktop terminal pin; this re-derives the pin from
 *  the committed tape and the receipt's envelope, then compares it with both
 *  the receipt's pin (catching a stale receipt) and the PSP terminal snapshot
 *  (catching a diverged run). Pure: takes the parsed profile entries, so the
 *  tests can drive it without PPSSPP. */
export function verifySegmentProfile(
  root: string,
  seg: SegmentReceipt,
  journeyBuildId: string,
  entries: ProfileEntry[],
): { terminalSha256: string; endMap: string; endPosition: [number, number]; frames: number } {
  // Receipt invariants first: the fields the terminal comparison depends on
  // must be internally consistent, or a tampered receipt sails through.
  if (seg.startFrame < 0 || seg.endFrame <= seg.startFrame
      || seg.envelope.frame < 0 || seg.envelope.timelineFrame < 0) {
    throw new Error("Receipt segment bounds are invalid");
  }
  if (seg.frames !== seg.endFrame - seg.startFrame) {
    throw new Error("Receipt frames do not match endFrame - startFrame");
  }
  if (seg.envelope.frame !== seg.startFrame) {
    throw new Error("Receipt envelope frame does not match startFrame");
  }
  if (seg.terminalFrame !== seg.envelope.timelineFrame + seg.frames) {
    throw new Error("Receipt terminal frame does not match envelope timelineFrame + frames");
  }
  const sessionIndex = entries.findLastIndex((e) => e.kind === "session");
  if (sessionIndex < 0) throw new Error("No PSP journey session marker found");
  const session = entries[sessionIndex]!;
  if (session.buildId !== journeyBuildId) {
    throw new Error("Newest PSP profile session does not match the current journey build");
  }
  if (session.segment !== seg.chapter) {
    throw new Error(`PSP profile segment ${String(session.segment)} != receipt ${seg.chapter}`);
  }
  const latest = entries.slice(sessionIndex);
  const abi = latest.find((e) => e.kind === "abi");
  if (abi?.passed !== true || abi.buildId !== journeyBuildId) {
    throw new Error("Newest PSP journey did not pass the double ABI check");
  }
  const terminal = latest.findLast((e) => e.kind === "terminal");
  if (!terminal || terminal.buildId !== journeyBuildId) {
    throw new Error("Newest PSP journey session did not reach a terminal snapshot");
  }
  if (terminal.frame !== seg.frames) {
    throw new Error(`PSP segment length mismatch: ${String(terminal.frame)} != ${seg.frames}`);
  }
  const { combined } = loadMainlineTape(root);
  const suffix = sliceSuffix(combined, seg.startFrame, seg.endFrame);
  if (sha256(JSON.stringify(suffix)) !== seg.tapeSha256) {
    throw new Error("Receipt tape hash does not match the committed mainline tape");
  }
  if (sha256(seg.envelope.snapshot) !== seg.snapshotSha256) {
    throw new Error("Receipt snapshot hash does not match its embedded envelope");
  }
  const spec: SegmentSpec = {
    chapter: seg.chapter,
    generated: seg.generated,
    startFrame: seg.startFrame,
    endFrame: seg.endFrame,
    envelope: seg.envelope,
    suffix,
    paginate: true,
  };
  const pin = replaySuffixTerminal(root, spec);
  if (pin.terminalSha256 !== seg.terminalSha256) {
    throw new Error("Receipt terminal pin does not match a fresh desktop suffix replay");
  }
  // The receipt's own end map/position must match the fresh replay, not
  // just the PSP terminal — otherwise a tampered receipt with a matching
  // PSP run would still pass. (terminalFrame is checked above against
  // envelope.timelineFrame + frames, which is exactly where the replay
  // ends.)
  if (pin.endMap !== seg.endMap) {
    throw new Error("Receipt end map does not match a fresh desktop suffix replay");
  }
  if (pin.endPosition[0] !== seg.endPosition[0] || pin.endPosition[1] !== seg.endPosition[1]) {
    throw new Error("Receipt end position does not match a fresh desktop suffix replay");
  }
  const actual = sha256(canonicalJson(terminal.state));
  if (actual !== pin.terminalSha256) {
    throw new Error("PSP terminal snapshot diverged from the desktop suffix replay");
  }
  const state = terminal.state as { mapId?: string; move?: { tx?: number; ty?: number } };
  if (state.mapId !== pin.endMap
      || state.move?.tx !== pin.endPosition[0]
      || state.move?.ty !== pin.endPosition[1]) {
    throw new Error("PSP terminal map/position diverged from the desktop suffix replay");
  }
  return {
    terminalSha256: actual,
    endMap: pin.endMap,
    endPosition: pin.endPosition,
    frames: seg.frames,
  };
}

/** Bake the segment journey wrapper around the game bundle: the prefix sets
 *  the boot snapshot/frame/civil-time globals, the wrapper feeds neutral
 *  buttons until the boot overlay restores the chapter, then replays the
 *  suffix and logs map/battle events plus the terminal state. The wrapper
 *  calls __pspExit one frame after the terminal so the host's bench window
 *  (which flushes at the terminal frame) lands before the process exits.
 *  Factored out of tools/psp.ts so the wrapper generation is testable
 *  without the PSP SDK. `civilTime` is the fixed initial civil time
 *  (battle/time-weather). */
export function bakeSegmentBundle(
  original: string,
  spec: SegmentSpec,
  civilTime: { year: number; month: number; day: number; hour: number; minute: number },
): { bundle: string; journeyBuildId: string } {
  const suffix = spec.suffix;
  const journeyBuildId = createHash("sha256")
    .update(original)
    .update(spec.envelope.snapshot)
    .update(JSON.stringify(suffix))
    .update(JSON.stringify(civilTime))
    .digest("hex");
  const prefix =
    `globalThis.__pocketTuxemonInitialCivilTime=${JSON.stringify(civilTime)};\n` +
    `globalThis.__pocketTuxemonBootSnapshot=${JSON.stringify(spec.envelope.snapshot)};\n` +
    `globalThis.__pocketTuxemonBootFrame=${spec.envelope.timelineFrame};\n`;
  const wrapper =
    `\n;(function(){var id=${JSON.stringify(journeyBuildId)};` +
    `__pspLog(JSON.stringify({kind:"session",buildId:id,segment:${JSON.stringify(spec.chapter)}}));` +
    `[0,-0,1.25,-4.5,1e30,Number.MIN_VALUE,NaN,Infinity,-Infinity].forEach(function(v){` +
    `if(!Object.is(__pspRoundTrip(v),v))throw new Error("PSP double ABI round trip failed");});` +
    `__pspLog(JSON.stringify({kind:"abi",passed:true,buildId:id}));` +
    `var f=globalThis.frame,n=0,tape=${JSON.stringify(suffix)},started=false,lastMap=null,lastBattle=false;` +
    `globalThis.frame=function(buttons,analog){` +
    `if(!started){f(0,analog);if(globalThis.__pocketTuxemonBootReady)started=true;return;}` +
    `f(n<tape.length?tape[n]:buttons,analog);n++;` +
    `var s=globalThis.__rpgSessionState;` +
    `var inBattle=s.scene&&s.scene.kind==='battle';` +
    `if(s.mapId!==lastMap){__pspLog(JSON.stringify({kind:"event",frame:n,type:"map",map:s.mapId,buildId:id}));lastMap=s.mapId;}` +
    `if(!!inBattle!==lastBattle){__pspLog(JSON.stringify({kind:"event",frame:n,type:inBattle?"battle-enter":"battle-exit",map:s.mapId,buildId:id}));lastBattle=!!inBattle;}` +
    `if(n%300===0)__pspLog(JSON.stringify({frame:n,map:s.mapId,pos:[s.move.tx,s.move.ty],` +
    `scene:s.scene?.kind,modal:s.interp.modal,error:s.interp.error,buildId:id}));` +
    `if(n===tape.length)__pspLog(JSON.stringify({kind:"terminal",frame:n,state:s,buildId:id}));` +
    `if(n===tape.length+1&&typeof __pspExit==="function")__pspExit();};})();\n`;
  return { bundle: prefix + original + wrapper, journeyBuildId };
}

/** A chapter may only start at a safe point: the engine's save predicate,
 *  plus no held input lock and no transfer fade (same predicate
 *  tools/bake-chapters.ts uses for committed chapters). */
function isSafe(state: SessionState): boolean {
  return canSave(state.move, state.interp, state.scene)
    && !state.interp.inputLocked
    && !state.fade;
}

export interface GenerateOptions {
  id?: string;
  /** How far past the target frame to scan for a safe point. */
  maxScan?: number;
  /** Write the envelope to .psp-segments/<id>.json when true. */
  write?: boolean;
}

/** Generate a chapter envelope at the first safe point at or after
 *  `targetFrame`, by replaying the mainline tape on the desktop reducer.
 *  Deterministic: the same tape and reducer always produce the same
 *  envelope. Used to split long chapter windows for bounded emulator runs. */
export function generateEnvelope(
  root: string,
  targetFrame: number,
  options: GenerateOptions = {},
): SegmentEnvelope {
  const project = readInlineProject(root);
  const { combined, worldTraversal } = loadMainlineTape(root);
  if (targetFrame < 0 || targetFrame > combined.length) {
    throw new Error(`generateEnvelope: target ${targetFrame} outside [0, ${combined.length}]`);
  }
  const session = createSession(
    project,
    60,
    mainlineSessionOptions(project, worldTraversal),
  );
  let state = startSession(project, session);
  let previous = 0;
  for (let f = 1; f <= targetFrame; f++) {
    const mask = combined[f - 1]!;
    state = stepSession(session, state, mainlineInput(mask, previous));
    previous = mask;
  }
  let safeFrame = targetFrame;
  if (!isSafe(state)) {
    const maxScan = options.maxScan ?? 3600;
    const limit = Math.min(targetFrame + maxScan, combined.length);
    let found = -1;
    for (let f = targetFrame + 1; f <= limit; f++) {
      const mask = combined[f - 1]!;
      state = stepSession(session, state, mainlineInput(mask, previous));
      previous = mask;
      if (isSafe(state)) {
        found = f;
        break;
      }
    }
    if (found < 0) {
      throw new Error(`generateEnvelope: no safe point in [${targetFrame}, ${limit}]`);
    }
    safeFrame = found;
  }
  const held = safeFrame === 0 ? 0 : combined[safeFrame - 1]!;
  const snapshot = createSessionSnapshot(session, state, held);
  const envelope = encodeEnvelope(snapshot);
  // Round-trip validation (same gate bake-chapters uses): the envelope must
  // restore to the exact saved bytes.
  const decoded = decodeEnvelopeText(envelope);
  const restored = restoreSessionSnapshot(session, decoded);
  const again = createSessionSnapshot(session, restored, decoded.held);
  if (canonicalJson(again) !== canonicalJson(snapshot)) {
    throw new Error(`generateEnvelope: save/restore round-trip changed the snapshot at ${safeFrame}`);
  }
  const record: SegmentEnvelope = {
    id: options.id ?? `f${safeFrame}`,
    frame: safeFrame,
    timelineFrame: state.frame,
    held: held >>> 0,
    map: state.mapId,
    position: [state.move.tx, state.move.ty],
    snapshot: envelope,
  };
  if (options.write !== false) {
    mkdirSync(GENERATED_SEGMENT_DIR, { recursive: true });
    writeFileSync(
      join(GENERATED_SEGMENT_DIR, `${record.id}.json`),
      JSON.stringify(record, null, 2) + "\n",
    );
  }
  return record;
}

/** Generate several envelopes in one reducer replay: each target becomes the
 *  first safe point at or after it (same scan as generateEnvelope). Far
 *  cheaper than one replay per target when splitting long windows. */
export function generateEnvelopes(
  root: string,
  targets: { id: string; frame: number }[],
  options: { maxScan?: number; write?: boolean } = {},
): SegmentEnvelope[] {
  const project = readInlineProject(root);
  const { combined, worldTraversal } = loadMainlineTape(root);
  const session = createSession(
    project,
    60,
    mainlineSessionOptions(project, worldTraversal),
  );
  const maxScan = options.maxScan ?? 3600;
  const sorted = [...targets].sort((a, b) => a.frame - b.frame);
  const results: SegmentEnvelope[] = [];
  let state = startSession(project, session);
  let previous = 0;
  let cursor = 0;
  for (const target of sorted) {
    if (target.frame < 0 || target.frame > combined.length) {
      throw new Error(`generateEnvelopes: target ${target.id} frame ${target.frame} out of range`);
    }
    // Advance to the target frame.
    while (cursor < target.frame) {
      const mask = combined[cursor]!;
      state = stepSession(session, state, mainlineInput(mask, previous));
      previous = mask;
      cursor++;
    }
    // Scan for a safe point.
    let safeFrame = cursor;
    if (!isSafe(state)) {
      const limit = Math.min(target.frame + maxScan, combined.length);
      let found = -1;
      while (cursor < limit) {
        const mask = combined[cursor]!;
        state = stepSession(session, state, mainlineInput(mask, previous));
        previous = mask;
        cursor++;
        if (isSafe(state)) {
          found = cursor;
          break;
        }
      }
      if (found < 0) {
        throw new Error(`generateEnvelopes: ${target.id}: no safe point in [${target.frame}, ${limit}]`);
      }
      safeFrame = found;
    }
    const held = safeFrame === 0 ? 0 : combined[safeFrame - 1]!;
    const snapshot = createSessionSnapshot(session, state, held);
    const envelope = encodeEnvelope(snapshot);
    const decoded = decodeEnvelopeText(envelope);
    const restored = restoreSessionSnapshot(session, decoded);
    const again = createSessionSnapshot(session, restored, decoded.held);
    if (canonicalJson(again) !== canonicalJson(snapshot)) {
      throw new Error(`generateEnvelopes: ${target.id}: round-trip changed the snapshot`);
    }
    const record: SegmentEnvelope = {
      id: target.id,
      frame: safeFrame,
      timelineFrame: state.frame,
      held: held >>> 0,
      map: state.mapId,
      position: [state.move.tx, state.move.ty],
      snapshot: envelope,
    };
    if (options.write !== false) {
      mkdirSync(GENERATED_SEGMENT_DIR, { recursive: true });
      writeFileSync(
        join(GENERATED_SEGMENT_DIR, `${record.id}.json`),
        JSON.stringify(record, null, 2) + "\n",
      );
    }
    results.push(record);
  }
  return results;
}

/** CLI: bun tools/psp-segment.ts --frame=<n> [--id=<id>] [--no-write] */
if (import.meta.main) {
  const args = new Set(process.argv.slice(2));
  const frameArg = [...args].find((a) => a.startsWith("--frame="));
  if (!frameArg) {
    console.error("usage: bun tools/psp-segment.ts --frame=<globalFrame> [--id=<id>] [--no-write]");
    process.exit(1);
  }
  const targetFrame = Number(frameArg.slice("--frame=".length));
  const idArg = [...args].find((a) => a.startsWith("--id="))?.slice("--id=".length);
  const envelope = generateEnvelope(ROOT, targetFrame, {
    id: idArg,
    write: !args.has("--no-write"),
  });
  console.log(
    `SEGMENT ENVELOPE ${envelope.id} frame=${envelope.frame} map=${envelope.map} ` +
      `@${envelope.position.join(",")} held=${envelope.held} ` +
      `snapshotSha256=${sha256(envelope.snapshot).slice(0, 12)}`,
  );
  if (args.has("--no-write")) {
    console.log(JSON.stringify(envelope));
  } else {
    console.log(`written .psp-segments/${envelope.id}.json`);
  }
}
