// Tests for the PSP mainline segment machinery (tools/psp-segment.ts):
// suffix slicing, segment resolution, the desktop terminal pin, the build
// receipt/profile verification path, and the baked journey wrapper. These
// run without the PSP SDK or PPSSPP — the receipt/profile check is driven
// with a desktop-replay terminal standing in for the PSP run.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { FIXED_INITIAL_CIVIL_TIME } from "../battle/time-weather.ts";
import { canonicalJson } from "../vendor/pocket-rpgkit/src/engine/save.ts";
import type { SessionState } from "../vendor/pocket-rpgkit/src/engine/session.ts";
import {
  bakeSegmentBundle,
  checkBuildArtifact,
  generateEnvelope,
  loadChapters,
  loadMainlineTape,
  replaySuffixState,
  replaySuffixTerminal,
  resolveSegment,
  ROOT,
  sha256,
  sliceSuffix,
  verifySegmentProfile,
  type ProfileEntry,
  type SegmentReceipt,
} from "../tools/psp-segment.ts";

const chapters = loadChapters(ROOT);
const { combined } = loadMainlineTape(ROOT);
const J3_SEGMENT_FRAMES = 23;

/** Build a receipt for a segment, the same way tools/psp.ts does. */
function receiptFor(chapterRef: string, endFrame?: number): {
  receipt: SegmentReceipt;
  buildId: string;
} {
  const spec = resolveSegment(ROOT, chapterRef, endFrame);
  const pin = replaySuffixTerminal(ROOT, spec);
  const { journeyBuildId } = bakeSegmentBundle("ORIGINAL_BUNDLE", spec, FIXED_INITIAL_CIVIL_TIME);
  return {
    buildId: journeyBuildId,
    receipt: {
      chapter: spec.chapter,
      generated: spec.generated,
      startFrame: spec.startFrame,
      endFrame: spec.endFrame,
      frames: spec.suffix.length,
      snapshotSha256: sha256(spec.envelope.snapshot),
      tapeSha256: sha256(JSON.stringify(spec.suffix)),
      terminalSha256: pin.terminalSha256,
      endMap: pin.endMap,
      endPosition: pin.endPosition,
      terminalFrame: pin.endFrame,
      envelope: spec.envelope,
    },
  };
}

/** A profile that reached the given terminal state, as the PSP wrapper logs. */
function profileFor(
  buildId: string,
  chapter: string,
  terminal: SessionState,
  frames: number,
): ProfileEntry[] {
  return [
    { kind: "session", buildId, segment: chapter },
    { kind: "abi", passed: true, buildId },
    { kind: "terminal", frame: frames, state: terminal, buildId },
  ];
}

describe("PSP segment suffix slicing", () => {
  test("every committed chapter window slices with the right head, tail and length", () => {
    // The PSP mainline is the full GB6+J1+J2+J3+J4 mainline; chapters beyond
    // it are not part of the 5-tape combined tape.
    const pspChapters = chapters.chapters.filter((c) => c.frame < combined.length);
    for (let i = 0; i < pspChapters.length; i++) {
      const chapter = pspChapters[i]!;
      const next = pspChapters[i + 1];
      const end = next ? Math.min(next.frame, combined.length) : combined.length;
      const suffix = sliceSuffix(combined, chapter.frame, end);
      expect(suffix.length).toBe(end - chapter.frame);
      // The first suffix mask is the mask ON the chapter frame (the first
      // mask folded after the restore). A +1 on the slice start silently
      // drops the first input frame; these head/tail pins catch it.
      expect(suffix[0]).toBe(combined[chapter.frame]);
      expect(suffix.at(-1)).toBe(combined[end - 1]);
    }
  });

  test("the kernel-defeated tail is 11 frames ending at the tape's last mask", () => {
    const kernel = chapters.chapters.find((c) => c.id === "kernel-defeated")!;
    const suffix = sliceSuffix(combined, kernel.frame, combined.length);
    expect(suffix.length).toBe(11);
    expect(suffix[0]).toBe(combined[kernel.frame]);
    expect(suffix.at(-1)).toBe(combined.at(-1));
  });

  test("slice bounds are validated", () => {
    expect(() => sliceSuffix(combined, -1, 10)).toThrow(/bad suffix slice/);
    expect(() => sliceSuffix(combined, 100, 100)).toThrow(/bad suffix slice/);
    expect(() => sliceSuffix(combined, 100, combined.length + 1)).toThrow(/bad suffix slice/);
  });
});

describe("PSP segment resolution", () => {
  test("a committed chapter resolves to the next chapter's frame", () => {
    // radio-broadcast now resolves to the next committed chapter,
    // kernel-briefing (the J3 terminal at 193231 is mid-tape once J4 loads).
    const spec = resolveSegment(ROOT, "radio-broadcast");
    expect(spec.generated).toBe(false);
    expect(spec.startFrame).toBe(193208);
    expect(spec.endFrame).toBe(195079);
    expect(spec.suffix.length).toBe(1871);
    expect(spec.envelope.map).toBe("spyder_radiotower");
  });

  test("an explicit end frame overrides the next-chapter default", () => {
    const spec = resolveSegment(ROOT, "radio-broadcast", 193231);
    expect(spec.endFrame).toBe(193231);
    expect(spec.suffix.length).toBe(23);
  });

  test("an unknown chapter reference is rejected", () => {
    expect(() => resolveSegment(ROOT, "no-such-chapter")).toThrow(/Unknown journey segment/);
  });
});

describe("PSP segment terminal pin", () => {
  test("the radio-broadcast suffix replay reaches the J3 terminal pin", () => {
    // Pin the J3 terminal at 193231 with an explicit end (the default end is
    // now the J4 chapter kernel-briefing).
    const spec = resolveSegment(ROOT, "radio-broadcast", 193231);
    const pin = replaySuffixTerminal(ROOT, spec);
    expect(pin.terminalSha256)
      .toBe("590452dceb93dfe0a2a88016610e602a6bc6f5334da6fa7b35c550f1f1f2548d");
    expect(pin.endMap).toBe("spyder_radiotower");
    expect(pin.endPosition).toEqual([9, 5]);
    expect(pin.endFrame).toBe(193231);
  });

  test("a generated envelope at a safe point also reaches the full-mainline terminal", () => {
    // A safe point mid-City-Park (frame 60000 is on spyder_route3); replay
    // from it to the tape end must reach the same full-mainline terminal
    // (the J4 Kernel-quest terminal at 206830).
    const env = generateEnvelope(ROOT, 60000, { id: "test-f60000", write: false });
    expect(env.frame).toBeGreaterThanOrEqual(60000);
    expect(env.map).toBe("spyder_route3");
    const spec = {
      chapter: "test-f60000",
      generated: true,
      startFrame: env.frame,
      endFrame: combined.length,
      envelope: env,
      suffix: sliceSuffix(combined, env.frame, combined.length),
    };
    const pin = replaySuffixTerminal(ROOT, spec);
    expect(pin.terminalSha256)
      .toBe("3fedbe7d848623d3f80b687f087a30f0e647ff4aa064cf0986ede38629719232");
    expect(pin.endMap).toBe("spyder_datacenter");
    expect(pin.endPosition).toEqual([7, 4]);
    expect(pin.endFrame).toBe(206830);
  }, 60_000);
});

describe("PSP segment receipt/profile verification", () => {
  test("a matching PSP terminal passes and reports the terminal", () => {
    const { receipt, buildId } = receiptFor("radio-broadcast", 193231);
    const spec = resolveSegment(ROOT, "radio-broadcast", 193231);
    const terminal = replaySuffixState(ROOT, spec);
    const result = verifySegmentProfile(
      ROOT,
      receipt,
      buildId,
      profileFor(buildId, "radio-broadcast", terminal, spec.suffix.length),
    );
    expect(result.terminalSha256).toBe(receipt.terminalSha256);
    expect(result.endMap).toBe("spyder_radiotower");
    expect(result.frames).toBe(J3_SEGMENT_FRAMES);
  });

  test("a diverged PSP terminal is rejected", () => {
    const { receipt, buildId } = receiptFor("radio-broadcast", 193231);
    const spec = resolveSegment(ROOT, "radio-broadcast", 193231);
    const terminal = replaySuffixState(ROOT, spec);
    const wrong = { ...terminal, mapId: "spyder_paper_town" } as SessionState;
    expect(() =>
      verifySegmentProfile(ROOT, receipt, buildId, profileFor(buildId, "radio-broadcast", wrong, J3_SEGMENT_FRAMES)),
    ).toThrow(/diverged/);
  });

  test("a wrong segment length is rejected", () => {
    const { receipt, buildId } = receiptFor("radio-broadcast", 193231);
    const spec = resolveSegment(ROOT, "radio-broadcast", 193231);
    const terminal = replaySuffixState(ROOT, spec);
    expect(() =>
      verifySegmentProfile(ROOT, receipt, buildId, profileFor(buildId, "radio-broadcast", terminal, 22)),
    ).toThrow(/length mismatch/);
  });

  test("a stale receipt pin is rejected", () => {
    const { receipt, buildId } = receiptFor("radio-broadcast", 193231);
    const spec = resolveSegment(ROOT, "radio-broadcast", 193231);
    const terminal = replaySuffixState(ROOT, spec);
    const stale = { ...receipt, terminalSha256: "0".repeat(64) };
    expect(() =>
      verifySegmentProfile(ROOT, stale, buildId, profileFor(buildId, "radio-broadcast", terminal, J3_SEGMENT_FRAMES)),
    ).toThrow(/pin does not match/);
  });

  test("a profile from a different segment is rejected", () => {
    const { receipt, buildId } = receiptFor("radio-broadcast", 193231);
    const spec = resolveSegment(ROOT, "radio-broadcast", 193231);
    const terminal = replaySuffixState(ROOT, spec);
    expect(() =>
      verifySegmentProfile(ROOT, receipt, buildId, profileFor(buildId, "paper-town", terminal, J3_SEGMENT_FRAMES)),
    ).toThrow(/segment/);
  });

  test("a profile with the wrong build id is rejected", () => {
    const { receipt, buildId } = receiptFor("radio-broadcast", 193231);
    const spec = resolveSegment(ROOT, "radio-broadcast", 193231);
    const terminal = replaySuffixState(ROOT, spec);
    expect(() =>
      verifySegmentProfile(ROOT, receipt, "deadbeef", profileFor(buildId, "radio-broadcast", terminal, J3_SEGMENT_FRAMES)),
    ).toThrow(/does not match the current journey build/);
  });

  test("a profile without a terminal is rejected", () => {
    const { receipt, buildId } = receiptFor("radio-broadcast", 193231);
    expect(() =>
      verifySegmentProfile(ROOT, receipt, buildId, [
        { kind: "session", buildId, segment: "radio-broadcast" },
        { kind: "abi", passed: true, buildId },
      ]),
    ).toThrow(/did not reach a terminal/);
  });

  test("a receipt whose tape hash does not match the committed tape is rejected", () => {
    const { receipt, buildId } = receiptFor("radio-broadcast", 193231);
    const spec = resolveSegment(ROOT, "radio-broadcast", 193231);
    const terminal = replaySuffixState(ROOT, spec);
    const stale = { ...receipt, tapeSha256: "0".repeat(64) };
    expect(() =>
      verifySegmentProfile(ROOT, stale, buildId, profileFor(buildId, "radio-broadcast", terminal, J3_SEGMENT_FRAMES)),
    ).toThrow(/tape hash/);
  });
});

describe("PSP segment receipt invariants", () => {
  // Every receipt field the terminal comparison depends on must itself be
  // checked, or a tampered receipt sails through. These pin each invariant.

  test("receipt frames must equal endFrame - startFrame", () => {
    const { receipt, buildId } = receiptFor("radio-broadcast", 193231);
    const spec = resolveSegment(ROOT, "radio-broadcast", 193231);
    const terminal = replaySuffixState(ROOT, spec);
    const tampered = { ...receipt, frames: 22 };
    expect(() =>
      verifySegmentProfile(ROOT, tampered, buildId, profileFor(buildId, "radio-broadcast", terminal, 22)),
    ).toThrow(/frames/);
  });

  test("receipt terminalFrame must equal envelope timelineFrame + frames", () => {
    const { receipt, buildId } = receiptFor("radio-broadcast", 193231);
    const spec = resolveSegment(ROOT, "radio-broadcast", 193231);
    const terminal = replaySuffixState(ROOT, spec);
    const tampered = { ...receipt, terminalFrame: receipt.terminalFrame - 1 };
    expect(() =>
      verifySegmentProfile(ROOT, tampered, buildId, profileFor(buildId, "radio-broadcast", terminal, J3_SEGMENT_FRAMES)),
    ).toThrow(/terminal frame/);
  });

  test("a receipt with invalid segment bounds is rejected", () => {
    const { receipt, buildId } = receiptFor("radio-broadcast", 193231);
    const spec = resolveSegment(ROOT, "radio-broadcast", 193231);
    const terminal = replaySuffixState(ROOT, spec);
    const tampered = {
      ...receipt,
      startFrame: -1,
      frames: receipt.endFrame + 1,
      envelope: { ...receipt.envelope, frame: -1 },
    };
    expect(() =>
      verifySegmentProfile(ROOT, tampered, buildId, profileFor(buildId, "radio-broadcast", terminal, J3_SEGMENT_FRAMES)),
    ).toThrow(/bounds/);
  });

  test("receipt endMap must match the fresh replay", () => {
    const { receipt, buildId } = receiptFor("radio-broadcast", 193231);
    const spec = resolveSegment(ROOT, "radio-broadcast", 193231);
    const terminal = replaySuffixState(ROOT, spec);
    const tampered = { ...receipt, endMap: "spyder_paper_town" };
    expect(() =>
      verifySegmentProfile(ROOT, tampered, buildId, profileFor(buildId, "radio-broadcast", terminal, J3_SEGMENT_FRAMES)),
    ).toThrow(/end map/);
  });

  test("receipt endPosition x must match the fresh replay", () => {
    // A tampered x with the real y must be rejected. Deleting the x
    // comparison in verifySegmentProfile must turn this test red.
    const { receipt, buildId } = receiptFor("radio-broadcast", 193231);
    const spec = resolveSegment(ROOT, "radio-broadcast", 193231);
    const terminal = replaySuffixState(ROOT, spec);
    const tampered = { ...receipt, endPosition: [0, receipt.endPosition[1]] as [number, number] };
    expect(() =>
      verifySegmentProfile(ROOT, tampered, buildId, profileFor(buildId, "radio-broadcast", terminal, J3_SEGMENT_FRAMES)),
    ).toThrow(/end position/);
  });

  test("receipt endPosition y must match the fresh replay", () => {
    // A tampered y with the real x must be rejected. The round-3 review's
    // surviving mutation deleted the y comparison and stayed green; this
    // fixture pins the y component on its own.
    const { receipt, buildId } = receiptFor("radio-broadcast", 193231);
    const spec = resolveSegment(ROOT, "radio-broadcast", 193231);
    const terminal = replaySuffixState(ROOT, spec);
    const tampered = { ...receipt, endPosition: [receipt.endPosition[0], 0] as [number, number] };
    expect(() =>
      verifySegmentProfile(ROOT, tampered, buildId, profileFor(buildId, "radio-broadcast", terminal, J3_SEGMENT_FRAMES)),
    ).toThrow(/end position/);
  });

  test("receipt envelope frame must match startFrame", () => {
    const { receipt, buildId } = receiptFor("radio-broadcast", 193231);
    const spec = resolveSegment(ROOT, "radio-broadcast", 193231);
    const terminal = replaySuffixState(ROOT, spec);
    const tampered = {
      ...receipt,
      envelope: { ...receipt.envelope, frame: receipt.envelope.frame + 1 },
    };
    expect(() =>
      verifySegmentProfile(ROOT, tampered, buildId, profileFor(buildId, "radio-broadcast", terminal, J3_SEGMENT_FRAMES)),
    ).toThrow(/envelope/);
  });

  test("a terminal diverged only in non-map state is rejected by the canonical SHA", () => {
    // The round-2 review's surviving mutation: with the canonical SHA
    // comparison disabled, a terminal whose map/position/frame still match
    // was accepted. This fixture differs only in a story variable, so the
    // SHA comparison is the ONLY check that can catch it.
    const { receipt, buildId } = receiptFor("radio-broadcast", 193231);
    const spec = resolveSegment(ROOT, "radio-broadcast", 193231);
    const terminal = replaySuffixState(ROOT, spec);
    const diverged = {
      ...terminal,
      ext: { __pspDivergenceProbe: 1 },
    } as SessionState;
    expect(() =>
      verifySegmentProfile(ROOT, receipt, buildId, profileFor(buildId, "radio-broadcast", diverged, J3_SEGMENT_FRAMES)),
    ).toThrow(/diverged/);
  });
});

describe("PSP build artifact hash check", () => {
  test("a mismatched or missing artifact hash is rejected", () => {
    expect(() =>
      checkBuildArtifact({ "pocket-tuxemon.prx": { sha256: "0".repeat(64) } }, "pocket-tuxemon.prx", "a".repeat(64)),
    ).toThrow(/artifact/);
    expect(() =>
      checkBuildArtifact(undefined, "pocket-tuxemon.prx", "a".repeat(64)),
    ).toThrow(/artifact/);
    expect(() =>
      checkBuildArtifact({ "pocket-tuxemon.prx": { sha256: 123 } }, "pocket-tuxemon.prx", "a".repeat(64)),
    ).toThrow(/artifact/);
    // A matching hash passes.
    checkBuildArtifact({ "pocket-tuxemon.prx": { sha256: "a".repeat(64) } }, "pocket-tuxemon.prx", "a".repeat(64));
  });
});

describe("PSP segment wrapper baking (no SDK)", () => {
  test("the baked bundle embeds the snapshot, boot frame and suffix", () => {
    const spec = resolveSegment(ROOT, "radio-broadcast");
    const { bundle, journeyBuildId } = bakeSegmentBundle(
      "ORIGINAL_BUNDLE",
      spec,
      FIXED_INITIAL_CIVIL_TIME,
    );
    expect(bundle.startsWith("globalThis.__pocketTuxemonInitialCivilTime=")).toBe(true);
    expect(bundle).toContain(`globalThis.__pocketTuxemonBootSnapshot=${JSON.stringify(spec.envelope.snapshot)}`);
    expect(bundle).toContain(`globalThis.__pocketTuxemonBootFrame=${spec.envelope.timelineFrame}`);
    expect(bundle).toContain(`segment:${JSON.stringify(spec.chapter)}`);
    expect(bundle).toContain(`tape=${JSON.stringify(spec.suffix)}`);
    expect(bundle).toContain('kind:"terminal"');
    // The wrapper terminates the run just after the tape end (no idle-to-
    // timeout), one frame after the terminal so the bench window flushes.
    expect(bundle).toContain('__pspExit');
    expect(bundle.endsWith("ORIGINAL_BUNDLE")).toBe(false);
    expect(bundle.includes("ORIGINAL_BUNDLE")).toBe(true);
    // The build id is a hash of the bundle inputs, not the original alone.
    expect(journeyBuildId).toHaveLength(64);
    expect(journeyBuildId).not.toBe(sha256("ORIGINAL_BUNDLE"));
  });

  test("the boot frame is the chapter's global timeline frame", () => {
    // This is the line the boot overlay re-applies after restore; baking the
    // wrong value here desyncs the suffix from the desktop verifier.
    const spec = resolveSegment(ROOT, "radio-broadcast");
    const { bundle } = bakeSegmentBundle("B", spec, FIXED_INITIAL_CIVIL_TIME);
    expect(bundle).toContain(`__pocketTuxemonBootFrame=${spec.envelope.timelineFrame}`);
    expect(spec.envelope.timelineFrame).toBe(193208);
  });

  test("the terminal is logged at the tape end and __pspExit fires one frame later", () => {
    // The host flushes its bench window at the terminal frame; exiting inside
    // that same frame (the round-1 behaviour) skipped the flush and lost the
    // tail window. The wrapper must therefore exit exactly one frame after
    // logging the terminal.
    const spec = resolveSegment(ROOT, "radio-broadcast");
    const { bundle } = bakeSegmentBundle("", spec, FIXED_INITIAL_CIVIL_TIME);
    const g = globalThis as unknown as Record<string, unknown>;
    const logs: unknown[] = [];
    let terminalAt = -1;
    let exitAt = -1;
    let calls = 0;
    // bakeSegmentBundle's prefix writes the time/snapshot/frame globals before
    // its wrapper replaces frame. Preserve descriptors (including absence),
    // not only values: leaving an own property with value undefined can still
    // change a later host probe.
    const touched = [
      "frame",
      "__pspLog",
      "__pspRoundTrip",
      "__pspExit",
      "__pocketTuxemonInitialCivilTime",
      "__pocketTuxemonBootSnapshot",
      "__pocketTuxemonBootFrame",
      "__pocketTuxemonBootReady",
      "__rpgSessionState",
    ] as const;
    const saved = new Map(touched.map((key) => [
      key,
      Object.getOwnPropertyDescriptor(globalThis, key),
    ] as const));
    try {
      g.frame = () => {};
      g.__pspLog = (line: string) => {
        const entry = JSON.parse(line) as { kind?: string };
        logs.push(entry);
        if (entry.kind === "terminal") terminalAt = calls;
      };
      g.__pspRoundTrip = (v: unknown) => v;
      g.__pspExit = () => { exitAt = calls; };
      g.__pocketTuxemonBootReady = true;
      g.__rpgSessionState = { mapId: "m", move: { tx: 0, ty: 0 }, scene: {}, interp: {} };
      // eslint-disable-next-line @typescript-eslint/no-implied-eval
      new Function(bundle)();
      const frame = g.frame as (buttons: number, analog?: number) => void;
      const L = spec.suffix.length;
      for (calls = 1; calls <= L + 2; calls++) frame(0, 0);
      const terminals = logs.filter((l) => (l as { kind?: string }).kind === "terminal");
      expect(terminals).toHaveLength(1);
      expect((terminals[0] as { frame: number }).frame).toBe(L);
      expect(exitAt).toBe(terminalAt + 1);
    } finally {
      for (const [key, descriptor] of saved) {
        delete g[key];
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      }
    }
    for (const [key, descriptor] of saved) {
      expect(Object.getOwnPropertyDescriptor(globalThis, key)).toEqual(descriptor);
    }
  });
});
