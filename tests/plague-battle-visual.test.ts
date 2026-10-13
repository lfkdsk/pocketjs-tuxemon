// Real-product visual coverage for the campaign-reachable plague technique
// override: imported data, shipped BattleRules, production Solid scene, both
// languages and both supported viewport sizes.

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, test } from "bun:test";

import { decodePng } from "../importer/png.ts";
import {
  capturePlague,
  PLAGUE_VISUAL_CASES,
  PLAGUE_VISUAL_LANGS,
  PLAGUE_VISUAL_VIEWPORTS,
  type PlagueVisualCapture,
  type PlagueVisualCase,
  type PlagueVisualLang,
} from "../tools/plague-visual-fixture.ts";
import { fnv1a } from "../vendor/pocket-rpgkit/vendor/pocketjs/hosts/sim/sim.ts";

const ROOT = resolve(import.meta.dir, "..");
const BUNDLE = join(ROOT, "dist/main");
const WASM = join(ROOT, "vendor/pocket-rpgkit/vendor/pocketjs/hosts/web/pocketjs.wasm");
const MANIFEST = join(ROOT, "data/plague-goldens.json");
const canBoot = existsSync(BUNDLE + ".js") && existsSync(BUNDLE + ".pak")
  && existsSync(WASM) && existsSync(MANIFEST);
if (!canBoot) {
  console.warn("Plague visual tests skipped; run `bun run import && bun run build && bun run goldens:plague`");
}
const simTest = canBoot ? test : test.skip;

interface GoldenEntry {
  lang: PlagueVisualLang;
  case: PlagueVisualCase;
  width: number;
  height: number;
  file: string;
  seed: number;
  eventIndex: number;
  eventTicks: number;
  rgbaFnv1a: string;
  pngSha256: string;
}

interface TreeNode {
  n?: string;
  x?: string;
  k?: TreeNode[];
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

function countLogicalColour(
  capture: PlagueVisualCapture,
  visualCase: PlagueVisualCase,
  rect: { x: number; y: number; width: number; height: number },
  colour: readonly [number, number, number],
  tolerance = 0,
): number {
  const scale = Math.min(capture.width / 480, capture.height / 272);
  const left = Math.floor((capture.width - 480 * scale) / 2);
  const top = Math.floor((capture.height - 272 * scale) / 2);
  const rgba = capture.cases[visualCase].rgba;
  let count = 0;
  for (let y = Math.floor(top + rect.y * scale); y < Math.ceil(top + (rect.y + rect.height) * scale); y++) {
    for (let x = Math.floor(left + rect.x * scale); x < Math.ceil(left + (rect.x + rect.width) * scale); x++) {
      const offset = (y * capture.width + x) * 4;
      if (Math.max(
        Math.abs(rgba[offset]! - colour[0]),
        Math.abs(rgba[offset + 1]! - colour[1]),
        Math.abs(rgba[offset + 2]! - colour[2]),
      ) <= tolerance) count++;
    }
  }
  return count;
}

let captures: Promise<PlagueVisualCapture[]> | undefined;
function captured(): Promise<PlagueVisualCapture[]> {
  // The sim host publishes one guest global, so production boots stay serial.
  return captures ??= (async () => {
    const output: PlagueVisualCapture[] = [];
    for (const lang of PLAGUE_VISUAL_LANGS) {
      for (const viewport of PLAGUE_VISUAL_VIEWPORTS) {
        output.push(await capturePlague(lang, viewport));
      }
    }
    return output;
  })();
}

const expectedText = {
  en_US: {
    sneeze: "Ah ... Ahchoo! Rockitten sneezed on Nut.",
    infected: "Nut begins to sniffle.",
  },
  zh_CN: {
    sneeze: "哈……哈啾！小岩猫 朝 螺母兽 打了个喷嚏。",
    infected: "螺母兽 开始抽鼻子了。",
  },
} as const;

describe("Spyder Bite production visuals", () => {
  simTest("matches every inspected bilingual golden at both viewport sizes", async () => {
    expect(manifest.format).toBe("pocket-tuxemon/plague-goldens/v1");
    expect(manifest.frames).toHaveLength(
      PLAGUE_VISUAL_LANGS.length * PLAGUE_VISUAL_VIEWPORTS.length * PLAGUE_VISUAL_CASES.length,
    );
    for (const capture of await captured()) {
      for (const visualCase of PLAGUE_VISUAL_CASES) {
        const entry = manifest.frames.find((candidate) =>
          candidate.lang === capture.lang && candidate.case === visualCase
            && candidate.width === capture.width && candidate.height === capture.height
        );
        if (!entry) throw new Error(`plague golden: missing ${capture.lang} ${visualCase} ${capture.width}x${capture.height}`);
        const path = join(ROOT, "tests/goldens", entry.file);
        const png = new Uint8Array(readFileSync(path));
        const decoded = decodePng(png, path);
        expect([decoded.width, decoded.height], entry.file).toEqual([capture.width, capture.height]);
        expect(capture.cases[visualCase].rgba, entry.file).toEqual(decoded.rgba);
        expect(fnv1a(decoded.rgba), entry.file).toBe(entry.rgbaFnv1a);
        expect(createHash("sha256").update(png).digest("hex"), entry.file).toBe(entry.pngSha256);
        expect(entry.seed).toBe(capture.seed);
        expect(entry.eventIndex).toBe(capture.eventIndex);
      }
    }
  }, 120_000);

  simTest("shows the upstream two-phase narration without clipping", async () => {
    for (const capture of await captured()) {
      for (const visualCase of PLAGUE_VISUAL_CASES) {
        const tree = capture.cases[visualCase].tree;
        const text = [0, 1, 2]
          .map((row) => nodeText(namedNode(tree, `battle-message-row-${row}`)))
          .join("")
          .trim();
        expect(text, `${capture.lang} ${visualCase} ${capture.width}x${capture.height}`)
          .toBe(expectedText[capture.lang][visualCase]);
        expect(text).not.toContain("… ");
        expect(nodeText(namedNode(tree, "battle-message-legend")).trim()).toBe(
          capture.lang === "zh_CN" ? "确定" : "OK",
        );
      }
    }
  }, 120_000);

  simTest("paints the full-width narration band and visible message glyphs", async () => {
    for (const capture of await captured()) {
      const scale = Math.min(capture.width / 480, capture.height / 272);
      for (const visualCase of PLAGUE_VISUAL_CASES) {
        // When a reducer event is presenting the command menu is hidden and
        // the panel occupies all 480 logical pixels. These exact theme
        // colours distinguish a real production MessageBand from tree-only
        // text or a stale half-width menu frame.
        expect(countLogicalColour(
          capture,
          visualCase,
          { x: 2, y: 218, width: 476, height: 50 },
          [0xf5, 0xf1, 0xd7],
        )).toBeGreaterThan(17_000 * scale * scale);
        expect(countLogicalColour(
          capture,
          visualCase,
          { x: 8, y: 224, width: 420, height: 34 },
          [0x10, 0x2b, 0x3a],
          45,
        )).toBeGreaterThan(20 * scale);
      }
    }
  }, 120_000);
});
