// Manual gate: run the English PSP opening journey under PPSSPPHeadless and
// verify the terminal state matches the desktop replay, then print the PSP
// side timing and memory metrics. Not in CI — it needs a local PPSSPPHeadless
// build and the PSP SDK (see docs/verification.md).
//
// Why the .prx and not EBOOT.PBP: the journey EBOOT.PBP does not complete
// under PPSSPP (cause not diagnosed — the SFO lacks MEMSIZE, yet PPSSPP
// grants ~46 MiB arena in at least one PBP build, so the earlier ~15 MiB
// OOM root cause was withdrawn). A bare ELF/PRX takes the "full PSP-2000
// memory access" path (arena ~46 MiB), which is also what a MEMSIZE=1
// PARAM.SFO would give on real PSP-2000+ hardware. Run the .prx for
// emulator verification.
//
// Usage:
//   bun run build:psp --journey        # build the journey package first
//   bun run verify:psp:emu             # run + verify + metrics
// Env:
//   PPSSPP_HEADLESS   path to PPSSPPHeadless (default ~/ppsspp-src/build/PPSSPPHeadless)
//   PSP_EMU_TIMEOUT   wall-seconds for the emulator run (default 240)
//   PSP_EMU_MEMSTICK  isolated memstick dir (default a temp dir under the repo)

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

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
  throw new Error(`dist/psp/pocket-tuxemon.prx missing — run: bun run build:psp --journey`);
}
const receipt = JSON.parse(readFileSync(receiptPath, "utf8")) as {
  journey?: unknown;
  journeyBuildId?: unknown;
};
if (receipt.journey !== true || typeof receipt.journeyBuildId !== "string") {
  throw new Error("dist/psp is not a journey build — run: bun run build:psp --journey");
}

const timeout = Number(process.env.PSP_EMU_TIMEOUT ?? "240");
const memstick = process.env.PSP_EMU_MEMSTICK || join(root, ".psp-emu-memstick");
mkdirSync(memstick, { recursive: true });
// Fresh outputs so a stale profile/bench from an older build cannot pass.
rmSync(profilePath, { force: true });
rmSync(benchPath, { force: true });

console.log(`# PPSSPPHeadless: ${headless}`);
console.log(`# PRX: ${prxPath}`);
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
// PPSSPP prints TIMEOUT when its --timeout fires; the journey wrapper calls
// __pspExit at the tape end, so a completed run exits on its own and TIMEOUT
// is tolerated as a fallback when it does not.
if (!existsSync(profilePath)) {
  console.error(stdout);
  console.error(stderr);
  throw new Error("No profile.jsonl — the journey did not boot or did not log. " +
    "Check the PPSSPP output above (a halt message shows on the PSP debug screen).");
}

// Terminal-state verification (reuses the device-profile verifier).
const verify = spawnSync(
  process.execPath,
  [join(root, "tools/verify-psp-journey.ts"), profilePath],
  { stdio: "inherit" },
);
if (verify.status !== 0) process.exit(1);

// Metrics from the PSP side bench JSONL (one 3-line record per 300-frame window).
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
}
const benchLines = readFileSync(benchPath, "utf8").trim().split("\n").filter(Boolean);
const mainWindows = benchLines
  .filter((l) => l.includes('"app"'))
  .map((l) => JSON.parse(l) as BenchMain);
if (mainWindows.length === 0) {
  throw new Error("No bench windows in PocketJS-bench.jsonl");
}
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
// QuickJS peak heap per 300-frame window (slowest_columns records); the
// global peak is the high-water across the whole run.
const qjsPeak = Math.max(
  0,
  ...benchLines
    .filter((l) => l.includes('"slowest_columns"'))
    .map((l) => (JSON.parse(l).qjs_peak_bytes as number | undefined) ?? 0),
);

const mib = (n: number) => (n / 1024 / 1024).toFixed(1);
console.log("");
console.log("# PSP-side metrics (PPSSPP software renderer, 333 MHz)");
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
if (qjsPeak > 0) {
  console.log(`QuickJS peak heap:     ${mib(qjsPeak)} MiB`);
}
console.log("slowest frames (frame, work_ms): " +
  globalSlowest.map((s) => `${s[0]}@${(s[1] / 1000).toFixed(0)}ms`).join(", "));
console.log("");
console.log("PASS: PSP opening journey terminal matches desktop replay.");
