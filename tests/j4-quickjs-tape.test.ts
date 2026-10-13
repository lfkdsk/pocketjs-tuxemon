import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";

import { buildJ4QuickjsTape } from "../tools/j4-quickjs-tape.ts";

describe("J4 QuickJS continuation tape", () => {
  test("starts at the radio chapter and carries every J4 battle through Kernel", () => {
    const tape = buildJ4QuickjsTape();
    expect(tape.format).toBe("pocket-tuxemon/j4-quickjs/v1");
    expect(tape.worldTraversal).toBe("seamless-v1");
    expect(tape.frames).toBe(18_600);
    expect(tape.frames).toBe(tape.masks.length);
    expect(tape.tapeSha256)
      .toBe(createHash("sha256").update(JSON.stringify(tape.masks)).digest("hex"));
    expect(tape.maps[0]).toEqual({ frame: 0, map: "spyder_radiotower" });
    expect(tape.maps.at(-1)).toMatchObject({ map: "spyder_datacenter" });
    expect(tape.battles).toHaveLength(17);
    expect(tape.battles[0]).toMatchObject({ opponent: "wild:aardorn" });
    expect(tape.battles.filter((battle) => battle.kind === "wild").map((battle) => battle.opponent))
      .toEqual(["wild:aardorn", "wild:aardorn", "wild:pythwire", "wild:sockeserp", "wild:kernel"]);
    expect(tape.battles.at(-1)).toMatchObject({
      opponent: "wild:kernel",
      outcome: "won",
    });
    // Terminal includes the deterministic player identity selected in G6,
    // the calendar variables refreshed on map entry, the persisted step total,
    // and the map BGM clock.
    expect(tape.terminalStateSha256)
      .toBe("1977c1b0f3bd1bba2c4e5ad82332599c4fc72f0acd84d9437868976fbfb5c736");
  });
});
