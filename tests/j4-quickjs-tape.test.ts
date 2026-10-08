import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";

import { buildJ4QuickjsTape } from "../tools/j4-quickjs-tape.ts";

describe("J4 QuickJS continuation tape", () => {
  test("starts at the radio chapter and carries every J4 battle through Kernel", () => {
    const tape = buildJ4QuickjsTape();
    expect(tape.format).toBe("pocket-tuxemon/j4-quickjs/v1");
    expect(tape.worldTraversal).toBe("seamless-v1");
    expect(tape.frames).toBe(13_622);
    expect(tape.frames).toBe(tape.masks.length);
    expect(tape.tapeSha256)
      .toBe(createHash("sha256").update(JSON.stringify(tape.masks)).digest("hex"));
    expect(tape.maps[0]).toEqual({ frame: 0, map: "spyder_radiotower" });
    expect(tape.maps.at(-1)).toMatchObject({ map: "spyder_datacenter" });
    expect(tape.battles).toHaveLength(15);
    expect(tape.battles[0]).toMatchObject({ opponent: "spyder_routee_calliope" });
    expect(tape.battles.filter((battle) => battle.kind === "wild").map((battle) => battle.opponent))
      .toEqual(["wild:pythwire", "wild:sockeserp", "wild:kernel"]);
    expect(tape.battles.at(-1)).toMatchObject({
      opponent: "wild:kernel",
      outcome: "won",
    });
    // Terminal carries the cathedral bill's authored metadata now.
    expect(tape.terminalStateSha256)
      .toBe("26032277d9391a611298f2367d752374d7bf6a7a8dfb9966fbc7399ef017d4e2");
  });
});
