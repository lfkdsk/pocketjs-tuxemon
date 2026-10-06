// Tuxepedia overlay visual tests: the production-rendered overlay at both
// viewports and both languages, compared against committed goldens, with
// semantic pixel assertions (selected-row accent, detail paper, unknown
// placeholder), tree-text assertions (title, counts, name, status, filter),
// the touch probe (tap selects, swipe pages), and the 2x composition check.

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, test } from "bun:test";

import { decodePng } from "../importer/png.ts";
import {
  captureTuxepedia,
  TUXEPEDIA_CASES,
  TUXEPEDIA_VIEWPORTS,
  type TuxepediaCase,
} from "../tools/tuxepedia-visual-fixture.ts";
import { TUXEMON_UI_THEME } from "../ui/tuxemon-theme.ts";
import { fnv1a, treeHasText } from "../vendor/pocket-rpgkit/vendor/pocketjs/hosts/sim/sim.ts";

const ROOT = resolve(import.meta.dir, "..");
const BUNDLE = join(ROOT, "dist/main");
const WASM = join(ROOT, "vendor/pocket-rpgkit/vendor/pocketjs/hosts/web/pocketjs.wasm");
const MANIFEST = join(ROOT, "data/tuxepedia-goldens.json");
const canBoot = existsSync(BUNDLE + ".js") && existsSync(BUNDLE + ".pak") &&
  existsSync(WASM) && existsSync(MANIFEST);
if (!canBoot) {
  console.warn("Tuxepedia visual tests skipped; run `bun run build && bun run build:wasm && bun tools/update-tuxepedia-goldens.ts`");
}
const simTest = canBoot ? test : test.skip;

const LANGS = ["en_US", "zh_CN"] as const;
type Lang = (typeof LANGS)[number];

interface GoldenEntry {
  case: TuxepediaCase;
  lang: Lang;
  width: number;
  height: number;
  file: string;
  rgbaFnv1a: string;
  pngSha256: string;
  cursor: number;
  filter: string;
  counts: { seen: number; caught: number; total: number };
}

interface TreeNode {
  n?: string;
  x?: string;
  k?: TreeNode[];
}

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

/** Every node in the tree whose name matches `predicate`, depth-first. */
function collectNodes(value: unknown, predicate: (name: string) => boolean): TreeNode[] {
  const out: TreeNode[] = [];
  const walk = (node: unknown): void => {
    const n = node as TreeNode;
    if (n?.n && predicate(n.n)) out.push(n);
    for (const child of n?.k ?? []) walk(child);
  };
  walk(value);
  return out;
}

const rowNodes = (tree: unknown): TreeNode[] =>
  collectNodes(tree, (name) => name.startsWith("tux-tuxepedia-row-"));
const rowTexts = (tree: unknown): string[] => rowNodes(tree).map(nodeText);

const manifest = canBoot
  ? JSON.parse(readFileSync(MANIFEST, "utf8")) as { format: string; frames: GoldenEntry[] }
  : { format: "", frames: [] };

function rgb(hex: string): readonly [number, number, number] {
  return [Number.parseInt(hex.slice(1, 3), 16), Number.parseInt(hex.slice(3, 5), 16), Number.parseInt(hex.slice(5, 7), 16)];
}

function countColour(
  rgba: Uint8Array,
  width: number,
  rect: { x: number; y: number; width: number; height: number },
  colour: readonly [number, number, number],
): number {
  let count = 0;
  for (let y = rect.y; y < rect.y + rect.height; y++) {
    for (let x = rect.x; x < rect.x + rect.width; x++) {
      const offset = (y * width + x) * 4;
      if (rgba[offset] === colour[0] && rgba[offset + 1] === colour[1] && rgba[offset + 2] === colour[2]) count++;
    }
  }
  return count;
}

type Capture = Awaited<ReturnType<typeof captureTuxepedia>>;
const captures = new Map<string, Promise<Capture>>();
function captured(viewportIndex: number, lang: Lang): Promise<Capture> {
  const key = `${viewportIndex}:${lang}`;
  let pending = captures.get(key);
  if (!pending) {
    pending = captureTuxepedia(TUXEPEDIA_VIEWPORTS[viewportIndex]!, lang);
    captures.set(key, pending);
  }
  return pending;
}

describe("Tuxepedia overlay visuals", () => {
  simTest("match the committed goldens at both viewports and both languages", async () => {
    expect(manifest.format).toBe("pocket-tuxemon/tuxepedia-goldens/v1");
    expect(manifest.frames).toHaveLength(TUXEPEDIA_VIEWPORTS.length * TUXEPEDIA_CASES.length * LANGS.length);
    for (let v = 0; v < TUXEPEDIA_VIEWPORTS.length; v++) {
      for (const lang of LANGS) {
        const capture = await captured(v, lang);
        const viewport = TUXEPEDIA_VIEWPORTS[v]!;
        for (const visualCase of TUXEPEDIA_CASES) {
          const entry = manifest.frames.find((candidate) =>
            candidate.case === visualCase && candidate.lang === lang
            && candidate.width === viewport.width && candidate.height === viewport.height);
          if (!entry) throw new Error(`Tuxepedia ${visualCase} ${lang}: missing ${viewport.width}x${viewport.height} golden`);
          const path = join(ROOT, "tests/goldens", entry.file);
          const png = new Uint8Array(readFileSync(path));
          const expected = decodePng(png, path);
          const frame = capture.cases[visualCase];
          expect([expected.width, expected.height]).toEqual([viewport.width, viewport.height]);
          expect(frame.rgba).toEqual(expected.rgba);
          expect(fnv1a(frame.rgba)).toBe(entry.rgbaFnv1a);
          expect(createHash("sha256").update(png).digest("hex")).toBe(entry.pngSha256);
          expect(frame.cursor).toBe(entry.cursor);
          expect(frame.filter).toBe(entry.filter);
          expect(frame.counts).toEqual(entry.counts);
        }
      }
    }
  }, 120_000);

  simTest("populated case shows the caught monster with art, facts and counts", async () => {
    const capture = await captured(0, "en_US");
    const frame = capture.cases.populated;
    const accent = rgb(TUXEMON_UI_THEME.accent);
    const paper = rgb(TUXEMON_UI_THEME.paper);
    // The selected Nut row (cursor 3, visible index 3) carries the accent.
    const rowY = 32 + 6 + 3 * 26;
    expect(countColour(frame.rgba, 480, { x: 13, y: rowY, width: 176, height: 22 }, accent)).toBeGreaterThan(2_500);
    // The detail panel is paper.
    expect(countColour(frame.rgba, 480, { x: 206, y: 34, width: 264, height: 214 }, paper)).toBeGreaterThan(20_000);
    // Tree text: title, counts, name, status, facts, description, legend.
    expect(nodeText(namedNode(frame.tree, "tux-tuxepedia-title"))).toBe("TUXEPEDIA");
    expect(nodeText(namedNode(frame.tree, "tux-tuxepedia-counts"))).toBe("SEEN 4  CAUGHT 2/255");
    expect(nodeText(namedNode(frame.tree, "tux-tuxepedia-name"))).toBe("Nut");
    expect(nodeText(namedNode(frame.tree, "tux-tuxepedia-status"))).toBe("CAUGHT");
    expect(treeHasText(frame.tree, "Metal")).toBeTrue();
    expect(JSON.stringify(frame.tree)).toContain("45 cm");
    expect(JSON.stringify(frame.tree)).toContain("4 kg");
    expect(JSON.stringify(frame.tree)).toContain("NUT and BOLT");
    expect(treeHasText(frame.tree, "square: filter")).toBeTrue();
    // The selected row's marker and the seen rows' markers.
    const texts = rowTexts(frame.tree);
    expect(texts.some((t) => t.includes("Nut") && t.endsWith("C"))).toBeTrue();
    expect(texts.some((t) => t.includes("Bolt") && t.endsWith("S"))).toBeTrue();
    // Count invariant: seen >= caught, and seen equals the S rows plus the C
    // rows (seen includes caught).
    const cRows = texts.filter((t) => t.endsWith("C")).length;
    const sRows = texts.filter((t) => t.endsWith("S")).length;
    expect(frame.counts.caught).toBe(cRows);
    expect(frame.counts.seen).toBe(cRows + sRows);
    expect(frame.counts.seen).toBeGreaterThanOrEqual(frame.counts.caught);
  }, 60_000);

  simTest("unknown case hides the monster behind a placeholder", async () => {
    const capture = await captured(0, "en_US");
    const frame = capture.cases.unknown;
    expect(nodeText(namedNode(frame.tree, "tux-tuxepedia-name"))).toBe("Unknown Tuxemon");
    expect(nodeText(namedNode(frame.tree, "tux-tuxepedia-status"))).toBe("UNKNOWN");
    expect(nodeText(namedNode(frame.tree, "tux-tuxepedia-unknown"))).toBe("???");
    expect(namedNode(frame.tree, "tux-tuxepedia-art")).toBeUndefined();
    expect(nodeText(namedNode(frame.tree, "tux-tuxepedia-counts"))).toBe("SEEN 0  CAUGHT 0/255");
    // Every list row is an unknown placeholder.
    const texts = rowTexts(frame.tree);
    expect(texts.length).toBeGreaterThan(0);
    expect(texts.every((t) => t.includes("???"))).toBeTrue();
  }, 60_000);

  simTest("caught filter lists only caught monsters", async () => {
    const en = await captured(0, "en_US");
    const zh = await captured(0, "zh_CN");
    const enFrame = en.cases.caughtFilter;
    const zhFrame = zh.cases.caughtFilter;
    expect(nodeText(namedNode(enFrame.tree, "tux-tuxepedia-filter"))).toBe("CAUGHT");
    expect(nodeText(namedNode(zhFrame.tree, "tux-tuxepedia-filter"))).toBe("已捕获");
    // Only the two caught monsters appear.
    const texts = rowTexts(enFrame.tree);
    expect(texts).toHaveLength(2);
    expect(texts.some((t) => t.includes("Rockitten"))).toBeTrue();
    expect(texts.some((t) => t.includes("Nut"))).toBeTrue();
    // The Chinese title and counts (seen = seen ∪ caught = 4).
    expect(nodeText(namedNode(zhFrame.tree, "tux-tuxepedia-title"))).toBe("图鉴");
    expect(nodeText(namedNode(zhFrame.tree, "tux-tuxepedia-counts"))).toBe("已见 4  已捕获 2/255");
  }, 60_000);

  simTest("zh build localizes type names and button hints", async () => {
    const zh = await captured(0, "zh_CN");
    const frame = zh.cases.populated;
    // Nut is a Metal type; the zh build shows the Chinese type name, not the
    // English slug, and the legend uses button glyphs, not English key names.
    expect(treeHasText(frame.tree, "金属")).toBeTrue();
    expect(treeHasText(frame.tree, "□: 筛选")).toBeTrue();
    expect(treeHasText(frame.tree, "×: 关闭")).toBeTrue();
    const json = JSON.stringify(frame.tree);
    expect(json).not.toContain("Metal");
    expect(json).not.toContain("square");
    // The detail panel and the legend carry no English type/key words.
    expect(nodeText(namedNode(frame.tree, "tux-tuxepedia-facts"))).toContain("金属");
    expect(nodeText(namedNode(frame.tree, "tux-tuxepedia-legend"))).toContain("□");
  }, 60_000);

  simTest("touch: tap selects a row and swipe pages the list", async () => {
    for (let v = 0; v < TUXEPEDIA_VIEWPORTS.length; v++) {
      for (const lang of LANGS) {
        const capture = await captured(v, lang);
        expect(capture.touch.tapWorked, `tap ${lang} ${capture.width}x${capture.height}`).toBeTrue();
        expect(capture.touch.swipeWorked, `swipe ${lang} ${capture.width}x${capture.height}`).toBeTrue();
        // The tap landed on a different row than the pre-tap cursor, and the
        // swipe paged it by exactly 8.
        expect(capture.touch.tapTo).not.toBe(capture.touch.tapFrom);
        expect(capture.touch.swipeTo - capture.touch.swipeFrom).toBe(8);
      }
    }
  }, 120_000);

  simTest("the 960x544 capture is the 2x composition of 480x272", async () => {
    for (const lang of LANGS) {
      const small = (await captured(0, lang)).cases.populated;
      const large = (await captured(1, lang)).cases.populated;
      let exactBlocks = 0;
      let channelError = 0;
      for (let y = 0; y < 272; y++) {
        for (let x = 0; x < 480; x++) {
          const source = (y * 480 + x) * 4;
          let exact = true;
          for (let oy = 0; oy < 2; oy++) {
            for (let ox = 0; ox < 2; ox++) {
              const target = ((y * 2 + oy) * 960 + x * 2 + ox) * 4;
              for (let channel = 0; channel < 4; channel++) {
                const difference = Math.abs(large.rgba[target + channel]! - small.rgba[source + channel]!);
                channelError += difference;
                if (difference !== 0) exact = false;
              }
            }
          }
          if (exact) exactBlocks++;
        }
      }
      const exactRatio = exactBlocks / (480 * 272);
      const meanError = channelError / (480 * 272 * 4 * 4);
      // Panels, rows and sprite are exact 2x; target-rasterized glyph edges
      // account for the bounded difference. The overlay carries more text
      // (eight list rows, details, legend) than the journal scene, so the
      // glyph budget is slightly looser.
      expect(exactRatio, `exactRatio ${lang}`).toBeGreaterThan(0.85);
      expect(meanError, `meanError ${lang}`).toBeLessThan(3.0);
    }
  }, 120_000);
});
