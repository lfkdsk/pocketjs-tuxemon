import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, test } from "bun:test";

import {
  animationPresentation,
  ballPresentation,
  presentationActiveMonster,
  presentationHp,
  presentationMaxHp,
} from "../battle/presentation.ts";
import type { RuntimeBattleState } from "../battle/runtime.ts";
import { decodePng } from "../importer/png.ts";
import {
  captureGb5BattleFrames,
  GB5_FRAME_NAMES,
  type Gb5BattleCapture,
  type Gb5CapturedFrame,
  type Gb5FrameName,
} from "../tools/gb5-battle-fixture.ts";
import { battlePreviewSourcePath } from "../tools/render-battle-preview.ts";
import { BATTLE_RECTS as R } from "../ui/battle-layout.ts";
import { barFillWidth } from "../vendor/pocket-rpgkit/src/ui/battle/effects.ts";
import { fnv1a } from "../vendor/pocket-rpgkit/vendor/pocketjs/hosts/sim/sim.ts";

const ROOT = resolve(import.meta.dir, "..");
const manifest = JSON.parse(readFileSync(join(ROOT, "data/gb5-battle-goldens.json"), "utf8")) as {
  format: string;
  frames: Array<{
    name: Gb5FrameName;
    width: number;
    height: number;
    file: string;
    rgbaFnv1a: string;
    pngSha256: string;
  }>;
};

const PIXEL_BYTES = 4;
const rgb = (rgba: Uint8Array, width: number, x: number, y: number): number[] =>
  [...rgba.slice((y * width + x) * PIXEL_BYTES, (y * width + x) * PIXEL_BYTES + 3)];

function countColour(
  rgba: Uint8Array,
  width: number,
  rect: { x: number; y: number; width: number; height: number },
  colour: readonly [number, number, number],
): number {
  let count = 0;
  for (let y = rect.y; y < rect.y + rect.height; y++) {
    for (let x = rect.x; x < rect.x + rect.width; x++) {
      const i = (y * width + x) * PIXEL_BYTES;
      if (rgba[i] === colour[0] && rgba[i + 1] === colour[1] && rgba[i + 2] === colour[2]) count++;
    }
  }
  return count;
}

function stateMonster(state: RuntimeBattleState, uid: number) {
  const monster = state.battle.parties.flat().find((candidate) => candidate.uid === uid);
  if (!monster) throw new Error(`GB5 semantic pixels: unknown monster uid ${uid}`);
  return monster;
}

function twoXSimilarity(small: Uint8Array, large: Uint8Array): { exactRatio: number; meanChannelError: number } {
  let exactBlocks = 0;
  let channelError = 0;
  for (let y = 0; y < 272; y++) for (let x = 0; x < 480; x++) {
    const source = (y * 480 + x) * PIXEL_BYTES;
    let exact = true;
    for (let oy = 0; oy < 2; oy++) for (let ox = 0; ox < 2; ox++) {
      const target = ((y * 2 + oy) * 960 + x * 2 + ox) * PIXEL_BYTES;
      for (let channel = 0; channel < PIXEL_BYTES; channel++) {
        const difference = Math.abs(large[target + channel]! - small[source + channel]!);
        channelError += difference;
        if (difference !== 0) exact = false;
      }
    }
    if (exact) exactBlocks++;
  }
  return {
    exactRatio: exactBlocks / (480 * 272),
    meanChannelError: channelError / (480 * 272 * 4 * PIXEL_BYTES),
  };
}

function golden(name: Gb5FrameName, width: number, height: number) {
  const entry = manifest.frames.find((candidate) =>
    candidate.name === name && candidate.width === width && candidate.height === height
  );
  if (!entry) throw new Error(`GB5 golden manifest: missing ${name} ${width}x${height}`);
  const path = join(ROOT, "tests/goldens", entry.file);
  const png = new Uint8Array(readFileSync(path));
  return { entry, png, image: decodePng(png, path) };
}

function assertGolden(capture: Gb5BattleCapture, name: Gb5FrameName): void {
  const expected = golden(name, capture.width, capture.height);
  const actual = capture.frames[name].rgba;
  expect([expected.image.width, expected.image.height]).toEqual([capture.width, capture.height]);
  expect(actual, `${name} ${capture.width}x${capture.height}`).toEqual(expected.image.rgba);
  expect(fnv1a(actual)).toBe(expected.entry.rgbaFnv1a);
  expect(createHash("sha256").update(expected.png).digest("hex")).toBe(expected.entry.pngSha256);
}

let captures: Promise<{ small: Gb5BattleCapture; large: Gb5BattleCapture }> | undefined;
function captured() {
  return captures ??= (async () => ({
    small: await captureGb5BattleFrames(
      { width: 480, height: 272 },
      { trackStructure: true, trackTextures: true },
    ),
    large: await captureGb5BattleFrames({ width: 960, height: 544 }),
  }))();
}

describe("GB5 real battle scene goldens", () => {
  test("six checkpoints match committed pixels at 480x272 and 960x544", async () => {
    const { small, large } = await captured();
    expect(manifest.format).toBe("pocket-tuxemon/gb5-battle-goldens/v1");
    expect(manifest.frames).toHaveLength(GB5_FRAME_NAMES.length * 2);
    for (const name of GB5_FRAME_NAMES) {
      assertGolden(small, name);
      assertGolden(large, name);
    }
  }, 60_000);

  test("960x544 keeps the same 2x composition with only target-scale edge rasterisation", async () => {
    const { small, large } = await captured();
    for (const name of GB5_FRAME_NAMES) {
      const similarity = twoXSimilarity(small.frames[name].rgba, large.frames[name].rgba);
      // Images, panels, bars, and layout coordinates are exact 2x blocks.
      // PocketJS intentionally rasterises glyph/alpha edges at the target
      // viewport, so those few edge blocks may differ by blend rounding.
      // The ratio moves with the glyph count: the technique menu sits at
      // 0.9696 with Nut at 105 / 105 HP (0.9701 at 101 / 101), all of the
      // extra blocks inside the HP numbers.
      expect(similarity.exactRatio, name).toBeGreaterThan(0.965);
      expect(similarity.meanChannelError, name).toBeLessThan(0.6);
    }
  }, 60_000);

  test("README battle screenshot is an exact nearest-neighbour 2x skill-menu frame", async () => {
    const { small } = await captured();
    const screenshot = decodePng(
      new Uint8Array(readFileSync(join(ROOT, "docs/screenshots/battle.png"))),
      "docs/screenshots/battle.png",
    );
    expect([screenshot.width, screenshot.height]).toEqual([960, 544]);
    expect(twoXSimilarity(small.frames["technique-menu"].rgba, screenshot.rgba))
      .toEqual({ exactRatio: 1, meanChannelError: 0 });
  }, 60_000);

  test("HP width, menu highlights, capture-ball pose, and animation frame are semantic pixels", async () => {
    const { small } = await captured();

    const hit = small.frames.hit;
    const hitEvent = hit.state.battle.events[hit.state.eventCursor]!;
    if (hitEvent.type !== "technique" || typeof hitEvent.target !== "number") {
      throw new Error("GB5 semantic pixels: hit checkpoint is not a targeted technique");
    }
    const target = stateMonster(hit.state, hitEvent.target);
    const hp = presentationHp(hit.state, target.uid);
    const maximum = presentationMaxHp(hit.state, target.uid);
    const fill = barFillWidth(hp, maximum, R.enemyHp.width);
    const fillColour = hp / maximum > 0.5 ? [0x49, 0xc9, 0x6d]
      : hp / maximum > 0.2 ? [0xf2, 0xc9, 0x4c] : [0xed, 0x5b, 0x5b];
    expect(fill).toBeGreaterThan(0);
    expect(fill).toBeLessThan(R.enemyHp.width);
    expect(rgb(hit.rgba, 480, R.enemyHp.x + fill - 1, R.enemyHp.y + 3)).toEqual(fillColour);
    expect(rgb(hit.rgba, 480, R.enemyHp.x + fill, R.enemyHp.y + 3)).toEqual([0x26, 0x3b, 0x43]);

    const accent = [0xd2, 0x7b, 0x2c] as const;
    const dim = [0x53, 0x7b, 0x80] as const;
    const mainFrame = small.frames["main-menu"];
    const main = mainFrame.rgba;
    const player = presentationActiveMonster(mainFrame.state, 0);
    expect([presentationHp(mainFrame.state, player.uid), presentationMaxHp(mainFrame.state, player.uid)])
      .toEqual([105, 105]);
    const ink = [0x10, 0x2b, 0x3a] as const;
    // The last 5 has opaque ink in this cell, followed by clear HUD paper.
    // With the former 100 px bar, the final digit instead ran into x=480.
    expect(countColour(main, 480, { x: 454, y: 125, width: 12, height: 14 }, ink)).toBeGreaterThan(1);
    expect(countColour(main, 480, { x: 468, y: 125, width: 8, height: 14 }, ink)).toBe(0);
    const commandCells = [
      { x: 246, y: 222, width: 112, height: 20 },
      { x: 362, y: 222, width: 112, height: 20 },
      { x: 246, y: 244, width: 112, height: 20 },
      { x: 362, y: 244, width: 112, height: 20 },
    ] as const;
    expect(mainFrame.state.menu.map(({ slug, available }) => [slug, available])).toEqual([
      ["fight", true],
      ["swap", false],
      ["item", false],
      ["forfeit", false],
    ]);
    expect(mainFrame.state.menu[mainFrame.state.menuIndex]?.available).toBeTrue();
    expect(countColour(main, 480, commandCells[0], accent)).toBeGreaterThan(4);
    for (const cell of commandCells.slice(1)) {
      // The full disabled command label remains visible in the theme's dim
      // colour; filtering it out (the original bug) leaves no dim glyphs.
      expect(countColour(main, 480, cell, dim)).toBeGreaterThan(4);
      expect(countColour(main, 480, cell, accent)).toBe(0);
    }
    const skills = small.frames["technique-menu"].rgba;
    expect(countColour(skills, 480, { x: 246, y: 237, width: 228, height: 14 }, accent)).toBeGreaterThan(4);
    expect(countColour(skills, 480, { x: 246, y: 251, width: 228, height: 14 }, accent)).toBe(0);

    const capture = small.frames["capture-shake"];
    const pose = ballPresentation(capture.state);
    expect(pose).toMatchObject({ kind: "capture", x: 352, y: 48, shake: 7, opacity: 1 });
    const ref = capture.state.visuals.items.tuxeball!.captureSprite!;
    const ball = decodePng(
      new Uint8Array(readFileSync(battlePreviewSourcePath(ROOT, ref))),
      ref.key,
    );
    let matched = 0;
    for (let y = 0; y < Math.min(32, ball.height); y++) for (let x = 0; x < Math.min(32, ball.width); x++) {
      const source = (y * ball.width + x) * PIXEL_BYTES;
      if (ball.rgba[source + 3] !== 255) continue;
      expect(rgb(capture.rgba, 480, pose.x + pose.shake + x, pose.y + y))
        // The indexed migration preserves the old RGBA4444 framebuffer
        // contract: opaque PNG channels are truncated and expanded by 17.
        .toEqual([...ball.rgba.slice(source, source + 3)].map((channel) => Math.floor(channel / 16) * 17));
      matched++;
    }
    expect(matched).toBeGreaterThan(40);

    const animation = animationPresentation(hit.state);
    expect(animation.opacity).toBe(1);
    expect(animation.page).not.toBeNull();
    expect(animation.sourceX).toBeGreaterThanOrEqual(0);
    expect(animation.frameKeys.length).toBeGreaterThan(1);
  }, 60_000);

  test("same-scene rewind to the serialised hit cursor restores every pixel", async () => {
    const { small, large } = await captured();
    expect(small.rewoundHit).toEqual(small.frames.hit.rgba);
    expect(large.rewoundHit).toEqual(large.frames.hit.rgba);
  }, 60_000);

  test("every steady battle frame performs zero node lifecycle operations", async () => {
    const { small } = await captured();
    expect(small.structuralSamples.length).toBeGreaterThan(500);
    expect(new Set(small.structuralSamples.map((sample) => sample.event))).toEqual(
      new Set(["sendOut", "menu:root", "menu:technique", "decision", "technique", "status", "round", "faint", "capture"]),
    );
    for (const sample of small.structuralSamples) {
      expect(
        sample.createNode + sample.destroyNode + sample.insertBefore + sample.removeChild,
        `structural churn at host frame ${sample.hostFrame} (${sample.event}@${sample.eventTicks})`,
      ).toBe(0);
    }
  }, 60_000);

  test("three battle scopes detach and free every lazy texture", async () => {
    const { small } = await captured();
    expect(small.textureCycles).toHaveLength(3);
    for (const [cycleIndex, cycle] of small.textureCycles.entries()) {
      expect(cycle.loads.length, `cycle ${cycleIndex} loads`).toBeGreaterThan(0);
      expect(new Set(cycle.loads).size, `cycle ${cycleIndex} unique loads`).toBe(cycle.loads.length);
      expect([...cycle.frees].sort((a, b) => a - b), `cycle ${cycleIndex} balanced frees`)
        .toEqual([...cycle.loads].sort((a, b) => a - b));

      const attached = new Map<number, number>();
      for (const operation of cycle.operations) {
        if (operation.kind === "set") attached.set(operation.node!, operation.handle);
        if (operation.kind === "free" && cycle.loads.includes(operation.handle)) {
          expect(
            [...attached.values()].includes(operation.handle),
            `cycle ${cycleIndex} handle ${operation.handle} must detach before free`,
          ).toBeFalse();
        }
      }
    }
  }, 60_000);
});
