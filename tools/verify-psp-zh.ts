// Manual gate: run the Chinese PSP opening smoke tape under PPSSPPHeadless
// and verify the terminal state matches a desktop zh_CN replay, then print
// the PSP-side timing, memory and GC metrics. The English equivalent is
// tools/verify-psp-emu.ts + tools/verify-psp-journey.ts; this one replays
// data/zh-smoke-journey.json through the zh_CN session.
//
//   bun run build:psp:zh -- --journey   # build the Chinese journey package
//   bun tools/verify-psp-zh.ts          # run + verify + metrics
// Env:
//   PPSSPP_HEADLESS   path to PPSSPPHeadless (default ~/ppsspp-src/build/PPSSPPHeadless)
//   PSP_EMU_TIMEOUT   wall-seconds for the emulator run (default 240)
//   PSP_EMU_MEMSTICK  isolated memstick dir (default a temp dir under the repo)

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, copyFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { createSession, startSession, stepSession } from "../vendor/pocket-rpgkit/src/engine/session.ts";
import { canonicalJson } from "../vendor/pocket-rpgkit/src/engine/save.ts";
import type { JsonValue } from "../vendor/pocket-rpgkit/src/engine/types.ts";
import { createTuxemonSessionOptions } from "../battle/game.ts";
import { createProductionTuxemonBattle } from "../battle/production.ts";
import { zhData } from "../ui/zh-data.ts";
import { readShardedProject } from "./generated-project.ts";
import { FIXED_INITIAL_CIVIL_TIME, timeWeatherAt } from "../battle/time-weather.ts";
import { checkBuildArtifact, type ProfileEntry } from "./psp-segment.ts";

const root = resolve(import.meta.dir, "..");
const pspOut = join(root, "dist/psp");
const prxPath = join(pspOut, "pocket-tuxemon.prx");
const receiptPath = join(pspOut, "build-receipt.json");
const profilePath = join(pspOut, "profile.jsonl");
const benchPath = join(pspOut, "PocketJS-bench.jsonl");

const headless = process.env.PPSSPP_HEADLESS ||
  join(homedir(), "ppsspp-src/build/PPSSPPHeadless");
if (!existsSync(headless)) {
  throw new Error(
    `PPSSPPHeadless not found at ${headless}. Set PPSSPP_HEADLESS or build it ` +
      `(HEADLESS_CROSS=1).`,
  );
}
if (!existsSync(prxPath)) {
  throw new Error("dist/psp/pocket-tuxemon.prx missing — run: bun run build:psp:zh -- --journey");
}
const receipt = JSON.parse(readFileSync(receiptPath, "utf8")) as {
  zh?: unknown;
  journey?: unknown;
  journeyBuildId?: unknown;
  artifacts?: Record<string, { sha256?: unknown }>;
};
if (receipt.zh !== true || receipt.journey !== true || typeof receipt.journeyBuildId !== "string") {
  throw new Error("dist/psp is not a Chinese journey build — run: bun run build:psp:zh -- --journey");
}
checkBuildArtifact(receipt.artifacts, "pocket-tuxemon.prx",
  createHash("sha256").update(readFileSync(prxPath)).digest("hex"));

const timeout = Number(process.env.PSP_EMU_TIMEOUT ?? "240");
const memstick = process.env.PSP_EMU_MEMSTICK || join(root, ".psp-emu-memstick-zh");
mkdirSync(memstick, { recursive: true });
// The PSP offload provider reads the font archive from
// ms0:/PSP/COMMON/pocketjs/font-archive.bin; on PPSSPP ms0: is the memstick.
const archiveDir = join(memstick, "PSP", "COMMON", "pocketjs");
mkdirSync(archiveDir, { recursive: true });
const archiveSrc = join(pspOut, "font-archive.bin");
if (!existsSync(archiveSrc)) {
  throw new Error("dist/psp/font-archive.bin missing — run: bun run build:psp:zh -- --journey");
}
// Bind the archive to the build the same way the PRX is bound: the receipt
// records its sha256, so a stale or swapped archive fails the gate.
checkBuildArtifact(receipt.artifacts, "font-archive.bin",
  createHash("sha256").update(readFileSync(archiveSrc)).digest("hex"));
copyFileSync(archiveSrc, join(archiveDir, "font-archive.bin"));
rmSync(profilePath, { force: true });
rmSync(benchPath, { force: true });

console.log(`# PPSSPPHeadless: ${headless}`);
console.log(`# PRX: ${prxPath} (Chinese journey)`);
console.log(`# memstick: ${memstick}`);
console.log(`# timeout: ${timeout}s`);
const run = spawnSync(
  headless,
  [
    "--graphics=software",
    `--timeout=${timeout}`,
    `--memstick=${memstick}`,
    prxPath,
  ],
  { stdio: ["ignore", "pipe", "pipe"], timeout: (timeout + 30) * 1000 },
);
const stdout = run.stdout?.toString() ?? "";
const stderr = run.stderr?.toString() ?? "";
if (run.status !== 0 && !stdout.includes("TIMEOUT")) {
  console.error(stdout);
  console.error(stderr);
  throw new Error(`PPSSPPHeadless exited with status ${run.status}`);
}
if (!existsSync(profilePath)) {
  console.error(stdout);
  console.error(stderr);
  throw new Error("No profile.jsonl — the journey did not boot or did not log.");
}

// --- terminal-state verification: replay the zh smoke tape on desktop ------
const entries = readFileSync(profilePath, "utf8").trim().split("\n").map((line, index) => {
  try {
    return JSON.parse(line) as ProfileEntry;
  } catch {
    throw new Error(`Malformed PSP profile JSON on line ${index + 1}`);
  }
});
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

const tapeDocument = JSON.parse(readFileSync(join(root, "data/zh-smoke-journey.json"), "utf8")) as {
  masks: number[];
  terminalStateSha256?: string;
};
const tape = tapeDocument.masks;
if (terminal.frame !== tape.length) {
  throw new Error(`PSP journey length mismatch: ${terminal.frame} vs tape ${tape.length}`);
}
const sharded = readShardedProject(root, "zh_CN");
const project = sharded.project;
// createProductionTuxemonBattle with zh_CN reads the zh_CN battle shell from
// the loaded zh data store (battle/production.ts battleRuntimeShell); load the
// five startup documents from dist/data first, the same way main.tsx does.
zhData.load((entry) => {
  const file = entry.endsWith("project-shell.json") ? "dist/project-shell.zh_CN.json"
    : entry.endsWith("battle-runtime-shell.json") ? "dist/battle-runtime-shell.zh_CN.json"
    : entry.endsWith("battle-names.json") ? "data/battle-names.zh_CN.json"
    : entry.endsWith("map-descriptions.json") ? "dist/map-descriptions.zh_CN.json"
    : entry.endsWith("month-names.json") ? "data/month-names.zh_CN.json"
    : entry;
  return readFileSync(join(root, file));
});
const { extensions, rules, scenes } = createProductionTuxemonBattle(
  { read: (entry) => new Uint8Array(readFileSync(join(root, "dist", entry))) },
  { initialTimeWeather: timeWeatherAt(FIXED_INITIAL_CIVIL_TIME) },
  "zh_CN",
);
const sessionRuntime = createSession(project, 60, createTuxemonSessionOptions(project, "seamless-v1", {
  maps: sharded.repository,
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
const expectedSha = createHash("sha256").update(expected).digest("hex");
if (actual !== expected) {
  throw new Error("PSP zh terminal snapshot diverged from the desktop zh replay");
}
if (tapeDocument.terminalStateSha256 && tapeDocument.terminalStateSha256 !== expectedSha) {
  throw new Error(
    `zh smoke terminal hash drift: replay ${expectedSha} vs recorded ${tapeDocument.terminalStateSha256}`,
  );
}
console.log(
  `PSP ZH JOURNEY PASS frames=${tape.length} end=${state.mapId}@${state.move.tx},${state.move.ty} ` +
    `sha256=${expectedSha}`,
);

// --- metrics ---------------------------------------------------------------
interface BenchMain {
  window_start: number;
  frames: number;
  eval_us: number;
  boot_to_frame0_us: number;
  avg_frame_interval_us: number;
  max_frame_interval_us: number;
  avg_work_us: number;
  max_work_us: number;
  arena_capacity_bytes: number;
  arena_bump_bytes: number;
  qjs_peak_bytes?: number;
  gc_count?: number;
  gc_us?: number;
  max_gc_us?: number;
  qjs_live_bytes?: number;
}
const benchLines = readFileSync(benchPath, "utf8").trim().split("\n").filter(Boolean);
const mainWindows = benchLines
  .filter((l) => l.includes('"app"'))
  .map((l) => JSON.parse(l) as BenchMain);
if (mainWindows.length === 0) throw new Error("No bench windows in PocketJS-bench.jsonl");
const first = mainWindows[0]!;
const last = mainWindows[mainWindows.length - 1]!;
const totalFrames = mainWindows.reduce((sum, w) => sum + w.frames, 0);
const avgInterval = mainWindows.reduce((s, w) => s + w.avg_frame_interval_us, 0) /
  mainWindows.length;
const maxWork = Math.max(...mainWindows.map((w) => w.max_work_us));
const maxInterval = Math.max(...mainWindows.map((w) => w.max_frame_interval_us));
const arenaBump = Math.max(...mainWindows.map((w) => w.arena_bump_bytes));
const slowest = benchLines
  .filter((l) => l.includes('"slowest_columns"'))
  .flatMap((l) => (JSON.parse(l).slowest as [number, number, number, number, number, number, number][]));
const globalSlowest = slowest.sort((a, b) => b[1] - a[1]).slice(0, 8);
const qjsPeak = Math.max(
  0,
  ...benchLines
    .filter((l) => l.includes('"slowest_columns"'))
    .map((l) => (JSON.parse(l).qjs_peak_bytes as number | undefined) ?? 0),
);
const gcTotal = mainWindows.reduce((s, w) => s + (w.gc_count ?? 0), 0);
const gcUsTotal = mainWindows.reduce((s, w) => s + (w.gc_us ?? 0), 0);
const maxGcUs = Math.max(0, ...mainWindows.map((w) => w.max_gc_us ?? 0));
const qjsLiveEnd = last.qjs_live_bytes ?? 0;

const mib = (n: number) => (n / 1024 / 1024).toFixed(1);
console.log("");
console.log("# PSP-side metrics (PPSSPP software renderer, 333 MHz, Chinese journey)");
console.log(`eval:                  ${(first.eval_us / 1e6).toFixed(2)} s`);
console.log(`boot to frame 0:       ${(first.boot_to_frame0_us / 1e6).toFixed(2)} s`);
console.log(`frames logged:         ${totalFrames} (${mainWindows.length} windows × 300)`);
console.log(`avg frame interval:    ${(avgInterval / 1000).toFixed(1)} ms ` +
  `(${(1e6 / avgInterval).toFixed(1)} fps emulated)`);
console.log(`max frame interval:    ${(maxInterval / 1000).toFixed(1)} ms`);
console.log(`max work (single frame): ${(maxWork / 1000).toFixed(1)} ms`);
console.log(`arena capacity:        ${mib(first.arena_capacity_bytes)} MiB`);
console.log(`arena bump high-water: ${mib(arenaBump)} MiB ` +
  `(${(100 * arenaBump / first.arena_capacity_bytes).toFixed(1)}% of capacity)`);
console.log(`arena headroom:        ${mib(first.arena_capacity_bytes - arenaBump)} MiB`);
if (qjsPeak > 0) console.log(`QuickJS peak heap:     ${mib(qjsPeak)} MiB`);
if (qjsLiveEnd > 0) console.log(`QuickJS live at end:  ${mib(qjsLiveEnd)} MiB`);
console.log(`GC:                    ${gcTotal} collections, ${(gcUsTotal / 1000).toFixed(1)} ms total, ` +
  `longest pause ${(maxGcUs / 1000).toFixed(1)} ms`);
console.log("slowest frames (frame, work_ms): " +
  globalSlowest.map((s) => `${s[0]}@${(s[1] / 1000).toFixed(0)}ms`).join(", "));
console.log("");
console.log("PASS: PSP zh opening journey terminal matches desktop zh replay.");
