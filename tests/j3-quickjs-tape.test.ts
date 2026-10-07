import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";

import { buildJ3QuickjsTape } from "../tools/j3-quickjs-tape.ts";

describe("J3 QuickJS continuation tape", () => {
  test("starts at the hospital chapter and carries every J3 battle to the broadcast", () => {
    const tape = buildJ3QuickjsTape();
    expect(tape.format).toBe("pocket-tuxemon/j3-quickjs/v1");
    expect(tape.worldTraversal).toBe("seamless-v1");
    expect(tape.frames).toBe(12_941);
    expect(tape.frames).toBe(tape.masks.length);
    expect(tape.tapeSha256)
      .toBe(createHash("sha256").update(JSON.stringify(tape.masks)).digest("hex"));
    expect(tape.maps[0]).toEqual({ frame: 0, map: "spyder_candy_hospital3" });
    expect(tape.maps.at(-1)).toMatchObject({ map: "spyder_radiotower" });
    expect(tape.battles).toHaveLength(13);
    expect(tape.battles[0]).toMatchObject({ opponent: "spyder_billie", startFrame: 97 });
    expect(tape.battles.at(-1)).toMatchObject({
      opponent: "spyder_omnichannel_beaverbrook",
      outcome: "won",
    });
    // Terminal carries the cathedral bill's authored metadata now.
    expect(tape.terminalStateSha256)
      .toBe("3a77d10652eaf061d57447276053948adfe8e318ba3f6e76fa35dd48c4981f2d");
  });
});
