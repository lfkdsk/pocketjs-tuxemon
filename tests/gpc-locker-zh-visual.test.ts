import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, test } from "bun:test";

import { decodePng } from "../importer/png.ts";
import {
  captureGpcZh,
  GPC_ZH_CASES,
  GPC_ZH_VIEWPORTS,
  importedZhPcArgs,
  type GpcZhCapture,
  type GpcZhCase,
} from "../tools/gpc-locker-zh-fixture.ts";
import { fnv1a, treeHasText } from "../vendor/pocket-rpgkit/vendor/pocketjs/hosts/sim/sim.ts";

const ROOT = resolve(import.meta.dir, "..");
const BUNDLE = join(ROOT, "dist/main");
const WASM = join(ROOT, "vendor/pocket-rpgkit/vendor/pocketjs/hosts/web/pocketjs.wasm");
const MANIFEST = join(ROOT, "data/gpc-locker-zh-goldens.json");
const canBoot = existsSync(BUNDLE + ".js") && existsSync(BUNDLE + ".pak") &&
  existsSync(WASM) && existsSync(MANIFEST);
if (!canBoot) console.warn("GPC zh locker visual tests skipped; run `bun run build && bun run build:wasm && bun run goldens:gpc:zh`");
const simTest = canBoot ? test : test.skip;

interface GoldenEntry {
  case: GpcZhCase;
  width: number;
  height: number;
  file: string;
  rgbaFnv1a: string;
  pngSha256: string;
}

const manifest = canBoot
  ? JSON.parse(readFileSync(MANIFEST, "utf8")) as { format: string; frames: GoldenEntry[] }
  : { format: "", frames: [] };

/** The English chrome the review found hardcoded in the PC scene. None of
 *  these may appear in a zh_CN PC frame. Scoped to the tux-pc-scene subtree
 *  so the world behind the overlay cannot cause false positives. */
const ENGLISH_CHROME = [
  // detailTitle()
  "LOCKER ", "BAG ", "PARTY ", " KINDS", " ITEMS",
  // pcHint()
  "Up/Down", "Left/Right", "A: options", "B: back", "A: select",
  "A: store", "A: open the locker", "A: ok", "Choose a box", "Choose a Tuxemon",
  "+/-1", "+/-10",
  // quantity popup legend
  "< > 1", "^ v 10", "A ok", "B back",
] as const;

/** Per-case zh_CN strings the frame must contain. Asserting the full string
 *  (not a prefix) is the semantic truncation guard: a clipped or shortened
 *  string fails here, and the golden pixels catch visual clipping. */
const REQUIRED: Record<GpcZhCase, readonly string[]> = {
  pcMenu: [
    "电脑",
    "拾取精灵",
    "放下精灵",
    "取出道具",
    "放入道具",
    "退出登录",
    "队伍 3/6",
    "上键/下键: 选择  行动键: 确定",
  ],
  pcBox: [
    "收容所 4/30",
    "阿尔多恩",
    "大鳍豚",
    "行动键: 选项  取消键: 返回  左键/右键: 翻页",
  ],
  pcParty: [
    "队伍 3/6",
    "小岩猫",
    "选择要存放的精灵。  取消键: 返回",
  ],
  pcItemLocker: [
    "储物柜 4/30 17 件",
    "治疗药水",
    "精灵球",
    "行动键: 选项  取消键: 返回  左键/右键: 翻页",
  ],
  pcItemQuantity: [
    "储物柜 2/30 37 件",
    "x1 / 25",
    "左键/右键 ±1",
    "左键/右键: ±1  上键/下键: ±10  行动键: 确定  取消键: 返回",
  ],
  pcItemBag: [
    "背包 4 种",
    "治疗药水",
    "行动键: 存入  取消键: 返回  左键/右键: 翻页",
  ],
  pcItemEmpty: [
    "储物柜 0/30 0 件",
    "这个柜子是空的，没有道具可拿。",
  ],
  pcItemFull: [
    "背包 2 种",
    "这个保管箱已满。",
  ],
  pcItemDisband: [
    "储物柜 2/30 14 件",
    "1 个 治疗药水 已被销毁。",
  ],
};

/** Strings that must NOT appear (the hidden nu_phone item). */
const FORBIDDEN: Partial<Record<GpcZhCase, readonly string[]>> = {
  pcItemBag: ["Nu 手机"],
};

/** Collect every text string under the tux-pc-scene node. */
function pcSceneText(tree: unknown): string[] {
  const out: string[] = [];
  const visit = (node: unknown): boolean => {
    if (!node || typeof node !== "object") return false;
    const current = node as { n?: unknown; x?: unknown; k?: unknown };
    if (current.n === "tux-pc-scene") {
      collect(current, out);
      return true;
    }
    return Array.isArray(current.k) && current.k.some((child) => visit(child));
  };
  const collect = (node: unknown, out: string[]): void => {
    if (!node || typeof node !== "object") return;
    const current = node as { x?: unknown; k?: unknown };
    if (typeof current.x === "string" && current.x.length > 0) out.push(current.x);
    if (Array.isArray(current.k)) for (const child of current.k) collect(child, out);
  };
  visit(tree);
  return out;
}

let captures: Promise<{ small: GpcZhCapture; large: GpcZhCapture }> | undefined;
function captured() {
  return captures ??= (async () => ({
    small: await captureGpcZh(GPC_ZH_VIEWPORTS[0]),
    large: await captureGpcZh(GPC_ZH_VIEWPORTS[1]),
  }))();
}

describe("G-PC-LOCKER zh_CN production PC visuals", () => {
  simTest("match both committed viewports", async () => {
    expect(manifest.format).toBe("pocket-tuxemon/gpc-locker-zh-goldens/v1");
    expect(manifest.frames).toHaveLength(GPC_ZH_VIEWPORTS.length * GPC_ZH_CASES.length);
    const { small, large } = await captured();
    for (const capture of [small, large]) {
      for (const visualCase of GPC_ZH_CASES) {
        const entry = manifest.frames.find((candidate) => candidate.case === visualCase
          && candidate.width === capture.width && candidate.height === capture.height);
        if (!entry) throw new Error(`GPC zh ${visualCase} golden: missing ${capture.width}x${capture.height}`);
        const path = join(ROOT, "tests/goldens", entry.file);
        const png = new Uint8Array(readFileSync(path));
        const expected = decodePng(png, path);
        expect(capture.cases[visualCase].rgba).toEqual(expected.rgba);
        expect(fnv1a(capture.cases[visualCase].rgba)).toBe(entry.rgbaFnv1a);
        expect(createHash("sha256").update(png).digest("hex")).toBe(entry.pngSha256);
      }
    }
  }, 90_000);

  for (const visualCase of GPC_ZH_CASES) {
    simTest(`${visualCase} renders the zh_CN strings with no English chrome`, async () => {
      const { small } = await captured();
      const frame = small.cases[visualCase];
      const text = pcSceneText(frame.tree).join("\n");
      // No English UI chrome leaked into the PC scene.
      for (const leak of ENGLISH_CHROME) {
        expect(text, `${visualCase}: leaked "${leak}"`).not.toContain(leak);
      }
      // Every required zh_CN string is present in full (truncation guard).
      for (const required of REQUIRED[visualCase]) {
        expect(treeHasText(frame.tree, required), `${visualCase}: missing "${required}"`).toBeTrue();
      }
      // Forbidden strings stay hidden.
      for (const forbidden of FORBIDDEN[visualCase] ?? []) {
        expect(treeHasText(frame.tree, forbidden), `${visualCase}: "${forbidden}" should be hidden`).toBeFalse();
      }
    }, 60_000);
  }

  simTest("the imported tux.pc itemDisbanded label uses item-destruction wording", () => {
    // The fixture builds its scene states from the real imported command args,
    // so this assertion guards the import path itself: a wrong .po mapping
    // (e.g. the monster-release wording 放生/只) lands here and fails.
    const labels = importedZhPcArgs().labels as Record<string, unknown>;
    const itemDisbanded = labels.itemDisbanded;
    expect(typeof itemDisbanded).toBe("string");
    const text = itemDisbanded as string;
    expect(text, "item disband must use the item verb 销毁").toContain("销毁");
    expect(text, "item disband must use the item classifier 个").toContain("个");
    expect(text, "item disband must not use the monster-release verb 放生").not.toContain("放生");
    expect(text, "item disband must not use the animal classifier 只").not.toContain("只");
  });

  simTest("the quantity picker legend fits its popup at 480x272", async () => {
    const { small } = await captured();
    const frame = small.cases.pcItemQuantity;
    // The popup legend is two lines; both must be in the tree in full.
    expect(treeHasText(frame.tree, "左键/右键 ±1   上键/下键 ±10")).toBeTrue();
    expect(treeHasText(frame.tree, "行动键 确定   取消键 返回")).toBeTrue();
  }, 60_000);
});
