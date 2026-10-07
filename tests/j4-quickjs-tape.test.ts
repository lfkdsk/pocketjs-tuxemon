import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";

import { buildJ4QuickjsTape } from "../tools/j4-quickjs-tape.ts";

describe("J4 QuickJS continuation tape", () => {
  test("starts at the radio chapter and carries every J4 battle through Kernel", () => {
    const tape = buildJ4QuickjsTape();
    expect(tape.format).toBe("pocket-tuxemon/j4-quickjs/v1");
    expect(tape.worldTraversal).toBe("seamless-v1");
    expect(tape.frames).toBe(13_410);
    expect(tape.frames).toBe(tape.masks.length);
    expect(tape.tapeSha256)
      .toBe(createHash("sha256").update(JSON.stringify(tape.masks)).digest("hex"));
    expect(tape.maps[0]).toEqual({ frame: 0, map: "spyder_radiotower" });
    expect(tape.maps.at(-1)).toMatchObject({ map: "spyder_datacenter" });
    expect(tape.battles).toHaveLength(14);
    expect(tape.battles[0]).toMatchObject({ opponent: "wild:cataspike" });
    expect(tape.battles.at(-1)).toMatchObject({
      opponent: "wild:kernel",
      outcome: "won",
    });
    // Terminal carries the cathedral bill's authored metadata now.
    expect(tape.terminalStateSha256)
      .toBe("4c6014137a346b2be6e37469f054e4509336ea867f1fdd3724565ba494204826");
  });
});
