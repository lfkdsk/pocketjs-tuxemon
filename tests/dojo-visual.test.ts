import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, test } from "bun:test";

import { decodePng } from "../importer/png.ts";
import {
  captureDojo,
  dojoGoldenFile,
  DOJO_VISUAL_CASES,
  DOJO_VISUAL_LANGS,
  DOJO_VISUAL_VIEWPORTS,
  type DojoLang,
  type DojoVisualCapture,
  type DojoVisualCase,
} from "../tools/dojo-visual-fixture.ts";
import { fnv1a } from "../vendor/pocket-rpgkit/vendor/pocketjs/hosts/sim/sim.ts";

const ROOT = resolve(import.meta.dir, "..");
const BUNDLE = join(ROOT, "dist/main");
const WASM = join(ROOT, "vendor/pocket-rpgkit/vendor/pocketjs/hosts/web/pocketjs.wasm");
const MANIFEST = join(ROOT, "data/dojo-goldens.json");
const canBoot = existsSync(BUNDLE + ".js") && existsSync(BUNDLE + ".pak") &&
  existsSync(WASM) && existsSync(MANIFEST);
if (!canBoot) console.warn("Dojo visual tests skipped; run `bun run import && bun run build && bun run build:wasm`");
const simTest = canBoot ? test : test.skip;

interface GoldenEntry {
  lang: DojoLang;
  case: DojoVisualCase;
  width: number;
  height: number;
  file: string;
  rgbaFnv1a: string;
  pngSha256: string;
}

const manifest = canBoot
  ? JSON.parse(readFileSync(MANIFEST, "utf8")) as { format: string; frames: GoldenEntry[] }
  : { format: "", frames: [] };

function treeText(tree: unknown): string {
  const output: string[] = [];
  const visit = (node: unknown): void => {
    if (!node || typeof node !== "object") return;
    const current = node as { x?: unknown; k?: unknown };
    if (typeof current.x === "string") output.push(current.x);
    if (Array.isArray(current.k)) for (const child of current.k) visit(child);
  };
  visit(tree);
  return output.join("\n");
}

/** Pixels inside an absolute rectangle that satisfy `test`. */
function count(
  capture: DojoVisualCapture,
  rect: { x0: number; y0: number; x1: number; y1: number },
  test: (r: number, g: number, b: number) => boolean,
): number {
  let total = 0;
  for (let y = rect.y0; y < rect.y1; y++) {
    for (let x = rect.x0; x < rect.x1; x++) {
      const i = (y * capture.width + x) * 4;
      if (test(capture.rgba[i]!, capture.rgba[i + 1]!, capture.rgba[i + 2]!)) total++;
    }
  }
  return total;
}

const yellow = (r: number, g: number, b: number) => r > 200 && g > 150 && b < 120;
const light = (r: number, g: number, b: number) => r > 150 && g > 150 && b > 150;

/** Bounds of light text pixels in one result-line band. */
function inkBounds(
  capture: DojoVisualCapture,
  rect: { x0: number; y0: number; x1: number; y1: number },
): { width: number; right: number } {
  let left = Infinity;
  let right = -1;
  for (let y = rect.y0; y < rect.y1; y++) {
    for (let x = rect.x0; x < rect.x1; x++) {
      const i = (y * capture.width + x) * 4;
      if (!light(capture.rgba[i]!, capture.rgba[i + 1]!, capture.rgba[i + 2]!)) continue;
      left = Math.min(left, x);
      right = Math.max(right, x);
    }
  }
  return { width: right < 0 ? 0 : right - left + 1, right };
}

const RESULT_INK: Record<DojoLang, Partial<Record<DojoVisualCase, {
  minWidth: number;
  minRight: number;
  ending: [number, number];
}>>> = {
  en_US: {
    learned: { minWidth: 185, minRight: 205, ending: [177, 210] },
    taste: { minWidth: 260, minRight: 280, ending: [249, 286] },
  },
  zh_CN: {
    learned: { minWidth: 125, minRight: 145, ending: [118, 151] },
    taste: { minWidth: 179, minRight: 199, ending: [170, 205] },
  },
};

const EXPECTED: Record<DojoLang, Record<DojoVisualCase, string[]>> = {
  en_US: {
    forget: ["Forget which technique?", "Boulder", "Mudslide", "Assault", "Thunderball"],
    learned: ["Rockitten learned technique Ram!"],
    devolve: ["Return to which form?", "Aardorn"],
    taste: ["Aardart's Cold Taste changed from Dry to Mild!"],
  },
  zh_CN: {
    forget: ["要遗忘哪个招式？", "岩石护罩", "泥石流", "突击", "霹雳弹"],
    learned: ["小岩猫 学会了招式 猛撞！"],
    devolve: ["要退回到哪种形态？", "阿尔多恩"],
    taste: ["阿尔达特的冷味从干涩变成了温和！"],
  },
};

const charset = new Set([...readFileSync(join(ROOT, "fonts/cjk-charset.txt"), "utf8")]);

describe("Spyder Dojo production screens", () => {
  for (const lang of DOJO_VISUAL_LANGS) {
    for (const visualCase of DOJO_VISUAL_CASES) {
      simTest(`${lang} ${visualCase} matches the inspected screens at 480x272 and 960x544`, async () => {
        for (const viewport of DOJO_VISUAL_VIEWPORTS) {
          const capture = await captureDojo(lang, visualCase, viewport);
          const text = treeText(capture.tree);
          // Every line is drawn whole (no clipping), and every Chinese glyph
          // is baked into the font (no missing-glyph boxes).
          for (const line of EXPECTED[lang][visualCase]) expect(text).toContain(line);
          expect(text).not.toContain("???");
          expect([...text].filter((ch) => ch.charCodeAt(0) >= 0x3000 && !charset.has(ch))).toEqual([]);

          if (visualCase === "forget" || visualCase === "devolve") {
            // The selected row is visibly inked in the fixed-size, right-
            // anchored menu instead of being satisfied by map pixels.
            const selectedY = visualCase === "forget" ? capture.height - 177 : capture.height - 135;
            expect(count(capture, {
              x0: capture.width - 255,
              y0: selectedY,
              x1: capture.width - 190,
              y1: selectedY + 13,
            }, yellow)).toBeGreaterThanOrEqual(60);
            if (visualCase === "forget") {
              // The last option (Thunderball / 霹雳弹) is present too.
              expect(count(capture, {
                x0: capture.width - 255,
                y0: capture.height - 135,
                x1: capture.width - 120,
                y1: capture.height - 118,
              }, light)).toBeGreaterThanOrEqual(120);
            }
          } else {
            // Measure only the first text row (not the map or box chrome),
            // prove its ending word/glyph is inked, and prove it did not wrap.
            const expected = RESULT_INK[lang][visualCase]!;
            const firstLine = { x0: 12, y0: capture.height - 90, x1: 350, y1: capture.height - 73 };
            const bounds = inkBounds(capture, firstLine);
            expect(bounds.width).toBeGreaterThanOrEqual(expected.minWidth);
            expect(bounds.right).toBeGreaterThanOrEqual(expected.minRight);
            expect(count(capture, {
              x0: expected.ending[0],
              y0: capture.height - 90,
              x1: expected.ending[1],
              y1: capture.height - 73,
            }, light)).toBeGreaterThan(40);
            expect(count(capture, {
              x0: 12,
              y0: capture.height - 72,
              x1: 350,
              y1: capture.height - 56,
            }, light)).toBe(0);
          }

          const golden = manifest.frames.find((frame) => frame.lang === lang && frame.case === visualCase
            && frame.width === viewport.width && frame.height === viewport.height)!;
          expect(golden.file).toBe(dojoGoldenFile(lang, visualCase, viewport));
          const png = readFileSync(join(ROOT, "tests/goldens", golden.file));
          expect(createHash("sha256").update(png).digest("hex")).toBe(golden.pngSha256);
          const decoded = decodePng(new Uint8Array(png), golden.file);
          expect([decoded.width, decoded.height]).toEqual([viewport.width, viewport.height]);
          expect(fnv1a(decoded.rgba)).toBe(golden.rgbaFnv1a);
          expect(fnv1a(capture.rgba)).toBe(golden.rgbaFnv1a);
        }
      }, 60_000);
    }
  }
});
