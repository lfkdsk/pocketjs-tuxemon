import { describe, expect, test } from "bun:test";

import {
  alternatingWindows,
  distribution,
  evaluateFrameGate,
  medianDistribution,
  MOBILE_WEB_CITY_WALK_ENDPOINTS,
  quantile,
  splitProfileHotspots,
} from "../tools/mobile-web-bench-lib.ts";

describe("mobile Web frame benchmark statistics", () => {
  test("walks right to x=15 and left to x=10 in the Cotton Town corridor", () => {
    expect(MOBILE_WEB_CITY_WALK_ENDPOINTS).toEqual([
      { x: 15, y: 30, mask: 0x0020 },
      { x: 10, y: 30, mask: 0x0080 },
    ]);
  });

  test("uses interpolated percentiles and strict long-frame thresholds", () => {
    expect(quantile([40, 10, 30, 20], 0.5)).toBe(25);
    expect(distribution([16.7, 16.71, 33, 33.01])).toEqual({
      count: 4,
      p50: 24.855,
      p95: 33.0085,
      p99: 33.0097,
      max: 33.01,
      over16_7: 0.75,
      over33: 0.25,
    });
  });

  test("alternates ABBA and BAAB and takes cross-window medians", () => {
    expect(alternatingWindows(3)).toEqual([
      ["baseline", "candidate", "candidate", "baseline"],
      ["candidate", "baseline", "baseline", "candidate"],
      ["baseline", "candidate", "candidate", "baseline"],
    ]);
    const summary = medianDistribution([
      distribution([5, 10, 15]),
      distribution([10, 20, 30]),
      distribution([15, 30, 45]),
    ]);
    expect(summary.p50).toBe(20);
    expect(summary.count).toBe(3);
  });

  test("enforces absolute mobile targets and paired noise allowance", () => {
    const baseline = { ...distribution(Array(60).fill(10)), p95: 10 };
    expect(evaluateFrameGate({
      throttle: 4,
      baseline,
      candidate: { ...baseline, p95: 11.2 },
    })).toMatchObject({ pass: true, targetMs: 16.7, regressionLimitMs: 11.3 });
    expect(evaluateFrameGate({
      throttle: 4,
      baseline,
      candidate: { ...baseline, p95: 17 },
    }).reasons).toHaveLength(2);
    expect(evaluateFrameGate({
      throttle: 6,
      baseline: { ...baseline, p95: 30 },
      candidate: { ...baseline, p95: 33.1 },
    }).pass).toBeFalse();
  });

  test("reports JavaScript and wasm profile samples separately", () => {
    const hotspots = splitProfileHotspots({
      nodes: [
        { id: 1, callFrame: { functionName: "paint", url: "http://game/player.js", lineNumber: 4, columnNumber: 0 } },
        { id: 2, callFrame: { functionName: "wasm-function[12]", url: "wasm://wasm/core", lineNumber: -1, columnNumber: -1 } },
      ],
      samples: [1, 2, 2],
      timeDeltas: [1_000, 2_000, 3_000],
    });
    expect(hotspots.js[0]).toMatchObject({ functionName: "paint", line: 5, selfMs: 1, samples: 1 });
    expect(hotspots.wasm[0]).toMatchObject({ functionName: "wasm-function[12]", line: 0, selfMs: 5, samples: 2 });
  });
});
