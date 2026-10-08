// Font glyph masks for the zh_CN web verifier. The baked `ui:font.0` atlas
// (text-xs, 12 px) carries every glyph's advance and a 14x15 alpha coverage
// cell. We render the EXPECTED text to a 1-bit mask and compare it against
// the screenshot's text region, so the assertions check actual glyphs
// (shape + position) instead of counting light pixels in a band that also
// holds map and dialog-box decoration.

import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { unpack } from "../vendor/pocket-rpgkit/vendor/pocketjs/framework/compiler/pak.ts";

const ROOT = resolve(import.meta.dir, "..");

export interface GlyphInfo {
  advance: number;
  /** cellW x cellH alpha bytes (0..255), row-major. */
  coverage: Uint8Array;
}

export interface FontMask {
  cellW: number;
  cellH: number;
  glyphs: Map<number, GlyphInfo>;
  /** Tofu box for codepoints the atlas lacks. */
  fallback: GlyphInfo;
}

const FONT_HEADER_SIZE = 16;
const FONT_CMAP_ENTRY_SIZE = 8;
/** Alpha at/above which a coverage pixel counts as ink. The solid glyph core
 *  (alpha >= 100) is the most distinctive part; faint anti-aliased edges are
 *  too close to the background to match reliably. */
const INK_ALPHA = 100;

const cached = new Map<string, FontMask>();

/** Parse one font atlas from the built desktop pak. Slot 0 is text-xs; slot 1
 * is text-sm, which the save message page uses for its title and body. */
export function loadFontMask(pakPath?: string, slot = 0): FontMask {
  const file = pakPath ?? join(ROOT, "dist/main.pak");
  const cacheKey = `${file}\0${slot}`;
  const hit = cached.get(cacheKey);
  if (hit) return hit;
  const entries = unpack(readFileSync(file));
  const key = `ui:font.${slot}`;
  const blob = entries.find((e) => e.key === key);
  if (!blob) throw new Error(`${key} not found in pak`);
  const d = blob.data;
  const dv = new DataView(d.buffer, d.byteOffset, d.byteLength);
  const glyphCount = dv.getUint16(6, true);
  const cellW = d[8]!;
  const cellH = d[9]!;
  const glyphs = new Map<number, GlyphInfo>();
  const coverageOffset = FONT_HEADER_SIZE + glyphCount * FONT_CMAP_ENTRY_SIZE;
  const cellSize = cellW * cellH;
  let fallback: GlyphInfo | null = null;
  for (let i = 0; i < glyphCount; i++) {
    const off = FONT_HEADER_SIZE + i * FONT_CMAP_ENTRY_SIZE;
    const cp = dv.getUint32(off, true);
    const gid = dv.getUint16(off + 4, true);
    const advance = d[off + 6]!;
    const coverage = d.slice(coverageOffset + gid * cellSize, coverageOffset + (gid + 1) * cellSize);
    const info: GlyphInfo = { advance, coverage };
    glyphs.set(cp, info);
    if (gid === 0) fallback = info;
  }
  if (!fallback) throw new Error("font atlas has no gid 0 fallback");
  const result = { cellW, cellH, glyphs, fallback };
  cached.set(cacheKey, result);
  return result;
}

export interface TextMask {
  width: number;
  height: number;
  /** 1-bit ink mask, row-major, length width*height. */
  ink: Uint8Array;
}

/** Render a string to a 1-bit ink mask using the font's advances and
 *  coverage cells. The baseline sits at `ascent` rows from the top. */
export function renderTextMask(font: FontMask, text: string): TextMask {
  const { cellW, cellH, glyphs, fallback } = font;
  // Measure first.
  let width = 0;
  const chars: { cp: number; glyph: GlyphInfo; x: number }[] = [];
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    const glyph = glyphs.get(cp) ?? fallback;
    chars.push({ cp, glyph, x: width });
    width += glyph.advance;
  }
  const height = cellH;
  const ink = new Uint8Array(width * height);
  for (const { glyph, x } of chars) {
    for (let y = 0; y < cellH; y++) {
      for (let cx = 0; cx < cellW; cx++) {
        if (glyph.coverage[y * cellW + cx]! >= INK_ALPHA) {
          const px = x + cx;
          if (px < width) ink[y * width + px] = 1;
        }
      }
    }
  }
  return { width, height, ink };
}

/** Match quality of a rendered text mask against a screenshot region.
 *  `recall` is the fraction of the mask's ink pixels that are "on"
 *  (text-colored) in the framebuffer; `precision` is the fraction of on-pixels
 *  inside the mask's ink bounding box that the mask actually explains. A
 *  region painted solid light has recall 1 but precision ~0, so `score` (the
 *  F1 of the two) fails it instead of matching at 100%. */
export interface MaskMatch {
  matched: number;
  total: number;
  onInBox: number;
  recall: number;
  precision: number;
  score: number;
}

/** Score a mask against the framebuffer under `isOn`, requiring BOTH that
 *  the expected glyphs are drawn (recall) and that no extra foreground fills
 *  the text area (precision). Returns the F1 of the two. */
export function maskMatch(
  mask: TextMask,
  rgba: Uint8Array,
  W: number,
  originX: number,
  originY: number,
  isOn: (x: number, y: number) => boolean,
): MaskMatch {
  // Ink bounding box of the mask: precision is measured over this box, so
  // decoration far from the glyphs does not penalize the score.
  let minX = mask.width, minY = mask.height, maxX = -1, maxY = -1;
  for (let y = 0; y < mask.height; y++) {
    for (let x = 0; x < mask.width; x++) {
      if (mask.ink[y * mask.width + x]) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  let matched = 0;
  let total = 0;
  let onInBox = 0;
  if (maxX >= 0) {
    for (let y = minY; y <= maxY; y++) {
      for (let x = minX; x <= maxX; x++) {
        const sx = originX + x;
        const sy = originY + y;
        const on = sx >= 0 && sy >= 0 && sx < W && isOn(sx, sy);
        if (on) onInBox++;
        if (mask.ink[y * mask.width + x]) {
          total++;
          if (on) matched++;
        }
      }
    }
  }
  const recall = total > 0 ? matched / total : 0;
  const precision = onInBox > 0 ? matched / onInBox : 0;
  const score = matched > 0 ? (2 * recall * precision) / (recall + precision) : 0;
  return { matched, total, onInBox, recall, precision, score };
}

/** Count ink pixels in a mask. */
export function maskInkCount(mask: TextMask): number {
  let n = 0;
  for (const v of mask.ink) if (v) n++;
  return n;
}
