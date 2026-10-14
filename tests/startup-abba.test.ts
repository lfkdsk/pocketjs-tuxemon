import { describe, expect, test } from "bun:test";
import {
  bootstrapMedian95,
  parseStartupOutput,
  selectStartupCells,
  summarizeStartupSamples,
  type StartupSample,
} from "../tools/bench-startup-abba.ts";

function sample(
  window: number,
  slot: number,
  variant: "baseline" | "candidate",
  startupMs: number,
): StartupSample {
  return {
    type: "sample",
    cell: "en_US-480x272",
    language: "en_US",
    viewport: "480x272",
    window,
    slot,
    order: window % 2 === 1 ? "ABBA" : "BAAB",
    variant,
    startupMs,
    processWallMs: startupMs + 10,
    launcherEnvelopeMs: 10,
    budgetPassed: startupMs <= 250,
    exitCode: startupMs <= 250 ? 0 : 101,
    loadBefore: [1, 1, 1],
    loadAfter: [1, 1, 1],
    cpuIdlePercent: 95,
    hostStages: {},
    stages: {},
    timestamp: "2026-01-01T00:00:00.000Z",
  };
}

describe("startup ABBA analysis", () => {
  test("parses the startup and detailed stage lines", () => {
    const parsed = parseStartupOutput(`
HOST_STAGE viewport=480x272 name=pak-read at_ms=0.000 delta_ms=12.500
STAGE viewport=480x272 name=compile at_ms=12.500 delta_ms=31.250
BOOT viewport=480x272 gc_mode=idle startup_to_first=149.750ms objects=1
`);
    expect(parsed).toEqual({
      startupMs: 149.75,
      hostStages: { "pak-read": 12.5 },
      stages: { compile: 31.25 },
    });
  });

  test("keeps complete-window paired deltas and failed worst samples", () => {
    const samples = [
      sample(1, 1, "baseline", 200),
      sample(1, 2, "candidate", 140),
      sample(1, 3, "candidate", 142),
      sample(1, 4, "baseline", 202),
      sample(2, 1, "candidate", 138),
      sample(2, 2, "baseline", 198),
      sample(2, 3, "baseline", 204),
      sample(2, 4, "candidate", 260),
    ];
    const summary = summarizeStartupSamples(samples)[0]!;
    expect(summary.baseline.n).toBe(4);
    expect(summary.baseline.medianMs).toBe(201);
    expect(summary.candidate.n).toBe(4);
    expect(summary.candidate.worstMs).toBe(260);
    expect(summary.candidate.budgetFailures).toBe(1);
    expect(summary.pairedDeltaPercent).toBeLessThan(0);
  });

  test("bootstrap interval is deterministic and ordered", () => {
    const first = bootstrapMedian95([1, 2, 3, 4, 5], 1_000);
    const second = bootstrapMedian95([1, 2, 3, 4, 5], 1_000);
    expect(first).toEqual(second);
    expect(first.low).toBeLessThanOrEqual(3);
    expect(first.high).toBeGreaterThanOrEqual(3);
  });

  test("selects an explicit cell and rejects unknown cell names", () => {
    expect(selectStartupCells("zh_CN-960x544")).toEqual([
      { language: "zh_CN", viewport: "960 544" },
    ]);
    expect(() => selectStartupCells("en_US-123x456")).toThrow(
      "unknown STARTUP_ABBA_CELLS",
    );
  });

  test("rejects an interrupted window instead of reporting a biased delta", () => {
    const interrupted = [
      sample(1, 1, "baseline", 200),
      sample(1, 2, "candidate", 140),
      sample(1, 3, "candidate", 142),
    ];
    expect(() => summarizeStartupSamples(interrupted)).toThrow(
      "startup summary requires a complete ABBA window",
    );
  });
});
