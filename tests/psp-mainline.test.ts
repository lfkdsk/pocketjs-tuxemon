// Tests for the full-mainline PSP segment runner (tools/psp-mainline.ts):
// the aggregator must never swallow a failure — a missing bench, an
// incomplete bench window, a non-zero emulator exit, a verifier FAIL or a
// PRX/receipt hash mismatch all fail the segment, and any failed segment
// fails the whole run. These run without PPSSPP: the per-segment evaluation
// is a pure function over the segment's artifact directory.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, basename } from "node:path";
import { createHash } from "node:crypto";

import {
  aggregateRun,
  buildPlan,
  collectSegmentBench,
  computeMetrics,
  evaluateSegmentRun,
  expectedBenchWindow,
  EXPECTED_END_FRAME,
  EXPECTED_PLAN_IDENTITIES,
  EXPECTED_SEGMENTS,
  isIncompleteOnly,
  metricsDrift,
  parseVerifyArgs,
  planWindows,
  prepareSegmentArtifacts,
  segmentStart,
  selectSegments,
  SEGMENT_ARTIFACTS,
  SPLIT_ENVELOPES,
  validatePlan,
  verifyRetainedSegment,
  ROOT,
} from "../tools/psp-mainline.ts";
import { generateEnvelopes } from "../tools/psp-segment.ts";
import { canonicalJson } from "../vendor/pocket-rpgkit/src/engine/save.ts";

const sha256 = (bytes: Uint8Array | string): string =>
  createHash("sha256").update(bytes).digest("hex");

// The terminal state the PSP run ends in; the receipt's terminalSha256 pin is
// the canonical-JSON hash of the same state, as a real receipt carries.
const TERMINAL_STATE = {};
const TERMINAL_PIN = sha256(canonicalJson(TERMINAL_STATE));

const TMP = join(ROOT, ".psp-test-tmp");
const dirs: string[] = [];
// The suite creates its own temp root (a clean checkout has no .psp-test-tmp)
// and removes it on exit so repeated runs start clean.
beforeAll(() => {
  mkdirSync(TMP, { recursive: true });
  // The real plan reads the generated envelopes from .psp-segments/ (a
  // gitignored desktop-replay product); regenerate them on a clean checkout.
  // The replay takes ~9 s, well above bun's 5 s default hook timeout.
  const missing = SPLIT_ENVELOPES.some((e) => !existsSync(join(ROOT, ".psp-segments", `${e.id}.json`)));
  if (missing) generateEnvelopes(ROOT, SPLIT_ENVELOPES, { write: true });
}, 60_000);
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  rmSync(TMP, { recursive: true, force: true });
});

function makeSegmentDir(
  files: Record<string, string | Uint8Array>,
): string {
  const dir = mkdtempSync(join(TMP, "seg-"));
  dirs.push(dir);
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(dir, name), content);
  }
  return dir;
}

const PRX_BYTES = new TextEncoder().encode("FAKE-PRX-FOR-TESTS");
const PROFILE = [
  JSON.stringify({ kind: "session", buildId: "b", segment: "radio-broadcast" }),
  JSON.stringify({ kind: "abi", passed: true, buildId: "b" }),
  JSON.stringify({ kind: "terminal", frame: 23, state: TERMINAL_STATE, buildId: "b" }),
].join("\n") + "\n";

/** A receipt whose journeySegment and PRX artifact hash are consistent. */
function receipt(frames = 23): string {
  return JSON.stringify({
    target: "psp",
    journey: true,
    journeyBuildId: "b",
    journeySegment: {
      chapter: "radio-broadcast",
      generated: false,
      startFrame: 185779,
      endFrame: 185779 + frames,
      frames,
      snapshotSha256: "0".repeat(64),
      tapeSha256: "0".repeat(64),
      terminalSha256: TERMINAL_PIN,
      endMap: "spyder_radiotower",
      endPosition: [9, 5],
      terminalFrame: 185779 + frames,
      envelope: {
        id: "radio-broadcast",
        frame: 185779,
        timelineFrame: 185779,
        held: 0,
        map: "spyder_radiotower",
        position: [9, 5],
        snapshot: "",
      },
    },
    artifacts: {
      "pocket-tuxemon.prx": { bytes: PRX_BYTES.length, sha256: sha256(PRX_BYTES) },
    },
  });
}

/** A bench JSONL whose single app window covers [0, frames+1). */
function bench(frames = 23): string {
  const { start, n } = expectedBenchWindow(frames);
  return [
    JSON.stringify({ app: "pocket-tuxemon", frames: n, window_start: start, window_n: n }),
    JSON.stringify({ window_start: start, slowest_columns: [], slowest: [] }),
  ].join("\n") + "\n";
}

function completeSegment(extra: Record<string, string | Uint8Array> = {}): string {
  return makeSegmentDir({
    "build-receipt.json": receipt(),
    "pocket-tuxemon.prx": PRX_BYTES,
    "profile.jsonl": PROFILE,
    "bench.jsonl": bench(),
    ...extra,
  });
}

const PASS_DETAIL = "PSP SEGMENT PASS segment=radio-broadcast frames=23";

describe("PSP mainline expected bench window", () => {
  test("the window covers the boot frame plus every suffix frame", () => {
    // Host frame 0 restores the chapter save; frames 1..L replay the L suffix
    // masks, so the single bench window must span [0, L+1).
    expect(expectedBenchWindow(23)).toEqual({ start: 0, n: 24 });
    expect(expectedBenchWindow(14626)).toEqual({ start: 0, n: 14627 });
  });
});

describe("PSP mainline segment selection", () => {
  const plan = [
    { id: "01-a", chapter: "a", end: 10 },
    { id: "02-b", chapter: "b", end: 20 },
    { id: "03-c", chapter: "c", end: 30 },
  ];
  test("no filter keeps every segment", () => {
    expect(selectSegments(plan).map((e) => e.id)).toEqual(["01-a", "02-b", "03-c"]);
  });
  test("--only keeps just that segment", () => {
    expect(selectSegments(plan, "02-b").map((e) => e.id)).toEqual(["02-b"]);
  });
  test("--exclude drops just that segment", () => {
    expect(selectSegments(plan, undefined, "02-b").map((e) => e.id)).toEqual(["01-a", "03-c"]);
  });
  test("--only and --exclude together yield nothing when they collide", () => {
    expect(selectSegments(plan, "02-b", "02-b")).toEqual([]);
  });
});

describe("PSP mainline segment evaluation", () => {
  test("a complete run passes", () => {
    const dir = completeSegment();
    const v = evaluateSegmentRun({ dir, exitCode: 0, verifyStatus: 0, verifyOutput: PASS_DETAIL });
    expect(v.status).toBe("PASS");
    expect(v.detail).toBe(PASS_DETAIL);
  });

  test("a missing bench fails the segment", () => {
    const dir = completeSegment();
    rmSync(join(dir, "bench.jsonl"));
    const v = evaluateSegmentRun({ dir, exitCode: 0, verifyStatus: 0, verifyOutput: PASS_DETAIL });
    expect(v.status).toBe("FAIL");
    expect(v.detail).toMatch(/bench/);
  });

  test("a bench that does not cover the whole segment fails", () => {
    // The pre-fix build logged rotating 300-frame windows and lost the tail.
    const dir = completeSegment({
      "bench.jsonl": [
        JSON.stringify({ app: "pocket-tuxemon", frames: 300, window_start: 0, window_n: 300 }),
        JSON.stringify({ app: "pocket-tuxemon", frames: 300, window_start: 300, window_n: 300 }),
      ].join("\n") + "\n",
    });
    const v = evaluateSegmentRun({ dir, exitCode: 0, verifyStatus: 0, verifyOutput: PASS_DETAIL });
    expect(v.status).toBe("FAIL");
    expect(v.detail).toMatch(/bench coverage/);
  });

  test("a bench window of the wrong length fails", () => {
    const dir = completeSegment({
      "bench.jsonl": [
        JSON.stringify({ app: "pocket-tuxemon", frames: 23, window_start: 0, window_n: 23 }),
      ].join("\n") + "\n",
    });
    const v = evaluateSegmentRun({ dir, exitCode: 0, verifyStatus: 0, verifyOutput: PASS_DETAIL });
    expect(v.status).toBe("FAIL");
    expect(v.detail).toMatch(/bench coverage/);
  });

  test("a bench window longer than the segment fails", () => {
    // The expected window is [0, frames+1) = [0, 24). A window that covers
    // more (e.g. a stale window from a longer run) must not be accepted by a
    // >= comparison; only an exact-length window passes.
    const dir = completeSegment({
      "bench.jsonl": [
        JSON.stringify({ app: "pocket-tuxemon", frames: 25, window_start: 0, window_n: 25 }),
      ].join("\n") + "\n",
    });
    const v = evaluateSegmentRun({ dir, exitCode: 0, verifyStatus: 0, verifyOutput: PASS_DETAIL });
    expect(v.status).toBe("FAIL");
    expect(v.detail).toMatch(/bench coverage/);
  });

  test("a non-zero emulator exit fails even with a profile and passing verifier", () => {
    const dir = completeSegment();
    const v = evaluateSegmentRun({ dir, exitCode: 1, verifyStatus: 0, verifyOutput: PASS_DETAIL });
    expect(v.status).toBe("FAIL");
    expect(v.detail).toMatch(/exit|signal|emulator/i);
  });

  test("a missing profile fails", () => {
    const dir = completeSegment();
    rmSync(join(dir, "profile.jsonl"));
    const v = evaluateSegmentRun({ dir, exitCode: 0, verifyStatus: null, verifyOutput: "" });
    expect(v.status).toBe("FAIL");
    expect(v.detail).toMatch(/profile/);
  });

  test("a verifier FAIL fails the segment", () => {
    const dir = completeSegment();
    const v = evaluateSegmentRun({
      dir,
      exitCode: 0,
      verifyStatus: 1,
      verifyOutput: "Error: PSP terminal snapshot diverged",
    });
    expect(v.status).toBe("FAIL");
    expect(v.detail).toMatch(/diverged/);
  });

  test("a PRX that does not match its receipt fails", () => {
    const dir = completeSegment({ "pocket-tuxemon.prx": new TextEncoder().encode("TAMPERED-PRX") });
    const v = evaluateSegmentRun({ dir, exitCode: 0, verifyStatus: 0, verifyOutput: PASS_DETAIL });
    expect(v.status).toBe("FAIL");
    expect(v.detail).toMatch(/prx|artifact/i);
  });

  test("a missing receipt fails", () => {
    const dir = completeSegment();
    rmSync(join(dir, "build-receipt.json"));
    const v = evaluateSegmentRun({ dir, exitCode: 0, verifyStatus: 0, verifyOutput: PASS_DETAIL });
    expect(v.status).toBe("FAIL");
    expect(v.detail).toMatch(/receipt/i);
  });
});

describe("PSP mainline aggregation", () => {
  test("all-pass exits zero", () => {
    const dir = completeSegment();
    const results = [
      evaluateSegmentRun({ dir, exitCode: 0, verifyStatus: 0, verifyOutput: PASS_DETAIL }),
    ];
    expect(aggregateRun(results)).toBe(0);
  });

  test("any failure exits non-zero and keeps the failing segment id", () => {
    const good = completeSegment();
    const bad = completeSegment();
    rmSync(join(bad, "bench.jsonl"));
    const results = [
      evaluateSegmentRun({ dir: good, exitCode: 0, verifyStatus: 0, verifyOutput: PASS_DETAIL }),
      evaluateSegmentRun({ dir: bad, exitCode: 0, verifyStatus: 0, verifyOutput: PASS_DETAIL }),
    ];
    expect(aggregateRun(results)).toBe(1);
    const failed = results.filter((r) => r.status === "FAIL");
    expect(failed).toHaveLength(1);
    expect(existsSync(join(bad, "build-receipt.json"))).toBe(true);
  });
});

describe("PSP mainline run-time artifact hygiene", () => {
  // The round-3 review found the orchestrator deleted bench.jsonl but not the
  // host's raw PocketJS-bench.jsonl, so a run that produced no bench could
  // copy the stale raw bench forward and look green.

  test("prepareSegmentArtifacts removes the profile, bench and host raw bench", () => {
    const dir = completeSegment();
    // A previous run left its host raw bench behind.
    writeFileSync(join(dir, SEGMENT_ARTIFACTS.rawBench), bench());
    for (const name of Object.values(SEGMENT_ARTIFACTS)) {
      expect(existsSync(join(dir, name))).toBe(true);
    }
    prepareSegmentArtifacts(dir);
    for (const name of Object.values(SEGMENT_ARTIFACTS)) {
      expect(existsSync(join(dir, name))).toBe(false);
    }
  });

  test("a stale raw bench is not reused when this run produces none", () => {
    const dir = completeSegment();
    // Pre-seed the leftovers a previous run would leave, including the host's
    // raw bench — the file the pre-fix orchestrator forgot to delete.
    writeFileSync(join(dir, SEGMENT_ARTIFACTS.rawBench), bench());
    writeFileSync(join(dir, SEGMENT_ARTIFACTS.bench), bench());
    writeFileSync(join(dir, SEGMENT_ARTIFACTS.profile), PROFILE);
    // This run starts clean: all three artifacts are removed first.
    prepareSegmentArtifacts(dir);
    // The emulator produced a profile (it ran) but no bench of its own.
    writeFileSync(join(dir, SEGMENT_ARTIFACTS.profile), PROFILE);
    expect(collectSegmentBench(dir)).toBe(false);
    expect(existsSync(join(dir, SEGMENT_ARTIFACTS.bench))).toBe(false);
    // The segment must FAIL on the missing bench, and the aggregate with it.
    const v = evaluateSegmentRun({ dir, exitCode: 0, verifyStatus: 0, verifyOutput: PASS_DETAIL });
    expect(v.status).toBe("FAIL");
    expect(v.detail).toMatch(/bench/);
    expect(aggregateRun([v])).toBe(1);
  });

  test("collectSegmentBench normalises a fresh raw bench and removes it", () => {
    const dir = completeSegment();
    rmSync(join(dir, "bench.jsonl"));
    writeFileSync(join(dir, SEGMENT_ARTIFACTS.rawBench), bench());
    expect(collectSegmentBench(dir)).toBe(true);
    expect(readFileSync(join(dir, "bench.jsonl"), "utf8")).toBe(bench());
    expect(existsSync(join(dir, SEGMENT_ARTIFACTS.rawBench))).toBe(false);
    const v = evaluateSegmentRun({ dir, exitCode: 0, verifyStatus: 0, verifyOutput: PASS_DETAIL });
    expect(v.status).toBe("PASS");
  });
});

describe("PSP mainline retained-evidence verification", () => {
  // The four-way consistency gate: retained PRX + assets.pak match their
  // receipt, the profile belongs to the receipt's build/segment and reached
  // its frame count, and the bench window covers [0, frames+1).

  const ASSETS = new TextEncoder().encode("FAKE-ASSETS-PAK");

  function retainedReceipt(frames = 23): string {
    const r = JSON.parse(receipt(frames)) as {
      artifacts: Record<string, { bytes: number; sha256: string }>;
    };
    r.artifacts["assets.pak"] = { bytes: ASSETS.length, sha256: sha256(ASSETS) };
    return JSON.stringify(r);
  }

  function retainedSegment(extra: Record<string, string | Uint8Array> = {}): { dir: string; assets: string } {
    const dir = mkdtempSync(join(TMP, "ret-"));
    dirs.push(dir);
    const assets = join(dir, "assets.pak");
    writeFileSync(assets, ASSETS);
    writeFileSync(join(dir, "build-receipt.json"), retainedReceipt());
    writeFileSync(join(dir, "pocket-tuxemon.prx"), PRX_BYTES);
    writeFileSync(join(dir, "profile.jsonl"), PROFILE);
    writeFileSync(join(dir, "bench.jsonl"), bench());
    for (const [name, content] of Object.entries(extra)) {
      writeFileSync(join(dir, name), content);
    }
    return { dir, assets };
  }

  test("a consistent retained segment passes", () => {
    const { dir, assets } = retainedSegment();
    const check = verifyRetainedSegment({ dir, assetsPakPath: assets });
    expect(check.ok).toBe(true);
    expect(check.issues).toEqual([]);
  });

  test("a missing receipt fails", () => {
    const { dir, assets } = retainedSegment();
    rmSync(join(dir, "build-receipt.json"));
    const check = verifyRetainedSegment({ dir, assetsPakPath: assets });
    expect(check.ok).toBe(false);
    expect(check.issues.join(" ")).toMatch(/receipt/);
  });

  test("a PRX that does not match the receipt fails", () => {
    const { dir, assets } = retainedSegment({ "pocket-tuxemon.prx": new TextEncoder().encode("TAMPERED") });
    const check = verifyRetainedSegment({ dir, assetsPakPath: assets });
    expect(check.ok).toBe(false);
    expect(check.issues.join(" ")).toMatch(/PRX/);
  });

  test("an assets.pak that does not match the receipt fails", () => {
    const { dir, assets } = retainedSegment();
    writeFileSync(assets, new TextEncoder().encode("TAMPERED-ASSETS"));
    const check = verifyRetainedSegment({ dir, assetsPakPath: assets });
    expect(check.ok).toBe(false);
    expect(check.issues.join(" ")).toMatch(/assets.pak/);
  });

  test("a profile from a different build fails", () => {
    const { dir, assets } = retainedSegment({
      "profile.jsonl": [
        JSON.stringify({ kind: "session", buildId: "deadbeef", segment: "radio-broadcast" }),
        JSON.stringify({ kind: "abi", passed: true, buildId: "deadbeef" }),
        JSON.stringify({ kind: "terminal", frame: 23, state: {}, buildId: "deadbeef" }),
      ].join("\n") + "\n",
    });
    const check = verifyRetainedSegment({ dir, assetsPakPath: assets });
    expect(check.ok).toBe(false);
    expect(check.issues.join(" ")).toMatch(/buildId/);
  });

  test("a profile from a different segment fails", () => {
    const { dir, assets } = retainedSegment({
      "profile.jsonl": [
        JSON.stringify({ kind: "session", buildId: "b", segment: "paper-town" }),
        JSON.stringify({ kind: "abi", passed: true, buildId: "b" }),
        JSON.stringify({ kind: "terminal", frame: 23, state: {}, buildId: "b" }),
      ].join("\n") + "\n",
    });
    const check = verifyRetainedSegment({ dir, assetsPakPath: assets });
    expect(check.ok).toBe(false);
    expect(check.issues.join(" ")).toMatch(/segment/);
  });

  test("a profile that ended early fails", () => {
    const { dir, assets } = retainedSegment({
      "profile.jsonl": [
        JSON.stringify({ kind: "session", buildId: "b", segment: "radio-broadcast" }),
        JSON.stringify({ kind: "abi", passed: true, buildId: "b" }),
        JSON.stringify({ kind: "terminal", frame: 22, state: TERMINAL_STATE, buildId: "b" }),
      ].join("\n") + "\n",
    });
    const check = verifyRetainedSegment({ dir, assetsPakPath: assets });
    expect(check.ok).toBe(false);
    expect(check.issues.join(" ")).toMatch(/terminal frame/);
  });

  test("an old complete session's terminal is not matched to a newer incomplete session", () => {
    // A good run (session + terminal) followed by a rerun of the same
    // build/segment that crashed before its terminal. The verifier must bind
    // the terminal to the NEWEST session and report the missing terminal,
    // not borrow the old session's terminal and call the segment complete.
    const { dir, assets } = retainedSegment({
      "profile.jsonl": [
        JSON.stringify({ kind: "session", buildId: "b", segment: "radio-broadcast" }),
        JSON.stringify({ kind: "abi", passed: true, buildId: "b" }),
        JSON.stringify({ kind: "terminal", frame: 23, state: TERMINAL_STATE, buildId: "b" }),
        JSON.stringify({ kind: "session", buildId: "b", segment: "radio-broadcast" }),
        JSON.stringify({ kind: "abi", passed: true, buildId: "b" }),
      ].join("\n") + "\n",
    });
    const check = verifyRetainedSegment({ dir, assetsPakPath: assets });
    expect(check.ok).toBe(false);
    expect(check.issues.join(" ")).toMatch(/no terminal marker/);
  });

  test("a terminal from a different build fails", () => {
    // The newest session is build "b" but its terminal is stamped with a
    // different buildId: the terminal must be checked, not just the session.
    const { dir, assets } = retainedSegment({
      "profile.jsonl": [
        JSON.stringify({ kind: "session", buildId: "b", segment: "radio-broadcast" }),
        JSON.stringify({ kind: "abi", passed: true, buildId: "b" }),
        JSON.stringify({ kind: "terminal", frame: 23, state: TERMINAL_STATE, buildId: "deadbeef" }),
      ].join("\n") + "\n",
    });
    const check = verifyRetainedSegment({ dir, assetsPakPath: assets });
    expect(check.ok).toBe(false);
    expect(check.issues.join(" ")).toMatch(/terminal buildId/);
  });

  test("a terminal whose state does not hash to the receipt pin fails", () => {
    // The terminal frame/build match but the state is not the receipt's
    // desktop pin: a diverged or borrowed terminal must not pass.
    const { dir, assets } = retainedSegment({
      "profile.jsonl": [
        JSON.stringify({ kind: "session", buildId: "b", segment: "radio-broadcast" }),
        JSON.stringify({ kind: "abi", passed: true, buildId: "b" }),
        JSON.stringify({ kind: "terminal", frame: 23, state: { mapId: "somewhere-else" }, buildId: "b" }),
      ].join("\n") + "\n",
    });
    const check = verifyRetainedSegment({ dir, assetsPakPath: assets });
    expect(check.ok).toBe(false);
    expect(check.issues.join(" ")).toMatch(/terminal state/);
  });

  test("a receipt without a desktop terminal pin fails", () => {
    // The pin is mandatory: a receipt that omits terminalSha256 cannot prove
    // which desktop state the PSP run must match, so the segment must fail
    // even when a terminal with a state is present.
    const { dir, assets } = retainedSegment();
    const r = JSON.parse(readFileSync(join(dir, "build-receipt.json"), "utf8")) as {
      journeySegment: Record<string, unknown>;
    };
    delete r.journeySegment.terminalSha256;
    writeFileSync(join(dir, "build-receipt.json"), JSON.stringify(r));
    const check = verifyRetainedSegment({ dir, assetsPakPath: assets });
    expect(check.ok).toBe(false);
    expect(check.issues.join(" ")).toMatch(/terminal pin/);
  });

  test("a terminal without state fails", () => {
    // A terminal marker without a state payload cannot be compared to the
    // desktop pin; it must not be treated as a complete terminal.
    const { dir, assets } = retainedSegment({
      "profile.jsonl": [
        JSON.stringify({ kind: "session", buildId: "b", segment: "radio-broadcast" }),
        JSON.stringify({ kind: "abi", passed: true, buildId: "b" }),
        JSON.stringify({ kind: "terminal", frame: 23, buildId: "b" }),
      ].join("\n") + "\n",
    });
    const check = verifyRetainedSegment({ dir, assetsPakPath: assets });
    expect(check.ok).toBe(false);
    expect(check.issues.join(" ")).toMatch(/terminal.*state/);
  });

  test("a bench window that does not cover the segment fails", () => {
    const { dir, assets } = retainedSegment({
      "bench.jsonl": [
        JSON.stringify({ app: "pocket-tuxemon", frames: 23, window_start: 0, window_n: 23 }),
      ].join("\n") + "\n",
    });
    const check = verifyRetainedSegment({ dir, assetsPakPath: assets });
    expect(check.ok).toBe(false);
    expect(check.issues.join(" ")).toMatch(/bench window/);
  });

  // The plan binding covers the END boundary too, not just chapter/start:
  // the receipt's endFrame must equal the plan entry's end, its window
  // length must equal endFrame - startFrame, its terminalFrame must equal
  // endFrame, and the segment directory must be the plan entry's id. These
  // are the fix-6 regressions: before the fix the verifier ignored all
  // four and accepted end-frame-tampered or mislabelled receipts.

  const PLAN_END = 185779 + 23;

  function boundExpected(dir: string) {
    return { id: basename(dir), chapter: "radio-broadcast", start: 185779, end: PLAN_END };
  }

  test("a receipt bound to its plan entry passes", () => {
    const { dir, assets } = retainedSegment();
    const check = verifyRetainedSegment({ dir, assetsPakPath: assets, expected: boundExpected(dir) });
    expect(check.ok).toBe(true);
    expect(check.issues).toEqual([]);
  });

  test("a receipt whose endFrame does not match the plan end fails", () => {
    const { dir, assets } = retainedSegment();
    const r = JSON.parse(readFileSync(join(dir, "build-receipt.json"), "utf8")) as {
      journeySegment: { endFrame: number };
    };
    r.journeySegment.endFrame += 1;
    writeFileSync(join(dir, "build-receipt.json"), JSON.stringify(r));
    const check = verifyRetainedSegment({ dir, assetsPakPath: assets, expected: boundExpected(dir) });
    expect(check.ok).toBe(false);
    expect(check.issues.join(" ")).toMatch(/endFrame/);
  });

  test("a receipt whose terminalFrame does not match endFrame fails", () => {
    const { dir, assets } = retainedSegment();
    const r = JSON.parse(readFileSync(join(dir, "build-receipt.json"), "utf8")) as {
      journeySegment: { terminalFrame: number };
    };
    r.journeySegment.terminalFrame += 1;
    writeFileSync(join(dir, "build-receipt.json"), JSON.stringify(r));
    const check = verifyRetainedSegment({ dir, assetsPakPath: assets, expected: boundExpected(dir) });
    expect(check.ok).toBe(false);
    expect(check.issues.join(" ")).toMatch(/terminalFrame/);
  });

  test("an expected id that does not match the segment directory fails", () => {
    const { dir, assets } = retainedSegment();
    const check = verifyRetainedSegment({
      dir,
      assetsPakPath: assets,
      expected: { id: "WRONG-ID", chapter: "radio-broadcast", start: 185779, end: PLAN_END },
    });
    expect(check.ok).toBe(false);
    expect(check.issues.join(" ")).toMatch(/plan id/);
  });
});

describe("PSP mainline metrics drift", () => {
  function metricsOut(): string {
    const out = mkdtempSync(join(TMP, "mout-"));
    dirs.push(out);
    const seg = join(out, "01-test");
    mkdirSync(seg);
    writeFileSync(join(seg, "build-receipt.json"), receipt());
    writeFileSync(join(seg, "pocket-tuxemon.prx"), PRX_BYTES);
    writeFileSync(join(seg, "profile.jsonl"), PROFILE);
    writeFileSync(join(seg, "bench.jsonl"), bench());
    return out;
  }

  test("metrics that recompute identically are not drift", () => {
    const out = metricsOut();
    const metrics = computeMetrics(out);
    const saved = join(out, "metrics.json");
    writeFileSync(saved, JSON.stringify(metrics, null, 2) + "\n");
    expect(metricsDrift(saved, computeMetrics(out))).toEqual([]);
  });

  test("a tampered metrics file is drift", () => {
    const out = metricsOut();
    const metrics = computeMetrics(out);
    const tampered = [{ ...metrics[0]!, frames: metrics[0]!.frames + 1 }];
    const saved = join(out, "metrics.json");
    writeFileSync(saved, JSON.stringify(tampered, null, 2) + "\n");
    expect(metricsDrift(saved, computeMetrics(out))).toContain("01-test");
  });

  test("a missing metrics file is drift", () => {
    const out = metricsOut();
    expect(metricsDrift(join(out, "metrics.json"), computeMetrics(out))).toContain("<metrics.json missing>");
  });

  test("GC counters are carried from the bench window", () => {
    const out = metricsOut();
    expect(computeMetrics(out)[0]).toMatchObject({ gcCount: null, gcTotalMs: null, maxGcMs: null, qjsLiveMiB: null });
    const { start, n } = expectedBenchWindow(23);
    writeFileSync(join(out, "01-test", "bench.jsonl"), [
      JSON.stringify({ app: "pocket-tuxemon", frames: n, window_start: start, window_n: n }),
      JSON.stringify({
        window_start: start, slowest_columns: [], slowest: [],
        gc_count: 3, gc_us: 41_500, max_gc_us: 30_250, qjs_live_bytes: 3 * 1024 * 1024,
      }),
    ].join("\n") + "\n");
    expect(computeMetrics(out)[0]).toMatchObject({ gcCount: 3, gcTotalMs: 41.5, maxGcMs: 30.25, qjsLiveMiB: 3 });
  });

  test("map and battle events are counted only for the newest session", () => {
    // A rerun appends a new session to the same profile. The metrics must
    // describe the newest run only; counting the old session's events would
    // inflate maps/battles and could mask a truncated rerun.
    const out = metricsOut();
    const seg = join(out, "01-test");
    writeFileSync(join(seg, "profile.jsonl"), [
      JSON.stringify({ kind: "session", buildId: "b", segment: "radio-broadcast" }),
      JSON.stringify({ kind: "event", type: "map" }),
      JSON.stringify({ kind: "event", type: "map" }),
      JSON.stringify({ kind: "event", type: "battle-enter" }),
      JSON.stringify({ kind: "terminal", frame: 23, state: TERMINAL_STATE, buildId: "b" }),
      JSON.stringify({ kind: "session", buildId: "b", segment: "radio-broadcast" }),
      JSON.stringify({ kind: "event", type: "map" }),
      JSON.stringify({ kind: "terminal", frame: 23, state: TERMINAL_STATE, buildId: "b" }),
    ].join("\n") + "\n");
    const metrics = computeMetrics(out);
    expect(metrics).toHaveLength(1);
    expect(metrics[0]!.maps).toBe(1);
    expect(metrics[0]!.battles).toBe(0);
  });
});

describe("PSP mainline known-incomplete classification", () => {
  // --known-incomplete tolerates only "ran but did not finish" issues; a
  // broken or tampered retention must still fail under the flag.
  test("a missing terminal marker is incomplete", () => {
    expect(isIncompleteOnly(["profile has no terminal marker"])).toBe(true);
  });
  test("a missing terminal plus missing bench is incomplete", () => {
    expect(isIncompleteOnly(["profile has no terminal marker", "missing bench.jsonl"])).toBe(true);
  });
  test("a bench window mismatch is not incomplete", () => {
    // A truncated, lengthened or stale bench window is a broken retention,
    // not a "ran but did not finish" run: the flag must not exempt it.
    expect(isIncompleteOnly(["bench window does not cover [0, 24)"])).toBe(false);
  });
  test("an assets mismatch is not incomplete", () => {
    expect(isIncompleteOnly(["assets.pak sha256 does not match the receipt"])).toBe(false);
  });
  test("a PRX mismatch mixed with no terminal is not incomplete", () => {
    expect(isIncompleteOnly(["profile has no terminal marker", "PRX sha256 does not match the receipt"])).toBe(false);
  });
  test("a wrong build is not incomplete", () => {
    expect(isIncompleteOnly(["profile session buildId != receipt journeyBuildId"])).toBe(false);
  });
  test("no issues is not incomplete", () => {
    expect(isIncompleteOnly([])).toBe(false);
  });
});

describe("PSP mainline verify argument parsing", () => {
  // The gate must accept exactly the two documented forms and reject
  // everything else: an empty id, a missing value, a value that looks like
  // an option, and any unknown option.
  test("parses --known-incomplete=<id>", () => {
    expect(parseVerifyArgs(["--known-incomplete=06-cotton-town-a"]).knownIncomplete)
      .toEqual(["06-cotton-town-a"]);
  });
  test("parses --known-incomplete <id>", () => {
    expect(parseVerifyArgs(["--known-incomplete", "06-cotton-town-a"]).knownIncomplete)
      .toEqual(["06-cotton-town-a"]);
  });
  test("parses a mix of both forms, repeated", () => {
    const args = parseVerifyArgs([
      "--known-incomplete", "06-cotton-town-a",
      "--known-incomplete=19-candy-town",
    ]);
    expect(args.knownIncomplete).toEqual(["06-cotton-town-a", "19-candy-town"]);
  });
  test("rejects an empty id", () => {
    expect(() => parseVerifyArgs(["--known-incomplete="])).toThrow(/empty/);
  });
  test("rejects --known-incomplete with no following value", () => {
    expect(() => parseVerifyArgs(["--known-incomplete"])).toThrow(/requires/);
  });
  test("rejects --known-incomplete followed by another option", () => {
    expect(() => parseVerifyArgs(["--known-incomplete", "--jobs=4"])).toThrow(/requires/);
  });
  test("rejects unknown options", () => {
    expect(() => parseVerifyArgs(["--bogus"])).toThrow(/unknown option/);
    expect(() => parseVerifyArgs(["--known-incomplete=x", "--quiet"])).toThrow(/unknown option/);
  });
});

describe("PSP mainline verify --known-incomplete (integration)", () => {
  // A fake retention tree matching the real 28-segment plan: every segment
  // consistent except 06-cotton-town-a, which ran but did not finish (no
  // terminal marker, no bench). The verify gate must report 27/27 PASS with
  // --known-incomplete=06-cotton-town-a (06 shown INCOMPLETE with its issues)
  // and FAIL without the flag. Driven through the real CLI with
  // PSP_MAINLINE_OUT pointed at the disposable tree.
  function buildFakeRetention(): string {
    const root = mkdtempSync(join(TMP, "verify-"));
    dirs.push(root);
    const plan = buildPlan();
    const PRX = new TextEncoder().encode("FAKE-PRX");
    const ASSETS = new TextEncoder().encode("FAKE-ASSETS-PAK");
    for (const e of plan) {
      const frames = e.end - segmentStart(e.chapter);
      const dir = join(root, e.id);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "build-receipt.json"), JSON.stringify({
        target: "psp",
        journey: true,
        journeyBuildId: "b",
        journeySegment: {
          chapter: e.chapter,
          startFrame: segmentStart(e.chapter),
          endFrame: e.end,
          frames,
          terminalFrame: e.end,
          terminalSha256: sha256(canonicalJson({})),
        },
        artifacts: {
          "pocket-tuxemon.prx": { sha256: sha256(PRX) },
          "assets.pak": { sha256: sha256(ASSETS) },
        },
      }));
      writeFileSync(join(dir, "pocket-tuxemon.prx"), PRX);
      writeFileSync(join(dir, "assets.pak"), ASSETS);
      const incomplete = e.id === "06-cotton-town-a";
      writeFileSync(join(dir, "profile.jsonl"), [
        JSON.stringify({ kind: "session", buildId: "b", segment: e.chapter }),
        JSON.stringify({ kind: "abi", passed: true, buildId: "b" }),
        ...(incomplete
          ? []
          : [JSON.stringify({ kind: "terminal", frame: frames, state: {}, buildId: "b" })]),
      ].join("\n") + "\n");
      if (!incomplete) {
        writeFileSync(join(dir, "bench.jsonl"), [
          JSON.stringify({ app: "pocket-tuxemon", frames: frames + 1, window_start: 0, window_n: frames + 1 }),
          JSON.stringify({ window_start: 0, slowest_columns: [], slowest: [] }),
        ].join("\n") + "\n");
      }
    }
    writeFileSync(join(root, "metrics.json"), JSON.stringify(computeMetrics(root), null, 2) + "\n");
    return root;
  }

  function runVerify(root: string, args: string[]): { status: number; out: string } {
    const r = spawnSync(process.execPath, [join(ROOT, "tools/psp-mainline.ts"), "verify", ...args], {
      cwd: ROOT,
      env: { ...process.env, PSP_MAINLINE_OUT: root },
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { status: r.status ?? -1, out: ((r.stdout?.toString() ?? "") + (r.stderr?.toString() ?? "")).trim() };
  }

  test("27/27 PASS with --known-incomplete, 06 shown INCOMPLETE with reasons", () => {
    const root = buildFakeRetention();
    const { status, out } = runVerify(root, ["--known-incomplete=06-cotton-town-a"]);
    expect(status).toBe(0);
    expect(out).toContain("OK 01-bedroom");
    expect(out).toContain("OK 28-kernel-defeated");
    expect(out).toContain("INCOMPLETE 06-cotton-town-a: profile has no terminal marker; missing bench.jsonl");
    expect(out).toContain("VERIFY PASS: 27/27 segments PASS (1 INCOMPLETE: 06-cotton-town-a)");
    expect(out).not.toContain("FAIL");
  });

  test("FAIL without the flag: the incomplete segment fails the gate", () => {
    const root = buildFakeRetention();
    const { status, out } = runVerify(root, []);
    expect(status).toBe(1);
    expect(out).toContain("FAIL 06-cotton-town-a: profile has no terminal marker; missing bench.jsonl");
  });

  test("the flag does not mask a real failure: an assets mismatch still FAILs", () => {
    const root = buildFakeRetention();
    writeFileSync(join(root, "06-cotton-town-a", "assets.pak"), new TextEncoder().encode("TAMPERED"));
    const { status, out } = runVerify(root, ["--known-incomplete=06-cotton-town-a"]);
    expect(status).toBe(1);
    expect(out).toContain("FAIL 06-cotton-town-a: assets.pak sha256 does not match the receipt");
  });

  test("an unknown segment id errors out instead of exempting anything", () => {
    const root = buildFakeRetention();
    const { status, out } = runVerify(root, ["--known-incomplete=99-nope"]);
    expect(status).not.toBe(0);
    expect(out).toMatch(/unknown segment id/);
  });

  test("a flagged id that actually completed errors out", () => {
    // The exemption is only for runs that did not finish; naming a segment
    // that has complete evidence must error, not silently pass.
    const root = buildFakeRetention();
    const { status, out } = runVerify(root, ["--known-incomplete=01-bedroom"]);
    expect(status).not.toBe(0);
    expect(out).toMatch(/actually completed/);
  });

  test("an unknown option errors out", () => {
    const root = buildFakeRetention();
    const { status, out } = runVerify(root, ["--quiet"]);
    expect(status).not.toBe(0);
    expect(out).toMatch(/unknown option/);
  });

  test("evidence bound to a different plan entry fails even when internally consistent", () => {
    // The round-4 review's scenario: one segment's evidence reused for
    // another plan entry. 02-paper-town's receipt and profile are made
    // internally consistent (profile chapter matches receipt chapter) but
    // claim 'bedroom', which does not match the plan entry's chapter.
    const root = buildFakeRetention();
    const dir = join(root, "02-paper-town");
    const receiptPath = join(dir, "build-receipt.json");
    const r = JSON.parse(readFileSync(receiptPath, "utf8")) as {
      journeySegment: { chapter: string; frames: number };
    };
    r.journeySegment.chapter = "bedroom";
    writeFileSync(receiptPath, JSON.stringify(r));
    writeFileSync(join(dir, "profile.jsonl"), [
      JSON.stringify({ kind: "session", buildId: "b", segment: "bedroom" }),
      JSON.stringify({ kind: "abi", passed: true, buildId: "b" }),
      JSON.stringify({ kind: "terminal", frame: r.journeySegment.frames, state: {}, buildId: "b" }),
    ].join("\n") + "\n");
    const { status, out } = runVerify(root, []);
    expect(status).toBe(1);
    expect(out).toContain("FAIL 02-paper-town: receipt chapter bedroom != plan paper-town");
  });
});

describe("PSP mainline plan invariants", () => {
  // The actual 28-segment plan must continuously cover [0, EXPECTED_END_FRAME)
  // with no gap or overlap. These invariants are independent of the plan's
  // own self-report, so a deleted segment (which leaves a frame gap) is
  // caught even though `verify` only walks the plan as given.
  test("the actual plan has 28 segments covering [0, EXPECTED_END_FRAME) with no gap or overlap", () => {
    const windows = planWindows(buildPlan());
    expect(validatePlan(windows)).toEqual([]);
    expect(windows).toHaveLength(EXPECTED_SEGMENTS);
    expect(windows[0]!.start).toBe(0);
    expect(windows[windows.length - 1]!.end).toBe(EXPECTED_END_FRAME);
    const total = windows.reduce((s, w) => s + (w.end - w.start), 0);
    expect(total).toBe(EXPECTED_END_FRAME);
  });

  test("deleting 25-surfboard leaves a gap and fails the invariants", () => {
    // The round-3 review's surviving mutation: the plan line for 25-surfboard
    // was deleted and every test stayed green. The segment covers
    // [188410, 190589); deleting it must now be caught.
    const plan = buildPlan().filter((e) => e.id !== "25-surfboard");
    const issues = validatePlan(planWindows(plan));
    expect(issues.length).toBeGreaterThan(0);
    expect(issues.join(" ")).toMatch(/27 segments|gap/);
  });

  test("a plan that does not start at 0 fails", () => {
    const w = planWindows(buildPlan());
    const tampered = [{ ...w[0]!, start: 5 }, ...w.slice(1)];
    expect(validatePlan(tampered).join(" ")).toMatch(/starts at frame 5/);
  });

  test("a plan that ends at the wrong frame fails", () => {
    const w = planWindows(buildPlan());
    const tampered = [...w.slice(0, -1), { ...w[w.length - 1]!, end: EXPECTED_END_FRAME - 1 }];
    expect(validatePlan(tampered).join(" ")).toMatch(/ends at frame/);
  });

  test("a plan with a gap between two segments fails", () => {
    const w = planWindows(buildPlan());
    // Move 02-paper-town's start 10 frames past 01-bedroom's end.
    const tampered = w.map((x, i) => (i === 1 ? { ...x, start: x.start + 10 } : x));
    expect(validatePlan(tampered).join(" ")).toMatch(/gap\/overlap/);
  });

  test("a plan with an overlap between two segments fails", () => {
    const w = planWindows(buildPlan());
    // Move 02-paper-town's start 10 frames before 01-bedroom's end.
    const tampered = w.map((x, i) => (i === 1 ? { ...x, start: x.start - 10 } : x));
    expect(validatePlan(tampered).join(" ")).toMatch(/gap\/overlap/);
  });

  test("the plan matches the fixed 28-segment identity table", () => {
    // The identity table is independent of the plan's own self-report: every
    // entry's id, chapter, start and end must match exactly, in order.
    const windows = planWindows(buildPlan());
    expect(windows).toHaveLength(EXPECTED_PLAN_IDENTITIES.length);
    for (let i = 0; i < EXPECTED_PLAN_IDENTITIES.length; i++) {
      expect(windows[i]).toEqual(EXPECTED_PLAN_IDENTITIES[i]);
    }
  });

  test("a duplicate segment id fails the invariants", () => {
    // The round-4 review's surviving mutation: 27-data-center's id was
    // changed to 26-route-b and every test stayed green, letting one
    // segment's evidence be checked twice while another went unverified.
    const plan = buildPlan().map((e) => (e.id === "27-data-center" ? { ...e, id: "26-route-b" } : e));
    const issues = validatePlan(planWindows(plan));
    expect(issues.join(" ")).toMatch(/duplicate segment id 26-route-b/);
    expect(issues.join(" ")).toMatch(/27-data-center/);
  });

  test("a plan entry with the wrong chapter fails the invariants", () => {
    const plan = buildPlan().map((e) => (e.id === "27-data-center" ? { ...e, chapter: "route-b" } : e));
    const issues = validatePlan(planWindows(plan));
    expect(issues.join(" ")).toMatch(/chapter/);
  });

  test("a plan entry with a shifted end fails the invariants", () => {
    const plan = buildPlan().map((e) => (e.id === "27-data-center" ? { ...e, end: e.end - 1 } : e));
    const issues = validatePlan(planWindows(plan));
    expect(issues.join(" ")).toMatch(/ends at/);
  });
});
