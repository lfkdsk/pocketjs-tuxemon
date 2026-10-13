// Production visual coverage for two imported real-map double battles in
// both languages and both supported viewport sizes.

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, test } from "bun:test";

import { decodePng } from "../importer/png.ts";
import {
  captureDoubleBattle,
  doubleBattleGoldenFile,
  DOUBLE_BATTLE_CASES,
  DOUBLE_BATTLE_LANGS,
  DOUBLE_BATTLE_VIEWPORTS,
  type DoubleBattleCapture,
  type DoubleBattleCase,
  type DoubleBattleLang,
} from "../tools/double-battle-visual-fixture.ts";
import { fnv1a } from "../vendor/pocket-rpgkit/vendor/pocketjs/hosts/sim/sim.ts";

const ROOT = resolve(import.meta.dir, "..");
const BUNDLE = join(ROOT, "dist/main");
const WASM = join(ROOT, "vendor/pocket-rpgkit/vendor/pocketjs/hosts/web/pocketjs.wasm");
const MANIFEST = join(ROOT, "data/double-battle-goldens.json");
const canBoot = existsSync(BUNDLE + ".js") && existsSync(BUNDLE + ".pak")
  && existsSync(WASM) && existsSync(MANIFEST);
if (!canBoot) {
  console.warn("Double-battle visual tests skipped; run `bun run import && bun run build && bun run goldens:doubles`");
}
const simTest = canBoot ? test : test.skip;

interface GoldenEntry {
  lang: DoubleBattleLang;
  case: DoubleBattleCase;
  width: number;
  height: number;
  file: string;
  map: string;
  opponent: string;
  player: { x: number; y: number };
  enemy: Array<{ slug: string; level: number }>;
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
  capture: DoubleBattleCapture,
  rect: { x: number; y: number; width: number; height: number },
  colour: readonly [number, number, number],
  tolerance: number,
): number {
  const scale = Math.min(capture.width / 480, capture.height / 272);
  const left = Math.floor((capture.width - 480 * scale) / 2);
  const top = Math.floor((capture.height - 272 * scale) / 2);
  let count = 0;
  for (let y = Math.floor(top + rect.y * scale); y < Math.ceil(top + (rect.y + rect.height) * scale); y++) {
    for (let x = Math.floor(left + rect.x * scale); x < Math.ceil(left + (rect.x + rect.width) * scale); x++) {
      const offset = (y * capture.width + x) * 4;
      if (Math.max(
        Math.abs(capture.rgba[offset]! - colour[0]),
        Math.abs(capture.rgba[offset + 1]! - colour[1]),
        Math.abs(capture.rgba[offset + 2]! - colour[2]),
      ) <= tolerance) count++;
    }
  }
  return count;
}

let captures: Promise<DoubleBattleCapture[]> | undefined;
function captured(): Promise<DoubleBattleCapture[]> {
  return captures ??= (async () => {
    const output: DoubleBattleCapture[] = [];
    for (const lang of DOUBLE_BATTLE_LANGS) {
      for (const visualCase of DOUBLE_BATTLE_CASES) {
        for (const viewport of DOUBLE_BATTLE_VIEWPORTS) {
          output.push(await captureDoubleBattle(lang, visualCase, viewport));
        }
      }
    }
    return output;
  })();
}

const expected = {
  route5: {
    map: "spyder_route5",
    opponent: "spyder_route5_tryphaena",
    enemy: [["miaownolith", 24], ["criniotherme", 22]],
    enemyName: { en_US: "Miaownolith", zh_CN: "巨石猫" },
  },
  dragonscave: {
    map: "spyder_dragonscave",
    opponent: "spyder_dragonscave_ray",
    enemy: [["ghosteeth", 45], ["embazook", 45], ["arthrobolt", 45], ["hydrone", 45]],
    enemyName: { en_US: "Ghosteeth", zh_CN: "幽灵齿" },
  },
} as const;

describe("real-map double-battle production visuals", () => {
  simTest("match all eight manually inspected bilingual goldens", async () => {
    expect(manifest.format).toBe("pocket-tuxemon/double-battle-goldens/v1");
    expect(manifest.frames).toHaveLength(8);
    for (const capture of await captured()) {
      const entry = manifest.frames.find((candidate) => candidate.lang === capture.lang
        && candidate.case === capture.case && candidate.width === capture.width
        && candidate.height === capture.height);
      if (!entry) throw new Error(`missing double battle golden ${capture.lang} ${capture.case} ${capture.width}x${capture.height}`);
      expect(entry.file).toBe(doubleBattleGoldenFile(capture.lang, capture.case, capture));
      const path = join(ROOT, "tests/goldens", entry.file);
      const png = new Uint8Array(readFileSync(path));
      const decoded = decodePng(png, path);
      expect([decoded.width, decoded.height]).toEqual([capture.width, capture.height]);
      expect(capture.rgba).toEqual(decoded.rgba);
      expect(fnv1a(decoded.rgba)).toBe(entry.rgbaFnv1a);
      expect(createHash("sha256").update(png).digest("hex")).toBe(entry.pngSha256);
    }
  }, 120_000);

  simTest("preserve event provenance, complete parties and two active slots", async () => {
    for (const capture of await captured()) {
      const want = expected[capture.case];
      const battle = capture.state.battle;
      expect(capture.map).toBe(want.map);
      expect(battle.opponent).toBe(want.opponent);
      expect(battle.fieldSize).toBe(2);
      expect(battle.parties[0].map(({ slug, level }) => [slug, level])).toEqual([
        ["nut", 50],
        ["rockitten", 50],
      ]);
      expect(battle.parties[1].map(({ slug, level }) => [slug, level]))
        .toEqual(want.enemy.map(([slug, level]) => [slug, level]));
      expect(battle.field.slice(0, 2)).toEqual(battle.parties[1].slice(0, 2).map(({ uid }) => uid));
      expect(battle.field.slice(2)).toEqual(battle.parties[0].slice(0, 2).map(({ uid }) => uid));
    }
  }, 120_000);

  simTest("renders localized unclipped battle chrome and meaningful pixels", async () => {
    const hashes = new Map<string, Set<string>>();
    for (const capture of await captured()) {
      const want = expected[capture.case];
      const tree = capture.tree;
      expect(nodeText(namedNode(tree, "enemy-hud-name"))).toContain(want.enemyName[capture.lang]);
      expect(nodeText(namedNode(tree, "enemy-hud-name"))).toContain(`Lv${want.enemy[0][1]}`);
      expect(nodeText(namedNode(tree, "player-hud-name"))).toContain(
        capture.lang === "zh_CN" ? "螺母兽  Lv50" : "Nut  Lv50",
      );
      expect(nodeText(namedNode(tree, "battle-message-row-0"))).toBe(
        capture.lang === "zh_CN" ? "螺母兽 要做什么？" : "What will Nut do?",
      );
      const cells = capture.lang === "zh_CN"
        ? ["> 战斗", "  替换", "  道具", "  认输"]
        : ["> Fight", "  Swap", "  Item", "  Forfeit"];
      for (let index = 0; index < cells.length; index++) {
        expect(nodeText(namedNode(tree, `battle-commands-cell-${index}`))).toBe(cells[index]);
      }
      const visible = nodeText(namedNode(tree, "tux-battle-canvas"));
      expect(visible).not.toContain("…");
      expect(visible).not.toContain("...");

      const scale = Math.min(capture.width / 480, capture.height / 272);
      expect(countLogicalColour(
        capture,
        { x: 246, y: 221, width: 116, height: 22 },
        [0xd2, 0x7b, 0x2c],
        55,
      )).toBeGreaterThan(25);
      expect(countLogicalColour(
        capture,
        { x: 244, y: 220, width: 236, height: 48 },
        [0xf5, 0xf1, 0xd7],
        8,
      )).toBeGreaterThan(8_000 * scale * scale);

      const key = `${capture.lang}:${capture.width}x${capture.height}`;
      const set = hashes.get(key) ?? new Set<string>();
      set.add(fnv1a(capture.rgba));
      hashes.set(key, set);
    }
    for (const [key, values] of hashes) {
      expect(values.size, `${key} must paint two distinct opponents/backdrops`).toBe(2);
    }
  }, 120_000);
});
