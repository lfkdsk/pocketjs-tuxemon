// PSP save/load end-to-end verification under PPSSPPHeadless.
//
// Thin CLI: builds the real deps (build:psp + PPSSPPHeadless) and dispatches
// to the phase logic in tools/lib/psp-save-verify.ts, which is unit-tested
// with fake deps so every documented phase provably runs its assertions.
//
// Usage: bun tools/verify-psp-save.ts [--phase=save|load|autosave|failure|all]
// Env: PPSSPP_HEADLESS, PSP_EMU_TIMEOUT, PSP_SAVE_MEMSTICK.

import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import { startSession, stepSession, type SessionHostEffect } from "../vendor/pocket-rpgkit/src/engine/session.ts";
import { createGameSession, input } from "./save-resume.ts";
import { FIXED_INITIAL_CIVIL_TIME } from "../battle/time-weather.ts";
import {
  decodePspSaveRecord,
  PHASES,
  runPhase,
  type LogEntry,
  type PspSaveVerifyDeps,
  type Tape,
} from "./lib/psp-save-verify.ts";


const ROOT = resolve(import.meta.dir, "..");
const PSP_OUT = join(ROOT, "dist/psp");
const HEADLESS = process.env.PPSSPP_HEADLESS ?? join(homedir(), "ppsspp-src/build/PPSSPPHeadless");
const TIMEOUT = Number(process.env.PSP_EMU_TIMEOUT ?? "180");
const MEMSTICK = resolve(process.env.PSP_SAVE_MEMSTICK ?? join(ROOT, ".psp-emu-memstick", "save"));
const WORK = join(ROOT, ".psp-save-e2e");
const SAVE_DIR_REL = "PSP/COMMON/pocketjs/save";

// --- real deps ---------------------------------------------------------------

function buildJourney(tape: Tape): void {
  const tapeFile = join(WORK, `${tape.label}.tape.json`);
  writeFileSync(tapeFile, JSON.stringify({ masks: tape.masks, logAt: tape.logAt, label: tape.label }));
  console.log(`# build ${tape.label} (${tape.masks.length} frames, logAt=${tape.logAt})`);
  const r = spawnSync(process.execPath, ["run", "build:psp", "--skip-assets", `--journey-tape=${tapeFile}`], {
    cwd: ROOT,
    stdio: ["ignore", "inherit", "inherit"],
    env: { ...process.env, PATH: `${process.env.HOME}/.cargo/bin:${process.env.PATH ?? ""}` },
    timeout: (TIMEOUT + 120) * 1000,
  });
  if (r.status !== 0) throw new Error(`build:psp --journey-tape=${tape.label} failed`);
}

function runPsp(phase: string, memstick: string): LogEntry[] {
  const dir = join(WORK, phase);
  mkdirSync(dir, { recursive: true });
  const prx = join(dir, "pocket-tuxemon.prx");
  writeFileSync(prx, readFileSync(join(PSP_OUT, "pocket-tuxemon.prx")));
  // The external assets.pak must sit beside the PRX: pak_external.rs reads it
  // from the PRX's directory, and without it the game halts during boot.
  writeFileSync(join(dir, "assets.pak"), readFileSync(join(PSP_OUT, "assets.pak")));
  // host0: maps to the PRX's directory, so profile.jsonl lands in dir/.
  for (const f of ["profile.jsonl", "PocketJS-bench.jsonl"]) {
    try { rmSync(join(dir, f), { force: true }); } catch { /* absent */ }
  }
  mkdirSync(memstick, { recursive: true });
  console.log(`# run ${phase} (memstick=${memstick})`);
  const r = spawnSync(HEADLESS, [
    "--graphics=software",
    `--timeout=${TIMEOUT}`,
    `--memstick=${memstick}`,
    prx,
  ], {
    cwd: ROOT,
    stdio: ["ignore", "pipe", "pipe"],
    timeout: (TIMEOUT + 30) * 1000,
  });
  const stdout = r.stdout?.toString() ?? "";
  const stderr = r.stderr?.toString() ?? "";
  if (r.status !== 0 && !stdout.includes("TIMEOUT") && !stderr.includes("TIMEOUT")) {
    console.error(stdout);
    console.error(stderr);
    throw new Error(`PPSSPP exited with status ${r.status} for ${phase}`);
  }
  const profilePath = join(dir, "profile.jsonl");
  if (!existsSync(profilePath)) {
    console.error(stdout);
    console.error(stderr);
    throw new Error(`no profile.jsonl for ${phase} — the run did not boot or did not log`);
  }
  return readFileSync(profilePath, "utf8").trim().split("\n").filter(Boolean).map((line) => {
    try { return JSON.parse(line) as LogEntry; } catch { return {}; }
  });
}

/** The logAt that captures the state right after the opening's autosave
 *  point. The journey-tape logger feeds tape[logAt-1] and then logs, so the
 *  state after the frame that publishes the autosave is logAt = frame + 1.
 *  Replayed in bun (the reducer is pure, so the frame matches the PPSSPP run
 *  frame-for-frame) so the trigger tape logs the state at the autosave point. */
function findAutosaveLogAt(): number {
  const journey = JSON.parse(readFileSync(join(ROOT, "data/g6-journey.json"), "utf8")) as { masks: number[] };
  const { project, session } = createGameSession(FIXED_INITIAL_CIVIL_TIME);
  let state = startSession(project, session);
  let published = false;
  const sink = {
    publish(e: SessionHostEffect) {
      if (e.action === "autosave") published = true;
    },
  };
  let previous = 0;
  for (let f = 0; f < journey.masks.length; f++) {
    const mask = journey.masks[f]!;
    state = stepSession(session, state, input(mask, previous), sink);
    if (published) return f + 1;
    previous = mask;
  }
  throw new Error("the opening tape crossed no autosave point");
}

function savePath(rel: string): string {
  return join(MEMSTICK, SAVE_DIR_REL, rel.replace(/^save\//, ""));
}

const deps: PspSaveVerifyDeps = {
  build: buildJourney,
  run: runPsp,
  memstick: MEMSTICK,
  work: WORK,
  autosaveFrame: -1, // resolved in main after the preflight
  cleanMemstick() {
    rmSync(join(MEMSTICK, "PSP"), { recursive: true, force: true });
  },
  withReadOnlySaveDir(fn: () => void) {
    const dir = join(MEMSTICK, SAVE_DIR_REL);
    mkdirSync(dir, { recursive: true });
    chmodSync(dir, 0o555);
    try { fn(); } finally { chmodSync(dir, 0o755); }
  },
  readSaveFile(rel: string) {
    const live = savePath(rel);
    const backup = `${live}.bak`;
    let liveError: unknown;
    if (existsSync(live)) {
      try {
        return decodePspSaveRecord(readFileSync(live));
      } catch (error) {
        liveError = error;
      }
    }
    if (existsSync(backup)) return decodePspSaveRecord(readFileSync(backup));
    if (liveError) throw liveError;
    return null;
  },
  saveFileExists(rel: string) {
    const live = savePath(rel);
    return existsSync(live) || existsSync(`${live}.bak`);
  },
};

// --- main --------------------------------------------------------------------

const phase = process.argv.find((a) => a.startsWith("--phase="))?.slice("--phase=".length) ?? "all";
mkdirSync(WORK, { recursive: true });
if (!existsSync(HEADLESS)) throw new Error(`PPSSPPHeadless not found at ${HEADLESS}`);
if (!PHASES.includes(phase as (typeof PHASES)[number]) && phase !== "all") {
  throw new Error(`unknown phase ${JSON.stringify(phase)} (expected one of: ${PHASES.join(", ")}, all)`);
}
deps.autosaveFrame = findAutosaveLogAt();
console.log(`# opening autosave point logged at logAt ${deps.autosaveFrame}`);

runPhase(phase, deps);

console.log("\nALL PHASES PASS");
