// Neighbour character preview across mainline seams: re-run the semantic
// pixel checks of tools/preview-seam-plan.ts on the committed contact sheets
// (regenerate with `bun run goldens:preview-seam`).

import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { decodePng } from "../importer/png.ts";
import {
  assertPreviewSeamMatrix,
  checkPreviewSeamRun,
  FIGURE_MATCH_MIN,
  missBudget,
  PREVIEW_SEAM_CROSSINGS,
  PREVIEW_SEAM_OUTPUT,
  PREVIEW_SEAM_VIEWPORTS,
  previewSeamSheetFile,
  sheetCell,
  type PreviewSeamCapture,
  type PreviewSeamManifest,
  type Pixels,
  type SpriteArt,
} from "../tools/preview-seam-plan.ts";

const DIR = join(import.meta.dir, "..", PREVIEW_SEAM_OUTPUT);
const manifest = JSON.parse(readFileSync(join(DIR, "manifest.json"), "utf8")) as PreviewSeamManifest;
const ROOT = join(import.meta.dir, "..");

// The character art the frames are checked against (committed PNGs).
const artImages = new Map<string, SpriteArt>();
function art(path: string): SpriteArt {
  let image = artImages.get(path);
  if (!image) artImages.set(path, image = decodePng(new Uint8Array(readFileSync(join(ROOT, path)))));
  return image;
}

function sheet(viewport: { width: number; height: number }) {
  const file = join(DIR, previewSeamSheetFile(viewport));
  expect(existsSync(file)).toBe(true);
  const bytes = readFileSync(file);
  const recorded = manifest.sheets.find((entry) => entry.file === previewSeamSheetFile(viewport))!;
  expect(createHash("sha256").update(bytes).digest("hex")).toBe(recorded.pngSha256);
  const image = decodePng(new Uint8Array(bytes));
  expect([image.width, image.height]).toEqual([recorded.width, recorded.height]);
  return image;
}

describe("neighbour preview across mainline seams", () => {
  const images = new Map<number, ReturnType<typeof sheet>>(PREVIEW_SEAM_VIEWPORTS.map((viewport) => [viewport.width, sheet(viewport)]));

  const checks = manifest.runs.map((run) => {
    const image = images.get(run.viewport.width)!;
    const crossingIndex = PREVIEW_SEAM_CROSSINGS.findIndex((crossing) => crossing.id === run.crossing);
    const pixels = (capture: PreviewSeamCapture): Pixels => {
      const [x0, y0] = sheetCell(crossingIndex, capture, run.viewport);
      return {
        width: image.width,
        height: image.height,
        rgba: image.rgba,
        x0,
        y0,
        frameWidth: run.viewport.width,
        frameHeight: run.viewport.height,
      };
    };
    return checkPreviewSeamRun(run, pixels, art);
  });

  test("every far-side character is in place before the crossing, the commit frame neither drops nor doubles it, and the map behind stays frozen", () => {
    expect(() => assertPreviewSeamMatrix(manifest, checks)).not.toThrow();
    // The sheets reproduce the generator's measurements exactly.
    for (const [index, run] of manifest.runs.entries()) {
      expect(checks[index]!.ratios).toEqual(run.ratios);
      expect(checks[index]!.figures).toEqual(run.figures);
    }
  });

  test("every frame of every crossing checks characters in place and scans for doubles", () => {
    for (const [index, run] of manifest.runs.entries()) {
      for (const frame of run.frames) {
        expect(frame.figures.length).toBeGreaterThan(0);
        // Every expected character found by the scan at most once, and
        // nothing else: occurrences never exceed the expected figures.
        expect(checks[index]!.figures[frame.capture].occurrences).toBeLessThanOrEqual(frame.figures.length);
      }
    }
    const present = checks.flatMap((check) => Object.values(check.figures).flatMap((entry) => entry.present));
    expect(present.filter((entry) => entry.startsWith("target:")).length).toBeGreaterThan(100);
    expect(present.filter((entry) => entry.startsWith("left:")).length).toBeGreaterThan(50);
  });

  test("covers every crossing at both viewports with characters on both sides", () => {
    const far = checks.reduce((sum, check) => sum + check.targetChecked, 0);
    const behind = checks.reduce((sum, check) => sum + check.leftChecked, 0);
    expect(manifest.runs.length).toBe(PREVIEW_SEAM_CROSSINGS.length * PREVIEW_SEAM_VIEWPORTS.length);
    expect(far).toBeGreaterThanOrEqual(PREVIEW_SEAM_CROSSINGS.length * 2);
    expect(behind).toBeGreaterThan(0);
  });

  // Mutations of the committed 480×272 sheet: each must fail the run.
  function mutated(crossing: string, paint: (copy: Uint8Array, cell: (capture: PreviewSeamCapture) => [number, number], width: number) => void) {
    const crossingIndex = PREVIEW_SEAM_CROSSINGS.findIndex((candidate) => candidate.id === crossing);
    const run = manifest.runs.find((candidate) => candidate.crossing === crossing && candidate.viewport.width === 480)!;
    const image = images.get(480)!;
    const copy = image.rgba.slice();
    const cell = (capture: PreviewSeamCapture) => sheetCell(crossingIndex, capture, run.viewport);
    paint(copy, cell, image.width);
    const check = checkPreviewSeamRun(run, (capture) => {
      const [x0, y0] = cell(capture);
      return { width: image.width, height: image.height, rgba: copy, x0, y0, frameWidth: 480, frameHeight: 272 };
    }, art);
    return { run, check };
  }

  /** Draw `path` with its top-left at (x, y) of a frame. */
  function stamp(copy: Uint8Array, width: number, [cx, cy]: [number, number], path: string, x: number, y: number): void {
    const sprite = art(path);
    for (let sy = 0; sy < sprite.height; sy++) {
      for (let sx = 0; sx < sprite.width; sx++) {
        const from = (sy * sprite.width + sx) * 4;
        if (sprite.rgba[from + 3] !== 255) continue;
        copy.set(sprite.rgba.subarray(from, from + 4), ((cy + y + sy) * width + cx + x + sx) * 4);
      }
    }
  }

  /** Overwrite a rect of a frame with the pixels one tile to its left. */
  function erase(copy: Uint8Array, width: number, [cx, cy]: [number, number], rect: readonly number[]): void {
    for (let y = 0; y < rect[3]!; y++) {
      for (let x = 0; x < rect[2]!; x++) {
        const at = ((cy + rect[1]! + y) * width + cx + rect[0]! + x) * 4;
        const from = at - 16 * 4;
        copy.set(copy.subarray(from, from + 4), at);
      }
    }
  }

  /** Opaque pixel count of `path`'s image. */
  function opaqueCount(path: string): number {
    const sprite = art(path);
    let n = 0;
    for (let i = 3; i < sprite.rgba.length; i += 4) if (sprite.rgba[i] === 255) n++;
    return n;
  }

  /** Draw `path` at (x, y) of a frame, then restore the opaque pixels at the
   * given row-major indices to the frame's original background. Returns how
   * many restored pixels had actually differed from the sprite (the
   * mismatches the holes create). */
  function stampWithHoles(
    copy: Uint8Array,
    original: Uint8Array,
    width: number,
    [cx, cy]: [number, number],
    path: string,
    x: number,
    y: number,
    holes: readonly number[],
  ): number {
    const sprite = art(path);
    const opaque: { sx: number; sy: number }[] = [];
    for (let sy = 0; sy < sprite.height; sy++) {
      for (let sx = 0; sx < sprite.width; sx++) {
        if (sprite.rgba[(sy * sprite.width + sx) * 4 + 3] !== 255) continue;
        opaque.push({ sx, sy });
      }
    }
    stamp(copy, width, [cx, cy], path, x, y);
    let mismatches = 0;
    for (const index of holes) {
      const { sx, sy } = opaque[index]!;
      const at = ((cy + y + sy) * width + cx + x + sx) * 4;
      if (copy[at] !== original[at] || copy[at + 1] !== original[at + 1] || copy[at + 2] !== original[at + 2]) mismatches++;
      copy.set(original.subarray(at, at + 4), at);
    }
    return mismatches;
  }

  test("a previewed character missing from before, commit and after fails", () => {
    const { run, check } = mutated("dryadsgrove-cotton", (copy, cell, width) => {
      const run = manifest.runs.find((candidate) => candidate.crossing === "dryadsgrove-cotton" && candidate.viewport.width === 480)!;
      for (const frame of run.frames) {
        if (frame.capture === "later") continue;
        const monk = frame.figures.find((figure) => figure.eventId === "npc_spyder_cottontown_monk")!;
        erase(copy, width, cell(frame.capture), monk.rect);
      }
    });
    expect(run.frames.length).toBe(4);
    for (const capture of ["before", "commit", "after"]) {
      expect(check.failures.some((failure) => failure.includes(` ${capture} target npc_spyder_cottontown_monk missing`))).toBe(true);
    }
  });

  test("a character drawn a second time where nobody stands fails", () => {
    const { check } = mutated("dryadsgrove-cotton", (copy, cell, width) => {
      stamp(copy, width, cell("commit"), "assets/characters/npc-npc-monk-idle-0.png", 16, 16);
      // Off the tile grid too: the scan covers every pixel position.
      stamp(copy, width, cell("later"), "assets/characters/npc-npc-statue-red-static.png", 37, 23);
    });
    expect(check.failures).toEqual([
      "dryadsgrove-cotton 480x272 commit assets/characters/npc-npc-monk-idle-0.png drawn at 16,16 where no character stands (doubled or ghost)",
      "dryadsgrove-cotton 480x272 later assets/characters/npc-npc-statue-red-static.png drawn at 37,23 where no character stands (doubled or ghost)",
    ]);
  });

  test("a character left behind drawn both frozen and one tile on fails", () => {
    const { run, check } = mutated("cotton-dryadsgrove", (copy, cell, width) => {
      const run = manifest.runs.find((candidate) => candidate.crossing === "cotton-dryadsgrove" && candidate.viewport.width === 480)!;
      const frame = run.frames.find((entry) => entry.capture === "after")!;
      const left = frame.figures.find((figure) => figure.kind === "left" && figure.rect[0] >= 32 && figure.rect[1] >= 0)!;
      stamp(copy, width, cell("after"), left.art, left.rect[0] - 16, left.rect[1]);
    });
    expect(check.failures.length).toBe(1);
    expect(check.failures[0]).toContain("cotton-dryadsgrove 480x272 after");
    expect(check.failures[0]).toContain("where no character stands");
    expect(run.frames[2]!.figures.some((figure) => figure.kind === "left")).toBe(true);
  });

  test("a frame without the far-side characters fails the check", () => {
    // Paint the `before` frame's target rects with the `after` frame's
    // pixels shifted by one tile: the characters are no longer where the
    // first target tick puts them.
    const run = manifest.runs.find((candidate) => candidate.crossing === "dryadsgrove-cotton" && candidate.viewport.width === 480)!;
    const image = images.get(480)!;
    const copy = { ...image, rgba: image.rgba.slice() };
    const [bx, by] = sheetCell(0, "before", run.viewport);
    for (const actor of run.target) {
      const rect = actor.rects.before;
      if (!rect) continue;
      for (let y = 0; y < rect[3]; y++) {
        for (let x = 0; x < rect[2]; x++) {
          const at = ((by + rect[1] + y) * copy.width + bx + rect[0] + x) * 4;
          const from = ((by + rect[1] + y) * copy.width + bx + rect[0] + x - 16) * 4;
          copy.rgba.set(image.rgba.subarray(from, from + 4), at);
        }
      }
    }
    const check = checkPreviewSeamRun(run, (capture) => {
      const [x0, y0] = sheetCell(0, capture, run.viewport);
      return { width: copy.width, height: copy.height, rgba: copy.rgba, x0, y0, frameWidth: 480, frameHeight: 272 };
    }, art);
    expect(check.failures.length).toBeGreaterThan(0);
    expect(check.failures.some((failure) => failure.includes("before/after"))).toBe(true);
    // The shifted characters are also missing from their place in `before`.
    expect(check.failures.some((failure) => failure.includes(" before target ") && failure.includes(" missing at "))).toBe(true);
  });

  test("a ghost sprite with both anchor pixels covered still matches above the threshold", () => {
    // Regression for the two-anchor prefilter: a full red statue stamped at
    // an empty cell, with its first and last opaque pixels restored to the
    // background, still matches 180/182 = 98.9% and must be found. The old
    // prefilter skipped the position because both anchors were covered.
    const path = "assets/characters/npc-npc-statue-red-static.png";
    const count = opaqueCount(path);
    let made = 0;
    const { check } = mutated("dryadsgrove-cotton", (copy, cell, width) => {
      made = stampWithHoles(copy, images.get(480)!.rgba, width, cell("later"), path, 37, 23, [0, count - 1]);
    });
    expect(made).toBe(2);
    expect(check.failures).toContain(
      "dryadsgrove-cotton 480x272 later assets/characters/npc-npc-statue-red-static.png drawn at 37,23 where no character stands (doubled or ghost)",
    );
  });

  test("a sprite at the mismatch limit is found, one just past it is not", () => {
    // 182 opaque pixels; the budget is 18 mismatches. 18 holes (both anchors
    // included) leave 164/182 = 90.1% >= 90% and must be found; a 19th hole
    // drops to 163/182 = 89.6% and must not be reported.
    const path = "assets/characters/npc-npc-statue-red-static.png";
    const count = opaqueCount(path);
    const allowed = missBudget(count, FIGURE_MATCH_MIN);
    expect(allowed).toBe(18);
    const holes = [0, count - 1];
    for (let k = 1; holes.length < allowed; k++) holes.push(Math.floor((k * count) / allowed));
    let made = 0;
    const atLimit = mutated("dryadsgrove-cotton", (copy, cell, width) => {
      made = stampWithHoles(copy, images.get(480)!.rgba, width, cell("later"), path, 37, 23, holes);
    });
    expect(made).toBe(allowed);
    expect(atLimit.check.failures).toContain(
      "dryadsgrove-cotton 480x272 later assets/characters/npc-npc-statue-red-static.png drawn at 37,23 where no character stands (doubled or ghost)",
    );
    const pastLimit = mutated("dryadsgrove-cotton", (copy, cell, width) => {
      stampWithHoles(copy, images.get(480)!.rgba, width, cell("later"), path, 37, 23, [...holes, count - 2]);
    });
    expect(pastLimit.check.failures.some((failure) => failure.includes("statue-red") && failure.includes("37,23"))).toBe(false);
  });
  test("the threshold is 90% and the miss budget agrees with the ratio exactly", () => {
    expect(FIGURE_MATCH_MIN).toBe(0.9);
    // floor(count * (1 - 0.9)) is one short for multiples of ten, because
    // 1 - 0.9 is 0.09999999999999998 in floating point.
    expect(missBudget(180, FIGURE_MATCH_MIN)).toBe(18);
    for (let count = 1; count <= 2048; count++) {
      const budget = missBudget(count, FIGURE_MATCH_MIN);
      expect((count - budget) / count >= FIGURE_MATCH_MIN).toBe(true);
      expect((count - budget - 1) / count < FIGURE_MATCH_MIN).toBe(true);
    }
  });

  test("a 180-pixel sprite matching exactly 90% is found, one more miss is not", () => {
    // A character art the matrix draws, with a multiple-of-ten opaque count:
    // 18 holes leave 162/180 = 0.9 exactly.
    const path = "assets/characters/npc-npc-childactor-fiery-idle-0.png";
    const count = opaqueCount(path);
    expect(count).toBe(180);
    const holes: number[] = [];
    for (let k = 0; k < 18; k++) holes.push(Math.floor(((k + 0.5) * count) / 18));
    let made = 0;
    const atLimit = mutated("dryadsgrove-cotton", (copy, cell, width) => {
      made = stampWithHoles(copy, images.get(480)!.rgba, width, cell("later"), path, 37, 23, holes);
    });
    expect(made).toBe(18);
    expect(atLimit.check.failures).toContain(
      `dryadsgrove-cotton 480x272 later ${path} drawn at 37,23 where no character stands (doubled or ghost)`,
    );
    let madePast = 0;
    const pastLimit = mutated("dryadsgrove-cotton", (copy, cell, width) => {
      madePast = stampWithHoles(copy, images.get(480)!.rgba, width, cell("later"), path, 37, 23, [...holes, holes[0]! + 1]);
    });
    expect(madePast).toBe(19);
    expect(pastLimit.check.failures.some((failure) => failure.includes("childactor-fiery") && failure.includes("37,23"))).toBe(false);
  });
});
