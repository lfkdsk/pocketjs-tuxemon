#!/usr/bin/env bun
// Build the real desktop package, replay the maintained opening under the
// native QuickJS host, and require non-zero battle/victory PCM to cross the
// host ring and be consumed by its device clock without underruns.

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  hostAudioProbeSource,
  type HostAudioProbeReport,
  validateBattleAudioReport,
} from "./host-audio-probe.ts";

const root = resolve(import.meta.dir, "..");
const journeyPath = join(root, "data", "gb6-mainline-journey.json");
const journey = await Bun.file(journeyPath).json() as { map?: unknown };
if (typeof journey.map !== "string" || journey.map.length === 0) {
  throw new Error("desktop audio verification journey is missing its terminal map");
}
const build = spawnSync("bun", ["tools/desktop.ts", "--build-only"], {
  cwd: root,
  stdio: "inherit",
  env: { ...process.env, TUXEMON_SRC: process.env.TUXEMON_SRC ?? join(root, ".tuxemon-src") },
});
if (build.status !== 0) process.exit(build.status ?? 1);

const out = join(root, "dist", "desktop-audio");
mkdirSync(out, { recursive: true });
const probePath = join(out, "probe.js");
writeFileSync(probePath, hostAudioProbeSource());
if (!existsSync(join(root, "dist/linux-app/pocket-tuxemon.js"))) {
  throw new Error("desktop audio verification requires the linux-app build");
}

const replay = spawnSync("bash", ["tools/bench-g6-quickjs.sh"], {
  cwd: root,
  encoding: "utf8",
  maxBuffer: 64 * 1024 * 1024,
  env: {
    ...process.env,
    TUXEMON_SRC: process.env.TUXEMON_SRC ?? join(root, ".tuxemon-src"),
    G6_AUDIO_PROBE_SCRIPT: probePath,
    G6_BENCH_ROOT: join(out, "quickjs"),
    G6_JOURNEY: journeyPath,
    G6_EXPECTED_MAP: journey.map,
    G6_BENCH_VIEWPORT: "480 272",
    G6_COLD_RUNS: "1",
    G6_SKIP_MAP_BENCH: "1",
    G6_FAST_BENCH: "1",
    G6_HASH_EVERY: "30",
  },
});
process.stdout.write(replay.stdout ?? "");
process.stderr.write(replay.stderr ?? "");
if (replay.status !== 0) process.exit(replay.status ?? 1);

const matches = [...(replay.stdout ?? "").matchAll(/^AUDIO_PROBE (.+)$/gm)];
if (matches.length !== 1) {
  throw new Error(`desktop audio verifier expected one AUDIO_PROBE line, received ${matches.length}`);
}
const report = JSON.parse(matches[0]![1]!) as HostAudioProbeReport;
const errors = validateBattleAudioReport(report);
if (errors.length > 0) {
  throw new Error(`desktop audio verification failed:\n  ${errors.join("\n  ")}`);
}
const battle = report.phases.music_battle_loop!;
const victory = report.phases.music_win_battle_boss!;
console.log(
  `DESKTOP AUDIO PASS: battle accepted=${battle.acceptedFrames} nonzero=${battle.nonZeroSamples} ` +
  `victory accepted=${victory.acceptedFrames} nonzero=${victory.nonZeroSamples}; ` +
  `device credited=${report.creditedFrames}; underruns=0; ` +
  `restored=${report.restored}`,
);
