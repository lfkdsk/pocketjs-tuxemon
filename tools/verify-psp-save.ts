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

import {
  createSession,
  startSession,
  stepSession,
  type SessionHostEffect,
} from "../vendor/pocket-rpgkit/src/engine/session.ts";
import { createTuxemonSessionOptions } from "../battle/game.ts";
import { TUXEMON_SESSION_OPTIONS_ZH } from "../battle/game-zh.ts";
import { createGameSession, input } from "./save-resume.ts";
import { readShardedProject } from "./generated-project.ts";
import { FIXED_INITIAL_CIVIL_TIME } from "../battle/time-weather.ts";
import {
  decodePspSaveRecord,
  makeSourceOnlyPspPackage,
  PHASES,
  PSP_SAVE_EXECUTIONS,
  PSP_SAVE_LANGUAGES,
  pspPhysicalAppRoot,
  pspPhysicalSavePath,
  runPhase,
  type LogEntry,
  type PspSaveExecution,
  type PspSaveLanguage,
  type PspSaveVerifyDeps,
  type Tape,
} from "./lib/psp-save-verify.ts";

const argv = process.argv.slice(2);
for (const arg of argv) {
  if (!arg.startsWith("--phase=") && !arg.startsWith("--lang=") && !arg.startsWith("--execution=")) {
    throw new Error(`unknown PSP save verifier option ${JSON.stringify(arg)}`);
  }
}
const phase = argv.find((arg) => arg.startsWith("--phase="))?.slice("--phase=".length) ?? "all";
const languageArg = argv.find((arg) => arg.startsWith("--lang="))?.slice("--lang=".length) ?? "en";
const executionArg = argv.find((arg) => arg.startsWith("--execution="))?.slice("--execution=".length)
  ?? "bytecode";
if (!PSP_SAVE_LANGUAGES.includes(languageArg as PspSaveLanguage)) {
  throw new Error(`unknown PSP save language ${JSON.stringify(languageArg)} (expected: ${PSP_SAVE_LANGUAGES.join(", ")})`);
}
if (!PSP_SAVE_EXECUTIONS.includes(executionArg as PspSaveExecution)) {
  throw new Error(`unknown PSP execution path ${JSON.stringify(executionArg)} (expected: ${PSP_SAVE_EXECUTIONS.join(", ")})`);
}
const language = languageArg as PspSaveLanguage;
const execution = executionArg as PspSaveExecution;

const ROOT = resolve(import.meta.dir, "..");
const PSP_OUT = join(ROOT, "dist/psp");
const HEADLESS = process.env.PPSSPP_HEADLESS ?? join(homedir(), "ppsspp-src/build/PPSSPPHeadless");
const TIMEOUT = Number(process.env.PSP_EMU_TIMEOUT ?? "420");
const MEMSTICK = resolve(process.env.PSP_SAVE_MEMSTICK
  ?? join(ROOT, ".psp-emu-memstick", `save-${language}-${execution}`));
const WORK = join(ROOT, ".psp-save-e2e", `${language}-${execution}`);

// --- real deps ---------------------------------------------------------------

function buildJourney(tape: Tape): void {
  const tapeFile = join(WORK, `${tape.label}.tape.json`);
  writeFileSync(tapeFile, JSON.stringify({ masks: tape.masks, logAt: tape.logAt, label: tape.label }));
  console.log(`# build ${tape.label} (${tape.masks.length} frames, logAt=${tape.logAt})`);
  const buildArgs = [
    "run",
    "build:psp",
    "--skip-assets",
    ...(language === "zh" ? ["--zh"] : []),
    `--journey-tape=${tapeFile}`,
  ];
  const r = spawnSync(process.execPath, buildArgs, {
    cwd: ROOT,
    stdio: ["ignore", "inherit", "inherit"],
    env: {
      ...process.env,
      PATH: `${process.env.HOME}/.cargo/bin:${process.env.PATH ?? ""}`,
      // The verifier checks the host's own path-selection trace, so a QJBC
      // package cannot silently fall back to source and still pass.
      POCKETJS_TRACE: "1",
    },
    timeout: (TIMEOUT + 120) * 1000,
  });
  if (r.status !== 0) throw new Error(`build:psp --journey-tape=${tape.label} failed`);
  if (execution === "source") {
    const packagePath = join(PSP_OUT, "app.pocket");
    writeFileSync(packagePath, makeSourceOnlyPspPackage(readFileSync(packagePath)));
  }
}

function runPsp(phase: string, memstick: string): LogEntry[] {
  const dir = join(WORK, phase);
  mkdirSync(dir, { recursive: true });
  const prx = join(dir, "pocket-tuxemon.prx");
  writeFileSync(prx, readFileSync(join(PSP_OUT, "pocket-tuxemon.prx")));
  // The generic PSP runtime resolves its native package from host0:, beside
  // the PRX. Keep the bytecode and source-fallback package with every run.
  writeFileSync(join(dir, "app.pocket"), readFileSync(join(PSP_OUT, "app.pocket")));
  // The external assets.pak must sit beside the PRX: pak_external.rs reads it
  // from the PRX's directory, and without it the game halts during boot.
  writeFileSync(join(dir, "assets.pak"), readFileSync(join(PSP_OUT, "assets.pak")));
  // host0: maps to the PRX's directory, so profile.jsonl lands in dir/.
  for (const f of ["profile.jsonl", "PocketJS-bench.jsonl", "PocketJS-trace.txt"]) {
    try { rmSync(join(dir, f), { force: true }); } catch { /* absent */ }
  }
  mkdirSync(memstick, { recursive: true });
  if (language === "zh") {
    const appRoot = pspPhysicalAppRoot(memstick);
    mkdirSync(appRoot, { recursive: true });
    writeFileSync(join(appRoot, "font-archive.bin"), readFileSync(join(PSP_OUT, "font-archive.bin")));
  }
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
  if (r.status !== 0) {
    console.error(stdout);
    console.error(stderr);
    throw new Error(`PPSSPP exited with status ${r.status} for ${phase}`);
  }
  const tracePath = join(dir, "PocketJS-trace.txt");
  if (!existsSync(tracePath)) throw new Error(`no PocketJS-trace.txt for ${phase}`);
  const trace = readFileSync(tracePath, "utf8");
  const expectedTrace = execution === "bytecode"
    ? "[PocketJS trace] run: bytecode"
    : "[PocketJS trace] run: source fallback (bytecode absent)";
  if (!trace.includes(expectedTrace)) {
    throw new Error(`${phase} did not use the requested ${execution} execution path`);
  }
  const profilePath = join(dir, "profile.jsonl");
  if (!existsSync(profilePath)) {
    console.error(stdout);
    console.error(stderr);
    throw new Error(`no profile.jsonl for ${phase} — the run did not boot or did not log`);
  }
  return readFileSync(profilePath, "utf8").trim().split("\n").filter(Boolean).map((line, index) => {
    try { return JSON.parse(line) as LogEntry; } catch {
      throw new Error(`malformed profile.jsonl line ${index + 1} for ${phase}`);
    }
  });
}

/** The logAt that captures the state right after the opening's autosave
 *  point. The journey-tape logger feeds tape[logAt-1] and then logs, so the
 *  state after the frame that publishes the autosave is logAt = frame + 1.
 *  Replayed in bun (the reducer is pure, so the frame matches the PPSSPP run
 *  frame-for-frame) so the trigger tape logs the state at the autosave point. */
function findAutosaveLogAt(lang: PspSaveLanguage): number {
  const journey = JSON.parse(readFileSync(join(
    ROOT,
    lang === "zh" ? "data/zh-smoke-journey.json" : "data/g6-journey.json",
  ), "utf8")) as { masks: number[] };
  const localized = lang === "zh" ? readShardedProject(ROOT, "zh_CN") : null;
  const game = localized
    ? {
        project: localized.project,
        session: createSession(localized.project, 60, createTuxemonSessionOptions(
          localized.project,
          "seamless-v1",
          { ...TUXEMON_SESSION_OPTIONS_ZH, maps: localized.repository },
        )),
      }
    : createGameSession(FIXED_INITIAL_CIVIL_TIME, "seamless-v1");
  const { project, session } = game;
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

const deps: PspSaveVerifyDeps = {
  build: buildJourney,
  run: runPsp,
  memstick: MEMSTICK,
  work: WORK,
  autosaveFrame: -1, // resolved in main after the preflight
  language,
  cleanMemstick() {
    rmSync(join(MEMSTICK, "PSP"), { recursive: true, force: true });
  },
  withReadOnlySaveDir(fn: () => void) {
    const dir = join(pspPhysicalAppRoot(MEMSTICK), "save");
    mkdirSync(dir, { recursive: true });
    chmodSync(dir, 0o555);
    try { fn(); } finally { chmodSync(dir, 0o755); }
  },
  readSaveFile(rel: string) {
    const live = pspPhysicalSavePath(MEMSTICK, rel);
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
    const live = pspPhysicalSavePath(MEMSTICK, rel);
    return existsSync(live) || existsSync(`${live}.bak`);
  },
  writeLegacySaveFile(rel: string, json: string) {
    const live = pspPhysicalSavePath(MEMSTICK, rel);
    mkdirSync(join(pspPhysicalAppRoot(MEMSTICK), "save"), { recursive: true });
    writeFileSync(live, json);
    rmSync(`${live}.tmp`, { force: true });
    rmSync(`${live}.bak`, { force: true });
  },
};

// --- main --------------------------------------------------------------------

mkdirSync(WORK, { recursive: true });
if (!existsSync(HEADLESS)) throw new Error(`PPSSPPHeadless not found at ${HEADLESS}`);
if (!PHASES.includes(phase as (typeof PHASES)[number]) && phase !== "all") {
  throw new Error(`unknown phase ${JSON.stringify(phase)} (expected one of: ${PHASES.join(", ")}, all)`);
}
deps.autosaveFrame = findAutosaveLogAt(language);
console.log(`# PSP save matrix lang=${language} execution=${execution}`);
console.log(`# opening autosave point logged at logAt ${deps.autosaveFrame}`);

runPhase(phase, deps);

console.log("\nALL PHASES PASS");
