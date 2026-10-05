// Same-moment PSP/desktop capture tool. For each key shot, the PSP side
// builds a capture PRX from the enclosing chapter save and dumps a small
// framebuffer window under PPSSPPHeadless; the desktop side renders the same
// global frame from the same chapter save and the same mainline tape through
// the sim host. The two sides are therefore the same reducer state at the
// same global frame, and the retained PRX + build receipt close the
// capture-to-build chain (PRX sha256 == receipt artifact hash).
//
// Not in CI — needs a local PPSSPPHeadless and the PSP SDK.
//
// Usage:
//   bun tools/psp-capture.ts desktop [--shot=<id>]   # render desktop controls
//   bun tools/psp-capture.ts psp [--shot=<id>]       # build + run + convert PSP
//   bun tools/psp-capture.ts verify                  # PRX/receipt hash + source cleanliness
//
// Env: PSP_CAPTURE_DIR (default dist/captures, gitignored),
//      PPSSPP_HEADLESS, PSP_EMU_TIMEOUT.

import { spawnSync, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import { FIXED_TIME_HOST_GLOBALS } from "../battle/time-weather.ts";
import { bootWorld } from "../vendor/pocket-rpgkit/vendor/pocketjs/hosts/sim/sim.ts";
import { encodePNG } from "../vendor/pocket-rpgkit/vendor/pocketjs/tests/png.ts";
import { loadChapters, loadMainlineTape, ROOT } from "./psp-segment.ts";
import { retainArtifact } from "./psp-retain.ts";

const sha256 = (bytes: Uint8Array | string): string =>
  createHash("sha256").update(bytes).digest("hex");

// The six key shots. `global` is the exact global frame both sides render;
// PSP_CAP_START is suffix-relative (tools/psp.ts adds the +1 boot-frame
// offset), so f0000 lands on `global`. The capture build runs a short suffix
// ending a few frames past the window.
interface Shot {
  id: string;
  chapter: string;
  global: number;
  capN: number;
}

const SHOTS: Shot[] = [
  { id: "01-bedroom", chapter: "bedroom", global: 1, capN: 4 },
  { id: "02-paper-town", chapter: "paper-town", global: 1406, capN: 4 },
  { id: "03-battle", chapter: "before-billie", global: 2524, capN: 4 },
  { id: "04-seam", chapter: "route-1", global: 3989, capN: 4 },
  { id: "05-cotton-town", chapter: "cotton-town", global: 5452, capN: 4 },
  { id: "06-radio-tower", chapter: "radio-broadcast", global: 185789, capN: 4 },
];

// Default to a gitignored directory inside the repo (dist/); override with
// PSP_CAPTURE_DIR for a retained evidence location outside the build output.
// Resolve to absolute: PPSSPP's --memstick must be absolute, or the host
// creates the bench file but never the dc_cap/ framebuffer dump directory.
const OUT = resolve(process.env.PSP_CAPTURE_DIR ?? join(ROOT, "dist", "captures"));
const HEADLESS = process.env.PPSSPP_HEADLESS ?? join(homedir(), "ppsspp-src/build/PPSSPPHeadless");
const TIMEOUT = process.env.PSP_EMU_TIMEOUT ?? "180";

function shotDir(shot: Shot): string {
  return join(OUT, shot.id);
}

/** The suffix-relative capture start: f0000 lands on the shot's global frame. */
function capStart(shot: Shot, chapterFrame: number): number {
  return shot.global - chapterFrame - 1;
}

/** Nearest-neighbour 3x zoom (480x272 -> 1440x816) for visual inspection. */
function zoom3(rgba: Uint8Array, w: number, h: number): Uint8Array {
  const out = new Uint8Array(w * 3 * h * 3 * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      for (let dy = 0; dy < 3; dy++) {
        for (let dx = 0; dx < 3; dx++) {
          const si = (y * w + x) * 4;
          const di = ((y * 3 + dy) * w * 3 + (x * 3 + dx)) * 4;
          out[di] = rgba[si]!;
          out[di + 1] = rgba[si + 1]!;
          out[di + 2] = rgba[si + 2]!;
          out[di + 3] = rgba[si + 3]!;
        }
      }
    }
  }
  return out;
}

/** Crop a 512-stride RGBA framebuffer dump to 480x272. The PSP GE leaves
 *  the alpha channel clear, so force it opaque (the previous round's
 *  conversion did the same — a transparent PNG renders white). */
function cropPspRaw(raw: Uint8Array): Uint8Array {
  const stride = 512;
  const w = 480;
  const h = 272;
  const out = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    const row = y * stride * 4;
    const dst = y * w * 4;
    for (let x = 0; x < w; x++) {
      const si = row + x * 4;
      const di = dst + x * 4;
      out[di] = raw[si]!;
      out[di + 1] = raw[si + 1]!;
      out[di + 2] = raw[si + 2]!;
      out[di + 3] = 255;
    }
  }
  return out;
}

function writePng(path: string, rgba: Uint8Array, w: number, h: number): void {
  writeFileSync(path, encodePNG(rgba, w, h));
}

// --- Desktop controls ------------------------------------------------------

async function renderDesktop(shot: Shot): Promise<void> {
  const chapters = loadChapters(ROOT);
  const chapter = chapters.chapters.find((c) => c.id === shot.chapter);
  if (!chapter) throw new Error(`no chapter ${shot.chapter}`);
  const { combined } = loadMainlineTape(ROOT);
  const start = capStart(shot, chapter.frame);
  const dir = shotDir(shot);
  mkdirSync(dir, { recursive: true });
  const world = await bootWorld(join(ROOT, "dist/main"), 60, {
    ...FIXED_TIME_HOST_GLOBALS,
    __pocketTuxemonBootSnapshot: chapter.snapshot,
    __pocketTuxemonBootFrame: chapter.timelineFrame,
  }, undefined, { width: 480, height: 272 });
  // Frame 0 restores the chapter save (boot overlay); frames 1..start+1 fold
  // suffix masks 0..start, so the render is the state at the shot's global
  // frame — the same state PSP f0000 shows.
  world.frame(0);
  world.tick();
  for (let k = 0; k <= start; k++) {
    world.frame(combined[chapter.frame + k]!);
    world.tick();
  }
  const rgba = world.render().slice();
  const state = globalThis.__rpgSessionState as { mapId?: string; move?: { tx: number; ty: number } } | undefined;
  const base = `${shot.id}-desktop-g${shot.global}`;
  writePng(join(dir, `${base}.png`), rgba, 480, 272);
  writePng(join(dir, `${base}.3x.png`), zoom3(rgba, 480, 272), 1440, 816);
  console.log(`desktop ${shot.id} g${shot.global} ${state?.mapId}@${state?.move?.tx},${state?.move?.ty} ` +
    `sha256=${sha256(rgba).slice(0, 16)} -> ${base}.png`);
}

// --- PSP captures ----------------------------------------------------------

function buildPsp(shot: Shot): void {
  const chapters = loadChapters(ROOT);
  const chapter = chapters.chapters.find((c) => c.id === shot.chapter)!;
  const start = capStart(shot, chapter.frame);
  const end = shot.global + 8;
  const dir = shotDir(shot);
  mkdirSync(dir, { recursive: true });
  console.log(`=== PSP BUILD ${shot.id} (${shot.chapter} -> ${end}, cap ${start} +${shot.capN}) ===`);
  const r = spawnSync("bun", ["run", "build:psp", "--skip-assets",
    `--journey-segment=${shot.chapter}`, `--journey-segment-end=${end}`, "--capture"], {
    cwd: ROOT,
    stdio: "inherit",
    env: {
      ...process.env,
      PSP_CAP_START: String(start),
      PSP_CAP_N: String(shot.capN),
      POCKETJS_LLVM_BIN: process.env.POCKETJS_LLVM_BIN ?? "/usr/lib/llvm-18/bin",
    },
  });
  if (r.status !== 0) throw new Error(`capture build failed for ${shot.id}`);
  // Retain the PRX + receipt so the capture-to-build chain is verifiable.
  writeFileSync(join(dir, `${shot.id}.prx`), readFileSync(join(ROOT, "dist/psp/pocket-tuxemon.prx")));
  writeFileSync(join(dir, `${shot.id}-receipt.json`), readFileSync(join(ROOT, "dist/psp/build-receipt.json")));
}

function runPsp(shot: Shot): void {
  const dir = shotDir(shot);
  const prx = join(dir, `${shot.id}.prx`);
  if (!existsSync(prx)) throw new Error(`missing ${prx}; run the psp build first`);
  // The host loads the external pak from the PRX's directory (host0:); the
  // mainline runner retains it per segment, and the capture needs it too.
  // Retained content-addressed (hardlink to the sha256-named store entry),
  // never an absolute symlink into dist/, so the evidence tree is portable.
  retainArtifact(join(ROOT, "dist/psp/assets.pak"), join(dir, "assets.pak"), join(OUT, "assets"), ".pak");
  const memstick = join(OUT, ".memstick", shot.id);
  rmSync(memstick, { recursive: true, force: true });
  mkdirSync(memstick, { recursive: true });
  const capDir = join(memstick, "dc_cap");
  console.log(`=== PSP RUN ${shot.id} ===`);
  const r = spawnSync("nice", ["-n", "10", "taskset", "-c", process.env.PSP_CAPTURE_AFFINITY ?? "0-7",
    HEADLESS, "--graphics=software", `--timeout=${TIMEOUT}`, `--memstick=${memstick}`, prx], {
    cwd: ROOT,
    stdio: "inherit",
    timeout: Number(TIMEOUT) * 1000 + 60_000,
  });
  const exit = r.status ?? -1;
  console.log(`exit=${exit}`);
  if (exit !== 0) console.log(`(non-zero exit for ${shot.id})`);
  // Convert the dumped framebuffers.
  const raws = existsSync(capDir)
    ? readdirSync(capDir).filter((f) => f.endsWith(".raw")).sort()
    : [];
  if (raws.length === 0) throw new Error(`${shot.id}: no framebuffer dumps in ${capDir}`);
  for (const name of raws) {
    const raw = new Uint8Array(readFileSync(join(capDir, name)));
    const rgba = cropPspRaw(raw);
    const idx = name.replace(/^f|\.raw$/g, "");
    const base = `${shot.id}-psp-g${shot.global}+${idx}`;
    writePng(join(dir, `${base}.png`), rgba, 480, 272);
    writePng(join(dir, `${base}.3x.png`), zoom3(rgba, 480, 272), 1440, 816);
    console.log(`psp ${shot.id} ${name} sha256=${sha256(rgba).slice(0, 16)} -> ${base}.png`);
  }
}

// --- PRX/receipt chain + source provenance ---------------------------------

const EMPTY_TREE_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

/** Paths that never feed a PSP build: documentation, evidence reports, CI
 *  config and top-level meta files. A capture built at a commit that differs
 *  from HEAD only by these paths is still reproducible from HEAD. */
export function isNonArtifactPath(p: string): boolean {
  if (p.startsWith("docs/") || p.startsWith("findings/") || p.startsWith("reports/") || p.startsWith(".github/")) {
    return true;
  }
  if (!p.includes("/")) {
    return /^(README(\.[\w-]+)?\.md|LICENSE(\.[\w-]+)?|CLAUDE\.md|AGENTS\.md|\.gitignore|\.gitattributes)$/.test(p);
  }
  return false;
}

/** Check a capture receipt's source provenance: the receipt must have been
 *  built from a clean worktree (empty source diff and no recorded changed
 *  files), and its source commit must be HEAD or differ from HEAD only by
 *  non-artifact paths. `driftPaths` is `git diff --name-only <receipt commit>
 *  HEAD` (empty when the receipt is at HEAD). Returns the issues found. */
export function sourceCleanlinessIssues(
  source: unknown,
  headCommit: string,
  driftPaths: readonly string[],
): string[] {
  const issues: string[] = [];
  const s = source as { commit?: unknown; diffSha256?: unknown; changedFiles?: unknown } | undefined;
  if (!s || typeof s.commit !== "string") {
    issues.push("receipt has no source commit");
    return issues;
  }
  if (typeof s.diffSha256 === "string" && s.diffSha256 !== EMPTY_TREE_SHA256) {
    issues.push("receipt source.diffSha256 is non-empty: the capture was built from a dirty worktree");
  }
  if (s.changedFiles !== null && typeof s.changedFiles === "object"
    && Object.keys(s.changedFiles as Record<string, unknown>).length > 0) {
    issues.push("receipt source.changedFiles is non-empty: the capture was built from a dirty worktree");
  }
  if (s.commit !== headCommit) {
    const affecting = driftPaths.filter((p) => !isNonArtifactPath(p));
    if (affecting.length > 0) {
      const shown = affecting.slice(0, 10).join(", ");
      const more = affecting.length > 10 ? `, ... ${affecting.length - 10} more` : "";
      issues.push(`receipt source ${s.commit.slice(0, 12)} != HEAD ${headCommit.slice(0, 12)} `
        + `with artifact-affecting changes: ${shown}${more}`);
    }
  }
  return issues;
}

function verifyChain(): void {
  let bad = 0;
  const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8" }).trim();
  for (const shot of SHOTS) {
    const dir = shotDir(shot);
    const prxPath = join(dir, `${shot.id}.prx`);
    const receiptPath = join(dir, `${shot.id}-receipt.json`);
    if (!existsSync(prxPath) || !existsSync(receiptPath)) {
      console.log(`MISSING ${shot.id}`);
      bad++;
      continue;
    }
    const receipt = JSON.parse(readFileSync(receiptPath, "utf8")) as {
      artifacts?: Record<string, { sha256?: string }>;
      source?: { commit?: string; diffSha256?: string; changedFiles?: Record<string, string> };
    };
    const issues: string[] = [];
    const actual = sha256(readFileSync(prxPath));
    const expected = receipt.artifacts?.["pocket-tuxemon.prx"]?.sha256;
    if (actual !== expected) {
      issues.push(`prx ${actual.slice(0, 12)} != receipt ${String(expected).slice(0, 12)}`);
    }
    // Source provenance: the capture must come from a clean worktree at HEAD
    // or a docs-only ancestor, not a dirty tree or an artifact-affecting
    // commit. The PRX hash chain alone cannot prove either.
    let drift: string[] = [];
    const sourceCommit = typeof receipt.source?.commit === "string" ? receipt.source.commit : undefined;
    if (sourceCommit && sourceCommit !== head) {
      const r = spawnSync("git", ["diff", "--name-only", sourceCommit, head], { cwd: ROOT, encoding: "utf8" });
      if (r.status !== 0) {
        issues.push(`cannot resolve receipt source commit ${sourceCommit.slice(0, 12)}`);
      } else {
        drift = r.stdout.trim().split("\n").filter(Boolean);
      }
    }
    issues.push(...sourceCleanlinessIssues(receipt.source, head, drift));
    if (issues.length > 0) {
      console.log(`FAIL ${shot.id}: ${issues.join("; ")}`);
      bad++;
    } else {
      console.log(`OK ${shot.id} ${actual.slice(0, 12)}`);
    }
  }
  if (bad > 0) process.exit(1);
}

// --- CLI -------------------------------------------------------------------

if (import.meta.main) {
  const command = process.argv[2];
  const onlyShot = process.argv.find((a) => a.startsWith("--shot="))?.slice("--shot=".length);
  const shots = SHOTS.filter((s) => !onlyShot || s.id === onlyShot);

  if (command === "desktop") {
    for (const shot of shots) await renderDesktop(shot);
  } else if (command === "psp") {
    if (!existsSync(HEADLESS)) throw new Error(`PPSSPPHeadless not found at ${HEADLESS}`);
    for (const shot of shots) {
      buildPsp(shot);
      runPsp(shot);
    }
  } else if (command === "verify") {
    verifyChain();
  } else {
    console.error("usage: bun tools/psp-capture.ts <desktop|psp|verify> [--shot=<id>]");
    process.exit(1);
  }
}
