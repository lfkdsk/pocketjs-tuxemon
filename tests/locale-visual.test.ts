// Production-rendered acceptance gate for the five shipped Latin locales.
// The exact images pin every surface at 1x and 2x, while the semantic checks
// make the oracle explainable: imported text, English fallback, measured
// wrapping, battle commands, palette regions, and final-atlas glyph coverage.

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, test } from "bun:test";

import { decodePng } from "../importer/png.ts";
import {
  captureLocaleAcceptance,
  FEATURE_MODES_VIEWPORTS,
  LOCALE_ACCEPTANCE_CASES,
  type LocaleAcceptanceCase,
  type LocaleAcceptanceCapture,
} from "../tools/feature-modes-visual-fixture.ts";
import { BAG_DETAIL_TEXT_WIDTH, bagDetailLines } from "../ui/bag-menu-text.ts";
import type {
  FeatureModesRuntimeData,
  LocalizedFeatureText,
} from "../ui/feature-modes-data.ts";
import type { Lang } from "../ui/language.ts";
import { TUXEMON_UI_THEME } from "../ui/tuxemon-theme.ts";
import { atlasCodepoints, parseAtlas } from "../vendor/pocket-rpgkit/tools/preview/atlas-merge.ts";
import { unpack } from "../vendor/pocket-rpgkit/vendor/pocketjs/framework/compiler/pak.ts";
import { fnv1a, treeHasText } from "../vendor/pocket-rpgkit/vendor/pocketjs/hosts/sim/sim.ts";

const ROOT = resolve(import.meta.dir, "..");
const BUNDLE = join(ROOT, "dist/main");
const PAK = BUNDLE + ".pak";
const WASM = join(ROOT, "vendor/pocket-rpgkit/vendor/pocketjs/hosts/web/pocketjs.wasm");
const MANIFEST_PATH = join(ROOT, "data/locale-visual-goldens.json");
const LANGS = ["de_DE", "fr_FR", "es_ES", "it_IT", "pt_BR"] as const satisfies readonly Lang[];
type LatinLang = typeof LANGS[number];

const canBoot = existsSync(BUNDLE + ".js") && existsSync(PAK)
  && existsSync(WASM) && existsSync(MANIFEST_PATH);
if (!canBoot) {
  console.warn("Locale visuals skipped; run `bun run build && bun run build:wasm && bun run goldens:locales`");
}
const simTest = canBoot ? test : test.skip;

interface GoldenFrame {
  case: LocaleAcceptanceCase;
  lang: LatinLang;
  width: number;
  height: number;
  file: string;
  rgbaFnv1a: string;
  pngSha256: string;
}

interface GoldenCapture {
  lang: LatinLang;
  width: number;
  height: number;
  dialogLines: string[];
  battleMenu: Array<{ kind: string; slug: string }>;
}

interface GoldenManifest {
  format: string;
  caseOrder: LocaleAcceptanceCase[];
  captures: GoldenCapture[];
  frames: GoldenFrame[];
}

interface TreeNode {
  n?: string;
  x?: string;
  k?: TreeNode[];
}

interface BattleDbSlice {
  items: Record<string, { name: string; description: string }>;
}

const manifest = canBoot
  ? JSON.parse(readFileSync(MANIFEST_PATH, "utf8")) as GoldenManifest
  : { format: "", caseOrder: [], captures: [], frames: [] };

const localeData = Object.fromEntries(LANGS.map((lang) => [lang, {
  features: JSON.parse(readFileSync(
    join(ROOT, `data/feature-modes-shell.${lang}.json`),
    "utf8",
  )) as FeatureModesRuntimeData,
  battle: JSON.parse(readFileSync(
    join(ROOT, `data/battle-db.${lang}.json`),
    "utf8",
  )) as BattleDbSlice,
}])) as Record<LatinLang, {
  features: FeatureModesRuntimeData;
  battle: BattleDbSlice;
}>;

function namedNode(value: unknown, name: string): TreeNode | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const node = value as TreeNode;
  if (node.n === name) return node;
  for (const child of node.k ?? []) {
    const found = namedNode(child, name);
    if (found) return found;
  }
  return undefined;
}

function nodeText(node: TreeNode | undefined): string {
  return node ? `${node.x ?? ""}${(node.k ?? []).map(nodeText).join("")}` : "";
}

function drawnText(value: unknown, out: string[] = []): string[] {
  if (value === null || typeof value !== "object") return out;
  const node = value as TreeNode;
  if (typeof node.x === "string" && node.x.length > 0) out.push(node.x);
  for (const child of node.k ?? []) drawnText(child, out);
  return out;
}

function localized(value: LocalizedFeatureText, lang: LatinLang): string {
  return value[lang] ?? value.en_US;
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
  colour: readonly [number, number, number],
): number {
  let count = 0;
  for (let offset = 0; offset < rgba.length; offset += 4) {
    if (rgba[offset] === colour[0] && rgba[offset + 1] === colour[1]
        && rgba[offset + 2] === colour[2]) count++;
  }
  return count;
}

function scaleMetrics(small: Uint8Array, large: Uint8Array): {
  exactBlockRatio: number;
  meanChannelError: number;
} {
  const smallWidth = 480;
  const largeWidth = 960;
  let exactBlocks = 0;
  let channelError = 0;
  for (let y = 0; y < 272; y++) {
    for (let x = 0; x < 480; x++) {
      const source = (y * smallWidth + x) * 4;
      let exact = true;
      for (let oy = 0; oy < 2; oy++) {
        for (let ox = 0; ox < 2; ox++) {
          const target = ((y * 2 + oy) * largeWidth + x * 2 + ox) * 4;
          for (let channel = 0; channel < 4; channel++) {
            const difference = Math.abs(large[target + channel]! - small[source + channel]!);
            channelError += difference;
            if (difference !== 0) exact = false;
          }
        }
      }
      if (exact) exactBlocks++;
    }
  }
  return {
    exactBlockRatio: exactBlocks / (480 * 272),
    meanChannelError: channelError / (480 * 272 * 4 * 4),
  };
}

type Capture = LocaleAcceptanceCapture;
const captures = new Map<string, Promise<Capture>>();
function captured(viewportIndex: number, lang: LatinLang): Promise<Capture> {
  const key = `${viewportIndex}:${lang}`;
  let pending = captures.get(key);
  if (!pending) {
    pending = captureLocaleAcceptance(FEATURE_MODES_VIEWPORTS[viewportIndex]!, lang);
    captures.set(key, pending);
  }
  return pending;
}

function fontAtlas() {
  const entry = unpack(new Uint8Array(readFileSync(PAK))).find((blob) => blob.key === "ui:font.0");
  if (!entry) throw new Error("locale visual test: dist/main.pak has no ui:font.0");
  return parseAtlas(entry.data);
}

describe("Latin locale production visuals", () => {
  simTest("match all 50 committed PNG/RGBA oracles and stable 2x composition", async () => {
    expect(manifest.format).toBe("pocket-tuxemon/locale-visual-goldens/v1");
    expect(manifest.caseOrder).toEqual([...LOCALE_ACCEPTANCE_CASES]);
    expect(manifest.captures).toHaveLength(LANGS.length * FEATURE_MODES_VIEWPORTS.length);
    expect(manifest.frames).toHaveLength(
      LANGS.length * FEATURE_MODES_VIEWPORTS.length * LOCALE_ACCEPTANCE_CASES.length,
    );
    expect(new Set(manifest.frames.map((entry) => entry.file)).size).toBe(manifest.frames.length);

    for (const lang of LANGS) {
      const byViewport: Capture[] = [];
      for (let viewportIndex = 0; viewportIndex < FEATURE_MODES_VIEWPORTS.length; viewportIndex++) {
        const viewport = FEATURE_MODES_VIEWPORTS[viewportIndex]!;
        const actual = await captured(viewportIndex, lang);
        byViewport.push(actual);
        const captureEntry = manifest.captures.find((entry) => entry.lang === lang
          && entry.width === viewport.width && entry.height === viewport.height);
        expect(captureEntry, `${lang} ${viewport.width}x${viewport.height} capture metadata`).toBeDefined();
        expect(actual.dialogLines).toEqual(captureEntry!.dialogLines);
        expect(actual.battleMenu).toEqual(captureEntry!.battleMenu);

        for (const visualCase of LOCALE_ACCEPTANCE_CASES) {
          const entry = manifest.frames.find((candidate) => candidate.case === visualCase
            && candidate.lang === lang && candidate.width === viewport.width
            && candidate.height === viewport.height);
          if (!entry) {
            throw new Error(`missing ${visualCase} ${lang} ${viewport.width}x${viewport.height} golden`);
          }
          const path = join(ROOT, "tests/goldens", entry.file);
          const png = new Uint8Array(readFileSync(path));
          const decoded = decodePng(png, path);
          const rgba = actual.cases[visualCase].rgba;
          expect([decoded.width, decoded.height]).toEqual([viewport.width, viewport.height]);
          expect(rgba, entry.file).toEqual(decoded.rgba);
          expect(fnv1a(rgba), entry.file).toBe(entry.rgbaFnv1a);
          expect(createHash("sha256").update(png).digest("hex"), entry.file).toBe(entry.pngSha256);
        }
      }
      for (const visualCase of LOCALE_ACCEPTANCE_CASES) {
        const metrics = scaleMetrics(
          byViewport[0]!.cases[visualCase].rgba,
          byViewport[1]!.cases[visualCase].rgba,
        );
        // The imported-map dialog includes a separately sampled tile layer;
        // its host-scaled pixels differ more than the fixed-resolution
        // overlays, but still retain a strong 2x correspondence.
        const exactFloor = visualCase === "dialog" ? 0.65 : 0.75;
        const errorCeiling = visualCase === "dialog" ? 20 : 6;
        expect(metrics.exactBlockRatio, `${lang} ${visualCase} exact 2x blocks`)
          .toBeGreaterThan(exactFloor);
        expect(metrics.meanChannelError, `${lang} ${visualCase} 2x mean error`)
          .toBeLessThan(errorCeiling);
      }
    }
  }, 240_000);

  simTest("shows imported copy and observable English fallback without semantic truncation", async () => {
    const titleRows = ["newGame", "battle", "minigame", "options", "exit"] as const;
    const expectedBattleMenu = [
      { kind: "fight", slug: "fight" },
      { kind: "replacement", slug: "swap" },
      { kind: "item", slug: "item" },
      { kind: "forfeit", slug: "forfeit" },
    ];

    for (let viewportIndex = 0; viewportIndex < FEATURE_MODES_VIEWPORTS.length; viewportIndex++) {
      for (const lang of LANGS) {
        const capture = await captured(viewportIndex, lang);
        const { features, battle } = localeData[lang];

        expect(nodeText(namedNode(capture.cases.title.tree, "tux-title-name"))).toBe("POCKET TUXEMON");
        for (const row of titleRows) {
          expect(nodeText(namedNode(capture.cases.title.tree, `tux-title-row-${row}`)))
            .toBe(localized(features.startMenu.title[row], lang));
        }
        expect(localized(features.startMenu.title.newGame, lang)).not.toBe(
          features.startMenu.title.newGame.en_US,
        );
        expect(localized(features.startMenu.title.battle, lang)).toBe(
          features.startMenu.title.battle.en_US,
        );

        expect(capture.dialogLines).toEqual(["Do you want to skip the intro?"]);
        expect(treeHasText(capture.cases.dialog.tree, "Do you want to skip the intro?")).toBeTrue();

        expect(capture.battleMenu).toEqual(expectedBattleMenu);
        for (const label of ["Fight", "Swap", "Item", "Forfeit"]) {
          expect(treeHasText(capture.cases.battle.tree, label), `${lang} battle fallback ${label}`).toBeTrue();
        }
        expect(namedNode(capture.cases.battle.tree, "tux-battle-scene")).toBeDefined();
        expect(namedNode(capture.cases.battle.tree, "battle-commands")).toBeDefined();

        expect(nodeText(namedNode(capture.cases.bag.tree, "tux-bag-title")))
          .toBe(localized(features.startMenu.root.bag, lang));
        expect(nodeText(namedNode(capture.cases.bag.tree, "tux-bag-item-name")))
          .toBe(battle.items.potion!.name);

        const options = capture.cases.options.tree;
        expect(nodeText(namedNode(options, "options-title"))).toBe(localized(features.options.title, lang));
        expect(nodeText(namedNode(options, "options-label-control:primary")))
          .toBe(localized(features.options.controls.primary, lang));
        expect(localized(features.options.controls.primary, lang)).not.toBe(
          features.options.controls.primary.en_US,
        );
        expect(localized(features.options.musicVolume, lang)).toBe(features.options.musicVolume.en_US);
        expect(nodeText(namedNode(options, "options-label-music"))).toBe(
          features.options.musicVolume.en_US,
        );

        for (const visualCase of LOCALE_ACCEPTANCE_CASES) {
          const texts = drawnText(capture.cases[visualCase].tree);
          expect(texts.length, `${lang} ${visualCase} semantic text`).toBeGreaterThan(0);
          for (const text of texts) {
            expect(text.includes("…"), `${lang} ${visualCase} inserted ellipsis in ${JSON.stringify(text)}`)
              .toBeFalse();
          }
        }
      }
    }
  }, 240_000);

  simTest("wraps every selected item description within its real atlas width", async () => {
    const atlas = fontAtlas();
    const advance = new Map(atlas.entries.map((entry) => [entry.cp, entry.advance]));
    const measure = (text: string): number => [...text].reduce((width, scalar) =>
      width + (advance.get(scalar.codePointAt(0)!) ?? Number.POSITIVE_INFINITY), 0);

    for (const lang of LANGS) {
      const capture = await captured(0, lang);
      const description = localeData[lang].battle.items.potion!.description;
      const lines = bagDetailLines(description, measure);
      expect(lines.length, `${lang} wrapped potion description`).toBe(
        measure(description) > BAG_DETAIL_TEXT_WIDTH ? 2 : 1,
      );
      expect(lines.join(" ").replaceAll(/\s+/g, " ").trim()).toBe(
        description.replaceAll(/\s+/g, " ").trim(),
      );
      expect(nodeText(namedNode(capture.cases.bag.tree, "tux-bag-item-description")))
        .toBe(lines.join("\n"));
      for (const line of lines) {
        expect(measure(line), `${lang} ${JSON.stringify(line)}`).toBeLessThanOrEqual(BAG_DETAIL_TEXT_WIDTH);
      }
    }
  }, 240_000);

  simTest("contains meaningful semantic palette regions at both viewport scales", async () => {
    const accent = rgb(TUXEMON_UI_THEME.accent);
    const paper = rgb(TUXEMON_UI_THEME.paper);
    const rim = rgb(TUXEMON_UI_THEME.rim);
    const selected = rgb("#145064");
    for (let viewportIndex = 0; viewportIndex < FEATURE_MODES_VIEWPORTS.length; viewportIndex++) {
      const viewport = FEATURE_MODES_VIEWPORTS[viewportIndex]!;
      const scaleArea = (viewport.width / 480) ** 2;
      for (const lang of LANGS) {
        const capture = await captured(viewportIndex, lang);
        expect(countColour(capture.cases.title.rgba, accent) / scaleArea).toBeGreaterThan(500);
        expect(countColour(capture.cases.title.rgba, selected) / scaleArea).toBeGreaterThan(3_000);
        expect(countColour(capture.cases.dialog.rgba, paper) / scaleArea).toBeGreaterThan(15_000);
        expect(countColour(capture.cases.dialog.rgba, rim) / scaleArea).toBeGreaterThan(400);
        expect(countColour(capture.cases.bag.rgba, accent) / scaleArea).toBeGreaterThan(3_000);
        expect(countColour(capture.cases.bag.rgba, paper) / scaleArea).toBeGreaterThan(70_000);
        expect(countColour(capture.cases.options.rgba, selected) / scaleArea).toBeGreaterThan(3_000);
        expect(countColour(capture.cases.options.rgba, paper) / scaleArea).toBeGreaterThan(80_000);
      }
    }
  }, 240_000);

  simTest("maps every rendered scalar in the final regular font atlas", async () => {
    const mapped = atlasCodepoints(fontAtlas());
    const used = new Map<number, Set<string>>();
    for (let viewportIndex = 0; viewportIndex < FEATURE_MODES_VIEWPORTS.length; viewportIndex++) {
      for (const lang of LANGS) {
        const capture = await captured(viewportIndex, lang);
        for (const visualCase of LOCALE_ACCEPTANCE_CASES) {
          for (const text of drawnText(capture.cases[visualCase].tree)) {
            for (const scalar of text) {
              const point = scalar.codePointAt(0)!;
              if (point < 32 || point === 127) continue;
              const contexts = used.get(point) ?? new Set<string>();
              contexts.add(`${lang}/${visualCase}`);
              used.set(point, contexts);
            }
          }
        }
      }
    }
    const missing = [...used].filter(([point]) => !mapped.has(point)).map(([point, contexts]) =>
      `U+${point.toString(16).toUpperCase().padStart(4, "0")} ${String.fromCodePoint(point)} (${[...contexts].slice(0, 3).join(", ")})`);
    expect(missing).toEqual([]);
  }, 240_000);
});
