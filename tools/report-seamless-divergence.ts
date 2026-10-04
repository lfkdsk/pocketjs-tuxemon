// Compare every committed legacy journey against the seamless-v1 runtime.
// The old masks remain immutable inputs: this report identifies the first
// timeline split and whether those inputs still reach their authored endpoint.

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { createTuxemonSessionOptions } from "../battle/game.ts";
import { canonicalJson } from "../vendor/pocket-rpgkit/src/engine/save.ts";
import {
  createSession,
  startSession,
  stepSession,
  type SessionInput,
  type SessionState,
} from "../vendor/pocket-rpgkit/src/engine/session.ts";
import type { WorldTraversalMode } from "../vendor/pocket-rpgkit/src/engine/types.ts";
import { readShardedProject } from "./generated-project.ts";
import { journeyWorldTraversal } from "./gb6-journey.ts";

const ROOT = resolve(import.meta.dir, "..");
const OUTPUT = resolve(process.env.W4G_DIVERGENCE_OUT ?? join(ROOT, "reports/W4G-divergence.json"));

interface TapeDocument {
  format: string;
  worldTraversal?: unknown;
  frames: number;
  masks: number[];
  map?: string;
  position?: [number, number];
  end?: { map: string; position: [number, number] };
}

interface TapeCase {
  name: string;
  files: string[];
  documents: TapeDocument[];
  masks: number[];
  endpoint: { map: string; position: [number, number] };
}

interface StateSummary {
  frame: number;
  map: string;
  position: [number, number];
  facing: number;
  moving: boolean;
  fade: SessionState["fade"];
  handoff: SessionState["handoff"] | null;
  scene: string | null;
  modal: string | null;
  error: string | null;
  sha256: string;
}

function readTape(file: string): TapeDocument {
  return JSON.parse(readFileSync(join(ROOT, file), "utf8")) as TapeDocument;
}

const g6 = readTape("data/g6-journey.json");
const firstLoss = readTape("data/gb6-first-loss-journey.json");
const gb6 = readTape("data/gb6-mainline-journey.json");
const laterLoss = readTape("data/gb6-later-loss-journey.json");
const j1 = readTape("data/j1-captainreturns-journey.json");
const j2 = readTape("data/j2-hospitalcure-journey.json");
const j3 = readTape("data/j3-omnichannelradioannounce-journey.json");
const j4 = readTape("data/j4-kernelquestdone-journey.json");

function endpoint(document: TapeDocument): { map: string; position: [number, number] } {
  const value = document.end ?? (document.map && document.position
    ? { map: document.map, position: document.position }
    : undefined);
  if (!value) throw new Error(`${document.format}: missing terminal endpoint`);
  return value;
}

function joinedMasks(documents: readonly TapeDocument[]): number[] {
  return documents.flatMap((document) => document.masks);
}

function tapeCase(name: string, files: string[], documents: TapeDocument[]): TapeCase {
  return {
    name,
    files,
    documents,
    masks: joinedMasks(documents),
    endpoint: endpoint(documents.at(-1)!),
  };
}

const cases = [
  tapeCase("G6", ["data/g6-journey.json"], [g6]),
  tapeCase("GB6 first loss", ["data/gb6-first-loss-journey.json"], [firstLoss]),
  tapeCase("GB6", ["data/gb6-mainline-journey.json"], [gb6]),
  tapeCase("GB6 later loss", ["data/gb6-later-loss-journey.json"], [laterLoss]),
  tapeCase("J1", ["data/gb6-mainline-journey.json", "data/j1-captainreturns-journey.json"], [gb6, j1]),
  tapeCase("J2", [
    "data/gb6-mainline-journey.json",
    "data/j1-captainreturns-journey.json",
    "data/j2-hospitalcure-journey.json",
  ], [gb6, j1, j2]),
  tapeCase("J3", [
    "data/gb6-mainline-journey.json",
    "data/j1-captainreturns-journey.json",
    "data/j2-hospitalcure-journey.json",
    "data/j3-omnichannelradioannounce-journey.json",
  ], [gb6, j1, j2, j3]),
  tapeCase("J4", [
    "data/gb6-mainline-journey.json",
    "data/j1-captainreturns-journey.json",
    "data/j2-hospitalcure-journey.json",
    "data/j3-omnichannelradioannounce-journey.json",
    "data/j4-kernelquestdone-journey.json",
  ], [gb6, j1, j2, j3, j4]),
] as const;

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

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function modalKind(state: SessionState): string | null {
  return state.interp.modal?.kind ?? null;
}

function summarize(state: SessionState): StateSummary {
  return {
    frame: state.frame,
    map: state.mapId,
    position: [state.move.tx, state.move.ty],
    facing: state.move.facing,
    moving: state.move.moving,
    fade: state.fade,
    handoff: state.handoff ? { ...state.handoff } : null,
    scene: state.scene?.kind ?? null,
    modal: modalKind(state),
    error: state.interp.error?.message ?? null,
    sha256: sha256(canonicalJson(state)),
  };
}

function firstDifference(left: unknown, right: unknown, path = "$state"): string | null {
  if (Object.is(left, right)) return null;
  if (left === null || right === null || typeof left !== "object" || typeof right !== "object") return path;
  if (Array.isArray(left) !== Array.isArray(right)) return path;
  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const keys = [...new Set([...Object.keys(leftRecord), ...Object.keys(rightRecord)])].sort();
  for (const key of keys) {
    if (!(key in leftRecord) || !(key in rightRecord)) return `${path}.${key}`;
    const child = firstDifference(leftRecord[key], rightRecord[key], `${path}.${key}`);
    if (child) return child;
  }
  return path;
}

function divergenceReason(legacy: SessionState, seamless: SessionState, path: string): string {
  if (!legacy.handoff && seamless.handoff && legacy.fade) {
    return "eligible transfer began an atomic handoff instead of the legacy fade";
  }
  if (legacy.mapId !== seamless.mapId) return "map commit timing differs";
  if (legacy.move.tx !== seamless.move.tx || legacy.move.ty !== seamless.move.ty) {
    return "player position differs";
  }
  if (legacy.fade !== seamless.fade) return "fade state differs";
  return `reducer state first differs at ${path}`;
}

function reaches(state: SessionState, expected: TapeCase["endpoint"]): boolean {
  return state.mapId === expected.map &&
    state.move.tx === expected.position[0] && state.move.ty === expected.position[1];
}

function validateLegacyIdentity(testCase: TapeCase): WorldTraversalMode[] {
  return testCase.documents.map((document, index) => {
    const identity = journeyWorldTraversal(document, `${testCase.name} source ${index + 1}`);
    if (identity !== "legacy-transfer") {
      throw new Error(`${testCase.name}: expected old masks to be legacy-transfer, got ${identity}`);
    }
    return identity;
  });
}

function run(testCase: TapeCase): object {
  const identities = validateLegacyIdentity(testCase);
  for (const [index, document] of testCase.documents.entries()) {
    if (document.frames !== document.masks.length) {
      throw new Error(`${testCase.name}: source ${index + 1} frame count differs from masks`);
    }
  }

  const legacyLoaded = readShardedProject(ROOT);
  const seamlessLoaded = readShardedProject(ROOT);
  const legacySession = createSession(
    legacyLoaded.project,
    60,
    createTuxemonSessionOptions(legacyLoaded.project, "legacy-transfer", { maps: legacyLoaded.repository }),
  );
  const seamlessSession = createSession(
    seamlessLoaded.project,
    60,
    createTuxemonSessionOptions(seamlessLoaded.project, "seamless-v1", { maps: seamlessLoaded.repository }),
  );
  let legacy = startSession(legacyLoaded.project, legacySession);
  let seamless = startSession(seamlessLoaded.project, seamlessSession);
  let previous = 0;
  let first: object | null = null;

  for (let sourceFrame = 0; sourceFrame < testCase.masks.length; sourceFrame++) {
    const mask = testCase.masks[sourceFrame]!;
    const frameInput = input(mask, previous);
    const before: StateSummary | null = first === null ? summarize(legacy) : null;
    legacy = stepSession(legacySession, legacy, frameInput);
    seamless = stepSession(seamlessSession, seamless, frameInput);
    previous = mask;

    if (first === null && canonicalJson(legacy) !== canonicalJson(seamless)) {
      const path = firstDifference(legacy, seamless) ?? "$state";
      first = {
        sourceFrame,
        tick: sourceFrame + 1,
        map: before!.map,
        position: before!.position,
        inputMask: mask >>> 0,
        reason: divergenceReason(legacy, seamless, path),
        firstDifferentPath: path,
        portalId: seamless.handoff?.portalId ?? null,
        before,
        legacy: summarize(legacy),
        seamless: summarize(seamless),
      };
    }
  }

  if (!first) throw new Error(`${testCase.name}: old masks did not diverge under seamless-v1`);
  const legacyTerminal = summarize(legacy);
  const seamlessTerminal = summarize(seamless);
  const row = {
    name: testCase.name,
    files: testCase.files,
    sourceIdentities: identities,
    sourceFrames: testCase.masks.length,
    expectedEndpoint: testCase.endpoint,
    firstDivergence: first,
    legacyTerminal,
    seamlessTerminal,
    legacyReachedExpectedEndpoint: reaches(legacy, testCase.endpoint),
    seamlessReachedExpectedEndpoint: reaches(seamless, testCase.endpoint),
    terminalStatesEqual: legacyTerminal.sha256 === seamlessTerminal.sha256,
  };
  console.log(
    `${testCase.name}: first f${(first as { sourceFrame: number }).sourceFrame} ` +
    `${(first as { map: string }).map} ` +
    `${(first as { reason: string }).reason}; seamlessEnd=${seamlessTerminal.map}@${seamlessTerminal.position.join(",")} ` +
    `expected=${row.seamlessReachedExpectedEndpoint}`,
  );
  return row;
}

const { project } = readShardedProject(ROOT);
if (project.worldTraversal !== "seamless-v1" || !project.worldLayout) {
  throw new Error("divergence report requires a seamless-v1 generated project with WorldLayout");
}
const rows = cases.map(run);
const report = {
  format: "pocket-tuxemon/seamless-divergence/v1",
  generatedAt: new Date().toISOString(),
  projectTraversal: project.worldTraversal,
  topologyHash: project.worldLayout.topologyHash,
  tapes: rows,
};
mkdirSync(resolve(OUTPUT, ".."), { recursive: true });
writeFileSync(OUTPUT, JSON.stringify(report, null, 2) + "\n");
console.log(`W4G DIVERGENCE PASS tapes=${rows.length} report=${OUTPUT}`);
