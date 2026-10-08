import { describe, expect, test } from "bun:test";

import { utilitySceneAutoplayMask } from "../tools/scene-autoplay.ts";
import { BTN_BITS } from "../vendor/pocket-rpgkit/src/engine/camera.ts";
import { NAME_INPUT_SCENE_ID } from "../vendor/pocket-rpgkit/src/engine/name-input.ts";

const CONFIRM = 0x2000;
const charset = ["A", "B"];
const scene = (buffer: string, cursor: number, random: boolean) => ({
  kind: "scene" as const,
  id: NAME_INPUT_SCENE_ID,
  state: { buffer, cursor, charset, random },
});

describe("acceptance-journey name input policy", () => {
  test("selects RANDOM when the scene resolved a candidate pool", () => {
    expect(utilitySceneAutoplayMask(scene("", 0, true))).toBe(BTN_BITS.LEFT);
    expect(utilitySceneAutoplayMask(scene("", charset.length + 3, true))).toBe(CONFIRM);
  });

  test("confirms a generated name and retains the plain A fallback", () => {
    expect(utilitySceneAutoplayMask(scene("Finnick", charset.length + 1, true))).toBe(CONFIRM);
    expect(utilitySceneAutoplayMask(scene("", 0, false))).toBe(CONFIRM);
  });
});
