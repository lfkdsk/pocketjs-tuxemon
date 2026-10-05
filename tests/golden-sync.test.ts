import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";

import {
  captureGoldenCheckpoints,
  loadGoldenSyncPlan,
} from "../tools/golden-sync.ts";

const ROOT = resolve(import.meta.dir, "..");

describe("golden checkpoint synchronization", () => {
  test("a checkpoint shifted by one tape frame is rejected", () => {
    const plan = loadGoldenSyncPlan(ROOT);
    const checkpoint = plan.mainline.find((candidate) =>
      candidate.suite === "gb6-route" && candidate.name === "cotton-town"
    )!;
    const shifted = { ...checkpoint, maskFrame: checkpoint.maskFrame + 1 };
    expect(() => captureGoldenCheckpoints(
      plan.mainlineMasks,
      [shifted],
      plan.worldTraversal,
      ROOT,
    )).toThrow(/golden sync: gb6-route\/cotton-town .* (diverged|not world-idle|not saveable)/);
  });
});
