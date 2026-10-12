// Production-bundle visual gate for title modes, Options, NuPhone/GPS, and
// START children: exact bilingual goldens at both supported resolutions,
// semantic tree/pixel assertions, touch interaction, lazy art, and 2x scale.

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, test } from "bun:test";

import { decodePng } from "../importer/png.ts";
import featureModesJson from "../data/feature-modes.json";
import {
  captureFeatureModes,
  FEATURE_MODES_CASES,
  FEATURE_MODES_VIEWPORTS,
  type FeatureModesCase,
} from "../tools/feature-modes-visual-fixture.ts";
import type { FeatureModesRuntimeData } from "../ui/feature-modes-data.ts";
import { TUXEMON_UI_THEME } from "../ui/tuxemon-theme.ts";
import { fnv1a, treeHasText } from "../vendor/pocket-rpgkit/vendor/pocketjs/hosts/sim/sim.ts";

const ROOT = resolve(import.meta.dir, "..");
const BUNDLE = join(ROOT, "dist/main");
const WASM = join(ROOT, "vendor/pocket-rpgkit/vendor/pocketjs/hosts/web/pocketjs.wasm");
const MANIFEST = join(ROOT, "data/feature-modes-goldens.json");
const canBoot = existsSync(BUNDLE + ".js") && existsSync(BUNDLE + ".pak")
  && existsSync(WASM) && existsSync(MANIFEST);
if (!canBoot) {
  console.warn("Feature mode visuals skipped; run `bun run build && bun run build:wasm && bun tools/update-feature-modes-goldens.ts`");
}
const simTest = canBoot ? test : test.skip;
const LANGS = ["en_US", "zh_CN"] as const;
type Lang = typeof LANGS[number];
const DATA = featureModesJson as unknown as FeatureModesRuntimeData;
const BATTLE_DB = Object.fromEntries(LANGS.map((lang) => [
  lang,
  JSON.parse(readFileSync(join(ROOT, `data/battle-db${lang === "zh_CN" ? ".zh_CN" : ""}.json`), "utf8")) as {
    monsters: Record<string, { name: string; description: string }>;
    items: Record<string, { name: string; description: string }>;
  },
])) as Record<Lang, {
  monsters: Record<string, { name: string; description: string }>;
  items: Record<string, { name: string; description: string }>;
}>;

interface GoldenEntry {
  case: FeatureModesCase;
  lang: Lang;
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
      if (rgba[offset] === colour[0] && rgba[offset + 1] === colour[1]
          && rgba[offset + 2] === colour[2]) count++;
    }
  }
  return count;
}

const manifest = canBoot
  ? JSON.parse(readFileSync(MANIFEST, "utf8")) as { format: string; frames: GoldenEntry[] }
  : { format: "", frames: [] };
type Capture = Awaited<ReturnType<typeof captureFeatureModes>>;
const captures = new Map<string, Promise<Capture>>();
function captured(viewportIndex: number, lang: Lang): Promise<Capture> {
  const key = `${viewportIndex}:${lang}`;
  let pending = captures.get(key);
  if (!pending) {
    pending = captureFeatureModes(FEATURE_MODES_VIEWPORTS[viewportIndex]!, lang);
    captures.set(key, pending);
  }
  return pending;
}

describe("Feature-mode and START production visuals", () => {
  simTest("match every committed bilingual golden at both resolutions", async () => {
    expect(manifest.format).toBe("pocket-tuxemon/feature-modes-goldens/v5");
    expect(manifest.frames).toHaveLength(FEATURE_MODES_CASES.length * LANGS.length * FEATURE_MODES_VIEWPORTS.length);
    for (let viewportIndex = 0; viewportIndex < FEATURE_MODES_VIEWPORTS.length; viewportIndex++) {
      for (const lang of LANGS) {
        const capture = await captured(viewportIndex, lang);
        const viewport = FEATURE_MODES_VIEWPORTS[viewportIndex]!;
        for (const visualCase of FEATURE_MODES_CASES) {
          const entry = manifest.frames.find((candidate) => candidate.case === visualCase
            && candidate.lang === lang && candidate.width === viewport.width
            && candidate.height === viewport.height);
          if (!entry) throw new Error(`missing ${visualCase} ${lang} ${viewport.width}x${viewport.height} golden`);
          const path = join(ROOT, "tests/goldens", entry.file);
          const png = new Uint8Array(readFileSync(path));
          const expected = decodePng(png, path);
          const actual = capture.cases[visualCase].rgba;
          expect([expected.width, expected.height]).toEqual([viewport.width, viewport.height]);
          expect(actual).toEqual(expected.rgba);
          expect(fnv1a(actual)).toBe(entry.rgbaFnv1a);
          expect(createHash("sha256").update(png).digest("hex")).toBe(entry.pngSha256);
        }
      }
    }
  }, 180_000);

  simTest("shows complete localized title, phone, START, party, player and Bag text", async () => {
    for (let viewportIndex = 0; viewportIndex < FEATURE_MODES_VIEWPORTS.length; viewportIndex++) {
      const en = await captured(viewportIndex, "en_US");
      const zh = await captured(viewportIndex, "zh_CN");
      expect(nodeText(namedNode(en.cases.title.tree, "tux-title-name"))).toBe("POCKET TUXEMON");
      for (const id of ["newGame", "battle", "minigame", "options", "exit"] as const) {
        expect(treeHasText(en.cases.title.tree, DATA.startMenu.title[id].en_US)).toBeTrue();
        expect(treeHasText(zh.cases.title.tree, DATA.startMenu.title[id].zh_CN)).toBeTrue();
      }
      expect(nodeText(namedNode(en.cases.difficulty.tree, "tux-title-difficulty-prompt")))
        .toBe("Choose your difficulty level");
      expect(nodeText(namedNode(zh.cases.difficulty.tree, "tux-title-difficulty-prompt")))
        .toBe("选择难度等级");
      expect(namedNode(en.cases.difficulty.tree, "tux-title-name")).toBeUndefined();
      expect(namedNode(en.cases.difficulty.tree, "tux-title-legend")).toBeUndefined();
      for (const label of ["Beginner", "Easy", "Normal", "Hard", "Expert"] as const) {
        expect(treeHasText(en.cases.difficulty.tree, label)).toBeTrue();
      }
      for (const label of ["入门", "简单", "普通", "困难", "专家"] as const) {
        expect(treeHasText(zh.cases.difficulty.tree, label)).toBeTrue();
      }
      for (const [capture, lang] of [[en, "en_US"], [zh, "zh_CN"]] as const) {
        for (const difficulty of DATA.titleMinigame.difficulties) {
          const visualCase = `minigame-${difficulty.id}` as const;
          const frame = capture.cases[visualCase];
          const probe = capture.minigame[visualCase];
          expect(nodeText(namedNode(frame.tree, "tux-minigame-question")))
            .toBe(DATA.titleMinigame.question[lang]);
          expect(nodeText(namedNode(frame.tree, "tux-minigame-score")))
            .toBe(`${DATA.titleMinigame.scoreLabel[lang]}: 0`);
          expect(nodeText(namedNode(frame.tree, "tux-minigame-streak")))
            .toBe(`${DATA.titleMinigame.streakLabel[lang]}: 0`);
          expect(probe.options).toHaveLength(difficulty.choices);
          for (const [index, slug] of probe.options.entries()) {
            expect(nodeText(namedNode(frame.tree, `tux-minigame-option-label-${index}`)))
              .toBe(BATTLE_DB[lang].monsters[slug]!.name);
          }
          expect(probe.description).toBe(BATTLE_DB[lang].monsters[probe.target]!.description);
        }
      }
      expect(nodeText(namedNode(en.cases.phone.tree, "tux-nuphone-title"))).toBe("Nu Phone");
      expect(treeHasText(en.cases.phone.tree, "Map App")).toBeTrue();
      expect(nodeText(namedNode(zh.cases.phone.tree, "tux-nuphone-title"))).toBe("Nu 手机");
      expect(treeHasText(zh.cases.phone.tree, "手机地图")).toBeTrue();
      expect(nodeText(namedNode(en.cases.map.tree, "tux-nuphone-location-label"))).toBe("Paper Town");
      expect(nodeText(namedNode(zh.cases.map.tree, "tux-nuphone-location-label"))).toBe("方絮镇");
      expect(treeHasText(en.cases.map.tree, "YOU ARE HERE")).toBeTrue();
      expect(treeHasText(zh.cases.map.tree, "当前位置")).toBeTrue();
      for (const [capture, lang] of [[en, "en_US"], [zh, "zh_CN"]] as const) {
        const titleOptions = capture.cases["options-title"];
        const startOptions = capture.cases["options-start"];
        expect(nodeText(namedNode(titleOptions.tree, "options-title"))).toBe(DATA.options.title[lang]);
        expect(nodeText(namedNode(startOptions.tree, "options-title"))).toBe(DATA.options.title[lang]);
        for (const [action, label] of Object.entries(DATA.options.controls)) {
          expect(nodeText(namedNode(titleOptions.tree, `options-label-control:${action}`))).toBe(label[lang]);
          expect(nodeText(namedNode(titleOptions.tree, `options-value-control:${action}`))).toBe(label[lang]);
        }
        expect(nodeText(namedNode(titleOptions.tree, "options-label-reset")))
          .toBe(DATA.options.resetDefault[lang]);
        expect(nodeText(namedNode(startOptions.tree, "options-label-music")))
          .toBe(DATA.options.musicVolume[lang]);
        expect(nodeText(namedNode(startOptions.tree, "options-label-sound")))
          .toBe(DATA.options.soundVolume[lang]);
        expect(nodeText(namedNode(startOptions.tree, "options-label-units"))).toBe(DATA.options.units[lang]);
        expect(nodeText(namedNode(startOptions.tree, "options-label-hemisphere")))
          .toBe(DATA.options.hemisphere[lang]);
        expect(nodeText(namedNode(startOptions.tree, "options-back"))).toContain(DATA.options.back[lang]);
        expect(nodeText(namedNode(startOptions.tree, "options-legend")))
          .toContain(DATA.options.controls.primary[lang]);
        expect(nodeText(namedNode(startOptions.tree, "options-value-screen"))).toBe("480×272");
        expect(nodeText(namedNode(startOptions.tree, "options-value-music"))).toBe("50%");
        expect(nodeText(namedNode(startOptions.tree, "options-value-sound"))).toBe("20%");
        expect(nodeText(namedNode(startOptions.tree, "options-value-units"))).toBe(DATA.options.metric[lang]);
        expect(nodeText(namedNode(startOptions.tree, "options-value-hemisphere")))
          .toBe(DATA.options.northern[lang]);
        expect(namedNode(startOptions.tree, "options-origin")).toBeUndefined();
        expect(nodeText(namedNode(startOptions.tree, "options-overlay"))).not.toContain("…");
        expect(nodeText(namedNode(capture.cases.start.tree, "start-menu-root-title")))
          .toBe(lang === "zh_CN" ? "开始菜单" : "START MENU");
        expect(nodeText(namedNode(capture.cases.start.tree, "start-menu-root-label-party")))
          .toBe(DATA.startMenu.root.party[lang]);
        expect(nodeText(namedNode(capture.cases.start.tree, "start-menu-root-label-bag")))
          .toBe(DATA.startMenu.root.bag[lang]);
        expect(nodeText(namedNode(capture.cases.start.tree, "start-menu-root-label-player")))
          .toBe(DATA.startMenu.root.player[lang]);
        expect(namedNode(capture.cases.start.tree, "start-menu-root-label-tuxepedia")).toBeDefined();
        expect(nodeText(namedNode(capture.cases.party.tree, "start-menu-party-name-0")))
          .toBe(BATTLE_DB[lang].monsters.rockitten!.name);
        const releasedName = BATTLE_DB[lang].monsters.rockitten!.name.toUpperCase();
        expect(nodeText(namedNode(capture.cases["release-confirm"].tree, "start-menu-release-question")))
          .toBe(lang === "zh_CN"
            ? `确定要放生${releasedName}吗？`
            : `Are you sure you would like to release ${releasedName}?`);
        expect(nodeText(namedNode(capture.cases["release-confirm"].tree, "start-menu-release-answer-0")))
          .toBe(lang === "zh_CN" ? "否" : "No");
        expect(nodeText(namedNode(capture.cases["release-confirm"].tree, "start-menu-release-answer-1")))
          .toBe(lang === "zh_CN" ? "是" : "Yes");
        expect(nodeText(namedNode(capture.cases["release-result"].tree, "start-menu-release-result-text")))
          .toBe(lang === "zh_CN" ? `已放生${releasedName}。` : `${releasedName} has been released.`);
        expect(nodeText(namedNode(capture.cases.player.tree, "start-menu-player-name")))
          .toBe(lang === "zh_CN" ? "小红" : "Red");
        expect(nodeText(namedNode(capture.cases.player.tree, "start-menu-player-progress")))
          .toBe(lang === "zh_CN" ? "精灵百科完成度： 0.8%!" : "Tuxepedia: 0.8%!");
        expect(nodeText(namedNode(capture.cases.player.tree, "start-menu-player-seen")))
          .toBe(lang === "zh_CN" ? "看到了3只精灵，共有393" : "Seen 3 out of 393");
        expect(nodeText(namedNode(capture.cases.player.tree, "start-menu-player-caught")))
          .toBe(lang === "zh_CN" ? "捉住了2只精灵，共有393" : "Caught 2 out of 393");
        expect(nodeText(namedNode(capture.cases.player.tree, "start-menu-player-walked")))
          .toBe(lang === "zh_CN" ? "行走的路程 1.23 km" : "Walked 1.23 km");
        expect(nodeText(namedNode(capture.cases.bag.tree, "tux-bag-title")))
          .toBe(DATA.startMenu.root.bag[lang]);
        expect(nodeText(namedNode(capture.cases.bag.tree, "tux-bag-item-name")))
          .toBe(BATTLE_DB[lang].items.potion!.name);
        expect(nodeText(namedNode(capture.cases.bag.tree, "tux-bag-item-description")))
          .toBe(BATTLE_DB[lang].items.potion!.description);
      }
    }
  }, 180_000);

  simTest("renders a real battle and non-empty semantic panels", async () => {
    const capture = await captured(0, "en_US");
    expect(namedNode(capture.cases.battle.tree, "tux-battle-scene")).toBeDefined();
    expect(namedNode(capture.cases.battle.tree, "player-party-tray")).toBeDefined();
    expect(namedNode(capture.cases.battle.tree, "enemy-party-tray")).toBeDefined();
    const accent = rgb(TUXEMON_UI_THEME.accent);
    expect(countColour(capture.cases.title.rgba, 480, { x: 250, y: 30, width: 220, height: 220 }, accent))
      .toBeGreaterThan(300);
    expect(countColour(capture.cases.difficulty.rgba, 480, { x: 120, y: 80, width: 240, height: 170 }, accent))
      .toBeGreaterThan(500);
    const green: readonly [number, number, number] = [0x7c, 0xf2, 0x9a];
    expect(countColour(capture.cases.map.rgba, 480, { x: 120, y: 40, width: 220, height: 190 }, green))
      .toBeGreaterThan(1);
    const selected = rgb("#145064");
    expect(countColour(capture.cases.party.rgba, 480, { x: 13, y: 36, width: 270, height: 32 }, selected))
      .toBeGreaterThan(2_500);
    expect(countColour(capture.cases.bag.rgba, 480, { x: 13, y: 41, width: 270, height: 185 }, accent))
      .toBeGreaterThan(2_000);
    expect(countColour(capture.cases["options-title"].rgba, 480, { x: 22, y: 49, width: 211, height: 21 }, selected))
      .toBeGreaterThan(3_000);
    expect(countColour(capture.cases["options-start"].rgba, 480, { x: 22, y: 49, width: 211, height: 21 }, selected))
      .toBeGreaterThan(3_000);
  }, 120_000);

  simTest("hard minigame shows description without monster art", async () => {
    for (let viewportIndex = 0; viewportIndex < FEATURE_MODES_VIEWPORTS.length; viewportIndex++) {
      for (const lang of LANGS) {
        const capture = await captured(viewportIndex, lang);
        for (const difficulty of ["easy", "normal"] as const) {
          const tree = capture.cases[`minigame-${difficulty}`].tree;
          expect(namedNode(tree, "tux-minigame-monster-art")).toBeDefined();
          expect(namedNode(tree, "tux-minigame-description-panel")).toBeUndefined();
        }
        const hard = capture.cases["minigame-hard"];
        const probe = capture.minigame["minigame-hard"];
        expect(namedNode(hard.tree, "tux-minigame-monster-art")).toBeUndefined();
        expect(namedNode(hard.tree, "tux-minigame-monster-clip")).toBeUndefined();
        expect(namedNode(hard.tree, "tux-minigame-description-panel")).toBeDefined();
        for (const [index, line] of probe.descriptionPage.entries()) {
          const rendered = nodeText(namedNode(hard.tree, `tux-minigame-description-row-${index}`));
          expect(rendered).toBe(line);
          expect(rendered).not.toContain("…");
        }
        expect(namedNode(hard.tree, `tux-minigame-description-row-${probe.descriptionPage.length}`))
          .toBeUndefined();
        expect(capture.minigameArtUploads).toEqual({
          difficulty: 0,
          easy: 1,
          normal: 1,
          hard: 0,
        });
      }
    }
  }, 180_000);

  simTest("touch opens Battle, starts the match, opens GPS and selects a pin", async () => {
    for (let viewportIndex = 0; viewportIndex < FEATURE_MODES_VIEWPORTS.length; viewportIndex++) {
      for (const lang of LANGS) {
        expect((await captured(viewportIndex, lang)).touch).toEqual({
          titleBattle: true,
          difficultyBattle: true,
          titleBattleDemoBlocked: true,
          titleMinigame: true,
          minigameDifficulty: true,
          minigameAnswers: true,
          minigameExit: true,
          phoneMap: true,
          mapPoint: true,
          startParty: true,
          startRelease: true,
          startReleaseResult: true,
          startPlayer: true,
          startBag: true,
          titleOptions: true,
          titleOptionsCapture: true,
          startOptions: true,
          startOptionsVolume: true,
        });
      }
    }
  }, 180_000);

  simTest("the large frames retain the fixed 2x composition", async () => {
    for (const lang of LANGS) {
      const small = await captured(0, lang);
      const large = await captured(1, lang);
      for (const visualCase of FEATURE_MODES_CASES) {
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
                  const difference = Math.abs(large.cases[visualCase].rgba[target + channel]!
                    - small.cases[visualCase].rgba[source + channel]!);
                  channelError += difference;
                  if (difference !== 0) exact = false;
                }
              }
            }
            if (exact) exactBlocks++;
          }
        }
        expect(exactBlocks / (480 * 272), `${visualCase} exact ${lang}`).toBeGreaterThan(0.75);
        expect(channelError / (480 * 272 * 4 * 4), `${visualCase} mean ${lang}`).toBeLessThan(6);
      }
    }
  }, 180_000);
});
