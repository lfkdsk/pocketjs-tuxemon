import { describe, expect, test } from "bun:test";

import { chapterWorldTraversal } from "../tools/bake-chapters.ts";

const segments = (worldTraversal?: unknown) => ({
  gb6: { worldTraversal },
  j1: { worldTraversal },
  j2: { worldTraversal },
  j3: { worldTraversal },
  j4: { worldTraversal },
});

describe("chapter traversal identity", () => {
  test("missing identities normalize to the legacy timeline", () => {
    expect(chapterWorldTraversal({ tape: segments() })).toBe("legacy-transfer");
  });

  test("a seamless manifest requires every segment to be seamless", () => {
    expect(chapterWorldTraversal({
      worldTraversal: "seamless-v1",
      tape: segments("seamless-v1"),
    })).toBe("seamless-v1");

    expect(() => chapterWorldTraversal({
      worldTraversal: "seamless-v1",
      tape: { ...segments("seamless-v1"), j2: {} },
    })).toThrow(/j2 segment traversal legacy-transfer != manifest seamless-v1/);
  });

  test("unknown identities fail instead of being guessed", () => {
    expect(() => chapterWorldTraversal({
      worldTraversal: "future-v2",
      tape: segments("future-v2"),
    })).toThrow(/unsupported world traversal identity future-v2/);
  });
});
