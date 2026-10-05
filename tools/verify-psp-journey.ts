// Compare the newest completed PSP journey session with a fresh production
// replay. The build receipt and session marker prevent an appended stale log
// from satisfying a newer build or an incomplete latest run.
//
// Opening builds (--journey) replay the full opening tape. Segment builds
// (--journey-segment) carry their envelope, frame range and desktop terminal
// pin in the receipt's journeySegment block; the verifier re-derives the pin
// from the committed tape and the receipt's envelope, then compares it with
// both the receipt's pin and the PSP terminal snapshot.

import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { createProductionTuxemonBattle } from "../battle/production.ts";
import { createTuxemonSessionOptions } from "../battle/game.ts";
import { FIXED_INITIAL_CIVIL_TIME, timeWeatherAt } from "../battle/time-weather.ts";
import { canonicalJson } from "../vendor/pocket-rpgkit/src/engine/save.ts";
import {
  createSession,
  startSession,
  stepSession,
} from "../vendor/pocket-rpgkit/src/engine/session.ts";
import type { JsonValue } from "../vendor/pocket-rpgkit/src/engine/types.ts";
import { readShardedProject } from "./generated-project.ts";
import { journeyWorldTraversal } from "./gb6-journey.ts";
import { checkBuildArtifact, verifySegmentProfile, type ProfileEntry } from "./psp-segment.ts";

interface BuildReceipt {
  target?: unknown;
  journey?: unknown;
  journeyBuildId?: unknown;
  journeySegment?: unknown;
  artifacts?: Record<string, { sha256?: unknown }>;
}

const root = resolve(import.meta.dir, "..");
const profilePath = process.argv[2];
if (!profilePath) {
  throw new Error("Usage: bun tools/verify-psp-journey.ts <PSPLINK profile.jsonl> [--prx=<path>]");
}
const prxArg = process.argv.find((a) => a.startsWith("--prx="));
const prxPath = prxArg ? resolve(prxArg.slice("--prx=".length)) : join(root, "dist/psp/pocket-tuxemon.prx");
const receiptPath = join(root, "dist/psp/build-receipt.json");
const receipt = JSON.parse(readFileSync(receiptPath, "utf8")) as BuildReceipt;
if (receipt.target !== "psp" || receipt.journey !== true ||
    typeof receipt.journeyBuildId !== "string") {
  throw new Error("dist/psp is not a journey-enabled PSP build");
}
// The PRX must hash to the receipt's artifact hash, or the profile cannot be
// tied to the verified build.
checkBuildArtifact(receipt.artifacts, "pocket-tuxemon.prx",
  createHash("sha256").update(readFileSync(prxPath)).digest("hex"));
if (statSync(profilePath).mtimeMs < statSync(prxPath).mtimeMs) {
  throw new Error("PSP profile predates the journey PRX; run the current build first");
}

const entries = readFileSync(profilePath, "utf8").trim().split("\n").map((line, index) => {
  try {
    return JSON.parse(line) as ProfileEntry;
  } catch {
    throw new Error(`Malformed PSP profile JSON on line ${index + 1}`);
  }
});

// Segment builds: verify against the receipt's envelope + desktop pin.
if (receipt.journeySegment !== undefined) {
  const result = verifySegmentProfile(
    root,
    receipt.journeySegment as Parameters<typeof verifySegmentProfile>[1],
    receipt.journeyBuildId,
    entries,
  );
  console.log(
    `PSP SEGMENT PASS segment=${(receipt.journeySegment as { chapter?: string }).chapter} ` +
      `frames=${result.frames} end=${result.endMap}@${result.endPosition[0]},${result.endPosition[1]} ` +
      `sha256=${result.terminalSha256}`,
  );
  process.exit(0);
}

// Opening build: replay the full opening tape and compare.
const sessionIndex = entries.findLastIndex((entry) => entry.kind === "session");
if (sessionIndex < 0) throw new Error("No PSP journey session marker found");
const session = entries[sessionIndex]!;
if (session.buildId !== receipt.journeyBuildId) {
  throw new Error("Newest PSP profile session does not match the current journey build");
}
const latest = entries.slice(sessionIndex);
const abi = latest.find((entry) => entry.kind === "abi");
if (abi?.passed !== true || abi.buildId !== receipt.journeyBuildId) {
  throw new Error("Newest PSP journey did not pass the double ABI check");
}
const terminal = latest.findLast((entry) => entry.kind === "terminal");
if (!terminal || terminal.buildId !== receipt.journeyBuildId) {
  throw new Error("Newest PSP journey session did not reach a terminal snapshot");
}

const tapeDocument = JSON.parse(readFileSync(join(root, "data/g6-journey.json"), "utf8")) as {
  masks: number[];
  worldTraversal?: unknown;
};
const tape = tapeDocument.masks;
const worldTraversal = journeyWorldTraversal(tapeDocument, "PSP journey tape");
if (terminal.frame !== tape.length) throw new Error("PSP journey length mismatch");
const { project, repository } = readShardedProject(root);
const { extensions, rules, scenes } = createProductionTuxemonBattle(
  { read: (entry) => new Uint8Array(readFileSync(join(root, "dist", entry))) },
  { initialTimeWeather: timeWeatherAt(FIXED_INITIAL_CIVIL_TIME) },
);
const sessionRuntime = createSession(project, 60, createTuxemonSessionOptions(project, worldTraversal, {
  maps: repository,
  extensions,
  battle: rules,
  scenes,
  immutableState: true,
}));
let state = startSession(project, sessionRuntime);
let previous = 0;
for (const mask of tape) {
  const pressed = mask & ~previous;
  state = stepSession(sessionRuntime, state, {
    buttons: mask,
    confirmEdge: !!(pressed & 0x2000),
    cancelEdge: !!(pressed & 0x4000),
    upEdge: !!(pressed & 0x10),
    downEdge: !!(pressed & 0x40),
    leftEdge: !!(pressed & 0x80),
    rightEdge: !!(pressed & 0x20),
  });
  previous = mask;
}
const expected = canonicalJson(state);
const actual = canonicalJson(terminal.state as JsonValue);
if (actual !== expected) {
  throw new Error("PSP terminal snapshot diverged from the production replay");
}
console.log(
  `PSP JOURNEY PASS frames=${tape.length} end=${state.mapId}@${state.move.tx},${state.move.ty} ` +
    `sha256=${createHash("sha256").update(actual).digest("hex")}`,
);
