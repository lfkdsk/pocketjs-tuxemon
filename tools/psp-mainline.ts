// Full-mainline PSP emulator runner: build and run the GB6+J1+J2+J3+J4
// mainline (199,316 frames) as 28 bounded chapter segments under
// PPSSPPHeadless, verify each terminal against its desktop pin, and collect
// the raw profile/bench plus per-segment metrics into reports/psp-mainline/.
//
// The long chapter windows are split with generated intermediate envelopes
// (tools/psp-segment.ts generateEnvelopes) so every segment fits in one
// foreground emulator run. Not in CI — needs a local PPSSPPHeadless and the
// PSP SDK (see docs/verification.md).
//
// The aggregator never swallows a failure: a missing bench, an incomplete
// bench window, a non-zero emulator exit, a verifier FAIL or a PRX/receipt
// hash mismatch all fail the segment, and any failed segment fails the run
// (exit non-zero). See tests/psp-mainline.test.ts.
//
// Usage:
//   bun tools/psp-mainline.ts snapshots     # generate the intermediate envelopes
//   bun tools/psp-mainline.ts plan          # print the 28-segment plan
//   bun tools/psp-mainline.ts build         # build all segments (sequential)
//   bun tools/psp-mainline.ts run [--jobs=4] [--only=<id>]  # run + verify + collect
//   bun tools/psp-mainline.ts report        # aggregate the collected metrics

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { generateEnvelopes, loadChapters, loadMainlineTape, ROOT } from "./psp-segment.ts";
import { retainArtifact } from "./psp-retain.ts";
import { canonicalJson } from "../vendor/pocket-rpgkit/src/engine/save.ts";

export { ROOT };

// Retention root. PSP_MAINLINE_OUT overrides for tests (a disposable tree);
// the default is the gitignored reports/psp-mainline/ evidence directory.
const OUT = process.env.PSP_MAINLINE_OUT ?? join(ROOT, "reports/psp-mainline");
const PSP_OUT = join(ROOT, "dist/psp");

const sha256 = (bytes: Uint8Array | string): string =>
  createHash("sha256").update(bytes).digest("hex");

// The 28-segment plan. Committed chapters use their data/chapters.json frame;
// the three long windows are split at generated envelopes (the frames below
// are the targets; generateEnvelopes picks the first safe point at/after).
interface PlanEntry {
  id: string;
  chapter: string;
  end: number;
}

/** The generated intermediate envelope targets (exported so tests can
 *  regenerate the gitignored .psp-segments/ snapshots on a clean checkout). */
export const SPLIT_ENVELOPES = [
  { id: "seg-18695", frame: 18695 },
  { id: "seg-31998", frame: 31998 },
  { id: "seg-58414", frame: 58414 },
  { id: "seg-71527", frame: 71527 },
  { id: "seg-84640", frame: 84640 },
  { id: "seg-97753", frame: 97753 },
  { id: "seg-136603", frame: 136603 },
  { id: "seg-150820", frame: 150820 },
];

// The pinned full-mainline extent this plan must cover: the J4 quest ends the
// Spyder campaign at frame 199,316, split into 28 bounded segments. These are
// independent of the plan's own self-report (the plan is hand-written), so a
// deleted or reordered segment is caught even though `verify` only walks the
// plan as given.
export const EXPECTED_SEGMENTS = 28;
export const EXPECTED_END_FRAME = 199316;

/** The fixed 28-segment identity table: every plan entry's id, chapter and
 *  [start, end) window, in order. This is independent of the plan's own
 *  self-report (the plan is hand-written and the envelope frames are read
 *  from disk), so a renamed, reordered or rebounded segment is caught even
 *  though `verify` only walks the plan as given. When the mainline data
 *  changes deliberately, regenerate with `bun tools/psp-mainline.ts plan`
 *  and update this table in the same change. */
export const EXPECTED_PLAN_IDENTITIES: ReadonlyArray<{ id: string; chapter: string; start: number; end: number }> = [
  { id: "01-bedroom", chapter: "bedroom", start: 0, end: 1399 },
  { id: "02-paper-town", chapter: "paper-town", start: 1399, end: 1924 },
  { id: "03-before-billie", chapter: "before-billie", start: 1924, end: 3692 },
  { id: "04-starter", chapter: "starter", start: 3692, end: 3982 },
  { id: "05-route-1", chapter: "route-1", start: 3982, end: 5384 },
  { id: "06-cotton-town-a", chapter: "cotton-town", start: 5384, end: 18902 },
  { id: "07-route2-a", chapter: "seg-18695", start: 18902, end: 32003 },
  { id: "08-route2-b", chapter: "seg-31998", start: 32003, end: 44953 },
  { id: "09-city-park-a", chapter: "city-park", start: 44953, end: 58430 },
  { id: "10-route3-a", chapter: "seg-58414", start: 58430, end: 71539 },
  { id: "11-route3-b", chapter: "seg-71527", start: 71539, end: 84645 },
  { id: "12-route3-c", chapter: "seg-84640", start: 84645, end: 97754 },
  { id: "13-leather-town", chapter: "seg-97753", start: 97754, end: 110244 },
  { id: "14-route-3-north", chapter: "route-3-north", start: 110244, end: 115006 },
  { id: "15-flower-city", chapter: "flower-city", start: 115006, end: 121768 },
  { id: "16-captain-returns-a", chapter: "captain-returns", start: 121768, end: 137571 },
  { id: "17-dojo", chapter: "seg-136603", start: 137571, end: 150965 },
  { id: "18-route5", chapter: "seg-150820", start: 150965, end: 165163 },
  { id: "19-candy-town", chapter: "candy-town", start: 165163, end: 171549 },
  { id: "20-greenwash", chapter: "greenwash-aardant", start: 171549, end: 172988 },
  { id: "21-hospital-cure", chapter: "hospital-cure", start: 172988, end: 180746 },
  { id: "22-omnichannel", chapter: "omnichannel-open", start: 180746, end: 185906 },
  { id: "23-radio-broadcast", chapter: "radio-broadcast", start: 185906, end: 187777 },
  { id: "24-kernel-briefing", chapter: "kernel-briefing", start: 187777, end: 189158 },
  { id: "25-surfboard", chapter: "surfboard", start: 189158, end: 191337 },
  { id: "26-route-b", chapter: "route-b", start: 191337, end: 194849 },
  { id: "27-data-center", chapter: "data-center", start: 194849, end: 199305 },
  { id: "28-kernel-defeated", chapter: "kernel-defeated", start: 199305, end: 199316 },
];

/** The 28-segment plan (exported so the coverage invariants are testable
 *  against the real plan, not a synthetic copy). */
export function buildPlan(): PlanEntry[] {
  const chapters = loadChapters(ROOT);
  const { combined } = loadMainlineTape(ROOT);
  const byId = new Map(chapters.chapters.map((c) => [c.id, c]));
  // Generated envelope frames (read from disk so the plan uses the actual
  // safe points, not the targets).
  const genFrames = new Map<string, number>();
  for (const e of SPLIT_ENVELOPES) {
    const path = join(ROOT, ".psp-segments", `${e.id}.json`);
    if (!existsSync(path)) {
      throw new Error(`missing generated envelope ${e.id}; run: bun tools/psp-mainline.ts snapshots`);
    }
    genFrames.set(e.id, (JSON.parse(readFileSync(path, "utf8")) as { frame: number }).frame);
  }
  const g = (id: string) => genFrames.get(id)!;
  return [
    { id: "01-bedroom", chapter: "bedroom", end: byId.get("paper-town")!.frame },
    { id: "02-paper-town", chapter: "paper-town", end: byId.get("before-billie")!.frame },
    { id: "03-before-billie", chapter: "before-billie", end: byId.get("starter")!.frame },
    { id: "04-starter", chapter: "starter", end: byId.get("route-1")!.frame },
    { id: "05-route-1", chapter: "route-1", end: byId.get("cotton-town")!.frame },
    { id: "06-cotton-town-a", chapter: "cotton-town", end: g("seg-18695") },
    { id: "07-route2-a", chapter: "seg-18695", end: g("seg-31998") },
    { id: "08-route2-b", chapter: "seg-31998", end: byId.get("city-park")!.frame },
    { id: "09-city-park-a", chapter: "city-park", end: g("seg-58414") },
    { id: "10-route3-a", chapter: "seg-58414", end: g("seg-71527") },
    { id: "11-route3-b", chapter: "seg-71527", end: g("seg-84640") },
    { id: "12-route3-c", chapter: "seg-84640", end: g("seg-97753") },
    { id: "13-leather-town", chapter: "seg-97753", end: byId.get("route-3-north")!.frame },
    { id: "14-route-3-north", chapter: "route-3-north", end: byId.get("flower-city")!.frame },
    { id: "15-flower-city", chapter: "flower-city", end: byId.get("captain-returns")!.frame },
    { id: "16-captain-returns-a", chapter: "captain-returns", end: g("seg-136603") },
    { id: "17-dojo", chapter: "seg-136603", end: g("seg-150820") },
    { id: "18-route5", chapter: "seg-150820", end: byId.get("candy-town")!.frame },
    { id: "19-candy-town", chapter: "candy-town", end: byId.get("greenwash-aardant")!.frame },
    { id: "20-greenwash", chapter: "greenwash-aardant", end: byId.get("hospital-cure")!.frame },
    { id: "21-hospital-cure", chapter: "hospital-cure", end: byId.get("omnichannel-open")!.frame },
    { id: "22-omnichannel", chapter: "omnichannel-open", end: byId.get("radio-broadcast")!.frame },
    { id: "23-radio-broadcast", chapter: "radio-broadcast", end: byId.get("kernel-briefing")!.frame },
    { id: "24-kernel-briefing", chapter: "kernel-briefing", end: byId.get("surfboard")!.frame },
    { id: "25-surfboard", chapter: "surfboard", end: byId.get("route-b")!.frame },
    { id: "26-route-b", chapter: "route-b", end: byId.get("data-center")!.frame },
    { id: "27-data-center", chapter: "data-center", end: byId.get("kernel-defeated")!.frame },
    { id: "28-kernel-defeated", chapter: "kernel-defeated", end: combined.length },
  ];
}

/** The start frame of a plan entry's chapter (generated envelope or committed
 *  chapter). Exported for the plan-coverage invariant tests. */
export function segmentStart(chapterRef: string): number {
  if (chapterRef.startsWith("seg-")) {
    return (JSON.parse(readFileSync(join(ROOT, ".psp-segments", `${chapterRef}.json`), "utf8")) as { frame: number }).frame;
  }
  return loadChapters(ROOT).chapters.find((c) => c.id === chapterRef)!.frame;
}

export interface PlanWindow {
  id: string;
  chapter: string;
  start: number;
  end: number;
}

/** The plan resolved to concrete [start, end) frame windows. */
export function planWindows(plan: PlanEntry[]): PlanWindow[] {
  return plan.map((e) => ({ id: e.id, chapter: e.chapter, start: segmentStart(e.chapter), end: e.end }));
}

/** Independent invariants the actual mainline plan must satisfy: the pinned
 *  segment count, continuous coverage [0, EXPECTED_END_FRAME) with no gap or
 *  overlap, and every window has positive length. Returns the list of
 *  violations (empty = valid). This is independent of the plan's own
 *  self-report, so a deleted segment (which leaves a frame gap) is caught
 *  even though `verify` only walks the plan as given. */
export function validatePlan(windows: PlanWindow[]): string[] {
  const issues: string[] = [];
  if (windows.length !== EXPECTED_SEGMENTS) {
    issues.push(`plan has ${windows.length} segments, expected ${EXPECTED_SEGMENTS}`);
  }
  // Identity binding: segment ids must be unique and every entry must match
  // the fixed identity table (id, chapter, start, end) in order. This is
  // what stops a renamed segment from reusing another segment's evidence
  // directory while the plan still self-reports 28 segments.
  const seen = new Set<string>();
  for (const w of windows) {
    if (seen.has(w.id)) issues.push(`duplicate segment id ${w.id}`);
    seen.add(w.id);
  }
  for (let i = 0; i < Math.min(windows.length, EXPECTED_PLAN_IDENTITIES.length); i++) {
    const w = windows[i]!;
    const exp = EXPECTED_PLAN_IDENTITIES[i]!;
    if (w.id !== exp.id) issues.push(`segment ${i + 1} id is ${w.id}, expected ${exp.id}`);
    if (w.chapter !== exp.chapter) issues.push(`segment ${w.id} chapter is ${w.chapter}, expected ${exp.chapter}`);
    if (w.start !== exp.start) issues.push(`segment ${w.id} starts at ${w.start}, expected ${exp.start}`);
    if (w.end !== exp.end) issues.push(`segment ${w.id} ends at ${w.end}, expected ${exp.end}`);
  }
  if (windows.length === 0) return issues;
  if (windows[0]!.start !== 0) {
    issues.push(`plan starts at frame ${windows[0]!.start}, expected 0`);
  }
  for (let i = 1; i < windows.length; i++) {
    const prev = windows[i - 1]!;
    const cur = windows[i]!;
    if (cur.start !== prev.end) {
      issues.push(`gap/overlap between ${prev.id} (end ${prev.end}) and ${cur.id} (start ${cur.start})`);
    }
  }
  const last = windows[windows.length - 1]!;
  if (last.end !== EXPECTED_END_FRAME) {
    issues.push(`plan ends at frame ${last.end}, expected ${EXPECTED_END_FRAME}`);
  }
  for (const w of windows) {
    if (w.end <= w.start) {
      issues.push(`segment ${w.id} has non-positive length [${w.start}, ${w.end})`);
    }
  }
  return issues;
}

/** Assert the plan invariants, throwing on the first violation. Called by the
 *  CLI before plan/build/run/verify so a hand-edited plan cannot run. */
export function assertPlan(plan: PlanEntry[]): void {
  const issues = validatePlan(planWindows(plan));
  if (issues.length > 0) {
    throw new Error(`mainline plan is invalid:\n  ${issues.join("\n  ")}`);
  }
}

// Pure segment selection so the --only/--exclude filtering is testable.
export function selectSegments(plan: PlanEntry[], only?: string, exclude?: string): PlanEntry[] {
  return plan.filter((e) => (!only || e.id === only) && e.id !== exclude);
}

function run(cmd: string, args: string[], env: Record<string, string> = {}): number {
  const child = spawnSync(cmd, args, {
    cwd: ROOT,
    stdio: "inherit",
    env: { ...process.env, ...env },
    timeout: 600_000,
  });
  return child.status ?? -1;
}

// --- Aggregation (pure: testable without PPSSPP) ---------------------------

export interface SegmentVerdict {
  id: string;
  status: "PASS" | "FAIL";
  detail: string;
}

/** The bench window a segment run must cover. Host frame 0 restores the
 *  chapter save, frames 1..L replay the L suffix masks, so the single bench
 *  window the capture+bench segment build bakes is [0, L+1). A run whose
 *  bench does not cover this window is a failed run, not a partial one. */
export function expectedBenchWindow(frames: number): { start: number; n: number } {
  return { start: 0, n: frames + 1 };
}

/** Evaluate one segment run from its artifact directory. Every failure mode
 *  is a FAIL: missing receipt/PRX/profile/bench, PRX/receipt hash mismatch,
 *  non-zero emulator exit, verifier failure, or incomplete bench coverage. */
export function evaluateSegmentRun(opts: {
  dir: string;
  /** Emulator exit code (null = the process never started). */
  exitCode: number | null;
  /** Verifier exit code (null = not run, e.g. no profile was produced). */
  verifyStatus: number | null;
  verifyOutput: string;
}): SegmentVerdict {
  const id = basename(opts.dir);
  const fail = (detail: string): SegmentVerdict => ({ id, status: "FAIL", detail });
  const receiptPath = join(opts.dir, "build-receipt.json");
  if (!existsSync(receiptPath)) return fail("missing build receipt");
  const receipt = JSON.parse(readFileSync(receiptPath, "utf8")) as {
    journeySegment?: { frames?: number };
    artifacts?: Record<string, { sha256?: string }>;
  };
  const seg = receipt.journeySegment;
  if (!seg || typeof seg.frames !== "number") {
    return fail("receipt has no journeySegment block");
  }
  const prxPath = join(opts.dir, "pocket-tuxemon.prx");
  if (!existsSync(prxPath)) return fail("missing pocket-tuxemon.prx");
  const expectedPrx = receipt.artifacts?.["pocket-tuxemon.prx"]?.sha256;
  if (typeof expectedPrx !== "string" || sha256(readFileSync(prxPath)) !== expectedPrx) {
    return fail("PRX sha256 does not match the receipt artifact hash");
  }
  if (opts.exitCode !== 0) {
    return fail(`emulator exited ${opts.exitCode ?? "unknown"}`);
  }
  if (!existsSync(join(opts.dir, "profile.jsonl"))) {
    return fail("no profile (emulator exited 0)");
  }
  if (opts.verifyStatus !== 0) {
    return fail(opts.verifyOutput.trim() || "verifier failed");
  }
  const benchPath = join(opts.dir, "bench.jsonl");
  if (!existsSync(benchPath)) return fail("missing bench.jsonl");
  const windows = readFileSync(benchPath, "utf8").trim().split("\n").filter(Boolean)
    .map((line) => JSON.parse(line) as { app?: string; frames?: number; window_start?: number })
    .filter((w) => typeof w.app === "string");
  const expected = expectedBenchWindow(seg.frames);
  const covered = windows.reduce((sum, w) => sum + (w.frames ?? 0), 0);
  const ok = windows.length === 1
    && windows[0]!.window_start === expected.start
    && windows[0]!.frames === expected.n;
  if (!ok) {
    return fail(`bench coverage ${windows.length} window(s) covering ${covered} frames, ` +
      `expected one window [${expected.start}, ${expected.start + expected.n})`);
  }
  return { id, status: "PASS", detail: opts.verifyOutput.trim() };
}

/** A run is green iff every segment PASSed. */
export function aggregateRun(results: SegmentVerdict[]): number {
  return results.every((r) => r.status === "PASS") ? 0 : 1;
}

// --- Run-time artifact hygiene ---------------------------------------------
//
// The host writes its raw bench to `PocketJS-bench.jsonl` in host0: (the PRX
// directory, i.e. the segment dir). A previous run that only deleted the
// normalised `bench.jsonl` left that raw file behind, so a run which produced
// no bench of its own could still copy the stale raw bench forward and look
// green. Every run therefore starts by removing all three artifacts the
// emulator may leave, and only normalises a raw bench that THIS run produced.

export const SEGMENT_ARTIFACTS = {
  profile: "profile.jsonl",
  bench: "bench.jsonl",
  rawBench: "PocketJS-bench.jsonl",
} as const;

/** Remove every artifact a previous run may have left in the segment dir, so
 *  a run that produces no bench cannot reuse the old one. */
export function prepareSegmentArtifacts(dir: string): void {
  for (const name of Object.values(SEGMENT_ARTIFACTS)) {
    rmSync(join(dir, name), { force: true });
  }
}

/** After an emulator run, normalise the host's raw bench into bench.jsonl.
 *  Returns true when a bench from THIS run was collected. The raw file is
 *  removed either way so it cannot be picked up by a later run. */
export function collectSegmentBench(dir: string): boolean {
  const raw = join(dir, SEGMENT_ARTIFACTS.rawBench);
  if (existsSync(raw)) {
    writeFileSync(join(dir, SEGMENT_ARTIFACTS.bench), readFileSync(raw));
    rmSync(raw, { force: true });
    return true;
  }
  return false;
}

// --- Metrics (pure: testable without PPSSPP) --------------------------------

export interface SegMetrics {
  id: string;
  frames: number;
  windows: number;
  avgIntervalMs: number;
  maxWorkMs: number;
  arenaBumpMiB: number;
  arenaCapMiB: number;
  qjsPeakMiB: number;
  maps: number;
  battles: number;
  slowest: [number, number][];
  /** Host-forced QuickJS collections in the window (null when the bench
   *  predates the host's GC counters). */
  gcCount: number | null;
  gcTotalMs: number | null;
  /** The longest single collection: the GC pause a player would feel. */
  maxGcMs: number | null;
  /** QuickJS live request bytes at the end of the window. */
  qjsLiveMiB: number | null;
}

/** Recompute the per-segment metrics from the retained bench + profile. Both
 *  `report` (writes metrics.json) and `verify` (compares against it) use this,
 *  so a metrics.json that no longer recomputes from the raw files is caught. */
export function computeMetrics(out: string): SegMetrics[] {
  const dirs = readdirSync(out).filter((d) => existsSync(join(out, d, "bench.jsonl")));
  const metrics: SegMetrics[] = [];
  for (const id of dirs.sort()) {
    const lines = readFileSync(join(out, id, "bench.jsonl"), "utf8").trim().split("\n").filter(Boolean);
    const app = lines.filter((l) => l.includes('"app"')).map((l) => JSON.parse(l));
    const slow = lines.filter((l) => l.includes('"slowest_columns"'));
    const frames = app.reduce((s, w) => s + w.frames, 0);
    const avgInterval = app.reduce((s, w) => s + w.avg_frame_interval_us, 0) / Math.max(1, app.length);
    const maxWork = Math.max(0, ...app.map((w) => w.max_work_us));
    const arenaBump = Math.max(0, ...app.map((w) => w.arena_bump_bytes));
    const arenaCap = Math.max(0, ...app.map((w) => w.arena_capacity_bytes));
    const qjsPeak = Math.max(0, ...slow.map((l) => (JSON.parse(l).qjs_peak_bytes as number | undefined) ?? 0));
    const gc = slow.map((l) => JSON.parse(l) as {
      gc_count?: number;
      gc_us?: number;
      max_gc_us?: number;
      qjs_live_bytes?: number;
    }).filter((w) => typeof w.gc_count === "number");
    const slowest = slow
      .flatMap((l) => (JSON.parse(l).slowest as [number, number, number, number, number, number, number][]))
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3);
    let maps = 0;
    let battles = 0;
    const profilePath = join(out, id, "profile.jsonl");
    if (existsSync(profilePath)) {
      const entries = readFileSync(profilePath, "utf8").trim().split("\n").filter(Boolean)
        .map((l) => JSON.parse(l) as { kind?: string; type?: string });
      // A rerun appends a new session to the same profile; the metrics must
      // describe the NEWEST session only, never the events of an older run.
      const sessionIndex = entries.findLastIndex((e) => e.kind === "session");
      const scoped = sessionIndex >= 0 ? entries.slice(sessionIndex) : [];
      for (const e of scoped) {
        if (e.kind === "event" && e.type === "map") maps++;
        if (e.kind === "event" && e.type === "battle-enter") battles++;
      }
    }
    metrics.push({
      id,
      frames,
      windows: app.length,
      avgIntervalMs: avgInterval / 1000,
      maxWorkMs: maxWork / 1000,
      arenaBumpMiB: arenaBump / 1024 / 1024,
      arenaCapMiB: arenaCap / 1024 / 1024,
      qjsPeakMiB: qjsPeak / 1024 / 1024,
      maps,
      battles,
      slowest: slowest.map((s) => [s[0], Math.round(s[1] / 1000)]),
      gcCount: gc.length === 0 ? null : gc.reduce((s, w) => s + w.gc_count!, 0),
      gcTotalMs: gc.length === 0 ? null : gc.reduce((s, w) => s + (w.gc_us ?? 0), 0) / 1000,
      maxGcMs: gc.length === 0 ? null : Math.max(...gc.map((w) => w.max_gc_us ?? 0)) / 1000,
      qjsLiveMiB: gc.length === 0 ? null : (gc[gc.length - 1]!.qjs_live_bytes ?? 0) / 1024 / 1024,
    });
  }
  return metrics;
}

// --- Retained-evidence verification (pure: testable without PPSSPP) --------

export interface RetainedCheck {
  id: string;
  ok: boolean;
  issues: string[];
}

/** Check one retained segment directory against its receipt: the PRX hashes
 *  to the receipt's PRX artifact hash, the retained assets.pak hashes to the
 *  receipt's assets.pak artifact hash, the receipt is bound to the plan
 *  entry being verified (segment id, chapter, start frame, window length AND
 *  the end boundary: endFrame, terminalFrame), the profile's newest session
 *  belongs to the receipt's build/segment and its terminal (found only after
 *  that session, so an older complete session's terminal is never matched to
 *  a newer incomplete one) has the receipt's buildId, reached the receipt's
 *  frame count, carries a state that hashes byte-for-byte to the receipt's
 *  desktop terminal pin, and the bench window covers [0, frames+1). This is
 *  the artifacts ↔ receipt ↔ profile ↔ bench consistency gate for a segment. */
export function verifyRetainedSegment(opts: {
  dir: string;
  assetsPakPath: string;
  /** The plan entry this evidence must be bound to (id, chapter, start, end).
   *  When given, the receipt's segment id/chapter/startFrame/frames must
   *  match the plan entry exactly, the receipt's endFrame must equal the
   *  plan entry's end, and the receipt's terminalFrame must equal its
   *  endFrame, so one segment's evidence cannot be reused for another plan
   *  entry and a receipt with a tampered or stale end boundary cannot pass. */
  expected?: { id: string; chapter: string; start: number; end: number };
}): RetainedCheck {
  const id = basename(opts.dir);
  const issues: string[] = [];
  const receiptPath = join(opts.dir, "build-receipt.json");
  if (!existsSync(receiptPath)) {
    return { id, ok: false, issues: ["missing build receipt"] };
  }
  const receipt = JSON.parse(readFileSync(receiptPath, "utf8")) as {
    journeyBuildId?: string;
    journeySegment?: {
      chapter?: string; startFrame?: number; endFrame?: number; frames?: number;
      terminalFrame?: number; terminalSha256?: string;
    };
    artifacts?: Record<string, { sha256?: string }>;
  };
  const seg = receipt.journeySegment;
  if (!seg || typeof seg.frames !== "number") {
    issues.push("receipt has no journeySegment block");
  }
  // The desktop terminal pin is mandatory: without it the receipt cannot
  // prove which canonical state the PSP run must end in, so a matching
  // terminal cannot be verified at all.
  if (typeof seg?.terminalSha256 !== "string") {
    issues.push("receipt has no desktop terminal pin");
  }
  // Bind the receipt to the plan entry being verified: the evidence must
  // have been built for exactly this segment id, chapter and window, not
  // borrowed from another segment's internally consistent retention.
  if (opts.expected && id !== opts.expected.id) {
    issues.push(`segment directory ${id} != plan id ${opts.expected.id}`);
  }
  if (opts.expected && seg) {
    if (seg.chapter !== opts.expected.chapter) {
      issues.push(`receipt chapter ${String(seg.chapter)} != plan ${opts.expected.chapter}`);
    }
    if (seg.startFrame !== opts.expected.start) {
      issues.push(`receipt startFrame ${String(seg.startFrame)} != plan start ${opts.expected.start}`);
    }
    if (typeof seg.frames === "number" && seg.frames !== opts.expected.end - opts.expected.start) {
      issues.push(`receipt frames ${seg.frames} != plan window ${opts.expected.end - opts.expected.start}`);
    }
    // The end boundary is part of the binding: the receipt must end exactly
    // where the plan entry ends, its window length must equal
    // endFrame - startFrame, and the desktop terminal pin must sit on the
    // end frame. A receipt missing either field, or carrying a tampered or
    // stale one, must not pass.
    if (typeof seg.endFrame !== "number") {
      issues.push("receipt has no endFrame");
    } else if (seg.endFrame !== opts.expected.end) {
      issues.push(`receipt endFrame ${seg.endFrame} != plan end ${opts.expected.end}`);
    }
    if (typeof seg.terminalFrame !== "number") {
      issues.push("receipt has no terminalFrame");
    } else if (typeof seg.endFrame === "number" && seg.terminalFrame !== seg.endFrame) {
      issues.push(`receipt terminalFrame ${seg.terminalFrame} != endFrame ${seg.endFrame}`);
    }
    if (typeof seg.frames === "number" && typeof seg.startFrame === "number"
      && typeof seg.endFrame === "number"
      && seg.frames !== seg.endFrame - seg.startFrame) {
      issues.push(`receipt frames ${seg.frames} != endFrame - startFrame ${seg.endFrame - seg.startFrame}`);
    }
  }
  const prxPath = join(opts.dir, "pocket-tuxemon.prx");
  if (!existsSync(prxPath)) {
    issues.push("missing pocket-tuxemon.prx");
  } else {
    const expected = receipt.artifacts?.["pocket-tuxemon.prx"]?.sha256;
    if (typeof expected !== "string" || sha256(readFileSync(prxPath)) !== expected) {
      issues.push("PRX sha256 does not match the receipt");
    }
  }
  if (!existsSync(opts.assetsPakPath)) {
    issues.push("missing retained assets.pak");
  } else {
    const expected = receipt.artifacts?.["assets.pak"]?.sha256;
    if (typeof expected !== "string" || sha256(readFileSync(opts.assetsPakPath)) !== expected) {
      issues.push("assets.pak sha256 does not match the receipt");
    }
  }
  const profilePath = join(opts.dir, "profile.jsonl");
  if (!existsSync(profilePath)) {
    issues.push("missing profile.jsonl");
  } else if (seg && typeof seg.frames === "number") {
    const entries = readFileSync(profilePath, "utf8").trim().split("\n").filter(Boolean)
      .map((l) => JSON.parse(l) as {
        kind?: string; buildId?: string; segment?: string; frame?: number; state?: unknown;
      });
    const sessionIndex = entries.findLastIndex((e) => e.kind === "session");
    if (sessionIndex < 0) {
      issues.push("profile has no session marker");
    } else {
      const session = entries[sessionIndex]!;
      if (session.buildId !== receipt.journeyBuildId) {
        issues.push("profile session buildId != receipt journeyBuildId");
      }
      if (session.segment !== seg.chapter) {
        issues.push(`profile segment ${String(session.segment)} != receipt ${String(seg.chapter)}`);
      }
      // The terminal must belong to the NEWEST session. Searching the whole
      // profile would let an older complete session's terminal mask a newer
      // incomplete one (a crashed/timed-out rerun after a good run).
      const latest = entries.slice(sessionIndex);
      const terminal = latest.findLast((e) => e.kind === "terminal");
      if (!terminal) {
        issues.push("profile has no terminal marker");
      } else {
        if (terminal.buildId !== receipt.journeyBuildId) {
          issues.push("profile terminal buildId != receipt journeyBuildId");
        }
        if (terminal.frame !== seg.frames) {
          issues.push(`profile terminal frame ${String(terminal.frame)} != receipt frames ${seg.frames}`);
        }
        // The terminal state is mandatory and must hash byte-for-byte to the
        // receipt's desktop pin, so a terminal without a state payload, from
        // a different build or a diverged state cannot pass.
        if (terminal.state === undefined) {
          issues.push("profile terminal has no state");
        } else if (typeof seg?.terminalSha256 === "string"
            && sha256(canonicalJson(terminal.state)) !== seg.terminalSha256) {
          issues.push("profile terminal state does not match the receipt pin");
        }
      }
    }
  }
  const benchPath = join(opts.dir, "bench.jsonl");
  if (!existsSync(benchPath)) {
    issues.push("missing bench.jsonl");
  } else if (seg && typeof seg.frames === "number") {
    const windows = readFileSync(benchPath, "utf8").trim().split("\n").filter(Boolean)
      .map((l) => JSON.parse(l) as { app?: string; frames?: number; window_start?: number })
      .filter((w) => typeof w.app === "string");
    const expected = expectedBenchWindow(seg.frames);
    const ok = windows.length === 1
      && windows[0]!.window_start === expected.start
      && windows[0]!.frames === expected.n;
    if (!ok) {
      issues.push(`bench window does not cover [${expected.start}, ${expected.start + expected.n})`);
    }
  }
  return { id, ok: issues.length === 0, issues };
}

/** Issues that mean "the run started but did not finish" (a killed or
 *  timed-out run), as opposed to a broken or tampered retention. The
 *  --known-incomplete flag tolerates only these; any other issue (missing
 *  PRX/receipt/assets, hash mismatch, wrong build or segment, a truncated or
 *  stale bench window) still fails. */
const INCOMPLETE_ISSUE = /^(profile has no terminal marker|missing bench\.jsonl)$/;

export function isIncompleteOnly(issues: string[]): boolean {
  return issues.length > 0 && issues.every((i) => INCOMPLETE_ISSUE.test(i));
}

export interface VerifyArgs {
  knownIncomplete: string[];
}

/** Parse `verify` arguments. Both documented forms are accepted
 *  (`--known-incomplete=<id>` and `--known-incomplete <id>`, repeatable and
 *  mixable). Anything else throws: an empty id, a missing value, a value
 *  that looks like another option, or an unknown option. The caller validates
 *  the ids against the plan and rejects ids that actually completed. */
export function parseVerifyArgs(argv: string[]): VerifyArgs {
  const knownIncomplete: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith("--known-incomplete=")) {
      const id = a.slice("--known-incomplete=".length);
      if (id === "") throw new Error("--known-incomplete requires a non-empty segment id");
      knownIncomplete.push(id);
    } else if (a === "--known-incomplete") {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) {
        throw new Error("--known-incomplete requires a segment id");
      }
      knownIncomplete.push(next);
      i++;
    } else {
      throw new Error(`unknown option: ${a}`);
    }
  }
  return { knownIncomplete };
}

/** Compare recomputed metrics against the saved metrics.json. Returns the
 *  list of segment ids whose metrics drifted (empty = consistent). */
export function metricsDrift(savedPath: string, recomputed: SegMetrics[]): string[] {
  if (!existsSync(savedPath)) return ["<metrics.json missing>"];
  const saved = JSON.parse(readFileSync(savedPath, "utf8")) as SegMetrics[];
  const byId = new Map(saved.map((m) => [m.id, m]));
  const drifted: string[] = [];
  for (const m of recomputed) {
    const s = byId.get(m.id);
    if (!s || JSON.stringify(s) !== JSON.stringify(m)) drifted.push(m.id);
  }
  if (saved.length !== recomputed.length) {
    for (const s of saved) {
      if (!recomputed.some((m) => m.id === s.id)) drifted.push(s.id);
    }
  }
  return drifted;
}

// --- CLI -------------------------------------------------------------------

const command = process.argv[2];

if (import.meta.main) {
  if (command === "snapshots") {
    const envs = generateEnvelopes(ROOT, SPLIT_ENVELOPES, { write: true });
    for (const e of envs) {
      console.log(`${e.id} frame=${e.frame} map=${e.map} @${e.position.join(",")}`);
    }
    console.log(`SNAPSHOTS ${envs.length} generated`);
  } else if (command === "plan") {
    const plan = buildPlan();
    assertPlan(plan);
    let total = 0;
    for (const e of plan) {
      const start = segmentStart(e.chapter);
      const len = e.end - start;
      total += len;
      console.log(`${e.id} ${e.chapter} [${start}..${e.end}) ${len} frames`);
    }
    console.log(`PLAN ${plan.length} segments, ${total} frames total`);
  } else if (command === "build") {
    const plan = buildPlan();
    assertPlan(plan);
    const only = process.argv.find((a) => a.startsWith("--only="))?.slice("--only=".length);
    const llvm = process.env.POCKETJS_LLVM_BIN ?? "/usr/lib/llvm-18/bin";
    for (const e of plan) {
      if (only && e.id !== only) continue;
      console.log(`\n=== BUILD ${e.id} (${e.chapter} -> ${e.end}) ===`);
      const status = run("bun", ["run", "build:psp", "--skip-assets",
        `--journey-segment=${e.chapter}`, `--journey-segment-end=${e.end}`],
        { POCKETJS_LLVM_BIN: llvm });
      if (status !== 0) throw new Error(`build failed for ${e.id}`);
      // Stash the PRX + receipt per segment so the run command can run them in
      // parallel; assets.pak is retained content-addressed (a hardlink to the
      // sha256-named store entry, never an absolute symlink into dist/), so the
      // retained evidence is portable and does not follow later rebuilds.
      const dir = join(OUT, e.id);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "build-receipt.json"), readFileSync(join(PSP_OUT, "build-receipt.json")));
      writeFileSync(join(dir, "pocket-tuxemon.prx"), readFileSync(join(PSP_OUT, "pocket-tuxemon.prx")));
      retainArtifact(join(PSP_OUT, "assets.pak"), join(dir, "assets.pak"), join(OUT, "assets"), ".pak");
    }
    console.log(`\nBUILD ALL DONE`);
  } else if (command === "run") {
    const plan = buildPlan();
    assertPlan(plan);
    const only = process.argv.find((a) => a.startsWith("--only="))?.slice("--only=".length);
    const exclude = process.argv.find((a) => a.startsWith("--exclude="))?.slice("--exclude=".length);
    const jobs = Number(process.argv.find((a) => a.startsWith("--jobs="))?.slice("--jobs=".length) ?? "4");
    const headless = process.env.PPSSPP_HEADLESS ?? join(homedir(), "ppsspp-src/build/PPSSPPHeadless");
    if (!existsSync(headless)) throw new Error(`PPSSPPHeadless not found at ${headless}`);
    const selected = selectSegments(plan, only, exclude);
    // Core affinity sets: 4 instances x 8 cores on a 32-core machine.
    // PSP_AFFINITY (comma-separated) overrides the list so a separately
    // launched --only run can reserve its own set without contention.
    const affinity = (process.env.PSP_AFFINITY ?? "0-7,8-15,16-23,24-31").split(",");
    const timeout = Number(process.env.PSP_EMU_TIMEOUT ?? "600");
    // Isolated memstick root: env-overridable, task-local by default (never a
    // shared absolute path).
    const memstickRoot = process.env.PSP_MEMSTICK_ROOT ?? join(ROOT, ".psp-emu-memstick", "mainline");
    mkdirSync(OUT, { recursive: true });

    const results: SegmentVerdict[] = [];
    let wave = 0;
    for (let i = 0; i < selected.length; i += jobs) {
      const batch = selected.slice(i, i + jobs);
      wave++;
      console.log(`\n=== WAVE ${wave}: ${batch.map((e) => e.id).join(", ")} ===`);
      const procs = batch.map((e, j) => {
        const dir = join(OUT, e.id);
        mkdirSync(dir, { recursive: true });
        const memstick = join(memstickRoot, e.id);
        rmSync(memstick, { recursive: true, force: true });
        mkdirSync(memstick, { recursive: true });
        const prx = join(dir, "pocket-tuxemon.prx");
        if (!existsSync(prx)) {
          throw new Error(`missing PRX for ${e.id}; run: bun tools/psp-mainline.ts build --only=${e.id}`);
        }
        // Fail fast on a stale stash: the PRX must match its receipt.
        const receipt = JSON.parse(readFileSync(join(dir, "build-receipt.json"), "utf8")) as {
          artifacts?: Record<string, { sha256?: string }>;
        };
        if (sha256(readFileSync(prx)) !== receipt.artifacts?.["pocket-tuxemon.prx"]?.sha256) {
          throw new Error(`PRX/receipt hash mismatch for ${e.id}; rebuild this segment`);
        }
        // host0: maps to the PRX's directory, so profile/bench land in dir/.
        // Remove every artifact a previous run may have left — including the
        // host's raw PocketJS-bench.jsonl — so a run that produces no bench
        // cannot reuse the old one.
        prepareSegmentArtifacts(dir);
        const logFile = join(dir, "ppsspp.log");
        const args = [
          "nice", "-n", "10",
          "taskset", "-c", affinity[j % affinity.length]!,
          headless,
          "--graphics=software",
          `--timeout=${timeout}`,
          `--memstick=${memstick}`,
          prx,
        ];
        const out = Bun.spawn(args, {
          cwd: ROOT,
          stdout: Bun.file(logFile),
          stderr: "inherit",
          env: { ...process.env },
        });
        return { e, dir, out };
      });
      // Wait for the wave, then verify each segment against its stashed receipt.
      for (const p of procs) {
        const exitCode = await p.out.exited;
        // Normalise the host raw bench only when THIS run produced one.
        collectSegmentBench(p.dir);
        const profile = join(p.dir, SEGMENT_ARTIFACTS.profile);
        let verifyStatus: number | null = null;
        let verifyOutput = "";
        if (existsSync(profile)) {
          // Verify against the stashed receipt: copy it into dist/psp so the
          // verifier reads the right journeySegment block.
          writeFileSync(join(PSP_OUT, "build-receipt.json"), readFileSync(join(p.dir, "build-receipt.json")));
          const verify = spawnSync(process.execPath, [join(ROOT, "tools/verify-psp-journey.ts"), profile,
            `--prx=${join(p.dir, "pocket-tuxemon.prx")}`], {
            cwd: ROOT,
            stdio: ["ignore", "pipe", "pipe"],
            env: { ...process.env },
          });
          verifyStatus = verify.status;
          verifyOutput = ((verify.stdout?.toString() ?? "") + (verify.stderr?.toString() ?? "")).trim();
        }
        results.push(evaluateSegmentRun({
          dir: p.dir,
          exitCode,
          verifyStatus,
          verifyOutput,
        }));
      }
      console.log(`wave ${wave} done`);
    }
    console.log("\n=== RESULTS ===");
    for (const r of results) console.log(`${r.status} ${r.id} ${r.detail}`);
    const passed = results.filter((r) => r.status === "PASS").length;
    const failed = results.filter((r) => r.status === "FAIL");
    console.log(`\n${passed}/${results.length} segments PASS`);
    if (failed.length > 0) {
      console.log(`FAILED: ${failed.map((r) => r.id).join(", ")}`);
    }
    writeFileSync(join(OUT, "run-results.json"), JSON.stringify(results, null, 2) + "\n");
    process.exit(aggregateRun(results));
  } else if (command === "report") {
    const metrics = computeMetrics(OUT);
    const mib = (n: number) => n.toFixed(1);
    const opt = (n: number | null, digits: number) => n === null ? "-" : n.toFixed(digits);
    console.log("| Segment | Frames | Avg ms | MaxWork ms | Arena MiB | QJS peak MiB | Maps | Battles | GCs | GC total ms | Max GC ms |");
    console.log("| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |");
    for (const m of metrics) {
      console.log(`| ${m.id} | ${m.frames} | ${m.avgIntervalMs.toFixed(1)} | ${m.maxWorkMs.toFixed(0)} | ${mib(m.arenaBumpMiB)}/${mib(m.arenaCapMiB)} | ${mib(m.qjsPeakMiB)} | ${m.maps} | ${m.battles} | ${opt(m.gcCount, 0)} | ${opt(m.gcTotalMs, 1)} | ${opt(m.maxGcMs, 1)} |`);
    }
    const totalFrames = metrics.reduce((s, m) => s + m.frames, 0);
    const totalBattles = metrics.reduce((s, m) => s + m.battles, 0);
    const maxArena = Math.max(...metrics.map((m) => m.arenaBumpMiB));
    const maxQjs = Math.max(...metrics.map((m) => m.qjsPeakMiB));
    console.log(`\nTOTAL: ${totalFrames} frames, ${totalBattles} battles, arena high-water ${mib(maxArena)} MiB, QJS peak ${mib(maxQjs)} MiB`);
    const withGc = metrics.filter((m) => m.gcCount !== null);
    if (withGc.length > 0) {
      const gcs = withGc.reduce((s, m) => s + m.gcCount!, 0);
      const gcMs = withGc.reduce((s, m) => s + m.gcTotalMs!, 0);
      const worst = withGc.reduce((a, b) => (b.maxGcMs! > a.maxGcMs! ? b : a));
      console.log(`GC: ${gcs} collections, ${gcMs.toFixed(1)} ms total, longest ${worst.maxGcMs!.toFixed(1)} ms (${worst.id}) over ${withGc.length} segment(s)`);
    }
    writeFileSync(join(OUT, "metrics.json"), JSON.stringify(metrics, null, 2) + "\n");
  } else if (command === "verify") {
    // Four-way consistency gate: retained artifacts (PRX + assets.pak) match
    // their receipts, the profile belongs to the receipt's build/segment and
    // reached its frame count, the bench window covers [0, frames+1), and
    // metrics.json recomputes from the benches. Run after `run` + `report`.
    //
    // --known-incomplete=<id> or --known-incomplete <id> (repeatable)
    // tolerates a segment that ran but did not finish (killed/timed out: no
    // terminal marker and/or no bench): it is reported INCOMPLETE with its
    // issues instead of failing the gate. Every other issue still fails, and
    // without the flag an incomplete segment fails the whole run. An empty
    // id, an id outside the plan, an id whose evidence actually completed,
    // or any unknown option is an error.
    let args: VerifyArgs;
    try {
      args = parseVerifyArgs(process.argv.slice(3));
    } catch (err) {
      console.error(`verify: ${(err as Error).message}`);
      console.error("usage: bun tools/psp-mainline.ts verify [--known-incomplete=<id>]...");
      process.exit(2);
    }
    const plan = buildPlan();
    assertPlan(plan);
    const planIds = new Set(plan.map((e) => e.id));
    for (const id of args.knownIncomplete) {
      if (!planIds.has(id)) {
        console.error(`verify: unknown segment id '${id}' (not in the ${plan.length}-segment plan)`);
        process.exit(2);
      }
    }
    const knownIncomplete = new Set(args.knownIncomplete);
    let failed = 0;
    const incompleteIds: string[] = [];
    const completedButFlagged: string[] = [];
    for (const e of plan) {
      const dir = join(OUT, e.id);
      if (!existsSync(dir)) {
        console.log(`MISSING ${e.id}`);
        failed++;
        continue;
      }
      const check = verifyRetainedSegment({
        dir,
        assetsPakPath: join(dir, "assets.pak"),
        expected: { id: e.id, chapter: e.chapter, start: segmentStart(e.chapter), end: e.end },
      });
      if (check.ok) {
        console.log(`OK ${e.id}`);
        if (knownIncomplete.has(e.id)) completedButFlagged.push(e.id);
      } else if (knownIncomplete.has(e.id) && isIncompleteOnly(check.issues)) {
        console.log(`INCOMPLETE ${e.id}: ${check.issues.join("; ")}`);
        incompleteIds.push(e.id);
      } else {
        console.log(`FAIL ${e.id}: ${check.issues.join("; ")}`);
        failed++;
      }
    }
    if (completedButFlagged.length > 0) {
      console.error(`FAIL: --known-incomplete names segment(s) that actually completed: `
        + `${completedButFlagged.join(", ")} (drop the flag; the exemption is only for unfinished runs)`);
      process.exit(1);
    }
    const drift = metricsDrift(join(OUT, "metrics.json"), computeMetrics(OUT));
    if (drift.length > 0) {
      console.log(`METRICS DRIFT: ${drift.join(", ")}`);
      failed++;
    } else {
      console.log("METRICS consistent with benches");
    }
    if (failed > 0) process.exit(1);
    const known = incompleteIds.length > 0
      ? ` (${incompleteIds.length} INCOMPLETE: ${incompleteIds.join(", ")})`
      : "";
    const done = plan.length - incompleteIds.length;
    console.log(`VERIFY PASS: ${done}/${done} segments PASS${known}`);
  } else {
    console.error("usage: bun tools/psp-mainline.ts <snapshots|plan|build|run|report|verify>");
    process.exit(1);
  }
}
