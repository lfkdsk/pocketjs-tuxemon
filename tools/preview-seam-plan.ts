// Neighbour character preview across mainline seams: the capture plan and
// the semantic pixel checks shared by the generator
// (tools/update-preview-seam-goldens.ts) and the visual regression
// (tests/preview-seam-visual.test.ts).
//
// Each crossing is captured at two viewports in four frames:
//   before  — handoff phase 0: the source map is active, the target map's
//             characters are painted by the sandboxed neighbour preview;
//   commit  — the seamless commit frame (target active, its characters not
//             spawned yet: the actor pool paints the handed-over snapshot);
//   after   — the first target tick (characters spawned by the real entry);
//   later   — 29 frames after that.
// Checks (screen rects come from the session state; pixels from the frames):
//   - every target character visible in `after` is already in `before` and
//     in `commit` at the same world position (patch equality);
//   - no ghost: where a target character stands away from its authored
//     cell, that cell looks the same in `commit` and `after`;
//   - the characters of the map left behind stay frozen (same patch in
//     commit, after and later) and the freeze moved them at most 2 px;
//   - every frame, with the character art as the reference: each character
//     the session state says is on screen (the source map's own at `before`,
//     the far side's, the frozen ones behind, from `after` on the live ones)
//     is drawn exactly where expected, and a scan of the whole frame finds
//     each of their sprites nowhere else (no dropped, doubled or ghost
//     character).

import type { Facing, WorldSide } from "../vendor/pocket-rpgkit/src/engine/types.ts";

export const PREVIEW_SEAM_FORMAT = "pocket-tuxemon/preview-seam/v1" as const;
export const PREVIEW_SEAM_OUTPUT = "docs/screenshots/preview-seam" as const;
export const PREVIEW_SEAM_CAPTURES = ["before", "commit", "after", "later"] as const;
export const PREVIEW_SEAM_LATER_FRAMES = 29;
export type PreviewSeamCapture = (typeof PREVIEW_SEAM_CAPTURES)[number];

export const PREVIEW_SEAM_VIEWPORTS = [
  { width: 480, height: 272 },
  { width: 960, height: 544 },
] as const;

export interface PreviewSeamCrossing {
  id: string;
  sourceMap: string;
  targetMap: string;
  sourceSide: WorldSide;
  /** One step inside the source map, on a seamless opening. */
  start: readonly [number, number];
  button: number;
  facing: Facing;
}

const UP = 0x0010;
const RIGHT = 0x0020;
const DOWN = 0x0040;
const LEFT = 0x0080;

/** Mainline (spyder_*) seams with characters near the crossing on the far
 * side, the near side or both. */
export const PREVIEW_SEAM_CROSSINGS: readonly PreviewSeamCrossing[] = [
  { id: "dryadsgrove-cotton", sourceMap: "spyder_dryadsgrove", targetMap: "spyder_cotton_town", sourceSide: "east", start: [38, 7], button: RIGHT, facing: 3 },
  { id: "cotton-dryadsgrove", sourceMap: "spyder_cotton_town", targetMap: "spyder_dryadsgrove", sourceSide: "west", start: [1, 7], button: LEFT, facing: 1 },
  { id: "route2-citypark", sourceMap: "spyder_route2", targetMap: "spyder_citypark", sourceSide: "north", start: [10, 1], button: UP, facing: 2 },
  { id: "citypark-route2", sourceMap: "spyder_citypark", targetMap: "spyder_route2", sourceSide: "south", start: [11, 38], button: DOWN, facing: 0 },
  { id: "route3-route4", sourceMap: "spyder_route3", targetMap: "spyder_route4", sourceSide: "west", start: [1, 3], button: LEFT, facing: 1 },
  { id: "leather-citypark", sourceMap: "spyder_leather_town", targetMap: "spyder_citypark", sourceSide: "east", start: [38, 32], button: RIGHT, facing: 3 },
] as const;

/** x, y, width, height in screen pixels (may extend past the viewport). */
export type Rect = readonly [number, number, number, number];

export interface PreviewSeamActor {
  eventId: string;
  /** World pixel of the character's cell (top-left of its 16×16 foot cell). */
  world: readonly [number, number];
  /** Sprite rect per capture (16×32 above the foot cell). */
  rects: Partial<Record<PreviewSeamCapture, Rect>>;
}

export interface PreviewSeamGhost {
  eventId: string;
  authoredWorld: readonly [number, number];
  rects: Partial<Record<PreviewSeamCapture, Rect>>;
}

export interface PreviewSeamLeftActor extends PreviewSeamActor {
  /** Largest distance (px) between the live character at phase 7 and its
   * frozen snapshot; null when it was not painted at phase 7. */
  freezeShift: number | null;
}

/** A character the session state puts on screen in one frame. */
export interface PreviewSeamFigure {
  eventId: string;
  /** source: the active source map's own (at `before`); target: the far
   * side's (the preview at `before`, the handed-over snapshot at `commit`,
   * live after); left: the frozen map behind. */
  kind: "source" | "target" | "left";
  /** The image the renderer paints for its sprite, pose and facing. */
  art: string;
  /** Screen rect of that image (16×32, or 16×16 on the foot cell). */
  rect: Rect;
  /** 0–255. */
  opacity: number;
}

export interface PreviewSeamFrame {
  capture: PreviewSeamCapture;
  figures: PreviewSeamFigure[];
  activeMap: string;
  camera: readonly [number, number];
  offset: readonly [number, number];
  player: Rect;
  rgbaFnv1a: string;
}

export interface PreviewSeamRun {
  crossing: string;
  viewport: { width: number; height: number };
  frames: PreviewSeamFrame[];
  target: PreviewSeamActor[];
  ghosts: PreviewSeamGhost[];
  left: PreviewSeamLeftActor[];
  /** Equality ratio per checked rect: `${kind}:${eventId}:${a}/${b}`. */
  ratios: Record<string, number>;
  /** Per capture: the characters found in place and the sprite
   * occurrences the whole-frame scan found (see checkPreviewSeamFigures). */
  figures: Record<PreviewSeamCapture, { present: string[]; occurrences: number }>;
}

export interface PreviewSeamSheet {
  viewport: { width: number; height: number };
  file: string;
  width: number;
  height: number;
  pngSha256: string;
}

export interface PreviewSeamManifest {
  format: typeof PREVIEW_SEAM_FORMAT;
  captures: PreviewSeamCapture[];
  runs: PreviewSeamRun[];
  sheets: PreviewSeamSheet[];
}

export function previewSeamSheetFile(viewport: { width: number; height: number }): string {
  return `preview-seam.${viewport.width}x${viewport.height}.contact-sheet.png`;
}

/** Where a capture of `run` sits in its viewport's contact sheet (rows =
 * crossings in plan order, columns = captures). */
export function sheetCell(crossingIndex: number, capture: PreviewSeamCapture, viewport: { width: number; height: number }): [number, number] {
  return [PREVIEW_SEAM_CAPTURES.indexOf(capture) * viewport.width, crossingIndex * viewport.height];
}

/** An RGBA image region reader. */
export interface Pixels {
  width: number;
  height: number;
  rgba: Uint8Array;
  /** Origin of the frame inside `rgba` (contact sheets hold many frames). */
  x0: number;
  y0: number;
  /** Frame size (pixels outside it are not compared). */
  frameWidth: number;
  frameHeight: number;
}

function inside(rect: Rect, frame: Pixels): boolean {
  return rect[0] >= 0 && rect[1] >= 0 && rect[0] + rect[2] <= frame.frameWidth && rect[1] + rect[3] <= frame.frameHeight;
}

function overlaps(a: Rect, b: Rect): boolean {
  return a[0] < b[0] + b[2] && b[0] < a[0] + a[2] && a[1] < b[1] + b[3] && b[1] < a[1] + a[3];
}

/** Share of equal RGB pixels between two same-size rects of two frames. */
export function patchEquality(a: Pixels, ra: Rect, b: Pixels, rb: Rect): number {
  if (ra[2] !== rb[2] || ra[3] !== rb[3]) throw new Error("patchEquality: rect sizes differ");
  let equal = 0;
  for (let y = 0; y < ra[3]; y++) {
    for (let x = 0; x < ra[2]; x++) {
      const ia = ((a.y0 + ra[1] + y) * a.width + a.x0 + ra[0] + x) * 4;
      const ib = ((b.y0 + rb[1] + y) * b.width + b.x0 + rb[0] + x) * 4;
      if (a.rgba[ia] === b.rgba[ib] && a.rgba[ia + 1] === b.rgba[ib + 1] && a.rgba[ia + 2] === b.rgba[ib + 2]) equal++;
    }
  }
  return equal / (ra[2] * ra[3]);
}

/** Patches must agree this well. A 16×32 character sprite covers well over
 * a third of its rect, so a missing, moved or doubled character drops the
 * ratio far below; the slack absorbs animated tiles behind a sprite. */
export const PATCH_EQUALITY_MIN = 0.97;
/** Freezing the map left behind may move a character by the one tick the
 * commit folds, never more. */
export const FREEZE_SHIFT_MAX = 2;

export interface PreviewSeamCheck {
  /** Rects compared (key as in PreviewSeamRun.ratios) and their ratio. */
  ratios: Record<string, number>;
  failures: string[];
  /** Characters compared on the far side and behind. */
  targetChecked: number;
  leftChecked: number;
  ghostChecked: number;
  /** Per capture: characters found in place (`${kind}:${eventId}`) and
   * sprite occurrences found by the whole-frame scan. */
  figures: Record<PreviewSeamCapture, { present: string[]; occurrences: number }>;
}

/** The semantic checks of one run. `frames(capture)` reads its pixels,
 * `art(path)` a character image. */
export function checkPreviewSeamRun(
  run: PreviewSeamRun,
  frames: (capture: PreviewSeamCapture) => Pixels,
  art: (path: string) => SpriteArt,
): PreviewSeamCheck {
  const out: PreviewSeamCheck = { ratios: {}, failures: [], targetChecked: 0, leftChecked: 0, ghostChecked: 0, figures: {} as PreviewSeamCheck["figures"] };
  const frame = (capture: PreviewSeamCapture) => run.frames.find((entry) => entry.capture === capture)!;
  const usable = (capture: PreviewSeamCapture, rect: Rect | undefined, others: readonly Rect[]): rect is Rect =>
    rect !== undefined && inside(rect, frames(capture)) && !overlaps(rect, frame(capture).player)
    && !others.some((other) => other !== rect && overlaps(rect, other));
  const compare = (kind: string, id: string, a: PreviewSeamCapture, ra: Rect, b: PreviewSeamCapture, rb: Rect): void => {
    const ratio = patchEquality(frames(a), ra, frames(b), rb);
    const key = `${kind}:${id}:${a}/${b}`;
    out.ratios[key] = Math.round(ratio * 10_000) / 10_000;
    if (ratio < PATCH_EQUALITY_MIN) {
      out.failures.push(`${run.crossing} ${run.viewport.width}x${run.viewport.height} ${key} equality ${ratio.toFixed(3)}`);
    }
  };
  const rectsOf = (capture: PreviewSeamCapture) => [
    ...run.target.map((actor) => actor.rects[capture]),
    ...run.left.map((actor) => actor.rects[capture]),
  ].filter((rect): rect is Rect => rect !== undefined);

  for (const actor of run.target) {
    const after = actor.rects.after;
    if (!usable("after", after, rectsOf("after"))) continue;
    for (const capture of ["before", "commit"] as const) {
      const rect = actor.rects[capture];
      if (!usable(capture, rect, rectsOf(capture))) continue;
      compare("target", actor.eventId, capture, rect, "after", after);
      if (capture === "before") out.targetChecked++;
    }
  }
  for (const ghost of run.ghosts) {
    const commit = ghost.rects.commit;
    const after = ghost.rects.after;
    if (!usable("commit", commit, rectsOf("commit")) || !usable("after", after, rectsOf("after"))) continue;
    compare("ghost", ghost.eventId, "commit", commit, "after", after);
    out.ghostChecked++;
  }
  for (const actor of run.left) {
    if (actor.freezeShift !== null && actor.freezeShift > FREEZE_SHIFT_MAX) {
      out.failures.push(`${run.crossing} ${actor.eventId} moved ${actor.freezeShift} px when frozen`);
    }
    const commit = actor.rects.commit;
    if (!usable("commit", commit, rectsOf("commit"))) continue;
    let checked = false;
    for (const capture of ["after", "later"] as const) {
      const rect = actor.rects[capture];
      if (!usable(capture, rect, rectsOf(capture))) continue;
      compare("left", actor.eventId, "commit", commit, capture, rect);
      checked = true;
    }
    if (checked) out.leftChecked++;
  }
  const figures = checkPreviewSeamFigures(run, frames, art);
  out.failures.push(...figures.failures);
  for (const capture of PREVIEW_SEAM_CAPTURES) {
    out.figures[capture] = { present: figures.present[capture], occurrences: figures.occurrences[capture] };
  }
  return out;
}

/** A character image (RGBA, straight alpha). */
export interface SpriteArt {
  width: number;
  height: number;
  rgba: Uint8Array;
}

/** Share of a sprite's opaque pixels a frame must reproduce exactly for the
 * sprite to count as drawn there. Frames at the fixed 09:00 start carry no
 * daylight tint, so an unobstructed character matches 100%. */
export const FIGURE_MATCH_MIN = 0.9;
/** Matches closer than this (px, both axes) are one occurrence. */
const OCCURRENCE_RADIUS = 4;

interface CompiledArt {
  width: number;
  height: number;
  /** x, y, r, g, b per opaque pixel. */
  pixels: Int32Array;
  count: number;
}

function compileArt(art: SpriteArt): CompiledArt {
  const values: number[] = [];
  for (let y = 0; y < art.height; y++) {
    for (let x = 0; x < art.width; x++) {
      const i = (y * art.width + x) * 4;
      if (art.rgba[i + 3] !== 255) continue;
      values.push(x, y, art.rgba[i]!, art.rgba[i + 1]!, art.rgba[i + 2]!);
    }
  }
  return { width: art.width, height: art.height, pixels: Int32Array.from(values), count: values.length / 5 };
}

/** The most mismatched pixels a sprite of `count` opaque pixels may have and
 * still reach `min`, decided by the same `(count - misses) / count >= min`
 * division the match ratio uses. `floor(count * (1 - min))` is not
 * equivalent: 1 - 0.9 is 0.09999999999999998 in floating point, so for a
 * count that is a multiple of ten it allowed one mismatch too few. */
export function missBudget(count: number, min: number): number {
  let misses = Math.ceil(count * (1 - min)) + 1;
  while (misses > 0 && (count - misses) / count < min) misses--;
  return misses;
}

/** Share of `art`'s opaque pixels that `frame` shows unchanged with the
 * image's top-left at (x, y); stops early once it cannot reach `min`. */
function artMatch(frame: Pixels, art: CompiledArt, x: number, y: number, min: number): number {
  const allowed = missBudget(art.count, min);
  let misses = 0;
  for (let k = 0; k < art.count; k++) {
    const o = k * 5;
    const i = ((frame.y0 + y + art.pixels[o + 1]!) * frame.width + frame.x0 + x + art.pixels[o]!) * 4;
    if (frame.rgba[i] !== art.pixels[o + 2] || frame.rgba[i + 1] !== art.pixels[o + 3] || frame.rgba[i + 2] !== art.pixels[o + 4]) {
      if (++misses > allowed) return 0;
    }
  }
  return (art.count - misses) / art.count;
}

/** Every place in the frame showing `art` (best position per cluster of
 * matches), scanning every position where the image fits. */
export function findArt(frame: Pixels, art: CompiledArt): { x: number; y: number; ratio: number }[] {
  const found: { x: number; y: number; ratio: number }[] = [];
  if (art.count === 0) return found;
  // No position prefilter: artMatch is itself the necessary condition. It
  // returns 0 as soon as more than missBudget(count, FIGURE_MATCH_MIN)
  // opaque pixels mismatch, so a background position is rejected after that
  // many cheap pixel checks and no position that could still reach the
  // threshold is ever skipped. (A former prefilter tested only the first and
  // last opaque pixels and skipped the position when both were covered —
  // even though the other 98% still matched, silently dropping a ghost the
  // threshold accepts.)
  for (let y = 0; y + art.height <= frame.frameHeight; y++) {
    for (let x = 0; x + art.width <= frame.frameWidth; x++) {
      const ratio = artMatch(frame, art, x, y, FIGURE_MATCH_MIN);
      if (ratio < FIGURE_MATCH_MIN) continue;
      const near = found.find((entry) => Math.abs(entry.x - x) < OCCURRENCE_RADIUS && Math.abs(entry.y - y) < OCCURRENCE_RADIUS);
      if (!near) found.push({ x, y, ratio });
      else if (ratio > near.ratio) Object.assign(near, { x, y, ratio });
    }
  }
  return found;
}

export interface PreviewSeamFigureCheck {
  present: Record<PreviewSeamCapture, string[]>;
  occurrences: Record<PreviewSeamCapture, number>;
  failures: string[];
}

/** Presence and uniqueness of every expected character in every frame of
 * `run`, against the character art (`art(path)`). A character whose image
 * lies fully in the frame, is opaque and is not covered by the player or by
 * another character must be found at its rect; the whole frame is scanned
 * for each expected image, and every occurrence must sit exactly on the
 * rect of an expected character with that image — anything else is a
 * doubled or ghost character. Characters partly off screen are only
 * scanned for. */
export function checkPreviewSeamFigures(
  run: PreviewSeamRun,
  frames: (capture: PreviewSeamCapture) => Pixels,
  art: (path: string) => SpriteArt,
): PreviewSeamFigureCheck {
  const label = `${run.crossing} ${run.viewport.width}x${run.viewport.height}`;
  const out: PreviewSeamFigureCheck = {
    present: { before: [], commit: [], after: [], later: [] },
    occurrences: { before: 0, commit: 0, after: 0, later: 0 },
    failures: [],
  };
  const compiled = new Map<string, CompiledArt>();
  const compiledArt = (path: string): CompiledArt => {
    let entry = compiled.get(path);
    if (!entry) compiled.set(path, entry = compileArt(art(path)));
    return entry;
  };
  for (const frame of run.frames) {
    const pixels = frames(frame.capture);
    const where = `${label} ${frame.capture}`;
    const occurrences = new Map<string, { x: number; y: number; ratio: number }[]>();
    for (const path of new Set(frame.figures.map((figure) => figure.art))) {
      const found = findArt(pixels, compiledArt(path));
      occurrences.set(path, found);
      out.occurrences[frame.capture] += found.length;
      for (const hit of found) {
        const owners = frame.figures.filter((figure) => figure.art === path && figure.rect[0] === hit.x && figure.rect[1] === hit.y);
        if (owners.length === 0) {
          out.failures.push(`${where} ${path} drawn at ${hit.x},${hit.y} where no character stands (doubled or ghost)`);
        }
      }
    }
    for (const figure of frame.figures) {
      const covered = overlaps(figure.rect, frame.player)
        || frame.figures.some((other) => other !== figure && overlaps(figure.rect, other.rect));
      if (!inside(figure.rect, pixels) || covered || figure.opacity !== 255) continue;
      const hit = occurrences.get(figure.art)!.some((entry) => entry.x === figure.rect[0] && entry.y === figure.rect[1]);
      if (!hit) {
        out.failures.push(`${where} ${figure.kind} ${figure.eventId} missing at ${figure.rect[0]},${figure.rect[1]}`);
        continue;
      }
      out.present[frame.capture].push(`${figure.kind}:${figure.eventId}`);
    }
  }
  return out;
}

/** Structural checks plus the matrix-wide minimums: every crossing and
 * every capture has a character verified in place on some viewport, the
 * far side's characters are verified in the preview (`before`) of every
 * crossing, and characters behind the player are verified frozen and in
 * place. */
export function assertPreviewSeamMatrix(
  manifest: PreviewSeamManifest,
  checks: readonly PreviewSeamCheck[],
): void {
  const fail = (message: string): never => {
    throw new Error(`preview seam matrix: ${message}`);
  };
  if (manifest.format !== PREVIEW_SEAM_FORMAT) fail(`unexpected format ${manifest.format}`);
  if (manifest.runs.length !== PREVIEW_SEAM_CROSSINGS.length * PREVIEW_SEAM_VIEWPORTS.length) fail("incomplete run list");
  if (checks.length !== manifest.runs.length) fail("one check per run expected");
  const failures = checks.flatMap((check) => check.failures);
  if (failures.length) fail(failures.join("; "));
  for (const crossing of PREVIEW_SEAM_CROSSINGS) {
    const indices = manifest.runs.flatMap((run, index) => (run.crossing === crossing.id ? [index] : []));
    if (indices.length !== PREVIEW_SEAM_VIEWPORTS.length) fail(`${crossing.id} is not captured at every viewport`);
    for (const index of indices) {
      const run = manifest.runs[index]!;
      const captures = run.frames.map((frame) => frame.capture).join(",");
      if (captures !== PREVIEW_SEAM_CAPTURES.join(",")) fail(`${crossing.id} captures ${captures}`);
      const active = run.frames.map((frame) => frame.activeMap);
      if (active[0] !== crossing.sourceMap || active.slice(1).some((map) => map !== crossing.targetMap)) {
        fail(`${crossing.id} active maps ${active.join(",")}`);
      }
    }
    const shown = indices.reduce((sum, index) => sum + checks[index]!.targetChecked + checks[index]!.leftChecked, 0);
    if (shown === 0) fail(`${crossing.id} checks no character on either side`);
    for (const capture of PREVIEW_SEAM_CAPTURES) {
      const present = indices.flatMap((index) => checks[index]!.figures[capture].present);
      const crossed = present.filter((entry) => !entry.startsWith("source:"));
      if (crossed.length === 0) fail(`${crossing.id} ${capture} finds no far-side or left-behind character in place`);
      if (capture === "before" && !present.some((entry) => entry.startsWith("target:"))) {
        fail(`${crossing.id} before finds no previewed far-side character in place`);
      }
    }
  }
  const total = (key: "targetChecked" | "leftChecked" | "ghostChecked") => checks.reduce((sum, check) => sum + check[key], 0);
  if (total("targetChecked") < PREVIEW_SEAM_CROSSINGS.length) fail(`only ${total("targetChecked")} far-side characters checked`);
  if (total("leftChecked") === 0) fail("no character behind the player checked");
  for (const capture of ["commit", "after", "later"] as const) {
    if (!checks.some((check) => check.figures[capture].present.some((entry) => entry.startsWith("left:")))) {
      fail(`no character behind the player found in place at ${capture}`);
    }
  }
}
