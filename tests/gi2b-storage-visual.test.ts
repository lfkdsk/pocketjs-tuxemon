import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, test } from "bun:test";

import { decodePng } from "../importer/png.ts";
import {
  captureGi2b,
  GI2B_VIEWPORTS,
  GI2B_VISUAL_CASES,
  type Gi2bArt,
  type Gi2bCapture,
  type Gi2bVisualCase,
} from "../tools/gi2b-storage-fixture.ts";
import { TUXEMON_UI_THEME } from "../ui/tuxemon-theme.ts";
import { fnv1a, treeHasText } from "../vendor/pocket-rpgkit/vendor/pocketjs/hosts/sim/sim.ts";

const ROOT = resolve(import.meta.dir, "..");
const BUNDLE = join(ROOT, "dist/main");
const WASM = join(ROOT, "vendor/pocket-rpgkit/vendor/pocketjs/hosts/web/pocketjs.wasm");
const MANIFEST = join(ROOT, "data/gi2b-storage-goldens.json");
const canBoot = existsSync(BUNDLE + ".js") && existsSync(BUNDLE + ".pak") &&
  existsSync(WASM) && existsSync(MANIFEST);
if (!canBoot) console.warn("GI2b storage visual tests skipped; run `bun run build && bun run build:wasm && bun tools/update-gi2b-goldens.ts`");
const simTest = canBoot ? test : test.skip;

interface GoldenEntry {
  case: Gi2bVisualCase;
  width: number;
  height: number;
  file: string;
  rgbaFnv1a: string;
  pngSha256: string;
}

const manifest = canBoot
  ? JSON.parse(readFileSync(MANIFEST, "utf8")) as { format: string; frames: GoldenEntry[] }
  : { format: "", frames: [] };

function rgb(hex: string): readonly [number, number, number] {
  return [Number.parseInt(hex.slice(1, 3), 16), Number.parseInt(hex.slice(3, 5), 16), Number.parseInt(hex.slice(5, 7), 16)];
}

function count(
  rgba: Uint8Array,
  width: number,
  rect: { x: number; y: number; width: number; height: number },
  matches: (pixel: readonly [number, number, number]) => boolean,
): number {
  let total = 0;
  for (let y = rect.y; y < rect.y + rect.height; y++) for (let x = rect.x; x < rect.x + rect.width; x++) {
    const offset = (y * width + x) * 4;
    if (matches([rgba[offset]!, rgba[offset + 1]!, rgba[offset + 2]!])) total++;
  }
  return total;
}

const same = (colour: readonly [number, number, number]) =>
  (pixel: readonly [number, number, number]) => pixel.every((channel, index) => channel === colour[index]);

/** Every opaque source pixel of the front sprite lands, 2x scaled, at the
 *  logical origin (480x272 canvas). */
function assertFrontSprite(rgba: Uint8Array, art: Gi2bArt, originX: number, originY: number): void {
  const image = decodePng(new Uint8Array(readFileSync(join(ROOT, art.artPath))), art.artPath);
  const [sourceX, sourceY, width, height] = art.front;
  let opaque = 0;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const source = ((sourceY + y) * image.width + sourceX + x) * 4;
    if (image.rgba[source + 3] !== 255) continue;
    const expected = [...image.rgba.slice(source, source + 3)].map((channel) => Math.floor(channel / 16) * 17);
    for (const [dx, dy] of [[0, 0], [1, 1]]) {
      const target = ((originY + y * 2 + dy!) * 480 + originX + x * 2 + dx!) * 4;
      expect([...rgba.slice(target, target + 3)], `${art.slug} ${x},${y}`).toEqual(expected);
    }
    opaque++;
  }
  expect(opaque).toBeGreaterThan(500);
}

let captures: Promise<{ small: Gi2bCapture; large: Gi2bCapture }> | undefined;
function captured() {
  return captures ??= (async () => ({
    small: await captureGi2b(GI2B_VIEWPORTS[0]),
    large: await captureGi2b(GI2B_VIEWPORTS[1]),
  }))();
}

describe("GI-2b production storage, trade and shop visuals", () => {
  simTest("match both committed viewports", async () => {
    expect(manifest.format).toBe("pocket-tuxemon/gi2b-storage-goldens/v1");
    expect(manifest.frames).toHaveLength(GI2B_VIEWPORTS.length * GI2B_VISUAL_CASES.length);
    const { small, large } = await captured();
    for (const capture of [small, large]) {
      for (const visualCase of GI2B_VISUAL_CASES) {
        const entry = manifest.frames.find((candidate) => candidate.case === visualCase
          && candidate.width === capture.width && candidate.height === capture.height);
        if (!entry) throw new Error(`GI2b ${visualCase} golden: missing ${capture.width}x${capture.height}`);
        const path = join(ROOT, "tests/goldens", entry.file);
        const png = new Uint8Array(readFileSync(path));
        const expected = decodePng(png, path);
        expect(capture.cases[visualCase].rgba).toEqual(expected.rgba);
        expect(fnv1a(capture.cases[visualCase].rgba)).toBe(entry.rgbaFnv1a);
        expect(createHash("sha256").update(png).digest("hex")).toBe(entry.pngSha256);
      }
      expect(treeHasText(capture.cases.pcBox.tree, "SHELTER 4/30")).toBeTrue();
      expect(treeHasText(capture.cases.pcBox.tree, "Quarantine")).toBeTrue();
      expect(treeHasText(capture.cases.pcOptions.tree, "Move to Quarantine")).toBeTrue();
      expect(treeHasText(capture.cases.tradeDone.tree, "You traded Cateye and received Zunna!")).toBeTrue();
      expect(treeHasText(capture.cases.shop.tree, "Money: $1250")).toBeTrue();
      expect(treeHasText(capture.cases.shop.tree, "Lv.10   Earth / Shadow")).toBeTrue();
      // Item locker: sorted rows, quantities and the box summary.
      expect(treeHasText(capture.cases.pcItemLocker.tree, "LOCKER 5/30 19 ITEMS")).toBeTrue();
      expect(treeHasText(capture.cases.pcItemLocker.tree, "Antidote")).toBeTrue();
      expect(treeHasText(capture.cases.pcItemLocker.tree, "Tuxeball")).toBeTrue();
      expect(treeHasText(capture.cases.pcItemQuantity.tree, "x1 / 25")).toBeTrue();
      // The bag list hides the invisible nu_phone (upstream visible:false).
      expect(treeHasText(capture.cases.pcItemBag.tree, "BAG 4 KINDS")).toBeTrue();
      expect(treeHasText(capture.cases.pcItemBag.tree, "Potion")).toBeTrue();
      expect(treeHasText(capture.cases.pcItemBag.tree, "Nu Phone")).toBeFalse();
    }
  }, 60_000);

  simTest("PC rows show the cursor, box counts and HP bars", async () => {
    const { small } = await captured();
    const accent = rgb(TUXEMON_UI_THEME.accent);
    const box = small.cases.pcBox.rgba;
    // Display order is by slug: Aardorn, Bigfin (selected), Budaye, Eyenemy.
    const row = (index: number) => ({ x: 201, y: 64 + index * 22, width: 264, height: 20 });
    expect(count(box, 480, row(1), same(accent))).toBeGreaterThan(3_000);
    expect(count(box, 480, row(0), same(accent))).toBe(0);
    expect(count(box, 480, row(2), same(accent))).toBe(0);
    // Aardorn is at 60% HP: green fill stops before the bar's end.
    const green = same([0x5f, 0xd0, 0x68]);
    const aardorn = count(box, 480, { x: 403, y: 64, width: 52, height: 20 }, green);
    const bigfin = count(box, 480, { x: 403, y: 86, width: 52, height: 20 }, green);
    expect(aardorn).toBeGreaterThan(80);
    expect(bigfin).toBeGreaterThan(aardorn + 60);
    // The options popup covers the right half of the box list.
    expect(count(small.cases.pcOptions.rgba, 480, { x: 300, y: 68, width: 160, height: 20 }, same(accent)))
      .toBeGreaterThan(2_500);
  }, 60_000);

  simTest("trade frames show the sent sprite alone, then the received one with the message", async () => {
    const { small } = await captured();
    const black = same([0, 0, 0]);
    const flash = small.cases.tradeFlash.rgba;
    const slot = (left: number) => ({ x: left, y: 52, width: 128, height: 128 });
    // At 3.5 s the sent Cateye flashes at the left quarter; the right slot is dark.
    expect(128 * 128 - count(flash, 480, slot(56), black)).toBeGreaterThan(1_000);
    expect(count(flash, 480, slot(296), black)).toBe(128 * 128);
    assertFrontSprite(small.cases.tradeDone.rgba, small.art.tradeReceived, 176, 52);
  }, 60_000);

  simTest("monster shop shows the selected stock row and its imported art", async () => {
    const { small } = await captured();
    const accent = rgb(TUXEMON_UI_THEME.accent);
    const shop = small.cases.shop.rgba;
    // Fuzzlet, Potturmeist (selected), Squink, Woodoor, Ziggurat.
    expect(count(shop, 480, { x: 15, y: 64, width: 196, height: 20 }, same(accent))).toBeGreaterThan(2_500);
    expect(count(shop, 480, { x: 15, y: 42, width: 196, height: 20 }, same(accent))).toBe(0);
    assertFrontSprite(shop, small.art.shop, 284, 34);
  }, 60_000);

  simTest("item locker rows, quantity picker and bag list render with a cursor", async () => {
    const { small, large } = await captured();
    const accent = rgb(TUXEMON_UI_THEME.accent);
    // Locker list: Antidote (row 0) is selected; Potion (row 1) is not.
    const locker = small.cases.pcItemLocker.rgba;
    const itemRow = (index: number) => ({ x: 199, y: 62 + index * 22, width: 264, height: 20 });
    expect(count(locker, 480, itemRow(0), same(accent))).toBeGreaterThan(3_000);
    expect(count(locker, 480, itemRow(1), same(accent))).toBe(0);
    // The nav panel's Locker box row is highlighted.
    expect(count(locker, 480, { x: 13, y: 40, width: 166, height: 20 }, same(accent))).toBeGreaterThan(2_000);
    // Quantity picker: the popup frame is painted over the detail list and
    // the "x1 / 25" value renders in accent.
    const quantity = small.cases.pcItemQuantity.rgba;
    const popupBorder = rgb(TUXEMON_UI_THEME.border);
    expect(count(quantity, 480, { x: 292, y: 60, width: 174, height: 2 }, same(popupBorder))).toBeGreaterThan(200);
    expect(count(quantity, 480, { x: 302, y: 90, width: 100, height: 24 }, same(accent))).toBeGreaterThan(30);
    // Bag list: Potion (row 0) is selected; the hidden nu_phone leaves 3 rows.
    const bag = small.cases.pcItemBag.rgba;
    expect(count(bag, 480, itemRow(0), same(accent))).toBeGreaterThan(3_000);
    expect(count(bag, 480, itemRow(3), same(accent))).toBe(0);
    // 960x544 is the same composition at 2x (accent rows land at 2x coords).
    const locker2x = large.cases.pcItemLocker.rgba;
    expect(count(locker2x, 960, { x: 398, y: 124, width: 528, height: 40 }, same(accent))).toBeGreaterThan(12_000);
  }, 60_000);
});
