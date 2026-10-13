import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";

import { buildJ3QuickjsTape } from "../tools/j3-quickjs-tape.ts";

describe("J3 QuickJS continuation tape", () => {
  test("starts at the hospital chapter and carries every J3 battle to the broadcast", () => {
    const tape = buildJ3QuickjsTape();
    expect(tape.format).toBe("pocket-tuxemon/j3-quickjs/v1");
    expect(tape.worldTraversal).toBe("seamless-v1");
    expect(tape.frames).toBe(18_001);
    expect(tape.frames).toBe(tape.masks.length);
    expect(tape.tapeSha256)
      .toBe(createHash("sha256").update(JSON.stringify(tape.masks)).digest("hex"));
    expect(tape.maps[0]).toEqual({ frame: 0, map: "spyder_candy_hospital3" });
    expect(tape.maps.at(-1)).toMatchObject({ map: "spyder_radiotower" });
    expect(tape.battles).toHaveLength(15);
    expect(tape.battles[0]).toMatchObject({ opponent: "spyder_billie", startFrame: 97 });
    expect(tape.battles.at(-1)).toMatchObject({
      opponent: "spyder_omnichannel_beaverbrook",
      outcome: "won",
    });
    // Terminal includes the deterministic player identity selected in G6,
    // the calendar variables refreshed on map entry, the persisted step total,
    // and the map BGM clock.
    expect(tape.terminalStateSha256)
      .toBe("49307027321e7f51ab1a8c81e48ca615cd70d636c289f4170e63fc408b1774bf");
  });
});
