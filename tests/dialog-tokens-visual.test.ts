// Visual + semantic checks for the dialog-token screenshots. Each key shot
// boots the PRODUCTION bundle (main.tsx's GameView mount with its textTokens
// prop), triggers its REAL imported event with REAL input, and captures the
// frame. The dialog's text band is then compared pixel-for-pixel against a
// committed golden crop (tests/goldens/dialog-tokens/). The goldens were
// eyeballed at 3x — they show the resolved text (Chad 0 vs Brad 0, the
// 尺/粮 risk glyphs, AV8R, …), so a pixel diff means the rendered dialog
// changed: a broken textTokens wiring, a wrong glyph, a truncation, or a
// blank box all fail the comparison.
//
// This is strictly stronger than the old light-pixel-ratio probe: that
// probe could not tell 尺 from 粮 from a blank band, and survived a mutation
// that kept only the first 60 px of text. A golden comparison fails on any
// of those.
//
// Skips only when the production bundle has not been built (local dev); CI
// builds it before running tests.

import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { inflateSync } from "node:zlib";
import { bundleIsBuilt, driveDialog, ROOT, type DialogShot } from "../tools/dialog-token-drive.ts";
import { DIALOG_SHOTS } from "../tools/dialog-token-shots.ts";

const testIfBuilt = bundleIsBuilt() ? test : test.skip;

interface PngImage {
  width: number;
  height: number;
  rgba: Uint8Array;
}

/** Decode an 8-bit RGBA PNG (the kit's encodePNG output). Handles the five
 *  scanline filters. Returns null on an unsupported format. */
function decodePNG(buf: Uint8Array): PngImage | null {
  if (buf[0] !== 0x89 || buf[1] !== 0x50) return null;
  let pos = 8;
  let width = 0, height = 0, bitDepth = 0, colorType = 0;
  const idat: number[] = [];
  while (pos < buf.length) {
    const len = (buf[pos]! << 24) | (buf[pos + 1]! << 16) | (buf[pos + 2]! << 8) | buf[pos + 3]!;
    const type = String.fromCharCode(buf[pos + 4]!, buf[pos + 5]!, buf[pos + 6]!, buf[pos + 7]!);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === "IHDR") {
      width = (data[0]! << 24) | (data[1]! << 16) | (data[2]! << 8) | data[3]!;
      height = (data[4]! << 24) | (data[5]! << 16) | (data[6]! << 8) | data[7]!;
      bitDepth = data[8]!;
      colorType = data[9]!;
    } else if (type === "IDAT") {
      for (const b of data) idat.push(b);
    } else if (type === "IEND") {
      break;
    }
    pos += 12 + len;
  }
  if (bitDepth !== 8 || colorType !== 6) return null;
  const channels = 4;
  const raw = inflateSync(Uint8Array.from(idat));
  const stride = width * channels;
  const rgba = new Uint8Array(width * height * 4);
  const prev = new Uint8Array(stride);
  let rp = 0;
  const paeth = (a: number, b: number, c: number): number => {
    const p = a + b - c;
    const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
    return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
  };
  for (let y = 0; y < height; y++) {
    const filter = raw[rp++]!;
    const line = new Uint8Array(stride);
    for (let x = 0; x < stride; x++) {
      const rawByte = raw[rp++]!;
      const a = x >= channels ? line[x - channels]! : 0;
      const b = prev[x]!;
      const c = x >= channels ? prev[x - channels]! : 0;
      switch (filter) {
        case 0: line[x] = rawByte; break;
        case 1: line[x] = rawByte + a; break;
        case 2: line[x] = rawByte + b; break;
        case 3: line[x] = rawByte + ((a + b) >> 1); break;
        case 4: line[x] = rawByte + paeth(a, b, c); break;
        default: return null;
      }
    }
    for (let x = 0; x < width; x++) {
      const si = x * channels, di = (y * width + x) * 4;
      rgba[di] = line[si]!;
      rgba[di + 1] = line[si + 1]!;
      rgba[di + 2] = line[si + 2]!;
      rgba[di + 3] = line[si + 3]!;
    }
    prev.set(line);
  }
  return { width, height, rgba };
}

const VP = { width: 480, height: 272 };
// The dialog box sits at the bottom of the 480x272 frame; its text band
// (up to two lines) is at 62%..94% of the height, 16 px in from each side.
const Y0 = Math.floor(VP.height * 0.62);
const Y1 = Math.floor(VP.height * 0.94);
const X0 = 16;
const X1 = VP.width - 16;
const CROP_W = X1 - X0;
const CROP_H = Y1 - Y0;

const GOLDEN_DIR = join(ROOT, "tests/goldens/dialog-tokens");

/** The key screenshots whose rendered text band is pinned to a golden. */
const KEY_SHOTS: readonly { slug: string; shot: DialogShot }[] = [
  "scoreboard-en",
  "wallet-zh",
  "today-en",
  "mapdesc-lion-zh",
  "mapdesc-timber-zh",
  "monster-av8r-en",
].map((slug) => ({
  slug,
  shot: DIALOG_SHOTS.find((s) => s.slug === slug)!,
}));

function cropBand(rgba: Uint8Array): Uint8Array {
  const crop = new Uint8Array(CROP_W * CROP_H * 4);
  for (let y = 0; y < CROP_H; y++) {
    for (let x = 0; x < CROP_W; x++) {
      const si = ((Y0 + y) * VP.width + (X0 + x)) * 4;
      const di = (y * CROP_W + x) * 4;
      crop[di] = rgba[si]!;
      crop[di + 1] = rgba[si + 1]!;
      crop[di + 2] = rgba[si + 2]!;
      crop[di + 3] = 255;
    }
  }
  return crop;
}

for (const { slug, shot } of KEY_SHOTS) {
  testIfBuilt(`${slug} renders the resolved dialog text (golden band)`, async () => {
    const { rgba } = await driveDialog(shot, VP);
    const golden = decodePNG(readFileSync(join(GOLDEN_DIR, `${slug}.480x272.png`)));
    expect(golden, `${slug}: golden PNG decode failed`).not.toBeNull();
    expect(golden!.width).toBe(CROP_W);
    expect(golden!.height).toBe(CROP_H);
    const crop = cropBand(rgba);
    // Pixel-exact: the sim host renders deterministically, so any diff is a
    // real rendering change (broken wiring, wrong glyph, truncation, blank).
    let diffs = 0;
    let firstDiff = -1;
    for (let i = 0; i < crop.length; i += 4) {
      if (crop[i] !== golden!.rgba[i] || crop[i + 1] !== golden!.rgba[i + 1] || crop[i + 2] !== golden!.rgba[i + 2]) {
        diffs++;
        if (firstDiff < 0) firstDiff = i;
      }
    }
    expect({ slug, diffs, firstDiff }).toEqual({ slug, diffs: 0, firstDiff: -1 });
  });
}
