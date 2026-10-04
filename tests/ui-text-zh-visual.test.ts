import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, test } from "bun:test";

import { decodePng } from "../importer/png.ts";
import {
  captureUiTextZh,
  UI_TEXT_ZH_CASES,
  UI_TEXT_ZH_VIEWPORTS,
  type UiTextZhVisualCase,
} from "../tools/ui-text-zh-visual-fixture.ts";
import {
  loadFontMask,
  maskMatch,
  renderTextMask,
  type TextMask,
} from "../tools/zh-font-mask.ts";
import { fnv1a } from "../vendor/pocket-rpgkit/vendor/pocketjs/hosts/sim/sim.ts";

const ROOT = resolve(import.meta.dir, "..");
const BUNDLE = join(ROOT, "dist/main");
const WASM = join(ROOT, "vendor/pocket-rpgkit/vendor/pocketjs/hosts/web/pocketjs.wasm");
const MANIFEST = join(ROOT, "data/ui-text-zh-goldens.json");
const canBoot = existsSync(BUNDLE + ".js") && existsSync(BUNDLE + ".pak")
  && existsSync(WASM) && existsSync(MANIFEST);
if (!canBoot) {
  console.warn(
    "zh UI-text visual tests skipped; run `bun run build && bun run build:wasm && bun run goldens:ui-text:zh`",
  );
}
const simTest = canBoot ? test : test.skip;

interface GoldenEntry {
  case: UiTextZhVisualCase;
  width: number;
  height: number;
  file: string;
  rgbaFnv1a: string;
  pngSha256: string;
}

interface TreeNode {
  n?: string;
  x?: string;
  k?: TreeNode[];
}

interface Region {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

interface GlyphCheck {
  case: UiTextZhVisualCase;
  text: string;
  region: Region;
  ink: "light" | "dark";
  scale?: number;
}

const manifest = canBoot
  ? JSON.parse(readFileSync(MANIFEST, "utf8")) as { format: string; frames: GoldenEntry[] }
  : { format: "", frames: [] };

function namedNode(value: unknown, name: string): TreeNode | undefined {
  const node = value as TreeNode;
  if (node?.n === name) return node;
  for (const child of node?.k ?? []) {
    const found = namedNode(child, name);
    if (found) return found;
  }
  return undefined;
}

function nodeText(node: TreeNode | undefined): string {
  return node ? `${node.x ?? ""}${(node.k ?? []).map(nodeText).join("")}` : "";
}

function textLeaves(node: TreeNode | undefined, output: string[] = []): string[] {
  if (!node) return output;
  if (typeof node.x === "string") output.push(node.x);
  for (const child of node.k ?? []) textLeaves(child, output);
  return output;
}

function requireNode(tree: unknown, name: string): TreeNode {
  const node = namedNode(tree, name);
  if (!node) throw new Error(`zh UI-text visual: missing ${name}`);
  return node;
}

function scaleMask(mask: TextMask, scale: number): TextMask {
  if (scale === 1) return mask;
  const width = mask.width * scale;
  const height = mask.height * scale;
  const ink = new Uint8Array(width * height);
  for (let y = 0; y < mask.height; y++) for (let x = 0; x < mask.width; x++) {
    if (!mask.ink[y * mask.width + x]) continue;
    for (let dy = 0; dy < scale; dy++) for (let dx = 0; dx < scale; dx++) {
      ink[(y * scale + dy) * width + x * scale + dx] = 1;
    }
  }
  return { width, height, ink };
}

function bestGlyphMatch(
  rgba: Uint8Array,
  width: number,
  mask: TextMask,
  region: Region,
  ink: GlyphCheck["ink"],
): { score: number; x: number; y: number } {
  const isOn = (x: number, y: number): boolean => {
    const offset = (y * width + x) * 4;
    const sum = rgba[offset]! + rgba[offset + 1]! + rgba[offset + 2]!;
    return ink === "light" ? sum > 300 : sum < 500;
  };
  let best = { score: 0, x: 0, y: 0 };
  for (let y = region.y0; y <= region.y1 - mask.height; y++) {
    for (let x = region.x0; x <= region.x1 - mask.width; x++) {
      const match = maskMatch(mask, rgba, width, x, y, isOn);
      if (match.score > best.score) best = { score: match.score, x, y };
    }
  }
  return best;
}

let capturePromise: Promise<{
  small: Awaited<ReturnType<typeof captureUiTextZh>>;
  large: Awaited<ReturnType<typeof captureUiTextZh>>;
}> | undefined;
function captures() {
  return capturePromise ??= (async () => ({
    small: await captureUiTextZh(UI_TEXT_ZH_VIEWPORTS[0]),
    large: await captureUiTextZh(UI_TEXT_ZH_VIEWPORTS[1]),
  }))();
}

function assertSurfaceText(tree: unknown): void {
  expect(nodeText(requireNode(tree, "rpgkit-save-title"))).toBe("存档菜单");
  expect(nodeText(requireNode(tree, "rpgkit-save-root-0"))).toBe("> 保存到存档位");
  expect(nodeText(requireNode(tree, "rpgkit-save-root-1"))).toBe("  从存档位加载");
  expect(nodeText(requireNode(tree, "rpgkit-save-root-2"))).toBe("  导出存档码");
  expect(nodeText(requireNode(tree, "rpgkit-save-root-3"))).toBe("  导入存档码");
  // The game-owned footer legend (outside the kit's UiTextTable) is localized.
  expect(nodeText(requireNode(tree, "rpgkit-save-legend"))).toBe("o: 选择   x: 返回   START: 关闭");
}

describe("Simplified Chinese kit interface visuals", () => {
  simTest("matches all seven production surfaces at both committed viewports", async () => {
    expect(manifest.format).toBe("pocket-tuxemon/ui-text-zh-goldens/v1");
    expect(manifest.frames).toHaveLength(UI_TEXT_ZH_VIEWPORTS.length * UI_TEXT_ZH_CASES.length);
    const { small, large } = await captures();
    for (const [index, viewport] of UI_TEXT_ZH_VIEWPORTS.entries()) {
      const capture = index === 0 ? small : large;
      for (const visualCase of UI_TEXT_ZH_CASES) {
        const entry = manifest.frames.find((candidate) =>
          candidate.case === visualCase
          && candidate.width === viewport.width
          && candidate.height === viewport.height
        );
        if (!entry) {
          throw new Error(`zh UI-text golden: missing ${visualCase} ${viewport.width}x${viewport.height}`);
        }
        const path = join(ROOT, "tests/goldens", entry.file);
        const png = new Uint8Array(readFileSync(path));
        const expected = decodePng(png, path);
        const actual = capture.cases[visualCase].rgba;
        expect([expected.width, expected.height], entry.file).toEqual([viewport.width, viewport.height]);
        expect(actual, entry.file).toEqual(expected.rgba);
        expect(fnv1a(actual), entry.file).toBe(entry.rgbaFnv1a);
        expect(createHash("sha256").update(png).digest("hex"), entry.file).toBe(entry.pngSha256);
      }
    }
  }, 60_000);

  simTest("shows exact Chinese labels without component-inserted ellipses", async () => {
    const all = await captures();
    for (const capture of [all.small, all.large]) {
      assertSurfaceText(capture.cases["save-menu"].tree);

      const name = requireNode(capture.cases["name-input"].tree, "rpgkit-name-input-scene");
      const nameWords = textLeaves(name);
      for (const expected of ["姓名", "删除", "确定", "取消"]) expect(nameWords).toContain(expected);
      // X is also a legitimate keyboard character, so identify the action
      // cells by their fixed position at the end instead of banning that
      // glyph from the whole keyboard.
      expect(nameWords.slice(-3)).toEqual(["删除", "确定", "取消"]);
      for (const englishDefault of ["Name", "<", "OK"]) expect(nameWords).not.toContain(englishDefault);

      const demoTree = capture.cases["demo-menu"].tree;
      expect(nodeText(requireNode(demoTree, "rpgkit-demo-menu-title"))).toBe("演示菜单");
      expect(nodeText(requireNode(demoTree, "rpgkit-demo-menu-tabs")))
        .toBe("【章节】  地图跳转  自动演示");
      expect(nodeText(requireNode(demoTree, "rpgkit-demo-menu-legend")))
        .toBe("左右键：翻页  上下键：选择  A：确定  B：关闭");

      const shopTree = capture.cases.shop.tree;
      expect(nodeText(requireNode(shopTree, "rpgkit-shop-stage"))).toBe("购买");
      expect(nodeText(requireNode(shopTree, "rpgkit-shop-gold"))).toBe("金币：8888");
      expect(nodeText(requireNode(shopTree, "rpgkit-shop-box")).replace(/\s+/g, " "))
        .toContain("3150 金币（库存 3）");
      expect(nodeText(requireNode(shopTree, "rpgkit-shop-legend"))).toBe("○ 确定 · × 返回");

      const hintsTree = capture.cases["button-hints"].tree;
      expect(nodeText(requireNode(hintsTree, "rpgkit-choice-prompt"))).toBe("要继续吗？");
      expect(nodeText(requireNode(hintsTree, "rpgkit-choice-legend"))).toBe("○ 确定 · × 返回");

      const errorTree = capture.cases["event-error"].tree;
      expect(nodeText(requireNode(errorTree, "rpgkit-fatal-error-title"))).toBe("事件错误");
      expect(nodeText(requireNode(errorTree, "rpgkit-fatal-error-message"))).toBe("测试事件无法继续。");

      const battleTree = capture.cases["battle-status"].tree;
      expect(nodeText(requireNode(battleTree, "player-hp-numbers"))).toBe("105／105");
      expect(nodeText(requireNode(battleTree, "battle-message-row-0"))).toBe("螺母兽 要做什么？");
      expect(nodeText(requireNode(battleTree, "battle-commands-cell-0"))).toBe("> 战斗");

      const visibleSurfaces = [
        requireNode(capture.cases["save-menu"].tree, "rpgkit-save-overlay"),
        name,
        requireNode(demoTree, "rpgkit-demo-menu-overlay"),
        requireNode(shopTree, "rpgkit-shop-box"),
        requireNode(hintsTree, "rpgkit-choices-box"),
        requireNode(errorTree, "rpgkit-fatal-error"),
        requireNode(battleTree, "tux-battle-canvas"),
      ];
      expect(visibleSurfaces.flatMap((surface) => textLeaves(surface)).filter((line) => line.includes("…")))
        .toEqual([]);
    }
  }, 60_000);

  simTest("matches Chinese glyph shapes on four surfaces at both viewports", async () => {
    const all = await captures();
    const font = loadFontMask();
    const checks: Record<"small" | "large", GlyphCheck[]> = {
      small: [
        { case: "shop", text: "购买", region: { x0: 220, y0: 70, x1: 300, y1: 105 }, ink: "light" },
        { case: "name-input", text: "删除", region: { x0: 300, y0: 185, x1: 380, y1: 225 }, ink: "light" },
        { case: "button-hints", text: "○ 确定 · × 返回", region: { x0: 350, y0: 140, x1: 470, y1: 175 }, ink: "light" },
        { case: "battle-status", text: "105／105", region: { x0: 390, y0: 110, x1: 475, y1: 150 }, ink: "dark" },
      ],
      large: [
        { case: "shop", text: "购买", region: { x0: 700, y0: 340, x1: 780, y1: 385 }, ink: "light" },
        { case: "name-input", text: "删除", region: { x0: 630, y0: 390, x1: 730, y1: 450 }, ink: "light" },
        { case: "button-hints", text: "○ 确定 · × 返回", region: { x0: 820, y0: 400, x1: 950, y1: 455 }, ink: "light" },
        { case: "battle-status", text: "105／105", region: { x0: 780, y0: 220, x1: 950, y1: 300 }, ink: "dark", scale: 2 },
      ],
    };
    for (const size of ["small", "large"] as const) {
      const capture = all[size];
      for (const check of checks[size]) {
        const mask = scaleMask(renderTextMask(font, check.text), check.scale ?? 1);
        const match = bestGlyphMatch(
          capture.cases[check.case].rgba,
          capture.width,
          mask,
          check.region,
          check.ink,
        );
        expect(
          match.score,
          `${check.case} ${capture.width}x${capture.height} “${check.text}” at ${match.x},${match.y}`,
        ).toBeGreaterThan(0.8);
      }
    }
  }, 60_000);
});
