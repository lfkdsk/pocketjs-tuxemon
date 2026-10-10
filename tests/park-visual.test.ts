// Eclipse Park production visual coverage. The dedicated encounter and
// settlement views are booted from dist/main in both supported languages and
// both target viewports, then compared with the manually inspected goldens.

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, test } from "bun:test";

import { decodePng } from "../importer/png.ts";
import {
  capturePark,
  PARK_VISUAL_CASES,
  PARK_VISUAL_LANGS,
  PARK_VISUAL_VIEWPORTS,
  type ParkVisualCapture,
  type ParkVisualCase,
  type ParkVisualLang,
} from "../tools/park-visual-fixture.ts";
import { TUXEMON_UI_THEME } from "../ui/tuxemon-theme.ts";
import { fnv1a } from "../vendor/pocket-rpgkit/vendor/pocketjs/hosts/sim/sim.ts";

const ROOT = resolve(import.meta.dir, "..");
const BUNDLE = join(ROOT, "dist/main");
const WASM = join(ROOT, "vendor/pocket-rpgkit/vendor/pocketjs/hosts/web/pocketjs.wasm");
const MANIFEST = join(ROOT, "data/park-goldens.json");
const canBoot = existsSync(BUNDLE + ".js") && existsSync(BUNDLE + ".pak") &&
  existsSync(WASM) && existsSync(MANIFEST);
if (!canBoot) {
  console.warn("Park visual tests skipped; run `bun run import && bun run build && bun run goldens:park`");
}
const simTest = canBoot ? test : test.skip;

interface GoldenEntry {
  lang: ParkVisualLang;
  case: ParkVisualCase;
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

function rgb(hex: string): readonly [number, number, number] {
  return [
    Number.parseInt(hex.slice(1, 3), 16),
    Number.parseInt(hex.slice(3, 5), 16),
    Number.parseInt(hex.slice(5, 7), 16),
  ];
}

function countLogicalColourNear(
  capture: ParkVisualCapture,
  visualCase: ParkVisualCase,
  rect: { x: number; y: number; width: number; height: number },
  colour: readonly [number, number, number],
  tolerance: number,
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

let captures: Promise<ParkVisualCapture[]> | undefined;
function captured(): Promise<ParkVisualCapture[]> {
  // The simulated host has one active guest global. Keep the four production
  // boots serial, in the same order as the golden writer.
  return captures ??= (async () => {
    const output: ParkVisualCapture[] = [];
    for (const lang of PARK_VISUAL_LANGS) {
      for (const viewport of PARK_VISUAL_VIEWPORTS) {
        output.push(await capturePark(lang, viewport));
      }
    }
    return output;
  })();
}

const encounterText = {
  en_US: {
    enemy: "Pairagrim  Lv6 F",
    player: "Nut  Lv12 -",
    prompt: "What will you do?",
    cells: ["> Ball ×25", "  Food", "  Doll", "  Run"],
  },
  zh_CN: {
    enemy: "双头鸟  Lv6 F",
    player: "螺母兽  Lv12 -",
    prompt: "你要做什么？",
    cells: ["> 公园球 ×25", "  食物", "  玩偶", "  逃跑"],
  },
} as const;

const summaryText = {
  en_US: "Eclipse Park ResultsSpecies seen1Capture attempts5Caught3Missed2Success rate60%" +
    "Top sightingsPairagrim · seen 12×Capture highlightsPairagrim · 28.0 turns left" +
    "Return to the park entrance",
  zh_CN: "Eclipse 公园结算发现种类1捕获尝试5成功捕获3捕获失败2成功率60%" +
    "常见精灵双头鸟 · 遇见 12 次捕获亮点双头鸟 · 余 28.0 回合返回公园入口",
} as const;

describe("Eclipse Park production visuals", () => {
  simTest("match all inspected bilingual encounter and settlement goldens", async () => {
    expect(manifest.format).toBe("pocket-tuxemon/park-goldens/v1");
    expect(manifest.frames).toHaveLength(
      PARK_VISUAL_LANGS.length * PARK_VISUAL_VIEWPORTS.length * PARK_VISUAL_CASES.length,
    );
    for (const capture of await captured()) {
      for (const visualCase of PARK_VISUAL_CASES) {
        const entry = manifest.frames.find((candidate) =>
          candidate.lang === capture.lang && candidate.case === visualCase &&
          candidate.width === capture.width && candidate.height === capture.height);
        if (!entry) {
          throw new Error(`Park ${capture.lang} ${visualCase}: missing ${capture.width}x${capture.height} golden`);
        }
        const path = join(ROOT, "tests/goldens", entry.file);
        const png = new Uint8Array(readFileSync(path));
        const decoded = decodePng(png, path);
        expect([decoded.width, decoded.height], entry.file).toEqual([capture.width, capture.height]);
        expect(capture.cases[visualCase].rgba, entry.file).toEqual(decoded.rgba);
        expect(fnv1a(decoded.rgba), entry.file).toBe(entry.rgbaFnv1a);
        expect(createHash("sha256").update(png).digest("hex"), entry.file).toBe(entry.pngSha256);
      }
    }
  }, 120_000);

  simTest("shows every encounter and settlement label without abbreviated text", async () => {
    for (const capture of await captured()) {
      const expected = encounterText[capture.lang];
      const encounter = capture.cases.encounter.tree;
      expect(nodeText(namedNode(encounter, "enemy-hud-name"))).toBe(expected.enemy);
      expect(nodeText(namedNode(encounter, "player-hud-name"))).toBe(expected.player);
      expect(nodeText(namedNode(encounter, "battle-message-row-0"))).toBe(expected.prompt);
      for (let index = 0; index < expected.cells.length; index++) {
        expect(nodeText(namedNode(encounter, `battle-commands-cell-${index}`))).toBe(expected.cells[index]);
      }

      const encounterVisible = nodeText(namedNode(encounter, "tux-battle-canvas"));
      const settlementVisible = nodeText(namedNode(capture.cases.summary.tree, "tux-park-summary-scene"));
      expect(settlementVisible).toBe(summaryText[capture.lang]);
      expect(encounterVisible).not.toContain("…");
      expect(encounterVisible).not.toContain("...");
      expect(settlementVisible).not.toContain("…");
      expect(settlementVisible).not.toContain("...");
    }
  }, 120_000);

  simTest("paints the selected Park Ball, disabled choices and settlement close control", async () => {
    const battleAccent = [0xd2, 0x7b, 0x2c] as const;
    const battlePaper = [0xf5, 0xf1, 0xd7] as const;
    const battleDim = [0x53, 0x7b, 0x80] as const;
    for (const capture of await captured()) {
      const scale = Math.min(capture.width / 480, capture.height / 272);
      // Park Ball is selected in the top-left command cell; Food is present
      // but disabled, and the entire four-cell menu remains visibly framed.
      expect(countLogicalColourNear(
        capture, "encounter", { x: 246, y: 221, width: 116, height: 22 }, battleAccent, 55,
      )).toBeGreaterThan(40 * scale);
      expect(countLogicalColourNear(
        capture, "encounter", { x: 362, y: 221, width: 116, height: 22 }, battleDim, 55,
      )).toBeGreaterThan(25 * scale);
      expect(countLogicalColourNear(
        capture, "encounter", { x: 244, y: 220, width: 236, height: 48 }, battlePaper, 8,
      )).toBeGreaterThan(8_000 * scale * scale);

      // The summary title and full-width close button use the Park accent.
      expect(countLogicalColourNear(
        capture, "summary", { x: 18, y: 8, width: 444, height: 25 }, rgb(TUXEMON_UI_THEME.accent), 70,
      )).toBeGreaterThan(300 * scale * scale);
      expect(countLogicalColourNear(
        capture, "summary", { x: 115, y: 230, width: 250, height: 32 }, rgb(TUXEMON_UI_THEME.accent), 5,
      )).toBeGreaterThan(5_500 * scale * scale);
    }
  }, 120_000);

  simTest("closes settlement through the scaled touch bridge at every viewport", async () => {
    for (const capture of await captured()) {
      expect(capture.touchClosed, `${capture.lang} ${capture.width}x${capture.height}`).toBeTrue();
    }
  }, 120_000);
});
