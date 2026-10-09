import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, test } from "bun:test";

import { decodePng } from "../importer/png.ts";
import {
  captureRadio,
  RADIO_VISUAL_CASES,
  RADIO_VISUAL_VIEWPORTS,
  type RadioVisualCase,
  type RadioVisualCapture,
} from "../tools/radio-visual-fixture.ts";
import { TUXEMON_UI_THEME } from "../ui/tuxemon-theme.ts";
import { unpack } from "../vendor/pocket-rpgkit/vendor/pocketjs/framework/compiler/pak.ts";
import { fnv1a, treeHasText } from "../vendor/pocket-rpgkit/vendor/pocketjs/hosts/sim/sim.ts";

const ROOT = resolve(import.meta.dir, "..");
const BUNDLE = join(ROOT, "dist/main");
const WASM = join(ROOT, "vendor/pocket-rpgkit/vendor/pocketjs/hosts/web/pocketjs.wasm");
const MANIFEST = join(ROOT, "data/radio-goldens.json");
const canBoot = existsSync(BUNDLE + ".js") && existsSync(BUNDLE + ".pak") &&
  existsSync(WASM) && existsSync(MANIFEST);
if (!canBoot) console.warn("radio visual tests skipped; run `bun run import && bun run build && bun run build:wasm && bun run goldens:radio`");
const simTest = canBoot ? test : test.skip;

interface GoldenEntry {
  case: RadioVisualCase;
  width: number;
  height: number;
  file: string;
  rgbaFnv1a: string;
  pngSha256: string;
}

const manifest = canBoot
  ? JSON.parse(readFileSync(MANIFEST, "utf8")) as { format: string; frames: GoldenEntry[] }
  : { format: "", frames: [] };

let captures: Promise<RadioVisualCapture[]> | undefined;
function captured(): Promise<RadioVisualCapture[]> {
  // The sim host intentionally exposes one active global guest at a time.
  // Capture the two resolutions sequentially, just like the golden writer.
  return captures ??= (async () => {
    const output: RadioVisualCapture[] = [];
    for (const viewport of RADIO_VISUAL_VIEWPORTS) output.push(await captureRadio(viewport));
    return output;
  })();
}

function sceneText(tree: unknown): string {
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

function rgb(hex: string): readonly [number, number, number] {
  return [
    Number.parseInt(hex.slice(1, 3), 16),
    Number.parseInt(hex.slice(3, 5), 16),
    Number.parseInt(hex.slice(5, 7), 16),
  ];
}

function countLogicalColour(
  capture: RadioVisualCapture,
  visualCase: RadioVisualCase,
  rect: { x: number; y: number; width: number; height: number },
  colour: readonly [number, number, number],
): number {
  const scale = Math.min(capture.width / 480, capture.height / 272);
  const left = Math.floor((capture.width - 480 * scale) / 2);
  const top = Math.floor((capture.height - 272 * scale) / 2);
  const pixels = capture.cases[visualCase].rgba;
  let count = 0;
  for (let y = Math.floor(top + rect.y * scale); y < Math.ceil(top + (rect.y + rect.height) * scale); y++) {
    for (let x = Math.floor(left + rect.x * scale); x < Math.ceil(left + (rect.x + rect.width) * scale); x++) {
      const offset = (y * capture.width + x) * 4;
      if (pixels[offset] === colour[0] && pixels[offset + 1] === colour[1] && pixels[offset + 2] === colour[2]) count++;
    }
  }
  return count;
}

function countLogicalNonColour(
  capture: RadioVisualCapture,
  visualCase: RadioVisualCase,
  rect: { x: number; y: number; width: number; height: number },
  colour: readonly [number, number, number],
): number {
  const scale = Math.min(capture.width / 480, capture.height / 272);
  const left = Math.floor((capture.width - 480 * scale) / 2);
  const top = Math.floor((capture.height - 272 * scale) / 2);
  const pixels = capture.cases[visualCase].rgba;
  let count = 0;
  for (let y = Math.floor(top + rect.y * scale); y < Math.ceil(top + (rect.y + rect.height) * scale); y++) {
    for (let x = Math.floor(left + rect.x * scale); x < Math.ceil(left + (rect.x + rect.width) * scale); x++) {
      const offset = (y * capture.width + x) * 4;
      if (pixels[offset] !== colour[0] || pixels[offset + 1] !== colour[1] || pixels[offset + 2] !== colour[2]) count++;
    }
  }
  return count;
}

describe("production radio tuner visuals", () => {
  simTest("reuses the existing 18px atlas instead of baking a radio-only 24px atlas", () => {
    const keys = unpack(new Uint8Array(readFileSync(BUNDLE + ".pak"))).map((entry) => entry.key);
    expect(keys).toContain("ui:font.3");
    expect(keys).not.toContain("ui:font.5");
  });

  simTest("match inspected tuner and broadcast PNGs at both viewports", async () => {
    expect(manifest.format).toBe("pocket-tuxemon/radio-goldens/v1");
    expect(manifest.frames).toHaveLength(RADIO_VISUAL_VIEWPORTS.length * RADIO_VISUAL_CASES.length);
    for (const capture of await captured()) {
      for (const visualCase of RADIO_VISUAL_CASES) {
        const entry = manifest.frames.find((candidate) => candidate.case === visualCase &&
          candidate.width === capture.width && candidate.height === capture.height);
        if (!entry) throw new Error(`radio ${visualCase}: missing ${capture.width}x${capture.height} golden`);
        const path = join(ROOT, "tests/goldens", entry.file);
        const png = new Uint8Array(readFileSync(path));
        const decoded = decodePng(png, path);
        expect(capture.cases[visualCase].rgba).toEqual(decoded.rgba);
        expect(fnv1a(decoded.rgba)).toBe(entry.rgbaFnv1a);
        expect(createHash("sha256").update(png).digest("hex")).toBe(entry.pngSha256);
      }
    }
  }, 90_000);

  simTest("shows the exact dial, signal and imported broadcast", async () => {
    for (const capture of await captured()) {
      const tuner = capture.cases.tuner;
      expect(treeHasText(tuner.tree, "94.7")).toBeTrue();
      expect(treeHasText(tuner.tree, "MHz")).toBeTrue();
      expect(sceneText(tuner.tree)).toContain("Route 101 Rhythms");
      expect(sceneText(tuner.tree)).toContain("Strong (100%)");
      expect(capture.cases.broadcast.state.broadcastDialogue).toEqual([
        "An R&B song is playing. It's called \"Possessuns, Part I\".",
      ]);
      expect(sceneText(capture.cases.broadcast.tree)).toContain("Possessuns,\nPart I");

      // A perfect station paints a full-width accent signal bar in the tuner
      // panel. The threshold scales by area, so both logical resolutions
      // assert the same semantic region rather than only pinning a hash.
      const scale = Math.min(capture.width / 480, capture.height / 272);
      // The reused 18px atlas still paints a substantial, unclipped 94.7
      // inside its otherwise paper-coloured box at both raster densities.
      expect(countLogicalNonColour(
        capture,
        "tuner",
        { x: 122, y: 46, width: 160, height: 44 },
        rgb(TUXEMON_UI_THEME.paper),
      )).toBeGreaterThan(150 * scale * scale);
      expect(countLogicalColour(
        capture,
        "tuner",
        { x: 80, y: 166, width: 310, height: 24 },
        rgb(TUXEMON_UI_THEME.accent),
      )).toBeGreaterThan(1_500 * scale * scale);
    }
  }, 90_000);

  simTest("touch Play, Continue and Return through scaled production hit regions", async () => {
    for (const capture of await captured()) {
      expect(capture.touch).toEqual({
        playWorked: true,
        nextWorked: true,
        returnWorked: true,
      });
    }
  }, 90_000);
});
