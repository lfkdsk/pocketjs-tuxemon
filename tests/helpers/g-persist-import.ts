import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import type { Project } from "../../vendor/pocket-rpgkit/src/engine/types.ts";
import type { CoverageReport } from "../../importer/coverage.ts";

export type GPersistFeature = "animation" | "camera" | "balloon" | "backdrop";

export interface GPersistBuild {
  project: Project;
  coverage: CoverageReport;
}

export type GPersistBuilds = Record<GPersistFeature, GPersistBuild>;

const ROOT = resolve(import.meta.dir, "../..");
const FIXTURE = join(ROOT, "tests/fixtures/g-persist-source");
const BUILDER = join(ROOT, "tests/fixtures/build-g-persist-fixture.ts");
const TUXEMON_REVISION = "9e6258ff726b786040a267e8bdbbf037b560285e";

const COPIED_UPSTREAM_FILES = [
  "mods/tuxemon/db/animation/tileset.yaml",
  "mods/tuxemon/animations/tileset/grass.png",
  "mods/tuxemon/gfx/bubbles/exclamation.png",
  "mods/tuxemon/gfx/ui/background/gradient_blue.png",
  "mods/tuxemon/gfx/ui/background/gradient_red.png",
] as const;

/** Build the committed constructed maps in a child process. The importer
 * captures TUXEMON_SRC at module load, so isolating the child avoids changing
 * this test process or racing sibling importer suites. Art stays authoritative:
 * the small fixture copies the pinned upstream files instead of checking in
 * rewritten stand-ins. */
export async function loadGPersistBuilds(): Promise<GPersistBuilds> {
  const upstream = process.env.TUXEMON_SRC ?? resolve(ROOT, ".tuxemon-src");
  if (!existsSync(upstream)) {
    throw new Error("g-persist fixture: set TUXEMON_SRC to the pinned Tuxemon checkout");
  }
  const revision = spawnSync("git", ["-C", upstream, "rev-parse", "HEAD"], { encoding: "utf8" });
  if (revision.status !== 0 || revision.stdout.trim() !== TUXEMON_REVISION) {
    throw new Error(`g-persist fixture: TUXEMON_SRC must be pinned at ${TUXEMON_REVISION}`);
  }

  const scratch = mkdtempSync(join(tmpdir(), "pocket-tuxemon-g-persist-"));
  try {
    cpSync(FIXTURE, scratch, { recursive: true });
    for (const relative of COPIED_UPSTREAM_FILES) {
      const source = join(upstream, relative);
      const destination = join(scratch, relative);
      if (!existsSync(source)) throw new Error(`g-persist fixture: missing upstream ${relative}`);
      mkdirSync(dirname(destination), { recursive: true });
      cpSync(source, destination);
    }

    // World-layout provenance is intentionally content-addressed to the
    // source revision. Give the isolated fixture its own deterministic local
    // revision instead of borrowing metadata from the real checkout.
    for (const args of [
      ["init", "--quiet"],
      ["add", "."],
      ["-c", "user.name=fixture", "-c", "user.email=fixture@example.invalid", "commit", "--quiet", "-m", "fixture"],
    ]) {
      const result = spawnSync("git", ["-C", scratch, ...args], { encoding: "utf8" });
      if (result.status !== 0) {
        throw new Error(`g-persist fixture git ${args[0]} failed: ${result.stderr.trim()}`);
      }
    }

    const proc = Bun.spawn({
      cmd: ["bun", "run", BUILDER],
      cwd: ROOT,
      env: { ...process.env, TUXEMON_SRC: scratch },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    if (exitCode !== 0) {
      throw new Error(`g-persist fixture build failed (exit ${exitCode}):\n${stderr}`);
    }
    return JSON.parse(stdout) as GPersistBuilds;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
